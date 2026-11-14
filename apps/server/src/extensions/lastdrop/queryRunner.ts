/**
 * Wraps T3's Claude query runner: picks the account per `open`, moves a thread only as a fork under a new id,
 * translates every native id T3 passes back, and retries or ends a query at a passing error or a usage limit,
 * all from the runner's inputs and the SDK stream. Never edits the adapter or kills a process. See docs/lastdrop/claude-routing.md.
 */
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  classifyResult,
  limitKind,
  parseClaudeResult,
  RETRY_PROMPT,
  RetryMachine,
  retryDelayMs,
  type Route,
  type RouteInput,
  standardRetryPolicy,
  type ThreadIdentity,
} from "@t3tools/lastdrop-node";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  type ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQueryRunnerError,
  type ClaudeAgentSdkQueryRunnerShape,
  type ClaudeAgentSdkQuerySession,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

/** The router's surface the wrapper uses (lastdrop-node's `ThreadRouter`; tests may stand in another). */
export interface QueryRouter {
  route(input: RouteInput): Promise<Route>;
  recorded(input: Pick<RouteInput, "identity" | "env">): Promise<Route>;
  currentSession(session: string): Promise<string>;
  messageId(session: string, uuid: string): Promise<{ session: string; uuid: string }>;
  lineage(session: string): Promise<ReadonlyArray<string>>;
  recordFork(source: string, forked: string): Promise<void>;
  markFull(account: string): void;
  markTroubled(account: string): void;
  signInWorks(account: string): Promise<boolean>;
  limitNotice(
    account: string,
    model: string | undefined,
    delegated: boolean,
  ): Promise<{ readonly notice: string; readonly to: string | undefined }>;
}

/** Where a thread sits in T3's projection: a delegated child picks with the subagents' rule. */
export interface ThreadLineage {
  readonly delegated: boolean;
  readonly parentThreadId?: string | undefined;
}

export interface WrapOptions {
  readonly router: QueryRouter;
  /** The thread's lineage from T3's projection; a main thread when unknown. */
  readonly lineage: (threadId: string) => Effect.Effect<ThreadLineage>;
  /** The environment a query runs with when T3 sets none (the runner's own default). */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  /** Waits between retries; tests pass their own. */
  readonly sleep?: (ms: number) => Effect.Effect<void>;
  /** -1...1, the retry jitter. */
  readonly random?: Effect.Effect<number>;
  readonly log?: (line: string) => void;
  /** Choosing an account never holds a thread up longer than this; then it opens where it was. */
  readonly deadlineMs?: number;
}

/** lastdrop's own bookkeeping failed; the query then opens as T3 asked (or where it was). */
export class LastdropRoutingError extends Schema.TaggedError<LastdropRoutingError>()(
  "LastdropRoutingError",
  { cause: Schema.Defect() },
) {}

const IDENTITY_KEYS = ["sessionId", "resume", "resumeSessionAt", "forkSession"] as const;

/** The SDK options that name the conversation, as the wrapper reads them from `open`'s input. */
export function identityOf(options: ClaudeAgentSdkQueryOpenInput["options"]): ThreadIdentity {
  const o = options as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  return {
    ...(str("sessionId") === undefined ? {} : { sessionId: str("sessionId") }),
    ...(str("resume") === undefined ? {} : { resume: str("resume") }),
    ...(str("resumeSessionAt") === undefined ? {} : { resumeSessionAt: str("resumeSessionAt") }),
    ...(o["forkSession"] === true ? { forkSession: true } : {}),
  };
}

/** `options` with the identity replaced (the SDK takes `sessionId` beside `resume` once `forkSession` is set). */
export function withIdentity(
  options: ClaudeAgentSdkQueryOpenInput["options"],
  identity: ThreadIdentity,
  env: Record<string, string> | undefined,
): ClaudeAgentSdkQueryOpenInput["options"] {
  const rest: Record<string, unknown> = { ...options };
  for (const key of IDENTITY_KEYS) delete rest[key];
  for (const key of IDENTITY_KEYS) if (identity[key] !== undefined) rest[key] = identity[key];
  if (env !== undefined) rest["env"] = env;
  return rest as unknown as ClaudeAgentSdkQueryOpenInput["options"];
}

/**
 * A notice the adapter shows in the thread (`system_notice` turn item: an `informational` notice). Its uuid
 * becomes the turn item's id, so it is random: a counter would repeat after a restart.
 */
