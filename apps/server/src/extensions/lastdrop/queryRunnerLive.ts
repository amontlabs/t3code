// @effect-diagnostics nodeBuiltinImport:off - The real home folder and new session ids; the I/O is lastdrop-node's.
/**
 * The wrapper as the server runs it: the router over the real home, lineage from T3's projection. Only on
 * macOS and not under vitest (T3's tests build this layer); elsewhere T3's runner is returned unchanged.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { isDelegatedAppThread, ThreadId } from "@t3tools/contracts";
import {
  fileLogger,
  lastdropPaths,
  routingStatuses,
  SessionLedger,
  ThreadRouter,
} from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ClaudeAgentSdkQueryRunner } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProjectionStoreV2 from "../../orchestration-v2/ProjectionStore.ts";
import { lastdropDataDir } from "../dataDir.ts";
import { type ThreadLineage, wrapQueryRunner } from "./queryRunner.ts";

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

/** The wrapped runner, or T3's own where lastdrop doesn't choose accounts. */
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
      const off = yield* Config.String("LASTDROP_CLAUDE_ROUTING").pipe(
        Config.option,
        Effect.orElseSucceed(Option.none),
      );
      const platform = yield* HostProcess.Platform;
      const config = yield* Effect.serviceOption(ServerConfig);
      if (
        platform !== "darwin" ||
        underTest._tag === "Some" ||
        (off._tag === "Some" && off.value === "0") ||
        Option.isNone(config)
      ) {
        return inner;
      }
      const dataDir = lastdropDataDir(config.value);
      const home = NodeOS.homedir();
      const paths = lastdropPaths({ home, dataDir });
      const log = fileLogger(`${dataDir}/lastdrop.log`);
      const router = new ThreadRouter({
        paths,
        ledger: new SessionLedger(`${dataDir}/sessions.json`),
        // @effect-diagnostics-next-line globalDate:off - the router's reads are plain promises.
        statuses: () => routingStatuses(paths, Date.now()),
        newSessionId: () => NodeCrypto.randomUUID(),
        log,
      });
      const lineage = yield* lineageReader.pipe(Effect.orElseSucceed(() => undefined));
      if (lineage === undefined)
        log("routing: T3's projection is not readable here; every thread picks as a main thread");
      log("routing: Claude queries choose their account (lastdrop)");
      return wrapQueryRunner(inner, {
        router,
        lineage: lineage ?? (() => Effect.succeed(MAIN_THREAD)),
        hostEnvironment: yield* HostProcess.Environment,
        log,
      });
    }),
  ).pipe(Layer.provide(queryRunner));
