/**
 * The user's agents from the fork's `agents.json` and `agent-models.json` (the standalone app's
 * catalog format), as the lastdrop provider's models: Claude's own first, then each enabled agent,
 * named and given efforts as the standalone ACP provider does.
 */
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";

/** Where an agent's entry runs, as the standalone app names it. */
export type AgentProvider = "claude" | "codex" | "zai" | "openrouter" | "antigravity";

export const AGENT_PROVIDERS: ReadonlyArray<AgentProvider> = [
  "claude",
  "codex",
  "zai",
  "openrouter",
  "antigravity",
];

export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  zai: "Z.ai",
  openrouter: "OpenRouter",
  antigravity: "Antigravity",
};

/**
 * The T3 instance each provider's entries run on. Z.ai and OpenRouter are Claude instances with
 * their endpoint in the instance's environment (step 6 makes them); while missing they are skipped.
 */
export const DEFAULT_INSTANCES: Record<AgentProvider, string> = {
  claude: "claudeAgent",
  codex: "codex",
  zai: "zai",
  openrouter: "openrouter",
  antigravity: "antigravity",
};

/** One entry of an agent's chain: a native T3 instance and its model. */
export interface AgentStep {
  readonly provider: AgentProvider;
  /** The T3 provider instance that runs this entry. */
  readonly instanceId: ProviderInstanceId;
  /** "Antigravity", "Claude"… */
  readonly providerLabel: string;
  readonly model: string;
  /** Fixed effort; absent means the run's effort option applies. */
  readonly effort?: string;
}

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  /** First entry is the agent's own provider and model; the rest are its fallbacks, in order. */
  readonly chain: ReadonlyArray<AgentStep>;
  /** One of Claude's own models (fable, opus…), listed before the user's agents. */
  readonly claudeModel?: boolean;
  /** The icon and color its subagents show, by the ids `client-runtime/src/extensions.ts` lists. */
  readonly icon?: string;
  readonly color?: string;
}

/** A chain entry's identity: instance, model and effort (the same model at two efforts differs). */
export const stepId = (step: AgentStep): string =>
  `${step.instanceId}/${step.model}/${step.effort ?? ""}`;

/** Efforts each provider's models took when the standalone app last listed them. */
export type ModelEfforts = Readonly<
  Record<string, ReadonlyArray<{ readonly id: string; readonly efforts: ReadonlyArray<string> }>>
>;

/** Claude Code's aliases, strongest first, and the model each stands for (`ClaudeBackend.aliases`). */
const CLAUDE_ALIASES: ReadonlyArray<readonly [alias: string, model: string]> = [
  ["fable", "claude-fable-5-2"],
  ["opus", "claude-opus-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["haiku", "claude-haiku-5-5"],
];

/** Levels lowest first, for the closest one a model offers. */
export const EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_LABEL: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The efforts a caller may give without asking the provider (`AgentProvider.callerEfforts`). */
export const CALLER_EFFORTS: Record<AgentProvider, ReadonlyArray<string>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  openrouter: ["low", "medium", "high", "xhigh", "max"],
  zai: ["low", "high", "max"],
  antigravity: ["low", "medium", "high", "xhigh", "max"],
};

/** Names Claude Code keeps for its own models; an agent under one is left out. */
const RESERVED = new Set(["sonnet", "opus", "haiku", "fable", "inherit", "best", "opusplan"]);
export const isReserved = (name: string): boolean =>
  RESERVED.has(name) || name.startsWith("claude-");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOr = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const isProvider = (value: unknown): value is AgentProvider =>
  typeof value === "string" && (AGENT_PROVIDERS as ReadonlyArray<string>).includes(value);

export type InstanceMap = Partial<Record<AgentProvider, string>>;

const makeStep = (
  provider: AgentProvider,
  model: string,
  effort: string | undefined,
  instances: InstanceMap,
): AgentStep => ({
  provider,
  instanceId: ProviderInstanceId.make(instances[provider] ?? DEFAULT_INSTANCES[provider]),
  providerLabel: PROVIDER_LABEL[provider],
  model,
  ...(effort === undefined ? {} : { effort }),
});

/**
 * The catalog file's agents. An agent the standalone app could not decode either (missing name,
 * unknown provider) is left out; a fallback with an unknown provider is dropped from its chain.
 */
