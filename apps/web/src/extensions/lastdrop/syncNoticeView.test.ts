import { describe, expect, it } from "vite-plus/test";

import { syncNotice } from "./syncNoticeView";

const pull = (title: string, labels: string[]) => ({
  title,
  html_url: `https://github.com/o/r/pull/${title.length}`,
  labels: labels.map((name) => ({ name })),
});
const runs = (conclusion: string) => ({
  workflow_runs: [
    { conclusion, head_branch: "v0.1.9-ld.4", html_url: "https://github.com/o/r/actions/runs/1" },
  ],
});

describe("syncNotice", () => {
  it("lists labelled sync PRs, then a failed release, and counts the rest", () => {
    expect(
      syncNotice(
        [pull("Sync to v0.1.10: merge conflict", ["lastdrop-sync"]), pull("Unrelated", ["bug"])],
        runs("failure"),
      ),
    ).toEqual({
      title: "Sync to v0.1.10: merge conflict",
      url: "https://github.com/o/r/pull/31",
      more: 1,
    });
    expect(syncNotice([], runs("failure"))).toEqual({
      title: "Release v0.1.9-ld.4 failed",
      url: "https://github.com/o/r/actions/runs/1",
      more: 0,
    });
  });

  it("is null when nothing is stuck or GitHub answers with something else", () => {
    expect(syncNotice([pull("Unrelated", [])], runs("success"))).toBeNull();
    expect(syncNotice({ message: "API rate limit exceeded" }, { workflow_runs: [] })).toBeNull();
    expect(syncNotice(undefined, undefined)).toBeNull();
  });
});
