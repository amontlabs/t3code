// @effect-diagnostics nodeBuiltinImport:off - A temporary lastdrop folder; never the real ~/.t3.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { addCodexAccount, CodexAccountFiles } from "@t3tools/lastdrop-node";

import { codexLimits, codexRoom, makeCodexRouting } from "./routing.ts";

const NOW = Date.UTC(2026, 10, 16, 12);
const MIN = 60_000;
const seconds = (ms: number) => Math.floor(ms / 1000);

describe("an account's room from its reading", () => {
  it("is unknown without a recent reading", () => {
    assert.deepStrictEqual(codexRoom("a", true, undefined, NOW), { key: "a", signedIn: true });
    const stale = { readAt: NOW - 3 * 60 * MIN, limits: { primary: { usedPercent: 10 } } };
    assert.deepStrictEqual(codexRoom("a", true, stale, NOW), { key: "a", signedIn: true });
  });

  it("takes the 5-hour and weekly windows, a passed reset as unused, and a reached limit as full", () => {
    const record = {
      readAt: NOW - MIN,
      limits: {
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: seconds(NOW - MIN) },
        secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: seconds(NOW + MIN) },
      },
    };
    assert.deepStrictEqual(codexRoom("a", true, record, NOW), {
      key: "a",
      signedIn: true,
      sessionUsed: 0,
      weeklyUsed: 70,
    });
    const reached = {
      readAt: NOW - MIN,
      limits: {
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: seconds(NOW + 30 * MIN) },
      },
    };
    assert.strictEqual(
      codexRoom("a", true, reached, NOW).fullUntil,
      seconds(NOW + 30 * MIN) * 1000,
    );
  });
});

describe("an account's limits", () => {
  it("name the available reset that expires first, so Use reset redeems it on this account", () => {
    const credit = (id: string, status: string, expiresAt: number) => ({ id, status, expiresAt });
    const record = {
      readAt: NOW,
      limits: { primary: { usedPercent: 100, windowDurationMins: 300 } },
      resetCredits: {
        availableCount: 2,
        credits: [
          credit("later", "available", seconds(NOW + 60 * MIN)),
          credit("used", "redeemed", seconds(NOW + MIN)),
          credit("soon", "available", seconds(NOW + 10 * MIN)),
        ],
      },
    };
    assert.deepStrictEqual(codexLimits(record)?.resetCredits, {
      availableCount: 2,
      nextExpiresAt: "2026-11-16T12:10:00.000Z",
      nextCreditId: "soon",
    });
    const none = { ...record, resetCredits: { availableCount: 0, credits: [] } };
    assert.isUndefined(codexLimits(none)?.resetCredits?.nextCreditId);
  });
});

describe("routing over lastdrop's files", () => {
  it("a new thread takes the roomiest signed-in account and stays there when reopened", async () => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-codex-"));
    try {
      const files = new CodexAccountFiles(dataDir);
      await files.editList((list) => addCodexAccount(list, "A", 0)!.list);
      await files.editList((list) => addCodexAccount(list, "B", 0)!.list);
      await files.editList((list) => addCodexAccount(list, "Out", 0)!.list);
      for (const key of ["A", "B"]) {
        NodeFS.mkdirSync(files.home(key), { recursive: true });
        NodeFS.writeFileSync(`${files.home(key)}/auth.json`, "{}");
      }
      const reading = (used: number) => ({
        readAt: NOW,
        limits: {
          primary: { usedPercent: used, windowDurationMins: 300 },
          secondary: { usedPercent: used, windowDurationMins: 10080 },
        },
      });
      await files.updateUsage("A", () => reading(50));
      await files.updateUsage("B", () => reading(10));
      const routing = makeCodexRouting({ files, now: () => NOW, log: () => {} });

      const first = await routing.route("thread-1");
      assert.deepStrictEqual(first, { account: "B", home: files.home("B") });
      await routing.recordThread("B", "thread-1", "native-1");
      // B fills up while the thread runs (Codex's own update), so new threads go to A...
      await routing.observeLimits("B", { primary: { usedPercent: 60 } });
      assert.strictEqual((await routing.route("thread-2"))?.account, "A");
      // ...while thread-1 reopens on B, until B is full.
      assert.strictEqual((await routing.route("thread-1"))?.account, "B");
      await routing.observeLimits("B", { primary: { usedPercent: 100 } });
      assert.strictEqual((await routing.route("thread-1"))?.account, "A");
      // A turn that ends at A's limit marks it full before any reading says so; with B full too, none has room.
      await routing.recordThread("A", "thread-1", "native-1");
      assert.strictEqual(await routing.atLimit("A", "thread-1"), undefined);
      await routing.observeLimits("B", { primary: { usedPercent: 10 } });
      assert.strictEqual(await routing.atLimit("A", "thread-1"), "B");
      assert.strictEqual((await routing.route("thread-1"))?.account, "B");
      // The agents' question: room while one signed-in account has some; each one named when none has.
      assert.deepStrictEqual(await routing.room(), { full: undefined, roomReadAt: NOW });
      await routing.observeLimits("B", { primary: { usedPercent: 100 } });
      assert.deepStrictEqual(await routing.room(), {
        full: [{ name: "A", until: NOW + 60 * MIN }, { name: "B" }],
        roomReadAt: undefined,
      });
      // A full read of A that began after its mark (a reset redeemed since, in the app or outside it) speaks
      // for A, and the mark goes; one that began before it has older numbers, and the mark stays.
      routing.usageRead("A", NOW);
      assert.isDefined((await routing.room())?.full);
      routing.usageRead("A", NOW + MIN);
      assert.deepStrictEqual(await routing.room(), { full: undefined, roomReadAt: NOW });
      assert.strictEqual((await routing.route("thread-2"))?.account, "A");
    } finally {
      NodeFS.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
