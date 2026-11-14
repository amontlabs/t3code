/**
 * lastdrop's provider client definitions (label, icon, settings schema), shared by web and mobile.
 * `providerClients.ts` spreads this list after T3's own; see FORK.md. Keep in step with
 * `EXTENSION_PROVIDER_CLIENTS` in `apps/server/src/extensions/index.ts` (the agents driver's
 * `settings.ts`).
 */
import { makeProviderSettingsSchema, ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient, type ProviderClientDefinition } from "@t3tools/provider-core/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
