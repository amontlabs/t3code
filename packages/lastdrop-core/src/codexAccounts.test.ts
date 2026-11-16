import { describe, expect, it } from "vite-plus/test";

import {
  addCodexAccount,
  chooseCodexAccount,
  type CodexRoom,
  moveCodexAccount,
  parseCodexAccounts,
  parseCodexThreads,
  recordCodexThread,
  recordedCodexAccount,
  removeCodexAccount,
  renameCodexAccount,
} from "./codexAccounts.ts";

const NOW = 1_000_000;
const room = (key: string, session?: number, weekly?: number, extra: Partial<CodexRoom> = {}) => ({
  key,
  signedIn: true,
  sessionUsed: session,
  weeklyUsed: weekly,
  ...extra,
});

describe("the Codex account list", () => {
  it("adds, renames, reorders and removes", () => {
    const first = addCodexAccount({ accounts: [] }, "Work", NOW)!;
    const second = addCodexAccount(first.list, "my home", NOW)!;
    expect(second.account).toEqual({ key: "my-home", name: "my home", addedAt: NOW });
    expect(addCodexAccount(second.list, "work", NOW)).toBeUndefined();
    expect(addCodexAccount(second.list, "  ", NOW)).toBeUndefined();
    const moved = moveCodexAccount(second.list, "my-home", -1);
    expect(moved.accounts.map((a) => a.key)).toEqual(["my-home", "Work"]);
    expect(moveCodexAccount(moved, "my-home", -1)).toBe(moved);
    const renamed = renameCodexAccount(moved, "Work", "Job");
    expect(renamed.accounts[1]).toEqual({ key: "Work", name: "Job", addedAt: NOW });
    expect(renameCodexAccount(renamed, "Work", "").accounts[1]).toEqual({
      key: "Work",
      addedAt: NOW,
    });
    expect(removeCodexAccount(renamed, "Work").accounts.map((a) => a.key)).toEqual(["my-home"]);
  });

  it("reads only well-formed, unique entries", () => {
    expect(
      parseCodexAccounts({
        accounts: [
          { key: "a", name: "A", addedAt: 5 },
          { key: "A" },
          { key: "../x" },
          { name: "no key" },
          "junk",
        ],
      }),
    ).toEqual({ accounts: [{ key: "a", name: "A", addedAt: 5 }] });
    expect(parseCodexAccounts(undefined)).toEqual({ accounts: [] });
  });
});

describe("choosing a Codex account", () => {
  it("passes through when nobody is signed in", () => {
    expect(
      chooseCodexAccount({ rooms: [room("a", 0, 0, { signedIn: false })], now: NOW }),
    ).toBeUndefined();
  });

  it("a new thread takes the most room across the 5-hour and weekly windows", () => {
    expect(chooseCodexAccount({ rooms: [room("a", 10, 90), room("b", 50, 20)], now: NOW })).toEqual(
      { key: "b", why: "room" },
    );
    // Signed-out accounts never take work, however empty.
    expect(
      chooseCodexAccount({
        rooms: [room("a", 0, 0, { signedIn: false }), room("b", 70, 70)],
        now: NOW,
      }),
    ).toEqual({ key: "b", why: "room" });
  });

  it("a known thread stays on its account until it is full or signed out", () => {
    const rooms = [room("a", 70, 70), room("b", 0, 0)];
    expect(chooseCodexAccount({ rooms, recorded: "a", now: NOW })).toEqual({
      key: "a",
      why: "recorded",
    });
    expect(
      chooseCodexAccount({ rooms: [room("a", 100, 70), room("b", 0, 0)], recorded: "a", now: NOW }),
    ).toEqual({ key: "b", why: "room" });
    expect(
      chooseCodexAccount({
        rooms: [room("a", 10, 10, { signedIn: false }), room("b", 50, 50)],
        recorded: "a",
        now: NOW,
      }),
    ).toEqual({ key: "b", why: "room" });
    // A removed account is no longer in the rooms at all.
    expect(chooseCodexAccount({ rooms: [room("b", 50, 50)], recorded: "a", now: NOW })?.key).toBe(
      "b",
    );
  });

  it("a usage-limit mark counts as full until its reset", () => {
    const marked = room("a", 10, 10, { fullUntil: NOW + 1 });
    expect(
      chooseCodexAccount({ rooms: [marked, room("b", 60, 60)], recorded: "a", now: NOW }),
    ).toEqual({ key: "b", why: "room" });
    expect(
      chooseCodexAccount({ rooms: [marked, room("b", 60, 60)], recorded: "a", now: NOW + 2 }),
    ).toEqual({ key: "a", why: "recorded" });
  });

  it("unknown usage is tried before failing on a full account; all full opens on the first", () => {
    expect(chooseCodexAccount({ rooms: [room("a", 100, 100), room("b")], now: NOW })?.key).toBe(
      "b",
    );
    expect(
      chooseCodexAccount({ rooms: [room("a", 100, 50), room("b", 30, 100)], now: NOW }),
    ).toEqual({ key: "a", why: "allFull" });
  });
});

describe("Codex thread records", () => {
  it("finds a T3 thread's newest account and keeps the newest records", () => {
    let records = recordCodexThread({}, "n1", { account: "a", threadId: "t1", at: 1 });
    records = recordCodexThread(records, "n2", { account: "b", threadId: "t1", at: 2 });
    records = recordCodexThread(records, "n3", { account: "a", threadId: "t2", at: 3 });
    expect(recordedCodexAccount(records, "t1")).toBe("b");
    expect(recordedCodexAccount(records, "t3")).toBeUndefined();
    const pruned = recordCodexThread(records, "n4", { account: "a", threadId: "t3", at: 4 }, 2);
    expect(Object.keys(pruned).toSorted()).toEqual(["n3", "n4"]);
    expect(parseCodexThreads({ threads: pruned })).toEqual(pruned);
    expect(parseCodexThreads({ threads: { x: { account: 1 } } })).toEqual({});
  });
});
