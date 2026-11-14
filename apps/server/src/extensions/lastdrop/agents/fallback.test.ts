/**
 * Fallback partway through a run, through T3's real orchestrator: agent `build` runs on Codex,
 * whose first run does some work and then ends at a usage limit. lastdrop must say so in the
 * thread, continue on Claude (the next entry) in a new provider conversation, and hand the
 * conversation over with T3's portable handoff.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import { ClaudeProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type { AgentDefinition } from "./catalog.ts";
import { CONTINUE_TEXT, INTERRUPTED_COMMAND_NOTE, runFallbackReactor } from "./fallback.ts";
import { makeFallbackSignals, makeRoom } from "./room.ts";
import { makeRouterAdapter } from "./router.ts";
import { makeFakeAdapter, makeFakeCalls } from "./testkit.ts";

const LASTDROP = ProviderInstanceId.make("lastdrop");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const ANTIGRAVITY = ProviderInstanceId.make("antigravity");
const threadId = ThreadId.make("thread:lastdrop-fallback");
const projectId = ProjectId.make("project:lastdrop-fallback");

const BUILD: AgentDefinition = {
  name: "build",
  description: "Implementation.",
  enabled: true,
  chain: [
    { provider: "codex", instanceId: CODEX, providerLabel: "Codex", model: "gpt-6.1-sol" },
    // Has room, but fails to open: the reopen goes past it, and the notice must say so.
    {
      provider: "antigravity",
      instanceId: ANTIGRAVITY,
      providerLabel: "Antigravity",
      model: "claude-sonnet-5-5",
    },
    { provider: "claude", instanceId: CLAUDE, providerLabel: "Claude", model: "sonnet" },
  ],
};
const SELECTION: ModelSelection = {
  instanceId: LASTDROP,
  model: "build",
  options: [{ id: "effort", value: "high" }],
};

describe("lastdrop fallback partway through a run", () => {
  it.live("continues on the next entry with a notice and T3's portable handoff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("lastdrop-fallback");
        const codexCalls = yield* makeFakeCalls;
        const claudeCalls = yield* makeFakeCalls;
        const codex = makeFakeAdapter({
          instanceId: CODEX,
          driver: ProviderDriverKind.make("codex"),
          capabilities: CodexProviderCapabilitiesV2,
          calls: codexCalls,
          failedRunOrdinals: new Set([1]),
          commandAtLimit: true,
          failure: makeProviderFailure({
            message: "You've hit your usage limit.",
            class: "usage_limit",
            code: "usage_limit",
          }),
        });
        const claude = makeFakeAdapter({
          instanceId: CLAUDE,
          driver: ProviderDriverKind.make("claudeAgent"),
          capabilities: ClaudeProviderCapabilitiesV2,
          calls: claudeCalls,
        });
        const antigravity = makeFakeAdapter({
          instanceId: ANTIGRAVITY,
          driver: ProviderDriverKind.make("antigravity"),
          capabilities: ClaudeProviderCapabilitiesV2,
          calls: yield* makeFakeCalls,
          failOpen: true,
        });
        const room = makeRoom();
        const signals = makeFallbackSignals();
        const lastdrop = makeRouterAdapter({
          instanceId: LASTDROP,
          agents: () => [BUILD],
          resolveTarget: (id) =>
            Effect.succeed(
              id === CODEX
                ? codex
                : id === CLAUDE
                  ? claude
                  : id === ANTIGRAVITY
                    ? antigravity
                    : undefined,
            ),
          room,
          fallbacks: signals,
        });
        const registry = ProviderAdapterRegistry.layerFromAdapters([codex, claude, lastdrop]);

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* Effect.forkScoped(runFallbackReactor(signals));
          const settled = (ordinal: number) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Fallback",
            modelSelection: SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            messageId: MessageId.make("first"),
            threadId,
            text: "Original request: rename the config loader",
            attachments: [],
            modelSelection: SELECTION,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* settled(1);
          yield* settled(2);

          const projection = yield* orchestrator.getThreadProjection(threadId);
          // Run 1 failed at the limit on Codex; run 2 is lastdrop's continuation and completed.
          assert.deepEqual(
            projection.runs.map((run) => [run.ordinal, run.status, run.modelSelection.model]),
            [
              [1, "failed", "build"],
              [2, "completed", "build"],
            ],
          );
          // The switch is in the thread, not silent.
          const notices = projection.turnItems.flatMap((item) =>
            item.type === "system_notice" ? [{ run: item.runId, message: item.message }] : [],
          );
          const [run1, run2] = projection.runs;
          // Run 1 says it stops at the limit and names no entry: the reopen decides.
          assert.deepEqual(
            notices.filter((notice) => notice.run === run1!.id).map((notice) => notice.message),
            [
              "build reached a usage limit on Codex · gpt-6.1-sol. lastdrop continues on the next entry with room; the next run names it.",
            ],
          );
          // Run 2 names exactly the entry it runs on, and why the others did not.
          assert.deepEqual(
            notices.filter((notice) => notice.run === run2!.id).map((notice) => notice.message),
            [
              "build continues on Claude · sonnet: Codex · gpt-6.1-sol reached a usage limit (until " +
                notices
                  .find((notice) => notice.run === run2!.id)!
                  .message.split("(until ")[1]!
                  .split(")")[0] +
                "); Antigravity · claude-sonnet-5-5 failed to open. The conversation is handed over.",
            ],
          );
          // Claude ran the continuation in a new native conversation, at the run's effort.
          const claudeTurns = yield* Ref.get(claudeCalls.turns);
          assert.equal(claudeTurns.length, 1);
          // The limit came mid-command: the next entry is told to check before redoing it.
          assert.equal(claudeTurns[0]!.text, `${CONTINUE_TEXT}\n\n${INTERRUPTED_COMMAND_NOTE}`);
          assert.deepEqual(claudeTurns[0]!.modelSelection, {
            instanceId: CLAUDE,
            model: "sonnet",
            options: [{ id: "effort", value: "high" }],
          });
          assert.equal(claudeTurns[0]!.nativeThreadId, `claudeAgent:${threadId}`);
          // T3's portable handoff delivered the earlier conversation, partial work included.
          const injected = JSON.stringify(yield* Ref.get(claudeCalls.injected));
          assert.include(injected, "Original request: rename the config loader");
          assert.include(injected, "Partial work by codex");
          assert.isTrue(
            projection.contextHandoffs.some((handoff) => handoff.delivery?.status === "injected"),
          );
          // The opened Claude session was not handed Codex's native thread.
          const claudeOpen = (yield* Ref.get(claudeCalls.opened))[0]!;
          assert.isUndefined(claudeOpen.initialNativeThreadId);
          assert.isUndefined(claudeOpen.resumeFromSession);
          // Codex is out of room now; persisted identity stays lastdrop's.
          assert.isFalse(yield* room.hasRoom(BUILD.chain[0]!));
          for (const run of projection.runs) assert.equal(run.providerInstanceId, LASTDROP);
          for (const thread of projection.providerThreads)
            assert.equal(thread.providerInstanceId, LASTDROP);
          for (const calls of [codexCalls, claudeCalls]) {
            const seen = JSON.stringify(yield* Ref.get(calls.inputs));
            assert.notInclude(seen, '"lastdrop"');
            assert.notInclude(seen, '"model":"build"');
          }
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "lastdrop-fallback",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              registry,
            ),
          ),
        );
      }),
    ),
  );

  it.live("says at open which entry runs, when the first has no room", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("lastdrop-open-notice");
        const claudeCalls = yield* makeFakeCalls;
        const claude = makeFakeAdapter({
          instanceId: CLAUDE,
          driver: ProviderDriverKind.make("claudeAgent"),
          capabilities: ClaudeProviderCapabilitiesV2,
          calls: claudeCalls,
        });
        const codexOut = makeFakeAdapter({
          instanceId: CODEX,
          driver: ProviderDriverKind.make("codex"),
          capabilities: CodexProviderCapabilitiesV2,
          calls: yield* makeFakeCalls,
        });
        const room = makeRoom();
        yield* room.markOut(BUILD.chain[0]!, "2099-01-01T00:00:00.000Z");
        const lastdrop = makeRouterAdapter({
          instanceId: LASTDROP,
          agents: () => [BUILD],
          // Antigravity is not set up here; Codex is, but out of room.
          resolveTarget: (id) =>
            Effect.succeed(id === CLAUDE ? claude : id === CODEX ? codexOut : undefined),
          room,
          fallbacks: makeFallbackSignals(),
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Open notice",
            modelSelection: SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            messageId: MessageId.make("first"),
            threadId,
            text: "Hello",
            attachments: [],
            modelSelection: SELECTION,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
            Effect.andThen(worker.drain()),
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.runs[0]!.status, "completed");
          assert.deepEqual(
            projection.turnItems.flatMap((item) =>
              item.type === "system_notice" ? [item.message] : [],
            ),
            [
              "build runs on Claude · sonnet: Codex · gpt-6.1-sol reached a usage limit (until 2099-01-01 00:00 UTC); Antigravity · claude-sonnet-5-5 is not set up.",
            ],
          );
          assert.equal((yield* Ref.get(claudeCalls.turns)).length, 1);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "lastdrop-open-notice",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              ProviderAdapterRegistry.layerFromAdapters([claude, lastdrop]),
            ),
          ),
        );
      }),
    ),
  );
});
