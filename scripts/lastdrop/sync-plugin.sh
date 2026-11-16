#!/bin/sh
# Copies lastdrop's Claude Code plugin from the lastdrop app's repository into the fork
# (packages/lastdrop-plugin/lastdrop/, its tests left out), then rebuilds the copy the server embeds
# (packages/lastdrop-node/src/pluginFiles.generated.ts). Run it after the plugin changes there.
#
#   scripts/lastdrop/sync-plugin.sh [path to ClaudePlugin/lastdrop]
#
# The copy is formatted with the repo's formatter and its sources start with a lint-off comment: T3's
# lint rules are not the plugin's.
#
# Without a path: ../headroom/ClaudePlugin/lastdrop beside the main checkout, or $LASTDROP_PLUGIN_SOURCE.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
source=${1:-${LASTDROP_PLUGIN_SOURCE:-}}
if [ -z "$source" ]; then
  common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)
  source="$common/../../headroom/ClaudePlugin/lastdrop"
fi
source=$(cd "$source" && pwd)
[ -f "$source/.claude-plugin/plugin.json" ] || { echo "not a plugin folder: $source" >&2; exit 1; }

target="$root/packages/lastdrop-plugin"
mkdir -p "$target"
rsync -a --delete --exclude tests --exclude node_modules --exclude .DS_Store "$source/" "$target/lastdrop/"
for file in $(find "$target/lastdrop" -name '*.tsx' -o -name '*.ts' ! -name '*.d.ts'); do
  { echo '/* oxlint-disable */'; cat "$file"; } > "$file.tmp" && mv "$file.tmp" "$file"
done
(cd "$root" && node_modules/.bin/vp fmt packages/lastdrop-plugin)
# What it was copied from, so a reader can tell how stale it is.
repo=$(git -C "$source" rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$repo" ]; then
  git -C "$repo" rev-parse HEAD > "$target/SOURCE"
fi

(cd "$root/packages/lastdrop-node" && ../../node_modules/.bin/vp run build-plugin-files)
(cd "$root" && node_modules/.bin/vp fmt packages/lastdrop-node/src/pluginFiles.generated.ts)
echo "plugin synced from $source"
