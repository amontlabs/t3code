// Ported from headroom Tests/LastDropTests/ClaudeUsageCacheTests.swift (the file and fetch cases) and the
// `ClaudeProvider.fetch` assertion of UsageBackoffTests.testOneProcessBlocksTheOthers (see PORTING.md). Every
// file is in a temporary home; the network is a fake.
import { keychainService } from "@t3tools/lastdrop-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ClaudeUsage, type FetchLike, UsageFetchError } from "./claudeUsage.ts";
import { claudeFolder } from "./paths.ts";
import { StatusStore } from "./statusStore.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

const uuid = "12c3cbaa-0000-0000-0000-000000000002";
const other = "614646e1-0000-0000-0000-000000000001";
const now = Date.UTC(2026, 10, 14, 12, 0, 0);

const config = (o: { account?: string; cached?: string; age?: number; session?: number }) => ({
  ...(o.account ? { oauthAccount: { accountUuid: o.account, emailAddress: "a@example.com" } } : {}),
  cachedUsageUtilization: {
    ...(o.cached ? { accountUuid: o.cached } : {}),
    fetchedAtMs: now - (o.age ?? 60_000),
    utilization: {
      five_hour: { utilization: o.session ?? 26, resets_at: "2099-01-01T00:00:00+00:00" },
      seven_day: { utilization: 2, resets_at: "2099-01-02T00:00:00+00:00" },
      cedar_ember: null,
      spend: { enabled: false },
    },
  },
});

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function fakeFetch(
  answers: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const path = new URL(url).pathname + new URL(url).search;
    const answer = answers[path] ?? { status: 404, body: {} };
    const headers = new Map(
      Object.entries({ "content-type": "application/json", ...answer.headers }).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    return {
      status: answer.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => JSON.stringify(answer.body),
    };
  };
  return { fetch, calls };
}

let t: TestHome;
let folder: string;
let statuses: StatusStore;

beforeEach(() => {
  t = makeTestHome();
  folder = claudeFolder(t.paths, "Pro")!;
  statuses = new StatusStore(`${t.paths.dataDir}/usage.json`);
});
afterEach(() => t.remove());

const provider = (fetch: FetchLike, at = now) =>
  new ClaudeUsage({
    paths: t.paths,
    statuses,
    fetch,
    version: async () => "2.1.321",
    sessionId: "0f8e1b9c-3b7e-4c7a-9d0e-111111111111",
    now: () => at,
  });
const offline: FetchLike = () => Promise.reject(new Error("no network in tests"));
const blob = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "tok",
      refreshToken: "r",
      expiresAt,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  });

describe("Claude usage from files", () => {
  it("the provider reads the shared file for its own account", async () => {
    // The folder only says who the account is; the answer is in the file every session shares.
    t.write(`${folder}/.claude.json`, { oauthAccount: { accountUuid: uuid } });
    t.write(t.paths.sharedConfig, config({ account: other, cached: uuid }));
    expect(await provider(offline).cachedUsage("Pro")).toBeDefined();
    // Main signs in in its own folder: Claude Code's own login's answer is never read as Main's.
    t.write(t.paths.sharedConfig, config({ account: other, cached: other }));
    expect(await provider(offline).cachedUsage("main")).toBeUndefined();
    expect(await provider(offline).cachedUsage("Pro")).toBeUndefined();
  });

  it("missing and unreadable files are skipped", async () => {
    t.write(`${folder}/.claude.json`, "not json");
    expect(await provider(offline).cachedUsage("Pro")).toBeUndefined();
    t.write(`${folder}/.claude.json`, config({ account: uuid, cached: uuid }));
    expect(await provider(offline).cachedUsage("Pro")).toBeDefined();
  });

  it("fetch serves the cache without asking, even while blocked", async () => {
    t.write(`${folder}/.claude.json`, { oauthAccount: { accountUuid: uuid } });
    t.write(t.paths.sharedConfig, config({ cached: uuid }));
    const until = now + 3_600_000;
    await statuses.update(
      (all) => (all["Pro"] = { at: now - 60_000, blockedUntil: until, failures: 1 }),
    );
    const snapshot = await provider(offline).fetch("Pro", { lean: true }); // a runner: no keychain, no plan
    expect(snapshot.windows.map((w) => w.usedPercent)).toEqual([26, 2]);
    expect(snapshot.source).toBe("cache");
    // The block is Anthropic's answer to lastdrop: a copy of Claude Code's doesn't end it.
    expect((await statuses.read())["Pro"]?.blockedUntil).toBe(until);
    // Once the copy is gone, the block refuses again, without asking.
    t.write(t.paths.sharedConfig, config({ cached: other }));
    const { fetch, calls } = fakeFetch({});
    await expect(provider(fetch).fetch("Pro", { lean: true })).rejects.toMatchObject({
      kind: "rateLimited",
    });
    expect(calls).toEqual([]);
  });
});

