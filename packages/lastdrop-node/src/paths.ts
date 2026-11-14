/**
 * Where lastdrop's files are, from one home folder, so tests run against a temporary home and never touch the
 * real `~/.claude`, `~/.claude-accounts`, `~/.t3` or the keychain.
 *
 * The account list and sign-in folders are the standalone lastdrop's (read where it keeps them, so both apps
 * share one set of accounts). State only the fork keeps goes in `dataDir` (`~/.t3/lastdrop/`).
 */
export interface LastdropPaths {
  readonly home: string;
  /** The standalone lastdrop's support folder (`~/Library/Application Support/lastdrop`). */
  readonly swiftSupport: string;
  /** The fork's own folder (`~/.t3/lastdrop/`), from the server's data-dir helper. */
  readonly dataDir: string;
  /** Non-main Claude accounts' sign-in folders (`~/.claude-accounts`). */
  readonly claudeFolders: string;
  /** Main's Claude Code folder (`~/.claude`). */
  readonly sharedClaude: string;
  /** Main's Claude Code config (`~/.claude.json`). */
  readonly sharedConfig: string;
  /** `/usr/bin/security`; tests pass a fake. */
  readonly security: string;
}

export function lastdropPaths(input: {
  readonly home: string;
  readonly dataDir: string;
  readonly security?: string;
}): LastdropPaths {
  const { home } = input;
  return {
    home,
    swiftSupport: `${home}/Library/Application Support/lastdrop`,
    dataDir: input.dataDir,
    claudeFolders: `${home}/.claude-accounts`,
    sharedClaude: `${home}/.claude`,
    sharedConfig: `${home}/.claude.json`,
    security: input.security ?? "/usr/bin/security",
  };
}

/** `accounts.json` and the older `claude-accounts.json`, in the standalone lastdrop's folder. */
export const accountsFiles = (p: LastdropPaths) => ({
  accounts: `${p.swiftSupport}/accounts.json`,
  legacy: `${p.swiftSupport}/claude-accounts.json`,
});

/** The fork's copy of each account's latest reading and rate-limit block (lastdrop's `usage.json` format). */
export const statusFile = (p: LastdropPaths) => `${p.dataDir}/usage.json`;

/** An empty folder helper CLIs start in, so they never look around the home folder. */
export const helperDirectory = (p: LastdropPaths) => `${p.dataDir}/helper`;

/** A Claude account's sign-in folder (`CLAUDE_SECURESTORAGE_CONFIG_DIR`); undefined for Main. */
export const claudeFolder = (p: LastdropPaths, key: string): string | undefined =>
  key === "main" ? undefined : `${p.claudeFolders}/${key}`;

/** The profile of a sign-in folder (`<folder>/profile`), for `CLAUDE_CONFIG_DIR`. */
export const profileDirectory = (folder: string) => `${folder}/profile`;
export const profileConfigFile = (folder: string) => `${profileDirectory(folder)}/.claude.json`;
