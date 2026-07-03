#!/usr/bin/env node
// tmux-vanzi-hub CLI: subcommands, tmux menus/panels, and the entry point.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import * as readlineTerminal from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
// (no imports needed from ../lib/render.mjs)
import {
  providerIconFor,
  formatChatPreview,
  formatRelativeAge,
  highlightCode,
  c,
  parseArgs,
  mkdirp,
  readJsonIfExists,
  loadConfig,
  resolveProjectRoot,
  projectName,
  pickerFilterEntries,
  pickerNextIndex,
  cleanInline,
  stripAnsi,
  hasPendingMarkdownTable,
  renderMarkdownTable,
  truncateText,
  displayPath,
  normalizeAdditionalDirectories,
  configOptionId,
  resolveConfigOption,
  chatConfigLabel,
  configOptionMenuValues,
  configOptionValueMatches,
  modeEntries,
  resolveAccessTarget,
  valueLabel,
  compactTmuxText,
  formatConfigOption,
  formatProviderCommand,
  formatContextUsage,
  mcpServerLabel,
  orderProjectChats,
  displayTmuxMenu,
  tmuxDisplayMessage,
  tmuxPaneFormat,
  syncTmuxChatMetadata,
  isAcpPane,
  tmuxSubmitToPane,
  tmuxPromptSubmitToPane,
  submitCommandToTmuxPane,
  tmuxInsertToPane,
  tmuxConfirmCommand,
  tmuxPanelCommand,
  actionPayload,
  parseActionPayload,
  tmuxActionCommand,
  tmuxPromptActionCommand,
  tmuxConfirmActionCommand,
  tmuxRunWorkspace,
  HUB_DIR,
  SOCKET_PATH,
  LOG_PATH,
  STATE_PATH,
  REGISTRY_PATH,
} from "../lib/core.mjs";
import {
  canConnectToSocket,
  connectHub,
} from "../lib/rpc.mjs";
import { HubDaemon } from "../lib/daemon.mjs";
import {
  PopupUi,
} from "../lib/ui.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

