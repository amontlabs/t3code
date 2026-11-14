// Ported from headroom Tests/LastDropTests/ThreadLauncherTests.swift (the decision, the transcript tail and
// the launching rules), plus the relay machine, limit notices and message-id translation (see PORTING.md).
import { describe, expect, it } from "vite-plus/test";

import { type Candidate, pick } from "./accounts.ts";
import {
  COLD,
  decideThread,
  type LedgerView,
  lastActivityAt,
  limitKind,
  parseTail,
  RetryMachine,
  resolvedSession,
  type ThreadIdentity,
  type Transcript,
  transcriptIds,
  translateMessageId,
  userAuthOverride,
  withoutTrailingNotices,
} from "./threadRouting.ts";
import { retryDelayMs, standardRetryPolicy } from "./transientError.ts";

const now = 1_800_000_000_000;

const candidate = (
  id: string,
  session: number | undefined,
  weekly: number | undefined,
): Candidate => ({
  id,
  name: id,
  sessionUsed: session,
  weeklyUsed: weekly,
});

const ledger = (
  threads: Record<string, string> = {},
  sessions: Record<string, string> = {},
): LedgerView => ({
  currentSession: (t) => threads[t] ?? t,
  account: (s) => sessions[s],
});

/** The thread answered `ageMs` ago; `compacted` puts a boundary after that answer. */
const transcript = (ageMs: number | undefined, compacted = false): Transcript => ({
  lastAssistantAt: ageMs === undefined ? undefined : now - ageMs,
  justCompacted: compacted,
});

const MIN = 60_000;
const HOUR = 60 * MIN;

const decide = (
  open: ThreadIdentity,
  input: {
    threads?: Record<string, string>;
    sessions?: Record<string, string>;
    candidates: ReadonlyArray<Candidate>;
    transcript: Transcript;
    newSessionId?: string;
    view?: LedgerView;
    isFull?: (a: string) => boolean;
  },
) =>
  decideThread(open, {
    ledger: input.view ?? ledger(input.threads, input.sessions),
    candidates: input.candidates,
    transcript: input.transcript,
    now,
    newSessionId: () => input.newSessionId ?? "moved-1",
    ...(input.isFull ? { isFull: input.isFull } : {}),
  });

describe("new threads", () => {
  it("a new thread starts on the roomiest account and records it", () => {
    const d = decide(
      { sessionId: "X" },
      { candidates: [candidate("main", 50, 50), candidate("Pro", 10, 10)], transcript: COLD },
    );
    expect(d.account).toBe("Pro");
    expect(d.action).toBe("new");
    expect(d.identity).toEqual({ sessionId: "X" });
    expect(d.writes).toEqual([{ type: "record", session: "X", account: "Pro" }]);
    expect(d.session).toBe("X");
  });

  it("a new thread without an id changes nothing in the ledger", () => {
    const d = decide({}, { candidates: [candidate("main", 10, 10)], transcript: COLD });
    expect(d.account).toBe("main");
    expect(d.writes).toEqual([]);
  });

  it("a delegated child picks with the subagents' rule", () => {
    // pick: the smallest plan with room under the ceiling; pickForThread would take the roomiest (B).
    const candidates: Candidate[] = [
      { ...candidate("A", 10, 10), size: { session: 1, weekly: 1 } },
      { ...candidate("B", 0, 0), size: { session: 20, weekly: 10 } },
    ];
    const d = decideThread(
      { sessionId: "child" },
      {
        ledger: ledger(),
        candidates,
        transcript: COLD,
        now,
        newSessionId: () => "n",
        choose: (list) => pick(list, { sessionThreshold: 0.9, weeklyThreshold: 0.9 }),
      },
    );
    expect(d.account).toBe("A");
    expect(decide({ sessionId: "main-thread" }, { candidates, transcript: COLD }).account).toBe(
      "B",
    );
  });
});

describe("staying warm", () => {
  it("a warm thread stays", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: transcript(10 * MIN),
      },
    );
    expect(d.account).toBe("A");
    expect(d.action).toBe("stay");
    expect(d.identity).toEqual({ resume: "X" });
    expect(d.writes).toEqual([]);
  });
});

