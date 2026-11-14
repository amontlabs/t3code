// Ported from headroom Tests/LastDropTests/SharedConversationsTests.swift (which account a shared
// conversation counts for) and the ledger and transfer cases of SubagentTests.swift (see PORTING.md), in a
// temporary home.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";

import {
  currentSessionIn,
  decodeLedger,
  lineageIn,
  linesAfterFork,
  MAX_SESSIONS,
  pruneLedger,
  SessionLedger,
  transcriptAccount,
} from "./sessionLedger.ts";
import {
  conversationTail,
  copyTranscript,
  findTranscript,
  messageIdIn,
  transcriptInShared,
} from "./sessionTransfer.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

let t: TestHome;
let shared: string;
let ledger: SessionLedger;
const now = Date.UTC(2026, 10, 14, 12);

beforeEach(() => {
  t = makeTestHome();
  shared = `${t.paths.sharedClaude}/projects`;
  ledger = new SessionLedger(`${t.paths.dataDir}/sessions.json`);
});
afterEach(() => t.remove());

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

describe("the session ledger", () => {
  it("records a session once and keeps its first account", async () => {
    await ledger.record({ session: "s1", account: "Work", at: now });
    await ledger.record({
      session: "s1",
      account: "main",
      at: now + 1,
      hasTranscriptLines: async () => true,
    });
    expect((await ledger.read()).sessions["s1"]).toEqual({ account: "Work", startedAt: now });
    // A record nobody answered yet is replaced: T3 restarted the thread elsewhere.
    await ledger.record({
      session: "s1",
      account: "main",
      at: now + 2,
      hasTranscriptLines: async () => false,
    });
    expect((await ledger.read()).sessions["s1"]?.account).toBe("main");
  });

  it("maps a thread to the conversation it continues in, and back through its moves", async () => {
    await ledger.record({ session: "C", account: "B", at: now, forkedAt: now, from: "X" });
    await ledger.setCurrent("C", "X", now);
    await ledger.record({ session: "D", account: "A", at: now, forkedAt: now, from: "C" });
    await ledger.setCurrent("D", "X", now);
    const store = await ledger.read();
    expect(currentSessionIn(store, "X")).toBe("D");
    expect(currentSessionIn(store, "unknown")).toBe("unknown");
    expect(lineageIn(store, "X")).toEqual(["D", "C", "X"]);
    // The file is the fork's own, in its data folder.
    expect(NodeFS.existsSync(`${t.paths.dataDir}/sessions.json`)).toBe(true);
  });

  it("an unreadable ledger is kept aside, never written over", async () => {
    t.write(`${t.paths.dataDir}/sessions.json`, "{not json");
    await ledger.setCurrent("C", "X", now);
    const kept = NodeFS.readdirSync(t.paths.dataDir).filter((n) => n.includes("unreadable"));
    expect(kept).toHaveLength(1);
    expect(currentSessionIn(await ledger.read(), "X")).toBe("C");
  });

  it("keeps at most the newest sessions, never one under 30 days old", () => {
    const store = decodeLedger("{}");
    const old = now - 40 * 86_400_000;
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      store.sessions[`s${i}`] = { account: "main", startedAt: i < 10 ? old + i : now };
    }
    pruneLedger(store, now);
    expect(Object.keys(store.sessions)).toHaveLength(MAX_SESSIONS);
    expect(store.sessions["s0"]).toBeUndefined();
    expect(store.sessions["s9"]).toBeDefined();
  });
});

describe("shared conversations", () => {
  const folders = () => ({ shared, accounts: t.paths.claudeFolders });

  // testTheLedgerSaysWhichAccountASharedConversationRanOn
  it("the ledger says which account a shared conversation ran on", async () => {
    await ledger.record({ session: "s1", account: "Work", at: now });
    const store = await ledger.read();
    expect(transcriptAccount(`${shared}/p/s1.jsonl`, store, folders())).toBe("Work");
    expect(transcriptAccount(`${shared}/p/s2.jsonl`, store, folders())).toBe("main");
    // A subagent transcript counts as the session its side folder belongs to.
    expect(transcriptAccount(`${shared}/p/s1/subagents/agent-a.jsonl`, store, folders())).toBe(
      "Work",
    );
  });

  // testAnAccountFolderKeepsItsOwnAccount
  it("an account folder keeps its own account", async () => {
    const store = await ledger.read();
    expect(
      transcriptAccount(`${t.paths.claudeFolders}/Work/projects/p/s1.jsonl`, store, folders()),
    ).toBe("Work");
  });

  // testLinesFromBeforeAForkDontCount
  it("lines from before a fork don't count", () => {
    const forked = Date.UTC(2026, 9, 30, 16);
    const text =
      line({ type: "assistant", timestamp: "2026-10-30T15:25:03.424Z" }) +
      line({ type: "assistant", timestamp: "2026-10-30T16:25:03.424Z" }) +
      line({ type: "assistant", timestamp: "2026-10-30T17:25:03.424Z" });
    expect(linesAfterFork(text, forked)).toHaveLength(2);
    expect(linesAfterFork(text, undefined)).toHaveLength(3);
  });
});

