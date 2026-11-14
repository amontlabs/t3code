// @effect-diagnostics nodeBuiltinImport:off - Joins lastdrop's log path.
/**
 * Under `auto` lastdrop answers an agent thread's approval requests (rules, read-only list, judge),
 * seen as waiting `approval_request` items in the router's stream and answered through the inner
 * adapter. Each decision is a notice row and a `lastdrop.log` line; what the judge can't decide is refused.
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
  readCatalogJudge,
  recordCall,
  runCommandJudge,
  type Decision,
  type JudgeAction,
  type JudgeContext,
  type JudgePolicy,
  type PermissionRules,
  type Verdict,
} from "@t3tools/lastdrop-node";
import {
  TurnItemId,
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

import { stepLabel, type AgentDefinition, type AgentStep } from "./catalog.ts";
import { standaloneCatalogFiles } from "./catalogSource.ts";
import { lastdropAnswers } from "./permissions.ts";

/** What the answers need from outside: seams for tests. */
export interface CommandAnswerServices {
  /** The user's rules where the agent works (read for each request, so an edit applies at once). */
  readonly rules: (cwd: string | null) => PermissionRules;
  /** Runs the judge on a prompt. Never throws: a failure is a verdict with `failure`. */
  readonly judge: (prompt: string) => Promise<Verdict>;
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

/** The standalone app's ways: settings files, the catalog's judge (read when each check runs), `agy`. */
export const defaultCommandAnswerServices: CommandAnswerServices = {
  rules: (cwd) => loadPermissionRules({ cwd: cwd ?? NodeOS.homedir() }),
  judge: (prompt) =>
    runCommandJudge(prompt, {
      executable: findAgy(),
      judge: readCatalogJudge(standaloneCatalogFiles().catalog),
    }),
  log: appendLog,
};

type TurnItemEvent = Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
type ApprovalItem = Extract<TurnItemEvent["turnItem"], { type: "approval_request" }>;

/** The action an approval item asks about, as the judge reads it. */
const approvalAction = (item: ApprovalItem, cwd: string | null): JudgeAction | undefined => {
  const prompt = item.prompt ?? "";
  const where = cwd === null ? {} : { cwd };
  switch (item.requestKind) {
    case "command":
      return prompt.trim() === ""
        ? { tool: "run_command", kind: "execute", label: "run_command", input: where }
        : {
            tool: "run_command",
            kind: "execute",
            label: actionLabel(prompt),
            command: prompt,
            input: { command: prompt, ...where },
          };
    case "file-change":
      return {
        tool: "edit",
        kind: "edit",
        label: actionLabel(`edit: ${prompt}`),
        input: { request: prompt, ...where },
      };
    case "file-read":
      return {
        tool: "read",
        kind: "read",
        label: actionLabel(`read: ${prompt}`),
        input: { request: prompt, ...where },
      };
    case "permission":
      return {
        tool: "permission",
        kind: "other",
        label: actionLabel(`permission: ${prompt}`),
        input: { request: prompt, ...where },
      };
    default:
      // MCP elicitations are questions for the person.
      return undefined;
  }
};

/** An identical action is decided once per session (the standalone app: once per run). */
const actionKey = (action: JudgeAction, policy: JudgePolicy): string =>
  [
    action.tool,
    action.kind,
    action.command ?? action.label,
    String(action.input.cwd ?? ""),
    policy,
  ].join("\u0001");

/** Provider threads by id; an item with none shares one key. */
const threadKey = (id: string | null | undefined): string => id ?? "";

/** What the agent is told with a refusal, where the provider takes feedback (`continuePrompt`). */
const refusalFeedback = (declined: string | undefined): string =>
  `${declined === undefined ? "That action was refused and can't run here." : `lastdrop refused ${declined}.`} That is final for this command: don't retry it or work around it. Go on with the task without it and give your report, naming anything refused that you needed and why.`;

/** One session's answers: its threads' modes and context, decisions made, notices to show. */
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
  const cache = new Map<string, Decision>();
  let pendingNotices: Array<ProviderAdapterV2Event> = [];
  const instructions = `The agent is "${agent.name}", one of the user's agents in T3 Code, running on ${stepLabel(step)}. Its role, as the user configured it: ${agent.description}`;

  const contextFor = (providerThreadId: string): JudgeContext =>
    contexts.get(providerThreadId) ?? { ...EMPTY_CONTEXT, instructions };

  /** A turn's or steer's message: trusted, like the user's own. */
  const onMessage = (
    providerThreadId: string,
    text: string,
    policy?: ProviderAdapterV2RuntimePolicy,
  ) => {
    if (policy !== undefined) policies.set(providerThreadId, policy);
    const context = contextFor(providerThreadId);
    if (text.trim() !== "")
      contexts.set(providerThreadId, { ...context, requests: [...context.requests, text] });
    else contexts.set(providerThreadId, context);
  };

  /** Earlier tool calls, inputs only. */
  const recordItem = (item: TurnItemEvent["turnItem"]) => {
    if (recorded.has(item.id)) return;
    let call: { tool: string; input: Record<string, unknown> } | undefined;
    if (item.type === "command_execution" && item.input.trim() !== "")
      call = { tool: "run_command", input: { command: item.input } };
    else if (item.type === "file_change") call = { tool: "edit", input: { file: item.fileName } };
    else if (item.type === "file_search" && item.pattern !== undefined)
      call = { tool: "file_search", input: { pattern: item.pattern } };
    else if (item.type === "web_search" && item.patterns !== undefined)
      call = { tool: "web_search", input: { patterns: item.patterns } };
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

  /** Decides, answers, logs; an answer the adapter refuses (the person answered first) shows nothing. */
  const answer = Effect.fn("LastdropCommandAnswers.answer")(function* (
    event: TurnItemEvent,
    item: ApprovalItem,
    action: JudgeAction,
    policy: JudgePolicy,
    judged: boolean,
  ) {
    const key = actionKey(action, policy);
    let decision = cache.get(key);
    if (decision === undefined) {
      let reachedJudge = false;
      const context = contextFor(threadKey(item.providerThreadId));
      const cwd = policies.get(threadKey(item.providerThreadId))?.cwd ?? input.openPolicy.cwd;
      decision = yield* Effect.promise(() =>
        decideAction({
          action,
          policy,
          rules: services.rules(cwd),
          context,
          judge: async (prompt) => {
            reachedJudge = true;
            if (!judged) return { allow: false, failure: "not judged" };
            return services.judge(prompt).catch((error: unknown) => ({
              allow: false,
              failure: error instanceof Error ? error.message : String(error),
            }));
          },
        }),
      );
      if (reachedJudge && !judged)
        decision = {
          allow: false,
          declined: `${action.label} (${stepLabel(step)}'s own reviewer left it to a person, and lastdrop asks nobody under auto)`,
          step: `Declined (its own reviewer asked a person): ${action.label}`,
        };
      cache.set(key, decision);
    }
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
        !handled.has(item.requestId)
      ) {
        const policy = policies.get(threadKey(item.providerThreadId)) ?? input.openPolicy;
        const answering = lastdropAnswers(step, policy);
        const action = answering === undefined ? undefined : approvalAction(item, policy.cwd);
        if (answering !== undefined && action !== undefined) {
          handled.add(item.requestId);
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

  return { onEvent, onMessage };
};
