/**
 * lastdrop's provider client definitions (label, icon, settings schema), shared by web and mobile.
 * `providerClients.ts` spreads this list after T3's own; see FORK.md. Keep in step with
 * `EXTENSION_PROVIDER_CLIENTS` in `apps/server/src/extensions/index.ts`.
 */
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";

export const extensionProviderClients: ReadonlyArray<ProviderClientDefinition> = [];
