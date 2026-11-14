/**
 * The rules that keep every Claude account's sign-in renewed. Port of the pure parts of headroom's
 * `ClaudeKeeper` (ClaudeKeeper.swift). lastdrop never asks Anthropic for tokens: Claude Code renews a token
 * with under 5 minutes left whenever it starts, so the keeper starts it with no prompt 4 minutes before
 * expiry. The process and the keychain reads are `@t3tools/lastdrop-node`'s.
 */
import type { SignInFacts } from "./claudeUsage.ts";
import type { SignInState } from "./usage.ts";

const MINUTE = 60_000;

/** Renew this long before the token expires. */
export const RENEW_AHEAD_MS = 4 * MINUTE;
/** Read each blob at least this often: sessions renew sign-ins too. */
export const RECHECK_EVERY_MS = 5 * MINUTE;
/** Waits between renewals that failed after expiry: 1, 2, 5, then every 15 minutes. */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [1, 2, 5, 15].map((m) => m * MINUTE);
/** Say so this long before a sign-in ends. */
export const WARN_BEFORE_MS = 3 * 24 * 60 * MINUTE;
/** Failing renewals, online, this long past expiry: the user has to sign in. */
export const GIVE_UP_AFTER_MS = 30 * MINUTE;

export interface KeeperSignIn {
  readonly state: SignInState;
  readonly detail?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly endsAt?: number | undefined;
  readonly plan?: string | undefined;
  readonly hasRefreshToken: boolean;
  readonly checkedAt: number;
  /** Renewals in a row that didn't move the expiry. */
  readonly attempts: number;
  readonly nextAttempt?: number | undefined;
  readonly renewing: boolean;
  /** Renewals kept failing while online, long after expiry. */
  readonly gaveUp: boolean;
}

export const newSignIn = (over: Partial<KeeperSignIn> = {}): KeeperSignIn => ({
  state: "ok",
  hasRefreshToken: true,
  checkedAt: -Infinity,
  attempts: 0,
  renewing: false,
  gaveUp: false,
  ...over,
});

export const isUsableSignIn = (state: SignInState): boolean => state === "ok";

/** The sign-in ends soon: worth signing in again before it does. */
export const endsSoon = (entry: KeeperSignIn, now: number): boolean =>
  entry.state === "ok" && entry.endsAt !== undefined && entry.endsAt - now < WARN_BEFORE_MS;

/** The blob is due a read: the periodic one, the renewal deadline, or a retry. */
export function isDue(entry: KeeperSignIn, now: number): boolean {
  if (now - entry.checkedAt >= RECHECK_EVERY_MS) return true;
  if (entry.nextAttempt !== undefined) return now >= entry.nextAttempt;
  if (entry.expiresAt !== undefined) return now >= entry.expiresAt - RENEW_AHEAD_MS;
  return false;
}

/** Time to start Claude Code on it: within `RENEW_AHEAD_MS` of expiry, once any wait is over. */
export function renewDue(entry: KeeperSignIn, now: number): boolean {
  if (!entry.hasRefreshToken) return false;
  if (entry.expiresAt !== undefined && now < entry.expiresAt - RENEW_AHEAD_MS) return false;
  return entry.nextAttempt === undefined || now >= entry.nextAttempt;
}

/** After a renewal that didn't take: just past expiry if it hasn't come yet, then 1, 2, 5, 15 minutes. */
export function nextAttempt(attempts: number, expiresAt: number | undefined, now: number): number {
  if (expiresAt !== undefined && now < expiresAt) return expiresAt + 5_000;
  const i = Math.min(Math.max(attempts - 2, 0), RETRY_DELAYS_MS.length - 1);
  return now + RETRY_DELAYS_MS[i]!;
}

const shortDate = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short" }).format(ms);

/** What the blob alone says. Claude Code clears a refused sign-in to empty tokens. */
export function judge(
  facts: SignInFacts | undefined,
  now: number,
): { readonly state: SignInState; readonly detail?: string | undefined } {
  if (!facts) return { state: "signedOut", detail: "Not signed in to Claude Code." };
  if (!facts.hasRefreshToken) {
    // A token that can't be renewed still works until it expires.
    if (facts.expiresAt !== undefined && facts.expiresAt > now) return { state: "ok" };
    return {
      state: "needsSignIn",
      detail:
        facts.loginEnded === "time_limit" ? "Its sign-in ran out." : "Its sign-in stopped working.",
    };
  }
  if (facts.endsAt !== undefined && facts.endsAt <= now) {
    return { state: "needsSignIn", detail: `Its sign-in ran out on ${shortDate(facts.endsAt)}.` };
  }
  return { state: "ok" };
}

/**
 * The entry after reading the blob at `now` (Swift's `check` after its read). `renew` is true when the keeper
 * should start Claude Code now; the returned entry is then marked renewing.
 */
export function afterCheck(
  previous: KeeperSignIn | undefined,
  facts: SignInFacts | undefined,
  online: boolean,
  now: number,
): { readonly entry: KeeperSignIn; readonly renew: boolean } {
  const before = previous ?? newSignIn();
  let entry: KeeperSignIn = {
    ...before,
    checkedAt: now,
    expiresAt: facts?.expiresAt,
    endsAt: facts?.endsAt,
    plan: facts?.plan,
    hasRefreshToken: facts?.hasRefreshToken ?? false,
  };
  // Moved by someone else (a session on the account, or a sign-in): nothing left to retry.
  const moved = facts?.expiresAt;
  if (moved !== undefined && moved !== before.expiresAt && moved > now) {
    entry = { ...entry, attempts: 0, nextAttempt: undefined, gaveUp: false };
  }
  const judged = judge(facts, now);
  entry = { ...entry, state: judged.state, detail: judged.detail };
  if (judged.state === "ok" && entry.gaveUp) {
    entry = { ...entry, state: "needsSignIn", detail: "Claude Code couldn't renew its sign-in." };
  }
  if (isUsableSignIn(entry.state) && online && renewDue(entry, now)) {
    return { entry: { ...entry, renewing: true }, renew: true };
  }
  return { entry, renew: false };
}

/** The entry once a renewal finished (Swift's `finished`). */
export function afterRenewal(
  entry: KeeperSignIn,
  renewed: boolean,
  online: boolean,
  now: number,
): KeeperSignIn {
  const base = { ...entry, renewing: false, checkedAt: -Infinity };
  if (renewed) return { ...base, attempts: 0, nextAttempt: undefined, gaveUp: false };
  const attempts = entry.attempts + 1;
  const gaveUp =
    entry.gaveUp ||
    (attempts >= 3 && online && now - (entry.expiresAt ?? -Infinity) > GIVE_UP_AFTER_MS);
  return { ...base, attempts, nextAttempt: nextAttempt(attempts, entry.expiresAt, now), gaveUp };
}
