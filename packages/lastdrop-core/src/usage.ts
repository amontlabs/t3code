/**
 * Claude usage per account and the routing rules on it. Port of `UsageWindow`, the pure parts of
 * `SubagentUsage` and `AgentPool.room`: plain values, the caller owns storage. Times are epoch ms (Swift's
 * are seconds; `decodeStatusFile` converts lastdrop's usage.json).
 */

/** One limit window, e.g. "Session" (5h), "Weekly", or a model's week ("Fable Weekly"). */
export interface UsageWindow {
  readonly label: string;
  /** 0...100, share of the window already used. Undefined when the provider returned no number. */
  readonly usedPercent?: number | undefined;
  /** Epoch ms. */
  readonly resetsAt?: number | undefined;
}

/** Where a Claude account's sign-in stands, as the keeper last judged it. */
export type SignInState = "ok" | "needsSignIn" | "signedOut";

/** An account's last reading, as lastdrop keeps it (one entry of `usage.json`). */
export interface AccountStatus {
  readonly session?: number | undefined;
  readonly weekly?: number | undefined;
  /** When it was read, epoch ms. */
  readonly at: number;
  /** Weekly limits scoped to a model, by its name ("Fable": 100). */
  readonly models?: Readonly<Record<string, number>> | undefined;
  /** The plan's name ("Max 20x"), for `planSize`. */
  readonly plan?: string | undefined;
  /** Anthropic answered 429 for this account: nobody asks again before this (epoch ms). */
  readonly blockedUntil?: number | undefined;
  /** Rate-limit answers in a row; the wait grows with it. Cleared by the next successful read. */
  readonly failures?: number | undefined;
  /** When each window resets, by its row's name ("Session", "Weekly", "Fable"), epoch ms. */
  readonly resetsAt?: Readonly<Record<string, number>> | undefined;
  /** The sign-in, as last judged; undefined counts as fine. */
  readonly signIn?: SignInState | undefined;
  readonly signInDetail?: string | undefined;
  /** When the sign-in itself ends (Claude Code's `refreshTokenExpiresAt`), epoch ms. */
  readonly signInEndsAt?: number | undefined;
}

