// @effect-diagnostics nodeBuiltinImport:off - The real home folder, the standalone's catalog and lastdrop's own small file.
/**
 * Z.ai and OpenRouter as T3 Claude instances `zai`/`openrouter` (the agents' targets), made and kept through
 * T3's `ServerSettingsService.updateProviderInstance`, in lastdrop's own profile with the endpoint's env and a
 * keychain key helper. Only instances lastdrop made are changed or removed. See docs/lastdrop/step6.md.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import {
  ENDPOINT_INSTANCE_IDS,
  ENDPOINT_PROVIDERS,
  ENDPOINT_TITLES,
  type EndpointInstance,
  type EndpointModel,
  type EndpointProvider,
  endpointEnvironment,
  endpointInstance,
  endpointModels,
} from "@t3tools/lastdrop-node";
import {
  endpointDirectory,
  EndpointMonitor,
  endpointSessionSettings,
  type EndpointState,
  fileLogger,
  lastdropPaths,
  loadAccounts,
  nodeFetch,
  prepareEndpointProfile,
} from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveLastdropDataDir } from "../dataDir.ts";
import { parseCatalog } from "./agents/catalog.ts";
import { standaloneCatalogFiles } from "./agents/catalogSource.ts";
import * as EndpointRoom from "./endpointRoom.ts";
import { type EndpointView, LastdropEndpoints } from "./endpointsView.ts";

/** Keys and the catalog are looked at this often; usage is read every 5 minutes. */
const TICK = "1 minute";

// MARK: What the instance should be

/** The catalog's models on the provider, primary entries first, and the judge chosen for it. */
export interface CatalogFacts {
  readonly models: Readonly<Record<EndpointProvider, ReadonlyArray<string>>>;
  readonly judges: Readonly<Partial<Record<EndpointProvider, string>>>;
}

export function catalogFacts(json: unknown): CatalogFacts {
  const models: Record<EndpointProvider, string[]> = { zai: [], openrouter: [] };
  const agents = parseCatalog(json).filter((agent) => agent.enabled);
  // Primary entries first, then fallbacks: the first model is the one the instance's roles are pinned to.
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
    for (const agent of agents) {
      const step = agent.chain[index];
      const provider = step?.provider;
      if (step === undefined || (provider !== "zai" && provider !== "openrouter")) continue;
      const list = models[provider];
      if (!list.includes(step.model)) list.push(step.model);
    }
  }
  const judges: Partial<Record<EndpointProvider, string>> = {};
  const raw =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>).judges
      : undefined;
  if (typeof raw === "object" && raw !== null) {
    for (const provider of ENDPOINT_PROVIDERS) {
      const entry = (raw as Record<string, unknown>)[provider];
      const model =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>).model
          : undefined;
      if (typeof model === "string" && model.length > 0) judges[provider] = model;
    }
  }
  return { models, judges };
}

/** The model the instance's roles are pinned to: the catalog's first, else Z.ai's strong default. */
export const roleModel = (provider: EndpointProvider, facts: CatalogFacts): string | undefined =>
  facts.models[provider]?.[0] ?? (provider === "zai" ? "glm-5.3" : undefined);

/** The provider's instance as lastdrop wants it, from the catalog and the listed models. */
export function desiredInstance(input: {
  readonly provider: EndpointProvider;
  readonly home: string;
  readonly sessionSettings: string;
  readonly facts: CatalogFacts;
  readonly listed: ReadonlyArray<EndpointModel>;
}): { readonly spec: EndpointInstance; readonly environment: Record<string, string> } {
  const { provider, facts } = input;
  const model = roleModel(provider, facts);
  const judge = facts.judges[provider];
  return {
    spec: endpointInstance({
      provider,
      home: input.home,
      sessionSettings: input.sessionSettings,
      model,
      judge,
      models: endpointModels(provider, facts.models[provider], input.listed),
    }),
    environment: endpointEnvironment({ provider, model, judge }),
  };
}

// MARK: Reconcile

