// Added (headroom's ThreadLauncher.choose had no direct test): the router as the query-runner wrapper calls
// it, in a temporary home: accounts, sign-ins, readings, the shared conversations folder and the ledger.
import {
  type AccountStatus,
  append,
  emptyConfig,
  encodeAccountsConfig,
} from "@t3tools/lastdrop-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { accountsFiles, claudeFolder } from "./paths.ts";
import { SessionLedger } from "./sessionLedger.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";
import { ThreadRouter } from "./threadRouter.ts";

let t: TestHome;
let at: number;
let statuses: Record<string, AccountStatus>;
let ids: string[];
let router: ThreadRouter;
let ledger: SessionLedger;
const MIN = 60_000;

const shared = () => `${t.paths.sharedClaude}/projects`;
const stamp = (ms: number) => new Date(ms).toISOString();
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

beforeEach(() => {
  t = makeTestHome();
  at = Date.UTC(2026, 10, 14, 12);
  let config = emptyConfig();
  for (const key of ["Pro", "Ultra"]) {
    config = append(config, { provider: "claude", key, addedAt: 0 });
  }
  t.write(accountsFiles(t.paths).accounts, encodeAccountsConfig(config));
  t.write(t.paths.sharedConfig, { oauthAccount: { accountUuid: "u-main" } });
  for (const key of ["Pro", "Ultra"]) {
    t.write(`${claudeFolder(t.paths, key)}/.claude.json`, {
      oauthAccount: { accountUuid: `u-${key}` },
    });
  }
  statuses = {
    main: { session: 85, weekly: 50, at, plan: "Max 5x" },
    Pro: { session: 10, weekly: 10, at, plan: "Pro" },
    Ultra: { session: 0, weekly: 5, at, plan: "Ultra" },
  };
  ids = ["new-1", "new-2", "new-3"];
  ledger = new SessionLedger(`${t.paths.dataDir}/sessions.json`);
  router = new ThreadRouter({
    paths: t.paths,
    ledger,
    statuses: async () => statuses,
    now: () => at,
    newSessionId: () => ids.shift()!,
  });
});
afterEach(() => t.remove());

const route = (identity: Record<string, string | boolean>, extra: Record<string, unknown> = {}) =>
  router.route({
    threadId: "thread-1",
    identity,
    model: "claude-haiku-5-5",
    env: { PATH: "/bin", HOME: t.paths.home },
    delegated: false,
    ...extra,
  });

