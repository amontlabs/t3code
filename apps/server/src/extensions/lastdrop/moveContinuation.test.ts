// The continuation after a usage-limit move: the cut work read from recorded SDK frames, labelled and worded by
// T3's own restart functions.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  restartCancelledBackgroundWorkNote,
} from "../../orchestration-v2/RestartBackgroundNote.ts";
import { CONTINUE_PROMPT, continuationText, CutWorkTracker } from "./moveContinuation.ts";
import { continuationCommand } from "./moveContinuationLayer.ts";

const frame = (o: Record<string, unknown>) =>
  ({ session_id: "s", uuid: "u", ...o }) as unknown as SDKMessage;
const toolUse = (id: string, name: string) =>
  frame({
    type: "assistant",
    parent_tool_use_id: null,
    message: { model: "claude-haiku-4-5", content: [{ type: "tool_use", id, name, input: {} }] },
  });
const started = (o: Record<string, unknown>) =>
  frame({ type: "system", subtype: "task_started", ...o });
const notified = (taskId: string, status: string, summary = "") =>
  frame({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    summary,
    output_file: "",
  });
const toolResult = (toolUseId: string, isError: boolean, text: string) =>
  frame({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: isError,
          content: [{ type: "text", text }],
        },
      ],
    },
  });
const LIMIT =
  "Agent terminated early due to an API error: You've hit your 5-hour limit · resets 5pm";

const track = (frames: ReadonlyArray<SDKMessage>) => {
  const tracker = new CutWorkTracker();
  for (const f of frames) tracker.observe(f);
  return tracker.work();
};

