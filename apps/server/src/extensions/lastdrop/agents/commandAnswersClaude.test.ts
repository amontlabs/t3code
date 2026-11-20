// @effect-diagnostics nodeBuiltinImport:off - Reads T3's recorded Claude fixture to build a transcript.
/**
 * T3's real Claude adapter under the router (an OpenRouter-style Claude entry), fed Claude Agent SDK
 * frames built from T3's recorded `tool_call_denied_write` fixture: a Bash call, an MCP tool whose
 * input holds a shell command, then a read-only Bash call. Only Bash is a shell command (review
 * items 1 and 2).
 */
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as ClaudeAdapterV2 from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeTurnInput } from "../../../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import type { AgentDefinition } from "./catalog.ts";
import { makeFallbackSignals, makeRoom } from "./room.ts";
import { makeRouterAdapter } from "./router.ts";

const CLAUDE = ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID;
const LASTDROP = ProviderInstanceId.make("lastdropAgents");
const MODEL = "claude-sonnet-4-6";
const PROMPT = "List the files in this folder.";

const agents: ReadonlyArray<AgentDefinition> = [
  {
    name: "cheap",
    description: "Cheap work.",
    enabled: true,
    chain: [
      { provider: "openrouter", instanceId: CLAUDE, providerLabel: "OpenRouter", model: MODEL },
    ],
  },
];

type Entry = { type: string; label?: string; frame?: Record<string, unknown> } & Record<
  string,
  unknown
>;

const fixture = NodeFS.readFileSync(
  new URL(
    "../../../orchestration-v2/testkit/fixtures/tool_call_denied_write/claude_transcript.ndjson",
    import.meta.url,
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Entry);

const session = String((fixture[0]!.metadata as Record<string, unknown>).nativeSessionId);
const toolUseTemplate = fixture.find(
  (entry) =>
    entry.label === "assistant" && JSON.stringify(entry.frame).includes(`"type":"tool_use"`),
)!;
const resultFrame = fixture.find((entry) => entry.label === "result")!;

/** Claude's assistant message calling `name` with `input`, its permission request, our answer, the result. */
const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
) => {
  const frame = structuredClone(toolUseTemplate.frame!) as { message: { content: Array<unknown> } };
  frame.message.content = [{ type: "tool_use", id, name, input, caller: { type: "direct" } }];
  return [
    { type: "emit_inbound", label: "assistant", frame },
    {
      type: "emit_inbound",
      label: `permission.request:${name}`,
      frame: {
        type: "permission.request",
        toolName: name,
        input,
        options: { displayName: name, toolUseID: id },
      },
    },
    {
      type: "expect_outbound",
      label: `permission.response:${name}`,
      frame: { type: "permission.response", result: { ...response, toolUseID: id } },
    },
    {
      type: "emit_inbound",
      label: "user",
      frame: {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: "done",
              is_error: response.behavior !== "allow",
              tool_use_id: id,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: session,
      },
    },
  ];
};

const declined = (detail: string) => ({
  behavior: "deny",
  message: `The user declined this tool call and said:\nlastdrop refused ${detail}. That is final for this command: don't retry it or work around it. Go on with the task without it and give your report, naming anything refused that you needed and why.`,
  decisionClassification: "user_reject",
});

