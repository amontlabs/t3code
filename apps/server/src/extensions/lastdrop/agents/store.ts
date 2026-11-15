// @effect-diagnostics nodeBuiltinImport:off - Two small JSON files under lastdrop's own folder.
/**
 * A map kept in memory and, once attached, in a JSON file under `~/.t3/lastdrop/`, so the agents'
 * entry per native thread and their room marks survive a restart. Whole-file writes through a
 * temporary file; the oldest entries go past `limit`.
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
  let file: string | undefined;
  const write = () => {
    if (file === undefined) return;
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
      if (map.delete(key)) write();
    },
    entries: () => [...map.entries()],
    attach: (path) => {
      file = path;
      try {
        const stored = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, V>;
        for (const [key, value] of Object.entries(stored)) map.set(key, value);
      } catch {
        // Missing or unreadable: start empty.
      }
    },
  };
};
