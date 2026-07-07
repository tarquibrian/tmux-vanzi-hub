# tmux-vanzi-hub

Vanzi Hub — a persistent multi-agent hub for tmux. Run Codex, Claude Code,
and any [Agent Client Protocol](https://agentclientprotocol.com) agent in
tmux popups: chats live in a background daemon, survive popup and daemon
restarts, and every list shows live status with a transcript preview.

## Requirements

- tmux >= 3.4
- Node.js >= 18 (no npm dependencies; the plugin is self-contained)
- ACP adapters are fetched on demand via `npx` (Codex: `codex-acp`,
  Claude Code: `claude-agent-acp`); each provider authenticates through
  its own CLI/account the first time (`/auth` inside a chat)

Run `vanzi-hub.mjs health` to check your environment:

```sh
node ~/.config/tmux/plugins/tmux-vanzi-hub/bin/vanzi-hub.mjs health
```

## Installation

With [TPM](https://github.com/tmux-plugins/tpm):

```tmux
set -g @plugin 'tarquibrian/tmux-vanzi-hub'
```

Manual:

```sh
git clone https://github.com/tarquibrian/tmux-vanzi-hub ~/.config/tmux/plugins/tmux-vanzi-hub
```

```tmux
run '~/.config/tmux/plugins/tmux-vanzi-hub/vanzi-hub.tmux'
```

## Authentication

The hub speaks [ACP](https://agentclientprotocol.com) to adapter processes;
authentication belongs to the agent CLI behind each adapter, so **you do not
need a paid plan** — an API key works too:

- **Codex** (`codex-acp`): a ChatGPT plan login (`codex login`) *or*
  `OPENAI_API_KEY`.
- **Claude Code** (`claude-agent-acp`): a Claude subscription
  (`claude /login`) *or* `ANTHROPIC_API_KEY`.

Adapters inherit the daemon's environment, so an exported key just works. To
scope a key to one agent, add an `env` block in
`~/.config/tmux-vanzi-hub/agents.json`:

```json
{
  "agents": {
    "codex": {
      "command": "npx",
      "args": ["-y", "@zed-industries/codex-acp@0.16.0"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

If an adapter starts unauthenticated, the chat drops into an auth state
(yellow composer border): `/auth` lists the login methods the adapter
advertises and `/auth <id|n>` runs one (browser OAuth flows open externally).
Credentials are stored by the agent CLIs themselves (`~/.codex`,
`~/.claude`), never by the hub.

## Adapters and model updates

The hub has **no hardcoded model list**: models, modes, and reasoning efforts
come from the adapter at session start, and the adapter reads them from the
agent CLI underneath. When a provider ships a new model, you get it by
updating those two layers — no plugin change needed:

- The adapter versions are pinned in `agents.json`
  (`@zed-industries/codex-acp@x.y.z`, `@agentclientprotocol/claude-agent-acp@x.y.z`).
  Bump the pin (or use `@latest` if you prefer trailing the newest release)
  in `~/.config/tmux-vanzi-hub/agents.json`.
- Keep the underlying CLIs current (`codex`, `claude`) the way you already
  update them.

`vanzi-hub.mjs health` prints the pinned adapter versions. After changing a
pin, restart the daemon (`vanzi-hub.mjs stop`).

## Privacy

Chat transcripts (the last 200 events per chat) are persisted in plain text
in `~/.cache/tmux-vanzi-hub/registry.json` so chats survive restarts. Delete
a chat (`Ctrl+D` in any picker, or `/delete`) to remove its transcript, or
wipe the state dir entirely: `rm -rf ~/.cache/tmux-vanzi-hub`.

## Keys

- `prefix+m`: minimize the open ACP popup or restore the most recently used
  chat for the current project. In a project with no chats it opens a native
  menu (new chat here per provider, or jump to a chat open in another project);
  when no chats exist anywhere it just creates one with the default provider.
- `prefix+y`: open the native tmux ACP menu for the current project.
- `prefix+M`: open the full ACP menu. Inside a chat it opens **in the same
  pane** as an overlay (equivalent to `Ctrl+O` in the composer, or `←` on an
  empty one; your draft is kept and restored on `Esc`); from a normal pane it
  opens the popup. An interactive list: type to
  filter fzf-style, `↑`/`↓` (or `Ctrl+N`/`Ctrl+P`) move, `Enter` opens the
  chat or creates one from a `New … chat` row, `Tab` toggles project/all
  scope, `Ctrl+R` re-imports provider sessions, `Ctrl+E` renames the
  highlighted chat inline, `Ctrl+S` sends a one-line reply straight to a
  live chat without leaving the list (an idle chat starts a turn, a busy one
  queues it; the preview refreshes to show it), `Ctrl+D` pressed twice
  deletes it permanently (the list refreshes in place), `Esc` clears the
  filter and then minimizes the popup — the menu stays alive so the next
  `prefix+M` reattaches instantly. The list refreshes live while chats change
  state. When the popup is at least 96 columns wide, a preview pane on the
  right shows the transcript tail of the highlighted chat — live and saved
  chats alike.
  Chats needing attention (permission/auth/error) sort to the top of every
  list. Chats are saved automatically (every event persists to the
  registry), so saved is the default state: lists show a status only for
  live chats. Set `VANZI_HUB_INTERACTIVE_UI=0` for the old text menu.
- `prefix+9`: create a new Codex chat for the current project.
- `prefix+0`: create a new Claude chat for the current project.
- `prefix+(`: focus the most recent Codex chat for the current project.
- `prefix+)`: focus the most recent Claude chat for the current project.
- `prefix+s`: outside the popup, open normal tmux sessions; inside `vz-*`,
  open the tmux tree selector for live ACP chats sorted by recent activity —
  aligned columns (icon, title, status, last-activity time, model/effort),
  session rows read as the project name, and the bottom pane previews the
  selected chat's real screen.
- `prefix+,`: inside an ACP workspace, rename the **chat** (daemon title +
  status-bar label); outside, the normal tmux window rename.
- `prefix+x` / `prefix+&`: inside an ACP workspace, open a close menu — close
  the window (chat keeps running), stop the chat (adapter off, stays saved),
  delete the chat permanently, or plain kill-pane. Outside, the normal tmux
  kill confirmations.

## Chats, windows, and the daemon

A chat is **not** a pane or a window: it lives in the background daemon (the
ACP adapter process plus the transcript) and is persisted in the registry.
Each tmux window inside the hidden `vz-*` workspace is only a **view** onto
one chat, and the pane inside it runs a disposable UI client. Consequences:

- Killing a pane or window (`prefix+x`, `prefix+&`) closes the view; the chat
  keeps running and stays in every menu. Reopen it and the transcript replays.
- The transcript is persisted (last 200 events) with the session metadata, so
  it also survives daemon restarts (`vanzi-hub.mjs stop`) — restored chats
  replay their saved transcript even when the adapter cannot reload history.
- A chat window is named after its chat title (a clean provider label like
  `Codex` until the title is known); identity is the `@vanzi_hub_chat_id`
  window option, not the name. `prefix+,` renames the chat (title + window
  name together).
- Splitting panes inside a chat window is plain tmux; extra panes are not
  chats.

`prefix+m` opens an existing internal tmux workspace for the current project,
named `vz-<project>` (with a `-2`/`-3` suffix when two projects share a
basename; the owning project is tracked in the `@vanzi_hub_project_path`
session option, the prefix is configurable via `@vanzi_hub_session_prefix`,
and legacy `acp-project-hash` sessions are reused while they live). When no live or saved chat exists for the
project, a native tmux menu offers a new chat here (one entry per provider,
default first) plus the most recent chats open in other projects so you can
jump to one instead; only when the hub has no chats anywhere does it create a
chat directly with the default provider. Those workspaces are hidden from the normal
`prefix+s` session chooser, but inside the popup they behave like tmux:
`prefix+m` detaches/minimizes, `prefix+9`/`prefix+0` create a fresh
Codex/Claude chat window, and `prefix+(`/`prefix+)` focus the provider's most
recent existing window for the current project. `prefix+s` inside any ACP workspace opens the normal
tmux tree-style ACP chat selector with chats from all project ACP workspaces, so
you can jump between project agents without visiting the normal tmux project
session first. Mini action menus live under `prefix+y`.
Set `@vanzi_hub_workspace_scope` to `global` to restore the single `vanzi-hub`
workspace mode.
Each chat window is named after its chat title (a clean provider label like
`Codex` or `Claude` until the title is known) and identified internally by the
`@vanzi_hub_chat_id` window option, not by its name. Inside the ACP workspace
each window renders as a minimal label built from chat metadata — the provider
icon in its accent color (`❋` Claude, `⬡` Codex, `◆` others; override per agent
with an `icon` field in agents.json), the chat title, and a status glyph only
while the chat needs
attention (working, permission, auth, error) — for example `❋ Refactor auth ⠹`.
Renaming the chat with `/rename` or `prefix+,` updates that label without
changing the internal window name.

Chat titles are human-facing and default to `New chat`, `New chat 2`, etc.
(restored sessions default to `Saved chat`); the project and provider are shown
as their own columns, so titles stay short. Rename a chat to make it easy to find
later. Chat lists everywhere read icon-first: the `prefix+s` switcher shows
`<icon> <title>  <glyph status>  <mode model effort steps>`, and the pickers
and tmux menus follow the same order.

## Popup Commands

- `/menu`: open the agent/chat menu overlay in this pane (same as `←` on an
  empty composer or `Ctrl+O`).
- `/control`, `/cmd`, or `/panel`: open the tmux Command Center for the
  active chat.
- `/chats`: interactive chat switcher over the transcript area (type to
  filter, Enter switches to that chat's window, `Ctrl+E` renames, `Ctrl+D`
  twice deletes — the open chat itself is protected; use `/delete` for it);
  falls back to a tmux menu.
- `/model`, `/effort`, `/modes`, `/access` with no argument open the same
  interactive picker with the current value marked `●`; tmux menus and text
  output remain as fallbacks (`VANZI_HUB_INTERACTIVE_UI=0` forces them).
- `/compose`: write a multiline prompt; finish with a single `.` line.
- `/edit`: write a prompt in `$VISUAL` or `$EDITOR`.
- `/new <agent>`: create another ACP session for the current project.
- `/refresh`: ask providers for saved ACP sessions through `session/list`.
- `/config`: show config options reported by the active ACP adapter.
- `/config <id> <value>`: set an ACP session config option.
- `/model <value>`: set the adapter model config option when reported.
- `/effort <value>`: set effort/reasoning config when reported.
- `/commands`: show provider commands reported through ACP.
- `/modes`: show modes reported by the active ACP adapter.
- `/mode <value>`: set the active ACP session mode.
- `/plan`: show the current execution plan with per-step status (a tmux panel
  when available, otherwise printed in the chat).
- `/auth`: list authentication methods advertised by the adapter.
- `/auth <id>` or `/auth <n>`: authenticate with the chosen method, then retry
  session creation.
- `/mcp`: list the MCP servers passed to the current chat's session.
- `/access <profile>`: set a provider-friendly access alias such as
  `read-only`, `agent`, `full`, `plan`, or `auto`.
- `/roots`: show the main project path and additional directories.
- `/roots add <path>`, `/roots remove <path>`, `/roots clear`: persist
  additional directories for the chat. Active sessions receive them after
  `/close` and reopen.
- `/attach <path> [path...]`: attach files to the next prompt. Images are sent
  as ACP `image` blocks when the agent advertises image support; text files are
  embedded as ACP `resource` blocks when `embeddedContext` is available; other
  files fall back to ACP `resource_link`.
- `@file`: mention and attach a project file inline. Typing `@...` opens the
  autocomplete dropdown with matching project files.
- `/attachments` or `/files`: show pending prompt attachments.
- `/detach <n>|last|all`: remove pending prompt attachments.
- `//command`: send a slash command directly to the provider instead of the hub.
- `/agent <text>`: send raw text directly to the provider.
- `/q <text>` or `?<text>`: filter chats by title, project, path, provider, or session id.
- `/p <provider>`: filter provider with `codex`, `claude`, or `all`.
- `/s <scope>`: filter scope with `project` or `all`.
- `/clear`: reset menu filters.
- `/cancel`: cancel the current turn and pending permission requests.
- Permission requests (including the plan-mode "ready to code?" approval):
  press `Enter` on an empty line — or `/allow` with no number — to open a
  compact numbered menu of the options. Press the number (`1`–`9`) to pick
  instantly, or `Ctrl+N`/`Ctrl+P` (arrows, `j`/`k`) to move and `Enter` to
  confirm; `Esc` keeps it pending. `/allow <n>` still picks option `n`
  directly and `/deny` rejects. Options are whatever the adapter sends; ACP
  has no per-option preview or free-text note channel.
- `/rename <title>` or `/title <title>`: name the current chat for menus/search.
- `/close`: stop the active ACP adapter while keeping saved session metadata.
- `/delete`: permanently delete the current chat (asks to confirm). When the
  adapter advertises `sessionCapabilities.delete`, the stored ACP session is
  deleted from the provider too; otherwise the chat is only forgotten locally.
- `/activity <mode>`: choose tool activity rendering with `compact`, `hidden`, or `debug`.
- `/debug`: toggle internal hub events in the chat pane.
- `/exit`: close the popup client only.

Inside tmux, `prefix+y` in an active ACP chat opens the Command Center for that
chat. Model, effort, config, modes, plan, access, provider commands, new chat,
rename, workspace roots, prompt attachments, activity display, cancel, close,
and delete actions use native tmux menus, prompts, status messages, or
confirmations when possible, so the chat history stays focused on the
conversation. `Delete chat` confirms first and removes the stored ACP session
from providers that advertise `sessionCapabilities.delete`. The slash
commands remain available as a fallback and for scripting. Informational hub
events such as restore, ready, and command-count notices are hidden by default;
use `/debug` to show them temporarily.
When tmux UI is available, long textual fallbacks for config, modes, access,
commands, roots, and refresh are suppressed in the chat pane; retry with
`/debug` enabled to print those details in the transcript.

Use `/exit` or the tmux popup toggle to close/minimize the popup without killing
the agent. Reopening the project/provider returns to the last selected chat.
Use Command Center `Rename chat` or `/rename <title>` to make a chat easy to
find later, then `/menu` or `prefix+s` and `/q <title>` to search saved and live
chats. tmux `prefix+,` renames only the tmux window; it is not persisted as the
ACP chat title.

Tool lifecycle events use `compact` rendering by default. Completed read/search
tools are grouped as `Explored`, edit/write tools as `Edited`, command-like tools
as `Ran`, and active tools use tmux status messages when possible. Use
`/activity hidden` for a conversation-only transcript, `/activity debug` or
`/debug` to render the full ACP/tool event stream in the chat pane. Provider
reasoning/thought chunks are hidden in normal mode and shown only with debug
rendering.

ACP `plan` updates are kept as live chat state, so the latest plan is always
available through `/plan`, the Command Center `Plan` entry, and a `plan done/total`
badge in tmux window metadata and the `prefix+s` switcher. The agent re-sends the
whole plan on every step change; the transcript renders a `Plan (done/total)`
block with per-step markers (`x` done, `>` in progress, `-` pending) and skips
identical repeats so progress is shown without duplicate blocks.

Agent responses are rendered with a small terminal Markdown renderer. It handles
headings, inline code, bold/italic text, links, images, blockquotes, lists,
checklists, fenced code blocks, horizontal rules, and streamed Markdown tables.
Tables are rendered without pipes, with aligned width-aware columns and
continuous separators. While the pinned composer is active, streamed tables
render progressively: the header appears as soon as its separator arrives, each
body row is painted the moment its line completes, and the block is re-painted
in place when a wider row changes the column widths. Width math is
display-aware, so CJK text and emoji keep tables and wrapped lines aligned. It
is not a full CommonMark parser; unsupported Markdown falls back to readable
plain text.

ACP session config uses the standard `session/set_config_option` and
`session/set_mode` methods when the adapter implements them. Use `/config` to
see exact ids and values, or shortcuts such as `/model sonnet`,
`/effort high`, and `/mode plan` when those options are reported by the active
adapter. The config menu is actionable in tmux: selecting a value submits the
matching hub action directly and updates tmux status without echoing a slash
command into the chat input.
`/model`, `/effort`, `/modes`, and `/access` open focused interactive pickers
over the transcript (tmux menus as fallback), keeping long option lists out of
the chat transcript.

`/access` is a thin alias layer over reported ACP modes/config. It does not
grant OS permissions by itself; it maps friendly names to the provider's own
permission modes. For example, Claude modes such as `auto`, `default`,
`acceptEdits`, `plan`, `dontAsk`, and `bypassPermissions` are selected through
the same ACP mode/config path. Codex modes are selected when the Codex ACP
adapter reports equivalent mode/config values.

The main project directory is always the session `cwd`. Command Center
`Workspace roots` or `/roots add <path>` persists extra roots as ACP
`additionalDirectories` for restore/load flows when the adapter supports them.

The chat input uses a pinned raw terminal composer when TTY support is
available. The chat transcript scrolls above a half-box composer: a single
top rule embeds the status (with an animated spinner while working), the
provider name, and any badges; the rule is tinted with the provider's accent
color and switches to yellow for permission/auth and red for error states.
The input sits flat below it, and then a metadata footer such as
`gpt-5.5 xhigh · 45k/200k (23%) $0.12 · auto · ~/.config`; when the ACP adapter
reports model, reasoning, access, permission, or mode values the footer uses
those values. When the input wraps beyond six rows, the footer adds
`↑ N more` / `↓ N more` counters. On popups shorter than 15 rows — or with
`VANZI_HUB_COMPOSER_BOX=0` — the composer falls back to the flat divider layout. When the adapter sends ACP `usage_update` events, the footer adds
a context-window segment (`used/size (percent)`) and the cumulative session cost
when reported. If
the current mode changes behavior materially, the divider also shows compact
badges such as `[PLAN]`, `[READ-ONLY]`, `[FULL-ACCESS]`, or `[ACCEPT-EDITS]`.
Chats with extra workspace roots show a `+N roots` footer segment. Pending
prompt files render as compact chips such as `[Image #1 screen.png]` and
`[File #1 notes.md]` above the input, while the footer shows attachment count
and total size. The composer has a subtle compact shaded input area, uses a provider-tinted
`❯` as the input marker, and shows
`Write a message · / commands · @ files` as the empty placeholder. It grows up
to six visual rows as the prompt grows, and supports multiline input with
`Ctrl+J`, `Alt/Option+J`, or `Alt/Option+Enter` for a newline while plain
`Enter` sends. While the agent is
responding or working, the composer divider shows an animated status spinner.
Sending a prompt while a turn is still active queues it instead of erroring: the
footer shows an `N queued` segment and the queued prompts are dispatched in order
as each turn finishes. Cancelling the active turn (`/cancel` or `Ctrl+C`) drops
any queued prompts.
Pasting one or more valid file paths attaches those files instead of inserting
the path text; image files render as `[Image #N ...]` chips and are shown as
`[IMAGE1]` entries in the submitted transcript. Press `Enter` on an empty
composer with pending attachments to send them; press Backspace on an empty
composer to remove the last pending attachment. Very large pasted text blocks
are stored as temporary text-file attachments under the hub cache so the input
stays usable; normal-sized multiline pastes remain editable in the composer.
The transcript scrolls above the composer and keeps the last 4000 lines in an
internal buffer: `PgUp`/`PgDn` scroll through that history without leaving the
input, the divider shows a `[SCROLL]` badge (with a `+N new` counter when output
arrives while scrolled), and `Esc` or submitting a prompt jumps back to the live
tail. Long lines are soft-wrapped to the popup width, so resizes and repaints
re-flow instead of truncating. `Ctrl+L` redraws the whole screen from the
buffer.
The editor supports left/right cursor movement, Home/End or `Ctrl+A`/`Ctrl+E`,
`Ctrl+U`, `Ctrl+K`, `Ctrl+W`, `Ctrl+Y`, `Alt+B`, `Alt+F`, Up/Down
history, and `Ctrl+R` reverse history search. Typing `/` or `@` opens an
autocomplete dropdown below the composer (it temporarily replaces the footer):
`Ctrl+N`/`Ctrl+P` (or `↑`/`↓`) travel the candidates, `Tab`, `Enter`, or `→`
accepts the highlighted one (`Enter` still submits when the typed command is
already exact), and `Esc` dismisses it until the input changes. On the flat
fallback layout, Tab keeps the classic unique-match completion. On an **empty**
composer, `Tab`/`Shift+Tab` cycle the adapter's session modes (e.g. Claude
`plan → default → acceptEdits`) — the hint shows the current mode and the footer
access label follows it; this is the quick equivalent of the `/modes` picker.
`←` on an empty composer backs out to the full menu **in the same pane** (the
agent-view "detach" gesture): pick a chat to focus its window (or create one),
or press `Esc` to return to the chat. Input history
is persisted locally for future popups. Drafts are persisted per chat while
editing and restored when the popup is reopened; a submitted prompt clears its
draft. Double `Esc` clears the current input and stores it in the local kill
ring for `Ctrl+Y`. `Ctrl+C` requests cancellation when the active chat is
responding, thinking, planning, working, or waiting for permission; otherwise
it clears non-empty input first and exits only when the input is already empty.
Long prompts wrap into visual rows inside the composer; Up/Down moves across
wrapped rows before falling back to history. Bracketed paste is enabled by default, so pasted code
blocks/logs are inserted as one operation and internal newlines do not submit the
prompt. Hints render for slash commands, multiline input, paste mode, or pending
attachments. Set `VANZI_HUB_PINNED_INPUT=0` to use the inline raw prompt,
`VANZI_HUB_RAW_INPUT=0` to fall back to Node readline, or
`VANZI_HUB_BRACKETED_PASTE=0` to disable bracketed paste.

## Runtime

The popup is only a client. A background daemon keeps ACP agent processes alive
through `~/.cache/tmux-vanzi-hub/hub.sock`, so closing the popup does not kill the
chat. The daemon also owns tmux window metadata (`@vanzi_hub_status` and friends):
it re-syncs the matching window on every chat change, so status glyphs in the
status bar and the `prefix+s` switcher stay fresh even when no popup is
attached — a chat left responding with the popup closed no longer shows a
frozen status. A permission request raised while the popup is closed stays pending instead
of being auto-cancelled: the chat status shows `permission` (visible in tmux
window badges and the `prefix+s` switcher), and reopening the popup re-surfaces
the request so you can still answer it. Unanswered requests cancel after a
five-minute timeout.

When an adapter reports `auth_required` (ACP error `-32000`) while creating a
session, the chat enters an `auth` state instead of failing: the adapter stays
running and the advertised authentication methods are listed in the chat. Use
`/auth <id>` or the Command Center `Authenticate` entry to run the ACP
`authenticate` method and retry session creation. Environment-variable methods
are not run through `authenticate`; the hub tells you which variables to set
before reopening the chat, since adapters read them at startup.

Session metadata is persisted in `~/.cache/tmux-vanzi-hub/registry.json`. Prompt
drafts and input history live in `drafts.json` and `input-history.json` in the
same cache directory; corrupt draft/history JSON is backed up as `.bad-*` and
recreated automatically.

Conceptually, visible tmux sessions remain your projects. Each project gets a
hidden ACP popup workspace, while the ACP daemon remains the global source of
truth for chat state and metadata.

Default adapters:

- `codex`: `npx -y @zed-industries/codex-acp@0.16.0`
- `claude`: `npx -y @agentclientprotocol/claude-agent-acp@0.46.0`

Override providers in:

```json
~/.config/tmux-vanzi-hub/agents.json
```

Use the same shape as `agents.json` in this plugin.

Provider defaults can include ACP config values. They are applied after
`session/new`, `session/load`, or `session/resume` only when the adapter reports
matching options:

```json
{
  "agents": {
    "claude": {
      "configDefaults": {
        "model": "sonnet",
        "effort": "high",
        "mode": "plan"
      }
    }
  }
}
```

The hub also remembers the last selected config per project/provider, so a new
chat inherits the model/effort you used most recently for that project.

### MCP servers

Attach MCP servers to agent sessions with a top-level `mcpServers` array (applied
to every agent) and/or a per-agent `mcpServers` array. They are passed to
`session/new`, `session/load`, and `session/resume`. `stdio` servers are
supported by every agent; `http` and `sse` servers are only sent when the agent
advertises the matching `mcpCapabilities`, and skipped ones are reported in the
chat. `env`/`headers` accept either an ACP `[{name,value}]` list or a plain
`{KEY: "value"}` object.

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": {}
    },
    {
      "name": "context7",
      "type": "http",
      "url": "https://mcp.example.com",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  ]
}
```

Use `/mcp` or the Command Center `MCP servers` entry to see what was sent for a
chat; the composer footer shows a `+N mcp` segment.

## Final Checks

- `prefix+m`: opens/minimizes the project ACP popup.
- `prefix+y`: opens Command Center; Model, Effort, Config, Modes, Access,
  Roots, New Chat, Rename, Cancel, and Close should use tmux UI rather than
  writing control text into the chat.
- `prefix+s`: outside ACP, shows normal tmux sessions; inside ACP, shows the
  tree-style ACP chat/window selector.
- `prefix+9` / `prefix+0`: open or focus Codex/Claude for the current project.
- `prefix+(` / `prefix+)`: create new Codex/Claude chats for the current
  project.
- `/debug`: temporarily prints hub internals and long fallback details into the
  chat pane.

If the daemon state looks stale after heavy changes:

```sh
node ~/.config/tmux/plugins/tmux-vanzi-hub/bin/vanzi-hub.mjs stop
```

Then reopen with `prefix+m` or a provider key.

## Tests

```sh
node ~/.config/tmux/plugins/tmux-vanzi-hub/tests/smoke.mjs
node ~/.config/tmux/plugins/tmux-vanzi-hub/tests/render-stream.mjs
node ~/.config/tmux/plugins/tmux-vanzi-hub/tests/render-width.mjs
node ~/.config/tmux/plugins/tmux-vanzi-hub/tests/render-live-table.mjs
node ~/.config/tmux/plugins/tmux-vanzi-hub/tests/picker.mjs
```

`smoke.mjs` drives the daemon protocol against a fake ACP agent; `render-stream.mjs`
feeds a Markdown table through the chat renderer in small chunks to guard against
streamed tables rendering raw. `render-width.mjs` covers the display-width and
ANSI wrapping primitives in `lib/render.mjs`; `render-live-table.mjs` guards the
progressive table pipeline used while the pinned composer is active.
