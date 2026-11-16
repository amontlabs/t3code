/**
 * Z.ai and OpenRouter I/O (headroom's `EndpointProfile`, `ZAIProvider`, `OpenRouterProvider`): keys read from
 * the fork's own keychain service (written by `endpointKeys.ts`), each T3 instance's Claude Code profile, and
 * usage. The key never goes into a file or T3's settings: the profile's `apiKeyHelper` script reads it when
 * Claude Code starts.
 */
import * as NodeFSP from "node:fs/promises";

import {
  checkInferenceKey,
  creditsWindow,
  type EndpointModel,
  type EndpointProvider,
  type EndpointUsage,
  endpointUsageError,
  isEndpointUsageError,
  ENDPOINT_PROVIDERS,
  ENDPOINT_TITLES,
  dollars,
  isManagementKey,
  missingKeyMessage,
  openRouterBalance,
  openRouterKey,
  openRouterKeys,
  openRouterKeyUsage,
  openRouterModels,
  profileSettingsJson,
  shellQuote,
  zaiPlan,
  zaiWindows,
} from "@t3tools/lastdrop-core";

import type { FetchLike } from "./claudeUsage.ts";
import { exists, readText, writeAtomic } from "./files.ts";
import { probeOwnKeychain, readOwnKeychain } from "./keychain.ts";
import type { LastdropPaths } from "./paths.ts";

/** The fork's keychain service: its items are never the standalone app's. */
export const KEYCHAIN_SERVICE = "t3code-lastdrop";
export const KEY_ITEMS: Readonly<Record<EndpointProvider, string>> = {
  zai: "zai-api-key",
  openrouter: "openrouter-api-key",
};
const ZAI_SESSION_ITEM = "zai-session";
const ZAI_ENV_KEYS = ["ZAI_API_KEY", "GLM_API_KEY"] as const;
const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";

const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";
const OPENROUTER_API = "https://openrouter.ai/api/v1";

type Env = Readonly<Record<string, string | undefined>>;

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

async function readOwn(paths: LastdropPaths, item: string): Promise<string | undefined> {
  return trimmed(await readOwnKeychain(paths.security, KEYCHAIN_SERVICE, item));
}

/** `~/.config/zai/key.json`: `{apiKey}`, `{api_key}`, `{key}`, or the key as plain text. */
async function zaiKeyFile(paths: LastdropPaths): Promise<string | undefined> {
  const text = await readText(`${paths.home}/.config/zai/key.json`);
  if (text === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(text);
    if (typeof json === "object" && json !== null) {
      for (const k of ["apiKey", "api_key", "key"]) {
        const v = (json as Record<string, unknown>)[k];
        if (typeof v === "string" && trimmed(v)) return trimmed(v);
      }
      return undefined;
    }
  } catch {
    // Not JSON: the key as plain text.
  }
  return trimmed(text);
}

/**
 * The main account's key that runs models: lastdrop's keychain item, then Z.ai's key file and
 * `ZAI_API_KEY`/`GLM_API_KEY`, or `OPENROUTER_API_KEY`.
 */
export async function endpointApiKey(
  provider: EndpointProvider,
  paths: LastdropPaths,
  env: Env = {},
): Promise<string | undefined> {
  const found = await lookupEndpointKey(provider, paths, env);
  return found.state === "found" ? found.key : undefined;
}

/**
 * The key, or why there's none: `missing` only when every place definitely has none; `unreadable` when the
 * keychain couldn't be read (locked, timed out) and no fallback had a key. Only `missing` may remove an
 * instance.
 */
export type KeyLookup =
  | { readonly state: "found"; readonly key: string }
  | { readonly state: "missing" }
  | { readonly state: "unreadable" };

export async function lookupEndpointKey(
  provider: EndpointProvider,
  paths: LastdropPaths,
  env: Env = {},
): Promise<KeyLookup> {
  const read = await probeOwnKeychain(paths.security, KEYCHAIN_SERVICE, KEY_ITEMS[provider]);
  if (read.state === "found") return { state: "found", key: read.value };
  const fallback = await fallbackEndpointKey(provider, paths, env);
  if (fallback !== undefined) return { state: "found", key: fallback };
  return read.state === "unreadable" ? { state: "unreadable" } : { state: "missing" };
}

