/**
 * lastdrop's provider client definitions (label, icon, settings schema), shared by web and mobile.
 * `providerClients.ts` spreads this list after T3's own; see FORK.md. Keep in step with
 * `EXTENSION_PROVIDER_CLIENTS` in `apps/server/src/extensions/clients.ts` (the agents driver's
 * `settings.ts`).
 */
import {
  makeProviderSettingsSchema,
  ProviderDriverKind,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { defineProviderClient, type ProviderClientDefinition } from "@t3tools/provider-core/client";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EnvironmentThreadState } from "./state/threadState.ts";

/** The user's agents (driver `lastdropAgents`): Claude's models and the standalone app's agents. */
const lastdropAgentsClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("lastdropAgents"),
  label: "lastdrop agents",
  featured: false,
  settingsSchema: makeProviderSettingsSchema({
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  }),
  // lastdrop's drop (headroom `website/favicon.svg`); the wave is cut out with an even-odd band.
  icon: {
    viewBox: "20 12 60 76",
    fill: { light: "#2b6fe6", dark: "#8fd0ff" },
    paths: [
      {
        d: "M50 16 C50 16 26 44 26 61 A24 24 0 0 0 74 61 C74 44 50 16 50 16 Z M26.4 54.28 C34.93 52.38 43.47 60.37 52 55.25 C59.78 50.58 66.35 55.6 73.6 55.23 L73.6 60.73 C66.35 61.1 59.78 56.08 52 60.75 C43.47 65.87 34.93 57.88 26.4 59.78 Z",
        fillRule: "evenodd",
        gradient: {
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 1,
          stops: [
            { offset: 0, color: "#8fd0ff" },
            { offset: 1, color: "#2b6fe6" },
          ],
        },
      },
    ],
  },
});

export const extensionProviderClients: ReadonlyArray<ProviderClientDefinition> = [
  lastdropAgentsClient,
];

/**
 * A lastdrop agent under the fork's runner shows up twice under its parent: Claude Code's own
 * subagent, whose turn the plugin takes over (only a progress thinking block), and the
 * `lastdropAgents` delegated task that does the work. Readers see only the delegated one.
 * The runner's request key `lastdrop-runner:<Claude agent id>` ends the delegated ids.
 */
function decodedId(id: string): string {
  let decoded = id;
  for (let pass = 0; pass < 3 && decoded.includes("%"); pass++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  return decoded;
}

function lastdropRunAgentId(id: string): string | null {
  if (!id.includes("lastdrop-runner")) return null;
  return /:delegate-task:lastdrop-runner:([^:]+)$/u.exec(decodedId(id))?.[1] ?? null;
}

const shadowSubagentIdsMemo = new WeakMap<
  OrchestrationV2ThreadProjection["subagents"],
  ReadonlySet<string>
>();
const filteredMemo = new WeakMap<object, readonly [ReadonlySet<string>, unknown]>();

function shadowSubagentIds(subagents: OrchestrationV2ThreadProjection["subagents"]) {
  let hidden = shadowSubagentIdsMemo.get(subagents);
  if (hidden === undefined) {
    const runs = new Set<string>();
    for (const subagent of subagents) {
      const agentId = lastdropRunAgentId(subagent.id);
      if (agentId !== null) runs.add(agentId);
    }
    hidden = new Set(
      runs.size === 0
        ? []
        : subagents.flatMap((subagent) =>
            subagent.origin === "provider_native" &&
            runs.has(subagent.nativeTaskRef?.nativeId ?? "")
              ? [subagent.id]
              : [],
          ),
    );
    shadowSubagentIdsMemo.set(subagents, hidden);
  }
  return hidden;
}

// Keeps each filtered array's identity while its source and the hidden set hold.
function filterOnce<T>(
  rows: ReadonlyArray<T>,
  hidden: ReadonlySet<string>,
  keep: (row: T) => boolean,
): ReadonlyArray<T> {
  const cached = filteredMemo.get(rows);
  if (cached !== undefined && cached[0] === hidden) return cached[1] as ReadonlyArray<T>;
  const kept = rows.filter(keep);
  const result = kept.length === rows.length ? rows : kept;
  filteredMemo.set(rows, [hidden, result]);
  return result;
}

export function withoutLastdropShadowSubagents(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const hidden = shadowSubagentIds(projection.subagents);
  if (hidden.size === 0) return projection;
  const shown = (item: { readonly type: string; readonly subagentId?: unknown }) =>
    item.type !== "subagent" || !hidden.has(String(item.subagentId));
  return {
    ...projection,
    subagents: filterOnce(projection.subagents, hidden, (subagent) => !hidden.has(subagent.id)),
    turnItems: filterOnce(projection.turnItems, hidden, shown),
    visibleTurnItems: filterOnce(projection.visibleTurnItems, hidden, (row) => shown(row.item)),
  };
}

const shadowThreadsMemo = new WeakMap<object, unknown>();

export function withoutLastdropShadowThreads<
  T extends {
    readonly id: string;
    readonly lineage: {
      readonly parentThreadId: string | null;
      readonly relationshipToParent?: string | null | undefined;
    };
  },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  const cached = shadowThreadsMemo.get(threads);
  if (cached !== undefined) return cached as ReadonlyArray<T>;
  const runsByParent = new Map<string, Set<string>>();
  for (const thread of threads) {
    const parent = thread.lineage.parentThreadId;
    const agentId = parent === null ? null : lastdropRunAgentId(thread.id);
    if (parent === null || agentId === null) continue;
    const runs = runsByParent.get(parent) ?? new Set<string>();
    runs.add(agentId);
    runsByParent.set(parent, runs);
  }
  const result =
    runsByParent.size === 0
      ? threads
      : threads.filter((thread) => {
          const runs =
            thread.lineage.relationshipToParent === "subagent" &&
            thread.lineage.parentThreadId !== null
              ? runsByParent.get(thread.lineage.parentThreadId)
              : undefined;
          if (runs === undefined || !thread.id.startsWith("thread:provider:")) return true;
          const agentId = decodedId(thread.id).split(":").at(-1);
          return agentId === undefined || !runs.has(agentId);
        });
  shadowThreadsMemo.set(threads, result);
  return result;
}

const shadowStateMemo = new WeakMap<EnvironmentThreadState, EnvironmentThreadState>();

export function withoutLastdropShadowState(state: EnvironmentThreadState): EnvironmentThreadState {
  if (Option.isNone(state.data)) return state;
  const cached = shadowStateMemo.get(state);
  if (cached !== undefined) return cached;
  const projection = withoutLastdropShadowSubagents(state.data.value);
  const result =
    projection === state.data.value ? state : { ...state, data: Option.some(projection) };
  shadowStateMemo.set(state, result);
  return result;
}
