# Step 5: the lastdrop agents provider

The `lastdropAgents` driver (shown as "lastdrop") makes the user's agents T3 models. Each session runs on a native T3 instance along the agent's fallback chain. The code is in `apps/server/src/extensions/lastdrop/agents/`; the spike that came before it is `step5-spike.md`.

## What it does

- **Models** (`catalog.ts`, `catalogSource.ts`): the list comes from the standalone lastdrop's `agent-catalog.json` and `agent-models.json` in `~/Library/Application Support/lastdrop`. They are read only, in the same format, with no migration, and polled every 2 s.
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
- **Fallback at open**: the first usable entry. A thread already on an entry stays there while it has room.
- **Fallback partway through a run** (`fallback.ts`):
  1. An inner `usage_limit` terminal marks the entry out until the reset time it reported (an hour if it gave none).
  2. If a later entry has room, the router adds a `system_notice` row ("review reached a usage limit on Codex · gpt-6.1-sol. lastdrop continues on Claude · opus, with this conversation handed over.").
  3. The reactor releases the session and sends T3's own "Continue where you left off."
  4. The new session opens on the next entry and refuses to resume the old entry's native thread.
  5. T3's own resume-failed recovery then starts a new native thread there and delivers the portable handoff.
  - With no next entry, the failure stays T3's own `usage_limit`, and T3's limit recovery waits for the reset.
- **Permissions** (`permissions.ts`): Antigravity has no auto mode, and T3 answers `agy` prompts from the runtime policy. So an `auto` thread runs its Antigravity entries in `full-access`, unless a managed ceiling forbids it. Other instances keep the thread's mode.
- **Instance lookup** (`layer.ts`, `shared.ts`): `Extensions.layer` binds a late lookup through `ProviderAdapterRegistryV2`, so T3's sign-in gating applies. No new seam. The layer is imported lazily to break an import cycle.
- **Icons**: the provider carries the drop logo (`packages/client-runtime/src/extensions.ts`). Model rows show their backend's icon (`ModelListRow.tsx` seam).

## Evidence

- `fallback.test.ts`, through T3's real orchestrator with fake adapters: Codex does some work, then hits a usage limit. The test checks that a notice row appears, that run 2 completes on Claude in a new native thread at the run's effort, that the handoff is injected with the original request and the partial work, and that ids are lastdrop's on our side and native inside.
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

## Gaps

- **Goals** are off for agent threads: `Orchestrator.goalDriverFor` reads `adapter.driver`, and only a 1-line edit in `Orchestrator.ts` (14.8k lines, off-limits) would change that.
- **Delegate catalog**: `FULL_CATALOG_DRIVERS` (`OrchestratorMcpService.ts:290`, off-limits) caps our listing at 8 models. Agents can still search for the rest.
- **Idle compaction** is on, via a seam, but only while the thread is on a Claude entry.
- **Command judge (step 7)**: until it lands, Antigravity entries of `auto` threads run unreviewed in full access. Codex keeps `auto_review`. Z.ai and OpenRouter rely on Claude Code's auto mode.
- **Room** is only lastdrop's own marks (usage-limit terminals) plus each instance's availability. Usage-limit readings from T3 and lastdrop's Claude accounts are not consulted yet.
- **Entry memory**: which entry made which native thread is kept in memory. After a restart, a thread is matched by its provider thread's driver.
- **Enabling**: T3 turns on unconfigured default instances only from its own list, so "lastdrop" has to be enabled once in Settings. That writes `providerInstances.lastdropAgents` into the shared `~/.t3` settings, which the official app sees as an unknown driver.
- **Driver kind**: it is `lastdropAgents`, not `lastdrop`, because the shared `~/.t3` already holds an instance named `lastdrop` (the standalone app's ACP instance).
- The model list has no description field, so an agent's role shows only in its name and `subProvider`.
