#!/usr/bin/env bash
# The conflicted files of an in-progress merge, with each seam's section of FORK.md, so Claude reads
# that instead of all of FORK.md. Usage: sync-brief.sh <FORK.md>
set -euo pipefail
fork_md="$1"
echo "# Conflicted files"
echo
git diff --name-only --diff-filter=U | while read -r file; do
  section="$(awk -v head="### \`$file\`" '
    index($0, head) == 1 { on = 1; print; next }
    on && /^##/ { exit }
    on { print }
  ' "$fork_md")"
  if [[ -n "$section" ]]; then
    printf '%s\n\n' "$section"
  else
    printf '## `%s`\n\nNot a seam.\n\n' "$file"
  fi
done
