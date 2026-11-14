/** Small file helpers: reads that treat a missing or unreadable file as absent, and atomic writes. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A JSON object from `path`; undefined when missing, unreadable or not an object. */
export async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes through a temporary file and a rename, so readers never see half a file. */
export async function writeAtomic(path: string, contents: string, mode = 0o600): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp.lastdrop.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    await NodeFSP.writeFile(temp, contents, { mode });
    await NodeFSP.rename(temp, path);
  } catch (error) {
    await NodeFSP.rm(temp, { force: true });
    throw error;
  }
}

/** Appends timestamped lines to `path` (lastdrop's own log, like the app's `subagents.log`). Never throws. */
export function fileLogger(path: string): (line: string) => void {
  return (line) => {
    void NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 })
      .then(() => NodeFSP.appendFile(path, `${new Date().toISOString()} ${line}\n`))
      .catch(() => {});
  };
}
