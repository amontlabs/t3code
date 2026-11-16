/**
 * Claude usage per account with Claude Code's OAuth sign-in (headroom's `ClaudeProvider.fetch`). Order: Claude
 * Code's own recent copy of the answer (asking again spends the endpoint's small quota), then nothing while
 * the account is told to back off, then the endpoint, recording a 429 for every reader.
 */
import {
  blockedUntil,
  type CachedUsage,
  claudeCodeOAuthHeaders,
  claudeReading,
  clearBlock,
  credentialsUsable,
  type Credentials,
  type ExtraCredits,
  isCloudflarePage,
  type LimitResets,
  newestCachedUsage,
  parseCredentials,
  placeGrants,
  planDisplayNameFromProfile,
  rateLimitedMessage,
  recordBlock,
  type ResetGrant,
  resetGrants,
  type UsageWindow,
} from "@t3tools/lastdrop-core";

import { readJsonObject } from "./files.ts";
import { claudeFolder, type LastdropPaths, profileConfigFile } from "./paths.ts";
import { signedInAccountOf, storedCredentials } from "./claudeSignIn.ts";
import type { StatusStore } from "./statusStore.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export type UsageErrorKind =
  | "notConfigured"
  | "unauthorized"
  | "rateLimited"
  | "http"
  | "invalidResponse"
  | "network";

