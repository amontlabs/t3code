// Added (headroom's ThreadLauncher.choose had no direct test): the router as the query-runner wrapper calls
// it, in a temporary home: accounts, sign-ins, readings, the shared conversations folder and the ledger.
import {
  type AccountStatus,
  append,
  emptyConfig,
  encodeAccountsConfig,
} from "@t3tools/lastdrop-core";
import * as NodeFS from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { accountsFile, claudeFolder } from "./paths.ts";
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
  t.write(accountsFile(t.paths), encodeAccountsConfig(config));
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

const route = async (
  identity: Record<string, string | boolean>,
  extra: Record<string, unknown> = {},
) => {
  const r = await routeOnly(identity, extra);
  await r.commit();
  return r;
};
const routeOnly = (
  identity: Record<string, string | boolean>,
  extra: Record<string, unknown> = {},
) =>
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
    expect(r.decision?.forcedBy).toBe("full");
    expect(r.notice).toContain("Pro");
    expect((await router.limitNotice("Ultra", "claude-haiku-5-5", false)).notice).toContain(
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
    // Troubled is not gone: a warm thread there stays, and is told nothing false.
    await ledger.record({ session: "W", account: "Ultra", at });
    t.write(
      `${shared()}/proj/W.jsonl`,
      line({ type: "assistant", uuid: "w", timestamp: stamp(at - MIN) }),
    );
    const warm = await route({ resume: "W" });
    expect(warm.decision?.action).toBe("stay");
    expect(warm.decision?.account).toBe("Ultra");
    expect(warm.notice).toBeUndefined();
    at += 11 * MIN;
    expect((await route({ sessionId: "Y" })).decision?.account).toBe("Ultra");
  });

  it("T3's own fork starts on its source's account", async () => {
    await ledger.record({ session: "X", account: "Pro", at });
    t.write(`${shared()}/proj/F.jsonl`, line({ type: "user", uuid: "f" }));
    await router.recordFork("X", "F");
    expect((await ledger.read()).sessions["F"]).toMatchObject({ account: "Pro", from: "X" });
  });

  it("choosing writes nothing until the route is committed", async () => {
    const r = await routeOnly({ sessionId: "X" });
    expect((await ledger.read()).sessions["X"]).toBeUndefined();
    await r.commit();
    expect((await ledger.read()).sessions["X"]?.account).toBe("Ultra");
  });

  it("every account troubled: a resumed thread stays on its recorded account", async () => {
    await ledger.record({ session: "B1", account: "Pro", at });
    t.write(
      `${shared()}/proj/B1.jsonl`,
      line({ type: "assistant", uuid: "b", timestamp: stamp(at - MIN) }),
    );
    for (const a of ["main", "Pro", "Ultra"]) router.markTroubled(a);
    const r = await route({ resume: "B1" });
    expect(r.decision?.account).toBe("Pro");
    expect(r.identity).toEqual({ resume: "B1" });
    expect(r.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(claudeFolder(t.paths, "Pro"));
  });

  it("nobody usable: a resumed thread is still decided, never opened untouched with its id", async () => {
    await ledger.record({ session: "B2", account: "Pro", at });
    statuses = Object.fromEntries(
      Object.entries(statuses).map(([k, v]) => [k, { ...v, signIn: "needsSignIn" as const }]),
    );
    const r = await route({ resume: "B2" });
    expect(r.untouched).toBeUndefined();
    expect(r.decision?.action).toBe("move");
    expect(r.identity.sessionId).not.toBe("B2");
  });

  it("the fallback opens on the recorded account, ids translated, writing nothing", async () => {
    await ledger.record({ session: "X", account: "Pro", at });
    await ledger.record({ session: "C", account: "Pro", at, forkedAt: at, from: "X" });
    await ledger.setCurrent("C", "X", at);
    t.write(`${shared()}/proj/C.jsonl`, line({ type: "assistant", uuid: "c" }));
    const before = await ledger.read();
    const r = await router.recorded({ identity: { resume: "X" }, env: { PATH: "/bin" } });
    expect(r.identity).toEqual({ resume: "C" });
    expect(r.decision?.account).toBe("Pro");
    expect(r.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe(claudeFolder(t.paths, "Pro"));
    expect(await ledger.read()).toEqual(before);
    // A ledger that can't be read: no guess.
    t.write(`${t.paths.dataDir}/sessions.json`, "{broken");
    await expect(router.recorded({ identity: { resume: "X" }, env: {} })).rejects.toThrow(
      /can't be read/,
    );
    await expect(routeOnly({ resume: "X" })).rejects.toThrow(/can't be read/);
  });

  it("a limit with nowhere else to go names no account", async () => {
    router.markFull("main");
    router.markFull("Pro");
    expect((await router.limitNotice("Ultra", undefined, false)).to).toBeUndefined();
    expect((await router.limitNotice("main", undefined, false)).to).toBe("Ultra");
  });

  it("a fork gets the subagents of its source and every older conversation, never overwriting", async () => {
    await ledger.record({ session: "X", account: "Ultra", at });
    await ledger.record({ session: "C", account: "Pro", at, forkedAt: at, from: "X" });
    await ledger.setCurrent("C", "X", at);
    t.write(`${shared()}/proj/X.jsonl`, line({ type: "user", uuid: "x1" }));
    t.write(`${shared()}/proj/C.jsonl`, line({ type: "user", uuid: "c1" }));
    t.write(`${shared()}/proj/X/subagents/agent-old.jsonl`, "old\n");
    t.write(`${shared()}/proj/X/subagents/agent-old.meta.json`, { agentType: "general-purpose" });
    t.write(`${shared()}/proj/X/subagents/agent-both.jsonl`, "from X\n");
    t.write(`${shared()}/proj/C/subagents/agent-both.jsonl`, "from C\n");
    t.write(`${shared()}/proj/C/subagents/agent-new.jsonl`, "new\n");
    t.write(`${shared()}/proj/N/subagents/agent-new.jsonl`, "already there\n");
    await router.copySubagents("C", "N");
    const read = (name: string) =>
      NodeFS.readFileSync(`${shared()}/proj/N/subagents/${name}`, "utf8");
    expect(read("agent-old.jsonl")).toBe("old\n");
    expect(JSON.parse(read("agent-old.meta.json"))).toEqual({ agentType: "general-purpose" });
    expect(read("agent-both.jsonl")).toBe("from C\n");
    expect(read("agent-new.jsonl")).toBe("already there\n");
    // The sources are untouched.
    expect(NodeFS.readFileSync(`${shared()}/proj/X/subagents/agent-both.jsonl`, "utf8")).toBe(
      "from X\n",
    );
  });

  it("a fork whose lineage has no subagents folder copies nothing and fails nothing", async () => {
    await ledger.record({ session: "X", account: "Ultra", at });
    t.write(`${shared()}/proj/X.jsonl`, line({ type: "user", uuid: "x1" }));
    await router.copySubagents("X", "N");
    await router.copySubagents("unknown", "N");
    expect(NodeFS.existsSync(`${shared()}/proj/N`)).toBe(false);
  });

  it("a T3 fork that wrote no transcript is not recorded", async () => {
    await ledger.record({ session: "X", account: "Pro", at });
    await router.recordFork("X", "nothing-written");
    expect((await ledger.read()).sessions["nothing-written"]).toBeUndefined();
  });
});
