/**
 * Which account a T3 thread's query opens on and how its ids change when it moves (only when that costs
 * nothing, or it can't stay). Port of headroom's `ThreadLauncher.decide`/`parseTail`, `ThreadReaper.limit`,
 * `ThreadRelay.Machine` and `SessionTransfer.withoutTrailingNotices`, on the SDK's options. No I/O.
 */
import { type Candidate, pickForThread } from "./accounts.ts";
import { TERMINAL_KEY } from "./accountsConfig.ts";

/** The SDK options that name the conversation (`ClaudeAgentSdkQueryOptions`' identity). */
export interface ThreadIdentity {
  readonly sessionId?: string | undefined;
  readonly resume?: string | undefined;
  readonly resumeSessionAt?: string | undefined;
  readonly forkSession?: boolean | undefined;
}

/** What the current conversation's transcript says about its end. */
export interface Transcript {
  /** When it last answered (epoch ms); undefined when it never did, or there is no transcript. */
  readonly lastAssistantAt: number | undefined;
  /** A compaction followed that answer. */
  readonly justCompacted: boolean;
  /**
   * The newest user line (a prompt, or a tool result on its way to the next request): a request that
   * refreshes the cache follows it, so a recent one keeps the thread warm. Doubt leans warm.
   */
  readonly lastUserAt?: number | undefined;
}

/** No transcript to read: the conversation is old or unknown, so moving costs nothing. */
export const COLD: Transcript = { lastAssistantAt: undefined, justCompacted: false };

