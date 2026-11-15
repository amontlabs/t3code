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
    notification: {
      source: { kind: "system" as const },
      outcome: "updated" as const,
      summary: `lastdrop moved this thread to Claude account ${pending.to} and resumed this turn`,
      detail: text,
    },
    attachments: [],
    modelSelection: event.payload.modelSelection,
    dispatchMode: { type: "start_immediately" as const },
    createdBy: "agent" as const,
    creationSource: "server" as const,
  };
}

/** Runs for the server's life: once T3 settles a run the wrapper ended at a limit, continues the thread. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "run.updated" || event.payload.status !== "failed") return Effect.void;
        const pending = pendingContinuations.take(event.threadId);
        if (pending === undefined) return Effect.void;
        return Effect.logInfo("lastdrop.move.continue", {
          threadId: event.threadId,
          to: pending.to,
          cut: pending.work.length,
        }).pipe(
          Effect.andThen(orchestrator.dispatch(continuationCommand(event, pending))),
          Effect.catchCause((cause) =>
            Effect.logWarning("lastdrop.move.continue-failed", { threadId: event.threadId, cause }),
          ),
        );
      }),
      Effect.forkScoped,
    );
  }),
);
