/**
 * The runner's commands over a narrow port onto T3 (`children.ts`). A run is a delegated task on the
 * `lastdropAgents` instance; its rows become `step` lines, its answer the `result`. Stop cancels the
 * task, a follow-up is a message to the same child. See docs/lastdrop/step8.md.
 */
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
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
  /** Marks the task's result delivered, so T3 doesn't wake the parent with it too. */
  readonly acknowledge: (parent: string, taskId: string) => Effect.Effect<void>;
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
}

interface Active {
  readonly parent: string;
  readonly child: string;
  readonly taskId: string | undefined;
  stopRequested: boolean;
}

/** Runs in progress, by agent id. In memory: a run never outlives the server that follows it. */
const active = new Map<string, Active>();

/** Claude Code's worktree for a subagent (`.claude/worktrees/agent-<id>`), as the plugin passes it in `cwd`. */
const ENGINE_WORKTREE = /\/\.claude\/worktrees\/agent-[^/]+\/?$/;

const findAgent = (deps: RunnerDeps, name: string): AgentDefinition | undefined =>
  pluginAgents(deps.port.catalog().agents).find((agent) => agent.name === name);

const isRunnerChild = (deps: RunnerDeps, thread: string): boolean =>
  deps.records.entries().some(([, record]) => record.child === thread);

const notEnabled = (name: string): RunnerLine => ({
  type: "error",
  text: `No agent ${name} is enabled in lastdrop (Settings → Agents).`,
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
  if (isRunnerChild(deps, parent)) return nested(request.agent);
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
    if (isRunnerChild(deps, parent)) return { line: nested(request.agent) };
    const agent = findAgent(deps, request.agent);
    if (agent === undefined) return { line: notEnabled(request.agent) };
    if (ENGINE_WORKTREE.test(request.cwd)) {
      return {
        line: {
          type: "error",
          text: `In T3 Code lastdrop, lastdrop's agents don't run in Claude Code's worktrees yet. Call ${agent.name} without isolation, or ask for a worktree through delegate_task (isolation "worktree").`,
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
      let finished = false;
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          if (active.get(id) === state) active.delete(id);
          // The plugin ended the runner while the agent ran: the agent stops with it.
          return finished ? Effect.void : deps.port.stop(parent, child, taskId).pipe(Effect.ignore);
        }),
      );
      let announced = (yield* deps.port.executed(child, agent)) ?? agent.chain[0]!;
      emit({ type: "started", agentId: id, ...stepFields(announced), childThreadId: child });
      yield* Effect.sleep(deps.tick ?? "1 minute").pipe(
        Effect.andThen(Effect.sync(() => emit({ type: "tick" }))),
        Effect.forever,
        Effect.forkScoped,
      );

      const seen = new Set<string>();
      let current = begun.runId;
      let failedAt: number | undefined;
      const graceMs = deps.fallbackGraceMs ?? 15_000;
      let last: ChildRun | undefined;
      for (;;) {
        const runs = yield* deps.port.runs(child);
        const run = runs.find((candidate) => candidate.id === current);
        const later =
          run === undefined
            ? []
            : runs
                .filter((candidate) => candidate.ordinal > run.ordinal)
                .toSorted((a, b) => a.ordinal - b.ordinal);
        const items = yield* deps.port.items(child, [current, ...later.map((r) => r.id)]);
        for (const item of items) {
          if (seen.has(item.id)) continue;
          const text = stepText(item);
          // An item without its text yet (a row still filling in) is read again next time.
          if (text === undefined && item.type !== "system_notice") seen.add(item.id);
          if (text === undefined) continue;
          seen.add(item.id);
          emit({ type: "step", text });
        }
        const runsOn = yield* deps.port.executed(child, agent);
        if (runsOn !== undefined && !sameStep(runsOn, announced)) {
          // A fallback: the row shows what runs now (the plugin keeps the run, `record`).
          announced = runsOn;
          emit({ type: "started", agentId: id, ...stepFields(runsOn), childThreadId: child });
        }
        if (run !== undefined && isTerminal(run.status)) {
          if (later.length > 0 && !state.stopRequested) {
            // The agents driver continued the work in a new run (a usage limit partway).
            current = later[0]!.id;
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
        yield* Effect.sleep(deps.poll ?? "1 second");
      }
      const status = last.status;
      const stopped = state.stopRequested || status === "cancelled" || status === "interrupted";
      const where = stepFields(announced);
      if (stopped) {
        emit({
          type: "result",
          text: "Stopped.",
          isError: true,
          stopped: true,
          ...where,
          childThreadId: child,
        });
      } else {
        const text = yield* deps.port.outcome(child, last.id);
        const isError = status !== "completed";
        emit({
          type: "result",
          text: text.trim() !== "" ? text : isError ? `${agent.name} failed (${status}).` : "",
          isError,
          ...where,
          childThreadId: child,
        });
      }
      finished = true;
      if (taskId !== undefined) yield* deps.port.acknowledge(parent, taskId);
      yield* Queue.end(queue);
    }).pipe(
      Effect.catchTags({
        LastdropRunnerError: (error) =>
          Effect.sync(() => {
            Queue.offerUnsafe(queue, { type: "result", text: error.message, isError: true });
            Queue.endUnsafe(queue);
          }),
      }),
    ),
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
