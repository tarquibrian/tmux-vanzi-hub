#!/usr/bin/env node
// Unit tests for the interactive picker's pure logic: fzf-style filtering and
// header-skipping selection movement, plus the menu item builder.
import assert from "node:assert/strict";
import {
  PopupUi,
  pickerFilterEntries,
  pickerNextIndex,
  formatRelativeAge,
  formatChatPreview,
} from "../bin/vanzi-hub.mjs";

const strip = (value) => String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

const entries = [
  { label: "Project A", disabled: true },
  { label: "codex idle Fix auth flow", searchText: "codex myproj Fix auth flow idle" },
  { label: "claude responding Refactor", searchText: "claude myproj Refactor tables responding" },
  { label: "New chat", disabled: true },
  { label: "+ New Codex chat", searchText: "new codex Codex ACP" },
  { label: "+ New Claude chat", searchText: "new claude Claude ACP" },
];

// --- pickerFilterEntries ------------------------------------------------------
assert.equal(pickerFilterEntries(entries, ""), entries, "empty query keeps everything");
{
  const filtered = pickerFilterEntries(entries, "codex");
  assert.ok(filtered.every((entry) => !entry.disabled), "headers dropped while filtering");
  assert.equal(filtered.length, 2);
}
{
  const filtered = pickerFilterEntries(entries, "new claude");
  assert.equal(filtered.length, 1, "all words must match");
  assert.equal(strip(filtered[0].label), "+ New Claude chat");
}
{
  const filtered = pickerFilterEntries(entries, "REFACTOR");
  assert.equal(filtered.length, 1, "matching is case-insensitive");
}
{
  const noSearchText = [{ label: "\x1b[1mBold label\x1b[0m" }];
  assert.equal(
    pickerFilterEntries(noSearchText, "bold label").length,
    1,
    "falls back to the ANSI-stripped label",
  );
}
assert.equal(pickerFilterEntries(entries, "nomatch").length, 0);

// --- pickerNextIndex ----------------------------------------------------------
assert.equal(pickerNextIndex([], 0, 1), -1, "empty list has no selection");
assert.equal(
  pickerNextIndex([{ label: "x", disabled: true }], 0, 1),
  -1,
  "all-disabled list has no selection",
);
assert.equal(pickerNextIndex(entries, -1, 0), 1, "invalid index resolves to first selectable");
assert.equal(pickerNextIndex(entries, 0, 0), 1, "header index resolves to first selectable");
assert.equal(pickerNextIndex(entries, 1, 1), 2, "moves down");
assert.equal(pickerNextIndex(entries, 2, 1), 4, "skips headers going down");
assert.equal(pickerNextIndex(entries, 4, -1), 2, "skips headers going up");
assert.equal(pickerNextIndex(entries, 1, -1), 1, "clamps at the top");
assert.equal(pickerNextIndex(entries, 5, 1), 5, "clamps at the bottom");
assert.equal(pickerNextIndex(entries, 1, 10), 5, "large jumps clamp at the last selectable");

// --- buildMenuPickerItems -----------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  ui.config = { defaultAgent: "codex" };
  ui.cwd = "/repo/current";
  ui.menuFilters = { provider: "all", scope: "all", query: "", limit: 80 };

  const menu = {
    agents: [
      { id: "codex", label: "Codex ACP" },
      { id: "claude", label: "Claude ACP" },
    ],
    visibleChats: [
      {
        id: "c1",
        provider: "codex",
        projectName: "current",
        title: "Fix auth",
        status: "idle",
        active: true,
        cwd: "/repo/current",
      },
      {
        id: "c2",
        provider: "claude",
        projectName: "other",
        title: "Refactor",
        status: "responding",
        active: true,
        cwd: "/repo/other",
      },
    ],
  };

  const items = ui.buildMenuPickerItems(menu);
  const labels = items.map((item) => strip(item.label));

  assert.ok(labels.some((label) => label.includes("current project")), "local project header");
  assert.ok(labels.some((label) => label.includes("New Codex ACP chat")), "new-chat entries");
  assert.ok(
    labels.some((label) => label.includes("New Codex ACP chat") && label.includes("default")),
    "default agent marked",
  );
  assert.ok(labels.some((label) => label === "other"), "remote project grouped by name");

  const chatItem = items.find((item) => item.value?.type === "chat" && item.value.chatId === "c1");
  assert.ok(chatItem, "chat entry present");
  assert.match(chatItem.searchText, /codex/, "search text includes provider");
  assert.match(chatItem.searchText, /Fix auth/, "search text includes title");

  const newItem = items.find((item) => item.value?.type === "new" && item.value.provider === "claude");
  assert.ok(newItem, "new-chat entry carries provider value");
}

