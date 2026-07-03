#!/usr/bin/env node
// Unit tests for the composer autocomplete dropdown: derivation, cycling,
// accept/submit rules, Esc suppression, and layout integration.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;

const { PopupUi } = await import("../bin/vanzi-hub.mjs");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo/demo",
    currentChat: { id: "c1", provider: "codex", status: "idle", cwd: "/repo/demo" },
    rawInput: null,
    pendingAttachments: [],
    pendingPermission: null,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    composerSpinnerFrame: 0,
    activePicker: null,
    lastRawInputLayout: null,
    lastRawScrollBottom: null,
    inputHistory: [],
    renderRawInput: () => {},
    saveRawDraft: () => {},
  });
  return ui;
}

const session = (line, cursor = line.length) => ({
  pinned: true,
  line,
  cursor,
  autocompleteIndex: 0,
  autocompleteKey: "",
  autocompleteSuppressedKey: "",
});

// --- Derivation -----------------------------------------------------------------
{
  const ui = makeUi();
  const dropdown = ui.activeAutocomplete(session("/mo"));
  assert.ok(dropdown, "slash prefix opens the dropdown");
  assert.equal(dropdown.kind, "command");
  assert.ok(dropdown.matches.length >= 2, "matches /model /modes /mode");
  assert.ok(dropdown.matches.every((m) => m.name.startsWith("/mo")));
}
{
  const ui = makeUi();
  assert.equal(ui.activeAutocomplete(session("//raw")), null, "// bypasses the dropdown");
  assert.equal(ui.activeAutocomplete(session("")), null, "empty line has no dropdown");
  assert.equal(ui.activeAutocomplete(session("/model x")), null, "hidden after the command word");
  assert.equal(ui.activeAutocomplete(session("plain text")), null);
}
{
  const ui = makeUi();
  const dropdown = ui.activeAutocomplete(session("/mode"));
  assert.ok(dropdown, "prefix of longer commands still shows the dropdown");
  assert.equal(dropdown.matches[0].name, "/mode", "exact match sorts first");
}
{
  const ui = makeUi();
  ui.fileMentionMatches = () => ["src/app.ts", "src/api.ts"];
  const dropdown = ui.activeAutocomplete(session("see @ap"));
  assert.ok(dropdown, "@query opens the mention dropdown");
  assert.equal(dropdown.kind, "mention");
  assert.equal(dropdown.matches[0].name, "@src/app.ts");
}

// --- Cycling + accept ------------------------------------------------------------
{
  const ui = makeUi();
  const s = session("/mo");
  const first = ui.activeAutocomplete(s);
  const count = first.matches.length;

  assert.ok(ui.handleAutocompleteKey(s, "", { name: "down" }), "down cycles");
  assert.equal(ui.activeAutocomplete(s).index, 1 % count);
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "up" }), "up cycles back");
  assert.equal(ui.activeAutocomplete(s).index, 0);
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "n", ctrl: true }), "ctrl+n cycles down");
  assert.equal(ui.activeAutocomplete(s).index, 1 % count);
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "p", ctrl: true }), "ctrl+p cycles up");
  assert.equal(ui.activeAutocomplete(s).index, 0);

  assert.ok(ui.handleAutocompleteKey(s, "", { name: "return" }), "enter accepts a completion");
  assert.match(s.line, /^\/\w+ $/, "line replaced with command + trailing space");
  assert.equal(s.cursor, s.line.length);
}
{
  const ui = makeUi();
  const s = session("/mode");
  assert.equal(
    ui.handleAutocompleteKey(s, "", { name: "return" }),
    false,
    "enter on an exactly-typed command falls through to submit",
  );
  assert.equal(s.line, "/mode", "line untouched");
}
{
  const ui = makeUi();
  ui.fileMentionMatches = () => ["src/app.ts"];
  const s = session("see @ap");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "return" }), "enter accepts the mention");
  assert.equal(s.line, "see @src/app.ts");
}
{
  const ui = makeUi();
  const s = session("/he");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "right" }), "right at EOL accepts");
  assert.match(s.line, /^\/help /);
}
{
  const ui = makeUi();
  const s = session("/mo");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "tab" }), "tab completes the selection");
  assert.match(s.line, /^\/\w+ $/, "tab replaced the line with the completion");
  assert.equal(s.cursor, s.line.length);
}

// --- Esc suppression --------------------------------------------------------------
{
  const ui = makeUi();
  const s = session("/mo");
  assert.ok(ui.handleAutocompleteKey(s, "", { name: "escape" }), "esc dismisses");
  assert.equal(ui.activeAutocomplete(s), null, "suppressed for the same input");
  s.line = "/mod";
  assert.ok(ui.activeAutocomplete(s), "typing re-opens the dropdown");
}

// --- Layout integration ------------------------------------------------------------
{
  const ui = makeUi();
  const s = session("/mo");
  const layout = ui.rawInputLayout(s);
  assert.ok(layout.dropdownRows >= 2, "dropdown rows reserved");
  assert.equal(layout.footerRow, null, "footer replaced while the dropdown is open");
  assert.equal(layout.hintRows, 0, "hint replaced while the dropdown is open");
  assert.ok(layout.composerRows.includes(layout.dropdownRow), "dropdown rows cleared on change");

  const plain = ui.rawInputLayout(session("hello"));
  assert.equal(plain.dropdownRows, 0);
  assert.ok(plain.footerRow !== null, "footer returns without the dropdown");
}

console.log("autocomplete test passed");