describe("moving transcripts", () => {
  // testTransferCopiesTheTranscriptAndItsSideFiles
  it("the transfer copies the transcript and its side files, without the trailing notice", async () => {
    const old = `${t.paths.claudeFolders}/Work/projects`;
    t.write(
      `${old}/proj/s1.jsonl`,
      line({ type: "assistant", uuid: "a" }) +
        line({ type: "assistant", uuid: "n", isApiErrorMessage: true }),
    );
    t.write(`${old}/proj/s1/subagents/agent-x.jsonl`, line({ type: "user" }));
    expect(await copyTranscript("s1", old, shared)).toBe(true);
    const copied = NodeFS.readFileSync(`${shared}/proj/s1.jsonl`, "utf8");
    expect(copied).toContain('"uuid":"a"');
    expect(copied).not.toContain('"uuid":"n"');
    expect(NodeFS.existsSync(`${shared}/proj/s1/subagents/agent-x.jsonl`)).toBe(true);
  });

  // testAnOldRunsSessionIsCopiedToTheMainProjectsOnce
  it("an old run's session is copied to the shared projects once", async () => {
    const old = `${t.paths.claudeFolders}/Work/projects`;
    t.write(`${old}/proj/s1.jsonl`, line({ type: "assistant", uuid: "a" }));
    expect(await transcriptInShared("s1", shared, [old])).toBe(`${shared}/proj/s1.jsonl`);
    NodeFS.appendFileSync(`${shared}/proj/s1.jsonl`, line({ type: "assistant", uuid: "b" }));
    // Found in the shared folder now: never copied over again.
    expect(await transcriptInShared("s1", shared, [old])).toBe(`${shared}/proj/s1.jsonl`);
    expect(NodeFS.readFileSync(`${shared}/proj/s1.jsonl`, "utf8")).toContain('"uuid":"b"');
    expect(await transcriptInShared("missing", shared, [old])).toBeUndefined();
  });

  // testTheConversationFileIsFoundAcrossProjectsAndReadWarm
  it("the conversation file is found across projects and read warm", async () => {
    t.write(`${shared}/proj-a/other.jsonl`, "");
    t.write(
      `${shared}/proj-b/conv-1.jsonl`,
      line({ type: "assistant", timestamp: new Date(now - 30_000).toISOString() }) +
        line({ type: "user", timestamp: new Date(now - 20_000).toISOString() }),
    );
    expect(await findTranscript("conv-1", shared)).toBe(`${shared}/proj-b/conv-1.jsonl`);
    const tail = await conversationTail("conv-1", shared);
    expect(tail.lastAssistantAt).toBe(now - 30_000);
    expect(tail.justCompacted).toBe(false);
    expect((await conversationTail("missing", shared)).lastAssistantAt).toBeUndefined();
  });

  // testAnAnswerBeyondAHugeToolResultIsFoundBySearchingFurtherBack
  it("an answer beyond a huge tool result is found by searching further back", async () => {
    t.write(
      `${shared}/p/big.jsonl`,
      line({ type: "assistant", timestamp: new Date(now - 30_000).toISOString() }) +
        line({ type: "attachment", content: "x".repeat(2 * 1024 * 1024) }),
    );
    expect((await conversationTail("big", shared)).lastAssistantAt).toBe(now - 30_000);
  });

  // testCarryOnRewritesTranscriptWhenSharedFolderAndForksToNewID: Claude Code's fork gives every copied
  // message a new uuid and records where it came from; a rewind to an old message finds its copy.
  it("a message id from before a move is found in the fork", async () => {
    t.write(
      `${shared}/p/X.jsonl`,
      line({ type: "user", uuid: "x1" }) + line({ type: "assistant", uuid: "x2" }),
    );
    t.write(
      `${shared}/p/C.jsonl`,
      line({ type: "user", uuid: "c1", forkedFrom: { sessionId: "X", messageUuid: "x1" } }) +
        line({ type: "assistant", uuid: "c2", forkedFrom: { sessionId: "X", messageUuid: "x2" } }) +
        line({ type: "assistant", uuid: "c3" }),
    );
    expect(await messageIdIn("x2", "C", shared)).toBe("c2");
    expect(await messageIdIn("c3", "C", shared)).toBe("c3");
    expect(await messageIdIn("zz", "C", shared)).toBeUndefined();
  });
});