describe("the thread router", () => {
  it("a new thread starts on the roomiest account, signed in through its folder and profile", async () => {
    const r = await route({ sessionId: "X" });
    expect(r.decision?.account).toBe("Ultra");
    expect(r.identity).toEqual({ sessionId: "X" });
    const folder = claudeFolder(t.paths, "Ultra")!;
    expect(r.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(folder);
    expect(r.env["CLAUDE_CONFIG_DIR"]).toBe(`${folder}/profile`);
    expect((await ledger.read()).sessions["X"]?.account).toBe("Ultra");
    expect((await ledger.read()).appThreads["thread-1"]?.account).toBe("Ultra");
  });

  it("main runs as it is", async () => {
    statuses = { main: { session: 0, weekly: 0, at, plan: "Ultra" } };
    const r = await route({ sessionId: "X" });
    expect(r.decision?.account).toBe("main");
    expect(r.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBeUndefined();
    expect(r.env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });

  it("the user's own sign-in in the environment is left alone", async () => {
    const r = await route({ sessionId: "X" }, { env: { CLAUDE_CONFIG_DIR: "/mine" } });
    expect(r.decision).toBeUndefined();
    expect(r.env).toEqual({ CLAUDE_CONFIG_DIR: "/mine" });
    expect(r.untouched).toContain("CLAUDE_CONFIG_DIR");
  });

  it("a warm thread stays; a cold one moves with a fork and a new id", async () => {
    await route({ sessionId: "X" }); // on Ultra
    t.write(
      `${shared()}/proj/X.jsonl`,
      line({ type: "user", uuid: "x1", timestamp: stamp(at - 11 * MIN) }) +
        line({ type: "assistant", uuid: "x2", timestamp: stamp(at - 10 * MIN) }),
    );
    statuses = { ...statuses, Pro: { session: 0, weekly: 0, at, plan: "Max 20x" } };
    const warm = await route({ resume: "X" });
    expect(warm.decision?.action).toBe("stay");
    expect(warm.identity).toEqual({ resume: "X" });
    expect(warm.decision?.account).toBe("Ultra");

    at += 2 * 60 * MIN;
    statuses = Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, { ...v, at }]));
    const cold = await route({ resume: "X" });
    expect(cold.decision?.action).toBe("move");
    expect(cold.decision?.account).toBe("Pro");
    expect(cold.identity).toEqual({ resume: "X", forkSession: true, sessionId: "new-1" });
    expect(cold.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(claudeFolder(t.paths, "Pro"));
    expect(cold.notice).toBeUndefined();
    const store = await ledger.read();
    expect(store.threads["X"]?.current).toBe("new-1");
    expect(store.sessions["new-1"]).toMatchObject({ account: "Pro", from: "X" });
  });

  it("after a move every id T3 passes back is translated, a rewind's message id too", async () => {
    await ledger.record({ session: "X", account: "Ultra", at });
    await ledger.record({ session: "C", account: "Pro", at, forkedAt: at, from: "X" });
    await ledger.setCurrent("C", "X", at);
    t.write(
      `${shared()}/proj/X.jsonl`,
      line({ type: "assistant", uuid: "x2", timestamp: stamp(at) }),
    );
    t.write(
      `${shared()}/proj/C.jsonl`,
      line({
        type: "assistant",
        uuid: "c2",
        forkedFrom: { sessionId: "X", messageUuid: "x2" },
        timestamp: stamp(at),
      }) + line({ type: "assistant", uuid: "c3", timestamp: stamp(at) }),
    );
    const resumed = await route({ resume: "X" });
    expect(resumed.identity).toEqual({ resume: "C" });
    expect(resumed.decision?.account).toBe("Pro");
    // A rewind to a turn before the move: its message is found under its copy's id, on the same account.
    const rewind = await route({ resume: "X", resumeSessionAt: "x2" });
    expect(rewind.identity).toEqual({ resume: "C", resumeSessionAt: "c2" });
    expect(rewind.decision?.action).toBe("stay");
    // A turn after the move keeps its id.
    expect((await route({ resume: "X", resumeSessionAt: "c3" })).identity.resumeSessionAt).toBe(
      "c3",
    );
    expect(await router.currentSession("X")).toBe("C");
    expect(await router.messageId("X", "x2")).toEqual({ session: "C", uuid: "c2" });
    expect(await router.lineage("X")).toEqual(["C", "X"]);
  });

  it("a full account moves even a warm thread, and the thread is told", async () => {
    await route({ sessionId: "X" }); // Ultra
    t.write(
      `${shared()}/proj/X.jsonl`,
      line({ type: "assistant", uuid: "x2", timestamp: stamp(at - MIN) }),
    );
    router.markFull("Ultra");
    const r = await route({ resume: "X" });
    expect(r.decision?.action).toBe("move");
    expect(r.decision?.account).toBe("Pro");
    expect(r.notice).toContain("Ultra is at its usage limit");
    expect(r.notice).toContain("Pro");
    expect(await router.limitNotice("Ultra", "claude-haiku-5-5", false)).toContain(
      "on Claude account Pro",
    );
  });

  it("delegated children pick with the subagents' rule: the smallest plan with room", async () => {
    const child = await route(
      { sessionId: "child" },
      { threadId: "child-1", delegated: true, parentThreadId: "thread-1" },
    );
    expect(child.decision?.account).toBe("Pro");
    const main = await route({ sessionId: "main-thread" }, { threadId: "thread-2" });
    expect(main.decision?.account).toBe("Ultra");
  });

  it("an account whose retries were spent is left alone for a while", async () => {
    router.markTroubled("Ultra");
    expect((await route({ sessionId: "X" })).decision?.account).toBe("Pro");
    at += 11 * MIN;
    expect((await route({ sessionId: "Y" })).decision?.account).toBe("Ultra");
  });

  it("T3's own fork starts on its source's account", async () => {
    await ledger.record({ session: "X", account: "Pro", at });
    await router.recordFork("X", "F");
    expect((await ledger.read()).sessions["F"]).toMatchObject({ account: "Pro", from: "X" });
  });
});
