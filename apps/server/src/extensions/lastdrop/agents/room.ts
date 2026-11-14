/**
 * Which chain entries have room, as far as lastdrop knows inside T3: an entry that ended a run at a
 * usage limit is out until the limit's reset (or an hour when the provider gave none). Shared by
 * every session of the lastdrop driver, since a limit is the account's, not the thread's.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AgentStep } from "./catalog.ts";
import { makeStoredMap, type StoredMap } from "./store.ts";

/** How long an entry stays out when its limit came without a reset time. */
const DEFAULT_OUT_MS = 60 * 60 * 1000;

const stepKey = (step: AgentStep): string => `${step.instanceId}\u0000${step.model}`;

export interface Room {
  readonly hasRoom: (step: AgentStep) => Effect.Effect<boolean>;
  /** Marks the entry out until `resetAt` (ISO), else for `DEFAULT_OUT_MS`. */
  readonly markOut: (step: AgentStep, resetAt: string | null | undefined) => Effect.Effect<void>;
  /** When the entry's mark ends (epoch ms), if it is out. */
  readonly outUntil: (step: AgentStep) => number | undefined;
}

export const makeRoom = (
  now: () => number = Date.now,
  marks: StoredMap<number> = makeStoredMap<number>(),
): Room => {
  const until = (step: AgentStep) => {
    const end = marks.get(stepKey(step));
    if (end === undefined) return undefined;
    if (end > now()) return end;
    marks.delete(stepKey(step));
    return undefined;
  };
  return {
    hasRoom: (step) => Effect.sync(() => until(step) === undefined),
    outUntil: until,
    markOut: (step, resetAt) =>
      Effect.sync(() => {
        const parsed = resetAt == null ? Number.NaN : Date.parse(resetAt);
        marks.set(
          stepKey(step),
          Number.isFinite(parsed) && parsed > now() ? parsed : now() + DEFAULT_OUT_MS,
        );
      }),
  };
};

/** A thread whose run ended at a limit and continues on the next entry, once T3 settles the run. */
export interface PendingFallback {
  readonly threadId: ThreadId;
  readonly agent: string;
  /** The entry the run ended on. The next run's notice names the one it continues on. */
  readonly from: string;
}

/** Hand-off from the router (which sees the limit) to the reactor (which re-sends the run). */
export interface FallbackSignals {
  readonly offer: (pending: PendingFallback) => Effect.Effect<void>;
  readonly take: (threadId: ThreadId) => Effect.Effect<PendingFallback | undefined>;
}

export const makeFallbackSignals = (): FallbackSignals => {
  const pending = new Map<ThreadId, PendingFallback>();
  return {
    offer: (entry) => Effect.sync(() => void pending.set(entry.threadId, entry)),
    take: (threadId) =>
      Effect.sync(() => {
        const entry = pending.get(threadId);
        pending.delete(threadId);
        return entry;
      }),
  };
};
