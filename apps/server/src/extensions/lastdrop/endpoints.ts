// @effect-diagnostics nodeBuiltinImport:off - The real home folder, the fork's agent catalog and lastdrop's own small file.
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
  isLastdropEndpointInstance,
} from "@t3tools/lastdrop-node";
import {
  endpointDirectory,
  EndpointMonitor,
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
import { agentCatalogFiles } from "./agents/catalogSource.ts";
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
      model,
      judge,
      models: endpointModels(provider, facts.models[provider], input.listed),
    }),
    environment: endpointEnvironment({ provider, model, judge }),
  };
}

// MARK: Reconcile

/** What lastdrop wants for a provider's instance this pass. */
export type Want =
  /** Not sure (keychain unreadable, catalog or model list never read): change nothing. */
  | { readonly kind: "keep" }
  /** Definitely gone (no key, or a management key): remove lastdrop's instance. */
  | { readonly kind: "remove" }
  | { readonly kind: "present"; readonly spec: EndpointInstance["instance"] };

/** What one pass did to one provider's instance. */
export type InstanceOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "kept"
  | "removed"
  | "absent"
  | "userOwned"
  | "raced";

/** The user's own choices on lastdrop's instance, put back when lastdrop makes it again. */
export interface Remembered {
  readonly enabled?: boolean | undefined;
  readonly accentColor?: string | undefined;
}

/** Which instance ids lastdrop made; each change is on disk before the T3 write it covers. */
export interface Ownership {
  readonly has: (instanceId: string) => boolean;
  readonly claim: (instanceId: string) => void;
  readonly release: (instanceId: string) => void;
  readonly remember: (instanceId: string, choices: Remembered) => void;
  readonly remembered: (instanceId: string) => Remembered | undefined;
}

interface OwnershipFile {
  readonly ids: ReadonlyArray<string>;
  readonly remembered: Readonly<Record<string, Remembered>>;
}

const readOwnershipFile = (file: string): OwnershipFile => {
  try {
    const json = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Partial<OwnershipFile>;
    return {
      ids: Array.isArray(json.ids) ? json.ids.filter((id) => typeof id === "string") : [],
      remembered:
        typeof json.remembered === "object" && json.remembered !== null ? json.remembered : {},
    };
  } catch {
    return { ids: [], remembered: {} };
  }
};

/** `<T3 home>/lastdrop/endpoint-instances.json`, written atomically on every change. */
export const fileOwnership = (file: string): Ownership => {
  let state = readOwnershipFile(file);
  const write = (next: OwnershipFile) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    NodeFS.renameSync(temporary, file);
    state = next;
  };
  return {
    has: (id) => state.ids.includes(id),
    claim: (id) => {
      if (!state.ids.includes(id)) write({ ...state, ids: [...state.ids, id].toSorted() });
    },
    release: (id) => {
      if (state.ids.includes(id)) write({ ...state, ids: state.ids.filter((x) => x !== id) });
    },
    remember: (id, choices) =>
      write({ ...state, remembered: { ...state.remembered, [id]: choices } }),
    remembered: (id) => state.remembered[id],
  };
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** lastdrop's fields of the instance equal the spec's: driver, our variables, our config keys. */
function ownedFieldsMatch(existing: ProviderInstanceConfig, spec: EndpointInstance["instance"]) {
  const config = (existing.config ?? {}) as Record<string, unknown>;
  const env = existing.environment ?? [];
  return (
    existing.driver === spec.driver &&
    spec.environment.every((want) =>
      env.some(
        (v) => v.name === want.name && v.value === want.value && v.sensitive === want.sensitive,
      ),
    ) &&
    Object.entries(spec.config).every(([key, value]) => sameJson(config[key], value))
  );
}

