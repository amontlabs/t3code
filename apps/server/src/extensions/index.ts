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
 * Wraps the layer that opens every Claude Agent SDK query. lastdrop will pick the account here;
 * today it returns the layer unchanged.
 */
export const wrapClaudeQueryRunner = <A, E, R>(
  queryRunner: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, R> => queryRunner;

/**
 * Long-lived services, merged into the server's core dependencies: Claude accounts and usage; the
 * agents' target lookup and fallback reactor; the Z.ai and OpenRouter instances and their usage.
 */
export const layer = Layer.mergeAll(
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
);

/** HTTP routes, merged beside T3's own: the accounts and endpoints views for the settings section. */
export const routes = Layer.mergeAll(LastdropAccounts.routes, LastdropEndpointsView.routes);

/** Refuses a database migrated by a newer T3 build; `server.ts` runs it before opening the database. */
export { refuseNewerDatabase } from "./databaseVersion.ts";
