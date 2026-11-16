// @effect-diagnostics nodeBuiltinImport:off - Reads the fork's agent catalog files.
/**
 * The runner's port onto T3: a run is T3's own delegated task (`OrchestratorMcpService`, the service
 * behind `delegate_task`) of the calling thread on the `lastdropAgents` instance, read back from T3's
 * projection. The service is built from its own layer here, as the MCP toolkit builds it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import type { McpThreadInvocationScope } from "../../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../../mcp/OrchestratorMcpService.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import {
  parseCatalog,
  parseModelEfforts,
  type AgentDefinition,
  type AgentStep,
} from "../agents/catalog.ts";
import { boundCatalogFiles, type CatalogFiles } from "../agents/catalogSource.ts";
import { LASTDROP_AGENTS_DRIVER } from "../agents/settings.ts";
import * as Shared from "../agents/shared.ts";
import { catalogExtras, type StepItem } from "./protocol.ts";
import { RunnerError, type CatalogRead, type ChildRun, type RunnerPort } from "./runs.ts";

/** The agents' T3 instance: one per server (`supportsMultipleInstances: false`), under its kind's id. */
const AGENTS_INSTANCE = ProviderInstanceId.make(LASTDROP_AGENTS_DRIVER);

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/** The fork's list as it reads now (the plugin reads it at each prompt). */
const readCatalog = (files: CatalogFiles | undefined = boundCatalogFiles()): CatalogRead => {
  const json = files === undefined ? undefined : readJson(files.catalog);
  return {
    agents: parseCatalog(json),
    efforts: parseModelEfforts(files === undefined ? undefined : readJson(files.models)),
    extras: catalogExtras(json),
  };
};

const message = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

const failed = (what: string) => (error: unknown) =>
  new RunnerError({ message: `${what}: ${message(error)}` });

/** The path with its links resolved (`/var` is `/private/var` on macOS), else as given. */
const real = (path: string): string => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

const within = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/** The run a run continues: after a usage limit (T3's recovery, or the agents driver's fallback) or a restart. */
const FALLBACK_MESSAGE = "lastdrop-fallback:";
const continues = (run: OrchestrationV2Run): string | undefined =>
  run.usageLimitContinuationOfRunId ??
  run.restartContinuationOfRunId ??
  (run.userMessageId.startsWith(FALLBACK_MESSAGE)
    ? run.userMessageId.slice(FALLBACK_MESSAGE.length)
    : undefined);

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled", "interrupted"]);

const stepId = (step: AgentStep): string => `${step.instanceId}/${step.model}/${step.effort ?? ""}`;

/** A turn item as a step line reads it. */
const stepItem = (item: OrchestrationV2TurnItem): StepItem => {
  const record = item as unknown as Record<string, unknown>;
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    input: record.input,
    fileName: typeof record.fileName === "string" ? record.fileName : undefined,
    pattern: typeof record.pattern === "string" ? record.pattern : undefined,
    patterns: Array.isArray(record.patterns) ? (record.patterns as string[]) : undefined,
    toolName: typeof record.toolName === "string" ? record.toolName : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
};

