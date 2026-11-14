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
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
  type RunId,
  type RuntimeMode,
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

import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";

import { stepLabel, stepSelection, type AgentDefinition, type AgentStep } from "./catalog.ts";
import { entryRuntimePolicy } from "./permissions.ts";
import { isUsageLimit } from "../endpointRoom.ts";
import type { FallbackSignals, Room } from "./room.ts";
import type { NativeEntry } from "./shared.ts";
import { makeStoredMap, type StoredMap } from "./store.ts";

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
  /** Which entry made each native thread, by native id; shared by the driver's sessions. */
  readonly nativeEntries?: StoredMap<NativeEntry>;
  /** The runtime modes the entry's instance supports (its snapshot's). */
  readonly innerRuntimeModes?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<RuntimeMode> | undefined>;
  /** The models the entry's instance publishes, for its effort option's id and levels. */
  readonly innerModels?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProviderModel> | undefined>;
}

/** Maps the runtime policy at the top of an adapter input to what the entry's instance needs. */
const withEntryPolicy = <A>(
  step: AgentStep,
  supported: ReadonlyArray<RuntimeMode> | undefined,
  value: A,
): A =>
  isPlainObject(value) && isPlainObject(value.runtimePolicy)
    ? ({
        ...value,
        runtimePolicy: entryRuntimePolicy(step, value.runtimePolicy as never, supported),
      } as A)
    : value;

/**
 * Capabilities every target offers: booleans all must be true, numbers the least, arrays the
 * common values; the first target's other values. Instance-level calls carry no thread.
 */
const intersect = (values: ReadonlyArray<unknown>): unknown => {
  const [first, ...rest] = values;
  if (rest.length === 0) return first;
  if (typeof first === "boolean") return values.every((value) => value === true);
  if (typeof first === "number")
    return Math.min(...values.filter((value): value is number => typeof value === "number"));
  if (Array.isArray(first))
    return first.filter((item) =>
      rest.every((value) => Array.isArray(value) && value.includes(item)),
    );
  if (isPlainObject(first)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(first))
      out[key] = intersect(values.map((value) => (isPlainObject(value) ? value[key] : undefined)));
    return out;
  }
  return first;
};

/** "2026-11-18 15:37 UTC". */
const clock = (epochMs: number): string =>
  `${DateTime.formatIso(DateTime.makeUnsafe(epochMs)).slice(0, 16).replace("T", " ")} UTC`;

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

interface Picked {
  readonly index: number;
  readonly step: AgentStep;
  readonly target: Adapter;
}

