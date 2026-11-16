// Replays of the query-runner wrapper with a fake runner (scripted SDK messages, no Claude Code) and the real
// lastdrop-node router over a temporary home: never the real ~/.claude, ~/.claude-accounts, ~/.t3 or keychain.
// @effect-diagnostics nodeBuiltinImport:off - checks the temporary home's files.
import * as NodeFS from "node:fs";

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { accountsFile, claudeFolder, SessionLedger, ThreadRouter } from "@t3tools/lastdrop-node";
import {
  type AccountStatus,
  append,
  emptyConfig,
  encodeAccountsConfig,
  makeTestHome,
  type TestHome,
} from "@t3tools/lastdrop-node/testing";
import { ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type {
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQueryRunnerShape,
  ClaudeAgentSdkQuerySession,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  type QueryRouter,
  type ThreadLineage,
  type WrapOptions,
  wrapQueryRunner,
} from "./queryRunner.ts";

const MIN = 60_000;
/** A transcript line's timestamp (plain data, written as Claude Code writes it). */
// @effect-diagnostics-next-line globalDate:off - transcript timestamps are ISO strings.
const iso = (ms: number): string => new Date(ms).toISOString();
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

interface Fake {
  readonly runner: ClaudeAgentSdkQueryRunnerShape;
  readonly opened: ClaudeAgentSdkQueryOpenInput[];
  readonly offered: SDKUserMessage[];
  readonly forks: Array<{ sessionId: string; upTo: string | undefined }>;
  readonly lookups: string[];
  closed: number;
}

/**
 * A runner whose n-th query answers `script(n)`'s first batch at once, and the next batch after each message
 * it is offered (a retry's "continue").
 */
function fakeRunner(script: (n: number) => ReadonlyArray<ReadonlyArray<SDKMessage>>): Fake {
  const fake: Fake = {
    opened: [],
    offered: [],
    forks: [],
    lookups: [],
    closed: 0,
    runner: undefined as unknown as ClaudeAgentSdkQueryRunnerShape,
  };
  const open = (input: ClaudeAgentSdkQueryOpenInput) =>
    Effect.gen(function* () {
      fake.opened.push(input);
      const batches = [...script(fake.opened.length)];
      const queue = yield* Queue.unbounded<SDKMessage, Cause.Done>();
      const next = Effect.gen(function* () {
        const batch = batches.shift();
        if (batch === undefined) return yield* Queue.end(queue);
        yield* Queue.offerAll(queue, batch);
        if (batches.length === 0) yield* Queue.end(queue);
      });
      yield* next;
      const session: ClaudeAgentSdkQuerySession = {
        messages: Stream.fromQueue(queue),
        offer: (message) =>
          Effect.gen(function* () {
            fake.offered.push(message);
            yield* next;
          }),
        setModel: () => Effect.void,
        applyFlagSettings: () => Effect.void,
        setPermissionMode: () => Effect.void,
        stopTask: () => Effect.void,
        backgroundTasks: () => Effect.succeed(false),
        mcpServerStatus: Effect.succeed([]),
        readMcpResource: () => Effect.succeed({ contents: [] }),
        callMcpTool: () => Effect.succeed({}),
        listPermissionRules: Effect.succeed([]),
        interrupt: Effect.void,
        close: Effect.sync(() => {
          fake.closed += 1;
        }),
      };
      return session;
    });
  (fake as { runner: ClaudeAgentSdkQueryRunnerShape }).runner = {
    allocateSessionId: Effect.succeed("allocated"),
    open,
    forkSession: (input) =>
      Effect.sync(() => {
        fake.forks.push({
          sessionId: input.sessionId,
          upTo: (input.options as { upToMessageId?: string }).upToMessageId,
        });
        return { sessionId: "forked-by-t3" };
      }),
    subagentLaunchToolUseId: (input) =>
      Effect.sync(() => {
        fake.lookups.push(input.sessionId);
        return input.sessionId === "X" ? "tool-1" : null;
      }),
    assertComplete: Effect.void,
  };
  return fake;
}

const init = (session = "s"): SDKMessage =>
  ({ type: "system", subtype: "init", session_id: session, uuid: "i" }) as unknown as SDKMessage;
const answer = (): SDKMessage =>
  ({
    type: "assistant",
    message: { model: "claude-haiku-5-5", content: [] },
    session_id: "s",
    uuid: "a",
  }) as unknown as SDKMessage;
const result = (fields: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    session_id: "s",
    uuid: "r",
    num_turns: 1,
    duration_ms: 1,
    ...fields,
  }) as unknown as SDKMessage;

