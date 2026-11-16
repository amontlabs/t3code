// Ported from headroom Tests/LastDropTests/EndpointBackendTests.swift (profile, key helper, live) and the Z.ai
// and OpenRouter usage readers. A temporary home and a fake `security`; nothing real is read or written.
// The live check is opt-in: LASTDROP_LIVE_ENDPOINT=1 reads the real keys and asks the real endpoints.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { endpointInstance } from "@t3tools/lastdrop-core";

import type { FetchLike } from "./claudeUsage.ts";
import {
  endpointApiKey,
  endpointDirectory,
  lookupEndpointKey,
  EndpointMonitor,
  fetchOpenRouterUsage,
  fetchZaiUsage,
  keyHelperPath,
  prepareEndpointProfile,
  validateOpenRouterKey,
} from "./endpoints.ts";
import { lastdropPaths } from "./paths.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

const onMacOS = NodeFS.existsSync("/usr/bin/plutil");

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const fakeFetch =
  (
    answer: (url: string, headers: Record<string, string>) => { status: number; body?: unknown },
    calls: Call[] = [],
  ): FetchLike =>
  async (url, init) => {
    calls.push({ url, headers: init.headers });
    const { status, body } = answer(url, init.headers);
    return {
      status,
      headers: { get: () => null },
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    };
  };

let home: TestHome;
beforeEach(() => {
  home = makeTestHome();
});
afterEach(() => home.remove());

describe("endpoint keys", () => {
  it("tells a missing key apart from a keychain it couldn't read", async () => {
    expect(await lookupEndpointKey("zai", home.paths)).toEqual({ state: "missing" });
    home.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("k"));
    home.lockKeychain(true);
    expect(await lookupEndpointKey("zai", home.paths)).toEqual({ state: "unreadable" });
    // A fallback key still counts while the keychain is locked.
    expect(await lookupEndpointKey("zai", home.paths, { ZAI_API_KEY: "e" })).toEqual({
      state: "found",
      key: "e",
    });
    home.lockKeychain(false);
    expect(await lookupEndpointKey("zai", home.paths)).toEqual({ state: "found", key: "k" });
  });

  it("reads the fork's own item, then the fallbacks, and never the app's", async () => {
    expect(await endpointApiKey("zai", home.paths)).toBeUndefined();
    expect(await endpointApiKey("zai", home.paths, { GLM_API_KEY: " env-key " })).toBe("env-key");
    home.write(`${home.paths.home}/.config/zai/key.json`, { api_key: "file-key" });
    expect(await endpointApiKey("zai", home.paths, { ZAI_API_KEY: "env" })).toBe("file-key");
    home.setKeychainItem("lastdrop", "zai-api-key", b64("app-key"));
    home.setKeychainItem("Headroom", "zai-api-key", b64("old-app-key"));
    expect(await endpointApiKey("zai", home.paths)).toBe("file-key");
    home.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("own-key"));
    expect(await endpointApiKey("zai", home.paths)).toBe("own-key");

    expect(await endpointApiKey("openrouter", home.paths, { ZAI_API_KEY: "x" })).toBeUndefined();
    expect(await endpointApiKey("openrouter", home.paths, { OPENROUTER_API_KEY: "or-env" })).toBe(
      "or-env",
    );
    home.setKeychainItem("t3code-lastdrop", "openrouter-api-key", b64("or-own"));
    expect(await endpointApiKey("openrouter", home.paths)).toBe("or-own");
  });
});