/** The newest sign the cache was touched. */
export function lastActivityAt(t: Transcript): number | undefined {
  const times = [t.lastAssistantAt, t.lastUserAt].filter((x): x is number => x !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
}

/** How long after its last answer a conversation is still worth keeping on its account (cache: 1 h). */
export const WARM_AFTER_MS = 55 * 60_000;

/** The ledger reads the decision needs. */
export interface LedgerView {
  /** The conversation a T3 thread continues in now: its own id until it first moved. */
  readonly currentSession: (thread: string) => string;
  /** The account a conversation was recorded on. */
  readonly account: (session: string) => string | undefined;
  /** Whether Claude Code wrote the conversation's transcript (a failed fork leaves none). */
  readonly transcriptExists?: (session: string) => boolean;
}

/** The conversation the thread continues in: the ledger's current one if it exists, else its own id. */
export function resolvedSession(ledger: LedgerView, thread: string): string {
  const current = ledger.currentSession(thread);
  return current === thread || (ledger.transcriptExists?.(current) ?? true) ? current : thread;
}

export type ThreadAction = "stay" | "move" | "new";

/** A ledger write the caller applies after the decision (the decision itself writes nothing). */
export type LedgerWrite =
  | {
      readonly type: "record";
      readonly session: string;
      readonly account: string;
      readonly forkedAt?: number | undefined;
      readonly from?: string | undefined;
    }
  | { readonly type: "current"; readonly session: string; readonly thread: string };

export interface ThreadDecision {
  /** The identity the query opens with: T3's own but for the resume and session ids. */
  readonly identity: ThreadIdentity;
  /** The account the query runs on. */
  readonly account: string;
  readonly action: ThreadAction;
  /** Why it stayed or moved, for the log. */
  readonly reason: string;
  readonly writes: ReadonlyArray<LedgerWrite>;
  /** The session the query runs (a move's new id, a resume's current conversation), "" when unknown. */
  readonly session: string;
  /** It left an account that was full, removed or signed out: the user is told, never silently. */
  readonly forced: boolean;
  /** Why it had to leave, for a forced move: the notice says exactly this. */
  readonly forcedBy?: "full" | "gone" | undefined;
  /** The account it left, for a move. */
  readonly from?: string | undefined;
}

export interface DecideInput {
  readonly ledger: LedgerView;
  readonly candidates: ReadonlyArray<Candidate>;
  readonly transcript: Transcript;
  readonly now: number;
  /** A recent "limit reached" answer (Swift's `AgentRegistry.isFull`). */
  readonly isFull?: (account: string) => boolean;
  /**
   * Its passing errors outlasted every retry a moment ago. Not gone: a warm thread stays there (and shows the
   * error); it is only never a destination.
   */
  readonly troubled?: (account: string) => boolean;
  readonly newSessionId: () => string;
  /**
   * Where new work goes: `pickForThread` for a main thread; a delegated child passes `pick` with its
   * ceiling (subagents' rule: the smallest plan with room).
   */
  readonly choose?: (candidates: ReadonlyArray<Candidate>) => Candidate | undefined;
}

/** At a limit by a reading (100% of a window) or by a recent "limit reached" answer. */
export function isKnownFull(c: Candidate, isFull: (account: string) => boolean): boolean {
  return (c.sessionUsed ?? 0) >= 100 || (c.weeklyUsed ?? 0) >= 100 || isFull(c.id);
}

/** The account a thread opens on, and the identity and ledger writes that follow. Reads nothing. */
export function decideThread(open: ThreadIdentity, input: DecideInput): ThreadDecision {
  const { ledger, candidates, transcript, now } = input;
  const isFull = input.isFull ?? (() => false);
  const troubled = input.troubled ?? (() => false);
  const pickFrom = input.choose ?? pickForThread;
  // Troubled accounts are never where work goes, unless nothing else is left.
  const choose = (list: ReadonlyArray<Candidate>) =>
    pickFrom(list.filter((c) => !troubled(c.id))) ?? pickFrom(list);
  // Nothing to continue: a new thread. It starts on the roomiest account; Claude Code's own login is the
  // floor when no account can be trusted with it.
  if (open.resume === undefined) {
    const account = choose(candidates)?.id ?? TERMINAL_KEY;
    const session = open.sessionId ?? "";
    return {
      identity: open,
      account,
      action: "new",
      reason: session === "" ? "no session id" : "new thread",
      writes: session === "" ? [] : [{ type: "record", session, account }],
      session,
      forced: false,
    };
  }
  const resume = open.resume;
  const current = resolvedSession(ledger, resume);
  const onCurrent = ledger.account(current) ?? TERMINAL_KEY;
  // A fork T3 asked for brings its own new session id; only the account is chosen.
  if (open.forkSession === true) {
    const account = choose(candidates)?.id ?? onCurrent;
    const session = open.sessionId ?? current;
    return {
      identity: { ...open, resume: current },
      account,
      action: "new",
      reason: "T3 fork",
      writes:
        open.sessionId === undefined
          ? []
          : [{ type: "record", session: open.sessionId, account, forkedAt: now, from: current }],
      session,
      forced: false,
    };
  }
  const stay = (reason: string): ThreadDecision => ({
    identity: { ...open, resume: current },
    account: onCurrent,
    action: "stay",
    reason,
    writes: [],
    session: current,
    forced: false,
  });
  const activity = lastActivityAt(transcript);
  const warm = activity !== undefined && now - activity < WARM_AFTER_MS;
  const free = !warm || transcript.justCompacted;
  const candidate = candidates.find((c) => c.id === onCurrent);
  // An account that is gone (removed, signed out, waiting for a sign-in) can't answer at all: the thread
  // leaves it even when warm. Only a KNOWN limit counts as full; an unreadable account stays while warm.
  const gone = candidate === undefined;
  const full = candidate !== undefined && isKnownFull(candidate, isFull);
  // A rewind (`resumeSessionAt`) moves only when it can't stay: T3 keeps the rewound head pinned until a turn
  // completes, so a rewind at a limit would otherwise never leave. Claude Code's fork keeps message ids, so
  // the rewind's message is found in the fork under the same id.
  if (open.resumeSessionAt !== undefined && !gone && !full) return stay("resume-session-at");
  if (!free && !gone && !full)
    return stay(troubled(onCurrent) ? "warm (its API is failing)" : "warm");
  // Moving costs a full re-read: only toward known room, unless it can't stay where it is.
  const picked = choose(candidates.filter((c) => !(full && c.id === onCurrent)));
  const known =
    picked !== undefined && picked.sessionUsed !== undefined && picked.weeklyUsed !== undefined;
  const destination =
    (known || gone || full ? picked?.id : undefined) ?? (gone ? TERMINAL_KEY : onCurrent);
  if (destination === onCurrent) {
    return stay(full ? "full, no other account has room" : "already the roomiest");
  }
  // Fork it onto the other account as a new session: each account only ever sees its own ids. T3 never
  // learns the new id; the ledger maps the thread to it.
  const moved = input.newSessionId();
  const { sessionId: _dropped, ...rest } = open;
  return {
    identity: { ...rest, resume: current, forkSession: true, sessionId: moved },
    account: destination,
    action: "move",
    reason: gone
      ? `${onCurrent} is gone (removed or signed out)`
      : full
        ? `${onCurrent} full`
        : `cold, ${destination} has more room`,
    writes: [
      { type: "record", session: moved, account: destination, forkedAt: now, from: current },
      { type: "current", session: moved, thread: resume },
    ],
    session: moved,
    forced: gone || full,
    ...(gone ? { forcedBy: "gone" as const } : full ? { forcedBy: "full" as const } : {}),
    from: onCurrent,
  };
}

/**
 * The user's own sign-in or profile in the query's environment: the wrapper then leaves the choice alone
 * and runs Claude as asked. Returns the variable that decided it.
 */
export function userAuthOverride(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const set = (key: string) => (environment[key] ?? "") !== "";
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_BASE_URL",
  ]) {
    if (set(key)) return key;
  }
  for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    const v = environment[key]?.toLowerCase();
    if (v !== undefined && !["", "0", "false"].includes(v)) return key;
  }
  return undefined;
}

