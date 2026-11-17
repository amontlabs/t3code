// @effect-diagnostics nodeBuiltinImport:off - The real home folder and a run id; the I/O is lastdrop-node's.
/**
 * lastdrop's Claude accounts: a service keeping every sign-in renewed and its usage read (lastdrop-node's
 * `AccountsMonitor`) and editing the fork's own list (`ClaudeAccounts`), with `GET /api/lastdrop/accounts` and
 * `POST /api/lastdrop/accounts` (one change per request) for the settings section.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type ProviderConsumeResetCreditOutcome,
  UsageLimitSourceError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type AccountChange,
  AccountChangeError,
  AccountsMonitor,
  ClaudeAccounts,
  type ClaudeAccountsView,
  fileLogger,
  lastdropPaths,
  nodeFetch,
  ResetRedeemError,
} from "@t3tools/lastdrop-node";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { ResetCreditCoordinator } from "../../provider/resetCreditCoordinator.ts";
import { resolveLastdropDataDir } from "../dataDir.ts";
import { bindPool, unbindPool } from "./agents/pools.ts";
import { lastdropRouting } from "./routing.ts";

const ACCOUNTS_ROUTE = "/api/lastdrop/accounts";

/** How often the keeper looks at the sign-ins (lastdrop's app tick). Usage is read every 5 minutes. */
const TICK = "15 seconds";

export class LastdropAccounts extends Context.Service<
  LastdropAccounts,
  {
    /** The accounts as last read; reads them first when nothing was read yet. */
    readonly view: Effect.Effect<ClaudeAccountsView | undefined>;
    /** Adds, signs in, renames, reorders, removes or imports; the view after it, and a sign-in's URL. */
    readonly change: (
      change: AccountChange,
    ) => Effect.Effect<
      { readonly view: ClaudeAccountsView; readonly signInUrl?: string },
      AccountsChangeRefused | AccountsRefreshError
    >;
    /** Spends one banked reset (`creditId`, Anthropic's grant id) on the account's own sign-in. */
    readonly redeemReset: (
      key: string,
      creditId: string,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, UsageLimitSourceError>;
  }
>()("t3/extensions/lastdrop/accounts/LastdropAccounts") {}

class AccountsRefreshError extends Schema.TaggedError<AccountsRefreshError>()(
  "LastdropAccountsRefreshError",
  { cause: Schema.Defect() },
) {}

/** A change that can't be made, with a message for the user. */
export class AccountsChangeRefused extends Schema.TaggedError<AccountsChangeRefused>()(
  "LastdropAccountsChangeRefused",
  { message: Schema.String },
) {}

const unavailable = AccountsChangeRefused.make({
  message: "lastdrop's accounts run on macOS only.",
});

/**
 * Starts the monitor on macOS, where Claude Code keeps sign-ins in the keychain. Not under vitest: T3's own
 * server tests start this layer, and must never read the real keychain or ask Anthropic.
 */
export const layer = Layer.effect(
  LastdropAccounts,
  Effect.gen(function* () {
    const underTest = yield* Config.String("VITEST").pipe(Config.option);
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin" || underTest._tag === "Some") {
      return LastdropAccounts.of({
        view: Effect.undefined,
        change: Effect.fn("LastdropAccounts.change")(function* () {
          return yield* unavailable;
        }),
        redeemReset: Effect.fn("LastdropAccounts.redeemReset")(function* () {
          return yield* new UsageLimitSourceError({ detail: unavailable.message });
        }),
      });
    }
    const coordinator = yield* ResetCreditCoordinator;
    const dataDir = yield* resolveLastdropDataDir;
    const paths = lastdropPaths({ home: NodeOS.homedir(), dataDir });
    const log = fileLogger(`${dataDir}/lastdrop.log`);
    const monitor = new AccountsMonitor({
      paths,
      fetch: nodeFetch,
      sessionId: NodeCrypto.randomUUID(),
      log,
    });
    const accounts = new ClaudeAccounts({ paths, monitor, env: process.env, log });
    yield* Effect.addFinalizer(() => Effect.sync(() => accounts.logins.cancelAll()));
    const io = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => new AccountsRefreshError({ cause }) });
    const tick = io(() => monitor.tick()).pipe(
      Effect.catch((error) => Effect.logWarning("lastdrop accounts refresh failed", error)),
    );
    yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);
    // The agents' Claude entries ask the accounts for room (the router's own readings and "limit reached"
    // answers), and have every account read again before a chain with no entry left fails.
    const routing = yield* lastdropRouting;
    if (routing !== undefined) {
      yield* bindPool("claude", {
        // Unreadable accounts answer like no pool: the entry is then judged by its own mark alone.
        room: (model) => Effect.promise(() => routing.router.room(model).catch(() => null)),
        refresh: io(() => monitor.readFresh()).pipe(
          Effect.catch((error) => Effect.logWarning("lastdrop accounts refresh failed", error)),
        ),
      });
      yield* Effect.addFinalizer(() => unbindPool("claude"));
    }
    return LastdropAccounts.of({
      view: io(() => accounts.view()).pipe(
        Effect.catch((error) =>
          Effect.logWarning("lastdrop accounts view failed", error).pipe(Effect.as(undefined)),
        ),
      ),
      change: Effect.fn("LastdropAccounts.change")(function* (change: AccountChange) {
        return yield* Effect.tryPromise({
          try: () => accounts.change(change),
          catch: (cause) =>
            cause instanceof AccountChangeError
              ? AccountsChangeRefused.make({ message: cause.message })
              : new AccountsRefreshError({ cause }),
        });
      }),
      // T3's rule for its own instances: one claim at a time per account, its request id kept until answered.
      redeemReset: Effect.fn("LastdropAccounts.redeemReset")(
        function* (key: string, creditId: string) {
          return yield* coordinator.redeem(
            `lastdrop-claude:${key}`,
            (requestId) =>
              Effect.tryPromise({
                try: () => monitor.redeemReset(key, creditId, requestId),
                catch: (cause) =>
                  cause instanceof ResetRedeemError
                    ? cause
                    : new ResetRedeemError("Claude could not redeem the reset.", false),
              }),
            (error) => error.settled,
          );
        },
        Effect.mapError(
          (error) =>
            new UsageLimitSourceError({
              detail:
                error instanceof ResetRedeemError
                  ? error.message
                  : "Claude could not redeem the reset.",
            }),
        ),
      ),
    });
  }),
);

