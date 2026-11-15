/**
 * A fake T3 for the runner tests: a scripted child thread whose runs and rows advance one phase per
 * read, and a record of what the runner asked of T3.
 */
import * as Effect from "effect/Effect";

import { parseCatalog, parseModelEfforts, type AgentStep } from "../agents/catalog.ts";
import { makeStoredMap } from "../agents/store.ts";
import { catalogExtras, type StepItem } from "./protocol.ts";
import {
  RunnerError,
  type CatalogRead,
  type ChildRun,
  type RunnerDeps,
  type RunnerPort,
  type RunRecord,
  type StartInput,
} from "./runs.ts";

/** The standalone app's `agent-catalog.json`, as it writes it. */
const CATALOG_JSON = {
  revision: 7,
  saveClaude: true,
  saveClaudeText: "Delegate first.",
  agents: [
    {
      id: "0E1A4E1C-0000-4000-8000-000000000001",
      name: "review",
      description: "Code reviews.",
      provider: "codex",
      model: "gpt-6.1-sol",
      fallbacks: [{ provider: "claude", model: "opus" }],
      enabled: true,
      instructions: "",
    },
    {
      id: "0E1A4E1C-0000-4000-8000-000000000002",
      name: "build",
      description: "Implementation.",
      provider: "antigravity",
      model: "claude-sonnet-5-5",
      enabled: true,
    },
    {
      id: "0E1A4E1C-0000-4000-8000-000000000003",
      name: "old",
      description: "Disabled.",
      provider: "codex",
      model: "gpt-6.1-terra",
      enabled: false,
    },
    {
      id: "0E1A4E1C-0000-4000-8000-000000000004",
      name: "opus",
      description: "Reserved name.",
      provider: "zai",
      model: "glm-5.3",
      enabled: true,
    },
  ],
};

const MODELS_JSON = {
  antigravity: { models: [{ id: "claude-sonnet-5-5", efforts: ["low", "medium", "high"] }] },
};

export const fakeCatalog = (): CatalogRead => ({
  agents: parseCatalog(CATALOG_JSON),
  efforts: parseModelEfforts(MODELS_JSON),
  extras: catalogExtras(CATALOG_JSON),
});

/** What the child shows at one read. */
export interface Phase {
  readonly runs: ReadonlyArray<ChildRun>;
  readonly items?: ReadonlyArray<StepItem & { readonly runId: string }>;
  readonly executed?: AgentStep;
}

export interface FakeT3 {
  readonly port: RunnerPort;
  readonly started: Array<{ parent: string; input: StartInput }>;
  readonly sent: Array<{ parent: string; child: string; message: string }>;
  readonly stopped: Array<{ parent: string; child: string; taskId: string | undefined }>;
  readonly acknowledged: Array<string>;
  /** Every read of the task's status, with whether it showed it ended. */
  readonly ackReads: Array<boolean>;
  /** Replaces the child's script (a follow-up's runs). */
  script: (phases: ReadonlyArray<Phase>) => void;
  /** Settles once the runner first reads the child's runs: the run is under way. */
  readonly following: Promise<void>;
}

export const makeFakeT3 = (options: {
  readonly phases: ReadonlyArray<Phase>;
  readonly outcomes?: Readonly<Record<string, string>>;
  readonly unavailable?: string;
  readonly startError?: string;
  readonly sendRunId?: string;
  /** Threads deleted since their token was made. */
  readonly deletedThreads?: ReadonlyArray<string>;
  /** Threads on the agents' instance. */
  readonly agentsThreads?: ReadonlyArray<string>;
  /** The calling thread's folder; a `cwd` outside it is refused. */
  readonly folder?: string;
  readonly worktree?: { readonly path: string; readonly branch: string | undefined };
  /** Reads of the task that still show it running before it shows ended. */
  readonly ackPending?: number;
  /** Which reads of the runs (0-based) fail, and how many outcome reads fail first. */
  readonly failRunsReads?: ReadonlyArray<number>;
  readonly failOutcomeReads?: number;
}): FakeT3 => {
  let runsReads = 0;
  let outcomeReads = 0;
  let ackReads = 0;
  let phases = options.phases;
  let index = 0;
  const current = () => phases[Math.min(index, phases.length - 1)]!;
  /** The phase the last read of the runs showed: rows and the entry are read after it. */
  let shown: Phase = phases[0]!;
  let followed = () => {};
  const following = new Promise<void>((resolve) => {
    followed = resolve;
  });
  const fake: FakeT3 = {
    following,
    started: [],
    sent: [],
    stopped: [],
    acknowledged: [],
    ackReads: [],
    script: (next) => {
      phases = next;
      index = 0;
      shown = next[0]!;
    },
    port: {
      catalog: fakeCatalog,
      unavailable: Effect.succeed(options.unavailable),
      start: (parent, input) =>
        options.startError !== undefined
          ? Effect.fail(new RunnerError({ message: options.startError }))
          : Effect.sync(() => {
              fake.started.push({ parent, input });
              return { taskId: "task-1", childThreadId: "child-1", runId: "run-1" };
            }),
      send: (parent, child, message) =>
        Effect.sync(() => {
          fake.sent.push({ parent, child, message });
          return { runId: options.sendRunId ?? "run-2", taskId: undefined };
        }),
      threadLive: (thread) => Effect.succeed(!(options.deletedThreads?.includes(thread) ?? false)),
      isAgentsThread: (thread) => Effect.succeed(options.agentsThreads?.includes(thread) ?? false),
      outsideFolder: (_thread, cwd) =>
        Effect.succeed(
          options.folder === undefined ||
            cwd === options.folder ||
            cwd.startsWith(`${options.folder}/`)
            ? undefined
            : options.folder,
        ),
      worktree: () => Effect.succeed(options.worktree),
      runs: () =>
        Effect.suspend(() =>
          (options.failRunsReads ?? []).includes(runsReads++)
            ? Effect.fail(new RunnerError({ message: "database busy" }))
            : Effect.sync(() => {
                shown = current();
                index++;
                followed();
                return shown.runs;
              }),
        ),
      items: (_child, runIds) =>
        Effect.sync(() => (shown.items ?? []).filter((item) => runIds.includes(item.runId))),
      outcome: (_child, runId) =>
        Effect.suspend(() =>
          outcomeReads++ < (options.failOutcomeReads ?? 0)
            ? Effect.fail(new RunnerError({ message: "database busy" }))
            : Effect.succeed(options.outcomes?.[runId] ?? ""),
        ),
      executed: () => Effect.sync(() => shown.executed),
      stop: (parent, child, taskId) =>
        Effect.sync(() => {
          fake.stopped.push({ parent, child, taskId });
        }),
      acknowledge: (_parent, taskId) =>
        Effect.sync(() => {
          const ended = ackReads++ >= (options.ackPending ?? 0);
          fake.ackReads.push(ended);
          if (ended) fake.acknowledged.push(taskId);
          return ended;
        }),
    },
  };
  return fake;
};

let ids = 0;

export const fakeDeps = (fake: FakeT3, records = makeStoredMap<RunRecord>()): RunnerDeps => ({
  port: fake.port,
  records,
  newId: () => `generated-${++ids}`,
  poll: "1 millis",
  fallbackGraceMs: 20,
  tick: "1 hour",
});
