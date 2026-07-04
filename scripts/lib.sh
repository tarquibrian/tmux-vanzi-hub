#!/usr/bin/env sh

tmux_option() {
  value="$(tmux show-option -gqv "$1" 2>/dev/null || true)"
  [ -n "$value" ] && printf "%s" "$value" || printf "%s" "$2"
}

project_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || printf "%s" "$1"
}

path_hash() {
  hash_length="$(tmux_option @vanzi_hub_hash_length 8)"

  if command -v md5sum >/dev/null 2>&1; then
    printf "%s" "$1" | md5sum | cut -c1-"$hash_length"
  else
    printf "%s" "$1" | md5 | cut -c1-"$hash_length"
  fi
}

acp_workspace_scope() {
  tmux_option @vanzi_hub_workspace_scope "project"
}

acp_global_session_name() {
  tmux_option @vanzi_hub_workspace_session "vanzi-hub"
}

acp_project_session_name() {
  project_path="$1"
  prefix="$(tmux_option @vanzi_hub_session_prefix vz)"
  project_slug="$(safe_name "$(basename "$project_path")")"
  project_hash="$(path_hash "$project_path")"

  printf "%s-%s-%s" "$prefix" "$project_slug" "$project_hash"
}

# Friendly session resolution: sessions are named <prefix>-<slug> (vz-<slug>
# by default, with -2/-3 when another project owns the slug) so tree views
# read cleanly. Identity lives in the @vanzi_hub_project_path session option,
# not the name; the legacy <prefix>-<slug>-<hash> deterministic name is still
# honored so live sessions from older versions keep working until they die.
acp_project_session() {
  project_path="$1"
  prefix="$(tmux_option @vanzi_hub_session_prefix vz)"
  tab="$(printf '\t')"

  found="$(tmux list-sessions -F "#{session_name}${tab}#{@vanzi_hub_project_path}" 2>/dev/null |
    awk -F "\t" -v pre="$prefix-" -v path="$project_path" \
      'index($1, pre) == 1 && $2 == path { print $1; exit }')"
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return
  fi

  legacy="$(acp_project_session_name "$project_path")"
  if tmux has-session -t "=$legacy" 2>/dev/null; then
    printf '%s\n' "$legacy"
    return
  fi

  base="$prefix-$(safe_name "$(basename "$project_path")")"
  name="$base"
  n=2
  while tmux has-session -t "=$name" 2>/dev/null; do
    name="$base-$n"
    n=$((n + 1))
  done
  printf '%s\n' "$name"
}

acp_session_name() {
  project_path="${1:-}"

  if [ "$(acp_workspace_scope)" = "global" ] || [ -z "$project_path" ]; then
    acp_global_session_name
    return
  fi

  acp_project_session "$project_path"
}

is_acp_session() {
  prefix="$(tmux_option @vanzi_hub_session_prefix vz)"
  workspace="$(acp_global_session_name)"

  case "$1" in
    "$workspace") return 0 ;;
    "$prefix"-*) return 0 ;;
    *) return 1 ;;
  esac
}

window_exists() {
  tmux list-windows -t "$1" -F "#{window_name}" 2>/dev/null | grep -Fxq "$2"
}

window_id_for() {
  tmux list-windows -t "$1" -F "#{window_id} #{window_name}" 2>/dev/null | awk -v name="$2" '$2 == name { print $1; exit }'
}

