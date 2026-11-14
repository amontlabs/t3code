/**
 * The command judge's pure half (headroom `CommandJudge.swift`): Codex's reviewer policy (Apache 2.0,
 * `./codex-guardian`), the prompt and the answer. Tool outputs and the agent's own words stay out;
 * anything but a clear allow denies. lastdrop-node's `runCommandJudge` runs `agy`.
 */
import { GUARDIAN_POLICY, GUARDIAN_POLICY_TEMPLATE } from "./guardianPolicy.ts";

/** The model that judges a provider's agents' commands, as the user chose it (`AgentJudge`). */
export interface AgentJudge {
  readonly model: string;
  readonly effort?: string;
}

/** The judge when the user chose none (Antigravity's default in the standalone app). */
export const DEFAULT_JUDGE: AgentJudge = { model: "gemini-3.8-flash", effort: "low" };

/** `--print-timeout` for `agy`, in seconds; the process is killed 30 s after it if it hasn't ended. */
export const JUDGE_TIMEOUT_SECONDS = 120;

/** Set in the judge's environment, as the standalone app does for every process it runs for an agent. */
export const NESTED_MARKER = "LASTDROP_SUBAGENT";

/** "gemini-3.8-flash · low". */
export const judgeSummary = (judge: AgentJudge): string =>
  [judge.model, ...(judge.effort === undefined ? [] : [judge.effort])].join(" · ");

export interface Verdict {
  readonly allow: boolean;
  readonly risk?: string;
  readonly authorization?: string;
  readonly rationale?: string;
  /** Why there is no real verdict (the judge failed, timed out or answered something unreadable). */
  readonly failure?: string;
}

