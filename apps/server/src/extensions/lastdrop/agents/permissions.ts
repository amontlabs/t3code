/**
 * The thread's permission mode as each entry's instance takes it. Antigravity has no auto mode and
 * T3 answers `agy` prompts from the policy, so `auto` runs its entries in full access until the
 * command judge (step 7) lands; other instances keep the thread's mode. See docs/lastdrop/step5.md.
 */
import type { RuntimeMode } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import type { AgentStep } from "./catalog.ts";

export const entryRuntimeMode = (
  step: AgentStep,
  mode: RuntimeMode,
  ceiling: RuntimeMode | undefined,
): RuntimeMode => {
  if (step.provider !== "antigravity" || mode !== "auto") return mode;
  // A managed ceiling under full access keeps the thread's mode (it may then ask).
  return ceiling === undefined || ceiling === "full-access" ? "full-access" : mode;
};

export const entryRuntimePolicy = (
  step: AgentStep,
  policy: ProviderAdapterV2RuntimePolicy,
): ProviderAdapterV2RuntimePolicy => {
  const runtimeMode = entryRuntimeMode(step, policy.runtimeMode, policy.maxRuntimeMode);
  return runtimeMode === policy.runtimeMode ? policy : { ...policy, runtimeMode };
};