// Keep the daemon log bounded: past 1MB the old log rolls to daemon.log.1
// (one generation is enough to debug "what happened before the restart").
function rotateDaemonLog() {
  try {
    const { size } = fs.statSync(LOG_PATH);
    if (size > 1024 * 1024) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch {
    // No log yet.
  }
}

async function ensureDaemon() {
  await mkdirp(HUB_DIR);

  try {
    return await connectHub(300);
  } catch {
    // Start below.
  }

  rotateDaemonLog();
  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 5000) {
    try {
      return await connectHub(300);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  throw new Error(
    `Could not start Vanzi hub daemon: ${lastError?.message || "unknown error"}. Log: ${LOG_PATH}`,
  );
}

async function runDaemon() {
  const config = await loadConfig();
  const daemon = new HubDaemon(config);
  await daemon.start();

  process.on("SIGINT", () => daemon.shutdown());
  process.on("SIGTERM", () => daemon.shutdown());

  await new Promise(() => {});
}

async function runUi(args) {
  const config = await loadConfig();
  if (args["default-agent"]) {
    config.defaultAgent = args["default-agent"];
  }
  const hub = await ensureDaemon();
  const cwd = path.resolve(args.cwd || process.cwd());
  const ui = new PopupUi(hub, config, cwd, args.mode || "menu", {
    agent: typeof args.agent === "string" ? args.agent : null,
    chatId: typeof args["chat-id"] === "string" ? args["chat-id"] : null,
    newChat: args.new === true,
  });
  await ui.run();
}

async function runTmuxMenu(args) {
  const config = await loadConfig();
  if (args["default-agent"]) {
    config.defaultAgent = args["default-agent"];
  }

  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;
  const hub = await ensureDaemon();
  const agents = (await hub.call("list_agents")).agents;
  const allChats = (await hub.call("list_chats", { cwd })).chats;
  const chats = allChats.slice(0, 20);
  hub.close();
  const acpPane = isAcpPane(context);
  const currentChatId = acpPane ? tmuxPaneFormat(context.pane, "#{@vanzi_hub_chat_id}") : "";
  const items = [];

  const add = (label, key, command) => {
    items.push({ label, key, command });
  };
  const sep = () => {
    items.push({ separator: true });
  };

  if (acpPane) {
    add("Command center", "?", tmuxPanelCommand(cwd, context, "control", currentChatId));
    add("Chats", "s", tmuxSubmitToPane(context.pane, "/chats"));
    add("Config", "g", tmuxPanelCommand(cwd, context, "config", currentChatId));
    add("Model", "l", tmuxPanelCommand(cwd, context, "model", currentChatId));
    add("Effort / reasoning", "f", tmuxPanelCommand(cwd, context, "effort", currentChatId));
    add("Access / permissions", "a", tmuxPanelCommand(cwd, context, "access", currentChatId));
    add("Workspace roots", "w", tmuxPanelCommand(cwd, context, "roots", currentChatId));
    add("Provider commands", "c", tmuxPanelCommand(cwd, context, "commands", currentChatId));
    add("Modes", "o", tmuxPanelCommand(cwd, context, "modes", currentChatId));
    add("Plan", "P", tmuxPanelCommand(cwd, context, "plan", currentChatId));
    add("New chat", "n", tmuxPanelCommand(cwd, context, "new", currentChatId));
    add("Activity display", "v", tmuxPanelCommand(cwd, context, "activity", currentChatId));
    sep();
  }

  add("Open default chat", "m", tmuxRunWorkspace(cwd, context, config.defaultAgent || "codex"));
  add("Full popup menu", "M", tmuxRunWorkspace(cwd, context, "", "", "menu"));
  sep();

  for (const [index, agent] of agents.entries()) {
    const key = index < 9 ? String(index + 1) : "";
    add(`Open ${agent.label || agent.id}`, key, tmuxRunWorkspace(cwd, context, agent.id));
  }

  sep();
  for (const agent of agents) {
    add(`New ${agent.label || agent.id}`, "", tmuxRunWorkspace(cwd, context, agent.id, "", "new"));
  }

  if (chats.length) {
    sep();
    for (const chat of orderProjectChats(chats)) {
      const status = chat.active ? ` · ${chat.status}` : "";
      const title = truncateText(chat.title || chat.id, 42);
      const age = formatRelativeAge(chat.updatedAt);
      add(
        `${providerIconFor(chat.provider, chat)} ${title}${status}${age ? ` · ${age}` : ""}`,
        "",
        tmuxRunWorkspace(cwd, context, chat.provider, chat.id),
      );
    }
  }

  const result = displayTmuxMenu(`Vanzi Hub: ${projectName(cwd)}`, items, context);
  if (!result.ok) {
    console.error(result.error || "tmux display-menu failed");
    process.exitCode = 1;
  }
}

// prefix+m lands here when the project has no live window and no saved chat.
// With no chats anywhere the answer is plain "create" (workspace.sh proceeds
// with the default provider, no prompt). Otherwise a native menu offers a new
// chat here or jumping to one of the chats open in other projects.
async function runTmuxToggleMenu(args) {
  const config = await loadConfig();
  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;

  const hub = await ensureDaemon();
  const agents = (await hub.call("list_agents")).agents;
  const chats = (await hub.call("list_chats", {})).chats;
  hub.close();

  // Truly empty hub, or headless (no tmux to draw a menu on): create directly.
  if (!chats.length || !process.env.TMUX) {
    process.stdout.write("create");
    return;
  }

  const items = [];
  const defaultAgent = config.defaultAgent || agents[0]?.id || "codex";

  const localChats = chats
    .filter((chat) => chat.cwd === cwd)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  for (const chat of localChats.slice(0, 4)) {
    const status = chat.active ? ` · ${chat.status || "idle"}` : "";
    const age = formatRelativeAge(chat.updatedAt);
    items.push({
      label: `${providerIconFor(chat.provider, chat)} ${truncateText(cleanInline(chat.title || chat.id), 32)}${status}${age ? ` · ${age}` : ""}`,
      key: "",
      command: tmuxRunWorkspace(cwd, context, chat.provider, chat.id, "open"),
    });
  }
  if (localChats.length) items.push({ separator: true });

  const orderedAgents = [...agents].sort(
    (a, b) => Number(b.id === defaultAgent) - Number(a.id === defaultAgent),
  );
  orderedAgents.forEach((agent, index) => {
    const suffix = agent.id === defaultAgent ? " · default" : "";
    items.push({
      label: `${agent.icon || providerIconFor(agent.id)} New ${agent.label || agent.id} chat here${suffix}`,
      key: index < 9 ? String(index + 1) : "",
      command: tmuxRunWorkspace(cwd, context, agent.id, "", "open"),
    });
  });

  const remoteChats = chats
    .filter((chat) => chat.cwd !== cwd)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 12);
  if (remoteChats.length) {
    items.push({ separator: true });
    for (const chat of remoteChats) {
      const status = chat.active ? ` · ${chat.status || "idle"}` : "";
      const age = formatRelativeAge(chat.updatedAt);
      items.push({
        label: `${providerIconFor(chat.provider, chat)} ${truncateText(cleanInline(chat.title || chat.id), 28)} · ${chat.projectName}${status}${age ? ` · ${age}` : ""}`,
        key: "",
        command: tmuxRunWorkspace(chat.cwd, context, chat.provider, chat.id, "open"),
      });
    }
  }

  const result = displayTmuxMenu(`Vanzi Hub: ${projectName(cwd)}`, items, context);
  if (!result.ok) {
    // Menu failed (odd tmux state): degrade to direct creation.
    process.stdout.write("create");
    return;
  }
  process.stdout.write("menu");
}

// prefix+x / prefix+& inside an ACP workspace: killing a window only closes
// the client view — the chat keeps running in the daemon. This menu makes
// those semantics explicit instead of letting tmux's kill prompts imply the
// chat is being destroyed.
async function runTmuxCloseMenu(args) {
  const context = {
    session: "",
    client: "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || "";

  const chatId = tmuxPaneFormat(context.pane, "#{@vanzi_hub_chat_id}");
  const title = tmuxPaneFormat(context.pane, "#{@vanzi_hub_title}") || "ACP window";
  const cwd = tmuxPaneFormat(context.pane, "#{@vanzi_hub_project_path}") || process.cwd();

  const items = [
    { label: "Close window · chat keeps running", key: "w", command: "kill-window" },
  ];

  if (chatId) {
    items.push({
      label: "Stop chat · adapter off, stays saved",
      key: "s",
      command: tmuxActionCommand(cwd, context, "close", chatId, ""),
    });
    items.push({ separator: true });
    items.push({
      label: "Delete chat · permanent",
      key: "D",
      command: tmuxConfirmActionCommand(cwd, context, "delete", chatId, "Delete this chat permanently? (y/n)"),
    });
  }

  items.push({ separator: true });
  items.push({ label: "Kill pane · tmux default", key: "x", command: "kill-pane" });

  const result = displayTmuxMenu(`Close · ${truncateText(cleanInline(title), 32)}`, items, context);
  if (!result.ok) {
    tmuxDisplayMessage(context, `vanzi-hub: close menu failed: ${result.error || "unknown error"}`);
    process.exitCode = 1;
  }
}

async function runTmuxPanel(args) {
  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;
  const panel = String(args.panel || args._?.[0] || "control");
  const hub = await ensureDaemon();
  const agents = (await hub.call("list_agents")).agents;
  const chats = (await hub.call("list_chats", { cwd })).chats;
  hub.close();

  const chat = selectPanelChat(chats, context, args);
  const view = buildTmuxPanelView(panel, chat, context, cwd, { agents });
  const result = displayTmuxMenu(view.title, view.items, context);
  if (!result.ok) {
    tmuxDisplayMessage(context, `vanzi-hub: tmux panel failed: ${result.error || "unknown error"}`);
    process.exitCode = 1;
  }
}

async function runTmuxAction(args) {
  const cwd = resolveProjectRoot(path.resolve(args.cwd || process.cwd()));
  const context = {
    session: typeof args.session === "string" ? args.session : "",
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  context.client = tmuxPaneFormat(context.pane, "#{client_name}") || context.client;

  const action = String(args.action || "");
  const chatId = args["chat-id"] || tmuxPaneFormat(context.pane, "#{@vanzi_hub_chat_id}");
  const value = typeof args.value === "string" ? args.value.trim() : "";
  const hub = await ensureDaemon();

  try {
    if (!chatId) throw new Error("No ACP chat is associated with this pane");

    switch (action) {
      case "config": {
        const payload = parseActionPayload(value);
        const configId = payload.configId || payload.id || "";
        if (!configId) throw new Error("Config id is empty");
        const result = await hub.call("set_config_option", {
          chatId,
          configId,
          value: payload.value,
        });
        syncTmuxChatMetadata(context, result.chat);
        tmuxDisplayMessage(
          context,
          `vanzi-hub: ${result.configId || configId}=${valueLabel(result.value) || String(payload.value ?? "")}`,
        );
        break;
      }

      case "mode": {
        if (!value) throw new Error("Mode is empty");
        const result = await hub.call("set_mode", { chatId, modeId: value });
        syncTmuxChatMetadata(context, result.chat);
        tmuxDisplayMessage(context, `vanzi-hub: mode=${result.modeId || value}`);
        break;
      }

      case "access": {
        if (!value) throw new Error("Access profile is empty");
        const chats = (await hub.call("list_chats", { cwd })).chats;
        const chat = selectPanelChat(chats, context, { "chat-id": chatId });
        const target = resolveAccessTarget(chat, value);
        if (!target) throw new Error(`No access mode matching ${value}`);

        let result;
        if (target.kind === "mode") {
          result = await hub.call("set_mode", { chatId, modeId: target.value });
          tmuxDisplayMessage(context, `vanzi-hub: mode=${result.modeId || target.value}`);
        } else {
          result = await hub.call("set_config_option", {
            chatId,
            configId: target.configId,
            value: target.value,
          });
          tmuxDisplayMessage(
            context,
            `vanzi-hub: ${result.configId || target.configId}=${valueLabel(result.value) || target.value}`,
          );
        }
        syncTmuxChatMetadata(context, result.chat);
        break;
      }

      case "rename": {
        if (!value) throw new Error("Title is empty");
        const chat = await hub.call("rename_chat", { chatId, title: value });
        syncTmuxChatMetadata(context, chat);
        tmuxDisplayMessage(context, `vanzi-hub: renamed to ${cleanInline(value)}`);
        break;
      }

      case "roots-add":
      case "roots-remove":
      case "roots-clear": {
        const chats = (await hub.call("list_chats", { cwd })).chats;
        const chat = selectPanelChat(chats, context, { "chat-id": chatId });
        if (!chat) throw new Error("No ACP chat found");

        const current = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || cwd);
        let next = current;
        if (action === "roots-clear") {
          next = [];
        } else if (action === "roots-add") {
          if (!value) throw new Error("Directory is empty");
          next = normalizeAdditionalDirectories([...current, value], chat.cwd || cwd);
        } else {
          if (!value) throw new Error("Directory is empty");
          const number = Number(value);
          if (Number.isInteger(number) && number >= 1 && number <= current.length) {
            next = current.filter((_, index) => index !== number - 1);
          } else {
            const resolved = normalizeAdditionalDirectories([value], chat.cwd || cwd)[0];
            next = current.filter((root) => root !== resolved);
          }
        }

        const result = await hub.call("set_roots", { chatId, additionalDirectories: next });
        syncTmuxChatMetadata(context, result.chat);
        const suffix = result.requiresRestart ? " restart adapter to apply" : " saved";
        tmuxDisplayMessage(context, `vanzi-hub: roots${suffix}`);
        break;
      }

      case "auth": {
        if (!value) throw new Error("Auth method is empty");
        const result = await hub.call("authenticate", { chatId, methodId: value });
        syncTmuxChatMetadata(context, result.chat);
        tmuxDisplayMessage(context, "vanzi-hub: authenticated");
        break;
      }

      case "cancel":
        await hub.call("cancel", { chatId });
        tmuxDisplayMessage(context, "vanzi-hub: cancel requested");
        break;

      case "close":
        if (context.pane && submitCommandToTmuxPane(context.pane, "/close")) {
          tmuxDisplayMessage(context, "vanzi-hub: closing adapter");
          break;
        }
        await hub.call("close_chat", { chatId });
        tmuxDisplayMessage(context, "vanzi-hub: adapter closed");
        break;

      case "delete": {
        // The tmux menu already confirmed, so delete directly and send the popup
        // back to its menu instead of re-prompting through /delete. keepPane
        // stops the daemon from killing the window the menu returns to.
        const result = await hub.call("delete_chat", { chatId, keepPane: context.pane || "" });
        if (context.pane) submitCommandToTmuxPane(context.pane, "/menu");
        tmuxDisplayMessage(
          context,
          result.providerDeleted ? "vanzi-hub: chat deleted" : "vanzi-hub: chat removed locally",
        );
        break;
      }

      default:
        throw new Error(`Unknown tmux action: ${action}`);
    }
  } catch (error) {
    tmuxDisplayMessage(context, `vanzi-hub: ${error.message || String(error)}`);
    process.exitCode = 1;
  } finally {
    hub.close();
  }
}

function selectPanelChat(chats, context, args) {
  const chatId = args["chat-id"] || tmuxPaneFormat(context.pane, "#{@vanzi_hub_chat_id}");
  const provider = tmuxPaneFormat(context.pane, "#{@vanzi_hub_provider}");

  return (
    chats.find((chat) => chat.id === chatId) ||
    chats.find((chat) => chat.provider === provider && chat.active) ||
    chats.find((chat) => chat.provider === provider) ||
    chats.find((chat) => chat.active) ||
    chats[0] ||
    null
  );
}

function buildTmuxPanelView(panel, chat, context, cwd, extras = {}) {
  switch (panel) {
    case "model":
      return buildConfigOptionPanelView(chat, context, cwd, "model", "ACP Model");
    case "effort":
    case "reasoning":
      return buildConfigOptionPanelView(chat, context, cwd, "effort", "ACP Effort");
    case "config":
      return { title: "ACP Config", items: buildConfigPanelItems(chat, context, cwd) };
    case "access":
    case "permissions":
      return { title: "ACP Access", items: buildAccessPanelItems(chat, context, cwd) };
    case "commands":
      return { title: "Provider Commands", items: buildProviderCommandsPanelItems(chat, context) };
    case "modes":
      return { title: "ACP Modes", items: buildModesPanelItems(chat, context, cwd) };
    case "new":
      return { title: "New ACP Chat", items: buildNewChatPanelItems(extras.agents || [], context, cwd) };
    case "roots":
      return { title: "Workspace Roots", items: buildRootsPanelItems(chat, context, cwd) };
    case "plan":
      return { title: "ACP Plan", items: buildPlanPanelItems(chat, context) };
    case "auth":
      return { title: "ACP Authentication", items: buildAuthPanelItems(chat, context, cwd) };
    case "mcp":
      return { title: "MCP Servers", items: buildMcpPanelItems(chat, context) };
    case "activity":
      return { title: "Tool Activity", items: buildActivityPanelItems(context) };
    case "control":
    default:
      return { title: "ACP Command Center", items: buildCommandCenterPanelItems(chat, context, cwd) };
  }
}

function buildCommandCenterPanelItems(chat, context, cwd) {
  if (!chat) {
    return [{ label: "No active ACP chat found for this pane", disabled: true }];
  }

  const provider = chat.providerLabel || chat.provider || "Agent";
  const project = chat.projectName || projectName(cwd);
  const contextLabel = formatContextUsage(chat.usage);
  const subtitle = [chat.status, chat.mode, chatConfigLabel(chat), contextLabel]
    .filter(Boolean)
    .join("  ");

  return [
    { label: `${provider} - ${project}`, disabled: true },
    { label: subtitle || "ready", disabled: true },
    { separator: true },
    { label: "Chats", key: "s", command: tmuxSubmitToPane(context.pane, "/chats") },
    { label: "Refresh provider sessions", key: "r", command: tmuxSubmitToPane(context.pane, "/refresh") },
    { separator: true },
    { label: "Provider commands", key: "c", command: tmuxPanelCommand(cwd, context, "commands", chat.id) },
    { label: "Config", key: "g", command: tmuxPanelCommand(cwd, context, "config", chat.id) },
    { label: "Model", key: "l", command: tmuxPanelCommand(cwd, context, "model", chat.id) },
    { label: "Effort / reasoning", key: "f", command: tmuxPanelCommand(cwd, context, "effort", chat.id) },
    { label: "Modes", key: "o", command: tmuxPanelCommand(cwd, context, "modes", chat.id) },
    { label: "Plan", key: "P", command: tmuxPanelCommand(cwd, context, "plan", chat.id) },
    ...(chat.authMethods?.length
      ? [{ label: "Authenticate", key: "A", command: tmuxPanelCommand(cwd, context, "auth", chat.id) }]
      : []),
    ...(chat.mcpServers?.length
      ? [{ label: "MCP servers", key: "i", command: tmuxPanelCommand(cwd, context, "mcp", chat.id) }]
      : []),
    { label: "Access / permissions", key: "a", command: tmuxPanelCommand(cwd, context, "access", chat.id) },
    { label: "Workspace roots", key: "w", command: tmuxPanelCommand(cwd, context, "roots", chat.id) },
    { label: "New chat", key: "n", command: tmuxPanelCommand(cwd, context, "new", chat.id) },
    { separator: true },
    { label: "Compose multiline prompt", key: "p", command: tmuxSubmitToPane(context.pane, "/compose") },
    { label: "Open editor prompt", key: "e", command: tmuxSubmitToPane(context.pane, "/edit") },
    { label: "Attach file to next prompt", key: "t", command: tmuxPromptSubmitToPane(context, "Attach file", "/attach ") },
    { label: "Rename chat", key: "r", command: tmuxPromptActionCommand(cwd, context, "rename", chat.id, "Rename chat", chat.title || "") },
    { label: "Activity display", key: "v", command: tmuxPanelCommand(cwd, context, "activity", chat.id) },
    { separator: true },
    { label: "Cancel current turn", key: "x", command: tmuxConfirmActionCommand(cwd, context, "cancel", chat.id, "Cancel current ACP turn?") },
    { label: "Close adapter", key: "k", command: tmuxConfirmCommand(context, "Close this ACP adapter?", tmuxSubmitToPane(context.pane, "/close")) },
    { label: "Delete chat", key: "d", command: tmuxConfirmActionCommand(cwd, context, "delete", chat.id, "Delete this chat permanently?") },
    { label: "Close popup", key: "q", command: tmuxSubmitToPane(context.pane, "/exit") },
  ];
}

function buildConfigPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const items = [
    { label: `provider  ${chat.providerLabel || chat.provider || "-"}`, disabled: true },
    { label: `mode      ${chat.mode || "-"}`, disabled: true },
    { separator: true },
  ];

  const options = (chat.configOptions || []).slice(0, 12);
  if (!options.length) {
    items.push({ label: "No config options reported by this adapter yet", disabled: true });
    return items;
  }

  for (const option of options) {
    const id = configOptionId(option);
    items.push({ label: stripAnsi(formatConfigOption(option)), disabled: true });

    const values = configOptionMenuValues(option);
    for (const entry of values.slice(0, 10)) {
      const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
      const label = entry.label && entry.label !== entry.value ? ` ${entry.label}` : "";
      items.push({
        label: `  ${marker} ${truncateText(`${entry.value}${label}`, 62)}`,
        command: tmuxActionCommand(cwd, context, "config", chat.id, actionPayload({ configId: id, value: entry.value })),
      });
    }
  }

  return items;
}

function buildConfigOptionPanelView(chat, context, cwd, configId, title) {
  if (!chat) {
    return {
      title,
      items: [{ label: "No active ACP chat found for this pane", disabled: true }],
    };
  }

  const option = resolveConfigOption(chat.configOptions || [], configId);
  if (!option) {
    return {
      title,
      items: [{ label: `No ${configId} option reported by this adapter yet`, disabled: true }],
    };
  }

  const id = configOptionId(option);
  const items = [
    { label: stripAnsi(formatConfigOption(option)), disabled: true },
    { separator: true },
  ];

  const values = configOptionMenuValues(option);
  if (!values.length) {
    items.push({ label: `No selectable values. Type /config ${id} <value>.`, disabled: true });
    return { title, items };
  }

  for (const entry of values.slice(0, 40)) {
    const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
    const detail = [entry.label !== entry.value ? entry.label : "", entry.description]
      .filter(Boolean)
      .join(" - ");
    items.push({
      label: `${marker} ${truncateText(`${entry.value}${detail ? ` ${detail}` : ""}`, 70)}`,
      command: tmuxActionCommand(cwd, context, "config", chat.id, actionPayload({ configId: id, value: entry.value })),
    });
  }

  return { title, items };
}

function buildAccessPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const profiles = [
    ["read-only", "Read-only / plan"],
    ["agent", "Agent / default"],
    ["full", "Full access / don't ask"],
    ["plan", "Plan"],
    ["auto", "Auto"],
  ];
  const items = [
    { label: `current  ${chat.mode || "-"}`, disabled: true },
    { separator: true },
  ];

  let enabled = 0;
  for (const [profile, label] of profiles) {
    const target = resolveAccessTarget(chat, profile);
    if (!target) {
      items.push({ label: `- ${label}`, disabled: true });
      continue;
    }

    enabled += 1;
    const targetLabel =
      target.kind === "mode" ? `mode=${target.value}` : `${target.configId}=${target.value}`;
    items.push({
      label: `${label}  ${targetLabel}`,
      command: tmuxActionCommand(cwd, context, "access", chat.id, profile),
    });
  }

  if (enabled === 0) {
    items.push({ separator: true });
    items.push({ label: "No matching access modes reported by this adapter", disabled: true });
  }

  const modes = modeEntries(chat.modes);
  if (modes.length) {
    items.push({ separator: true });
    items.push({ label: "Reported modes", disabled: true });
    for (const mode of modes.slice(0, 20)) {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      const marker = id === chat.mode ? "*" : " ";
      items.push({
        label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
        command: tmuxActionCommand(cwd, context, "mode", chat.id, id),
      });
    }
  }

  return items;
}

