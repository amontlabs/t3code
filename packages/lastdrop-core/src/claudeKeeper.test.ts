// Ported from headroom Tests/LastDropTests/ClaudeKeeperTests.swift (see PORTING.md): the keeper's rules and
// the status file's. Times are ms.
import { describe, expect, it } from "vite-plus/test";

import {
  afterCheck,
  afterRenewal,
  endsSoon,
  isDue,
  judge,
  newSignIn,
  nextAttempt,
  renewDue,
} from "./claudeKeeper.ts";
import type { SignInFacts } from "./claudeUsage.ts";
import {
  type AccountStatus,
  decodeStatusFile,
  encodeStatusFile,
  isUnknown,
  readingFromStatus,
  recordBlock,
  resetsFromWindows,
  statusWithReading,
  statusWithSignIn,
} from "./usage.ts";

const now = 1_800_000_000_000;
const s = (n: number) => n * 1000;
const DAY = 86_400_000;

const facts = (o: {
  expires: number | undefined;
  ends?: number | undefined;
  refresh?: boolean;
  ended?: string;
}): SignInFacts => ({
  expiresAt: o.expires === undefined ? undefined : now + o.expires,
  endsAt: "ends" in o ? (o.ends === undefined ? undefined : now + o.ends) : now + 30 * DAY,
  hasRefreshToken: o.refresh ?? true,
  loginEnded: o.ended,
});

describe("the keeper", () => {
  it("judge names what only the user can fix", () => {
    expect(judge(undefined, now).state).toBe("signedOut");
    expect(judge(facts({ expires: s(3600) }), now).state).toBe("ok");
    // Expired but renewable: still fine, the keeper renews it.
    expect(judge(facts({ expires: s(-3600) }), now).state).toBe("ok");
    expect(
      judge(facts({ expires: undefined, refresh: false, ended: "time_limit" }), now).state,
    ).toBe("needsSignIn");
    expect(judge(facts({ expires: undefined, refresh: false }), now).state).toBe("needsSignIn");
    expect(judge(facts({ expires: s(3600), ends: s(-60) }), now).state).toBe("needsSignIn");
    // No refresh token, but the token still works for a while.
    expect(judge(facts({ expires: s(600), refresh: false }), now).state).toBe("ok");
  });

  it("renews four minutes before expiry, then just after, then backs off", () => {
    let entry = newSignIn({ expiresAt: now + s(600), checkedAt: now });
    expect(renewDue(entry, now)).toBe(false);
    expect(isDue(entry, now + s(200))).toBe(false);
    expect(isDue(entry, now + s(360))).toBe(true);
    expect(renewDue(entry, now + s(360))).toBe(true);
    // The first attempt didn't take: again 5 s after expiry.
    entry = { ...entry, nextAttempt: nextAttempt(1, entry.expiresAt, now + s(360)) };
    expect(entry.nextAttempt).toBe(now + s(605));
    expect(renewDue(entry, now + s(500))).toBe(false);
    expect(renewDue(entry, now + s(605))).toBe(true);
    // After expiry: 1, 2, 5, then every 15 minutes.
    const after = now + s(700);
    expect([2, 3, 4, 5, 9].map((n) => nextAttempt(n, entry.expiresAt, after) - after)).toEqual(
      [60, 120, 300, 900, 900].map(s),
    );
  });

  it("no renewal without a refresh token, and at once without a token", () => {
    expect(renewDue(newSignIn({ expiresAt: now + s(60), hasRefreshToken: false }), now)).toBe(
      false,
    );
    expect(renewDue(newSignIn({ expiresAt: undefined, hasRefreshToken: true }), now)).toBe(true);
  });

  it("the blob is read every five minutes anyway", () => {
    const entry = newSignIn({ expiresAt: now + s(8 * 3600), checkedAt: now });
    expect(isDue(entry, now + s(299))).toBe(false);
    expect(isDue(entry, now + s(300))).toBe(true);
  });

  it("ends soon warns three days ahead", () => {
    expect(endsSoon(newSignIn({ endsAt: now + 2 * DAY }), now)).toBe(true);
    expect(endsSoon(newSignIn({ endsAt: now + 4 * DAY }), now)).toBe(false);
  });

  // Added (no Swift test): `ClaudeKeeper.check`/`finished` as pure steps.
  it("a check starts a renewal when due and online, and gives up after failing long past expiry", () => {
    const due = afterCheck(undefined, facts({ expires: s(120) }), true, now);
    expect(due.renew).toBe(true);
    expect(due.entry.renewing).toBe(true);
    expect(afterCheck(undefined, facts({ expires: s(120) }), false, now).renew).toBe(false);
    let entry = afterRenewal(due.entry, false, true, now);
    expect(entry).toMatchObject({ renewing: false, attempts: 1, nextAttempt: now + s(125) });
    // Long past expiry, three failures: only the user can help.
    const late = now + s(3600);
    entry = afterRenewal({ ...entry, attempts: 2 }, false, true, late);
    expect(entry.gaveUp).toBe(true);
    const judged = afterCheck(entry, facts({ expires: s(120) }), true, late);
    expect(judged.entry.state).toBe("needsSignIn");
    expect(judged.renew).toBe(false);
    // A session renewed it meanwhile: the expiry moved, nothing left to retry.
    const moved = afterCheck(entry, facts({ expires: s(8 * 3600) }), true, now);
    expect(moved.entry).toMatchObject({ state: "ok", attempts: 0, gaveUp: false });
    expect(afterRenewal(due.entry, true, true, now)).toMatchObject({ attempts: 0, gaveUp: false });
  });
});