/** What one pass did to one provider's instance. */
export type InstanceOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "removed"
  | "absent"
  | "userOwned";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Our fields of the instance equal what lastdrop wants (the user's `enabled` and other fields aside). */
function matches(existing: ProviderInstanceConfig, spec: EndpointInstance["instance"]): boolean {
  const config = (existing.config ?? {}) as Record<string, unknown>;
  return (
    existing.driver === spec.driver &&
    existing.displayName === spec.displayName &&
    sameJson(
      (existing.environment ?? []).map((v) => ({
        name: v.name,
        value: v.value,
        sensitive: v.sensitive,
      })),
      spec.environment,
    ) &&
    Object.entries(spec.config).every(([key, value]) => sameJson(config[key], value))
  );
}

const toConfig = (
  spec: EndpointInstance["instance"],
  existing: ProviderInstanceConfig | undefined,
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make(spec.driver),
  displayName: spec.displayName,
  ...(existing?.accentColor === undefined ? {} : { accentColor: existing.accentColor }),
  environment: spec.environment,
  enabled: existing?.enabled ?? spec.enabled,
  config: { ...((existing?.config ?? {}) as Record<string, unknown>), ...spec.config },
});

/**
 * Brings one provider's instance in line: made when the provider can run agents and the id is free, kept
 * current while lastdrop owns it, removed when the provider goes. The user's own instance under the id, or
 * the user's on/off choice on ours, is never changed.
 */
