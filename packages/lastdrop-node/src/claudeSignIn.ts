/**
 * Claude Code's sign-ins as lastdrop reads them, and renewing one by starting Claude Code. Port of headroom's
 * `ClaudeProvider.storedCredentials`/`signedInAccount`, `ClaudeSignIn.renew`, `SubagentRunner.executable` and
 * `ClaudeCodeHeaders.installedVersion`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import {
  type AccountsConfig,
  claudeCodeVersion,
  keychainService,
  loadAccountsConfig,
  type SignInFacts,
  signedInAccount,
  signInFacts,
} from "@t3tools/lastdrop-core";

import { readJsonObject, readText } from "./files.ts";
import { readKeychain } from "./keychain.ts";
import { runEnvironment, withoutCallerIdentity } from "./claudeProfile.ts";
import { accountsFiles, claudeFolder, helperDirectory, type LastdropPaths } from "./paths.ts";

/** The account list the standalone lastdrop keeps (read only: the fork never rewrites it here). */
export async function loadAccounts(paths: LastdropPaths, now: number): Promise<AccountsConfig> {
  const files = accountsFiles(paths);
  return loadAccountsConfig(
    { accounts: await readText(files.accounts), legacy: await readText(files.legacy) },
    now,
  );
}

/** Claude Code's credentials blob for a config folder: the keychain, else `<folder>/.credentials.json`. */
export async function storedCredentials(
  paths: LastdropPaths,
  configDir: string | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<string | undefined> {
  const raw = await readKeychain(paths.security, keychainService(configDir));
  if (raw) return raw;
  const fromEnv = env["CLAUDE_CONFIG_DIR"]?.replace(/^~(?=\/|$)/u, paths.home);
  const dir = configDir ?? fromEnv ?? paths.sharedClaude;
  return readText(`${dir}/.credentials.json`);
}

export async function readSignInFacts(
  paths: LastdropPaths,
  configDir: string | undefined,
): Promise<SignInFacts | undefined> {
  const raw = await storedCredentials(paths, configDir);
  return raw === undefined ? undefined : signInFacts(raw);
}

/** The account a config folder is signed in to (`oauthAccount` in its `.claude.json`, Main's `~/.claude.json`). */
export async function signedInAccountOf(
  paths: LastdropPaths,
  configDir: string | undefined,
): Promise<{ readonly uuid: string | undefined; readonly email: string | undefined }> {
  return signedInAccount(
    await readJsonObject(
      configDir === undefined ? paths.sharedConfig : `${configDir}/.claude.json`,
    ),
  );
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path, NodeFSP.constants.X_OK);
    return (await NodeFSP.stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The native install first (it updates itself), then the `claude` on PATH. */
export async function claudeExecutable(
  paths: LastdropPaths,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const candidates = [
    `${paths.home}/.local/bin/claude`,
    ...(env["PATH"] ?? "")
      .split(":")
      .filter(Boolean)
      .map((dir) => `${dir}/claude`),
    ...(env["CLAUDE_CODE_EXECPATH"] ? [env["CLAUDE_CODE_EXECPATH"]] : []),
  ];
  for (const c of candidates) if (await isExecutable(c)) return c;
  return undefined;
}

/** The Claude Code version installed now, so the User-Agent follows its updates. */
export async function installedClaudeCodeVersion(paths: LastdropPaths): Promise<string> {
  const target = await NodeFSP.readlink(`${paths.home}/.local/bin/claude`).catch(() => undefined);
  const installed = await NodeFSP.readdir(`${paths.home}/.local/share/claude/versions`).catch(
    () => [] as string[],
  );
  return claudeCodeVersion(target, installed);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claude Code renews a sign-in when it starts with under 5 minutes left; lastdrop never asks Anthropic for
 * tokens itself. So this starts Claude Code with no prompt in the account's folder (no usage spent) and watches
 * the stored token's expiry move. True when it did. Takes up to 30 s.
 */
export async function renewSignIn(
  paths: LastdropPaths,
  key: string,
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly log?: (line: string) => void;
    readonly pollMs?: number;
    readonly polls?: number;
    readonly now?: () => number;
  },
): Promise<boolean> {
  const log = options.log ?? (() => {});
  const claude = await claudeExecutable(paths, options.env);
  if (!claude) return false;
  const folder = claudeFolder(paths, key);
  const expiry = async () => (await readSignInFacts(paths, folder))?.expiresAt;
  const before = await expiry();
  log(`renewing the ${key} sign-in`);
  // The sign-in is renewed where it lives (with its refresh lock), so this runs in the account's folder.
  const env = await runEnvironment(paths, key, withoutCallerIdentity(options.env));
  env["LASTDROP_SUBAGENT"] = "1";
  delete env["CLAUDE_SECURESTORAGE_CONFIG_DIR"];
  if (folder) env["CLAUDE_CONFIG_DIR"] = folder;
  const cwd = helperDirectory(paths);
  await NodeFSP.mkdir(cwd, { recursive: true, mode: 0o700 });
  let running = true;
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(
      claude,
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      { env, cwd, stdio: ["pipe", "ignore", "ignore"] },
    );
  } catch {
    return false;
  }
  child.on("error", () => (running = false));
  child.on("exit", () => (running = false));
  try {
    for (let i = 0; i < (options.polls ?? 15); i++) {
      await sleep(options.pollMs ?? 2000);
      const wasRunning = running; // before the read: a sign-in written as it exits still counts
      const after = await expiry();
      if (after !== undefined && after !== before && after > (options.now ?? Date.now)()) {
        log(`renewed the ${key} sign-in, until ${new Date(after).toISOString()}`);
        return true;
      }
      if (!wasRunning) break;
    }
    log(`the ${key} sign-in wasn't renewed`);
    return false;
  } finally {
    // No prompt: it exits by itself once stdin closes. One still running after that is stuck: stop it.
    child.stdin?.end();
    if (running) setTimeout(() => running && child.kill("SIGTERM"), 5000).unref();
  }
}
