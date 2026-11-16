/**
 * Wraps T3's Codex app-server client factory: every Codex process T3 starts for a thread opens through `open`, so
 * the account is picked there by pointing `CODEX_HOME` at the account's shadow home. The client is passed back
 * as T3's, watched for the native thread ids it starts or resumes, its rate-limit updates and a turn ending at the
 * account's usage limit. Never edits the adapter. See docs/lastdrop/independence.md, item 5.
 */
import type { CodexSettings } from "@t3tools/contracts";
import type { CodexLimitSnapshot } from "@t3tools/lastdrop-node";
import { CODEX_FILE_STORE_LAUNCH_ARGS } from "@t3tools/lastdrop-node";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";

import type { CodexAppServerClientFactoryShape } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { resolveCodexLaunchArgs } from "../../../provider/codexLaunchArgs.ts";

export type CodexOpenInput = Parameters<CodexAppServerClientFactoryShape["open"]>[0];
type Client = CodexClient.CodexAppServerClient["Service"];

/** The routing the wrapper asks (`routing.ts` over lastdrop's files; tests stand in another). */
export interface CodexRouting {
  /** The account a session of this T3 thread opens on, or undefined to open it as T3 would. */
  readonly route: (
    threadId: string,
  ) => Promise<{ readonly account: string; readonly home: string } | undefined>;
  readonly recordThread: (
    account: string,
    threadId: string,
    nativeThreadId: string,
  ) => Promise<void>;
  readonly observeLimits: (account: string, snapshot: CodexLimitSnapshot) => Promise<void>;
  /** Marks the account full; the account the thread now opens on, or undefined when none has room. */
  readonly atLimit: (account: string, threadId: string) => Promise<string | undefined>;
  readonly log: (line: string) => void;
}

/** Told when a routed thread's turn ends at its account's limit and another account has room. */
export type OnLimitMove = (move: {
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
}) => void;

const LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";
const THREAD_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutTrailingSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, "") : path);

/**
 * Only T3's own CLI-login instances on the shared `~/.codex` are routed: not a managed one (T3's "Add ChatGPT
 * account"), one with its own shadow home, or one on another Codex home (its sessions live elsewhere).
 */
export function isRoutable(
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  sharedHome: string,
): boolean {
  if (settings.setupMode === "managed") return false;
  if (settings.shadowHomePath.trim() !== "") return false;
  const home = settings.homePath.trim() || environment["CODEX_HOME"]?.trim() || sharedHome;
  return withoutTrailingSlash(home) === withoutTrailingSlash(sharedHome);
}

/** Settings and environment on the account's home, with Codex told to keep its sign-in in that home's `auth.json`. */
export function onAccountHome<S extends CodexSettings>(
  settings: S,
  environment: NodeJS.ProcessEnv,
  home: string,
): { readonly settings: S; readonly environment: NodeJS.ProcessEnv } {
  const launchArgs =
    `${resolveCodexLaunchArgs(settings.launchArgs, environment)} ${CODEX_FILE_STORE_LAUNCH_ARGS}`.trim();
  const accountEnvironment: NodeJS.ProcessEnv = { ...environment, CODEX_HOME: home };
  if (accountEnvironment[LAUNCH_ARGS_ENV]?.trim()) accountEnvironment[LAUNCH_ARGS_ENV] = launchArgs;
  return {
    settings: { ...settings, homePath: home, launchArgs },
    environment: accountEnvironment,
  };
}

/** The open input on the account's home (`onAccountHome`). */
export function withAccountHome(input: CodexOpenInput, home: string): CodexOpenInput {
  return { ...input, ...onAccountHome(input.settings, input.environment, home) };
}

const nativeThreadOf = (method: string, response: unknown): string | undefined => {
  if (!THREAD_METHODS.has(method) || !isRecord(response) || !isRecord(response["thread"])) {
    return undefined;
  }
  const id = response["thread"]["id"];
  return typeof id === "string" ? id : undefined;
};

const errorCode = (info: unknown): string | undefined =>
  typeof info === "string" ? info : isRecord(info) ? Object.keys(info)[0] : undefined;

/** The account's usage limit, as T3's adapter reads it (`codexUsageLimitError`): not a single model's. */
function isAccountLimit(info: unknown): boolean {
  const code = errorCode(info);
  if (code === "usageLimitExceeded" || code === "rateLimitExceeded") return true;
  const exhausted = isRecord(info) ? info["responseTooManyFailedAttempts"] : undefined;
  return isRecord(exhausted) && exhausted["httpStatusCode"] === 429;
}

/**
 * The limit's notice, once per native turn: told on Codex's final `error` (its details become the turn's failure
 * text, which T3 prefers) or, without one, on the failed `turn/completed` (its message). Undefined: no move.
 */
type LimitNotice = (turnId: string) => Effect.Effect<string | undefined>;