window_is_dead() {
  [ "$(tmux display-message -p -t "$1" "#{pane_dead}" 2>/dev/null || true)" = "1" ]
}

# The window already hosting a given chat id, regardless of its name. A chat
# created as "<provider>-new" keeps that window name but stores the real chat
# id in @vanzi_hub_chat_id; reopening it by canonical name would miss this
# window and spawn a duplicate, so match on the id.
window_id_for_chat() {
  window_chat_session="$1"
  window_chat_id="$2"
  [ -n "$window_chat_id" ] || return 1

  tmux has-session -t "$window_chat_session" 2>/dev/null || return 1
  tmux list-windows -t "$window_chat_session" -F "#{@vanzi_hub_chat_id}|#{window_id}" 2>/dev/null |
    awk -F "|" -v chat="$window_chat_id" '$1 == chat { print $2; exit }'
}

current_acp_window_for() {
  current_session="$1"
  current_project_path="$2"
  current_provider="$3"

  tmux has-session -t "$current_session" 2>/dev/null || return 1
  tmux list-windows -t "$current_session" -F "#{@vanzi_hub_project_path}|#{@vanzi_hub_provider}|#{@vanzi_hub_action}|#{@vanzi_hub_status}|#{@vanzi_hub_updated_at}|#{window_activity}|#{window_id}" 2>/dev/null |
    awk -F "|" -v project="$current_project_path" -v provider="$current_provider" '
      $1 == project && $2 == provider && $3 != "menu" && $4 != "closed" && $4 != "stopped" && $4 != "error" {
        score = $5 != "" ? $5 : sprintf("%020d", $6)
        if (best == "" || score > best_score) {
          best = $7
          best_score = score
        }
      }
      END {
        if (best != "") print best
      }
    '
}

last_acp_window_for_project() {
  current_session="$1"
  current_project_path="$2"

  tmux has-session -t "$current_session" 2>/dev/null || return 1
  tmux list-windows -t "$current_session" -F "#{window_active}|#{@vanzi_hub_project_path}|#{@vanzi_hub_action}|#{pane_dead}|#{@vanzi_hub_updated_at}|#{window_activity}|#{window_id}" 2>/dev/null |
    awk -F "|" -v project="$current_project_path" '
      $2 == project && $3 != "menu" && $4 != "1" {
        if ($1 == "1") {
          print $7
          selected = 1
          exit
        }

        score = $5 != "" ? $5 : sprintf("%020d", $6)
        if (best == "" || score > best_score) {
          best = $7
          best_score = score
        }
      }
      END {
        if (!selected && best != "") print best
      }
    '
}

safe_name() {
  value="$(printf "%s" "$1" | tr -cs '[:alnum:]_.-' '-' | sed 's/^[^[:alnum:]]*//;s/[^[:alnum:]]*$//')"
  [ -n "$value" ] && printf "%.24s" "$value" || printf "project"
}

canonical_acp_window_name() {
  canonical_project_path="$1"
  canonical_provider="$2"
  canonical_chat_id="$3"
  canonical_action="$4"
  canonical_project_slug="$(safe_name "$(basename "$canonical_project_path")")"
  canonical_project_hash="$(path_hash "$canonical_project_path")"

  if [ "$canonical_action" = "menu" ]; then
    printf "menu"
  elif [ -n "$canonical_chat_id" ]; then
    printf "%s-%s-%s-%s" "$canonical_project_slug" "$canonical_project_hash" "$canonical_provider" "$(path_hash "$canonical_chat_id")"
  elif [ "$canonical_action" = "new" ]; then
    printf "%s-%s-%s-new" "$canonical_project_slug" "$canonical_project_hash" "$canonical_provider"
  else
    printf "%s-%s-%s" "$canonical_project_slug" "$canonical_project_hash" "$canonical_provider"
  fi
}

unique_window_name() {
  unique_session="$1"
  unique_base="$2"
  unique_current_id="${3:-}"
  unique_candidate="$unique_base"
  unique_index=2

  while :; do
    unique_existing_id="$(window_id_for "$unique_session" "$unique_candidate")"
    if [ -z "$unique_existing_id" ] || [ "$unique_existing_id" = "$unique_current_id" ]; then
      printf "%s" "$unique_candidate"
      return 0
    fi

    unique_candidate="$unique_base-$unique_index"
    unique_index=$((unique_index + 1))
  done
}

cleanup_workspace_windows() {
  cleanup_session="$1"
  cleanup_separator="|"

  tmux has-session -t "$cleanup_session" 2>/dev/null || return 0

  tmux list-windows -t "$cleanup_session" -F "#{window_id}|#{window_name}|#{@vanzi_hub_project_path}|#{@vanzi_hub_provider}|#{@vanzi_hub_chat_id}|#{@vanzi_hub_action}" 2>/dev/null |
    while IFS="$cleanup_separator" read -r cleanup_window_id cleanup_window_name cleanup_project_path cleanup_provider cleanup_chat_id cleanup_action; do
      [ -n "$cleanup_window_id" ] || continue
      [ -n "$cleanup_project_path" ] || continue
      [ -n "$cleanup_provider" ] || continue

      cleanup_desired=""
      cleanup_canonical="$(canonical_acp_window_name "$cleanup_project_path" "$cleanup_provider" "$cleanup_chat_id" "$cleanup_action")"

      case "$cleanup_window_name" in
        [![:alnum:]]*) cleanup_desired="$cleanup_canonical" ;;
      esac

      # A window still named "menu" that now hosts a chat view (a chat was
      # opened from the picker in that window) must give the name back, or
      # prefix+M keeps landing on the chat instead of a fresh menu.
      if [ -z "$cleanup_desired" ] && [ "$cleanup_window_name" = "menu" ] && [ "$cleanup_action" != "menu" ]; then
        cleanup_desired="$cleanup_canonical"
      fi

      if [ -z "$cleanup_desired" ] && [ "$cleanup_action" = "new" ]; then
        case "$cleanup_window_name" in
          "$cleanup_canonical"-[0-9]*-*) cleanup_desired="$cleanup_canonical" ;;
        esac
      fi

      [ -n "$cleanup_desired" ] || continue
      cleanup_existing_id="$(window_id_for "$cleanup_session" "$cleanup_desired")"
      if [ -n "$cleanup_existing_id" ] && [ "$cleanup_existing_id" != "$cleanup_window_id" ]; then
        cleanup_desired="$cleanup_desired-legacy"
      fi

      cleanup_target="$(unique_window_name "$cleanup_session" "$cleanup_desired" "$cleanup_window_id")"
      [ "$cleanup_window_name" = "$cleanup_target" ] && continue
      tmux rename-window -t "$cleanup_window_id" "$cleanup_target" 2>/dev/null || true
    done
}

