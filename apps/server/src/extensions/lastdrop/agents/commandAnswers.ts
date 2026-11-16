// @effect-diagnostics nodeBuiltinImport:off - Joins lastdrop's log path.
/**
 * Under `auto` lastdrop answers an agent thread's approval requests (rules, read-only list, judge),
 * seen as waiting `approval_request` items in the router's stream and answered through the inner
 * adapter. Each decision is a notice row and a `lastdrop.log` line; what can't be decided is refused.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  actionLabel,
  decideAction,
  EMPTY_CONTEXT,
  fileLogger,
  findAgy,
  loadPermissionRules,
  makeJudgeLimit,
  readCatalogJudge,
  recordCall,
  runCommandJudge,
  judgeSummary,
  sortedJson,
  unwrapShellLaunch,
  type Decision,
  type JudgeAction,
  type JudgeContext,
  type JudgePolicy,
  type PermissionRules,
  type Verdict,
} from "@t3tools/lastdrop-node";
import {
  TurnItemId,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2RuntimeRequestResponseInput,
} from "@t3tools/provider-core/server/ProviderAdapter";

import { isCutAntigravityToolText } from "../../../provider/acp/AntigravityProtocol.ts";
import { rawToolCall, type RawToolCall } from "../../acpToolCalls.ts";
import { stepLabel, type AgentDefinition, type AgentStep } from "./catalog.ts";
import { boundCatalogFiles } from "./catalogSource.ts";
import { lastdropAnswers } from "./permissions.ts";

/** What the answers need from outside: seams for tests. */
export interface CommandAnswerServices {
  /** The user's rules where the agent works (read for each request, so an edit applies at once). */
  readonly rules: (cwd: string | null) => PermissionRules;
  /** Runs the judge on a prompt; `signal` aborts when the session closes. Never throws. */
  readonly judge: (prompt: string, signal: AbortSignal) => Promise<Verdict>;
  readonly log: (line: string) => void;
  /** The judge model now, so a verdict is kept only for the model that gave it. */
  readonly judgeModel?: () => string;
}

let logPath: string | undefined;

/** Keeps the decisions' log in lastdrop's folder from now on (`attachStore`). */
export const attachCommandLog = (dataDir: string): void => {
  logPath = NodePath.join(dataDir, "lastdrop.log");
};

const appendLog = (line: string) => {
  if (logPath !== undefined) fileLogger(logPath)(line);
};

/** At most this many `agy` judges at once, across every session. */
const JUDGE_CONCURRENCY = 3;
const judgeLimit = makeJudgeLimit(JUDGE_CONCURRENCY);

/** The fork's ways: settings files, the catalog's judge (read when each check runs), `agy`. */
export const defaultCommandAnswerServices: CommandAnswerServices = {
  rules: (cwd) => loadPermissionRules({ cwd: cwd ?? NodeOS.homedir() }),
  judge: (prompt, signal) =>
    judgeLimit(() =>
      runCommandJudge(prompt, {
        executable: findAgy(),
        judge: readCatalogJudge(boundCatalogFiles()?.catalog ?? ""),
        signal,
      }),
    ),
  log: appendLog,
  judgeModel: () => judgeSummary(readCatalogJudge(boundCatalogFiles()?.catalog ?? "")),
};

/** Swift keeps the latest 10 requests (`AntigravityBackend.run`). */
const MAX_REQUESTS = 10;

type TurnItemEvent = Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
type ApprovalItem = Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;

/** Provider fallbacks for a command whose text the request didn't carry. */
const GENERIC_COMMAND_TEXT = new Set(["command", "monitor", "terminal", "run_command", "bash"]);

/** How long an approval waits for agy's own update of its call (it comes just before). */
const RAW_CALL_WAIT = "5 seconds";

/** Bounds for a session's memory: calls, requests and verdicts it keeps. */
const MAX_TOOLS = 200;
const MAX_IDS = 500;
const MAX_VERDICTS = 200;

/** What a request is about: the action to decide, or why it is refused without reading further. */
type Planned =
  | { readonly action: JudgeAction; readonly cwd: string | null }
  | { readonly refusal: string };

