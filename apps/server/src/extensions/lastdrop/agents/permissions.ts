/**
 * The thread's permission mode as each entry's instance takes it, by T3's own rule: a mode the
 * target doesn't support becomes `approval-required`, so its prompts reach the person. Z.ai and
 * OpenRouter are Claude instances on another endpoint whose auto check is untested: no `auto` yet.
 */
import type { RuntimeMode } from "@t3tools/contracts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import type { AgentStep } from "./catalog.ts";

/** Every mode, published by the lastdrop snapshot so T3 passes the thread's own to the router. */
export const ALL_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** `RuntimePolicy.ts` `providerRuntimeMode`: an unsupported mode asks for approval. */
const supportedOrAsk = (
  mode: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode =>
  supported === undefined || supported.length === 0 || supported.includes(mode)
    ? mode
    : "approval-required";

export const entryRuntimeMode = (
  step: AgentStep,
  mode: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode => {
  // Until the command judge (step 7): Claude Code's auto check on these endpoints is untested.
  if ((step.provider === "zai" || step.provider === "openrouter") && mode === "auto")
    return "approval-required";
  return supportedOrAsk(mode, supported);
};

export const entryRuntimePolicy = (
  step: AgentStep,
  policy: ProviderAdapterV2RuntimePolicy,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): ProviderAdapterV2RuntimePolicy => {
  const runtimeMode = entryRuntimeMode(step, policy.runtimeMode, supported);
  return runtimeMode === policy.runtimeMode ? policy : { ...policy, runtimeMode };
};
