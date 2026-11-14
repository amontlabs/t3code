// @effect-diagnostics nodeBuiltinImport:off - Temporary store files.
/**
 * The router's targets with fake native adapters: Antigravity (no recorded fixtures in T3), Z.ai
 * and OpenRouter as Claude instances, an entry whose instance is missing or fails to open, the
 * permission mapping, and the driver's published snapshot.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
import { ALL_RUNTIME_MODES, entryRuntimeMode } from "./permissions.ts";
import { makeFallbackSignals, makeRoom, type Room } from "./room.ts";
import type { NativeEntry } from "./shared.ts";
import { makeStoredMap, type StoredMap } from "./store.ts";
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
  readonly room?: Room;
  readonly nativeEntries?: StoredMap<NativeEntry>;
  readonly initialNativeThreadId?: string;
  readonly resumeDriver?: string;
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
    room: input.room ?? makeRoom(),
    fallbacks: makeFallbackSignals(),
    ...(input.nativeEntries === undefined ? {} : { nativeEntries: input.nativeEntries }),
    // Antigravity has no auto mode (`AntigravityProvider.ts`); Claude instances take every mode.
    innerRuntimeModes: (id) =>
      Effect.succeed(id === ANTIGRAVITY ? ANTIGRAVITY_MODES : [...ALL_RUNTIME_MODES]),
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
    ...(input.initialNativeThreadId === undefined
      ? {}
      : { initialNativeThreadId: input.initialNativeThreadId }),
    ...(input.resumeDriver === undefined
      ? {}
      : { resumeFromSession: { driver: input.resumeDriver } }),
  } as never);
  const opened = yield* Ref.get(calls.opened);
  return { runtime, opened, last: opened.at(-1)!, router };
});

const ANTIGRAVITY_MODES = ["approval-required", "auto-accept-edits", "full-access"] as const;

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

  it.effect("runs auto as accept-edits where the entry's instance has no auto mode", () =>
    Effect.gen(function* () {
      // Antigravity lacks `auto`: it runs accept-edits, and lastdrop answers its command prompts
      // (`commandAnswers.ts`) instead of the person.
      const antigravity = yield* openOn({
        agent: "live",
        available: [ANTIGRAVITY],
        runtimeMode: "auto",
      });
      assert.equal(antigravity.last.runtimePolicy.runtimeMode, "auto-accept-edits");
      const claude = yield* openOn({ agent: "live", available: [CLAUDE], runtimeMode: "auto" });
      assert.equal(claude.last.runtimePolicy.runtimeMode, "auto");
      const full = yield* openOn({
        agent: "live",
        available: [ANTIGRAVITY],
        runtimeMode: "full-access",
      });
      assert.equal(full.last.runtimePolicy.runtimeMode, "full-access");
      const asking = yield* openOn({
        agent: "live",
        available: [ANTIGRAVITY],
        runtimeMode: "approval-required",
      });
      assert.equal(asking.last.runtimePolicy.runtimeMode, "approval-required");
      // Z.ai keeps Claude Code's auto mode (its check works there); what it still asks, lastdrop answers.
      const zai = yield* openOn({ agent: "cheap", available: [ZAI], runtimeMode: "auto" });
      assert.equal(zai.last.runtimePolicy.runtimeMode, "auto");
      // OpenRouter's auto check is untested: accept-edits, every command answered by lastdrop.
      const openrouter = yield* openOn({
        agent: "cheap",
        available: [OPENROUTER],
        runtimeMode: "auto",
      });
      assert.equal(openrouter.last.runtimePolicy.runtimeMode, "auto-accept-edits");
      const step = agents.find((agent) => agent.name === "live")!.chain[0]!;
      // Antigravity has no auto mode, even with its modes unknown.
      assert.equal(entryRuntimeMode(step, "auto", undefined), "auto-accept-edits");
      assert.equal(entryRuntimeMode(step, "auto", ANTIGRAVITY_MODES), "auto-accept-edits");
      // A target with neither mode still asks the person.
      assert.equal(entryRuntimeMode(step, "auto", ["approval-required"]), "approval-required");
      // Plan mode: edits must reach lastdrop to be refused, so not accept-edits (review item 3).
      assert.equal(entryRuntimeMode(step, "auto", ANTIGRAVITY_MODES, "plan"), "approval-required");
      assert.equal(entryRuntimeMode(step, "auto", undefined, "plan"), "approval-required");
      const openrouterStep = agents.find((agent) => agent.name === "cheap")!.chain[1]!;
      assert.equal(entryRuntimeMode(openrouterStep, "auto", [...ALL_RUNTIME_MODES], "plan"), "approval-required");
      const zaiStep = agents.find((agent) => agent.name === "cheap")!.chain[0]!;
      assert.equal(entryRuntimeMode(zaiStep, "auto", [...ALL_RUNTIME_MODES], "plan"), "auto");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps a moved thread on its entry after a restart, and resumes its native thread",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-entries-"));
        try {
          const file = NodePath.join(dir, "agent-threads.json");
          const roomFile = NodePath.join(dir, "agent-room.json");
          const before = makeStoredMap<NativeEntry>();
          before.attach(file);
          const marks = makeStoredMap<number>();
          marks.attach(roomFile);
          const room = makeRoom(Date.now, marks);
          const live = agents.find((agent) => agent.name === "live")!;
          yield* room.markOut(live.chain[0]!, null);
          const first = yield* openOn({
            agent: "live",
            available: [ANTIGRAVITY, CLAUDE],
            room,
            nativeEntries: before,
          });
          const thread = yield* first.runtime.ensureThread({
            threadId: ThreadId.make("thread:targets"),
            modelSelection: { instanceId: LASTDROP, model: "live" },
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          } as never);
          const nativeId = thread.nativeThreadRef!.nativeId!;
          // A new server: maps loaded from the files only.
          const after = makeStoredMap<NativeEntry>();
          after.attach(file);
          const reloaded = makeStoredMap<number>();
          reloaded.attach(roomFile);
          const reopened = yield* openOn({
            agent: "live",
            available: [ANTIGRAVITY, CLAUDE],
            room: makeRoom(Date.now, reloaded),
            nativeEntries: after,
            initialNativeThreadId: nativeId,
          });
          assert.equal(reopened.last.modelSelection.instanceId, CLAUDE);
          assert.equal(reopened.last.initialNativeThreadId, nativeId);
          const resumed = yield* reopened.runtime.resumeThread({ providerThread: thread } as never);
          assert.equal(resumed.nativeThreadRef!.nativeId, nativeId);
          // The room marks came back too: Antigravity is still out after the restart.
          assert.isFalse(yield* makeRoom(Date.now, reloaded).hasRoom(live.chain[0]!));
          // Antigravity has room again: the thread still stays where its conversation is.
          const stays = yield* openOn({
            agent: "live",
            available: [ANTIGRAVITY, CLAUDE],
            nativeEntries: after,
            initialNativeThreadId: nativeId,
          });
          assert.equal(stays.last.modelSelection.instanceId, CLAUDE);
        } finally {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }).pipe(Effect.scoped),
  );

  it.effect("never resumes an unknown native thread when two entries share a driver", () =>
    Effect.gen(function* () {
      // Z.ai and OpenRouter are both Claude-driver instances; the map was lost.
      const opened = yield* openOn({
        agent: "cheap",
        available: [ZAI, OPENROUTER],
        nativeEntries: makeStoredMap<NativeEntry>(),
        initialNativeThreadId: "openrouter:thread:targets",
        resumeDriver: "claudeAgent",
      });
      assert.equal(opened.last.modelSelection.instanceId, ZAI);
      assert.isUndefined(opened.last.initialNativeThreadId);
      const failed = yield* Effect.flip(
        opened.runtime.resumeThread({
          providerThread: {
            id: "provider-thread:x",
            driver: "claudeAgent",
            nativeThreadRef: {
              driver: "claudeAgent",
              nativeId: "openrouter:thread:targets",
              strength: "strong",
            },
          },
        } as never),
      );
      assert.equal(failed._tag, "ProviderAdapterResumeThreadError");
    }).pipe(Effect.scoped),
  );

  it.effect("gives capabilities when the first agent is out, and never fails", () =>
    Effect.gen(function* () {
      const room = makeRoom();
      for (const agent of agents) for (const step of agent.chain) yield* room.markOut(step, null);
      const { router } = yield* openOn({ agent: "live", available: [ANTIGRAVITY, CLAUDE] });
      // Out of room everywhere: still the targets' common capabilities.
      const outRouter = makeRouterAdapter({
        instanceId: LASTDROP,
        agents: () => agents,
        resolveTarget: () => Effect.undefined,
        room,
        fallbacks: makeFallbackSignals(),
      });
      const none = yield* outRouter.getCapabilities();
      assert.isDefined(none.sessions);
      const both = yield* router.getCapabilities();
      assert.isDefined(both.turns);
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
      assert.equal(snapshot.displayName, "lastdrop agents");
      assert.deepEqual(snapshot.supportedRuntimeModes, [...ALL_RUNTIME_MODES]);
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(
        snapshot.models.filter((model) => model.isLegacy !== true).map((model) => model.slug),
        ["fable", "opus", "sonnet", "haiku", "live", "cheap"],
      );
      assert.equal(instance.orchestrationAdapter.driver, "lastdropAgents");
    }).pipe(Effect.scoped),
  );
});
