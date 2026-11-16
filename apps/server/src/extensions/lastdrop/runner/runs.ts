/**
 * The runner's commands over a narrow port onto T3 (`children.ts`). A run is a delegated task on the
 * `lastdropAgents` instance; its rows become `step` lines, its answer the `result`. Stop cancels the
 * task, a follow-up is a message to the same child. See docs/lastdrop/step8.md.
 */
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  agentEfforts,
  closestEffort,
  type AgentDefinition,
  type AgentStep,
  type ModelEfforts,
} from "../agents/catalog.ts";
import type { StoredMap } from "../agents/store.ts";
import {
  pluginAgents,
  stepFields,
  stepPending,
  stepText,
  type CatalogExtras,
  type RunnerLine,
  type RunRequest,
  type StepItem,
} from "./protocol.ts";

export class RunnerError extends Schema.TaggedError<RunnerError>()("LastdropRunnerError", {
  message: Schema.String,
}) {}

export type ChildRunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

export interface ChildRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: ChildRunStatus;
  /** The run this one continues after a usage limit or restart (the agents driver's fallback, T3's recovery). */
  readonly continues?: string | undefined;
}

const isTerminal = (status: ChildRunStatus): boolean =>
  status === "completed" ||
  status === "interrupted" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "rolled_back";

export interface CatalogRead {
  /** Every agent of the catalog file, disabled ones too. */
  readonly agents: ReadonlyArray<AgentDefinition>;
  readonly efforts: ModelEfforts;
  readonly extras: CatalogExtras;
}

export interface StartInput {
  readonly agent: string;
  readonly task: string;
  readonly title: string;
  readonly effort: string | undefined;
  readonly isolation: "worktree" | undefined;
  readonly requestKey: string;
}

