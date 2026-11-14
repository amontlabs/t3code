// Ported from headroom Tests/LastDropTests ClaudeUsageCacheTests.swift, ClaudeAccountsTests.swift
// (LimitResetsTests, keychain service, headers), ProviderMappingTests.swift (Claude cases) and
// ClaudeKeeperTests.swift (the blob). See PORTING.md.
import { describe, expect, it } from "vite-plus/test";

import {
  claudeCodeOAuthHeaders,
  claudeCodeVersion,
  FALLBACK_CLAUDE_CODE_VERSION,
} from "./claudeCodeHeaders.ts";
import {
  CACHE_FRESH_MS,
  type ResetGrant,
  cachedUsageFromConfig,
  claudeExtraUsage,
  claudeReading,
  claudeWindows,
  isModelOnly,
  isSignedIn,
  keychainService,
  newestCachedUsage,
  parseCredentials,
  placeGrants,
  planDisplayNameFromProfile,
  resetGrants,
  shownPlan,
  signInFacts,
} from "./claudeUsage.ts";
import { planName } from "./planSize.ts";
import { currentResets, type UsageWindow } from "./usage.ts";

const uuid = "12c3cbaa-0000-0000-0000-000000000002";
const other = "614646e1-0000-0000-0000-000000000001";
const now = Date.UTC(2026, 10, 14, 12, 0, 0);

/** A `.claude.json` signed in to `account`, with a cached answer for `cached` fetched `age` ms ago. */
function config(o: {
  account?: string;
  cached?: string | undefined;
  age?: number;
  session?: number;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.account) out["oauthAccount"] = { accountUuid: o.account, emailAddress: "a@example.com" };
  const cache: Record<string, unknown> = {
    fetchedAtMs: now - (o.age ?? 60_000),
    utilization: {
      five_hour: { utilization: o.session ?? 26, resets_at: "2099-01-01T00:00:00+00:00" },
      seven_day: { utilization: 2, resets_at: "2099-01-02T00:00:00+00:00" },
      cedar_ember: null,
      spend: { enabled: false },
    },
  };
  if (o.cached) cache["accountUuid"] = o.cached;
  out["cachedUsageUtilization"] = cache;
  return out;
}

describe("Claude Code's cached usage", () => {
  it("the matching account is read", () => {
    const hit = cachedUsageFromConfig(config({ cached: uuid }), uuid, now)!;
    expect(hit.fetchedAt - now).toBe(-60_000);
    const { windows, credits } = claudeReading(hit.root);
    expect(windows.map((w) => w.label)).toEqual(["Session", "Weekly"]);
    expect(windows.map((w) => w.usedPercent)).toEqual([26, 2]);
    expect(credits).toBeUndefined();
  });

  it("another account's answer is ignored", () => {
    expect(cachedUsageFromConfig(config({ cached: other }), uuid, now)).toBeUndefined();
    // Claude Code may leave the account out: then it's nobody's.
    expect(cachedUsageFromConfig(config({ cached: undefined }), uuid, now)).toBeUndefined();
  });

  it("a stale or future answer is ignored", () => {
    const age = CACHE_FRESH_MS;
    expect(
      cachedUsageFromConfig(config({ cached: uuid, age: age - 30_000 }), uuid, now),
    ).toBeDefined();
    expect(
      cachedUsageFromConfig(config({ cached: uuid, age: age + 1000 }), uuid, now),
    ).toBeUndefined();
    expect(
      cachedUsageFromConfig(config({ cached: uuid, age: -3_600_000 }), uuid, now),
    ).toBeUndefined();
  });

  it("a malformed cache is ignored", () => {
    expect(cachedUsageFromConfig({}, uuid, now)).toBeUndefined();
    const empty = {
      cachedUsageUtilization: { fetchedAtMs: now, accountUuid: uuid, utilization: {} },
    };
    expect(cachedUsageFromConfig(empty, uuid, now)).toBeUndefined();
  });

  it("missing files and an unknown account (parsed configs)", () => {
    // Missing or unreadable files reach this as undefined.
    expect(newestCachedUsage(uuid, [undefined], now)).toBeUndefined();
    expect(newestCachedUsage(uuid, [undefined, "not json"], now)).toBeUndefined();
    expect(newestCachedUsage(uuid, [undefined, config({ cached: uuid })], now)).toBeDefined();
    // An account that isn't signed in has no answer to match.
    expect(newestCachedUsage(undefined, [config({ cached: uuid })], now)).toBeUndefined();
  });

  it("the newest matching file wins", () => {
    const shared = config({ cached: uuid, age: 300_000, session: 10 });
    const own = config({ account: uuid, cached: uuid, age: 30_000, session: 40 });
    let hit = newestCachedUsage(uuid, [shared, own], now)!;
    expect(claudeReading(hit.root).windows[0]!.usedPercent).toBe(40);
    // The shared file now holds another account's answer: the folder's own still serves.
    hit = newestCachedUsage(uuid, [config({ cached: other, age: 5000, session: 99 }), own], now)!;
    expect(claudeReading(hit.root).windows[0]!.usedPercent).toBe(40);
  });

  it("the profile's plan wins over the sign-in's stamp", () => {
    expect(shownPlan("Max 5x", "Pro")).toBe("Max 5x");
    expect(shownPlan("Ultra", "Max 20x")).toBe("Ultra");
    expect(shownPlan(undefined, "Pro")).toBe("Pro");
    expect(shownPlan("Ultra", undefined)).toBe("Ultra");
  });

  it("renewal waits on the stored sign-in", () => {
    const blob = (expiresIn: number | undefined) =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "token",
          subscriptionType: "max",
          ...(expiresIn === undefined ? {} : { expiresAt: now + expiresIn }),
        },
      });
    expect(isSignedIn(undefined, now)).toBe(false);
    expect(isSignedIn("{}", now)).toBe(false);
    expect(isSignedIn(blob(-10_000), now)).toBe(false);
    expect(isSignedIn(blob(30_000), now)).toBe(false); // about to expire
    expect(isSignedIn(blob(8 * 3_600_000), now)).toBe(true);
    expect(isSignedIn(blob(undefined), now)).toBe(true);
  });
});

