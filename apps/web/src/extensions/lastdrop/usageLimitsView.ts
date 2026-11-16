/**
 * Every account's limits, one entry each, for the Usage hover and **Usage → Limits**: T3's merged accounts plus
 * lastdrop's names and next-work badges, grouped by provider. Accounts and providers without a reading stay
 * listed with why, so nothing silently disappears.
 */
import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  formatResetsIn,
  type LimitAccount,
  limitsNotice,
  remainingPercent,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

import type { AccountView } from "./accountsView";
import type { CodexAccountView } from "./codexAccountsView";

/** lastdrop's endpoint drivers, which have no provider client of their own. */
const ENDPOINT_DRIVER_NAMES: Readonly<Record<string, string>> = {
  Zai: "Z.ai",
  OpenRouter: "OpenRouter",
};

/** Drivers whose T3 provider reads limits: one that is on but shows none says why. */
const LIMIT_DRIVERS = new Set(["codex", "claudeAgent", "antigravity"]);

const DRIVER_ORDER = ["claudeAgent", "codex", "antigravity", "Zai", "OpenRouter"];

export interface LimitMeter {
  readonly id: string;
  readonly label: string;
  readonly leftPercent: number;
  /** "Resets in 2h 30m", or null when unknown (or, on a model line, the same as the week's). */
  readonly resets: string | null;
}

export interface LimitEntry {
  readonly key: string;
  readonly name: string;
  /** The e-mail when the name is something else. */
  readonly detail: string | undefined;
  readonly plan: string | undefined;
  /** Session and the week, side by side. */
  readonly main: ReadonlyArray<LimitMeter>;
  /** Model weeks ("Weekly · Fable") and the rest, one slim line each. */
  readonly more: ReadonlyArray<LimitMeter>;
  /** Where new work goes now (lastdrop's Claude accounts). */
  readonly nextFor: ReadonlyArray<string>;
  /** Why there is no reading. */
  readonly notice: string | undefined;
  /** T3's account, for redeeming banked resets. */
  readonly account: LimitAccount | undefined;
}

export interface LimitGroup {
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly entries: ReadonlyArray<LimitEntry>;
}

const capitalized = (text: string | null) =>
  text === null ? null : text.charAt(0).toUpperCase() + text.slice(1);

/** "Claude Ultra Subscription" → "Ultra", "ChatGPT Plus Subscription" → "Plus"; others as they are. */
export function shortPlan(plan: string | undefined): string | undefined {
  const short = plan
    ?.replace(/^(claude|chatgpt|openai|google|antigravity)\s+/i, "")
    .replace(/\s+(subscription|plan)$/i, "")
    .trim();
  return short || plan;
}

const meter = (window: ServerProviderUsageWindow, now: number): LimitMeter => ({
  id: window.id,
  label: window.label,
  leftPercent: remainingPercent(window),
  resets: capitalized(formatResetsIn(window, now)),
});

/** The first session and the plain week go side by side; model weeks and the rest follow on their own lines. */
function splitWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): Pick<LimitEntry, "main" | "more"> {
  const session = windows.find((window) => window.kind === "session");
  const week = windows.find((window) => window.kind === "weekly" && !window.label.includes("·"));
  const main = [session, week].filter((window) => window !== undefined);
  const first = main.length > 0 ? main : windows.slice(0, 1);
  const weekReset = week?.resetsAt === undefined ? undefined : Date.parse(week.resetsAt);
  return {
    main: first.map((window) => meter(window, now)),
    more: windows
      .filter((window) => !first.includes(window))
      .map((window) => {
        const line = meter(window, now);
        const reset = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);
        const sameAsWeek =
          window.kind === "weekly" &&
          reset !== undefined &&
          weekReset !== undefined &&
          Math.abs(reset - weekReset) < 60_000;
        return sameAsWeek ? { ...line, resets: null } : line;
      }),
  };
}

const emailKey = (email: string | undefined) => email?.trim().toLowerCase();

