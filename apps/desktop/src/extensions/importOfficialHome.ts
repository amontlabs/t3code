/**
 * First launch: copy the official T3 Code home (`~/.t3`) into the fork's home once, so the fork
 * starts with the user's projects, threads and settings. The official folder is only read.
 *
 * Synchronous on purpose: it runs from the desktop entry point before Electron is ready, and
 * T3's pre-ready setup (Clerk's scheme) must not yield to the event loop first.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Runs before the Effect runtime exists.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Runs before the Effect runtime exists.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/** Top-level entries copied. Others are rebuilt by the app or hold paths into `~/.t3`. */
const COPIED_TOP_LEVEL = new Set(["userdata", "tools"]);

/**
 * Entries of `userdata` left behind: the running server's lock and port, logs, and the environment
 * id, so the fork is its own environment for remote clients and the relay.
 */
const SKIPPED_STATE_ENTRIES = new Set([
  "logs",
  "server-owner.sqlite",
  "server-owner.sqlite-journal",
  "server-runtime.json",
  "environment-id",
]);

const SQLITE_HEADER = "SQLite format 3\0";

export type ImportOutcome =
  | { readonly _tag: "Imported"; readonly databases: number; readonly files: number }
  | { readonly _tag: "Skipped"; readonly reason: "target-exists" | "no-source" };

const isSqliteDatabase = (file: string): boolean => {
  const header = Buffer.alloc(SQLITE_HEADER.length);
  const fd = NodeFS.openSync(file, "r");
  try {
    const read = NodeFS.readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.toString("latin1") === SQLITE_HEADER;
  } finally {
    NodeFS.closeSync(fd);
  }
};

const cloneFile = (source: string, destination: string): void => {
  // A copy-on-write clone on APFS: instant and no extra space until either side changes.
  NodeFS.copyFileSync(source, destination, NodeFS.constants.COPYFILE_FICLONE);
};

/**
 * One consistent copy, even while the official app writes. With a `-wal`, a read-only
 * `VACUUM INTO` snapshots one committed state, WAL included. Without one no WAL writer is open:
 * clone the file (and a hot `-journal`), since opening it could create files in `~/.t3`.
 */
const copyDatabase = (source: string, destination: string): void => {
  if (!NodeFS.existsSync(`${source}-wal`)) {
    cloneFile(source, destination);
    if (NodeFS.existsSync(`${source}-journal`)) {
      cloneFile(`${source}-journal`, `${destination}-journal`);
    }
    return;
  }
  const db = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  // VACUUM INTO writes a rollback-journal file; the server opens its databases in WAL mode.
  const copy = new NodeSqlite.DatabaseSync(destination);
  try {
    copy.exec("PRAGMA journal_mode = WAL");
  } finally {
    copy.close();
  }
};

const isSidecar = (name: string): boolean =>
  name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal");

interface Counts {
  databases: number;
  files: number;
}

const copyTree = (
  source: string,
  destination: string,
  skip: (name: string) => boolean,
  counts: Counts,
): void => {
  NodeFS.mkdirSync(destination, { mode: NodeFS.statSync(source).mode & 0o777 });
  for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      NodeFS.symlinkSync(NodeFS.readlinkSync(from), to);
    } else if (entry.isDirectory()) {
      copyTree(from, to, isSidecarOfDatabase(from), counts);
    } else if (entry.isFile()) {
      if (isSqliteDatabase(from)) {
        copyDatabase(from, to);
        counts.databases += 1;
      } else {
        cloneFile(from, to);
        counts.files += 1;
      }
    }
  }
};

/** In a folder, skip `-wal`/`-shm`/`-journal` files whose database is copied by `copyDatabase`. */
const isSidecarOfDatabase =
  (directory: string) =>
  (name: string): boolean =>
    isSidecar(name) &&
    NodeFS.existsSync(NodePath.join(directory, name.replace(/-(wal|shm|journal)$/u, "")));

/**
 * Copies `sourceHome` into `targetHome` when the target does not exist yet. The copy is built in a
 * staging folder beside the target and renamed into place, so a failed or interrupted import
 * leaves no target and runs again next launch. A second app instance racing the first keeps
 * whichever rename lands first.
 */
export function importOfficialHome(input: {
  readonly sourceHome: string;
  readonly targetHome: string;
}): ImportOutcome {
  const { sourceHome, targetHome } = input;
  if (NodeFS.existsSync(targetHome)) return { _tag: "Skipped", reason: "target-exists" };
  if (!NodeFS.existsSync(sourceHome)) return { _tag: "Skipped", reason: "no-source" };

  const staging = `${targetHome}.importing-${process.pid}`;
  NodeFS.rmSync(staging, { recursive: true, force: true });
  const counts: Counts = { databases: 0, files: 0 };
  try {
    NodeFS.mkdirSync(staging, { mode: 0o700 });
    for (const entry of NodeFS.readdirSync(sourceHome, { withFileTypes: true })) {
      if (!entry.isDirectory() || !COPIED_TOP_LEVEL.has(entry.name)) continue;
      const from = NodePath.join(sourceHome, entry.name);
      const skip =
        entry.name === "userdata"
          ? (name: string) => SKIPPED_STATE_ENTRIES.has(name) || isSidecarOfDatabase(from)(name)
          : isSidecarOfDatabase(from);
      copyTree(from, NodePath.join(staging, entry.name), skip, counts);
    }
    try {
      NodeFS.renameSync(staging, targetHome);
    } catch (error) {
      // Another instance finished first: keep its copy.
      if (NodeFS.existsSync(targetHome)) {
        NodeFS.rmSync(staging, { recursive: true, force: true });
        return { _tag: "Skipped", reason: "target-exists" };
      }
      throw error;
    }
  } catch (error) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { _tag: "Imported", ...counts };
}
