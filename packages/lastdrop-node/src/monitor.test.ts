// Added (no single Swift test): the app's refresh loop as the fork runs it, in a temporary home with a fake
// `security` and a fake network.
import {
  decodeStatusFile,
  encodeAccountsConfig,
  keychainService,
  append,
  emptyConfig,
} from "@t3tools/lastdrop-core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";

import type { FetchLike } from "./claudeUsage.ts";
import { AccountsMonitor, USAGE_REFRESH_MS } from "./monitor.ts";
import { accountsFiles, claudeFolder, statusFile } from "./paths.ts";
import {
  standaloneAppRunning,
  standaloneHeartbeatFile,
  standaloneStatusFile,
} from "./standalone.ts";
import { makeTestHome, type TestHome } from "./testHome.ts";

const mainUUID = "614646e1-0000-0000-0000-000000000001";
const proUUID = "12c3cbaa-0000-0000-0000-000000000002";
let t: TestHome;
let at = Date.UTC(2026, 10, 14, 12, 0, 0);

beforeEach(() => {
  t = makeTestHome();
  at = Date.UTC(2026, 10, 14, 12, 0, 0);
});
afterEach(() => t.remove());

const blob = (expiresAt: number, plan = "max") =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `tok-${plan}`,
      refreshToken: "r",
      expiresAt,
      subscriptionType: plan,
      rateLimitTier: plan === "max" ? "default_claude_max_20x" : "default_claude_ai",
    },
  });