describe("moving when it costs nothing", () => {
  it("a cold thread never forks onto an account nothing is known about", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "work" },
        candidates: [
          candidate("main", undefined, undefined),
          candidate("work", undefined, undefined),
        ],
        transcript: COLD,
      },
    );
    expect(d.account).toBe("work");
    expect(d.action).toBe("stay");
    // But a thread whose account is known full goes to the unknown one rather than failing.
    const full = decide(
      { resume: "X" },
      {
        sessions: { X: "work" },
        candidates: [candidate("main", undefined, undefined), candidate("work", 100, 50)],
        transcript: COLD,
      },
    );
    expect(full.account).toBe("main");
  });

  it("a cold thread moves to the roomiest account", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: transcript(2 * HOUR),
      },
    );
    expect(d.account).toBe("B");
    expect(d.action).toBe("move");
    expect(d.identity).toEqual({ resume: "X", forkSession: true, sessionId: "moved-1" });
    expect(d.writes).toEqual([
      { type: "record", session: "moved-1", account: "B", forkedAt: now, from: "X" },
      { type: "current", session: "moved-1", thread: "X" },
    ]);
    expect(d.session).toBe("moved-1");
    expect(d.forced).toBe(false);
  });

  it("a just-compacted thread moves even though it is warm", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: transcript(10 * MIN, true),
      },
    );
    expect(d.action).toBe("move");
    expect(d.account).toBe("B");
  });

  it("a full account moves even when the thread is warm, and says so", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 100, 100), candidate("B", 10, 10)],
        transcript: transcript(10 * MIN),
      },
    );
    expect(d.action).toBe("move");
    expect(d.account).toBe("B");
    expect(d.forced).toBe(true);
    expect(d.from).toBe("A");
  });

  it("a full account with no other room stays", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 100, 100), candidate("B", 100, 100)],
        transcript: transcript(2 * HOUR),
      },
    );
    expect(d.action).toBe("stay");
    expect(d.account).toBe("A");
  });

  it("an unreadable account does not end a warm stay", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", undefined, undefined), candidate("B", 10, 10)],
        transcript: transcript(10 * MIN),
      },
    );
    expect(d.action).toBe("stay");
    expect(d.account).toBe("A");
  });

  it("an unreadable account is never a destination", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 10, 10), candidate("B", undefined, undefined)],
        transcript: transcript(2 * HOUR),
      },
    );
    expect(d.account).toBe("A");
  });

  it("a recent limit-reached answer counts as full", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: transcript(MIN),
        isFull: (a) => a === "A",
      },
    );
    expect(d.action).toBe("move");
    expect(d.account).toBe("B");
  });
});

describe("an account that is gone", () => {
  it("a warm thread leaves an account that is no longer signed in", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "Gone" },
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: transcript(MIN),
      },
    );
    expect(d.action).toBe("move");
    expect(d.account).toBe("B");
    expect(d.reason).toContain("gone");
    expect(d.forced).toBe(true);
  });

  it("a thread on a gone account falls back to main when nobody has room", () => {
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "Gone" },
        candidates: [candidate("A", 100, 100)],
        transcript: transcript(MIN),
      },
    );
    expect(d.action).toBe("move");
    expect(d.account).toBe("main");
  });
});

describe("a conversation that was never written", () => {
  it("a missing current conversation falls back to the thread's own id", () => {
    // The fork to "C" failed before Claude Code wrote C.jsonl: the thread resumes X again.
    const view: LedgerView = {
      currentSession: (t) => (t === "X" ? "C" : t),
      account: (s) => ({ C: "B", X: "A" })[s],
      transcriptExists: (s) => s !== "C",
    };
    const d = decide(
      { resume: "X" },
      {
        view,
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: transcript(10 * MIN),
      },
    );
    expect(d.identity).toEqual({ resume: "X" });
    expect(d.account).toBe("A");
    expect(d.session).toBe("X");
    const present: LedgerView = {
      currentSession: () => "C",
      account: () => "B",
      transcriptExists: () => true,
    };
    expect(resolvedSession(present, "X")).toBe("C");
  });

  it("resume-session-at never moves", () => {
    const d = decide(
      { resume: "X", resumeSessionAt: "msg-1" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: transcript(2 * HOUR),
      },
    );
    expect(d.action).toBe("stay");
    expect(d.account).toBe("A");
    expect(d.identity).toEqual({ resume: "X", resumeSessionAt: "msg-1" });
  });
});

describe("T3's own fork", () => {
  it("a T3 fork picks a fresh account and records its session", () => {
    const open = { resume: "X", forkSession: true, sessionId: "M" };
    const d = decide(open, {
      sessions: { X: "A" },
      candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
      transcript: transcript(10 * MIN),
    });
    expect(d.action).toBe("new");
    expect(d.account).toBe("B");
    expect(d.identity).toEqual(open);
    expect(d.writes).toEqual([
      { type: "record", session: "M", account: "B", forkedAt: now, from: "X" },
    ]);
    expect(d.session).toBe("M");
  });
});