set_window_metadata() {
  target="$1"
  provider="$2"
  chat_id="$3"
  action="$4"
  project_path="$5"
  project_name="$(basename "$project_path")"
  provider_short="$(printf '%s' "$provider" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')"
  window_title="New chat"
  status_detail="Starting ACP"

  if [ "$action" = "new" ]; then
    window_title="New chat"
    status_detail="Creating new ACP session"
  elif [ -n "$chat_id" ]; then
    window_title="Restored chat"
    status_detail="Restoring ACP session"
  elif [ "$action" = "menu" ]; then
    window_title="ACP menu"
    status_detail="Opening ACP menu"
  fi

  case "$provider" in
    claude) provider_icon="❋" ;;
    codex) provider_icon="⬡" ;;
    *) provider_icon="◆" ;;
  esac

  tmux set-window-option -t "$target" -q @vanzi_hub_provider "$provider"
  tmux set-window-option -t "$target" -q @vanzi_hub_provider_short "$provider_short"
  tmux set-window-option -t "$target" -q @vanzi_hub_provider_icon "$provider_icon"
  tmux set-window-option -t "$target" -q @vanzi_hub_chat_id "$chat_id"
  tmux set-window-option -t "$target" -q @vanzi_hub_action "$action"
  tmux set-window-option -t "$target" -q @vanzi_hub_project_path "$project_path"
  tmux set-window-option -t "$target" -q @vanzi_hub_project_name "$project_name"
  tmux set-window-option -t "$target" -q @vanzi_hub_project_hash "$(path_hash "$project_path")"
  tmux set-window-option -t "$target" -q @vanzi_hub_status "starting"
  tmux set-window-option -t "$target" -q @vanzi_hub_status_glyph "◌"
  tmux set-window-option -t "$target" -q @vanzi_hub_status_detail "$status_detail"
  tmux set-window-option -t "$target" -q @vanzi_hub_mode ""
  tmux set-window-option -t "$target" -q @vanzi_hub_model ""
  tmux set-window-option -t "$target" -q @vanzi_hub_effort ""
  tmux set-window-option -t "$target" -q @vanzi_hub_title "$window_title"
  refresh_status_line
}