function buildProviderCommandsPanelItems(chat, context) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const commands = chat.availableCommands || [];
  if (!commands.length) {
    return [
      { label: "No provider commands reported by ACP yet", disabled: true },
      { label: "You can still type //command manually", disabled: true },
    ];
  }

  const items = [
    { label: "Select a command to insert it at the prompt", disabled: true },
    { separator: true },
  ];

  for (const command of commands.slice(0, 30)) {
    const name = command.name || command.command || command.id || command.title || "command";
    const text = `//${String(name).replace(/^\/+/, "")}`;
    items.push({
      label: stripAnsi(formatProviderCommand(command)),
      command: tmuxInsertToPane(context.pane, text),
    });
  }

  return items;
}

function buildModesPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const modes = chat.modes || null;
  const items = [{ label: `current  ${chat.mode || "-"}`, disabled: true }];

  if (!modes) {
    items.push({ separator: true });
    items.push({ label: "No modes reported by this adapter yet", disabled: true });
    return items;
  }

  const entries = modes.availableModes || modes.modes || modes.options || [];
  items.push({ separator: true });

  if (!Array.isArray(entries) || !entries.length) {
    items.push({ label: JSON.stringify(modes), disabled: true });
    return items;
  }

  for (const mode of entries.slice(0, 30)) {
    const id = mode.id || mode.modeId || mode.name || String(mode);
    const label = mode.label || mode.title || mode.name || id;
    const marker = id === chat.mode ? "*" : " ";
    items.push({
      label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
      command: tmuxActionCommand(cwd, context, "mode", chat.id, id),
    });
  }

  return items;
}