// --- formatRelativeAge ----------------------------------------------------------
{
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(formatRelativeAge(ago(10 * 1000)), "now");
  assert.equal(formatRelativeAge(ago(37 * 60 * 1000)), "37m");
  assert.equal(formatRelativeAge(ago(8 * 3600 * 1000)), "8h");
  assert.equal(formatRelativeAge(ago(2 * 86400 * 1000)), "2d");
  assert.equal(formatRelativeAge(ago(21 * 86400 * 1000)), "3w");
  assert.equal(formatRelativeAge(ago(90 * 86400 * 1000)), "3mo");
  assert.equal(formatRelativeAge(ago(800 * 86400 * 1000)), "2y");
  assert.equal(formatRelativeAge(""), "", "missing timestamp renders nothing");
  assert.equal(formatRelativeAge("garbage"), "");
}

// --- formatChatPreview ----------------------------------------------------------
{
  const strip = (value) => value.replace(/\[[0-9;]*m/g, "");
  const events = [
    { type: "user", text: "hola" },
    { type: "agent_chunk", text: "Hola. ¿En qué " },
    { type: "agent_chunk", text: "te ayudo?" },
    { type: "thought_chunk", text: "reasoning noise" },
    { type: "tool_call", title: "Read file", kind: "read" },
    { type: "tool_update", title: "Read file", status: "completed" },
    { type: "system", level: "info", text: "Commands available: 12" },
    { type: "plan", entries: [{}, {}, {}] },
    { type: "error", text: "boom" },
  ];

  const lines = formatChatPreview(events, 40, 20).map(strip);
  assert.ok(lines.some((line) => line.includes("❯ hola")), "user line present");
  assert.ok(
    lines.some((line) => line.includes("Hola. ¿En qué te ayudo?")),
    "agent chunks coalesce into one paragraph",
  );
  assert.ok(lines.some((line) => line.includes("⚙ Read file")), "tool call shown");
  assert.ok(lines.some((line) => line.includes("▸ plan · 3 steps")), "plan shown");
  assert.ok(lines.some((line) => line.includes("✗ boom")), "error shown");
  assert.ok(!lines.some((line) => line.includes("reasoning")), "thoughts skipped");
  assert.ok(!lines.some((line) => line.includes("Commands available")), "system noise skipped");

  // Tail cap: only the last maxLines survive, most recent content wins.
  const many = [];
  for (let i = 0; i < 60; i += 1) many.push({ type: "user", text: `msg ${i}` });
  const tail = formatChatPreview(many, 40, 5).map(strip);
  assert.ok(tail.length >= 4 && tail.length <= 5, "tail capped at maxLines");
  assert.ok(tail.some((line) => line.includes("msg 59")), "most recent message kept");

  // Long text wraps to width.
  const wrapped = formatChatPreview(
    [{ type: "agent_chunk", text: "palabra ".repeat(30) }],
    20,
    30,
  ).map(strip);
  assert.ok(wrapped.length > 3, "long paragraph wraps into multiple lines");
  assert.ok(wrapped.every((line) => line.length <= 20), "wrapped lines respect width");

  assert.deepEqual(formatChatPreview(null, 40, 10), []);
  assert.deepEqual(formatChatPreview([], 4, 10), []);

  // Markdown renderer: agent paragraphs go through it; box-drawing rows
  // (tables) are clipped to the pane width instead of soft-wrapped.
  const render = (text) =>
    text
      .split("\n")
      .map((line) => (line.startsWith("|") ? `│ ${line.replace(/\|/g, "").trim()} │ ${"x".repeat(40)}` : line))
      .join("\n");
  const rendered = formatChatPreview(
    [{ type: "agent_chunk", text: "| head |\n| data |\nplain paragraph that is long enough to wrap around" }],
    24,
    20,
    render,
  ).map(strip);
  const tableRows = rendered.filter((line) => line.includes("│"));
  assert.equal(tableRows.length, 2, "table rows stay one line each");
  assert.ok(tableRows.every((line) => line.length <= 24), "table rows clipped to width");
  assert.ok(
    rendered.filter((line) => line.includes("wrap") || line.includes("plain")).length >= 2,
    "plain paragraphs still wrap",
  );
}

// --- showPermissionPicker ---------------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const calls = [];
  Object.assign(ui, {
    currentChat: { id: "c1" },
    pendingPermission: {
      permissionId: "perm-1",
      toolCall: { title: "Ready to code?" },
      options: [
        { optionId: "opt-allow", name: "Yes, auto-accept edits", kind: "allow_always" },
        { optionId: "opt-manual", name: "Yes, manually approve", kind: "allow_once" },
        { optionId: "opt-no", name: "No, keep planning", kind: "reject_once" },
      ],
    },
    pickerSupported: () => true,
    canPaintPinned: () => true,
    hub: { call: async (method, params) => { calls.push({ method, params }); } },
    quickSelect: async (config) => {
      // The menu was handed exactly the pending options, first preselected.
      assert.equal(config.items.length, 3, "one item per option");
      assert.equal(config.items[0].value, "opt-allow");
      assert.ok(config.items[0].current, "first option preselected");
      assert.ok(config.title.includes("Ready to code?"), "tool title in the menu title");
      return "opt-manual";
    },
  });

  const handled = await ui.showPermissionPicker();
  assert.equal(handled, true, "picker handled the pending permission");
  assert.equal(calls.length, 1, "one response sent");
  assert.deepEqual(calls[0], {
    method: "permission_response",
    params: { permissionId: "perm-1", optionId: "opt-manual" },
  });
  assert.equal(ui.pendingPermission, null, "pending cleared after responding");
}
{
  // Esc keeps the request pending so /allow <n> still works.
  const ui = Object.create(PopupUi.prototype);
  const pending = { permissionId: "perm-2", options: [{ optionId: "o", name: "ok" }], toolCall: null };
  let sent = false;
  Object.assign(ui, {
    pendingPermission: pending,
    pickerSupported: () => true,
    canPaintPinned: () => true,
    hub: { call: async () => { sent = true; } },
    quickSelect: async () => null,
  });
  assert.equal(await ui.showPermissionPicker(), true, "handled even on cancel");
  assert.equal(sent, false, "no response sent on Esc");
  assert.equal(ui.pendingPermission, pending, "request still pending");
}
{
  // No pending permission → not handled, falls through to normal Enter.
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, { pendingPermission: null, pickerSupported: () => true, canPaintPinned: () => true });
  assert.equal(await ui.showPermissionPicker(), false, "nothing to pick");
}

