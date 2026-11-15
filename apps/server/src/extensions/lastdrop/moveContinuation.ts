/**
 * After a usage-limit move the thread gets T3's restart follow-up: T3's note over the work the end cut
 * (read from the SDK stream), then T3's continue prompt. See docs/lastdrop/subagent-resume.md.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2RestartCancelledBackgroundWork,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { limitKind } from "@t3tools/lastdrop-node";

import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  restartCancelledBackgroundWorkNote,
} from "../../orchestration-v2/RestartBackgroundNote.ts";
import { CONTINUE_PROMPT } from "../../orchestration-v2/RestartContinuation.ts";

export type CutWork = OrchestrationV2RestartCancelledBackgroundWork;

/**
 * What T3's restart continuation sends for a run that was cut mid-turn (`RestartContinuation.ts`): its prompt
 * alone when nothing was cut, else its note over the cut work, a blank line, and its prompt.
 */
export function continuationText(work: ReadonlyArray<CutWork>): string {
  return work.length === 0
    ? CONTINUE_PROMPT
    : `${restartCancelledBackgroundWorkNote(work)}\n\n${CONTINUE_PROMPT}`;
}

/** Claude Code's task types T3 keeps as background shells, not subagents (ClaudeAdapterV2's opaque kinds). */
const SHELL_TASK_TYPES = new Set(["local_bash"]);

interface Task {
  readonly taskId: string;
  readonly taskType: string | undefined;
  readonly description: string | undefined;
  readonly prompt: string | undefined;
  readonly toolUseId: string | undefined;
  readonly parentTaskId: string | undefined;
  readonly backgrounded: boolean | undefined;
  /** Ended on its own (done, stopped, or failed for another reason than the limit). */
  ended: boolean;
}

const str = (o: unknown, key: string): string | undefined => {
  if (o === null || typeof o !== "object") return undefined;
  const v = Reflect.get(o, key);
  return typeof v === "string" ? v : undefined;
};

const isLimitText = (text: string | undefined) => text !== undefined && limitKind(text) !== "none";

function blocks(message: SDKMessage): ReadonlyArray<Record<string, unknown>> {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
    : [];
}

function toolResultText(block: Record<string, unknown>): string {
  const content = block["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => str(part, "text") ?? "").join("\n");
}

/**
 * The query's subagents and background shells, from its SDK frames, as T3 would list them cut: a task
 * (`task_started`) that never ended (`task_notification`, `task_updated` to a final status, or its launching
 * tool's result), or that failed because of the usage limit.
 */
export class CutWorkTracker {
  private readonly tasks = new Map<string, Task>();
  private readonly toolNames = new Map<string, string>();

  observe(message: SDKMessage): void {
    if (message.type === "assistant") {
      for (const b of blocks(message)) {
        const id = str(b, "id");
        const name = str(b, "name");
        if (b["type"] === "tool_use" && id !== undefined && name !== undefined)
          this.toolNames.set(id, name);
      }
      return;
    }
    if (message.type === "user") {
      for (const b of blocks(message)) {
        if (b["type"] !== "tool_result") continue;
        const task = this.byToolUse(str(b, "tool_use_id"));
        if (task === undefined || task.ended) continue;
        // A foreground Agent call's result ends it, unless the limit cut it.
        if (!(b["is_error"] === true && isLimitText(toolResultText(b)))) task.ended = true;
      }
      return;
    }
    if (message.type !== "system") return;
    const subtype = (message as { subtype?: string }).subtype;
    const taskId = str(message, "task_id");
    if (taskId === undefined) return;
    if (subtype === "task_started") {
      const backgrounded = Reflect.get(message, "is_backgrounded");
      this.tasks.delete(taskId);
      this.tasks.set(taskId, {
        taskId,
        taskType: str(message, "task_type"),
        description: str(message, "description"),
        prompt: str(message, "prompt"),
        toolUseId: str(message, "tool_use_id"),
        parentTaskId: str(message, "parent_task_id"),
        backgrounded: typeof backgrounded === "boolean" ? backgrounded : undefined,
        ended: false,
      });
      return;
    }
    const task = this.tasks.get(taskId);
    if (task === undefined) return;
    if (subtype === "task_notification") {
      const status = str(message, "status");
      task.ended = !(status === "failed" && isLimitText(str(message, "summary")));
    } else if (subtype === "task_updated") {
      const patch = Reflect.get(message, "patch");
      const status = str(patch, "status");
      if (status === "completed" || status === "killed") task.ended = true;
      else if (status === "failed") task.ended = !isLimitText(str(patch, "error"));
    }
  }

  /** The cut work, subagents first (T3 records turn items before the roster), each labelled by T3. */
  work(): ReadonlyArray<CutWork> {
    const out: CutWork[] = [];
    const subagents = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.ended || SHELL_TASK_TYPES.has(task.taskType ?? "")) continue;
      subagents.add(task.taskId);
      const work = cancelledTurnItemWork({
        type: "subagent",
        origin: "provider_native",
        id: `lastdrop-cut:${task.taskId}`,
        title: task.description ?? null,
        prompt: task.prompt ?? "",
        nativeItemRef: { driver: "claudeAgent", nativeId: task.taskId, strength: "strong" },
      } as unknown as OrchestrationV2TurnItem);
      if (work !== undefined) out.push(work);
    }
    for (const task of this.tasks.values()) {
      if (task.ended || !SHELL_TASK_TYPES.has(task.taskType ?? "")) continue;
      // T3's roster holds only backgrounded shells; one a recorded subagent started is covered by it.
      if (task.backgrounded === false) continue;
      if (task.parentTaskId !== undefined && subagents.has(task.parentTaskId)) continue;
      const pending: OrchestrationV2PendingBackgroundTask = {
        taskId: task.taskId,
        kind: this.toolNames.get(task.toolUseId ?? "") === "Monitor" ? "monitor" : "command",
        ...(task.description?.trim() ? { description: task.description } : {}),
        ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      };
      out.push(cancelledRosterTaskWork(pending));
    }
    return out;
  }

  private byToolUse(toolUseId: string | undefined): Task | undefined {
    if (toolUseId === undefined) return undefined;
    for (const task of this.tasks.values()) if (task.toolUseId === toolUseId) return task;
    return undefined;
  }
}

/** A thread the wrapper moved at a limit, waiting for T3 to settle its run. */
export interface PendingContinuation {
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly work: ReadonlyArray<CutWork>;
}

/** Shared by the wrapper (offers) and the reactor (takes); one per server process. */
export const pendingContinuations = (() => {
  const pending = new Map<string, PendingContinuation>();
  return {
    offer: (entry: PendingContinuation) => void pending.set(entry.threadId, entry),
    take: (threadId: string) => {
      const entry = pending.get(threadId);
      pending.delete(threadId);
      return entry;
    },
    /** A query opened on the thread first (the user spoke): no continuation any more. */
    drop: (threadId: string) => void pending.delete(threadId),
  };
})();
