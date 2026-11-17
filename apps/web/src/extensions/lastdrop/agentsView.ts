/**
 * The agents editor's data as `GET /api/lastdrop/agents` sends it (the server's `AgentsView`, kept here so
 * the web needs no dependency on the server's packages), and the pure parts of editing a list.
 */
export type AgentProvider = "claude" | "codex" | "zai" | "openrouter" | "antigravity";

export interface AgentEntry {
  readonly provider: AgentProvider;
  readonly model: string;
  readonly effort?: string;
}

export interface AgentRecord extends AgentEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly fallbacks: ReadonlyArray<AgentEntry>;
  /** Ids from `agentLook.ts`; absent is the plain look. */
  readonly icon?: string;
  readonly color?: string;
}

export interface ModelChoice {
  readonly id: string;
  readonly name: string;
  readonly efforts: ReadonlyArray<string>;
}

export interface ProviderChoice {
  readonly provider: AgentProvider;
  readonly label: string;
  readonly available: boolean;
  readonly models: ReadonlyArray<ModelChoice>;
  /** Efforts for a model typed in by hand. */
  readonly efforts: ReadonlyArray<string>;
}

export interface AgentsEditorView {
  readonly agents: ReadonlyArray<AgentRecord>;
  readonly revision: number;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly canImport: boolean;
  readonly problem?: string;
}

/** The server's limits (`catalogEdit.ts`). */
export const MAX_FALLBACKS = 7;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export const EFFORT_LABEL: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const providerLabel = (
  providers: ReadonlyArray<ProviderChoice>,
  provider: AgentProvider,
): string => providers.find((choice) => choice.provider === provider)?.label ?? provider;

/** "Codex · gpt-6.1-sol · high". */
export const entryLabel = (providers: ReadonlyArray<ProviderChoice>, entry: AgentEntry): string =>
  [
    providerLabel(providers, entry.provider),
    entry.model,
    ...(entry.effort === undefined ? [] : [entry.effort]),
  ].join(" · ");

/** The first entry that can run now, else the first. */
const defaultProvider = (providers: ReadonlyArray<ProviderChoice>): AgentProvider =>
  (providers.find((choice) => choice.available) ?? providers[0])?.provider ?? "claude";

export const blankEntry = (provider: AgentProvider): AgentEntry => ({ provider, model: "" });

export const blankAgent = (providers: ReadonlyArray<ProviderChoice>): AgentRecord => ({
  id: "",
  name: "",
  description: "",
  enabled: true,
  ...blankEntry(defaultProvider(providers)),
  fallbacks: [],
});

/** The efforts an entry's model takes: the listed model's, else any level for a model typed by hand. */
export const effortChoices = (
  providers: ReadonlyArray<ProviderChoice>,
  entry: AgentEntry,
): ReadonlyArray<string> => {
  const choice = providers.find((candidate) => candidate.provider === entry.provider);
  const listed = choice?.models.find((model) => model.id === entry.model);
  return listed?.efforts ?? choice?.efforts ?? [];
};

/** The entry with its effort cleared when the new provider or model does not take it. */
export const changeEntry = (
  providers: ReadonlyArray<ProviderChoice>,
  entry: AgentEntry,
  change: Partial<Pick<AgentEntry, "provider" | "model">>,
): AgentEntry => {
  const { effort, ...rest } = { ...entry, ...change };
  return effort !== undefined && effortChoices(providers, rest).includes(effort)
    ? { ...rest, effort }
    : rest;
};

export const withEffort = (entry: AgentEntry, effort: string | undefined): AgentEntry => {
  const { effort: _effort, ...rest } = entry;
  return effort === undefined ? rest : { ...rest, effort };
};

/** The agent with its own (first) entry replaced; the effort follows the entry, set or not. */
export const withFirstEntry = (agent: AgentRecord, entry: AgentEntry): AgentRecord => {
  const { provider: _provider, model: _model, effort: _effort, ...rest } = agent;
  return { ...rest, ...entry };
};

/** What stops the draft from being saved, or undefined. Mirrors the server's checks for a quick answer. */
export const draftProblem = (
  draft: AgentRecord,
  others: ReadonlyArray<AgentRecord>,
): string | undefined => {
  const name = draft.name.trim();
  if (!NAME.test(name))
    return "Name: letters, digits, “-”, “_” or “.”, starting with a letter or digit.";
  if (others.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
    return `Another agent is named “${name}”.`;
  }
  if (["sonnet", "opus", "haiku", "fable", "inherit", "best", "opusplan"].includes(name)) {
    return `“${name}” is a name Claude Code keeps for its own models.`;
  }
  const entries = [draft, ...draft.fallbacks];
  if (entries.some((entry) => !/^\S+$/.test(entry.model.trim()))) {
    return "Every entry needs a model, with no spaces.";
  }
  return undefined;
};

/** The list with `draft` added (empty id) or replacing the agent with its id. */
export const withAgent = (
  agents: ReadonlyArray<AgentRecord>,
  draft: AgentRecord,
): ReadonlyArray<AgentRecord> => {
  const clean: AgentRecord = {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    model: draft.model.trim(),
    fallbacks: draft.fallbacks.map((entry) => ({ ...entry, model: entry.model.trim() })),
  };
  return draft.id === "" || !agents.some((agent) => agent.id === draft.id)
    ? [...agents, clean]
    : agents.map((agent) => (agent.id === draft.id ? clean : agent));
};

export const withoutAgent = (
  agents: ReadonlyArray<AgentRecord>,
  id: string,
): ReadonlyArray<AgentRecord> => agents.filter((agent) => agent.id !== id);

export const withEnabled = (
  agents: ReadonlyArray<AgentRecord>,
  id: string,
  enabled: boolean,
): ReadonlyArray<AgentRecord> =>
  agents.map((agent) => (agent.id === id ? { ...agent, enabled } : agent));

/** `items` with the one at `from` moved to `to` (both clamped to the list). */
export const moveItem = <T>(
  items: ReadonlyArray<T>,
  from: number,
  to: number,
): ReadonlyArray<T> => {
  if (from < 0 || from >= items.length) return items;
  const target = Math.min(Math.max(to, 0), items.length - 1);
  if (target === from) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
};
