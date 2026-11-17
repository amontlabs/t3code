/**
 * A lastdrop agent's look (icon, color) and chain, from the `lastdropAgent` field the agents driver
 * puts on each agent's model (`apps/server/src/extensions/lastdrop/agents/catalog.ts`).
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Icons an agent can pick, by id: the lucide icon of that name (`AgentAvatar.tsx`). */
export const LASTDROP_AGENT_ICONS = [
  "bot",
  "eye",
  "hammer",
  "wrench",
  "scale",
  "search",
  "telescope",
  "compass",
  "bug",
  "zap",
  "shield",
  "lock",
  "mouse-pointer",
  "brain",
  "lightbulb",
  "flame",
  "code",
  "terminal",
  "cpu",
  "database",
  "git-branch",
  "layers",
  "file-text",
  "list-checks",
  "book-open",
  "pen-line",
  "flask-conical",
  "rocket",
  "target",
  "gauge",
  "palette",
  "puzzle",
] as const;
export type LastdropAgentIcon = (typeof LASTDROP_AGENT_ICONS)[number];

/** Colors an agent can pick, by id: dark enough under a white icon in both themes. */
export const LASTDROP_AGENT_COLORS = {
  violet: "#7c3aed",
  blue: "#2563eb",
  sky: "#0284c7",
  teal: "#0d9488",
  emerald: "#059669",
  amber: "#d97706",
  orange: "#ea580c",
  red: "#dc2626",
  pink: "#db2777",
  slate: "#475569",
} as const;
export type LastdropAgentColor = keyof typeof LASTDROP_AGENT_COLORS;

const LastdropAgentLookSchema = Schema.Struct({
  icon: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  chain: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      model: Schema.String,
      effort: Schema.optional(Schema.String),
    }),
  ),
  fallbackThreads: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});
const decodeLook = Schema.decodeUnknownOption(LastdropAgentLookSchema);

/** A lastdrop agent's look and chain, from its model in the agents provider's list. */
export interface LastdropAgentLook {
  /** Known ids only: an id a newer client added draws as no pick here. */
  readonly icon: LastdropAgentIcon | null;
  readonly color: string | null;
  readonly chain: ReadonlyArray<{
    readonly instanceId: string;
    readonly model: string;
    readonly effort?: string | undefined;
  }>;
  /** Child threads on an entry past the first: thread id → place in `chain`. */
  readonly fallbackThreads: Readonly<Record<string, number>>;
}

const lookMemo = new WeakMap<object, LastdropAgentLook | null>();

export function lastdropAgentLook(
  model: { readonly lastdropAgent?: unknown } | undefined,
): LastdropAgentLook | null {
  if (model === undefined || model.lastdropAgent == null) return null;
  const raw = model.lastdropAgent;
  if (typeof raw !== "object") return null;
  const cached = lookMemo.get(raw);
  if (cached !== undefined) return cached;
  const look = Option.match(decodeLook(raw), {
    onNone: () => null,
    onSome: (decoded): LastdropAgentLook => ({
      icon: (LASTDROP_AGENT_ICONS as ReadonlyArray<string>).includes(decoded.icon ?? "")
        ? (decoded.icon as LastdropAgentIcon)
        : null,
      color:
        decoded.color !== undefined && Object.hasOwn(LASTDROP_AGENT_COLORS, decoded.color)
          ? LASTDROP_AGENT_COLORS[decoded.color as LastdropAgentColor]
          : null,
      chain: decoded.chain,
      fallbackThreads: decoded.fallbackThreads ?? {},
    }),
  });
  lookMemo.set(raw, look);
  return look;
}

/** The chain entry a child thread runs on: its fallback when listed, else the first. */
export function lastdropAgentRunningEntry(
  look: LastdropAgentLook,
  threadId: string | null | undefined,
): { readonly index: number; readonly entry: LastdropAgentLook["chain"][number] } | null {
  const listed = threadId == null ? undefined : look.fallbackThreads[threadId];
  const index = listed !== undefined && look.chain[listed] !== undefined ? listed : 0;
  const entry = look.chain[index];
  return entry === undefined ? null : { index, entry };
}
