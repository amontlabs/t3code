# Step 5 spike: a `lastdrop` driver that forwards to native T3 instances

Question (plan §3 "Agents and fallback chains", §6 risk 1): can a `lastdrop` provider whose models are the user's agents forward each session to a native T3 instance's `ProviderAdapterV2`, so that tool rows, steering, rollback and approvals stay T3's own?

**Verdict: it works, with caveats.** Forwarding at session open works through T3's full orchestrator. The caveats are wiring (no seam gives a driver another instance's adapter), a few behaviours T3 keys on the instance's driver kind, per-model icons, and fallback partway through a run. That last one needs a router session, which is a design change, not a blocker.

## What was built

All of it is in `apps/server/src/extensions/lastdrop/agents/`. No T3 file changed, and the guard passes (`check-fork-paths: 0 violations`).

- `catalog.ts`: the agents as models, shaped after `AgentCatalog.swift`: name, description, enabled, and a chain of steps (instance, provider label, model, optional fixed effort). It has hard-coded spike agents. `agentModels()` builds `ServerProviderModel`s with `subProvider` ("Antigravity · claude-sonnet-5-5, then Claude · claude-sonnet-4-6") and an `effort` select. A fixed-effort agent gets no effort option. `stepSelection()` turns `lastdrop/<agent>` plus the run's effort into the step's own selection (instance, model, effort).
- `delegatingAdapter.ts`: `makeDelegatingAdapter({ instanceId, agents, resolveTarget, hasRoom })`.
  - At `openSession` it finds the agent by model name and takes the first chain step with room. It looks up that instance's adapter and opens the inner session with the inner selection.
  - It returns the inner runtime with every call forwarded. Inputs are mapped outer → inner and outputs and events inner → outer. That covers `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest`, `rollbackThread`, `forkThread`, `readThreadSnapshot`, the optional calls, `mcpApps`, `subscribeEvents` and the background probes.
- `delegatingAdapter.test.ts`: the evidence, below.

### Identity rule (the main finding)

- **Instance id:** everything T3 persists names `lastdrop`. A generic deep restamp rewrites `providerInstanceId`, `instanceId` and `createdByProviderInstanceId`. It swaps `modelSelection` objects whole: the step's model maps back to the thread's outer selection (`lastdrop/build` plus effort).
- **`driver`:** this stays the inner adapter's (`claudeAgent`) on events, sessions and provider threads. T3 branches on it for driver-specific behaviour, for example `ProviderTurnStartService` checks `session.driver === "claudeAgent"`, and native subagent stop checks `subagent.driver`.
- **Inner calls:** going the other way, the inner adapter sees only `claudeAgent` and its real model.
- **Ids:** thread, turn, item and node ids are never rewritten. They are allocated by T3 (`IdAllocator`) or native to the inner provider, so they pass through unchanged.
- **Domain events:** `ProviderEventIngestor` stamps these with the run's instance (`lastdrop`), which already matches.

## Evidence

`pnpm exec vp test run src/extensions/lastdrop/agents/` → **36 passed**. Typecheck (`effect-tsgo`) and `vp lint` are clean on these files.

1. **Every recorded Claude replay fixture (34)** runs through `OrchestratorV2` with the thread on `lastdrop/build`. Our adapter forwards to T3's **real `ClaudeAdapterV2`**, which replays the SDK. The fixtures are:
   - basic turns: simple, multi_turn, multi_turn_restart, queued_turn, message_steering, web_search, command_output_streaming;
   - interrupts: turn_interrupt, turn_interrupt_mid_tool, turn_interrupt_restart;
   - rollback: **thread_rollback**;
   - approvals and permissions: **tool_call_read_only_on_request**, **tool_call_restricted_granular**, tool_call_denied_write, tool_call_workspace_never, tool_call_read_only;
   - subagents: **subagent**, **claude_nested_subagent_model**, claude_background_subagent_*, claude_nested_background_subagent_wake;
   - background tasks: claude_background_task_*, claude_background_monitor_wake, claude_local_bash_task;
   - compaction and resume: claude_compact_*, claude_idle_resume;
   - other: claude_result_is_error, claude_mcp_tool_presentation.

   For each fixture:
   - **T3's own output checks for that fixture run unchanged:** rows, item types, approvals, rollback result, subagent child threads, checkpoints. Their single pin on the thread's instance id is satisfied by checking a view of the result with `lastdrop` mapped back to `claudeAgent`.
   - **Our identity checks:** every instance id in every projection (thread, runs, sessions, provider threads, subagents, runtime requests…) is `lastdrop`. Every run's model is the agent name. Sessions have `driver: claudeAgent`. All domain events name `lastdrop`.
   - **A spy on the Claude adapter** confirms it was never given a `lastdrop` id or the agent name as its model.

2. **Fallback at open:** agent `fallback` = Antigravity (no room) → Claude. The test confirms room was asked of `[antigravity, claudeAgent]` in order, and that the session opened on Claude under `lastdrop/fallback`. The simple fixture's checks pass.
3. **Model list:** the models decode as `ServerProviderModel`. `subProvider` lists the chain. `build` offers an effort select and `judge` (fixed `high`) offers none.

## Obstacles and caveats

