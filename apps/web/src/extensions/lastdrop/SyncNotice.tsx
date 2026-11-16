/**
 * Sidebar warning when a fork update is stuck: an upstream sync Claude could not finish, or a release
 * that failed to build. Electron's updater only sees published releases, so without this a stuck sync
 * looks the same as being up to date. Reads the repository's public API, no sign-in.
 */
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";

import { type SyncNotice, syncIssuesUrl, syncNoticeFromIssues } from "./syncNoticeView";

const REPOSITORY = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
// Unauthenticated GitHub API calls are limited to 60 an hour per address.
const POLL_MS = 30 * 60 * 1000;

export function LastdropSyncNotice() {
  return isElectron && REPOSITORY ? <SyncNoticeContent repository={REPOSITORY} /> : null;
}

function SyncNoticeContent({ repository }: { readonly repository: string }) {
  const [notice, setNotice] = useState<SyncNotice | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls GitHub, outside React
  useEffect(() => {
    const controller = new AbortController();
    const check = () =>
      fetch(syncIssuesUrl(repository), {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((body: unknown) => {
          if (body !== undefined) setNotice(syncNoticeFromIssues(body));
        })
        .catch(() => {});
    void check();
    const timer = window.setInterval(check, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [repository]);

  if (!notice) return null;
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Fork update needs attention</AlertTitle>
      <AlertDescription>
        <button
          type="button"
          className="text-left underline underline-offset-2"
          onClick={() => void readLocalApi()?.shell.openExternal(notice.url)}
        >
          {notice.title}
        </button>
        {notice.more > 0 ? ` and ${notice.more} more` : null}
      </AlertDescription>
    </Alert>
  );
}
