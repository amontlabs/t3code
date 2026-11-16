#!/usr/bin/env bash
# The checks a sync must pass before `lastdrop` moves (lastdrop-sync.yml). Runs them all, so one log
# shows every failure. Usage: sync-checks.sh <upstream base> <log file>
set -uo pipefail
base="$1"
log="$2"
failed=()

run() {
  local name="$1"
  shift
  echo "::group::$name"
  echo "===== $name" >> "$log"
  if ! "$@" 2>&1 | tee -a "$log"; then
    failed+=("$name")
    # vp run prints which tasks failed, and their output, only here.
    if [[ "$1" == vp ]]; then vp run --last-details 2>&1 | tee -a "$log" || true; fi
  fi
  echo "::endgroup::"
}

run guard node scripts/lastdrop/check-fork-paths.ts --base "$base"
# GitHub's standard runner (4 CPUs, 16 GB) runs out of memory with more typecheck tasks at once.
run typecheck vp run --concurrency-limit 2 typecheck
run test vp run -r test
run build vp run build:desktop

if ((${#failed[@]})); then
  echo "Failed: ${failed[*]}" | tee -a "$log"
  exit 1
fi
