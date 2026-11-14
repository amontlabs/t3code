/**
 * Z.ai and OpenRouter: Claude Code on their Anthropic-compatible endpoints, and their usage. Port of the pure
 * parts of headroom's `EndpointProfile` (EndpointBackends.swift), `ZAIProvider`, `OpenRouterProvider` and the
 * endpoint error classes of `SubagentRunner.parse`. In the fork each provider is one T3 Claude instance whose
 * environment is `endpointEnvironment`; I/O is `@t3tools/lastdrop-node`'s.
 */
import type { UsageWindow } from "./usage.ts";
import { POOL_READING_VALID_MS } from "./usage.ts";

export const ENDPOINT_PROVIDERS = ["zai", "openrouter"] as const;
export type EndpointProvider = (typeof ENDPOINT_PROVIDERS)[number];

export const isEndpointProvider = (value: unknown): value is EndpointProvider =>
  value === "zai" || value === "openrouter";

export const ENDPOINT_TITLES: Readonly<Record<EndpointProvider, string>> = {
  zai: "Z.ai",
  openrouter: "OpenRouter",
};

export const ENDPOINT_BASE_URLS: Readonly<Record<EndpointProvider, string>> = {
  zai: "https://api.z.ai/api/anthropic",
  openrouter: "https://openrouter.ai/api",
};

/** Every model role Claude Code reads; the standalone pins each to the run's model. */
export const MODEL_VARIABLES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/**
 * Inherited variables that would send the run somewhere else or change it (the standalone runner scrubs every
 * inherited `ANTHROPIC_*`). A T3 instance can only set variables, so these are set empty, which Claude Code
 * reads as unset.
 */
export const SCRUBBED_VARIABLES = [
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_BETAS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_EFFORT",
  "MAX_THINKING_TOKENS",
] as const;

/** Z.ai's Coding Plan models and efforts (https://docs.z.ai/devpack/latest-model). */
export const ZAI_MODELS = ["glm-5.3", "glm-5.3-flash"] as const;
export const ZAI_EFFORTS = ["low", "high", "max"] as const;
export const ZAI_DEFAULT_EFFORT = "max";

/**
 * Auto mode's judge when the user chose none: a strong model, since a small one lets risky actions through
 * (2026-11-09: `glm-5.3-flash` allowed an SSH-key upload that `glm-5.3` blocked). OpenRouter has no fixed
 * list, so the agent's own model judges there.
 */
const DEFAULT_JUDGES: Readonly<Record<EndpointProvider, string | undefined>> = {
  zai: "glm-5.3",
  openrouter: undefined,
};

/** The model that judges actions for auto mode: the user's choice, else the provider's default. */
export const endpointJudge = (
  provider: EndpointProvider,
  model: string,
  setting?: string | undefined,
): string => setting ?? DEFAULT_JUDGES[provider] ?? model;

/**
 * The environment a run on the endpoint needs (`EndpointProfile.environment`). The key is never in it:
 * `ANTHROPIC_AUTH_TOKEN` stays empty and the profile's `apiKeyHelper` prints the key at launch.
 */
export function endpointEnvironment(input: {
  readonly provider: EndpointProvider;
  /** The model every role is pinned to; undefined leaves the roles (and the judge) to Claude Code. */
  readonly model: string | undefined;
  readonly judge?: string | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: ENDPOINT_BASE_URLS[input.provider],
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3000000",
  };
  if (input.model !== undefined) for (const key of MODEL_VARIABLES) env[key] = input.model;
  // Auto mode's server-side check never runs through these endpoints. Claude Code's own client-side check
  // does, through the same endpoint: on by this switch, judged by the chosen model.
  env.CLAUDE_CODE_AUTO_MODE_SERVER = "0";
  const judge =
    input.model === undefined
      ? (input.judge ?? DEFAULT_JUDGES[input.provider])
      : endpointJudge(input.provider, input.model, input.judge);
  if (judge !== undefined) env.CLAUDE_CODE_AUTO_MODE_MODEL = judge;
  return env;
}

