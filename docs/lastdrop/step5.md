# Step 5: the lastdrop agents provider

The `lastdropAgents` driver (shown as "lastdrop agents") makes the user's agents T3 models. Each session runs on a native T3 instance along the agent's fallback chain. The code is in `apps/server/src/extensions/lastdrop/agents/`; the spike that came before it is `step5-spike.md`.

## What it does

- **Models** (`catalog.ts`, `catalogSource.ts`): the list comes from the fork's `~/.t3/lastdrop/agents.json` and `agent-models.json`, in the standalone app's catalog format (so the parser is the same), polled every 2 s. Settings edits it (`editor.ts`, `catalogEdit.ts`); a one-time import copies the app's files. A missing file is an empty list.
  - Claude's own models come first (fable, opus, sonnet, haiku), then each enabled agent.
  - Names follow the standalone ACP provider: "build · Antigravity Claude Sonnet 5.5".
  - `subProvider` is the first entry's backend.
  - Effort follows `ACPServer.efforts(for:)`: the levels every entry of the chain takes, from the model cache, else the provider's caller levels. A fixed-effort agent offers none.
  - The chain instances' own models are also published as legacy entries, so a native subagent on another model (Claude's Haiku child) gets a display name.
- **Targets** (`DEFAULT_INSTANCES`): Claude → `claudeAgent`, Codex → `codex`, Antigravity → `antigravity`. Z.ai → `zai` and OpenRouter → `openrouter` are Claude-driver instances that set their endpoint in the instance environment; T3 supports per-instance env. Step 6 creates those instances; until it does, those entries are skipped.
  - An entry is skipped like one with no room when its instance is missing, disabled, not installed or unavailable, or when it fails to open.
  - Claude still goes through the plain Claude instance. Step 4's query-runner wrapper picks the account once it is merged.
- **Router** (`router.ts`): the spike's delegating adapter, reworked.
  - One inner session per outer session.
  - Persisted ids name the lastdrop instance, and `driver` stays the inner driver's.
  - Each entry gets its own model and the closest effort it offers, under the inner model's own option id.
  - The router records which entry made each native thread.
