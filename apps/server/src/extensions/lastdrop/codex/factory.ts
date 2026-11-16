/**
 * Wraps T3's Codex app-server client factory: every Codex process T3 starts for a thread opens through `open`, so
 * the account is picked there by pointing `CODEX_HOME` at the account's shadow home. The client is passed back
 * as T3's, watched only for the native thread ids it starts or resumes and its rate-limit updates. Never edits
 * the adapter. Moving a running thread to another account (stage B) is not here; see docs/lastdrop/independence.md, item 5.
 */
import type { CodexSettings } from "@t3tools/contracts";
import type { CodexLimitSnapshot } from "@t3tools/lastdrop-node";
import { CODEX_FILE_STORE_LAUNCH_ARGS } from "@t3tools/lastdrop-node";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";

import type { CodexAppServerClientFactoryShape } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { resolveCodexLaunchArgs } from "../../../provider/codexLaunchArgs.ts";

export type CodexOpenInput = Parameters<CodexAppServerClientFactoryShape["open"]>[0];
type Client = CodexClient.CodexAppServerClient["Service"];

/** The routing the wrapper asks (`routing.ts` over lastdrop's files; tests stand in another). */
export interface CodexRouting {
  /** The account a session of this T3 thread opens on, or undefined to open it as T3 would. */
  readonly route: (
    threadId: string,
  ) => Promise<{ readonly account: string; readonly home: string } | undefined>;
  readonly recordThread: (
    account: string,
    threadId: string,
    nativeThreadId: string,
  ) => Promise<void>;
  readonly observeLimits: (account: string, snapshot: CodexLimitSnapshot) => Promise<void>;
  readonly log: (line: string) => void;
}

const LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";
const THREAD_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutTrailingSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, "") : path);

/**
 * Only T3's own CLI-login instances on the shared `~/.codex` are routed: not a managed one (T3's "Add ChatGPT
 * account"), one with its own shadow home, or one on another Codex home (its sessions live elsewhere).
 */
export function isRoutable(
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  sharedHome: string,
): boolean {
  if (settings.setupMode === "managed") return false;
  if (settings.shadowHomePath.trim() !== "") return false;
  const home = settings.homePath.trim() || environment["CODEX_HOME"]?.trim() || sharedHome;
  return withoutTrailingSlash(home) === withoutTrailingSlash(sharedHome);
}

/** Settings and environment on the account's home, with Codex told to keep its sign-in in that home's `auth.json`. */
export function onAccountHome<S extends CodexSettings>(
  settings: S,
  environment: NodeJS.ProcessEnv,
  home: string,
): { readonly settings: S; readonly environment: NodeJS.ProcessEnv } {
  const launchArgs =
    `${resolveCodexLaunchArgs(settings.launchArgs, environment)} ${CODEX_FILE_STORE_LAUNCH_ARGS}`.trim();
  const accountEnvironment: NodeJS.ProcessEnv = { ...environment, CODEX_HOME: home };
  if (accountEnvironment[LAUNCH_ARGS_ENV]?.trim()) accountEnvironment[LAUNCH_ARGS_ENV] = launchArgs;
  return {
    settings: { ...settings, homePath: home, launchArgs },
    environment: accountEnvironment,
  };
}

/** The open input on the account's home (`onAccountHome`). */
export function withAccountHome(input: CodexOpenInput, home: string): CodexOpenInput {
  return { ...input, ...onAccountHome(input.settings, input.environment, home) };
}

const nativeThreadOf = (method: string, response: unknown): string | undefined => {
  if (!THREAD_METHODS.has(method) || !isRecord(response) || !isRecord(response["thread"])) {
    return undefined;
  }
  const id = response["thread"]["id"];
  return typeof id === "string" ? id : undefined;
};

/** T3's client, telling `onThread` each native thread it starts, resumes or forks and `onLimits` each update. */
function observeClient(
  client: Client,
  onThread: (nativeThreadId: string) => void,
  onLimits: (snapshot: CodexLimitSnapshot) => void,
): Client {
  const seen = (method: string) => (response: unknown) =>
    Effect.sync(() => {
      const id = nativeThreadOf(method, response);
      if (id !== undefined) onThread(id);
    });
  return {
    ...client,
    raw: {
      ...client.raw,
      request: (method, payload) =>
        client.raw.request(method, payload).pipe(Effect.tap(seen(method))),
    },
    request: (method, payload) => client.request(method, payload).pipe(Effect.tap(seen(method))),
    handleServerNotification: (method, handler) =>
      client.handleServerNotification(
        method,
        method === "account/rateLimits/updated"
          ? (payload) =>
              Effect.sync(() => {
                const update: unknown = payload;
                const snapshot = isRecord(update) ? update["rateLimits"] : undefined;
                if (isRecord(snapshot)) onLimits(snapshot);
              }).pipe(Effect.andThen(handler(payload)))
          : handler,
      ),
  };
}

/** The factory with each routable session opened on the account `routing` picks. */
export function wrapCodexClientFactory(
  inner: CodexAppServerClientFactoryShape,
  options: { readonly routing: CodexRouting; readonly sharedHome: string },
): CodexAppServerClientFactoryShape {
  const { routing, sharedHome } = options;
  const quietly = (what: string, run: () => Promise<void>) => {
    void run().catch((error: unknown) => routing.log(`codex: ${what} failed: ${String(error)}`));
  };
  return {
    open: Effect.fn("LastdropCodexRouting.open")(function* (input: CodexOpenInput) {
      if (!isRoutable(input.settings, input.environment, sharedHome))
        return yield* inner.open(input);
      const route = yield* Effect.tryPromise({
        try: () => routing.route(input.threadId),
        catch: (cause) => String(cause),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            routing.log(`codex: choosing an account failed, T3's own login opens: ${error}`);
            return undefined;
          }),
        ),
      );
      if (route === undefined) return yield* inner.open(input);
      const client = yield* inner.open(withAccountHome(input, route.home));
      return observeClient(
        client,
        (nativeThreadId) =>
          quietly("recording a thread", () =>
            routing.recordThread(route.account, input.threadId, nativeThreadId),
          ),
        (snapshot) =>
          quietly("recording usage", () => routing.observeLimits(route.account, snapshot)),
      );
    }),
  };
}
