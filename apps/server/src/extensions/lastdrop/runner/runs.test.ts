import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { beforeEach } from "vite-plus/test";

import { makeStoredMap } from "../agents/store.ts";
import type { RunnerLine, RunRequest } from "./protocol.ts";
import { resetActiveRuns, routeLine, runLines, stopLine, type RunRecord } from "./runs.ts";
import { fakeCatalog, fakeDeps, makeFakeT3 } from "./testkit.ts";

const PARENT = "thread-parent";
const request = (fields: Partial<RunRequest> = {}): RunRequest => ({
  prompt: "Review the diff.",
  description: "Review diff",
  cwd: "/repo",
  agent: "review",
  id: "agent-a1",
  ...fields,
});

const collect = (stream: Stream.Stream<RunnerLine>) =>
  Stream.runCollect(stream).pipe(Effect.map((lines) => [...lines]));

const types = (lines: ReadonlyArray<RunnerLine>) => lines.map((line) => line.type);

const review = fakeCatalog().agents.find((agent) => agent.name === "review")!;

beforeEach(() => resetActiveRuns());

describe("route", () => {
  it.live("routes an enabled agent, leaves plain reroutes to Claude Code", () =>
    Effect.gen(function* () {
      const deps = fakeDeps(makeFakeT3({ phases: [{ runs: [] }] }));
      assert.deepStrictEqual(yield* routeLine(deps, PARENT, request()), { type: "routed" });
      assert.deepStrictEqual(yield* routeLine(deps, PARENT, request({ agent: undefined })), {
        type: "no_room",
      });
      assert.deepStrictEqual(yield* routeLine(deps, PARENT, request({ agent: "old" })), {
        type: "error",
        text: "No agent old is enabled in lastdrop (Settings → Agents).",
      });
      // A reserved name never becomes a type.
      assert.strictEqual(
        (yield* routeLine(deps, PARENT, request({ agent: "opus" }))).type,
        "error",
      );
    }),
  );

  it.live("names the provider that is off", () =>
    Effect.gen(function* () {
      const deps = fakeDeps(makeFakeT3({ phases: [{ runs: [] }], unavailable: "off" }));
      assert.deepStrictEqual(yield* routeLine(deps, PARENT, request()), {
        type: "error",
        text: "off",
      });
    }),
  );

  it.live("resumes only its own thread's runs, and refuses agents inside its agents", () =>
    Effect.gen(function* () {
      const records = makeStoredMap<RunRecord>();
      records.set("agent-a1", { parent: PARENT, child: "child-1", agent: "review" });
      const deps = fakeDeps(makeFakeT3({ phases: [{ runs: [] }] }), records);
      assert.strictEqual(
        (yield* routeLine(deps, PARENT, request({ resume: "agent-a1" }))).type,
        "routed",
      );
      assert.strictEqual(
        (yield* routeLine(deps, "other", request({ resume: "agent-a1" }))).type,
        "no_room",
      );
      assert.strictEqual(
        (yield* routeLine(deps, PARENT, request({ resume: "agent-zz" }))).type,
        "no_room",
      );
      const nested = yield* routeLine(deps, "child-1", request());
      assert.deepStrictEqual(nested, {
        type: "error",
        text: "An agent lastdrop runs can't start lastdrop's agents (review).",
      });
    }),
  );
});