/** What the runner needs from T3. */
export interface RunnerPort {
  readonly catalog: () => CatalogRead;
  /** Why the agents' T3 instance can't take a run now; undefined when it can. */
  readonly unavailable: Effect.Effect<string | undefined>;
  /** Whether the thread is there (not deleted): its token holds only while it is. */
  readonly threadLive: (thread: string) => Effect.Effect<boolean>;
  /** Whether the thread runs on the agents' T3 instance (any of lastdrop's agents, however it started). */
  readonly isAgentsThread: (thread: string) => Effect.Effect<boolean>;
  /** The thread's own folder when `cwd` is outside it; undefined when `cwd` is in it (or it can't be told). */
  readonly outsideFolder: (thread: string, cwd: string) => Effect.Effect<string | undefined>;
  /** The child's own worktree, when T3 made one for it. */
  readonly worktree: (
    parent: string,
    child: string,
  ) => Effect.Effect<{ readonly path: string; readonly branch: string | undefined } | undefined>;
  readonly start: (
    parent: string,
    input: StartInput,
  ) => Effect.Effect<
    { readonly taskId: string; readonly childThreadId: string; readonly runId: string },
    RunnerError
  >;
  readonly send: (
    parent: string,
    child: string,
    message: string,
    requestKey: string,
  ) => Effect.Effect<{ readonly runId: string; readonly taskId?: string | undefined }, RunnerError>;
  readonly runs: (child: string) => Effect.Effect<ReadonlyArray<ChildRun>, RunnerError>;
  readonly items: (
    child: string,
    runIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<StepItem>, RunnerError>;
  /** The run's answer: its last assistant message, else its error. */
  readonly outcome: (child: string, runId: string) => Effect.Effect<string, RunnerError>;
  /** The chain entry the child runs on now, when known. */
  readonly executed: (
    child: string,
    agent: AgentDefinition,
  ) => Effect.Effect<AgentStep | undefined>;
  readonly stop: (
    parent: string,
    child: string,
    taskId: string | undefined,
  ) => Effect.Effect<void, RunnerError>;
  /**
   * Marks the task's result delivered, so T3 doesn't wake the parent with it too. True once T3 shows the
   * task ended (and so marked it); false while it doesn't yet, or the read failed.
   */
  readonly acknowledge: (parent: string, taskId: string) => Effect.Effect<boolean>;
}

/** A run the plugin may continue or stop, by Claude Code's agent id; kept across restarts. */
export interface RunRecord {
  readonly parent: string;
  readonly child: string;
  readonly agent: string;
}

export interface RunnerDeps {
  readonly port: RunnerPort;
  readonly records: StoredMap<RunRecord>;
  readonly newId: () => string;
  /** Between two reads of the child; 1 s live. */
  readonly poll?: Duration.Input | undefined;
  /** How long a failed run waits for the fallback's next run, in ms; 15 s live. */
  readonly fallbackGraceMs?: number | undefined;
  /** Between two `tick` lines; a minute live, as the standalone runner. */
  readonly tick?: Duration.Input | undefined;
  /** Reads of the child in a row that may fail before the runner lets the run go; 30 live (a poll apart). */
  readonly readTries?: number | undefined;
}

interface Active {
  readonly parent: string;
  readonly child: string;
  readonly taskId: string | undefined;
  stopRequested: boolean;
}

/** Runs in progress, by agent id. In memory: a run never outlives the server that follows it. */
const active = new Map<string, Active>();

/** Claude Code's worktrees for subagents (`.claude/worktrees/agent-<id>`). */
const ENGINE_WORKTREE = /\/\.claude\/worktrees\/[^/]+/;

const findAgent = (deps: RunnerDeps, name: string): AgentDefinition | undefined =>
  pluginAgents(deps.port.catalog().agents).find((agent) => agent.name === name);

/** A thread on lastdrop's agents: one this runner started, or any thread on the agents' instance. */
const isRunnerChild = (deps: RunnerDeps, thread: string): Effect.Effect<boolean> =>
  deps.records.entries().some(([, record]) => record.child === thread)
    ? Effect.succeed(true)
    : deps.port.isAgentsThread(thread);

const notEnabled = (name: string): RunnerLine => ({
  type: "error",
  text: `No agent ${name} is enabled in lastdrop (Settings → Providers → lastdrop agents).`,
});

const nested = (name: string): RunnerLine => ({
  type: "error",
  text: `An agent lastdrop runs can't start lastdrop's agents (${name}).`,
});

/** `--agent-route`: whether the run goes to lastdrop. Starts nothing. */
export const routeLine = Effect.fn("LastdropRunner.route")(function* (
  deps: RunnerDeps,
  parent: string,
  request: RunRequest,
): Effect.fn.Return<RunnerLine> {
  if (request.resume !== undefined) {
    const record = deps.records.get(request.resume);
    return { type: record !== undefined && record.parent === parent ? "routed" : "no_room" };
  }
  // A plain reroute stays on the thread's own account: the fork picks the account per thread.
  if (request.agent === undefined) return { type: "no_room" };
  if (yield* isRunnerChild(deps, parent)) return nested(request.agent);
  if (findAgent(deps, request.agent) === undefined) return notEnabled(request.agent);
  const problem = yield* deps.port.unavailable;
  return problem === undefined ? { type: "routed" } : { type: "error", text: problem };
});

/** The effort the agent's T3 model takes for the call's, when it takes one. */
const effortFor = (
  agent: AgentDefinition,
  efforts: ModelEfforts,
  wanted: string | undefined,
): string | undefined => {
  if (wanted === undefined) return undefined;
  const levels = agentEfforts(agent, efforts);
  return levels === undefined ? undefined : closestEffort(wanted, levels);
};

type Begin =
  | { readonly line: RunnerLine }
  | {
      readonly child: string;
      readonly runId: string;
      readonly taskId: string | undefined;
      readonly agent: AgentDefinition;
    };

const begin = Effect.fn("LastdropRunner.begin")(
  function* (
    deps: RunnerDeps,
    parent: string,
    request: RunRequest,
    id: string,
  ): Effect.fn.Return<Begin, RunnerError> {
    if (request.resume !== undefined) {
      const record = deps.records.get(request.resume);
      if (record === undefined || record.parent !== parent) {
        return {
          line: { type: "error", text: `No agent ${request.resume} was started by lastdrop.` },
        };
      }
      const agent = findAgent(deps, record.agent);
      if (agent === undefined) return { line: notEnabled(record.agent) };
      if (request.prompt.trim() === "") {
        return { line: { type: "error", text: "The agent resumed without a new message." } };
      }
      const sent = yield* deps.port.send(
        parent,
        record.child,
        request.prompt,
        `lastdrop-runner:${id}:${deps.newId()}`,
      );
      return { child: record.child, runId: sent.runId, taskId: sent.taskId, agent };
    }
    if (request.agent === undefined) return { line: { type: "no_room" } };
    if (yield* isRunnerChild(deps, parent)) return { line: nested(request.agent) };
    const agent = findAgent(deps, request.agent);
    if (agent === undefined) return { line: notEnabled(request.agent) };
    // A run is a T3 thread in the calling thread's folder, or in a worktree T3 makes (isolation): never
    // anywhere else, so a call from another folder (Claude Code's own worktree) is refused, not moved.
    const folder = ENGINE_WORKTREE.test(request.cwd)
      ? request.cwd
      : yield* deps.port.outsideFolder(parent, request.cwd);
    if (folder !== undefined) {
      return {
        line: {
          type: "error",
          text: `In T3 Code lastdrop, ${agent.name} runs in this thread's folder or in a worktree T3 Code makes for it, not in ${request.cwd}. Call it from the thread's folder, with isolation "worktree" for a worktree.`,
        },
      };
    }
    if (request.prompt.trim() === "") {
      return { line: { type: "error", text: "The agent was called without a prompt." } };
    }
    const problem = yield* deps.port.unavailable;
    if (problem !== undefined) return { line: { type: "error", text: problem } };
    const started = yield* deps.port.start(parent, {
      agent: agent.name,
      task: request.prompt,
      title: (request.description ?? agent.name).slice(0, 512),
      effort: effortFor(agent, deps.port.catalog().efforts, request.effort),
      isolation: request.isolation === "worktree" ? "worktree" : undefined,
      requestKey: `lastdrop-runner:${id}`,
    });
    deps.records.set(id, { parent, child: started.childThreadId, agent: agent.name });
    return { child: started.childThreadId, runId: started.runId, taskId: started.taskId, agent };
  },
  Effect.catchTags({
    LastdropRunnerError: (error) =>
      Effect.succeed<Begin>({ line: { type: "error", text: error.message } }),
  }),
);

const sameStep = (a: AgentStep, b: AgentStep): boolean =>
  a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort;

/**
 * `--agent-run`: the run's lines until its result. The stream's end (the plugin ended the runner) stops a
 * run that is still going, as ending the standalone runner ends its agent.
 */
export const runLines = (
  deps: RunnerDeps,
  parent: string,
  request: RunRequest,
): Stream.Stream<RunnerLine> =>
  Stream.callback<RunnerLine>((queue) =>
    Effect.gen(function* () {
      const emit = (line: RunnerLine) => void Queue.offerUnsafe(queue, line);
      const id = request.id ?? request.resume ?? deps.newId();
      const begun = yield* begin(deps, parent, request, id);
      if ("line" in begun) {
        emit(begun.line);
        return yield* Queue.end(queue);
      }
      const { child, agent, taskId } = begun;
      const state: Active = { parent, child, taskId, stopRequested: false };
      active.set(id, state);
      const pause = Effect.sleep(deps.poll ?? "1 second");
      const tries = deps.readTries ?? 30;
      /** The runs this runner followed: its own, then the fallback's continuations of it. */
      const followed = new Set<string>([begun.runId]);
      let finished = false;
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          // A follow-up with the same id (a steer) took the run over: the child is its now.
          if (active.get(id) !== state) return Effect.void;
          active.delete(id);
          if (finished) return Effect.void;
          // The plugin ended the runner while the agent ran: the agent stops with it, unless the child
          // already runs something this runner didn't follow (the user, a wake).
          return deps.port.runs(child).pipe(
            Effect.map((runs) => runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]),
            Effect.map((newest) => newest === undefined || followed.has(newest.id)),
            Effect.orElseSucceed(() => true),
            Effect.flatMap((ours) =>
              ours ? deps.port.stop(parent, child, taskId).pipe(Effect.ignore) : Effect.void,
            ),
          );
        }),
      );
      let announced = (yield* deps.port.executed(child, agent)) ?? agent.chain[0]!;
      emit({ type: "started", agentId: id, ...stepFields(announced), childThreadId: child });
      yield* Effect.sleep(deps.tick ?? "1 minute").pipe(
        Effect.andThen(Effect.sync(() => emit({ type: "tick" }))),
        Effect.forever,
        Effect.forkScoped,
      );

      /**
       * The run is let go, not stopped: it keeps running in T3, and T3 brings its answer to the parent
       * as the task's completion (not marked delivered).
       */
      const letGo = Effect.fn("LastdropRunner.letGo")(function* (what: string, error: RunnerError) {
        finished = true;
        emit({
          type: "result",
          text: `${what}: ${error.message}. It keeps running in T3 Code (its child thread); T3 Code brings its answer to this thread when it ends.`,
          isError: true,
          ...stepFields(announced),
          childThreadId: child,
        });
        yield* Queue.end(queue);
      });

      const seen = new Set<string>();
      let current = begun.runId;
      let failedAt: number | undefined;
      const graceMs = deps.fallbackGraceMs ?? 15_000;
      let failures = 0;
      let last: ChildRun | undefined;
      for (;;) {
        const read = yield* Effect.gen(function* () {
          const runs = yield* deps.port.runs(child);
          const run = runs.find((candidate) => candidate.id === current);
          // Only a continuation of this run (a fallback partway): never a later run the user or a wake started.
          const next =
            run === undefined || state.stopRequested
              ? undefined
              : runs
                  .filter((candidate) => candidate.continues === run.id)
                  .toSorted((a, b) => a.ordinal - b.ordinal)[0];
          // The continuation's rows too: the next read follows it, and they would show a read late.
          const items = yield* deps.port.items(
            child,
            next === undefined ? [current] : [current, next.id],
          );
          return { run, next, items };
        }).pipe(Effect.result);
        if (read._tag === "Failure") {
          // A read that fails now and then (a busy database) is read again; many in a row let the run go.
          if (++failures >= tries)
            return yield* letGo(`lastdrop lost track of ${agent.name}`, read.failure);
          yield* pause;
          continue;
        }
        failures = 0;
        const { run, next, items } = read.success;
        for (const item of items) {
          if (seen.has(item.id)) continue;
          // A row still filling in (a command without its text yet) is read again next time.
          if (stepPending(item)) continue;
          seen.add(item.id);
          const text = stepText(item);
          if (text !== undefined) emit({ type: "step", text });
        }
        const runsOn = yield* deps.port.executed(child, agent);
        if (runsOn !== undefined && !sameStep(runsOn, announced)) {
          // A fallback: the row shows what runs now (the plugin keeps the run, `record`).
          announced = runsOn;
          emit({ type: "started", agentId: id, ...stepFields(runsOn), childThreadId: child });
        }
        if (run !== undefined && isTerminal(run.status)) {
          if (next !== undefined) {
            // The agents driver continued the work in a new run (a usage limit partway).
            current = next.id;
            followed.add(current);
            failedAt = undefined;
            continue;
          }
          const waitForFallback = run.status === "failed" && !state.stopRequested;
          const now = yield* Clock.currentTimeMillis;
          if (waitForFallback && failedAt === undefined) failedAt = now;
          if (!waitForFallback || now - failedAt! >= graceMs) {
            last = run;
            break;
          }
        }
        yield* pause;
      }
      const status = last.status;
      const stopped = state.stopRequested || status === "cancelled" || status === "interrupted";
      const where = stepFields(announced);
      let line: RunnerLine;
      if (stopped) {
        line = { type: "result", text: "Stopped.", isError: true, stopped: true };
      } else {
        const answer = yield* deps.port.outcome(child, last.id).pipe(
          Effect.retry({
            times: Math.max(0, tries - 1),
            schedule: Schedule.spaced(deps.poll ?? "1 second"),
          }),
          Effect.result,
        );
        if (answer._tag === "Failure") {
          return yield* letGo(`lastdrop couldn't read ${agent.name}'s answer`, answer.failure);
        }
        const text = answer.success;
        const isError = status !== "completed";
        line = {
          type: "result",
          text: text.trim() !== "" ? text : isError ? `${agent.name} failed (${status}).` : "",
          isError,
        };
      }
      finished = true;
      // Marked delivered before the plugin reads the result (it ends the runner then), and until T3 shows
      // the task ended: else T3 also brings the same answer to the parent after its turn.
      if (taskId !== undefined) {
        yield* deps.port.acknowledge(parent, taskId).pipe(
          Effect.flatMap((marked) => (marked ? Effect.void : Effect.fail("not yet" as const))),
          Effect.retry({
            times: Math.max(0, tries - 1),
            schedule: Schedule.spaced(deps.poll ?? "1 second"),
          }),
          Effect.ignore,
          Effect.uninterruptible,
        );
      }
      const worktree = yield* deps.port.worktree(parent, child);
      emit({
        ...line,
        ...where,
        ...(worktree === undefined
          ? {}
          : {
              worktreePath: worktree.path,
              ...(worktree.branch === undefined ? {} : { worktreeBranch: worktree.branch }),
            }),
        childThreadId: child,
      });
      yield* Queue.end(queue);
    }),
  );

/** `--agent-stop <id>`: cancels a run in progress; its runner then reports it stopped. */
export const stopLine = Effect.fn("LastdropRunner.stop")(function* (
  deps: RunnerDeps,
  parent: string,
  id: string,
): Effect.fn.Return<{ readonly line: RunnerLine; readonly ok: boolean }> {
  const run = active.get(id);
  if (run === undefined || run.parent !== parent) {
    return { line: { type: "error", text: `Agent ${id} isn't running.` }, ok: false };
  }
  run.stopRequested = true;
  return yield* deps.port.stop(run.parent, run.child, run.taskId).pipe(
    Effect.as({ line: { type: "stopped" } as RunnerLine, ok: true }),
    Effect.catchTags({
      LastdropRunnerError: (error) =>
        Effect.succeed({ line: { type: "error", text: error.message } as RunnerLine, ok: false }),
    }),
  );
});

/** For tests: forgets the runs in progress. */
export const resetActiveRuns = (): void => active.clear();
