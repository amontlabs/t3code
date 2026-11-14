/**
 * A non-main account's Claude Code profile: `~/.claude` seen through links, with a `.claude.json` of its own
 * rebuilt from Main's each time a session starts. Port of headroom's `ClaudeProfile.prepare`/`link`/`sync`/
 * `locked` and `ClaudeAccount.runEnvironment` (ClaudeProfile.swift, ClaudeAccounts.swift). The key rules are
 * in `@t3tools/lastdrop-core`.
 */
import * as NodeFSP from "node:fs/promises";

import {
  isSharedFile,
  mergedProfileConfig,
  OWN_FOLDERS,
  profileOwnState,
  sameJson,
} from "@t3tools/lastdrop-core";

import { exists, readJsonObject } from "./files.ts";
import { claudeFolder, type LastdropPaths, profileConfigFile, profileDirectory } from "./paths.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claude Code saves its config while holding `<file>.lock`, a folder (proper-lockfile): making it is taking the
 * lock. Waits a moment for a save in progress, then gives up without running `body`.
 */
export async function withConfigLock(file: string, body: () => Promise<void>): Promise<void> {
  const lock = `${file}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      await NodeFSP.mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || tries >= 20) throw error;
      await sleep(25);
    }
  }
  try {
    await body();
  } finally {
    await NodeFSP.rmdir(lock).catch(() => {});
  }
}

/** Links what `~/.claude` holds and the profile doesn't have yet. Nothing already there is touched. */
export async function linkShared(paths: LastdropPaths, dir: string): Promise<void> {
  let names: string[];
  try {
    names = await NodeFSP.readdir(paths.sharedClaude);
  } catch {
    return;
  }
  for (const name of names) {
    const source = `${paths.sharedClaude}/${name}`;
    const target = `${dir}/${name}`;
    const stat = await NodeFSP.stat(source).catch(() => undefined);
    if (!stat) continue;
    if (stat.isDirectory() ? OWN_FOLDERS.has(name) : !isSharedFile(name)) continue;
    if (await exists(target)) continue;
    await NodeFSP.symlink(source, target).catch(() => {});
  }
}

/**
 * Rewrites the profile's `.claude.json` from Main's and the account's own keys, under Claude Code's config lock.
 * Skipped while Main's config can't be read; throws while the lock stays held (the next start does it).
 */
export async function syncProfile(paths: LastdropPaths, folder: string): Promise<void> {
  const file = profileConfigFile(folder);
  const main = await readJsonObject(paths.sharedConfig);
  if (!main) return;
  await withConfigLock(file, async () => {
    const profile = await readJsonObject(file);
    const config = mergedProfileConfig(
      main,
      profileOwnState(profile, await readJsonObject(`${folder}/.claude.json`)),
    );
    // Nothing new, however Claude Code last laid the file out: running sessions aren't made to re-read it.
    if (profile && sameJson(profile, config)) return;
    const temp = `${file}.tmp.lastdrop.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      await NodeFSP.writeFile(temp, JSON.stringify(sortedDeep(config), null, 2), { mode: 0o600 });
      await NodeFSP.rename(temp, file);
    } catch (error) {
      await NodeFSP.rm(temp, { force: true });
      throw error;
    }
  });
}

/**
 * Brings the account's profile up to date and returns it, for `CLAUDE_CONFIG_DIR`. Undefined when there is
 * none to use (no sign-in folder, or Main's config can't be read and no profile was made before).
 */
export async function prepareProfile(
  paths: LastdropPaths,
  folder: string,
  log: (line: string) => void = () => {},
): Promise<string | undefined> {
  const dir = profileDirectory(folder);
  if (!(await exists(folder))) return undefined; // no sign-in folder: no account to run as
  try {
    await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
    await linkShared(paths, dir);
    await syncProfile(paths, folder);
  } catch (error) {
    log(`the profile at ${dir} wasn't brought up to date: ${(error as Error).message}`);
  }
  return (await exists(`${dir}/.claude.json`)) ? dir : undefined;
}

/**
 * The environment to run claude on an account. Main runs as it is. Another account signs in through
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` (its folder) and runs in its profile (`CLAUDE_CONFIG_DIR`). Building it
 * brings that profile up to date.
 */
export async function runEnvironment(
  paths: LastdropPaths,
  key: string,
  base: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k !== "CLAUDE_CONFIG_DIR" && k !== "CLAUDE_SECURESTORAGE_CONFIG_DIR")
      env[k] = v;
  }
  const folder = claudeFolder(paths, key);
  if (folder) {
    env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] = folder;
    const profile = await prepareProfile(paths, folder);
    if (profile) env["CLAUDE_CONFIG_DIR"] = profile;
  }
  return env;
}

/** Drops the calling session's identity, as headroom's `SubagentRunner.environment` does. */
export const withoutCallerIdentity = (
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !(
          entry[0].startsWith("CLAUDE_CODE_") ||
          entry[0].startsWith("CLAUDE_AGENT_") ||
          entry[0] === "CLAUDECODE" ||
          entry[0] === "CLAUDE_EFFORT" ||
          entry[0] === "CLAUDE_PID" ||
          entry[0].startsWith("ANTHROPIC_") ||
          entry[0] === "MAX_THINKING_TOKENS"
        ),
    ),
  );

/** Swift wrote with `.sortedKeys`; sorted top-level keys keep the file diffable. */
function sortedDeep(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((k) => [k, value[k]]),
  );
}