function buildNewChatPanelItems(agents, context, cwd) {
  if (!agents.length) return [{ label: "No ACP agents configured", disabled: true }];

  const items = [
    { label: `project  ${displayPath(cwd)}`, disabled: true },
    { separator: true },
  ];

  for (const [index, agent] of agents.entries()) {
    const key = index < 9 ? String(index + 1) : "";
    items.push({
      label: `New ${agent.label || agent.id}`,
      key,
      command: tmuxRunWorkspace(cwd, context, agent.id, "", "new"),
    });
  }

  return items;
}

function planMenuMarker(status) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▸";
  if (status === "skipped" || status === "cancelled") return "⊘";
  return "·";
}

function buildMcpPanelItems(chat, context) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const servers = chat.mcpServers || [];
  if (!servers.length) {
    return [{ label: "No MCP servers configured for this chat", disabled: true }];
  }

  const items = [
    { label: `MCP servers (${servers.length})`, disabled: true },
    { separator: true },
  ];
  for (const server of servers) {
    const target = server.url || server.command || "";
    items.push({ label: `${mcpServerLabel(server)}  ${compactTmuxText(target, 48)}`, disabled: true });
  }
  return items;
}

function buildAuthPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const methods = chat.authMethods || [];
  if (!methods.length) {
    return [{ label: "No auth methods reported by this adapter", disabled: true }];
  }

  const items = [
    { label: `Authenticate ${chat.providerLabel || chat.provider || ""}`.trim(), disabled: true },
    { separator: true },
  ];
  for (const method of methods) {
    const id = method.id || method.methodId || "";
    const name = method.name || id;
    if (method.type === "env_var") {
      const vars = Array.isArray(method.vars)
        ? method.vars.map((v) => v.name).filter(Boolean).join(", ")
        : "";
      items.push({ label: `${name}  (set ${vars || "env vars"} + reopen)`, disabled: true });
    } else {
      items.push({ label: name, command: tmuxActionCommand(cwd, context, "auth", chat.id, id) });
    }
  }
  return items;
}

