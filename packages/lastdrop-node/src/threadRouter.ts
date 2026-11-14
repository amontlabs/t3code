/**
 * The I/O around lastdrop-core's `decideThread`: the account each T3 query opens on, its environment, the
 * ledger writes, and every id T3 passes back translated after a move. Full and troubled marks are this
 * server's memory. Port of headroom's `ThreadLauncher.choose`; see docs/lastdrop/claude-routing.md.
 */
import {
  type AccountStatus,
  type Candidate,
  claudeView,
  decideThread,
  type LedgerWrite,
  MAIN_KEY,
  moveNotice,
  pick,
  pickForThread,
  planSize,
  pool,
  readingFromStatus,
  type ThreadDecision,
  type ThreadIdentity,
  usedForModel,
  userAuthOverride,
} from "@t3tools/lastdrop-core";

import { runEnvironment } from "./claudeProfile.ts";
import { loadAccounts, signedInAccountOf } from "./claudeSignIn.ts";
import { claudeFolder, type LastdropPaths } from "./paths.ts";
import { currentSessionIn, lineageIn, type LedgerStore, SessionLedger } from "./sessionLedger.ts";
import {
  conversationTail,
  findTranscript,
  hasTranscriptLines,
  messageIdIn,
  transcriptInShared,
} from "./sessionTransfer.ts";

/** A recent "limit reached" answer marks the account full this long, unless a newer reading says otherwise. */
export const FULL_FOR_MS = 10 * 60_000;
/** An account whose passing errors outlasted every retry is left alone this long. */
export const TROUBLED_FOR_MS = 10 * 60_000;

export interface RouteInput {
  /** T3's app thread id. */
  readonly threadId: string;
  /** The query's identity as T3 built it (its own native ids). */
  readonly identity: ThreadIdentity;
  readonly model: string | undefined;
  /** The environment the query would run with. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A delegated child (a T3 subagent or delegated task), and its parent app thread when known. */
  readonly delegated: boolean;
  readonly parentThreadId?: string | undefined;
}

export interface Route {
  /** The identity to open with: ids translated, a move's fork and new id. */
  readonly identity: ThreadIdentity;
  /** The environment to open with: the account's sign-in folder and profile. */
  readonly env: Record<string, string>;
  /** Undefined when the wrapper left the query as it was (the user's own sign-in, or no accounts). */
  readonly decision: ThreadDecision | undefined;
  /** What the thread shows before its first answer, when it had to leave its account. */
  readonly notice?: string | undefined;
  /** Why the query runs as asked, when it does. */
  readonly untouched?: string | undefined;
}

export interface RouterOptions {
  readonly paths: LastdropPaths;
  readonly ledger: SessionLedger;
  /** The readings routing uses (the fork's `usage.json`, or the standalone app's while it runs). */
  readonly statuses: () => Promise<Record<string, AccountStatus>>;
  readonly now?: () => number;
  readonly newSessionId: () => string;
  readonly log?: (line: string) => void;
}

const sharedProjects = (p: LastdropPaths) => `${p.sharedClaude}/projects`;

