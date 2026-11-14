/**
 * Errors that end a Claude Code turn but say nothing about the account (Cloudflare page, 5xx, 529, network,
 * or an auth failure while the sign-in works; the 2026-11-13 incident): retried, then handed on like a limit.
 * Port of headroom's `TransientError` and `RetryPolicy` (TransientErrors.swift).
 */

/** Provider business codes survive Claude Code's flattened "API Error" strings. */
export function hasCode(code: number, text: string): boolean {
  return new RegExp(`(?<![0-9])${code}(?![0-9])`, "u").test(text);
}

// Only signing in again fixes these, whatever else the text says.
const SIGNED_OUT = [
  "not logged in",
  "please run /login",
  "token has been revoked",
  "invalid_grant",
  "oauth token has expired",
];
// An HTML page instead of JSON: Cloudflare's block or challenge in front of the API.
const PAGE = ["cloudflare", "attention required", "<html", "<!doctype html", "just a moment"];
const SERVER = [
  "internal server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "credential validation failed",
];
const NETWORK = [
  "econnreset",
  "etimedout",
  "econnrefused",
  "enotfound",
  "eai_again",
  "epipe",
  "socket hang up",
  "network error",
  "fetch failed",
  "connection error",
  "request timed out",
  "unable to connect",
  "und_err",
  "network is unreachable",
];

/**
 * Why `text` (Claude Code's result, or what it wrote to stderr) is a passing error; undefined when it isn't
 * one. `status` is Claude Code's `api_error_status` when it reported one. `signInWorks` is asked only for an
 * authentication failure without a Cloudflare page: then the account's own sign-in decides.
 */
export function transientReason(
  text: string,
  status: number | undefined,
  signInWorks: () => boolean,
): string | undefined {
  const t = text.toLowerCase();
  const has = (list: ReadonlyArray<string>) => list.some((needle) => t.includes(needle));
  if (has(SIGNED_OUT)) return undefined;
  if (has(PAGE)) return "Cloudflare page instead of an API answer";
  if (status === 529 || t.includes("overloaded") || hasCode(529, text))
    return "API overloaded (529)";
  if (status !== undefined && status >= 500 && status <= 599) return `API server error (${status})`;
  if (/api error:?\s*5\d\d/u.test(t) || has(SERVER)) return "API server error";
  if (has(NETWORK)) return "network error";
  const auth =
    status === 401 ||
    status === 403 ||
    t.includes("failed to authenticate") ||
    t.includes("authentication_failed");
  if (auth && signInWorks()) return "authentication failed while the sign-in is valid";
  return undefined;
}

/**
 * How long to wait before each retry after a transient error: 10 s, 30 s, 90 s, 3 min, each moved by up to
 * a fifth either way so parallel runs don't come back in step. Then the work is handed on.
 */
export interface RetryPolicy {
  readonly delaysSeconds: ReadonlyArray<number>;
  readonly jitter: number;
}

export const standardRetryPolicy: RetryPolicy = { delaysSeconds: [10, 30, 90, 180], jitter: 0.2 };

/**
 * The wait (ms) before retry number `failures + 1`; undefined when the retries are spent. `random` is in
 * -1...1 (clamped): the caller draws it (Effect's `Random` on the server), so this stays pure.
 */
export function retryDelayMs(
  policy: RetryPolicy,
  failures: number,
  random: number,
): number | undefined {
  if (failures < 0 || failures >= policy.delaysSeconds.length) return undefined;
  const base = policy.delaysSeconds[failures]!;
  const seconds = Math.max(0, base * (1 + policy.jitter * Math.min(Math.max(random, -1), 1)));
  return Math.round(seconds * 1000);
}
