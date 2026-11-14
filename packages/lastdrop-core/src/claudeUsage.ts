/**
 * Reading Claude usage: Anthropic's usage answer (from the endpoint or Claude Code's cached copy), reset
 * grants, the plan's name, and Claude Code's sign-in blob. Port of the pure parts of headroom's
 * `ClaudeProvider` (ClaudeProvider.swift). Fetching and file reads are `@t3tools/lastdrop-node`'s.
 */
import * as NodeCrypto from "node:crypto";

import { planName } from "./planSize.ts";
import { addResets, type LimitResets, type UsageWindow } from "./usage.ts";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const dict = (value: unknown, key: string): Json | undefined =>
  isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
const str = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
/** A number, or a string holding one (Swift's `double`). */
function dbl(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** An ISO date with or without a fraction of any length, in epoch ms. */
export function isoDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/u, "$1"));
  return Number.isNaN(ms) ? undefined : ms;
}

/** Epoch seconds or milliseconds, in epoch ms; undefined unless positive. */
export function epochDate(value: number | undefined): number | undefined {
  if (value === undefined || !(value > 0)) return undefined;
  return value > 1e11 ? value : value * 1000;
}

// MARK: Usage answer

/**
 * Session and Weekly, then one weekly row per model-scoped limit ("Fable Weekly"). Per-model windows moved
 * from `seven_day_<model>` into the `limits` array; the legacy keys are still read. Percentages are 0-100.
 */
export function claudeWindows(root: unknown): UsageWindow[] {
  const window = (label: string, used: number | undefined, reset: string | undefined) =>
    used === undefined
      ? undefined
      : dropUndefined({
          label,
          usedPercent: Math.min(Math.max(used, 0), 100),
          resetsAt: isoDate(reset),
        });
  const windows: UsageWindow[] = [];
  for (const [key, label] of [
    ["five_hour", "Session"],
    ["seven_day", "Weekly"],
  ] as const) {
    const w = window(label, dbl(dict(root, key), "utilization"), str(dict(root, key), "resets_at"));
    if (w) windows.push(w);
  }
  const limits = isRecord(root) && Array.isArray(root["limits"]) ? root["limits"] : [];
  for (const limit of limits) {
    if (str(limit, "kind") !== "weekly_scoped") continue;
    const name = str(dict(dict(limit, "scope"), "model"), "display_name");
    if (!name) continue;
    const w = window(`${name} Weekly`, dbl(limit, "percent"), str(limit, "resets_at"));
    if (w && !windows.some((x) => x.label === w.label)) windows.push(w);
  }
  for (const [key, label] of [
    ["seven_day_sonnet", "Sonnet Weekly"],
    ["seven_day_opus", "Opus Weekly"],
  ] as const) {
    if (windows.some((x) => x.label === label)) continue;
    const w = window(label, dbl(dict(root, key), "utilization"), str(dict(root, key), "resets_at"));
    if (w) windows.push(w);
  }
  return windows;
}

/** What an account can spend past its plan's limits (Claude's extra usage). */
export interface ExtraCredits {
  /** "$12.40 of $50.00". */
  readonly amount: string;
  /** The limits are used up and this is what the account runs on now. */
  readonly inUse: boolean;
  readonly detail?: string | undefined;
}

/** `spend: {"enabled", "used": {"amount_minor", "currency", "exponent"}, "limit" | "balance"}`; off: undefined. */
export function claudeExtraUsage(root: unknown, limitReached: boolean): ExtraCredits | undefined {
  const spend = dict(root, "spend");
  if (!spend || spend["enabled"] !== true) return undefined;
  const money = (value: unknown) => {
    const minor = dbl(value, "amount_minor");
    if (minor === undefined) return undefined;
    const amount = minor / 10 ** (dbl(value, "exponent") ?? 2);
    return formatCurrency(amount, str(value, "currency") ?? "USD");
  };
  const used = money(spend["used"]) ?? formatCurrency(0, "USD");
  const limit = money(spend["limit"]);
  const balance = money(spend["balance"]);
  const amount = limit ? `${used} of ${limit}` : balance ? `${balance} left` : `${used} used`;
  return { amount, inUse: limitReached, detail: "Extra usage" };
}

const formatCurrency = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

/** The windows and extra usage in a usage answer. */
export function claudeReading(root: unknown): {
  readonly windows: UsageWindow[];
  readonly credits: ExtraCredits | undefined;
} {
  const windows = claudeWindows(root);
  return {
    windows,
    credits: claudeExtraUsage(
      root,
      windows.some((w) => (w.usedPercent ?? 0) >= 100),
    ),
  };
}

// MARK: Claude Code's cached reading

/** Claude Code's copy of a usage answer (`cachedUsageUtilization` in a `.claude.json`). */
export interface CachedUsage {
  readonly fetchedAt: number;
  readonly root: Json;
}

