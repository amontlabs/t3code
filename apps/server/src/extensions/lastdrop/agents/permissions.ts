/**
 * The thread's mode as each entry's instance takes it, and who answers its approval requests
 * (docs/agents.md "Permission modes"). Under `auto`, an entry without an auto of its own runs
 * accept-edits and lastdrop answers; otherwise T3's rule: an unsupported mode becomes
 * `approval-required` and the person answers.
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
  interactionMode: ProviderAdapterV2RuntimePolicy["interactionMode"] = "default",
): RuntimeMode => {
  if (mode === "auto") {
    const known = supported !== undefined && supported.length > 0;
    // Antigravity's own Auto exists only on some sign-ins; while its modes are unknown, or in plan
    // mode, lastdrop answers. OpenRouter: Claude Code's own auto check is untested there. Answered
    // entries are asked about every command; Z.ai keeps Claude Code's check (verified in step 6).
    const answered =
      (step.provider === "antigravity" && (!known || interactionMode === "plan")) ||
      step.provider === "openrouter" ||
      (known && !supported.includes("auto"));
    if (answered) {
      // In plan mode edits must reach lastdrop too, to be refused: accept-edits would let the
      // provider's client allow them itself.
      const target = interactionMode === "plan" ? "approval-required" : "auto-accept-edits";
      if (!known || supported.includes(target)) return target;
    }
  }
  return supportedOrAsk(mode, supported);
};

export const entryRuntimePolicy = (
  step: AgentStep,
  policy: ProviderAdapterV2RuntimePolicy,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): ProviderAdapterV2RuntimePolicy => {
  const runtimeMode = entryRuntimeMode(step, policy.runtimeMode, supported, policy.interactionMode);
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