function buildPlanPanelItems(chat, context) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const entries = chat.plan?.entries || [];
  if (!entries.length) {
    return [{ label: "No active plan for this chat", disabled: true }];
  }

  const done = entries.filter((entry) => entry.status === "completed").length;
  const items = [
    { label: `Plan  ${done}/${entries.length} done`, disabled: true },
    { separator: true },
  ];
  for (const entry of entries) {
    items.push({
      label: `${planMenuMarker(entry.status)} ${compactTmuxText(cleanInline(entry.content), 64)}`,
      disabled: true,
    });
  }
  return items;
}

function buildRootsPanelItems(chat, context, cwd) {
  if (!chat) return [{ label: "No active ACP chat found for this pane", disabled: true }];

  const roots = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || cwd);
  const items = [
    { label: `main  ${displayPath(chat.cwd || cwd)}`, disabled: true },
    { label: "Changes are applied on next adapter restore", disabled: true },
    { separator: true },
    {
      label: "Add directory...",
      key: "a",
      command: tmuxPromptActionCommand(cwd, context, "roots-add", chat.id, "Add workspace root"),
    },
  ];

  if (roots.length) {
    items.push({ separator: true });
    for (const [index, root] of roots.entries()) {
      items.push({
        label: `Remove ${displayPath(root)}`,
        key: index < 9 ? String(index + 1) : "",
        command: tmuxConfirmActionCommand(
          cwd,
          context,
          "roots-remove",
          chat.id,
          `Remove workspace root ${displayPath(root)}?`,
          root,
        ),
      });
    }
    items.push({ separator: true });
    items.push({
      label: "Clear additional roots",
      key: "x",
      command: tmuxConfirmActionCommand(cwd, context, "roots-clear", chat.id, "Clear all additional roots?"),
    });
  } else {
    items.push({ label: "No additional directories configured", disabled: true });
  }

  return items;
}

