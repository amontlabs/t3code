/**
 * Fallback partway through a run: the router ends the limited run as `cancelled` held by T3's
 * restart-continuation marker; once T3 settles it, release the session and re-send the run as its
 * continuation, so waiters follow it to the next entry (docs/lastdrop/step5.md).
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../../orchestration-v2/ProviderSessionManager.ts";
import type { FallbackSignals, PendingFallback } from "./room.ts";

/** What T3's own limit recovery sends (`UsageLimitRecoveryWorker`). */
export const CONTINUE_TEXT = "Continue where you left off.";
/** Added when the limit came while a command was running. */
export const INTERRUPTED_COMMAND_NOTE =
  "The previous model stopped at a usage limit while a command was running, so that command may have been interrupted. Check the current state (files, processes, git status) before running it again.";
/** When T3 runs a marker the reactor never settled (the server stopped mid-handover). */
export const HOLD_GRACE_MS = 60_000;

/** T3's restart-continuation marker for a run (`Orchestrator.awaitsRestartContinuation`). */
export const holdId = (runId: RunId) => `effect:restart-continuation:${runId}`;

type RunUpdated = Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>;

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);

const continueAfter = Effect.fn("LastdropFallback.continueAfter")(function* (
  pending: PendingFallback,
  event: RunUpdated,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const projection = yield* orchestrator.getThreadProjection(event.threadId);
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === event.payload.providerThreadId,
  );
  if (providerThread?.providerSessionId != null) {
    yield* sessions.release({
      providerSessionId: providerThread.providerSessionId,
      reason: "manual_shutdown",
      detail: `lastdrop: ${pending.agent} leaves ${pending.from} at a usage limit.`,
    });
  }
  yield* Effect.logInfo("lastdrop.fallback.continue", {
    threadId: event.threadId,
    agent: pending.agent,
    from: pending.from,
  });
  const cutOff = projection.turnItems.some(
    (item) =>
      item.runId === event.payload.id &&
      item.type === "command_execution" &&
      item.status !== "completed" &&
      item.status !== "failed",
  );
  // A Stop that reached the run makes T3 decline this (accepted, no run): the run stays stopped.
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`lastdrop-fallback:${event.payload.id}`),
    messageId: MessageId.make(`lastdrop-fallback:${event.payload.id}`),
    threadId: event.threadId,
    text: cutOff ? `${CONTINUE_TEXT}\n\n${INTERRUPTED_COMMAND_NOTE}` : CONTINUE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
    restartContinuationOfRunId: event.payload.id,
  });
});

/** Runs for the server's life: holds and continues each lastdrop run the router signalled. */
export const runFallbackReactor = Effect.fn("LastdropFallback.run")(function* (
  signals: FallbackSignals,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;

  const hold = Effect.fn("LastdropFallback.hold")(
    function* (pending: PendingFallback) {
      const now = yield* DateTime.now;
      yield* outbox.enqueue([
        {
          id: holdId(pending.runId),
          commandId: CommandId.make(`lastdrop-fallback-hold:${pending.runId}`),
          threadId: pending.threadId,
          request: { type: "provider-runtime.continue", sourceRunId: pending.runId },
          availableAt: DateTime.add(now, { milliseconds: HOLD_GRACE_MS }),
        },
      ]);
      return true;
    },
    (effect, pending) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("lastdrop.fallback.hold-failed", {
            threadId: pending.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      ),
  );

  // The continuation exists (or was declined): waiters follow it now, not the marker. Any other
  // pending continuation marker on this thread is older than this run, so stale for T3 too.
  const settle = (threadId: ThreadId) =>
    outbox
      .cancelUnsettled({
        threadId,
        effectTypes: ["provider-runtime.continue"],
        reason: "lastdrop: the run continued on the next entry",
      })
      .pipe(
        Effect.flatMap((ids) => outbox.signalCancellations(ids)),
        Effect.catchCause((cause) =>
          Effect.logWarning("lastdrop.fallback.settle-failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

  const onSettled = Effect.fn("LastdropFallback.onSettled")(function* (event: RunUpdated) {
    const pending = yield* signals.take(event.threadId, event.payload.id);
    if (pending === undefined) return;
    // Only the held handover continues; any other end (a Stop) just lets go of the run.
    if (event.payload.status === "cancelled")
      yield* continueAfter(pending, event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("lastdrop.fallback.failed", {
            threadId: event.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    yield* settle(event.threadId);
  });

  yield* signals.bindHold(hold);
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      event.type === "run.updated" && TERMINAL.has(event.payload.status)
        ? onSettled(event)
        : Effect.void,
    ),
    Effect.ensuring(signals.bindHold(undefined)),
  );
});
