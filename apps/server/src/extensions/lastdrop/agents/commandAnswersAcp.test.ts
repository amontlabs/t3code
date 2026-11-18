/**
 * T3's real Antigravity adapter under the router, fed agy's own ACP shapes through T3's ACP replay
 * agent: `run_command` titled calls whose command is only in `rawInput.CommandLine`. lastdrop must
 * judge that command, never the title (review item 1).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "../../../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";
import { makeAntigravityAdapterV2 } from "../../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { observeAntigravitySessionEvent } from "../../acpToolCalls.ts";
import { allAgents, parseCatalog } from "./catalog.ts";
import { makeFallbackSignals, makeRoom } from "./room.ts";
import { makeRouterAdapter } from "./router.ts";

const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const LASTDROP = ProviderInstanceId.make("lastdropAgents");
const SESSION = "agy-replay-session-1";

const agents = allAgents(
  parseCatalog({
    agents: [
      {
        name: "live",
        description: "Live checks.",
        provider: "antigravity",
        model: "gemini-test",
        enabled: true,
      },
    ],
  }),
);

/** One agy call: `tool_call` in progress, then `session/request_permission` for it (agy's order). */
/** One agy call as sent: `tool_call` in progress, then `session/request_permission` for it. */
const toolCall = (
  id: string,
  fields: Record<string, unknown>,
  optionId: "allow" | "deny",
  permission: Record<string, unknown> = {},
) => {
  const call = { toolCallId: id, ...fields };
  return callFrames(id, call, { ...call, ...permission }, optionId);
};

const commandCall = (
  id: string,
  command: string,
  optionId: "allow" | "deny",
  naming: Record<string, unknown> = { name: "run_command", title: command },
) =>
  toolCall(
    id,
    {
      ...naming,
      kind: "execute",
      rawInput: {
        CommandLine: command,
        Cwd: "<workspace>",
        WaitMsBeforeAsync: 5000,
        toolSummary: "my own words",
      },
    },
    optionId,
  );

const callFrames = (
  id: string,
  call: Record<string, unknown>,
  permissionCall: Record<string, unknown>,
  optionId: "allow" | "deny",
) => {
  return [
    {
      type: "emit_inbound",
      label: `tool.started:${id}`,
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: SESSION,
          update: { sessionUpdate: "tool_call", status: "in_progress", ...call },
        },
      },
    },
    {
      type: "emit_inbound",
      label: `permission.request:${id}`,
      frame: {
        kind: "request",
        method: "session/request_permission",
        params: {
          sessionId: SESSION,
          toolCall: { ...permissionCall, status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      },
    },
    {
      type: "expect_outbound",
      label: `permission.response:${id}`,
      frame: {
        kind: "response",
        method: "session/request_permission",
        result: { outcome: { outcome: "selected", optionId } },
      },
    },
    {
      type: "emit_inbound",
      label: `tool.done:${id}`,
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: SESSION,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: optionId === "allow" ? "completed" : "failed",
            rawOutput: { output: optionId === "allow" ? "fake output" : "" },
          },
        },
      },
    },
  ];
};

