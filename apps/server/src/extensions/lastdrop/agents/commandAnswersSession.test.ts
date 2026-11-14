/**
 * One session's answers, event by event (review fixes): the action is the tool item's, never the
 * approval's summary; other tools are judged as themselves; rules apply on every request and only
 * judge verdicts are kept; requests are bounded and a closed session answers nothing.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type ProviderRequestKind,
} from "@t3tools/contracts";
import type { PermissionRules, Verdict } from "@t3tools/lastdrop-node";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { allAgents, parseCatalog } from "./catalog.ts";
import { makeSessionAnswers } from "./commandAnswers.ts";

const driver = ProviderDriverKind.make("antigravity");
const agent = allAgents(
  parseCatalog({
    agents: [
      {
        name: "live",
        description: "Live checks.",
        provider: "antigravity",
        model: "m",
        enabled: true,
      },
    ],
  }),
).find((each) => each.name === "live")!;
const step = agent.chain[0]!;
const providerThreadId = ProviderThreadId.make("provider-thread:1");

const setup = Effect.fn("setup")(function* (options: {
  readonly rules?: () => PermissionRules;
  readonly judge?: (prompt: string, signal: AbortSignal) => Promise<Verdict>;
  readonly interactionMode?: "default" | "plan";
}) {
  const answers =
    yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput>();
  const prompts: Array<string> = [];
  const logs: Array<string> = [];
  let rules: PermissionRules = { allow: [], deny: [], ask: [] };
  const session = makeSessionAnswers({
    agent,
    step,
    services: {
      rules: options.rules ?? (() => rules),
      judge: async (prompt, signal) => {
        prompts.push(prompt);
        return options.judge === undefined
          ? { allow: true, risk: "low", authorization: "high", rationale: "ok" }
          : options.judge(prompt, signal);
      },
      log: (line) => logs.push(line),
    },
    openPolicy: {
      runtimeMode: "auto",
      interactionMode: options.interactionMode ?? "default",
      cwd: "/w",
    },
    respond: (response) => Queue.offer(answers, response).pipe(Effect.asVoid),
  });
  const at = yield* DateTime.now;
  const base = (id: string, ordinal: number) => ({
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread:1"),
    runId: RunId.make("run:1"),
    nodeId: NodeId.make("node:1"),
    providerThreadId,
    providerTurnId: ProviderTurnId.make("turn:1"),
    parentItemId: null,
    ordinal,
    status: "running" as const,
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
  });
  let n = 0;
  /** A tool item for native call `call`, then the waiting approval for it; the decision. */
  const ask = Effect.fn("ask")(function* (
    tool: Record<string, unknown> | undefined,
    request: { readonly kind?: ProviderRequestKind; readonly summary?: string } = {},
  ) {
    n += 1;
    const call = `call-${n}`;
    if (tool !== undefined)
      yield* session.onEvent({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...base(`item:tool:${n}`, n * 10),
          nativeItemRef: { driver, nativeId: call, strength: "strong" },
          ...tool,
        } as OrchestrationV2TurnItem,
      });
    yield* session.onEvent({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...base(`item:approval:${n}`, n * 10 + 1),
        nativeItemRef: { driver, nativeId: call, strength: "weak" },
        status: "waiting",
        type: "approval_request",
        requestId: RuntimeRequestId.make(`request:${n}`),
        requestKind: request.kind ?? "command",
        prompt: request.summary ?? "run_command",
      },
    });
    const answer = yield* Queue.take(answers);
    // The notice shows with the next event.
    const shown = yield* session.onEvent({
      type: "prompt_suggestion.updated",
      driver,
      threadId: ThreadId.make("thread:1"),
      runId: RunId.make("run:1"),
      text: "",
    });
    const notice = shown.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
        ? [event.turnItem.message]
        : [],
    )[0];
    return { decision: answer.decision, notice: notice ?? "", prompt: prompts.at(-1) };
  });
  const command = (input: string, title = "run_command") => ({
    type: "command_execution",
    title,
    input,
  });
  return {
    session,
    ask,
    command,
    prompts,
    logs,
    setRules: (next: PermissionRules) => {
      rules = next;
    },
  };
});

