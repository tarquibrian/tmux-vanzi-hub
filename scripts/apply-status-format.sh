#!/usr/bin/env sh
# Re-assert the ACP window-status-format on a workspace session. The daemon
# calls this on every metadata sync to self-heal the intermittent revert of
# this session option to the theme default (see apply_acp_status_format).
#
# Usage: apply-status-format.sh <session-or-window-target>
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$CURRENT_DIR/scripts/lib.sh"

TARGET="${1:-}"
[ -n "$TARGET" ] || exit 0

apply_acp_status_format "$TARGET"
