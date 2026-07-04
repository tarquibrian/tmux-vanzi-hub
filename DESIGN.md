# tmux-vanzi-hub · Visual Design System

Decisions locked 2026-07-02 (composer restyled to half-box 2026-07-03): **hybrid layout** (half-box composer, flat transcript)
with **provider-tinted accents** overridden by semantic state colors.

## Principles

1. **Hybrid density** — the composer (persistent, focal) gets a rounded box;
   transcript content stays flat and dense, structured by spacing, indentation,
   and color instead of borders.
2. **Provider tint, semantic override** — the active provider's color tints
   structure (composer border, input marker, user-turn rail). Attention states
   always win: permission/auth = yellow, error = red, regardless of provider.
3. **One vocabulary** — every glyph, color, and spacing rule comes from the
   tokens below. No raw color codes or ad-hoc glyphs at call sites.
4. **Degrade gracefully** — every styled surface has a plain fallback: small
   popups drop the box, non-TTY drops color, `VANZI_HUB_INTERACTIVE_UI=0` keeps
   the legacy flows.

## Audit — current inconsistencies this system replaces

- Colors scattered as raw codes across three languages: `colour170/43/39`
  (provider) duplicated in `lib.sh`, `switcher.sh`, and JS `providerColorName`;
  `colour236/244/245` shading inline in JS; named ANSI (`cyan`, `yellow`)
  elsewhere. No single palette.
- Glyph grammar mixed: plan uses ASCII `x`/`>`/`-` while status uses `●◐◌⏸⊘✗○`;
  activity tree uses `└` but plan doesn't; menu bullets `•` vs `-` vs `+`.
- Divider zoo: `─` (hr, activity), `━` (table header), plain `--`; widths
  computed three different ways.
- Composer is a flat shaded band: divider-as-title above, unpadded footer
  below, `^`/`v` overflow markers, placeholder "message".
- Slash-command and `@file` completion render as a plain dim hint line; Tab
  completes only unique matches — no visible selection model.
- Permission request renders as plain `[permission]` yellow text, visually
  weaker than an ordinary activity group despite being the one thing that
  blocks the agent.
- Label grammar differs per surface: switcher `glyph status Provider title`,
  toggle menu `project · provider status · title`, chats picker mixes both.

## Tokens

### Palette (256-color, tmux-safe)

| Token            | Value            | Use |
|------------------|------------------|-----|
| `provider.claude`| `colour173`      | Claude accents (characteristic orange) |
| `provider.codex` | `colour39`       | Codex accents (characteristic blue) |
| `provider.other` | `colour39`       | any other adapter |
| `sem.ok`         | ANSI green       | idle, success, done markers |
| `sem.busy`       | ANSI cyan        | responding/thinking/working, spinner |
| `sem.warn`       | ANSI yellow      | permission, auth, queued, cancelling |
| `sem.err`        | ANSI red         | error, denied |
| `fg.muted`       | `colour244`      | meta text, hints, separators |
| `fg.faint`       | `colour238`      | dividers, disabled |
| `bg.surface`     | `colour236`      | composer input band |
| `fg.placeholder` | `colour245`      | placeholder on `bg.surface` |