describe("endpoint profile", () => {
  it("owns its settings and onboarding without changing shared settings", async () => {
    const shared = home.paths.sharedClaude;
    const dir = endpointDirectory(home.paths, "openrouter");
    home.write(`${shared}/settings.json`, `{"env":{"ANTHROPIC_AUTH_TOKEN":"other-account"}}`);
    home.write(`${shared}/CLAUDE.md`, "role");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.symlinkSync(`${shared}/settings.json`, `${dir}/settings.json`);
    home.write(`${dir}/session-settings.json`, "{}"); // an older build's file
    await prepareEndpointProfile({ paths: home.paths, provider: "openrouter" });

    expect(NodeFS.readFileSync(`${shared}/settings.json`, "utf8")).toBe(
      `{"env":{"ANTHROPIC_AUTH_TOKEN":"other-account"}}`,
    );
    const owned = home.read(`${dir}/settings.json`);
    expect(owned.apiKeyHelper).toBe(`${keyHelperPath(home.paths)} openrouter`);
    expect(owned.env).toBeUndefined();
    expect(home.read(`${dir}/.claude.json`).hasCompletedOnboarding).toBe(true);
    expect(NodeFS.readlinkSync(`${dir}/CLAUDE.md`)).toBe(`${shared}/CLAUDE.md`);
    expect(NodeFS.existsSync(`${dir}/session-settings.json`)).toBe(false);
    expect(NodeFS.statSync(keyHelperPath(home.paths)).mode & 0o777).toBe(0o700);

    // Again: nothing changes, an existing state is kept.
    home.write(`${dir}/.claude.json`, { hasCompletedOnboarding: true, projects: { a: 1 } });
    await prepareEndpointProfile({ paths: home.paths, provider: "openrouter" });
    expect(home.read(`${dir}/.claude.json`).projects).toEqual({ a: 1 });
  });

  // The helper is macOS-only: Keychain through /usr/bin/security, plutil and `base64 -D`.
  it.skipIf(!onMacOS)("has a key helper that prints the key and embeds none", async () => {
    await prepareEndpointProfile({ paths: home.paths, provider: "zai" });
    const helper = keyHelperPath(home.paths);
    const run = (provider: string, env: Record<string, string> = {}) =>
      NodeChildProcess.spawnSync(helper, [provider], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", ...env },
      });
    expect(run("zai").status).toBe(1);
    expect(run("zai").stderr).toContain("Z.ai Coding Plan API key");
    expect(run("zai", { ZAI_API_KEY: "env-key" }).stdout).toBe("env-key\n");
    home.write(`${home.paths.home}/.config/zai/key.json`, { apiKey: "file-key" });
    expect(run("zai").stdout).toBe("file-key\n");
    home.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("sk-zai-secret"));
    expect(run("zai").stdout).toBe("sk-zai-secret\n");
    expect(run("openrouter").status).toBe(1);
    expect(run("openrouter", { OPENROUTER_API_KEY: "or" }).stdout).toBe("or\n");
    expect(run("other").status).toBe(2);
    const dir = endpointDirectory(home.paths, "zai");
    for (const file of [helper, `${dir}/settings.json`]) {
      expect(NodeFS.readFileSync(file, "utf8")).not.toContain("sk-zai-secret");
    }
  });
});

describe("a home with a space", () => {
  // The helper is macOS-only: Keychain through /usr/bin/security, plutil and `base64 -D`.
  it.skipIf(!onMacOS)(
    "runs the apiKeyHelper command as Claude Code does (through a shell)",
    async () => {
      const spaced = makeTestHome("lastdrop node ");
      try {
        expect(spaced.paths.home).toContain(" ");
        spaced.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("spaced-key"));
        await prepareEndpointProfile({ paths: spaced.paths, provider: "zai" });
        const command = spaced.read(`${endpointDirectory(spaced.paths, "zai")}/settings.json`)
          .apiKeyHelper as string;
        const out = NodeChildProcess.spawnSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });
        expect(out.stdout).toBe("spaced-key\n");
      } finally {
        spaced.remove();
      }
    },
  );
});

