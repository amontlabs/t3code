/**
 * Step 5 spike: a `ProviderAdapterV2` whose models are the user's agents, forwarding each session
 * to a native T3 instance's adapter. Persisted records name this instance; `driver` stays the
 * inner one (T3 branches on it); inner calls get the inner instance and the step's model back.
 */
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind } from "@t3tools/contracts";

import { stepSelection, type AgentDefinition, type AgentStep } from "./catalog.ts";

type Adapter = ProviderAdapterV2["Service"];

export interface DelegatingAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly agents: ReadonlyArray<AgentDefinition>;
  /** The native instance's adapter, looked up when a session opens (late: no layer cycle). */
  readonly resolveTarget: (instanceId: ProviderInstanceId) => Effect.Effect<Adapter | undefined>;
  /** Whether a step has room now; the first that has is used. Defaults to every step. */
  readonly hasRoom?: (step: AgentStep) => Effect.Effect<boolean>;
}

const LASTDROP_DRIVER = ProviderDriverKind.make("lastdrop");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Rewrites instance ids deep inside adapter records. `modelSelection` objects are swapped whole
 * (`selection`), other `providerInstanceId`/`instanceId`/`createdByProviderInstanceId` fields
 * equal to `from` become `to`. Non-plain objects (DateTime, Uint8Array) are left alone.
 */
const restamp = (
  value: unknown,
  from: ProviderInstanceId,
  to: ProviderInstanceId,
  selection: (inner: ModelSelection) => ModelSelection,
): unknown => {
  if (Array.isArray(value)) return value.map((entry) => restamp(entry, from, to, selection));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "modelSelection" || key === "currentModelSelection") &&
      isPlainObject(entry) &&
      entry.instanceId === from
    ) {
      out[key] = selection(entry as unknown as ModelSelection);
    } else if (
      (key === "providerInstanceId" ||
        key === "instanceId" ||
        key === "createdByProviderInstanceId") &&
      entry === from
    ) {
      out[key] = to;
    } else {
      out[key] = restamp(entry, from, to, selection);
    }
  }
  return out;
};