1. **No seam hands a driver another instance's adapter.** Drivers are built inside `ProviderInstanceRegistry`, so a driver env that needs the registry is a layer cycle. The fix needs no new seam: `Extensions.layer` sits above `ProviderInstanceRegistryHydration` in `server.ts`, so it can build `ProviderAdapterRegistry.layerFromProviderInstanceRegistry` and publish a late-bound lookup that the driver reads at `openSession`. Go through `ProviderAdapterRegistryV2.get`, not `instance.orchestrationAdapter` directly, so T3's `auth.withAccess` sign-in gating still applies.
2. **Native subagent child threads** on another model (for example Claude's haiku subagent) come out as `lastdrop/claude-haiku-4-5`, which is not in lastdrop's model list. Rows and behaviour are right (claude_nested_subagent_model passes), but the picker on such a child would show an unknown model. Decide whether children keep the inner instance id; only `app_thread.created` and `subagent.modelSelection` are involved.
3. **T3 behaviours keyed on the instance's `driverKind`** (which is `lastdrop`, not the adapter's or session's `driver`) are off for agent threads:
   - native goals (`Orchestrator.goalDriverFor`, which reads `adapter.driver`);
   - idle compaction (`IdleCompactionService`);
   - the full delegate catalog (`FULL_CATALOG_DRIVERS` in `OrchestratorMcpService`).

   Usage-limit refresh after a failed turn calls `instances.getInstance("lastdrop").snapshot.refreshUsage`, so our snapshot must forward that to the step's instance. None of these break a run.

4. **Capabilities and `planSelectionTransition`** are per adapter, not per session. The spike answers both from the first agent's first step. The real driver must:
   - give capabilities that are safe for every target (or the intersection);
   - return `create_with_handoff` when the new agent's step is on another instance;
   - otherwise delegate to the step's adapter.
5. **Per-model icons:** `ServerProviderModel` has no icon field, and `ProviderClientDefinition.icon` is per driver. Showing Codex, Antigravity or Claude icons per agent needs a small web extension that maps `subProvider` to T3's provider icons. That is a new seam (budget a few lines) or a fork-folder component. `subProvider` text works today with no change.
6. **Fallback partway through a run is not prototyped.**
   - The session is bound to one inner session, and the provider thread's native ids belong to that provider, so the adapter cannot switch step in place.
   - Today a usage-limit `turn.terminal` passes through as T3's own `usage_limit` failure, which T3's `UsageLimitRecoveryWorker` handles by waiting for the reset.
   - Moving to the next step needs a new provider thread with T3's portable handoff (see the design below).
7. **Not exercised by the spike:**
   - Codex and Antigravity as targets (they share the same `ProviderAdapterV2` contract; the Codex replay harness can run the same test);
   - thread fork into another thread (`ThreadFork.integration`);
   - switching a live thread from Claude to `lastdrop`;
   - restart recovery that reads persisted provider threads before any session is open (`readThreadSnapshot` after a restart goes through our adapter, but only once a session exists).

## Recommended design for step 5

Keep the delegating adapter. Porting `AgentRun` onto `effect-codex-app-server`/`provider-acp` is not needed. Turn the spike into a **router session**:

1. **Driver.** `LastdropDriver` (kind `lastdrop`) goes in `EXTENSION_DRIVERS`, plus a client definition in `extensionProviderClients` and `EXTENSION_PROVIDER_CLIENTS`.
   - The model list comes from the catalog (`agentModels`).
   - The snapshot forwards `refreshUsage` to the step instances.
   - `textGeneration` comes from the first agent's step.
   - The target lookup is late-bound from `Extensions.layer` (caveat 1).
2. **Router session.** One outer session opens inner sessions lazily, one per step instance, inside the outer session's scope.
   - Each provider thread records its step in its persisted record. Since `driver` stays inner, `providerThread.driver` plus a step index in `nativeMetadata` or in a fork-side map keyed by provider thread id is enough.
   - Calls on that thread go to its step's inner session.
   - Events from all inner sessions merge into the outer stream, restamped as in the spike.
3. **Fallback.**
   - _At open, or before any work:_ take the next step with room, as in the spike.
   - _Partway:_ on a `usage_limit` terminal from step _n_, the router marks step _n_ out of room and lets the failure through. A small fork reactor in `Extensions.layer`, keyed on lastdrop threads with `lastErrorClass === "usage_limit"`, then re-sends the run's message. The router's `ensureThread` sees that the thread's step has no room, returns a **new provider thread** on step _n+1_ (`forceNewNativeThread`), and calls the step's `injectHistory` with T3's handoff context (`ContextHandoffService`, `docs/user/portable-handoffs.md`).
   - **Spike this one part first in step 5:** confirm that the orchestrator accepts a new provider thread from `ensureThread` on the same session, and that the handoff is delivered.
4. **Identity.** Keep the spike's rule: instance ids are `lastdrop` and `driver` stays inner. Decide caveat 2, then add lastdrop to the goal and idle-compaction checks through the driver's own capabilities where T3 allows, or accept them as off.
5. **Tests.** Promote `delegatingAdapter.test.ts`: run every Claude and Codex replay fixture through the router, and add a replayed usage-limit partway through a run for the fallback.
