/**
 * The headers Claude Code sends to Anthropic's OAuth endpoints (usage, profile). Anthropic decides from them
 * which app is asking, and offers reset grants to Claude Code only. Port of headroom's `ClaudeCodeHeaders`;
 * the installed version is read by `@t3tools/lastdrop-node`.
 */

/** Used when no installed Claude Code can be found. */
export const FALLBACK_CLAUDE_CODE_VERSION = "2.1.321";

/** `claude-cli/2.1.321 (external, cli)`. */
export const claudeCodeUserAgent = (version: string): string =>
  `claude-cli/${version} (external, cli)`;

/** What Claude Code's OAuth client sends: `x-app`, User-Agent, session id, bearer, OAuth beta, JSON. */
export function claudeCodeOAuthHeaders(
  accessToken: string,
  version: string,
  sessionId: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "x-app": "cli",
    "User-Agent": claudeCodeUserAgent(version),
    "X-Claude-Code-Session-Id": sessionId,
  };
}

const isVersion = (s: string) => /^\d+\.\d+\.\d+$/u.test(s);

const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
};

/** The version the `claude` launcher points at (`…/claude/versions/2.1.321`), else the newest installed. */
export function claudeCodeVersion(
  launcherTarget: string | undefined,
  installed: ReadonlyArray<string>,
): string {
  const name = launcherTarget?.split("/").pop();
  if (name && isVersion(name)) return name;
  const versions = installed.filter(isVersion).toSorted(compareVersions);
  return versions.at(-1) ?? FALLBACK_CLAUDE_CODE_VERSION;
}
