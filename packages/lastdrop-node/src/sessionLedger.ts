/**
 * Which account each conversation ran on, the conversation each T3 native session continues in now (the
 * old → new id map) and each app thread's account: `~/.t3/lastdrop/sessions.json`, one writer, changes
 * serialized and atomic, times in ms. Port of headroom's `SessionLedger`.
 */
import * as NodeFSP from "node:fs/promises";

import { readText, writeAtomic } from "./files.ts";

export interface LedgerSession {
  /** "main", or an account's folder name. */
  readonly account: string;
  readonly startedAt: number;
  /** A conversation forked from another (a move): its lines from before this were copied. */
  readonly forkedAt?: number | undefined;
  /** The conversation it was forked from. */
  readonly from?: string | undefined;
}

/** A T3 thread's native session, keyed by the id T3 knows it by (T3 never learns of a move's new id). */
export interface LedgerThread {
  /** The conversation it continues in now: T3's own id until it first moves. */
  readonly current: string;
  readonly at: number;
}

/** A T3 app thread (its `ThreadId`), for its children: the account its last query opened on. */
export interface LedgerAppThread {
  readonly account: string;
  readonly at: number;
}

export interface LedgerStore {
  sessions: Record<string, LedgerSession>;
  threads: Record<string, LedgerThread>;
  appThreads: Record<string, LedgerAppThread>;
}

