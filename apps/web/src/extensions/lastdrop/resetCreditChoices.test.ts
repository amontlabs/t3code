import { UsageLimitSourceId } from "@t3tools/contracts";
import { resetCreditChoices } from "@t3tools/shared/usageLimitsCopy";
import { describe, expect, it } from "vite-plus/test";

// Pins the `usageLimits.ts` seam (FORK.md): a hub's reset credits are offered per kind.
describe("resetCreditChoices", () => {
  it("offers each kind of hub reset apart, spending that kind's own credit", () => {
    const options = [
      { creditId: "weekly-1", label: "Weekly reset", description: "Week.", availableCount: 1 },
      { creditId: "fable-1", label: "Fable reset", description: "Fable.", availableCount: 2 },
    ];
    const choices = resetCreditChoices(
      { availableCount: 3, nextCreditId: "weekly-1", options },
      { sourceId: UsageLimitSourceId.make("hub"), accountId: "a", creditId: "weekly-1" },
      Date.parse("2026-09-03T11:00:00.000Z"),
    );
    expect(choices.map((choice) => [choice.availableCount, choice.input])).toEqual([
      [1, { sourceId: "hub", accountId: "a", creditId: "weekly-1" }],
      [2, { sourceId: "hub", accountId: "a", creditId: "fable-1" }],
    ]);
  });
});
