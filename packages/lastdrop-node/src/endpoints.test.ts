// Ported from headroom Tests/LastDropTests/EndpointBackendTests.swift (profile, key helper, live) and the Z.ai
// and OpenRouter usage readers. A temporary home and a fake `security`; nothing real is read or written.
// The live check is opt-in: LASTDROP_LIVE_ENDPOINT=1 reads the real keys and asks the real endpoints.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { endpointEnvironment } from "@t3tools/lastdrop-core";

import type { FetchLike } from "./claudeUsage.ts";
import {
  endpointApiKey,
  endpointDirectory,
  endpointSessionSettings,
  EndpointMonitor,
  fetchOpenRouterUsage,
  fetchZaiUsage,
  keyHelperPath,
  prepareEndpointProfile,
  validateOpenRouterKey,
} from "./endpoints.ts";
import { lastdropPaths } from "./paths.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

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
  it("reads lastdrop's own item, then its old name, then the standalone's fallbacks", async () => {
    expect(await endpointApiKey("zai", home.paths)).toBeUndefined();
    expect(await endpointApiKey("zai", home.paths, { GLM_API_KEY: " env-key " })).toBe("env-key");
    home.write(`${home.paths.home}/.config/zai/key.json`, { api_key: "file-key" });
    expect(await endpointApiKey("zai", home.paths, { ZAI_API_KEY: "env" })).toBe("file-key");
    home.setKeychainItem("Headroom", "zai-api-key", b64("old-key"));
    expect(await endpointApiKey("zai", home.paths)).toBe("old-key");
    home.setKeychainItem("lastdrop", "zai-api-key", b64("own-key"));
    expect(await endpointApiKey("zai", home.paths)).toBe("own-key");

    expect(await endpointApiKey("openrouter", home.paths, { ZAI_API_KEY: "x" })).toBeUndefined();
    expect(await endpointApiKey("openrouter", home.paths, { OPENROUTER_API_KEY: "or-env" })).toBe(
      "or-env",
    );
    home.setKeychainItem("lastdrop", "openrouter-api-key", b64("or-own"));
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
    const environment = endpointEnvironment({ provider: "openrouter", model: "provider/model" });
    await prepareEndpointProfile({ paths: home.paths, provider: "openrouter", environment });

    expect(NodeFS.readFileSync(`${shared}/settings.json`, "utf8")).toBe(
      `{"env":{"ANTHROPIC_AUTH_TOKEN":"other-account"}}`,
    );
    const owned = home.read(`${dir}/settings.json`);
    expect(owned.apiKeyHelper).toBe(`${keyHelperPath(home.paths)} openrouter`);
    expect(owned.env).toBeUndefined();
    expect(home.read(`${dir}/.claude.json`).hasCompletedOnboarding).toBe(true);
    expect(NodeFS.readlinkSync(`${dir}/CLAUDE.md`)).toBe(`${shared}/CLAUDE.md`);
    const session = home.read(endpointSessionSettings(home.paths, "openrouter"));
    expect(session).toEqual({ env: environment });
    expect(JSON.stringify(session)).not.toContain("other-account");
    expect(NodeFS.statSync(keyHelperPath(home.paths)).mode & 0o777).toBe(0o700);

    // Again: nothing changes, an existing state is kept.
    home.write(`${dir}/.claude.json`, { hasCompletedOnboarding: true, projects: { a: 1 } });
    await prepareEndpointProfile({ paths: home.paths, provider: "openrouter", environment });
    expect(home.read(`${dir}/.claude.json`).projects).toEqual({ a: 1 });
  });

  it("has a key helper that prints the key and embeds none", async () => {
    await prepareEndpointProfile({
      paths: home.paths,
      provider: "zai",
      environment: endpointEnvironment({ provider: "zai", model: "glm-5.3" }),
    });
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
    home.setKeychainItem("lastdrop", "zai-api-key", b64("sk-zai-secret"));
    expect(run("zai").stdout).toBe("sk-zai-secret\n");
    expect(run("openrouter").status).toBe(1);
    expect(run("openrouter", { OPENROUTER_API_KEY: "or" }).stdout).toBe("or\n");
    expect(run("other").status).toBe(2);
    const dir = endpointDirectory(home.paths, "zai");
    for (const file of [
      helper,
      `${dir}/settings.json`,
      endpointSessionSettings(home.paths, "zai"),
    ]) {
      expect(NodeFS.readFileSync(file, "utf8")).not.toContain("sk-zai-secret");
    }
  });
});

describe("Z.ai usage", () => {
  it("prefers the web session, reads the plan, and words a refused key", async () => {
    home.setKeychainItem("lastdrop", "zai-api-key", b64("k"));
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
    home.setKeychainItem("lastdrop", "zai-session", b64("session-header"));
    await fetchZaiUsage(fetch, home.paths);
    expect(calls.at(-2)!.headers.Authorization).toBe("session-header");

    const refused = fakeFetch(() => ({ status: 401 }));
    await expect(fetchZaiUsage(refused, home.paths)).rejects.toThrow("Z.ai session expired");
  });

  it("asks for a sign-in when nothing is set", async () => {
    await expect(
      fetchZaiUsage(
        fakeFetch(() => ({ status: 200 })),
        home.paths,
      ),
    ).rejects.toThrow("Sign in to Z.ai");
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

    home.setKeychainItem("lastdrop", "zai-api-key", b64("k"));
    home.setKeychainItem("lastdrop", "openrouter-api-key", b64("o"));
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
    expect(monitor.state("zai")).toEqual({ provider: "zai", configured: false });
  });

  it("keeps the last reading when a read fails, with the error", async () => {
    let now = 1_000_000;
    let fail = false;
    const fetch = fakeFetch(() =>
      fail ? { status: 500 } : { status: 200, body: { data: { limits: [] } } },
    );
    home.setKeychainItem("lastdrop", "zai-api-key", b64("k"));
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