/** One reading of an account's limits for routing. */
export interface Reading {
  readonly session: number | undefined;
  readonly weekly: number | undefined;
  readonly models: Readonly<Record<string, number>>;
  /** False when only signing in again would let it run anything. */
  readonly usable: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A reading routes for this long. With the app running it is never this old: resets are projected. */
export const READING_VALID_MS = 2 * HOUR;
/** The agents pool trusts a reading this long, or `READING_VALID_MS` while the account is rate limited. */
export const POOL_READING_VALID_MS = 30 * MINUTE;
/** Longest wait after a rate limit. */
export const MAX_BACKOFF_MS = 30 * MINUTE;
/** A server's Retry-After is held within these bounds. */
const RETRY_AFTER_MIN_MS = MINUTE;
const RETRY_AFTER_MAX_MS = HOUR;

/** Nothing is known about its limits. */
export const isUnknown = (r: Reading): boolean => r.session === undefined || r.weekly === undefined;

/** The weekly limit scoped to `model` ("claude-fable-5-2", "fable"), if the account has one. */
export function usedForModel(reading: Reading, model: string | undefined): number | undefined {
  const m = model?.toLowerCase();
  if (!m) return undefined;
  for (const [name, used] of Object.entries(reading.models)) {
    const word = name.toLowerCase().split(" ")[0] ?? "";
    if (word && m.includes(word)) return used;
  }
  return undefined;
}

/** "Fable Weekly" → "Fable". */
export const modelName = (label: string): string => label.slice(0, -" Weekly".length);

const isModelRow = (label: string) => label !== "Weekly" && label.endsWith(" Weekly");

/**
 * Routing values from a reading's rows. A plan without a 5-hour window (Ultra) has nothing to run out of
 * there: once the week is read, its session counts as unused, not unknown.
 */
export function readingFromWindows(windows: ReadonlyArray<UsageWindow>): Reading {
  const used = (label: string) => windows.find((w) => w.label === label)?.usedPercent;
  const weekly = used("Weekly");
  const models: Record<string, number> = {};
  for (const w of windows) {
    if (isModelRow(w.label) && w.usedPercent !== undefined)
      models[modelName(w.label)] = w.usedPercent;
  }
  return {
    session: used("Session") ?? (weekly === undefined ? undefined : 0),
    weekly,
    models,
    usable: true,
  };
}

/** When each window of a reading resets, by the names `AccountStatus.resetsAt` uses. */
export function resetsFromWindows(windows: ReadonlyArray<UsageWindow>): Record<string, number> {
  const resets: Record<string, number> = {};
  for (const w of windows) {
    if (w.resetsAt === undefined) continue;
    const name =
      w.label === "Session" || w.label === "Weekly"
        ? w.label
        : isModelRow(w.label)
          ? modelName(w.label)
          : undefined;
    if (name !== undefined) resets[name] = w.resetsAt;
  }
  return resets;
}

/**
 * The account's reading for routing at `now`: unknown when older than `READING_VALID_MS`. A window past its
 * reset counts as unused. `fullSince` is when the account last answered "limit reached" (Swift's
 * `AgentRegistry.fullSince`): it counts as full until a reading newer than that says otherwise.
 */
export function readingFromStatus(
  status: AccountStatus | undefined,
  now: number,
  fullSince?: number,
): Reading {
  const usable = status?.signIn === undefined || status.signIn === "ok";
  let session: number | undefined;
  let weekly: number | undefined;
  const models: Record<string, number> = {};
  if (status && now - status.at < READING_VALID_MS) {
    const projected = (name: string, used: number | undefined) => {
      if (used === undefined) return undefined;
      const reset = status.resetsAt?.[name];
      return reset !== undefined && reset <= now ? 0 : used;
    };
    weekly = projected("Weekly", status.weekly);
    // Older entries have no models; a session left out next to a read week is a plan without one.
    session = projected("Session", status.session ?? (status.weekly === undefined ? undefined : 0));
    for (const [name, used] of Object.entries(status.models ?? {})) {
      const value = projected(name, used);
      if (value !== undefined) models[name] = value;
    }
  }
  if (fullSince !== undefined && (status?.at ?? -Infinity) < fullSince) {
    session = 100;
    weekly = 100;
  }
  return { session, weekly, models, usable };
}

// MARK: Shared backoff

/** Wait after the n-th rate limit in a row: 5, 10, 20, then 30 minutes. */
export function backoffMs(failures: number): number {
  return Math.min(5 * MINUTE * 2 ** (Math.max(failures, 1) - 1), MAX_BACKOFF_MS);
}

/** When the account may be asked again; undefined when it may be now. */
export function blockedUntil(status: AccountStatus | undefined, now: number): number | undefined {
  const until = status?.blockedUntil;
  return until !== undefined && until > now ? until : undefined;
}

/**
 * Records a 429 for the account: the server's Retry-After (seconds, held to 1 minute...1 hour), else the
 * growing backoff. An account already blocked keeps its block, so a burst of requests counts as one failure.
 */
export function recordBlock(
  status: AccountStatus | undefined,
  retryAfterSeconds: number | undefined,
  now: number,
): { readonly status: AccountStatus; readonly until: number } {
  const entry: AccountStatus = status ?? { at: -Infinity };
  if (entry.blockedUntil !== undefined && entry.blockedUntil > now) {
    return { status: entry, until: entry.blockedUntil };
  }
  const failures = (entry.failures ?? 0) + 1;
  const wait =
    retryAfterSeconds === undefined
      ? backoffMs(failures)
      : Math.min(Math.max(retryAfterSeconds * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
  const until = now + wait;
  return { status: { ...entry, failures, blockedUntil: until }, until };
}

/** A successful read ends the backoff. */
export function clearBlock(status: AccountStatus): AccountStatus {
  const { blockedUntil: _blocked, failures: _failures, ...rest } = status;
  return rest;
}

/**
 * The agents pool's room on an account (percent points under the thresholds), or undefined when it has none
 * or its reading is too old. An account that can't be read right now (rate limited) keeps its last reading
 * longer.
 */
export function poolRoom(
  status: AccountStatus | undefined,
  thresholds: { readonly sessionThreshold: number; readonly weeklyThreshold: number },
  now: number,
): number | undefined {
  if (!status) return undefined;
  const blocked = status.blockedUntil !== undefined && status.blockedUntil > now;
  if (now - status.at >= (blocked ? READING_VALID_MS : POOL_READING_VALID_MS)) return undefined;
  const rooms = [
    status.session === undefined ? undefined : thresholds.sessionThreshold * 100 - status.session,
    status.weekly === undefined ? undefined : thresholds.weeklyThreshold * 100 - status.weekly,
  ].filter((r): r is number => r !== undefined);
  if (rooms.length === 0) return undefined;
  const room = Math.min(...rooms);
  return room > 0 ? room : undefined;
}

// MARK: lastdrop's usage.json

const SIGN_IN_STATES: ReadonlyArray<SignInState> = ["ok", "needsSignIn", "signedOut"];

/**
 * Decodes lastdrop's `usage.json` (dates in seconds since 1970) into statuses with epoch-ms times. Entries
 * without a numeric `at` are dropped; unknown fields are ignored; `null` reads as absent.
 */
export function decodeStatusFile(json: string): Record<string, AccountStatus> {
  const root: unknown = JSON.parse(json);
  const out: Record<string, AccountStatus> = {};
  if (!isRecord(root)) return out;
  for (const [id, raw] of Object.entries(root)) {
    if (!isRecord(raw) || typeof raw["at"] !== "number") continue;
    const num = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : undefined);
    const date = (value: unknown) => (typeof value === "number" ? value * 1000 : undefined);
    const str = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
    const numbers = (value: unknown, map: (v: number) => number) => {
      if (!isRecord(value)) return undefined;
      const result: Record<string, number> = {};
      for (const [k, v] of Object.entries(value)) if (typeof v === "number") result[k] = map(v);
      return result;
    };
    const signIn = str("signIn");
    out[id] = dropUndefined({
      session: num("session"),
      weekly: num("weekly"),
      at: raw["at"] * 1000,
      models: numbers(raw["models"], (v) => v),
      plan: str("plan"),
      blockedUntil: date(raw["blockedUntil"]),
      failures: num("failures"),
      resetsAt: numbers(raw["resetsAt"], (v) => v * 1000),
      signIn: SIGN_IN_STATES.find((s) => s === signIn),
      signInDetail: str("signInDetail"),
      signInEndsAt: date(raw["signInEndsAt"]),
    });
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
