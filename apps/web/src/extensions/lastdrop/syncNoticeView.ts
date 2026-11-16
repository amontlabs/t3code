/**
 * The fork's update pipeline (`.github/workflows/lastdrop-sync.yml`, `lastdrop-release.yml`) opens a PR or
 * an issue labelled `lastdrop-sync` when an update is stuck. GitHub's issues endpoint lists both.
 */
const SYNC_LABEL = "lastdrop-sync";

export interface SyncNotice {
  readonly title: string;
  readonly url: string;
  readonly more: number;
}

export function syncIssuesUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/issues?state=open&labels=${SYNC_LABEL}&per_page=20`;
}

/** The newest open item, from GitHub's `GET /repos/{repo}/issues` response. */
export function syncNoticeFromIssues(response: unknown): SyncNotice | null {
  if (!Array.isArray(response)) return null;
  const items = response.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { title, html_url: url } = item as { title?: unknown; html_url?: unknown };
    return typeof title === "string" && typeof url === "string" ? [{ title, url }] : [];
  });
  const [first] = items;
  return first ? { ...first, more: items.length - 1 } : null;
}