export class ThreadRouter {
  private readonly fullSince = new Map<string, number>();
  private readonly troubledUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly options: RouterOptions;
  constructor(options: RouterOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** The account answered "limit reached": full until a newer reading, for at most `FULL_FOR_MS`. */
  markFull(account: string): void {
    this.fullSince.set(account, this.now());
  }

  /** The account's passing errors outlasted every retry: new work goes elsewhere for a while. */
  markTroubled(account: string): void {
    this.troubledUntil.set(account, this.now() + TROUBLED_FOR_MS);
  }

  isFull(account: string): boolean {
    const since = this.fullSince.get(account);
    return since !== undefined && this.now() - since < FULL_FOR_MS;
  }

  /** The keeper's judgement of the account's sign-in (fine unless it said otherwise). */
  async signInWorks(account: string): Promise<boolean> {
    const status = (await this.options.statuses())[account];
    return status?.signIn === undefined || status.signIn === "ok";
  }

  /** Every account a query could run on now, with its room. */
  async candidates(
    model: string | undefined,
    own?: string,
  ): Promise<{
    readonly candidates: ReadonlyArray<Candidate>;
    readonly ceiling: { readonly sessionThreshold: number; readonly weeklyThreshold: number };
  }> {
    const { paths } = this.options;
    const now = this.now();
    const config = await loadAccounts(paths, now);
    const statuses = await this.options.statuses();
    const candidates: Candidate[] = [];
    for (const account of pool(config, "claude")) {
      const key = account.key;
      // An account nobody is signed in to can't run anything.
      if ((await signedInAccountOf(paths, claudeFolder(paths, key))).uuid === undefined) continue;
      const status = statuses[key];
      const since = this.fullSince.get(key);
      const reading = readingFromStatus(
        status,
        now,
        since !== undefined && now - since < FULL_FOR_MS ? since : undefined,
      );
      // Only signing in again would let it run anything: threads on it move.
      if (!reading.usable) continue;
      // Its API kept failing through every retry a moment ago: threads there move, new ones go elsewhere.
      if ((this.troubledUntil.get(key) ?? -Infinity) > now) continue;
      candidates.push({
        id: key,
        name: account.name ?? key,
        sessionUsed: reading.session,
        weeklyUsed: reading.weekly,
        modelUsed: usedForModel(reading, model),
        size: planSize(status?.plan),
        isOwn: own !== undefined && own === key,
      });
    }
    const claude = claudeView(config);
    return {
      candidates,
      ceiling: {
        sessionThreshold: claude.sessionThreshold,
        weeklyThreshold: claude.weeklyThreshold,
      },
    };
  }

  /** Where a query opens: the account, its environment, and the ids it opens with. */
  async route(input: RouteInput): Promise<Route> {
    const { paths, ledger } = this.options;
    const now = this.now();
    const store = await ledger.read();
    const translated = this.translatedIdentity(store, input.identity);
    const override = userAuthOverride(input.env);
    if (override !== undefined) {
      return {
        identity: await translated,
        env: defined(input.env),
        decision: undefined,
        untouched: `${override} is set`,
      };
    }
    const own =
      input.parentThreadId === undefined
        ? undefined
        : store.appThreads[input.parentThreadId]?.account;
    const { candidates, ceiling } = await this.candidates(input.model, own);
    // No account to run on (nobody is signed in anywhere): the choice is Claude Code's.
    if (candidates.length === 0) {
      return {
        identity: await translated,
        env: defined(input.env),
        decision: undefined,
        untouched: "no signed-in account",
      };
    }
    const identity = input.identity;
    const resume = identity.resume;
    const projects = sharedProjects(paths);
    const accountsFolders = candidates
      .map((c) => claudeFolder(paths, c.id))
      .filter((f): f is string => f !== undefined)
      .map((f) => `${f}/projects`);
    let current = "";
    let currentExists = true;
    if (resume !== undefined) {
      const recorded = currentSessionIn(store, resume);
      // A conversation only in an account's own old folder is brought into the shared one first.
      currentExists =
        recorded === resume ||
        (await transcriptInShared(recorded, projects, accountsFolders)) !== undefined;
      current = recorded === resume || currentExists ? recorded : resume;
      if (current === resume) await transcriptInShared(resume, projects, accountsFolders);
    }
    const transcript = current === "" ? undefined : await conversationTail(current, projects);
    const decision = decideThread(
      // A rewind's message id is translated after the decision, which never moves a rewind.
      identity,
      {
        ledger: {
          currentSession: (t) => (t === resume ? current || t : currentSessionIn(store, t)),
          account: (s) => store.sessions[s]?.account,
          transcriptExists: (s) => (s === current ? currentExists : true),
        },
        candidates,
        transcript: transcript ?? { lastAssistantAt: undefined, justCompacted: false },
        now,
        isFull: (a) => this.isFull(a),
        newSessionId: this.options.newSessionId,
        choose: input.delegated ? (list) => pick(list, ceiling) : pickForThread,
      },
    );
    const resumeSessionAt =
      decision.identity.resumeSessionAt === undefined || decision.identity.resume === undefined
        ? decision.identity.resumeSessionAt
        : ((await messageIdIn(
            decision.identity.resumeSessionAt,
            decision.identity.resume,
            projects,
          )) ?? decision.identity.resumeSessionAt);
    await this.apply(decision.writes, now);
    await ledger.setAppThreadAccount(input.threadId, decision.account, now);
    const label = (resume ?? decision.session).slice(0, 8) || input.threadId.slice(0, 8);
    this.log(`thread ${label}: ${decision.action} on ${decision.account} (${decision.reason})`);
    const notice =
      decision.forced && decision.from !== undefined
        ? moveNotice({
            from: decision.from,
            to: decision.account,
            why: candidates.some((c) => c.id === decision.from) ? "full" : "gone",
          })
        : undefined;
    return {
      identity: {
        ...decision.identity,
        ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
      },
      env: await runEnvironment(paths, decision.account, input.env),
      decision,
      ...(notice === undefined ? {} : { notice }),
    };
  }

  private async apply(writes: ReadonlyArray<LedgerWrite>, now: number): Promise<void> {
    const projects = sharedProjects(this.options.paths);
    for (const write of writes) {
      if (write.type === "record") {
        await this.options.ledger.record({
          session: write.session,
          account: write.account,
          forkedAt: write.forkedAt,
          from: write.from,
          at: now,
          hasTranscriptLines: () => hasTranscriptLines(write.session, projects),
        });
      } else {
        await this.options.ledger.setCurrent(write.session, write.thread, now);
      }
    }
  }

  /** T3's ids in a query's identity, as the conversation they name is called now (no account chosen). */
  private async translatedIdentity(
    store: LedgerStore,
    identity: ThreadIdentity,
  ): Promise<ThreadIdentity> {
    if (identity.resume === undefined) return identity;
    const current = await this.currentSession(identity.resume, store);
    const at =
      identity.resumeSessionAt === undefined
        ? undefined
        : ((await messageIdIn(
            identity.resumeSessionAt,
            current,
            sharedProjects(this.options.paths),
          )) ?? identity.resumeSessionAt);
    return { ...identity, resume: current, ...(at === undefined ? {} : { resumeSessionAt: at }) };
  }

  /** The conversation T3's native session id continues in now (its own id until it moved, or if it's gone). */
  async currentSession(session: string, store?: LedgerStore): Promise<string> {
    const current = currentSessionIn(store ?? (await this.options.ledger.read()), session);
    if (current === session) return session;
    return (await findTranscript(current, sharedProjects(this.options.paths))) === undefined
      ? session
      : current;
  }

  /** Every conversation T3's native session went through, current first. */
  async lineage(session: string): Promise<ReadonlyArray<string>> {
    return lineageIn(await this.options.ledger.read(), session);
  }

  /** A message id T3 recorded for its session, as it is called in the conversation it continues in now. */
  async messageId(session: string, uuid: string): Promise<{ session: string; uuid: string }> {
    const current = await this.currentSession(session);
    if (current === session) return { session, uuid };
    const translated = await messageIdIn(uuid, current, sharedProjects(this.options.paths));
    return { session: current, uuid: translated ?? uuid };
  }

  /** T3 forked a conversation itself (a file copy, no request): the fork starts on its source's account. */
  async recordFork(source: string, forked: string): Promise<void> {
    const store = await this.options.ledger.read();
    const current = currentSessionIn(store, source);
    await this.options.ledger.record({
      session: forked,
      account: store.sessions[current]?.account ?? MAIN_KEY,
      forkedAt: this.now(),
      from: current,
      at: this.now(),
    });
  }

  /** The notice for a limit reached mid-run on `account`, naming where the next message goes. */
  async limitNotice(
    account: string,
    model: string | undefined,
    delegated: boolean,
  ): Promise<string> {
    const { candidates, ceiling } = await this.candidates(model);
    const others = candidates.filter((c) => c.id !== account);
    const next = delegated ? pick(others, ceiling) : pickForThread(others);
    return moveNotice({ from: account, to: next?.id, why: "limit" });
  }
}

function defined(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}
