/**
 * Keeps every Claude account's sign-in and usage fresh: the standalone lastdrop's app loop (`AppModel` refresh
 * and `ClaudeKeeper.tick`) without the app. `tick` every 15 s renews sign-ins when due; each account's usage
 * is read every 5 minutes, and at once after a renewal. Readings and sign-in states go to the fork's
 * `usage.json`, the file routing reads.
 */
import {
  type AccountStatus,
  claudeView,
  endsSoon,
  isMain,
  type LimitResets,
  pool,
  readingFromStatus,
  windowsFromStatus,
  type SignInState,
  statusWithReading,
  statusWithSignIn,
  type UsageWindow,
} from "@t3tools/lastdrop-core";

import { ClaudeUsage, type FetchLike, type UsageSnapshot } from "./claudeUsage.ts";
import {
  installedClaudeCodeVersion,
  loadAccounts,
  readSignInFacts,
  renewSignIn,
  signedInAccountOf,
} from "./claudeSignIn.ts";
import { ClaudeKeeper } from "./keeper.ts";
import { claudeFolder, type LastdropPaths, statusFile } from "./paths.ts";
import { standaloneAppRunning, standaloneStatusFile } from "./standalone.ts";
import { StatusStore } from "./statusStore.ts";

/** Each account's usage is read this often (lastdrop's app refresh). */
export const USAGE_REFRESH_MS = 5 * 60_000;

/** One Claude account as the Accounts section shows it. Plain JSON: it crosses HTTP as it is. */
export interface AccountView {
  /** "main", or the sign-in folder's name. */
  readonly key: string;
  readonly name?: string | undefined;
  readonly isMain: boolean;
  readonly email?: string | undefined;
  readonly plan?: string | undefined;
  readonly signIn: SignInState;
  readonly signInDetail?: string | undefined;
  /** The sign-in itself ends within three days. */
  readonly signInEndsSoon: boolean;
  readonly signInEndsAt?: number | undefined;
  /** Routing's view (resets projected, unknown when old): percent used. */
  readonly session?: number | undefined;
  readonly weekly?: number | undefined;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly resets?: LimitResets | undefined;
  /** When the numbers were read (epoch ms), and where from. */
  readonly readAt?: number | undefined;
  /** `standalone`: the standalone lastdrop app read it (it runs, so the fork asks nobody itself). */
  readonly source?: "cache" | "endpoint" | "standalone" | undefined;
  /** Why the last read failed, if it did. */
  readonly error?: string | undefined;
  readonly rateLimitedUntil?: number | undefined;
}

export interface AccountsView {
  readonly updatedAt: number;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
  readonly accounts: ReadonlyArray<AccountView>;
  /** Set while the standalone lastdrop app runs and reads usage for both apps. */
  readonly readBy?: "standalone" | undefined;
}

export interface MonitorOptions {
  readonly paths: LastdropPaths;
  /** The environment Claude Code is started from; the process's own by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch: FetchLike;
  readonly sessionId: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Tests replace Claude Code. */
  readonly renew?: (key: string) => Promise<boolean>;
  /** Whether the standalone lastdrop app runs (its heartbeat); tests decide. */
  readonly standaloneRunning?: () => Promise<boolean>;
}

interface UsageEntry {
  attemptedAt: number;
  snapshot?: UsageSnapshot | undefined;
  error?: string | undefined;
  due: boolean;
}

export class AccountsMonitor {
  readonly statuses: StatusStore;
  /** The standalone app's readings, read only, while it runs. */
  readonly standaloneStatuses: StatusStore;
  readonly usage: ClaudeUsage;
  readonly keeper: ClaudeKeeper;
  private readonly options: MonitorOptions;
  private readonly now: () => number;
  private readonly entries = new Map<string, UsageEntry>();
  private ticking: Promise<void> | undefined;
  private lastView: AccountsView | undefined;
  private version: Promise<string> | undefined;

  constructor(options: MonitorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.statuses = new StatusStore(statusFile(options.paths));
    this.standaloneStatuses = new StatusStore(standaloneStatusFile(options.paths));
    this.usage = new ClaudeUsage({
      paths: options.paths,
      statuses: this.statuses,
      fetch: options.fetch,
      version: () => (this.version ??= installedClaudeCodeVersion(options.paths)),
      sessionId: options.sessionId,
      now: this.now,
      ...(options.log ? { log: options.log } : {}),
    });
    this.keeper = new ClaudeKeeper({
      readFacts: (key) => readSignInFacts(options.paths, claudeFolder(options.paths, key)),
      renew:
        options.renew ??
        ((key) =>
          renewSignIn(options.paths, key, {
            env: options.env ?? process.env,
            ...(options.log ? { log: options.log } : {}),
          })),
      now: this.now,
      onRenewed: (key) => this.markDue(key),
      ...(options.log ? { log: options.log } : {}),
    });
  }