export const makeDelegatingAdapter = (options: DelegatingAdapterOptions): Adapter => {
  const outerId = options.instanceId;
  const firstAgent = options.agents[0]!;

  const pickStep = Effect.fn("LastdropAdapter.pickStep")(function* (agent: AgentDefinition) {
    for (const step of agent.chain) {
      if (options.hasRoom === undefined || (yield* options.hasRoom(step))) return step;
    }
    return undefined;
  });

  const openSession: Adapter["openSession"] = Effect.fn("LastdropAdapter.openSession")(
    function* (input) {
      const agent = options.agents.find(
        (candidate) => candidate.name === input.modelSelection.model,
      );
      const fail = (cause: unknown) =>
        new ProviderAdapterOpenSessionError({
          driver: LASTDROP_DRIVER,
          providerSessionId: input.providerSessionId,
          cause,
        });
      if (agent === undefined) return yield* fail(`No agent named ${input.modelSelection.model}.`);
      const step = yield* pickStep(agent);
      if (step === undefined) return yield* fail(`No step of ${agent.name} has room.`);
      const target = yield* options.resolveTarget(step.instanceId);
      if (target === undefined) return yield* fail(`No instance ${step.instanceId}.`);
      const innerId = step.instanceId;
      // Outer selection the session opened with; later turns may carry a new effort.
      let outerSelection: ModelSelection = input.modelSelection;
      const toInnerSelection = (outer: ModelSelection): ModelSelection => {
        outerSelection = outer;
        return stepSelection(step, outer);
      };
      const toInner = <A>(value: A): A => restamp(value, outerId, innerId, toInnerSelection) as A;
      const toOuter = <A>(value: A): A =>
        restamp(value, innerId, outerId, (inner) =>
          inner.model === step.model ? outerSelection : { ...inner, instanceId: outerId },
        ) as A;
      const mapEvents = (
        events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>,
      ): Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error> =>
        events.pipe(Stream.map((event) => toOuter(event)));

      const inner = yield* target.openSession(toInner(input));
      const forward = <I, O>(
        call: ((input: I) => Effect.Effect<O, ProviderAdapterV2Error>) | undefined,
      ) =>
        call === undefined
          ? undefined
          : (callInput: I) => call(toInner(callInput)).pipe(Effect.map((out) => toOuter(out)));

      const runtime: ProviderAdapterV2SessionRuntime = {
        ...inner,
        instanceId: outerId,
        providerSession: toOuter(inner.providerSession),
        events: mapEvents(inner.events),
        ...(inner.subscribeEvents === undefined
          ? {}
          : {
              subscribeEvents: inner.subscribeEvents.pipe(
                Effect.map((subscription) => ({
                  ...subscription,
                  events: mapEvents(subscription.events),
                })),
              ),
            }),
        ...(inner.hasPendingBackgroundWorkForThread === undefined
          ? {}
          : {
              hasPendingBackgroundWorkForThread: (providerThread, probe) =>
                inner.hasPendingBackgroundWorkForThread!(toInner(providerThread), probe),
            }),
        ...(inner.getModelContextWindow === undefined
          ? {}
          : {
              getModelContextWindow: (selection, cwd) =>
                inner.getModelContextWindow!(
                  toInner({ modelSelection: selection }).modelSelection,
                  cwd,
                ),
            }),
        ...(inner.canReuseContextUsage === undefined
          ? {}
          : {
              canReuseContextUsage: (previous, next) =>
                inner.canReuseContextUsage!(
                  toInner({ modelSelection: previous }).modelSelection,
                  toInner({ modelSelection: next }).modelSelection,
                ),
            }),
        ensureThread: forward(inner.ensureThread)!,
        resumeThread: forward(inner.resumeThread)!,
        startTurn: forward(inner.startTurn)!,
        steerTurn: forward(inner.steerTurn)!,
        interruptTurn: forward(inner.interruptTurn)!,
        respondToRuntimeRequest: forward(inner.respondToRuntimeRequest)!,
        readThreadSnapshot: forward(inner.readThreadSnapshot)!,
        rollbackThread: forward(inner.rollbackThread)!,
        forkThread: forward(inner.forkThread)!,
      };
      const optional = {
        injectHistory: forward(inner.injectHistory),
        compactThread: forward(inner.compactThread),
        stopTask: forward(inner.stopTask),
        awaitBackgroundTasks: forward(inner.awaitBackgroundTasks),
        stopSubagent: forward(inner.stopSubagent),
        unloadThread: forward(inner.unloadThread),
        uploadFeedback: forward(inner.uploadFeedback),
      };
      const mcpApps =
        inner.mcpApps === undefined
          ? undefined
          : {
              listTools: forward(inner.mcpApps.listTools)!,
              callTool: forward(inner.mcpApps.callTool)!,
              readResource: forward(inner.mcpApps.readResource)!,
            };
      return Object.assign(
        runtime,
        Object.fromEntries(Object.entries(optional).filter(([, call]) => call !== undefined)),
        mcpApps === undefined ? {} : { mcpApps },
      ) as ProviderAdapterV2SessionRuntime;
    },
  );

  // Capabilities and transitions come from the first agent's first step: the spike forwards to
  // one instance. The real driver must answer per agent (see the report).
  const firstTarget = options.resolveTarget(firstAgent.chain[0]!.instanceId).pipe(
    Effect.filterOrElse(
      (target): target is Adapter => target !== undefined,
      () => Effect.die(`No instance ${firstAgent.chain[0]!.instanceId}.`),
    ),
  );
  return {
    instanceId: outerId,
    driver: LASTDROP_DRIVER,
    getCapabilities: () =>
      firstTarget.pipe(
        Effect.flatMap((target) => target.getCapabilities()),
        Effect.orDie,
      ),
    planSelectionTransition: (input) =>
      input.current.model === input.target.model
        ? firstTarget.pipe(
            Effect.flatMap((target) =>
              target.planSelectionTransition({
                ...input,
                current: stepSelection(firstAgent.chain[0]!, input.current),
                target: stepSelection(firstAgent.chain[0]!, input.target),
              }),
            ),
            Effect.orDie,
          )
        : // Another agent may run elsewhere: a new provider thread with T3's handoff.
          Effect.succeed({ type: "create_with_handoff" as const }),
    openSession,
  };
};