function buildActivityPanelItems(context) {
  return [
    { label: "Controls tool/event rendering in this chat pane", disabled: true },
    { separator: true },
    { label: "Compact activity", key: "1", command: tmuxSubmitToPane(context.pane, "/activity compact") },
    { label: "Hide activity", key: "2", command: tmuxSubmitToPane(context.pane, "/activity hidden") },
    { label: "Debug activity", key: "3", command: tmuxSubmitToPane(context.pane, "/activity debug") },
  ];
}

async function runStatus() {
  const state = await readJsonIfExists(STATE_PATH);
  if (!state) {
    console.log("Vanzi hub has no state yet");
    return;
  }

  const socket = state.socket || SOCKET_PATH;
  const active = await canConnectToSocket(socket);
  const daemonLabel = active ? state.pid || "unknown" : `stopped (last pid ${state.pid || "unknown"})`;
  console.log(`daemon: ${daemonLabel} ${socket}`);
  const chats = state.chats || [];
  for (const chat of chats.slice(0, 50)) {
    console.log(
      `${chat.id} ${chat.provider}/${chat.projectName} ${chat.status} ${chat.statusDetail || ""}`,
    );
  }
  if (chats.length > 50) {
    console.log(`... ${chats.length - 50} more chat(s)`);
  }
}