interface World {
  readonly t: TestHome;
  readonly router: ThreadRouter;
  readonly ledger: SessionLedger;
  statuses: Record<string, AccountStatus>;
  now: number;
}

function world(): World {
  const t = makeTestHome();
  let config = emptyConfig();
  for (const key of ["Pro", "Ultra"])
    config = append(config, { provider: "claude", key, addedAt: 0 });
  t.write(accountsFile(t.paths), encodeAccountsConfig(config));
  t.write(t.paths.sharedConfig, { oauthAccount: { accountUuid: "u-main" } });
  for (const key of ["Pro", "Ultra"]) {
    t.write(`${claudeFolder(t.paths, key)}/.claude.json`, {
      oauthAccount: { accountUuid: `u-${key}` },
    });
  }
  const ledger = new SessionLedger(`${t.paths.dataDir}/sessions.json`);
  const ids = ["moved-1", "moved-2"];
  const w: World = {
    t,
    ledger,
    statuses: {},
    now: Date.UTC(2026, 10, 14, 12),
    router: undefined as unknown as ThreadRouter,
  };
  w.statuses = {
    main: { session: 85, weekly: 50, at: w.now, plan: "Max 5x" },
    Pro: { session: 10, weekly: 10, at: w.now, plan: "Pro" },
    Ultra: { session: 0, weekly: 5, at: w.now, plan: "Ultra" },
  };
  (w as { router: ThreadRouter }).router = new ThreadRouter({
    paths: t.paths,
    ledger,
    statuses: async () => w.statuses,
    now: () => w.now,
    newSessionId: () => ids.shift()!,
  });
  return w;
}

const openInput = (
  threadId: string,
  identity: Record<string, string | boolean>,
  env: Record<string, string> = { PATH: "/bin" },
): ClaudeAgentSdkQueryOpenInput =>
  ({
    threadId: ThreadId.make(threadId),
    providerSessionId: "provider-session",
    options: { model: "claude-haiku-5-5", tools: [], permissionMode: "default", env, ...identity },
  }) as unknown as ClaudeAgentSdkQueryOpenInput;

const wrap = (
  w: World,
  fake: Fake,
  lineage: (threadId: string) => ThreadLineage = () => ({ delegated: false }),
  extra: {
    readonly router?: QueryRouter;
    readonly deadlineMs?: number;
    readonly sleep?: (ms: number) => Effect.Effect<void>;
    readonly onLimitMove?: WrapOptions["onLimitMove"];
    readonly onOpen?: WrapOptions["onOpen"];
  } = {},
) => {
  const waits: number[] = [];
  const runner = wrapQueryRunner(fake.runner, {
    router: extra.router ?? w.router,
    lineage: (id) => Effect.succeed(lineage(id)),
    hostEnvironment: { PATH: "/bin" },
    sleep: extra.sleep ?? ((ms) => Effect.sync(() => void waits.push(ms))),
    random: Effect.succeed(0),
    ...(extra.deadlineMs === undefined ? {} : { deadlineMs: extra.deadlineMs }),
    ...(extra.onLimitMove === undefined ? {} : { onLimitMove: extra.onLimitMove }),
    ...(extra.onOpen === undefined ? {} : { onOpen: extra.onOpen }),
  });
  return { runner, waits };
};

const drain = (session: ClaudeAgentSdkQuerySession) =>
  session.messages.pipe(
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  );

const opts = (input: ClaudeAgentSdkQueryOpenInput) =>
  input.options as unknown as Record<string, unknown>;
const env = (input: ClaudeAgentSdkQueryOpenInput) => opts(input)["env"] as Record<string, string>;

