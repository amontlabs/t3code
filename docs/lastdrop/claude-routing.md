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
- The candidates are the standalone lastdrop's Claude accounts that are signed in and usable (no sign-in needed),
  with their readings from `usage.json` (see "Usage"). An account whose passing errors outlasted every retry
  ("troubled", 10 minutes) stays a candidate: a warm thread there stays (and shows the error); it is only never
  a destination while another account has room.
- The account's sign-in folder goes in `CLAUDE_SECURESTORAGE_CONFIG_DIR` and its profile in `CLAUDE_CONFIG_DIR`
  (`runEnvironment`, which brings the profile up to date first). Main runs with neither.
- If the query's environment already names a sign-in or a profile (`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`,
  Bedrock, a custom `ANTHROPIC_BASE_URL`…), the wrapper leaves the query alone, as the Swift launcher did.
- Choosing writes nothing: the router returns the route's ledger writes as a `commit`, which the wrapper runs
  only for a route that came back within 3 s, before the query opens. A route that fails or comes back late is
  dropped (it never writes), and the thread opens on its **recorded** account (its sign-in and profile, ids
  translated). If even that can't be built (an unreadable ledger, a missing sign-in folder), the open is refused
  with a clear error: a thread never runs on Main's sign-in with an id another account has seen.
- Transcript lookups and tail reads are cached (by path, size and mtime), so routing is a few small reads.
- `LASTDROP_CLAUDE_ROUTING=0` in the server's environment turns the wrapper off.

## Moving

The rules are headroom's (docs/claude-accounts.md, "T3 Code threads"):

- A new thread (`sessionId`) starts on the best account.
- A resumed thread stays on its account while its prompt cache is warm: an answer or a user line in the last 55
  minutes of its transcript tail.
- It moves only when moving costs nothing: cold, or just compacted. Or when it can't stay: the account is full
  (a reading at 100%, or a "limit reached" answer in the last 10 minutes), signed out or removed. Toward known
  room only, unless it can't stay.
- A rewind (`resumeSessionAt`) moves only when it can't stay (full, gone): T3 keeps the rewound head pinned
  until a turn completes, so a rewind at a limit would otherwise never leave. The fork keeps message ids, so the
  rewind's message is found in it under the same id.
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

- With no other account to move to, a limit is only surfaced (a notice) and the query stays open, as plain T3
  does: background work keeps running.
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

## The ledger file

`sessions.json` is changed under a lock folder beside it (`sessions.json.lock`; a lock older than 10 s is taken
for a dead process's and broken) and replaced atomically, so two servers on one T3 home never lose a write. A
file that exists but can't be read is refused, never read as empty (every thread would then count as Main's):
resumed threads then don't open, with an error naming the file, until it is fixed or moved aside.

## Live-check settings

Unset, these change nothing. `LASTDROP_CLAUDE_FOLDERS` names the accounts' sign-in folders' parent (default
`<home>/.claude-accounts`) and `LASTDROP_PROFILES` where profiles are built (default `<folder>/profile`), so a
throwaway home can sign in through an account's real folder path (its keychain item is named after that path)
without touching the real profile. `LASTDROP_FAULT_ROUTE=throw` makes every route fail.

## Known limits

- Full and troubled marks are in the server's memory; a restart forgets them (the next reading still counts).
- A thread whose account changed by hand outside lastdrop isn't known to the ledger: it counts as Main's.

## Checked live (2026-11-14 and 15)

First run: Main only (moves forced by a ledger entry naming an account not signed in there).

Second run, two real accounts. Built server (`vp pack`), throwaway `HOME` and `T3CODE_HOME`, `~/.claude.json`
copied, the throwaway's `Library/Keychains` linked to the real one, the standalone app's `app.heartbeat` linked
(so the fork polled nothing), `LASTDROP_CLAUDE_FOLDERS` at the real `~/.claude-accounts` (sign-ins only read) and
`LASTDROP_PROFILES` in the throwaway. Haiku 4.5, `t3 thread start/send`, rewind and fork sent as
`checkpoint.rollback` and `thread.fork` over T3's WebSocket RPC.

- A new thread opened on `claude-2` (the real pick). With its transcript backdated 2 h and the throwaway's
  `usage.json` copy edited so Main read as roomier, the next message moved it to Main as a fork under a new id;
  the conversation carried over. Main's requests (`api-request` lines) carried only the new id. **But** the old
  id reached Main inside message content: Claude Code's environment reminder names a scratchpad folder after the
  session (`/private/tmp/claude-501/<project>/<old id>/scratchpad`), copied by the fork and sent in the next
  request body. Not fixed (it is Claude Code's own fork copy).
- Claude Code's fork kept every message uuid. A rollback to the turn before the move pinned an old uuid; the next
  open resumed the moved conversation at it, on Main, without moving ("No." to "did I ask which bird?").
- `thread.fork` from the run before the move: the SDK fork copied from the moved conversation (T3's id
  translated) and was recorded on its account.
- `LASTDROP_FAULT_ROUTE=throw`: a cold `claude-2` thread that a working route would have moved stayed on
  `claude-2` (the process's environment showed its sign-in folder and profile), same id, ledger unchanged.
- Found and fixed: a profile built before `~/.claude/projects` existed kept its account's conversations to itself;
  `projects` is now always linked, and a real one is folded into the shared folder.
- The real `claude-2` folder and both keychain items' modification dates were unchanged afterwards.

Not checked live: a real usage limit or passing error mid-run; request headers (no proxy).