/** The key from outside the keychain: Z.ai's key file and `ZAI_API_KEY`/`GLM_API_KEY`, or `OPENROUTER_API_KEY`. */
export async function fallbackEndpointKey(
  provider: EndpointProvider,
  paths: LastdropPaths,
  env: Env = {},
): Promise<string | undefined> {
  return provider === "zai"
    ? ((await zaiKeyFile(paths)) ??
        ZAI_ENV_KEYS.map((name) => trimmed(env[name])).find((k) => k !== undefined))
    : trimmed(env[OPENROUTER_ENV_KEY]);
}

/** Z.ai's usage authorization: the web session lastdrop keeps, else the API key. */
async function zaiAuthorization(
  paths: LastdropPaths,
  env: Env,
): Promise<{ header: string; isSession: boolean } | undefined> {
  const session = await readOwn(paths, ZAI_SESSION_ITEM);
  if (session !== undefined) return { header: session, isSession: true };
  const key = await endpointApiKey("zai", paths, env);
  return key === undefined ? undefined : { header: `Bearer ${key}`, isSession: false };
}

// MARK: Profile

/** The fork's profile folder for the provider (the standalone keeps its own in its support folder). */
export const endpointDirectory = (paths: LastdropPaths, provider: EndpointProvider): string =>
  `${paths.dataDir}/endpoints/${provider}`;
export const keyHelperPath = (paths: LastdropPaths): string =>
  `${paths.dataDir}/endpoints/key-helper`;

/**
 * The key helper: prints the provider's key from the keychain (base64, as lastdrop stores it), else the same
 * fallbacks as `endpointApiKey`. Claude Code runs it at launch and on a 401.
 */
export function keyHelperScript(paths: LastdropPaths): string {
  const security = shellQuote(paths.security);
  const keyFile = shellQuote(`${paths.home}/.config/zai/key.json`);
  return `#!/bin/sh
# lastdrop (T3 Code fork): prints the Z.ai or OpenRouter key for Claude Code's apiKeyHelper.
# Reads the fork's keychain item (service ${KEYCHAIN_SERVICE}); never stores the key.
case "$1" in
  zai) item=${KEY_ITEMS.zai} ;;
  openrouter) item=${KEY_ITEMS.openrouter} ;;
  *) echo "usage: key-helper zai|openrouter" >&2; exit 2 ;;
esac
encoded=$(${security} find-generic-password -s ${KEYCHAIN_SERVICE} -a "$item" -w 2>/dev/null)
if [ -n "$encoded" ]; then
  key=$(printf '%s' "$encoded" | /usr/bin/base64 -D 2>/dev/null)
  if [ -n "$key" ]; then printf '%s\\n' "$key"; exit 0; fi
fi
if [ "$1" = zai ]; then
  if [ -f ${keyFile} ]; then
    for field in apiKey api_key key; do
      key=$(/usr/bin/plutil -extract "$field" raw -o - ${keyFile} 2>/dev/null)
      if [ -n "$key" ]; then printf '%s\\n' "$key"; exit 0; fi
    done
    if ! /usr/bin/grep -q '{' ${keyFile}; then
      key=$(/usr/bin/tr -d ' \\n\\r\\t' < ${keyFile})
      if [ -n "$key" ]; then printf '%s\\n' "$key"; exit 0; fi
    fi
  fi
  for key in "$ZAI_API_KEY" "$GLM_API_KEY"; do
    if [ -n "$key" ]; then printf '%s\\n' "$key"; exit 0; fi
  done
  echo ${shellQuote(missingKeyMessage("zai"))} >&2
else
  if [ -n "$OPENROUTER_API_KEY" ]; then printf '%s\\n' "$OPENROUTER_API_KEY"; exit 0; fi
  echo ${shellQuote(missingKeyMessage("openrouter"))} >&2
fi
exit 1
`;
}

/** Only non-secret, useful context is shared with the user's Claude profile. */
const SHARED_ITEMS = ["agents", "skills", "CLAUDE.md", "commands"] as const;