function withLimitNotice(method: string, payload: unknown, notice: LimitNotice) {
  if (method === "error" && isRecord(payload) && payload["willRetry"] !== true) {
    const error = payload["error"];
    const turnId = payload["turnId"];
    if (!isRecord(error) || typeof turnId !== "string" || !isAccountLimit(error["codexErrorInfo"]))
      return Effect.succeed(payload);
    return notice(turnId).pipe(
      Effect.map((text) =>
        text === undefined ? payload : { ...payload, error: { ...error, additionalDetails: text } },
      ),
    );
  }
  if (method === "turn/completed" && isRecord(payload) && isRecord(payload["turn"])) {
    const turn = payload["turn"];
    const error = turn["error"];
    const turnId = turn["id"];
    if (
      turn["status"] !== "failed" ||
      !isRecord(error) ||
      typeof turnId !== "string" ||
      !isAccountLimit(error["codexErrorInfo"])
    )
      return Effect.succeed(payload);
    return notice(turnId).pipe(
      Effect.map((text) =>
        text === undefined
          ? payload
          : { ...payload, turn: { ...turn, error: { ...error, message: text } } },
      ),
    );
  }
  return Effect.succeed(payload);
}

/**
 * T3's client, telling `onThread` each native thread it starts, resumes or forks, `onLimits` each update, and
 * rewording a turn's limit failure with `notice`.
 */
function observeClient(
  client: Client,
  onThread: (nativeThreadId: string) => void,
  onLimits: (snapshot: CodexLimitSnapshot) => void,
  notice: LimitNotice,
): Client {
  const seen = (method: string) => (response: unknown) =>
    Effect.sync(() => {
      const id = nativeThreadOf(method, response);
      if (id !== undefined) onThread(id);
    });
  return {
    ...client,
    raw: {
      ...client.raw,
      request: (method, payload) =>
        client.raw.request(method, payload).pipe(Effect.tap(seen(method))),
    },
    request: (method, payload) => client.request(method, payload).pipe(Effect.tap(seen(method))),
    handleServerNotification: (method, handler) =>
      client.handleServerNotification(
        method,
        method === "account/rateLimits/updated"
          ? (payload) =>
              Effect.sync(() => {
                const update: unknown = payload;
                const snapshot = isRecord(update) ? update["rateLimits"] : undefined;
                if (isRecord(snapshot)) onLimits(snapshot);
              }).pipe(Effect.andThen(handler(payload)))
          : method === "error" || method === "turn/completed"
            ? (payload) =>
                withLimitNotice(method, payload, notice).pipe(
                  Effect.flatMap((seen) => handler(seen as typeof payload)),
                )
            : handler,
      ),
  };
}

/** The factory with each routable session opened on the account `routing` picks. */
export function wrapCodexClientFactory(
  inner: CodexAppServerClientFactoryShape,
  options: {
    readonly routing: CodexRouting;
    readonly sharedHome: string;
    readonly onLimitMove?: OnLimitMove;
    /** A session opened on the thread: a continuation still waiting for its run is no longer wanted. */
    readonly onOpen?: (threadId: string) => void;
  },
): CodexAppServerClientFactoryShape {
  const { routing, sharedHome, onLimitMove, onOpen } = options;
  const quietly = (what: string, run: () => Promise<void>) => {
    void run().catch((error: unknown) => routing.log(`codex: ${what} failed: ${String(error)}`));
  };
  return {
    open: Effect.fn("LastdropCodexRouting.open")(function* (input: CodexOpenInput) {
      if (!isRoutable(input.settings, input.environment, sharedHome))
        return yield* inner.open(input);
      const route = yield* Effect.tryPromise({
        try: () => routing.route(input.threadId),
        catch: (cause) => String(cause),
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            routing.log(`codex: choosing an account failed, T3's own login opens: ${error}`);
            return undefined;
          }),
        ),
      );
      if (route === undefined) return yield* inner.open(input);
      onOpen?.(input.threadId);
      const client = yield* inner.open(withAccountHome(input, route.home));
      // The error and the completion of one turn both say it; the first decides, the second reads the same.
      const notices = new Map<string, Promise<string | undefined>>();
      const atLimit = async (turnId: string): Promise<string | undefined> => {
        const to = await routing.atLimit(route.account, input.threadId);
        if (to === undefined) {
          routing.log(
            `codex: thread ${input.threadId} on ${route.account}: usage limit, and no other account has room`,
          );
          return undefined;
        }
        routing.log(
          `codex: thread ${input.threadId} on ${route.account}: usage limit; it continues on ${to} (turn ${turnId})`,
        );
        onLimitMove?.({ threadId: input.threadId, from: route.account, to });
        return `lastdrop: Codex account ${route.account} reached its usage limit; the thread continues on ${to}.`;
      };
      const notice: LimitNotice = (turnId) =>
        Effect.promise(() => {
          const seen = notices.get(turnId);
          if (seen !== undefined) return seen.then(() => undefined);
          const next = atLimit(turnId).catch((error: unknown) => {
            routing.log(
              `codex: at a usage limit, choosing the next account failed: ${String(error)}`,
            );
            return undefined;
          });
          notices.set(turnId, next);
          return next;
        });
      return observeClient(
        client,
        (nativeThreadId) =>
          quietly("recording a thread", () =>
            routing.recordThread(route.account, input.threadId, nativeThreadId),
          ),
        (snapshot) =>
          quietly("recording usage", () => routing.observeLimits(route.account, snapshot)),
        notice,
      );
    }),
  };
}
