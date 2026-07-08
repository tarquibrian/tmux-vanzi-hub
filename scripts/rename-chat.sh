#!/usr/bin/env sh
# Renames the ACP chat shown in a pane (daemon title + tmux label).
# Usage: rename-chat.sh <pane_id> <title>
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$CURRENT_DIR/scripts/lib.sh"

PANE="${1:-}"
TITLE="${2:-}"
[ -n "$TITLE" ] || exit 0

exec "$(node_bin)" "$CURRENT_DIR/bin/vanzi-hub.mjs" tmux-action --action rename --pane "$PANE" --value "$TITLE"
