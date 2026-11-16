You are finishing a `git rebase` of this fork's `lastdrop` branch onto upstream T3 Code `$TAG` (commit `$BASE`), from its previous base `$PREVIOUS`. It stopped on a conflict. You run headless in CI; nobody will answer questions.

Read `$FORK_MD` first (FORK.md as it was before the rebase): "Rules", "Fork folders", "Seams" and "Resolving a sync". The fork's code lives in its own folders; upstream files differ from upstream only at the seams, each with a budget and a section saying what its lines are and how to redo them.

For each stop, `git status` lists the conflicted files. In a rebase, `--ours` (HEAD) is upstream's new code plus the fork commits already replayed; `--theirs` is the fork commit being applied.

- A seam: start from HEAD's version and redo what this fork commit changes there, guided by the seam's section ("Lines", "Must survive", "Conflict"). If upstream moved or renamed what the seam relies on, apply the same intent where it now lives, and update the seam's section in `FORK.md` and its entry in `scripts/lastdrop/seams.json`, keeping the change as small as it allows.
- `pnpm-lock.yaml`: `git checkout --ours pnpm-lock.yaml`. The workflow regenerates it after the rebase.
- Any other file outside the fork folders: the fork should not differ from upstream there. Take HEAD's version.
- A file in a fork folder: upstream should never touch these paths, so this means upstream now uses the same path for something of its own. Do not drop either side and do not try to resolve it: stop.
- A commit left empty: `git rebase --skip`.

Then `git add` the files and run `GIT_EDITOR=true git rebase --continue`. Repeat until the rebase finishes. When it has, run `node scripts/lastdrop/check-fork-paths.ts --base $BASE` and fix what it reports in a commit `lastdrop: sync fixes for $TAG`.

Rules:

- Do not push, fetch, change remotes or touch tags. Do not install dependencies or run the test suite: the workflow runs typecheck, tests and the build after you.
- Never edit upstream code outside the seams, or upstream tests, to make the fork fit.
- If you cannot resolve a conflict with confidence, stop and leave the rebase in progress. A person takes over from a PR. A wrong resolution that passes the checks is worse than stopping.

Before you finish, write `$NOTES` in Markdown, short: whether the rebase finished; each conflict (file, commit) and what you did; anything a person should look at. If you stopped, say why first.
