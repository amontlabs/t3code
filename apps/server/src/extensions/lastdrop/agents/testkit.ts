/**
 * A fake native adapter for the agents tests, after T3's own in `ProviderSwitch.integration.test.ts`:
 * each turn answers with one assistant message, or fails with `failure` on `failedRunOrdinals`.
 */
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import {
  MessageId,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { makeProviderFailure } from "@t3tools/provider-core/server/failure";

export interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: string;
  readonly nativeThreadId: string | null;
}

export interface FakeCalls {
  readonly turns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injected: Ref.Ref<ReadonlyArray<unknown>>;
  /** Every input the adapter got, to prove it never sees the lastdrop identity. */
  readonly inputs: Ref.Ref<ReadonlyArray<unknown>>;
  readonly opened: Ref.Ref<ReadonlyArray<ProviderAdapter.ProviderAdapterV2OpenSessionInput>>;
}

export const makeFakeCalls = Effect.gen(function* () {
  return {
    turns: yield* Ref.make<ReadonlyArray<CapturedTurn>>([]),
    injected: yield* Ref.make<ReadonlyArray<unknown>>([]),
    inputs: yield* Ref.make<ReadonlyArray<unknown>>([]),
    opened: yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2OpenSessionInput>>([]),
  } satisfies FakeCalls;
});

const unimplemented = (driver: ProviderDriverKind, detail: string) =>
  Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));

export const makeFakeAdapter = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly calls: FakeCalls;
  readonly failedRunOrdinals?: ReadonlySet<number>;
  readonly failure?: ReturnType<typeof makeProviderFailure>;
  readonly failOpen?: boolean;
  /** A failed run leaves a command running, as a limit mid-command does. */
  readonly commandAtLimit?: boolean;
  /** Turns end only once this is done: a parent thread whose run stays active. */
  readonly holdTurns?: Deferred.Deferred<void>;
}): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId: input.instanceId,
  driver: input.driver,
  getCapabilities: () => Effect.succeed(input.capabilities),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: Effect.fn("FakeAdapter.openSession")(function* (sessionInput) {
    yield* Ref.update(input.calls.opened, (all) => [...all, sessionInput]);
    yield* Ref.update(input.calls.inputs, (all) => [...all, sessionInput]);
    if (input.failOpen === true)
      return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: input.driver,
        providerSessionId: sessionInput.providerSessionId,
        cause: "simulated open failure",
      });
    const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const now = yield* DateTime.now;
    const providerSession: OrchestrationV2ProviderSession = {
      id: sessionInput.providerSessionId,
      driver: input.driver,
      providerInstanceId: input.instanceId,
      status: "ready",
      cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
      model: sessionInput.modelSelection.model,
      capabilities: input.capabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const record = (value: unknown) => Ref.update(input.calls.inputs, (all) => [...all, value]);
    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: input.instanceId,
      driver: input.driver,
      providerSessionId: sessionInput.providerSessionId,
      providerSession,
      events: Stream.fromPubSub(events),
      ensureThread: Effect.fn("FakeAdapter.ensureThread")(function* (threadInput) {
        yield* record(threadInput);
        const createdAt = yield* DateTime.now;
        const nativeThreadId = `${input.instanceId}:${threadInput.threadId}`;
        return {
          id:
            threadInput.existingProviderThread?.id ??
            ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
          driver: input.driver,
          providerInstanceId: input.instanceId,
          providerSessionId: sessionInput.providerSessionId,
          appThreadId: threadInput.threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: input.driver,
            nativeId: nativeThreadId,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          contextUsage: null,
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
        } satisfies OrchestrationV2ProviderThread;
      }),
      resumeThread: ({ providerThread }) => record(providerThread).pipe(Effect.as(providerThread)),
      injectHistory: (history) =>
        Ref.update(input.calls.injected, (current) => [
          ...current,
          ...historyResponseItems(history.messages, history.context),
        ]).pipe(Effect.andThen(record(history)), Effect.as(true)),
      startTurn: Effect.fn("FakeAdapter.startTurn")(function* (turnInput) {
        yield* record(turnInput);
        yield* Ref.update(input.calls.turns, (turns) => [
          ...turns,
          {
            instanceId: input.instanceId,
            text: turnInput.message.text,
            modelSelection: turnInput.modelSelection,
            runtimeMode: turnInput.runtimePolicy.runtimeMode,
            nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
          },
        ]);
        yield* Effect.yieldNow;
        const eventTime = yield* DateTime.now;
        const providerTurnId = ProviderTurnId.make(
          `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
        );
        const failed = input.failedRunOrdinals?.has(turnInput.runOrdinal) === true;
        const status = failed ? ("failed" as const) : ("completed" as const);
        const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
          {
            type: "provider_turn.updated",
            driver: input.driver,
            providerTurn: {
              id: providerTurnId,
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: {
                driver: input.driver,
                nativeId: `native-turn:${input.instanceId}:${turnInput.runOrdinal}`,
                strength: "strong",
              },
              ordinal: turnInput.runOrdinal,
              status,
              startedAt: eventTime,
              completedAt: eventTime,
            },
          },
          {
            type: "turn_item.updated",
            driver: input.driver,
            turnItem: {
              id: TurnItemId.make(
                `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              ),
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: turnInput.runOrdinal * 100 + 1,
              status,
              title: null,
              startedAt: eventTime,
              completedAt: eventTime,
              updatedAt: eventTime,
              type: "assistant_message",
              messageId: MessageId.make(
                `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              ),
              text: failed
                ? `Partial work by ${input.instanceId}`
                : `${input.instanceId} answer for run ${turnInput.runOrdinal}`,
              streaming: false,
            },
          },
          ...(failed && input.commandAtLimit === true
            ? [
                {
                  type: "turn_item.updated" as const,
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:command`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 2,
                    status: "running" as const,
                    title: null,
                    startedAt: eventTime,
                    completedAt: null,
                    updatedAt: eventTime,
                    type: "command_execution" as const,
                    input: "pnpm test",
                  },
                },
              ]
            : []),
          {
            type: "turn.terminal",
            driver: input.driver,
            providerThreadId: turnInput.providerThread.id,
            providerTurnId,
            runOrdinal: turnInput.runOrdinal,
            ...(failed
              ? {
                  status: "failed" as const,
                  failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                  failure: input.failure!,
                }
              : { status: "completed" as const, failure: null }),
            threadDisposition: "reusable",
          },
        ];
        const publish = Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
          discard: true,
        });
        if (input.holdTurns === undefined) yield* publish;
        else {
          // The turn starts now and ends at the release.
          const started = providerEvents[0]!;
          if (started.type === "provider_turn.updated")
            yield* PubSub.publish(events, {
              ...started,
              providerTurn: { ...started.providerTurn, status: "running", completedAt: null },
            });
          yield* Effect.forkDetach(
            Deferred.await(input.holdTurns).pipe(
              Effect.andThen(
                Effect.forEach(providerEvents.slice(1), (event) => PubSub.publish(events, event), {
                  discard: true,
                }),
              ),
            ),
          );
        }
      }),
      steerTurn: () => Effect.void,
      interruptTurn: () => Effect.void,
      respondToRuntimeRequest: () => Effect.void,
      readThreadSnapshot: () => unimplemented(input.driver, "readThreadSnapshot unused"),
      rollbackThread: () => unimplemented(input.driver, "rollbackThread unused"),
      forkThread: () => unimplemented(input.driver, "forkThread unused"),
    };
    return runtime;
  }),
});
