/**
 * lastdrop's Codex accounts: the list, signing in (`codex login --device-auth` in the account's shadow home), and
 * each signed-in account's usage read every few minutes through an app-server in its home. Routes
 * `GET /api/lastdrop/codex-accounts` and `POST` (one change per request) for the settings section.
 */
import {
  CodexSettings,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerProviderUsageLimits,
  type ServerSettings,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  addCodexAccount,
  CODEX_FILE_STORE_LAUNCH_ARGS,
  type CodexAccountFiles,
  codexAccountFiles,
  codexAccountTitle,
  CodexLogins,
  CodexSignInError,
  chooseCodexAccount,
  fileLogger,
  moveCodexAccount,
  removeCodexAccount,
  renameCodexAccount,
} from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { codexPlanLabel, withCodexAppServerClient } from "../../../provider/CodexProvider.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../../provider/Drivers/CodexHomeLayout.ts";
import { codexRateLimitsFailureMessage } from "../../../provider/codexUsageLimits.ts";
import { resolveLastdropDataDir } from "../../dataDir.ts";
import { authorize, json } from "../accounts.ts";
import { isRoutable } from "./factory.ts";
import { codexLimits, codexRoom } from "./routing.ts";

const ROUTE = "/api/lastdrop/codex-accounts";
/** How often each signed-in account's usage is read. */
const READ_EVERY = "5 minutes";
const READ_TIMEOUT = "30 seconds";

export interface CodexAccountView {
  readonly key: string;
  readonly title: string;
  readonly signedIn: boolean;
  readonly email?: string | undefined;
  readonly plan?: string | undefined;
  /** T3's windows for the last reading; none before the first. */
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
  readonly readAt?: number | undefined;
  readonly error?: string | undefined;
  /** A sign-in waiting for its code to be typed on Codex's page. */
  readonly signIn?: { readonly url: string; readonly code: string } | undefined;
  readonly signInError?: string | undefined;
}

export interface CodexAccountsView {
  readonly accounts: ReadonlyArray<CodexAccountView>;
  /** Where a new Codex thread opens now; undefined while none is signed in (T3's own login is used). */
  readonly next?: string | undefined;
}

export type CodexAccountChange =
  | { readonly action: "add"; readonly name: string }
  | { readonly action: "rename"; readonly key: string; readonly name: string }
  | { readonly action: "move"; readonly key: string; readonly by: -1 | 1 }
  | { readonly action: "remove"; readonly key: string }
  | { readonly action: "signIn"; readonly key: string }
  | { readonly action: "cancelSignIn"; readonly key: string };

export class CodexAccountsRefused extends Schema.TaggedError<CodexAccountsRefused>()(
  "LastdropCodexAccountsRefused",
  { message: Schema.String },
) {}

class CodexAccountsError extends Schema.TaggedError<CodexAccountsError>()(
  "LastdropCodexAccountsError",
  { cause: Schema.Defect() },
) {}

export class LastdropCodexAccounts extends Context.Service<
  LastdropCodexAccounts,
  {
    /** Undefined where the fork doesn't keep Codex accounts (under vitest). */
    readonly view: Effect.Effect<CodexAccountsView | undefined>;
    readonly change: (
      change: CodexAccountChange,
    ) => Effect.Effect<CodexAccountsView, CodexAccountsRefused | CodexAccountsError>;
  }
>()("t3/extensions/lastdrop/codex/accounts/LastdropCodexAccounts") {}

const decodeSettings = Schema.decodeSync(CodexSettings);
const decodeInstanceSettings = Schema.decodeUnknownOption(CodexSettings);
const DEFAULT_CODEX_INSTANCE = ProviderInstanceId.make("codex");

/**
 * The binary of T3's Codex instance whose sessions lastdrop routes (enabled, on the shared `~/.codex`; the default
 * instance first), so usage reads and sign-ins run the Codex the user configured; `codex` from `PATH` without one.
 */
