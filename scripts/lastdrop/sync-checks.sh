#!/usr/bin/env bash
# The checks a sync must pass before `lastdrop` moves (lastdrop-sync.yml). Usage: sync-checks.sh <upstream base> <log file>
# Typecheck and tests run one package at a time: `vp run` stops starting tasks once one fails, which
# hid failures from the fix step, and GitHub's standard runner (16 GB) runs out of memory with
# several big typechecks at once (the root `typecheck` script runs four).
set -uo pipefail
base="$1"
log="$2"
failed=()

# A runner crash, not a result: a process killed for memory, or the test browser going away.
RUNNER_CRASH='exit code: 137|Killed|VITEST_BROWSER_CONNECTION_CLOSED|Browser connection was closed'

run() {
  local name="$1"
  shift
  local attempt out="$RUNNER_TEMP/check-output.log"
  echo "::group::$name"
  for attempt in 1 2; do
    echo "===== $name" >> "$log"
    if "$@" > "$out" 2>&1; then
      tee -a "$log" < "$out"
      echo "::endgroup::"
      return
    fi
    # vp run prints which tasks failed, and their output, only here.
    if [[ "$1" == vp ]]; then vp run --last-details >> "$out" 2>&1 || true; fi
    tee -a "$log" < "$out"
    if ((attempt == 1)) && grep -aqE "$RUNNER_CRASH" "$out"; then
      echo "::warning::$name: the runner crashed (memory or test browser); running it once more."
      continue
    fi
    failed+=("$name")
    break
  done
  echo "::endgroup::"
}

# The workspace's packages (pnpm-workspace.yaml) that have the script.
packages_with() {
  git ls-files -- 'apps/*/package.json' 'packages/*/package.json' 'infra/*/package.json' \
    evals/package.json scripts/package.json oxlint-plugin-t3code/package.json |
    xargs jq -r --arg script "$1" 'select(.scripts[$script]) | .name'
}

run guard node scripts/lastdrop/check-fork-paths.ts --base "$base"
for package in $(packages_with typecheck); do
  run "typecheck $package" vp run --filter "$package" typecheck
done
for package in $(packages_with test); do
  run "test $package" vp run --filter "$package" test
done
run build vp run build:desktop

if ((${#failed[@]})); then
  echo "Failed: ${failed[*]}" | tee -a "$log"
  # What the fix step reads first: failing checks, then each error or failing test with some context.
  {
    echo "# Failed checks"
    echo
    printf -- '- %s\n' "${failed[@]}"
    echo
    echo '```'
    sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -a -E '✗ \(exit code|violation' | sort -u
    sed 's/\x1b\[[0-9;]*m//g' "$log" |
      grep -a -A 20 -E '^ *FAIL |(error|warning) TS[0-9]+|^ *Error:|AssertionError|check-fork-paths:' | head -c 40000
    echo '```'
  } > "${log%.log}.digest.md"
  exit 1
fi