export class UsageFetchError extends Error {
  readonly kind: UsageErrorKind;
  readonly status: number | undefined;
  constructor(kind: UsageErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface UsageSnapshot {
  readonly plan: string | undefined;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly credits?: ExtraCredits | undefined;
  /** The account's own resets (not a model row's). */
  readonly resets?: LimitResets | undefined;
  /** Where the numbers came from: Claude Code's copy, or Anthropic just now. */
  readonly source: "cache" | "endpoint";
  /** When the numbers were read (epoch ms). */
  readonly at: number;
}

/** Answers worth asking for at most once an hour per key; a failure keeps the previous answer and counts. */
export class HourlyCache<V> {
  private readonly entries = new Map<string, { checked: number; value: V | undefined }>();
  private readonly intervalMs: number;
  constructor(intervalMs = 3_600_000) {
    this.intervalMs = intervalMs;
  }

  async value(
    key: string,
    now: number,
    fetch: () => Promise<V | undefined>,
  ): Promise<V | undefined> {
    const entry = this.entries.get(key);
    if (entry && now - entry.checked < this.intervalMs) return entry.value;
    let value: V | undefined;
    try {
      value = (await fetch()) ?? entry?.value;
    } catch {
      value = entry?.value;
    }
    this.entries.set(key, { checked: now, value });
    return value;
  }
}

export type FetchLike = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Node's own fetch. */
export const nodeFetch: FetchLike = (url, init) => fetch(url, init);

export interface ClaudeUsageOptions {
  readonly paths: LastdropPaths;
  readonly statuses: StatusStore;
  readonly fetch: FetchLike;
  readonly version: () => Promise<string>;
  /** One id for the whole run, as one Claude Code session keeps one. */
  readonly sessionId: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Reads every Claude account's usage. Keeps the hourly plan and grant caches for the process. */
export class ClaudeUsage {
  private readonly planCache = new HourlyCache<string>();
  private readonly grantCache = new HourlyCache<ResetGrant[]>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly options: ClaudeUsageOptions;

  constructor(options: ClaudeUsageOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Where Claude Code may have kept the account's answer: `~/.claude.json`, its profile, its folder. */
  cacheFiles(key: string): string[] {
    const folder = claudeFolder(this.options.paths, key);
    return [
      this.options.paths.sharedConfig,
      ...(folder ? [profileConfigFile(folder, this.options.paths), `${folder}/.claude.json`] : []),
    ];
  }

  /** The account's recent answer from Claude Code, if it has one. */
  async cachedUsage(key: string): Promise<CachedUsage | undefined> {
    const { uuid } = await signedInAccountOf(
      this.options.paths,
      claudeFolder(this.options.paths, key),
    );
    const configs = await Promise.all(this.cacheFiles(key).map((f) => readJsonObject(f)));
    return newestCachedUsage(uuid, configs, this.now());
  }

  /**
   * The account's usage. `lean` skips the plan and grants (a runner's read); `fresh` asks Anthropic even when
   * Claude Code's copy is recent.
   */
  async fetch(
    key: string,
    options: { lean?: boolean; fresh?: boolean } = {},
  ): Promise<UsageSnapshot> {
    const folder = claudeFolder(this.options.paths, key);
    if (!options.fresh) {
      const cached = await this.cachedUsage(key);
      if (cached) {
        const { windows, credits } = claudeReading(cached.root);
        const base = { windows, credits, source: "cache" as const, at: cached.fetchedAt };
        if (options.lean) return { ...base, plan: undefined };
        const raw = await storedCredentials(this.options.paths, folder);
        const creds = raw === undefined ? undefined : parseCredentials(raw);
        return this.snapshot(key, base, creds, cached.root["cedar_ember"]);
      }
    }
    // Another process (or an earlier refresh) was told to back off: asking again only keeps the 429 going.
    const until = blockedUntil((await this.options.statuses.read())[key], this.now());
    if (until !== undefined) {
      throw new UsageFetchError("rateLimited", rateLimitedMessage(until, this.now()));
    }
    const raw = await storedCredentials(this.options.paths, folder);
    if (raw === undefined) throw new UsageFetchError("notConfigured", "Not signed in here.");
    const creds = parseCredentials(raw);
    if (!creds) {
      throw new UsageFetchError(
        "notConfigured",
        "Claude Code is not signed in with a Claude subscription.",
      );
    }
    // Read-only: Claude Code refreshes its own login, so an expired token means "run claude".
    const expired = "Claude Code sign-in expired. Run `claude` to refresh it.";
    if (!credentialsUsable(creds, this.now())) throw new UsageFetchError("unauthorized", expired);
    let reading: ReturnType<typeof claudeReading>;
    try {
      reading = await this.usage(creds.accessToken, expired);
    } catch (error) {
      if (error instanceof RateLimited) {
        const blocked = await this.options.statuses.update((all) => {
          const r = recordBlock(all[key], error.retryAfter, this.now());
          all[key] = r.status;
          return r.until;
        });
        throw new UsageFetchError("rateLimited", rateLimitedMessage(blocked, this.now()));
      }
      throw error;
    }
    await this.options.statuses.update((all) => {
      if (all[key]) all[key] = clearBlock(all[key]);
    });
    const base = { ...reading, source: "endpoint" as const, at: this.now() };
    if (options.lean) return { ...base, plan: creds.plan };
    return this.snapshot(key, base, creds, undefined);
  }

  /** The reading plus the plan's name and the reset grants, each asked for at most once an hour. */
  private async snapshot(
    key: string,
    base: Omit<UsageSnapshot, "plan" | "resets">,
    creds: Credentials | undefined,
    grantsBlock: unknown,
  ): Promise<UsageSnapshot> {
    const now = this.now();
    let grants = resetGrants(grantsBlock, now);
    let plan = creds?.plan;
    if (creds) {
      const token = credentialsUsable(creds, now) ? creds.accessToken : undefined;
      // Claude Code's saved reading carries `"cedar_ember": null`: then they're asked for.
      if (typeof grantsBlock !== "object" || grantsBlock === null) {
        // The same endpoint as the usage: never asked while it's telling this account to back off.
        const blocked = blockedUntil((await this.options.statuses.read())[key], now) !== undefined;
        grants = await this.grantCache.value(key, now, async () => {
          if (!token || blocked) throw new UsageFetchError("http", "skipped", 429);
          return this.resetGrants(token);
        });
      }
      // Keyed by the subscription in the sign-in too: after a plan change the old name isn't kept.
      const shown = await this.planCache.value(`${key}|${creds.plan ?? ""}`, now, async () => {
        if (!token) throw new UsageFetchError("http", "skipped", 401);
        return this.planDisplayName(token);
      });
      plan = shown ?? creds.plan;
    }
    const placed = placeGrants(grants, base.windows);
    return { ...base, windows: placed.windows, resets: placed.account, plan };
  }

  private async request(url: string, token: string, what: string) {
    const headers = claudeCodeOAuthHeaders(
      token,
      await this.options.version(),
      this.options.sessionId,
    );
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.options.fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new UsageFetchError("network", `Couldn't reach Anthropic: ${(error as Error).message}`);
    }
    if (response.status < 200 || response.status >= 300) {
      const type = response.headers.get("content-type") ?? "?";
      const ray = response.headers.get("cf-ray");
      this.log(
        `anthropic: lastdrop's ${what} request answered ${response.status} (${type}${ray ? `, cf-ray ${ray}` : ""})`,
      );
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { response, body };
  }

  private async usage(token: string, expired: string) {
    const { response, body } = await this.request(USAGE_URL, token, "usage");
    const status = response.status;
    // A Cloudflare page says nothing about the sign-in: a passing error, read again later.
    if (isCloudflarePage(status, response.headers.get("content-type") ?? undefined)) {
      throw new UsageFetchError("http", `Anthropic answered ${status}.`, status);
    }
    if (status === 401 || status === 403)
      throw new UsageFetchError("unauthorized", expired, status);
    if (status === 429) {
      const header = response.headers.get("retry-after")?.trim();
      const seconds = header ? Number(header) : Number.NaN;
      throw new RateLimited(Number.isFinite(seconds) ? seconds : undefined);
    }
    if (status < 200 || status >= 300) {
      throw new UsageFetchError("http", `Anthropic answered ${status}.`, status);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new UsageFetchError("invalidResponse", "Anthropic's answer wasn't usage.");
    }
    return claudeReading(body);
  }

  private async resetGrants(token: string): Promise<ResetGrant[] | undefined> {
    const { response, body } = await this.request(
      `${USAGE_URL}?cedar_ember=1&skip_spend=1`,
      token,
      "reset grants",
    );
    if (
      response.status < 200 ||
      response.status >= 300 ||
      typeof body !== "object" ||
      body === null
    ) {
      throw new UsageFetchError("http", "no grants", response.status);
    }
    return resetGrants((body as Record<string, unknown>)["cedar_ember"], this.now());
  }

  private async planDisplayName(token: string): Promise<string | undefined> {
    const { response, body } = await this.request(PROFILE_URL, token, "profile");
    if (
      response.status < 200 ||
      response.status >= 300 ||
      typeof body !== "object" ||
      body === null
    ) {
      throw new UsageFetchError("http", "no profile", response.status);
    }
    return planDisplayNameFromProfile(body);
  }
}

class RateLimited extends Error {
  readonly retryAfter: number | undefined;
  constructor(retryAfter: number | undefined) {
    super("rate limited");
    this.retryAfter = retryAfter;
  }
}
