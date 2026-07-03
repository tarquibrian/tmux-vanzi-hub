#!/usr/bin/env node
// Unit tests for the boxed composer layout: geometry, degrade rule, overflow
// counters, and a paint smoke test for the box borders.
import assert from "node:assert/strict";

process.stdout.isTTY = true;
process.stdout.columns = 100;
process.stdout.rows = 30;

const { PopupUi } = await import("../bin/vanzi-hub.mjs");

const strip = (value) => String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function makeUi() {
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo/demo",
    currentChat: {
      id: "c1",
      provider: "codex",
      providerLabel: "Codex ACP",
      projectName: "demo",
      status: "idle",
      cwd: "/repo/demo",
    },
    rawInput: null,
    pendingAttachments: [],
    pendingPermission: null,
    scrollOffsetRows: 0,
    scrollNewRows: 0,
    composerSpinnerFrame: 0,
    activePicker: null,
    lastRawInputLayout: null,
    lastRawScrollBottom: null,
  });
  return ui;
}

const session = (line = "") => ({ pinned: true, line, cursor: line.length });

// --- Geometry: boxed layout on a normal-size popup -----------------------------
{
  const ui = makeUi();
  const layout = ui.rawInputLayout(session(""));
  assert.equal(layout.boxed, true, "boxed on 30 rows");
  // gap + top rule + 1 input row + bottom rule + footer = 5 composer rows
  assert.equal(layout.outputBottom, 30 - 5);
  assert.equal(layout.gapRow, 25, "blank gap row between transcript and box");
  assert.equal(layout.dividerRow, 26, "top rule row");
  assert.equal(layout.inputRow, 27);
  assert.equal(layout.boxBottomRow, 28, "bottom rule wraps the input");
  assert.equal(layout.footerRow, 29);
  assert.ok(layout.composerRows.includes(layout.boxBottomRow), "bottom rule cleared on layout change");
  assert.ok(layout.composerRows.includes(layout.gapRow), "gap row cleared on layout change");
  const flatWidth = ui.rawInputTextWidth(session(""), 100, false);
  assert.equal(layout.inputWidth, flatWidth, "flush band: same input width as flat");
}

// --- Degrade rule ---------------------------------------------------------------
{
  const ui = makeUi();
  process.stdout.rows = 12;
  const layout = ui.rawInputLayout(session(""));
  assert.equal(layout.boxed, false, "small popups fall back to the flat layout");
  assert.equal(layout.boxBottomRow, null);
  process.stdout.rows = 30;
}
{
  const ui = makeUi();
  process.env.VANZI_HUB_COMPOSER_BOX = "0";
  assert.equal(ui.rawInputLayout(session("")).boxed, false, "env kill-switch works");
  delete process.env.VANZI_HUB_COMPOSER_BOX;
}

// --- Multiline growth + overflow counters ---------------------------------------
{
  const ui = makeUi();
  const long = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const layout = ui.rawInputLayout(session(long));
  assert.equal(layout.inputRows, 6, "input grows to the 6-row cap");
  const view = ui.rawInputMultilineViewport(session(long), layout.inputWidth, layout.inputRows);
  assert.equal(view.hiddenAbove + view.hiddenBelow, 4, "10 lines - 6 visible = 4 hidden");
}

// --- Placeholder ---------------------------------------------------------------
{
  const ui = makeUi();
  const layout = ui.rawInputLayout(session(""));
  const view = ui.rawInputMultilineViewport(session(""), layout.inputWidth, layout.inputRows);
  assert.ok(view.rows[0].placeholder, "empty composer shows placeholder");
  assert.match(view.rows[0].text, /commands/, "placeholder mentions / commands");
  assert.match(view.rows[0].text, /@ files/, "placeholder mentions @ files");
}

// --- Paint smoke test ------------------------------------------------------------
{
  const ui = makeUi();
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    ui.renderPinnedRawInput(session("hello box"), ui.rawInputLayout(session("hello box")));
  } finally {
    process.stdout.write = original;
  }
  const plain = strip(out);
  assert.ok(/─ .*idle.*─/.test(plain), "top rule painted with embedded status");
  assert.ok(!plain.includes("╭") && !plain.includes("╰"), "no box corners");
  assert.ok(!plain.includes("│"), "no side borders");
  assert.ok((plain.match(/─{20,}/g) || []).length >= 1, "bottom rule painted");
  assert.ok(plain.includes("hello box"), "input text painted");
  assert.ok(out.includes("\x1b[38;5;43m"), "codex accent tints the rule");
}

// --- Attention state overrides the border color ----------------------------------
{
  const ui = makeUi();
  ui.currentChat.status = "permission";
  ui.pendingPermission = { permissionId: "p1", options: [] };
  assert.equal(ui.composerBorderSeq(), "\x1b[33m", "permission turns the border yellow");
  ui.currentChat.status = "error";
  ui.pendingPermission = null;
  assert.equal(ui.composerBorderSeq(), "\x1b[31m", "error turns the border red");
}

console.log("composer-layout test passed");
