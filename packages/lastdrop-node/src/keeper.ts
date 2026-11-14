/**
 * Keeps every Claude account's sign-in renewed before it expires, Main included. Port of headroom's
 * `ClaudeKeeper` (ClaudeKeeper.swift); its rules are `@t3tools/lastdrop-core`'s `afterCheck`/`afterRenewal`.
 * Call `tick` every 15 s: it reads a blob only when one is due and starts at most one renewal per account.
 */
import {
  afterCheck,
  afterRenewal,
  isDue,
  isUsableSignIn,
  type KeeperSignIn,
  type SignInFacts,
} from "@t3tools/lastdrop-core";

export interface KeeperOptions {
  /** The account's stored sign-in (`readSignInFacts`). */
  readonly readFacts: (key: string) => Promise<SignInFacts | undefined>;
  /** Starts Claude Code on the account; true when the expiry moved (`renewSignIn`). */
  readonly renew: (key: string) => Promise<boolean>;
  readonly online?: () => boolean;
  readonly now?: () => number;
  /** A renewal moved the expiry: the account's usage can be read again right away. */
  readonly onRenewed?: (key: string) => void;
  readonly log?: (line: string) => void;
}

export class ClaudeKeeper {
  private readonly entries = new Map<string, KeeperSignIn>();
  private readonly checking = new Set<string>();
  private readonly renewals = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly online: () => boolean;
  private readonly options: KeeperOptions;

  constructor(options: KeeperOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.online = options.online ?? (() => true);
  }

  /** By account key ("main", "Pro"). */
  get signIns(): ReadonlyMap<string, KeeperSignIn> {
    return this.entries;
  }

  /** Read the blobs again on the next tick (after a wake, a 401, or a sign-in). */
  recheck(key?: string): void {
    for (const [k, e] of this.entries) {
      if (key === undefined || k === key) this.entries.set(k, { ...e, checkedAt: -Infinity });
    }
  }

  async tick(keys: ReadonlyArray<string>): Promise<void> {
    for (const key of keys) await this.check(key);
    for (const key of this.entries.keys()) if (!keys.includes(key)) this.entries.delete(key);
  }

  /** Waits for renewals in flight (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all(this.renewals);
  }

  private async check(key: string): Promise<void> {
    const current = this.entries.get(key);
    if (this.checking.has(key) || current?.renewing) return;
    if (current && !isDue(current, this.now())) return;
    this.checking.add(key);
    try {
      const facts = await this.options.readFacts(key).catch(() => undefined);
      // Read after the wait: a renewal may have finished meanwhile.
      const previous = this.entries.get(key);
      if (previous?.renewing) return;
      const wasUsable = previous ? isUsableSignIn(previous.state) : true;
      const { entry, renew } = afterCheck(previous, facts, this.online(), this.now());
      this.entries.set(key, entry);
      if (renew) {
        const job = this.options
          .renew(key)
          .catch(() => false)
          .then((renewed) => this.finished(key, renewed));
        this.renewals.add(job);
        void job.finally(() => this.renewals.delete(job));
        return;
      }
      if (wasUsable && !isUsableSignIn(entry.state)) {
        this.options.log?.(`the ${key} sign-in needs you: ${entry.detail ?? entry.state}`);
      }
    } finally {
      this.checking.delete(key);
    }
  }

  private finished(key: string, renewed: boolean): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.set(key, afterRenewal(entry, renewed, this.online(), this.now()));
    if (renewed) this.options.onRenewed?.(key);
  }
}