const AccountKey = Schema.String.check(Schema.isMinLength(1));
const AccountChangeBody = Schema.Union([
  Schema.Struct({ action: Schema.Literal("add"), name: Schema.String }),
  Schema.Struct({ action: Schema.Literal("rename"), key: AccountKey, name: Schema.String }),
  Schema.Struct({ action: Schema.Literal("move"), key: AccountKey, by: Schema.Literals([-1, 1]) }),
  Schema.Struct({ action: Schema.Literal("remove"), key: AccountKey }),
  Schema.Struct({ action: Schema.Literal("import") }),
  Schema.Struct({ action: Schema.Literal("signIn"), key: AccountKey }),
  Schema.Struct({ action: Schema.Literal("submitCode"), key: AccountKey, code: Schema.String }),
  Schema.Struct({ action: Schema.Literal("cancelSignIn"), key: AccountKey }),
]);
const decodeAccountChange = Schema.decodeUnknownOption(Schema.fromJsonString(AccountChangeBody));

export const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/**
 * A session that may read the environment, and operate it for a change. A remote (DPoP) client may not change
 * accounts: their sign-ins live on the Mac that runs them, and the settings section shows none there.
 */
export const authorize = Effect.fn("LastdropAccounts.authorize")(function* (change: boolean) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (session._tag === "None") return json({ error: "unauthorized" }, 401);
  const scope = change ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
  if (!session.value.scopes.includes(scope)) {
    return json({ error: "forbidden" }, 403);
  }
  if (change && session.value.method === "dpop-access-token") {
    return json({ error: "Accounts change on the Mac that runs them." }, 403);
  }
  return undefined;
});

/** `GET /api/lastdrop/accounts`: the accounts view. */
const readRoute = HttpRouter.add(
  "GET",
  ACCOUNTS_ROUTE,
  Effect.gen(function* () {
    const refused = yield* authorize(false);
    if (refused) return refused;
    const view = yield* (yield* LastdropAccounts).view;
    return json(view ?? { unavailable: "lastdrop's accounts run on macOS only." });
  }),
);

/** `POST /api/lastdrop/accounts` with one `AccountChange`: the view after it (and a sign-in's URL), or `{ error }`. */
const changeRoute = HttpRouter.add(
  "POST",
  ACCOUNTS_ROUTE,
  Effect.gen(function* () {
    const refused = yield* authorize(true);
    if (refused) return refused;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const change = decodeAccountChange(body);
    if (change._tag === "None") return json({ error: "That isn't an account change." }, 400);
    return yield* (yield* LastdropAccounts).change(change.value).pipe(
      Effect.map((result) => json(result)),
      Effect.catchTags({
        LastdropAccountsChangeRefused: (refusal) =>
          Effect.succeed(json({ error: refusal.message }, 400)),
        LastdropAccountsRefreshError: (error) =>
          Effect.logWarning("lastdrop account change failed", error).pipe(
            Effect.as(json({ error: "The change failed; see lastdrop.log." }, 500)),
          ),
      }),
    );
  }),
);

export const routes = Layer.mergeAll(readRoute, changeRoute);
