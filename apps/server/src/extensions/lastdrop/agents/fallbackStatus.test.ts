/**
 * What waits on a run must see one run when lastdrop falls back partway: `t3 thread start --wait`
 * (T3's `waitForThread`, behind `t3_thread_wait`) and a `delegate_task` parent waiting on its
 * child. Agent `build` runs on Codex, whose first run ends at a usage limit; lastdrop continues on
 * Claude. Neither observer may see the first run fail.
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
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import { ClaudeProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../../../orchestration-v2/ProviderSessionManager.ts";
import { runOutcome } from "../../../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import type { AgentDefinition } from "./catalog.ts";
import {
  CONTINUE_TEXT,
  continuationCommandId,
  continuationMessageId,
  runFallbackReactor,
} from "./fallback.ts";
import { makeFallbackSignals, makeRoom } from "./room.ts";
import { makeRouterAdapter } from "./router.ts";
import { makeFakeAdapter, makeFakeCalls, type FakeCalls } from "./testkit.ts";

const LASTDROP = ProviderInstanceId.make("lastdrop");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const PARENT = ProviderInstanceId.make("parentClaude");
const projectId = ProjectId.make("project:lastdrop-fallback-status");

const BUILD: AgentDefinition = {
  name: "build",
  description: "Implementation.",
  enabled: true,
  chain: [
    { provider: "codex", instanceId: CODEX, providerLabel: "Codex", model: "gpt-6.1-sol" },
    { provider: "claude", instanceId: CLAUDE, providerLabel: "Claude", model: "sonnet" },
  ],
};
const SELECTION: ModelSelection = { instanceId: LASTDROP, model: "build" };
const LIMIT = makeProviderFailure({
  message: "You've hit your usage limit.",
  class: "usage_limit",
  code: "usage_limit",
});

interface ServerOptions {
  /** Claude first, then Codex (default: Codex first). */
  readonly claudeFirst?: boolean;
  /** Run ordinals the first entry fails at its limit (default: run 1). */
  readonly limitedRuns?: ReadonlySet<number>;
  /** What the reactor sees of T3's orchestrator, to fail its re-send. */
  readonly reactorOrchestrator?: (
    orchestrator: Orchestrator.OrchestratorV2["Service"],
  ) => Orchestrator.OrchestratorV2["Service"];
  /** What the reactor sees of T3's session manager, to fail its release. */
  readonly reactorSessions?: (
    sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"],
  ) => ProviderSessionManager.ProviderSessionManagerV2["Service"];
}

/** The fake inner adapters' calls, for what the next entry got. */
let lastCalls: { readonly codex: FakeCalls; readonly claude: FakeCalls } | undefined;

/** T3's orchestrator with fake Codex, Claude and a held parent instance, plus lastdrop. */
const withServer = <A, E, R>(
  name: string,
  holdParent: Deferred.Deferred<void>,
  body: Effect.Effect<A, E, R>,
  options: ServerOptions = {},
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const limited = options.limitedRuns ?? new Set([1]);
    const calls = { codex: yield* makeFakeCalls, claude: yield* makeFakeCalls };
    lastCalls = calls;
    const codex = makeFakeAdapter({
      instanceId: CODEX,
      driver: ProviderDriverKind.make("codex"),
      capabilities: CodexProviderCapabilitiesV2,
      calls: calls.codex,
      ...(options.claudeFirst ? {} : { failedRunOrdinals: limited, failure: LIMIT }),
    });
    const claude = makeFakeAdapter({
      instanceId: CLAUDE,
      driver: ProviderDriverKind.make("claudeAgent"),
      capabilities: ClaudeProviderCapabilitiesV2,
      calls: calls.claude,
      ...(options.claudeFirst ? { failedRunOrdinals: limited, failure: LIMIT } : {}),
    });
    const parent = makeFakeAdapter({
      instanceId: PARENT,
      driver: ProviderDriverKind.make("claudeAgent"),
      capabilities: ClaudeProviderCapabilitiesV2,
      calls: yield* makeFakeCalls,
      holdTurns: holdParent,
    });
    const signals = makeFallbackSignals();
    const lastdrop = makeRouterAdapter({
      instanceId: LASTDROP,
      agents: () =>
        options.claudeFirst ? [{ ...BUILD, chain: [BUILD.chain[1]!, BUILD.chain[0]!] }] : [BUILD],
      resolveTarget: (id) =>
        Effect.succeed(id === CODEX ? codex : id === CLAUDE ? claude : undefined),
      room: makeRoom(),
      fallbacks: signals,
    });
    const harness = ProviderReplayHarness.layerWithRegistry(
      {
        name,
        runtimePolicyOverride: {
          cwd,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        },
      },
      ProviderAdapterRegistry.layerFromAdapters([codex, claude, parent, lastdrop]),
    );
    const layer = Layer.mergeAll(
      harness,
      ThreadManagementService.layer.pipe(
        Layer.provide(harness),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
      EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
    );
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      yield* Effect.forkScoped(
        runFallbackReactor(signals).pipe(
          Effect.provideService(
            Orchestrator.OrchestratorV2,
            options.reactorOrchestrator?.(orchestrator) ?? orchestrator,
          ),
          Effect.provideService(
            ProviderSessionManager.ProviderSessionManagerV2,
            options.reactorSessions?.(sessions) ?? sessions,
          ),
        ),
      );
      return yield* body;
    }).pipe(Effect.provide(layer));
  });

