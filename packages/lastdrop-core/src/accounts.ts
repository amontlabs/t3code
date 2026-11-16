/**
 * Which Claude account a subagent or a T3 thread runs on, from one pool, by room. Subagents take the smallest
 * plan under the ceiling (thresholds are the only limit); threads take the most room in Pro-sized windows.
 * Port of headroom's `SubagentAccounts`; rules in docs/claude-accounts.md ("Best account for a thread").
 */
import { PRO_SIZE, type PlanSize, planSize } from "./planSize.ts";
import { type Reading, usedForModel } from "./usage.ts";

export interface Candidate {
  /** The account's id ("main", "claude-2"). */
  readonly id: string;
  readonly name: string;
  /** Percent of the 5-hour window used, 0...100; undefined when unknown. */
  readonly sessionUsed: number | undefined;
  /** Percent of the week used; undefined when unknown. */
  readonly weeklyUsed: number | undefined;
  /** The weekly limit scoped to the run's model ("Fable Weekly"), when the account has one. */
  readonly modelUsed?: number | undefined;
  /** The calling session runs on it: among unknown accounts, it is tried last. */
  readonly isOwn?: boolean | undefined;
  /** Pro when left out. */
  readonly size?: PlanSize | undefined;
}

/** Fractions, 0...1: an account takes a subagent only while below both. */
export interface Ceiling {
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
}

const sizeOf = (c: Candidate): PlanSize => c.size ?? PRO_SIZE;

/**
 * The subagent's account: the smallest plan under the ceiling, and among equal plans the one with the most
 * room under it. When no account is known to be under it, one whose usage is unknown (another than the
 * session's own first) is tried: it refuses quickly if it's full, while one known to be full surely fails.
 */
export function pick<C extends Candidate>(
  candidates: ReadonlyArray<C>,
  ceiling: Ceiling,
): C | undefined {
  const room = (c: Candidate): number | undefined => {
    if (c.sessionUsed === undefined || c.weeklyUsed === undefined) return undefined;
    let r = Math.min(
      ceiling.sessionThreshold * 100 - c.sessionUsed,
      ceiling.weeklyThreshold * 100 - c.weeklyUsed,
    );
    if (c.modelUsed !== undefined) r = Math.min(r, ceiling.weeklyThreshold * 100 - c.modelUsed);
    return r > 0 ? r : undefined;
  };
  let best: { candidate: C; room: number } | undefined;
  for (const c of candidates) {
    const r = room(c);
    if (r === undefined) continue;
    if (!best) {
      best = { candidate: c, room: r };
      continue;
    }
    // Ties keep the earlier one in the order.
    const size = sizeOf(c).session;
    const bestSize = sizeOf(best.candidate).session;
    if (size < bestSize || (size === bestSize && r > best.room)) best = { candidate: c, room: r };
  }
  return best?.candidate ?? unknown(candidates);
}

/** The last resort: an account nothing is known about, another than the session's own first. */
export function unknown<C extends Candidate>(candidates: ReadonlyArray<C>): C | undefined {
  const list = candidates.filter((c) => c.sessionUsed === undefined || c.weeklyUsed === undefined);
  return list.find((c) => !c.isOwn) ?? list[0];
}

/** A thread starts on an account only while it has used less than this much of its 5-hour window (percent)... */
export const THREAD_SESSION_FLOOR = 80;
/** ...and of its week. */
export const THREAD_WEEKLY_FLOOR = 95;

/**
 * Room in Pro-sized windows: what's left of the 5-hour window and of the week, times the plan's size,
 * whichever is tighter. Undefined when unknown.
 */
export function threadRoom(c: Candidate): number | undefined {
  if (c.sessionUsed === undefined || c.weeklyUsed === undefined) return undefined;
  const size = sizeOf(c);
  let room = Math.min(size.session * (100 - c.sessionUsed), size.weekly * (100 - c.weeklyUsed));
  if (c.modelUsed !== undefined) room = Math.min(room, size.weekly * (100 - c.modelUsed));
  return room / 100;
}

