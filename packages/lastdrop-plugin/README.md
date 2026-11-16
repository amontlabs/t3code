# lastdrop's Claude Code plugin

`lastdrop/` is the Claude Code plugin `lastdrop` (the Agent types that route subagents across accounts and
providers), copied from the lastdrop app's repository (`ClaudePlugin/lastdrop`, same owner, MIT). `SOURCE` is the
commit it was copied from. Do not edit it here: change it there, then run `scripts/lastdrop/sync-plugin.sh`.

The copy differs from the source in three ways, all made by the sync script: its tests are left out, its
sources start with a lint-off comment, and the repo's formatter has run over it.

The server embeds the folder (`packages/lastdrop-node/src/pluginFiles.generated.ts`, rebuilt by the same
script), writes it to `<T3 home>/lastdrop/plugin/lastdrop` and loads it into every Claude query through the
Agent SDK's `plugins` option (`apps/server/src/extensions/lastdrop/runner/queryEnvironment.ts`).
