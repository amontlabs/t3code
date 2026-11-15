/**
 * The agents' server-side wiring, inside `Extensions.layer` (above T3's provider hydration, so no
 * new seam): binds the target lookup the driver reads when a session opens, and runs the fallback
 * reactor for runs that end at a limit partway (holding them open for their waiters, `fallback.ts`).
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { resolveLastdropDataDir } from "../../dataDir.ts";
import { runFallbackReactor } from "./fallback.ts";
import { LASTDROP_AGENTS_DRIVER } from "./settings.ts";
import * as Shared from "./shared.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    /** A native instance that exists, is on, installed and not marked unavailable. */
    const usableInstance = Effect.fn("LastdropAgents.usableInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const instance = yield* instances.getInstance(instanceId);
      if (
        instance === undefined ||
        !instance.enabled ||
        instance.driverKind === LASTDROP_AGENTS_DRIVER
      )
        return undefined;
      const snapshot = yield* instance.snapshot.getSnapshot;
      if (!snapshot.enabled || !snapshot.installed || snapshot.availability === "unavailable")
        return undefined;
      return { instance, snapshot };
    });
    yield* Shared.bindTargets({
      resolve: (instanceId) =>
        usableInstance(instanceId).pipe(
          Effect.flatMap((usable) =>
            usable === undefined
              ? Effect.undefined
              : adapters.get(instanceId).pipe(Effect.orElseSucceed(() => undefined)),
          ),
        ),
      models: (instanceId) =>
        usableInstance(instanceId).pipe(Effect.map((usable) => usable?.snapshot.models)),
      runtimeModes: (instanceId) =>
        usableInstance(instanceId).pipe(
          Effect.map((usable) => usable?.snapshot.supportedRuntimeModes),
        ),
      refreshUsage: (instanceId) =>
        instances.getInstance(instanceId).pipe(
          Effect.flatMap((instance) => instance?.snapshot.refreshUsage ?? Effect.void),
          Effect.ignore,
        ),
    });
    yield* Effect.addFinalizer(() => Shared.unbindTargets);
    yield* Shared.attachStore(yield* resolveLastdropDataDir);
    // Out of this context, T3's outbox is rebuilt here; in production it is T3's own instance (the
    // shared memo map), but the reactor only touches table rows, so it need not be.
    yield* runFallbackReactor(Shared.fallbacks).pipe(
      Effect.provide(EffectOutbox.layer),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry));