export const routedCodexBinary = Effect.fn("LastdropCodexAccounts.codexBinary")(function* (
  instances: ServerSettings["providerInstances"],
  environment: NodeJS.ProcessEnv,
  sharedHome: string,
) {
  const entries = Object.entries(instances).toSorted(
    ([left], [right]) =>
      Number(right === DEFAULT_CODEX_INSTANCE) - Number(left === DEFAULT_CODEX_INSTANCE),
  );
  for (const [, instance] of entries) {
    if (instance.driver !== "codex" || !resolveProviderInstanceEnabled(instance)) continue;
    const settings = decodeInstanceSettings(instance.config ?? {});
    if (settings._tag === "None") continue;
    const instanceEnvironment = yield* mergeProviderInstanceEnvironment(
      instance.environment,
      environment,
    );
    if (!isRoutable(settings.value, instanceEnvironment, sharedHome)) continue;
    const binary = settings.value.binaryPath.trim();
    return binary === "" ? "codex" : expandHomePath(binary, yield* HostProcess.HomeDirectory);
  }
  return "codex";
});

/** The view from the files; `logins` adds waiting sign-ins. */
async function codexAccountsView(
  files: CodexAccountFiles,
  now: number,
  logins?: Pick<CodexLogins, "pending" | "failure">,
): Promise<CodexAccountsView> {
  const [list, usage] = await Promise.all([files.list(), files.usage()]);
  const accounts = await Promise.all(
    list.accounts.map(async (account): Promise<CodexAccountView> => {
      const record = usage[account.key];
      const signedIn = await files.signedIn(account.key);
      const signIn = logins?.pending(account.key);
      const signInError = logins?.failure(account.key);
      const usageLimits = codexLimits(record);
      return {
        key: account.key,
        title: codexAccountTitle(account),
        signedIn,
        ...(record?.email ? { email: record.email } : {}),
        ...(record?.plan ? { plan: record.plan } : {}),
        ...(usageLimits ? { usageLimits } : {}),
        ...(record ? { readAt: record.readAt } : {}),
        ...(record?.error ? { error: record.error } : {}),
        ...(signIn ? { signIn } : {}),
        ...(signInError ? { signInError } : {}),
      };
    }),
  );
  const next = chooseCodexAccount({
    rooms: accounts.map((a) => codexRoom(a.key, a.signedIn, usage[a.key], now)),
    now,
  })?.key;
  return { accounts, ...(next ? { next } : {}) };
}

const inertLayer = Layer.succeed(
  LastdropCodexAccounts,
  LastdropCodexAccounts.of({
    view: Effect.undefined,
    change: Effect.fn("LastdropCodexAccounts.change")(function* () {
      return yield* CodexAccountsRefused.make({ message: "Codex accounts aren't kept here." });
    }),
  }),
);