function noticeMessage(content: string, sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "informational",
    level: "notice",
    content,
    // @effect-diagnostics-next-line cryptoRandomUUID:off - a message id built in plain code, like the SDK's own.
    uuid: globalThis.crypto.randomUUID(),
    session_id: sessionId,
  } as unknown as SDKSystemMessage;
}

/** The message a query is told to continue with after a passing error. */
const continueMessage = (): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: RETRY_PROMPT },
    parent_tool_use_id: null,
    session_id: "",
  }) as SDKUserMessage;

const isResult = (m: SDKMessage): m is SDKResultMessage => m.type === "result";

/** A `rate_limit_event` saying the account's limit refused the request. */
function isRejectedRateLimit(m: SDKMessage): boolean {
  if (m.type !== "rate_limit_event") return false;
  const info = (m as { rate_limit_info?: { status?: unknown } }).rate_limit_info;
  return info?.status === "rejected";
}

/** The result with the notice as its error, so the turn's failure in T3 reads it too. */
function withNotice(message: SDKResultMessage, notice: string): SDKResultMessage {
  const errors = (message as { errors?: unknown }).errors;
  return {
    ...message,
    errors: [notice, ...(Array.isArray(errors) ? errors : [])],
  } as SDKResultMessage;
}

interface Step {
  readonly emit: ReadonlyArray<SDKMessage>;
  /** The query ends after these: the next message opens again, on another account. */
  readonly end: boolean;
}

