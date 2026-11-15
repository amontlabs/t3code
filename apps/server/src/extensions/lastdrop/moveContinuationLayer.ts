/**
 * The move continuation's reactor, inside `Extensions.layer`: once T3 settles a run the wrapper ended at a
 * usage limit (`run.updated`, failed), it dispatches what T3 dispatches after a restart (`moveContinuation.ts`),
 * and the thread's next query opens on the account it moved to. See docs/lastdrop/subagent-resume.md.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import {
  continuationText,
  type PendingContinuation,
  pendingContinuations,
} from "./moveContinuation.ts";

type RunUpdated = Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>;

/** The message T3 would dispatch after a restart, for the run the limit ended. */
export function continuationCommand(event: RunUpdated, pending: PendingContinuation) {
  const text = continuationText(pending.work);
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(`lastdrop-move-continuation:${event.payload.id}`),
    messageId: MessageId.make(`lastdrop-move-continuation:${event.payload.id}`),
    threadId: ThreadId.make(pending.threadId),
    text,
    attachments: [],
    modelSelection: event.payload.modelSelection,
    // Started at once, as T3's own limit continuation is: a queued message waits while the thread is held at
    // its limit. T3 accepts a notification only on queued messages or its restart continuation, so none here.
    dispatchMode: { type: "start_immediately" as const },
    createdBy: "agent" as const,
    creationSource: "server" as const,
  };
}

/**
 * Releases the provider session whose query the limit ended (as the agents' fallback does): sent at once, the
 * continuation would otherwise reach that closing query and fail. The next one opens, and moves, fresh.
 */
const continueAfter = Effect.fn("LastdropMoveContinuation.continueAfter")(function* (
  event: RunUpdated,
  pending: PendingContinuation,
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
      detail: `lastdrop: Claude account ${pending.from} reached its usage limit; the thread continues on ${pending.to}.`,
    });
  }
  yield* Effect.logInfo("lastdrop.move.continue", {
    threadId: event.threadId,
    to: pending.to,
    cut: pending.work.length,
  });
  yield* orchestrator.dispatch(continuationCommand(event, pending));
});

/** Runs for the server's life: once T3 settles a run the wrapper ended at a limit, continues the thread. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "run.updated" || event.payload.status !== "failed") return Effect.void;
        const pending = pendingContinuations.take(event.threadId);
        if (pending === undefined) return Effect.void;
        return continueAfter(event, pending).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("lastdrop.move.continue-failed", { threadId: event.threadId, cause }),
          ),
        );
      }),
      Effect.forkScoped,
    );
  }),
);