# Window-status labels are not re-rendered on option changes; force it. A bare
# refresh-client -S fails inside run-shell (no current client), so refresh
# every attached client explicitly.
refresh_status_line() {
  for _client in $(tmux list-clients -F '#{client_name}' 2>/dev/null); do
    tmux refresh-client -S -t "$_client" 2>/dev/null || true
  done
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

popup_width() {
  tmux_option @vanzi_hub_popup_width "90%"
}

popup_height() {
  tmux_option @vanzi_hub_popup_height "85%"
}

node_bin() {
  tmux_option @vanzi_hub_node "node"
}

default_agent() {
  tmux_option @vanzi_hub_default_agent "codex"
}

set_workspace_metadata() {
  session="$1"
  project_path="$2"
  parent_client="$3"
  parent_pane="$4"

  tmux set-option -t "$session" -q @vanzi_hub_project_path "$project_path"
  tmux set-option -t "$session" -q @vanzi_hub_project_name "$(basename "$project_path")"
  tmux set-option -t "$session" -q @vanzi_hub_project_hash "$(path_hash "$project_path")"
  tmux set-option -t "$session" -q @vanzi_hub_parent_client "$parent_client"
  tmux set-option -t "$session" -q @vanzi_hub_parent_pane "$parent_pane"

  # Inside the ACP workspace, show minimal chat labels in the status bar:
  # provider icon (accent-colored), renameable title, and a status glyph only
  # when the chat needs attention (busy/permission/auth/error) — idle is quiet.
  # Codex = characteristic blue, Claude = characteristic orange; unknown falls
  # back to blue. Applied to the icon on inactive tabs only.
  acp_provider_style="#{?#{==:#{@vanzi_hub_provider},claude},#[fg=colour173],#{?#{==:#{@vanzi_hub_provider},codex},#[fg=colour39],#[fg=colour39]}}"
  acp_icon="#{?#{@vanzi_hub_provider_icon},#{@vanzi_hub_provider_icon},#{@vanzi_hub_provider_short}}"
  acp_attention_states="responding|thinking|working|planning|starting|cancelling|permission|auth|error"
  # Inactive tabs: semantic hue for the attention glyph (dark bg reads it fine).
  acp_attention="#{?#{m/r:^($acp_attention_states)$,#{@vanzi_hub_status}}, #{?#{==:#{@vanzi_hub_status},error},#[fg=red],#{?#{m/r:^(permission|auth)$,#{@vanzi_hub_status}},#[fg=yellow],#[fg=cyan]}}#{@vanzi_hub_status_glyph}#[default],}"
  # Active tab: the glyph inherits the current-style (black on the accent bar)
  # like the icon and title; its shape (◐ ⏸ ⊘ ✗) already carries the state, so
  # a semantic tint would only cost contrast on the punk background.
  acp_attention_active="#{?#{m/r:^($acp_attention_states)$,#{@vanzi_hub_status}}, #{@vanzi_hub_status_glyph},}"
  acp_title="#{?#{@vanzi_hub_title},#{@vanzi_hub_title},#W}"
  # Inactive: provider-colored icon. Active (current): the icon inherits the
  # window-status-current-style so it reads black like the title on the accent
  # background, instead of a low-contrast provider tint.
  acp_window_status_format=" $acp_provider_style$acp_icon#[default] $acp_title$acp_attention "
  acp_window_status_current_format=" $acp_icon $acp_title$acp_attention_active "
  tmux set-option -t "$session" -q window-status-format "$acp_window_status_format"
  tmux set-option -t "$session" -q window-status-current-format "$acp_window_status_current_format"
  tmux set-option -t "$session" -q window-status-separator ""
}