/** Wraps a query runner; with no accounts to choose from every call goes through as it was. */
export function wrapQueryRunner(
  inner: ClaudeAgentSdkQueryRunnerShape,
  options: WrapOptions,
): ClaudeAgentSdkQueryRunnerShape {
  const { router } = options;
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => Effect.sleep(Duration.millis(ms)));
  const random = options.random ?? Random.nextBetween(-1, 1);
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new LastdropRoutingError({ cause }) });

  const deadline = Duration.millis(options.deadlineMs ?? 3000);
  /** Refuses the open: never Main's sign-in with an id another account has seen. */
  const refuse = (threadId: string, why: string) =>
    Effect.fail(
      new ClaudeAgentSdkQueryRunnerError({
        method: "open",
        cause: new Error(
          `lastdrop couldn't open this thread on its Claude account (${why}). Send the message again; if it keeps failing, check ~/.t3/lastdrop/lastdrop.log.`,
        ),
      }),
    ).pipe(Effect.tap(() => Effect.sync(() => log(`thread ${threadId}: open refused (${why})`))));

  const watch = (
    session: ClaudeAgentSdkQuerySession,
    route: Route | undefined,
    input: { readonly model: string | undefined; readonly delegated: boolean },
  ): ClaudeAgentSdkQuerySession => {
    const account = route?.decision?.account;
    if (account === undefined) return session;
    const label = (route?.decision?.session ?? "").slice(0, 8);
    const machine = new RetryMachine<SDKMessage>((failures: number, r: number) =>
      retryDelayMs(standardRetryPolicy, failures, r),
    );
    let pendingNotice = route?.notice;
    let rejected = false;
    let released: Deferred.Deferred<SDKMessage> | undefined;
    let closed = false;
    const closeOnce = Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      // A retry waiting: its held result goes to T3 now, so the stream never waits out the timer.
      const held = machine.release();
      if (held !== undefined && released !== undefined)
        Deferred.doneUnsafe(released, Effect.succeed(held));
      return session.close;
    });

    /** T3 spoke (a message, a stop) while a retry waited: the held result goes first. */
    const releaseHeld = Effect.sync(() => {
      const line = machine.fromParent(true);
      if (line !== undefined && released !== undefined) {
        log(`thread ${label}: T3 spoke while a retry waited; the held error goes through`);
        Deferred.doneUnsafe(released, Effect.succeed(line));
      }
    });

    const step = Effect.fn("LastdropQueryRunner.step")(function* (message: SDKMessage) {
      const lead: SDKMessage[] = [];
      if (isRejectedRateLimit(message)) rejected = true;
      if (!isResult(message)) {
        // The thread had to leave its account: say so just before its first answer (earlier frames, such as
        // `init`, arrive before the adapter's turn takes notices).
        if (pendingNotice !== undefined && message.type === "assistant") {
          const notice = noticeMessage(pendingNotice, message.session_id);
          pendingNotice = undefined;
          return { emit: [notice, message], end: false };
        }
        return { emit: [message], end: false };
      }
      if (pendingNotice !== undefined) {
        lead.push(noticeMessage(pendingNotice, message.session_id));
        pendingNotice = undefined;
      }
      const parsed = parseClaudeResult(message as unknown as Record<string, unknown>);
      const kind = limitKind(parsed.text);
      const accountLimit =
        parsed.isError &&
        !parsed.modelUnavailable &&
        (parsed.limitReached || rejected) &&
        kind !== "model";
      rejected = false;
      if (accountLimit) {
        router.markFull(account);
        const { notice, to } = yield* io(() =>
          router.limitNotice(account, input.model, input.delegated),
        ).pipe(
          Effect.orElseSucceed(() => ({
            notice: `lastdrop: Claude account ${account} reached its usage limit.`,
            to: undefined,
          })),
        );
        if (to === undefined) {
          // Nowhere to move: T3's own handling (the session stays open, background work keeps running).
          log(`thread ${label} on ${account}: usage limit, and no other account has room`);
          return {
            emit: [...lead, noticeMessage(notice, message.session_id), message],
            end: false,
          };
        }
        log(
          `thread ${label} on ${account}: usage limit; ending the query so the next message moves to ${to}`,
        );
        return {
          emit: [...lead, noticeMessage(notice, message.session_id), withNotice(message, notice)],
          end: true,
        };
      }
      const signIn = parsed.isError
        ? yield* io(() => router.signInWorks(account)).pipe(Effect.orElseSucceed(() => true))
        : true;
      const transient = classifyResult(parsed, () => signIn).transient;
      const action = machine.fromChild(true, transient, message, yield* random);
      switch (action.type) {
        case "forward":
          return { emit: [...lead, message], end: false };
        case "giveUp":
          log(
            `thread ${label} on ${account}: temporary API error (${transient}) again; retries spent, ending the query so the next message moves`,
          );
          router.markTroubled(account);
          return { emit: [...lead, message], end: true };
        case "hold": {
          log(
            `thread ${label} on ${account}: temporary API error (${transient}); retry ${machine.failures} of ${standardRetryPolicy.delaysSeconds.length} in ${Math.round(action.afterMs / 1000)} s, continuing the same session`,
          );
          const done = yield* Deferred.make<SDKMessage>();
          released = done;
          const outcome = yield* Effect.raceFirst(
            sleep(action.afterMs).pipe(Effect.as({ type: "fire" as const })),
            Deferred.await(done).pipe(Effect.map((line) => ({ type: "released" as const, line }))),
          );
          released = undefined;
          if (outcome.type === "released") return { emit: [...lead, outcome.line], end: false };
          if (!machine.fire(action.generation)) {
            const held = machine.release();
            return { emit: held === undefined ? lead : [...lead, held], end: false };
          }
          log(`thread ${label} on ${account}: retry ${machine.failures}, telling it to continue`);
          const offered = yield* session.offer(continueMessage()).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          // The query couldn't take the retry: T3 gets the error after all.
          return offered ? { emit: lead, end: false } : { emit: [...lead, message], end: false };
        }
      }
    }) as (message: SDKMessage) => Effect.Effect<Step>;

    let ended = false;
    const messages = session.messages.pipe(
      Stream.mapEffect(step),
      Stream.takeUntil((s) => s.end),
      Stream.tap((s) =>
        Effect.sync(() => {
          if (s.end) ended = true;
        }),
      ),
      Stream.flatMap((s) => Stream.fromIterable(s.emit)),
      // Claude Code ended (or T3 closed its side): a held result goes to T3 so the turn ends.
      Stream.concat(
        Stream.suspend(() => {
          const held = machine.release();
          // A notice still waiting for an answer goes out before the stream ends.
          const out: SDKMessage[] = [];
          if (pendingNotice !== undefined) out.push(noticeMessage(pendingNotice, ""));
          pendingNotice = undefined;
          if (held !== undefined) out.push(held);
          return Stream.fromIterable(out);
        }),
      ),
      Stream.ensuring(Effect.suspend(() => (ended ? closeOnce.pipe(Effect.ignore) : Effect.void))),
    ) as Stream.Stream<SDKMessage, ClaudeAgentSdkQueryRunnerError>;

    return {
      ...session,
      messages,
      offer: (message, onQueued) =>
        releaseHeld.pipe(Effect.andThen(session.offer(message, onQueued))),
      interrupt: releaseHeld.pipe(Effect.andThen(session.interrupt)),
      close: closeOnce,
    };
  };

  return {
    ...inner,
    open: Effect.fn("LastdropQueryRunner.open")(function* (input: ClaudeAgentSdkQueryOpenInput) {
      const identity = identityOf(input.options);
      const lineage = yield* options.lineage(input.threadId);
      const env = (input.options.env ?? options.hostEnvironment) as Readonly<
        Record<string, string | undefined>
      >;
      const model = typeof input.options.model === "string" ? input.options.model : undefined;
      const routeInput = {
        threadId: input.threadId,
        identity,
        model,
        env,
        delegated: lineage.delegated,
        parentThreadId: lineage.parentThreadId,
      };
      // A route that comes back too late is dropped unused: it wrote nothing, and never will.
      const routed = yield* io(() => router.route(routeInput)).pipe(
        Effect.timeoutOption(deadline),
        Effect.map((o) => (o._tag === "Some" ? o.value : undefined)),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log(`thread ${input.threadId}: choosing an account failed (${String(cause)})`);
            return undefined;
          }),
        ),
      );
      let route: Route;
      if (routed !== undefined) {
        // The route's ledger writes, before the query opens: a thread opened on B is recorded on B.
        const committed = yield* io(routed.commit).pipe(
          Effect.timeoutOption(deadline),
          Effect.map((o) => o._tag === "Some"),
          Effect.orElseSucceed(() => false),
        );
        if (!committed)
          return yield* refuse(input.threadId, "its session ledger couldn't be written");
        route = routed;
      } else {
        // Stay where the thread was recorded, or don't open at all.
        const recorded = yield* io(() => router.recorded({ identity, env })).pipe(
          Effect.timeoutOption(deadline),
          Effect.map((o) => (o._tag === "Some" ? o.value : undefined)),
          Effect.orElseSucceed(() => undefined),
        );
        if (recorded === undefined) {
          return yield* refuse(
            input.threadId,
            "choosing its account failed and its recorded account couldn't be read",
          );
        }
        route = recorded;
      }
      const session = yield* inner.open({
        ...input,
        options: withIdentity(
          input.options,
          route.identity,
          route.decision === undefined ? undefined : route.env,
        ),
      });
      return watch(session, route, { model, delegated: lineage.delegated });
    }),
    forkSession: Effect.fn("LastdropQueryRunner.forkSession")(function* (
      input: Parameters<ClaudeAgentSdkQueryRunnerShape["forkSession"]>[0],
    ) {
      const upTo = (input.options as { upToMessageId?: string }).upToMessageId;
      const source = yield* (
        upTo === undefined
          ? io(() => router.currentSession(input.sessionId)).pipe(
              Effect.map((session) => ({ session, uuid: undefined as string | undefined })),
            )
          : io(() => router.messageId(input.sessionId, upTo))
      ).pipe(Effect.orElseSucceed(() => ({ session: input.sessionId, uuid: upTo })));
      const result = yield* inner.forkSession({
        ...input,
        sessionId: source.session,
        options:
          source.uuid === undefined
            ? input.options
            : { ...input.options, upToMessageId: source.uuid },
      });
      yield* io(() => router.recordFork(input.sessionId, result.sessionId)).pipe(Effect.ignore);
      return result;
    }),
    subagentLaunchToolUseId: Effect.fn("LastdropQueryRunner.subagentLaunchToolUseId")(function* (
      input: Parameters<ClaudeAgentSdkQueryRunnerShape["subagentLaunchToolUseId"]>[0],
    ) {
      // A subagent started before a move sits under an older conversation's folder.
      const sessions = yield* io(() => router.lineage(input.sessionId)).pipe(
        Effect.orElseSucceed(() => [input.sessionId]),
      );
      for (const [i, session] of sessions.entries()) {
        const lookup = inner.subagentLaunchToolUseId({ ...input, sessionId: session });
        // Only the last (T3's own id) answers as T3 asked; an earlier one may simply have no such folder.
        const found =
          i === sessions.length - 1
            ? yield* lookup
            : yield* lookup.pipe(Effect.orElseSucceed(() => null));
        if (found !== null) return found;
      }
      return null;
    }),
  };
}
