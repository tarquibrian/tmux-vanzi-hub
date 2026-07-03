#!/usr/bin/env sh
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$CURRENT_DIR/scripts"
. "$SCRIPT_DIR/lib.sh"

CURRENT_PATH="${1:-$(pwd)}"
CURRENT_SESSION="${2:-}"
TARGET_CLIENT="${3:-}"
TARGET_PANE="${4:-}"
PROVIDER="${5:-}"
CHAT_ID="${6:-}"
ACTION="${7:-open}"

[ -n "$CURRENT_PATH" ] || CURRENT_PATH="$HOME"

# prefix+M while already on the ephemeral menu window toggles it off: send the
# menu process an Escape so it backs out (reveals the recent chat or minimizes)
# and exits, closing its own window — instead of stacking another menu.
if [ "$ACTION" = "menu" ] && [ -n "$TARGET_PANE" ]; then
  current_action="$(tmux display-message -p -t "$TARGET_PANE" "#{@vanzi_hub_action}" 2>/dev/null || true)"
  if [ "$current_action" = "menu" ]; then
    tmux send-keys -t "$TARGET_PANE" Escape
    exit 0
  fi
fi

if is_acp_session "$CURRENT_SESSION"; then
  if [ "$ACTION" = "toggle" ] && [ -n "$TARGET_CLIENT" ]; then
    tmux detach-client -t "$TARGET_CLIENT"
    exit 0
  fi
fi

PROJECT_PATH="$(project_root "$CURRENT_PATH")"
SESSION="$(acp_session_name "$PROJECT_PATH")"
[ -n "$PROVIDER" ] || PROVIDER="$(default_agent)"

stored_project_chat() {
  "$(node_bin)" "$CURRENT_DIR/bin/vanzi-hub.mjs" project-chat --cwd "$PROJECT_PATH" 2>/dev/null || true
}

# Project with no chats: ask the hub what to do. "create" means no chats exist
# anywhere (or no tmux to draw a menu), so a chat is created directly; any
# other answer means a native menu was shown and took over the flow.
toggle_menu_decision() {
  "$(node_bin)" "$CURRENT_DIR/bin/vanzi-hub.mjs" tmux-toggle-menu \
    --cwd "$PROJECT_PATH" \
    --session "$CURRENT_SESSION" \
    --client "$TARGET_CLIENT" \
    --pane "$TARGET_PANE" 2>/dev/null || printf "create"
}

if [ "$ACTION" = "toggle" ]; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    cleanup_workspace_windows "$SESSION"
    existing_window_id="$(last_acp_window_for_project "$SESSION" "$PROJECT_PATH" 2>/dev/null || true)"
    if [ -n "$existing_window_id" ]; then
      set_workspace_metadata "$SESSION" "$PROJECT_PATH" "$TARGET_CLIENT" "$TARGET_PANE"
      tmux select-window -t "$existing_window_id"
      ACTION="toggle-existing"
    fi
  fi

  if [ "$ACTION" = "toggle" ]; then
    stored_chat="$(stored_project_chat)"
    if [ -n "$stored_chat" ]; then
      PROVIDER="${stored_chat%%|*}"
      CHAT_ID="${stored_chat#*|}"
      ACTION="open"
    else
      decision="$(toggle_menu_decision)"
      if [ "$decision" != "create" ]; then
        exit 0
      fi
      ACTION="open"
    fi
  fi
fi

window_name() {
  base_name="$(canonical_acp_window_name "$PROJECT_PATH" "$PROVIDER" "$CHAT_ID" "$ACTION")"

  if [ "$ACTION" = "new" ]; then
    unique_window_name "$SESSION" "$base_name"
    return
  fi

  printf "%s" "$base_name"
}