export const parseCatalog = (
  json: unknown,
  instances: InstanceMap = {},
): ReadonlyArray<AgentDefinition> => {
  if (!isRecord(json) || !Array.isArray(json.agents)) return [];
  return json.agents.flatMap((raw): ReadonlyArray<AgentDefinition> => {
    if (!isRecord(raw)) return [];
    const name = stringOr(raw.name);
    const model = stringOr(raw.model);
    if (name === undefined || model === undefined || !isProvider(raw.provider)) return [];
    const fallbacks: ReadonlyArray<unknown> = Array.isArray(raw.fallbacks) ? raw.fallbacks : [];
    const chain = [
      makeStep(raw.provider, model, stringOr(raw.effort), instances),
      ...fallbacks.flatMap((entry) => {
        if (!isRecord(entry) || !isProvider(entry.provider)) return [];
        const fallbackModel = stringOr(entry.model);
        return fallbackModel === undefined
          ? []
          : [makeStep(entry.provider, fallbackModel, stringOr(entry.effort), instances)];
      }),
    ];
    const icon = stringOr(raw.icon);
    const color = stringOr(raw.color);
    return [
      {
        name,
        description: typeof raw.description === "string" ? raw.description : "",
        enabled: raw.enabled === true,
        chain,
        ...(icon === undefined ? {} : { icon }),
        ...(color === undefined ? {} : { color }),
      },
    ];
  });
};

/** `agent-models.json`: `{provider: {models: [{id, efforts}], updated}}`. */
export const parseModelEfforts = (json: unknown): ModelEfforts => {
  if (!isRecord(json)) return {};
  const out: Record<string, Array<{ id: string; efforts: ReadonlyArray<string> }>> = {};
  for (const [provider, entry] of Object.entries(json)) {
    if (!isRecord(entry) || !Array.isArray(entry.models)) continue;
    out[provider] = entry.models.flatMap((model: unknown) =>
      isRecord(model) && typeof model.id === "string" && Array.isArray(model.efforts)
        ? [
            {
              id: model.id,
              efforts: model.efforts.filter((e: unknown): e is string => typeof e === "string"),
            },
          ]
        : [],
    );
  }
  return out;
};

/** Claude's own models as agents of one entry each, on the Claude instance. */
const claudeModelAgents = (instances: InstanceMap = {}): ReadonlyArray<AgentDefinition> =>
  CLAUDE_ALIASES.map(([alias, model]) => ({
    name: alias,
    description: `${model} on your Claude accounts, the one with the most room.`,
    enabled: true,
    claudeModel: true,
    chain: [makeStep("claude", alias, undefined, instances)],
  }));

/** Every agent the provider runs: Claude's own first, then the catalog's enabled ones. */
export const allAgents = (
  catalog: ReadonlyArray<AgentDefinition>,
  instances: InstanceMap = {},
): ReadonlyArray<AgentDefinition> => [
  ...claudeModelAgents(instances),
  ...catalog.filter((agent) => agent.enabled && agent.chain.length > 0 && !isReserved(agent.name)),
];

/** "Claude Opus 5.5" for `opus` or `claude-opus-5-5`, "GPT-6.1 Sol", "Gemini 3.8 Flash" (`UsagePrice.displayName`). */
export const modelName = (model: string): string => {
  const id = CLAUDE_ALIASES.find(([alias]) => alias === model)?.[1] ?? model;
  if (id === "codex-auto-review") return "Codex review";
  const parts = id.split("-");
  const last = parts.at(-1);
  if (last !== undefined && last.length === 8 && /^\d+$/.test(last)) parts.pop();
  const cap = (part: string) => part.charAt(0).toUpperCase() + part.slice(1);
  switch (parts[0]) {
    case "claude":
      return parts.length < 2 ? id : `Claude ${cap(parts[1]!)} ${parts.slice(2).join(".")}`.trim();
    case "gpt":
      return parts.length < 2 ? id : [`GPT-${parts[1]}`, ...parts.slice(2).map(cap)].join(" ");
    case "gemini":
      return parts.map(cap).join(" ");
    default:
      return id.length === 0 ? "Unknown" : id;
  }
};

const bounded = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** "Codex · gpt-6.1-sol · high", as the agent's row writes an entry. */
export const stepLabel = (step: AgentStep): string =>
  [step.providerLabel, step.model, ...(step.effort === undefined ? [] : [step.effort])].join(" · ");