describe("limit resets", () => {
  const at = 1_793_000_000_000;

  it("Claude reset grants", () => {
    const block = {
      eligible: true,
      next_grant_id: "g1",
      grants: [
        {
          id: "g1",
          resets_left: 2,
          ends_at: "2026-11-05T07:59:00+00:00",
          clears: ["five_hour", "seven_day"],
        },
        { id: "g0", resets_left: 0, ends_at: "2026-11-01T00:00:00+00:00" },
        { id: "old", resets_left: 1, ends_at: "2020-01-01T00:00:00+00:00" },
      ],
    };
    const r = placeGrants(resetGrants(block, at), []).account;
    expect(r?.count).toBe(2);
    expect(r?.expiries.length).toBe(2);
    expect(resetGrants(null, at)).toBeUndefined();
    expect(resetGrants({ eligible: false, grants: block.grants }, at)?.length).toBe(0);
    expect(resetGrants({ eligible: true, grants: [{ id: "x" }] }, at)).toBeUndefined(); // malformed
  });

  it("model-only grants go on their model row (Anthropic's answer of 2026-11-10)", () => {
    const grant = (id: string, label: string, clears: string[]) => ({
      id,
      label,
      resets_total: 1,
      resets_left: 1,
      starts_at: "2026-11-09T18:00:00+00:00",
      ends_at: "2027-03-09T07:59:00+00:00",
      clears,
      usable_now: true,
    });
    const block = {
      eligible: true,
      ineligible_reason: null,
      next_grant_id: "launch-2610-fable",
      grants: [
        grant(
          "launch-2610-fable",
          "New model launch: one Fable reset for Max, Team Premium and Enterprise Premium",
          ["seven_day_overage_included"],
        ),
        grant(
          "launch-2610-fable-6mo",
          "New model launch: one more Fable reset at 6 months' tenure",
          ["seven_day_overage_included"],
        ),
        grant("weekly", "Weekly reset", ["five_hour", "seven_day"]),
      ],
    };
    const grants = resetGrants(block, at);
    expect(grants?.map((g) => g.modelOnly)).toEqual([true, true, false]);
    // Max 5x's Fable grant clears the session as well: still the Fable row's.
    expect(isModelOnly(["five_hour", "seven_day_overage_included"])).toBe(true);
    expect(isModelOnly(["five_hour"])).toBe(false);
    expect(isModelOnly(["seven_day", "seven_day_overage_included"])).toBe(false);
    expect(isModelOnly([])).toBe(false);

    const rows: UsageWindow[] = ["Session", "Weekly", "Sonnet Weekly", "Fable Weekly"].map(
      (label) => ({
        label,
      }),
    );
    const placed = placeGrants(grants, rows);
    expect(placed.account?.count).toBe(1);
    expect(placed.windows.map((w) => w.resets?.count)).toEqual([
      undefined,
      undefined,
      undefined,
      2,
    ]);
    expect(placed.windows[3]!.resets?.expiries.length).toBe(2);

    // A label that names no row: the only model row takes it; with none, the account header does.
    const unnamed: ResetGrant[] = [
      { count: 1, expiries: [], label: "Launch reset", modelOnly: true },
    ];
    const one = placeGrants(unnamed, [{ label: "Weekly" }, { label: "Opus Weekly" }]);
    expect(one.account?.count).toBe(0);
    expect(one.windows[1]!.resets?.count).toBe(1);
    expect(placeGrants(unnamed, [{ label: "Weekly" }]).account?.count).toBe(1);
  });

  it("expired resets drop", () => {
    const r = { count: 3, expiries: [at - 10_000, at + 3_600_000, at + 3_600_000] };
    expect(currentResets(r, at)).toEqual({ count: 2, expiries: [at + 3_600_000, at + 3_600_000] });
  });
});

