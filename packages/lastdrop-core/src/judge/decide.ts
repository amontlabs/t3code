/**
 * One approval request, decided as the standalone app decides an Antigravity agent's
 * (`AntigravityBackend.decide`): the user's rules, Claude Code's read-only list, then the judge.
 */
import {
  clip,
  judgePrompt,
  policyText as guardianPolicyText,
  verdictSummary,
  type JudgeContext,
  type Verdict,
} from "./commandJudge.ts";
import { checkRules, type PermissionRules } from "./permissionRules.ts";
import { readOnlyCommands } from "./readOnlyCommands.ts";

/**
 * `checked`: rules, read-only list, judge. `readOnly` (plan): deny and ask rules, read-only list,
 * the judge told to allow only reads; edits refused. `bypass`: everything allowed.
 */
export type JudgePolicy = "checked" | "readOnly" | "bypass";

/** The action a request asks about: its tool, kind, a short label, the command if it is one, and what the judge reads. */
export interface JudgeAction {
  readonly tool: string;
  /** ACP's tool kinds: `execute`, `edit`, `delete`, `move`, `read`, `fetch`, `other`… */
  readonly kind: string;
  readonly label: string;
  readonly command?: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface Decision {
  readonly allow: boolean;
  /** "swift test (not covered by your allow rules; judge: high risk, …)": the report's line for a refusal. */
  readonly declined?: string;
  /** The live step ("Allowed by your rule Bash(git status:*): git status"). */
  readonly step: string;
}

/** A label of at most 120 characters, on one line. */
export const actionLabel = (text: string): string => {
  const line = text.replaceAll("\n", " ");
  return Array.from(line).length > 120 ? `${Array.from(line).slice(0, 119).join("")}…` : line;
};

export const decideAction = async (input: {
  readonly action: JudgeAction;
  readonly policy: JudgePolicy;
  readonly rules: PermissionRules;
  readonly context: JudgeContext;
  /** Runs the judge on a prompt; it must never throw (a failure is a verdict with `failure`). */
  readonly judge: (prompt: string) => Promise<Verdict>;
  readonly policyText?: (readOnly: boolean) => string;
}): Promise<Decision> => {
  const { action, policy } = input;
  if (policy === "bypass")
    return { allow: true, step: `Allowed (bypass permissions): ${action.label}` };
  if (action.command !== undefined) {
    const verdict = checkRules(input.rules, action.command);
    if (verdict.type === "deny")
      return {
        allow: false,
        declined: `${action.label} (your deny rule ${verdict.rule})`,
        step: `Declined by your rule ${verdict.rule}: ${action.label}`,
      };
    if (verdict.type === "ask")
      return {
        allow: false,
        declined: `${action.label} (your rule ${verdict.rule} asks first, and nobody can be asked)`,
        step: `Declined by your rule ${verdict.rule}: ${action.label}`,
      };
    if (verdict.type === "allow" && policy === "checked")
      return {
        allow: true,
        step: `Allowed by your rule ${verdict.rules.join(", ")}: ${action.label}`,
      };
    // Claude Code's own read-only list: these never wait for the judge, in plan mode too.
    const names = readOnlyCommands(action.command);
    if (names !== undefined)
      return { allow: true, step: `Allowed as read-only (${names.join(", ")}): ${action.label}` };
  } else if (policy === "readOnly" && ["edit", "delete", "move"].includes(action.kind)) {
    return {
      allow: false,
      declined: `${action.label} (read-only agent)`,
      step: `Declined (read-only agent): ${action.label}`,
    };
  }
  const why =
    action.command === undefined
      ? ""
      : policy === "readOnly"
        ? "read-only agent; "
        : "not covered by your allow rules; ";
  let verdict: Verdict;
  try {
    const text = judgePrompt(
      (input.policyText ?? guardianPolicyText)(policy === "readOnly"),
      input.context,
      {
        tool: action.tool,
        arguments: action.input,
      },
    );
    verdict = await input.judge(text);
  } catch (error) {
    verdict = {
      allow: false,
      failure: clip(error instanceof Error ? error.message : String(error), 200),
    };
  }
  if (verdict.allow) return { allow: true, step: `Allowed by the reviewer: ${action.label}` };
  return {
    allow: false,
    declined: `${action.label} (${why}${verdictSummary(verdict)})`,
    step: `Declined by the reviewer: ${action.label}`,
  };
};
