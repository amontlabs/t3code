// Ported from headroom Tests/LastDropTests/SubagentTests.swift, "Choosing an account" (see PORTING.md).
import { describe, expect, it } from "vite-plus/test";

import { type Candidate, ownAccountUuid, pick, pickForThread } from "./accounts.ts";
import { planName, planSize } from "./planSize.ts";
import { readingFromWindows, usedForModel } from "./usage.ts";

const candidate = (
  id: string,
  session: number | undefined,
  weekly: number | undefined,
  extra: Partial<Candidate> = {},
): Candidate => ({ id, name: id, sessionUsed: session, weeklyUsed: weekly, ...extra });

const ceiling = (sessionThreshold: number, weeklyThreshold: number) => ({
  sessionThreshold,
  weeklyThreshold,
});

describe("choosing an account", () => {
  it("picks the account with most room", () => {
    const picked = pick([candidate("A", 60, 20), candidate("B", 10, 30)], ceiling(0.9, 0.9));
    expect(picked?.id).toBe("B");
  });

  it("skips accounts at or over a threshold", () => {
    expect(
      pick([candidate("A", 90, 10), candidate("B", 10, 95)], ceiling(0.9, 0.9)),
    ).toBeUndefined();
    expect(pick([candidate("A", 89, 10)], ceiling(0.9, 0.9))?.id).toBe("A");
  });

  it("unknown usage is the last resort", () => {
    // A known account with room wins.
    expect(
      pick([candidate("A", undefined, 10), candidate("B", 50, 50)], ceiling(0.9, 0.9))?.id,
    ).toBe("B");
    // None known to have room: the unknown one is tried rather than failing on a full one.
    expect(
      pick([candidate("A", undefined, 10), candidate("B", 95, 50)], ceiling(0.9, 0.9))?.id,
    ).toBe("A");
    expect(pickForThread([candidate("A", undefined, undefined), candidate("B", 100, 50)])?.id).toBe(
      "A",
    );
  });

  it("2026-11-11's incident goes to the unknown account", () => {
    // A session on Max, out of Fable; Ultra unreadable. The Fable subagent goes to Ultra, not to Max.
    const max = candidate("claude-2", 24, 93, { modelUsed: 100, isOwn: true });
    const ultra = candidate("main", undefined, undefined);
    expect(pick([ultra, max], ceiling(0.95, 1))?.id).toBe("main");
    // Unknown accounts other than the session's own come first.
    const ownUnknown = candidate("own", undefined, undefined, { isOwn: true });
    expect(
      pick([ownUnknown, candidate("other", undefined, undefined)], ceiling(0.9, 0.9))?.id,
    ).toBe("other");
  });

  // The threshold is a ceiling and nothing else: subagents already running there, or the session being the
  // account's own, never turn an account under it away. 2026-11-12: a sixth build got "no room" with Ultra at
  // weekly 35% because five running ones and the session each held back points.
  it("the ceiling is the only limit", () => {
    const ultra = candidate("main", 0, 35, { isOwn: true, size: planSize("Ultra") });
    const max5 = candidate("claude-2", 100, 12, { size: planSize("Max 5x") });
    expect(pick([ultra, max5], ceiling(0.9, 0.9))?.id).toBe("main");
    expect(pick([candidate("Pro", 89, 25)], ceiling(0.9, 0.95))?.id).toBe("Pro");
    expect(pick([candidate("Pro", 90, 25)], ceiling(0.9, 0.95))).toBeUndefined();
    expect(pick([candidate("Pro", 10, 95)], ceiling(0.9, 0.95))).toBeUndefined();
  });

  it("a plan without a five-hour window has room", () => {
    // Ultra: only weekly rows. The session counts as unused, not unknown.
    const reading = readingFromWindows([{ label: "Weekly", usedPercent: 0 }]);
    expect(reading.session).toBe(0);
    expect(readingFromWindows([]).session).toBeUndefined();
    const ultra: Candidate = {
      id: "main",
      name: "main",
      sessionUsed: reading.session,
      weeklyUsed: reading.weekly,
      size: planSize("Ultra"),
    };
    expect(pick([ultra], ceiling(0.9, 0.9))?.name).toBe("main");
    expect(pickForThread([ultra])?.name).toBe("main");
  });

  it("the run's model limit counts", () => {
    const reading = readingFromWindows([
      { label: "Session", usedPercent: 38 },
      { label: "Weekly", usedPercent: 80 },
      { label: "Fable Weekly", usedPercent: 100 },
    ]);
    expect(usedForModel(reading, "claude-fable-5-2")).toBe(100);
    expect(usedForModel(reading, "fable")).toBe(100);
    expect(usedForModel(reading, "opus")).toBeUndefined();
    const max = candidate("Max", 38, 50, { modelUsed: usedForModel(reading, "fable") });
    const ultra = candidate("Ultra", 0, 0);
    expect(pick([max, ultra], ceiling(0.9, 0.9))?.name).toBe("Ultra");
    expect(pick([max], ceiling(0.9, 0.9))).toBeUndefined();
  });

  it("the session's own account takes subagents up to the ceiling", () => {
    const own = candidate("Own", 75, 10, { isOwn: true });
    expect(pick([own], ceiling(0.9, 0.9))?.name).toBe("Own");
    expect(pick([{ ...own, sessionUsed: 90 }], ceiling(0.9, 0.9))).toBeUndefined();
  });

  it("plan size comes from the sign-in's tier", () => {
    expect(planSize(planName("max", "default_claude_max_5x"))).toEqual({ session: 5, weekly: 5 });
  });

  it("own account comes from the session", () => {
    expect(ownAccountUuid({ CLAUDE_CODE_ACCOUNT_UUID: "u1" }, () => undefined)).toBe("u1");
  });

  // Swift reads `.claude.json` from a temporary folder; the port takes the reader as an argument.
  it("own account follows the secure storage folder first", () => {
    const signedIn = (dir: string | undefined) => (dir === "/tmp/own" ? "max-uuid" : undefined);
    expect(
      ownAccountUuid(
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/own", CLAUDE_CODE_ACCOUNT_UUID: "app-uuid" },
        signedIn,
      ),
    ).toBe("max-uuid");
    // A folder with no sign-in falls through to the app's UUID.
    expect(
      ownAccountUuid(
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/nonexistent-x", CLAUDE_CODE_ACCOUNT_UUID: "app-uuid" },
        signedIn,
      ),
    ).toBe("app-uuid");
  });
});