describe("Claude Code's identity", () => {
  it("the keychain service matches Claude Code", () => {
    expect(keychainService(undefined)).toBe("Claude Code-credentials");
    // sha256("/Users/x/.claude-accounts/Pro")[0..<8], as Claude Code 2.1.310 names it.
    expect(keychainService("/Users/x/.claude-accounts/Pro")).toBe(
      "Claude Code-credentials-71aaf74d",
    );
  });

  it("Claude Code's headers", () => {
    const h = claudeCodeOAuthHeaders("tok", "2.1.321", "0f8e1b9c-3b7e-4c7a-9d0e-111111111111");
    expect(h["User-Agent"]).toBe("claude-cli/2.1.321 (external, cli)");
    expect(h["x-app"]).toBe("cli");
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(h["X-Claude-Code-Session-Id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(claudeCodeVersion("/u/.local/share/claude/versions/2.1.319", ["2.1.321"])).toBe(
      "2.1.319",
    );
    expect(claudeCodeVersion(undefined, ["2.1.9", "2.1.321", "2.1.40", "junk"])).toBe("2.1.321");
    expect(claudeCodeVersion("/opt/claude", [])).toBe(FALLBACK_CLAUDE_CODE_VERSION);
  });

  it("sign-in facts read Claude Code's blob", () => {
    const raw = `{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1800000000000,"refreshTokenExpiresAt":1802000000000,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}`;
    const f = signInFacts(raw);
    expect(f?.expiresAt).toBe(1_800_000_000_000);
    expect(f?.endsAt).toBe(1_802_000_000_000);
    expect(f?.hasRefreshToken).toBe(true);
    expect(f?.plan).toBe("Max 20x");
    // What Claude Code leaves after Anthropic refused the refresh token (invalid_grant).
    const dead = signInFacts(
      `{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"loginEnded":"time_limit"}}`,
    );
    expect(dead?.expiresAt).toBeUndefined();
    expect(dead?.hasRefreshToken).toBe(false);
    expect(dead?.loginEnded).toBe("time_limit");
  });
});

describe("Claude mapping", () => {
  it("Claude windows and plan", () => {
    const root =
      JSON.parse(`{"five_hour":{"utilization":6.0,"resets_at":"2026-10-26T19:59:59.943648+00:00"},
         "seven_day":{"utilization":35,"resets_at":"2026-10-30T10:00:00+00:00"},
         "seven_day_opus":null,"seven_day_sonnet":{"utilization":12.5,"resets_at":null},
         "limits":[{"kind":"weekly_all","percent":35},
                   {"kind":"weekly_scoped","percent":10,"resets_at":"2026-10-28T03:59:59.802507+00:00",
                    "scope":{"model":{"id":null,"display_name":"Fable"}}}]}`);
    const w = claudeWindows(root);
    expect(w.map((x) => x.label)).toEqual(["Session", "Weekly", "Fable Weekly", "Sonnet Weekly"]);
    expect(w[2]!.usedPercent).toBe(10);
    expect(w[2]!.resetsAt).toBeDefined();
    expect(w[0]!.usedPercent).toBe(6);
    expect(Math.abs(w[0]!.resetsAt! - 1_793_044_799_943)).toBeLessThan(10);
    expect(w[3]!.resetsAt).toBeUndefined();

    expect(planName("max", "default_claude_max_20x")).toBe("Max 20x");
    expect(planName("pro", "default_claude_ai")).toBe("Pro");
    const creds = parseCredentials(
      `{"claudeAiOauth":{"accessToken":"t","expiresAt":1793044799000,"subscriptionType":"max"}}`,
    );
    expect(creds?.accessToken).toBe("t");
    expect(creds?.plan).toBe("Max");
    expect(parseCredentials("{}")).toBeUndefined();

    expect(
      planDisplayNameFromProfile({
        organization: { plan_display_name: "Ultra", rate_limit_tier: "default_claude_max_20x" },
      }),
    ).toBe("Ultra");
    expect(
      planDisplayNameFromProfile({ organization: { plan_display_name: " " } }),
    ).toBeUndefined();
    expect(planDisplayNameFromProfile({})).toBeUndefined();
    // No display name (seen on an upgraded Max 5x account): the type and tier say it.
    expect(
      planDisplayNameFromProfile({
        organization: {
          plan_display_name: null,
          organization_type: "claude_max",
          rate_limit_tier: "default_claude_max_5x",
        },
      }),
    ).toBe("Max 5x");
  });

  it("Claude extra usage only when enabled", () => {
    expect(
      claudeExtraUsage(
        { spend: { enabled: false, used: { amount_minor: 0, currency: "USD", exponent: 2 } } },
        true,
      ),
    ).toBeUndefined();
    const on = claudeExtraUsage(
      {
        spend: {
          enabled: true,
          used: { amount_minor: 1240, currency: "USD", exponent: 2 },
          limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
        },
      },
      true,
    );
    expect(on?.amount).toBe("$12.40 of $50.00");
    expect(on?.inUse).toBe(true);
  });
});
