import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type { CodexLimitSnapshot } from "@t3tools/lastdrop-node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";

import {
  type CodexOpenInput,
  type CodexRouting,
  isRoutable,
  withAccountHome,
  wrapCodexClientFactory,
} from "./factory.ts";

type Client = CodexClient.CodexAppServerClient["Service"];
const HOME = "/home/u/.codex";
const DEFAULT_SETTINGS = Schema.decodeSync(CodexSettings)({});
const settings = (overrides: Partial<CodexSettings> = {}): CodexSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});
const openInput = (overrides: Partial<CodexOpenInput> = {}): CodexOpenInput => ({
  instanceId: ProviderInstanceId.make("codex"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: ProviderSessionId.make("session-1"),
  runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
  settings: settings(),
  environment: { PATH: "/bin" },
  ...overrides,
});

/** The client surface the wrapper touches; the rest of T3's client is never called here. */
function fakeClient(responses: Record<string, unknown>) {
  const handlers = new Map<string, (payload: unknown) => Effect.Effect<void, never>>();
  const answer = (method: string) => Effect.succeed(responses[method]);
  const client = {
    raw: { request: answer },
    request: answer,
    handleServerNotification: (
      method: string,
      handler: (payload: unknown) => Effect.Effect<void, never>,
    ) =>
      Effect.sync(() => {
        handlers.set(method, handler);
      }),
  };
  // A test double for the three methods above.
  return { client: client as unknown as Client, handlers };
}

function fakeRouting(route: { account: string; home: string } | undefined) {
  const threads: Array<[string, string, string]> = [];
  const limits: Array<[string, CodexLimitSnapshot]> = [];
  const routing: CodexRouting = {
    route: async () => route,
    recordThread: async (...entry) => {
      threads.push(entry);
    },
    observeLimits: async (...entry) => {
      limits.push(entry);
    },
    log: () => {},
  };
  return { routing, threads, limits };
}

describe("which Codex sessions lastdrop routes", () => {
  it("only T3's CLI-login instances on the shared ~/.codex", () => {
    const cases: Array<[string, CodexSettings, NodeJS.ProcessEnv, boolean]> = [
      ["default", settings(), {}, true],
      ["explicit shared home", settings({ homePath: `${HOME}/` }), {}, true],
      ["managed (Add ChatGPT account)", settings({ setupMode: "managed" }), {}, false],
      ["own shadow home", settings({ shadowHomePath: "~/.codex-t3/me" }), {}, false],
      ["another home", settings({ homePath: "/elsewhere" }), {}, false],
      ["another home from the environment", settings(), { CODEX_HOME: "/elsewhere" }, false],
    ];
    for (const [name, value, environment, expected] of cases) {
      assert.strictEqual(isRoutable(value, environment, HOME), expected, name);
    }
  });

  it("an account's session runs in its home and keeps its sign-in in that home's auth.json", () => {
    const routed = withAccountHome(
      openInput({ settings: settings({ launchArgs: "--strict-config" }) }),
      "/d/codex/Work",
    );
    assert.strictEqual(routed.settings.homePath, "/d/codex/Work");
    assert.strictEqual(routed.environment["CODEX_HOME"], "/d/codex/Work");
    assert.strictEqual(
      routed.settings.launchArgs,
      `--strict-config -c 'cli_auth_credentials_store="file"'`,
    );
    // T3 lets this variable win over the setting, so it gets the same arguments.
    const overridden = withAccountHome(
      openInput({ environment: { T3CODE_CODEX_LAUNCH_ARGS: "--x" } }),
      "/h",
    );
    assert.strictEqual(
      overridden.environment["T3CODE_CODEX_LAUNCH_ARGS"],
      `--x -c 'cli_auth_credentials_store="file"'`,
    );
  });
});

describe("the wrapped factory", () => {
  it.effect("opens as T3 would when not routable or nobody is signed in", () =>
    Effect.gen(function* () {
      const opened: CodexOpenInput[] = [];
      const { client } = fakeClient({});
      const inner = {
        open: (input: CodexOpenInput) => Effect.sync(() => (opened.push(input), client)),
      };
      const managed = openInput({ settings: settings({ setupMode: "managed" }) });
      const wrapped = wrapCodexClientFactory(inner, {
        routing: fakeRouting({ account: "Work", home: "/d/codex/Work" }).routing,
        sharedHome: HOME,
      });
      assert.strictEqual(yield* Effect.scoped(wrapped.open(managed)), client);
      const nobody = wrapCodexClientFactory(inner, {
        routing: fakeRouting(undefined).routing,
        sharedHome: HOME,
      });
      const plain = openInput();
      assert.strictEqual(yield* Effect.scoped(nobody.open(plain)), client);
      assert.deepStrictEqual(opened, [managed, plain]);
    }),
  );

  it.effect("opens on the picked account and records its native threads and rate limits", () =>
    Effect.gen(function* () {
      const opened: CodexOpenInput[] = [];
      const { client, handlers } = fakeClient({
        "thread/start": { thread: { id: "native-1" } },
        "thread/resume": { thread: { id: "native-2" } },
        "turn/start": { turn: { id: "t" } },
      });
      const { routing, threads, limits } = fakeRouting({ account: "Work", home: "/d/codex/Work" });
      const wrapped = wrapCodexClientFactory(
        { open: (input) => Effect.sync(() => (opened.push(input), client)) },
        { routing, sharedHome: HOME },
      );
      const routed = yield* Effect.scoped(wrapped.open(openInput()));
      assert.strictEqual(opened[0]?.environment["CODEX_HOME"], "/d/codex/Work");
      yield* routed.request("thread/start", {});
      yield* routed.raw.request("thread/resume", { threadId: "native-2" });
      yield* routed.request("turn/start", { threadId: "native-1", input: [] });
      let seen: unknown;
      yield* routed.handleServerNotification("account/rateLimits/updated", (payload) =>
        Effect.sync(() => {
          seen = payload;
        }),
      );
      const snapshot = { primary: { usedPercent: 100 } };
      yield* handlers.get("account/rateLimits/updated")!({ rateLimits: snapshot });
      // T3's own handler still gets every update.
      assert.deepStrictEqual(seen, { rateLimits: snapshot });
      assert.deepStrictEqual(threads, [
        ["Work", "thread-1", "native-1"],
        ["Work", "thread-1", "native-2"],
      ]);
      assert.deepStrictEqual(limits, [["Work", snapshot]]);
    }),
  );
});
