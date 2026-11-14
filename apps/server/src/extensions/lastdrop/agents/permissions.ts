/**
 * The thread's mode as each entry's instance takes it, and who answers its approval requests
 * (docs/agents.md "Permission modes"). Under `auto` lastdrop answers, so Antigravity runs accept-edits;
 * otherwise T3's rule: an unsupported mode becomes `approval-required` and the person answers.
 */
import type { RuntimeMode } from "@t3tools/contracts";
import type { JudgePolicy } from "@t3tools/lastdrop-node";
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
  if (mode === "auto") {
    const known = supported !== undefined && supported.length > 0;
    // Antigravity has no auto mode, even while its modes are unknown: accept-edits, with lastdrop
    // answering what it asks (the standalone app's mode for it).
    if (step.provider === "antigravity" && (!known || supported.includes("auto-accept-edits")))
      return "auto-accept-edits";
    // OpenRouter: Claude Code's own auto check is untested there, so every command it asks about
    // goes to lastdrop's rules and judge instead. Z.ai keeps Claude Code's check (verified in step 6).
    if (step.provider === "openrouter" && (!known || supported.includes("auto-accept-edits")))
      return "auto-accept-edits";
    if (known && !supported.includes("auto") && supported.includes("auto-accept-edits"))
      return "auto-accept-edits";
  }
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

/**
 * Whether lastdrop answers an entry's request: only under `auto`, read-only in plan mode; other modes
 * ask the person. Codex's requests are those its `auto_review` left to a person: rules and the
 * read-only list allow, the rest is declined without the judge.
 */
export const lastdropAnswers = (
  step: AgentStep,
  policy: Pick<ProviderAdapterV2RuntimePolicy, "runtimeMode" | "interactionMode">,
): { readonly policy: JudgePolicy; readonly judge: boolean } | undefined => {
  if (policy.runtimeMode !== "auto") return undefined;
  return {
    policy: policy.interactionMode === "plan" ? "readOnly" : "checked",
    judge: step.provider !== "codex",
  };
};
