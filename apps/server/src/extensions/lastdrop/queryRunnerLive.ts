/**
 * The wrapper as the server runs it: the router over the real home, lineage from T3's projection. Only on
 * macOS and not under vitest (T3's tests build this layer); elsewhere T3's runner is returned unchanged.
 */
import { isDelegatedAppThread, ThreadId } from "@t3tools/contracts";
import type { ThreadRouter } from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQueryRunner,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import { elicitationChoicesLive } from "./claudeElicitation.ts";
import { pendingContinuations } from "./moveContinuation.ts";
import { type ThreadLineage, wrapQueryRunner } from "./queryRunner.ts";
import { lastdropRouting } from "./routing.ts";
import { boundPlugin, runnerVariables } from "./runner/endpoint.ts";
import { withLastdropPlugin, withRunnerEnvironment } from "./runner/queryEnvironment.ts";

const MAIN_THREAD: ThreadLineage = { delegated: false };

/** Reads a thread's lineage from T3's projection, when the server's database is there to read. */
const lineageReader = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return undefined;
  const context = yield* Layer.build(
    ProjectionStoreV2.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql.value))),
  );
  const store = Context.get(context, ProjectionStoreV2.ProjectionStoreV2);
  return (threadId: string): Effect.Effect<ThreadLineage> =>
    store.getThread(ThreadId.make(threadId)).pipe(
      Effect.map((thread) => ({
        delegated: isDelegatedAppThread(thread),
        parentThreadId: thread.lineage.parentThreadId ?? undefined,
      })),
      Effect.orElseSucceed(() => MAIN_THREAD),
    );
});

/**
 * The runner's variables and lastdrop's plugin on every query (step 8, `runner/`), around the routing wrapper
 * so a routed query's environment and options keep them, and an MCP form's own scopes in the query's elicitation
 * answers (`claudeElicitation.ts`). Not under vitest, where T3's tests pin the query's options.
 */
export const wrapLive = <E, R>(
  queryRunner: Layer.Layer<ClaudeAgentSdkQueryRunner, E, R>,
): Layer.Layer<ClaudeAgentSdkQueryRunner, E, R> =>
  Layer.effect(
    ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const inner = yield* ClaudeAgentSdkQueryRunner;
      const underTest = yield* Config.String("VITEST").pipe(
        Config.option,
        Effect.orElseSucceed(Option.none),
      );
      if (underTest._tag === "Some") return inner;
      const hostEnvironment = yield* HostProcess.Environment;
      return {
        ...inner,
        open: Effect.fn("LastdropRunnerEnvironment.open")(function* (
          input: ClaudeAgentSdkQueryOpenInput,
        ) {
          const added = yield* runnerVariables(input.threadId);
          const withRunner = withRunnerEnvironment(
            elicitationChoicesLive.onQuery(input),
            hostEnvironment,
            () => added,
          );
          const plugin = boundPlugin();
          return yield* inner.open(
            plugin === undefined ? withRunner : withLastdropPlugin(withRunner, plugin),
          );
        }),
      };
    }),
  ).pipe(Layer.provide(wrapRouting(queryRunner)));

/** The wrapped runner, or T3's own where lastdrop doesn't choose accounts. */
const wrapRouting = <E, R>(
  queryRunner: Layer.Layer<ClaudeAgentSdkQueryRunner, E, R>,
): Layer.Layer<ClaudeAgentSdkQueryRunner, E, R> =>
  Layer.effect(
    ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const inner = yield* ClaudeAgentSdkQueryRunner;
      const routing = yield* lastdropRouting;
      if (routing === undefined) return inner;
      const { router, log, fault } = routing;
      const lineage = yield* lineageReader.pipe(Effect.orElseSucceed(() => undefined));
      if (lineage === undefined)
        log("routing: T3's projection is not readable here; every thread picks as a main thread");
      log("routing: Claude queries choose their account (lastdrop)");
      return wrapQueryRunner(inner, {
        router:
          fault === "throw"
            ? Object.assign(Object.create(router) as ThreadRouter, {
                route: () => Promise.reject(new Error("LASTDROP_FAULT_ROUTE=throw")),
              })
            : router,
        lineage: lineage ?? (() => Effect.succeed(MAIN_THREAD)),
        hostEnvironment: yield* HostProcess.Environment,
        log,
        // After a move at a limit, the thread continues as after a restart (moveContinuationLayer.ts).
        onLimitMove: (move) => pendingContinuations.offer(move),
        onOpen: (threadId) => pendingContinuations.drop(threadId),
      });
    }),
  ).pipe(Layer.provide(queryRunner));