// --- cycleMode (Tab / Shift+Tab) ------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const applied = [];
  Object.assign(ui, {
    currentChat: {
      mode: "plan",
      modes: { availableModes: [{ id: "plan" }, { id: "default" }, { id: "acceptEdits" }] },
    },
    notify: () => {},
    applyMode: async (id) => {
      applied.push(id);
      ui.currentChat = { ...ui.currentChat, mode: id };
    },
  });

  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "default", "Tab moves to the next mode");
  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "acceptEdits");
  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "plan", "Tab wraps past the end");
  await ui.cycleMode(-1);
  assert.equal(applied.at(-1), "acceptEdits", "Shift+Tab wraps backwards");
}
{
  // Match the current mode by any alias, not just id.
  const ui = Object.create(PopupUi.prototype);
  const applied = [];
  Object.assign(ui, {
    currentChat: {
      mode: "Plan Mode",
      modes: { availableModes: [{ id: "plan", label: "Plan Mode" }, { id: "build", label: "Build" }] },
    },
    notify: () => {},
    applyMode: async (id) => applied.push(id),
  });
  await ui.cycleMode(1);
  assert.equal(applied.at(-1), "build", "current matched by label alias, advances to build");
}
{
  // A single mode (or none) never cycles.
  const ui = Object.create(PopupUi.prototype);
  let applied = false;
  Object.assign(ui, {
    currentChat: { mode: "default", modes: { availableModes: [{ id: "default" }] } },
    notify: () => {},
    applyMode: async () => {
      applied = true;
    },
  });
  await ui.cycleMode(1);
  assert.equal(applied, false, "single mode does not cycle");
}

