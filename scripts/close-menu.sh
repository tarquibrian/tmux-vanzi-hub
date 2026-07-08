#!/usr/bin/env sh
# Close menu for ACP windows: closing a window never kills the chat (it lives
# in the daemon); this menu offers the real choices.
# Usage: close-menu.sh <pane_id>
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$CURRENT_DIR/scripts/lib.sh"

exec "$(node_bin)" "$CURRENT_DIR/bin/vanzi-hub.mjs" tmux-close-menu --pane "${1:-}"