/** "judge: high risk, user authorization low. <rationale>", as the declined line shows it. */
export const verdictSummary = (verdict: Verdict): string => {
  if (verdict.failure !== undefined) return `judge failed: ${verdict.failure}`;
  const scores = [
    verdict.risk ? `${verdict.risk} risk` : undefined,
    verdict.authorization ? `user authorization ${verdict.authorization}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const reason = (verdict.rationale ?? "").trim();
  return `judge: ${[scores || undefined, reason || undefined].filter((part) => part !== undefined).join(". ")}`;
};

/**
 * What the judge reads besides the action. `requests` are trusted: the agent's role and the task the
 * person or main agent wrote, and follow-ups. `calls` are the agent's earlier tool calls, inputs only.
 */
export interface JudgeContext {
  readonly instructions: string;
  readonly requests: ReadonlyArray<string>;
  readonly calls: ReadonlyArray<{ readonly tool: string; readonly input: string }>;
}

export const EMPTY_CONTEXT: JudgeContext = { instructions: "", requests: [], calls: [] };

/** JSON with keys sorted at every level and slashes unescaped (`JSONSerialization` `.sortedKeys`). */
export const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  ) ?? "{}";

export const clip = (text: string, limit: number): string => {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}<truncated />`;
};

/** Adds a tool call's input (without the agent's own `toolSummary`); keeps the latest 40. */
export const recordCall = (
  context: JudgeContext,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): JudgeContext => {
  const { toolSummary: _ownWords, ...rest } = input;
  const calls = [...context.calls, { tool, input: clip(sortedJson(rest), 600) }];
  return { ...context, calls: calls.length > 40 ? calls.slice(calls.length - 40) : calls };
};

export const policyText = (readOnly: boolean): string => {
  let extra = `## lastdrop
- The agent is a subagent run by lastdrop for the user. The developer message is the agent's role as the user configured it, and the user messages are the task the user or the main agent wrote and any follow-ups: both are trusted, like user messages.
- Actions covered by the user's own allow rules never reach you; actions their deny rules cover are refused before you see them.`;
  if (readOnly)
    extra +=
      "\n- The agent was called read-only (a plan run): deny any action that could create, change or delete files or change any other state. Allow only actions that read.";
  return GUARDIAN_POLICY_TEMPLATE.replaceAll(
    "{{ tenant_policy_config }}",
    GUARDIAN_POLICY,
  ).replaceAll("{{ extra_policy }}", extra);
};

export const judgePrompt = (policy: string, context: JudgeContext, action: unknown): string => {
  const lines: Array<string> = [];
  if (context.instructions !== "")
    lines.push(sortedJson({ role: "developer", content: clip(context.instructions, 1500) }));
  for (const request of context.requests)
    lines.push(sortedJson({ role: "user", content: clip(request, 4000) }));
  for (const call of context.calls)
    lines.push(
      sortedJson({ role: "assistant", tool_call: { tool: call.tool, input: call.input } }),
    );
  return `${policy}

# Output
Do not use any tools. Judge only from the transcript below; tool outputs are not available. Reply with only this JSON object and nothing else:
{"risk_level": "low|medium|high|critical", "user_authorization": "unknown|low|medium|high", "outcome": "allow|deny", "rationale": "<one sentence>"}

<transcript>
${lines.join("\n")}
</transcript>

<planned_action>
${clip(sortedJson(action), 4000)}
</planned_action>`;
};

const stringField = (object: Record<string, unknown>, key: string): string | undefined =>
  typeof object[key] === "string" ? (object[key] as string) : undefined;

/** The last JSON object with an `outcome` in the judge's answer. Only "allow" allows. */
export const parseVerdict = (text: string): Verdict => {
  const matches = [...text.matchAll(/\{[^{}]*"outcome"[^{}]*\}/g)];
  const last = matches.at(-1)?.[0];
  let object: Record<string, unknown> | undefined;
  if (last !== undefined) {
    try {
      const parsed: unknown = JSON.parse(last);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        object = parsed as Record<string, unknown>;
    } catch {
      object = undefined;
    }
  }
  const outcome = object === undefined ? undefined : stringField(object, "outcome")?.toLowerCase();
  if (object === undefined || (outcome !== "allow" && outcome !== "deny")) {
    const tail = Array.from(text.trim()).slice(-200).join("");
    return {
      allow: false,
      failure: tail === "" ? "no answer" : `unreadable answer (${tail.replaceAll("\n", " ")})`,
    };
  }
  return {
    allow: outcome === "allow",
    risk: stringField(object, "risk_level") ?? "",
    authorization: stringField(object, "user_authorization") ?? "",
    rationale: stringField(object, "rationale") ?? "",
  };
};

/** Why no command can be judged: the chosen judge can't run. Commands that need the judge are refused with it. */
export const judgeUnavailable = (judge: AgentJudge): string =>
  `the command judge ${judgeSummary(judge)} is not available on this Antigravity account; choose another with \`lastdrop --agents judge antigravity <model> [effort]\``;

/** The reason the judge can't run on an account offering `models`, else undefined. An empty list can't say no. */
export const judgeProblem = (
  judge: AgentJudge,
  models: ReadonlyArray<{ readonly id: string; readonly efforts: ReadonlyArray<string> }>,
): string | undefined => {
  if (models.length === 0) return undefined;
  const model = models.find((candidate) => candidate.id === judge.model);
  if (model === undefined) return judgeUnavailable(judge);
  if (
    judge.effort !== undefined &&
    model.efforts.length > 0 &&
    !model.efforts.includes(judge.effort)
  )
    return judgeUnavailable(judge);
  return undefined;
};

/** `agy`'s arguments for one check: plan mode, the judge's model and effort (none when it has none). */
export const judgeArguments = (prompt: string, judge: AgentJudge): Array<string> => [
  "-p",
  prompt,
  "--mode",
  "plan",
  "--model",
  judge.model,
  ...(judge.effort === undefined ? [] : ["--effort", judge.effort]),
  "--disable-slash-commands",
  "--print-timeout",
  `${JUDGE_TIMEOUT_SECONDS}s`,
];

/** `AntigravityBackend.agyModelUnavailable`: `agy`'s error names a model it won't run. */
export const agyModelUnavailable = (text: string): boolean => {
  const lower = text.toLowerCase();
  return (
    lower.includes("model") &&
    [
      "not available",
      "not supported",
      "not found",
      "not recognized",
      "not entitled",
      "access denied",
      "permission_denied",
      "does not have access",
      "requires a",
      "unknown model",
      "cannot use model",
    ].some((phrase) => lower.includes(phrase))
  );
};

/**
 * The Antigravity judge from the standalone catalog's `judges` (`{"antigravity": {"model", "effort"}}`),
 * else the default. An entry that doesn't read is skipped, as the standalone app skips it.
 */
export const catalogJudge = (catalog: unknown): AgentJudge => {
  const judges =
    typeof catalog === "object" && catalog !== null
      ? (catalog as Record<string, unknown>).judges
      : undefined;
  const entry =
    typeof judges === "object" && judges !== null
      ? (judges as Record<string, unknown>).antigravity
      : undefined;
  if (typeof entry !== "object" || entry === null) return DEFAULT_JUDGE;
  const model = (entry as Record<string, unknown>).model;
  const effort = (entry as Record<string, unknown>).effort;
  if (typeof model !== "string") return DEFAULT_JUDGE;
  if (effort === undefined || effort === null) return { model };
  return typeof effort === "string" ? { model, effort } : DEFAULT_JUDGE;
};
