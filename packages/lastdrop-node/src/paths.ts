/**
 * Where lastdrop's files are, from one home folder, so tests run against a temporary home and never touch the
 * real `~/.claude`, `~/.t3` or the keychain.
 *
 * The fork owns its accounts: the list, sign-in folders and readings all live in `dataDir` (`~/.t3/lastdrop/`).
 * Main is Claude Code's own login (`~/.claude`). Only `appImport.ts` names the standalone app's folder.
 */
export interface LastdropPaths {
  readonly home: string;
  /** The fork's own folder (`~/.t3/lastdrop/`), from the server's data-dir helper. */
  readonly dataDir: string;
  /** Non-main Claude accounts' sign-in folders (`<dataDir>/accounts`). */
  readonly claudeFolders: string;
  /** Main's Claude Code folder (`~/.claude`). */
  readonly sharedClaude: string;
  /** Main's Claude Code config (`~/.claude.json`). */
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

/** A Claude account's sign-in folder (`CLAUDE_SECURESTORAGE_CONFIG_DIR`); undefined for Main. */
export const claudeFolder = (p: LastdropPaths, key: string): string | undefined =>
  key === "main" ? undefined : `${p.claudeFolders}/${key}`;

/** The profile of a sign-in folder (`<folder>/profile`), for `CLAUDE_CONFIG_DIR`. */
export const profileDirectory = (folder: string, p?: Pick<LastdropPaths, "profiles">) =>
  p?.profiles === undefined
    ? `${folder}/profile`
    : `${p.profiles}/${folder.slice(folder.lastIndexOf("/") + 1)}`;
export const profileConfigFile = (folder: string, p?: Pick<LastdropPaths, "profiles">) =>
  `${profileDirectory(folder, p)}/.claude.json`;