window_command() {
  node="$(node_bin)"
  bin="$CURRENT_DIR/bin/vanzi-hub.mjs"

  if [ "$ACTION" = "menu" ]; then
    printf "%s %s ui --mode menu --cwd %s" "$(shell_quote "$node")" "$(shell_quote "$bin")" "$(shell_quote "$PROJECT_PATH")"
    return
  fi

  cmd="$(shell_quote "$node") $(shell_quote "$bin") ui --mode chat --cwd $(shell_quote "$PROJECT_PATH") --agent $(shell_quote "$PROVIDER")"
  if [ -n "$CHAT_ID" ]; then
    cmd="$cmd --chat-id $(shell_quote "$CHAT_ID")"
  fi
  if [ "$ACTION" = "new" ]; then
    cmd="$cmd --new"
  fi
  printf "%s" "$cmd"
}

ensure_workspace() {
  if [ "$ACTION" = "toggle-existing" ]; then
    return
  fi

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    cleanup_workspace_windows "$SESSION"
  fi

  # Reopening a specific chat: jump to the window already hosting that chat id
  # (its name may differ from the canonical one, e.g. a "<provider>-new"
  # window) instead of spawning a duplicate.
  if [ -n "$CHAT_ID" ] && [ "$ACTION" != "new" ]; then
    chat_window_id="$(window_id_for_chat "$SESSION" "$CHAT_ID" 2>/dev/null || true)"
    if [ -n "$chat_window_id" ] && ! window_is_dead "$chat_window_id"; then
      set_workspace_metadata "$SESSION" "$PROJECT_PATH" "$TARGET_CLIENT" "$TARGET_PANE"
      set_window_metadata "$chat_window_id" "$PROVIDER" "$CHAT_ID" "$ACTION" "$PROJECT_PATH"
      tmux select-window -t "$chat_window_id"
      return
    fi
  fi

  if [ -z "$CHAT_ID" ] && { [ "$ACTION" = "open" ] || [ "$ACTION" = "toggle" ]; }; then
    current_window_id="$(current_acp_window_for "$SESSION" "$PROJECT_PATH" "$PROVIDER" 2>/dev/null || true)"
    if [ -n "$current_window_id" ]; then
      set_workspace_metadata "$SESSION" "$PROJECT_PATH" "$TARGET_CLIENT" "$TARGET_PANE"
      tmux select-window -t "$current_window_id"
      return
    fi
  fi

  name="$(window_name)"
  cmd="$(window_command)"

  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    window_id="$(tmux new-session -d -P -F "#{window_id}" -s "$SESSION" -n "$name" -c "$PROJECT_PATH" "$cmd")"
  elif ! window_exists "$SESSION" "$name"; then
    window_id="$(tmux new-window -d -P -F "#{window_id}" -t "$SESSION:" -n "$name" -c "$PROJECT_PATH" "$cmd")"
  else
    window_id="$(window_id_for "$SESSION" "$name")"
    if window_is_dead "$window_id"; then
      tmux respawn-window -k -t "$window_id" -c "$PROJECT_PATH" "$cmd"
    fi
  fi

  set_workspace_metadata "$SESSION" "$PROJECT_PATH" "$TARGET_CLIENT" "$TARGET_PANE"
  set_window_metadata "$window_id" "$PROVIDER" "$CHAT_ID" "$ACTION" "$PROJECT_PATH"
  tmux select-window -t "$window_id"
}

ensure_workspace

if is_acp_session "$CURRENT_SESSION"; then
  if [ -n "$TARGET_CLIENT" ]; then
    tmux switch-client -c "$TARGET_CLIENT" -t "$SESSION"
  fi
  exit 0
fi

if [ -n "$TARGET_CLIENT" ]; then
  tmux display-popup -c "$TARGET_CLIENT" -d "$PROJECT_PATH" -w "$(popup_width)" -h "$(popup_height)" -E "tmux attach-session -t $(shell_quote "$SESSION")"
else
  tmux display-popup -d "$PROJECT_PATH" -w "$(popup_width)" -h "$(popup_height)" -E "tmux attach-session -t $(shell_quote "$SESSION")"
fi