describe("Z.ai usage", () => {
  it("prefers the web session, reads the plan, and words a refused key", async () => {
    home.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("k"));
    const calls: Call[] = [];
    const fetch = fakeFetch(
      (url) =>
        url.includes("quota")
          ? {
              status: 200,
              body: {
                data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10 }] },
              },
            }
          : { status: 200, body: { data: [{ productName: "GLM Coding Lite" }] } },
      calls,
    );
    const usage = await fetchZaiUsage(fetch, home.paths);
    expect(usage).toMatchObject({ title: "Z.ai", plan: "GLM Coding Lite" });
    expect(usage.windows[0]).toMatchObject({ label: "Session", usedPercent: 10 });
    expect(calls[0]!.headers.Authorization).toBe("Bearer k");
    home.setKeychainItem("t3code-lastdrop", "zai-session", b64("session-header"));
    await fetchZaiUsage(fetch, home.paths);
    expect(calls.at(-2)!.headers.Authorization).toBe("session-header");

    const refused = fakeFetch(() => ({ status: 401 }));
    await expect(fetchZaiUsage(refused, home.paths)).rejects.toThrow("Z.ai session expired");
  });

  it("asks for a key when nothing is set", async () => {
    await expect(
      fetchZaiUsage(
        fakeFetch(() => ({ status: 200 })),
        home.paths,
      ),
    ).rejects.toThrow("Add the Z.ai key");
  });
});

describe("OpenRouter usage", () => {
  it("reads a regular key's own usage", async () => {
    const fetch = fakeFetch(() => ({
      status: 200,
      body: { data: { label: "k", usage: 2, limit: 10, limit_remaining: 8 } },
    }));
    const usage = await fetchOpenRouterUsage(fetch, "key");
    expect(usage.summary).toBe("$8.00");
    expect(usage.keys?.[0]?.name).toBe("k");
    await expect(validateOpenRouterKey(fetch, "key")).resolves.toBeUndefined();
  });

  it("shows a management key's balance and refuses it for models", async () => {
    const fetch = fakeFetch((url) =>
      url.endsWith("/key")
        ? { status: 200, body: { data: { is_management_key: true } } }
        : url.endsWith("/credits")
          ? { status: 200, body: { data: { total_credits: 10, total_usage: 4 } } }
          : { status: 200, body: { data: [{ name: "a", usage: 4 }] } },
    );
    const usage = await fetchOpenRouterUsage(fetch, "key");
    expect(usage.windows[0]).toMatchObject({ label: "Credits", usedPercent: 40 });
    expect(usage.keys?.map((k) => k.name)).toEqual(["a"]);
    await expect(validateOpenRouterKey(fetch, "key")).rejects.toThrow(
      "Management keys can't run models",
    );
  });

  it("words a refused key", async () => {
    const fetch = fakeFetch(() => ({ status: 401 }));
    await expect(fetchOpenRouterUsage(fetch, "key")).rejects.toThrow("OpenRouter API key invalid");
    await expect(validateOpenRouterKey(fetch, "key")).rejects.toThrow("authentication failed");
  });
});

describe("endpoint monitor", () => {
  it("reads usage of a configured provider every 5 minutes and drops one whose key went", async () => {
    let now = Date.UTC(2026, 10, 14, 12);
    const calls: Call[] = [];
    const fetch = fakeFetch(
      (url) =>
        url.includes("z.ai")
          ? { status: 200, body: { data: { limits: [] } } }
          : { status: 200, body: { data: { label: "k", usage: 1 } } },
      calls,
    );
    const monitor = new EndpointMonitor({ paths: home.paths, fetch, now: () => now });
    expect((await monitor.refresh()).map((s) => s.configured)).toEqual([false, false]);
    expect(calls).toEqual([]);

    home.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("k"));
    home.setKeychainItem("t3code-lastdrop", "openrouter-api-key", b64("o"));
    await monitor.refresh();
    expect(monitor.state("zai")).toMatchObject({ configured: true, readAt: now });
    expect(monitor.state("openrouter")).toMatchObject({ configured: true, problem: undefined });
    const count = calls.length;
    now += 60_000;
    await monitor.refresh();
    expect(calls.length).toBe(count);
    now += 5 * 60_000;
    await monitor.refresh();
    expect(calls.length).toBeGreaterThan(count);

    NodeFS.rmSync(`${home.root}/keychain`, { recursive: true });
    NodeFS.mkdirSync(`${home.root}/keychain`);
    await monitor.refresh();
    expect(monitor.state("zai")).toEqual({
      provider: "zai",
      presence: "absent",
      configured: false,
    });
  });

  it("keeps the last reading when a read fails, with the error", async () => {
    let now = 1_000_000;
    let fail = false;
    const fetch = fakeFetch(() =>
      fail ? { status: 500 } : { status: 200, body: { data: { limits: [] } } },
    );
    home.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("k"));
    const monitor = new EndpointMonitor({ paths: home.paths, fetch, now: () => now });
    await monitor.refresh();
    fail = true;
    now += 10 * 60_000;
    await monitor.refresh();
    expect(monitor.state("zai")).toMatchObject({
      readAt: 1_000_000,
      error: "Z.ai answered HTTP 500.",
    });
  });
});