// Environment checkup for issue reports and first-run debugging.
async function runHealth() {
  const ok = (label, value) => console.log(`✓ ${label}: ${value}`);
  const bad = (label, value) => console.log(`✗ ${label}: ${value}`);

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  (nodeMajor >= 18 ? ok : bad)("node", `${process.version}${nodeMajor < 18 ? " (need >= 18)" : ""}`);

  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (tmux.status === 0) {
    const version = tmux.stdout.trim();
    const number = Number.parseFloat(version.replace(/^tmux\s+/i, ""));
    (Number.isFinite(number) && number >= 3.4 ? ok : bad)(
      "tmux",
      `${version}${Number.isFinite(number) && number < 3.4 ? " (need >= 3.4)" : ""}`,
    );
  } else {
    bad("tmux", "not found in PATH");
  }

  try {
    await mkdirp(HUB_DIR);
    fs.accessSync(HUB_DIR, fs.constants.W_OK);
    ok("state dir", HUB_DIR);
  } catch (error) {
    bad("state dir", `${HUB_DIR} not writable (${error.message})`);
  }

  const registry = await readJsonIfExists(REGISTRY_PATH);
  const chatCount = Array.isArray(registry?.chats) ? registry.chats.length : 0;
  ok("registry", `${chatCount} saved chat(s)`);

  const daemonUp = await canConnectToSocket(SOCKET_PATH);
  console.log(`${daemonUp ? "✓" : "·"} daemon: ${daemonUp ? "running" : "stopped (starts on demand)"} ${SOCKET_PATH}`);

  const config = await loadConfig();
  for (const [name, agent] of Object.entries(config.agents || {})) {
    const command = agent?.command;
    if (!command) {
      bad(`agent ${name}`, "no command configured");
      continue;
    }
    const which = spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" });
    (which.status === 0 ? ok : bad)(
      `agent ${name}`,
      which.status === 0 ? `${command} ${(agent.args || []).join(" ")}`.trim() : `${command} not found in PATH`,
    );
  }
}