/**
 * Makes the provider's Claude Code profile (`EndpointProfile.prepare`): its own `settings.json` holding only
 * the key helper (a stale symlink is replaced, never written through), onboarding marked done, links to the
 * user's agents, skills, CLAUDE.md and commands. Writes only what differs.
 */
export async function prepareEndpointProfile(input: {
  readonly paths: LastdropPaths;
  readonly provider: EndpointProvider;
}): Promise<void> {
  const { paths, provider } = input;
  const dir = endpointDirectory(paths, provider);
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  const helper = keyHelperPath(paths);
  const script = keyHelperScript(paths);
  if ((await readText(helper)) !== script) await writeAtomic(helper, script, 0o700);
  const settings = `${dir}/settings.json`;
  const settingsText = profileSettingsJson(`${shellQuote(helper)} ${provider}`);
  const stat = await NodeFSP.lstat(settings).catch(() => undefined);
  if (stat?.isSymbolicLink()) await NodeFSP.rm(settings);
  if (stat?.isSymbolicLink() || (await readText(settings)) !== settingsText) {
    await writeAtomic(settings, settingsText);
  }
  const state = `${dir}/.claude.json`;
  let onboarding: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse((await readText(state)) ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      onboarding = parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable: start over.
  }
  if (onboarding.hasCompletedOnboarding !== true) {
    await writeAtomic(state, JSON.stringify({ ...onboarding, hasCompletedOnboarding: true }));
  }
  for (const item of SHARED_ITEMS) {
    const source = `${paths.sharedClaude}/${item}`;
    const target = `${dir}/${item}`;
    if (!(await exists(source)) || (await exists(target))) continue;
    await NodeFSP.symlink(source, target);
  }
  // The environment now goes inline in the instance's `--settings`; an older build's file goes.
  await NodeFSP.rm(`${dir}/session-settings.json`, { force: true });
}

// MARK: Usage