export function limitGroups(input: {
  readonly presentations: LimitPresentations;
  readonly now: number;
  readonly driverLabel: (driver: ServerProvider["driver"]) => string | undefined;
  /** lastdrop's Claude accounts (`GET /api/lastdrop/accounts`), when this client can read them. */
  readonly lastdrop?: ReadonlyArray<AccountView> | undefined;
  /** lastdrop's Codex accounts (`GET /api/lastdrop/codex-accounts`), whose titles name their rows. */
  readonly lastdropCodex?:
    | ReadonlyArray<Pick<CodexAccountView, "key" | "title" | "email">>
    | undefined;
}): ReadonlyArray<LimitGroup> {
  const { presentations, now } = input;
  const named = new Map(
    (input.lastdrop ?? []).flatMap((account) =>
      account.email ? [[emailKey(account.email), account] as const] : [],
    ),
  );
  // A signed-out account has no e-mail; lastdrop's limit source ids its Claude rows by account key.
  const namedByKey = new Map(
    (input.lastdrop ?? []).map((account) => [account.key, account] as const),
  );
  const codexByEmail = new Map(
    (input.lastdropCodex ?? []).flatMap((account) =>
      account.email ? [[emailKey(account.email), account.title] as const] : [],
    ),
  );
  // lastdrop's limit source ids its Codex rows `codex-<key>` (the server's `limitSources.ts`).
  const codexById = new Map<string, string>(
    (input.lastdropCodex ?? []).map((account) => [`codex-${account.key}`, account.title] as const),
  );
  const groups = new Map<ServerProvider["driver"], LimitEntry[]>();
  const shown = new Set<string>();
  const add = (driver: ServerProvider["driver"], entry: LimitEntry, email?: string) => {
    const key = emailKey(email);
    if (key) shown.add(`${driver}:${key}`);
    groups.set(driver, [...(groups.get(driver) ?? []), entry]);
  };
  const isShown = (driver: ServerProvider["driver"], email: string | undefined) => {
    const key = emailKey(email);
    return key !== undefined && shown.has(`${driver}:${key}`);
  };
  const lastdropOf = (
    driver: ServerProvider["driver"],
    email: string | undefined,
    sourceId: string | undefined,
  ): Pick<AccountView, "name" | "plan" | "nextFor"> | undefined => {
    if (driver === "claudeAgent") {
      return (
        named.get(emailKey(email)) ??
        (sourceId === undefined ? undefined : namedByKey.get(sourceId))
      );
    }
    if (driver !== "codex") return undefined;
    const name =
      (sourceId === undefined ? undefined : codexById.get(sourceId)) ??
      codexByEmail.get(emailKey(email));
    return name === undefined ? undefined : { name };
  };
  const entry = (
    driver: ServerProvider["driver"],
    base: {
      key: string;
      name: string;
      email: string | undefined;
      plan: string | undefined;
      sourceId?: string;
    },
    rest: Pick<LimitEntry, "main" | "more" | "notice" | "account">,
  ): LimitEntry => {
    const known = lastdropOf(driver, base.email, base.sourceId);
    const name = known?.name ?? base.name;
    return {
      key: base.key,
      name,
      detail: base.email && base.email !== name ? base.email : undefined,
      plan: shortPlan(base.plan ?? known?.plan),
      nextFor: known?.nextFor ?? [],
      ...rest,
    };
  };

  for (const account of collectLimitAccounts(presentations)) {
    add(
      account.driver,
      entry(
        account.driver,
        {
          key: account.key,
          name: account.email ?? account.displayName ?? account.key,
          email: account.email,
          plan: account.plan,
        },
        { ...splitWindows(account.limits.windows, now), notice: undefined, account },
      ),
      account.email,
    );
  }

  const endpointIds = new Set<string>();
  for (const presentation of presentations.values()) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (account.driver in ENDPOINT_DRIVER_NAMES) endpointIds.add(account.id);
        const notice = limitsNotice(account.usageLimits);
        if (notice === null || isShown(account.driver, account.email)) continue;
        add(
          account.driver,
          entry(
            account.driver,
            {
              key: `${source.id}:${account.id}`,
              name: account.email ?? account.id,
              email: account.email,
              plan: account.plan,
              sourceId: account.id,
            },
            { main: [], more: [], notice, account: undefined },
          ),
          account.email,
        );
      }
    }
  }

  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!provider.enabled || !LIMIT_DRIVERS.has(provider.driver)) continue;
      // lastdrop's Z.ai and OpenRouter instances are Claude ones; their limits come from lastdrop's source.
      if (provider.displayName && endpointIds.has(provider.displayName)) continue;
      if (isShown(provider.driver, provider.auth.email)) continue;
      const notice = providerNotice(provider);
      if (notice === null) continue;
      // Only a provider nothing else covers: one row per driver for an anonymous, signed-out provider.
      if (!provider.auth.email && groups.has(provider.driver)) continue;
      const name = provider.displayName ?? input.driverLabel(provider.driver) ?? provider.driver;
      add(
        provider.driver,
        entry(
          provider.driver,
          {
            key: `${environmentId}:${provider.instanceId}`,
            name: provider.auth.email ?? name,
            email: provider.auth.email,
            plan: provider.auth.label,
          },
          { main: [], more: [], notice, account: undefined },
        ),
        provider.auth.email,
      );
    }
  }

  const rank = (driver: string) => {
    const index = DRIVER_ORDER.indexOf(driver);
    return index < 0 ? DRIVER_ORDER.length : index;
  };
  return [...groups]
    .toSorted(([left], [right]) => rank(left) - rank(right))
    .map(([driver, entries]) => ({
      driver,
      label: input.driverLabel(driver) ?? ENDPOINT_DRIVER_NAMES[driver] ?? String(driver),
      entries: entries.toSorted(
        (left, right) =>
          Number(left.notice !== undefined) - Number(right.notice !== undefined) ||
          left.name.localeCompare(right.name),
      ),
    }));
}

/** Why an enabled provider that reads limits shows none, or null when it isn't worth a line. */
function providerNotice(provider: ServerProvider): string | null {
  if (!provider.installed) return "Not installed.";
  if (provider.auth.status === "unauthenticated") return "Signed out.";
  if (provider.status === "error") return provider.message ?? "Unavailable.";
  if (provider.usageLimits === undefined) return "No limits read yet.";
  if (provider.usageLimits.unavailable?.reason === "unsupported") return null;
  return limitsNotice(provider.usageLimits);
}

/**
 * The list as one sentence for screen readers (the Usage button's description): each provider, each account and
 * its room per window, or why it has no reading.
 */
export function limitsSummary(groups: ReadonlyArray<LimitGroup>): string {
  if (groups.length === 0) return "No account reports limits yet.";
  return groups
    .map((group) => {
      const entries = group.entries.map((entry) => {
        const detail =
          entry.notice ??
          [...entry.main, ...entry.more]
            .map((meter) => `${meter.label} ${meter.leftPercent}% left`)
            .join(", ");
        const next = entry.nextFor.length > 0 ? ` (next for ${entry.nextFor.join(", ")})` : "";
        return detail ? `${entry.name}${next}: ${detail}` : `${entry.name}${next}`;
      });
      const text = `${group.label}: ${entries.join("; ")}`;
      return text.endsWith(".") ? text : `${text}.`;
    })
    .join(" ");
}
