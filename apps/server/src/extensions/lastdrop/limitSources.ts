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

import type { CodexAccountsView } from "./codex/accounts.ts";
import type { EndpointsView } from "./endpointsView.ts";

/** The source's id; reset credits are never redeemed through it. */
export const LASTDROP_SOURCE_ID = UsageLimitSourceId.make("lastdrop");
const SOURCE_LABEL = "lastdrop";
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
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

/** An ISO time, or undefined for none: a never-read account's status has `at: -Infinity`. */
const iso = (ms: number | undefined): string | undefined =>
  ms !== undefined && Number.isFinite(ms) ? DateTime.formatIso(DateTime.makeUnsafe(ms)) : undefined;
const isoNow = (now: number): string => DateTime.formatIso(DateTime.makeUnsafe(now));

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
  const reset = iso(window.resetsAt);
  const resetsAt = reset !== undefined ? { resetsAt: reset } : {};
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

/**
 * Banked resets (Anthropic's grants) as a count only: lastdrop spends none from T3, so no credit id. Not sent for
 * an account a T3 provider also reports (`nativeEmails`): T3 takes the fresher count's source as the one to redeem
 * through, and ours has no credit id, so its **Use reset** would disappear.
 */
function resetCredits(
  account: LimitResets | undefined,
  windows: ReadonlyArray<UsageWindow>,
): ServerProviderUsageLimits["resetCredits"] {
  const all = [account, ...windows.map((window) => window.resets)].filter(
    (resets): resets is LimitResets => resets !== undefined && resets.count > 0,
  );
  const availableCount = all.reduce((sum, resets) => sum + resets.count, 0);
  if (availableCount === 0) return undefined;
  const next = iso(
    all
      .flatMap((resets) => resets.expiries)
      .filter(Number.isFinite)
      .toSorted((a, b) => a - b)[0],
  );
  return { availableCount, ...(next !== undefined ? { nextExpiresAt: next } : {}) };
}

