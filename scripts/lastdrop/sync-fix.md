This checkout is this fork's `lastdrop` branch rebased onto upstream T3 Code `$TAG` (commit `$BASE`). The rebase went through, but the checks failed: the fork guard, typecheck, tests and desktop build, in that order, all in `$CHECKS_LOG`. You get one attempt to fix them. You run headless in CI; nobody will answer questions.

Read `FORK.md` first: "Rules", "Fork folders", "Seams". The fork's code lives in its own folders; upstream files differ from upstream only at the seams, within their budgets (`scripts/lastdrop/seams.json`).

1. Find each failure in the log and its cause. Usually upstream changed something fork code uses (a renamed export, a changed signature or schema), and the fix belongs in the fork's folders or at a seam.
2. Fix it inside the fork's folders or within a seam's budget. If a seam has to change, update its section in `FORK.md` and its entry in `seams.json`.
3. Check your fix with the narrowest commands: `vp test run <files>`, the package's typecheck (`vp run --filter <package> typecheck`), `node scripts/lastdrop/check-fork-paths.ts --base $BASE`. Dependencies are installed. Do not rerun the whole suite; the workflow does that after you.
4. Commit everything as `lastdrop: fixes for $TAG`.

Rules:

- Do not push, fetch, change remotes or touch tags.
- Never edit upstream code outside the seams, or upstream tests, to make checks pass. If the only fix needs that, or a failing upstream test also fails on upstream `$TAG` itself, change nothing for it and explain.
- A failure that looks flaky (a timeout, a network error): say so and change nothing for it.

Before you finish, append to `$NOTES` in Markdown, short: each failure, its cause, what you changed, and anything a person should look at.