/** "Codex · gpt-6.1-sol, then Claude · opus" (`AgentDefinition.summary`). */
export const agentSummary = (agent: AgentDefinition): string =>
  agent.chain.map(stepLabel).join(", then ");

/** "build · Antigravity Claude Sonnet 5.5"; a Claude agent is "judge · Claude Fable 5.2". */
const agentDisplayName = (agent: AgentDefinition): string => {
  const first = agent.chain[0]!;
  const model = modelName(first.model);
  if (agent.claudeModel === true) return model;
  const runsOn = model.startsWith(`${first.providerLabel} `)
    ? model
    : `${first.providerLabel} ${model}`;
  return bounded(`${agent.name} · ${runsOn}`, 160);
};

/** The agent's role and chain, as the standalone ACP provider describes it. */
export const agentDescription = (agent: AgentDefinition): string =>
  bounded(`${agent.description} (${agentSummary(agent)})`, 1024);

const effortsOf = (step: AgentStep, known: ModelEfforts): ReadonlyArray<string> =>
  known[step.provider]?.find((model) => model.id === step.model)?.efforts ??
  CALLER_EFFORTS[step.provider];

/**
 * The efforts a caller may pick (`ACPServer.efforts(for:)`); undefined for none. A Claude model
 * takes every level. An agent takes one only without an effort of its own, and only a level every
 * entry of its chain that takes efforts takes. A first entry that takes none gives no option.
 */
export const agentEfforts = (
  agent: AgentDefinition,
  known: ModelEfforts,
): ReadonlyArray<string> | undefined => {
  if (agent.claudeModel === true) return CALLER_EFFORTS.claude;
  if (agent.chain[0]?.effort !== undefined) return undefined;
  const levels = agent.chain.map((step) => effortsOf(step, known));
  const first = levels[0];
  if (first === undefined || first.length === 0) return undefined;
  const common = levels
    .slice(1)
    .filter((entry) => entry.length > 0)
    .reduce<ReadonlyArray<string>>(
      (kept, next) => kept.filter((level) => next.includes(level)),
      first,
    );
  return common.length === 0 ? undefined : common;
};

/** The closest level `levels` offers to `chosen`: it, else the next lower, else the next higher. */
export const closestEffort = (
  chosen: string,
  levels: ReadonlyArray<string>,
): string | undefined => {
  if (levels.includes(chosen)) return chosen;
  const rank = (level: string) => (EFFORT_RANK as ReadonlyArray<string>).indexOf(level);
  const wanted = rank(chosen);
  if (wanted < 0) return undefined;
  const ranked = levels.map((level) => [level, rank(level)] as const).filter(([, r]) => r >= 0);
  const lower = ranked.filter(([, r]) => r < wanted).toSorted((a, b) => b[1] - a[1])[0];
  const higher = ranked.filter(([, r]) => r > wanted).toSorted((a, b) => a[1] - b[1])[0];
  return (lower ?? higher)?.[0];
};

/** Agent threads whose latest session runs on an entry past the first: agent → thread id → index. */
export type FallbackThreads = ReadonlyMap<string, Readonly<Record<string, number>>>;

/** How many fallback threads each agent's model lists: the recent ones a card or transcript shows. */
const FALLBACK_THREADS_LIMIT = 50;

/**
 * From the entry map (oldest first), each agent thread's latest entry when it is not the first of
 * its agent's chain. An entry no longer in the chain is left out.
 */
export const fallbackThreads = (
  agents: ReadonlyArray<AgentDefinition>,
  entries: ReadonlyArray<
    readonly [
      string,
      { readonly entry: string; readonly agent?: string; readonly appThreadId?: string },
    ]
  >,
): FallbackThreads => {
  const latest = new Map<string, { readonly agent: string; readonly entry: string }>();
  for (const [, value] of entries) {
    if (value.agent === undefined || value.appThreadId === undefined) continue;
    latest.delete(value.appThreadId);
    latest.set(value.appThreadId, { agent: value.agent, entry: value.entry });
  }
  const byAgent = new Map<string, Array<readonly [string, number]>>();
  for (const [threadId, { agent: name, entry }] of latest) {
    const agent = agents.find((candidate) => candidate.name === name);
    const index = agent?.chain.findIndex((step) => stepId(step) === entry) ?? -1;
    if (index <= 0) continue;
    const list = byAgent.get(name) ?? [];
    list.push([threadId, index]);
    byAgent.set(name, list);
  }
  return new Map(
    [...byAgent].map(([name, list]) => [
      name,
      Object.fromEntries(list.slice(-FALLBACK_THREADS_LIMIT)),
    ]),
  );
};

