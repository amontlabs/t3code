/**
 * At each start, a home with no `lastdropAgents` entry gets it on (the entry the switch writes): T3
 * runs an unconfigured instance only if it is `codex` or `claudeAgent`, while the switch shows on.
 * T3's `create` fails on an existing entry, so the user's own switch is never changed.
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../../../serverSettings.ts";
import { LASTDROP_AGENTS_DRIVER } from "./settings.ts";

export const LASTDROP_AGENTS_INSTANCE = ProviderInstanceId.make(LASTDROP_AGENTS_DRIVER);

/** `created`, `kept` (an entry exists: the user's switch, or an earlier start's), or `raced`. */
export const ensureAgentsInstanceOn = Effect.fn("LastdropAgents.ensureInstanceOn")(function* (
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateProviderInstance">,
) {
  const current = yield* settings.getSettings;
  if (Object.hasOwn(current.providerInstances, LASTDROP_AGENTS_INSTANCE)) return "kept" as const;
  return yield* settings
    .updateProviderInstance({
      operation: "create",
      instanceId: LASTDROP_AGENTS_INSTANCE,
      instance: { driver: LASTDROP_AGENTS_DRIVER, enabled: true },
    })
    .pipe(
      Effect.as("created" as const),
      // The entry appeared between the read and the write (the switch, or another writer).
      Effect.catchTags({
        ServerSettingsError: (error) =>
          error.operation === "create-provider-instance"
            ? Effect.succeed("raced" as const)
            : Effect.fail(error),
      }),
    );
});