async function getJson(
  fetch: FetchLike,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw endpointUsageError(
      "http",
      `Couldn't reach ${new URL(url).host}: ${(error as Error).message}`,
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

const ok = (status: number) => status >= 200 && status < 300;

/** Z.ai's Coding Plan usage (`ZAIProvider.fetch`). */
export async function fetchZaiUsage(
  fetch: FetchLike,
  paths: LastdropPaths,
  env: Env = {},
): Promise<EndpointUsage> {
  const auth = await zaiAuthorization(paths, env);
  if (auth === undefined)
    throw endpointUsageError("notConfigured", "Add the Z.ai key in Settings → Providers → Claude.");
  const headers = { Authorization: auth.header, Accept: "application/json" };
  const { status, body } = await getJson(fetch, ZAI_QUOTA_URL, headers);
  if (status === 401 || status === 403) {
    throw endpointUsageError(
      "unauthorized",
      auth.isSession
        ? "Z.ai session expired. Sign in again in Settings → Providers → Claude."
        : "Z.ai API key invalid. Check it in Settings → Providers → Claude.",
    );
  }
  if (!ok(status)) throw endpointUsageError("http", `Z.ai answered HTTP ${status}.`);
  const windows = zaiWindows(body);
  let plan: string | undefined;
  try {
    const sub = await getJson(fetch, ZAI_SUBSCRIPTION_URL, headers);
    if (ok(sub.status)) plan = zaiPlan(sub.body);
  } catch {
    // The plan's name is best effort.
  }
  return { title: ENDPOINT_TITLES.zai, plan, windows };
}

/**
 * OpenRouter's credit (`OpenRouterProvider.fetch`): a regular key reports itself; a management key shows the
 * account's balance and keys (and can't run agents).
 */
export async function fetchOpenRouterUsage(fetch: FetchLike, key: string): Promise<EndpointUsage> {
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const own = await getJson(fetch, `${OPENROUTER_API}/key`, headers);
  const data =
    typeof own.body === "object" && own.body !== null
      ? (own.body as Record<string, unknown>).data
      : undefined;
  if (ok(own.status) && !isManagementKey(own.body)) {
    const one = openRouterKey(data);
    if (one === undefined) throw endpointUsageError("invalid", "OpenRouter returned no key.");
    return openRouterKeyUsage(one);
  }
  if (isManagementKey(own.body) || own.status === 401 || own.status === 403) {
    const credits = await getJson(fetch, `${OPENROUTER_API}/credits`, headers);
    if (credits.status === 401) {
      throw endpointUsageError(
        "unauthorized",
        "OpenRouter API key invalid. Check it in Settings → Providers → Claude.",
      );
    }
    if (!ok(credits.status))
      throw endpointUsageError("http", `OpenRouter answered HTTP ${credits.status}.`);
    const balance = openRouterBalance(credits.body);
    const keys = await getJson(fetch, `${OPENROUTER_API}/keys`, headers).catch(() => undefined);
    return {
      title: ENDPOINT_TITLES.openrouter,
      windows: balance === undefined ? [] : [creditsWindow(balance)],
      keys: keys !== undefined && ok(keys.status) ? openRouterKeys(keys.body) : [],
      summary:
        balance === undefined ? undefined : dollars(Math.max(balance.total - balance.used, 0)),
    };
  }
  throw endpointUsageError("http", `OpenRouter answered HTTP ${own.status}.`);
}

/** Whether the key can run models (`OpenRouterProvider.validateInferenceKey`); throws why not. */
export async function validateOpenRouterKey(fetch: FetchLike, key: string): Promise<void> {
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const own = await getJson(fetch, `${OPENROUTER_API}/key`, headers);
  if (ok(own.status)) return checkInferenceKey(own.body);
  if (own.status === 401 || own.status === 403) {
    const credits = await getJson(fetch, `${OPENROUTER_API}/credits`, headers);
    if (ok(credits.status)) {
      throw endpointUsageError("management", missingKeyMessage("openrouter"));
    }
    throw endpointUsageError(
      "unauthorized",
      "OpenRouter authentication failed. Check the regular API key in Settings → Providers → Claude.",
    );
  }
  throw endpointUsageError("http", `OpenRouter answered HTTP ${own.status}.`);
}

/** OpenRouter's public model list, tool-capable models only. */
export async function fetchOpenRouterModels(
  fetch: FetchLike,
): Promise<ReadonlyArray<EndpointModel>> {
  const { status, body } = await getJson(fetch, `${OPENROUTER_API}/models`, {
    Accept: "application/json",
  });
  if (!ok(status)) throw endpointUsageError("http", `OpenRouter answered HTTP ${status}.`);
  return openRouterModels(body);
}

// MARK: Monitor

/** Usage is read this often, as the standalone's app refresh. */
export const ENDPOINT_USAGE_REFRESH_MS = 5 * 60_000;
const MODELS_REFRESH_MS = 60 * 60_000;

/** What lastdrop knows about one provider. Never holds the key. */
export interface EndpointState {
  readonly provider: EndpointProvider;
  /**
   * This pass's answer: a key is there, there definitely is none, or the keychain couldn't be read (locked,
   * timed out). Only `absent` may remove the instance; `unknown` keeps everything as it was.
   */
  readonly presence: "configured" | "absent" | "unknown";
  /** A key was there at the last definite answer. */
  readonly configured: boolean;
  /** Why agents can't run on it although a key is there: only a definite management key, kept across failures. */
  readonly problem?: string | undefined;
  readonly usage?: EndpointUsage | undefined;
  /** When `usage` was read, epoch ms. */
  readonly readAt?: number | undefined;
  readonly error?: string | undefined;
}

export interface EndpointMonitorOptions {
  readonly paths: LastdropPaths;
  readonly fetch: FetchLike;
  readonly env?: Env;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Reads each provider's key presence every pass and its usage every 5 minutes. */
export class EndpointMonitor {
  private readonly options: EndpointMonitorOptions;
  private readonly now: () => number;
  private readonly states = new Map<EndpointProvider, EndpointState & { attemptedAt?: number }>();
  private models: { at: number; list: ReadonlyArray<EndpointModel> } | undefined;
  private modelsTriedAt: number | undefined;

  constructor(options: EndpointMonitorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  state(provider: EndpointProvider): EndpointState {
    const { attemptedAt: _a, ...state } = this.states.get(provider) ?? {
      provider,
      presence: "unknown",
      configured: false,
    };
    return state;
  }

  all(): ReadonlyArray<EndpointState> {
    return ENDPOINT_PROVIDERS.map((p) => this.state(p));
  }

  /**
   * OpenRouter's listed models, read at most hourly. A failed read keeps the last good list (and tries again
   * next pass, not in an hour); undefined until one read has succeeded, so nothing is written on no data.
   */
  async openRouterModels(): Promise<ReadonlyArray<EndpointModel> | undefined> {
    const now = this.now();
    if (this.models !== undefined && now - this.models.at < MODELS_REFRESH_MS) {
      return this.models.list;
    }
    if (this.modelsTriedAt !== undefined && now - this.modelsTriedAt < 60_000)
      return this.models?.list;
    this.modelsTriedAt = now;
    try {
      this.models = { at: now, list: await fetchOpenRouterModels(this.options.fetch) };
    } catch (error) {
      this.options.log?.(`OpenRouter models: ${(error as Error).message}`);
    }
    return this.models?.list;
  }

  /** One pass over both providers. */
  async refresh(force = false): Promise<ReadonlyArray<EndpointState>> {
    await Promise.all(ENDPOINT_PROVIDERS.map((p) => this.refreshOne(p, force)));
    return this.all();
  }

  private async refreshOne(provider: EndpointProvider, force: boolean): Promise<void> {
    const { paths, fetch } = this.options;
    const env = this.options.env ?? {};
    const previous = this.states.get(provider);
    const lookup = await lookupEndpointKey(provider, paths, env);
    const now = this.now();
    if (lookup.state === "missing") {
      this.states.set(provider, { provider, presence: "absent", configured: false });
      return;
    }
    if (lookup.state === "unreadable") {
      // Keep everything as it was; only say this pass couldn't tell.
      this.options.log?.(
        `${ENDPOINT_TITLES[provider]}: keychain unreadable; keeping the instance as is`,
      );
      this.states.set(provider, {
        ...(previous ?? { provider, configured: false }),
        presence: "unknown",
      });
      return;
    }
    const key = lookup.key;
    const keyChanged = previous?.configured !== true;
    if (
      !force &&
      !keyChanged &&
      previous?.attemptedAt !== undefined &&
      now - previous.attemptedAt < ENDPOINT_USAGE_REFRESH_MS
    ) {
      this.states.set(provider, { ...previous, presence: "configured" });
      return;
    }
    let problem = keyChanged ? undefined : previous?.problem;
    let usage = previous?.usage;
    let readAt = previous?.readAt;
    let error: string | undefined;
    try {
      usage =
        provider === "zai"
          ? await fetchZaiUsage(fetch, paths, env)
          : await fetchOpenRouterUsage(fetch, key);
      readAt = now;
    } catch (e) {
      error = (e as Error).message;
    }
    if (provider === "openrouter") {
      try {
        await validateOpenRouterKey(fetch, key);
        problem = undefined;
      } catch (e) {
        // Only a definite management key stops the instance; an outage, a 401 or an odd answer keeps the last word.
        if (isEndpointUsageError(e) && e.kind === "management") problem = e.message;
      }
    }
    if (error !== undefined) this.options.log?.(`${ENDPOINT_TITLES[provider]} usage: ${error}`);
    this.states.set(provider, {
      provider,
      presence: "configured",
      configured: true,
      problem,
      usage,
      readAt,
      error,
      attemptedAt: now,
    });
  }
}

/** The pure endpoint parts the server uses (it depends on this package only). */
export {
  ENDPOINT_INSTANCE_IDS,
  ENDPOINT_PROVIDERS,
  ENDPOINT_TITLES,
  type EndpointInstance,
  type EndpointModel,
  type EndpointProvider,
  type EndpointUsage,
  type EndpointWindow,
  endpointEnvironment,
  endpointInstance,
  endpointLimitReached,
  endpointModels,
  endpointOutUntil,
  ENDPOINT_MARKER,
  isEndpointProvider,
  isLastdropEndpointEnvironment,
  isLastdropEndpointInstance,
} from "@t3tools/lastdrop-core";
