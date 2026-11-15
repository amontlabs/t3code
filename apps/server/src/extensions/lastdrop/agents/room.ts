/**
 * Which chain entries have room, as far as lastdrop knows inside T3: an entry that ended a run at a
 * usage limit is out until the limit's reset (or an hour when the provider gave none). Shared by
 * every session of the lastdrop driver, since a limit is the account's, not the thread's.
 */
import type { RunId, ThreadId } from "@t3tools/contracts";
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
  /** Out-of-room known from elsewhere (Z.ai and OpenRouter usage), until when. */
  external: (step: AgentStep, now: number) => number | undefined = () => undefined,
): Room => {
  const marked = (step: AgentStep) => {
    const end = marks.get(stepKey(step));
    if (end === undefined) return undefined;
    if (end > now()) return end;
    marks.delete(stepKey(step));
    return undefined;
  };
  const until = (step: AgentStep) => {
    const ends = [marked(step), external(step, now())].filter((e): e is number => e !== undefined);
    return ends.length === 0 ? undefined : Math.max(...ends);
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
  /** The run that reached the limit; its continuation follows it (`restartContinuationOfRunId`). */
  readonly runId: RunId;
  readonly agent: string;
  /** The entry the run ended on. The next run's notice names the one it continues on. */
  readonly from: string;
}

/**
 * Hand-off from the router (which sees the limit) to the reactor (which re-sends the run). The
 * reactor binds `hold` while it runs: it keeps the run open for whatever waits on it (T3's
 * restart-continuation marker, `fallback.ts`) until the continuation exists.
 */
export interface FallbackSignals {
  /** False when nothing holds and continues runs (no reactor): the limit then stays T3's own. */
  readonly offer: (pending: PendingFallback) => Effect.Effect<boolean>;
  /** The pending fallback for this run, once; undefined for any other run. */
  readonly take: (threadId: ThreadId, runId: RunId) => Effect.Effect<PendingFallback | undefined>;
  readonly bindHold: (
    hold: ((pending: PendingFallback) => Effect.Effect<boolean>) | undefined,
  ) => Effect.Effect<void>;
}

export const makeFallbackSignals = (): FallbackSignals => {
  const pending = new Map<ThreadId, PendingFallback>();
  let hold: ((pending: PendingFallback) => Effect.Effect<boolean>) | undefined;
  return {
    offer: Effect.fn("LastdropFallback.offer")(function* (entry) {
      if (hold === undefined || !(yield* hold(entry))) return false;
      pending.set(entry.threadId, entry);
      return true;
    }),
    take: (threadId, runId) =>
      Effect.sync(() => {
        const entry = pending.get(threadId);
        if (entry?.runId !== runId) return undefined;
        pending.delete(threadId);
        return entry;
      }),
    bindHold: (next) =>
      Effect.sync(() => {
        hold = next;
      }),
  };
};