describe("threads that moved before", () => {
  it("a thread that already moved resumes its current conversation", () => {
    const d = decide(
      { resume: "X" },
      {
        threads: { X: "C" },
        sessions: { C: "B" },
        candidates: [candidate("B", 10, 10), candidate("main", 0, 0)],
        transcript: transcript(10 * MIN),
      },
    );
    expect(d.action).toBe("stay");
    expect(d.identity).toEqual({ resume: "C" });
    expect(d.account).toBe("B");
    expect(d.session).toBe("C");
  });

  it("a moved thread moves on from its new conversation", () => {
    const d = decide(
      { resume: "X" },
      {
        threads: { X: "C" },
        sessions: { C: "A" },
        candidates: [candidate("A", 10, 10), candidate("main", 0, 0)],
        transcript: transcript(2 * HOUR),
        newSessionId: "moved-2",
      },
    );
    expect(d.identity).toEqual({ resume: "C", forkSession: true, sessionId: "moved-2" });
    expect(d.writes).toEqual([
      { type: "record", session: "moved-2", account: "main", forkedAt: now, from: "C" },
      { type: "current", session: "moved-2", thread: "X" },
    ]);
  });
});

const json = (o: unknown) => JSON.stringify(o);
// @effect-diagnostics-next-line globalDate:off - transcript timestamps are ISO strings.
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

describe("the transcript tail", () => {
  it("tail parsing reads the last answer", () => {
    const t = parseTail(
      [
        json({ type: "user", timestamp: at(-120_000) }),
        json({ type: "assistant", timestamp: at(-60_000) }),
        json({ type: "user", timestamp: at(-30_000) }),
      ].join("\n"),
    );
    expect(t.lastAssistantAt).toBe(now - 60_000);
    expect(t.justCompacted).toBe(false);
  });

  it("tail parsing sees a compact boundary after the last answer", () => {
    const t = parseTail(
      [
        json({ type: "assistant", timestamp: at(-60_000) }),
        json({ type: "system", subtype: "compact_boundary", timestamp: at(-50_000) }),
        json({ type: "user", timestamp: at(-40_000) }),
      ].join("\n"),
    );
    expect(t.justCompacted).toBe(true);
  });

  it("tail parsing sees a compact summary after the last answer", () => {
    const t = parseTail(
      [
        json({ type: "assistant", timestamp: at(-60_000) }),
        json({ type: "user", isCompactSummary: true, timestamp: at(-50_000) }),
      ].join("\n"),
    );
    expect(t.justCompacted).toBe(true);
  });

  it("a compaction before the last answer does not count", () => {
    const t = parseTail(
      [
        json({ type: "system", subtype: "compact_boundary", timestamp: at(-90_000) }),
        json({ type: "assistant", timestamp: at(-60_000) }),
        json({ type: "user", timestamp: at(-30_000) }),
      ].join("\n"),
    );
    expect(t.justCompacted).toBe(false);
    expect(t.lastAssistantAt).toBe(now - 60_000);
  });

  it("gaps and broken lines in the tail are skipped", () => {
    const t = parseTail(
      ["not json at all", "", json({ type: "assistant", timestamp: at(-60_000) })].join("\n"),
    );
    expect(t.lastAssistantAt).toBe(now - 60_000);
    expect(parseTail("").lastAssistantAt).toBeUndefined();
  });

  it("synthetic answers do not count as warm", () => {
    const t = parseTail(
      [
        json({ type: "assistant", timestamp: at(-7_200_000) }),
        json({ type: "assistant", isApiErrorMessage: true, timestamp: at(-60_000) }),
        json({ type: "assistant", message: { model: "<synthetic>" }, timestamp: at(-30_000) }),
      ].join("\n"),
    );
    expect(t.lastAssistantAt).toBe(now - 7_200_000);
  });

  it("a user line after the last answer keeps the thread warm", () => {
    const t = parseTail(
      [
        json({ type: "assistant", timestamp: at(-7_200_000) }),
        json({ type: "user", timestamp: at(-60_000) }),
      ].join("\n"),
    );
    expect(lastActivityAt(t)).toBe(now - 60_000);
    const d = decide(
      { resume: "X" },
      {
        sessions: { X: "A" },
        candidates: [candidate("A", 10, 10), candidate("B", 0, 0)],
        transcript: t,
      },
    );
    expect(d.action).toBe("stay");
  });
});