describe("the accounts monitor", () => {
  it("reads every account's sign-in and usage, and keeps the status file", async () => {
    const config = append(emptyConfig(), {
      provider: "claude",
      key: "Pro",
      name: "Work",
      addedAt: 0,
    });
    t.write(accountsFiles(t.paths).accounts, encodeAccountsConfig(config));
    // Main: signed in, with Claude Code's own recent reading.
    t.setKeychain("Claude Code-credentials", blob(at + 3_600_000));
    t.write(t.paths.sharedConfig, {
      oauthAccount: { accountUuid: mainUUID, emailAddress: "main@example.com" },
      cachedUsageUtilization: {
        accountUuid: mainUUID,
        fetchedAtMs: at - 60_000,
        utilization: {
          five_hour: { utilization: 30, resets_at: "2026-11-14T15:00:00+00:00" },
          seven_day: { utilization: 40, resets_at: "2026-11-18T10:00:00+00:00" },
          cedar_ember: null,
        },
      },
    });
    // Pro: signed in, read from Anthropic.
    const folder = claudeFolder(t.paths, "Pro")!;
    t.write(`${folder}/.claude.json`, {
      oauthAccount: { accountUuid: proUUID, emailAddress: "pro@example.com" },
    });
    t.setKeychain(keychainService(folder), blob(at + 3_600_000, "pro"));
    const asked: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      asked.push(`${init.headers["Authorization"]} ${new URL(url).pathname}${new URL(url).search}`);
      const body = url.endsWith("/profile")
        ? {
            organization: {
              plan_display_name: init.headers["Authorization"]?.endsWith("max") ? "Ultra" : "Pro",
            },
          }
        : url.includes("cedar_ember")
          ? { cedar_ember: null }
          : {
              five_hour: { utilization: 5, resets_at: "2026-11-14T16:00:00+00:00" },
              seven_day: { utilization: 7, resets_at: "2026-11-19T10:00:00+00:00" },
            };
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify(body),
      };
    };
    const monitor = new AccountsMonitor({
      paths: t.paths,
      env: {},
      fetch,
      sessionId: "s",
      now: () => at,
      renew: async () => false,
    });

    const view = await monitor.view();
    expect(
      view.accounts.map((a) => [
        a.key,
        a.name,
        a.email,
        a.plan,
        a.signIn,
        a.session,
        a.weekly,
        a.source,
      ]),
    ).toEqual([
      ["main", undefined, "main@example.com", "Ultra", "ok", 30, 40, "cache"],
      ["Pro", "Work", "pro@example.com", "Pro", "ok", 5, 7, "endpoint"],
    ]);
    // Main's reading came from Claude Code's copy; only its plan and grants were asked for.
    expect(asked.filter((a) => a.startsWith("Bearer tok-max")).map((a) => a.split(" ")[2])).toEqual(
      ["/api/oauth/usage?cedar_ember=1&skip_spend=1", "/api/oauth/profile"],
    );
    const statuses = decodeStatusFile(NodeFS.readFileSync(statusFile(t.paths), "utf8"));
    expect(statuses["main"]).toMatchObject({
      session: 30,
      weekly: 40,
      plan: "Ultra",
      signIn: "ok",
    });
    expect(statuses["Pro"]).toMatchObject({ session: 5, weekly: 7, plan: "Pro", signIn: "ok" });
    // The standalone lastdrop's files are only read.
    expect(NodeFS.readdirSync(`${t.paths.swiftSupport}`)).toEqual(["accounts.json"]);

    // Within five minutes nothing is asked again; after, it is.
    const before = asked.length;
    at += 60_000;
    await monitor.tick();
    expect(asked.length).toBe(before);
    at += USAGE_REFRESH_MS;
    await monitor.tick();
    expect(asked.length).toBe(before + 1); // Pro's usage; the plan and grants are kept for an hour
  });

  it("an account without a sign-in says so and isn't read", async () => {
    const config = append(emptyConfig(), { provider: "claude", key: "Gone", addedAt: 0 });
    t.write(accountsFiles(t.paths).accounts, encodeAccountsConfig(config));
    const monitor = new AccountsMonitor({
      paths: t.paths,
      env: {},
      fetch: () => Promise.reject(new Error("no network")),
      sessionId: "s",
      now: () => at,
    });
    const view = await monitor.view();
    expect(view.accounts.map((a) => [a.key, a.signIn, a.error])).toEqual([
      ["main", "signedOut", "Run `claude` to sign in."],
      ["Gone", "signedOut", "Run `claude` to sign in."],
    ]);
  });

  it("while the standalone app runs, the fork reads its usage.json and asks nobody", async () => {
    const config = append(emptyConfig(), { provider: "claude", key: "Pro", addedAt: 0 });
    t.write(accountsFiles(t.paths).accounts, encodeAccountsConfig(config));
    t.write(t.paths.sharedConfig, { oauthAccount: { accountUuid: mainUUID } });
    // The app's own file, in its format (seconds).
    t.write(standaloneStatusFile(t.paths), {
      main: { session: 12, weekly: 34, at: at / 1000 - 60, plan: "Ultra", signIn: "ok" },
      Pro: { session: 50, weekly: 60, at: at / 1000 - 60, signIn: "needsSignIn" },
    });
    const asked: string[] = [];
    const renewed: string[] = [];
    const monitor = new AccountsMonitor({
      paths: t.paths,
      env: {},
      fetch: async (url) => {
        asked.push(url);
        throw new Error("no network");
      },
      sessionId: "s",
      now: () => at,
      renew: async (key) => {
        renewed.push(key);
        return true;
      },
      standaloneRunning: async () => true,
    });
    const view = await monitor.view();
    expect(view.readBy).toBe("standalone");
    expect(view.accounts.map((a) => [a.key, a.session, a.weekly, a.signIn, a.source])).toEqual([
      ["main", 12, 34, "ok", "standalone"],
      ["Pro", 50, 60, "needsSignIn", "standalone"],
    ]);
    expect((await monitor.routingStatuses())["main"]?.session).toBe(12);
    expect(asked).toEqual([]);
    expect(renewed).toEqual([]);
    // Nothing of the fork's own was written, and the app's file is only read.
    expect(NodeFS.existsSync(statusFile(t.paths))).toBe(false);
  });

  it("the standalone app counts as running while its heartbeat is under a minute old", async () => {
    expect(await standaloneAppRunning(t.paths, at)).toBe(false);
    t.write(standaloneHeartbeatFile(t.paths), "");
    NodeFS.utimesSync(standaloneHeartbeatFile(t.paths), at / 1000 - 30, at / 1000 - 30);
    expect(await standaloneAppRunning(t.paths, at)).toBe(true);
    expect(await standaloneAppRunning(t.paths, at + 31_000)).toBe(false);
  });
});
