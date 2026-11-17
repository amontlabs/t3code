/**
 * T3's recorded Claude replay fixtures, run through OrchestratorV2 with the thread on the lastdrop
 * instance (model "build"), whose router forwards to T3's real Claude adapter (replayed SDK). Each fixture's own output checks run unchanged, then identity checks: every
 * persisted record names `lastdrop`, and the Claude adapter saw only `claudeAgent` and its model.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { ClaudeOrchestratorReplayHarness } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../../../orchestration-v2/testkit/fixtures/index.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "../../../orchestration-v2/testkit/fixtures/shared.ts";
import { readReplayFixtureTranscript } from "../../../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../../../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import { fallbackThreads, type AgentDefinition, type AgentStep } from "./catalog.ts";
import { makeFallbackSignals, makeRoom, type Room } from "./room.ts";
import { makeRouterAdapter } from "./router.ts";
import type { NativeEntry } from "./shared.ts";
import { makeStoredMap } from "./store.ts";

const LASTDROP = ProviderInstanceId.make("lastdrop");
const CLAUDE = CLAUDE_MODEL_SELECTION.instanceId;
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
/** The native instance and model the scenario's agent runs on (Claude's or Codex's fixtures). */
let inner: ModelSelection = CLAUDE_MODEL_SELECTION;
const innerStep = (): AgentStep => ({
  provider: inner.instanceId === CLAUDE ? "claude" : "codex",
  instanceId: inner.instanceId,
  providerLabel: inner.instanceId === CLAUDE ? "Claude" : "Codex",
  model: inner.model,
});
const agents = (): ReadonlyArray<AgentDefinition> => [
  { name: "build", description: "Implementation.", enabled: true, chain: [innerStep()] },
  // Antigravity first, out of room: the session must open on Claude, the next entry.
  {
    name: "fallback",
    description: "Antigravity, then Claude.",
    enabled: true,
    chain: [
      {
        provider: "antigravity",
        instanceId: ANTIGRAVITY,
        providerLabel: "Antigravity",
        model: "claude-sonnet-5-5",
      },
      innerStep(),
    ],
  },
];
/** The agent the scenario's thread uses. */
let agentName = "build";
/** Steps whose room was asked, in order. */
const roomAsked: Array<ProviderInstanceId> = [];

/** Which entry made each native thread, as the router records it. */
const nativeEntries = makeStoredMap<NativeEntry>();

/** What the Claude adapter was called with, to prove it never sees the lastdrop identity. */
const innerCalls: Array<unknown> = [];

const spyAdapter = (adapter: ProviderAdapterV2["Service"]) => ({
  ...adapter,
  openSession: (input: Parameters<typeof adapter.openSession>[0]) => {
    innerCalls.push(input);
    return adapter.openSession(input).pipe(
      Effect.map((runtime) => {
        const spied = { ...runtime };
        for (const key of [
          "ensureThread",
          "resumeThread",
          "startTurn",
          "steerTurn",
          "respondToRuntimeRequest",
          "rollbackThread",
          "forkThread",
          "readThreadSnapshot",
          "interruptTurn",
        ] as const) {
          const call = runtime[key] as (input: unknown) => Effect.Effect<unknown, never>;
          (spied as Record<string, unknown>)[key] = (input: unknown) => {
            innerCalls.push(input);
            return call(input);
          };
        }
        return spied;
      }),
    );
  },
});

type AnyHarness = typeof ClaudeOrchestratorReplayHarness;

/** A native harness whose registry also holds lastdrop's router over that native adapter. */
const lastdropHarnessOver = (base: AnyHarness): AnyHarness => ({
  ...base,
  makeProviderAdapterRegistryLayer: (transcript, options) =>
    Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const nativeRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        const native = yield* nativeRegistry.get(inner.instanceId).pipe(Effect.orDie);
        const room: Room = {
          ...makeRoom(),
          out: (step) =>
            Effect.sync(() => {
              roomAsked.push(step.instanceId);
              return step.instanceId === ANTIGRAVITY ? "reached a usage limit" : undefined;
            }),
        };
        const lastdrop = makeRouterAdapter({
          instanceId: LASTDROP,
          agents,
          room,
          fallbacks: makeFallbackSignals(),
          nativeEntries,
          // Antigravity's instance exists here: only its room keeps it out.
          resolveTarget: (id) =>
            Effect.succeed(
              id === inner.instanceId
                ? spyAdapter(native)
                : id === ANTIGRAVITY
                  ? native
                  : undefined,
            ),
        });
        return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          get: (id) => (id === LASTDROP ? Effect.succeed(lastdrop) : nativeRegistry.get(id)),
          list: () => Effect.succeed([inner.instanceId, LASTDROP]),
        });
      }),
    ).pipe(Layer.provide(base.makeProviderAdapterRegistryLayer(transcript, options))),
});
const HARNESSES: Record<string, AnyHarness> = {
  claudeAgent: lastdropHarnessOver(ClaudeOrchestratorReplayHarness),
  codex: lastdropHarnessOver(CodexOrchestratorReplayHarness as unknown as AnyHarness),
};

