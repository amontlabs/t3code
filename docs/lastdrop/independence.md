# Independence from the standalone lastdrop app

Status: in progress, started 2026-11-16 (owner's decisions below).

The fork must run with the standalone lastdrop app absent. After this work it never reads, writes or runs anything of the app's: not `~/Library/Application Support/lastdrop/`, not `~/.claude-accounts/`, not the app's keychain items (`lastdrop`/`Headroom` services), not `/Applications/lastdrop.app` (its runner or its Claude Code plugin). The app stays maintained for people who use Claude Code or plain T3; both can be installed side by side without either knowing of the other.

## Rules

- **No new seams.** Everything goes in fork paths (`seams.json` `allowed`). UI goes through the existing `ExtensionInstanceSection` (per-driver section in `ProviderInstanceCard.tsx`); server routes through the existing `server.ts` seam (`/api/lastdrop/*`). Raising an existing seam's budget needs the owner's sign-off.
- **Fork state** lives in `~/.t3/lastdrop/` (`LastdropPaths.dataDir`); secrets in the keychain under the fork's own service name `t3code-lastdrop`.
- **Main** is Claude Code's own login (`~/.claude`, `~/.claude.json`), shared by nature with the CLI, plain T3 and the app. Nothing else is shared.
- **Import, once.** A section with nothing yet offers "Import from the lastdrop app" while the app's data exists. It copies; it never reads the app again afterwards and never writes to it.
- Tests run against a temporary home (`testHome.ts`); never the real `~`, keychain or `~/.t3/userdata`.

## Owner's decisions

1. Extra Claude accounts are signed in again inside the fork (own folders, own keychain items). Sharing the app's would make the two apps invalidate each other's rotating refresh tokens.
2. Codex accounts are routed automatically too, like Claude.
3. Agents are stored in `~/.t3/lastdrop/agents.json`, not T3's `settings.json`.
4. The `lastdrop:*` Claude Code plugin ships inside the fork.

## Work

1. **Claude accounts** (Settings → Providers → Claude, `AccountsSection`): list, add, sign in, rename, reorder, remove. List in `~/.t3/lastdrop/accounts.json` (the app's format), sign-in folders `~/.t3/lastdrop/accounts/<key>`. Remove `standalone.ts` (heartbeat and the app's `usage.json`): the fork always reads usage and renews sign-ins itself.
2. **Agents** (Settings → Providers → lastdrop agents): an editor for name, description, provider, model, effort, fallbacks, on/off. Stored in `~/.t3/lastdrop/agents.json` (+ efforts), same shape as the app's `agent-catalog.json`/`agent-models.json` so the parser and router stay.
3. **Endpoint keys** (Z.ai and OpenRouter cards): a key field stored under `t3code-lastdrop`; env fallbacks stay. **Done**, 2026-11-16 (not run live): keys are read and written under `t3code-lastdrop` only (`endpointKeys.ts`, symmetric with the reader and the key helper, tested through a fake `security`); `GET/PUT/DELETE /api/lastdrop/endpoints/keys[/<provider>]` and `POST …/import` (`apps/server/src/extensions/lastdrop/endpointKeys.ts`; writes need `orchestration:operate` and refuse a DPoP session); the key field is on each Z.ai/OpenRouter card, and both are on the main Claude card below Accounts (`ClaudeInstanceSections.tsx`, which renders `AccountsSection` unchanged). "Import from the lastdrop app" (`importFromApp.ts`) copies the two API keys once, per provider the fork has none for; the app's Z.ai web session is not copied (the fork can't renew it, so Z.ai usage reads with the key). The usage messages now point to Settings → Providers → Claude.
4. **Plugin**: a fork-owned copy of `ClaudePlugin/lastdrop` loaded into every Claude query through the Agent SDK's `plugins` option; the app's installed `lastdrop@lastdrop` turned off for those queries so agents don't show twice; packaged with the desktop app. **Done**, 2026-11-16 (not run live): `packages/lastdrop-plugin/lastdrop` is the vendored plugin (`scripts/lastdrop/sync-plugin.sh` copies it from `../headroom`), embedded in the server (`pluginFiles.generated.ts`) and written to `<T3 home>/lastdrop/plugin/lastdrop` when the runner routes bind, so dev, the server bundle and the packaged desktop app resolve the same path and `build-desktop-artifact.ts` is untouched. `withLastdropPlugin` adds `plugins: [{ type: "local", path }]` and `enabledPlugins["lastdrop@lastdrop"] = false` to every query's options. Still open: the plugin falls back to the app's runner when the fork's fails (step8.md), which needs the app.
5. **Codex accounts**: several ChatGPT logins, routed like Claude's. Design pending research.
6. **Cleanup**: no code path names `swiftSupport`, `.claude-accounts`, the app's keychain services or `/Applications/lastdrop.app`, except the import readers. FORK.md's "shared with the standalone" section rewritten.
