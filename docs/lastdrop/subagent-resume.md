# Subagents across a usage-limit move

When a thread's Claude account runs out, the agent gets the same follow-up as after quitting the app, and the
subagents the limit cut can still be resumed on the new account.

## Design

- **Copy on every fork.** Claude Code resumes a subagent (SendMessage to its id) only from
  `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`) of the session it runs
  as, and `--fork-session` doesn't copy that folder. Before a forked query starts, the wrapper calls
  `ThreadRouter.copySubagents(source, forked)` (lastdrop-node `copySubagentFolders`): `subagents/` of the
  source conversation, then of each older one it was forked from (the ledger's `from` chain, then T3's lineage),
  is copied into the fork's folder beside the source transcript. Newest first, never overwriting a file already
  there; a conversation without the folder is skipped. Done for every fork the wrapper makes: a move
  (`forkSession` + new `sessionId` in `open`) and T3's own `forkSession`. A failure is logged, never fails the
  query. The files hold no account id or email, so they are copied as they are.
- **Cut work, from the SDK stream** (`moveContinuation.ts`, `CutWorkTracker`). Every frame of a watched query is
  observed. A `task_started` is a subagent (or a background shell, for task type `local_bash`; a monitor when
  its launching tool is `Monitor`). It ends with `task_notification`, a `task_updated` to `completed`/`killed`,
  or its launching tool's result. A failure whose text is a limit (`limitKind`) doesn't end it: such a
  subagent is cut. At the limit, the tasks not ended are the cut work, subagents first, then shells, a shell
  of a cut subagent covered by it, as T3's recovery lists them (`ProviderRuntimeRecoveryService`). Each entry
  is labelled by T3's own `cancelledTurnItemWork` (a subagent, `<title> (id <agentId>)`) or
  `cancelledRosterTaskWork`.
- **Same follow-up as a restart.** The text is `continuationText(work)`: T3's `CONTINUE_PROMPT` alone when
  nothing was cut, else `restartCancelledBackgroundWorkNote(work)`, a blank line, and `CONTINUE_PROMPT`: what
  `RestartContinuation.ts` sends for a run cut mid-turn. The note and labels come from T3's functions, so
  upstream wording changes (such as a "resume it with SendMessage" hint) arrive with a sync. `CONTINUE_PROMPT`
  is T3's own, exported through a one-word seam in `RestartContinuation.ts` (FORK.md);
  `queryRunner.contract.test.ts` pins the note-then-prompt shape.
- **Sending it** (`moveContinuationLayer.ts`, in `Extensions.layer`). At a limit with another account to go to,
  the wrapper hands the thread and its cut work to `pendingContinuations` (dropped if a query opens on the
  thread first). On T3's `run.updated` to `failed` for that thread, the reactor releases the run's provider
  session (sent at once, the message would reach the closing query and fail, as seen live) and dispatches
  `message.dispatch` with the text, `start_immediately`, `createdBy: agent`, `creationSource: server`, on the
  run's model. Two differences from T3's restart dispatch, both forced by T3's orchestrator: no
  `notification` (T3 takes one only on queued messages or its own restart continuation) and not queued (a
  queued message waits while the thread is held at its limit).
- The limit notice now says the thread continues on the other account, not to send another message.
- The note keeps T3's first line ("the T3 server restarted"), since it is T3's text verbatim.

## Checked live (2026-11-15)

Fork server from the worktree, isolated `T3CODE_HOME` (`/private/tmp/sr-live`), `LASTDROP_PROFILES` in it,
the standalone app's usage readings, Claude Code 2.1.322, `claude-haiku-5-5`, plugins off. The Claude instance's
`launchArgs` carried `--settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18533"}}'` (in the
environment, `ANTHROPIC_BASE_URL` would turn routing off). A Node proxy there forwarded to api.anthropic.com
unchanged until the subagent (marked by a token in its prompt) had made 3 requests, then answered every request
with that request's `Authorization` with Anthropic's usage-limit 429 (`rate_limit_error`, `unified-status:
rejected`, `representative-claim: five_hour`, `5h-utilization: 1.0`, overage rejected); other sign-ins passed.

The thread asked for one foreground general-purpose subagent: remember code word PLOVER-26, write `notes.txt`,
`ls`, `date`, append "step 5", `cat`, answer the word. Seen (run 4; runs 1-3 found the two dispatch problems
above):

- Proxy: requests 2-5 on `claude-2` (auth `5aa30fe9`) passed, the subagent's 4th (request 6) and the parent's
  next (7) got the 429, then everything went out on `main` (auth `94210be3`) under session `c48b77f3`.
- `lastdrop.log`: `thread f9de1fea on claude-2: usage limit; ending the query so the thread continues on main
  (1 cut: Run multi-step code word task (id a73f27d08322a8fd5))`, `thread f9de1fea: move on main (claude-2
  full)`, `fork c48b77f3: subagents copied from 1 conversation(s) of f9de1fea`.
- `c48b77f3/subagents/` held `agent-a73f27d08322a8fd5.jsonl` and `.meta.json` before Claude Code started.
- The continuation, as the new session's transcript has it:
  `Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report
  back on its own, so resume or restart what you still need and wait for its result:` /
  `- subagent: Run multi-step code word task (id a73f27d08322a8fd5)` / blank line / T3's `CONTINUE_PROMPT`.
- Haiku did **not** use SendMessage: it read `notes.txt`, said "the earlier run either never wrote to it or
  stopped after step 2", and started a new subagent, which finished with `PLOVER-26`.
- Then, asked to SendMessage the old id `a73f27d08322a8fd5`: the send succeeded ("the agent is resuming from its
  transcript"); the old subagent, now on `main`, answered `PLOVER-26` from before the cut, finished its
  remaining steps (`notes.txt` ended `step 2 / step 5 / step 5`, step 5 twice because the new subagent had
  already done it) and ended with `PLOVER-26`. The thread replied "The subagent `a73f27d08322a8fd5` answered:
  **PLOVER-26**."

Not checked live: background shells or monitors cut at a limit (unit tests only); a thread forked by T3 itself
after a move (unit test only); whether the model resumes on its own once upstream's note names SendMessage.
