/**
 * lastdrop's accounts as one of T3's usage limit sources (the snapshots hubs report), so Usage → Limits pools
 * every Claude account, Z.ai and OpenRouter. Pure conversion plus a process-wide feed the publisher writes and
 * the `UsageLimitSources` wrapper reads (`limitSourcesLive.ts`); with nothing published it adds nothing.
 */
import {
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
  ProviderDriverKind,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type {
  AccountsView,
  EndpointWindow,
  LimitResets,
  UsageWindow,
} from "@t3tools/lastdrop-node";

import type { EndpointsView } from "./endpointsView.ts";

/** The source's id; reset credits are never redeemed through it. */
export const LASTDROP_SOURCE_ID = UsageLimitSourceId.make("lastdrop");
const SOURCE_LABEL = "lastdrop";
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
/**
 * Z.ai's and OpenRouter's pools. Not T3 drivers (their T3 instances are Claude ones, whose own probe reports no
 * limits behind a proxy): **Usage → Limits** names a pool by its driver when no provider client has it, so these
 * read as names there.
 */
const ENDPOINT_DRIVERS = {
  zai: ProviderDriverKind.make("Zai"),
  openrouter: ProviderDriverKind.make("OpenRouter"),
} as const;

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * One of lastdrop's windows with T3's id, kind and label for it (`claudeUsageLimits.ts`: `five_hour`,
 * `seven_day`, `seven_day_<model>` as "Weekly · <model>"), so lastdrop's readings pool with T3's own probe of
 * the same account. Undefined without a percentage.
 */
export function toUsageWindow(
  window: UsageWindow | EndpointWindow,
): ServerProviderUsageWindow | undefined {
  if (window.usedPercent === undefined || !Number.isFinite(window.usedPercent)) return undefined;
  const usedPercent = Math.min(Math.max(window.usedPercent, 0), 100);
  const resetsAt = window.resetsAt !== undefined ? { resetsAt: iso(window.resetsAt) } : {};
  if (window.label === "Session") {
    return {
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: SESSION_MINS,
      usedPercent,
      ...resetsAt,
    };
  }
  if (window.label === "Weekly") {
    return {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: WEEK_MINS,
      usedPercent,
      ...resetsAt,
    };
  }
  if (window.label.endsWith(" Weekly")) {
    const model = window.label.slice(0, -" Weekly".length);
    return {
      id: `seven_day_${slug(model)}`,
      kind: "weekly",
      label: `Weekly · ${model}`,
      windowDurationMins: WEEK_MINS,
      usedPercent,
      ...resetsAt,
    };
  }
  const id = slug(window.label);
  if (id === "") return undefined;
  return { id, kind: "other", label: window.label, usedPercent, ...resetsAt };
}

/** Banked resets (Anthropic's grants) as a count only: lastdrop spends none from T3, so no credit id. */
function resetCredits(
  account: LimitResets | undefined,
  windows: ReadonlyArray<UsageWindow>,
): ServerProviderUsageLimits["resetCredits"] {
  const all = [account, ...windows.map((window) => window.resets)].filter(
    (resets): resets is LimitResets => resets !== undefined && resets.count > 0,
  );
  const availableCount = all.reduce((sum, resets) => sum + resets.count, 0);
  if (availableCount === 0) return undefined;
  const next = all.flatMap((resets) => resets.expiries).toSorted((a, b) => a - b)[0];
  return { availableCount, ...(next !== undefined ? { nextExpiresAt: iso(next) } : {}) };
}

function limits(input: {
  readonly readAt: number | undefined;
  readonly now: number;
  readonly windows: ReadonlyArray<UsageWindow | EndpointWindow>;
  readonly problem: string | undefined;
  readonly resets?: ServerProviderUsageLimits["resetCredits"];
}): ServerProviderUsageLimits {
  const checkedAt = iso(input.readAt ?? input.now);
  const windows = input.windows.flatMap((window) => toUsageWindow(window) ?? []);
  if (input.problem !== undefined || windows.length === 0) {
    return {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: input.problem ?? "No reading yet." },
    };
  }
  return { checkedAt, windows, ...(input.resets ? { resetCredits: input.resets } : {}) };
}

const SIGN_IN_PROBLEMS = { needsSignIn: "Needs sign-in.", signedOut: "Signed out." } as const;

/** Each Claude account lastdrop knows, then each configured Z.ai/OpenRouter endpoint. */
export function lastdropLimitSource(input: {
  readonly accounts: AccountsView | undefined;
  readonly endpoints: EndpointsView | undefined;
  readonly now: number;
}): UsageLimitSourceSnapshot | undefined {
  const { now } = input;
  const claude = (input.accounts?.accounts ?? []).map((account): UsageLimitSourceAccount => ({
    id: account.key,
    driver: CLAUDE_DRIVER,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    usageLimits: limits({
      readAt: account.readAt,
      now,
      windows: account.windows,
      problem:
        account.signIn === "ok"
          ? account.windows.length === 0
            ? account.error
            : undefined
          : (account.signInDetail ?? SIGN_IN_PROBLEMS[account.signIn]),
      resets: resetCredits(account.resets, account.windows),
    }),
  }));
  const endpoints = (input.endpoints?.endpoints ?? [])
    .filter((endpoint) => endpoint.configured)
    .map((endpoint): UsageLimitSourceAccount => ({
      id: endpoint.title,
      driver: ENDPOINT_DRIVERS[endpoint.provider],
      ...(endpoint.usage?.plan ? { plan: endpoint.usage.plan } : {}),
      usageLimits: limits({
        readAt: endpoint.readAt,
        now,
        windows: endpoint.usage?.windows ?? [],
        problem: endpoint.usage ? undefined : (endpoint.error ?? endpoint.problem),
      }),
    }));
  const accounts = [...claude, ...endpoints];
  if (accounts.length === 0) return undefined;
  return {
    id: LASTDROP_SOURCE_ID,
    kind: "cliproxy",
    label: SOURCE_LABEL,
    checkedAt: iso(now),
    accounts,
  };
}

// MARK: Feed

type Listener = (snapshots: ReadonlyArray<UsageLimitSourceSnapshot>) => void;
let latest: ReadonlyArray<UsageLimitSourceSnapshot> = [];
let latestKey = "[]";
const listeners = new Set<Listener>();

/** The snapshots the wrapper adds after T3's own; empty until the publisher runs. */
export const currentLastdropSources = (): ReadonlyArray<UsageLimitSourceSnapshot> => latest;

/** Publishes a new reading; a reading equal to the last one (ignoring `checkedAt` of the source) is dropped. */
export function publishLastdropSources(
  snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
): boolean {
  const key = JSON.stringify(snapshots.map(({ checkedAt: _, ...rest }) => rest));
  if (key === latestKey) return false;
  latest = snapshots;
  latestKey = key;
  for (const listener of listeners) listener(snapshots);
  return true;
}

export function onLastdropSources(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