/**
 * The account a T3 Code thread starts on, or moves to when moving costs nothing: the most room among the
 * accounts below both floors; if none is, the most room among those not at a limit; if none is, one whose
 * usage is unknown. Undefined when every account is at a limit.
 */
export function pickForThread<C extends Candidate>(candidates: ReadonlyArray<C>): C | undefined {
  const best = (list: ReadonlyArray<C>): C | undefined => {
    let found: { candidate: C; room: number } | undefined;
    for (const c of list) {
      const r = threadRoom(c);
      if (r === undefined || r <= 0) continue;
      if (!found || r > found.room) found = { candidate: c, room: r };
    }
    return found?.candidate;
  };
  const roomy = candidates.filter(
    (c) =>
      c.sessionUsed !== undefined &&
      c.weeklyUsed !== undefined &&
      c.sessionUsed < THREAD_SESSION_FLOOR &&
      c.weeklyUsed < THREAD_WEEKLY_FLOOR &&
      (c.modelUsed ?? 0) < THREAD_WEEKLY_FLOOR,
  );
  return best(roomy) ?? best(candidates.filter(hasRoom)) ?? unknown(candidates);
}

/**
 * Where new work goes now, as badges per account id: "Threads" (a new T3 thread), "Subagents" (a delegated
 * Claude run), and each model with its own weekly limit ("Fable": a subagent on that model). Port of headroom's
 * `AppModel.routingBadges`. Accounts that can't run (`usable` false) take nothing.
 */
export function routingBadges(
  accounts: ReadonlyArray<{
    readonly id: string;
    readonly reading: Reading;
    readonly plan?: string | undefined;
  }>,
  ceiling: Ceiling,
): Readonly<Record<string, ReadonlyArray<string>>> {
  const usable = accounts.filter((a) => a.reading.usable);
  const candidates = (model: string | undefined): Candidate[] =>
    usable.map((a) => ({
      id: a.id,
      name: a.id,
      sessionUsed: a.reading.session,
      weeklyUsed: a.reading.weekly,
      modelUsed: usedForModel(a.reading, model),
      size: planSize(a.plan),
    }));
  const badges: Record<string, string[]> = {};
  const mark = (id: string | undefined, badge: string) => {
    if (id !== undefined) (badges[id] ??= []).push(badge);
  };
  mark(pickForThread(candidates(undefined))?.id, "Threads");
  mark(pick(candidates(undefined), ceiling)?.id, "Subagents");
  const models = new Set(usable.flatMap((a) => Object.keys(a.reading.models)));
  for (const model of [...models].toSorted()) {
    mark(pick(candidates(model.toLowerCase()), ceiling)?.id, model);
  }
  return badges;
}

/** True while the account can still answer: below 100% of both windows (and the model's week). */
export function hasRoom(c: Candidate): boolean {
  if (c.sessionUsed === undefined || c.weeklyUsed === undefined) return false;
  return c.sessionUsed < 100 && c.weeklyUsed < 100 && (c.modelUsed ?? 0) < 100;
}

/**
 * The account the calling session runs as: the Claude app passes it to its Code-tab sessions; a terminal
 * session is the one its config folder is signed in to. `signedInUuid` reads a config folder's
 * `.claude.json` (`oauthAccount.accountUuid`; undefined folder = the default one) and is the caller's I/O.
 */
export function ownAccountUuid(
  environment: Readonly<Record<string, string | undefined>>,
  signedInUuid: (configDir: string | undefined) => string | undefined,
): string | undefined {
  const expand = (path: string): string => {
    const home = environment["HOME"];
    return home && (path === "~" || path.startsWith("~/")) ? home + path.slice(1) : path;
  };
  // The folder a run is signed in at wins: a T3 thread on another account carries the Claude app's UUID too.
  const secure = environment["CLAUDE_SECURESTORAGE_CONFIG_DIR"];
  if (secure) {
    const uuid = signedInUuid(expand(secure));
    if (uuid) return uuid;
  }
  const app = environment["CLAUDE_CODE_ACCOUNT_UUID"];
  if (app) return app;
  const dir = environment["CLAUDE_CONFIG_DIR"];
  return signedInUuid(dir === undefined ? undefined : expand(dir));
}