/** The most sessions kept, and the age under which none is ever dropped. */
export const MAX_SESSIONS = 20_000;
export const KEEP_NEWER_THAN_MS = 30 * 86_400_000;
const MAX_THREADS = 2000;
const KEEP_THREADS = 1500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function decodeLedger(text: string): LedgerStore {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root)) throw new Error("the ledger is not an object");
  const table = <T>(key: string, decode: (v: Record<string, unknown>) => T | undefined) => {
    const out: Record<string, T> = {};
    const raw = root[key];
    if (!isRecord(raw)) return out;
    for (const [id, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      const decoded = decode(value);
      if (decoded !== undefined) out[id] = decoded;
    }
    return out;
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  return {
    sessions: table("sessions", (v) => {
      const account = str(v["account"]);
      const startedAt = num(v["startedAt"]);
      if (account === undefined || startedAt === undefined) return undefined;
      const forkedAt = num(v["forkedAt"]);
      const from = str(v["from"]);
      return {
        account,
        startedAt,
        ...(forkedAt === undefined ? {} : { forkedAt }),
        ...(from === undefined ? {} : { from }),
      };
    }),
    threads: table("threads", (v) => {
      const current = str(v["current"]);
      const at = num(v["at"]);
      return current === undefined || at === undefined ? undefined : { current, at };
    }),
    appThreads: table("appThreads", (v) => {
      const account = str(v["account"]);
      const at = num(v["at"]);
      return account === undefined || at === undefined ? undefined : { account, at };
    }),
  };
}

const emptyStore = (): LedgerStore => ({ sessions: {}, threads: {}, appThreads: {} });

/** Keeps at most `MAX_SESSIONS`, dropping the oldest first and never one newer than 30 days. */
export function pruneLedger(store: LedgerStore, now: number): void {
  const ids = Object.keys(store.sessions);
  if (ids.length > MAX_SESSIONS) {
    const cutoff = now - KEEP_NEWER_THAN_MS;
    const old = ids
      .filter((id) => store.sessions[id]!.startedAt < cutoff)
      .toSorted((a, b) => store.sessions[a]!.startedAt - store.sessions[b]!.startedAt);
    for (const id of old.slice(0, ids.length - MAX_SESSIONS)) delete store.sessions[id];
  }
  for (const key of ["threads", "appThreads"] as const) {
    const entries = Object.entries(store[key]);
    if (entries.length <= MAX_THREADS) continue;
    store[key] = Object.fromEntries(
      entries.toSorted((a, b) => b[1].at - a[1].at).slice(0, KEEP_THREADS),
    );
  }
}

export interface RecordInput {
  readonly session: string;
  readonly account: string;
  readonly forkedAt?: number | undefined;
  readonly from?: string | undefined;
  readonly at: number;
  readonly replace?: boolean;
  /**
   * Whether the conversation's transcript already has a line. A fresh (not forked) record replaces one whose
   * conversation has none yet: T3 restarts a thread nobody answered on another account.
   */
  readonly hasTranscriptLines?: () => Promise<boolean>;
}

export class SessionLedger {
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  /** The store as it is now; an unreadable file reads as empty (and is set aside at the next write). */
  async read(): Promise<LedgerStore> {
    const text = await readText(this.file);
    if (text === undefined) return emptyStore();
    try {
      return decodeLedger(text);
    } catch {
      return emptyStore();
    }
  }

  /** Read, change and write, one change at a time. A file that can't be read is kept aside, never overwritten. */
  update<T>(change: (store: LedgerStore) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const text = await readText(this.file);
      let store = emptyStore();
      if (text !== undefined) {
        try {
          store = decodeLedger(text);
        } catch {
          await NodeFSP.rename(this.file, `${this.file}.unreadable-${Date.now()}`);
        }
      }
      const before = JSON.stringify(store);
      const result = await change(store);
      const after = JSON.stringify(store);
      if (after !== before) await writeAtomic(this.file, after);
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** Notes that `session` runs on `account` (see `RecordInput` for when an existing record is replaced). */
  record(input: RecordInput): Promise<void> {
    if (input.session === "") return Promise.resolve();
    return this.update(async (store) => {
      const existing = store.sessions[input.session];
      if (existing) {
        const replace =
          input.replace === true ||
          (input.forkedAt === undefined &&
            existing.account !== input.account &&
            !((await input.hasTranscriptLines?.()) ?? true));
        if (!replace) return;
      }
      store.sessions[input.session] = {
        account: input.account,
        startedAt: input.at,
        ...(input.forkedAt === undefined ? {} : { forkedAt: input.forkedAt }),
        ...(input.from === undefined ? {} : { from: input.from }),
      };
      pruneLedger(store, input.at);
    });
  }

  setCurrent(session: string, thread: string, at: number): Promise<void> {
    return this.update((store) => {
      store.threads[thread] = { current: session, at };
      pruneLedger(store, at);
    });
  }

  setAppThreadAccount(threadId: string, account: string, at: number): Promise<void> {
    return this.update((store) => {
      if (store.appThreads[threadId]?.account === account) return;
      store.appThreads[threadId] = { account, at };
      pruneLedger(store, at);
    });
  }
}

/** The conversation T3's native session `thread` continues in now, in a store already read. */
export const currentSessionIn = (store: LedgerStore, thread: string): string =>
  store.threads[thread]?.current ?? thread;

/** Every conversation a T3 native session went through, newest first (its current one, back to its own id). */
export function lineageIn(store: LedgerStore, thread: string): ReadonlyArray<string> {
  const out: string[] = [];
  let session: string | undefined = currentSessionIn(store, thread);
  while (session !== undefined && !out.includes(session) && out.length < 64) {
    out.push(session);
    if (session === thread) break;
    session = store.sessions[session]?.from;
  }
  if (!out.includes(thread)) out.push(thread);
  return out;
}

/**
 * The account a transcript in a conversations folder counts for: the ledger's account of its session (a
 * subagent's transcript, `<session>/subagents/agent-<id>.jsonl`, counts as its session's), main when the
 * ledger doesn't know it; one in an account's own old folder (`~/.claude-accounts/<key>/projects`) is that
 * account's. Port of headroom's `UsageFiles`/`UsageLedger` attribution (SharedConversationsTests).
 */
export function transcriptAccount(
  path: string,
  store: LedgerStore,
  folders: { readonly shared: string; readonly accounts: string },
): string {
  if (path.startsWith(`${folders.accounts}/`)) {
    const key = path.slice(folders.accounts.length + 1).split("/")[0];
    if (key) return key;
  }
  const rest = path.startsWith(`${folders.shared}/`) ? path.slice(folders.shared.length + 1) : path;
  const parts = rest.split("/");
  // <project>/<session>.jsonl, or <project>/<session>/subagents/agent-<id>.jsonl
  const session = parts.length >= 3 ? parts[1] : parts[1]?.replace(/\.jsonl$/u, "");
  return (session === undefined ? undefined : store.sessions[session]?.account) ?? "main";
}

/** A forked conversation's own lines: those from before `forkedAt` were copied, and its parent counts them. */
export function linesAfterFork(text: string, forkedAt: number | undefined): ReadonlyArray<string> {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (forkedAt === undefined) return lines;
  return lines.filter((line) => {
    try {
      const at = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? "");
      return !Number.isFinite(at) || at >= forkedAt;
    } catch {
      return true;
    }
  });
}
