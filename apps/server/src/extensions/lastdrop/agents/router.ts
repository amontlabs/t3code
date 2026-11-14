/**
 * The agents adapter: each session runs on one entry of its agent's chain, forwarded to that
 * entry's native instance. Records name the lastdrop instance, `driver` stays the inner one. At a
 * usage limit partway it marks the entry out, adds a notice and signals `fallback.ts`.
 */
import {
  ProviderDriverKind,
  TurnItemId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type RunId,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterResumeThreadError,
  type ProviderAdapterV2,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";

import { stepLabel, stepSelection, type AgentDefinition, type AgentStep } from "./catalog.ts";
import { entryRuntimePolicy } from "./permissions.ts";
import type { FallbackSignals, Room } from "./room.ts";

type Adapter = ProviderAdapterV2["Service"];

const LASTDROP_DRIVER = ProviderDriverKind.make("lastdropAgents");

export interface RouterOptions {
  readonly instanceId: ProviderInstanceId;
  /** The agents now (the catalog reloads live). */
  readonly agents: () => ReadonlyArray<AgentDefinition>;
  /**
   * The native instance's adapter, looked up when a session opens (late: no layer cycle).
   * Undefined when the instance is missing or disabled: the entry is skipped like one without room.
   */
  readonly resolveTarget: (instanceId: ProviderInstanceId) => Effect.Effect<Adapter | undefined>;
  readonly room: Room;
  readonly fallbacks: FallbackSignals;
  /** Which chain entry made each native thread, by native id; shared by the driver's sessions. */
  readonly nativeSteps?: Map<string, string>;
  /** The models the entry's instance publishes, for its effort option's id and levels. */
  readonly innerModels?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProviderModel> | undefined>;
}

/** Maps the runtime policy at the top of an adapter input to what the entry's instance needs. */
const withEntryPolicy = <A>(step: AgentStep, value: A): A =>
  isPlainObject(value) && isPlainObject(value.runtimePolicy)
    ? ({
        ...value,
        runtimePolicy: entryRuntimePolicy(step, value.runtimePolicy as never),
      } as A)
    : value;

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

/** A chain entry's identity: instance, model and effort (the same model at two efforts differs). */
const stepId = (step: AgentStep): string => `${step.instanceId}/${step.model}/${step.effort ?? ""}`;

export const makeRouterAdapter = (options: RouterOptions): Adapter => {
  const outerId = options.instanceId;
  const nativeSteps = options.nativeSteps ?? new Map<string, string>();

  const findAgent = (name: string) =>
    options.agents().find((candidate) => candidate.enabled && candidate.name === name);

  /** The entry and its adapter, when its instance exists and it has room. */
  const usable = Effect.fn("LastdropRouter.usable")(function* (step: AgentStep) {
    const target = yield* options.resolveTarget(step.instanceId);
    if (target === undefined) return undefined;
    if (!(yield* options.room.hasRoom(step))) return undefined;
    return target;
  });

  /** The first usable entry at or after `from`. */
  const pickFrom = Effect.fn("LastdropRouter.pickFrom")(function* (
    agent: AgentDefinition,
    from: number,
  ) {
    for (let index = from; index < agent.chain.length; index++) {
      const step = agent.chain[index]!;
      const target = yield* usable(step);
      if (target !== undefined) return { index, step, target };
    }
    return undefined;
  });

  const openSession: Adapter["openSession"] = Effect.fn("LastdropRouter.openSession")(
    function* (input) {
      const fail = (cause: unknown) =>
        new ProviderAdapterOpenSessionError({
          driver: LASTDROP_DRIVER,
          providerSessionId: input.providerSessionId,
          cause,
        });
      const agent = findAgent(input.modelSelection.model);
      if (agent === undefined)
        return yield* fail(`lastdrop has no agent named ${input.modelSelection.model}.`);
      // A thread already on an entry stays there while it has room: no handoff for nothing.
      const previousId =
        input.initialNativeThreadId === undefined
          ? undefined
          : nativeSteps.get(input.initialNativeThreadId);
      const previousIndex = agent.chain.findIndex((step) => stepId(step) === previousId);
      const kept =
        previousIndex < 0
          ? undefined
          : yield* usable(agent.chain[previousIndex]!).pipe(
              Effect.map((target) =>
                target === undefined
                  ? undefined
                  : { index: previousIndex, step: agent.chain[previousIndex]!, target },
              ),
            );
      let picked = kept ?? (yield* pickFrom(agent, 0));
      // An entry that fails to open is skipped for the next one (sign-in, missing CLI).
      let inner: ProviderAdapterV2SessionRuntime | undefined;
      let models: ReadonlyArray<ServerProviderModel> | undefined;
      let lastCause: unknown = undefined;
      while (picked !== undefined) {
        const { step, target } = picked;
        const innerModels =
          options.innerModels === undefined
            ? undefined
            : yield* options.innerModels(step.instanceId);
        const sameEntry = previousId === stepId(step);
        const innerInput = {
          ...input,
          modelSelection: stepSelection(step, input.modelSelection, innerModels),
          // Another entry's native thread and session mean nothing to this one.
          ...(sameEntry ? {} : { initialNativeThreadId: undefined, resumeFromSession: undefined }),
        };
        const opened = yield* Effect.result(
          target.openSession(
            withEntryPolicy(
              step,
              restamp(
                innerInput,
                outerId,
                step.instanceId,
                (selection) => selection,
              ) as typeof input,
            ),
          ),
        );
        if (opened._tag === "Success") {
          inner = opened.success;
          models = innerModels;
          break;
        }
        lastCause = opened.failure;
        picked = yield* pickFrom(agent, picked.index + 1);
      }
      if (picked === undefined || inner === undefined)
        return yield* fail(
          lastCause ??
            `No entry of ${agent.name} has room: ${agent.chain.map(stepLabel).join(", ")}.`,
        );
      return makeSession({
        agent,
        ...picked,
        inner,
        innerModels: models,
        outerSelection: input.modelSelection,
      });
    },
  );

  const makeSession = (session: {
    readonly agent: AgentDefinition;
    readonly index: number;
    readonly step: AgentStep;
    readonly target: Adapter;
    readonly inner: ProviderAdapterV2SessionRuntime;
    readonly innerModels: ReadonlyArray<ServerProviderModel> | undefined;
    readonly outerSelection: ModelSelection;
  }): ProviderAdapterV2SessionRuntime => {
    const { agent, step, inner } = session;
    const innerId = step.instanceId;
    const thisStep = stepId(step);
    let outerSelection = session.outerSelection;
    /** The turn each provider thread runs now: a notice row needs its run and node. */
    const turns = new Map<
      string,
      { readonly threadId: ThreadId; readonly runId: RunId; readonly nodeId: NodeId }
    >();

    const toInnerSelection = (outer: ModelSelection): ModelSelection => {
      if (outer.instanceId !== outerId) return outer;
      outerSelection = outer;
      return stepSelection(step, outer, session.innerModels);
    };
    const toInner = <A>(value: A): A =>
      withEntryPolicy(step, restamp(value, outerId, innerId, toInnerSelection) as A);
    const toOuter = <A>(value: A): A =>
      restamp(value, innerId, outerId, (selection) =>
        selection.model === step.model ? outerSelection : { ...selection, instanceId: outerId },
      ) as A;

    const remember = (thread: OrchestrationV2ProviderThread) => {
      const nativeId = thread.nativeThreadRef?.nativeId;
      if (nativeId != null) nativeSteps.set(nativeId, thisStep);
      return thread;
    };

    /** At a usage limit: mark the entry out; with a next entry, a notice and a signal to go on. */
    const atTerminal = Effect.fn("LastdropRouter.atTerminal")(function* (
      event: Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>,
    ) {
      if (event.status !== "failed" || event.failure?.class !== "usage_limit") return [event];
      yield* options.room.markOut(step, event.failure.resetAt);
      const next = yield* pickFrom(agent, session.index + 1);
      const turn = turns.get(event.providerThreadId);
      if (next === undefined || turn === undefined) return [event];
      const message = `${agent.name} reached a usage limit on ${stepLabel(step)}. lastdrop continues on ${stepLabel(next.step)}, with this conversation handed over.`;
      yield* options.fallbacks.offer({
        threadId: turn.threadId,
        agent: agent.name,
        from: stepLabel(step),
        to: stepLabel(next.step),
      });
      const now = yield* DateTime.now;
      const notice: ProviderAdapterV2Event = {
        type: "turn_item.updated",
        driver: event.driver,
        turnItem: {
          id: TurnItemId.make(`lastdrop-fallback:${event.providerTurnId}`),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.nodeId,
          providerThreadId: event.providerThreadId,
          providerTurnId: event.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: (event.failureItemOrdinal ?? event.runOrdinal * 100) + 1,
          status: "completed",
          title: "Continuing on the next model",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "system_notice",
          message,
        },
      } as ProviderAdapterV2Event;
      return [notice, event];
    });

    const mapEvents = (
      events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>,
    ): Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error> =>
      events.pipe(
        Stream.mapEffect((event) =>
          event.type === "turn.terminal" ? atTerminal(event) : Effect.succeed([event]),
        ),
        Stream.flatMap((batch) => Stream.fromIterable(batch)),
        Stream.map((event) => toOuter(event)),
      );

    const forward = <I, O>(
      call: ((input: I) => Effect.Effect<O, ProviderAdapterV2Error>) | undefined,
    ) =>
      call === undefined
        ? undefined
        : (callInput: I) => call(toInner(callInput)).pipe(Effect.map((out) => toOuter(out)));

    /** The thread came from another chain entry (or provider): this session cannot resume it. */
    const fromOtherEntry = (thread: OrchestrationV2ProviderThread): boolean => {
      const nativeId = thread.nativeThreadRef?.nativeId;
      const made = nativeId == null ? undefined : nativeSteps.get(nativeId);
      if (made !== undefined) return made !== thisStep;
      return thread.driver !== inner.driver;
    };

    const threadCall = <I, O>(call: (input: I) => Effect.Effect<O, ProviderAdapterV2Error>) =>
      forward(call)!;

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
      ensureThread: (input) => {
        const existing = input.existingProviderThread;
        // A row another entry made keeps its id; its native parts are this entry's to make.
        const adopted =
          existing !== undefined && fromOtherEntry(existing)
            ? {
                ...input,
                existingProviderThread: {
                  ...existing,
                  driver: inner.driver,
                  nativeThreadRef: null,
                  nativeConversationHeadRef: null,
                  nativeMetadata: null,
                  goal: null,
                },
              }
            : input;
        return threadCall(inner.ensureThread)(adopted).pipe(Effect.map(remember));
      },
      resumeThread: (input) =>
        fromOtherEntry(input.providerThread)
          ? Effect.fail(
              new ProviderAdapterResumeThreadError({
                driver: inner.driver,
                providerSessionId: inner.providerSessionId,
                providerThreadId: input.providerThread.id,
                cause: `This thread's conversation is on another entry of ${agent.name}; it continues on ${stepLabel(step)} with a handoff.`,
              }),
            )
          : threadCall(inner.resumeThread)(input).pipe(Effect.map(remember)),
      startTurn: (input) => {
        turns.set(input.providerThread.id, {
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
        });
        return threadCall(inner.startTurn)(input);
      },
      steerTurn: threadCall(inner.steerTurn),
      interruptTurn: threadCall(inner.interruptTurn),
      respondToRuntimeRequest: threadCall(inner.respondToRuntimeRequest),
      readThreadSnapshot: threadCall(inner.readThreadSnapshot),
      rollbackThread: threadCall(inner.rollbackThread),
      forkThread: (input) => threadCall(inner.forkThread)(input).pipe(Effect.map(remember)),
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
  };

  /** The entry a new session of `model` would open on now, for capabilities and transitions. */
  const currentEntry = Effect.fn("LastdropRouter.currentEntry")(function* (model?: string) {
    const agents = options.agents();
    const agent = (model === undefined ? undefined : findAgent(model)) ?? agents[0];
    if (agent === undefined) return undefined;
    return yield* pickFrom(agent, 0);
  });

  return {
    instanceId: outerId,
    driver: LASTDROP_DRIVER,
    getCapabilities: () =>
      currentEntry().pipe(
        Effect.flatMap((entry) =>
          entry === undefined
            ? Effect.die("lastdrop has no agent with room.")
            : entry.target.getCapabilities(),
        ),
        Effect.orDie,
      ),
    planSelectionTransition: (input) =>
      input.current.model !== input.target.model
        ? // Another agent may run elsewhere: a new provider thread with T3's handoff.
          Effect.succeed({ type: "create_with_handoff" as const })
        : currentEntry(input.target.model).pipe(
            Effect.flatMap((entry) =>
              entry === undefined
                ? Effect.succeed({ type: "create_with_handoff" as const })
                : entry.target.planSelectionTransition({
                    ...input,
                    current: stepSelection(entry.step, input.current),
                    target: stepSelection(entry.step, input.target),
                  }),
            ),
            Effect.orDie,
          ),
    openSession,
  };
};