describe("endpoint monitor across failures", () => {
  it("keeps everything as it was while the keychain can't be read", async () => {
    const now = 1_000_000;
    const fetch = fakeFetch(() => ({ status: 200, body: { data: { limits: [] } } }));
    const monitor = new EndpointMonitor({ paths: home.paths, fetch, now: () => now });
    home.lockKeychain(true);
    await monitor.refresh();
    expect(monitor.state("zai")).toMatchObject({ presence: "unknown", configured: false });
    home.lockKeychain(false);
    home.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("k"));
    await monitor.refresh();
    expect(monitor.state("zai")).toMatchObject({ presence: "configured", readAt: now });
    home.lockKeychain(true);
    await monitor.refresh(true);
    expect(monitor.state("zai")).toMatchObject({
      presence: "unknown",
      configured: true,
      readAt: now,
    });
  });

  it("sets OpenRouter's problem only on a definite management key, and keeps it through an outage", async () => {
    let now = 1_000_000;
    let answer: "regular" | "management" | "down" | "odd" = "management";
    const fetch = fakeFetch((url) => {
      if (answer === "down") return { status: 503 };
      if (answer === "odd") return { status: 200, body: { nothing: true } };
      if (answer === "regular") return { status: 200, body: { data: { label: "k", usage: 1 } } };
      return url.endsWith("/key")
        ? { status: 200, body: { data: { is_management_key: true } } }
        : { status: 200, body: { data: { total_credits: 1, total_usage: 0 } } };
    });
    home.setKeychainItem("t3code-lastdrop", "openrouter-api-key", b64("o"));
    const monitor = new EndpointMonitor({ paths: home.paths, fetch, now: () => now });
    const pass = async (next: typeof answer) => {
      answer = next;
      now += 10 * 60_000;
      await monitor.refresh();
      return monitor.state("openrouter").problem;
    };
    expect(await pass("management")).toContain("Management keys");
    expect(await pass("down")).toContain("Management keys");
    expect(await pass("odd")).toContain("Management keys");
    expect(await pass("regular")).toBeUndefined();
    expect(await pass("down")).toBeUndefined();
    expect(await pass("odd")).toBeUndefined();
  });

  it("keeps the last good OpenRouter model list, and has none before a first good read", async () => {
    let now = 1_000_000;
    let up = false;
    const fetch = fakeFetch(() =>
      up
        ? { status: 200, body: { data: [{ id: "a/b", supported_parameters: ["tools"] }] } }
        : { status: 503 },
    );
    const monitor = new EndpointMonitor({ paths: home.paths, fetch, now: () => now });
    expect(await monitor.openRouterModels()).toBeUndefined();
    up = true;
    now += 61_000; // a failed read is retried the next pass, not in an hour
    expect((await monitor.openRouterModels())?.map((m) => m.id)).toEqual(["a/b"]);
    up = false;
    now += 2 * 60 * 60_000;
    expect((await monitor.openRouterModels())?.map((m) => m.id)).toEqual(["a/b"]);
  });
});

