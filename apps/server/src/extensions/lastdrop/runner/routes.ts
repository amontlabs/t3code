// @effect-diagnostics nodeBuiltinImport:off - A run id for a request without one.
/**
 * `POST /api/lastdrop/runner/<command>`: what the runner script (`endpoint.ts`) posts for each flag of
 * the standalone binary, answered in its JSON lines. A request carries its thread's token, and acts as
 * that thread only. Loaded lazily by `Extensions.routes` (it reaches T3's orchestrator, whose modules
 * import the extension lists).
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as OrchestratorMcpService from "../../../mcp/OrchestratorMcpService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { resolveLastdropDataDir } from "../../dataDir.ts";
import { makeStoredMap } from "../agents/store.ts";
import { makeLivePort } from "./children.ts";
import {
  bindRunner,
  installRunnerScript,
  RUNNER_PATH,
  tokenThread,
  unbindRunner,
} from "./endpoint.ts";
import {
  agentsCommand,
  catalogLine,
  encodeLine,
  isValidAgentId,
  parseRunRequest,
  type RunnerLine,
} from "./protocol.ts";
import { routeLine, runLines, stopLine, type RunnerDeps, type RunRecord } from "./runs.ts";

const LINES = "application/x-ndjson";

const lines = (body: ReadonlyArray<RunnerLine>, status = 200) =>
  HttpServerResponse.text(body.map(encodeLine).join(""), {
    status,
    contentType: LINES,
    headers: { "cache-control": "no-store" },
  });

/** The calling thread, from its token; undefined when the token doesn't hold. */
const caller = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const header = request.headers["authorization"] ?? "";
  return header.startsWith("Bearer ") ? tokenThread(header.slice("Bearer ".length)) : undefined;
});

const unauthorized = lines(
  [
    {
      type: "error",
      text: "lastdrop's runner refused the request: its thread token doesn't hold.",
    },
  ],
  401,
);

const bodyText = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.text),
  Effect.orElseSucceed(() => ""),
);

const form = bodyText.pipe(Effect.map((text) => new URLSearchParams(text)));

const post = <E, R>(
  command: string,
  handle: (thread: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpRouter.add(
    "POST",
    `${RUNNER_PATH}/${command}`,
    Effect.gen(function* () {
      const thread = yield* caller;
      if (thread === undefined) return unauthorized;
      return yield* handle(thread);
    }),
  );

/** The routes, closing over the runner's state: a route's handler may need only the request. */
export const handlers = (deps: RunnerDeps) =>
  Layer.mergeAll(
    post("agent-catalog", () =>
      Effect.sync(() => {
        const read = deps.port.catalog();
        return lines([catalogLine(read.agents, read.extras)]);
      }),
    ),
    post("agent-route", (thread) =>
      Effect.gen(function* () {
        const request = parseRunRequest(yield* bodyText);
        if ("type" in request) return lines([request]);
        return lines([yield* routeLine(deps, thread, request)]);
      }),
    ),
    post("agent-run", (thread) =>
      Effect.gen(function* () {
        const request = parseRunRequest(yield* bodyText);
        if ("type" in request) return lines([request]);
        return HttpServerResponse.stream(
          runLines(deps, thread, request).pipe(Stream.map(encodeLine), Stream.encodeText),
          {
            contentType: LINES,
            // no-transform keeps the compression middleware from holding lines back.
            headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
          },
        );
      }),
    ),
    post("agent-stop", (thread) =>
      Effect.gen(function* () {
        const id = (yield* form).get("id") ?? "";
        if (!isValidAgentId(id))
          return lines([{ type: "error", text: `Agent ${id} isn't running.` }], 404);
        const { line, ok } = yield* stopLine(deps, thread, id);
        return lines([line], ok ? 200 : 404);
      }),
    ),
    // The fork starts nothing ahead of a run: a run is a T3 thread, which opens its own session.
    post("agent-warm", () => Effect.succeed(lines([]))),
    // The self-test checks the standalone app's own subagents; the fork has none to check.
    post("agent-selftest", () =>
      Effect.succeed(
        lines([
          {
            type: "skipped",
            text: "T3 Code lastdrop runs lastdrop's agents as T3 threads; there is no subagent runner to test.",
          },
        ]),
      ),
    ),
    post("agent-open", () =>
      Effect.succeed(
        lines(
          [
            {
              type: "error",
              text: "In T3 Code lastdrop, open the agent's child thread in T3 Code instead.",
            },
          ],
          404,
        ),
      ),
    ),
    post("delegate-note", () =>
      Effect.succeed(
        lines(
          [
            {
              type: "error",
              text: "T3 Code lastdrop keeps no delegate notes: its Claude children are T3 threads it routes itself.",
            },
          ],
          400,
        ),
      ),
    ),
    post("agents", () =>
      Effect.gen(function* () {
        const args = (yield* form).get("args")?.trim().split(/\s+/).filter(Boolean) ?? [];
        const read = deps.port.catalog();
        const { output, failed } = agentsCommand(args, read.agents, read.extras);
        return HttpServerResponse.text(`${output}\n`, {
          status: failed ? 400 : 200,
          contentType: "text/plain",
        });
      }),
    ),
  );

const makeDeps = Effect.gen(function* () {
  const port = yield* makeLivePort;
  const records = makeStoredMap<RunRecord>(2_000);
  records.attach(NodePath.join(yield* resolveLastdropDataDir, "agent-runs.json"));
  return { port, records, newId: () => NodeCrypto.randomUUID() } satisfies RunnerDeps;
});

/**
 * Writes the runner script and binds its address, so Claude queries opened from now on carry it. Not
 * under vitest: T3's own server tests start the routes.
 */
const bindLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const underTest = yield* Config.String("VITEST").pipe(Config.option);
    if (underTest._tag === "Some") return;
    const server = yield* HttpServer.HttpServer;
    if (!NetAddress.isInetAddress(server.address)) return;
    const address = server.address.address;
    const host = NetAddress.isUnspecified(address)
      ? "127.0.0.1"
      : NetAddress.formatUrlHostString(NetAddress.formatIp(address));
    const dataDir = yield* resolveLastdropDataDir;
    const script = yield* Effect.sync(() => {
      try {
        return installRunnerScript(dataDir);
      } catch (cause) {
        return String(cause);
      }
    });
    if (!script.startsWith("/")) {
      return yield* Effect.logWarning("lastdrop runner script not written", script);
    }
    bindRunner({ script, url: `http://${host}:${server.address.port}${RUNNER_PATH}` });
    yield* Effect.addFinalizer(() => Effect.sync(unbindRunner));
  }),
);

export const routes = Layer.mergeAll(Layer.unwrap(Effect.map(makeDeps, handlers)), bindLayer).pipe(
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
);
