/**
 * The lastdrop agents driver: one T3 provider whose models are Claude's own and the user's agents
 * (the fork's `agents.json`, live), each session forwarded to a native T3 instance along
 * the agent's chain (`router.ts`).
 */
import { TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { agentModels, fallbackSignature, fallbackThreads } from "./catalog.ts";
import { boundCatalogFiles, makeCatalogSource, type CatalogSource } from "./catalogSource.ts";
import { ALL_RUNTIME_MODES } from "./permissions.ts";
import { makeRouterAdapter } from "./router.ts";
import { LASTDROP_AGENTS_DRIVER, LastdropAgentsSettings } from "./settings.ts";
import * as Shared from "./shared.ts";

const decodeSettings = Schema.decodeSync(LastdropAgentsSettings);

const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: LASTDROP_AGENTS_DRIVER,
  packageName: null,
});

/** Titles and commit messages stay with T3's other providers. */
const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "lastdrop's agents do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
})();

/** How often the catalog files are checked for a change. */
const CATALOG_POLL = "2 seconds";

export const makeLastdropAgentsDriver = (
  openSource: () => CatalogSource = () => makeCatalogSource({ files: boundCatalogFiles }),
): ProviderDriver<LastdropAgentsSettings> => ({
  driverKind: LASTDROP_AGENTS_DRIVER,
  metadata: { displayName: "lastdrop agents", supportsMultipleInstances: false },
  configSchema: LastdropAgentsSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("LastdropAgentsDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
  }) {
    const source = openSource();
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: LASTDROP_AGENTS_DRIVER,
      instanceId,
    });
    const stamp = withInstanceIdentity({
      instanceId,
      driverKind: LASTDROP_AGENTS_DRIVER,
      displayName: displayName ?? "lastdrop agents",
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const onFallback = () =>
      fallbackThreads(source.current().agents, Shared.nativeEntries.entries());
    /** Every instance the agents' chains run on, for usage refreshes and their model lists. */
    const chainInstances = () => [
      ...new Set(
        source.current().agents.flatMap((agent) => agent.chain.map((step) => step.instanceId)),
      ),
    ];
    /**
     * The chain instances' own models, as legacy (hidden) entries: a native subagent on another
     * model (Claude's Haiku child) is restamped `lastdropAgents/<model>`, and T3 names a thread's
     * model from its provider's list.
     */
    const innerModels = Effect.fn("LastdropAgentsDriver.innerModels")(function* () {
      const ids = chainInstances();
      const lists = yield* Effect.forEach(ids, (id) =>
        Shared.targets.models(id).pipe(
          Effect.map((models) =>
            (models ?? []).map((model) => ({
              slug: model.slug,
              name: model.name,
              ...(model.shortName === undefined ? {} : { shortName: model.shortName }),
              subProvider: source
                .current()
                .agents.flatMap((agent) => agent.chain)
                .find((step) => step.instanceId === id)!.providerLabel,
              isCustom: false,
              isLegacy: true,
              capabilities: model.capabilities,
            })),
          ),
        ),
      );
      return lists.flat();
    });
    const build = Effect.fn("LastdropAgentsDriver.build")(function* () {
      const reading = source.current();
      const own = agentModels(reading.agents, reading.efforts, onFallback());
      const slugs = new Set(own.map((model) => model.slug));
      const legacy = (yield* innerModels()).filter((model) => {
        if (slugs.has(model.slug)) return false;
        slugs.add(model.slug);
        return true;
      });
      const agents = reading.agents.filter((agent) => agent.claudeModel !== true).length;
      return stamp({
        enabled,
        installed: true,
        version: null,
        status: !enabled ? "disabled" : reading.problem === undefined ? "ready" : "warning",
        auth: { status: "authenticated", label: "Your agents" },
        setup: { canAuthenticate: false, canInstall: false },
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        message:
          reading.problem ??
          `Claude's models and ${agents} agent${agents === 1 ? "" : "s"} from lastdrop.`,
        models: [...own, ...legacy],
        slashCommands: [],
        skills: [],
        supportsTextGeneration: false,
        // Every mode reaches the router, which takes each entry to what its instance supports.
        supportedRuntimeModes: [...ALL_RUNTIME_MODES],
        supportsConversationRollback: true,
      } as Parameters<typeof stamp>[0]);
    });
    const current = yield* Ref.make<ServerProvider>(yield* build());
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const refresh = build().pipe(
      Effect.tap((next) => Ref.set(current, next)),
      Effect.tap((next) => PubSub.publish(changes, next)),
    );
    // The catalog reloads live: a changed file, or a change in the chain instances' own lists,
    // publishes a new model list.
    const innerSignature = innerModels().pipe(
      Effect.map((models) => models.map((model) => model.slug).join(",")),
    );
    let lastInner = "";
    // Threads moving to a fallback entry publish too, so cards name the entry that runs.
    let lastFallbacks = fallbackSignature(onFallback());
    yield* Effect.gen(function* () {
      const changed = source.reloadIfChanged();
      const signature = yield* innerSignature;
      const fallbacks = fallbackSignature(onFallback());
      if (changed || signature !== lastInner || fallbacks !== lastFallbacks) {
        lastInner = signature;
        lastFallbacks = fallbacks;
        yield* refresh;
      }
    }).pipe(Effect.repeat(Schedule.spaced(CATALOG_POLL)), Effect.forkScoped);
    const snapshot: ManagedServerProvider = {
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSnapshot: Ref.get(current),
      refresh: Effect.sync(source.reloadIfChanged).pipe(Effect.andThen(refresh)),
      refreshUsage: Effect.suspend(() =>
        Effect.forEach(chainInstances(), Shared.targets.refreshUsage, { discard: true }),
      ),
      streamChanges: Stream.fromPubSub(changes),
      applyUsageLimits: () => Effect.void,
    };
    const orchestrationAdapter = makeRouterAdapter({
      instanceId,
      agents: () => source.current().agents,
      resolveTarget: Shared.targets.resolve,
      innerModels: Shared.targets.models,
      room: Shared.room,
      fallbacks: Shared.fallbacks,
      nativeEntries: Shared.nativeEntries,
      innerRuntimeModes: Shared.targets.runtimeModes,
    });
    return {
      instanceId,
      driverKind: LASTDROP_AGENTS_DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
    } satisfies ProviderInstance;
  }),
});

export const LastdropAgentsDriver = makeLastdropAgentsDriver();