/** What to tell the user when the provider has no key that can run models. */
export const missingKeyMessage = (provider: EndpointProvider): string =>
  provider === "zai"
    ? "Add a Z.ai Coding Plan API key in lastdrop's Settings."
    : "Add a regular OpenRouter API key in lastdrop's Settings. Management keys can't run models.";

// MARK: The T3 instance

/** The T3 instance id per provider: what the agents driver's targets map Z.ai and OpenRouter to. */
export const ENDPOINT_INSTANCE_IDS: Readonly<Record<EndpointProvider, string>> = {
  zai: "zai",
  openrouter: "openrouter",
};

/** Marks the instance as lastdrop's in T3's provider list. */
export const endpointInstanceName = (provider: EndpointProvider): string =>
  `${ENDPOINT_TITLES[provider]} (lastdrop)`;

export interface EndpointModel {
  readonly id: string;
  readonly name?: string | undefined;
  readonly efforts: ReadonlyArray<string>;
  readonly defaultEffort?: string | undefined;
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** A T3 custom model entry (`CustomModelEntry`) with an effort option when the model takes one. */
export function customModelEntry(model: EndpointModel): {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: {
    readonly optionDescriptors: ReadonlyArray<{
      readonly id: "effort";
      readonly label: "Reasoning";
      readonly type: "select";
      readonly options: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly isDefault?: boolean;
      }>;
    }>;
  };
} {
  const preferred =
    model.defaultEffort !== undefined && model.efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : undefined;
  return {
    slug: model.id,
    name: model.name ?? model.id,
    capabilities: {
      optionDescriptors:
        model.efforts.length === 0
          ? []
          : [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: model.efforts.map((effort) => ({
                  id: effort,
                  label: EFFORT_LABELS[effort] ?? effort,
                  ...(effort === preferred ? { isDefault: true } : {}),
                })),
              },
            ],
    },
  };
}

/** The models the instance offers: Z.ai's fixed list; on OpenRouter the catalog's models, from its list. */
export function endpointModels(
  provider: EndpointProvider,
  catalogModels: ReadonlyArray<string>,
  listed: ReadonlyArray<EndpointModel> = [],
): ReadonlyArray<EndpointModel> {
  if (provider === "zai") {
    const extra = catalogModels.filter((m) => !(ZAI_MODELS as ReadonlyArray<string>).includes(m));
    return [...ZAI_MODELS, ...extra].map((id) => ({
      id,
      efforts: ZAI_EFFORTS,
      defaultEffort: ZAI_DEFAULT_EFFORT,
    }));
  }
  return [...new Set(catalogModels)].map(
    (id) => listed.find((m) => m.id === id) ?? { id, efforts: [] },
  );
}

/** One environment entry of a T3 provider instance. */
export interface InstanceVariable {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
}

/** The T3 instance lastdrop keeps for the provider (a `ProviderInstanceConfig` as plain data). */
export interface EndpointInstance {
  readonly instanceId: string;
  readonly instance: {
    readonly driver: "claudeAgent";
    readonly displayName: string;
    readonly enabled: boolean;
    readonly environment: ReadonlyArray<InstanceVariable>;
    readonly config: {
      readonly homePath: string;
      readonly launchArgs: string;
      readonly customModels: ReadonlyArray<ReturnType<typeof customModelEntry>>;
      /** Marks the instance as lastdrop's (beside `ENDPOINT_MARKER` in its environment). */
      readonly lastdropEndpoint: EndpointProvider;
    };
  };
}

/**
 * The provider's instance: Claude Code in its own profile (`homePath`, which holds the key helper), with the
 * endpoint's environment. The same environment goes inline in `--settings`, so a project's
 * `.claude/settings.json` can't switch the endpoint (the standalone's `--settings` argument); inline, so no
 * file path can be split or go missing.
 */