async function runProjectChat(args) {
  const cwd = resolveProjectRoot(args.cwd || process.cwd());
  const registry = await readJsonIfExists(REGISTRY_PATH);
  const chats = Array.isArray(registry?.chats) ? registry.chats : [];
  const currentIds = new Set(
    (Array.isArray(registry?.current) ? registry.current : [])
      .filter((entry) => entry?.chatId && entry?.cwd && path.resolve(entry.cwd) === cwd)
      .map((entry) => entry.chatId),
  );

  const candidates = chats
    .filter(
      (chat) =>
        chat?.id &&
        chat?.provider &&
        chat?.sessionId &&
        chat?.cwd &&
        path.resolve(chat.cwd) === cwd,
    )
    .sort((a, b) => {
      const currentDifference = Number(currentIds.has(b.id)) - Number(currentIds.has(a.id));
      if (currentDifference !== 0) return currentDifference;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });

  if (candidates[0]) {
    process.stdout.write(`${candidates[0].provider}|${candidates[0].id}`);
  }
}

async function runStop() {
  const hub = await connectHub(1000);
  await hub.call("shutdown");
  hub.close();
  console.log("Vanzi hub daemon stopped");
}

async function runRenderMarkdown() {
  const input = fs.readFileSync(0, "utf8");
  const ui = Object.create(PopupUi.prototype);
  ui.markdownFence = false;
  process.stdout.write(ui.renderMarkdown(input));
}

// tmux-invoked subcommands must not exit non-zero: run-shell turns that into
// a blocking error banner over the pane. Surface failures as a status message.
function reportTmuxCommandFailure(args, error) {
  const context = {
    client: typeof args.client === "string" ? args.client : "",
    pane: typeof args.pane === "string" ? args.pane : "",
  };
  try {
    tmuxDisplayMessage(context, `vanzi-hub: ${error.message || String(error)}`);
  } catch {
    // Nothing left to report to.
  }
}

async function main() {
  const [command = "ui", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "daemon":
      await runDaemon();
      break;
    case "ui":
      await runUi(args);
      break;
    case "health":
      await runHealth();
      break;
    case "status":
      await runStatus();
      break;
    case "project-chat":
      await runProjectChat(args);
      break;
    case "tmux-menu":
      await runTmuxMenu(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-toggle-menu":
      await runTmuxToggleMenu(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-close-menu":
      await runTmuxCloseMenu(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-panel":
      await runTmuxPanel(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "tmux-action":
      await runTmuxAction(args).catch((error) => reportTmuxCommandFailure(args, error));
      break;
    case "stop":
      await runStop();
      break;
    case "_render-markdown":
      await runRenderMarkdown();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exitCode = 2;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

export {
  PopupUi,
  renderMarkdownTable,
  hasPendingMarkdownTable,
  pickerFilterEntries,
  pickerNextIndex,
  formatRelativeAge,
  formatChatPreview,
  highlightCode,
};

