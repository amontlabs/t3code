import type { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";

import { formatContextWindowTokens } from "~/lib/contextWindow";

/** The line warns once the prompt cache has this long left. */
const CACHE_WARNING_MS = 15 * 60_000;

export type CacheStatus =
  | { readonly state: "warm"; readonly expiresAtMs: number; readonly minutesLeft: number }
  | { readonly state: "expiring"; readonly expiresAtMs: number; readonly minutesLeft: number }
  | { readonly state: "expired"; readonly expiresAtMs: number };

export interface ConversationStatus {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly usedPercent: number | null;
  /** Null when the provider reports no cache lifetime (only Claude does) or the turn wrote none. */
  readonly cache: CacheStatus | null;
}

export function conversationStatus(
  usage: OrchestrationV2ProviderTurnTokenUsage,
  nowMs: number,
): ConversationStatus {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const usedPercent =
    maxTokens === null ? null : Math.min(100, Math.round((usage.usedTokens / maxTokens) * 100));
  const expiresAtMs =
    usage.promptCacheExpiresAt === undefined ? Number.NaN : Date.parse(usage.promptCacheExpiresAt);
  const leftMs = expiresAtMs - nowMs;
  const cache: CacheStatus | null = !Number.isFinite(expiresAtMs)
    ? null
    : leftMs <= 0
      ? { state: "expired", expiresAtMs }
      : leftMs <= CACHE_WARNING_MS
        ? { state: "expiring", expiresAtMs, minutesLeft: Math.floor(leftMs / 60_000) }
        : { state: "warm", expiresAtMs, minutesLeft: Math.floor(leftMs / 60_000) };
  return { usedTokens: usage.usedTokens, maxTokens, usedPercent, cache };
}

/** Tokens as 58k or 1.2M. */
export function formatTokens(value: number): string {
  return formatContextWindowTokens(value).replace(/m$/, "M");
}

/** "Cache expires in 12 minutes, at 2:32 PM" or "Cache expired at 11:24 AM"; `at` is the formatted expiry. */
export function cacheText(cache: CacheStatus, at: string): string {
  if (cache.state === "expired") return `Cache expired at ${at}`;
  const left =
    cache.minutesLeft === 0
      ? "under a minute"
      : `${cache.minutesLeft} minute${cache.minutesLeft === 1 ? "" : "s"}`;
  return `Cache expires in ${left}, at ${at}`;
}
