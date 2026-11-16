/**
 * lastdrop's accounts as one of T3's usage limit sources (the snapshots hubs report), so Usage → Limits pools
 * every Claude account, Z.ai and OpenRouter. Pure conversion plus a process-wide feed (and the reset redeemer)
 * the publisher sets and the `UsageLimitSources` wrapper reads (`limitSourcesLive.ts`); with nothing published it
 * adds nothing.
 */
import {
  type ProviderConsumeResetCreditResult,
  type ServerProviderResetCredits,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceError,
  type UsageLimitSourceSnapshot,
  ProviderDriverKind,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type {
  AccountsView,
  AccountView,
  EndpointWindow,
  KeyUsage,
  LimitResets,
  ResetGrant,
  UsageWindow,
} from "@t3tools/lastdrop-node";

import type { CodexAccountsView } from "./codex/accounts.ts";
import type { EndpointsView } from "./endpointsView.ts";

/** The source's id; a reset redeemed through it is spent on the row's own fork account. */
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
  const detail = "detail" in window ? window.detail?.trim() : undefined;
  const resetsAt = {
    ...(reset !== undefined ? { resetsAt: reset } : {}),
    ...(detail ? { detail } : {}),
  };
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

type ResetOption = NonNullable<ServerProviderResetCredits["options"]>[number];

/** A model's week ("Fable Weekly") by name, as `placeGrants` matches a model-only grant to it. */
const modelRowNames = (windows: ReadonlyArray<UsageWindow>) =>
  windows.flatMap((window) =>
    window.label !== "Weekly" && window.label.endsWith(" Weekly")
      ? [window.label.slice(0, -" Weekly".length)]
      : [],
  );

/**
 * One option per kind of grant (T3's `claudeResetCredits.ts`): a weekly reset refills the account's week, a
 * model-only one (Fable) only that model's. Each names the grant **Use** spends, so the two never mix.
 */
function resetOptions(
  grants: ReadonlyArray<ResetGrant>,
  windows: ReadonlyArray<UsageWindow>,
  now: number,
): ReadonlyArray<ResetOption> {
  const models = modelRowNames(windows);
  const kinds = new Map<string, { model: string | undefined; grants: ResetGrant[] }>();
  for (const grant of grants) {
    const expired = grant.expiries.length > 0 && grant.expiries.every((at) => at <= now);
    if (grant.id === undefined || grant.count < 1 || expired) continue;
    const label = grant.label.toLowerCase();
    const model = grant.modelOnly
      ? (models.find((name) => label.includes(name.toLowerCase())) ??
        (models.length === 1 ? models[0] : "Model"))
      : undefined;
    const kind = model ?? "";
    kinds.set(kind, { model, grants: [...(kinds.get(kind)?.grants ?? []), grant] });
  }
  return [...kinds.values()]
    .toSorted((left, right) => Number(left.model !== undefined) - Number(right.model !== undefined))
    .flatMap(({ model, grants: group }) => {
      const expiries = group
        .flatMap((grant) => grant.expiries)
        .filter((at) => Number.isFinite(at) && at > now)
        .toSorted((a, b) => a - b);
      const soonest = (grant: ResetGrant) =>
        grant.expiries.filter((at) => Number.isFinite(at)).toSorted((a, b) => a - b)[0] ??
        Number.POSITIVE_INFINITY;
      const chosen =
        group.find((grant) => grant.next) ??
        group.toSorted((left, right) => soonest(left) - soonest(right))[0];
      const creditId = chosen?.id;
      if (creditId === undefined) return [];
      const expiresAt = iso(expiries[0]);
      return [
        {
          creditId,
          label: model === undefined ? "Weekly reset" : `${model} reset`,
          description:
            model === undefined
              ? "Refills this account's weekly limit."
              : `Refills this account's ${model} allowance. It doesn't reset the whole week.`,
          availableCount: group.reduce((sum, grant) => sum + grant.count, 0),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
      ];
    });
}

/**
 * Banked resets (Anthropic's grants), with the one Anthropic redeems next as the credit id and, per kind, the
 * grant to spend: **Use** redeems it on this account's own sign-in (`limitSourcesLive.ts`), never Claude Code's.
 */
function resetCredits(
  account: Pick<AccountView, "resets" | "windows" | "nextResetId" | "grants">,
  now: number,
): ServerProviderUsageLimits["resetCredits"] {
  const all = [account.resets, ...account.windows.map((window) => window.resets)].filter(
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
  const options = resetOptions(account.grants ?? [], account.windows, now);
  return {
    availableCount,
    ...(next !== undefined ? { nextExpiresAt: next } : {}),
    ...(account.nextResetId !== undefined ? { nextCreditId: account.nextResetId } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
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

/** A Codex account's row id is this and its key; a Claude account's is its key. */
export const CODEX_ROW = "codex-";

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
    id: `${CODEX_ROW}${account.key}`,
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

/** OpenRouter's spend per key, for **Usage → Limits** on every client (lastdrop's own route is local-only). */
function usageKeys(
  keys: ReadonlyArray<KeyUsage> | undefined,
): Pick<UsageLimitSourceAccount, "keys"> {
  const shown = (keys ?? []).flatMap((key) => {
    const name = key.name.trim();
    return name === "" || !Number.isFinite(key.total) ? [] : [{ ...key, name }];
  });
  return shown.length === 0 ? {} : { keys: shown };
}

/** Each Claude account lastdrop knows, each Codex account, then each configured Z.ai/OpenRouter endpoint. */
export function lastdropLimitSource(input: {
  readonly accounts: AccountsView | undefined;
  readonly codex?: CodexAccountsView | undefined;
  readonly endpoints: EndpointsView | undefined;
  readonly now: number;
}): UsageLimitSourceSnapshot | undefined {
  const { now } = input;
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
        resets: resetCredits(account, now),
      }),
    ),
  }));
  const endpoints = (input.endpoints?.endpoints ?? [])
    .filter((endpoint) => endpoint.configured)
    .map((endpoint): UsageLimitSourceAccount => ({
      id: endpoint.title,
      driver: ENDPOINT_DRIVERS[endpoint.provider],
      ...(endpoint.usage?.plan ? { plan: endpoint.usage.plan } : {}),
      ...usageKeys(endpoint.usage?.keys),
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

/** Spends one banked reset on the account a row of this source names (its `id`). */
export type LastdropRedeemer = (
  accountId: string,
  creditId: string,
) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;

let redeemer: LastdropRedeemer | undefined;

/** Set by the publisher layer for its lifetime, like the feed; the returned function unsets it. */
export const setLastdropRedeemer = (next: LastdropRedeemer): (() => void) => {
  redeemer = next;
  return () => {
    if (redeemer === next) redeemer = undefined;
  };
};

export const lastdropRedeemer = (): LastdropRedeemer | undefined => redeemer;
