// @effect-diagnostics nodeBuiltinImport:off - The real home folder; the keychain I/O is lastdrop-node's.
/**
 * The Z.ai and OpenRouter keys in the fork's keychain service: a service over lastdrop-node's key functions
 * and thin routes under `/api/lastdrop/endpoints/keys`. A key goes in and is never sent back, only where it
 * comes from. The endpoints service (`endpoints.ts`) notices a changed key on its next pass.
 */
import * as NodeOS from "node:os";

import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import {
  clearEndpointKey,
  type EndpointKeyStatus,
  endpointKeyStatus,
  type EndpointProvider,
  importableEndpointKeys,
  importEndpointKeys,
  lastdropPaths,
  setEndpointKey,
} from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { resolveLastdropDataDir } from "../dataDir.ts";

const KEYS_ROUTE = "/api/lastdrop/endpoints/keys" as const;
const MAX_KEY_BYTES = 4096;

/** Where each key is, and which the app could fill: never a key. */
export interface EndpointKeysView {
  readonly keys: ReadonlyArray<EndpointKeyStatus>;
  readonly importable: ReadonlyArray<EndpointProvider>;
}

export class LastdropEndpointKeys extends Context.Service<
  LastdropEndpointKeys,
  {
    readonly view: Effect.Effect<EndpointKeysView | undefined>;
    /** False when the key wasn't stored (empty, keychain refused). */
    readonly set: (provider: EndpointProvider, key: string) => Effect.Effect<boolean>;
    readonly clear: (provider: EndpointProvider) => Effect.Effect<boolean>;
    readonly importFromApp: Effect.Effect<ReadonlyArray<EndpointProvider>>;
  }
>()("t3/extensions/lastdrop/endpointKeys/LastdropEndpointKeys") {}

/** Runs on macOS, where the keys are in the keychain. Not under vitest, which must never reach the real one. */
export const layer = Layer.effect(
  LastdropEndpointKeys,
  Effect.gen(function* () {
    const underTest = yield* Config.String("VITEST").pipe(Config.option);
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin" || underTest._tag === "Some") {
      return LastdropEndpointKeys.of({
        view: Effect.undefined,
        set: Effect.fn("LastdropEndpointKeys.set")(function* () {
          return yield* Effect.succeed(false);
        }),
        clear: Effect.fn("LastdropEndpointKeys.clear")(function* () {
          return yield* Effect.succeed(false);
        }),
        importFromApp: Effect.succeed([]),
      });
    }
    const dataDir = yield* resolveLastdropDataDir;
    const paths = lastdropPaths({ home: NodeOS.homedir(), dataDir });
    const attempt = <A>(run: () => Promise<A>, fallback: A) =>
      Effect.promise(run).pipe(Effect.orElseSucceed(() => fallback));
    return LastdropEndpointKeys.of({
      view: attempt(
        async () => ({
          keys: await endpointKeyStatus(paths, process.env),
          importable: await importableEndpointKeys(paths, process.env),
        }),
        undefined,
      ),
      set: Effect.fn("LastdropEndpointKeys.set")(function* (provider, key) {
        return yield* attempt(() => setEndpointKey(paths, provider, key), false);
      }),
      clear: Effect.fn("LastdropEndpointKeys.clear")(function* (provider) {
        return yield* attempt(() => clearEndpointKey(paths, provider), false);
      }),
      importFromApp: attempt(() => importEndpointKeys(paths, process.env), []),
    });
  }),
);

/** Why a session may not change keys, or undefined: a key is the environment owner's, set on this machine. */
export function writeRefusal(session: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string | undefined;
}): { readonly status: 403; readonly error: string } | undefined {
  if (session.proofKeyThumbprint !== undefined) {
    return { status: 403, error: "Keys are set on the Mac that runs them." };
  }
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return { status: 403, error: "forbidden" };
  }
  return undefined;
}

/** The key out of a request body `{"key": "..."}`; undefined when it isn't one that may be stored. */
export function keyFromBody(text: string): string | undefined {
  if (text.length > MAX_KEY_BYTES * 2) return undefined;
  try {
    const key: unknown = (JSON.parse(text) as { key?: unknown }).key;
    if (typeof key !== "string") return undefined;
    const trimmed = key.trim();
    // A key is one line of printable characters; anything else was pasted wrong.
    return trimmed.length > 0 && trimmed.length <= MAX_KEY_BYTES && /^[\x21-\x7e]+$/u.test(trimmed)
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/** The session behind the request, or the refusal to send: 401 without one, 403 without its scope. */
const authorize = Effect.fn("LastdropEndpointKeys.authorize")(function* (scope: "read" | "write") {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (session._tag === "None") return json({ error: "unauthorized" }, 401);
  if (!session.value.scopes.includes(AuthOrchestrationReadScope)) {
    return json({ error: "forbidden" }, 403);
  }
  if (scope === "write") {
    const refusal = writeRefusal(session.value);
    if (refusal !== undefined) return json({ error: refusal.error }, refusal.status);
  }
  return undefined;
});

/** The view after a change, so the section updates from one answer. */
const answer = Effect.fn("LastdropEndpointKeys.answer")(function* (ok: boolean, failure: string) {
  const view = yield* (yield* LastdropEndpointKeys).view;
  return ok ? json(view ?? {}) : json({ error: failure }, 502);
});

const providerRoutes = (provider: EndpointProvider) => {
  const path = `${KEYS_ROUTE}/${provider}` as const;
  return Layer.mergeAll(
    HttpRouter.add(
      "PUT",
      path,
      Effect.gen(function* () {
        const refused = yield* authorize("write");
        if (refused !== undefined) return refused;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const key = keyFromBody(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
        if (key === undefined) return json({ error: "That isn't a key." }, 400);
        const stored = yield* (yield* LastdropEndpointKeys).set(provider, key);
        return yield* answer(stored, "The key couldn't be saved to the keychain.");
      }),
    ),
    HttpRouter.add(
      "DELETE",
      path,
      Effect.gen(function* () {
        const refused = yield* authorize("write");
        if (refused !== undefined) return refused;
        const cleared = yield* (yield* LastdropEndpointKeys).clear(provider);
        return yield* answer(cleared, "The key couldn't be removed from the keychain.");
      }),
    ),
  );
};

export const routes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    KEYS_ROUTE,
    Effect.gen(function* () {
      const refused = yield* authorize("read");
      if (refused !== undefined) return refused;
      const view = yield* (yield* LastdropEndpointKeys).view;
      return json(view ?? { unavailable: "Z.ai and OpenRouter run on macOS only." });
    }),
  ),
  HttpRouter.add(
    "POST",
    `${KEYS_ROUTE}/import` as const,
    Effect.gen(function* () {
      const refused = yield* authorize("write");
      if (refused !== undefined) return refused;
      yield* (yield* LastdropEndpointKeys).importFromApp;
      return yield* answer(true, "");
    }),
  ),
  providerRoutes("zai"),
  providerRoutes("openrouter"),
);
