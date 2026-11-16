#!/usr/bin/env bash
# Runs Claude Code headless on a sync prompt (sync-resolve.md, sync-fix.md) in the current checkout.
# Usage: sync-claude.sh <prompt file> <model> <budget in USD>
# Uses CLAUDE_CODE_OAUTH_TOKEN, then CLAUDE_CODE_OAUTH_TOKEN_2 when the first account is at its limit.
# The prompt's variables ($TAG, $BASE, ...) come from the environment.
set -uo pipefail
prompt_file="$1"
model="$2"
budget="$3"
prefix="$RUNNER_TEMP/claude-code"
if [[ ! -x "$prefix/node_modules/.bin/claude" ]]; then
  # Outside the checkout, so the workspace's package manager settings stay out of it.
  (cd "$RUNNER_TEMP" && npm install --no-save --silent --prefix "$prefix" "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION") || exit 1
fi
prompt="$(envsubst '$TAG $PREVIOUS $PRE_MERGE $BASE $FORK_MD $NOTES $CHECKS_LOG $CHECKS_DIGEST' < "$prompt_file")"
out="$RUNNER_TEMP/claude-$(basename "$prompt_file" .md).json"

account=0
for token in "${CLAUDE_CODE_OAUTH_TOKEN:-}" "${CLAUDE_CODE_OAUTH_TOKEN_2:-}"; do
  account=$((account + 1))
  [[ -n "$token" ]] || continue
  CLAUDE_CODE_OAUTH_TOKEN="$token" CLAUDE_CODE_OAUTH_TOKEN_2="" \
    "$prefix/node_modules/.bin/claude" -p "$prompt" --model "$model" --max-budget-usd "$budget" \
    --dangerously-skip-permissions --output-format json > "$out" 2>&1
  status=$?
  jq -r '.result // empty' "$out" 2>/dev/null || cat "$out"
  jq -r --arg step "$(basename "$prompt_file" .md)" --arg account "$account" \
    '"- Claude (\($step), account \($account)): \(.num_turns) turns, \(.usage.input_tokens + .usage.cache_read_input_tokens + .usage.cache_creation_input_tokens) input and \(.usage.output_tokens) output tokens, $\(.total_cost_usd) at API prices"' \
    "$out" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
  if grep -qiE "hit your .*limit|usage limit|limit reached|rate.?limit" "$out" &&
    { ((status != 0)) || jq -e '.is_error == true' "$out" > /dev/null 2>&1; }; then
    echo "Account $account is at its limit; trying the next one."
    continue
  fi
  exit "$status"
done
echo "No Claude account had room left."
exit 1