export function endpointInstance(input: {
  readonly provider: EndpointProvider;
  readonly home: string;
  readonly model: string | undefined;
  readonly judge?: string | undefined;
  readonly models: ReadonlyArray<EndpointModel>;
  readonly enabled?: boolean | undefined;
}): EndpointInstance {
  const env = endpointEnvironment(input);
  const environment: Array<InstanceVariable> = [
    ...SCRUBBED_VARIABLES.map((name) => ({ name, value: "", sensitive: false })),
    ...Object.entries(env)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value, sensitive: false })),
    { name: ENDPOINT_MARKER, value: input.provider, sensitive: false },
  ];
  return {
    instanceId: ENDPOINT_INSTANCE_IDS[input.provider],
    instance: {
      driver: "claudeAgent",
      displayName: endpointInstanceName(input.provider),
      enabled: input.enabled ?? true,
      environment,
      config: {
        homePath: input.home,
        launchArgs: endpointLaunchArgs(env),
        customModels: input.models.map(customModelEntry),
        lastdropEndpoint: input.provider,
      },
    },
  };
}

/** `--settings '<json>'`: the environment above every settings file, quoted for T3's argument tokenizer. */
export const endpointLaunchArgs = (env: Readonly<Record<string, string>>): string =>
  `--settings ${shellQuote(JSON.stringify({ env }))}`;

// MARK: Telling lastdrop's instances apart

/**
 * The environment variable that marks a Claude process as running on lastdrop's Z.ai or OpenRouter instance.
 * Must hold for the query-runner wrapper (step 4): such a query is never given a Claude account.
 */
export const ENDPOINT_MARKER = "LASTDROP_ENDPOINT";

/** A Claude query's environment is one of lastdrop's endpoint instances (its marker, or our base URL). */
export function isLastdropEndpointEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  if (env === undefined) return false;
  if (isEndpointProvider(env[ENDPOINT_MARKER])) return true;
  const base = env.ANTHROPIC_BASE_URL;
  return base !== undefined && Object.values(ENDPOINT_BASE_URLS).includes(base);
}

/** A T3 provider instance (`ProviderInstanceConfig`) carries lastdrop's endpoint marker. */
export function isLastdropEndpointInstance(
  instance:
    | {
        readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
        readonly config?: unknown;
      }
    | undefined,
): boolean {
  if (instance === undefined) return false;
  const marked = instance.environment?.some(
    (v) => v.name === ENDPOINT_MARKER && isEndpointProvider(v.value),
  );
  const config = instance.config;
  return (
    marked === true ||
    (typeof config === "object" &&
      config !== null &&
      isEndpointProvider((config as Record<string, unknown>).lastdropEndpoint))
  );
}

/** The profile's own settings: only the key helper, never the key (`EndpointProfile.prepare`). */
export const profileSettingsJson = (helperCommand: string): string =>
  `${JSON.stringify({ apiKeyHelper: helperCommand }, null, 2)}\n`;

/** Single-quoted for a POSIX shell. */
export const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

// MARK: Errors

/**
 * How a failed run on the endpoint counts: true at a usage limit (move to the next entry), false when it isn't
 * one even though the endpoint said 429 (Z.ai's throttling), undefined to keep T3's own reading.
 * Z.ai business codes 1308/1310/1316–1321 are an exhausted window, 1302/1305 throttling; OpenRouter's 402 is
 * spent credit.
 */
const ZAI_EXHAUSTED = new Set([1308, 1310, 1316, 1317, 1318, 1319, 1320, 1321]);
const ZAI_THROTTLING = new Set([1302, 1305]);

/**
 * Z.ai's business codes as Claude Code reports them: the error body's `"code":"1308"` (or a number), or
 * `API Error: 1302` at the start of the text. A number elsewhere in the message ("1320 tokens") is not one.
 */
