/**
 * Which keys of Claude Code's `.claude.json` belong to the signed-in account (headroom's `ClaudeProfile`). A
 * non-main account's profile config is Main's with these swapped in, so accounts never discard each other's
 * cached answers and get rate limited asking again. Building the folder is `@t3tools/lastdrop-node`'s.
 */

/** Keys Claude Code itself clears when signing out (2.1.321), and other answers about the signed-in account. */
export const OWN_KEYS: ReadonlySet<string> = new Set([
  "oauthAccount",
  "managedSettingsNoticeSeenOrg",
  "additionalModelOptionsAnsweredAt",
  "artifactRosterDenied",
  "lastSeenOrgDefaultUpdatedAt",
  "startupPrefetchedAt",
  "userID",
  "machineID",
  "claudeCodeFirstTokenDate",
  "penguinModeOrgEnabled",
  "claudeAiMcpEverConnected",
  "hasAvailableSubscription",
  "hasAvailableMaxSubscription",
  "claudeMaxTier",
  "recommendedSubscription",
  "isQualifiedForDataSharing",
  "promoCreditCheck",
  "orgSurveyCheck",
  "fable51OrgPickMoveDone",
  "fable51OrgPickMoveWaitingSince",
]);

/** The account's own: the keys above and every cache. Any other key, known or not, is shared. */
export const isOwnKey = (key: string): boolean =>
  OWN_KEYS.has(key) || key.toLowerCase().includes("cache");

type Config = Readonly<Record<string, unknown>>;

/** Main's config with the account's own keys in place of Main's. */
export function mergedProfileConfig(main: Config, own: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(main)) if (!isOwnKey(k)) out[k] = v;
  for (const [k, v] of Object.entries(own)) if (isOwnKey(k)) out[k] = v;
  return out;
}

const uuidOf = (config: Config | undefined): string | undefined => {
  const account = config?.["oauthAccount"];
  if (typeof account !== "object" || account === null) return undefined;
  const uuid = (account as Record<string, unknown>)["accountUuid"];
  return typeof uuid === "string" ? uuid : undefined;
};

/**
 * Where the account's own keys are read: the profile, which its sessions keep current, unless the folder has
 * since been signed in to another account (or the profile is new), and then the folder's.
 */
export function profileOwnState(profile: Config | undefined, folder: Config | undefined): Config {
  const signedIn = uuidOf(profile);
  if (!profile || signedIn === undefined) return folder ?? profile ?? {};
  const now = uuidOf(folder);
  if (now !== undefined && now !== signedIn) return folder ?? {};
  return profile;
}

/** Files of `~/.claude` a profile shares besides its folders: the ones the user writes, and every `.md`. */
export const SHARED_FILES: ReadonlySet<string> = new Set([
  "settings.json",
  "settings.local.json",
  "keybindings.json",
  "history.jsonl",
]);
export const isSharedFile = (name: string): boolean =>
  SHARED_FILES.has(name) || name.endsWith(".md");
/** Folders that go with `.claude.json`: its backups. */
export const OWN_FOLDERS: ReadonlySet<string> = new Set(["backups"]);

/** Deep equality of two JSON values, ignoring key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameJson((a as Config)[k], (b as Config)[k]));
}
