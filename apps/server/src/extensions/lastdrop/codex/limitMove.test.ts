/**
 * A Codex thread at its account's usage limit, through T3's real orchestrator and Codex adapter: the app-server is
 * a scripted fake per account home. With another account signed in and with room, the thread continues there on
 * the same native thread with T3's continue prompt and lastdrop's notice; with none, T3's own limit failure stays.
 */
// @effect-diagnostics nodeBuiltinImport:off - the accounts' files live in a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { codexAccountFiles } from "@t3tools/lastdrop-node";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexError from "effect-codex-app-server/errors";

import * as ServerConfig from "../../../config.ts";
import * as CodexAdapterV2 from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { CONTINUE_PROMPT } from "../../../orchestration-v2/RestartContinuation.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { pendingContinuations } from "../moveContinuation.ts";
import * as MoveContinuation from "../moveContinuationLayer.ts";
import { type CodexOpenInput, wrapCodexClientFactory } from "./factory.ts";
import { makeCodexRouting } from "./routing.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const RESET_SECONDS = Math.floor(Date.parse("2099-01-01T00:00:00.000Z") / 1000);
const NATIVE = "native-thread-1";
const MODEL = "gpt-6-luna";
const SHARED_HOME = "/nonexistent/shared/.codex";
const LIMIT_MESSAGE = "You've hit your usage limit.";

const turn = (id: string, status: string, error: unknown = null) => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error,
  startedAt: 1790295630,
  completedAt: status === "inProgress" ? null : 1790295635,
  durationMs: null,
});