// MARK: The transcript

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseLine(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const stamp = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Written by Claude Code itself (a limit notice, an API error): no request answered, no cache touched. */
function isSynthetic(event: Record<string, unknown>): boolean {
  if (event["isApiErrorMessage"] === true) return true;
  const message = event["message"];
  return isRecord(message) && message["model"] === "<synthetic>";
}

/**
 * The transcript's last answer, and whether a compaction came after it. The lines after the last assistant
 * line decide: a boundary before it belongs to an earlier part of the conversation.
 */
export function parseTail(text: string): Transcript {
  let lastAssistantAt: number | undefined;
  let lastUserAt: number | undefined;
  let justCompacted = false;
  for (const line of text.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    switch (event["type"]) {
      case "assistant":
        if (isSynthetic(event)) break;
        lastAssistantAt = stamp(event["timestamp"]) ?? lastAssistantAt;
        justCompacted = false;
        break;
      case "user":
        if (event["isCompactSummary"] === true) justCompacted = true;
        lastUserAt = stamp(event["timestamp"]) ?? lastUserAt;
        break;
      case "system":
        if (event["subtype"] === "compact_boundary") justCompacted = true;
        break;
    }
  }
  return { lastAssistantAt, justCompacted, lastUserAt };
}

/**
 * The transcript without the notices Claude Code wrote after the account's last answer ("You've hit your
 * session limit"): resumed elsewhere, the conversation carries on from its last real step.
 */
export function withoutTrailingNotices(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = parseLine(lines[i]!);
    if (!event || (event["type"] !== "user" && event["type"] !== "assistant")) continue; // metadata stays
    if (!isSynthetic(event)) break;
    lines.splice(i, 1);
  }
  return lines.join("\n");
}

/**
 * One transcript's message ids, for translating an id across a fork: `own` are its lines' uuids, `copies`
 * maps each id a line was copied from (`forkedFrom.messageUuid`) to the line's own uuid, and `parent` is the
 * session it was forked from. Claude Code gives every copied message a new uuid when it forks.
 */
export interface TranscriptIds {
  readonly own: ReadonlySet<string>;
  readonly copies: ReadonlyMap<string, string>;
  readonly parent: string | undefined;
}

export function transcriptIds(text: string): TranscriptIds {
  const own = new Set<string>();
  const copies = new Map<string, string>();
  let parent: string | undefined;
  for (const line of text.split("\n")) {
    const event = parseLine(line);
    if (!event || typeof event["uuid"] !== "string") continue;
    own.add(event["uuid"]);
    const from = event["forkedFrom"];
    if (isRecord(from) && typeof from["messageUuid"] === "string") {
      copies.set(from["messageUuid"], event["uuid"]);
      if (typeof from["sessionId"] === "string") parent ??= from["sessionId"];
    }
  }
  return { own, copies, parent };
}

/**
 * The id `uuid` (a message of `session` or of any conversation it was forked from) has in `session`;
 * undefined when the lineage doesn't hold it. `ids` reads a session's transcript ids (undefined when gone).
 */
export function translateMessageId(
  uuid: string,
  session: string,
  ids: (session: string) => TranscriptIds | undefined,
  depth = 0,
): string | undefined {
  const mine = ids(session);
  if (!mine) return undefined;
  if (mine.own.has(uuid)) return uuid;
  const copied = mine.copies.get(uuid);
  if (copied !== undefined) return copied;
  if (mine.parent === undefined || mine.parent === session || depth > 16) return undefined;
  const inParent = translateMessageId(uuid, mine.parent, ids, depth + 1);
  return inParent === undefined ? undefined : mine.copies.get(inParent);
}

// MARK: Limits in the result

export type LimitKind = "none" | "account" | "model";

/**
 * What a limit message is about: the whole account (session, weekly, usage), or one model ("You've hit your
 * Opus limit"), which says nothing about the account's room for the others. Not a passing 429, which
 * Claude Code retries itself. Port of `ThreadReaper.limit`.
 */
