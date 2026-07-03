#!/usr/bin/env sh

CURRENT_DIR="$(cd "$(dirname "$0")" && pwd)"

set_default() {
  option="$1"
  value="$2"

  [ -n "$(tmux show-option -gqv "$option")" ] && return 0
  tmux set-option -gq "$option" "$value"
}

set_default @vanzi_hub_popup_width "90%"
set_default @vanzi_hub_popup_height "85%"
set_default @vanzi_hub_legacy_keys "on"
set_default @vanzi_hub_workspace_session "vanzi-hub"
set_default @vanzi_hub_workspace_scope "project"
set_default @vanzi_hub_session_prefix "vz"
set_default @vanzi_hub_hash_length "8"
set_default @vanzi_hub_node "node"

tmux set-option -gq @vanzi_hub_dir "$CURRENT_DIR"

tmux unbind-key -q m
tmux unbind-key -q s
tmux unbind-key -q y
tmux unbind-key -q M

tmux bind-key m run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" '' '' toggle"
tmux bind-key y run-shell "sh \"$CURRENT_DIR/scripts/tmux-menu.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\""
tmux bind-key M run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" '' '' menu"

if [ "$(tmux show-option -gqv @vanzi_hub_legacy_keys)" = "on" ]; then
  # 9/0 always create a fresh chat (predictable with many chats around);
  # (/) focus the most recent existing chat for the provider.
  tmux unbind-key -q 9
  tmux unbind-key -q 0
  tmux unbind-key -q '('
  tmux unbind-key -q ')'
  tmux bind-key -r 9 run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" codex '' new"
  tmux bind-key -r 0 run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" claude '' new"
  tmux bind-key -r '(' run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" codex '' open"
  tmux bind-key -r ')' run-shell "sh \"$CURRENT_DIR/scripts/workspace.sh\" \"#{pane_current_path}\" \"#{session_name}\" \"#{client_name}\" \"#{pane_id}\" claude '' open"
fi

# Outside the ACP popup this is the normal tmux session chooser. Inside a
# vz-* popup workspace it becomes the ACP chat/window chooser with live status.
tmux bind-key s run-shell "sh \"$CURRENT_DIR/scripts/switcher.sh\" \"#{session_name}\" \"#{pane_id}\""

SESSION_PREFIX="$(tmux show-option -gqv @vanzi_hub_session_prefix)"
[ -n "$SESSION_PREFIX" ] || SESSION_PREFIX="vz"
WORKSPACE_SESSION="$(tmux show-option -gqv @vanzi_hub_workspace_session)"
[ -n "$WORKSPACE_SESSION" ] || WORKSPACE_SESSION="vanzi-hub"
ACP_MATCH="#{||:#{m/r:^${SESSION_PREFIX}-,#{session_name}},#{==:#{session_name},$WORKSPACE_SESSION}}"

# Inside ACP workspaces prefix+, renames the CHAT (daemon title + status-bar
# label); window names stay canonical since they carry chat identity. Outside
# it is the normal tmux window rename.
tmux unbind-key -q ,
tmux bind-key , if-shell -F "$ACP_MATCH" \
  "command-prompt -I \"#{@vanzi_hub_title}\" -p \"Rename chat:\" \"run-shell 'sh $CURRENT_DIR/scripts/rename-chat.sh #{pane_id} \\\"%%\\\"'\"" \
  "command-prompt -I \"#{window_name}\" \"rename-window -- '%%'\""

# Inside ACP workspaces prefix+x / prefix+& open a close menu that states what
# actually dies: killing the window only closes the view — the chat keeps
# running in the daemon unless explicitly stopped or deleted.
tmux unbind-key -q x
tmux bind-key x if-shell -F "$ACP_MATCH" \
  "run-shell \"sh $CURRENT_DIR/scripts/close-menu.sh #{pane_id}\"" \
  "confirm-before -p \"kill-pane #P? (y/n)\" kill-pane"
tmux unbind-key -q '&'
tmux bind-key '&' if-shell -F "$ACP_MATCH" \
  "run-shell \"sh $CURRENT_DIR/scripts/close-menu.sh #{pane_id}\"" \
  "confirm-before -p \"kill-window #W? (y/n)\" kill-window"