const runThroughLastdrop = Effect.fn("runThroughLastdrop")(function* (
  fixtureName: string,
  buildInput: () => OrchestratorFixtureInput,
  variant: ProviderOrchestratorReplayVariant,
) {
  const recorded = yield* readReplayFixtureTranscript(variant.transcriptFile);
  const throughLabel = variant.transcriptEntriesThroughLabel;
  const sliced: ProviderReplayTranscript =
    throughLabel === undefined
      ? recorded
      : {
          ...recorded,
          entries: recorded.entries.slice(
            0,
            recorded.entries.findIndex(
              (entry) => entry.type === "emit_inbound" && entry.label === throughLabel,
            ) + 1,
          ),
        };
  // The native SDK still gets its own runtime instructions and model.
  const replay = materializeReplayTranscriptRuntimeInstructions(sliced, {
    driver: variant.driver,
    model: variant.modelSelection.model,
  });
  inner = variant.modelSelection;
  const lastdropHarness = HARNESSES[variant.driver]!;
  const fixtureInput = buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  // Codex's recordings name the workspace by a placeholder, as T3's own Codex replay fills in.
  const transcript = yield* lastdropHarness.decodeTranscript(
    variant.driver === "codex" ? materializeReplayTranscriptWorkspace(replay, workspace) : replay,
  );
  // The thread itself is on lastdrop's "build" agent.
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: variant.driver,
    modelSelection: { instanceId: LASTDROP, model: agentName },
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  innerCalls.length = 0;
  roomAsked.length = 0;
  const result = yield* runOrchestratorV2ProviderReplayScenario(
    {
      name: `${fixtureName}/lastdrop`,
      transcript,
      commands: materialized.commands,
      steps: materialized.steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
    },
    lastdropHarness,
    variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
  ).pipe(provideDeterministicTestRuntime);
  return { result, transcript };
});

const nativeVariants = ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
  fixture.providers
    .filter((provider) => provider.driver === "claudeAgent" || provider.driver === "codex")
    .map((provider) => [`${provider.driver}/${fixture.name}`, fixture, provider] as const),
);

/** Every instance id in a value, by field name. */
const instanceIds = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((entry) => instanceIds(entry, found));
  else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "providerInstanceId" || key === "instanceId") && typeof entry === "string")
        found.add(entry);
      else instanceIds(entry, found);
    }
  }
  return found;
};

/** The result as if the thread had been on the native instance directly. */
const asInner = (value: unknown): unknown => {
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [key, asInner(entry)]));
  if (Array.isArray(value)) return value.map(asInner);
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key.toLowerCase().endsWith("modelselection") &&
      entry !== null &&
      typeof entry === "object" &&
      (entry as ModelSelection).instanceId === LASTDROP
    )
      out[key] =
        (entry as ModelSelection).model === agentName
          ? inner
          : { ...(entry as ModelSelection), instanceId: inner.instanceId };
    else if ((key === "providerInstanceId" || key === "instanceId") && entry === LASTDROP)
      out[key] = inner.instanceId;
    else out[key] = asInner(entry);
  }
  return out;
};

describe("lastdrop router over T3's Claude and Codex adapters", () => {
  it.effect.each(nativeVariants)("replays %s through lastdrop", ([label, fixture, variant]) =>
    Effect.gen(function* () {
      const fixtureName = label;
      const { result, transcript } = yield* runThroughLastdrop(
        fixture.name,
        fixture.buildInput,
        variant,
      );
      // T3's own checks for this fixture: rows, approvals, rollback, subagents.
      // T3's fixture checks pin the thread to Claude's instance; they run on a view of the
      // result with lastdrop's identity mapped back, so they judge only the behaviour.
      variant.assertOutput(asInner(result) as typeof result, transcript);
      for (const projection of result.projections.values()) {
        // Persisted identity: lastdrop only, driver stays Claude's.
        assert.deepEqual(
          [...instanceIds(projection)].filter((id) => id !== LASTDROP),
          [],
          `${fixtureName}: thread ${projection.thread.id} has a non-lastdrop instance id`,
        );
        for (const run of projection.runs) assert.equal(run.modelSelection.model, agentName);
        for (const session of projection.providerSessions) {
          assert.equal(session.providerInstanceId, LASTDROP);
          assert.equal(session.driver, variant.driver);
        }
        for (const thread of projection.providerThreads) {
          assert.equal(thread.providerInstanceId, LASTDROP);
        }
      }
      for (const event of result.domainEvents) {
        if ("providerInstanceId" in event && event.providerInstanceId !== undefined) {
          assert.equal(event.providerInstanceId, LASTDROP);
        }
      }
      // The Claude adapter saw only its own identity and model.
      assert.isAbove(innerCalls.length, 0);
      const seen = instanceIds(innerCalls);
      assert.isFalse(seen.has(LASTDROP), `${fixtureName}: Claude adapter was given lastdrop ids`);
      assert.isFalse(
        JSON.stringify(innerCalls).includes(`"model":"${agentName}"`),
        `${fixtureName}: Claude adapter was given the agent name as its model`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("opens on the next step when the first has no room", () =>
    Effect.gen(function* () {
      const simple = ORCHESTRATOR_REPLAY_FIXTURES.find((fixture) => fixture.name === "simple")!;
      const variant = simple.providers.find((provider) => provider.driver === "claudeAgent")!;
      agentName = "fallback";
      const { result, transcript } = yield* runThroughLastdrop(
        "simple",
        simple.buildInput,
        variant,
      ).pipe(Effect.ensuring(Effect.sync(() => (agentName = "build"))));
      variant.assertOutput(asInner(result) as typeof result, transcript);
      // At open: Antigravity first (no room), then Claude. Capabilities may ask before.
      assert.deepEqual(roomAsked.slice(-2), [ANTIGRAVITY, CLAUDE]);
      const projection = [...result.projections.values()][0]!;
      assert.equal(projection.runs[0]!.modelSelection.model, "fallback");
      assert.equal(projection.providerSessions[0]!.providerInstanceId, LASTDROP);
      // The thread is listed on its fallback entry, for the subagent card's hover.
      assert.deepEqual(fallbackThreads(agents(), nativeEntries.entries()).get("fallback"), {
        [projection.thread.id]: 1,
      });
    }).pipe(Effect.scoped),
  );
});