function limits(input: {
  readonly readAt: number | undefined;
  readonly now: number;
  readonly windows: ReadonlyArray<UsageWindow | EndpointWindow>;
  readonly problem: string | undefined;
  readonly resets?: ServerProviderUsageLimits["resetCredits"];
}): ServerProviderUsageLimits {
  const checkedAt = iso(input.readAt) ?? isoNow(input.now);
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

/** One account that could not be converted; the others still publish. */
const unreadable = (now: number): ServerProviderUsageLimits => ({
  checkedAt: isoNow(now),
  windows: [],
  unavailable: { reason: "probeFailed", message: "lastdrop could not show this account's usage." },
});

const safely = (now: number, make: () => ServerProviderUsageLimits): ServerProviderUsageLimits => {
  try {
    return make();
  } catch {
    return unreadable(now);
  }
};

const emailKey = (email: string): string => email.trim().toLowerCase();

/** One of lastdrop's Codex accounts: T3's own windows for its last reading (`codex/routing.ts`). */
function codexAccount(
  account: CodexAccountsView["accounts"][number],
  now: number,
): UsageLimitSourceAccount {
  const problem = !account.signedIn
    ? SIGN_IN_PROBLEMS.signedOut
    : (account.error ?? (account.usageLimits === undefined ? "No reading yet." : undefined));
  return {
    // Unique within the source, beside the Claude accounts' keys.
    id: `codex-${account.key}`,
    driver: CODEX_DRIVER,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    usageLimits:
      problem === undefined && account.usageLimits !== undefined
        ? account.usageLimits
        : {
            checkedAt: iso(account.readAt) ?? isoNow(now),
            windows: [],
            unavailable: { reason: "probeFailed", message: problem ?? "No reading yet." },
          },
  };
}

/** Each Claude account lastdrop knows, each Codex account, then each configured Z.ai/OpenRouter endpoint. */
export function lastdropLimitSource(input: {
  readonly accounts: AccountsView | undefined;
  readonly codex?: CodexAccountsView | undefined;
  readonly endpoints: EndpointsView | undefined;
  readonly now: number;
  /** E-mails T3's own providers report (any case): their accounts get no reset count from us. */
  readonly nativeEmails?: ReadonlySet<string>;
}): UsageLimitSourceSnapshot | undefined {
  const { now } = input;
  const native = new Set([...(input.nativeEmails ?? [])].map(emailKey));
  const claude = (input.accounts?.accounts ?? []).map((account): UsageLimitSourceAccount => ({
    id: account.key,
    driver: CLAUDE_DRIVER,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    usageLimits: safely(now, () =>
      limits({
        readAt: account.readAt,
        now,
        windows: account.windows,
        // A failing read shows its error, not the last good numbers.
        problem:
          account.signIn === "ok"
            ? account.error
            : (account.signInDetail ?? SIGN_IN_PROBLEMS[account.signIn]),
        ...(account.email && native.has(emailKey(account.email))
          ? {}
          : { resets: resetCredits(account.resets, account.windows) }),
      }),
    ),
  }));
  const endpoints = (input.endpoints?.endpoints ?? [])
    .filter((endpoint) => endpoint.configured)
    .map((endpoint): UsageLimitSourceAccount => ({
      id: endpoint.title,
      driver: ENDPOINT_DRIVERS[endpoint.provider],
      ...(endpoint.usage?.plan ? { plan: endpoint.usage.plan } : {}),
      usageLimits: safely(now, () =>
        limits({
          readAt: endpoint.readAt,
          now,
          windows: endpoint.usage?.windows ?? [],
          problem: endpoint.usage ? undefined : (endpoint.error ?? endpoint.problem),
        }),
      ),
    }));
  const codex = (input.codex?.accounts ?? []).map((account) => codexAccount(account, now));
  const accounts = [...claude, ...codex, ...endpoints];
  if (accounts.length === 0) return undefined;
  return {
    id: LASTDROP_SOURCE_ID,
    kind: "cliproxy",
    label: SOURCE_LABEL,
    checkedAt: isoNow(now),
    accounts,
  };
}

// MARK: Feed

type Listener = (snapshots: ReadonlyArray<UsageLimitSourceSnapshot>) => void;

/**
 * What decides whether a reading changed: not the source's check time, nor an unavailable account's (it has no
 * reading, so its time is the publish time and would change every round).
 */
const changeKey = (snapshots: ReadonlyArray<UsageLimitSourceSnapshot>): string =>
  JSON.stringify(
    snapshots.map(({ checkedAt: _, accounts, ...rest }) => ({
      ...rest,
      accounts: accounts.map((account) => {
        if (!account.usageLimits.unavailable) return account;
        const { checkedAt: __, ...usageLimits } = account.usageLimits;
        return { ...account, usageLimits };
      }),
    })),
  );

/**
 * The latest published reading, shared by the publisher and the `UsageLimitSources` wrapper (they sit in different
 * layers of the server's stack). The publisher layer owns it: it starts empty when that layer builds and is cleared
 * when it closes, so a rebuilt layer never serves the previous one's reading.
 */
class Feed {
  private latest: ReadonlyArray<UsageLimitSourceSnapshot> = [];
  private latestKey = changeKey([]);
  private readonly listeners = new Set<Listener>();

  current = (): ReadonlyArray<UsageLimitSourceSnapshot> => this.latest;

  publish = (snapshots: ReadonlyArray<UsageLimitSourceSnapshot>): boolean => {
    const key = changeKey(snapshots);
    if (key === this.latestKey) return false;
    this.latest = snapshots;
    this.latestKey = key;
    for (const listener of this.listeners) listener(snapshots);
    return true;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

const feed = new Feed();

/** The snapshots the wrapper adds after T3's own; empty until the publisher runs. */
export const currentLastdropSources = feed.current;

/** Publishes a new reading; one with the same content as the last (see `changeKey`) is dropped. */
export const publishLastdropSources = feed.publish;

export const onLastdropSources = feed.subscribe;

/** Empties the feed (listeners hear `[]`): the publisher layer's start and end. */
export const resetLastdropSources = (): void => {
  feed.publish([]);
};
