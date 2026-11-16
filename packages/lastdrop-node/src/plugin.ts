/**
 * lastdrop's Claude Code plugin on disk: the vendored folder (`packages/lastdrop-plugin`) is embedded in
 * `pluginFiles.generated.ts`, so the server, a bundle and the packaged app all carry it without a resource
 * beside them, and each start writes it under lastdrop's folder for the Agent SDK's `plugins` option to load.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readText, writeAtomic } from "./files.ts";
import { PLUGIN_FILES } from "./pluginFiles.generated.ts";

/** The plugin's marketplace id when the lastdrop app installed it: turned off in the fork's queries. */
export const APP_PLUGIN_ID = "lastdrop@lastdrop";

/** `<lastdrop data dir>/plugin/lastdrop`: what the SDK loads. */
export const pluginDirectory = (dataDir: string): string =>
  NodePath.join(dataDir, "plugin", "lastdrop");

async function filesBelow(directory: string, prefix = ""): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesBelow(NodePath.join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    ),
  );
  return nested.flat();
}

/** Writes the plugin's files that differ and removes the ones it no longer has; returns the plugin's folder. */
export async function installPlugin(
  dataDir: string,
  files: Readonly<Record<string, string>> = PLUGIN_FILES,
): Promise<string> {
  const root = pluginDirectory(dataDir);
  for (const [path, contents] of Object.entries(files)) {
    const target = NodePath.join(root, path);
    if ((await readText(target)) !== contents) await writeAtomic(target, contents, 0o644);
  }
  for (const path of await filesBelow(root)) {
    if (!Object.hasOwn(files, path)) await NodeFSP.rm(NodePath.join(root, path), { force: true });
  }
  return root;
}
