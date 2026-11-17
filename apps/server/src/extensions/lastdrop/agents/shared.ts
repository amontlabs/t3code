/**
 * What the agents driver shares with `Extensions.layer` for the server's life. Targets are
 * late-bound: a driver needing T3's instance registry would be a layer cycle, so the layer binds
 * the lookup (through `ProviderAdapterRegistryV2`, keeping sign-in gating) and sessions read it.
 */
// @effect-diagnostics nodeBuiltinImport:off - Joins lastdrop's folder paths.
import * as NodePath from "node:path";

import type {
  ProviderInstanceId,
  RuntimeMode,
  ServerProviderModel,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";

import * as EndpointRoom from "../endpointRoom.ts";
import { bindCatalogDir } from "./catalogSource.ts";
import { attachCommandLog } from "./commandAnswers.ts";
import { poolOf } from "./pools.ts";
import { makeFallbackSignals, makeRoom, readingFromLimits, type RoomMark } from "./room.ts";
import { makeStoredMap } from "./store.ts";

export interface Targets {
  /** The instance's adapter; undefined when missing, disabled or another lastdrop instance. */
  readonly resolve: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterV2["Service"] | undefined>;
  /** The models the instance publishes (for each model's effort option). */
  readonly models: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProviderModel> | undefined>;
  /** The runtime modes the instance supports (its snapshot's `supportedRuntimeModes`). */
  readonly runtimeModes: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<RuntimeMode> | undefined>;
  /** The usage limits the instance last published (its snapshot's `usageLimits`). */
  readonly usage: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ServerProviderUsageLimits | undefined>;
  /** Asks the instance to read its usage limits again. */
  readonly refreshUsage: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}

let bound: Targets | undefined;

/** Called once by `Extensions.layer`; returns the unbind for its finalizer. */
export const bindTargets = (targets: Targets): Effect.Effect<void> =>
  Effect.sync(() => {
    bound = targets;
  });

export const unbindTargets = Effect.sync(() => {
  bound = undefined;
});

export const targets: Targets = {
  resolve: (instanceId) => (bound === undefined ? Effect.undefined : bound.resolve(instanceId)),
  models: (instanceId) => (bound === undefined ? Effect.undefined : bound.models(instanceId)),
  runtimeModes: (instanceId) =>
    bound === undefined ? Effect.undefined : bound.runtimeModes(instanceId),
  usage: (instanceId) => (bound === undefined ? Effect.undefined : bound.usage(instanceId)),
  refreshUsage: (instanceId) =>
    bound === undefined ? Effect.void : bound.refreshUsage(instanceId),
};

/**
 * Which entry made a native thread: the entry's id and its instance. The agent and the T3 thread
 * it runs for are absent on entries saved before they were kept.
 */
export interface NativeEntry {
  readonly entry: string;
  readonly instanceId: string;
  readonly agent?: string;
  readonly appThreadId?: string;
}

const roomMarks = makeStoredMap<RoomMark | number>();
/**
 * The entries' room, shared by every session: a limit is the account's, not the thread's. Claude and Codex
 * entries ask their account pool, the others their instance's own usage reading.
 */
export const room = makeRoom(Date.now, roomMarks, {
  pool: (step) => poolOf(step.provider),
  reading: (step, now) =>
    targets
      .usage(step.instanceId)
      .pipe(Effect.map((limits) => readingFromLimits(limits, step.model, now))),
  external: (step, now) => EndpointRoom.outUntil(step.instanceId, now),
  refresh: (step) => targets.refreshUsage(step.instanceId),
});
/** Runs the router saw end at a limit, for the fallback reactor. */
export const fallbacks = makeFallbackSignals();
/** Which chain entry made each native thread, by native id. */
export const nativeEntries = makeStoredMap<NativeEntry>();

/** Keeps the entry map and room marks in lastdrop's folder from now on (`Extensions.layer`). */
export const attachStore = (dataDir: string): Effect.Effect<void> =>
  Effect.sync(() => {
    nativeEntries.attach(NodePath.join(dataDir, "agent-threads.json"));
    roomMarks.attach(NodePath.join(dataDir, "agent-room.json"));
    attachCommandLog(dataDir);
    bindCatalogDir(dataDir);
  });