const createThread = (threadId: ThreadId, modelSelection: ModelSelection) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      createdBy: "user",
      creationSource: "web",
      title: "Fallback status",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`first:${threadId}`),
      messageId: MessageId.make(`first:${threadId}`),
      threadId,
      text: "Original request: rename the config loader",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    return (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
  });

describe("lastdrop fallback partway: one run for what waits on it", () => {
  it.live("t3 thread start --wait follows the run to the next entry's result", () =>
    Effect.scoped(
      withServer(
        "lastdrop-fallback-wait",
        Deferred.makeUnsafe<void>(),
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("thread:lastdrop-fallback-wait");
          const run1 = yield* createThread(threadId, SELECTION);
          // What `t3_thread_wait` runs for `--wait`, on the run the CLI started.
          const waited = yield* threads.waitForThread({
            projectId,
            threadId,
            runId: run1.id,
            timeoutMs: 20_000,
          });
          assert.isFalse(waited.timedOut);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run2 = projection.runs.find((run) => run.ordinal === 2);
          assert.isDefined(run2, "lastdrop continued in a second run");
          assert.equal(waited.run?.id, run2!.id);
          assert.equal(runOutcome(waited.run!), "completed");
          // The result the CLI prints is the next entry's answer.
          assert.isTrue(
            projection.turnItems.some(
              (item) =>
                item.runId === run2!.id &&
                item.type === "assistant_message" &&
                item.text === "claudeAgent answer for run 2",
            ),
          );
        }),
      ),
    ),
  );

  it.live("a delegate_task parent sees its child complete, never fail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const holdParent = yield* Deferred.make<void>();
        yield* withServer(
          "lastdrop-fallback-delegate",
          holdParent,
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const parentId = ThreadId.make("thread:lastdrop-fallback-parent");
            const parentRun = yield* createThread(parentId, {
              instanceId: PARENT,
              model: "sonnet",
            });
            // Every state the parent's task row goes through.
            const seen = yield* Ref.make<ReadonlyArray<OrchestrationV2Subagent>>([]);
            const watcher = yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) => event.type === "subagent.updated" && event.threadId === parentId,
              ),
              Stream.map(({ event }) => (event as { payload: OrchestrationV2Subagent }).payload),
              Stream.tap((task) => Ref.update(seen, (all) => [...all, task])),
              Stream.takeUntil((task) => task.result !== null),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("delegate"),
              parentThreadId: parentId,
              parentRunId: parentRun.id,
              parentNodeId: parentRun.rootNodeId!,
              task: "Rename the config loader",
              modelSelection: SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
            const childId = task.childThreadId!;
            const childRun1 = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
            // delegate_task in wait mode waits on the child's run like this.
            const waited = yield* threads.waitForThread({
              projectId,
              threadId: childId,
              runId: childRun1.id,
              timeoutMs: 20_000,
            });
            assert.equal(runOutcome(waited.run!), "completed");
            yield* Fiber.join(watcher).pipe(Effect.timeout("20 seconds"));
            const states = yield* Ref.get(seen);
            for (const state of states)
              assert.notInclude(
                ["failed", "cancelled", "interrupted"],
                state.status,
                JSON.stringify(state),
              );
            const settled = states.at(-1)!;
            assert.equal(settled.status, "completed");
            assert.equal(settled.result, "claudeAgent answer for run 2");
            // The parent heard of the child once, with its real result.
            yield* Deferred.succeed(holdParent, undefined);
            const parent = yield* orchestrator.getThreadProjection(parentId);
            const wakes = parent.messages.filter(
              (message) => message.delegatedCompletion !== undefined,
            );
            assert.isAtMost(wakes.length, 1);
            for (const wake of wakes) assert.notMatch(wake.text, /fail|cancel/i);
          }),
        );
      }),
    ),
  );
  it.live("Codex as the next entry gets the continue prompt, not a native resume", () =>
    Effect.scoped(
      withServer(
        "lastdrop-fallback-codex-next",
        Deferred.makeUnsafe<void>(),
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const threadId = ThreadId.make("thread:lastdrop-fallback-codex-next");
          const run1 = yield* createThread(threadId, SELECTION);
          const waited = yield* threads.waitForThread({
            projectId,
            threadId,
            runId: run1.id,
            timeoutMs: 20_000,
          });
          assert.equal(runOutcome(waited.run!), "completed");
          const inputs = (yield* Ref.get(lastCalls!.codex.inputs)).filter(
            (input): input is { message: { text: string } } =>
              typeof input === "object" && input !== null && "runOrdinal" in input,
          );
          assert.lengthOf(inputs, 1);
          // With the link, CodexAdapterV2 resumes natively and starts the turn with no input.
          assert.notProperty(inputs[0]!, "restartContinuationOfRunId");
          assert.include(inputs[0]!.message.text, CONTINUE_TEXT);
          // The earlier conversation reaches the new entry (T3's handoff, here injected).
          assert.include(
            JSON.stringify(yield* Ref.get(lastCalls!.codex.injected)),
            "Original request: rename the config loader",
          );
        }),
        { claudeFirst: true },
      ),
    ),
  );

  it.live("a delegate_task parent gets its child's run when the handover fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recovered = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* withServer(
          "lastdrop-fallback-resend-fails",
          Deferred.makeUnsafe<void>(),
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const parentId = ThreadId.make("thread:lastdrop-fallback-resend-parent");
            const parentRun = yield* createThread(parentId, {
              instanceId: PARENT,
              model: "sonnet",
            });
            const settled = yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) => event.type === "subagent.updated" && event.threadId === parentId,
              ),
              Stream.map(({ event }) => (event as { payload: OrchestrationV2Subagent }).payload),
              Stream.filter((task) => task.result !== null || task.status === "cancelled"),
              Stream.runHead,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("delegate-resend-fails"),
              parentThreadId: parentId,
              parentRunId: parentRun.id,
              parentNodeId: parentRun.rootNodeId!,
              task: "Rename the config loader",
              modelSelection: SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const task = yield* Fiber.join(settled).pipe(Effect.timeout("20 seconds"));
            assert.isTrue(Option.isSome(task));
            assert.notEqual(Option.getOrThrow(task).status, "completed");
            // T3 skipped the child's task while the marker was pending; with no continuation,
            // only this call settles it (T3 makes it after declining its own continuation).
            const childId = Option.getOrThrow(task).childThreadId!;
            const childRun1 = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
            assert.deepEqual(yield* Ref.get(recovered), [`${childId} ${childRun1.id}`]);
          }),
          {
            // The handover fails before anything is re-sent (as when the run ends interrupted).
            reactorOrchestrator: (orchestrator) => ({
              ...orchestrator,
              getThreadProjection: () => Effect.die(new Error("the thread could not be read")),
              recoverDelegatedTask: (threadId, options) =>
                Ref.update(recovered, (all) => [
                  ...all,
                  `${threadId} ${options?.sourceRunId}`,
                ]).pipe(Effect.andThen(orchestrator.recoverDelegatedTask(threadId, options))),
            }),
          },
        );
      }),
    ),
  );

  it.live("a session that could not be released fails its next limit as T3's own", () =>
    Effect.scoped(
      withServer(
        "lastdrop-fallback-release-fails",
        Deferred.makeUnsafe<void>(),
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("thread:lastdrop-fallback-release-fails");
          const run2Failed = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.threadId === threadId &&
                event.payload.ordinal === 2 &&
                event.payload.status === "failed",
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* createThread(threadId, SELECTION);
          yield* Fiber.join(run2Failed).pipe(Effect.timeout("20 seconds"));
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const [run1, run2] = projection.runs;
          assert.equal(run1!.status, "cancelled");
          assert.equal(run2!.restartContinuationOfRunId, run1!.id);
          // Visible, and T3's limit recovery arms on it; no third run on the limited session.
          assert.equal(run2!.status, "failed");
          assert.lengthOf(projection.runs, 2);
          assert.isTrue(
            projection.turnItems.some((item) => item.type === "error" && item.runId === run2!.id),
          );
          // What T3's limit recovery reads.
          const shell = yield* orchestrator.getThreadShell(threadId);
          assert.equal(shell?.status, "failed");
          assert.equal(shell?.lastErrorClass, "usage_limit");
        }),
        {
          limitedRuns: new Set([1, 2]),
          reactorSessions: (sessions) => ({
            ...sessions,
            release: () => Effect.die(new Error("the session did not close")),
          }),
        },
      ),
    ),
  );
  it.live("T3's own continuation of the run is the same one, never a second", () =>
    Effect.scoped(
      withServer(
        "lastdrop-fallback-one-continuation",
        Deferred.makeUnsafe<void>(),
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("thread:lastdrop-fallback-one-continuation");
          const run1 = yield* createThread(threadId, SELECTION);
          yield* threads.waitForThread({ projectId, threadId, runId: run1.id, timeoutMs: 20_000 });
          const before = yield* orchestrator.getThreadProjection(threadId);
          const run2 = before.runs.find((run) => run.ordinal === 2)!;
          assert.equal(run2.userMessageId, continuationMessageId(run1.id));
          // What T3's worker dispatches when it runs the marker after the grace: the same command,
          // so it replays ours whatever state the continuation is in (T3's own check skips only a
          // later run that is no longer queued).
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: continuationCommandId(run1.id),
            messageId: continuationMessageId(run1.id),
            threadId,
            text: "T3's restart prompt",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "server",
            restartContinuationOfRunId: run1.id,
          });
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(after.runs, before.runs.length);
          assert.lengthOf(after.messages, before.messages.length);
        }),
      ),
    ),
  );
});
