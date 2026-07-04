#!/usr/bin/env sh
set -eu

CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$CURRENT_DIR/scripts/lib.sh"

CURRENT_SESSION="${1:-}"
TARGET_PANE="${2:-}"

if is_acp_session "$CURRENT_SESSION"; then
  provider="#{?#{@vanzi_hub_provider_short},#{@vanzi_hub_provider_short},#{?#{@vanzi_hub_provider_label},#{@vanzi_hub_provider_label},#{@vanzi_hub_provider}}}"
  icon="#{?#{@vanzi_hub_provider_icon},#{@vanzi_hub_provider_icon},$provider}"
  glyph="#{?#{@vanzi_hub_status_glyph},#{@vanzi_hub_status_glyph} ,}"
  title="#{?#{@vanzi_hub_title},#{@vanzi_hub_title},#{window_name}}"
  meta="#{?#{@vanzi_hub_mode},#{@vanzi_hub_mode}  ,}#{?#{@vanzi_hub_model},#{@vanzi_hub_model} ,}#{?#{@vanzi_hub_effort},#{@vanzi_hub_effort}  ,}#{?#{@vanzi_hub_plan},steps #{@vanzi_hub_plan},}"
  status_style="#{?#{==:#{@vanzi_hub_status},error},#[fg=red],#{?#{==:#{@vanzi_hub_status},idle},#[fg=green],#{?#{==:#{@vanzi_hub_status},responding},#[fg=green],#{?#{==:#{@vanzi_hub_status},permission},#[fg=yellow],#{?#{==:#{@vanzi_hub_status},auth},#[fg=yellow],#{?#{==:#{@vanzi_hub_status},starting},#[fg=cyan],#[fg=colour244]}}}}}}"
  provider_style="#{?#{==:#{@vanzi_hub_provider},claude},#[fg=colour173],#{?#{==:#{@vanzi_hub_provider},codex},#[fg=colour39],#[fg=colour39]}}"

  # Window rows: icon · fixed-width title · status · last activity · meta.
  # Titles are clipped with an ellipsis and padded so the columns line up.
  chat_line="$provider_style$icon#[default] #[bold]#{p32:#{=/30/…:$title}}#[default] $status_style$glyph#{p11:#{@vanzi_hub_status}}#[default] #[fg=colour244]#{t/f/%R:window_activity}  $meta#[default]"
  # Session rows (the tree parents) read as the project instead of the raw
  # vz-<slug> name; the active window's options carry the path.
  session_line="#[bold]▣ #{?#{@vanzi_hub_project_path},#{b:@vanzi_hub_project_path},#{session_name}}#[default]  #[fg=colour244]#{@vanzi_hub_project_path}#[default]"
  format="#{?window_format,$chat_line,$session_line}"
  prefix="$(tmux_option @vanzi_hub_session_prefix vz)"
  global_session="$(acp_global_session_name)"

  if [ "$(acp_workspace_scope)" = "project" ]; then
    session_filter="#{&&:#{m/r:^$prefix-,#{session_name}},#{!=:#{session_name},$global_session}}"
  else
    session_filter="#{||:#{==:#{session_name},$global_session},#{m/r:^$prefix-,#{session_name}}}"
  fi

  filter="#{&&:$session_filter,#{&&:#{!=:#{window_name},menu},#{&&:#{==:#{pane_dead},0},#{&&:#{!=:#{@vanzi_hub_project_path},},#{!=:#{@vanzi_hub_provider},}}}}}"

  chat_count="$(tmux list-windows -a -f "$filter" -F "#{window_id}" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$chat_count" = "0" ]; then
    tmux display-message "vanzi-hub: no hay chats ACP activos para mostrar"
    exit 0
  fi

  if [ -n "$TARGET_PANE" ]; then
    tmux choose-tree -Zw -O time -t "$TARGET_PANE" -f "$filter" -F "$format" "switch-client -t '%%'"
  else
    tmux choose-tree -Zw -O time -f "$filter" -F "$format" "switch-client -t '%%'"
  fi
  exit 0
fi

prefix="$(tmux_option @vanzi_hub_session_prefix vz)"
normal_session_filter="#{?#{m/r:^(agents|acp|$prefix)-,#{session_name}},0,1}"
tmux choose-tree -Zs -f "$normal_session_filter"