const withWorld = <A, E>(body: (w: World) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(Effect.sync(world), body, (w) => Effect.sync(() => w.t.remove()));

describe("the query-runner wrapper (replays)", () => {
  it.effect(
    "a new thread opens on the best account, signed in through its folder and profile",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const fake = fakeRunner(() => [[init(), answer(), result()]]);
          const { runner } = wrap(w, fake);
          const session = yield* runner.open(openInput("thread-1", { sessionId: "X" }));
          const messages = yield* drain(session);
          assert.deepEqual(
            messages.map((m) => m.type),
            ["system", "assistant", "result"],
          );
          const opened = fake.opened[0]!;
          assert.equal(opts(opened)["sessionId"], "X");
          assert.isUndefined(opts(opened)["resume"]);
          assert.equal(
            env(opened)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
            claudeFolder(w.t.paths, "Ultra"),
          );
          assert.equal(
            env(opened)["CLAUDE_CONFIG_DIR"],
            `${claudeFolder(w.t.paths, "Ultra")}/profile`,
          );
          assert.equal(opened.threadId, "thread-1");
          assert.equal(fake.closed, 0);
        }),
      ),
  );

  it.effect("a warm thread stays on its account; a cold one moves with a fork and a new id", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const fake = fakeRunner(() => [[init(), result()]]);
        const { runner } = wrap(w, fake);
        yield* drain(yield* runner.open(openInput("thread-1", { sessionId: "X" }))); // Ultra
        w.t.write(
          `${w.t.paths.sharedClaude}/projects/proj/X.jsonl`,
          line({ type: "assistant", uuid: "x1", timestamp: iso(w.now - 5 * MIN) }),
        );
        w.statuses = { ...w.statuses, Pro: { session: 0, weekly: 0, at: w.now, plan: "Max 20x" } };
        yield* drain(yield* runner.open(openInput("thread-1", { resume: "X" })));
        assert.equal(opts(fake.opened[1]!)["resume"], "X");
        assert.isUndefined(opts(fake.opened[1]!)["forkSession"]);
        assert.equal(
          env(fake.opened[1]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Ultra"),
        );

        w.now += 2 * 60 * MIN;
        w.statuses = Object.fromEntries(
          Object.entries(w.statuses).map(([k, v]) => [k, { ...v, at: w.now }]),
        );
        const moved = yield* runner.open(openInput("thread-1", { resume: "X" }));
        const messages = yield* drain(moved);
        const o = opts(fake.opened[2]!);
        assert.equal(o["resume"], "X");
        assert.equal(o["forkSession"], true);
        assert.equal(o["sessionId"], "moved-1");
        assert.equal(
          env(fake.opened[2]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Pro"),
        );
        // A move that costs nothing says nothing.
        assert.isFalse(
          messages.some(
            (m) => m.type === "system" && (m as { subtype?: string }).subtype === "informational",
          ),
        );
        assert.equal(
          (yield* Effect.promise(() => w.ledger.read())).threads["X"]?.current,
          "moved-1",
        );
      }),
    ),
  );

  it.effect("rollback and fork after a move translate T3's ids", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const projects = `${w.t.paths.sharedClaude}/projects`;
        yield* Effect.promise(async () => {
          await w.ledger.record({ session: "X", account: "Ultra", at: w.now });
          await w.ledger.record({
            session: "C",
            account: "Pro",
            at: w.now,
            forkedAt: w.now,
            from: "X",
          });
          await w.ledger.setCurrent("C", "X", w.now);
        });
        w.t.write(
          `${projects}/p/X.jsonl`,
          line({ type: "assistant", uuid: "x2", timestamp: iso(w.now) }),
        );
        w.t.write(
          `${projects}/p/C.jsonl`,
          line({
            type: "assistant",
            uuid: "c2",
            forkedFrom: { sessionId: "X", messageUuid: "x2" },
            timestamp: iso(w.now),
          }),
        );
        const fake = fakeRunner(() => [[init(), result()]]);
        const { runner } = wrap(w, fake);
        // Rewind to a turn from before the move: T3 passes its own id and the old message's id.
        yield* drain(
          yield* runner.open(openInput("thread-1", { resume: "X", resumeSessionAt: "x2" })),
        );
        const o = opts(fake.opened[0]!);
        assert.equal(o["resume"], "C");
        assert.equal(o["resumeSessionAt"], "c2");
        assert.isUndefined(o["forkSession"]);
        assert.equal(
          env(fake.opened[0]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Pro"),
        );
        // T3's own fork of the thread, up to that message (the SDK writes the fork's transcript).
        w.t.write(`${projects}/p/forked-by-t3.jsonl`, line({ type: "user", uuid: "f1" }));
        yield* runner.forkSession({
          sessionId: "X",
          options: { upToMessageId: "x2" },
          environment: {},
          threadId: ThreadId.make("thread-2"),
          providerSessionId: "provider-session",
        } as unknown as Parameters<ClaudeAgentSdkQueryRunnerShape["forkSession"]>[0]);
        assert.deepEqual(fake.forks, [{ sessionId: "C", upTo: "c2" }]);
        const store = yield* Effect.promise(() => w.ledger.read());
        assert.deepEqual(store.sessions["forked-by-t3"]?.account, "Pro");
        // A subagent from before the move is looked up in the older conversation too.
        const found = yield* runner.subagentLaunchToolUseId({
          sessionId: "X",
          agentId: "a",
          dir: null,
          threadId: ThreadId.make("thread-1"),
          providerSessionId: "provider-session",
        } as unknown as Parameters<ClaudeAgentSdkQueryRunnerShape["subagentLaunchToolUseId"]>[0]);
        assert.equal(found, "tool-1");
        assert.deepEqual(fake.lookups, ["C", "X"]);
      }),
    ),
  );

  it.effect("a usage limit mid-run is surfaced in the thread and ends the query", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const limited = result({
          is_error: true,
          result: "You've hit your session limit · resets 5pm",
          api_error_status: 429,
        });
        const fake = fakeRunner((n) =>
          n === 1 ? [[init(), limited, answer()]] : [[init(), answer(), result()]],
        );
        const { runner } = wrap(w, fake);
        const messages = yield* drain(
          yield* runner.open(openInput("thread-1", { sessionId: "X" })),
        );
        const notice = messages.find(
          (m) => m.type === "system" && (m as { subtype?: string }).subtype === "informational",
        ) as unknown as { level: string; content: string } | undefined;
        assert.isDefined(notice);
        assert.equal(notice!.level, "notice");
        assert.include(notice!.content, "Ultra reached its usage limit");
        assert.include(notice!.content, "Pro");
        const last = messages.at(-1) as unknown as { type: string; errors?: string[] };
        assert.equal(last.type, "result");
        assert.equal(last.errors?.[0], notice!.content);
        // The query ended at the result (nothing after it reached T3), closed by T3's own close.
        assert.equal(fake.closed, 1);
        // The next message opens on another account, even though the thread is warm.
        w.t.write(
          `${w.t.paths.sharedClaude}/projects/p/X.jsonl`,
          line({ type: "assistant", uuid: "x1", timestamp: iso(w.now - MIN) }),
        );
        const next = yield* runner.open(openInput("thread-1", { resume: "X" }));
        const nextMessages = yield* drain(next);
        // The notice comes just before the first answer, never with Claude Code's first frames.
        const at = nextMessages.findIndex(
          (m) => m.type === "system" && (m as { subtype?: string }).subtype === "informational",
        );
        assert.equal(nextMessages[at + 1]?.type, "assistant");
        assert.equal(
          env(fake.opened[1]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Pro"),
        );
        assert.equal(opts(fake.opened[1]!)["forkSession"], true);
        assert.isTrue(
          nextMessages.some(
            (m) =>
              m.type === "system" &&
              (m as { subtype?: string; content?: string }).content?.includes(
                "is at its usage limit",
              ) === true,
          ),
        );
      }),
    ),
  );

  it.effect(
    "a limit move reports the cut subagent and brings its transcript to the fork before it opens",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          const frame = (o: Record<string, unknown>) =>
            ({ session_id: "s", uuid: "u", ...o }) as unknown as SDKMessage;
          const frames = [
            init(),
            frame({
              type: "assistant",
              parent_tool_use_id: null,
              message: {
                model: "claude-haiku-5-5",
                content: [{ type: "tool_use", id: "toolu_cut", name: "Agent", input: {} }],
              },
            }),
            frame({
              type: "system",
              subtype: "task_started",
              task_id: "a-cut",
              tool_use_id: "toolu_cut",
              description: "Remember and write",
              task_type: "local_agent",
              prompt: "Remember the word, write the file, then go on.",
              is_backgrounded: false,
            }),
            frame({
              type: "system",
              subtype: "task_started",
              task_id: "a-done",
              tool_use_id: "toolu_done",
              description: "Quick look",
              task_type: "local_agent",
            }),
            frame({
              type: "system",
              subtype: "task_notification",
              task_id: "a-done",
              status: "completed",
              output_file: "",
              summary: "ok",
            }),
            frame({
              type: "user",
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "toolu_cut",
                    is_error: true,
                    content: [
                      {
                        type: "text",
                        text: "Agent terminated early due to an API error: You've hit your 5-hour limit · resets 5pm",
                      },
                    ],
                  },
                ],
              },
            }),
            result({
              is_error: true,
              result: "You've hit your session limit · resets 5pm",
              api_error_status: 429,
            }),
          ];
          const fake = fakeRunner((n) => (n === 1 ? [frames] : [[init(), answer(), result()]]));
          const projects = `${w.t.paths.sharedClaude}/projects`;
          const copied = `${projects}/p/moved-1/subagents/agent-a-cut.jsonl`;
          const atOpen: boolean[] = [];
          const checked: Fake = {
            ...fake,
            runner: {
              ...fake.runner,
              open: (input) =>
                Effect.sync(() => void atOpen.push(NodeFS.existsSync(copied))).pipe(
                  Effect.andThen(fake.runner.open(input)),
                ),
            },
          };
          const moves: Array<Parameters<NonNullable<WrapOptions["onLimitMove"]>>[0]> = [];
          const opens: string[] = [];
          const { runner } = wrap(w, checked, undefined, {
            onLimitMove: (move) => void moves.push(move),
            onOpen: (threadId) => void opens.push(threadId),
          });
          yield* drain(yield* runner.open(openInput("thread-1", { sessionId: "X" })));
          assert.deepEqual(moves, [
            {
              threadId: "thread-1",
              from: "Ultra",
              to: "Pro",
              work: [
                {
                  kind: "subagent",
                  label: "Remember and write (id a-cut)",
                  id: "lastdrop-cut:a-cut",
                },
              ],
            },
          ]);
          // The cut subagent's transcript sits under the conversation the limit ended.
          w.t.write(
            `${projects}/p/X.jsonl`,
            line({ type: "assistant", uuid: "x1", timestamp: iso(w.now - MIN) }),
          );
          w.t.write(
            `${projects}/p/X/subagents/agent-a-cut.jsonl`,
            line({ type: "user", uuid: "s1" }),
          );
          w.t.write(`${projects}/p/X/subagents/agent-a-cut.meta.json`, {
            agentType: "general-purpose",
          });
          yield* drain(yield* runner.open(openInput("thread-1", { resume: "X" })));
          assert.equal(opts(fake.opened[1]!)["sessionId"], "moved-1");
          assert.deepEqual(atOpen, [false, true]);
          assert.isTrue(NodeFS.existsSync(`${projects}/p/moved-1/subagents/agent-a-cut.meta.json`));
          assert.deepEqual(opens, ["thread-1", "thread-1"]);
        }),
      ),
  );

  it.effect("a passing API error is retried in the same query, T3 sees one turn", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const failed = result({
          is_error: true,
          result: "API Error: 503 credential validation failed",
          api_error_status: 503,
        });
        const fake = fakeRunner(() => [
          [init(), failed],
          [answer(), result()],
        ]);
        const { runner, waits } = wrap(w, fake);
        const messages = yield* drain(
          yield* runner.open(openInput("thread-1", { sessionId: "X" })),
        );
        assert.deepEqual(
          messages.map((m) => m.type),
          ["system", "assistant", "result"],
        );
        assert.isFalse((messages.at(-1) as unknown as { is_error: boolean }).is_error);
        assert.deepEqual(waits, [10_000]);
        assert.equal(fake.offered.length, 1);
        assert.include(JSON.stringify(fake.offered[0]), "temporary API error");
        assert.equal(fake.closed, 0);
      }),
    ),
  );

  it.effect("retries spent: the error goes through and the query ends", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const failed = () =>
          result({ is_error: true, result: "API Error: 529 overloaded", api_error_status: 529 });
        const fake = fakeRunner(() => [[failed()], [failed()], [failed()], [failed()], [failed()]]);
        const { runner, waits } = wrap(w, fake);
        const messages = yield* drain(
          yield* runner.open(openInput("thread-1", { sessionId: "X" })),
        );
        assert.deepEqual(waits, [10_000, 30_000, 90_000, 180_000]);
        assert.equal(messages.length, 1);
        assert.isTrue((messages[0] as unknown as { is_error: boolean }).is_error);
        assert.equal(fake.closed, 1);
        // The account is left alone a while: the next query opens elsewhere.
        yield* drain(yield* runner.open(openInput("thread-2", { sessionId: "Y" })));
        assert.equal(
          env(fake.opened[1]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Pro"),
        );
      }),
    ),
  );

  it.effect("delegated children pick with the subagents' rule", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const fake = fakeRunner(() => [[init(), result()]]);
        const { runner } = wrap(w, fake, (id) =>
          id === "child" ? { delegated: true, parentThreadId: "thread-1" } : { delegated: false },
        );
        yield* drain(yield* runner.open(openInput("thread-1", { sessionId: "P" })));
        yield* drain(yield* runner.open(openInput("child", { sessionId: "K" })));
        assert.equal(
          env(fake.opened[0]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Ultra"),
        );
        // The smallest plan with room, not the roomiest.
        assert.equal(
          env(fake.opened[1]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Pro"),
        );
      }),
    ),
  );

  it.effect("the user's own sign-in in the environment runs as asked", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const fake = fakeRunner(() => [[init(), result()]]);
        const { runner } = wrap(w, fake);
        const input = openInput("thread-1", { sessionId: "X" }, { ANTHROPIC_API_KEY: "sk-x" });
        yield* drain(yield* runner.open(input));
        assert.deepEqual(opts(fake.opened[0]!), opts(input));
      }),
    ),
  );

  it.effect(
    "a Z.ai or OpenRouter instance's query opens untouched, even with a recorded session",
    () =>
      withWorld((w) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            w.ledger.record({ session: "Z1", account: "Pro", at: w.now }),
          );
          const fake = fakeRunner(() => [[init(), result()]]);
          const { runner } = wrap(w, fake);
          const input = openInput(
            "thread-z",
            { resume: "Z1" },
            { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", LASTDROP_ENDPOINT: "zai" },
          );
          yield* drain(yield* runner.open(input));
          assert.deepEqual(opts(fake.opened[0]!), opts(input));
        }),
      ),
  );

  // Review fixes: the open never runs another account's id on Main, and late routes never write.
  const recordOnPro = (w: World) =>
    Effect.promise(async () => {
      await w.ledger.record({ session: "B1", account: "Pro", at: w.now });
      w.t.write(
        `${w.t.paths.sharedClaude}/projects/p/B1.jsonl`,
        line({ type: "assistant", uuid: "b", timestamp: iso(w.now - MIN) }),
      );
    });

  it.effect("a route that throws opens the thread on its recorded account, never Main", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        yield* recordOnPro(w);
        const throwing: QueryRouter = Object.assign(Object.create(w.router), {
          route: () => Promise.reject(new Error("boom")),
        });
        const fake = fakeRunner(() => [[init(), result()]]);
        const { runner } = wrap(w, fake, undefined, { router: throwing });
        yield* drain(yield* runner.open(openInput("thread-1", { resume: "B1" })));
        assert.equal(opts(fake.opened[0]!)["resume"], "B1");
        assert.isUndefined(opts(fake.opened[0]!)["forkSession"]);
        assert.equal(
          env(fake.opened[0]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Pro"),
        );
      }),
    ),
  );

  it.effect("a route past the deadline is dropped and never writes the ledger afterwards", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        yield* recordOnPro(w);
        let lateCommits = 0;
        const asked = yield* Deferred.make<void>();
        let finish: () => void = () => {};
        const late = new Promise<void>((resolve) => (finish = resolve));
        const slow: QueryRouter = Object.assign(Object.create(w.router), {
          route: async (input: Parameters<QueryRouter["route"]>[0]) => {
            Deferred.doneUnsafe(asked, Effect.void);
            await late;
            const route = await w.router.route(input);
            return { ...route, commit: async () => void (lateCommits += 1) };
          },
        });
        const fake = fakeRunner(() => [[init(), result()]]);
        const { runner } = wrap(w, fake, undefined, { router: slow, deadlineMs: 3000 });
        const before = yield* Effect.promise(() => w.ledger.read());
        const opening = yield* Effect.forkChild(
          runner.open(openInput("thread-1", { resume: "B1" })),
        );
        yield* Deferred.await(asked);
        yield* TestClock.adjust("4 seconds");
        yield* drain(yield* Fiber.join(opening));
        // The late route comes back now: it is never committed.
        finish();
        yield* Effect.promise(() => late);
        yield* Effect.yieldNow;
        assert.equal(lateCommits, 0);
        assert.deepEqual(yield* Effect.promise(() => w.ledger.read()), before);
        // The thread opened on its own account.
        assert.equal(opts(fake.opened[0]!)["resume"], "B1");
        assert.equal(
          env(fake.opened[0]!)["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
          claudeFolder(w.t.paths, "Pro"),
        );
      }),
    ),
  );

  it.effect("with no route and no readable ledger, the open is refused with a clear error", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        w.t.write(`${w.t.paths.dataDir}/sessions.json`, "{broken");
        const fake = fakeRunner(() => [[init(), result()]]);
        const { runner } = wrap(w, fake);
        const exit = yield* runner.open(openInput("thread-1", { resume: "B1" })).pipe(Effect.exit);
        assert.equal(exit._tag, "Failure");
        assert.include(String(exit), "couldn't open this thread on its Claude account");
        assert.lengthOf(fake.opened, 0);
      }),
    ),
  );

  it.effect("a limit with nowhere to move keeps the query open, as plain T3 does", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        w.router.markFull("Pro");
        w.router.markFull("main");
        const limited = result({
          is_error: true,
          result: "You've hit your session limit",
          api_error_status: 429,
        });
        const fake = fakeRunner(() => [[init(), limited]]);
        const { runner } = wrap(w, fake);
        const messages = yield* drain(
          yield* runner.open(openInput("thread-1", { sessionId: "X" })),
        );
        assert.equal(fake.closed, 0);
        const last = messages.at(-1) as unknown as { type: string; errors?: string[] };
        assert.equal(last.type, "result");
        assert.isUndefined(last.errors);
        assert.isTrue(
          messages.some(
            (m) =>
              (m as { content?: string }).content?.includes("no other account has room") === true,
          ),
        );
      }),
    ),
  );

  it.effect("notices get random ids: a restart never repeats a turn item id", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const limited = () =>
          result({
            is_error: true,
            result: "You've hit your session limit",
            api_error_status: 429,
          });
        const ids: string[] = [];
        for (let i = 0; i < 2; i++) {
          // A new wrapper each time: as after a server restart.
          const fake = fakeRunner(() => [[init(), limited()]]);
          const { runner } = wrap(w, fake);
          const messages = yield* drain(
            yield* runner.open(openInput(`thread-${i}`, { sessionId: `S${i}` })),
          );
          for (const m of messages)
            if ((m as { subtype?: string }).subtype === "informational") ids.push(m.uuid!);
        }
        assert.lengthOf(ids, 2);
        assert.notEqual(ids[0], ids[1]);
        assert.match(ids[0]!, /^[0-9a-f-]{36}$/u);
      }),
    ),
  );

  it.effect("closing during a retry wait lets the held result through at once", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        const failed = result({
          is_error: true,
          result: "API Error: 503 credential validation failed",
          api_error_status: 503,
        });
        const fake = fakeRunner(() => [[init(), failed]]);
        const waiting = yield* Deferred.make<void>();
        const { runner } = wrap(w, fake, undefined, {
          sleep: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const session = yield* runner.open(openInput("thread-1", { sessionId: "X" }));
        const fiber = yield* Effect.forkChild(drain(session));
        yield* Deferred.await(waiting);
        yield* session.close;
        const messages = yield* Fiber.join(fiber);
        assert.equal(messages.at(-1)?.type, "result");
        assert.isTrue((messages.at(-1) as unknown as { is_error: boolean }).is_error);
      }),
    ),
  );

  it.effect("a notice is delivered even when the stream ends before any answer", () =>
    withWorld((w) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await w.ledger.record({ session: "G", account: "Gone", at: w.now });
        });
        const fake = fakeRunner(() => [[init()]]);
        const { runner } = wrap(w, fake);
        const messages = yield* drain(yield* runner.open(openInput("thread-1", { resume: "G" })));
        assert.isTrue(
          messages.some(
            (m) => (m as { content?: string }).content?.includes("no longer signed in") === true,
          ),
        );
      }),
    ),
  );
});
