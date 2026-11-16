/** `LastdropCodexDriver.create` (codexDriver.ts): T3's Codex instance, insulated from Codex's own login. */
import type { CodexSettings } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";

import {
  checkCodexProviderStatus,
  probeCodexSkillsForCwd,
} from "../../../provider/CodexProvider.ts";
import { ProviderDriverError } from "../../../provider/Errors.ts";
import { applyCodexModelCatalog } from "../../../provider/codexModelCatalog.ts";
import { CodexDriver, type CodexDriverEnv } from "../../../provider/Drivers/CodexDriver.ts";
import { makeCodexTextGeneration } from "../../../textGeneration/CodexTextGeneration.ts";
import type * as CodexUsageHistory from "../../../usage/CodexUsageHistory.ts";
import { insulateCodex } from "./codexDriver.ts";
import { isRoutable, onAccountHome } from "./factory.ts";
import { lastdropCodexRouting } from "./routing.ts";

export const create: ProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | CodexUsageHistory.CodexUsageHistory
>["create"] = Effect.fn("LastdropCodexDriver.create")(function* (input) {
  const instance = yield* CodexDriver.create(input);
  const live = yield* lastdropCodexRouting;
  if (live === undefined) return instance;
  const processEnv = yield* mergeProviderInstanceEnvironment(
    input.environment,
    yield* HostProcess.Environment,
  );
  // The same instances the client factory routes; managed ones and other homes keep their own sign-in.
  if (!isRoutable(input.config, processEnv, live.sharedHome)) return instance;
  const context = yield* Effect.context<CodexDriverEnv>();
  const config = {
    ...input.config,
    enabled: input.enabled,
    binaryPath: expandHomePath(input.config.binaryPath, yield* HostProcess.HomeDirectory),
  } satisfies CodexSettings;
  const catalog = (yield* ModelCatalog.ModelCatalog).current(CodexDriver.driverKind);
  return insulateCodex(instance, {
    pick: Effect.promise(() => live.routing.pick().catch(() => undefined)),
    probe: (home) => {
      const account = onAccountHome(config, processEnv, home);
      return Effect.zipWith(
        checkCodexProviderStatus(account.settings, undefined, account.environment),
        catalog,
        applyCodexModelCatalog,
      ).pipe(
        Effect.provideContext(context),
        Effect.orElseSucceed(() => undefined),
      );
    },
    skills: (home, cwd) => {
      if (!config.enabled) return Effect.undefined;
      const account = onAccountHome(config, processEnv, home);
      return probeCodexSkillsForCwd({
        binaryPath: account.settings.binaryPath,
        homePath: account.settings.homePath,
        launchArgs: account.settings.launchArgs,
        cwd,
        environment: account.environment,
      }).pipe(
        Effect.scoped,
        Effect.timeout("20 seconds"),
        Effect.provideContext(context),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: CodexDriver.driverKind,
              instanceId: input.instanceId,
              detail: `Failed to probe Codex skills for '${cwd}'`,
              cause,
            }),
        ),
      );
    },
    textGeneration: (home, models) => {
      const account = onAccountHome(config, processEnv, home);
      return makeCodexTextGeneration(account.settings, account.environment, models).pipe(
        Effect.provideContext(context),
      );
    },
  });
});
