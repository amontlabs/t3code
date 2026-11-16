/**
 * lastdrop's account list: each provider's pool in priority order and the thresholds work picks by (headroom's
 * `AccountsConfig`, `ClaudeAccountsConfig`). The format is the standalone app's `accounts.json` (dates in
 * seconds), so both apps share one list. File I/O is `@t3tools/lastdrop-node`'s.
 */

export const PROVIDERS = ["claude", "codex", "antigravity", "zai", "openrouter"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const MAIN_KEY = "main";
/**
 * Claude Code's own login (`~/.claude`), where Claude threads run while no fork account is signed in. Not an
 * account: never on the list, never read or renewed by lastdrop. A slug can't make it, so no key collides.
 */
export const TERMINAL_KEY = "@terminal";
export const DEFAULT_THRESHOLD = 0.9;

/**
 * One sign-in on one provider. Every Claude account keeps its own sign-in, Main included; another provider's
 * Main uses the login already on the Mac.
 */
export interface Account {
  readonly provider: ProviderId;
  /** Unique within the provider: "main", or a short name also used in folder and keychain names ("Pro"). */
  readonly key: string;
  /** What the panel calls it ("Pro", "Work"); undefined uses its plan. */
  readonly name?: string | undefined;
  /** Epoch ms. Main's is the distant past. */
  readonly addedAt: number;
  /** The Swift app's menu bar mode ("session", "weekly", "both"); kept as it is. */
  readonly menuBar?: string | undefined;
  /** Notify at this share used (0...1); undefined never. */
  readonly notifyAt?: number | undefined;
}

export interface AccountsConfig {
  readonly accounts: ReadonlyArray<Account>;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
}

/** Swift's `Date.distantPast`, in epoch ms. */
export const DISTANT_PAST = -62_135_769_600_000;

export const mainAccount = (provider: ProviderId): Account => ({
  provider,
  key: MAIN_KEY,
  addedAt: DISTANT_PAST,
  notifyAt: 1,
});

/** "claude.main", "codex.work": unique across providers. */
export const accountId = (a: Pick<Account, "provider" | "key">): string => `${a.provider}.${a.key}`;
export const isMain = (a: Pick<Account, "key">): boolean => a.key === MAIN_KEY;

/** "Pro" → "Pro"; "my work" → "my-work". Letters, digits, "-" and "_" only. */
export function slug(name: string): string {
  return name
    .trim()
    .split(/[^\p{L}\p{N}_-]/u)
    .filter((part) => part.length > 0)
    .join("-");
}

/** Every provider's main account but Claude's, and the default thresholds. */
export const emptyConfig = (): AccountsConfig =>
  normalize({
    accounts: [],
    sessionThreshold: DEFAULT_THRESHOLD,
    weeklyThreshold: DEFAULT_THRESHOLD,
  });

/** One provider's accounts, main included, in priority order. */
export const pool = (config: AccountsConfig, provider: ProviderId): ReadonlyArray<Account> =>
  config.accounts.filter((a) => a.provider === provider);

export const findAccount = (config: AccountsConfig, id: string): Account | undefined =>
  config.accounts.find((a) => accountId(a) === id);

/**
 * Drops duplicate accounts and adds a missing main account at the front of its pool, except Claude's: its
 * accounts are all the fork's own, and with none Claude threads run on Claude Code's own login.
 */
export function normalize(config: AccountsConfig): AccountsConfig {
  const seen = new Set<string>();
  const accounts = config.accounts.filter((a) => {
    const id = accountId(a);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const provider of PROVIDERS) {
    if (provider === "claude" || seen.has(accountId(mainAccount(provider)))) continue;
    const first = accounts.findIndex((a) => a.provider === provider);
    accounts.splice(first === -1 ? accounts.length : first, 0, mainAccount(provider));
  }
  return { ...config, accounts };
}

/** Puts `account` at the end of its provider's pool. */
export function append(config: AccountsConfig, account: Account): AccountsConfig {
  const accounts = [...config.accounts];
  const last = accounts.findLastIndex((a) => a.provider === account.provider);
  accounts.splice(last === -1 ? accounts.length : last + 1, 0, account);
  return { ...config, accounts };
}

/**
 * Adds an account at the end of its provider's pool. Undefined when the name has no usable characters, is
 * "main" outside Claude's pool, or is taken in that pool (compared ignoring case: folder names on macOS do).
 */
export function add(
  config: AccountsConfig,
  provider: ProviderId,
  name: string,
  now: number,
): { readonly config: AccountsConfig; readonly account: Account } | undefined {
  const key = slug(name);
  const lower = key.toLowerCase();
  if (!key || (lower === MAIN_KEY && provider !== "claude")) return undefined;
  if (pool(config, provider).some((a) => a.key.toLowerCase() === lower)) return undefined;
  const account: Account = { provider, key, addedAt: now, notifyAt: 1 };
  return { config: append(config, account), account };
}

/** A key no account of the provider has yet ("codex-2"). */
export function newKey(config: AccountsConfig, provider: ProviderId): string {
  const taken = new Set(pool(config, provider).map((a) => a.key.toLowerCase()));
  for (let n = 2; ; n++) if (!taken.has(`${provider}-${n}`)) return `${provider}-${n}`;
}

export function rename(config: AccountsConfig, id: string, name: string): AccountsConfig {
  const trimmed = name.trim();
  return update(config, id, (a) => ({ ...a, name: trimmed || undefined }));
}

export function update(
  config: AccountsConfig,
  id: string,
  change: (a: Account) => Account,
): AccountsConfig {
  return { ...config, accounts: config.accounts.map((a) => (accountId(a) === id ? change(a) : a)) };
}

/** Forgets an account. Another provider's main account can't be removed: it is the login already on the Mac. */
export const remove = (config: AccountsConfig, id: string): AccountsConfig => ({
  ...config,
  accounts: config.accounts.filter(
    (a) => accountId(a) !== id || (isMain(a) && a.provider !== "claude"),
  ),
});

/** Moves an account up (-1) or down (+1) its own pool; other providers' accounts don't count as steps. */
export function move(config: AccountsConfig, id: string, by: number): AccountsConfig {
  const account = findAccount(config, id);
  if (!account) return config;
  const own = [...pool(config, account.provider)];
  const i = own.indexOf(account);
  const j = i + by;
  if (j < 0 || j >= own.length) return config;
  [own[i], own[j]] = [own[j]!, own[i]!];
  let next = 0;
  return {
    ...config,
    accounts: config.accounts.map((a) => (a.provider === account.provider ? own[next++]! : a)),
  };
}

// MARK: The Claude pool, as the old claude-accounts.json shaped it

export interface ClaudeAccount {
  readonly id: string;
  readonly addedAt: number;
}

export interface ClaudeAccountsConfig {
  /** Accounts besides Main. */
  readonly accounts: ReadonlyArray<ClaudeAccount>;
  /** Priority order of account ids; always contains "main" exactly once once normalized. */
  readonly order: ReadonlyArray<string>;
  readonly sessionThreshold: number;
  readonly weeklyThreshold: number;
}

/** Keeps `order` consistent with `accounts`: drops unknown ids, appends missing ones, one "main". */
export function normalizeClaude(c: ClaudeAccountsConfig): ClaudeAccountsConfig {
  const seen = new Set<string>();
  const order = c.order.filter((id) => {
    if (seen.has(id)) return false;
    if (id !== MAIN_KEY && !c.accounts.some((a) => a.id === id)) return false;
    seen.add(id);
    return true;
  });
  if (!seen.has(MAIN_KEY)) order.unshift(MAIN_KEY);
  for (const a of c.accounts) if (!seen.has(a.id)) order.push(a.id);
  return { ...c, order };
}

/** Every account, Main included, in priority order. */
export function orderedClaude(c: ClaudeAccountsConfig): ReadonlyArray<ClaudeAccount> {
  return c.order.flatMap((id) => {
    if (id === MAIN_KEY) return [{ id, addedAt: DISTANT_PAST }];
    const found = c.accounts.find((a) => a.id === id);
    return found ? [found] : [];
  });
}

/** The Claude pool and the thresholds of `all`. */
export function claudeView(all: AccountsConfig): ClaudeAccountsConfig {
  const claude = pool(all, "claude");
  return normalizeClaude({
    accounts: claude.filter((a) => !isMain(a)).map((a) => ({ id: a.key, addedAt: a.addedAt })),
    order: claude.map((a) => a.key),
    sessionThreshold: all.sessionThreshold,
    weeklyThreshold: all.weeklyThreshold,
  });
}

/** The Claude pool becomes `claude`'s accounts and order, where the Claude pool was. */
export function replaceClaudePool(
  config: AccountsConfig,
  claude: ClaudeAccountsConfig,
): AccountsConfig {
  const normalized = normalizeClaude(claude);
  const at = Math.max(
    0,
    config.accounts.findIndex((a) => a.provider === "claude"),
  );
  // Keep what the list doesn't carry (name, menu bar, notifications) for the accounts that stay.
  const claudePool = orderedClaude(normalized).map(
    (c): Account =>
      config.accounts.find((a) => a.provider === "claude" && a.key === c.id) ?? {
        provider: "claude",
        key: c.id,
        addedAt: c.id === MAIN_KEY ? DISTANT_PAST : c.addedAt,
        notifyAt: 1,
      },
  );
  const others = config.accounts.filter((a) => a.provider !== "claude");
  others.splice(Math.min(at, others.length), 0, ...claudePool);
  return normalize({
    accounts: others,
    sessionThreshold: normalized.sessionThreshold,
    weeklyThreshold: normalized.weeklyThreshold,
  });
}

/** The Claude list from before there were pools: same accounts, order and thresholds. */
export const migrateClaudeAccounts = (old: ClaudeAccountsConfig): AccountsConfig =>
  replaceClaudePool(emptyConfig(), old);

// MARK: Files

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Decodes `accounts.json`. Undefined when it isn't an accounts file at all. Accounts of providers this build
 * doesn't know are left out; an account without `addedAt` gets `now`.
 */
export function decodeAccountsConfig(json: string, now: number): AccountsConfig | undefined {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(root)) return undefined;
  const accounts: Account[] = [];
  for (const raw of Array.isArray(root["accounts"]) ? root["accounts"] : []) {
    if (!isRecord(raw)) continue;
    const provider = PROVIDERS.find((p) => p === raw["provider"]);
    const key = str(raw["key"]);
    if (!provider || !key) continue;
    const added = num(raw["addedAt"]);
    accounts.push(
      dropUndefined({
        provider,
        key,
        name: str(raw["name"]),
        addedAt: added === undefined ? now : added * 1000,
        menuBar: str(raw["menuBar"]),
        notifyAt: num(raw["notifyAt"]),
      }),
    );
  }
  return normalize({
    accounts,
    sessionThreshold: num(root["sessionThreshold"]) ?? DEFAULT_THRESHOLD,
    weeklyThreshold: num(root["weeklyThreshold"]) ?? DEFAULT_THRESHOLD,
  });
}

/** Decodes the old `claude-accounts.json`. */
export function decodeClaudeAccountsConfig(
  json: string,
  now: number,
): ClaudeAccountsConfig | undefined {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(root)) return undefined;
  const accounts: ClaudeAccount[] = [];
  for (const raw of Array.isArray(root["accounts"]) ? root["accounts"] : []) {
    if (!isRecord(raw) || !str(raw["id"])) continue;
    const added = num(raw["addedAt"]);
    accounts.push({ id: raw["id"] as string, addedAt: added === undefined ? now : added * 1000 });
  }
  const order = Array.isArray(root["order"])
    ? root["order"].filter((id): id is string => typeof id === "string")
    : [MAIN_KEY];
  return {
    accounts,
    order,
    sessionThreshold: num(root["sessionThreshold"]) ?? DEFAULT_THRESHOLD,
    weeklyThreshold: num(root["weeklyThreshold"]) ?? DEFAULT_THRESHOLD,
  };
}

/** `accounts.json` as the Swift app writes it: sorted keys, two-space indent, dates in seconds. */
export function encodeAccountsConfig(config: AccountsConfig): string {
  const accounts = config.accounts.map((a) =>
    sortKeys(
      dropUndefined({
        addedAt: a.addedAt / 1000,
        key: a.key,
        menuBar: a.menuBar,
        name: a.name,
        notifyAt: a.notifyAt,
        provider: a.provider,
      }),
    ),
  );
  return JSON.stringify(
    {
      accounts,
      sessionThreshold: config.sessionThreshold,
      weeklyThreshold: config.weeklyThreshold,
    },
    null,
    2,
  );
}

/** Loads the list: `accounts.json`, else the old Claude list migrated (left on disk), else main accounts. */
export function loadAccountsConfig(
  files: { readonly accounts?: string | undefined; readonly legacy?: string | undefined },
  now: number,
): AccountsConfig {
  const current =
    files.accounts === undefined ? undefined : decodeAccountsConfig(files.accounts, now);
  if (current) return current;
  const old =
    files.legacy === undefined ? undefined : decodeClaudeAccountsConfig(files.legacy, now);
  return old ? migrateClaudeAccounts(old) : emptyConfig();
}

function sortKeys<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ) as T;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
