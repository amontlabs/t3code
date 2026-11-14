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
  sortedJson,
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
import { stepLabel, type AgentDefinition, type AgentStep } from "./catalog.ts";
import { standaloneCatalogFiles } from "./catalogSource.ts";
import { lastdropAnswers } from "./permissions.ts";

/** What the answers need from outside: seams for tests. */
export interface CommandAnswerServices {
  /** The user's rules where the agent works (read for each request, so an edit applies at once). */
  readonly rules: (cwd: string | null) => PermissionRules;
  /** Runs the judge on a prompt; `signal` aborts when the session closes. Never throws. */
  readonly judge: (prompt: string, signal: AbortSignal) => Promise<Verdict>;
  readonly log: (line: string) => void;
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
export const JUDGE_CONCURRENCY = 3;
const judgeLimit = makeJudgeLimit(JUDGE_CONCURRENCY);

/** The standalone app's ways: settings files, the catalog's judge (read when each check runs), `agy`. */
export const defaultCommandAnswerServices: CommandAnswerServices = {
  rules: (cwd) => loadPermissionRules({ cwd: cwd ?? NodeOS.homedir() }),
  judge: (prompt, signal) =>
    judgeLimit(() =>
      runCommandJudge(prompt, {
        executable: findAgy(),
        judge: readCatalogJudge(standaloneCatalogFiles().catalog),
        signal,
      }),
    ),
  log: appendLog,
};

/** Swift keeps the latest 10 requests (`AntigravityBackend.run`). */
const MAX_REQUESTS = 10;

type TurnItemEvent = Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
type ApprovalItem = Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;

/** Provider fallbacks for a command whose text the request didn't carry. */
const GENERIC_COMMAND_TEXT = new Set(["command", "monitor", "terminal", "run_command", "bash"]);

/**
 * The shell command a `command_execution` item runs, as the provider read it from the tool's own
 * input (Antigravity `CommandLine`, Claude `Bash.command`, Codex `exec`). Undefined when the text
 * may be the title or a fallback, or was cut: then nobody knows what would run.
 */
export const realCommand = (
  item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
): string | undefined => {
  const command = item.input.trim();
  const title = (item.title ?? "").trim();
  if (command === "" || GENERIC_COMMAND_TEXT.has(command.toLowerCase())) return undefined;
  if (command === title || title.includes(`\`${command}\``)) return undefined;
  if (isCutAntigravityToolText(item.input)) return undefined;
  return item.input;
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
  item.type === "dynamic_tool" ? (item.toolName ?? "tool") : item.type === "file_change" ? "edit" : item.type;

/**
 * The action an approval asks about, from the tool item the provider made for the same native call
 * (the approval itself carries only a summary). Only a real shell command goes through the shell
 * rules and the read-only list; any other tool goes to the judge with its name and input, as in the
 * standalone app. Undefined when the call is unknown or its command can't be read: refused.
 */
export const approvalAction = (
  item: ApprovalItem,
  tool: OrchestrationV2TurnItem | undefined,
  cwd: string | null,
): JudgeAction | undefined => {
  if (tool === undefined) return undefined;
  const where = cwd === null ? {} : { cwd };
  if (tool.type === "command_execution") {
    const command = realCommand(tool);
    if (command === undefined) return undefined;
    return {
      tool: "run_command",
      kind: "execute",
      label: actionLabel(command),
      command,
      input: { command, ...where },
    };
  }
  const name = toolName(tool);
  const kind =
    tool.type === "file_change" || item.requestKind === "file-change"
      ? "edit"
      : item.requestKind === "file-read"
        ? "read"
        : tool.type === "web_search"
          ? "fetch"
          : "other";
  const input = toolInput(tool);
  const detail = sortedJson(input);
  return {
    tool: name,
    kind,
    label: actionLabel(detail === "{}" ? name : `${name}: ${detail}`),
    input: { ...input, ...where },
  };
};

/** An action the judge decided, by its full content and mode. */
const verdictKey = (action: JudgeAction, policy: JudgePolicy): string =>
  sortedJson({ tool: action.tool, kind: action.kind, input: action.input, policy });

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
  /** The latest tool item for each native call, which an approval for that call is about. */
  const tools = new Map<string, OrchestrationV2TurnItem>();
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
    if (nativeId != null && item.type !== "approval_request") tools.set(nativeId, item);
    if (recorded.has(item.id)) return;
    let call: { tool: string; input: Record<string, unknown> } | undefined;
    if (item.type === "command_execution") {
      const command = realCommand(item);
      if (command !== undefined) call = { tool: "run_command", input: { command } };
    } else if (
      item.type === "file_change" ||
      item.type === "file_search" ||
      item.type === "web_search" ||
      item.type === "dynamic_tool"
    )
      call = { tool: toolName(item), input: toolInput(item) };
    if (call === undefined) return;
    recorded.add(item.id);
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

  /** The judge, once per identical action and mode; a failure is never kept. */
  const judgeOnce = (key: string) => async (prompt: string): Promise<Verdict> => {
    const kept = verdicts.get(key);
    if (kept !== undefined) return kept;
    const verdict = await services.judge(prompt, closing.signal).catch(
      (error: unknown): Verdict => ({
        allow: false,
        failure: error instanceof Error ? error.message : String(error),
      }),
    );
    if (verdict.failure === undefined) verdicts.set(key, verdict);
    return verdict;
  };

  const decide = Effect.fn("LastdropCommandAnswers.decide")(function* (
    item: ApprovalItem,
    action: JudgeAction | undefined,
    policy: JudgePolicy,
    judged: boolean,
  ) {
    if (action === undefined) {
      const what = actionLabel(item.prompt?.trim() || item.requestKind);
      return {
        allow: false,
        declined: `${what} (lastdrop could not read which action this request is for)`,
        step: `Declined (the action could not be read): ${what}`,
      } satisfies Decision;
    }
    let reachedJudge = false;
    const cwd = policies.get(threadKey(item.providerThreadId))?.cwd ?? input.openPolicy.cwd;
    const judge = judgeOnce(verdictKey(action, policy));
    const decision = yield* Effect.promise(() =>
      decideAction({
        action,
        policy,
        rules: services.rules(cwd),
        context: contextFor(threadKey(item.providerThreadId)),
        judge: async (prompt) => {
          reachedJudge = true;
          return judged ? judge(prompt) : { allow: false, failure: "not judged" };
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

  /** Decides, answers, logs; an answer the adapter refuses (the person answered first) shows nothing. */
  const answer = Effect.fn("LastdropCommandAnswers.answer")(function* (
    event: TurnItemEvent,
    item: ApprovalItem,
    action: JudgeAction | undefined,
    policy: JudgePolicy,
    judged: boolean,
  ) {
    const decision = yield* decide(item, action, policy, judged);
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
      if (event.runtimeRequest.responseCapability.supportsFeedback === true)
        feedback.add(event.runtimeRequest.id);
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
          const nativeId = item.nativeItemRef?.nativeId;
          const action = approvalAction(
            item,
            nativeId == null ? undefined : tools.get(nativeId),
            policy.cwd,
          );
          yield* Effect.forkDetach(
            answer(event, item, action, answering.policy, answering.judge).pipe(
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
