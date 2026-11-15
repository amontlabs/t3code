// Ported from headroom Tests/LastDropTests/UsageBackoffTests.swift (see PORTING.md). Swift keeps the status in
// usage.json; the port works on the status values, so "another process sees it in the file" becomes "the
// returned status says so".
import { describe, expect, it } from "vite-plus/test";

import {
  type AccountStatus,
  backoffMs,
  blockedUntil,
  clearBlock,
  decodeStatusFile,
  poolRoom,
  readingFromStatus,
  recordBlock,
  windowsFromStatus,
} from "./usage.ts";

const now = Date.UTC(2026, 10, 14, 12, 0, 0);
const minutes = (n: number) => n * 60_000;

describe("usage backoff", () => {
  it("one process blocks the others", () => {
    expect(blockedUntil(undefined, now)).toBeUndefined();
    const { status, until } = recordBlock(undefined, undefined, now);
    expect(until - now).toBe(300_000);
    // Another process sees it in the status.
    expect(blockedUntil(status, now)).toBe(until);
    // Swift: ClaudeProvider.fetch refuses while blocked; that's the provider's code (step 3).
  });

  it("backoff grows and is capped", () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual(
      [300, 600, 1200, 1800, 1800].map((s) => s * 1000),
    );
    let t = now;
    let status: AccountStatus | undefined;
    const waits: Array<number> = [];
    for (let i = 0; i < 3; i += 1) {
      const block = recordBlock(status, undefined, t);
      status = block.status;
      waits.push(block.until - t);
      t = block.until + 1000;
    }
    expect(waits).toEqual([300_000, 600_000, 1_200_000]);
  });

  it("a burst counts once and the server's Retry-After wins", () => {
    const first = recordBlock(undefined, 900, now);
    expect(first.until - now).toBe(900_000);
    const second = recordBlock(first.status, undefined, now);
    expect(second.until).toBe(first.until);
    expect(second.status.failures).toBe(1);
  });

  it("success clears the block", () => {
    const { status } = recordBlock(undefined, undefined, now);
    const cleared = clearBlock(status);
    expect(blockedUntil(cleared, now)).toBeUndefined();
    expect(cleared.failures).toBeUndefined();
  });

  it("a recent reading is used while blocked", () => {
    const status: AccountStatus = {
      session: 26,
      weekly: 2,
      at: now - minutes(90),
      blockedUntil: now + minutes(10),
      failures: 2,
    };
    const usage = readingFromStatus(status, now);
    expect(usage.session).toBe(26);
    expect(usage.weekly).toBe(2);
  });

  it("a reading older than two hours is unknown while blocked", () => {
    const status: AccountStatus = {
      session: 26,
      weekly: 2,
      at: now - minutes(180),
      blockedUntil: now + minutes(10),
      failures: 1,
    };
    const usage = readingFromStatus(status, now);
    expect(usage.session).toBeUndefined();
    expect(usage.weekly).toBeUndefined();
  });

  it("a runner uses the app's fresh reading without fetching", () => {
    // 14 minutes old: the reading comes back as is, and nothing is blocked.
    const status: AccountStatus = { session: 40, weekly: 10, at: now - minutes(14) };
    expect(readingFromStatus(status, now).session).toBe(40);
    expect(blockedUntil(status, now)).toBeUndefined();
  });

  it("old status files decode", () => {
    const json = `{"main":{"session":5,"weekly":1,"at":800000000,"plan":"Max 20x"},"Pro":{"session":null,"weekly":null,"at":800000000}}`;
    const status = decodeStatusFile(json);
    expect(status["main"]?.plan).toBe("Max 20x");
    expect(status["main"]?.at).toBe(800_000_000_000);
    expect(status["main"]?.blockedUntil).toBeUndefined();
    expect(status["Pro"]?.failures).toBeUndefined();
  });

  it("the pool keeps a blocked account's reading longer", () => {
    const thresholds = { sessionThreshold: 0.9, weeklyThreshold: 0.9 };
    const plain: AccountStatus = { session: 26, weekly: 2, at: now - minutes(90) };
    const blocked: AccountStatus = { ...plain, blockedUntil: now + minutes(5) };
    expect(poolRoom(plain, thresholds, now)).toBeUndefined();
    expect(poolRoom(blocked, thresholds, now)).toBeDefined();
  });
});

// Not in the Swift tests: the rules `SubagentUsage.reading(_:now:)` and `usage(_:)` apply, pinned here because
// the port has no file or app around them.
describe("reading a status for routing", () => {
  it("a window past its reset counts as unused", () => {
    const status: AccountStatus = {
      session: 95,
      weekly: 60,
      models: { Fable: 100 },
      at: now - minutes(30),
      resetsAt: { Session: now - minutes(1), Fable: now - minutes(1), Weekly: now + minutes(60) },
    };
    const reading = readingFromStatus(status, now);
    expect(reading.session).toBe(0);
    expect(reading.weekly).toBe(60);
    expect(reading.models).toEqual({ Fable: 0 });
  });

  it("a session left out beside a read week is a plan without one", () => {
    expect(readingFromStatus({ weekly: 20, at: now }, now).session).toBe(0);
    expect(readingFromStatus({ at: now }, now).session).toBeUndefined();
  });

  it("a sign-in that needs signing in again is not usable; none judged is", () => {
    expect(readingFromStatus({ at: now, signIn: "needsSignIn" }, now).usable).toBe(false);
    expect(readingFromStatus({ at: now }, now).usable).toBe(true);
  });

  it("an account that answered 'limit reached' is full until a newer reading", () => {
    const status: AccountStatus = { session: 10, weekly: 10, at: now - minutes(5) };
    const full = readingFromStatus(status, now, now - minutes(1));
    expect([full.session, full.weekly]).toEqual([100, 100]);
    const later = readingFromStatus(status, now, now - minutes(10));
    expect([later.session, later.weekly]).toEqual([10, 10]);
  });
});

describe("windows from a usage.json entry", () => {
  it("has no session row for Ultra, and a weekly row per model", () => {
    expect(
      windowsFromStatus({
        at: now,
        session: 0,
        weekly: 98,
        models: { Fable: 53 },
        plan: "Ultra",
        resetsAt: { Weekly: now + minutes(60), Fable: now + minutes(60) },
      }),
    ).toEqual([
      { label: "Weekly", usedPercent: 98, resetsAt: now + minutes(60) },
      { label: "Fable Weekly", usedPercent: 53, resetsAt: now + minutes(60) },
    ]);
  });

  it("keeps the session row when it has a reset or use", () => {
    expect(
      windowsFromStatus({ at: now, session: 49, weekly: 94, resetsAt: { Session: now } }).map(
        (window) => window.label,
      ),
    ).toEqual(["Session", "Weekly"]);
    expect(windowsFromStatus({ at: now, session: 12 })[0]?.label).toBe("Session");
    expect(windowsFromStatus(undefined)).toEqual([]);
  });
});
