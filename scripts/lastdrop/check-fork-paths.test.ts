import { assert, describe, it } from "@effect/vitest";

import { checkForkPaths, parseNumstat, type SeamsConfig } from "./check-fork-paths.ts";

const config: SeamsConfig = {
  allowed: [
    "packages/lastdrop-*/**",
    "apps/*/src/extensions/**",
    "packages/client-runtime/src/extensions.ts",
    ".github/workflows/lastdrop-*",
    "FORK.md",
  ],
  exempt: ["pnpm-lock.yaml"],
  seams: { "apps/server/src/server.ts": { budget: 3, why: "layer and routes" } },
};

describe("checkForkPaths", () => {
  it("accepts fork folders, exempt files and seams within budget", () => {
    const violations = checkForkPaths(
      [
        { path: "packages/lastdrop-core/src/pick.ts", changed: 400 },
        { path: "apps/web/src/extensions/lastdrop/Accounts.tsx", changed: 90 },
        { path: "packages/client-runtime/src/extensions.ts", changed: 8 },
        { path: ".github/workflows/lastdrop-sync.yml", changed: 120 },
        { path: "FORK.md", changed: 200 },
        { path: "pnpm-lock.yaml", changed: 5000 },
        { path: "apps/server/src/server.ts", changed: 3 },
      ],
      config,
    );
    assert.deepEqual(violations, []);
  });

  it("refuses T3 files that are not seams, including look-alike paths", () => {
    const violations = checkForkPaths(
      [
        { path: "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts", changed: 1 },
        { path: "packages/lastdrop.ts", changed: 1 },
        { path: "apps/server/src/extensions.ts", changed: 1 },
        { path: "apps/server/test/src/extensions/x.ts", changed: 1 },
        { path: ".github/workflows/ci.yml", changed: 1 },
        { path: "packages/client-runtime/src/extensions.tsx", changed: 1 },
      ],
      config,
    );
    assert.deepEqual(
      violations.map((violation) => violation._tag),
      Array(6).fill("OutsideAllowedPaths"),
    );
  });

  it("refuses a seam over its budget, or a binary change to one", () => {
    const violations = checkForkPaths([{ path: "apps/server/src/server.ts", changed: 4 }], config);
    assert.deepEqual(violations, [
      { _tag: "OverBudget", path: "apps/server/src/server.ts", changed: 4, budget: 3 },
    ]);
    assert.equal(
      checkForkPaths([{ path: "apps/server/src/server.ts", changed: null }], config).length,
      1,
    );
  });
});

describe("parseNumstat", () => {
  it("reads text and binary entries, including paths with spaces", () => {
    assert.deepEqual(parseNumstat("3\t1\tapps/server/src/server.ts\0-\t-\tassets/a b.png\0"), [
      { path: "apps/server/src/server.ts", changed: 4 },
      { path: "assets/a b.png", changed: null },
    ]);
  });
});
