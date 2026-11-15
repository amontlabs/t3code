// @effect-diagnostics nodeBuiltinImport:off - Two small JSON files under lastdrop's own folder.
/**
 * A map kept in memory and, once attached, in a JSON file under `~/.t3/lastdrop/`, so the agents'
 * entry per native thread and their room marks survive a restart. Whole-file writes through a
 * temporary file; the oldest entries go past `limit`. Each write reads the file again first and keeps
 * the entries another server sharing the folder (`~/.t3`) wrote since, so neither drops the other's.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface StoredMap<V> {
  readonly get: (key: string) => V | undefined;
  readonly set: (key: string, value: V) => void;
  readonly delete: (key: string) => void;
  /** Every entry, oldest first. */
  readonly entries: () => ReadonlyArray<readonly [string, V]>;
  /** Loads the file (its entries win) and writes every later change to it. */
  readonly attach: (file: string) => void;
}

export const makeStoredMap = <V>(limit = 5_000): StoredMap<V> => {
  const map = new Map<string, V>();
  /** Keys deleted here since the last write: the file's copy of them isn't taken back. */
  const deleted = new Set<string>();
  let file: string | undefined;
  const read = (path: string): Record<string, V> => {
    try {
      return JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, V>;
    } catch {
      return {};
    }
  };
  const write = () => {
    if (file === undefined) return;
    // Another server's entries first (older than this change), then ours in their order.
    const merged = new Map<string, V>();
    for (const [key, value] of Object.entries(read(file))) {
      if (!map.has(key) && !deleted.has(key)) merged.set(key, value);
    }
    for (const [key, value] of map) merged.set(key, value);
    map.clear();
    for (const [key, value] of merged) map.set(key, value);
    deleted.clear();
    while (map.size > limit) map.delete(map.keys().next().value!);
    try {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
      NodeFS.renameSync(temporary, file);
    } catch {
      // A write that fails keeps the map in memory; the next change tries again.
    }
  };
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.delete(key);
      map.set(key, value);
      write();
    },
    delete: (key) => {
      deleted.add(key);
      if (map.delete(key)) write();
    },
    entries: () => [...map.entries()],
    attach: (path) => {
      file = path;
      // Missing or unreadable: start empty.
      for (const [key, value] of Object.entries(read(path))) map.set(key, value);
    },
  };
};
