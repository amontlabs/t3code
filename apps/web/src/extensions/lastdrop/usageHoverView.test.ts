import {
  EnvironmentId,
  ProviderDriverKind,
  UsageLimitSourceId,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { usageHoverGroups, usageHoverSummary } from "./usageHoverView";

const NOW = Date.UTC(2026, 10, 15, 12);
const claude = ProviderDriverKind.make("claudeAgent");

const reading = (
  id: string,
  email: string | undefined,
  windows: UsageLimitSourceAccount["usageLimits"]["windows"],
  driver = claude,
): UsageLimitSourceAccount => ({
  id,
  driver,
  ...(email ? { email } : {}),
  usageLimits:
    windows.length > 0
      ? { checkedAt: "2026-11-15T11:59:00.000Z", windows }
      : {
          checkedAt: "2026-11-15T11:59:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "Needs sign-in." },
        },
});

const presentations = (accounts: UsageLimitSourceAccount[]): LimitPresentations =>
  new Map([
    [
      EnvironmentId.make("local"),
      {
        entry: { target: { label: "This Mac" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("lastdrop"),
              kind: "cliproxy",
              label: "lastdrop",
              checkedAt: "2026-11-15T12:00:00.000Z",
              accounts,
            },
          ],
        },
      },
    ],
  ]);

describe("the usage hover", () => {
  it("lists each Claude account with its windows, then Z.ai, and accounts without a reading last", () => {
    const groups = usageHoverGroups(
      presentations([
        reading("claude-2", "b@example.com", [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 25,
            resetsAt: "2026-11-15T14:30:00.000Z",
          },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 90 },
        ]),
        reading("main", "a@example.com", [
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 50 },
        ]),
        reading("claude-3", undefined, []),
        reading(
          "Z.ai",
          undefined,
          [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 4 }],
          ProviderDriverKind.make("Zai"),
        ),
      ]),
      NOW,
      () => undefined,
    );
    expect(groups.map((group) => group.label)).toEqual(["claudeAgent", "Z.ai"]);
    const [first] = groups;
    expect(first?.accounts.map((account) => account.name)).toEqual([
      "a@example.com",
      "b@example.com",
      "claude-3",
    ]);
    expect(first?.accounts[1]?.windows).toEqual([
      { id: "five_hour", label: "Session", leftPercent: 10, resets: null },
      { id: "seven_day", label: "Weekly", leftPercent: 75, resets: "resets in 2h 30m" },
    ]);
    expect(first?.accounts[2]?.notice).toBe("Needs sign-in.");
    expect(usageHoverSummary(groups)).toBe(
      "claudeAgent: a@example.com: Weekly 50% left; b@example.com: Session 10% left, Weekly 75% left; " +
        "claude-3: Needs sign-in. Z.ai: Z.ai: Session 96% left.",
    );
    expect(usageHoverSummary([])).toBe("No account reports limits yet.");
  });
});