describe("launching rules", () => {
  it("the user's own auth or profile is left alone", () => {
    expect(userAuthOverride({ PATH: "/bin", ANTHROPIC_API_KEY: "" })).toBeUndefined();
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ]) {
      expect(userAuthOverride({ [key]: "1" })).toBe(key);
    }
    expect(userAuthOverride({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBeUndefined();
  });
});

describe("moving a transcript", () => {
  // headroom testTransferDropsTheTrailingLimitNoticeOnly
  it("the transfer drops the trailing limit notice only", () => {
    const answer = json({ type: "assistant", uuid: "a1", message: { model: "claude-opus-5-5" } });
    const notice = json({
      type: "assistant",
      uuid: "n1",
      isApiErrorMessage: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your limit" }] },
    });
    const meta = json({ type: "summary", summary: "x" });
    expect(withoutTrailingNotices([answer, notice, meta].join("\n"))).toBe(
      [answer, meta].join("\n"),
    );
    expect(withoutTrailingNotices([notice, answer].join("\n"))).toBe([notice, answer].join("\n"));
  });
});

describe("limit notices", () => {
  // headroom testIsLimitNoticeCases
  it("a limit is the account's or one model's", () => {
    expect(limitKind("You've hit your session limit · resets 5pm")).toBe("account");
    expect(limitKind("Claude AI usage limit reached|1760000000")).toBe("account");
    expect(limitKind("You've hit your weekly limit")).toBe("account");
    expect(limitKind("You've hit your Opus limit")).toBe("model");
    expect(limitKind("API Error: 429 rate_limit_error, please retry")).toBe("none");
    expect(limitKind("Done.")).toBe("none");
  });
});

describe("message ids across a fork", () => {
  const line = (uuid: string, from?: { sessionId: string; messageUuid: string }) =>
    json({ type: "assistant", uuid, ...(from ? { forkedFrom: from } : {}) });
  const files: Record<string, string> = {
    X: [line("x1"), line("x2")].join("\n"),
    C: [
      line("c1", { sessionId: "X", messageUuid: "x1" }),
      line("c2", { sessionId: "X", messageUuid: "x2" }),
      line("c3"),
    ].join("\n"),
    D: [
      line("d1", { sessionId: "C", messageUuid: "c1" }),
      line("d2", { sessionId: "C", messageUuid: "c2" }),
      line("d3", { sessionId: "C", messageUuid: "c3" }),
    ].join("\n"),
  };
  const ids = (s: string) => (files[s] === undefined ? undefined : transcriptIds(files[s]!));

  it("an id from before a move is found under its copy's id", () => {
    expect(translateMessageId("x2", "C", ids)).toBe("c2");
    expect(translateMessageId("c3", "C", ids)).toBe("c3");
    // Two moves: X → C → D.
    expect(translateMessageId("x1", "D", ids)).toBe("d1");
    expect(translateMessageId("c3", "D", ids)).toBe("d3");
    expect(translateMessageId("nope", "D", ids)).toBeUndefined();
    expect(translateMessageId("x1", "missing", ids)).toBeUndefined();
  });
});

describe("retrying a passing error (the relay)", () => {
  const machine = () =>
    new RetryMachine<string>((failures, random) =>
      retryDelayMs(standardRetryPolicy, failures, random),
    );

  // headroom testTheRelayHoldsAPassingErrorRetries…
  it("holds a passing error's result and retries, four times, then gives up", () => {
    const m = machine();
    expect(m.fromChild(false, undefined, "text")).toEqual({ type: "forward" });
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const action = m.fromChild(true, "API server error", `result-${i}`);
      expect(action.type).toBe("hold");
      if (action.type !== "hold") return;
      waits.push(action.afterMs);
      expect(m.held).toBe(`result-${i}`);
      expect(m.fire(action.generation)).toBe(true);
      expect(m.held).toBeUndefined();
    }
    expect(waits).toEqual([10_000, 30_000, 90_000, 180_000]);
    expect(m.fromChild(true, "API server error", "last")).toEqual({ type: "giveUp" });
    // A good result starts the count again.
    expect(m.fromChild(true, undefined, "ok")).toEqual({ type: "forward" });
    expect(m.failures).toBe(0);
  });

  // headroom testT3SpeakingDuringAWaitLetsTheHeldResultThroughAndCancelsTheRetry
  it("T3 speaking during a wait lets the held result through and cancels the retry", () => {
    const m = machine();
    const action = m.fromChild(true, "network error", "held");
    if (action.type !== "hold") throw new Error("expected a hold");
    expect(m.fromParent(false)).toBeUndefined();
    expect(m.fromParent(true)).toBe("held");
    expect(m.fire(action.generation)).toBe(false);
    expect(m.failures).toBe(0);
  });

  it("the query ending lets a held result through", () => {
    const m = machine();
    m.fromChild(true, "network error", "held");
    expect(m.release()).toBe("held");
    expect(m.release()).toBeUndefined();
  });
});
