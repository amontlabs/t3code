/**
 * The JSON-lines protocol lastdrop's Claude Code plugin speaks with its runner (`register.tsx`, the
 * standalone app's `AgentRun.swift`, `AgentCatalog.pluginLine`, `AgentsCommand`), as the fork answers it.
 * Pure: requests in, lines out. `protocol.contract.test.ts` pins the shapes the plugin parses.
 */
import {
  agentSummary,
  allAgents,
  type AgentDefinition,
  type AgentStep,
} from "../agents/catalog.ts";

/** One line the plugin reads: `{"type": ..., ...}`. */
export type RunnerLine = { readonly type: string } & Readonly<Record<string, unknown>>;

export const encodeLine = (line: RunnerLine): string => `${JSON.stringify(line)}\n`;

/** The plugin's request on stdin for `--agent-run`, `--agent-route` and `--agent-warm` (`AgentRun.Request`). */
export interface RunRequest {
  readonly prompt: string;
  readonly description?: string | undefined;
  readonly subagentType?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly isolation?: string | undefined;
  readonly cwd: string;
  readonly permissionMode?: string | undefined;
  readonly parentModel?: string | undefined;
  /** A run of this id to continue (SendMessage). */
  readonly resume?: string | undefined;
  /** An added agent (`lastdrop:<name>` without the prefix); absent for a plain reroute. */
  readonly agent?: string | undefined;
  readonly role?: string | undefined;
  /** Claude Code's native agent id: stop and resume name it. */
  readonly id?: string | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** `AgentRun.Request.validID`: 1 to 100 of `[A-Za-z0-9_-]`. */
export const isValidAgentId = (id: string): boolean => /^[A-Za-z0-9_-]{1,100}$/.test(id);

/** The request, or the line that refuses it (as `AgentRun.main` answers an unreadable one). */
export const parseRunRequest = (body: string): RunRequest | RunnerLine => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { type: "result", text: "lastdrop couldn't read the subagent request.", isError: true };
  }
  const raw = json as Record<string, unknown>;
  if (typeof raw.prompt !== "string" || typeof raw.cwd !== "string") {
    return { type: "result", text: "lastdrop couldn't read the subagent request.", isError: true };
  }
  const request: RunRequest = {
    prompt: raw.prompt,
    cwd: raw.cwd,
    description: text(raw.description),
    subagentType: text(raw.subagentType),
    model: text(raw.model),
    effort: text(raw.effort),
    isolation: text(raw.isolation),
    permissionMode: text(raw.permissionMode),
    parentModel: text(raw.parentModel),
    resume: text(raw.resume),
    agent: text(raw.agent),
    role: text(raw.role),
    id: typeof raw.id === "string" ? raw.id : undefined,
  };
  for (const id of [request.id, request.resume]) {
    if (id !== undefined && !isValidAgentId(id)) {
      return { type: "error", text: "lastdrop received an invalid native agent id." };
    }
  }
  return request;
};

/** The catalog file's fields beside its agents (`AgentCatalog`), as read. */
export interface CatalogExtras {
  readonly revision?: number | undefined;
  readonly saveClaude?: boolean | undefined;
  readonly saveClaudeText?: string | undefined;
}

export const catalogExtras = (json: unknown): CatalogExtras => {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const raw = json as Record<string, unknown>;
  return {
    revision: typeof raw.revision === "number" ? raw.revision : undefined,
    saveClaude: raw.saveClaude === true,
    saveClaudeText: text(raw.saveClaudeText),
  };
};

