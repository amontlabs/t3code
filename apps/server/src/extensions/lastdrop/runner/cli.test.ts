// @effect-diagnostics nodeBuiltinImport:off - A real HTTP server and the real runner script, run by sh and curl.
/**
 * The runner as the plugin runs it: the script (`endpoint.ts`) with its environment, through curl, to the
 * routes (`routes.ts`) served over HTTP, onto a fake T3 (`testkit.ts`).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { installRunnerScript, threadToken } from "./endpoint.ts";
import { handlers } from "./routes.ts";
import { resetActiveRuns } from "./runs.ts";
import { fakeDeps, makeFakeT3, type FakeT3 } from "./testkit.ts";

const PARENT = "thread-parent";

let fake: FakeT3;
let server: NodeHttp.Server;
let dispose: () => Promise<void>;
let url: string;
let script: string;

const resetFake = () => {
  fake = makeFakeT3({
    phases: [
      { runs: [{ id: "run-1", ordinal: 1, status: "running" }] },
      {
        runs: [{ id: "run-1", ordinal: 1, status: "running" }],
        items: [{ id: "i1", runId: "run-1", type: "command_execution", input: "ls" }],
      },
      { runs: [{ id: "run-1", ordinal: 1, status: "completed" }] },
    ],
    outcomes: { "run-1": "All good." },
  });
};

beforeAll(async () => {
  resetFake();
  // The fake is replaced per test; the routes reach the current one through this proxy.
  const port = new Proxy({} as FakeT3["port"], {
    get: (_, key) => fake.port[key as keyof FakeT3["port"]],
  });
  const shared = { ...fakeDeps(fake), port, poll: "20 millis" as const };
  const web = HttpRouter.toWebHandler(handlers(shared).pipe(Layer.provide(NodeServices.layer)), {
    disableLogger: true,
  });
  dispose = web.dispose;
  server = NodeHttp.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const init: RequestInit = {
      method: req.method ?? "GET",
      headers: req.headers as Record<string, string>,
    };
    if (chunks.length > 0) init.body = Buffer.concat(chunks);
    const response = await web.handler(new Request(`http://127.0.0.1${req.url}`, init));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    const reader = response.body?.getReader();
    res.on("close", () => void reader?.cancel());
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  url = `http://127.0.0.1:${address.port}/api/lastdrop/runner`;
  script = installRunnerScript(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastdrop-runner-")),
  );
});

afterAll(async () => {
  server.close();
  await dispose();
});

beforeEach(() => {
  resetActiveRuns();
  resetFake();
});

const env = (thread = PARENT): NodeJS.ProcessEnv => ({
  ...process.env,
  LASTDROP_RUNNER: script,
  LASTDROP_RUNNER_URL: url,
  LASTDROP_RUNNER_TOKEN: threadToken(thread),
});

const run = (args: string[], input?: string, environment = env()) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = NodeChildProcess.spawn(script, args, { env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

const lines = (stdout: string) =>
  stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const REQUEST = JSON.stringify({
  prompt: "Review it.",
  cwd: "/repo",
  agent: "review",
  id: "agent-c1",
});

describe("the runner script", () => {
  it("is an executable the plugin can spawn", () => {
    expect(NodeFS.statSync(script).mode & 0o111).not.toBe(0);
  });

  it("--agent-catalog prints one line", async () => {
    const out = await run(["--agent-catalog"]);
    expect(out.code).toBe(0);
    const [line] = lines(out.stdout);
    expect(line).toMatchObject({
      nativeTasks: true,
      agentModels: true,
      t3Instance: true,
      t3InstanceId: "lastdropAgents",
      revision: 7,
    });
    expect((line!.agents as Array<{ name: string }>).map((agent) => agent.name)).toEqual([
      "review",
      "build",
    ]);
  });

  it("--agent-route answers routed or no_room", async () => {
    expect(lines((await run(["--agent-route"], REQUEST)).stdout)).toEqual([{ type: "routed" }]);
    const plain = JSON.stringify({ prompt: "p", cwd: "/repo", subagentType: "Explore" });
    expect(lines((await run(["--agent-route"], plain)).stdout)).toEqual([{ type: "no_room" }]);
  });

  it("--agent-run streams the run to its result", async () => {
    const out = await run(["--agent-run"], REQUEST);
    expect(out.code).toBe(0);
    expect(lines(out.stdout).map((line) => line.type)).toEqual(["started", "step", "result"]);
    expect(lines(out.stdout).at(-1)).toMatchObject({ text: "All good.", isError: false });
    expect(fake.started[0]!.parent).toBe(PARENT);
  });

  it("--agent-stop stops a running agent; an unknown one fails", async () => {
    fake = makeFakeT3({ phases: [{ runs: [{ id: "run-1", ordinal: 1, status: "running" }] }] });
    const running = run(["--agent-run"], REQUEST);
    await fake.following;
    const stop = await run(["--agent-stop", "agent-c1"]);
    expect(stop.code).toBe(0);
    expect(lines(stop.stdout)).toEqual([{ type: "stopped" }]);
    fake.script([{ runs: [{ id: "run-1", ordinal: 1, status: "cancelled" }] }]);
    const out = await running;
    expect(lines(out.stdout).at(-1)).toMatchObject({ type: "result", stopped: true });
    const unknown = await run(["--agent-stop", "agent-zz"]);
    expect(unknown.code).not.toBe(0);
    expect(lines(unknown.stdout)).toEqual([
      { type: "error", text: "Agent agent-zz isn't running." },
    ]);
  });

  it("ending the runner stops the agent", async () => {
    fake = makeFakeT3({ phases: [{ runs: [{ id: "run-1", ordinal: 1, status: "running" }] }] });
    const child = NodeChildProcess.spawn(script, ["--agent-run"], { env: env() });
    child.stdin.end(REQUEST);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGTERM");
    await expect
      .poll(() => fake.stopped)
      .toEqual([{ parent: PARENT, child: "child-1", taskId: "task-1" }]);
  });

  it("--agents --help and list; a change is refused", async () => {
    const help = await run(["--agents", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/lastdrop --agents list/);
    const list = await run(["--agents", "list"]);
    expect(JSON.parse(list.stdout).agents).toHaveLength(4);
    const remove = await run(["--agents", "remove", "review"]);
    // As the lastdrop app: 1, not curl's 22.
    expect(remove.code).toBe(1);
    expect(remove.stdout).toMatch(/doesn't change lastdrop's agents/);
  });

  it("the other flags answer plainly", async () => {
    expect((await run(["--agent-warm"], REQUEST)).code).toBe(0);
    expect(lines((await run(["--agent-selftest"])).stdout)[0]!.type).toBe("skipped");
    expect((await run(["--agent-open", "agent-c1"])).code).not.toBe(0);
    expect((await run(["--delegate-note"], "{}")).code).not.toBe(0);
  });

  it("refuses a token that doesn't hold, and runs nothing", async () => {
    const out = await run(["--agent-run"], REQUEST, {
      ...env(),
      LASTDROP_RUNNER_TOKEN: `${PARENT}.forged`,
    });
    expect(out.code).not.toBe(0);
    expect(lines(out.stdout)[0]).toMatchObject({ type: "error" });
    expect(fake.started).toEqual([]);
  });

  it("refuses a deleted thread's token", async () => {
    fake = makeFakeT3({ phases: [{ runs: [] }], deletedThreads: [PARENT] });
    const out = await run(["--agent-run"], REQUEST);
    expect(out.code).not.toBe(0);
    expect(lines(out.stdout)[0]).toMatchObject({ type: "error" });
    expect(fake.started).toEqual([]);
  });

  it("sends its token to this machine only", async () => {
    const out = await run(["--agent-catalog"], undefined, {
      ...env(),
      LASTDROP_RUNNER_URL: "http://192.168.1.20:3773/api/lastdrop/runner",
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/isn't a loopback address/);
  });

  it("outside a fork thread it says so", async () => {
    const { LASTDROP_RUNNER_URL: _url, ...rest } = env();
    const out = await run(["--agent-catalog"], undefined, rest as NodeJS.ProcessEnv);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/not inside a T3 Code lastdrop thread/);
  });
});
