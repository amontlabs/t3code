/**
 * Where lastdrop's files are, from one home folder, so tests run against a temporary home. The fork's accounts
 * live in `dataDir` (`~/.t3/lastdrop/`); `~/.claude` lends profiles its settings and conversations, and its login
 * is used only while no fork account is signed in. Only `appImport.ts` names the standalone app's folder.
 */
import { TERMINAL_KEY } from "@t3tools/lastdrop-core";

export interface LastdropPaths {
  readonly home: string;
  /** The fork's own folder (`~/.t3/lastdrop/`), from the server's data-dir helper. */
  readonly dataDir: string;
  /** Every Claude account's sign-in folder's parent (`<dataDir>/accounts`). */
  readonly claudeFolders: string;
  /** Claude Code's own folder (`~/.claude`), which profiles link into. */
  readonly sharedClaude: string;
  /** Claude Code's own config (`~/.claude.json`), which profiles' configs are rebuilt from. */
  readonly sharedConfig: string;
  /** `/usr/bin/security`; tests pass a fake. */
  readonly security: string;
  /**
   * Where accounts' profiles are built: `<folder>/profile` when unset. A live check in a throwaway home sets it,
   * so an account's real sign-in folder is only read.
   */
  readonly profiles?: string | undefined;
}

export function lastdropPaths(input: {
  readonly home: string;
  readonly dataDir: string;
  readonly security?: string;
  readonly profiles?: string | undefined;
  /** The sign-in folders' parent; `<dataDir>/accounts` when unset. */
  readonly claudeFolders?: string | undefined;
}): LastdropPaths {
  const { home } = input;
  return {
    home,
    dataDir: input.dataDir,
    claudeFolders: input.claudeFolders ?? `${input.dataDir}/accounts`,
    sharedClaude: `${home}/.claude`,
    sharedConfig: `${home}/.claude.json`,
    security: input.security ?? "/usr/bin/security",
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
  };
}

/** The fork's account list (the standalone lastdrop's `accounts.json` format). */
export const accountsFile = (p: LastdropPaths) => `${p.dataDir}/accounts.json`;

/** The fork's copy of each account's latest reading and rate-limit block (lastdrop's `usage.json` format). */
export const statusFile = (p: LastdropPaths) => `${p.dataDir}/usage.json`;

/** An empty folder helper CLIs start in, so they never look around the home folder. */
export const helperDirectory = (p: LastdropPaths) => `${p.dataDir}/helper`;

/**
 * A Claude account's sign-in folder (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), Main's included; undefined only for
 * Claude Code's own login (`TERMINAL_KEY`), which has none of the fork's.
 */
export const claudeFolder = (p: LastdropPaths, key: string): string | undefined =>
  key === TERMINAL_KEY ? undefined : `${p.claudeFolders}/${key}`;

/** The profile of a sign-in folder (`<folder>/profile`), for `CLAUDE_CONFIG_DIR`. */
export const profileDirectory = (folder: string, p?: Pick<LastdropPaths, "profiles">) =>
  p?.profiles === undefined
    ? `${folder}/profile`
    : `${p.profiles}/${folder.slice(folder.lastIndexOf("/") + 1)}`;
export const profileConfigFile = (folder: string, p?: Pick<LastdropPaths, "profiles">) =>
  `${profileDirectory(folder, p)}/.claude.json`;
