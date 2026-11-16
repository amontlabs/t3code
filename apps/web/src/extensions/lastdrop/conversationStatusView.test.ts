import { describe, expect, it } from "vite-plus/test";

import { cacheText, conversationStatus, formatTokens } from "./conversationStatusView";

const expiresAt = "2026-11-16T14:30:00.000Z";
const end = Date.parse(expiresAt);
const usage = {
  usedTokens: 50_000,
  maxTokens: 200_000,
  promptCacheExpiresAt: expiresAt,
  updatedAt: "2026-11-16T13:30:00.000Z",
};

describe("conversationStatus", () => {
  it("warns within 15 minutes of expiry and says expired from the expiry itself", () => {
    const cache = (nowMs: number) => conversationStatus(usage, nowMs).cache;
    expect(cache(end - 15 * 60_000 - 1)).toEqual({
      state: "warm",
      expiresAtMs: end,
      minutesLeft: 15,
    });
    expect(cache(end - 15 * 60_000)).toEqual({
      state: "expiring",
      expiresAtMs: end,
      minutesLeft: 15,
    });
    expect(cache(end - 30_000)).toEqual({ state: "expiring", expiresAtMs: end, minutesLeft: 0 });
    expect(cache(end)).toEqual({ state: "expired", expiresAtMs: end });
  });

  it("has no cache state without a reported lifetime, and no percentage without a window", () => {
    const { promptCacheExpiresAt: _, ...unknownCache } = usage;
    expect(conversationStatus({ ...unknownCache, maxTokens: null }, end)).toEqual({
      usedTokens: 50_000,
      maxTokens: null,
      usedPercent: null,
      cache: null,
    });
    expect(conversationStatus(usage, end).usedPercent).toBe(25);
  });

  it("words the cache countdown and rounds tokens to k and M", () => {
    const at = "2:30 PM";
    expect(cacheText({ state: "expiring", expiresAtMs: end, minutesLeft: 12 }, at)).toBe(
      "Cache expires in 12 minutes, at 2:30 PM",
    );
    expect(cacheText({ state: "expiring", expiresAtMs: end, minutesLeft: 1 }, at)).toBe(
      "Cache expires in 1 minute, at 2:30 PM",
    );
    expect(cacheText({ state: "expiring", expiresAtMs: end, minutesLeft: 0 }, at)).toBe(
      "Cache expires in under a minute, at 2:30 PM",
    );
    expect(cacheText({ state: "expired", expiresAtMs: end }, at)).toBe("Cache expired at 2:30 PM");
    expect([formatTokens(57_521), formatTokens(1_000_000), formatTokens(1_250_000)]).toEqual([
      "58k",
      "1M",
      "1.3M",
    ]);
  });
});
