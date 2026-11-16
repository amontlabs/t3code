// @effect-diagnostics nodeBuiltinImport:off - The real home folder and new session ids; the I/O is lastdrop-node's.
/**
 * Whether lastdrop chooses Claude accounts in this server, and the router it chooses with: on macOS, not under
 * vitest (T3's tests build these layers), unless `LASTDROP_CLAUDE_ROUTING=0`. Shared by the query-runner wrapper
 * and the Claude driver wrapper, so both see the same accounts.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  fileLogger,
  lastdropPaths,
  type LastdropPaths,
  SessionLedger,
  StatusStore,
  statusFile,
  ThreadRouter,
} from "@t3tools/lastdrop-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { lastdropDataDir } from "../dataDir.ts";

export interface LastdropRouting {
  readonly paths: LastdropPaths;
  readonly dataDir: string;
  readonly router: ThreadRouter;
  readonly log: (line: string) => void;
  /** `LASTDROP_FAULT_ROUTE`, for live checks. */
  readonly fault: string | undefined;
}

const setting = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );

const routers = new Map<string, LastdropRouting>();

/** Undefined where lastdrop leaves Claude to T3. */
export const lastdropRouting: Effect.Effect<LastdropRouting | undefined> = Effect.gen(function* () {
  const underTest = yield* setting("VITEST");
  const off = yield* setting("LASTDROP_CLAUDE_ROUTING");
  const platform = yield* HostProcess.Platform;
  const config = yield* Effect.serviceOption(ServerConfig);
  if (platform !== "darwin" || underTest !== undefined || off === "0" || Option.isNone(config)) {
    return undefined;
  }
  const dataDir = lastdropDataDir(config.value);
  // One router per data folder: its full and troubled marks are this server's memory, shared by both wrappers.
  const known = routers.get(dataDir);
  if (known !== undefined) return known;
  // Live checks only (docs/lastdrop/claude-routing.md): sign in through the accounts' real folders while
  // their profiles are built elsewhere, and make choosing fail on purpose. Unset, they change nothing.
  const paths = lastdropPaths({
    home: NodeOS.homedir(),
    dataDir,
    claudeFolders: yield* setting("LASTDROP_CLAUDE_FOLDERS"),
    profiles: yield* setting("LASTDROP_PROFILES"),
  });
  const log = fileLogger(`${dataDir}/lastdrop.log`);
  const statuses = new StatusStore(statusFile(paths));
  const router = new ThreadRouter({
    paths,
    ledger: new SessionLedger(`${dataDir}/sessions.json`),
    statuses: () => statuses.read(),
    newSessionId: () => NodeCrypto.randomUUID(),
    log,
  });
  const routing = { paths, dataDir, router, log, fault: yield* setting("LASTDROP_FAULT_ROUTE") };
  routers.set(dataDir, routing);
  return routing;
});
