/**
 * lastdrop's server extensions. T3's own registries spread these at small seams listed in
 * FORK.md. With empty lists and an identity wrapper the server behaves exactly as upstream.
 */
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as LastdropAccounts from "./lastdrop/accounts.ts";
import * as LastdropEndpointsView from "./lastdrop/endpointsView.ts";
import { LastdropAgentsDriver } from "./lastdrop/agents/driver.ts";
import { lastdropAgentsClient } from "./lastdrop/agents/settings.ts";

import type { ClaudeAgentSdkQueryRunner } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { UsageLimitSources } from "../usage/UsageLimitSources.ts";

/** Services the extension drivers need to create instances. */
export type ExtensionDriversEnv = never;
/** Services the extension drivers' usage readers need. */
export type ExtensionUsageReadersEnv = never;

/** Provider drivers added after T3's built-in ones (`builtInDrivers.ts`): the user's agents. */
export const EXTENSION_DRIVERS: ReadonlyArray<AnyProviderDriver<ExtensionDriversEnv>> = [
  LastdropAgentsDriver,
];

/** Drivers whose transcripts the Usage page reads, after T3's own. */
export const EXTENSION_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<ExtensionDriversEnv, ExtensionUsageReadersEnv>
> = [];

/**
 * Client definitions of the extension drivers, for the server's own copies of the client list
 * (`settingsSecrets.ts`, `policy/managedProviders.ts`). Keep in step with
 * `packages/client-runtime/src/extensions.ts`.
 */
export const EXTENSION_PROVIDER_CLIENTS: ReadonlyArray<ProviderClientDefinition> = [
  lastdropAgentsClient,
];

/**
 * Wraps the layer that opens every Claude Agent SDK query: lastdrop picks the Claude account per
 * thread there, moves threads between accounts and translates their session ids
 * (`lastdrop/queryRunner.ts`). Under vitest and off macOS it returns T3's runner unchanged.
 */
export const wrapClaudeQueryRunner = <E, R>(
  queryRunner: Layer.Layer<ClaudeAgentSdkQueryRunner, E, R>,
): Layer.Layer<ClaudeAgentSdkQueryRunner, E, R> =>
  // Loaded lazily: the wrapper imports the Claude adapter, which (through the drivers) imports this file.
  Layer.unwrap(
    Effect.promise(() => import("./lastdrop/queryRunnerLive.ts")).pipe(
      Effect.map((live) => live.wrapLive(queryRunner)),
    ),
  );

/**
 * Wraps T3's usage limit sources (the hubs **Usage → Limits** reads): lastdrop's Claude accounts, Z.ai and
 * OpenRouter come after T3's own sources (`lastdrop/limitSourcesLive.ts`). With nothing published it adds nothing.
 */
export const wrapUsageLimitSources = <E, R>(
  sources: Layer.Layer<UsageLimitSources, E, R>,
): Layer.Layer<UsageLimitSources, E, R> =>
  // Loaded lazily: T3's service reaches the settings module, which imports this file's lists.
  Layer.unwrap(
    Effect.promise(() => import("./lastdrop/limitSourcesLive.ts")).pipe(
      Effect.map((live) => live.wrap(sources)),
    ),
  );

/**
 * Long-lived services, merged into the server's core dependencies: Claude accounts and usage; the
 * agents' target lookup and fallback reactor; the move continuation; the Z.ai and OpenRouter instances and their usage.
 */
const services = Layer.mergeAll(
  LastdropAccounts.layer,
  // Imported when the layer builds: it reaches T3's settings service, which imports this module's lists.
  Layer.unwrap(
    Effect.promise(() => import("./lastdrop/endpoints.ts")).pipe(
      Effect.map((endpoints) => endpoints.layer),
    ),
  ),
  // Imported when the layer builds: it reaches T3's orchestrator, which imports this module's lists.
  Layer.unwrap(
    Effect.promise(() => import("./lastdrop/agents/layer.ts")).pipe(
      Effect.map((agents) => agents.layer),
    ),
  ),
  // The continuation after a Claude thread moved at a usage limit; it too reaches T3's orchestrator.
  Layer.unwrap(
    Effect.promise(() => import("./lastdrop/moveContinuationLayer.ts")).pipe(
      Effect.map((move) => move.layer),
    ),
  ),
);

/** The services, and the publisher that feeds their readings to the usage limit sources wrapper. */
export const layer = Layer.unwrap(
  Effect.promise(() => import("./lastdrop/limitSourcesLive.ts")).pipe(
    Effect.map((live) => live.publisher),
  ),
).pipe(Layer.provideMerge(services));

/**
 * HTTP routes, merged beside T3's own: the accounts and endpoints views for the settings section, and
 * the runner lastdrop's Claude Code plugin calls for its Agent types (`lastdrop/runner/`, step 8).
 */
export const routes = Layer.mergeAll(
  LastdropAccounts.routes,
  LastdropEndpointsView.routes,
  // Imported when the layer builds: it reaches T3's orchestrator, which imports this module's lists.
  Layer.unwrap(
    Effect.promise(() => import("./lastdrop/runner/routes.ts")).pipe(
      Effect.map((runner) => runner.routes),
    ),
  ),
);

/** Refuses a database migrated by a newer T3 build; `server.ts` runs it before opening the database. */
export { refuseNewerDatabase } from "./databaseVersion.ts";