/** A tool item as kept for its approval: inputs only, never outputs. */
interface ToolSeen {
  readonly type: OrchestrationV2TurnItem["type"];
  readonly command?: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unread = (item: ApprovalItem, what = "which command"): Planned => {
  const label = actionLabel(item.prompt?.trim() || item.requestKind);
  return { refusal: `${label} (lastdrop could not read ${what} this request is for)` };
};

const mismatch = (command: string, prompt: string): Planned => ({
  refusal: `${actionLabel(command)} (the request names another command than the call runs: ${actionLabel(prompt)})`,
});

const shell = (command: string, cwd: string | null): Planned => ({
  action: {
    tool: "run_command",
    kind: "execute",
    label: actionLabel(command),
    command,
    input: { command, ...(cwd === null ? {} : { cwd }) },
  },
  cwd,
});

const otherTool = (
  name: string,
  kind: string,
  input: Record<string, unknown>,
  cwd: string | null,
): Planned => {
  const detail = sortedJson(input);
  return {
    action: {
      tool: name,
      kind,
      label: actionLabel(detail === "{}" ? name : `${name}: ${detail}`),
      input: { ...input, ...(cwd === null ? {} : { cwd }) },
    },
    cwd,
  };
};

/** T3's summaries of a command call, which name no command. */
const COMMAND_SUMMARIES = new Set(["ran command", "run command", "running command"]);

/**
 * Whether the approval's text names a command other than the call's: any backticked part that
 * isn't the command, or any text that is neither the command, the call's title nor a summary.
 */
const namesAnotherCommand = (
  prompt: string | undefined,
  command: string,
  title?: string,
): boolean => {
  const text = prompt?.trim() ?? "";
  if (text === "" || text === command.trim() || text === title) return false;
  const quoted = [...text.matchAll(/`([^`]*)`/g)].map((match) => match[1]!.trim());
  if (quoted.length > 0) return quoted.some((part) => part !== command.trim());
  const lower = text.toLowerCase();
  return !COMMAND_SUMMARIES.has(lower) && !GENERIC_COMMAND_TEXT.has(lower);
};

/**
 * An Antigravity request, from agy's own data for the call (`acpToolCalls.ts`): only its
 * `run_command` tool with a `CommandLine` that decodes is a shell command, in its own `Cwd`; another
 * command-running tool is refused, any other tool is judged with its name and input. A request that
 * names another command than the call is refused.
 */
const antigravityPlan = (
  item: ApprovalItem,
  raw: RawToolCall | undefined,
  threadCwd: string | null,
): Planned => {
  if (raw === undefined) return unread(item);
  const input = raw.rawInput;
  if (input !== undefined && !isRecord(input)) return unread(item);
  const { toolSummary: _ownWords, ...fields } = input ?? {};
  if (raw.title === "run_command" && raw.kind === "execute") {
    const line = fields.CommandLine;
    const cwd = fields.Cwd;
    if (
      typeof line !== "string" ||
      line.trim() === "" ||
      (cwd !== undefined && typeof cwd !== "string")
    )
      return unread(item);
    if (isCutAntigravityToolText(line)) return unread(item);
    if (namesAnotherCommand(item.prompt, line, raw.title))
      return mismatch(line, item.prompt!.trim());
    return shell(line, typeof cwd === "string" && cwd.trim() !== "" ? cwd : threadCwd);
  }
  if (raw.kind === "execute") return unread(item);
  return otherTool(raw.title ?? raw.name ?? "tool", raw.kind ?? "other", fields, threadCwd);
};

/** What the judge reads of another tool: its own fields, never its output. */
const toolInput = (item: OrchestrationV2TurnItem): Record<string, unknown> => {
  switch (item.type) {
    case "dynamic_tool":
      return { input: item.input };
    case "file_change":
      return {
        file: item.fileName,
        ...(item.oldStr === undefined ? {} : { oldStr: item.oldStr }),
        ...(item.newStr === undefined ? {} : { newStr: item.newStr }),
        ...(item.changes === undefined ? {} : { changes: item.changes }),
      };
    case "web_search":
      return item.patterns === undefined ? {} : { patterns: item.patterns };
    case "file_search":
      return item.pattern === undefined ? {} : { pattern: item.pattern };
    default:
      return {};
  }
};

const toolName = (item: OrchestrationV2TurnItem): string =>
  item.type === "dynamic_tool"
    ? (item.toolName ?? "tool")
    : item.type === "file_change"
      ? "edit"
      : item.type;

/** The tool item as kept: inputs only. */
const seen = (item: OrchestrationV2TurnItem): ToolSeen => ({
  type: item.type,
  name: toolName(item),
  input: toolInput(item),
  ...(item.type === "command_execution" ? { command: item.input } : {}),
});

/**
 * A Claude or Codex request, from the tool item for the same call: only `command_execution`
 * (Claude's Bash, Codex's command, unwrapped from its `<shell> -lc` launch) is a shell command.
 */
const itemPlan = (
  item: ApprovalItem,
  tool: ToolSeen | undefined,
  codex: boolean,
  cwd: string | null,
): Planned => {
  if (tool === undefined) return unread(item, "which action");
  if (tool.type === "command_execution") {
    const raw = tool.command?.trim() ?? "";
    if (raw === "" || GENERIC_COMMAND_TEXT.has(raw.toLowerCase())) return unread(item);
    // Claude's approval carries Bash's own command: it must be the item's. Codex's carries its reason.
    if (!codex && namesAnotherCommand(item.prompt, raw)) return mismatch(raw, item.prompt!.trim());
    return shell(codex ? (unwrapShellLaunch(raw) ?? raw) : raw, cwd);
  }
  const kind =
    tool.type === "file_change" || item.requestKind === "file-change"
      ? "edit"
      : item.requestKind === "file-read"
        ? "read"
        : tool.type === "web_search"
          ? "fetch"
          : "other";
  return otherTool(tool.name, kind, tool.input, cwd);
};

/** Keeps a map or set to its newest `max` entries. */
const bound = <K>(collection: Map<K, unknown> | Set<K>, max: number) => {
  while (collection.size > max) collection.delete(collection.keys().next().value!);
};

/** Provider threads by id; an item with none shares one key. */
const threadKey = (id: string | null | undefined): string => id ?? "";

/** What the agent is told with a refusal, where the provider takes feedback (`continuePrompt`). */
const refusalFeedback = (declined: string | undefined): string =>
  `${declined === undefined ? "That action was refused and can't run here." : `lastdrop refused ${declined}.`} That is final for this command: don't retry it or work around it. Go on with the task without it and give your report, naming anything refused that you needed and why.`;

/** One session's answers: its threads' modes and context, verdicts given, notices to show. */
export const makeSessionAnswers = (input: {
  readonly agent: AgentDefinition;
  readonly step: AgentStep;
  readonly services: CommandAnswerServices;
  readonly openPolicy: ProviderAdapterV2RuntimePolicy;
  readonly respond: (
    request: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
}) => {
  const { agent, step, services } = input;
  /** The thread's own policy (before the entry's mapping), by provider thread. */
  const policies = new Map<string, ProviderAdapterV2RuntimePolicy>();
  const contexts = new Map<string, JudgeContext>();
  const recorded = new Set<string>();
  const handled = new Set<string>();
  const feedback = new Set<string>();
  /** Each native call's latest tool item, inputs only, which an approval for that call is about. */
  const tools = new Map<string, ToolSeen>();
  /** Judge verdicts only: rules are read again for every request, and failures are never kept. */
  const verdicts = new Map<string, Verdict>();
  const closing = new AbortController();
  let pendingNotices: Array<ProviderAdapterV2Event> = [];
  const instructions = `The agent is "${agent.name}", one of the user's agents in T3 Code, running on ${stepLabel(step)}. Its role, as the user configured it: ${agent.description}`;

  const contextFor = (providerThreadId: string): JudgeContext =>
    contexts.get(providerThreadId) ?? { ...EMPTY_CONTEXT, instructions };

  /** A turn's or steer's message: trusted, like the user's own; the latest 10 are kept. */
  const onMessage = (
    providerThreadId: string,
    text: string,
    policy?: ProviderAdapterV2RuntimePolicy,
  ) => {
    if (policy !== undefined) policies.set(providerThreadId, policy);
    const context = contextFor(providerThreadId);
    if (text.trim() === "") {
      contexts.set(providerThreadId, context);
      return;
    }
    const requests = [...context.requests, text];
    contexts.set(providerThreadId, {
      ...context,
      requests: requests.length > MAX_REQUESTS ? requests.slice(-MAX_REQUESTS) : requests,
    });
  };

  /** Earlier tool calls, inputs only; and each call's latest item, by its native id. */
  const recordItem = (item: OrchestrationV2TurnItem) => {
    const nativeId = item.nativeItemRef?.nativeId;
    if (nativeId != null && item.type !== "approval_request" && item.type !== "system_notice") {
      tools.delete(nativeId);
      tools.set(nativeId, seen(item));
      bound(tools, MAX_TOOLS);
    }
    if (recorded.has(item.id)) return;
    let call: { tool: string; input: Record<string, unknown> } | undefined;
    if (item.type === "command_execution") {
      const command = item.input.trim();
      if (command !== "" && !GENERIC_COMMAND_TEXT.has(command.toLowerCase()))
        call = { tool: "run_command", input: { command } };
    } else if (
      item.type === "file_change" ||
      item.type === "file_search" ||
      item.type === "web_search" ||
      item.type === "dynamic_tool"
    )
      call = { tool: toolName(item), input: toolInput(item) };
    if (call === undefined) return;
    recorded.add(item.id);
    bound(recorded, MAX_IDS);
    const key = threadKey(item.providerThreadId);
    contexts.set(key, recordCall(contextFor(key), call.tool, call.input));
  };

  const notice = Effect.fn("LastdropCommandAnswers.notice")(function* (
    event: TurnItemEvent,
    item: ApprovalItem,
    decision: Decision,
  ) {
    const now = yield* DateTime.now;
    return {
      type: "turn_item.updated",
      driver: event.driver,
      turnItem: {
        id: TurnItemId.make(`lastdrop-judge:${item.requestId}`),
        threadId: item.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        providerThreadId: item.providerThreadId,
        providerTurnId: item.providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: item.ordinal,
        status: "completed",
        title: decision.allow ? "lastdrop allowed" : "lastdrop declined",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "system_notice",
        message: decision.allow ? decision.step : `Declined: ${decision.declined ?? decision.step}`,
      },
    } as ProviderAdapterV2Event;
  });

  /**
   * The judge, once per identical prompt and judge model: the same action, mode and conversation
   * (a new message or call asks again). A failure is never kept.
   */
  const judgeOnce = async (prompt: string): Promise<Verdict> => {
    const key = sortedJson({ prompt, judge: services.judgeModel?.() ?? "" });
    const kept = verdicts.get(key);
    if (kept !== undefined) return kept;
    const verdict = await services
      .judge(prompt, closing.signal)
      .catch((error: unknown): Verdict => ({
        allow: false,
        failure: error instanceof Error ? error.message : String(error),
      }));
    if (verdict.failure === undefined) {
      verdicts.set(key, verdict);
      bound(verdicts, MAX_VERDICTS);
    }
    return verdict;
  };

  /** The user's rules where the agent works, plus the deny and ask rules where the command runs. */
  const rulesFor = (threadCwd: string | null, cwd: string | null): PermissionRules => {
    const thread = services.rules(threadCwd);
    if (cwd === null || cwd === threadCwd) return thread;
    const there = services.rules(cwd);
    return {
      allow: thread.allow,
      deny: [...new Set([...thread.deny, ...there.deny])],
      ask: [...new Set([...thread.ask, ...there.ask])],
    };
  };

  const decide = Effect.fn("LastdropCommandAnswers.decide")(function* (
    item: ApprovalItem,
    planned: Planned,
    policy: JudgePolicy,
    judged: boolean,
  ) {
    if ("refusal" in planned) {
      return {
        allow: false,
        declined: planned.refusal,
        step: `Declined (the request could not be read): ${planned.refusal}`,
      } satisfies Decision;
    }
    const { action } = planned;
    let reachedJudge = false;
    const threadCwd = policies.get(threadKey(item.providerThreadId))?.cwd ?? input.openPolicy.cwd;
    const decision = yield* Effect.promise(() =>
      decideAction({
        action,
        policy,
        rules: rulesFor(threadCwd, planned.cwd),
        context: contextFor(threadKey(item.providerThreadId)),
        judge: async (prompt) => {
          reachedJudge = true;
          return judged ? judgeOnce(prompt) : { allow: false, failure: "not judged" };
        },
      }),
    );
    if (reachedJudge && !judged)
      return {
        allow: false,
        declined: `${action.label} (${stepLabel(step)}'s own reviewer left it to a person, and lastdrop asks nobody under auto)`,
        step: `Declined (its own reviewer asked a person): ${action.label}`,
      } satisfies Decision;
    return decision;
  });

  /** What the request is about: agy's own data for Antigravity, the tool item for the others. */
  const plan = Effect.fn("LastdropCommandAnswers.plan")(function* (
    item: ApprovalItem,
    threadCwd: string | null,
  ) {
    const nativeId = item.nativeItemRef?.nativeId;
    if (step.provider === "antigravity") {
      if (nativeId == null) return unread(item);
      const raw = yield* rawToolCall(step.instanceId, nativeId, RAW_CALL_WAIT);
      return antigravityPlan(item, raw, threadCwd);
    }
    return itemPlan(
      item,
      nativeId == null ? undefined : tools.get(nativeId),
      step.provider === "codex",
      threadCwd,
    );
  });

  /** Decides, answers, logs; an answer the adapter refuses (the person answered first) shows nothing. */
  const answer = Effect.fn("LastdropCommandAnswers.answer")(function* (
    event: TurnItemEvent,
    item: ApprovalItem,
    threadCwd: string | null,
    policy: JudgePolicy,
    judged: boolean,
  ) {
    const decision = yield* decide(item, yield* plan(item, threadCwd), policy, judged);
    if (closing.signal.aborted) return;
    const reply: ProviderApprovalDecision = decision.allow ? "accept" : "decline";
    const answered = yield* input
      .respond({
        requestId: item.requestId as RuntimeRequestId,
        decision: reply,
        ...(!decision.allow && feedback.has(item.requestId)
          ? { feedback: refusalFeedback(decision.declined) }
          : {}),
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (!answered) return;
    services.log(
      `agent ${agent.name} (${stepLabel(step)}), thread ${item.threadId}: ${decision.allow ? decision.step : `Declined: ${decision.declined ?? decision.step}`}`,
    );
    pendingNotices.push(yield* notice(event, item, decision));
  });

  /**
   * The events to pass on for `event`: notices of decisions made since the last event first. A
   * waiting approval request under `auto` is answered in the background (the agent waits for it).
   */
  const onEvent = Effect.fn("LastdropCommandAnswers.onEvent")(function* (
    event: ProviderAdapterV2Event,
  ) {
    const before = pendingNotices;
    pendingNotices = [];
    if (
      event.type === "runtime_request.updated" &&
      event.runtimeRequest.responseCapability.type === "live"
    ) {
      if (event.runtimeRequest.responseCapability.supportsFeedback === true) {
        feedback.add(event.runtimeRequest.id);
        bound(feedback, MAX_IDS);
      }
    }
    if (event.type === "turn_item.updated") {
      const item = event.turnItem;
      recordItem(item);
      if (
        item.type === "approval_request" &&
        item.status === "waiting" &&
        item.requestKind !== "mcp-elicitation" &&
        !handled.has(item.requestId) &&
        !closing.signal.aborted
      ) {
        const policy = policies.get(threadKey(item.providerThreadId)) ?? input.openPolicy;
        const answering = lastdropAnswers(step, policy);
        if (answering !== undefined) {
          handled.add(item.requestId);
          bound(handled, MAX_IDS);
          yield* Effect.forkDetach(
            answer(event, item, policy.cwd, answering.policy, answering.judge).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("lastdrop command answer failed", cause),
              ),
            ),
          );
        }
      }
    }
    return [...before, event];
  });

  /** The session closed: its judges are killed and nothing more is answered. */
  const close = Effect.sync(() => closing.abort());

  return { onEvent, onMessage, close };
};
