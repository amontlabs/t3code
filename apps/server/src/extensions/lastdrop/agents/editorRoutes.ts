/**
 * `/api/lastdrop/agents`: the agents editor's routes, thin over `LastdropAgentsEditor`.
 *
 * `GET` (read scope), `POST { agents, revision? }` and `POST /import` (the one-time copy of the app's list).
 * Writes need `providers:manage` and refuse a remote (DPoP) session: the files live on this Mac.
 * Writes are POST: T3's CORS allows only GET and POST, and the desktop renderer is cross-origin.
 */
import { AuthOrchestrationReadScope, AuthProvidersManageScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { AgentsEditorError, LastdropAgentsEditor } from "./editor.ts";

const AGENTS_ROUTE = "/api/lastdrop/agents";
const IMPORT_ROUTE = "/api/lastdrop/agents/import";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/** The refusal for a request that may not use the route, or undefined when it may. */
const refusal = Effect.fn("LastdropAgentsRoutes.refusal")(function* (write: boolean) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (session._tag === "None") return json({ error: "unauthorized" }, 401);
  const { scopes, method } = session.value;
  if (!scopes.includes(AuthOrchestrationReadScope)) return json({ error: "forbidden" }, 403);
  if (write && (method === "dpop-access-token" || !scopes.includes(AuthProvidersManageScope))) {
    return json({ error: "forbidden" }, 403);
  }
  return undefined;
});

const answer = (result: Effect.Effect<unknown, AgentsEditorError>) =>
  result.pipe(
    Effect.map((body) => json(body)),
    Effect.catchTags({
      LastdropAgentsEditorError: (error) =>
        Effect.succeed(json({ error: error.message }, error.status)),
    }),
  );

const read = HttpRouter.add(
  "GET",
  AGENTS_ROUTE,
  Effect.gen(function* () {
    const refused = yield* refusal(false);
    if (refused !== undefined) return refused;
    const editor = yield* LastdropAgentsEditor;
    return json(yield* editor.view);
  }),
);

const save = HttpRouter.add(
  "POST",
  AGENTS_ROUTE,
  Effect.gen(function* () {
    const refused = yield* refusal(true);
    if (refused !== undefined) return refused;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
    if (typeof body !== "object" || body === null || !("agents" in body)) {
      return json({ error: "Send { agents: [...] }." }, 400);
    }
    const editor = yield* LastdropAgentsEditor;
    return yield* answer(
      editor.save({
        agents: body.agents,
        revision: "revision" in body ? body.revision : undefined,
      }),
    );
  }),
);

const importApp = HttpRouter.add(
  "POST",
  IMPORT_ROUTE,
  Effect.gen(function* () {
    const refused = yield* refusal(true);
    if (refused !== undefined) return refused;
    const editor = yield* LastdropAgentsEditor;
    return yield* answer(editor.importFromApp);
  }),
);

export const routes = Layer.mergeAll(read, save, importApp);
