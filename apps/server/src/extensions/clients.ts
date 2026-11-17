/**
 * Client definitions of the extension drivers, for the server's own copies of the client list
 * (`settingsSecrets.ts`, `policy/managedProviders.ts`). Keep in step with
 * `packages/client-runtime/src/extensions.ts`. Its own module, apart from `index.ts`: those files load early
 * (through the settings service) and `index.ts` imports the drivers, which import them back.
 */
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";

import { lastdropAgentsClient } from "./lastdrop/agents/settings.ts";

export const EXTENSION_PROVIDER_CLIENTS: ReadonlyArray<ProviderClientDefinition> = [
  lastdropAgentsClient,
];
