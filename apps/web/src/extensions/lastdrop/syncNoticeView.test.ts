import { describe, expect, it } from "vite-plus/test";

import { syncNoticeFromIssues } from "./syncNoticeView";

describe("syncNoticeFromIssues", () => {
  it("takes the newest item and counts the rest", () => {
    expect(
      syncNoticeFromIssues([
        { title: "Sync to v0.1.10: rebase conflict", html_url: "https://github.com/o/r/pull/3" },
        { title: "Release v0.1.9-ld.2 failed", html_url: "https://github.com/o/r/issues/2" },
      ]),
    ).toEqual({
      title: "Sync to v0.1.10: rebase conflict",
      url: "https://github.com/o/r/pull/3",
      more: 1,
    });
  });

  it("is null when nothing is open or the response is not a list", () => {
    expect(syncNoticeFromIssues([])).toBeNull();
    expect(syncNoticeFromIssues({ message: "API rate limit exceeded" })).toBeNull();
    expect(syncNoticeFromIssues([{ title: 3 }])).toBeNull();
  });
});