function zaiErrorCodes(message: string): ReadonlyArray<number> {
  const codes: number[] = [];
  for (const m of message.matchAll(/"code"\s*:\s*"?(\d{4})"?(?![0-9])/gu)) codes.push(Number(m[1]));
  const lead = /^\s*API Error:\s*(?:\d{3}\s+)?(\d{4})(?![0-9])/u.exec(message);
  if (lead) codes.push(Number(lead[1]));
  return codes;
}

export function endpointLimitReached(
  provider: EndpointProvider,
  failure: {
    readonly message?: string | undefined;
    readonly code?: string | null | undefined;
  },
): boolean | undefined {
  const message = failure.message ?? "";
  if (provider === "zai") {
    const codes = zaiErrorCodes(message);
    if (codes.some((c) => ZAI_THROTTLING.has(c))) return false;
    if (codes.some((c) => ZAI_EXHAUSTED.has(c))) return true;
    return undefined;
  }
  if (failure.code === "api_error_402") return true;
  if (/API Error:\s*402(?![0-9])|"code"\s*:\s*"?402(?![0-9])/u.test(message)) return true;
  if (/billing_error|payment_required|insufficient credits/iu.test(message)) return true;
  return undefined;
}

// MARK: Usage

/** A usage row as lastdrop shows it: a routing window plus words for rows that have no reset. */
export interface EndpointWindow extends UsageWindow {
  readonly detail?: string | undefined;
}

export interface KeyUsage {
  readonly name: string;
  readonly total: number;
  readonly today?: number | undefined;
  readonly month?: number | undefined;
  readonly limit?: number | undefined;
  readonly limitRemaining?: number | undefined;
  readonly disabled: boolean;
}

export interface EndpointUsage {
  readonly title: string;
  readonly plan?: string | undefined;
  readonly windows: ReadonlyArray<EndpointWindow>;
  readonly keys?: ReadonlyArray<KeyUsage> | undefined;
  /** The short text the standalone's menu bar showed ("$4.20"). */
  readonly summary?: string | undefined;
}

export type EndpointUsageErrorKind =
  | "notConfigured"
  | "unauthorized"
  | "http"
  | "invalid"
  | "management"
  | "message";

/** A failed read, with why (a plain `Error` carrying `kind`). */
export type EndpointUsageError = Error & { readonly kind: EndpointUsageErrorKind };

export const endpointUsageError = (
  kind: EndpointUsageErrorKind,
  message: string,
): EndpointUsageError => Object.assign(new Error(message), { kind });

export const isEndpointUsageError = (error: unknown): error is EndpointUsageError =>
  error instanceof Error && typeof (error as { kind?: unknown }).kind === "string";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const clamp = (n: number) => Math.min(Math.max(n, 0), 100);

/** Seconds or milliseconds since 1970 (headroom's `Dates.epoch`), as epoch ms. */
const epochMs = (value: unknown): number | undefined => {
  const n = num(value);
  if (n === undefined || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
};

/** Window length in hours from Z.ai's `(unit, number)`: 3 = hours, 4 = days, 5 = months, 6 = weeks. */
const zaiHours = (unit: number, n: number): number | undefined =>
  unit === 3
    ? n
    : unit === 4
      ? n * 24
      : unit === 5
        ? n * 24 * 30
        : unit === 6
          ? n * 24 * 7
          : undefined;

/** Z.ai's quota answer as rows (`ZAIProvider.windows`). */
export function zaiWindows(root: unknown): ReadonlyArray<EndpointWindow> {
  if (!isRecord(root)) throw endpointUsageError("invalid", "Z.ai returned no usage.");
  if (root.success === false) {
    throw endpointUsageError("message", str(root.msg) ?? "Z.ai returned an error.");
  }
  const container = isRecord(root.data) ? root.data : root;
  const limits = container.limits;
  if (!Array.isArray(limits)) throw endpointUsageError("invalid", "Z.ai returned no usage.");
  const entries = limits.filter(isRecord);
  const type = (e: Record<string, unknown>) => str(e.type) ?? str(e.name);
  const windows: EndpointWindow[] = [];
  for (const entry of entries) {
    const t = type(entry);
    if (t !== "CREDIT_LIMIT" && t !== "TOKENS_LIMIT") continue;
    const unit = num(entry.unit);
    const n = num(entry.number);
    const pct = num(entry.percentage);
    if (unit === undefined || n === undefined || n <= 0 || pct === undefined) continue;
    const hours = zaiHours(unit, n);
    if (hours === undefined) continue;
    windows.push({
      label: hours < 24 ? "Session" : "Weekly",
      usedPercent: clamp(pct),
      resetsAt: epochMs(entry.nextResetTime),
    });
  }
  const web = entries.find((e) => type(e) === "TIME_LIMIT");
  const used = num(web?.currentValue);
  const limit = num(web?.usage);
  if (web !== undefined && used !== undefined && limit !== undefined) {
    windows.push({
      label: "Web Searches",
      usedPercent: limit > 0 ? clamp((used / limit) * 100) : undefined,
      resetsAt: epochMs(web.nextResetTime),
      detail: `${Math.trunc(Math.max(limit - used, 0))} / ${Math.trunc(limit)} left`,
    });
  }
  return windows;
}

/** The Coding Plan's name from the subscription list, best effort. */
export function zaiPlan(root: unknown): string | undefined {
  if (!isRecord(root) || !Array.isArray(root.data)) return undefined;
  const first: unknown = root.data[0];
  const name = isRecord(first) ? str(first.productName) : undefined;
  return name === undefined || name === "" ? undefined : name;
}

export const dollars = (n: number): string => `$${n.toFixed(2)}`;

/** A management key is for provisioning, not model calls. */
export function isManagementKey(root: unknown): boolean {
  const data = isRecord(root) && isRecord(root.data) ? root.data : root;
  return isRecord(data) && (data.is_management_key === true || data.is_provisioning_key === true);
}

/** `GET /key` answered: the key may run models (`OpenRouterProvider.checkInferenceKey`). */
export function checkInferenceKey(root: unknown): void {
  if (!isRecord(root) || !isRecord(root.data)) {
    throw endpointUsageError("invalid", "OpenRouter returned no key.");
  }
  if (isManagementKey(root)) {
    throw endpointUsageError("management", missingKeyMessage("openrouter"));
  }
}

export function openRouterKey(d: unknown): KeyUsage | undefined {
  if (!isRecord(d)) return undefined;
  const usage = num(d.usage);
  if (usage === undefined) return undefined;
  const name = [str(d.name), str(d.label)].find((s) => s !== undefined && s !== "") ?? "Key";
  return {
    name,
    total: usage,
    today: num(d.usage_daily),
    month: num(d.usage_monthly),
    limit: num(d.limit),
    limitRemaining: num(d.limit_remaining),
    disabled: d.disabled === true,
  };
}

export function openRouterKeys(root: unknown): ReadonlyArray<KeyUsage> {
  if (!isRecord(root) || !Array.isArray(root.data)) return [];
  return root.data
    .map(openRouterKey)
    .filter((k): k is KeyUsage => k !== undefined)
    .toSorted((a, b) => b.total - a.total);
}

export function openRouterBalance(root: unknown): { total: number; used: number } | undefined {
  const data = isRecord(root) && isRecord(root.data) ? root.data : root;
  if (!isRecord(data)) return undefined;
  const used = num(data.total_usage);
  if (used === undefined) return undefined;
  return { total: Math.max(num(data.total_credits) ?? 0, 0), used: Math.max(used, 0) };
}

export function creditsWindow(balance: { total: number; used: number }): EndpointWindow {
  const left = Math.max(balance.total - balance.used, 0);
  return {
    label: "Credits",
    usedPercent: balance.total > 0 ? Math.min((balance.used / balance.total) * 100, 100) : 100,
    detail: `${dollars(left)} of ${dollars(balance.total)} left`,
  };
}

/** A regular key's own `GET /key` answer as usage. */
export function openRouterKeyUsage(one: KeyUsage): EndpointUsage {
  const windows: EndpointWindow[] = [];
  let summary: string | undefined;
  if (one.limitRemaining !== undefined) {
    const remaining = Math.max(one.limitRemaining, 0);
    summary = dollars(remaining);
    windows.push({
      label: "Credits",
      usedPercent:
        one.limit !== undefined && one.limit > 0
          ? clamp(((one.limit - one.limitRemaining) / one.limit) * 100)
          : undefined,
      detail: `${dollars(remaining)} left on this key`,
    });
  }
  return { title: "OpenRouter", windows, keys: [one], summary };
}

/** OpenRouter's model list, tool-capable models only (`OpenRouterBackend.decodeModels`). */
export function openRouterModels(root: unknown): ReadonlyArray<EndpointModel> {
  if (!isRecord(root) || !Array.isArray(root.data)) {
    throw endpointUsageError("invalid", "OpenRouter returned no models.");
  }
  return root.data
    .flatMap((entry): ReadonlyArray<EndpointModel> => {
      if (!isRecord(entry)) return [];
      const parameters = Array.isArray(entry.supported_parameters)
        ? entry.supported_parameters.filter((p): p is string => typeof p === "string")
        : [];
      const id = str(entry.id);
      if (!parameters.includes("tools") || id === undefined || id === "") return [];
      const reasoning = isRecord(entry.reasoning) ? entry.reasoning : undefined;
      const listed = Array.isArray(reasoning?.supported_efforts)
        ? reasoning.supported_efforts.filter((e): e is string => typeof e === "string")
        : undefined;
      const efforts = listed ?? (parameters.includes("reasoning") ? ["low", "medium", "high"] : []);
      const preferred = str(reasoning?.default_effort);
      return [
        {
          id,
          name: str(entry.name) ?? id,
          efforts,
          defaultEffort:
            preferred !== undefined && efforts.includes(preferred) ? preferred : undefined,
        },
      ];
    })
    .toSorted((a, b) =>
      (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { numeric: true }),
    );
}

// MARK: Room

/**
 * Until when the provider has no room for agents (epoch ms), from its last reading: a Session or Weekly row at
 * or over its threshold (until that row resets; a row past its reset counts as unused), or credits used up. Undefined when it has room, or when the
 * reading is too old to say (unknown usage never stops an agent; the endpoint answers at its limit).
 */
export function endpointOutUntil(
  reading: { readonly windows: ReadonlyArray<EndpointWindow>; readonly at: number } | undefined,
  thresholds: { readonly sessionThreshold: number; readonly weeklyThreshold: number },
  now: number,
): number | undefined {
  if (reading === undefined || now - reading.at >= POOL_READING_VALID_MS) return undefined;
  const fallback = reading.at + POOL_READING_VALID_MS;
  let until: number | undefined;
  for (const w of reading.windows) {
    if (w.usedPercent === undefined) continue;
    const limit =
      w.label === "Session"
        ? thresholds.sessionThreshold * 100
        : w.label === "Weekly"
          ? thresholds.weeklyThreshold * 100
          : w.label === "Credits"
            ? 100
            : undefined;
    if (limit === undefined || w.usedPercent < limit) continue;
    // Past its reset the window is unused again, as Claude's readings project it.
    if (w.resetsAt !== undefined && w.resetsAt <= now) continue;
    const end = w.resetsAt ?? fallback;
    until = until === undefined ? end : Math.max(until, end);
  }
  return until !== undefined && until > now ? until : undefined;
}
