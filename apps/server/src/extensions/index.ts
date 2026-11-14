/**
 * lastdrop's server extensions. T3's own registries spread these at small seams listed in
 * FORK.md. With empty lists and an identity wrapper the server behaves exactly as upstream.
 */
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

import * as LastdropAccounts from "./lastdrop/accounts.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ClaudeAgentSdkQueryRunner } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

/** Services the extension drivers need to create instances. */
export type ExtensionDriversEnv = never;
/** Services the extension drivers' usage readers need. */
export type ExtensionUsageReadersEnv = never;

/** Provider drivers added after T3's built-in ones (`builtInDrivers.ts`). */
export const EXTENSION_DRIVERS: ReadonlyArray<AnyProviderDriver<ExtensionDriversEnv>> = [];

/** Drivers whose transcripts the Usage page reads, after T3's own. */
export const EXTENSION_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<ExtensionDriversEnv, ExtensionUsageReadersEnv>
> = [];

/**
 * Client definitions of the extension drivers, for the server's own copies of the client list
 * (`settingsSecrets.ts`, `policy/managedProviders.ts`). Keep in step with
 * `packages/client-runtime/src/extensions.ts`.
 */
export const EXTENSION_PROVIDER_CLIENTS: ReadonlyArray<ProviderClientDefinition> = [];

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

/** Long-lived services, merged into the server's core dependencies: Claude accounts and usage. */
export const layer = LastdropAccounts.layer;

/** HTTP routes, merged beside T3's own: the accounts view for the settings section. */
export const routes = LastdropAccounts.routes;

/** Refuses a database migrated by a newer T3 build; `server.ts` runs it before opening the database. */
export { refuseNewerDatabase } from "./databaseVersion.ts";