describe("the continuation after a usage-limit move", () => {
  it("nothing cut: exactly what T3 sends after a restart with nothing cut", () => {
    assert.equal(continuationText([]), CONTINUE_PROMPT);
    assert.deepEqual(
      track(
        [toolUse("t1", "Agent"), started({ task_id: "a1", tool_use_id: "t1" })].concat(
          toolResult("t1", false, "done"),
        ),
      ),
      [],
    );
  });

  it("lists a limit-failed subagent and a still-running one, labelled by T3, and none that ended", () => {
    const work = track([
      toolUse("t-fail", "Agent"),
      started({
        task_id: "a-fail",
        tool_use_id: "t-fail",
        task_type: "local_agent",
        description: "Remember the code word",
        prompt: "Remember PELICAN, write it to a file, then three more steps.",
        is_backgrounded: false,
      }),
      started({
        task_id: "a-run",
        tool_use_id: "t-run",
        task_type: "local_agent",
        description: "Long survey",
        is_backgrounded: true,
      }),
      started({
        task_id: "a-done",
        tool_use_id: "t-done",
        task_type: "local_agent",
        description: "Quick look",
      }),
      notified("a-done", "completed", "ok"),
      started({
        task_id: "a-other",
        tool_use_id: "t-other",
        task_type: "local_agent",
        description: "Broke",
      }),
      notified("a-other", "failed", "File not found"),
      started({ task_id: "a-stop", task_type: "local_agent", description: "Stopped" }),
      frame({
        type: "system",
        subtype: "task_updated",
        task_id: "a-stop",
        patch: { status: "killed" },
      }),
      started({ task_id: "a-upd", task_type: "local_agent", description: "Limit via update" }),
      frame({
        type: "system",
        subtype: "task_updated",
        task_id: "a-upd",
        patch: { status: "failed", error: LIMIT },
      }),
      toolResult("t-fail", true, LIMIT),
    ]);
    const t3 = (taskId: string, title: string, prompt = "") =>
      cancelledTurnItemWork({
        type: "subagent",
        origin: "provider_native",
        id: `lastdrop-cut:${taskId}`,
        title,
        prompt,
        nativeItemRef: { driver: "claudeAgent", nativeId: taskId, strength: "strong" },
      } as unknown as OrchestrationV2TurnItem)!;
    assert.deepEqual(work, [
      t3("a-fail", "Remember the code word"),
      t3("a-run", "Long survey"),
      t3("a-upd", "Limit via update"),
    ]);
    assert.deepEqual(work[0], {
      kind: "subagent",
      label: "Remember the code word (id a-fail)",
      id: "lastdrop-cut:a-fail",
    });
    const text = continuationText(work);
    assert.equal(text, `${restartCancelledBackgroundWorkNote(work)}\n\n${CONTINUE_PROMPT}`);
    assert.include(text, "- subagent: Remember the code word (id a-fail)");
    assert.isTrue(text.startsWith("Note: the T3 server restarted"));
    assert.isTrue(text.endsWith(CONTINUE_PROMPT));
  });

  it("a subagent without a title is labelled by its prompt, as T3 does", () => {
    const [work] = track([
      started({
        task_id: "a1",
        task_type: "local_agent",
        description: "",
        prompt: "Count to three",
      }),
    ]);
    assert.equal(work?.label, "Count to three (id a1)");
  });

  it("background shells and monitors still running are listed after subagents, as T3's roster lists them", () => {
    const work = track([
      toolUse("b1", "Bash"),
      started({
        task_id: "sh1",
        tool_use_id: "b1",
        task_type: "local_bash",
        description: "npm run dev",
        is_backgrounded: true,
      }),
      toolUse("m1", "Monitor"),
      started({
        task_id: "mo1",
        tool_use_id: "m1",
        task_type: "local_bash",
        description: "watch the log",
        is_backgrounded: true,
      }),
      started({
        task_id: "sh-done",
        tool_use_id: "b2",
        task_type: "local_bash",
        description: "sleep 1",
        is_backgrounded: true,
      }),
      notified("sh-done", "completed"),
      started({ task_id: "a1", task_type: "local_agent", description: "Builder" }),
      // A shell the cut subagent started is covered by the subagent's entry.
      started({
        task_id: "sh-sub",
        task_type: "local_bash",
        description: "tsc --watch",
        parent_task_id: "a1",
        is_backgrounded: true,
      }),
    ]);
    assert.deepEqual(
      work.map((w) => w.kind),
      ["subagent", "shell", "monitor"],
    );
    assert.deepEqual(
      work[1],
      cancelledRosterTaskWork({ taskId: "sh1", kind: "command", description: "npm run dev" }),
    );
    assert.deepEqual(
      work[2],
      cancelledRosterTaskWork({ taskId: "mo1", kind: "monitor", description: "watch the log" }),
    );
    assert.equal(work[1]?.label, "npm run dev (id sh1)");
  });

  it("a subagent resumed after it ended counts as running again", () => {
    const work = track([
      started({ task_id: "a1", task_type: "local_agent", description: "Writer" }),
      notified("a1", "completed", "ok"),
      started({
        task_id: "a1",
        task_type: "local_agent",
        description: "Writer",
        is_backgrounded: true,
      }),
    ]);
    assert.deepEqual(
      work.map((w) => w.label),
      ["Writer (id a1)"],
    );
  });

  it("is dispatched like T3's restart continuation: server-made, started at once, on the run's model", () => {
    const work = track([
      started({ task_id: "a1", task_type: "local_agent", description: "Writer" }),
    ]);
    const modelSelection = { instanceId: "claudeAgent", model: "claude-haiku-4-5" };
    const command = continuationCommand(
      { payload: { id: "run-1", modelSelection } } as unknown as Parameters<
        typeof continuationCommand
      >[0],
      { threadId: "thread-1", from: "claude-2", to: "main", work },
    );
    assert.equal(command.type, "message.dispatch");
    assert.equal(command.threadId, "thread-1");
    assert.equal(command.text, continuationText(work));
    assert.equal(command.notification.detail, command.text);
    assert.deepEqual(command.modelSelection, modelSelection);
    assert.deepEqual(command.dispatchMode, { type: "start_immediately" });
    assert.equal(command.createdBy, "agent");
    assert.equal(command.creationSource, "server");
  });
});