Rule: provider color on **structure** (border, marker, rail) only while the
chat is in a neutral state (idle/responding/etc. keep provider border; the
title's status word carries the semantic color). Permission/auth/error switch
the **whole border** to the semantic color.

### Glyphs

| Group      | Set |
|------------|-----|
| status     | `●` idle · `◐` busy (static) · spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (animated) · `◌` starting · `⏸` permission · `⊘` auth · `✗` error · `⚠` warning · `○` stopped · `·` saved |
| provider   | `❋` Claude · `⬡` Codex · `◆` other — accent-colored, overridable per agent via `icon` in agents.json. Chat labels read icon → title → info everywhere; the tmux status bar shows the status glyph only when the chat needs attention |
| plan       | `✓` done · `▸` in progress · `·` pending · `⊘` skipped |
| markers    | `❯` input/selection/user-echo · `│` echo continuation · `●` current value (pickers) · `•` bullet · `└` `├` tree |
| borders    | `╭ ─ ╮ │ ╰ ╯` composer box · `─` section divider · `━` table header rule |
| overflow   | `↑ N more` / `↓ N more` (replaces `^`/`v`) |

### Spacing

- 1 blank line between conversation turns (existing `pendingResponseBreak`).
- Transcript text: 1-space left gutter; tree items indent 2, summaries 6 dim.
- Composer meta/hints: 2-space left pad.
- Dividers span `min(width, 96)`.

## Component specs

### Composer (half-box, 2026-07-03)

```
─ ⠹ responding · Codex ── [PLAN] ──────────────────────────
  ❯ how do I make the table wider▏
    second wrapped line…
  gpt-5.5 xhigh · 45k/200k 23% · 2 queued · +1 mcp · ~/.config
  / commands · @ files · Ctrl+J newline
```

A single accent-tinted top rule carries the status/provider/badges; the input
and meta lines are flat below it (no side or bottom borders — one row cheaper
and closer to the flat transcript).

- Border: provider color; permission/auth → `sem.warn`, error → `sem.err`.
- Top border embeds: status glyph+word (semantic color, spinner animates),
  provider label, badges (`[PLAN]`, `[PASTE]`, `[SEARCH]`, scroll).
- Interior keeps `bg.surface` band; placeholder:
  `Escribe un mensaje · / comandos · @ archivos` in `fg.placeholder`.
- Input grows 1→6 rows inside the box; overflow rows show `↑2 more`/`↓1 more`
  right-aligned dim inside the border.
- Footer below the box (not inside): existing segments, `·` separated;
  context meter keeps green/yellow/red by usage; queue in `sem.warn`.
- Attachment chips render above the box, unchanged style.
- Height budget: box adds 2 rows vs the divider layout. If terminal rows
  < 15, drop to the current flat divider layout automatically.
- Scroll badge in top border: `[↑ 12 new · PgDn]`.

### Autocomplete dropdown (slash + `@file`)

```
│ ❯ /mo▏                                                   │
╰──────────────────────────────────────────────────────────╯
  ❯ /model    set model config option
    /modes    show provider modes
    /mode     set provider mode
```

- Appears below the box (replaces footer+hint rows while active, max 5 rows).
- `↑`/`↓`/`Tab` cycle, `Enter`/`→` accept, `Esc` dismiss, typing refines.
- Same row grammar as pickers: `❯` selection, name + dim hint column.
- `@` mentions: same dropdown listing matched project files.

### Transcript blocks (flat)

- **User turn**: provider-tinted `❯` rail, bold text, `│` continuation rail.
- **Activity group**: `● Explored` (bold) + `└` items; dim summaries; closing
  divider `─`. Group glyph inherits `sem.busy` while running, `sem.ok` done.
- **Plan**: `Plan (2/4)` bold + token markers (`✓ ▸ · ⊘`), replacing `x > -`.
- **Permission (blocking — strongest flat block)**:
  ```
  ▎ ⏸ Permission · Write file src/app.ts
  ▎ 1 Allow once   2 Allow always   3 Deny
  ▎ /allow <n> · /deny
  ```
  `▎` left rail + all text in `sem.warn`; re-printed when popup reopens.
- **Chat header** (`printChatTitle`): `● Codex · myproject · Refactor auth`
  one line, provider-colored glyph, dim path on second line only in debug.
- **Errors**: `✗ message` in `sem.err` (drop the `[error]` bracket tag).
- **Code blocks**: fenced content renders as a full-width shaded band
  (`colour235`, one shade darker than the composer) with the language as a dim
  header row inside the band; soft-wrapped continuations keep the background.
  Non-TTY output stays plain.

### Pickers (already close to spec)

- Title row: bold title + dim counter. Query row: `❯` + query.
- Rows: `❯` selection (cyan), `●` current (green), headers bold flat.
- Bottom hint row dim. No boxes — pickers are transient, flat is right.
- Normalize label grammar everywhere: `<glyph+status>  <Provider>  <title>  <meta>`
  for chats; `<value> · <label>` for options.

### tmux surfaces

- Window status / switcher / toggle-menu labels adopt the same grammar:
  `<glyph> <Provider> <title>` with provider color from the token table
  (single source: JS emits the format strings; shell consumes cached values —
  full dedup deferred to R4).
- Native display-menus keep tmux styling (quick actions only).

## Phases

| Phase | Scope | Size |
|-------|-------|------|
| **V1** | Composer box + placeholder + overflow + footer polish + scroll badge + degrade rule | core, ~1 día |
| **V2** | Autocomplete dropdown (slash + `@file`) with selection cycling | medium |
| **V3** | Transcript blocks: user rail, plan/permission/error/activity/header restyle | medium |
| **V4** | Label grammar normalization (pickers + tmux surfaces) + token extraction into one module | small |
| **V5** | Optional theming: `@vanzi_hub_color_*` tmux options override tokens | small, later |

Implementation anchors: composer = `rawInputLayout` / `renderPinnedRawInput` /
`inputHint`; dropdown = new state in `handleRawKeypress` + paint in
`renderPinnedRawInput`; transcript blocks = `renderUserTurn`, `renderPlan`,
`renderPermission`, `renderActivityEvent`, `printChatTitle`, `renderEvent`;
tokens land in `lib/render.mjs` or a new `lib/theme.mjs`.
