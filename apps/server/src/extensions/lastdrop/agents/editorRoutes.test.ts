/**
 * Who may use `/api/lastdrop/agents`: a session that may read the environment lists; saving and importing
 * need `providers:manage` and a local session. Over a fake editor, so no file is touched.
 */
import { assert, describe, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthProvidersManageScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import { AgentsEditorError, LastdropAgentsEditor, type AgentsView } from "./editor.ts";
import { routes } from "./editorRoutes.ts";

const view: AgentsView = { agents: [], revision: 3, providers: [], canImport: false };
const saved: Array<unknown> = [];

const auth = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
  // The test names the session in a header: "none", or "<method>:<scope>,<scope>".
  authenticateHttpRequest: (request: { readonly headers: Record<string, string | undefined> }) => {
    const header = request.headers["x-session"] ?? "none";
    if (header === "none") return Effect.fail({ _tag: "NoSession" as const });
    const cut = header.indexOf(":");
    const method = header.slice(0, cut);
    const scopes = header.slice(cut + 1);
    return Effect.succeed({ method, scopes: scopes.split(",") });
  },
} as never);

const editor = Layer.succeed(LastdropAgentsEditor, {
  view: Effect.succeed(view),
  save: (input) =>
    Effect.sync(() => saved.push(input)).pipe(
      Effect.andThen(
        input.revision === 1
          ? Effect.fail(new AgentsEditorError({ status: 409, message: "changed elsewhere" }))
          : Effect.succeed(view),
      ),
    ),
  importFromApp: Effect.succeed(view),
});

const web = HttpRouter.toWebHandler(
  routes.pipe(HttpRouter.provideRequest(Layer.merge(auth, editor))),
  {
    disableLogger: true,
  },
);

const call = (method: string, session: string, path = "/api/lastdrop/agents", body?: unknown) =>
  Effect.promise(async () => {
    const response = await web.handler(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { "x-session": session, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return response.status;
  });

const READ = `bearer-access-token:${AuthOrchestrationReadScope}`;
const MANAGE = `bearer-access-token:${AuthOrchestrationReadScope},${AuthProvidersManageScope}`;
const REMOTE = `dpop-access-token:${AuthOrchestrationReadScope},${AuthProvidersManageScope}`;

describe("the agents routes", () => {
  it.effect(
    "lists for a reader, and refuses writes without providers:manage or from a remote session",
    () =>
      Effect.gen(function* () {
        assert.equal(yield* call("GET", "none"), 401);
        assert.equal(yield* call("GET", "bearer-access-token:other"), 403);
        assert.equal(yield* call("GET", READ), 200);
        assert.equal(yield* call("PUT", READ, undefined, { agents: [] }), 403);
        assert.equal(yield* call("PUT", REMOTE, undefined, { agents: [] }), 403);
        assert.equal(yield* call("POST", REMOTE, "/api/lastdrop/agents/import"), 403);
        assert.deepEqual(saved, []);
      }),
  );

  it.effect(
    "saves and imports for a local manager, and answers an editor refusal with its status",
    () =>
      Effect.gen(function* () {
        assert.equal(yield* call("PUT", MANAGE, undefined, { agents: [], revision: 3 }), 200);
        assert.deepEqual(saved, [{ agents: [], revision: 3 }]);
        assert.equal(yield* call("PUT", MANAGE, undefined, { agents: [], revision: 1 }), 409);
        assert.equal(yield* call("PUT", MANAGE, undefined, { nothing: true }), 400);
        assert.equal(yield* call("POST", MANAGE, "/api/lastdrop/agents/import"), 200);
      }),
  );
});
