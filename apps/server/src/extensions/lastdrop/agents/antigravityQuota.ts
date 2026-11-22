/**
 * agy's subscription quota notice, which it sends as the turn's chat message before an error step
 * T3 classes as a plain provider error: "⚠ Individual quota reached. … Resets in 68h47m38s."
 */
import * as DateTime from "effect/DateTime";

const QUOTA_NOTICE = /\bIndividual quota reached\b/;
const RESETS_IN = /\bResets in ((?:\d+[dhms])+)/;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** The notice's reset (ISO, null when it names none), or undefined when the text is no quota notice. */
export const antigravityQuotaReset = (
  text: string,
  now: DateTime.Utc,
): string | null | undefined => {
  if (!QUOTA_NOTICE.test(text)) return undefined;
  const delay = RESETS_IN.exec(text)?.[1];
  if (delay === undefined) return null;
  let ms = 0;
  for (const [, amount, unit] of delay.matchAll(/(\d+)([dhms])/g))
    ms += Number(amount) * UNIT_MS[unit!]!;
  return ms > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: ms })) : null;
};
