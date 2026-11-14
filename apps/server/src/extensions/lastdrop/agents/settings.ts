/**
 * The agents provider's settings and client definition (server copy; the web's is in
 * `packages/client-runtime/src/extensions.ts`). Driver kind `lastdropAgents`: the shared `~/.t3`
 * already holds an instance `lastdrop` (the standalone app's ACP provider).
 */
import { makeProviderSettingsSchema, ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LASTDROP_AGENTS_DRIVER = ProviderDriverKind.make("lastdropAgents");

export const LastdropAgentsSettings = makeProviderSettingsSchema({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type LastdropAgentsSettings = typeof LastdropAgentsSettings.Type;

export const lastdropAgentsClient = defineProviderClient({
  driverKind: LASTDROP_AGENTS_DRIVER,
  label: "lastdrop agents",
  featured: false,
  settingsSchema: LastdropAgentsSettings,
});