export const makeRouterAdapter = (options: RouterOptions): Adapter => {
  const outerId = options.instanceId;
  const nativeEntries = options.nativeEntries ?? makeStoredMap<NativeEntry>();

  const findAgent = (name: string) =>
    options.agents().find((candidate) => candidate.enabled && candidate.name === name);

  /** The entry's adapter when its instance exists and it has room; else why not. */
  const check = Effect.fn("LastdropRouter.check")(function* (step: AgentStep) {
    const target = yield* options.resolveTarget(step.instanceId);
    if (target === undefined) return { reason: `${stepLabel(step)} is not set up` } as const;
    if (!(yield* options.room.hasRoom(step))) {
      const until = options.room.outUntil(step);
      return {
        reason: `${stepLabel(step)} reached a usage limit${until === undefined ? "" : ` (until ${clock(until)})`}`,
      } as const;
    }
    return { target } as const;
  });

  /** The first usable entry, in `order`. */
  const firstUsable = Effect.fn("LastdropRouter.firstUsable")(function* (
    agent: AgentDefinition,
    order: ReadonlyArray<number>,
  ) {
    for (const index of order) {
      const step = agent.chain[index]!;
      const checked = yield* check(step);
      if ("target" in checked) return { index, step, target: checked.target } satisfies Picked;
    }
    return undefined;
  });

  const chainOrder = (agent: AgentDefinition, first?: number) => [
    ...(first === undefined ? [] : [first]),
    ...agent.chain.map((_, index) => index).filter((index) => index !== first),
  ];

  /**
   * The entry that made the session's native thread: from the stored map, else from the previous
   * session's driver when exactly one entry runs on it. Unknown means it is never resumed.
   */
  const previousEntry = Effect.fn("LastdropRouter.previousEntry")(function* (
    agent: AgentDefinition,
    input: Parameters<Adapter["openSession"]>[0],
  ) {
    const nativeId = input.initialNativeThreadId;
    if (nativeId === undefined) return undefined;
    const stored = nativeEntries.get(nativeId);
    if (stored !== undefined) {
      const index = agent.chain.findIndex((step) => stepId(step) === stored.entry);
      return index >= 0
        ? index
        : agent.chain.findIndex((step) => step.instanceId === stored.instanceId);
    }
    const driver = input.resumeFromSession?.driver;
    if (driver === undefined) return undefined;
    const drivers = yield* Effect.forEach(agent.chain, (step) =>
      options.resolveTarget(step.instanceId).pipe(Effect.map((target) => target?.driver)),
    );
    const matches = drivers.flatMap((each, index) => (each === driver ? [index] : []));
    return matches.length === 1 ? matches[0] : undefined;
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
      const previous = yield* previousEntry(agent, input);
      const known = previous !== undefined && previous >= 0 ? previous : undefined;
      // A thread stays on its entry while it has room; else the chain in order. Each entry is
      // checked and opened once; the notice names the one that opened, and why others did not.
      const skipped: Array<string> = [];
      for (const index of chainOrder(agent, known)) {
        const step = agent.chain[index]!;
        const checked = yield* check(step);
        if (!("target" in checked)) {
          skipped.push(checked.reason);
          continue;
        }
        const target = checked.target;
        const innerModels =
          options.innerModels === undefined
            ? undefined
            : yield* options.innerModels(step.instanceId);
        const supported =
          options.innerRuntimeModes === undefined
            ? undefined
            : yield* options.innerRuntimeModes(step.instanceId);
        const sameEntry = index === known;
        const innerInput = {
          ...input,
          modelSelection: stepSelection(step, input.modelSelection, innerModels),
          // Another entry's native thread and session are never resumed here.
          ...(sameEntry ? {} : { initialNativeThreadId: undefined, resumeFromSession: undefined }),
        };
        const opened = yield* Effect.result(
          target.openSession(
            withEntryPolicy(
              step,
              supported,
              restamp(
                innerInput,
                outerId,
                step.instanceId,
                (selection) => selection,
              ) as typeof input,
            ),
          ),
        );
        if (opened._tag === "Failure") {
          skipped.push(`${stepLabel(step)} failed to open`);
          continue;
        }
        const moved = known !== undefined ? index !== known : index !== 0;
        const notice = !moved
          ? undefined
          : known !== undefined
            ? `${agent.name} continues on ${stepLabel(step)}: ${skipped.join("; ")}. The conversation is handed over.`
            : `${agent.name} runs on ${stepLabel(step)}: ${skipped.join("; ")}.`;
        return makeSession({
          agent,
          index,
          step,
          target,
          inner: opened.success,
          innerModels,
          supported,
          outerSelection: input.modelSelection,
          adoptedNativeId: sameEntry ? input.initialNativeThreadId : undefined,
          openNotice: notice,
        });
      }
      return yield* fail(`No entry of ${agent.name} can run: ${skipped.join("; ")}.`);
    },
  );

  const makeSession = (session: {
    readonly agent: AgentDefinition;
    readonly index: number;
    readonly step: AgentStep;
    readonly target: Adapter;
    readonly inner: ProviderAdapterV2SessionRuntime;
    readonly innerModels: ReadonlyArray<ServerProviderModel> | undefined;
    readonly supported: ReadonlyArray<RuntimeMode> | undefined;
    readonly outerSelection: ModelSelection;
    /** The native thread this session resumes, when the entry was inferred, not stored. */
    readonly adoptedNativeId: string | undefined;
    readonly openNotice: string | undefined;
  }): ProviderAdapterV2SessionRuntime => {
    const { agent, step, inner } = session;
    const innerId = step.instanceId;
    const thisStep = stepId(step);
    let outerSelection = session.outerSelection;
    let pendingNotice = session.openNotice;
    /** The turn each provider thread runs now: a notice row needs its run and node. */
    const turns = new Map<
      string,
      { readonly threadId: ThreadId; readonly runId: RunId; readonly nodeId: NodeId }
    >();
    if (session.adoptedNativeId !== undefined)
      nativeEntries.set(session.adoptedNativeId, { entry: thisStep, instanceId: innerId });

    const toInnerSelection = (outer: ModelSelection): ModelSelection => {
      if (outer.instanceId !== outerId) return outer;
      outerSelection = outer;
      return stepSelection(step, outer, session.innerModels);
    };
    const toInner = <A>(value: A): A =>
      withEntryPolicy(
        step,
        session.supported,
        restamp(value, outerId, innerId, toInnerSelection) as A,
      );
    const toOuter = <A>(value: A): A =>
      restamp(value, innerId, outerId, (selection) =>
        selection.model === step.model ? outerSelection : { ...selection, instanceId: outerId },
      ) as A;

    const remember = (thread: OrchestrationV2ProviderThread) => {
      const nativeId = thread.nativeThreadRef?.nativeId;
      if (nativeId != null) nativeEntries.set(nativeId, { entry: thisStep, instanceId: innerId });
      return thread;
    };

    const noticeEvent = Effect.fn("LastdropRouter.noticeEvent")(function* (input: {
      readonly driver: ProviderAdapterV2Event["driver"];
      readonly providerThreadId: string;
      readonly providerTurnId: string;
      readonly ordinal: number;
      readonly title: string;
      readonly message: string;
    }) {
      const turn = turns.get(input.providerThreadId);
      if (turn === undefined) return undefined;
      const now = yield* DateTime.now;
      return {
        type: "turn_item.updated",
        driver: input.driver,
        turnItem: {
          id: TurnItemId.make(`lastdrop-notice:${input.providerTurnId}:${input.ordinal}`),
          threadId: turn.threadId,
          runId: turn.runId,
          nodeId: turn.nodeId,
          providerThreadId: input.providerThreadId,
          providerTurnId: input.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: input.ordinal,
          status: "completed",
          title: input.title,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "system_notice",
          message: input.message,
        },
      } as ProviderAdapterV2Event;
    });

    /** The first turn of a session that is not on the agent's usual entry says which one runs. */
    const atTurnStart = Effect.fn("LastdropRouter.atTurnStart")(function* (
      event: Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }>,
    ) {
      if (pendingNotice === undefined) return [event];
      const notice = yield* noticeEvent({
        driver: event.driver,
        providerThreadId: event.providerTurn.providerThreadId,
        providerTurnId: event.providerTurn.id,
        ordinal: 0,
        title: `Running on ${stepLabel(step)}`,
        message: pendingNotice,
      });
      if (notice === undefined) return [event];
      pendingNotice = undefined;
      return [event, notice];
    });

    /** At a usage limit: mark the entry out; when another entry can run, say so and go on. */
    const atTerminal = Effect.fn("LastdropRouter.atTerminal")(function* (
      event: Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>,
    ) {
      if (event.status !== "failed" || !isUsageLimit(step.provider, event.failure)) return [event];
      yield* options.room.markOut(step, event.failure.resetAt);
      const other = yield* firstUsable(
        agent,
        agent.chain.map((_, index) => index).filter((index) => index !== session.index),
      );
      const turn = turns.get(event.providerThreadId);
      if (other === undefined || turn === undefined) return [event];
      yield* options.fallbacks.offer({
        threadId: turn.threadId,
        agent: agent.name,
        from: stepLabel(step),
      });
      const notice = yield* noticeEvent({
        driver: event.driver,
        providerThreadId: event.providerThreadId,
        providerTurnId: event.providerTurnId,
        ordinal: (event.failureItemOrdinal ?? event.runOrdinal * 100) + 1,
        title: "Continuing on another entry",
        message: `${agent.name} reached a usage limit on ${stepLabel(step)}. lastdrop continues on the next entry with room; the next run names it.`,
      });
      return notice === undefined ? [event] : [notice, event];
    });

    const mapEvents = (
      events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>,
    ): Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error> =>
      events.pipe(
        Stream.mapEffect((event) =>
          event.type === "turn.terminal"
            ? atTerminal(event)
            : event.type === "provider_turn.updated"
              ? atTurnStart(event)
              : Effect.succeed([event]),
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

    /**
     * The native thread is not this instance's: made on another instance, or by an entry nobody
     * recorded. A native thread is never resumed on a different instance.
     */
    const fromOtherEntry = (thread: OrchestrationV2ProviderThread): boolean => {
      const nativeId = thread.nativeThreadRef?.nativeId;
      if (nativeId == null) return thread.driver !== inner.driver;
      const made = nativeEntries.get(nativeId);
      return made === undefined || made.instanceId !== innerId;
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
          existing !== undefined && (fromOtherEntry(existing) || existing.driver !== inner.driver)
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

  /** The entry a new session of `model` would open on now, for transitions. */
  const currentEntry = Effect.fn("LastdropRouter.currentEntry")(function* (model: string) {
    const agent = findAgent(model);
    if (agent === undefined) return undefined;
    return yield* firstUsable(agent, chainOrder(agent));
  });

  /** What every target instance offers; T3's ACP defaults when none is set up. Never fails. */
  const capabilities = Effect.fn("LastdropRouter.capabilities")(function* () {
    const ids = [
      ...new Set(options.agents().flatMap((agent) => agent.chain.map((step) => step.instanceId))),
    ];
    const found = yield* Effect.forEach(ids, (id) =>
      options
        .resolveTarget(id)
        .pipe(
          Effect.flatMap((target) =>
            target === undefined
              ? Effect.undefined
              : target.getCapabilities().pipe(Effect.orElseSucceed(() => undefined)),
          ),
        ),
    );
    const known = found.filter(
      (caps): caps is OrchestrationV2ProviderCapabilities => caps !== undefined,
    );
    return known.length === 0
      ? AcpProviderCapabilitiesV2
      : (intersect(known) as OrchestrationV2ProviderCapabilities);
  });

  return {
    instanceId: outerId,
    driver: LASTDROP_DRIVER,
    getCapabilities: capabilities,
    planSelectionTransition: (input) =>
      input.current.model !== input.target.model
        ? // Another agent may run elsewhere: a new provider thread with T3's handoff.
          Effect.succeed({ type: "create_with_handoff" as const })
        : currentEntry(input.target.model).pipe(
            Effect.flatMap((entry) =>
              entry === undefined
                ? Effect.succeed({ type: "create_with_handoff" as const })
                : entry.target
                    .planSelectionTransition({
                      ...input,
                      current: stepSelection(entry.step, input.current),
                      target: stepSelection(entry.step, input.target),
                    })
                    .pipe(Effect.orElseSucceed(() => ({ type: "create_with_handoff" as const }))),
            ),
          ),
    openSession,
  };
};
