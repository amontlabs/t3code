// Replays of the query-runner wrapper with a fake runner (scripted SDK messages, no Claude Code) and the real
// lastdrop-node router over a temporary home: never the real ~/.claude, ~/.claude-accounts, ~/.t3 or keychain.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { accountsFiles, claudeFolder, SessionLedger, ThreadRouter } from "@t3tools/lastdrop-node";
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
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type {
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQueryRunnerShape,
  ClaudeAgentSdkQuerySession,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { type ThreadLineage, wrapQueryRunner } from "./queryRunner.ts";

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
  t.write(accountsFiles(t.paths).accounts, encodeAccountsConfig(config));
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
) => {
  const waits: number[] = [];
  const runner = wrapQueryRunner(fake.runner, {
    router: w.router,
    lineage: (id) => Effect.succeed(lineage(id)),
    hostEnvironment: { PATH: "/bin" },
    sleep: (ms) => Effect.sync(() => void waits.push(ms)),
    random: Effect.succeed(0),
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
        // T3's own fork of the thread, up to that message.
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
        const fake = fakeRunner(() => [[init(), limited, answer()]]);
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
});
