/**
 * The router's targets with fake native adapters: Antigravity (no recorded fixtures in T3), Z.ai
 * and OpenRouter as Claude instances, an entry whose instance is missing or fails to open, the
 * permission mapping, and the driver's published snapshot.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ClaudeProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { allAgents, parseCatalog, type AgentDefinition } from "./catalog.ts";
import { makeLastdropAgentsDriver } from "./driver.ts";
import { entryRuntimeMode } from "./permissions.ts";
import { makeFallbackSignals, makeRoom } from "./room.ts";
import { makeRouterAdapter } from "./router.ts";
import { makeFakeAdapter, makeFakeCalls } from "./testkit.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const LASTDROP = ProviderInstanceId.make("lastdropAgents");
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const ZAI = ProviderInstanceId.make("zai");
const OPENROUTER = ProviderInstanceId.make("openrouter");

const agents = allAgents(
  parseCatalog({
    agents: [
      {
        name: "live",
        description: "Live checks.",
        provider: "antigravity",
        model: "claude-sonnet-5-5",
        enabled: true,
        fallbacks: [{ provider: "claude", model: "sonnet" }],
      },
      {
        name: "cheap",
        description: "Cheap work.",
        provider: "zai",
        model: "glm-5.3-flash",
        enabled: true,
        fallbacks: [{ provider: "openrouter", model: "qwen-4" }],
      },
    ],
  }),
);

const openOn = Effect.fn("openOn")(function* (input: {
  readonly agent: string;
  readonly available: ReadonlyArray<ProviderInstanceId>;
  readonly failOpen?: ReadonlyArray<ProviderInstanceId>;
  readonly runtimeMode?: "auto" | "full-access" | "approval-required";
  readonly agents?: ReadonlyArray<AgentDefinition>;
}) {
  const calls = yield* makeFakeCalls;
  const fake = (instanceId: ProviderInstanceId, driver: string) =>
    makeFakeAdapter({
      instanceId,
      driver: ProviderDriverKind.make(driver),
      capabilities: driver === "acp" ? AcpProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      calls,
      failOpen: input.failOpen?.includes(instanceId) === true,
    });
  const adapters = new Map([
    [ANTIGRAVITY, fake(ANTIGRAVITY, "antigravity")],
    [CLAUDE, fake(CLAUDE, "claudeAgent")],
    [ZAI, fake(ZAI, "claudeAgent")],
    [OPENROUTER, fake(OPENROUTER, "claudeAgent")],
  ]);
  const router = makeRouterAdapter({
    instanceId: LASTDROP,
    agents: () => input.agents ?? agents,
    resolveTarget: (id) =>
      Effect.succeed(input.available.includes(id) ? adapters.get(id) : undefined),
    room: makeRoom(),
    fallbacks: makeFallbackSignals(),
  });
  const runtime = yield* router.openSession({
    threadId: ThreadId.make("thread:targets"),
    providerSessionId: ProviderSessionId.make("session:targets"),
    modelSelection: { instanceId: LASTDROP, model: input.agent },
    runtimePolicy: {
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: "default",
      cwd: null,
    },
  } as never);
  const opened = yield* Ref.get(calls.opened);
  return { runtime, opened, last: opened.at(-1)! };
});

describe("lastdrop router targets", () => {
  it.effect("runs an Antigravity entry on the Antigravity instance, with its model", () =>
    Effect.gen(function* () {
      const { runtime, last } = yield* openOn({
        agent: "live",
        available: [ANTIGRAVITY, CLAUDE],
      });
      assert.equal(runtime.instanceId, LASTDROP);
      assert.equal(runtime.driver, "antigravity");
      assert.equal(runtime.providerSession.providerInstanceId, LASTDROP);
      assert.deepEqual(last.modelSelection, {
        instanceId: ANTIGRAVITY,
        model: "claude-sonnet-5-5",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("skips an entry whose instance is missing or disabled, like one without room", () =>
    Effect.gen(function* () {
      const { opened, last } = yield* openOn({ agent: "live", available: [CLAUDE] });
      assert.equal(opened.length, 1);
      assert.deepEqual(last.modelSelection, { instanceId: CLAUDE, model: "sonnet" });
    }).pipe(Effect.scoped),
  );

  it.effect("goes on to the next entry when an entry fails to open", () =>
    Effect.gen(function* () {
      const { opened, last } = yield* openOn({
        agent: "live",
        available: [ANTIGRAVITY, CLAUDE],
        failOpen: [ANTIGRAVITY],
      });
      assert.deepEqual(
        opened.map((input) => input.modelSelection.instanceId),
        [ANTIGRAVITY, CLAUDE],
      );
      assert.equal(last.modelSelection.instanceId, CLAUDE);
    }).pipe(Effect.scoped),
  );

  it.effect("runs Z.ai and OpenRouter entries on their Claude instances", () =>
    Effect.gen(function* () {
      const zai = yield* openOn({ agent: "cheap", available: [ZAI, OPENROUTER] });
      assert.deepEqual(zai.last.modelSelection, { instanceId: ZAI, model: "glm-5.3-flash" });
      assert.equal(zai.runtime.driver, "claudeAgent");
      const openrouter = yield* openOn({ agent: "cheap", available: [OPENROUTER] });
      assert.deepEqual(openrouter.last.modelSelection, { instanceId: OPENROUTER, model: "qwen-4" });
    }).pipe(Effect.scoped),
  );

  it.effect("fails to open when no entry is usable, naming the chain", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(openOn({ agent: "cheap", available: [] }));
      assert.include(String((failed as { cause?: unknown }).cause), "Z.ai · glm-5.3-flash");
    }).pipe(Effect.scoped),
  );

  it.effect("runs an auto thread's Antigravity entry in full access, others as they are", () =>
    Effect.gen(function* () {
      const antigravity = yield* openOn({
        agent: "live",
        available: [ANTIGRAVITY],
        runtimeMode: "auto",
      });
      assert.equal(antigravity.last.runtimePolicy.runtimeMode, "full-access");
      const claude = yield* openOn({ agent: "live", available: [CLAUDE], runtimeMode: "auto" });
      assert.equal(claude.last.runtimePolicy.runtimeMode, "auto");
      const asked = yield* openOn({
        agent: "live",
        available: [ANTIGRAVITY],
        runtimeMode: "approval-required",
      });
      assert.equal(asked.last.runtimePolicy.runtimeMode, "approval-required");
      const step = agents.find((agent) => agent.name === "live")!.chain[0]!;
      // A managed ceiling under full access keeps the thread's mode.
      assert.equal(entryRuntimeMode(step, "auto", "auto-accept-edits"), "auto");
    }).pipe(Effect.scoped),
  );
});

describe("lastdrop agents driver", () => {
  it.effect("publishes Claude's models, the agents, and the chain instances' own as legacy", () =>
    Effect.gen(function* () {
      const reading = { agents, efforts: {} };
      const driver = makeLastdropAgentsDriver(() => ({
        current: () => reading,
        reloadIfChanged: () => false,
      }));
      const instance = yield* driver.create({
        instanceId: LASTDROP,
        displayName: undefined,
        environment: [] as never,
        enabled: true,
        config: driver.defaultConfig(),
      });
      const snapshot = decodeProvider(yield* instance.snapshot.getSnapshot);
      assert.equal(snapshot.driver, "lastdropAgents");
      assert.equal(snapshot.displayName, "lastdrop");
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(
        snapshot.models.filter((model) => model.isLegacy !== true).map((model) => model.slug),
        ["fable", "opus", "sonnet", "haiku", "live", "cheap"],
      );
      assert.equal(instance.orchestrationAdapter.driver, "lastdropAgents");
    }).pipe(Effect.scoped),
  );
});
