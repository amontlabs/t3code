/**
 * lastdrop's Codex accounts: the fork's own list (no "main": a terminal `codex login` never changes it), which
 * account a Codex thread opens on, and the record of which account each native Codex thread ran on.
 * File I/O is `@t3tools/lastdrop-node`'s (`codexAccounts.ts`).
 */
import { type Candidate, hasRoom, pickForThread } from "./accounts.ts";
import { slug } from "./accountsConfig.ts";

export interface CodexAccount {
  /** Unique ignoring case; also the account's folder name. */
  readonly key: string;
  readonly name?: string | undefined;
  /** Epoch ms. */
  readonly addedAt: number;
}

/** The accounts in priority order. */
export interface CodexAccountList {
  readonly accounts: ReadonlyArray<CodexAccount>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The list from `codex-accounts.json`; anything unreadable is left out. */
export function parseCodexAccounts(value: unknown): CodexAccountList {
  const raw = isRecord(value) && Array.isArray(value["accounts"]) ? value["accounts"] : [];
  const seen = new Set<string>();
  const accounts: CodexAccount[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = entry["key"];
    if (typeof key !== "string" || slug(key) !== key || key === "") continue;
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    const name = entry["name"];
    const addedAt = entry["addedAt"];
    accounts.push({
      key,
      ...(typeof name === "string" && name.trim() !== "" ? { name: name.trim() } : {}),
      addedAt: typeof addedAt === "number" && Number.isFinite(addedAt) ? addedAt : 0,
    });
  }
  return { accounts };
}

export const codexAccountTitle = (account: CodexAccount): string => account.name ?? account.key;

/** Adds an account last. Undefined when the name has no usable characters or its key is taken. */
export function addCodexAccount(
  list: CodexAccountList,
  name: string,
  now: number,
): { readonly list: CodexAccountList; readonly account: CodexAccount } | undefined {
  const trimmed = name.trim();
  const key = slug(trimmed);
  if (key === "") return undefined;
  if (list.accounts.some((a) => a.key.toLowerCase() === key.toLowerCase())) return undefined;
  const account: CodexAccount = {
    key,
    ...(trimmed === key ? {} : { name: trimmed }),
    addedAt: now,
  };
  return { list: { accounts: [...list.accounts, account] }, account };
}

export function renameCodexAccount(
  list: CodexAccountList,
  key: string,
  name: string,
): CodexAccountList {
  const trimmed = name.trim();
  return {
    accounts: list.accounts.map((a) => {
      if (a.key !== key) return a;
      const { name: _, ...rest } = a;
      return trimmed === "" || trimmed === a.key ? rest : { ...rest, name: trimmed };
    }),
  };
}

/** Moves an account up (-1) or down (+1); unchanged at either end. */
export function moveCodexAccount(
  list: CodexAccountList,
  key: string,
  by: -1 | 1,
): CodexAccountList {
  const accounts = [...list.accounts];
  const i = accounts.findIndex((a) => a.key === key);
  const j = i + by;
  if (i === -1 || j < 0 || j >= accounts.length) return list;
  [accounts[i], accounts[j]] = [accounts[j]!, accounts[i]!];
  return { accounts };
}

export const removeCodexAccount = (list: CodexAccountList, key: string): CodexAccountList => ({
  accounts: list.accounts.filter((a) => a.key !== key),
});

// MARK: Picking

/** What picking knows of one account, in the list's order. */
export interface CodexRoom {
  readonly key: string;
  /** Its folder holds a sign-in (`auth.json`). */
  readonly signedIn: boolean;
  /** Percent of the 5-hour window used; undefined when unknown. */
  readonly sessionUsed?: number | undefined;
  /** Percent of the longest window (weekly, or monthly on Free) used; undefined when unknown. */
  readonly weeklyUsed?: number | undefined;
  /** Epoch ms: Codex reported a usage limit until then. */
  readonly fullUntil?: number | undefined;
}

const candidateOf = (room: CodexRoom, now: number): Candidate => {
  const marked = room.fullUntil !== undefined && room.fullUntil > now;
  return {
    id: room.key,
    name: room.key,
    sessionUsed: marked ? 100 : room.sessionUsed,
    weeklyUsed: marked ? 100 : room.weeklyUsed,
  };
};

/** At a limit: a window at 100%, or Codex said so and the reset hasn't come. Unknown usage isn't full. */
export function isCodexAccountFull(room: CodexRoom, now: number): boolean {
  const c = candidateOf(room, now);
  if (c.sessionUsed === undefined && c.weeklyUsed === undefined) return false;
  return !hasRoom({ ...c, sessionUsed: c.sessionUsed ?? 0, weeklyUsed: c.weeklyUsed ?? 0 });
}

export type CodexChoice =
  | { readonly key: string; readonly why: "recorded" | "room" | "allFull" }
  | undefined;

/**
 * The account a Codex session opens on. A thread that ran on an account stays on it while it is signed in and
 * not full; otherwise the most room across the 5-hour and weekly windows (lastdrop's thread rule). When every
 * signed-in account is full, the first in the list, so Codex shows its own limit message. Undefined when none is
 * signed in: the session then opens as T3 would open it.
 */
export function chooseCodexAccount(input: {
  readonly rooms: ReadonlyArray<CodexRoom>;
  readonly recorded?: string | undefined;
  readonly now: number;
}): CodexChoice {
  const signedIn = input.rooms.filter((room) => room.signedIn);
  if (signedIn.length === 0) return undefined;
  const recorded = signedIn.find((room) => room.key === input.recorded);
  if (recorded !== undefined && !isCodexAccountFull(recorded, input.now)) {
    return { key: recorded.key, why: "recorded" };
  }
  const picked = pickForThread(signedIn.map((room) => candidateOf(room, input.now)));
  if (picked !== undefined) return { key: picked.id, why: "room" };
  return { key: signedIn[0]!.key, why: "allFull" };
}

// MARK: Thread records

/** The account a native Codex thread ran on, and its T3 thread. */
export interface CodexThreadRecord {
  readonly account: string;
  readonly threadId: string;
  /** Epoch ms of the last time it was seen. */
  readonly at: number;
}

/** By native thread id. */
export type CodexThreadRecords = Readonly<Record<string, CodexThreadRecord>>;

/** The most records kept; the oldest go first. */
export const CODEX_THREAD_RECORDS_KEPT = 5000;

export function parseCodexThreads(value: unknown): CodexThreadRecords {
  const raw = isRecord(value) && isRecord(value["threads"]) ? value["threads"] : {};
  const records: Record<string, CodexThreadRecord> = {};
  for (const [nativeId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const { account, threadId, at } = entry;
    if (typeof account !== "string" || typeof threadId !== "string") continue;
    records[nativeId] = {
      account,
      threadId,
      at: typeof at === "number" && Number.isFinite(at) ? at : 0,
    };
  }
  return records;
}

/** Records (or refreshes) a native thread's account, keeping the newest `kept` records. */
export function recordCodexThread(
  records: CodexThreadRecords,
  nativeId: string,
  record: CodexThreadRecord,
  kept = CODEX_THREAD_RECORDS_KEPT,
): CodexThreadRecords {
  const next = { ...records, [nativeId]: record };
  const ids = Object.keys(next);
  if (ids.length <= kept) return next;
  const newest = ids.toSorted((a, b) => next[b]!.at - next[a]!.at).slice(0, kept);
  return Object.fromEntries(newest.map((id) => [id, next[id]!]));
}

/** The account a T3 thread's Codex threads last ran on. */
export function recordedCodexAccount(
  records: CodexThreadRecords,
  threadId: string,
): string | undefined {
  let newest: CodexThreadRecord | undefined;
  for (const record of Object.values(records)) {
    if (record.threadId !== threadId) continue;
    if (newest === undefined || record.at > newest.at) newest = record;
  }
  return newest?.account;
}