export function limitKind(text: string): LimitKind {
  if (
    !/hit your .*limit|usage limit|limit reached|(session|weekly|opus|sonnet|haiku|fable) limit/iu.test(
      text,
    )
  )
    return "none";
  const wholeAccount = /session limit|usage limit|weekly limit/iu.test(text);
  const aModel = /opus|sonnet|haiku|fable/iu.test(text);
  return aModel && !wholeAccount ? "model" : "account";
}

// MARK: Retrying a passing error (ThreadRelay.Machine)

export type RelayAction =
  | { readonly type: "forward" }
  /** Keep the result from T3; after `afterMs` call `fire(generation)`. */
  | { readonly type: "hold"; readonly afterMs: number; readonly generation: number }
  /** The retries are spent: forward the result, and hand the thread on. */
  | { readonly type: "giveUp" };

/**
 * The relay's decisions without any I/O: a `result` that ends a turn at a passing error is held back from T3,
 * and after a wait the same query is told to continue; T3 sees one longer turn. A message or a stop from T3
 * meanwhile lets the held result through first. Port of headroom's `ThreadRelay.Machine`.
 */
export class RetryMachine<Line> {
  private heldLine: Line | undefined;
  private failureCount = 0;
  private gen = 0;
  private readonly delayMs: (failures: number, random: number) => number | undefined;
  constructor(delayMs: (failures: number, random: number) => number | undefined) {
    this.delayMs = delayMs;
  }

  get held(): Line | undefined {
    return this.heldLine;
  }
  get failures(): number {
    return this.failureCount;
  }
  get generation(): number {
    return this.gen;
  }

  /** A message from Claude Code: whether it is a turn's result, and why its error passes, when it does. */
  fromChild(isResult: boolean, transient: string | undefined, line: Line, random = 0): RelayAction {
    if (!isResult) return { type: "forward" };
    if (transient === undefined) {
      this.failureCount = 0;
      return { type: "forward" };
    }
    const wait = this.delayMs(this.failureCount, random);
    if (wait === undefined) {
      this.failureCount = 0;
      return { type: "giveUp" };
    }
    this.failureCount += 1;
    this.gen += 1;
    this.heldLine = line;
    return { type: "hold", afterMs: wait, generation: this.gen };
  }

  /** T3 sent a message or a stop: a held result goes first, returned here to emit ahead of it. */
  fromParent(endsWait: boolean): Line | undefined {
    if (!endsWait || this.heldLine === undefined) return undefined;
    const line = this.heldLine;
    this.heldLine = undefined;
    this.failureCount = 0;
    this.gen += 1;
    return line;
  }

  /** A wait ended: true when its retry still stands. The held result is dropped: the retry brings its own. */
  fire(generation: number): boolean {
    if (generation !== this.gen || this.heldLine === undefined) return false;
    this.heldLine = undefined;
    return true;
  }

  /** The query ended: a held result goes to T3 so the turn ends. */
  release(): Line | undefined {
    const line = this.heldLine;
    this.heldLine = undefined;
    this.gen += 1;
    return line;
  }
}

/** The message a query is told to continue with after a passing error (headroom's `retryPrompt`). */
export const RETRY_PROMPT =
  "The previous request failed with a temporary API error. Continue the task from where you left off and finish it.";

// MARK: What the user is told

/** The notice a thread shows when it had to leave its account, or its account ran out mid-run. */
export function moveNotice(input: {
  readonly from: string;
  readonly to: string | undefined;
  readonly why: "full" | "gone" | "limit";
}): string {
  const where = input.to === undefined ? undefined : accountLabel(input.to);
  // Claude Code's own login is only left once a fork account is signed in: it isn't gone, the fork stopped using it.
  if (input.from === TERMINAL_KEY && input.why !== "limit") {
    return `lastdrop: this thread ran on Claude Code's own login and continues on ${where ?? "another account"}. The conversation carries over.`;
  }
  const from = accountLabel(input.from);
  switch (input.why) {
    case "limit":
      return where === undefined
        ? `lastdrop: ${from} reached its usage limit, and no other account has room right now. Send the message again once a limit resets.`
        : `lastdrop: ${from} reached its usage limit. This thread continues on ${where}; the conversation carries over.`;
    case "full":
      return `lastdrop: ${from} is at its usage limit, so this thread continues on ${where ?? "another account"}. The conversation carries over; its prompt cache is read again once.`;
    case "gone":
      return `lastdrop: ${from} is no longer signed in, so this thread continues on ${where ?? "another account"}. The conversation carries over.`;
  }
}

const accountLabel = (key: string) =>
  key === TERMINAL_KEY ? "Claude Code's own login" : `Claude account ${key}`;