describe("the status file", () => {
  it("a window past its reset counts as unused", () => {
    const status: AccountStatus = {
      session: 100,
      weekly: 60,
      at: now - s(3600),
      models: { Fable: 100 },
      resetsAt: { Session: now - s(60), Weekly: now + DAY, Fable: now - s(1) },
    };
    const r = readingFromStatus(status, now);
    expect(r.session).toBe(0);
    expect(r.weekly).toBe(60);
    expect(r.models["Fable"]).toBe(0);
  });

  it("a reading older than two hours is unknown", () => {
    const r = readingFromStatus({ session: 10, weekly: 10, at: now - s(2 * 3600 + 1) }, now);
    expect(isUnknown(r)).toBe(true);
    expect(r.usable).toBe(true);
  });

  it("an account that needs sign-in is not usable", () => {
    const status = statusWithSignIn({ session: 10, weekly: 10, at: now }, { state: "needsSignIn" });
    expect(readingFromStatus(status, now).usable).toBe(false);
  });

  it("limit reached holds until a newer reading", () => {
    const full = now - s(30);
    expect(readingFromStatus({ session: 10, weekly: 10, at: now - s(60) }, now, full).session).toBe(
      100,
    );
    // The app read it again after the 429: its own numbers decide.
    expect(readingFromStatus({ session: 12, weekly: 10, at: now + s(1) }, now, full).session).toBe(
      12,
    );
  });

  it("resets are kept by row name", () => {
    const windows = [
      { label: "Weekly", usedPercent: 10, resetsAt: now },
      { label: "Fable Weekly", usedPercent: 5, resetsAt: now + s(60) },
    ];
    expect(resetsFromWindows(windows)).toEqual({ Weekly: now, Fable: now + s(60) });
  });

  it("an update keeps other writers' fields", () => {
    const blocked = recordBlock(undefined, 600, now).status;
    const entry = statusWithSignIn(blocked, { state: "needsSignIn" });
    const read = decodeStatusFile(encodeStatusFile({ "claude-2": entry }))["claude-2"];
    expect(read?.blockedUntil).toBe(now + s(600));
    expect(read?.signIn).toBe("needsSignIn");
  });

  // Added: the app's `SubagentUsage.update` for one reading, and the file round trip.
  it("a reading updates numbers only when newer, and the plan always", () => {
    const windows = [
      { label: "Session", usedPercent: 26, resetsAt: now + s(3600) },
      { label: "Weekly", usedPercent: 2 },
      { label: "Fable Weekly", usedPercent: 9 },
    ];
    const first = statusWithReading(undefined, { windows, at: now, plan: "Max 20x" });
    expect(first).toEqual({
      session: 26,
      weekly: 2,
      models: { Fable: 9 },
      resetsAt: { Session: now + s(3600) },
      at: now,
      plan: "Max 20x",
    });
    const older = statusWithReading(first, { windows: [], at: now - 1, plan: "Ultra" });
    expect(older.session).toBe(26);
    expect(older.plan).toBe("Ultra");
    expect(decodeStatusFile(encodeStatusFile({ main: first }))["main"]).toEqual(first);
  });
});
