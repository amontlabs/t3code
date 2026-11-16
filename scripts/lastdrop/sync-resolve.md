You are finishing a `git merge` of upstream T3 Code `$TAG` (commit `$BASE`) into this fork's `lastdrop` branch, which was based on `$PREVIOUS`. It stopped on conflicts. You run headless in CI; nobody will answer questions.

`$BRIEF` lists the conflicted files and, for each seam among them, its section of FORK.md. Start there; open `$FORK_MD` (FORK.md from before the merge) only if you need more. The fork's code lives in its own folders; upstream files differ from upstream only at the seams, a few lines each. In this merge, `--ours` is the fork and `--theirs` is upstream.

For each conflicted file:

- A seam: take upstream's file (`git checkout --theirs <file>`) and re-apply the fork's change, which is exactly `git diff $PREVIOUS $PRE_MERGE -- <file>`, guided by the seam's section ("Must survive", "Conflict"). If upstream moved or renamed what the seam relies on, apply the same intent where it now lives, and update the seam's section in `FORK.md` and its budget in `scripts/lastdrop/seams.json`, keeping the change as small as it allows.
- A file in a fork folder: upstream should never have these paths, so upstream now uses the same path for something of its own. Do not drop either side and do not try to resolve it: stop.
- Any other file: the fork should not differ from upstream there. Take upstream's (`git checkout --theirs <file>`).

Then `git add` the files and `git commit --no-edit`. Run `node scripts/lastdrop/check-fork-paths.ts --base $BASE` and fix what it reports in a commit `lastdrop: sync fixes for $TAG`.

Rules:

- Do not push, fetch, change remotes or touch tags. Do not install dependencies, typecheck or run tests: the workflow does that after you, and gives a fix step the results.
- Read only what you need: the brief, the conflicted files, the fork's diff for them. Do not survey the repository.
- Never edit upstream code outside the seams, or upstream tests, to make the fork fit.
- If you cannot resolve a conflict with confidence, stop and leave the merge in progress. A person takes over from a PR. A wrong resolution that passes the checks is worse than stopping.

Before you finish, write `$NOTES` in Markdown, short: whether the merge is committed; each conflict and what you did; anything a person should look at. If you stopped, say why first.