  /** Read the account's usage at the next tick. */
  markDue(key?: string): void {
    for (const [k, e] of this.entries) if (key === undefined || k === key) e.due = true;
  }

  /** One pass; a pass already running is joined rather than doubled. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  /** Whether the standalone app runs now: then it reads usage and renews sign-ins, and the fork only reads. */
  standaloneRunning(): Promise<boolean> {
    return (
      this.options.standaloneRunning ?? (() => standaloneAppRunning(this.options.paths, this.now()))
    )();
  }

  /**
   * The readings routing uses: the standalone app's while it runs (it is the one reader of Anthropic's usage
   * then), else the fork's own.
   */
  async routingStatuses(): Promise<Record<string, AccountStatus>> {
    return (await this.standaloneRunning()) ? this.standaloneStatuses.read() : this.statuses.read();
  }

  /** The last pass's view; runs a pass first when there was none. */
  async view(): Promise<AccountsView> {
    if (!this.lastView) await this.tick();
    return this.lastView!;
  }

  private async pass(): Promise<void> {
    const now = this.now();
    const config = await loadAccounts(this.options.paths, now);
    const accounts = pool(config, "claude");
    const keys = accounts.map((a) => a.key);
    if (await this.standaloneRunning()) {
      // The standalone app asks Anthropic and renews sign-ins: asking too would double its requests.
      this.lastView = await this.viewFrom(
        config,
        accounts,
        await this.standaloneStatuses.read(),
        now,
        true,
      );
      return;
    }
    await this.keeper.tick(keys);
    for (const key of keys) {
      const entry = this.entries.get(key) ?? { attemptedAt: -Infinity, due: true };
      this.entries.set(key, entry);
      if (!entry.due && now - entry.attemptedAt < USAGE_REFRESH_MS) continue;
      entry.attemptedAt = now;
      entry.due = false;
      try {
        entry.snapshot = await this.usage.fetch(key);
        entry.error = undefined;
      } catch (error) {
        entry.error = (error as Error).message;
      }
    }
    for (const key of this.entries.keys()) if (!keys.includes(key)) this.entries.delete(key);
    const statuses = await this.statuses.update((all) => {
      for (const key of keys) {
        const snapshot = this.entries.get(key)?.snapshot;
        let status: AccountStatus | undefined = all[key];
        if (snapshot) {
          status = statusWithReading(status, {
            windows: snapshot.windows,
            at: snapshot.at,
            plan: snapshot.plan,
          });
        }
        const signIn = this.keeper.signIns.get(key);
        if (signIn) {
          status = statusWithSignIn(status, {
            state: signIn.state,
            detail: signIn.detail,
            endsAt: signIn.endsAt,
          });
        }
        if (status) all[key] = status;
      }
      return { ...all };
    });
    this.lastView = await this.viewFrom(config, accounts, statuses, now, false);
  }

  private async viewFrom(
    config: Awaited<ReturnType<typeof loadAccounts>>,
    accounts: ReturnType<typeof pool>,
    statuses: Record<string, AccountStatus>,
    now: number,
    standalone: boolean,
  ): Promise<AccountsView> {
    const views: AccountView[] = [];
    for (const account of accounts) {
      const key = account.key;
      const entry = standalone ? undefined : this.entries.get(key);
      const signIn = standalone ? undefined : this.keeper.signIns.get(key);
      const status = statuses[key];
      const reading = readingFromStatus(status, now);
      const { email } = await signedInAccountOf(
        this.options.paths,
        claudeFolder(this.options.paths, key),
      );
      views.push(
        dropUndefined({
          key,
          name: account.name,
          isMain: isMain(account),
          email,
          plan: entry?.snapshot?.plan ?? status?.plan ?? signIn?.plan,
          signIn: signIn?.state ?? (standalone ? (status?.signIn ?? "ok") : "signedOut"),
          signInDetail: signIn?.detail ?? (standalone ? status?.signInDetail : undefined),
          signInEndsSoon: signIn ? endsSoon(signIn, now) : false,
          signInEndsAt: signIn?.endsAt ?? (standalone ? status?.signInEndsAt : undefined),
          session: reading.session,
          weekly: reading.weekly,
          // The standalone's readings (and this app's own before its first read) keep numbers, not rows.
          windows: entry?.snapshot?.windows ?? windowsFromStatus(status),
          resets: entry?.snapshot?.resets,
          readAt: entry?.snapshot?.at ?? status?.at,
          source: entry?.snapshot?.source ?? (standalone ? "standalone" : undefined),
          error: entry?.error,
          rateLimitedUntil:
            status?.blockedUntil !== undefined && status.blockedUntil > now
              ? status.blockedUntil
              : undefined,
        }) as AccountView,
      );
    }
    const claude = claudeView(config);
    return {
      updatedAt: now,
      sessionThreshold: claude.sessionThreshold,
      weeklyThreshold: claude.weeklyThreshold,
      accounts: views,
      ...(standalone ? { readBy: "standalone" as const } : {}),
    };
  }
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