/** The instance with only lastdrop's fields set; the user's name, switch, colour and extra variables stay. */
const withOwnedFields = (
  existing: ProviderInstanceConfig,
  spec: EndpointInstance["instance"],
): ProviderInstanceConfig => {
  const ours = new Set(spec.environment.map((v) => v.name));
  return {
    ...existing,
    driver: ProviderDriverKind.make(spec.driver),
    environment: [
      ...spec.environment,
      ...(existing.environment ?? []).filter((v) => !ours.has(v.name)),
    ],
    config: { ...((existing.config ?? {}) as Record<string, unknown>), ...spec.config },
  };
};

const newInstance = (
  spec: EndpointInstance["instance"],
  remembered: Remembered | undefined,
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make(spec.driver),
  displayName: spec.displayName,
  ...(remembered?.accentColor === undefined ? {} : { accentColor: remembered.accentColor }),
  environment: spec.environment,
  enabled: remembered?.enabled ?? spec.enabled,
  config: spec.config,
});

/**
 * One provider's instance, settings read just before writing. lastdrop's = marked and id recorded (a marked
 * one the file lost is adopted). Made with T3's `create`, updated only in lastdrop's fields, removed only on
 * a definite `remove`; the user's switch and colour come back if it is made again.
 */
export const reconcileInstance = Effect.fn("LastdropEndpoints.reconcileInstance")(function* <
  E,
  R,
>(input: {
  readonly instanceId: string;
  readonly want: Want;
  readonly read: Effect.Effect<ProviderInstanceConfigMap, E, R>;
  readonly mutate: (mutation: ProviderInstanceMutation) => Effect.Effect<void, E, R>;
  readonly ownership: Ownership;
}) {
  const { ownership, want } = input;
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const existing = (yield* input.read)[instanceId];
  const marked = isLastdropEndpointInstance(existing);
  if (existing !== undefined && marked && !ownership.has(instanceId)) ownership.claim(instanceId);
  if (existing !== undefined && !marked && ownership.has(instanceId)) ownership.release(instanceId);
  const ours = existing !== undefined && marked;
  const outcome = (o: InstanceOutcome) => ({
    outcome: o,
    ours: o === "created" || o === "updated" || o === "unchanged" || o === "kept",
  });

  if (want.kind === "keep") {
    return outcome(existing === undefined ? "absent" : ours ? "kept" : "userOwned");
  }
  if (want.kind === "remove") {
    if (existing === undefined) return outcome("absent");
    if (!ours) return outcome("userOwned");
    ownership.remember(instanceId, {
      enabled: existing.enabled,
      accentColor: existing.accentColor,
    });
    yield* input.mutate({ operation: "remove", instanceId });
    ownership.release(instanceId);
    return outcome("removed");
  }
  if (existing === undefined) {
    // On disk before the write: a crash after T3 saved it still leaves it lastdrop's.
    ownership.claim(instanceId);
    const created = yield* input
      .mutate({
        operation: "create",
        instanceId,
        instance: newInstance(want.spec, ownership.remembered(instanceId)),
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (created) return outcome("created");
    // Someone saved an instance under this id meanwhile: it isn't lastdrop's unless it carries the marker.
    const now = (yield* input.read)[instanceId];
    if (!isLastdropEndpointInstance(now)) ownership.release(instanceId);
    return outcome("raced");
  }
  if (!ours) return outcome("userOwned");
  if (ownedFieldsMatch(existing, want.spec)) return outcome("unchanged");
  yield* input.mutate({
    operation: "upsert",
    instanceId,
    instance: withOwnedFields(existing, want.spec),
  });
  return outcome("updated");
});

/**
 * What lastdrop wants for the provider: `keep` on any doubt (keychain unreadable, no catalog or model list
 * ever read), `remove` only on a definite absence or a management key, else the instance.
 */
export function wantFor(input: {
  readonly state: Pick<EndpointState, "presence" | "problem">;
  readonly facts: CatalogFacts | undefined;
  readonly listed: ReadonlyArray<EndpointModel> | undefined;
  readonly build: (facts: CatalogFacts, listed: ReadonlyArray<EndpointModel>) => EndpointInstance;
  readonly provider: EndpointProvider;
}): Want {
  const { state, facts } = input;
  if (state.presence === "absent") return { kind: "remove" };
  if (state.presence === "unknown") return { kind: "keep" };
  if (state.problem !== undefined) return { kind: "remove" };
  if (facts === undefined) return { kind: "keep" };
  const needsList = input.provider === "openrouter" && facts.models.openrouter.length > 0;
  if (needsList && input.listed === undefined) return { kind: "keep" };
  return { kind: "present", spec: input.build(facts, input.listed ?? []).instance };
}

/** The fork's `agents.json`: read, definitely absent, or unreadable now (keep the last good facts). */
export function readCatalogFile(
  file: string,
): { readonly state: "ok"; readonly json: unknown } | { readonly state: "missing" | "unreadable" } {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    return { state: (error as { code?: string }).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    return { state: "ok", json: JSON.parse(text) };
  } catch {
    return { state: "unreadable" };
  }
}

// MARK: Service

class EndpointsError extends Schema.TaggedError<EndpointsError>()("LastdropEndpointsError", {
  cause: Schema.Defect(),
}) {}

const io = <A>(run: () => Promise<A> | A) =>
  Effect.tryPromise({ try: async () => run(), catch: (cause) => new EndpointsError({ cause }) });

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
    const catalogFile = agentCatalogFiles(dataDir).catalog;
    const monitor = new EndpointMonitor({ paths, fetch: nodeFetch, env: process.env, log });
    const placement = new Map<EndpointProvider, EndpointView["instance"]>();
    const told = new Set<string>();
    let updatedAt = 0;

    const ownership = fileOwnership(NodePath.join(dataDir, "endpoint-instances.json"));
    /** The last catalog that read; undefined until one did (then nothing is written). */
    let lastFacts: CatalogFacts | undefined;

    const pass = Effect.gen(function* () {
      const states = yield* io(() => monitor.refresh());
      const started = yield* Clock.currentTimeMillis;
      const accounts = yield* io(() => loadAccounts(paths, started));
      EndpointRoom.setThresholds({
        sessionThreshold: accounts.sessionThreshold,
        weeklyThreshold: accounts.weeklyThreshold,
      });
      const catalog = readCatalogFile(catalogFile);
      if (catalog.state === "ok") lastFacts = catalogFacts(catalog.json);
      else if (catalog.state === "missing") lastFacts = catalogFacts(undefined);
      for (const state of states) {
        const provider = state.provider;
        const instanceId = ENDPOINT_INSTANCE_IDS[provider];
        EndpointRoom.setReading(
          instanceId,
          state.usage === undefined || state.readAt === undefined
            ? undefined
            : { windows: state.usage.windows, at: state.readAt },
        );
        const listed =
          provider === "openrouter" && state.presence === "configured"
            ? yield* io(() => monitor.openRouterModels())
            : [];
        const want = wantFor({
          state,
          facts: lastFacts,
          listed,
          provider,
          build: (facts, models) =>
            desiredInstance({
              provider,
              home: endpointDirectory(paths, provider),
              facts,
              listed: models,
            }).spec,
        });
        if (want.kind === "present") {
          yield* io(() => prepareEndpointProfile({ paths, provider }));
        }
        // Read T3's settings again right before each write: a pass spends seconds on the network.
        const result = yield* reconcileInstance({
          instanceId,
          want,
          ownership,
          read: settings.getSettings.pipe(Effect.map((current) => current.providerInstances)),
          mutate: (mutation) => settings.updateProviderInstance(mutation).pipe(Effect.asVoid),
        });
        placement.set(
          provider,
          result.outcome === "userOwned" ? "user" : result.ours ? "ours" : "none",
        );
        if (["created", "updated", "removed", "raced"].includes(result.outcome)) {
          log(`${ENDPOINT_TITLES[provider]}: instance ${instanceId} ${result.outcome}`);
        }
        if (result.outcome === "userOwned" && !told.has(instanceId)) {
          told.add(instanceId);
          log(`${ENDPOINT_TITLES[provider]}: instance ${instanceId} is the user's own; left alone`);
        }
      }
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
