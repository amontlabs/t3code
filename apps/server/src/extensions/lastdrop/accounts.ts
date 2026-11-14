// @effect-diagnostics nodeBuiltinImport:off - The real home folder and a run id; the I/O is lastdrop-node's.
/**
 * lastdrop's Claude accounts: a service keeping every sign-in renewed and its usage read (lastdrop-node's
 * `AccountsMonitor`), and `GET /api/lastdrop/accounts` for the settings section. Accounts are the standalone
 * app's, only read here; the fork's own state is `<T3 home>/lastdrop/usage.json`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  AccountsMonitor,
  type AccountsView,
  fileLogger,
  lastdropPaths,
  nodeFetch,
} from "@t3tools/lastdrop-node";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { resolveLastdropDataDir } from "../dataDir.ts";

const ACCOUNTS_ROUTE = "/api/lastdrop/accounts";

/** How often the keeper looks at the sign-ins (lastdrop's app tick). Usage is read every 5 minutes. */
const TICK = "15 seconds";

export class LastdropAccounts extends Context.Service<
  LastdropAccounts,
  {
    /** The accounts as last read; reads them first when nothing was read yet. */
    readonly view: Effect.Effect<AccountsView | undefined>;
  }
>()("t3/extensions/lastdrop/accounts/LastdropAccounts") {}

class AccountsRefreshError extends Schema.TaggedError<AccountsRefreshError>()(
  "LastdropAccountsRefreshError",
  { cause: Schema.Defect() },
) {}

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
      return LastdropAccounts.of({ view: Effect.undefined });
    }
    const dataDir = yield* resolveLastdropDataDir;
    const monitor = new AccountsMonitor({
      paths: lastdropPaths({ home: NodeOS.homedir(), dataDir }),
      fetch: nodeFetch,
      sessionId: NodeCrypto.randomUUID(),
      log: fileLogger(`${dataDir}/lastdrop.log`),
    });
    const io = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => new AccountsRefreshError({ cause }) });
    const tick = io(() => monitor.tick()).pipe(
      Effect.catch((error) => Effect.logWarning("lastdrop accounts refresh failed", error)),
    );
    yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);
    return LastdropAccounts.of({
      view: io(() => monitor.view()).pipe(
        Effect.catch((error) =>
          Effect.logWarning("lastdrop accounts view failed", error).pipe(Effect.as(undefined)),
        ),
      ),
    });
  }),
);

/** `GET /api/lastdrop/accounts`: the accounts view, for a session that may read the environment. */
export const routes = HttpRouter.add(
  "GET",
  ACCOUNTS_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (session._tag === "None") {
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
    }
    if (!session.value.scopes.includes(AuthOrchestrationReadScope)) {
      return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 });
    }
    const accounts = yield* LastdropAccounts;
    const view = yield* accounts.view;
    return HttpServerResponse.jsonUnsafe(
      view ?? { unavailable: "lastdrop's accounts run on macOS only." },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);
