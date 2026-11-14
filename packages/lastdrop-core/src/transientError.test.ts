// Ported from headroom Tests/LastDropTests/TransientErrorTests.swift, "The classifier" and "The policy"
// (see PORTING.md for the run, chain and relay cases).
import { describe, expect, it } from "vite-plus/test";

import { classifyResult, failedToStart, handsOn, parseClaudeResult } from "./result.ts";
import { retryDelayMs, standardRetryPolicy, transientReason } from "./transientError.ts";

const cloudflare = "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";
const no = () => false;
const yes = () => true;

describe("the classifier", () => {
  it("the incident's errors are passing whatever the sign-in", () => {
    expect(transientReason(cloudflare, 403, no)).toBeDefined();
    expect(
      transientReason("API Error: 503 credential validation failed", undefined, no),
    ).toBeDefined();
    expect(transientReason("API Error: 503 status code (no body)", 503, no)).toBeDefined();
  });

  it("overloaded, server and network errors are passing", () => {
    expect(transientReason('API Error: 529 {"type":"overloaded_error"}', 529, no)).toBe(
      "API overloaded (529)",
    );
    expect(transientReason("Overloaded", undefined, no)).toBeDefined();
    expect(transientReason("API Error: 500 Internal server error", 500, no)).toBeDefined();
    expect(transientReason("API Error: 502 Bad Gateway", undefined, no)).toBeDefined();
    expect(transientReason("API Error: Connection error.", undefined, no)).toBeDefined();
    expect(transientReason("Error: read ECONNRESET", undefined, no)).toBeDefined();
    expect(transientReason("Request timed out.", undefined, no)).toBeDefined();
  });

  it("an authentication failure is passing only while the sign-in works", () => {
    const text =
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}';
    expect(transientReason(text, 401, yes)).toBeDefined();
    expect(transientReason(text, 401, no)).toBeUndefined();
    // Signed out is signed out, whatever the sign-in blob says.
    expect(transientReason("Not logged in · Please run /login", undefined, yes)).toBeUndefined();
    expect(
      transientReason("OAuth token has been revoked. Please run /login.", 403, yes),
    ).toBeUndefined();
  });

  it("the sign-in is only asked about for an authentication failure", () => {
    let asked = 0;
    const ask = () => {
      asked += 1;
      return true;
    };
    transientReason(cloudflare, 403, ask);
    transientReason("Something broke.", undefined, ask);
    expect(asked).toBe(0);
    transientReason("Failed to authenticate.", 401, ask);
    expect(asked).toBe(1);
  });

  it("other errors, limits and missing models are not passing", () => {
    expect(transientReason("Something broke.", undefined, yes)).toBeUndefined();
    const limit = classifyResult(
      parseClaudeResult({
        is_error: true,
        result: "You've hit your session limit",
        api_error_status: 429,
      }),
      yes,
    );
    expect(limit.limitReached).toBe(true);
    expect(limit.transient).toBeUndefined();
    const model = classifyResult(
      parseClaudeResult({
        is_error: true,
        result: "Fable 5.1 requires usage credits. Switch to another model.",
      }),
      yes,
    );
    expect(model.transient).toBeUndefined();
    const ok = classifyResult(
      parseClaudeResult({ is_error: false, result: "Cloudflare is a CDN." }),
      yes,
    );
    expect(ok.transient, "only an error is ever passing").toBeUndefined();
  });

  // The incident's result event: a passing error, not a sign-in to fix, and before any work a reason to fall back.
  it("the incident's result is passing and falls back before any work", () => {
    const result = classifyResult(
      parseClaudeResult({
        type: "result",
        is_error: true,
        api_error_status: 403,
        result: cloudflare,
      }),
      no,
    );
    expect(result.transient).toBeDefined();
    expect(result.unavailable).toBe(false);
    expect(result.limitReached).toBe(false);
    expect(failedToStart(result)).toBe(true);
    expect(handsOn(result)).toBe(true);
    expect(
      failedToStart({ ...result, toolUses: 3 }),
      "after work, it is handed on, not skipped",
    ).toBe(false);
  });
});

describe("the policy", () => {
  it("retries wait ten, thirty, ninety seconds then three minutes, jittered", () => {
    const policy = standardRetryPolicy;
    expect([0, 1, 2, 3].map((n) => retryDelayMs(policy, n, 0))).toEqual([
      10_000, 30_000, 90_000, 180_000,
    ]);
    expect(retryDelayMs(policy, 4, 0)).toBeUndefined();
    expect(retryDelayMs(policy, 0, -1)).toBe(8_000);
    expect(retryDelayMs(policy, 3, 1)).toBe(216_000);
  });
});