/** Compares two readings: equal when every agent lists the same threads on the same entries. */
export const fallbackSignature = (threads: FallbackThreads): string =>
  [...threads]
    .map(
      ([name, byThread]) =>
        `${name}:${Object.entries(byThread)
          .map(([threadId, index]) => `${threadId}=${index}`)
          .join(",")}`,
    )
    .join(";");

/** The lastdrop provider's models: Claude's first, then each agent, effort only when it may be picked. */
export const agentModels = (
  agents: ReadonlyArray<AgentDefinition>,
  known: ModelEfforts = {},
  onFallback: FallbackThreads = new Map(),
): ReadonlyArray<ServerProviderModel> =>
  agents
    .filter((agent) => agent.enabled && agent.chain.length > 0)
    .map((agent, index) => {
      const levels = agentEfforts(agent, known);
      const descriptors: Array<ProviderOptionDescriptor> =
        levels === undefined
          ? []
          : [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                role: "reasoning",
                description:
                  "An entry of the chain that doesn't offer this level runs at the closest one it does.",
                options: levels.map((level) => ({
                  id: level,
                  label: EFFORT_LABEL[level] ?? level,
                  ...(level === "high" ? { isDefault: true } : {}),
                })),
              },
            ];
      return {
        slug: agent.name,
        name: agentDisplayName(agent),
        shortName: agent.name,
        subProvider: agent.chain[0]!.providerLabel,
        isCustom: false,
        ...(index === 0 ? { isDefault: true } : {}),
        capabilities: { optionDescriptors: descriptors },
        lastdropAgent: {
          ...(agent.icon === undefined ? {} : { icon: agent.icon }),
          ...(agent.color === undefined ? {} : { color: agent.color }),
          chain: agent.chain.map((step) => ({
            instanceId: step.instanceId,
            model: step.model,
            ...(step.effort === undefined ? {} : { effort: step.effort }),
          })),
          ...(onFallback.has(agent.name) ? { fallbackThreads: onFallback.get(agent.name) } : {}),
        },
      } satisfies ServerProviderModel;
    });

export type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/** The reasoning option of an inner model, from the instance's own published model list. */
export const reasoningDescriptor = (
  innerModels: ReadonlyArray<ServerProviderModel> | undefined,
  model: string,
): SelectDescriptor | undefined => {
  const descriptors =
    innerModels?.find((entry) => entry.slug === model || entry.aliases?.includes(model))
      ?.capabilities?.optionDescriptors ?? [];
  return descriptors.find(
    (descriptor): descriptor is SelectDescriptor =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" ||
        descriptor.id === "effort" ||
        descriptor.id === "reasoningEffort"),
  );
};

/** The option id each driver reads effort from, when its published models don't say. */
const DEFAULT_EFFORT_OPTION: Partial<Record<AgentProvider, string>> = {
  claude: "effort",
  zai: "effort",
  openrouter: "effort",
  codex: "reasoningEffort",
};

/**
 * The selection the entry's instance gets: its instance and model, and the effort (fixed, or the
 * run's, moved to the closest level the inner model offers, under the inner option's id). Other
 * options are dropped: they were offered for our model.
 */
export const stepSelection = (
  step: AgentStep,
  outer: ModelSelection,
  innerModels?: ReadonlyArray<ServerProviderModel>,
): ModelSelection => {
  const asked = outer.options?.find((option) => option.id === "effort");
  const wanted = step.effort ?? (typeof asked?.value === "string" ? asked.value : undefined);
  const descriptor = reasoningDescriptor(innerModels, step.model);
  const optionId = descriptor?.id ?? DEFAULT_EFFORT_OPTION[step.provider];
  const effort =
    wanted === undefined || optionId === undefined
      ? undefined
      : descriptor === undefined
        ? wanted
        : closestEffort(
            wanted,
            descriptor.options.map((option) => option.id),
          );
  const options: ReadonlyArray<ProviderOptionSelection> =
    effort === undefined || optionId === undefined ? [] : [{ id: optionId, value: effort }];
  return {
    instanceId: step.instanceId,
    model: step.model,
    ...(options.length === 0 ? {} : { options }),
  } as ModelSelection;
};