// --- replyToChatFromPicker -------------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const calls = [];
  Object.assign(ui, {
    notify: (m) => calls.push({ notify: m }),
    hub: { call: async (method, params) => { calls.push({ method, params }); } },
  });

  await ui.replyToChatFromPicker({ value: { chatId: "codex-1" } }, "hello there");
  assert.deepEqual(
    calls[0],
    { method: "send_prompt", params: { chatId: "codex-1", text: "hello there" } },
    "reply sends the prompt to the chat",
  );
}
{
  // No chatId → nothing sent.
  const ui = Object.create(PopupUi.prototype);
  let sent = false;
  Object.assign(ui, { notify: () => {}, hub: { call: async () => { sent = true; } } });
  await ui.replyToChatFromPicker({ value: {} }, "x");
  assert.equal(sent, false, "missing chatId sends nothing");
}
{
  // A send failure surfaces via notify instead of throwing.
  const ui = Object.create(PopupUi.prototype);
  let notified = "";
  Object.assign(ui, {
    notify: (m) => { notified = m; },
    hub: { call: async () => { throw new Error("adapter down"); } },
  });
  await ui.replyToChatFromPicker({ value: { chatId: "c" } }, "hi");
  assert.match(notified, /reply failed.*adapter down/, "failure is reported, not thrown");
}
{
  // canReply gates on chat.active in the chats picker items.
  const ui = Object.create(PopupUi.prototype);
  Object.assign(ui, {
    cwd: "/repo",
    currentChat: { id: "other" },
    hub: { call: async () => ({ chats: [
      { id: "live", provider: "codex", projectName: "repo", cwd: "/repo", active: true, status: "idle" },
      { id: "saved", provider: "codex", projectName: "repo", cwd: "/repo", active: false },
    ] }) },
    orderChatsForDisplay: (chats) => chats,
  });
  const items = await ui.buildChatsPickerItems();
  const rows = items.filter((i) => !i.disabled);
  assert.equal(rows.find((r) => r.value.chatId === "live").canReply, true, "live chat can be replied to");
  assert.equal(rows.find((r) => r.value.chatId === "saved").canReply, false, "saved chat cannot");
}

// --- showMenuOverlay routing -----------------------------------------------------
{
  const ui = Object.create(PopupUi.prototype);
  const switches = [];
  Object.assign(ui, {
    cwd: "/repo",
    currentChat: { id: "chat-here" },
    pickerSupported: () => true,
    canPaintPinned: () => true,
    switchToChatWindow: (arg) => switches.push(arg),
  });

  ui.runMenuPicker = async () => ({ type: "chat", chatId: "chat-3", cwd: "/repo", provider: "codex" });
  await ui.showMenuOverlay();
  assert.deepEqual(
    switches.at(-1),
    { type: "chat", chatId: "chat-3", cwd: "/repo", provider: "codex" },
    "picking another chat focuses/creates its window",
  );

  switches.length = 0;
  ui.runMenuPicker = async () => ({ type: "chat", chatId: "chat-here" });
  await ui.showMenuOverlay();
  assert.equal(switches.length, 0, "picking the current chat switches nothing");

  ui.runMenuPicker = async () => ({ type: "new", provider: "claude" });
  await ui.showMenuOverlay();
  assert.deepEqual(switches.at(-1), { cwd: "/repo", provider: "claude", action: "new" }, "new chat");

  ui.runMenuPicker = async () => ({ type: "provider", provider: "codex" });
  await ui.showMenuOverlay();
  assert.deepEqual(switches.at(-1), { cwd: "/repo", provider: "codex", action: "open" }, "open provider");

  switches.length = 0;
  ui.runMenuPicker = async () => null;
  assert.equal(await ui.showMenuOverlay(), true, "Esc is still handled");
  assert.equal(switches.length, 0, "Esc switches nothing");
}

console.log("picker test passed");