/** A cached answer is used while younger than this. */
export const CACHE_FRESH_MS = 10 * 60_000;

/**
 * `{"cachedUsageUtilization": {"fetchedAtMs", "accountUuid", "utilization": {…}}}`. Every account's sessions
 * may write the shared file, so an answer counts only for the account it names. Undefined when it names
 * another (or none), is older than `CACHE_FRESH_MS` or dated ahead of the clock, or has no limits in it.
 */
export function cachedUsageFromConfig(
  config: unknown,
  accountUuid: string,
  now: number,
): CachedUsage | undefined {
  const cache = dict(config, "cachedUsageUtilization");
  if (!cache || str(cache, "accountUuid") !== accountUuid) return undefined;
  const fetchedAt = epochDate(dbl(cache, "fetchedAtMs"));
  const root = dict(cache, "utilization");
  if (fetchedAt === undefined || !root) return undefined;
  const age = now - fetchedAt + 5_000; // a few seconds of clock slack
  if (age < 0 || age >= CACHE_FRESH_MS) return undefined;
  if (claudeWindows(root).length === 0) return undefined;
  return { fetchedAt, root };
}

/** The newest fresh answer for the account among parsed config files (undefined entries: unreadable). */
export function newestCachedUsage(
  accountUuid: string | undefined,
  configs: ReadonlyArray<unknown>,
  now: number,
): CachedUsage | undefined {
  if (!accountUuid) return undefined;
  let best: CachedUsage | undefined;
  for (const config of configs) {
    const hit = cachedUsageFromConfig(config, accountUuid, now);
    if (hit && (!best || hit.fetchedAt > best.fetchedAt)) best = hit;
  }
  return best;
}

/** The account a `.claude.json` is signed in to (`oauthAccount`). */
export function signedInAccount(config: unknown): {
  readonly uuid: string | undefined;
  readonly email: string | undefined;
} {
  const account = dict(config, "oauthAccount");
  return { uuid: str(account, "accountUuid"), email: str(account, "emailAddress") };
}

// MARK: Reset grants

export interface ResetGrant {
  readonly count: number;
  readonly expiries: ReadonlyArray<number>;
  readonly label: string;
  /** Clears one model's weekly limit, not the account's. */
  readonly modelOnly: boolean;
}

/**
 * `{"eligible": true, "grants": [{"id", "label", "resets_left", "ends_at", "clears"}]}`. Undefined for a
 * missing or `null` block, or a malformed grant. An ineligible account has no usable resets.
 */
export function resetGrants(value: unknown, now: number): ResetGrant[] | undefined {
  if (!isRecord(value)) return undefined;
  const grants: ResetGrant[] = [];
  for (const grant of Array.isArray(value["grants"]) ? value["grants"] : []) {
    const left = dbl(grant, "resets_left");
    if (!isRecord(grant) || left === undefined) return undefined;
    const ends = isoDate(str(grant, "ends_at"));
    if (value["eligible"] !== true || left < 1 || (ends !== undefined && ends <= now)) continue;
    const clears = Array.isArray(grant["clears"])
      ? grant["clears"].filter((c): c is string => typeof c === "string")
      : [];
    const count = Math.trunc(left);
    grants.push({
      count,
      expiries: ends === undefined ? [] : Array.from({ length: count }, () => ends),
      label: str(grant, "label") ?? "",
      modelOnly: isModelOnly(clears),
    });
  }
  return grants;
}

/** A grant that clears a weekly limit other than `seven_day`, and not `seven_day` itself. */
export const isModelOnly = (clears: ReadonlyArray<string>): boolean =>
  !clears.includes("seven_day") && clears.some((c) => c.startsWith("seven_day_"));

/**
 * Puts each model-only grant on its model's weekly row: the one whose model the label names, else the only
 * model row. Returns the new rows and the account's other resets.
 */
export function placeGrants(
  grants: ReadonlyArray<ResetGrant> | undefined,
  windows: ReadonlyArray<UsageWindow>,
): { readonly windows: UsageWindow[]; readonly account: LimitResets | undefined } {
  const rows = [...windows];
  if (!grants) return { windows: rows, account: undefined };
  const modelRows = rows.flatMap((w, i) =>
    w.label !== "Weekly" && w.label.endsWith(" Weekly") ? [i] : [],
  );
  let account: LimitResets = { count: 0, expiries: [] };
  for (const grant of grants) {
    const label = grant.label.toLowerCase();
    const row = grant.modelOnly
      ? (modelRows.find((i) =>
          label.includes(rows[i]!.label.slice(0, -" Weekly".length).toLowerCase()),
        ) ?? (modelRows.length === 1 ? modelRows[0] : undefined))
      : undefined;
    if (row !== undefined) {
      const w = rows[row]!;
      rows[row] = {
        ...w,
        resets: addResets(w.resets ?? { count: 0, expiries: [] }, grant.count, grant.expiries),
      };
    } else {
      account = addResets(account, grant.count, grant.expiries);
    }
  }
  return { windows: rows, account };
}

