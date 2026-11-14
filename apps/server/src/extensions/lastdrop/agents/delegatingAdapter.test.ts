/**
 * Step 5 spike: T3's recorded Claude replay fixtures, run through OrchestratorV2 with the thread
 * on the `lastdrop` instance (model "build"), whose adapter forwards to T3's real Claude adapter
 * (replayed SDK). Each fixture's own output checks run unchanged, then identity checks: every
 * persisted record names `lastdrop`, and the Claude adapter saw only `claudeAgent` and its model.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ServerProviderModel,
  type ModelSelection,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { ClaudeOrchestratorReplayHarness } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
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
import { agentModels, spikeAgents } from "./catalog.ts";
import { makeDelegatingAdapter } from "./delegatingAdapter.ts";

const LASTDROP = ProviderInstanceId.make("lastdrop");
const CLAUDE = CLAUDE_MODEL_SELECTION.instanceId;
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const AGENTS = [
  ...spikeAgents(CLAUDE_MODEL_SELECTION.model),
  // Antigravity first, out of room: the session must open on Claude, the next step.
  {
    name: "fallback",
    description: "Antigravity, then Claude.",
    enabled: true,
    chain: [
      { instanceId: ANTIGRAVITY, providerLabel: "Antigravity", model: "claude-sonnet-5-5" },
      { instanceId: CLAUDE, providerLabel: "Claude", model: CLAUDE_MODEL_SELECTION.model },
    ],
  },
];
/** The agent the scenario's thread uses. */
let agentName = "build";
/** Steps whose room was asked, in order. */
const roomAsked: Array<ProviderInstanceId> = [];

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

const lastdropHarness: typeof ClaudeOrchestratorReplayHarness = {
  ...ClaudeOrchestratorReplayHarness,
  makeProviderAdapterRegistryLayer: (transcript, options) =>
    Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const claudeRegistry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        const claude = yield* claudeRegistry.get(CLAUDE).pipe(Effect.orDie);
        const lastdrop = makeDelegatingAdapter({
          instanceId: LASTDROP,
          agents: AGENTS,
          hasRoom: (step) =>
            Effect.sync(() => {
              roomAsked.push(step.instanceId);
              return step.instanceId !== ANTIGRAVITY;
            }),
          resolveTarget: (id) => Effect.succeed(id === CLAUDE ? spyAdapter(claude) : undefined),
        });
        return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          get: (id) =>
            id === LASTDROP
              ? Effect.succeed(lastdrop)
              : id === CLAUDE
                ? Effect.succeed(claude)
                : claudeRegistry.get(id),
          list: () => Effect.succeed([CLAUDE, LASTDROP]),
        });
      }),
    ).pipe(
      Layer.provide(
        ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, options),
      ),
    ),
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
  // The Claude SDK still gets Claude's runtime instructions and model.
  const replay = materializeReplayTranscriptRuntimeInstructions(sliced, {
    driver: variant.driver,
    model: variant.modelSelection.model,
  });
  const fixtureInput = buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const transcript = yield* lastdropHarness.decodeTranscript(replay);
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

const claudeVariants = ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
  fixture.providers
    .filter((provider) => provider.driver === "claudeAgent")
    .map((provider) => [fixture.name, fixture, provider] as const),
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

const decodeModel = Schema.decodeSync(ServerProviderModel);

/** The result as if the thread had been on Claude directly. */
const asClaude = (value: unknown): unknown => {
  if (value instanceof Map)
    return new Map([...value].map(([key, entry]) => [key, asClaude(entry)]));
  if (Array.isArray(value)) return value.map(asClaude);
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
          ? CLAUDE_MODEL_SELECTION
          : { ...(entry as ModelSelection), instanceId: CLAUDE };
    else if ((key === "providerInstanceId" || key === "instanceId") && entry === LASTDROP)
      out[key] = CLAUDE;
    else out[key] = asClaude(entry);
  }
  return out;
};

describe("lastdrop delegating adapter (step 5 spike)", () => {
  it.effect.each(claudeVariants)(
    "replays %s through lastdrop → claudeAgent",
    ([fixtureName, fixture, variant]) =>
      Effect.gen(function* () {
        const { result, transcript } = yield* runThroughLastdrop(
          fixtureName,
          fixture.buildInput,
          variant,
        );
        // T3's own checks for this fixture: rows, approvals, rollback, subagents.
        // T3's fixture checks pin the thread to Claude's instance; they run on a view of the
        // result with lastdrop's identity mapped back, so they judge only the behaviour.
        variant.assertOutput(asClaude(result) as typeof result, transcript);
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
            assert.equal(session.driver, "claudeAgent");
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
      variant.assertOutput(asClaude(result) as typeof result, transcript);
      assert.deepEqual(roomAsked, [ANTIGRAVITY, CLAUDE]);
      const projection = [...result.projections.values()][0]!;
      assert.equal(projection.runs[0]!.modelSelection.model, "fallback");
      assert.equal(projection.providerSessions[0]!.providerInstanceId, LASTDROP);
    }).pipe(Effect.scoped),
  );

  it("publishes agents with subProvider and per-model effort", () => {
    const models = agentModels(AGENTS);
    for (const model of models) decodeModel(model);
    assert.deepEqual(
      models.map((model) => [model.slug, model.subProvider]),
      [
        ["build", "Claude · claude-sonnet-4-6"],
        ["judge", "Claude · claude-sonnet-4-6"],
        ["fallback", "Antigravity · claude-sonnet-5-5, then Claude · claude-sonnet-4-6"],
      ],
    );
    const effort = (slug: string) =>
      models
        .find((model) => model.slug === slug)
        ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "effort");
    assert.isDefined(effort("build"));
    // A fixed-effort agent offers no effort.
    assert.isUndefined(effort("judge"));
  });
});