const transcript = {
  ...fixture[0]!,
  scenario: "lastdrop_claude_tool_approvals",
  entries: [
    {
      type: "expect_outbound",
      label: "query.open",
      frame: {
        type: "query.open",
        options: {
          model: MODEL,
          tools: { type: "preset", preset: "claude_code" },
          permissionMode: "acceptEdits",
          sessionId: session,
          settings: { showThinkingSummaries: true },
        },
      },
    },
    {
      type: "expect_outbound",
      label: "prompt.offer:1",
      frame: {
        type: "prompt.offer",
        message: {
          type: "user",
          message: { role: "user", content: PROMPT },
          parent_tool_use_id: null,
        },
      },
    },
    ...fixture
      .slice(1)
      .filter((entry) => entry.label === "system")
      .slice(0, 3),
    ...call(
      "toolu_bash_rm",
      "Bash",
      { command: "rm -rf ~/Documents", description: "Clean up" },
      declined(
        "rm -rf ~/Documents (not covered by your allow rules; judge: critical risk, user authorization unknown. Deletes documents.)",
      ),
    ),
    ...call(
      "toolu_mcp_ssh",
      "mcp__ssh__exec",
      { command: "cat /etc/shadow" },
      declined(
        'mcp__ssh__exec: {"input":{"command":"cat /etc/shadow"}} (judge: high risk, user authorization low. Runs a command on another host.)',
      ),
    ),
    ...call(
      "toolu_bash_ls",
      "Bash",
      { command: "ls -la", description: "List files" },
      {
        behavior: "allow",
        updatedInput: { command: "ls -la", description: "List files" },
        decisionClassification: "user_temporary",
      },
    ),
    resultFrame,
    { type: "runtime_exit", status: "success" },
  ],
};

describe("lastdrop on T3's real Claude adapter", () => {
  it.live("judges Bash's own command, and an MCP tool as itself", () =>
    Effect.gen(function* () {
      const decoded = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(transcript as never);
      const replay = makeClaudeRestartReplayHarness(decoded);
      const registry = yield* Effect.service(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ).pipe(Effect.provide(replay.harness.makeProviderAdapterRegistryLayer(decoded)));
      const claude = yield* registry.get(CLAUDE).pipe(Effect.orDie);
      const prompts: Array<string> = [];
      const router = makeRouterAdapter({
        instanceId: LASTDROP,
        agents: () => agents,
        resolveTarget: (id) => Effect.succeed(id === CLAUDE ? claude : undefined),
        room: makeRoom(),
        fallbacks: makeFallbackSignals(),
        commandAnswers: {
          // No rules: Bash goes to the read-only list and the judge, the MCP tool to the judge.
          rules: () => ({ allow: [], deny: [], ask: [] }),
          judge: async (prompt) => {
            prompts.push(prompt);
            const planned = prompt.split("<planned_action>")[1] ?? "";
            if (planned.includes("mcp__ssh__exec"))
              return {
                allow: false,
                risk: "high",
                authorization: "low",
                rationale: "Runs a command on another host.",
              };
            return planned.includes("rm -rf")
              ? {
                  allow: false,
                  risk: "critical",
                  authorization: "unknown",
                  rationale: "Deletes documents.",
                }
              : { allow: true, risk: "low", authorization: "high", rationale: "ok" };
          },
          log: () => undefined,
        },
      });
      const threadId = ThreadId.make("thread-lastdrop-claude");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "auto",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId: LASTDROP, model: "cheap" } as const;
      const runtime = yield* router.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-lastdrop-claude"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId: LASTDROP,
          runtimePolicy,
          now: yield* DateTime.now,
          modelSelection,
          messageText: PROMPT,
        }),
      );
      const notices: Array<string> = [];
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice")
          notices.push(event.turnItem.message);
        if (event.type === "turn.terminal") break;
      }
      yield* replay.assertComplete;
      assert.deepEqual(notices, [
        "Declined: rm -rf ~/Documents (not covered by your allow rules; judge: critical risk, user authorization unknown. Deletes documents.)",
        'Declined: mcp__ssh__exec: {"input":{"command":"cat /etc/shadow"}} (judge: high risk, user authorization low. Runs a command on another host.)',
        "Allowed as read-only (ls): ls -la",
      ]);
      assert.equal(prompts.length, 2, "ls never reaches the judge; the MCP tool does");
      assert.include(prompts[1]!.split("<planned_action>")[1]!, `"tool":"mcp__ssh__exec"`);
    }).pipe(Effect.provide(McpProviderSessions.layer), Effect.scoped),
  );
});
