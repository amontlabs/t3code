/**
 * Which chain entries can take a run. A run that ends at a usage limit leaves "seen at T, until U" on its
 * entry, and a usage reading taken after T that shows room cancels it (a reset redeemed since, another
 * sign-in). An entry on a pool of accounts (Claude, Codex) is also out while its pool's own router says every
 * account is at a limit. Shared by every session of the lastdrop driver.
 */
import type { RunId, ServerProviderUsageLimits, ThreadId } from "@t3tools/contracts";
import type { FullAccount } from "@t3tools/lastdrop-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { AgentStep } from "./catalog.ts";
import type { Pool } from "./pools.ts";
import { makeStoredMap, type StoredMap } from "./store.ts";

/** How long an entry stays out when its limit came without a reset time. */
const DEFAULT_OUT_MS = 60 * 60 * 1000;
/**
 * How long an entry on a pool stays out after a run ended at a limit there, unless a newer reading shows an
 * account with room first: the reset the provider gave is one account's, not the pool's. The pool's router
 * holds an account's own "limit reached" answer as long.
 */
export const POOL_OUT_MS = 10 * 60_000;
/** A chain with no entry left has an instance's usage read again at most this often. */
const REFRESH_EVERY_MS = 2 * 60_000;
/** How long that call waits for the readings; a slower read finishes for the next call. */
const REFRESH_WAIT = "10 seconds";

const stepKey = (step: AgentStep): string => `${step.instanceId}\u0000${step.model}`;

/** "2026-11-18 15:37 UTC". */
const clock = (epochMs: number): string =>
  `${DateTime.formatIso(DateTime.makeUnsafe(epochMs)).slice(0, 16).replace("T", " ")} UTC`;

/** A usage limit a run ended at. An older file kept only the end time, as a bare number. */
export interface RoomMark {
  readonly seenAt: number;
  readonly until: number;
  /** The sign-in the instance was read for then: another sign-in's limit is not this one's. */
  readonly account?: string | undefined;
}

/** What an entry's instance last read of its own limits. */
export interface RoomReading {
  readonly at: number;
  /** A window that meters the entry's model is used up. */
  readonly full: boolean;
  readonly account?: string | undefined;
}

/**
 * The instance's usage reading for a run on `model`; undefined when it published none. The windows named after
 * the model's family count ("Claude · Weekly", Antigravity's "Claude & GPT (shared)"), or all of them when none is.
 */
export const readingFromLimits = (
  limits: ServerProviderUsageLimits | undefined,
  model: string,
  now: number,
): RoomReading | undefined => {
  if (limits === undefined || limits.unavailable !== undefined || limits.windows.length === 0) {
    return undefined;
  }
  const at = Date.parse(limits.checkedAt);
  if (!Number.isFinite(at)) return undefined;
  const family = model.toLowerCase().split("-")[0] ?? "";
  const named =
    family === ""
      ? []
      : limits.windows.filter((w) => `${w.id} ${w.label}`.toLowerCase().includes(family));
  const full = (named.length > 0 ? named : limits.windows).some(
    (w) => w.usedPercent >= 100 && !(w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now),
  );
  return { at, full, account: limits.credentialFingerprint };
};

/** Where the room's knowledge comes from; a source left out knows nothing. */
export interface RoomSources {
  /** The entry's account pool, when its provider has one. */
  readonly pool?: (step: AgentStep) => Pool | undefined;
  /** The entry's instance's own usage reading. */
  readonly reading?: (step: AgentStep, now: number) => Effect.Effect<RoomReading | undefined>;
  /** Out-of-room known from elsewhere (Z.ai and OpenRouter usage), until when. */
  readonly external?: (step: AgentStep, now: number) => number | undefined;
  /** Asks the entry's instance to read its usage again. */
  readonly refresh?: (step: AgentStep) => Effect.Effect<void>;
}

export interface Room {
  /** Why the entry can't take a run now, to follow its name ("reached a usage limit (until …)"); undefined when it can. */
  readonly out: (step: AgentStep) => Effect.Effect<string | undefined>;
  /** A run on the entry ended at a usage limit that lasts until `resetAt` (ISO), else for `DEFAULT_OUT_MS`. */
  readonly markOut: (step: AgentStep, resetAt: string | null | undefined) => Effect.Effect<void>;
  /**
   * Has the entries' providers read their usage again and waits briefly for it: for a chain with no entry
   * left, when a reset used outside the app may not have reached a reading yet.
   */
  readonly refresh: (steps: ReadonlyArray<AgentStep>) => Effect.Effect<void>;
}