/** The agents the plugin registers as `lastdrop:<name>` types: enabled, not one of Claude's own names. */
export const pluginAgents = (
  catalog: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<AgentDefinition> => allAgents(catalog).filter((agent) => !agent.claudeModel);

/** A stable number for a list read without a revision: the plugin only compares it. */
const hashRevision = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/**
 * `--agent-catalog`'s line (`AgentCatalog.pluginLine`). In the fork:
 * - `t3Instance` is false: the plugin's T3 texts name the standalone app's instance (`lastdrop`), and the
 *   fork's own provider is `lastdropAgents`, which T3's delegate_task lists by itself;
 * - `delegateNotes` is false: a plain Claude child is a T3 thread the fork's query-runner wrapper routes.
 */
export const catalogLine = (
  catalog: ReadonlyArray<AgentDefinition>,
  extras: CatalogExtras,
): RunnerLine => {
  const agents = pluginAgents(catalog).map((agent) => ({
    name: agent.name,
    description: agent.description,
    provider: agent.chain[0]!.provider,
    summary: agentSummary(agent),
    prompt: "",
  }));
  return {
    type: "catalog",
    revision: extras.revision ?? hashRevision(JSON.stringify([agents, extras.saveClaude ?? false])),
    saveClaude: extras.saveClaude ?? false,
    ...(extras.saveClaudeText === undefined ? {} : { saveClaudeText: extras.saveClaudeText }),
    nativeTasks: true,
    agentModels: true,
    t3Instance: false,
    delegateNotes: false,
    agents,
  };
};

/** Where an entry runs, as the plugin's `started`/`result` lines name it. */
export const stepFields = (
  step: AgentStep,
): { account: string; model: string; provider: string } => ({
  account: step.providerLabel,
  model: step.model,
  provider: step.provider,
});

/** `--agents list` (`AgentsCommand.Entry`, read only here). */
const agentsList = (catalog: ReadonlyArray<AgentDefinition>, extras: CatalogExtras): string =>
  JSON.stringify(
    {
      agents: catalog.map((agent) => ({
        name: agent.name,
        description: agent.description,
        models: agent.chain.map((step) => ({
          provider: step.provider,
          model: step.model,
          ...(step.effort === undefined ? {} : { effort: step.effort }),
        })),
        enabled: agent.enabled,
      })),
      saveClaude: extras.saveClaude ?? false,
    },
    null,
    2,
  );

/** The standalone app's command, which still edits the list the fork reads. */
const STANDALONE_COMMAND = "/Applications/lastdrop.app/Contents/MacOS/lastdrop";

const AGENTS_HELP = `Lists the agents lastdrop adds to Claude Code's Agent tool in T3 Code lastdrop. Use it only when the user asks for a change.

lastdrop --agents list                  Every agent, as JSON

T3 Code lastdrop reads the lastdrop app's list (~/Library/Application Support/lastdrop/agent-catalog.json)
and doesn't change it. Changes apply from the next prompt. To add, change or remove an agent, use the
lastdrop app's Settings → Agents, or its command: ${STANDALONE_COMMAND} --agents --help.

Prints JSON and exits 0, or prints the reason and exits 1.`;

/** What an `--agents` verb answers: its output and whether it failed. */
export const agentsCommand = (
  args: ReadonlyArray<string>,
  catalog: ReadonlyArray<AgentDefinition>,
  extras: CatalogExtras,
): { readonly output: string; readonly failed: boolean } => {
  const [verb] = args;
  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    return { output: AGENTS_HELP, failed: false };
  }
  if (verb === "list" && args.length === 1) {
    return { output: agentsList(catalog, extras), failed: false };
  }
  if (["models", "set", "remove", "saving", "judge"].includes(verb)) {
    return {
      output: `T3 Code lastdrop reads lastdrop's agents and doesn't change them. Run ${STANDALONE_COMMAND} --agents ${args.join(" ")} (the lastdrop app), or use its Settings → Agents.`,
      failed: true,
    };
  }
  return { output: `Unknown command: ${args.join(" ")}. See --agents --help.`, failed: true };
};

/** A turn item, as far as a step line needs it. */
export interface StepItem {
  readonly id: string;
  readonly type: string;
  readonly title?: string | null | undefined;
  readonly input?: unknown;
  readonly fileName?: string | undefined;
  readonly pattern?: string | undefined;
  readonly patterns?: ReadonlyArray<string> | undefined;
  readonly toolName?: string | null | undefined;
  readonly message?: string | undefined;
}

const firstLine = (value: string, limit = 160): string => {
  const line = value.split("\n", 1)[0]!.trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
};

/**
 * A step line's text for a turn item of the agent's thread ("Bash: git status", "Edit: note.txt"), or
 * undefined for items that are not steps (messages, reasoning). A notice row (a fallback) is a step too.
 */
export const stepText = (item: StepItem): string | undefined => {
  switch (item.type) {
    case "command_execution":
      return typeof item.input === "string" && item.input.trim() !== ""
        ? `Bash: ${firstLine(item.input)}`
        : "Bash";
    case "file_change":
      return item.fileName === undefined ? "Edit" : `Edit: ${item.fileName}`;
    case "file_search":
      return item.pattern === undefined ? "Search" : `Search: ${firstLine(item.pattern)}`;
    case "web_search":
      return item.patterns?.[0] === undefined
        ? "Web search"
        : `Web search: ${firstLine(item.patterns[0])}`;
    case "dynamic_tool":
      return item.title ?? item.toolName ?? "Tool";
    case "system_notice":
      return item.message === undefined ? undefined : firstLine(item.message, 400);
    case "approval_request":
      return `Waiting for approval: ${firstLine(item.title ?? "a request")}`;
    case "user_input_request":
      return "Waiting for an answer in T3 Code";
    default:
      return undefined;
  }
};