const make = Effect.gen(function* () {
  const dataDir = yield* resolveLastdropDataDir;
  const files = codexAccountFiles(dataDir);
  const log = fileLogger(`${dataDir}/lastdrop.log`);
  const environment = yield* HostProcess.Environment;
  const helper = `${dataDir}/helper`;
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const signedInNow = yield* Queue.unbounded<string>();
  const logins = new CodexLogins({
    files,
    env: environment,
    cwd: helper,
    onSignedIn: (key) => {
      log(`codex: signed the ${key} account in`);
      Queue.offerUnsafe(signedInNow, key);
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => logins.cancelAll()));

  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new CodexAccountsError({ cause }) });

  /** T3's shadow home for the account: its own `auth.json`, everything else linked to `~/.codex`. */
  const prepareHome = (key: string) =>
    resolveCodexHomeLayout(decodeSettings({ shadowHomePath: files.home(key) })).pipe(
      Effect.flatMap(materializeCodexShadowHome),
      Effect.provide(services),
    );

  // Imported here: T3's settings service imports the extension lists this module is part of.
  const { ServerSettingsService } = yield* Effect.promise(
    () => import("../../../serverSettings.ts"),
  );
  const settings = yield* ServerSettingsService;
  const sharedHome = `${yield* HostProcess.HomeDirectory}/.codex`;
  const codexBinary = settings.getSettings.pipe(
    Effect.flatMap((current) =>
      routedCodexBinary(current.providerInstances, environment, sharedHome),
    ),
    Effect.orElseSucceed(() => "codex"),
  );

  const readUsage = Effect.fn("LastdropCodexAccounts.readUsage")(function* (key: string) {
    yield* prepareHome(key);
    const binaryPath = yield* codexBinary;
    const read = Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* withCodexAppServerClient({
          binaryPath,
          homePath: files.home(key),
          launchArgs: CODEX_FILE_STORE_LAUNCH_ARGS,
          cwd: helper,
          environment,
        });
        const account = yield* client.request("account/read", {});
        const limits = yield* client.request("account/rateLimits/read", null);
        return { account: account.account, limits };
      }),
    ).pipe(Effect.timeout(READ_TIMEOUT), Effect.provide(services));
    const now = yield* Clock.currentTimeMillis;
    const result = yield* read.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          message:
            error._tag === "TimeoutError"
              ? "Codex did not answer the usage request."
              : codexRateLimitsFailureMessage(error),
        }),
      ),
    );
    yield* io(() =>
      files.updateUsage(key, (current) => {
        if (!result.ok) return { ...current, readAt: now, error: result.message };
        const { account, limits } = result.value;
        const chatgpt = account?.type === "chatgpt" ? account : undefined;
        const plan = codexPlanLabel(chatgpt?.planType);
        return {
          readAt: now,
          ...(chatgpt?.email ? { email: chatgpt.email } : {}),
          ...(plan ? { plan } : {}),
          limits: limits.rateLimitsByLimitId?.["codex"] ?? limits.rateLimits,
        };
      }),
    );
  });

  const readAll = Effect.gen(function* () {
    const list = yield* io(() => files.list());
    for (const account of list.accounts) {
      if (!(yield* io(() => files.signedIn(account.key)))) continue;
      yield* readUsage(account.key).pipe(
        Effect.catch((error) =>
          Effect.logWarning("lastdrop Codex usage read failed", { key: account.key, error }),
        ),
      );
    }
  }).pipe(Effect.catch((error) => Effect.logWarning("lastdrop Codex usage read failed", error)));

  yield* readAll.pipe(Effect.repeat(Schedule.spaced(READ_EVERY)), Effect.forkScoped);
  yield* Queue.take(signedInNow).pipe(
    Effect.flatMap((key) => readUsage(key).pipe(Effect.ignore)),
    Effect.forever,
    Effect.forkScoped,
  );

  const view = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* io(() => codexAccountsView(files, now, logins));
  });

  const known = (key: string) =>
    io(() => files.list()).pipe(
      Effect.flatMap((list) =>
        list.accounts.some((a) => a.key === key)
          ? Effect.void
          : Effect.fail(CodexAccountsRefused.make({ message: `There's no account ${key}.` })),
      ),
    );

  const apply = Effect.fn("LastdropCodexAccounts.apply")(function* (change: CodexAccountChange) {
    const now = yield* Clock.currentTimeMillis;
    switch (change.action) {
      case "add": {
        const name = change.name.trim();
        let refused = false;
        yield* io(() =>
          files.editList((list) => {
            const added = addCodexAccount(list, name, now);
            if (added === undefined) refused = true;
            return added?.list ?? list;
          }),
        );
        if (refused) {
          return yield* CodexAccountsRefused.make({
            message:
              name === "" ? "Give the account a name." : `An account named ${name} exists already.`,
          });
        }
        log(`codex: added an account named ${name}`);
        break;
      }
      case "rename":
        yield* known(change.key);
        yield* io(() =>
          files.editList((list) => renameCodexAccount(list, change.key, change.name)),
        );
        break;
      case "move":
        yield* known(change.key);
        yield* io(() => files.editList((list) => moveCodexAccount(list, change.key, change.by)));
        break;
      case "remove":
        yield* known(change.key);
        logins.cancel(change.key);
        yield* io(() => files.editList((list) => removeCodexAccount(list, change.key)));
        yield* io(() => files.removeHome(change.key));
        yield* io(() => files.updateUsage(change.key, () => undefined));
        log(`codex: removed the ${change.key} account`);
        break;
      case "signIn":
        yield* known(change.key);
        yield* prepareHome(change.key).pipe(
          Effect.mapError((cause) => new CodexAccountsError({ cause })),
        );
        const binary = yield* codexBinary;
        yield* Effect.tryPromise({
          try: () => logins.start(change.key, binary),
          catch: (cause) =>
            cause instanceof CodexSignInError
              ? CodexAccountsRefused.make({ message: cause.message })
              : new CodexAccountsError({ cause }),
        });
        break;
      case "cancelSignIn":
        logins.cancel(change.key);
        break;
    }
    return yield* view;
  });

  // One change at a time: the list's own writes are serial, but a change reads before it writes.
  const lock = yield* Semaphore.make(1);
  return LastdropCodexAccounts.of({
    view: view.pipe(
      Effect.catch((error) =>
        Effect.logWarning("lastdrop Codex accounts view failed", error).pipe(Effect.as(undefined)),
      ),
    ),
    change: Effect.fn("LastdropCodexAccounts.change")(function* (change: CodexAccountChange) {
      return yield* lock.withPermits(1)(apply(change));
    }),
  });
});