export const makeLivePort = Effect.gen(function* () {
  const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  /**
   * The calling thread as a T3 MCP caller, as `RemoteDelegation` follows a task: its id, and the instance
   * of its active run (`delegate_task` requires the run to be the caller's own).
   */
  const scopeOf = Effect.fn("LastdropRunner.scopeOf")(function* (parent: string) {
    const threadId = ThreadId.make(parent);
    const records = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(failed("lastdrop couldn't read the calling thread")));
    const run = ThreadManagementService.latestActiveRun({ runs: records.runs });
    const instance = run?.providerInstanceId ?? records.thread.modelSelection?.instanceId;
    if (instance === undefined) {
      return yield* new RunnerError({
        message: "lastdrop couldn't tell the calling thread's provider.",
      });
    }
    return {
      environmentId,
      requestNamespace: `lastdrop-runner:${parent}`,
      thread: {
        threadId,
        providerSessionId: `lastdrop-runner:${parent}`,
        providerInstanceId: instance,
      },
      client: undefined,
      capabilities: new Set(["orchestration"] as const),
      issuedAt: yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)),
    } satisfies McpThreadInvocationScope;
  });

  const port: RunnerPort = {
    catalog: () => readCatalog(),
    unavailable: instances
      .getInstance(AGENTS_INSTANCE)
      .pipe(
        Effect.map((instance) =>
          instance === undefined || !instance.enabled
            ? 'lastdrop\'s agents provider ("lastdrop agents") is off in T3 Code lastdrop: turn it on in Settings → Providers.'
            : undefined,
        ),
      ),
    // A read that fails isn't a deletion: the token's MAC already held.
    threadLive: (thread) =>
      threads.getThreadShell(ThreadId.make(thread)).pipe(
        Effect.map((shell) => shell !== null && shell.deletedAt === null),
        Effect.orElseSucceed(() => true),
      ),
    isAgentsThread: (thread) =>
      threads.getThreadRecords(ThreadId.make(thread), ["runs"]).pipe(
        Effect.map(
          (records) =>
            records.thread.modelSelection?.instanceId === AGENTS_INSTANCE ||
            records.runs.some((run) => run.providerInstanceId === AGENTS_INSTANCE),
        ),
        Effect.orElseSucceed(() => false),
      ),
    outsideFolder: Effect.fn("LastdropRunner.outsideFolder")(
      function* (thread, cwd) {
        const records = yield* threads.getThreadRecords(ThreadId.make(thread), []);
        const root =
          records.thread.worktreePath ??
          Option.getOrUndefined(yield* projects.get(records.thread.projectId))?.workspaceRoot;
        if (root === undefined) return undefined;
        const folder = real(root);
        return within(real(cwd), folder) ? undefined : folder;
      },
      Effect.orElseSucceed(() => undefined),
    ),
    worktree: Effect.fn("LastdropRunner.worktree")(
      function* (parent, child) {
        const own = (yield* threads.getThreadRecords(ThreadId.make(child), [])).thread;
        const theirs = (yield* threads.getThreadRecords(ThreadId.make(parent), [])).thread;
        if (own.worktreePath == null || own.worktreePath === theirs.worktreePath) return undefined;
        return { path: own.worktreePath, branch: own.branch ?? undefined };
      },
      Effect.orElseSucceed(() => undefined),
    ),
    start: Effect.fn("LastdropRunner.start")(function* (parent, input) {
      const scope = yield* scopeOf(parent);
      const result = yield* mcp
        .delegateTask(scope, {
          task: input.task,
          title: input.title,
          target: {
            providerInstanceId: AGENTS_INSTANCE,
            model: input.agent,
            ...(input.effort === undefined
              ? {}
              : { options: [{ id: "effort", value: input.effort }] }),
          },
          ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
          mode: "async",
          clientRequestId: input.requestKey,
        })
        .pipe(Effect.mapError(failed(`lastdrop couldn't start ${input.agent}`)));
      if (result.childThreadId === null || result.childRunId === null) {
        return yield* new RunnerError({
          message: `lastdrop couldn't start ${input.agent}: T3 made no child thread here.`,
        });
      }
      return {
        taskId: result.taskId,
        childThreadId: result.childThreadId,
        runId: result.childRunId,
      };
    }),
    send: Effect.fn("LastdropRunner.send")(function* (parent, child, text, requestKey) {
      const scope = yield* scopeOf(parent);
      const sent = yield* mcp
        .sendToThread(scope, {
          threadId: ThreadId.make(child),
          message: text,
          mode: "queue",
          clientRequestId: requestKey,
        })
        .pipe(Effect.mapError(failed("lastdrop couldn't send the message to its agent")));
      return { runId: sent.runId, taskId: sent.taskId };
    }),
    runs: (child) =>
      threads.getThreadRecords(ThreadId.make(child), ["runs"]).pipe(
        Effect.map((records) =>
          records.runs.map((run: OrchestrationV2Run): ChildRun => ({
            id: run.id,
            ordinal: run.ordinal,
            status: run.status,
            continues: continues(run),
          })),
        ),
        Effect.mapError(failed("lastdrop couldn't read its agent's thread")),
      ),
    items: (child, runIds) =>
      threads
        .getThreadRecords(ThreadId.make(child), ["turnItems"], {
          turnItemRunIds: runIds as ReadonlyArray<OrchestrationV2Run["id"]>,
        })
        .pipe(
          Effect.map((records) =>
            records.turnItems.toSorted((a, b) => a.ordinal - b.ordinal).map(stepItem),
          ),
          Effect.mapError(failed("lastdrop couldn't read its agent's thread")),
        ),
    outcome: (child, runId) =>
      threads
        .getThreadRecords(ThreadId.make(child), ["messages", "turnItems"], {
          messageRoles: ["assistant"],
          messageRunIds: [runId as OrchestrationV2Run["id"]],
          turnItemRunIds: [runId as OrchestrationV2Run["id"]],
          turnItemTypes: ["error"],
        })
        .pipe(
          Effect.map((records) => {
            const answers = records.messages
              .filter((m) => m.role === "assistant" && m.text.trim() !== "")
              .toSorted(
                (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
              );
            const answer = answers.at(-1)?.text;
            if (answer !== undefined) return answer;
            return records.turnItems
              .flatMap((item) => (item.type === "error" ? [item.failure.message] : []))
              .join("\n");
          }),
          Effect.mapError(failed("lastdrop couldn't read its agent's answer")),
        ),
    executed: (child, agent: AgentDefinition) =>
      threads.getThreadRecords(ThreadId.make(child), ["providerThreads"]).pipe(
        Effect.map((records) => {
          const latest = records.providerThreads
            .filter((thread) => thread.nativeThreadRef?.nativeId != null)
            .toSorted((a, b) => (a.lastRunOrdinal ?? 0) - (b.lastRunOrdinal ?? 0))
            .at(-1);
          const nativeId = latest?.nativeThreadRef?.nativeId;
          const entry = nativeId == null ? undefined : Shared.nativeEntries.get(nativeId)?.entry;
          return entry === undefined
            ? undefined
            : agent.chain.find((step) => stepId(step) === entry);
        }),
        Effect.orElseSucceed(() => undefined),
      ),
    stop: Effect.fn("LastdropRunner.stop")(function* (parent, child, taskId) {
      const scope = yield* scopeOf(parent);
      if (taskId !== undefined) {
        yield* mcp
          .cancelTask(scope, { taskId: NodeId.make(taskId), reason: "Stopped from Claude Code." })
          .pipe(Effect.mapError(failed("lastdrop couldn't stop its agent")));
        return;
      }
      yield* mcp
        .interruptThread(scope, { threadId: ThreadId.make(child), stop: true })
        .pipe(Effect.mapError(failed("lastdrop couldn't stop its agent")));
    }),
    // Reading a task that ended marks it delivered (`readTask`'s acknowledgement); one still running isn't.
    acknowledge: (parent, taskId) =>
      scopeOf(parent).pipe(
        Effect.flatMap((scope) => mcp.taskStatus(scope, NodeId.make(taskId))),
        Effect.map((task) => TERMINAL_TASK.has(task.status)),
        Effect.orElseSucceed(() => false),
      ),
  };
  return port;
});
