/**
 * What the hover on the sidebar's Usage icon lists: every account **Usage → Limits** pools (T3's own provider
 * accounts, hubs, and lastdrop's source with each Claude account, Z.ai and OpenRouter), grouped by provider,
 * each with its windows' room and reset. lastdrop's accounts without a reading (sign-in needed, a failed read)
 * follow with why, since T3's pools leave them out.
 */
import type { ServerProvider } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  formatResetsIn,
  limitsNotice,
  remainingPercent,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

/** lastdrop's usage limit source (server `extensions/lastdrop/limitSources.ts`). */
export const LASTDROP_SOURCE_ID = "lastdrop";

/** Names for lastdrop's endpoint drivers, which have no provider client of their own. */
const DRIVER_NAMES: Readonly<Record<string, string>> = { Zai: "Z.ai", OpenRouter: "OpenRouter" };

const WINDOW_ORDER = { session: 0, weekly: 1, monthly: 2, other: 3 } as const;

export interface HoverWindow {
  readonly id: string;
  readonly label: string;
  readonly leftPercent: number;
  readonly resets: string | null;
}

export interface HoverAccount {
  readonly key: string;
  readonly name: string;
  readonly plan: string | undefined;
  readonly windows: ReadonlyArray<HoverWindow>;
  /** Why there is no reading, for an account left out of T3's pools. */
  readonly notice?: string | undefined;
}

export interface HoverGroup {
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly accounts: ReadonlyArray<HoverAccount>;
}

export function usageHoverGroups(
  presentations: LimitPresentations,
  now: number,
  driverLabel: (driver: ServerProvider["driver"]) => string | undefined,
): ReadonlyArray<HoverGroup> {
  const groups = new Map<ServerProvider["driver"], HoverAccount[]>();
  const add = (driver: ServerProvider["driver"], account: HoverAccount) => {
    const list = groups.get(driver);
    if (list) list.push(account);
    else groups.set(driver, [account]);
  };
  const shown = new Set<string>();
  for (const account of collectLimitAccounts(presentations)) {
    if (account.email) shown.add(`${account.driver}:${account.email.toLowerCase()}`);
    add(account.driver, {
      key: account.key,
      name: account.email ?? account.displayName ?? account.key,
      plan: account.plan,
      windows: account.limits.windows
        .toSorted((left, right) => WINDOW_ORDER[left.kind] - WINDOW_ORDER[right.kind])
        .map((window) => ({
          id: window.id,
          label: window.label,
          leftPercent: remainingPercent(window),
          resets: formatResetsIn(window, now),
        })),
    });
  }
  for (const presentation of presentations.values()) {
    const source = presentation.serverConfig?.usageLimitSources?.find(
      (entry) => entry.id === LASTDROP_SOURCE_ID,
    );
    for (const account of source?.accounts ?? []) {
      const notice = limitsNotice(account.usageLimits);
      if (notice === null) continue;
      const seen = `${account.driver}:${(account.email ?? account.id).toLowerCase()}`;
      if (shown.has(seen)) continue;
      shown.add(seen);
      add(account.driver, {
        key: `${LASTDROP_SOURCE_ID}:${account.id}`,
        name: account.email ?? account.id,
        plan: account.plan,
        windows: [],
        notice,
      });
    }
  }
  return [...groups].map(([driver, accounts]) => ({
    driver,
    label: driverLabel(driver) ?? DRIVER_NAMES[driver] ?? String(driver),
    accounts: accounts.toSorted(
      (left, right) =>
        Number(left.notice !== undefined) - Number(right.notice !== undefined) ||
        left.name.localeCompare(right.name),
    ),
  }));
}
