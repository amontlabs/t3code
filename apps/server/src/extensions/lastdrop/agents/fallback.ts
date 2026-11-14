/**
 * Fallback partway through a run: once T3 settles a run the router signalled, release the session
 * and re-send the run. The new session opens on the next entry and refuses the old native thread,
 * so T3's own recovery starts a new one there with its portable handoff.
 */
import { CommandId, MessageId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../../orchestration-v2/ProviderSessionManager.ts";
import type { FallbackSignals } from "./room.ts";

/** What T3's own limit recovery sends (`UsageLimitRecoveryWorker`). */
export const CONTINUE_TEXT = "Continue where you left off.";

type RunUpdated = Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>;

const continueAfter = Effect.fn("LastdropFallback.continueAfter")(function* (
  signals: FallbackSignals,
  event: RunUpdated,
) {
  const pending = yield* signals.take(event.threadId);
  if (pending === undefined) return;
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
      detail: `lastdrop: ${pending.agent} continues on ${pending.to}.`,
    });
  }
  yield* Effect.logInfo("lastdrop.fallback.continue", {
    threadId: event.threadId,
    agent: pending.agent,
    from: pending.from,
    to: pending.to,
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`lastdrop-fallback:${event.payload.id}`),
    messageId: MessageId.make(`lastdrop-fallback:${event.payload.id}`),
    threadId: event.threadId,
    text: CONTINUE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  });
});

/** Runs for the server's life: continues each lastdrop run the router signalled. */
export const runFallbackReactor = Effect.fn("LastdropFallback.run")(function* (
  signals: FallbackSignals,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? continueAfter(signals, event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("lastdrop.fallback.failed", { threadId: event.threadId, cause }),
            ),
          )
        : Effect.void,
    ),
  );
});
