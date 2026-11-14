# Claude accounts per T3 thread (step 4)

Every Claude Agent SDK query T3 opens goes through `ClaudeAgentSdkQueryRunner`. The fork swaps that layer for a
wrapper (`apps/server/src/extensions/lastdrop/queryRunnerLive.ts` → `queryRunner.ts`) at the
`ProviderOrchestrationAdapterInfrastructure.ts` seam. `ClaudeAdapterV2.ts` is not edited: the wrapper works only
on the runner's inputs (`open`, `forkSession`, `subagentLaunchToolUseId`) and on the SDK message stream it returns.

## Picking

On each `open(threadId, options)`:

- The thread's lineage comes from T3's projection (`ProjectionStoreV2.getThread`, `isDelegatedAppThread`). A
  delegated child picks with `pick`, the subagents' rule: the smallest plan with room under the thresholds, the
  parent's account counted as its own. A main thread picks with `pickForThread`: the most room in Pro-sized windows.
- The candidates are the standalone lastdrop's Claude accounts that are signed in, usable (no sign-in needed),
  not troubled, with their readings from `usage.json` (see "Usage").
- The account's sign-in folder goes in `CLAUDE_SECURESTORAGE_CONFIG_DIR` and its profile in `CLAUDE_CONFIG_DIR`
  (`runEnvironment`, which brings the profile up to date first). Main runs with neither.
- If the query's environment already names a sign-in or a profile (`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`,
  Bedrock, a custom `ANTHROPIC_BASE_URL`…), the wrapper leaves the query alone, as the Swift launcher did.
- Choosing never holds a thread up more than 3 s; on a timeout or an error the query opens where it was (ids
  translated only).
- `LASTDROP_CLAUDE_ROUTING=0` in the server's environment turns the wrapper off.

## Moving

The rules are headroom's (docs/claude-accounts.md, "T3 Code threads"):

- A new thread (`sessionId`) starts on the best account.
- A resumed thread stays on its account while its prompt cache is warm: an answer or a user line in the last 55
  minutes of its transcript tail.
- It moves only when moving costs nothing: cold, or just compacted. Or when it can't stay: the account is full
  (a reading at 100%, or a "limit reached" answer in the last 10 minutes), signed out or removed. Toward known
  room only, unless it can't stay.
- A rewind (`resumeSessionAt`) never moves.
- A move never carries a session id to another account: the query opens with `resume: <current>`,
  `forkSession: true` and a new `sessionId`. The ledger maps T3's id to the new one.
- A move because the account ran out is never silent: the thread shows a notice (a `system`/`informational`
  message the adapter turns into a `system_notice` item) just before its first answer on the new account
  (Claude Code's earlier frames, such as `init`, come before the adapter's turn takes notices).

## The id map

`<T3 home>/lastdrop/sessions.json`:

- `sessions`: each conversation's account, start, and for a fork `forkedAt` and `from` (its parent).
- `threads`: T3's native session id → the conversation it continues in now.
- `appThreads`: each T3 thread's last account, for its children.

Every id T3 passes back is translated:

| T3 passes                               | Translated to                                                         |
| --------------------------------------- | --------------------------------------------------------------------- |
| `resume` (its own id)                   | the current conversation (if its transcript exists, else T3's id)     |
| `resumeSessionAt` (rollback)            | that message's copy in the current conversation (`forkedFrom` chain)  |
| `forkSession(sessionId, upToMessageId)` | the current conversation and the message's copy; the fork is recorded |
| `subagentLaunchToolUseId(sessionId)`    | tried in each conversation of the lineage, current first              |

A move's own fork (Claude Code 2.1.322's `--fork-session`, checked live) keeps every message's uuid, so a rewind
id from before the move is found as it is. T3's own forks (the SDK's `forkSession`, a file copy) give each copied
message a new uuid and record `forkedFrom: {sessionId, messageUuid}`; the wrapper follows that chain across forks.
The adapter's own transcript check
(`claudeTranscriptState`) reads T3's id directly; that transcript stays in place, so it still finds a conversation.
Message `session_id`s in the stream are left as Claude Code sends them (task-output tailing needs the real one).

## At a limit, and passing errors

The wrapper watches the SDK stream; it never polls transcripts and never signals a process.

- A `result` that is a usage limit for the whole account (429, "limit reached", a rejected `rate_limit_event`;
  not a single model's limit): the account is marked full, a notice names where the next message goes, the
  result's first `errors` entry becomes that notice (T3 shows it as the turn's failure), and the query ends
  (T3's own `close`). The next message opens a new query, which moves.
- A `result` at a passing error (`TransientError`: 5xx, 529, Cloudflare page, network, auth while the sign-in
  works): held back from T3, and after 10 s, 30 s, 90 s and 3 min (jittered) the same query is offered a
  "continue" message; T3 sees one longer turn. A message or a stop from T3 during a wait lets the held result
  through first. Once retries are spent the result goes through, the account is marked troubled for 10 minutes
  and the query ends.

## Usage

While the standalone lastdrop app runs (its `app.heartbeat` in `~/Library/Application Support/lastdrop` is under a
minute old), routing reads its `usage.json` and the fork's monitor neither asks Anthropic nor renews sign-ins: the
two apps never double the requests. Otherwise the fork polls as in step 3 and routing reads `~/.t3/lastdrop/usage.json`.

## Known limits

- Full and troubled marks are in the server's memory; a restart forgets them (the next reading still counts).
- A thread whose account changed by hand outside lastdrop isn't known to the ledger: it counts as Main's.

## Checked live (2026-11-14)

Built server (`vp pack`), throwaway `HOME` and `T3CODE_HOME`, `~/.claude.json` copied, Main's sign-in read from
the login keychain (the throwaway's `Library/Keychains` linked to the real one), the standalone app's
`app.heartbeat` and `usage.json` linked read-only. `t3 thread start/send` with Haiku 4.5: a new thread opened on
Main through the wrapper; with the conversation marked in the ledger as another account's (not signed in there),
the next message moved it with `resume` + `forkSession` + a new id, the conversation carried over, the thread
showed the notice, and a second move forked the fork. Not checked live: a move between two real accounts, a real
usage limit or passing error mid-run, rewind after a move in the UI.
