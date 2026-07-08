#!/usr/bin/env node
// Unit tests for the zero-dep line diff engine (git-style unified hunks) that
// turns an ACP tool-call diff (full old/new file text) into colored rows.
import assert from "node:assert/strict";
import { computeLineDiff, toolContentDiffs } from "../lib/core.mjs";

// Identical text → nothing to show.
{
  const d = computeLineDiff("a\nb\nc\n", "a\nb\nc\n");
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.hunks.length, 0);
}

// A one-line modification: remove then add, wrapped in surrounding context, with
// original line numbers preserved.
{
  const d = computeLineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(d.added, 1, "one line added");
  assert.equal(d.removed, 1, "one line removed");
  const signs = d.hunks.flatMap((h) => h.rows.map((r) => r.sign)).join("");
  assert.equal(signs, " -+ ", "context, -old, +new, context");
  const minus = d.hunks[0].rows.find((r) => r.sign === "-");
  const plus = d.hunks[0].rows.find((r) => r.sign === "+");
  assert.equal(minus.text, "b");
  assert.equal(plus.text, "B");
  assert.equal(minus.oldNo, 2, "old line number");
  assert.equal(plus.newNo, 2, "new line number");
}

// New file: all additions.
{
  const d = computeLineDiff("", "x\ny\n");
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
  assert.deepEqual(d.hunks[0].rows.map((r) => r.sign), ["+", "+"]);
}

// Pure deletion.
{
  const d = computeLineDiff("x\ny\nz\n", "x\nz\n");
  assert.equal(d.added, 0);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks[0].rows.find((r) => r.sign === "-").text, "y");
}

// Two far-apart edits split into separate hunks, each carrying only nearby
// context (not the whole file).
{
  const oldText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const lines = oldText.split("\n");
  lines[1] = "CHANGED 1";
  lines[38] = "CHANGED 38";
  const d = computeLineDiff(oldText, lines.join("\n"));
  assert.equal(d.hunks.length, 2, "far-apart edits form two hunks");
  const total = d.hunks.reduce((n, h) => n + h.rows.length, 0);
  assert.ok(total < 24, "hunks carry only nearby context");
}

// A massive rewrite is capped by maxRows and flagged truncated.
{
  const oldText = Array.from({ length: 2000 }, (_, i) => `o${i}`).join("\n");
  const newText = Array.from({ length: 2000 }, (_, i) => `n${i}`).join("\n");
  const d = computeLineDiff(oldText, newText, { maxRows: 100 });
  const total = d.hunks.reduce((n, h) => n + h.rows.length, 0);
  assert.ok(total <= 100, "rows capped at maxRows");
  assert.equal(d.truncated, true, "truncation flagged");
}

// toolContentDiffs pulls only diff blocks out of ACP tool-call content.
{
  const diffs = toolContentDiffs([
    { type: "content", content: { type: "text", text: "noise" } },
    { type: "diff", path: "a.txt", oldText: "1\n2\n", newText: "1\n2\n3\n" },
    { type: "diff", path: "same.txt", oldText: "k\n", newText: "k\n" },
  ]);
  assert.equal(diffs.length, 1, "only the changed diff block is kept");
  assert.equal(diffs[0].path, "a.txt");
  assert.equal(diffs[0].added, 1);
  assert.equal(diffs[0].removed, 0);
}

console.log("diff test passed");
