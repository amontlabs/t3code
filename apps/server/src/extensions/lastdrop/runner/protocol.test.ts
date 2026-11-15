import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  bindRunner,
  isLoopbackUrl,
  runnerEnvironment,
  runnerVariables,
  threadToken,
  tokenThread,
  unbindRunner,
} from "./endpoint.ts";
import { agentsCommand, encodeLine, stepText } from "./protocol.ts";
import { withRunnerEnvironment } from "./queryEnvironment.ts";
import { fakeCatalog } from "./testkit.ts";

describe("lines", () => {
  it("one JSON object per line", () => {
    assert.strictEqual(encodeLine({ type: "tick" }), '{"type":"tick"}\n');
  });

  it("steps name the tool and its first line; messages are not steps", () => {
    assert.strictEqual(
      stepText({ id: "1", type: "command_execution", input: "ls -la\nmore" }),
      "Bash: ls -la",
    );
    assert.strictEqual(stepText({ id: "1", type: "file_change", fileName: "a.ts" }), "Edit: a.ts");
    assert.strictEqual(stepText({ id: "1", type: "file_search", pattern: "foo" }), "Search: foo");
    assert.strictEqual(
      stepText({ id: "1", type: "web_search", patterns: ["t3"] }),
      "Web search: t3",
    );
    assert.strictEqual(
      stepText({ id: "1", type: "dynamic_tool", title: "Read: a.ts", toolName: "Read" }),
      "Read: a.ts",
    );
    assert.strictEqual(stepText({ id: "1", type: "system_notice", message: "Moved." }), "Moved.");
    assert.isUndefined(stepText({ id: "1", type: "assistant_message" }));
    assert.isUndefined(stepText({ id: "1", type: "reasoning" }));
    assert.strictEqual(
      stepText({ id: "1", type: "command_execution", input: "x".repeat(400) })!.length,
      166,
    );
  });
});

describe("--agents", () => {
  const read = fakeCatalog();
  it("help, list; changes go to the lastdrop app", () => {
    assert.isFalse(agentsCommand(["--help"], read.agents, read.extras).failed);
    assert.match(agentsCommand([], read.agents, read.extras).output, /--agents list/);
    const list = JSON.parse(agentsCommand(["list"], read.agents, read.extras).output) as {
      agents: Array<{ name: string; enabled: boolean; models: unknown[] }>;
    };
    assert.deepStrictEqual(
      list.agents.map((agent) => [agent.name, agent.enabled, agent.models.length]),
      [
        ["review", true, 2],
        ["build", true, 1],
        ["old", false, 1],
        ["opus", true, 1],
      ],
    );
    const set = agentsCommand(["remove", "review"], read.agents, read.extras);
    assert.isTrue(set.failed);
    assert.match(set.output, /lastdrop\.app.*--agents remove review/);
    assert.isTrue(agentsCommand(["nope"], read.agents, read.extras).failed);
  });
});

describe("tokens", () => {
  const key = new Uint8Array(32).fill(7);
  it("name their thread and hold only with the server's key", () => {
    const token = threadToken("thread-1", key);
    assert.strictEqual(tokenThread(token, key), "thread-1");
    assert.isUndefined(tokenThread(token, new Uint8Array(32).fill(8)));
    assert.isUndefined(tokenThread(token.replace("thread-1", "thread-2"), key));
    assert.isUndefined(tokenThread("thread-1", key));
    assert.isUndefined(tokenThread("", key));
  });
});

describe("a query's environment", () => {
  const input = {
    threadId: "thread-1",
    options: { model: "opus" } as { env?: Record<string, string> },
  };

  it.effect("has no runner while lastdrop's agents can't run, or off loopback", () =>
    Effect.gen(function* () {
      bindRunner({
        script: "/t3/lastdrop/bin/lastdrop",
        url: "http://127.0.0.1:1/api/lastdrop/runner",
        available: Effect.succeed(false),
      });
      assert.isUndefined(yield* runnerVariables("thread-1"));
      bindRunner({ script: "/s", url: "http://127.0.0.1:1/api/lastdrop/runner" });
      assert.isDefined(yield* runnerVariables("thread-1"));
      bindRunner({ script: "/s", url: "http://10.0.0.2:1/api/lastdrop/runner" });
      assert.isUndefined(runnerEnvironment("thread-1"));
      assert.isTrue(isLoopbackUrl("http://[::1]:5/x"));
      assert.isFalse(isLoopbackUrl("http://127.0.0.1.example.com:5/x"));
    }).pipe(Effect.ensuring(Effect.sync(unbindRunner))),
  );

  it("is unchanged until the routes are bound", () => {
    unbindRunner();
    assert.strictEqual(withRunnerEnvironment(input, { HOME: "/h" }), input);
  });

  it("gains the runner, its address and the thread's token, over the query's own environment", () => {
    bindRunner({
      script: "/t3/lastdrop/bin/lastdrop",
      url: "http://127.0.0.1:1/api/lastdrop/runner",
    });
    try {
      const fromHost = withRunnerEnvironment(input, { HOME: "/h", UNSET: undefined });
      const env = fromHost.options.env!;
      assert.strictEqual(env.HOME, "/h");
      assert.isFalse("UNSET" in env);
      assert.strictEqual(env.LASTDROP_RUNNER, "/t3/lastdrop/bin/lastdrop");
      assert.strictEqual(env.LASTDROP_RUNNER_URL, "http://127.0.0.1:1/api/lastdrop/runner");
      assert.strictEqual(tokenThread(env.LASTDROP_RUNNER_TOKEN!), "thread-1");
      const own = withRunnerEnvironment(
        {
          ...input,
          options: {
            env: { CLAUDE_CONFIG_DIR: "/p", LASTDROP_ENDPOINT: "zai" } as Record<string, string>,
          },
        },
        { HOME: "/h" },
      );
      assert.isUndefined(own.options.env!.HOME);
      assert.strictEqual(own.options.env!.LASTDROP_ENDPOINT, "zai");
      assert.isDefined(own.options.env!.LASTDROP_RUNNER_TOKEN);
      assert.strictEqual((own.options as { model?: string }).model, undefined);
      assert.deepStrictEqual(Object.keys(runnerEnvironment("x")!).toSorted(), [
        "LASTDROP_RUNNER",
        "LASTDROP_RUNNER_TOKEN",
        "LASTDROP_RUNNER_URL",
      ]);
    } finally {
      unbindRunner();
    }
  });
});