describe("Claude usage from Anthropic", () => {
  const usageAnswer = {
    five_hour: { utilization: 41, resets_at: "2026-11-14T15:00:00+00:00" },
    seven_day: { utilization: 12, resets_at: "2026-11-18T10:00:00+00:00" },
    limits: [
      {
        kind: "weekly_scoped",
        percent: 3,
        resets_at: "2026-11-18T10:00:00+00:00",
        scope: { model: { display_name: "Fable" } },
      },
    ],
  };

  it("asks with Claude Code's headers, then the plan and grants once an hour", async () => {
    t.setKeychain(keychainService(folder), blob(now + 3_600_000));
    const { fetch, calls } = fakeFetch({
      "/api/oauth/usage": { status: 200, body: usageAnswer },
      "/api/oauth/usage?cedar_ember=1&skip_spend=1": {
        status: 200,
        body: {
          cedar_ember: {
            eligible: true,
            grants: [
              {
                id: "launch",
                label: "New model launch: one Fable reset",
                resets_left: 1,
                ends_at: "2027-03-09T07:59:00+00:00",
                clears: ["seven_day_overage_included"],
              },
            ],
          },
        },
      },
      "/api/oauth/profile": { status: 200, body: { organization: { plan_display_name: "Ultra" } } },
    });
    const p = provider(fetch);
    const snapshot = await p.fetch("Pro");
    expect(snapshot.source).toBe("endpoint");
    expect(snapshot.plan).toBe("Ultra");
    expect(snapshot.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["Session", 41],
      ["Weekly", 12],
      ["Fable Weekly", 3],
    ]);
    expect(snapshot.windows[2]!.resets?.count).toBe(1);
    expect(snapshot.resets?.count).toBe(0);
    expect(calls[0]!.headers["User-Agent"]).toBe("claude-cli/2.1.321 (external, cli)");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(calls).toHaveLength(3);
    await p.fetch("Pro");
    expect(calls).toHaveLength(4); // the plan and grants are kept for an hour
  });

  it("one process blocks the others: a 429 is recorded and nobody asks again", async () => {
    t.setKeychain(keychainService(folder), blob(now + 3_600_000));
    const { fetch, calls } = fakeFetch({
      "/api/oauth/usage": { status: 429, body: {}, headers: { "Retry-After": "600" } },
    });
    await expect(provider(fetch).fetch("Pro", { lean: true })).rejects.toMatchObject({
      kind: "rateLimited",
    });
    expect((await statuses.read())["Pro"]).toMatchObject({
      blockedUntil: now + 600_000,
      failures: 1,
    });
    // Another reader (a fresh provider) sees the block and doesn't ask.
    await expect(provider(fetch, now + 60_000).fetch("Pro", { lean: true })).rejects.toBeInstanceOf(
      UsageFetchError,
    );
    expect(calls).toHaveLength(1);
    // Past the block a success clears it.
    const ok = fakeFetch({ "/api/oauth/usage": { status: 200, body: usageAnswer } });
    await provider(ok.fetch, now + 601_000).fetch("Pro", { lean: true });
    expect((await statuses.read())["Pro"]?.blockedUntil).toBeUndefined();
  });

  it("says what only the user can fix", async () => {
    await expect(provider(offline).fetch("Pro")).rejects.toMatchObject({ kind: "notConfigured" });
    // Falls back to the folder's credentials file when the keychain has nothing.
    t.write(`${folder}/.credentials.json`, blob(now - 1000));
    await expect(provider(offline).fetch("Pro")).rejects.toMatchObject({ kind: "unauthorized" });
    t.setKeychain(keychainService(folder), blob(now + 3_600_000));
    const { fetch } = fakeFetch({ "/api/oauth/usage": { status: 401, body: {} } });
    await expect(provider(fetch).fetch("Pro")).rejects.toMatchObject({ kind: "unauthorized" });
    const cloudflare = fakeFetch({
      "/api/oauth/usage": { status: 403, body: {}, headers: { "content-type": "text/html" } },
    });
    await expect(provider(cloudflare.fetch).fetch("Pro")).rejects.toMatchObject({
      kind: "http",
      status: 403,
    });
  });
});
