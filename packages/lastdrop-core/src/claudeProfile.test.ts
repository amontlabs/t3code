// Ported from headroom Tests/LastDropTests/ClaudeProfileTests.swift, the key rules (see PORTING.md). The folder
// cases are in @t3tools/lastdrop-node's claudeProfile.test.ts.
import { describe, expect, it } from "vite-plus/test";

import { isOwnKey, mergedProfileConfig, profileOwnState, sameJson } from "./claudeProfile.ts";

const mainUUID = "614646e1-0000-0000-0000-000000000001";
const otherUUID = "12c3cbaa-0000-0000-0000-000000000002";
const usage = (uuid: string, at = 1) => ({ accountUuid: uuid, fetchedAtMs: at });

const mainConfig = (): Record<string, unknown> => ({
  oauthAccount: { accountUuid: mainUUID },
  cachedUsageUtilization: usage(mainUUID),
  modelAccessCache: ["main"],
  userID: "main-device",
  startupPrefetchedAt: 1,
  mcpServers: { t3: { command: "t3" } },
  projects: { "/repo": { hasTrustDialogAccepted: true } },
  hasCompletedOnboarding: true,
  numStartups: 501,
  someKeyFromTheFuture: "shared",
});

const uuidOf = (c: Record<string, unknown>) =>
  (c["oauthAccount"] as { accountUuid?: string } | undefined)?.accountUuid;

describe("Claude profile keys", () => {
  it("caches and account keys are own, everything else is shared", () => {
    // Everything Claude Code 2.1.321 clears when signing out.
    for (const key of [
      "oauthAccount",
      "managedSettingsNoticeSeenOrg",
      "additionalModelOptionsCache",
      "additionalModelOptionsAnsweredAt",
      "additionalModelCostsCache",
      "modelAccessCache",
      "orgModelDefaultCache",
      "cachedArtifactRoster",
      "artifactRosterDenied",
      "lastSeenOrgDefaultUpdatedAt",
      "clientDataCache",
      "clientDataCacheSlots",
      "autoCompactWindowsCache",
      "cachedUsageUtilization",
      "metricsStatusCache",
      "metricsStatusCacheByPrincipal",
      "githubWebConnectionStatusCache",
      "unusedLimitResetStatusCache",
      "startupPrefetchedAt",
    ])
      expect(isOwnKey(key), key).toBe(true);
    for (const key of [
      "cachedExtraUsageDisabledReason",
      "cachedGrowthBookFeatures",
      "passesEligibilityCache",
      "userID",
    ])
      expect(isOwnKey(key), key).toBe(true);
    for (const key of [
      "mcpServers",
      "projects",
      "hasCompletedOnboarding",
      "numStartups",
      "githubRepoPaths",
      "tipsHistory",
      "installMethod",
      "someKeyFromTheFuture",
    ])
      expect(isOwnKey(key), key).toBe(false);
  });

  it("merged is Main's config with the account's own keys", () => {
    const own = {
      oauthAccount: { accountUuid: otherUUID },
      cachedUsageUtilization: usage(otherUUID),
      mcpServers: { stale: {} },
      numStartups: 2,
      onlyInTheAccount: true,
    };
    const config = mergedProfileConfig(mainConfig(), own);
    expect(uuidOf(config)).toBe(otherUUID);
    expect((config["cachedUsageUtilization"] as { accountUuid: string }).accountUuid).toBe(
      otherUUID,
    );
    // Main's own keys never reach the account, even those the account doesn't have.
    expect(config["modelAccessCache"]).toBeUndefined();
    expect(config["userID"]).toBeUndefined();
    expect(config["startupPrefetchedAt"]).toBeUndefined();
    // Shared keys are exactly Main's: a server removed there is gone here too.
    expect(Object.keys(config["mcpServers"] as object)).toEqual(["t3"]);
    expect(config["numStartups"]).toBe(501);
    expect(config["someKeyFromTheFuture"]).toBe("shared");
    expect(config["onlyInTheAccount"]).toBeUndefined();
  });

  it("own state follows the profile until the folder is signed in elsewhere", () => {
    const profile = {
      oauthAccount: { accountUuid: otherUUID },
      cachedUsageUtilization: usage(otherUUID, 9),
    };
    const sameFolder = {
      oauthAccount: { accountUuid: otherUUID },
      cachedUsageUtilization: usage(otherUUID, 1),
    };
    const own = profileOwnState(profile, sameFolder);
    expect((own["cachedUsageUtilization"] as { fetchedAtMs: number }).fetchedAtMs).toBe(9);
    // New profile, or one that never knew its account: the folder's sign-in.
    expect(uuidOf(profileOwnState(undefined, sameFolder))).toBe(otherUUID);
    expect(uuidOf(profileOwnState({}, sameFolder))).toBe(otherUUID);
    // The folder was signed in to another account: the profile's answers are that other account's no more.
    const moved = profileOwnState(profile, { oauthAccount: { accountUuid: "new" } });
    expect(uuidOf(moved)).toBe("new");
    expect(moved["cachedUsageUtilization"]).toBeUndefined();
    // No folder config: the profile stands.
    expect(uuidOf(profileOwnState(profile, undefined))).toBe(otherUUID);
    expect(profileOwnState(undefined, undefined)).toEqual({});
  });

  // Added: Swift compared with NSDictionary.isEqual; the port's comparison ignores key order.
  it("the same config in another layout is the same", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
  });
});
