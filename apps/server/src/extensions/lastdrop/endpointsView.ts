/**
 * The endpoints service's tag, its view and `GET /api/lastdrop/endpoints`. Kept apart from `endpoints.ts`
 * (which reaches T3's settings service, whose module imports the extension lists) so `Extensions.routes` can
 * load it eagerly.
 */
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import type { EndpointProvider, EndpointUsage } from "@t3tools/lastdrop-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";

const ENDPOINTS_ROUTE = "/api/lastdrop/endpoints";

/** One provider as the Accounts section shows it. Plain JSON, never a key. */
export interface EndpointView {
  readonly provider: EndpointProvider;
  readonly title: string;
  readonly instanceId: string;
  readonly configured: boolean;
  readonly problem?: string | undefined;
  /** "ours": lastdrop's instance runs it; "user": the user's own instance has the id; "none": no instance. */
  readonly instance: "ours" | "user" | "none";
  readonly usage?: EndpointUsage | undefined;
  readonly readAt?: number | undefined;
  readonly error?: string | undefined;
  /** Out of room for agents until then (epoch ms). */
  readonly outUntil?: number | undefined;
}

export interface EndpointsView {
  readonly updatedAt: number;
  readonly endpoints: ReadonlyArray<EndpointView>;
}

export class LastdropEndpoints extends Context.Service<
  LastdropEndpoints,
  { readonly view: Effect.Effect<EndpointsView | undefined> }
>()("t3/extensions/lastdrop/endpointsView/LastdropEndpoints") {}

/** `GET /api/lastdrop/endpoints`: Z.ai and OpenRouter, for a session that may read the environment. */
export const routes = HttpRouter.add(
  "GET",
  ENDPOINTS_ROUTE,
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
    const endpoints = yield* LastdropEndpoints;
    const view = yield* endpoints.view;
    return HttpServerResponse.jsonUnsafe(
      view ?? { unavailable: "Z.ai and OpenRouter run on macOS only." },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);