const transcript = {
  type: "transcript_start",
  provider: "antigravity",
  protocol: "acp.ndjson-jsonrpc",
  version: "1",
  scenario: "lastdrop_antigravity_command_approvals",
  entries: [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        kind: "request",
        method: "initialize",
        params: "<any>",
      },
    },
    {
      type: "emit_inbound",
      label: "initialized",
      frame: {
        kind: "response",
        method: "initialize",
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [{ id: "replay", name: "Replay" }],
          agentInfo: { name: "agy-replay", version: "1" },
        },
      },
    },
    {
      type: "expect_outbound",
      label: "session.new",
      frame: { kind: "request", method: "session/new", params: "<any>" },
    },
    {
      type: "emit_inbound",
      label: "session.created",
      frame: {
        kind: "response",
        method: "session/new",
        result: {
          sessionId: SESSION,
          models: {
            currentModelId: "gemini-test",
            availableModels: [{ modelId: "gemini-test", name: "Gemini test" }],
          },
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gemini-test",
              options: [{ value: "gemini-test", name: "Gemini test" }],
            },
          ],
        },
      },
    },
    // accept-edits: what auto becomes on Antigravity, lastdrop answering the commands.
    {
      type: "expect_outbound",
      label: "session.mode",
      frame: {
        kind: "request",
        method: "session/set_config_option",
        params: { sessionId: SESSION, configId: "mode", value: "auto_edit" },
      },
    },
    {
      type: "emit_inbound",
      label: "session.mode.set",
      frame: {
        kind: "response",
        method: "session/set_config_option",
        result: {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gemini-test",
              options: [{ value: "gemini-test", name: "Gemini test" }],
            },
            {
              id: "mode",
              name: "Mode",
              type: "select",
              currentValue: "auto_edit",
              options: [
                { value: "default", name: "Default" },
                { value: "auto_edit", name: "Accept edits" },
                { value: "plan", name: "Plan" },
              ],
            },
          ],
        },
      },
    },
    {
      type: "expect_outbound",
      label: "session.prompt",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    },
    // The real command is judged: agy 1.5.9+ names run_command in `name` and the command in
    // `title`; older agy named it in `title`. A read-only command is allowed (no verdict carries over).
    ...commandCall("call-1", "rm -rf ~/Documents", "deny"),
    ...commandCall("call-2", "ls -la", "allow", { title: "run_command" }),
    // A title that looks read-only does not make its real command so: not agy's run_command, refused.
    ...commandCall("call-3", "rm -rf ~/Documents", "deny", { title: "Run `ls`" }),
    // Review 2, item 1: no rawInput, a backticked title. T3 takes `ls` from the title; nothing
    // says what runs, so it is refused without the judge.
    ...toolCall("call-4", { title: "Run `ls`", kind: "execute" }, "deny"),
    // Item 2: not agy's run_command, though it carries a `command`: judged as the tool it is.
    ...toolCall("call-5", { title: "ssh_exec", rawInput: { command: "cat /etc/shadow" } }, "deny"),
    // A run_command whose input doesn't decode: refused.
    ...toolCall(
      "call-6",
      { title: "run_command", kind: "execute", rawInput: { CommandLine: "ls", Cwd: 5 } },
      "deny",
    ),
    // The request names another command than the call: refused.
    ...toolCall(
      "call-7",
      {
        title: "run_command",
        kind: "execute",
        rawInput: { CommandLine: "ls -la", Cwd: "<workspace>" },
      },
      "deny",
      { title: "Run `rm -rf x`" },
    ),
    {
      type: "emit_inbound",
      label: "assistant.final",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: SESSION,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "prompt.completed",
      frame: { kind: "response", method: "session/prompt", result: { stopReason: "end_turn" } },
    },
    { type: "runtime_exit", status: "success" },
  ],
};

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("lastdrop on T3's real Antigravity adapter", () => {
  it.live("judges rawInput.CommandLine, never the run_command title", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* SecureRandom.SecureRandom;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "lastdrop-acp-replay-",
      });
      const decoded = yield* decodeAcpReplayTranscript(
        transcript as never,
        ProviderDriverKind.make("antigravity"),
      );
      const statusPath = path.join(workspace, "status.json");
      const replay = makeAcpReplayRuntime({
        transcript: decoded,
        statusPath,
        scriptPath: yield* path.fromFileUrl(
          new URL("../../../../scripts/acp-replay-agent.ts", import.meta.url),
        ),
        childProcessSpawner,
        fileSystem,
      });
      const antigravity = yield* makeAntigravityAdapterV2({
        instanceId: ANTIGRAVITY,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          replay(input as never).pipe(Effect.provideService(SecureRandom.SecureRandom, crypto)),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
        // What the driver's seam does in the app: agy's own calls reach lastdrop.
        onSessionEvent: (event) =>
          Effect.sync(() => observeAntigravitySessionEvent(ANTIGRAVITY, event)),
      });
      const prompts: Array<string> = [];
      const notices: Array<string> = [];
      const router = makeRouterAdapter({
        instanceId: LASTDROP,
        agents: () => agents,
        resolveTarget: (id) => Effect.succeed(id === ANTIGRAVITY ? antigravity : undefined),
        room: makeRoom(),
        fallbacks: makeFallbackSignals(),
        innerRuntimeModes: () =>
          Effect.succeed(["approval-required", "auto-accept-edits", "full-access"]),
        commandAnswers: {
          rules: () => ({ allow: [], deny: [], ask: [] }),
          judge: async (prompt) => {
            prompts.push(prompt);
            const planned = prompt.split("<planned_action>")[1] ?? "";
            return planned.includes("rm -rf") || planned.includes("ssh_exec")
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
      const threadId = ThreadId.make("thread-lastdrop-acp");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "auto",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId: LASTDROP, model: "live" } as const;
      const session = yield* router.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-lastdrop-acp"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* session.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* session.startTurn({
        ...makeTurnInput({
          threadId,
          providerThread,
          instanceId: LASTDROP,
          runtimePolicy,
          now: yield* DateTime.now,
          modelSelection,
          messageText: "List the files in this folder.",
        }),
      });
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice")
          notices.push(event.turnItem.message);
        if (event.type === "turn.terminal") break;
      }
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, decoded);
      // The answers themselves are the transcript's expected ACP responses (checked above).
      const shown = notices.filter((notice) => !notice.startsWith("live runs on"));
      assert.deepEqual(shown.slice(0, 3), [
        "Declined: rm -rf ~/Documents (not covered by your allow rules; judge: critical risk, user authorization unknown. Deletes documents.)",
        "Allowed as read-only (ls): ls -la",
        // Not agy's run_command (its title is changed): a command-running tool lastdrop can't read.
        "Declined: ls (lastdrop could not read which command this request is for)",
      ]);
      assert.include(shown[3]!, "could not read which command");
      assert.include(shown[4]!, "ssh_exec");
      assert.include(shown[5]!, "could not read which command");
      assert.include(shown[6]!, "names another command");
      assert.equal(shown.length, 7);
      const planned = prompts.map((prompt) => prompt.split("<planned_action>")[1]!);
      assert.deepEqual(
        planned.map((text) =>
          text.includes("ssh_exec")
            ? "ssh_exec"
            : text.includes("rm -rf ~/Documents")
              ? "rm"
              : "other",
        ),
        ["rm", "ssh_exec"],
        "ls, the unreadable and the mismatched calls never reach the judge",
      );
      assert.include(planned[1]!, `"tool":"ssh_exec"`);
      assert.include(planned[1]!, "cat /etc/shadow");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
