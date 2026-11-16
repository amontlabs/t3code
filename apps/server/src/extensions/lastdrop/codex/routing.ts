/**
 * The routing over lastdrop's files: the account list, each home's sign-in, the readings and the thread records
 * (`@t3tools/lastdrop-node`'s `CodexAccountFiles`), with T3's own reading of Codex's rate limits.
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  chooseCodexAccount,
  type CodexAccountFiles,
  type CodexRoom,
  type CodexUsageRecord,
  recordedCodexAccount,
} from "@t3tools/lastdrop-node";
import * as DateTime from "effect/DateTime";

import {
  codexRateLimitsToLimits,
  codexUsageLimitResetAt,
  mergeCodexRateLimits,
} from "../../../provider/codexUsageLimits.ts";
import type { CodexRouting } from "./factory.ts";

/** A reading older than this says nothing about the account's room now. */
const CODEX_READING_VALID_MS = 2 * 60 * 60_000;
/** How long an account counts as full when Codex says it hit a limit without saying until when. */
const FULL_WITHOUT_RESET_MS = 60 * 60_000;

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** T3's limit windows for a reading (Codex's main allowance), or undefined without one. */
export function codexLimits(
  record: CodexUsageRecord | undefined,
): ServerProviderUsageLimits | undefined {
  if (record?.limits === undefined) return undefined;
  return codexRateLimitsToLimits({ snapshot: record.limits, checkedAt: isoOf(record.readAt) });
}

/** What picking knows of an account's room from its reading: unknown without a recent one. */
export function codexRoom(
  key: string,
  signedIn: boolean,
  record: CodexUsageRecord | undefined,
  now: number,
): CodexRoom {
  const limits = codexLimits(record);
  if (
    record === undefined ||
    limits === undefined ||
    now - record.readAt > CODEX_READING_VALID_MS
  ) {
    return { key, signedIn };
  }
  const used = (kinds: ReadonlyArray<string>) =>
    Math.max(
      0,
      ...limits.windows
        .filter((w) => kinds.includes(w.kind))
        // A window whose reset has passed is unused again.
        .map((w) =>
          w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now ? 0 : w.usedPercent,
        ),
    );
  const reached = record.limits?.rateLimitReachedType;
  const resetAt = codexUsageLimitResetAt(record.limits);
  const fullUntil =
    reached === undefined || reached === null
      ? undefined
      : resetAt === null
        ? record.readAt + FULL_WITHOUT_RESET_MS
        : Date.parse(resetAt);
  return {
    key,
    signedIn,
    sessionUsed: used(["session"]),
    weeklyUsed: used(["weekly", "monthly"]),
    ...(fullUntil === undefined ? {} : { fullUntil }),
  };
}

/** Every account's room, in the list's order. */
async function codexRooms(files: CodexAccountFiles, now: number): Promise<CodexRoom[]> {
  const [list, usage] = await Promise.all([files.list(), files.usage()]);
  return Promise.all(
    list.accounts.map(async (account) =>
      codexRoom(account.key, await files.signedIn(account.key), usage[account.key], now),
    ),
  );
}

export function makeCodexRouting(options: {
  readonly files: CodexAccountFiles;
  readonly now: () => number;
  readonly log: (line: string) => void;
}): CodexRouting {
  const { files, now, log } = options;
  return {
    route: async (threadId) => {
      const at = now();
      const [rooms, threads] = await Promise.all([codexRooms(files, at), files.threads()]);
      const choice = chooseCodexAccount({
        rooms,
        recorded: recordedCodexAccount(threads, threadId),
        now: at,
      });
      if (choice === undefined) return undefined;
      log(`codex: thread ${threadId} opens on ${choice.key} (${choice.why})`);
      return { account: choice.key, home: files.home(choice.key) };
    },
    recordThread: (account, threadId, nativeThreadId) =>
      files.recordThread(nativeThreadId, { account, threadId, at: now() }),
    observeLimits: (account, snapshot) =>
      files.updateUsage(account, (current) => {
        const limits = mergeCodexRateLimits(current?.limits, snapshot);
        if (limits === undefined) return current;
        const { error: _, ...rest } = current ?? { readAt: now() };
        return { ...rest, readAt: now(), limits };
      }),
    log,
  };
}