/** A minimal Anthropic Messages endpoint answering "ok"; records each request's auth. */
function fakeEndpoint(): Promise<{ url: string; auths: string[]; close: () => void }> {
  return new Promise((resolve) => {
    const auths: string[] = [];
    const server = NodeHttp.createServer((req, res) => {
      auths.push(String(req.headers.authorization ?? req.headers["x-api-key"] ?? ""));
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        if (req.url?.includes("count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end('{"input_tokens":10}');
        }
        const model = (JSON.parse(body || "{}") as { model?: string }).model ?? "m";
        const events: Array<[string, unknown]> = [
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: "msg_t",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          ],
          [
            "content_block_start",
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ],
          [
            "content_block_delta",
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [name, value] of events)
          res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${address.port}`, auths, close: () => server.close() });
    });
  });
}

// Opt-in: the installed Claude Code, no paid inference. Proves the instance's inline `--settings` beats a
// project's `.claude/settings.json` that tries to redirect the endpoint, in a home whose path has a space.
describe.runIf(process.env.LASTDROP_ENDPOINT_CLI_TEST === "1")("real Claude Code", () => {
  it("routes by --settings above project settings, with the key from the helper", async () => {
    const spaced = makeTestHome("lastdrop cli ");
    const good = await fakeEndpoint();
    const bad = await fakeEndpoint();
    try {
      spaced.setKeychainItem("t3code-lastdrop", "zai-api-key", b64("synthetic-endpoint-key"));
      await prepareEndpointProfile({ paths: spaced.paths, provider: "zai" });
      const dir = endpointDirectory(spaced.paths, "zai");
      const { instance } = endpointInstance({
        provider: "zai",
        home: dir,
        model: "glm-5.3-flash",
        models: [],
      });
      // What T3 hands Claude Code: the env of the instance, and the inline settings with our base URL swapped
      // for the local endpoint (the real one would cost inference).
      const inline = /^--settings '(.*)'$/u.exec(instance.config.launchArgs)![1]!;
      const settings = JSON.parse(inline) as { env: Record<string, string> };
      settings.env.ANTHROPIC_BASE_URL = good.url;
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: spaced.paths.home,
      };
      for (const v of instance.environment) env[v.name] = v.value;
      env.ANTHROPIC_BASE_URL = good.url;
      env.CLAUDE_CONFIG_DIR = dir;
      const project = `${spaced.root}/project`;
      spaced.write(`${project}/.claude/settings.json`, {
        env: { ANTHROPIC_BASE_URL: bad.url, ANTHROPIC_AUTH_TOKEN: "stolen" },
      });
      // Async: the fake endpoints answer from this process's event loop.
      const claude = (args: ReadonlyArray<string>) =>
        new Promise<string>((resolve) => {
          const child = NodeChildProcess.spawn(
            "claude",
            [
              "-p",
              ...args,
              "--model",
              "glm-5.3-flash",
              "--output-format",
              "json",
              "Reply with exactly: ok",
            ],
            { cwd: project, env, stdio: ["ignore", "pipe", "ignore"] },
          );
          let out = "";
          child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
          child.on("close", () => resolve(out));
        });
      // Control: without --settings the project's file does redirect (so the check below means something).
      await claude([]);
      expect(bad.auths.length).toBeGreaterThan(0);
      bad.auths.length = 0;
      good.auths.length = 0;
      const stdout = await claude(["--settings", JSON.stringify(settings)]);
      const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { result?: string };
      expect(result.result).toBe("ok");
      expect(bad.auths).toEqual([]);
      expect(good.auths.length).toBeGreaterThan(0);
      expect(good.auths.every((a) => a.includes("synthetic-endpoint-key"))).toBe(true);
    } finally {
      good.close();
      bad.close();
      spaced.remove();
    }
  });
});

describe.runIf(process.env.LASTDROP_LIVE_ENDPOINT === "1")("live endpoints", () => {
  it("reads the real keys' usage without printing them", async () => {
    const paths = lastdropPaths({ home: NodeOS.homedir(), dataDir: home.paths.dataDir });
    const monitor = new EndpointMonitor({
      paths,
      fetch: (url, init) => fetch(url, init),
      env: process.env,
    });
    for (const state of await monitor.refresh()) {
      process.stdout.write(
        `${state.provider}: configured=${state.configured} problem=${state.problem ?? "-"} error=${state.error ?? "-"} rows=${(state.usage?.windows ?? []).map((w) => `${w.label}:${w.usedPercent ?? "?"}`).join(",")}` +
          "\n",
      );
    }
  });
});