const accountText = (account: FullAccount): string => {
  const what =
    account.window === "weekly"
      ? "week used up"
      : account.window === "session"
        ? "5-hour window used up"
        : account.window === "model"
          ? "the model's week used up"
          : "at its limit";
  return `${account.name}: ${what}${account.until === undefined ? "" : ` until ${clock(account.until)}`}`;
};

export const makeRoom = (
  now: () => number = Date.now,
  marks: StoredMap<RoomMark | number> = makeStoredMap<RoomMark | number>(),
  sources: RoomSources = {},
): Room => {
  const refreshedAt = new Map<string, number>();
  const pooled = (step: AgentStep) =>
    sources.pool?.(step)?.room(step.model) ?? Effect.succeed(null);

  /** The entry's mark, unless it ended or a reading taken since shows room. */
  const standing = Effect.fn("LastdropRoom.standing")(function* (
    step: AgentStep,
    at: number,
    roomReadAt: number | undefined | null,
  ) {
    const key = stepKey(step);
    const stored = marks.get(key);
    if (stored === undefined) return undefined;
    if (typeof stored === "number") {
      // A bare end time on a pool's entry was one account's reset held against the whole pool.
      if (stored <= at || roomReadAt !== null) {
        marks.delete(key);
        return undefined;
      }
      // Nothing says when it was seen: only a reading from now on can speak against it.
      marks.set(key, { seenAt: at, until: stored });
      return { seenAt: at, until: stored } satisfies RoomMark;
    }
    const cancelled =
      stored.until <= at ||
      (roomReadAt !== null
        ? roomReadAt !== undefined && roomReadAt > stored.seenAt
        : yield* (sources.reading?.(step, at) ?? Effect.undefined).pipe(
            Effect.map(
              (reading) =>
                reading !== undefined &&
                ((stored.account !== undefined &&
                  reading.account !== undefined &&
                  reading.account !== stored.account) ||
                  (reading.at > stored.seenAt && !reading.full)),
            ),
          ));
    if (!cancelled) return stored;
    marks.delete(key);
    return undefined;
  });

  return {
    out: Effect.fn("LastdropRoom.out")(function* (step) {
      const pool = yield* pooled(step);
      if (pool !== null && pool.full !== undefined) {
        return `has no account with room (${pool.full.map(accountText).join("; ")})`;
      }
      const at = now();
      const mark = yield* standing(step, at, pool === null ? null : pool.roomReadAt);
      const ends = [mark?.until, sources.external?.(step, at)].filter(
        (end): end is number => end !== undefined,
      );
      return ends.length === 0
        ? undefined
        : `reached a usage limit (until ${clock(Math.max(...ends))})`;
    }),
    markOut: Effect.fn("LastdropRoom.markOut")(function* (step, resetAt) {
      const at = now();
      if ((yield* pooled(step)) !== null) {
        marks.set(stepKey(step), { seenAt: at, until: at + POOL_OUT_MS });
        return;
      }
      const parsed = resetAt == null ? Number.NaN : Date.parse(resetAt);
      const reading = yield* sources.reading?.(step, at) ?? Effect.undefined;
      marks.set(stepKey(step), {
        seenAt: at,
        until: Number.isFinite(parsed) && parsed > at ? parsed : at + DEFAULT_OUT_MS,
        ...(reading?.account === undefined ? {} : { account: reading.account }),
      });
    }),
    refresh: Effect.fn("LastdropRoom.refresh")(function* (steps) {
      const at = now();
      const due = [...new Map(steps.map((step) => [step.instanceId, step])).values()].filter(
        (step) => at - (refreshedAt.get(step.instanceId) ?? -Infinity) >= REFRESH_EVERY_MS,
      );
      if (due.length === 0) return;
      for (const step of due) refreshedAt.set(step.instanceId, at);
      // Detached: a read slower than the wait (Antigravity's can take 30 s) still lands for the next call.
      const reads = yield* Effect.forEach(
        due,
        (step) =>
          pooled(step).pipe(
            Effect.flatMap((pool) =>
              pool === null
                ? (sources.refresh?.(step) ?? Effect.void)
                : (sources.pool?.(step)?.refresh ?? Effect.void),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.forkDetach);
      yield* Fiber.await(reads).pipe(Effect.timeoutOption(REFRESH_WAIT));
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
