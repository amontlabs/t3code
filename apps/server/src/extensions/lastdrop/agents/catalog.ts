/**
 * Step 5 spike: the user's agents as a lastdrop provider's model list. Shaped after the
 * standalone app's `AgentCatalog.swift` (`AgentDefinition`: name, description, provider, model,
 * effort, enabled, fallbacks), with one hard-coded agent for the spike.
 */
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";

/** Where one step of an agent's chain runs: a native T3 instance and its model. */
export interface AgentStep {
  /** The T3 provider instance that runs this step (`claudeAgent`, `codex`, `antigravity`…). */
  readonly instanceId: ProviderInstanceId;
  /** Shown in the model list's subProvider, e.g. "Antigravity". */
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
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** One hard-coded agent for the spike; the real step reads the catalog file. */
export const spikeAgents = (claudeModel: string): ReadonlyArray<AgentDefinition> => [
  {
    name: "build",
    description: "Implementation and fixes in this repo, one topic per agent.",
    enabled: true,
    chain: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        providerLabel: "Claude",
        model: claudeModel,
      },
    ],
  },
  {
    name: "judge",
    description: "Judgement: design calls and trade-offs.",
    enabled: true,
    chain: [
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        providerLabel: "Claude",
        model: claudeModel,
        effort: "high",
      },
    ],
  },
];

/** "Claude · claude-sonnet-4-6", then each fallback. */
const subProvider = (agent: AgentDefinition): string =>
  agent.chain.map((step) => `${step.providerLabel} · ${step.model}`).join(", then ");

/** The lastdrop provider's models: one per enabled agent, effort offered only when not fixed. */
export const agentModels = (
  agents: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<ServerProviderModel> =>
  agents
    .filter((agent) => agent.enabled && agent.chain.length > 0)
    .map((agent, index) => {
      const first = agent.chain[0]!;
      return {
        slug: agent.name,
        name: agent.name,
        subProvider: subProvider(agent),
        isCustom: false,
        ...(index === 0 ? { isDefault: true } : {}),
        capabilities:
          first.effort === undefined
            ? {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select" as const,
                    role: "reasoning" as const,
                    options: EFFORT_LEVELS.map((level) => ({
                      id: level,
                      label: level,
                      ...(level === "high" ? { isDefault: true } : {}),
                    })),
                  },
                ],
              }
            : { optionDescriptors: [] },
      } satisfies ServerProviderModel;
    });

/**
 * The selection the chosen step's instance gets: its instance and model, and the effort (fixed,
 * or the one the run asked for). Other options are dropped: they were offered for our model.
 */
export const stepSelection = (step: AgentStep, outer: ModelSelection): ModelSelection => {
  const asked = outer.options?.find((option) => option.id === "effort");
  const effort = step.effort ?? (typeof asked?.value === "string" ? asked.value : undefined);
  const options: ReadonlyArray<ProviderOptionSelection> =
    effort === undefined ? [] : [{ id: "effort", value: effort }];
  return {
    instanceId: step.instanceId,
    model: step.model,
    ...(options.length === 0 ? {} : { options }),
  } as ModelSelection;
};
