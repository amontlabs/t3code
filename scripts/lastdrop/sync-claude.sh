#!/usr/bin/env bash
# Runs Claude Code headless on a sync prompt (sync-resolve.md, sync-fix.md) in the current checkout.
# Usage: sync-claude.sh <prompt file>. Needs CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CODE_VERSION; the
# prompt's $TAG, $PREVIOUS, $PRE_REBASE, $BASE, $FORK_MD, $NOTES and $CHECKS_LOG come from the environment.
set -euo pipefail
prefix="$RUNNER_TEMP/claude-code"
if [[ ! -x "$prefix/node_modules/.bin/claude" ]]; then
  # Outside the checkout, so the workspace's package manager settings stay out of it.
  (cd "$RUNNER_TEMP" && npm install --no-save --silent --prefix "$prefix" "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION")
fi
prompt="$(envsubst '$TAG $PREVIOUS $PRE_REBASE $BASE $FORK_MD $NOTES $CHECKS_LOG' < "$1")"
"$prefix/node_modules/.bin/claude" -p "$prompt" --model opus --dangerously-skip-permissions
