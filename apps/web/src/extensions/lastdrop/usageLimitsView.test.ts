import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { limitGroups, limitsSummary, shortPlan } from "./usageLimitsView";

const NOW = Date.UTC(2026, 10, 15, 12);
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

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

describe("the usage limits list", () => {
  it("lists each account apart with its windows, lastdrop's names and badges, and accounts without a reading last", () => {
    const groups = limitGroups({
      presentations: presentations([
        reading("claude-2", "b@example.com", [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 25,
            resetsAt: "2026-11-15T14:30:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 60,
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
        reading(
          "codex-c1",
          "c@example.com",
          [{ id: "primary", kind: "session", label: "Session", usedPercent: 20 }],
          codex,
        ),
        reading("codex-c2", undefined, [], codex),
      ]),
      now: NOW,
      driverLabel: () => undefined,
      lastdrop: [
        {
          key: "claude-2",
          name: "Work",
          email: "B@example.com",
          signIn: "ok",
          signInEndsSoon: false,
          nextFor: ["Threads", "Subagents"],
        },
      ],
      lastdropCodex: [
        { key: "c1", title: "Personal", email: "C@example.com" },
        { key: "c2", title: "Team" },
      ],
    });
    expect(groups.map((group) => group.label)).toEqual(["claudeAgent", "codex", "Z.ai"]);
    // Codex rows take the fork account's name, signed in (by e-mail) or not (by its row id).
    expect(groups[1]?.entries.map((entry) => [entry.name, entry.detail])).toEqual([
      ["Personal", "c@example.com"],
      ["Team", undefined],
    ]);
    const [claudeGroup] = groups;
    expect(claudeGroup?.entries.map((entry) => entry.name)).toEqual([
      "a@example.com",
      "Work",
      "claude-3",
    ]);
    const work = claudeGroup?.entries[1];
    expect(work?.detail).toBe("b@example.com");
    expect(work?.nextFor).toEqual(["Threads", "Subagents"]);
    expect(work?.main).toEqual([
      { id: "five_hour", label: "Session", leftPercent: 10, resets: null },
      { id: "seven_day", label: "Weekly", leftPercent: 75, resets: "Resets in 2h 30m" },
    ]);
    // The model's week resets with the week: its line doesn't repeat it.
    expect(work?.more).toEqual([
      { id: "seven_day_fable", label: "Weekly · Fable", leftPercent: 40, resets: null },
    ]);
    expect(claudeGroup?.entries[2]?.notice).toBe("Needs sign-in.");
    expect(limitsSummary(groups)).toBe(
      "claudeAgent: a@example.com: Weekly 50% left; Work (next for Threads, Subagents): Session 10% left, " +
        "Weekly 75% left, Weekly · Fable 40% left; claude-3: Needs sign-in. codex: Personal: Session 80% left; " +
        "Team: Needs sign-in. Z.ai: Z.ai: Session 96% left.",
    );
    expect(limitsSummary([])).toBe("No account reports limits yet.");
  });

  it("an enabled provider that reads limits but shows none says why", () => {
    const provider = (driver: string, auth: Partial<ServerProvider["auth"]>) =>
      ({
        instanceId: ProviderInstanceId.make(driver),
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated", ...auth },
      }) as ServerProvider;
    const groups = limitGroups({
      presentations: new Map([
        [
          EnvironmentId.make("local"),
          {
            entry: { target: { label: "This Mac" } },
            serverConfig: {
              providers: [
                provider("antigravity", { status: "unauthenticated" }),
                // Signed in, but its limits were never read.
                provider("claudeAgent", { email: "a@example.com" }),
              ],
            },
          },
        ],
      ]),
      now: NOW,
      driverLabel: (driver) => (driver === "antigravity" ? "Antigravity" : undefined),
    });
    expect(
      groups.map((group) => [group.label, group.entries.map((entry) => entry.notice)]),
    ).toEqual([
      ["claudeAgent", ["No limits read yet."]],
      ["Antigravity", ["Signed out."]],
    ]);
  });

  it("shortens plan names", () => {
    expect(shortPlan("Claude Ultra Subscription")).toBe("Ultra");
    expect(shortPlan("ChatGPT Plus Subscription")).toBe("Plus");
    expect(shortPlan("GLM Coding Pro")).toBe("GLM Coding Pro");
    expect(shortPlan(undefined)).toBeUndefined();
  });
});
