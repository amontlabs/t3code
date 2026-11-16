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
import { accountsFile, claudeFolder, statusFile } from "./paths.ts";
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
    const config = append(append(emptyConfig(), { provider: "claude", key: "main", addedAt: 0 }), {
      provider: "claude",
      key: "Pro",
      name: "Work",
      addedAt: 0,
    });
    t.write(accountsFile(t.paths), encodeAccountsConfig(config));
    // Claude Code's own login, signed in with a recent reading: never the fork's Main, never read or renewed.
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
      ["main", undefined, undefined, undefined, "signedOut", undefined, undefined, undefined],
      ["Pro", "Work", "pro@example.com", "Pro", "ok", 5, 7, "endpoint"],
    ]);
    expect(view.terminalLogin).toBe(false);
    expect(asked.some((a) => a.startsWith("Bearer tok-max"))).toBe(false);
    const statuses = decodeStatusFile(NodeFS.readFileSync(statusFile(t.paths), "utf8"));
    expect(statuses["main"]?.signIn).toBe("signedOut");
    expect(statuses["Pro"]).toMatchObject({ session: 5, weekly: 7, plan: "Pro", signIn: "ok" });

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
    t.write(accountsFile(t.paths), encodeAccountsConfig(config));
    const monitor = new AccountsMonitor({
      paths: t.paths,
      env: {},
      fetch: () => Promise.reject(new Error("no network")),
      sessionId: "s",
      now: () => at,
    });
    const view = await monitor.view();
    expect(view.accounts.map((a) => [a.key, a.signIn, a.error])).toEqual([
      ["Gone", "signedOut", "Not signed in here."],
    ]);
    // No account can take work: Claude threads run on Claude Code's own login.
    expect(view.terminalLogin).toBe(true);
  });

  it("a never-read account has no read time, and an old usage.json entry shows no windows", async () => {
    t.write(
      accountsFile(t.paths),
      encodeAccountsConfig(append(emptyConfig(), { provider: "claude", key: "Pro", addedAt: 0 })),
    );
    const folder = claudeFolder(t.paths, "Pro")!;
    t.write(`${folder}/.claude.json`, { oauthAccount: { accountUuid: proUUID } });
    t.setKeychain(keychainService(folder), blob(at + 3_600_000));
    const monitor = new AccountsMonitor({
      paths: t.paths,
      env: {},
      fetch: async () => {
        throw new Error("no network");
      },
      sessionId: "s",
      now: () => at,
      renew: async () => false,
    });
    const [main] = (await monitor.view()).accounts;
    expect(main?.readAt).toBeUndefined();
    expect(main?.windows).toEqual([]);
    expect(main?.error).toContain("no network");

    t.write(statusFile(t.paths), {
      Pro: { session: 0, weekly: 34, at: at / 1000 - 3 * 3600, plan: "Max 20x" },
    });
    const later = new AccountsMonitor({
      paths: t.paths,
      env: {},
      fetch: async () => {
        throw new Error("no network");
      },
      sessionId: "s",
      now: () => at,
      renew: async () => false,
    });
    const [old] = (await later.view()).accounts;
    expect(old?.readAt).toBe(at - 3 * 3_600_000);
    expect(old?.windows).toEqual([]);
  });
});
