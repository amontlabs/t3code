/**
 * A fork update is stuck while the sync (`.github/workflows/lastdrop-sync.yml`) has an open PR labelled
 * `lastdrop-sync`, or while the latest finished release run (`lastdrop-release.yml`) failed. Both come from
 * GitHub's public API. Issues are off on the fork, so neither is an issue.
 */
const SYNC_LABEL = "lastdrop-sync";

export interface SyncNotice {
  readonly title: string;
  readonly url: string;
  readonly more: number;
}

interface Item {
  readonly title: string;
  readonly url: string;
}

export function syncPullsUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/pulls?state=open&base=lastdrop&per_page=30`;
}

export function releaseRunsUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/actions/workflows/lastdrop-release.yml/runs?status=completed&per_page=1`;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** Open sync PRs, from GitHub's `GET /repos/{repo}/pulls` response. */
function stuckSyncs(response: unknown): Item[] {
  if (!Array.isArray(response)) return [];
  return response.flatMap((value: unknown) => {
    const pull = record(value);
    const labels = Array.isArray(pull?.labels) ? pull.labels : [];
    const labelled = labels.some((label: unknown) => record(label)?.name === SYNC_LABEL);
    const { title, html_url: url } = pull ?? {};
    return labelled && typeof title === "string" && typeof url === "string" ? [{ title, url }] : [];
  });
}

/** The latest finished release run if it failed, from `GET .../workflows/{file}/runs`. */
function failedRelease(response: unknown): Item[] {
  const runs = record(response)?.workflow_runs;
  const run = Array.isArray(runs) ? record(runs[0]) : null;
  if (run?.conclusion !== "failure" || typeof run.html_url !== "string") return [];
  const tag = typeof run.head_branch === "string" ? run.head_branch : "the latest tag";
  return [{ title: `Release ${tag} failed`, url: run.html_url }];
}

export function syncNotice(pulls: unknown, releaseRuns: unknown): SyncNotice | null {
  const [first, ...rest] = [...stuckSyncs(pulls), ...failedRelease(releaseRuns)];
  return first ? { ...first, more: rest.length } : null;
}