export const reconcileInstance = Effect.fn("LastdropEndpoints.reconcileInstance")(function* <
  E,
>(input: {
  readonly instances: ProviderInstanceConfigMap;
  readonly instanceId: string;
  /** Undefined when the provider has no key that can run models. */
  readonly spec: EndpointInstance["instance"] | undefined;
  readonly owned: boolean;
  readonly mutate: (mutation: ProviderInstanceMutation) => Effect.Effect<void, E>;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const existing = input.instances[instanceId];
  if (input.spec === undefined) {
    if (!input.owned || existing === undefined) return { outcome: "absent", owned: false } as const;
    yield* input.mutate({ operation: "remove", instanceId });
    return { outcome: "removed", owned: false } as const;
  }
  if (existing === undefined) {
    yield* input.mutate({
      operation: "upsert",
      instanceId,
      instance: toConfig(input.spec, undefined),
    });
    return { outcome: "created", owned: true } as const;
  }
  if (!input.owned) return { outcome: "userOwned", owned: false } as const;
  if (matches(existing, input.spec)) return { outcome: "unchanged", owned: true } as const;
  yield* input.mutate({
    operation: "upsert",
    instanceId,
    instance: toConfig(input.spec, existing),
  });
  return { outcome: "updated", owned: true } as const;
});

// MARK: Ownership file

/** Which instance ids lastdrop made (`<T3 home>/lastdrop/endpoint-instances.json`). */
export const readOwned = (file: string): Set<string> => {
  try {
    const json: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    const ids =
      typeof json === "object" && json !== null ? (json as { ids?: unknown }).ids : undefined;
    return new Set(
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
};

const writeOwned = (file: string, ids: ReadonlySet<string>): void => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify({ ids: [...ids].toSorted() }), { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
};

// MARK: Service

class EndpointsError extends Schema.TaggedError<EndpointsError>()("LastdropEndpointsError", {
  cause: Schema.Defect(),
}) {}

const io = <A>(run: () => Promise<A> | A) =>
  Effect.tryPromise({ try: async () => run(), catch: (cause) => new EndpointsError({ cause }) });

const readCatalogJson = (file: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Runs on macOS, where the keys are in the keychain. Not under vitest: T3's own server tests start this
 * layer and must never read the real keychain, write T3's settings or ask Z.ai.
 */
export const layer = Layer.effect(
  LastdropEndpoints,
  Effect.gen(function* () {
    const underTest = yield* Config.String("VITEST").pipe(Config.option);
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin" || underTest._tag === "Some") {
      return LastdropEndpoints.of({ view: Effect.undefined });
    }
    const settings = yield* ServerSettingsService;
    const dataDir = yield* resolveLastdropDataDir;
    const home = NodeOS.homedir();
    const paths = lastdropPaths({ home, dataDir });
    const log = fileLogger(`${dataDir}/lastdrop.log`);
    const ownedFile = NodePath.join(dataDir, "endpoint-instances.json");
    const catalogFile = standaloneCatalogFiles(home).catalog;
    const monitor = new EndpointMonitor({ paths, fetch: nodeFetch, env: process.env, log });
    const placement = new Map<EndpointProvider, EndpointView["instance"]>();
    const told = new Set<string>();
    let updatedAt = 0;

    const pass = Effect.gen(function* () {
      const states = yield* io(() => monitor.refresh());
      const started = yield* Clock.currentTimeMillis;
      const accounts = yield* io(() => loadAccounts(paths, started));
      EndpointRoom.setThresholds({
        sessionThreshold: accounts.sessionThreshold,
        weeklyThreshold: accounts.weeklyThreshold,
      });
      const facts = catalogFacts(readCatalogJson(catalogFile));
      const owned = readOwned(ownedFile);
      const current = yield* settings.getSettings;
      for (const state of states) {
        const provider = state.provider;
        const instanceId = ENDPOINT_INSTANCE_IDS[provider];
        EndpointRoom.setReading(
          instanceId,
          state.usage === undefined || state.readAt === undefined
            ? undefined
            : { windows: state.usage.windows, at: state.readAt },
        );
        let spec: EndpointInstance["instance"] | undefined;
        if (state.configured && state.problem === undefined) {
          const listed =
            provider === "openrouter" ? yield* io(() => monitor.openRouterModels()) : [];
          const desired = desiredInstance({
            provider,
            home: endpointDirectory(paths, provider),
            sessionSettings: endpointSessionSettings(paths, provider),
            facts,
            listed,
          });
          yield* io(() =>
            prepareEndpointProfile({ paths, provider, environment: desired.environment }),
          );
          spec = desired.spec.instance;
        }
        const result = yield* reconcileInstance({
          instances: current.providerInstances,
          instanceId,
          spec,
          owned: owned.has(instanceId),
          mutate: (mutation) => settings.updateProviderInstance(mutation).pipe(Effect.asVoid),
        });
        if (result.owned) owned.add(instanceId);
        else if (result.outcome !== "userOwned") owned.delete(instanceId);
        placement.set(
          provider,
          result.outcome === "userOwned" ? "user" : result.owned ? "ours" : "none",
        );
        if (
          result.outcome === "created" ||
          result.outcome === "updated" ||
          result.outcome === "removed"
        ) {
          log(`${ENDPOINT_TITLES[provider]}: instance ${instanceId} ${result.outcome}`);
        }
        if (result.outcome === "userOwned" && !told.has(instanceId)) {
          told.add(instanceId);
          log(`${ENDPOINT_TITLES[provider]}: instance ${instanceId} is the user's own; left alone`);
        }
      }
      yield* io(() => writeOwned(ownedFile, owned));
      updatedAt = yield* Clock.currentTimeMillis;
    }).pipe(Effect.catch((error) => Effect.logWarning("lastdrop endpoints pass failed", error)));

    yield* settings.ready.pipe(
      Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(TICK)))),
      Effect.catch((error) => Effect.logWarning("lastdrop endpoints stopped", error)),
      Effect.forkScoped,
    );

    const view = (state: EndpointState, now: number): EndpointView => {
      const instanceId = ENDPOINT_INSTANCE_IDS[state.provider];
      return {
        provider: state.provider,
        title: ENDPOINT_TITLES[state.provider],
        instanceId,
        configured: state.configured,
        problem: state.problem,
        instance: placement.get(state.provider) ?? "none",
        usage: state.usage,
        readAt: state.readAt,
        error: state.error,
        outUntil: EndpointRoom.outUntil(instanceId, now),
      };
    };
    return LastdropEndpoints.of({
      view: Clock.currentTimeMillis.pipe(
        Effect.map((now) => ({ updatedAt, endpoints: monitor.all().map((s) => view(s, now)) })),
      ),
    });
  }),
);