describe("run", () => {
  it.live("starts a delegated task, reports its rows, then its answer", () =>
    Effect.gen(function* () {
      const fake = makeFakeT3({
        phases: [
          { runs: [{ id: "run-1", ordinal: 1, status: "running" }] },
          {
            runs: [{ id: "run-1", ordinal: 1, status: "running" }],
            items: [
              { id: "i1", runId: "run-1", type: "reasoning" },
              { id: "i2", runId: "run-1", type: "command_execution", input: "git diff\n--stat" },
            ],
          },
          {
            runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
            items: [
              { id: "i2", runId: "run-1", type: "command_execution", input: "git diff" },
              { id: "i3", runId: "run-1", type: "file_change", fileName: "src/a.ts" },
            ],
          },
        ],
        outcomes: { "run-1": "Looks good." },
      });
      const deps = fakeDeps(fake);
      const lines = yield* collect(runLines(deps, PARENT, request({ effort: "xhigh" })));
      assert.deepStrictEqual(lines, [
        {
          type: "started",
          agentId: "agent-a1",
          account: "Codex",
          model: "gpt-6.1-sol",
          provider: "codex",
          childThreadId: "child-1",
        },
        { type: "step", text: "Bash: git diff" },
        { type: "step", text: "Edit: src/a.ts" },
        {
          type: "result",
          text: "Looks good.",
          isError: false,
          account: "Codex",
          model: "gpt-6.1-sol",
          provider: "codex",
          childThreadId: "child-1",
        },
      ]);
      assert.deepStrictEqual(fake.started, [
        {
          parent: PARENT,
          input: {
            agent: "review",
            task: "Review the diff.",
            title: "Review diff",
            // review's first entry has no effort list (Codex's caller levels): the closest it takes.
            effort: fake.started[0]!.input.effort,
            isolation: undefined,
            requestKey: "lastdrop-runner:agent-a1",
          },
        },
      ]);
      assert.deepStrictEqual(fake.acknowledged, ["task-1"]);
      assert.deepStrictEqual(deps.records.get("agent-a1"), {
        parent: PARENT,
        child: "child-1",
        agent: "review",
      });
      assert.deepStrictEqual(fake.stopped, []);
    }),
  );

  it.live("passes the closest effort an agent takes, none for one that takes none", () =>
    Effect.gen(function* () {
      const done = { runs: [{ id: "run-1", ordinal: 1, status: "completed" as const }] };
      const fake = makeFakeT3({ phases: [done] });
      yield* collect(runLines(fakeDeps(fake), PARENT, request({ agent: "build", effort: "max" })));
      assert.strictEqual(fake.started[0]!.input.effort, "high");
      const none = makeFakeT3({ phases: [done] });
      yield* collect(runLines(fakeDeps(none), PARENT, request({ agent: "build" })));
      assert.strictEqual(none.started[0]!.input.effort, undefined);
    }),
  );

  it.live("follows a fallback partway: the next run's answer, the entry it runs on", () =>
    Effect.gen(function* () {
      const opus = review.chain[1]!;
      const fake = makeFakeT3({
        phases: [
          { runs: [{ id: "run-1", ordinal: 1, status: "running" }] },
          { runs: [{ id: "run-1", ordinal: 1, status: "failed" }] },
          {
            runs: [
              { id: "run-1", ordinal: 1, status: "failed" },
              { id: "run-2", ordinal: 2, status: "running" },
            ],
            items: [
              {
                id: "n1",
                runId: "run-2",
                type: "system_notice",
                message:
                  "review reached a usage limit on Codex · gpt-6.1-sol. lastdrop continues on Claude · opus.",
              },
            ],
            executed: opus,
          },
          {
            runs: [
              { id: "run-1", ordinal: 1, status: "failed" },
              { id: "run-2", ordinal: 2, status: "completed" },
            ],
            executed: opus,
          },
        ],
        outcomes: { "run-1": "usage limit", "run-2": "Done on opus." },
      });
      const lines = yield* collect(runLines(fakeDeps(fake), PARENT, request()));
      assert.deepStrictEqual(types(lines), ["started", "step", "started", "result"]);
      assert.deepStrictEqual(lines[2], {
        type: "started",
        agentId: "agent-a1",
        account: "Claude",
        model: "opus",
        provider: "claude",
        childThreadId: "child-1",
      });
      assert.strictEqual(lines[3]!.text, "Done on opus.");
      assert.strictEqual(lines[3]!.isError, false);
      assert.strictEqual(lines[3]!.model, "opus");
    }),
  );

  it.live("reports a failure once no fallback run follows", () =>
    Effect.gen(function* () {
      const fake = makeFakeT3({
        phases: [{ runs: [{ id: "run-1", ordinal: 1, status: "failed" }] }],
        outcomes: { "run-1": "No entry of review has room." },
      });
      const lines = yield* collect(runLines(fakeDeps(fake), PARENT, request()));
      assert.deepStrictEqual(lines.at(-1)?.text, "No entry of review has room.");
      assert.strictEqual(lines.at(-1)?.isError, true);
    }),
  );

  it.live("answers errors as lines: not enabled, no prompt, a failed start, a worktree", () =>
    Effect.gen(function* () {
      const idle = { phases: [{ runs: [] }] };
      const run = (fields: Partial<RunRequest>, options = idle) =>
        collect(runLines(fakeDeps(makeFakeT3(options)), PARENT, request(fields)));
      assert.deepStrictEqual(types(yield* run({ agent: "old" })), ["error"]);
      assert.deepStrictEqual(types(yield* run({ prompt: "  " })), ["error"]);
      assert.deepStrictEqual(yield* run({}, { ...idle, startError: "T3 said no" } as never), [
        { type: "error", text: "T3 said no" },
      ]);
      const worktree = yield* run({ cwd: "/repo/.claude/worktrees/agent-a1b2" });
      assert.strictEqual(worktree[0]!.type, "error");
      assert.match(String(worktree[0]!.text), /Claude Code's worktrees/);
      assert.deepStrictEqual(yield* run({ agent: undefined }), [{ type: "no_room" }]);
    }),
  );

  it.live("asks T3 for a worktree when the call's isolation reaches the runner", () =>
    Effect.gen(function* () {
      const fake = makeFakeT3({
        phases: [{ runs: [{ id: "run-1", ordinal: 1, status: "completed" }] }],
      });
      yield* collect(runLines(fakeDeps(fake), PARENT, request({ isolation: "worktree" })));
      assert.strictEqual(fake.started[0]!.input.isolation, "worktree");
    }),
  );

  it.live("stop: cancels the task, and the run reports itself stopped", () =>
    Effect.gen(function* () {
      const running = { runs: [{ id: "run-1", ordinal: 1, status: "running" as const }] };
      const fake = makeFakeT3({ phases: [running] });
      const deps = fakeDeps(fake);
      const fiber = yield* collect(runLines(deps, PARENT, request())).pipe(Effect.forkChild);
      yield* Effect.promise(() => fake.following);
      assert.deepStrictEqual(yield* stopLine(deps, "other-thread", "agent-a1"), {
        line: { type: "error", text: "Agent agent-a1 isn't running." },
        ok: false,
      });
      const stop = yield* stopLine(deps, PARENT, "agent-a1");
      assert.deepStrictEqual(stop, { line: { type: "stopped" }, ok: true });
      fake.script([{ runs: [{ id: "run-1", ordinal: 1, status: "cancelled" }] }]);
      const lines = yield* Fiber.join(fiber);
      assert.deepStrictEqual(lines.at(-1), {
        type: "result",
        text: "Stopped.",
        isError: true,
        stopped: true,
        account: "Codex",
        model: "gpt-6.1-sol",
        provider: "codex",
        childThreadId: "child-1",
      });
      assert.deepStrictEqual(fake.stopped, [
        { parent: PARENT, child: "child-1", taskId: "task-1" },
      ]);
      assert.deepStrictEqual((yield* stopLine(deps, PARENT, "agent-a1")).ok, false);
    }),
  );

  it.live("the runner ended by the plugin stops the agent", () =>
    Effect.gen(function* () {
      const fake = makeFakeT3({
        phases: [{ runs: [{ id: "run-1", ordinal: 1, status: "running" }] }],
      });
      const lines = yield* runLines(fakeDeps(fake), PARENT, request()).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      assert.strictEqual([...lines][0]!.type, "started");
      assert.deepStrictEqual(fake.stopped, [
        { parent: PARENT, child: "child-1", taskId: "task-1" },
      ]);
    }),
  );

  it.live("a follow-up is a message to the same child, and follows the new run", () =>
    Effect.gen(function* () {
      const records = makeStoredMap<RunRecord>();
      records.set("agent-a1", { parent: PARENT, child: "child-1", agent: "review" });
      const fake = makeFakeT3({
        phases: [
          {
            runs: [
              { id: "run-1", ordinal: 1, status: "completed" },
              { id: "run-2", ordinal: 2, status: "completed" },
            ],
          },
        ],
        outcomes: { "run-2": "Second answer." },
      });
      const lines = yield* collect(
        runLines(
          fakeDeps(fake, records),
          PARENT,
          request({ resume: "agent-a1", prompt: "And tests?" }),
        ),
      );
      assert.deepStrictEqual(fake.sent, [
        { parent: PARENT, child: "child-1", message: "And tests?" },
      ]);
      assert.deepStrictEqual(fake.started, []);
      assert.deepStrictEqual(types(lines), ["started", "result"]);
      assert.strictEqual(lines[0]!.agentId, "agent-a1");
      assert.strictEqual(lines[1]!.text, "Second answer.");
      // No task to acknowledge for a plain message.
      assert.deepStrictEqual(fake.acknowledged, []);
      const other = yield* collect(
        runLines(fakeDeps(fake, records), "other-thread", request({ resume: "agent-a1" })),
      );
      assert.deepStrictEqual(other, [
        { type: "error", text: "No agent agent-a1 was started by lastdrop." },
      ]);
    }),
  );

  it.live("ticks while the agent works", () =>
    Effect.gen(function* () {
      const fake = makeFakeT3({
        phases: [
          ...Array.from({ length: 40 }, () => ({
            runs: [{ id: "run-1", ordinal: 1, status: "running" as const }],
          })),
          { runs: [{ id: "run-1", ordinal: 1, status: "completed" as const }] },
        ],
      });
      const deps = { ...fakeDeps(fake), poll: "2 millis" as const, tick: "10 millis" as const };
      const lines = yield* collect(runLines(deps, PARENT, request()));
      assert.isTrue(types(lines).includes("tick"));
      assert.strictEqual(lines.at(-1)!.type, "result");
    }),
  );
});