- **Fallback at open**: a thread stays on the entry that made its native thread while that entry has room; otherwise the chain is tried in order. Each entry is checked and opened once. The first turn of a session that is not on the agent's usual entry gets a notice naming the entry that actually opened, and why each other entry did not (usage limit and its end, not set up, failed to open).
- **Fallback partway through a run** (`fallback.ts`):
  1. An inner `usage_limit` terminal marks the entry out until the reset time it reported (an hour if it gave none).
  2. If a later entry has room, the router adds a `system_notice` row ("review reached a usage limit on Codex · gpt-6.1-sol. lastdrop continues on the next entry with room; the next run names it.").
  3. The router ends the run as `cancelled`, not `failed`, after the reactor has written T3's own restart-continuation marker for it (`effect:restart-continuation:<run>` in the effect outbox, the marker a server restart writes, due in 60 s). T3 treats a cancelled run with that marker pending as still going: `t3_thread_wait` (so `t3 thread start --wait`), a delegate_task parent waiting on its child, and the task's completion and wake all wait.
  4. Once T3 settles the run, the reactor releases the session and sends T3's own "Continue where you left off." with `restartContinuationOfRunId` naming the run, then cancels the marker and calls T3's `recoverDelegatedTask` for the run, as T3 does after its own continuation. Every waiter follows that chain, so it sees one run that ends with the continuation's outcome. No error row is written for the limit; the notice says what happened.
  5. The new session opens on the next entry and refuses to resume the old entry's native thread.
  6. T3's own resume-failed recovery then starts a new native thread there and delivers the portable handoff.
  7. The router drops `restartContinuationOfRunId` from the turn it passes to an entry other than the one that ran the run (a session that opened on a new entry, or a provider thread handed over from another entry). With the field, an adapter such as Codex resumes its native turn and starts it with no input, losing the continue text, the inline handoff context and the interrupted-command note.
  - With no next entry, the failure stays T3's own `usage_limit`, and T3's limit recovery waits for the reset.
  - **When no continuation follows**, the run stays `cancelled` and `recoverDelegatedTask` settles a delegate_task parent's task with it (T3's task finalization skipped the run while the marker was pending, and nothing else makes it look again):
    - A Stop that reaches the run before the continuation makes T3 decline it; the run stays stopped.
    - The run ended otherwise (`interrupted`): nothing is re-sent.
    - The re-send fails: the thread was archived or deleted, the lastdrop instance was turned off, or an internal error. These are the cases where T3's own restart continuation also gives up; the reactor logs `lastdrop.fallback.failed`.
  - **A release that fails** does not stop the re-send. The thread's session then stays on the limited entry, and the router hands over at most once per session: the continuation's limit ends as T3's own `failed` `usage_limit`, with T3's error row, and T3's limit recovery arms on it.
  - **One continuation only**: the re-send uses T3's own ids for a run's restart continuation (`command:restart-continuation:<run>`, `message:restart-continuation:<run>`). If the handover outlives the marker's 60 s and T3's worker runs it too, whichever dispatches second is the same command (T3 replays its receipt), and T3's worker skips a run whose continuation message exists. A marker T3's worker has claimed is left to it rather than cancelled, so T3's dispatch is never cut short; the worker settles it.
  - **A server restart mid-handover** (between the two runs): T3 runs the marker itself after 60 s (its `continueRestartedRun`), gated by "continue threads after a server update". With the setting on, the continuation sends T3's restart prompt instead of lastdrop's text, and the new session opens on the next entry, since the room mark is on disk. With it off, run 1 stays `cancelled` with no continuation, and waiters get that.
  - **T3's restart-loop cap**: T3 refuses to continue a run after a restart when it is the third restart continuation in a row within 5 minutes (`RestartContinuation.ts`, `MAX_CONTINUATION_CHAIN`). lastdrop's hops are restart continuations, so they count: a 4-entry chain that fell back three times within 5 minutes, then a server restart, leaves the last run unfinished. Not fixed: the cap lives in T3's code past the existing seam's budget, and the case needs three limits within minutes.
  - **The outbox instance**: T3 keeps its outbox service inside the orchestration runtime, out of `Extensions.layer`'s reach, so the reactor builds `EffectOutbox.layer` itself. In production that is the same instance as T3's (the server's shared memo map), but the reactor does not rely on it: it only writes, reads and cancels rows of the shared table, never the in-memory wake-ups or interrupts. T3's worker polls for due rows, and T3's waiters are woken by the continuation's own `run.updated`.
- **Permissions** (`permissions.ts`): T3's own rule (`RuntimePolicy.ts` `providerRuntimeMode`) is applied per entry, against the target instance snapshot's `supportedRuntimeModes`: a mode the target lacks becomes `approval-required`. The lastdrop snapshot publishes every mode, so T3 hands the thread's own mode to the router. Since step 7, `auto` maps to `auto-accept-edits` on Antigravity, and lastdrop answers the entries' approval requests under `auto` (`docs/lastdrop/step7.md`).
- **Instance lookup** (`layer.ts`, `shared.ts`): `Extensions.layer` binds a late lookup through `ProviderAdapterRegistryV2`, so T3's sign-in gating applies. No new seam. The layer is imported lazily to break an import cycle.
- **Icons**: the provider carries the drop logo (`packages/client-runtime/src/extensions.ts`). Model rows show their backend's icon (`ModelListRow.tsx` seam).

## Evidence

- `fallback.test.ts`, through T3's real orchestrator with fake adapters: Codex does some work, then hits a usage limit. The test checks that run 1 ends `cancelled` with no error row and its marker cancelled, that run 2 continues it (`restartContinuationOfRunId`), that a notice row appears, that run 2 completes on Claude in a new native thread at the run's effort, that the handoff is injected with the original request and the partial work, and that ids are lastdrop's on our side and native inside.
- `fallbackStatus.test.ts`: T3's `waitForThread` (what `t3_thread_wait` and `--wait` run) on run 1 returns run 2, `completed`, with Claude's answer; a delegate_task parent's task row never shows `failed`, `cancelled` or `interrupted`, and settles `completed` with the continuation's result. Both fail without the marker. Also: on a Claude → Codex chain, Codex's turn has no `restartContinuationOfRunId` and carries the continue text, with the handoff delivered; when the handover fails before the re-send, the reactor calls `recoverDelegatedTask` for the child's run and the parent's task settles; when the release fails, the continuation's own limit ends `failed` with T3's error row and the thread shows `failed`/`usage_limit` for T3's limit recovery; dispatching T3's own continuation command afterwards adds no run and no message.
- `router.test.ts`: all 34 recorded Claude fixtures and 25 Codex fixtures run through the router. Each fixture's own checks pass, plus identity checks. Fallback at open is covered too.
- `targets.test.ts` (fake adapters):
  - Antigravity as a target.
  - Missing instances and entries that fail to open are skipped.
  - Z.ai and OpenRouter run as Claude instances.
  - With no usable entry, the error names the chain.
  - The permission mapping.
  - The driver's snapshot.
- `catalog.test.ts`: the real catalog's format, names, efforts, entry selections, and live reload.
- **Live, 2026-11-14**: the fork's server ran with an isolated `T3CODE_HOME`. `t3 thread start --provider lastdropAgents --model review "Reply with exactly: lastdrop live ok"` went as follows:
  1. Codex (gpt-6.1-sol) answered with a real usage limit.
  2. The notice row appeared.
  3. Antigravity was skipped (not set up in that home).
  4. Claude · opus answered `lastdrop live ok` from the handoff.
  - The catalog was read without being changed. Codex and Claude used their real sign-ins and wrote only their own session logs.

- **Live, one run at a fallback (2026-11-15)**: the fork server from the worktree, isolated `T3CODE_HOME`, `LASTDROP_CLAUDE_ROUTING=0`, agent `computer-use` (Codex · gpt-6.1-terra, at its real limit until 2026-11-18, then Claude · haiku):
  1. `t3 thread start --provider lastdropAgents --model computer-use --wait --json` printed `status: completed`, `reply: "fallback status ok"`, run 2's id, exit 0. Run 1 `cancelled`, run 2 `completed` with `restartContinuationOfRunId` run 1, both notices, no error row, the marker `cancelled`.
  2. A Haiku parent thread called `delegate_task` on `lastdropAgents`/`computer-use` and waited: it answered `CHILD completed child ok` in its single run; the child's run 1 was `cancelled` at the Codex limit and run 2 `completed` on Haiku.
- **Live, review fixes**: an `auto` thread on `build` (Antigravity first) in a fresh isolated home got the notice "build runs on Claude · sonnet: Antigravity · claude-sonnet-5-5 is not set up." and ran on Claude. T3's Antigravity driver needs its own ACP runtime, installed from T3's provider settings (`agy` alone is not enough), and none was installed. So the approval prompt under `auto` on Antigravity is checked by the tests only, not live.

## Gaps

- **Goals** are off for agent threads: `Orchestrator.goalDriverFor` reads `adapter.driver`, and only a 1-line edit in `Orchestrator.ts` (14.8k lines, off-limits) would change that.
- **Delegate catalog**: `FULL_CATALOG_DRIVERS` (`OrchestratorMcpService.ts:290`, off-limits) caps our listing at 8 models. Agents can still search for the rest.
- **Idle compaction** is on, via a seam, but only while the thread is on a Claude entry.
- **Command judge**: done in step 7 (`docs/lastdrop/step7.md`).
- **Room** is only lastdrop's own marks (usage-limit terminals) plus each instance's availability. Usage-limit readings from T3 and lastdrop's Claude accounts are not consulted yet.
- **Entry memory**: which entry made each native thread, and the room marks, are kept in `~/.t3/lastdrop/agent-threads.json` and `agent-room.json`, and survive a restart. They are not in the provider thread's `nativeMetadata` because that is a closed T3 schema. A native thread with no record is inferred only when exactly one entry runs on its session's driver. Otherwise it is never resumed: T3 starts a new native thread with the handoff, so one instance never resumes another's conversation.
- **Enabling**: "lastdrop agents" is on by default (`defaultOn.ts`). T3 runs an instance with no `providerInstances` entry only if it is one of its own default-on instances (`codex`, `claudeAgent`), while the Settings switch shows the driver's default (on); a fresh home used to show the switch on and refuse the threads until it was switched off and on. At each start, and after any settings change that leaves no entry (Settings → "Reset to defaults" removes it), settings with no `lastdropAgents` entry get `{ driver: "lastdropAgents", enabled: true }` through T3's settings service `create`, the same entry the switch writes. `create` fails if an entry exists, so a user who switched it off stays off. No seam: a one-word seam in `packages/contracts/src/settings.ts` (`DEFAULT_ENABLED_DEFAULT_INSTANCES`) would also work, but that file is large and changes often upstream. The entry is in the shared `~/.t3` settings, where the official app shows it as an unknown driver, read-only. Z.ai and OpenRouter (step 6) never had the mismatch: lastdrop creates them with an explicit `enabled`.
- **Driver kind and the second "lastdrop"**: the kind is `lastdropAgents`, not `lastdrop`, because the shared `~/.t3` already holds an instance named `lastdrop` (the standalone app's ACP instance). Ours is labelled "lastdrop agents". The picker still lists the standalone ACP instance, labelled "lastdrop", and no seam-free way exists to hide it: it is the user's own instance in shared settings, which the official app still uses. To hide it in the fork, turn it off in the fork's Settings (this also turns it off in the official app), or remove it once the standalone ACP provider is retired.
- **Capabilities**: T3 asks an instance for capabilities with no thread, so lastdrop answers what every set-up target offers (booleans all true, the least of each number, common values), or T3's ACP defaults when none is set up. It never fails.
- **A limit mid-command**: the re-sent message adds that the last command may have been interrupted and to check the state before redoing it.
- The model list has no description field, so an agent's role shows only in its name and `subProvider`.
