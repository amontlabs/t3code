/**
 * The routing over lastdrop's files: the account list, each home's sign-in, the readings and the thread records
 * (`@t3tools/lastdrop-node`'s `CodexAccountFiles`), with T3's own reading of Codex's rate limits.
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  chooseCodexAccount,
  type CodexAccountFiles,
  codexAccountFiles,
  type CodexRoom,
  type CodexUsageRecord,
  fileLogger,
  recordedCodexAccount,
} from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerConfig } from "../../../config.ts";
import {
  codexRateLimitsToLimits,
  codexUsageLimitResetAt,
  mergeCodexRateLimits,
} from "../../../provider/codexUsageLimits.ts";
import { lastdropDataDir } from "../../dataDir.ts";
import type { CodexRouting } from "./factory.ts";

const setting = (name: string) =>
  Config.String(name).pipe(Config.option, Effect.orElseSucceed(Option.none));

/**
 * The routing over this server's lastdrop files and the shared `~/.codex` it routes away from, shared by the
 * client-factory wrapper and the Codex driver wrapper. Undefined under vitest (T3's tests build both), with
 * `LASTDROP_CODEX_ROUTING=0`, or without T3's server config.
 */
export const lastdropCodexRouting: Effect.Effect<
  { readonly routing: LastdropCodexRouting; readonly sharedHome: string } | undefined
> = Effect.gen(function* () {
  const underTest = yield* setting("VITEST");
  const off = yield* setting("LASTDROP_CODEX_ROUTING");
  const config = yield* Effect.serviceOption(ServerConfig);
  if (
    underTest._tag === "Some" ||
    (off._tag === "Some" && off.value === "0") ||
    Option.isNone(config)
  ) {
    return undefined;
  }
  const dataDir = lastdropDataDir(config.value);
  const home = yield* HostProcess.HomeDirectory;
  return {
    routing: makeCodexRouting({
      files: codexAccountFiles(dataDir),
      now: Date.now,
      log: fileLogger(`${dataDir}/lastdrop.log`),
    }),
    sharedHome: `${home}/.codex`,
  };
});

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

/** Every account's room, in the list's order; `fullUntil` holds the accounts seen at a limit (epoch ms). */
async function codexRooms(
  files: CodexAccountFiles,
  now: number,
  fullUntil: ReadonlyMap<string, number>,
): Promise<CodexRoom[]> {
  const [list, usage] = await Promise.all([files.list(), files.usage()]);
  return Promise.all(
    list.accounts.map(async (account) => {
      const room = codexRoom(
        account.key,
        await files.signedIn(account.key),
        usage[account.key],
        now,
      );
      const marked = fullUntil.get(account.key);
      return marked === undefined || marked <= now || (room.fullUntil ?? 0) >= marked
        ? room
        : { ...room, fullUntil: marked };
    }),
  );
}

export interface LastdropCodexRouting extends CodexRouting {
  /** The account a new thread would open on now (the roomiest), or undefined while none is signed in. */
  readonly pick: () => Promise<{ readonly account: string; readonly home: string } | undefined>;
}

export function makeCodexRouting(options: {
  readonly files: CodexAccountFiles;
  readonly now: () => number;
  readonly log: (line: string) => void;
}): LastdropCodexRouting {
  const { files, now, log } = options;
  // A turn that ended at a limit marks its account here (the server's memory), so the reopen leaves it even
  // before Codex's own update reaches the reading.
  const fullUntil = new Map<string, number>();
  return {
    route: async (threadId) => {
      const at = now();
      const [rooms, threads] = await Promise.all([
        codexRooms(files, at, fullUntil),
        files.threads(),
      ]);
      const choice = chooseCodexAccount({
        rooms,
        recorded: recordedCodexAccount(threads, threadId),
        now: at,
      });
      if (choice === undefined) return undefined;
      log(`codex: thread ${threadId} opens on ${choice.key} (${choice.why})`);
      return { account: choice.key, home: files.home(choice.key) };
    },
    pick: async () => {
      const at = now();
      const choice = chooseCodexAccount({ rooms: await codexRooms(files, at, fullUntil), now: at });
      return choice === undefined
        ? undefined
        : { account: choice.key, home: files.home(choice.key) };
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
    atLimit: async (account) => {
      const at = now();
      const reset = codexUsageLimitResetAt((await files.usage())[account]?.limits);
      const resetMs = reset === null ? Number.NaN : Date.parse(reset);
      fullUntil.set(account, resetMs > at ? resetMs : at + FULL_WITHOUT_RESET_MS);
      const choice = chooseCodexAccount({ rooms: await codexRooms(files, at, fullUntil), now: at });
      return choice === undefined || choice.why === "allFull" || choice.key === account
        ? undefined
        : choice.key;
    },
    log,
  };
}