const threadResult = (home: string) => ({
  thread: {
    id: NATIVE,
    sessionId: NATIVE,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    projectId: null,
    modelProvider: "openai",
    model: MODEL,
    reasoningEffort: null,
    createdAt: 1790295630,
    updatedAt: 1790295630,
    status: { type: "idle" },
    path: `${home}/sessions/${NATIVE}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.156.1",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  },
  model: MODEL,
  modelProvider: "openai",
  serviceTier: null,
  cwd: "/workspace",
  instructionSources: [],
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
  reasoningEffort: null,
});

const fullSnapshot = {
  limitId: "codex",
  primary: { usedPercent: 100, resetsAt: RESET_SECONDS, windowDurationMins: 300 },
};

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

/**
 * Codex's app-server for one account home: answers T3's requests, and on `turn/start` plays the turn. A full
 * account ends it at the limit (Codex's update, final error and failed completion); another completes it.
 */
function fakeAppServer(home: string, full: boolean, seen: Array<[string, Request]>) {
  return Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const send = (frame: unknown) =>
      Queue.offerUnsafe(input, encoder.encode(`${JSON.stringify(frame)}\n`));
    const notify = (method: string, params: unknown) => send({ method, params });
    let buffered = "";
    const answer = (request: Request) => {
      const result = (value: unknown) => send({ id: request.id, result: value });
      switch (request.method) {
        case "initialize":
          return result({
            userAgent: "T3 Code/test",
            codexHome: home,
            platformFamily: "unix",
            platformOs: "macos",
          });
        case "thread/start":
        case "thread/resume":
          return result(threadResult(home));
        case "account/rateLimits/read":
          return result({ rateLimits: fullSnapshot, rateLimitsByLimitId: { codex: fullSnapshot } });
        case "turn/start": {
          const turnId = `turn-${seen.filter(([, r]) => r.method === "turn/start").length}`;
          result({ turn: turn(turnId, "inProgress") });
          notify("turn/started", { threadId: NATIVE, turn: turn(turnId, "inProgress") });
          if (!full) {
            return notify("turn/completed", { threadId: NATIVE, turn: turn(turnId, "completed") });
          }
          notify("account/rateLimits/updated", { rateLimits: fullSnapshot });
          const error = { message: LIMIT_MESSAGE, codexErrorInfo: "usageLimitExceeded" };
          notify("error", {
            threadId: NATIVE,
            turnId,
            willRetry: false,
            error: { ...error, additionalDetails: null },
          });
          return notify("turn/completed", {
            threadId: NATIVE,
            turn: turn(turnId, "failed", error),
          });
        }
        default:
          return send({ id: request.id, error: { code: -32601, message: "not in this fake" } });
      }
    };
    const onChunk = (chunk: string | Uint8Array) =>
      Effect.sync(() => {
        buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          const frame = JSON.parse(line) as Partial<Request>;
          if (typeof frame.id !== "number" || typeof frame.method !== "string") continue;
          const request = { id: frame.id, method: frame.method, params: frame.params };
          seen.push([home, request]);
          answer(request);
        }
      });
    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () => Sink.forEach(onChunk),
      stderr: () => Sink.drain,
    });
    return yield* CodexClient.make(
      stdio,
      {},
      Effect.succeed(new CodexError.CodexAppServerProcessExitedError({ code: 0 })),
    );
  });
}

const threadId = ThreadId.make("thread:lastdrop-codex-limit");
const SETTINGS = Schema.decodeSync(CodexSettings)({ homePath: SHARED_HOME });
const SELECTION: ModelSelection = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: MODEL,
};

/** Runs a thread's first message with accounts A and B signed in; `fullB` puts B at its limit too. */
function runAtLimit(fullB: boolean) {
  return Effect.gen(function* () {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-codex-limit-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dataDir, { recursive: true, force: true })),
    );
    const files = codexAccountFiles(dataDir);
    yield* Effect.promise(async () => {
      await files.editList(() => ({
        accounts: [
          { key: "A", addedAt: 1 },
          { key: "B", addedAt: 2 },
        ],
      }));
      for (const key of ["A", "B"]) {
        NodeFS.mkdirSync(files.home(key), { recursive: true });
        NodeFS.writeFileSync(`${files.home(key)}/auth.json`, "{}");
      }
      // A has the most room, so the new thread opens there.
      await files.updateUsage("A", () => ({
        readAt: NOW,
        limits: { limitId: "codex", primary: { usedPercent: 10, resetsAt: RESET_SECONDS } },
      }));
      await files.updateUsage("B", () => ({
        readAt: NOW,
        limits: fullB
          ? fullSnapshot
          : { limitId: "codex", primary: { usedPercent: 40, resetsAt: RESET_SECONDS } },
      }));
    });
    const log: string[] = [];
    const routing = makeCodexRouting({ files, now: () => NOW, log: (line) => log.push(line) });
    const seen: Array<[string, Request]> = [];
    const opened: string[] = [];
    const inner = {
      open: (input: CodexOpenInput) =>
        Effect.suspend(() => {
          const home = input.environment["CODEX_HOME"] ?? "";
          opened.push(home);
          return fakeAppServer(home, home === files.home("A") || fullB, seen);
        }),
    };
    const factory = wrapCodexClientFactory(inner, {
      routing,
      sharedHome: SHARED_HOME,
      onLimitMove: (move) => pendingContinuations.offer({ ...move, work: [] }),
      onOpen: (id) => pendingContinuations.drop(id),
    });
    const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
      CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: SETTINGS,
      }).pipe(Effect.map((adapter) => [adapter])),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, factory),
          Layer.effect(
            ServerConfig.ServerConfig,
            ProviderReplayHarness.makeReplayServerConfig("lastdrop-codex-limit").pipe(Effect.orDie),
          ).pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
          NodeCrypto.layer,
          IdAllocator.layer,
        ),
      ),
    );
    const cwd = yield* checkpointWorkspace("lastdrop-codex-limit");
    return yield* Effect.gen(function* () {
      yield* Layer.build(MoveContinuation.layer);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
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
        projectId: ProjectId.make("project:lastdrop-codex-limit"),
        createdBy: "user",
        creationSource: "web",
        title: "Codex at a limit",
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
        text: "Rename the config loader",
        attachments: [],
        modelSelection: SELECTION,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* settled(1);
      if (!fullB) yield* settled(2);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const threads = yield* Effect.promise(() => files.threads());
      return { projection, seen, opened, files, log, threads };
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          {
            name: "lastdrop-codex-limit",
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
  });
}

const errorMessages = (items: ReadonlyArray<{ readonly type: string }>) =>
  items.flatMap((item) =>
    item.type === "error"
      ? [(item as unknown as { failure: { message: string } }).failure.message]
      : [],
  );

describe("a Codex thread at its account's usage limit", () => {
  it.live("continues on another account with room, on the same native thread, with a notice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projection, seen, opened, files, threads } = yield* runAtLimit(false);
        assert.deepEqual(opened, [files.home("A"), files.home("B")]);
        assert.deepEqual(
          projection.runs.map((run) => [run.ordinal, run.status]),
          [
            [1, "failed"],
            [2, "completed"],
          ],
        );
        // The first run's failure is the notice.
        assert.deepEqual(errorMessages(projection.turnItems), [
          "lastdrop: Codex account A reached its usage limit; the thread continues on B.",
        ]);
        // B resumed A's native thread (the sessions are shared) and got T3's continue prompt.
        const onB = seen.filter(([home]) => home === files.home("B")).map(([, r]) => r);
        assert.deepEqual(
          onB
            .filter((r) => r.method === "thread/resume")
            .map((r) => (r.params as { threadId: string }).threadId),
          [NATIVE],
        );
        const turnStart = onB.find((r) => r.method === "turn/start")!;
        assert.deepEqual((turnStart.params as { input: unknown }).input, [
          { type: "text", text: CONTINUE_PROMPT },
        ]);
        // A's session was released, not failed: no error banner.
        assert.isAbove(projection.providerSessions.length, 0);
        for (const session of projection.providerSessions) assert.isNull(session.lastError);
        assert.equal(threads[NATIVE]?.account, "B");
        assert.isUndefined(pendingContinuations.take(threadId));
      }),
    ),
  );

  it.live("keeps T3's own limit failure when every account is full", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { projection, opened, files, log } = yield* runAtLimit(true);
        assert.deepEqual(opened, [files.home("A")]);
        assert.deepEqual(
          projection.runs.map((run) => [run.ordinal, run.status]),
          [[1, "failed"]],
        );
        assert.deepEqual(errorMessages(projection.turnItems), [LIMIT_MESSAGE]);
        assert.isUndefined(pendingContinuations.take(threadId));
        assert.isTrue(log.some((line) => line.includes("no other account has room")));
      }),
    ),
  );
});