describe("the action is the tool's own, never the approval's summary (review item 1)", () => {
  it.effect("judges the real command, keyed by it, whatever the title says", () =>
    Effect.gen(function* () {
      const deny = async (prompt: string): Promise<Verdict> =>
        (prompt.split("<planned_action>")[1] ?? "").includes("rm -rf ~/Documents")
          ? {
              allow: false,
              risk: "critical",
              authorization: "unknown",
              rationale: "Deletes documents.",
            }
          : { allow: true, risk: "low", authorization: "high", rationale: "ok" };
      const t = yield* setup({ judge: deny });
      const first = yield* t.ask(t.command("rm -rf ~/Documents"));
      assert.equal(first.decision, "decline");
      assert.include(first.notice, "rm -rf ~/Documents");
      const planned = first.prompt!.split("<planned_action>")[1]!;
      assert.include(planned, `"command":"rm -rf ~/Documents"`);
      assert.notInclude(planned, `"command":"run_command"`);
      // Another command under the same title is its own action: no verdict carries over.
      const second = yield* t.ask(t.command("npm install"));
      assert.equal(second.decision, "accept");
      assert.deepEqual(t.prompts.length, 2);
      // A summary that looks read-only allows nothing: the real command is judged.
      const disguised = yield* t.ask(t.command("rm -rf ~/Documents"), { summary: "Run `ls`" });
      assert.equal(disguised.decision, "decline");
    }),
  );

  it.effect("refuses when the real command can't be read", () =>
    Effect.gen(function* () {
      const t = yield* setup({});
      // No tool item for the call.
      const unknown = yield* t.ask(undefined, { summary: "Run `ls`" });
      assert.equal(unknown.decision, "decline");
      assert.include(unknown.notice, "could not read which action");
      // The item's text is only the title, a fallback, the title's backticked part, or was cut.
      for (const tool of [
        t.command("run_command"),
        t.command("Command", "Command"),
        t.command("ls", "Run `ls`"),
        t.command("[Earlier output truncated]\n\nls -la"),
      ]) {
        const result = yield* t.ask(tool);
        assert.equal(result.decision, "decline", JSON.stringify(tool));
      }
      assert.deepEqual(t.prompts, [], "nothing unknown reaches the judge");
    }),
  );
});

describe("only shell commands go through shell rules and the read-only list (review item 2)", () => {
  it.effect("judges an MCP tool, a fetch or an Agent call as itself", () =>
    Effect.gen(function* () {
      const t = yield* setup({
        judge: async () => ({
          allow: false,
          risk: "high",
          authorization: "low",
          rationale: "Reads secrets.",
        }),
      });
      t.setRules({ allow: ["*"], deny: [], ask: [] });
      const mcp = yield* t.ask({
        type: "dynamic_tool",
        toolName: "mcp__ssh__exec",
        input: { command: "cat /etc/shadow" },
      });
      assert.equal(mcp.decision, "decline", "neither read-only nor allowed by a bare Bash rule");
      assert.include(mcp.prompt!, `"tool":"mcp__ssh__exec"`);
      assert.include(mcp.prompt!, "cat /etc/shadow");
      assert.include(mcp.notice, "mcp__ssh__exec");
      const fetch = yield* t.ask({ type: "web_search", patterns: ["https://example.com"] });
      assert.equal(fetch.decision, "decline");
      assert.include(fetch.prompt!, `"tool":"web_search"`);
      const subagent = yield* t.ask({
        type: "dynamic_tool",
        toolName: "Agent",
        input: { prompt: "ls" },
      });
      assert.equal(subagent.decision, "decline");
      assert.equal(t.prompts.length, 3);
      // A real shell command still takes the bare Bash rule.
      const shell = yield* t.ask(t.command("make deploy"));
      assert.equal(shell.decision, "accept");
      assert.include(shell.notice, "Allowed by your rule Bash(*)");
    }),
  );

  it.effect("refuses edits in plan mode without the judge", () =>
    Effect.gen(function* () {
      const t = yield* setup({ interactionMode: "plan" });
      const edit = yield* t.ask(
        { type: "file_change", fileName: "src/a.ts" },
        { kind: "file-change" },
      );
      assert.equal(edit.decision, "decline");
      assert.include(edit.notice, "read-only agent");
      assert.deepEqual(t.prompts, []);
    }),
  );
});