/** Not under vitest: T3's own server tests start this layer and must never run `codex` or read `~/.codex`. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const underTest = yield* Config.String("VITEST").pipe(Config.option);
    if (underTest._tag === "Some") return inertLayer;
    return Layer.effect(LastdropCodexAccounts, make);
  }),
);

const AccountKey = Schema.String.check(Schema.isMinLength(1));
const ChangeBody = Schema.Union([
  Schema.Struct({ action: Schema.Literal("add"), name: Schema.String }),
  Schema.Struct({ action: Schema.Literal("rename"), key: AccountKey, name: Schema.String }),
  Schema.Struct({ action: Schema.Literal("move"), key: AccountKey, by: Schema.Literals([-1, 1]) }),
  Schema.Struct({ action: Schema.Literal("remove"), key: AccountKey }),
  Schema.Struct({ action: Schema.Literal("signIn"), key: AccountKey }),
  Schema.Struct({ action: Schema.Literal("cancelSignIn"), key: AccountKey }),
]);
const decodeChange = Schema.decodeUnknownOption(Schema.fromJsonString(ChangeBody));

const readRoute = HttpRouter.add(
  "GET",
  ROUTE,
  Effect.gen(function* () {
    const refused = yield* authorize(false);
    if (refused) return refused;
    const view = yield* (yield* LastdropCodexAccounts).view;
    return json(view ?? { unavailable: "Codex accounts aren't kept here." });
  }),
);

const changeRoute = HttpRouter.add(
  "POST",
  ROUTE,
  Effect.gen(function* () {
    const refused = yield* authorize(true);
    if (refused) return refused;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const change = decodeChange(body);
    if (change._tag === "None") return json({ error: "That isn't an account change." }, 400);
    return yield* (yield* LastdropCodexAccounts).change(change.value).pipe(
      Effect.map((view) => json({ view })),
      Effect.catchTags({
        LastdropCodexAccountsRefused: (refusal) =>
          Effect.succeed(json({ error: refusal.message }, 400)),
        LastdropCodexAccountsError: (error) =>
          Effect.logWarning("lastdrop Codex account change failed", error).pipe(
            Effect.as(json({ error: "The change failed; see lastdrop.log." }, 500)),
          ),
      }),
    );
  }),
);

export const routes = Layer.mergeAll(readRoute, changeRoute);
