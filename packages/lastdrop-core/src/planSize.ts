/**
 * How big a Claude plan's limits are, in Pro's: Max 20x has twenty times Pro's 5-hour window but ten times
 * its week. Ultra has no 5-hour window at all; its size there only matters for a thread's room.
 *
 * Port of headroom's `PlanSize` (SessionLedger.swift) and `ClaudeProvider.planName`.
 */
export interface PlanSize {
  readonly session: number;
  readonly weekly: number;
}

export const PRO_SIZE: PlanSize = { session: 1, weekly: 1 };

/**
 * From the plan name lastdrop shows: claude.ai's current names ("Pro", "Max", "Ultra"), or Claude Code's
 * older ones when the profile can't be read ("Max 5x", "Max 20x"). Unknown plans count as Pro.
 */
export function planSize(plan: string | undefined): PlanSize {
  switch (plan?.toLowerCase().replaceAll(" ", "")) {
    case "ultra":
    case "max20x":
      return { session: 20, weekly: 10 };
    case "max5x":
    case "max":
      return { session: 5, weekly: 5 };
    default:
      return PRO_SIZE;
  }
}

/**
 * The plan's name from a sign-in, when the profile can't be read: "max" + "default_claude_max_20x" →
 * "Max 20x"; "pro" → "Pro". Claude Code stamps these at sign-in and never updates them after an upgrade,
 * so the profile's plan wins when there is one.
 */
export function planName(type: string | undefined, tier: string | undefined): string | undefined {
  const trimmed = type?.trim();
  if (!trimmed) return undefined;
  const name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const size = tier?.match(/\d+x$/u)?.[0];
  return size ? `${name} ${size}` : name;
}