// MARK: Plan

/**
 * `{"organization": {"plan_display_name": "Ultra", "organization_type": "claude_max", "rate_limit_tier"}}`.
 * Without a display name: the type and tier ("Max 5x"). Undefined when neither is there.
 */
export function planDisplayNameFromProfile(root: unknown): string | undefined {
  const org = dict(root, "organization");
  const name = str(org, "plan_display_name")?.trim();
  if (name) return name;
  const type = str(org, "organization_type");
  if (!type?.startsWith("claude_")) return undefined;
  return planName(type.slice("claude_".length), str(org, "rate_limit_tier"));
}

/**
 * The plan name to show: the one from Anthropic's profile. The sign-in's stands in only when there's none:
 * Claude Code stamps it at sign-in and never updates it after an upgrade.
 */
export const shownPlan = (shown: string | undefined, credentials: string | undefined) =>
  shown ?? credentials;

// MARK: Claude Code's sign-in blob

export interface Credentials {
  readonly accessToken: string;
  readonly expiresAt: number | undefined;
  readonly plan: string | undefined;
}

/** Not about to expire: Anthropic would accept it. */
export const credentialsUsable = (c: Credentials, now: number): boolean =>
  c.expiresAt === undefined || c.expiresAt - now >= 60_000;

const parseBlob = (raw: string): Json | undefined => {
  try {
    const json: unknown = JSON.parse(raw);
    return dict(json, "claudeAiOauth");
  } catch {
    return undefined;
  }
};

/** Parses Claude Code's `{"claudeAiOauth": {...}}` credentials blob. */
export function parseCredentials(raw: string): Credentials | undefined {
  const oauth = parseBlob(raw);
  const token = str(oauth, "accessToken")?.trim();
  if (!oauth || !token) return undefined;
  return {
    accessToken: token,
    expiresAt: epochDate(dbl(oauth, "expiresAt")),
    plan: planName(str(oauth, "subscriptionType"), str(oauth, "rateLimitTier")),
  };
}

/** True when the blob holds a token that hasn't (nearly) expired. */
export function isSignedIn(raw: string | undefined, now: number): boolean {
  const creds = raw === undefined ? undefined : parseCredentials(raw);
  return creds ? credentialsUsable(creds, now) : false;
}

/** What the keeper needs to know about a sign-in, from the blob alone. */
export interface SignInFacts {
  /** When the access token expires; undefined when there's none. */
  readonly expiresAt: number | undefined;
  /** When the sign-in itself ends (`refreshTokenExpiresAt`). */
  readonly endsAt: number | undefined;
  readonly hasRefreshToken: boolean;
  /** Claude Code's reason for clearing a dead sign-in: "time_limit" when it ran out. */
  readonly loginEnded?: string | undefined;
  readonly plan?: string | undefined;
}

/** Undefined when the blob isn't a Claude subscription sign-in at all. */
export function signInFacts(raw: string): SignInFacts | undefined {
  const oauth = parseBlob(raw);
  if (!oauth) return undefined;
  const access = str(oauth, "accessToken")?.trim() ?? "";
  const refresh = str(oauth, "refreshToken")?.trim() ?? "";
  const expires = dbl(oauth, "expiresAt");
  return {
    expiresAt: access
      ? epochDate(expires !== undefined && expires > 0 ? expires : undefined)
      : undefined,
    endsAt: epochDate(dbl(oauth, "refreshTokenExpiresAt")),
    hasRefreshToken: refresh.length > 0,
    loginEnded: str(oauth, "loginEnded"),
    plan: planName(str(oauth, "subscriptionType"), str(oauth, "rateLimitTier")),
  };
}

/**
 * Claude Code's keychain item for a config folder: `Claude Code-credentials`, plus the first 8 hex digits of
 * the SHA-256 of the folder path when `CLAUDE_CONFIG_DIR` is set (Claude Code 2.1.310).
 */
export function keychainService(configDir: string | undefined): string {
  if (configDir === undefined) return "Claude Code-credentials";
  const digest = NodeCrypto.createHash("sha256").update(configDir.normalize("NFC")).digest("hex");
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}

// MARK: Answers

export function rateLimitedMessage(until: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return `Claude usage is rate limited. Retrying in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** An answer that is an HTML page (Cloudflare's block or challenge) rather than the API's JSON. */
export const isCloudflarePage = (status: number, contentType: string | undefined): boolean =>
  !(status >= 200 && status < 300) && (contentType ?? "").toLowerCase().includes("text/html");

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