describe("rules on every request, only judge verdicts kept (review item 5)", () => {
  it.effect("applies a deny rule added after an allow, and judges again after a failure", () =>
    Effect.gen(function* () {
      let calls = 0;
      const t = yield* setup({
        judge: async () => {
          calls += 1;
          return calls === 1
            ? { allow: false, failure: "timed out" }
            : { allow: true, risk: "low", authorization: "high", rationale: "ok" };
        },
      });
      t.setRules({ allow: ["make *"], deny: [], ask: [] });
      assert.equal((yield* t.ask(t.command("make deploy"))).decision, "accept");
      t.setRules({ allow: ["make *"], deny: ["make deploy"], ask: [] });
      assert.equal(
        (yield* t.ask(t.command("make deploy"))).decision,
        "decline",
        "the new deny rule applies",
      );
      t.setRules({ allow: [], deny: [], ask: [] });
      // The judge times out once: refused, and asked again next time.
      assert.equal((yield* t.ask(t.command("npm publish"))).decision, "decline");
      assert.equal((yield* t.ask(t.command("npm publish"))).decision, "accept");
      // A verdict is kept: the same action isn't judged again.
      assert.equal((yield* t.ask(t.command("npm publish"))).decision, "accept");
      assert.equal(calls, 2);
      // A deny rule still refuses a command the judge allowed before.
      t.setRules({ allow: [], deny: ["npm *"], ask: [] });
      assert.equal((yield* t.ask(t.command("npm publish"))).decision, "decline");
      assert.equal(calls, 2);
    }),
  );
});

describe("bounded requests, closed sessions (review item 6)", () => {
  it.effect("keeps the latest 10 messages", () =>
    Effect.gen(function* () {
      const t = yield* setup({
        judge: async () => ({ allow: false, risk: "high", authorization: "low", rationale: "no" }),
      });
      for (let i = 1; i <= 25; i += 1) t.session.onMessage(providerThreadId, `message ${i}`);
      const result = yield* t.ask(t.command("make deploy"));
      const messages = result.prompt!.match(/message \d+/g) ?? [];
      assert.deepEqual(
        messages,
        Array.from({ length: 10 }, (_, i) => `message ${i + 16}`),
      );
    }),
  );

  it.effect("aborts its judges and answers nothing once closed", () =>
    Effect.gen(function* () {
      let markStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      let markAborted: () => void = () => undefined;
      const aborted = new Promise<void>((resolve) => (markAborted = resolve));
      const t = yield* setup({
        judge: (_prompt, signal) =>
          new Promise<Verdict>((resolve) => {
            signal.addEventListener("abort", () => {
              markAborted();
              resolve({ allow: false, failure: "the session closed" });
            });
            markStarted();
          }),
      });
      const at = yield* DateTime.now;
      yield* t.session.onEvent({
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make("item:tool:x"),
          threadId: ThreadId.make("thread:1"),
          runId: RunId.make("run:1"),
          nodeId: NodeId.make("node:1"),
          providerThreadId,
          providerTurnId: ProviderTurnId.make("turn:1"),
          nativeItemRef: { driver, nativeId: "call-x", strength: "strong" },
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: "run_command",
          startedAt: at,
          completedAt: null,
          updatedAt: at,
          type: "command_execution",
          input: "make deploy",
        },
      });
      yield* t.session.onEvent({
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make("item:approval:x"),
          threadId: ThreadId.make("thread:1"),
          runId: RunId.make("run:1"),
          nodeId: NodeId.make("node:1"),
          providerThreadId,
          providerTurnId: ProviderTurnId.make("turn:1"),
          nativeItemRef: { driver, nativeId: "call-x", strength: "weak" },
          parentItemId: null,
          ordinal: 2,
          status: "waiting",
          title: null,
          startedAt: at,
          completedAt: null,
          updatedAt: at,
          type: "approval_request",
          requestId: RuntimeRequestId.make("request:x"),
          requestKind: "command",
          prompt: "run_command",
        },
      });
      yield* Effect.promise(() => started);
      yield* t.session.close;
      yield* Effect.promise(() => aborted);
      assert.deepEqual(t.logs, [], "no answer after the session closed");
    }),
  );
});
