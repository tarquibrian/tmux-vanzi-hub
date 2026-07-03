#!/usr/bin/env node

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
import {
  stringDisplayWidth,
  wrapAnsiLine,
  truncateAnsiToWidth,
  padAnsiToWidth,
  stripAnsi as stripAnsiSequences,
} from "../lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_CONFIG = {
  defaultAgent: "codex",
  agents: {
    codex: {
      label: "Codex ACP",
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp@0.16.0"],
    },
    claude: {
      label: "Claude ACP",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.46.0"],
    },
  },
};

const CACHE_BASE = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
const CONFIG_BASE = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const HUB_DIR = process.env.VANZI_HUB_HOME || path.join(CACHE_BASE, "tmux-vanzi-hub");
const USER_CONFIG_PATH =
  process.env.VANZI_HUB_CONFIG || path.join(CONFIG_BASE, "tmux-vanzi-hub", "agents.json");

// One-time migration from the pre-rebrand name (tmux-acp-hub): move the state
// dir (registry with saved chats, drafts, history) and copy the user config.
{
  const legacyHubDir = path.join(CACHE_BASE, "tmux-acp-hub");
  if (!fs.existsSync(HUB_DIR) && fs.existsSync(legacyHubDir)) {
    try {
      fs.renameSync(legacyHubDir, HUB_DIR);
    } catch {
      // Fall through to a fresh state dir.
    }
  }
  const legacyConfig = path.join(CONFIG_BASE, "tmux-acp-hub", "agents.json");
  if (!fs.existsSync(USER_CONFIG_PATH) && fs.existsSync(legacyConfig)) {
    try {
      fs.mkdirSync(path.dirname(USER_CONFIG_PATH), { recursive: true });
      fs.copyFileSync(legacyConfig, USER_CONFIG_PATH);
    } catch {
      // Plugin defaults still apply.
    }
  }
}
const PLUGIN_CONFIG_PATH = path.join(PLUGIN_DIR, "agents.json");
const SOCKET_PATH = process.env.VANZI_HUB_SOCKET || path.join(HUB_DIR, "hub.sock");
const PID_PATH = path.join(HUB_DIR, "daemon.pid");
const LOG_PATH = path.join(HUB_DIR, "daemon.log");
const STATE_PATH = path.join(HUB_DIR, "state.json");
const REGISTRY_PATH = path.join(HUB_DIR, "registry.json");
const DRAFTS_PATH = path.join(HUB_DIR, "drafts.json");
const INPUT_HISTORY_PATH = path.join(HUB_DIR, "input-history.json");
const PASTES_DIR = path.join(HUB_DIR, "pastes");
const HISTORY_LIMIT = 300;
const HISTORY_PERSIST_LIMIT = 200;
const INPUT_HISTORY_LIMIT = 200;
const DRAFT_SAVE_DEBOUNCE_MS = 200;
const INPUT_HISTORY_SAVE_DEBOUNCE_MS = 300;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_EMBEDDED_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_AUTO_ATTACH_PASTE_PATHS = 12;
const PASTE_TEXT_ATTACHMENT_MIN_CHARS = 8000;
const PASTE_TEXT_ATTACHMENT_MIN_LINES = 40;
const TRANSCRIPT_SCREEN_LINE_LIMIT = 4000;
const MAX_COMPOSER_INPUT_ROWS = 6;
const MIN_COMPOSER_INPUT_ROWS = 1;
const COMPOSER_INPUT_SIDE_PADDING = 1;
const COMPOSER_META_SIDE_PADDING = 1;
const COMPOSER_MARKER_WIDTH = 2;
const COMPOSER_INPUT_VERTICAL_PADDING = 0;
const COMPOSER_BOX_SIDE_WIDTH = 2;
const COMPOSER_SPINNER_INTERVAL_MS = 180;
const LIVE_TABLE_PAINT_MS = 40;
const COMPOSER_PLACEHOLDER = "Write a message · / commands · @ files";

const PROVIDER_ACCENT_CODES = { claude: 170, codex: 43 };
const PROVIDER_ACCENT_FALLBACK = 39;

// Plain-Unicode provider marks (no Nerd Font required): Anthropic's starburst,
// OpenAI's hexagon. Overridable per agent with an `icon` field in agents.json.
const PROVIDER_ICONS = { claude: "❋", codex: "⬡" };
const PROVIDER_ICON_FALLBACK = "◆";

function providerIconFor(provider, chat = null) {
  if (chat?.providerIcon) return chat.providerIcon;
  return PROVIDER_ICONS[normalizeToken(provider)] || PROVIDER_ICON_FALLBACK;
}

function resolvedAgentIcon(config, provider) {
  return config?.agents?.[provider]?.icon || providerIconFor(provider);
}

function coloredProviderIcon(chat) {
  const icon = providerIconFor(chat?.provider, chat);
  const accent = providerAccentSeq(chat?.provider);
  return accent ? `${accent}${icon}${colors.reset || ""}` : icon;
}

// Render a transcript tail into wrapped lines for the picker preview pane.
// Streaming chunks are coalesced and, when a markdown renderer is provided,
// formatted like the chat view (tables, code fences, headings); reasoning,
// tool updates, and adapter logs are noise at this zoom level and are skipped.
function formatChatPreview(events, width, maxLines, renderMarkdown = null) {
  if (!Array.isArray(events) || width < 8 || maxLines < 1) return [];

  const out = [];
  const push = (line) => {
    out.push(line);
    // Keep the working set bounded; only the tail survives anyway.
    if (out.length > maxLines * 4) out.splice(0, out.length - maxLines * 2);
  };
  const pushWrapped = (text) => {
    for (const paragraph of String(text || "").split("\n")) {
      if (!paragraph.trim()) continue;
      for (const line of wrapAnsiLine(paragraph, width)) push(line);
    }
  };
  // Table and box-drawing rows lose their alignment when soft-wrapped; clip
  // them to the pane instead. Everything else wraps like the transcript.
  const pushRendered = (rendered) => {
    for (const line of String(rendered || "").split("\n")) {
      if (!line.trim()) {
        if (out.length && out[out.length - 1] !== "") push("");
        continue;
      }
      if (/[│┃┼├┤┌┐└┘─╭╮╰╯]/.test(stripAnsi(line))) {
        push(truncateAnsiToWidth(line, width));
      } else {
        for (const wrapped of wrapAnsiLine(line, width)) push(wrapped);
      }
    }
  };

  let agentBuffer = "";
  const flushAgent = () => {
    if (agentBuffer.trim()) {
      if (renderMarkdown) pushRendered(renderMarkdown(agentBuffer));
      else pushWrapped(agentBuffer);
    }
    agentBuffer = "";
  };

  for (const event of events) {
    switch (event?.type) {
      case "user":
        flushAgent();
        if (out.length) push("");
        pushWrapped(`${c("cyan", "❯")} ${event.text || ""}`);
        push("");
        break;
      case "agent_chunk":
        agentBuffer += event.text || "";
        break;
      case "tool_call":
        flushAgent();
        push(c("dim", truncateAnsiToWidth(`⚙ ${cleanInline(event.title || event.kind || "tool")}`, width)));
        break;
      case "plan":
        flushAgent();
        push(c("dim", `▸ plan · ${(event.entries || []).length} steps`));
        break;
      case "error":
        flushAgent();
        pushWrapped(c("red", `✗ ${cleanInline(event.text || "")}`));
        break;
      default:
        break;
    }
  }
  flushAgent();

  while (out.length && !out[out.length - 1]) out.pop();
  const tail = out.slice(-maxLines);
  while (tail.length && !tail[0]) tail.shift();
  return tail;
}

// Compact relative age for chat lists: now, 37m, 8h, 2d, 3w, 2mo, 1y.
function formatRelativeAge(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";

  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function providerAccentSeq(provider) {
  if (!process.stdout.isTTY) return "";
  const code = PROVIDER_ACCENT_CODES[normalizeToken(provider)] || PROVIDER_ACCENT_FALLBACK;
  return `\x1b[38;5;${code}m`;
}

// One shaded full-width row of a fenced code block. The background carries
// across soft-wrapped continuations (wrapAnsiLine re-opens SGR state), so long
// code lines stay inside the band.
function codeBlockLine(content, { dim = false, width = null } = {}) {
  if (!process.stdout.isTTY) return content;
  const target = width ?? Math.max(24, (process.stdout.columns || 80) - 1);
  // Fixed-width targets (picker preview pane) clip long code lines so the
  // padded background never spills into a soft-wrap.
  const body = width ? truncateAnsiToWidth(` ${content}`, target) : ` ${content}`;
  const padded = padAnsiToWidth(body, target);
  return `${colors.codeBg}${dim ? colors.dim : ""}${padded}${colors.reset}`;
}

function codeFenceHeader(lang, width = null) {
  if (!lang) return "";
  return codeBlockLine(lang, { dim: true, width });
}
const MAX_ATTACHMENT_CHIP_ROWS = 2;
const FILE_MENTION_LIMIT = 3000;
const FILE_MENTION_CACHE_MS = 15000;
const KILL_RING_LIMIT = 20;
const COMPOSER_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const colors = process.stdout.isTTY
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      italic: "\x1b[3m",
      strike: "\x1b[9m",
      cyan: "\x1b[36m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      magenta: "\x1b[35m",
      blue: "\x1b[34m",
      inputBg: "\x1b[48;5;236m",
      inputMuted: "\x1b[38;5;245m\x1b[48;5;236m",
      codeBg: "\x1b[48;5;235m",
    }
  : {
      reset: "",
      bold: "",
      dim: "",
      italic: "",
      strike: "",
      cyan: "",
      green: "",
      yellow: "",
      red: "",
      magenta: "",
      blue: "",
      inputBg: "",
      inputMuted: "",
      codeBg: "",
    };

function c(color, text) {
  return `${colors[color] || ""}${text}${colors.reset}`;
}

function nowIso() {
  return new Date().toISOString();
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function parseArgs(argv) {
  const result = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }

    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    i += 1;
  }

  return result;
}

async function mkdirp(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readJsonIfExistsSync(file, options = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (options.backupCorrupt === true) backupCorruptJsonFileSync(file);
    return null;
  }
}

function backupCorruptJsonFileSync(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(file, `${file}.bad-${stamp}`);
  } catch {}
}

function writeJsonFileSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

let draftsCache = null;
let draftsDirty = false;
let draftsFlushTimer = null;

function loadDrafts() {
  if (!draftsCache) {
    const value = readJsonIfExistsSync(DRAFTS_PATH, { backupCorrupt: true });
    draftsCache = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  return draftsCache;
}

function scheduleDraftsFlush() {
  if (draftsFlushTimer) clearTimeout(draftsFlushTimer);
  draftsFlushTimer = setTimeout(flushDraftsSync, DRAFT_SAVE_DEBOUNCE_MS);
  draftsFlushTimer.unref?.();
}

function flushDraftsSync() {
  if (draftsFlushTimer) {
    clearTimeout(draftsFlushTimer);
    draftsFlushTimer = null;
  }
  if (!draftsDirty || !draftsCache) return;

  try {
    writeJsonFileSync(DRAFTS_PATH, draftsCache);
    draftsDirty = false;
  } catch {}
}

function draftKey(chatId, cwd) {
  return shortHash(`${chatId || "chat"}:${path.resolve(cwd || process.cwd())}`);
}

function loadDraft(key) {
  const drafts = loadDrafts();
  return typeof drafts[key] === "string" ? drafts[key] : "";
}

function saveDraft(key, text) {
  if (!key) return;
  const drafts = loadDrafts();
  if (text) {
    drafts[key] = text;
  } else {
    delete drafts[key];
  }
  draftsDirty = true;
  scheduleDraftsFlush();
}

function clearDraft(key) {
  saveDraft(key, "");
}

let inputHistoryCache = null;
let inputHistoryDirty = false;
let inputHistoryFlushTimer = null;

function normalizeInputHistory(value) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  return entries
    .map((entry) => (typeof entry === "string" ? entry : ""))
    .filter((entry) => entry.trim())
    .slice(-INPUT_HISTORY_LIMIT);
}

function loadInputHistory() {
  if (!inputHistoryCache) {
    inputHistoryCache = normalizeInputHistory(
      readJsonIfExistsSync(INPUT_HISTORY_PATH, { backupCorrupt: true }),
    );
  }
  return [...inputHistoryCache];
}

function scheduleInputHistoryFlush() {
  if (inputHistoryFlushTimer) clearTimeout(inputHistoryFlushTimer);
  inputHistoryFlushTimer = setTimeout(flushInputHistorySync, INPUT_HISTORY_SAVE_DEBOUNCE_MS);
  inputHistoryFlushTimer.unref?.();
}

function flushInputHistorySync() {
  if (inputHistoryFlushTimer) {
    clearTimeout(inputHistoryFlushTimer);
    inputHistoryFlushTimer = null;
  }
  if (!inputHistoryDirty || !inputHistoryCache) return;

  try {
    writeJsonFileSync(INPUT_HISTORY_PATH, inputHistoryCache);
    inputHistoryDirty = false;
  } catch {}
}

function saveInputHistory(entries) {
  inputHistoryCache = normalizeInputHistory(entries);
  inputHistoryDirty = true;
  scheduleInputHistoryFlush();
}

function flushLocalInputStateSync() {
  flushDraftsSync();
  flushInputHistorySync();
}

function mergeConfig(base, next) {
  if (!next) return base;

  return {
    ...base,
    ...next,
    agents: {
      ...(base.agents || {}),
      ...(next.agents || {}),
    },
  };
}

async function loadConfig() {
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config = mergeConfig(config, await readJsonIfExists(PLUGIN_CONFIG_PATH));
  config = mergeConfig(config, await readJsonIfExists(USER_CONFIG_PATH));
  return config;
}

function resolveProjectRoot(cwd) {
  let current = path.resolve(cwd);

  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function projectName(cwd) {
  return path.basename(cwd) || cwd;
}

function defaultChatTitle() {
  return "New chat";
}

function newChatTitle(providerLabel, cwd, number) {
  return number > 1 ? `New chat ${number}` : "New chat";
}

function savedSessionTitle() {
  return "Saved chat";
}

function projectKey(provider, cwd) {
  return `${provider}\0${path.resolve(cwd)}`;
}

function chatIdFor(provider, cwd, sessionId = null, seed = null) {
  const identity = sessionId || seed || path.resolve(cwd);
  return `${provider}-${shortHash(`${path.resolve(cwd)}\0${identity}`)}`;
}

function agentEntries(config) {
  return Object.entries(config.agents || {}).map(([id, agent]) => ({
    id,
    label: agent.label || id,
    icon: agent.icon || "",
    command: agent.command,
    args: Array.isArray(agent.args) ? agent.args : [],
  }));
}

function linePrefixJson(message) {
  return `${JSON.stringify(message)}\n`;
}

async function canConnectToSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

class LineConnection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = "";
    this.closed = false;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => {
      this.closed = true;
      this.onClose?.();
    });
    socket.on("error", () => {
      this.closed = true;
      this.onClose?.();
    });
  }

  handleData(chunk) {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;

      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      try {
        this.onMessage(JSON.parse(line));
      } catch (error) {
        this.send({
          type: "event",
          event: "protocol_error",
          message: `Invalid JSON from peer: ${error.message}`,
        });
      }
    }
  }

  send(message) {
    if (this.closed) return;
    this.socket.write(linePrefixJson(message));
  }

  close() {
    this.closed = true;
    this.socket.end();
  }
}

class AcpPeer {
  constructor(child, onProtocolError) {
    this.child = child;
    this.onProtocolError = onProtocolError;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleData(chunk));
    child.on("error", (error) => this.rejectPending(error));
    child.on("exit", (code, signal) => {
      this.rejectPending(new Error(`ACP adapter exited: ${signal || code}`));
    });
    child.stdin.on("error", (error) => {
      this.onProtocolError?.(`ACP stdin error: ${error.message}`);
    });
  }

  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  call(method, params = {}, options = {}) {
    const id = this.nextId;
    this.nextId += 1;

    const timeoutMs = options.timeoutMs ?? 30000;
    const request = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }, timeoutMs);
      }

      this.pending.set(id, { resolve, reject, timer, method });

      try {
        this.write(request);
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.onProtocolError?.(`ACP notify failed: ${method}: ${error.message}`);
    }
  }

  write(message) {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("ACP adapter stdin is closed");
    }

    this.child.stdin.write(linePrefixJson(message));
  }

  handleData(chunk) {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;

      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.onProtocolError?.(`Invalid ACP JSON: ${error.message}: ${line.slice(0, 160)}`);
        continue;
      }

      this.handleMessage(message);
    }
  }

  async handleMessage(message) {
    if (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      (Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error"))
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);

      if (message.error) {
        const error = new Error(message.error.message || JSON.stringify(message.error));
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const handler = this.requestHandlers.get(message.method);
      if (!handler) {
        this.respondError(message.id, -32601, `Method not found: ${message.method}`);
        return;
      }

      try {
        const result = await handler(message.params || {});
        this.respond(message.id, result || {});
      } catch (error) {
        this.respondError(message.id, -32000, error.message || String(error));
      }
      return;
    }

    const handler = this.notificationHandlers.get(message.method);
    if (handler) {
      try {
        await handler(message.params || {});
      } catch (error) {
        this.onProtocolError?.(`Notification failed: ${message.method}: ${error.message}`);
      }
    }
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message, data = null) {
    const error = { code, message };
    if (data) error.data = data;
    this.write({ jsonrpc: "2.0", id, error });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      // Process may already be gone.
    }
  }
}

class HubDaemon {
  constructor(config) {
    this.config = config;
    this.server = null;
    this.clients = new Set();
    this.chats = new Map();
    this.registry = new Map();
    this.currentByProject = new Map();
    this.pendingPermissions = new Map();
    this.persistTimer = null;
    this.registryTimer = null;
    this.latestState = null;
    this.stateDirty = false;
    this.tmuxSyncTimers = new Map();
    // provider -> boolean: whether the adapter advertises session/delete, so
    // bulk deletes don't spawn a probe adapter per chat.
    this.sessionDeleteSupport = new Map();
    // "provider\0sessionId" for sessions deleted locally but not provider-side;
    // keeps session/list refreshes from resurrecting them.
    this.sessionTombstones = new Set();
  }

  tombstoneKey(provider, sessionId) {
    return `${provider}\0${sessionId}`;
  }

  tombstoneSession(provider, sessionId) {
    if (!provider || !sessionId) return;
    this.sessionTombstones.add(this.tombstoneKey(provider, sessionId));
    this.saveRegistry();
  }

  isSessionTombstoned(provider, sessionId) {
    return Boolean(provider && sessionId && this.sessionTombstones.has(this.tombstoneKey(provider, sessionId)));
  }

  async start() {
    await mkdirp(HUB_DIR);
    await this.loadRegistry();
    await this.removeStaleSocket();

    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(SOCKET_PATH, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    await fsp.chmod(SOCKET_PATH, 0o600).catch(() => {});
    await fsp.writeFile(PID_PATH, String(process.pid), "utf8");
    this.persistState();
  }

  async removeStaleSocket() {
    if (!fs.existsSync(SOCKET_PATH)) return;

    if (await canConnectToSocket(SOCKET_PATH)) {
      throw new Error(`Vanzi hub socket is already active: ${SOCKET_PATH}`);
    }

    try {
      await fsp.unlink(SOCKET_PATH);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  handleConnection(socket) {
    const client = {
      id: shortHash(`${Date.now()}-${Math.random()}`),
      subscriptions: new Set(),
      conn: null,
    };

    client.conn = new LineConnection(
      socket,
      (message) => {
        this.handleClientMessage(client, message).catch((error) => {
          this.sendError(client, message.id, error);
        });
      },
      () => this.handleClientClose(client),
    );

    this.clients.add(client);
  }

  handleClientClose(client) {
    this.clients.delete(client);
    // Pending permission requests intentionally survive client disconnects so a
    // reopened popup can still answer them; the per-request timeout bounds them.
  }

  async handleClientMessage(client, message) {
    if (message.type !== "request") return;

    const { id, method, params = {} } = message;

    try {
      let result;
      switch (method) {
        case "list_agents":
          result = { defaultAgent: this.config.defaultAgent, agents: agentEntries(this.config) };
          break;
        case "list_chats":
          result = { chats: this.chatSummaries(params) };
          break;
        case "ensure_chat":
          result = this.chatSummary(
            await this.ensureChat(params.provider || this.config.defaultAgent, params.cwd),
          );
          break;
        case "new_chat":
          result = this.chatSummary(
            await this.createChat(params.provider || this.config.defaultAgent, params.cwd, {
              makeCurrent: true,
              newSession: true,
            }),
          );
          break;
        case "refresh_sessions":
          result = await this.refreshSessions(
            params.provider || null,
            params.cwd || null,
            params.includeAllProviders === true,
          );
          break;
        case "subscribe":
          result = await this.subscribe(client, params.chatId);
          break;
        case "unsubscribe":
          result = this.unsubscribe(client, params.chatId);
          break;
        case "watch":
          client.watchAll = true;
          result = { ok: true };
          break;
        case "unwatch":
          client.watchAll = false;
          result = { ok: true };
          break;
        case "send_prompt":
          result = await this.sendPrompt(params.chatId, params.text, params.attachments || []);
          break;
        case "set_config_option":
          result = await this.setConfigOption(params.chatId, params.configId, params.value);
          break;
        case "set_mode":
          result = await this.setMode(params.chatId, params.modeId);
          break;
        case "set_roots":
          result = this.setRoots(params.chatId, params.additionalDirectories || []);
          break;
        case "cancel":
          result = this.cancel(params.chatId);
          break;
        case "permission_response":
          result = this.permissionResponse(params);
          break;
        case "close_chat":
          result = this.closeChat(params.chatId);
          break;
        case "delete_chat":
          result = await this.deleteChat(params.chatId);
          break;
        case "authenticate":
          result = await this.authenticate(params.chatId, params.methodId);
          break;
        case "rename_chat":
          result = this.renameChat(params.chatId, params.title);
          break;
        case "chat_preview":
          result = this.chatPreview(params.chatId);
          break;
        case "shutdown":
          result = { ok: true };
          setTimeout(() => this.shutdown(), 20);
          break;
        default:
          throw new Error(`Unknown hub method: ${method}`);
      }

      client.conn.send({ type: "response", id, result });
    } catch (error) {
      this.sendError(client, id, error);
    }
  }

  sendError(client, id, error) {
    client.conn.send({
      type: "response",
      id,
      error: {
        message: error.message || String(error),
      },
    });
  }

  agentConfig(provider) {
    const agent = this.config.agents?.[provider];
    if (!agent) throw new Error(`Unknown ACP agent: ${provider}`);
    if (!agent.command) throw new Error(`ACP agent ${provider} has no command`);
    return agent;
  }

  async ensureChat(provider, rawCwd) {
    const cwd = resolveProjectRoot(rawCwd || process.cwd());
    const currentId = this.currentByProject.get(projectKey(provider, cwd));
    const current = currentId ? this.chats.get(currentId) : null;

    if (current && !["closed", "stopped", "error"].includes(current.status)) {
      return current;
    }

    if (currentId && this.registry.has(currentId)) {
      try {
        return await this.activateStoredChat(currentId);
      } catch (error) {
        this.chats.delete(currentId);
        if (!isRestoreUnsupported(error)) throw error;
      }
    }

    const saved = [...this.registry.values()]
      .filter((record) => record.provider === provider && record.cwd === cwd && record.sessionId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    if (saved[0]) {
      this.currentByProject.set(projectKey(provider, cwd), saved[0].id);
      try {
        return await this.activateStoredChat(saved[0].id);
      } catch (error) {
        this.chats.delete(saved[0].id);
        if (!isRestoreUnsupported(error)) throw error;
      }
    }

    return this.createChat(provider, cwd, { makeCurrent: true });
  }

  async createChat(provider, rawCwd, options = {}) {
    const cwd = resolveProjectRoot(rawCwd || process.cwd());
    const agent = this.agentConfig(provider);
    const providerLabel = agent.label || provider;
    const provisionalId = chatIdFor(provider, cwd, null, `${Date.now()}-${Math.random()}`);
    const title =
      options.title ||
      (options.newSession
        ? newChatTitle(providerLabel, cwd, this.nextProjectChatNumber(provider, cwd))
        : defaultChatTitle(providerLabel, cwd));
    const chat = this.createChatObject({
      id: provisionalId,
      provider,
      providerLabel,
      cwd,
      title,
      statusDetail: "Starting ACP adapter",
      configValues: {
        ...agentDefaultConfigValues(agent),
        ...this.projectConfigValues(provider, cwd),
        ...sanitizeConfigValues(options.configValues || {}),
      },
    });

    this.chats.set(chat.id, chat);
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Starting ${chat.providerLabel} in ${chat.cwd}`,
    });

    await this.startAcpAgent(chat, agent, { lifecycle: "new" });

    if (chat.sessionId) {
      this.rekeyChat(chat, chatIdFor(provider, cwd, chat.sessionId));
    }

    this.rememberChat(chat, { makeCurrent: options.makeCurrent === true });
    return chat;
  }

  async activateStoredChat(chatId) {
    const active = this.chats.get(chatId);
    if (active && !["closed", "stopped", "error"].includes(active.status)) return active;

    const record = this.registry.get(chatId);
    if (!record) throw new Error(`Unknown saved chat: ${chatId}`);
    if (!record.sessionId) throw new Error(`Saved chat has no ACP session id: ${chatId}`);

    const agent = this.agentConfig(record.provider);
    const chat = this.createChatObject({
      ...record,
      providerLabel: agent.label || record.provider,
      statusDetail: "Restoring ACP session",
      configValues: sanitizeConfigValues(record.configValues || {}),
    });

    this.chats.set(chat.id, chat);
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Restoring ${chat.providerLabel} session ${record.sessionId}`,
    });

    try {
      await this.startAcpAgent(chat, agent, {
        lifecycle: "restore",
        sessionId: record.sessionId,
        additionalDirectories: record.additionalDirectories || [],
      });
    } catch (error) {
      if (!isRestoreUnsupported(error)) throw error;

      // The saved session no longer exists on the provider side. Retrying it
      // forever just accumulates errors; tombstone the stale session and give
      // the user a fresh working session in the same chat instead.
      this.tombstoneSession(record.provider, record.sessionId);
      this.registry.delete(chatId);
      chat.sessionId = null;
      chat.history = chat.history.filter(
        (event) => !(event.type === "error" && /Failed to start ACP session/.test(event.text || "")),
      );
      this.addEvent(chat, {
        type: "system",
        level: "warn",
        text: "Saved session no longer exists on the provider — starting a fresh session",
      });

      await this.startAcpAgent(chat, agent, {
        lifecycle: "new",
        additionalDirectories: record.additionalDirectories || [],
      });

      if (chat.sessionId) {
        this.rekeyChat(chat, chatIdFor(chat.provider, chat.cwd, chat.sessionId));
      }
    }

    this.rememberChat(chat, { makeCurrent: true });
    return chat;
  }

  createChatObject(input) {
    const now = nowIso();
    const chat = {
      id: input.id,
      provider: input.provider,
      providerLabel: input.providerLabel || input.provider,
      cwd: path.resolve(input.cwd),
      projectName: input.projectName || projectName(input.cwd),
      title: input.title || defaultChatTitle(input.providerLabel || input.provider, input.cwd),
      status: "starting",
      statusDetail: input.statusDetail || "Starting ACP adapter",
      mode: input.mode || null,
      pid: null,
      sessionId: input.sessionId || null,
      startedAt: input.startedAt || now,
      updatedAt: input.updatedAt || now,
      additionalDirectories: input.additionalDirectories || [],
      history: Array.isArray(input.history) ? [...input.history] : [],
      peer: null,
      process: null,
      turnActive: false,
      toolCalls: new Map(),
      modes: input.modes || null,
      availableCommands: input.availableCommands || [],
      configOptions: input.configOptions || [],
      configValues: sanitizeConfigValues(input.configValues || {}),
      usage: null,
      plan: null,
      promptQueue: [],
      authMethods: input.authMethods || [],
      pendingAuthOptions: null,
      mcpServers: [],
      suppressExitEvent: false,
    };
    return chat;
  }

  spawnAcpProcess(agent, cwd, onProtocolError) {
    const child = spawn(agent.command, Array.isArray(agent.args) ? agent.args : [], {
      cwd,
      env: { ...process.env, ...(agent.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const peer = new AcpPeer(child, onProtocolError);
    return { child, peer };
  }

  initializePeer(peer) {
    return peer.call(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
        },
        clientInfo: {
          name: "tmux-vanzi-hub",
          title: "tmux Vanzi Hub",
          version: "0.1.0",
        },
      },
      { timeoutMs: 30000 },
    );
  }

  async startAcpAgent(chat, agent, options = {}) {
    const { child, peer } = this.spawnAcpProcess(agent, chat.cwd, (message) => {
      this.addEvent(chat, { type: "error", text: message });
    });

    chat.process = child;
    chat.pid = child.pid;
    chat.peer = peer;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) this.addEvent(chat, { type: "adapter_log", text });
    });

    child.on("exit", (code, signal) => {
      if (chat.status === "closed") return;
      if (chat.suppressExitEvent) {
        chat.suppressExitEvent = false;
        return;
      }

      this.cancelPendingPermissionsForChat(chat, "Adapter exited");
      chat.turnActive = false;
      chat.promptQueue = [];
      this.setStatus(chat, "stopped", `Adapter exited: ${signal || code}`);
      this.addEvent(chat, {
        type: "system",
        level: code === 0 ? "info" : "error",
        text: `ACP adapter exited (${signal || code})`,
      });
      this.rememberChat(chat);
    });

    chat.peer.onNotification("session/update", (params) => this.handleSessionUpdate(chat, params));
    chat.peer.onRequest("session/request_permission", (params) =>
      this.handlePermissionRequest(chat, params),
    );

    try {
      this.setStatus(chat, "starting", "Initializing ACP");
      const init = await this.initializePeer(chat.peer);

      chat.agentInfo = init.agentInfo || null;
      chat.agentCapabilities = init.agentCapabilities || null;
      chat.authMethods = init.authMethods || [];

      await this.establishSession(chat, agent, options);
    } catch (error) {
      // The agent requires authentication before a session can be created. Keep
      // the adapter alive so the user can authenticate and retry instead of
      // tearing everything down with a cryptic error.
      if (error.code === -32000) {
        chat.pendingAuthOptions = options;
        this.setStatus(chat, "auth", "Authentication required");
        this.emitAuthRequired(chat);
        return;
      }

      this.setStatus(chat, "error", error.message || String(error));
      this.addEvent(chat, {
        type: "error",
        text: `Failed to start ACP session: ${error.message || String(error)}`,
      });
      this.cancelPendingPermissionsForChat(chat, "ACP session failed to start");
      chat.turnActive = false;
      chat.suppressExitEvent = true;

      if (chat.peer) {
        chat.peer.close();
      }

      if (chat.process && !chat.process.killed) {
        chat.process.kill("SIGTERM");
      }

      chat.peer = null;
      chat.process = null;
      chat.pid = null;
      throw error;
    }
  }

  async establishSession(chat, agent, options = {}) {
    let session;
    const restoreSessionId = options.sessionId || chat.sessionId;
    const additionalDirectories = Array.isArray(options.additionalDirectories)
      ? options.additionalDirectories
      : chat.additionalDirectories || [];
    chat.additionalDirectories = additionalDirectories;

    const { servers: mcpServers, skipped: skippedMcp } = resolveMcpServers(
      this.config,
      agent,
      chat.agentCapabilities,
    );
    chat.mcpServers = mcpServers;
    if (skippedMcp.length) {
      this.addEvent(chat, {
        type: "system",
        level: "warn",
        text: `Skipped MCP servers: ${skippedMcp.map((s) => `${s.skipped} (${s.reason})`).join(", ")}`,
      });
    }

    if (options.lifecycle === "restore" && restoreSessionId) {
      if (supportsSessionResume(chat)) {
        this.setStatus(chat, "starting", "Resuming ACP session");
        session = await chat.peer.call(
          "session/resume",
          { sessionId: restoreSessionId, cwd: chat.cwd, additionalDirectories, mcpServers },
          { timeoutMs: 60000 },
        );
      } else if (supportsSessionLoad(chat)) {
        this.setStatus(chat, "starting", "Loading ACP session");
        session = await chat.peer.call(
          "session/load",
          { sessionId: restoreSessionId, cwd: chat.cwd, additionalDirectories, mcpServers },
          { timeoutMs: 60000 },
        );
      } else {
        throw new Error("Agent does not advertise session/resume or session/load");
      }
    } else {
      this.setStatus(chat, "starting", "Creating ACP session");
      session = await chat.peer.call(
        "session/new",
        { cwd: chat.cwd, mcpServers },
        { timeoutMs: 60000 },
      );
    }

    chat.sessionId = session.sessionId || restoreSessionId;
    if (session.title) chat.title = session.title;
    chat.modes = session.modes || null;
    chat.mode = session.modes?.currentModeId || null;
    chat.configOptions = session.configOptions || [];
    syncChatModeFromConfig(chat);
    await this.applyDesiredConfig(chat, agent);
    this.setStatus(chat, "idle", "Ready");
    this.addEvent(chat, {
      type: "system",
      level: "success",
      text: `ACP session ready: ${chat.sessionId}`,
    });
  }

  emitAuthRequired(chat) {
    const methods = chat.authMethods || [];
    const lines = methods.map((method, index) => {
      const id = method.id || method.methodId || `method-${index + 1}`;
      const name = method.name || id;
      const vars = Array.isArray(method.vars) ? method.vars.map((v) => v.name).filter(Boolean) : [];
      const hint =
        method.type === "env_var" && vars.length
          ? ` — set ${vars.join(", ")} and reopen the chat`
          : "";
      return `  ${index + 1}. ${name} [${id}]${hint}`;
    });
    this.addEvent(chat, {
      type: "auth_required",
      methods,
      text: methods.length
        ? `Authentication required for ${chat.providerLabel}.\nAvailable methods:\n${lines.join("\n")}\nUse /auth <id> to authenticate.`
        : `Authentication required for ${chat.providerLabel}, but the adapter advertised no methods.`,
    });
  }

  async authenticate(chatId, methodId) {
    const chat = this.requireChat(chatId);
    if (!chat.peer) throw new Error("ACP adapter is not running");

    const methods = chat.authMethods || [];
    const method =
      methods.find((candidate) => (candidate.id || candidate.methodId) === methodId) ||
      (methods.length === 1 ? methods[0] : null);
    if (!method) throw new Error(`Unknown auth method: ${methodId}`);

    const resolvedId = method.id || method.methodId || methodId;
    if (method.type === "env_var") {
      const vars = Array.isArray(method.vars) ? method.vars.map((v) => v.name).filter(Boolean) : [];
      throw new Error(
        `${method.name || resolvedId} is an environment-variable method. Set ${
          vars.join(", ") || "the required variables"
        } in your environment and reopen the chat; the adapter reads them at startup.`,
      );
    }

    this.setStatus(chat, "starting", `Authenticating: ${method.name || resolvedId}`);
    await chat.peer.call("authenticate", { methodId: resolvedId }, { timeoutMs: 120000 });
    this.addEvent(chat, {
      type: "system",
      level: "success",
      text: `Authenticated with ${method.name || resolvedId}`,
    });

    const agent = this.agentConfig(chat.provider);
    await this.establishSession(chat, agent, chat.pendingAuthOptions || { lifecycle: "new" });
    chat.pendingAuthOptions = null;

    if (chat.sessionId) {
      this.rekeyChat(chat, chatIdFor(chat.provider, chat.cwd, chat.sessionId));
      this.rememberChat(chat, { makeCurrent: true });
    }
    return { ok: true, chat: this.chatSummary(chat) };
  }

  nextProjectChatNumber(provider, cwd) {
    const resolvedCwd = path.resolve(cwd);
    const ids = new Set();

    for (const record of this.registry.values()) {
      if (record.provider === provider && record.cwd === resolvedCwd) ids.add(record.id);
    }

    for (const chat of this.chats.values()) {
      if (chat.provider === provider && chat.cwd === resolvedCwd) ids.add(chat.id);
    }

    return ids.size + 1;
  }

  async subscribe(client, chatId) {
    const chat = this.chats.has(chatId)
      ? this.requireChat(chatId)
      : await this.activateStoredChat(chatId);

    client.subscriptions.add(chatId);
    this.markCurrentChat(chat);

    let pendingPermission = null;
    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.chatId === chat.id) {
        pendingPermission = { permissionId, options: pending.options || [] };
        break;
      }
    }

    return {
      chat: this.chatSummary(chat),
      history: chat.history,
      pendingPermission,
    };
  }

  unsubscribe(client, chatId) {
    client.subscriptions.delete(chatId);
    return { ok: true };
  }

  async sendPrompt(chatId, text, attachments = []) {
    const chat = this.requireChat(chatId);
    const cleanText = String(text || "").trim();
    const allAttachments = [
      ...(Array.isArray(attachments) ? attachments : []),
      ...mentionAttachmentsForText(chat.cwd, cleanText, attachments),
    ];
    const prompt = await buildPromptContent(chat, cleanText, allAttachments);

    if (!prompt.length) throw new Error("Prompt is empty");
    if (!chat.sessionId || !chat.peer) throw new Error("ACP session is not ready");

    // A turn is already running: queue this prompt and dispatch it when the
    // current one finishes. Hub-side serialization keeps it safe for every
    // adapter, whether or not it advertises prompt queueing.
    if (chat.turnActive) {
      chat.promptQueue.push({ text: cleanText, prompt });
      this.addEvent(chat, {
        type: "system",
        level: "info",
        text: `Queued prompt (${chat.promptQueue.length} pending)`,
      });
      this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
      return {
        accepted: true,
        queued: true,
        queueLength: chat.promptQueue.length,
        chat: this.chatSummary(chat),
      };
    }

    this.startPromptTurn(chat, cleanText, prompt);
    return { accepted: true, queued: false, chat: this.chatSummary(chat) };
  }

  startPromptTurn(chat, cleanText, prompt) {
    chat.turnActive = true;
    this.setStatus(chat, "responding", "Prompt submitted");
    this.addEvent(chat, { type: "user", text: promptDisplayText(cleanText, prompt) });

    chat.peer
      .call(
        "session/prompt",
        {
          sessionId: chat.sessionId,
          prompt,
        },
        { timeoutMs: 0 },
      )
      .then((result) => {
        chat.turnActive = false;
        const stopReason = result?.stopReason || "end_turn";
        this.setStatus(chat, "idle", `Turn complete: ${stopReason}`);
        this.rememberChat(chat);
        this.addEvent(chat, { type: "turn_done", stopReason });
        this.drainPromptQueue(chat);
      })
      .catch((error) => {
        chat.turnActive = false;
        chat.promptQueue = [];
        this.setStatus(chat, "error", error.message || String(error));
        this.addEvent(chat, {
          type: "error",
          text: `Prompt failed: ${error.message || String(error)}`,
        });
      });
  }

  drainPromptQueue(chat) {
    if (chat.turnActive) return;
    const next = chat.promptQueue.shift();
    if (!next) return;
    this.broadcast(chat, { type: "chat_state", chat: this.chatSummary(chat) });
    this.startPromptTurn(chat, next.text, next.prompt);
  }

  async setConfigOption(chatId, configId, value) {
    const chat = this.requireChat(chatId);
    const applied = await this.applySessionConfigOption(chat, configId, value);
    this.rememberChat(chat, { makeCurrent: true });
    this.broadcast(chat, {
      type: "chat_state",
      chat: this.chatSummary(chat),
    });
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Config ${applied.configId} set to ${valueLabel(applied.value) || String(applied.value)}`,
    });

    return {
      ok: true,
      configId: applied.configId,
      value: applied.value,
      chat: this.chatSummary(chat),
    };
  }

  async applySessionConfigOption(chat, configId, value) {
    if (!chat.peer || !chat.sessionId) throw new Error("ACP session is not ready");

    const option = resolveConfigOption(chat.configOptions, configId);
    if (!option) throw new Error(`Unknown config option: ${configId}`);

    const request = buildSetConfigOptionRequest(chat.sessionId, option, value);
    const result = await chat.peer.call("session/set_config_option", request, { timeoutMs: 30000 });

    if (Array.isArray(result?.configOptions)) {
      chat.configOptions = result.configOptions;
    } else {
      chat.configOptions = applyLocalConfigOptionValue(chat.configOptions, option.id || option.optionId, request.value);
    }

    syncChatModeFromConfig(chat);
    chat.configValues = selectedConfigValues(chat, {
      ...chat.configValues,
      [request.configId]: request.value,
    });
    return {
      configId: request.configId,
      value: request.value,
    };
  }

  async applyDesiredConfig(chat, agent) {
    const desired = {
      ...agentDefaultConfigValues(agent),
      ...sanitizeConfigValues(chat.configValues || {}),
    };
    const entries = sortConfigEntries(Object.entries(desired));
    if (!entries.length || !chat.configOptions?.length) {
      chat.configValues = selectedConfigValues(chat, desired);
      return;
    }

    for (const [configId, value] of entries) {
      const option = resolveConfigOption(chat.configOptions, configId);
      if (!option) continue;

      let resolvedValue;
      try {
        resolvedValue = resolveConfigOptionValue(option, value);
      } catch (error) {
        this.addEvent(chat, {
          type: "system",
          level: "warn",
          text: `Skipped config ${configId}: ${error.message || String(error)}`,
        });
        continue;
      }

      if (configOptionValueMatches(option, resolvedValue)) continue;

      try {
        await this.applySessionConfigOption(chat, configOptionId(option), resolvedValue);
      } catch (error) {
        if (isMethodNotFound(error, "session/set_config_option")) return;
        this.addEvent(chat, {
          type: "system",
          level: "warn",
          text: `Could not apply config ${configId}: ${error.message || String(error)}`,
        });
      }
    }

    chat.configValues = selectedConfigValues(chat, desired);
  }

  async setMode(chatId, modeId) {
    const chat = this.requireChat(chatId);
    if (!chat.peer || !chat.sessionId) throw new Error("ACP session is not ready");

    const mode = resolveMode(chat.modes, modeId);
    const resolvedModeId = mode?.id || mode?.modeId || mode?.name || modeId;

    try {
      await chat.peer.call(
        "session/set_mode",
        {
          sessionId: chat.sessionId,
          modeId: String(resolvedModeId),
        },
        { timeoutMs: 30000 },
      );
    } catch (error) {
      if (!isMethodNotFound(error, "session/set_mode") || !resolveConfigOption(chat.configOptions, "mode")) {
        throw error;
      }

      const result = await this.setConfigOption(chatId, "mode", String(resolvedModeId));
      return {
        ok: true,
        modeId: result.value,
        chat: result.chat,
      };
    }

    chat.mode = String(resolvedModeId);
    chat.configOptions = applyLocalConfigOptionValue(chat.configOptions, "mode", chat.mode);
    chat.configValues = selectedConfigValues(chat, {
      ...chat.configValues,
      mode: chat.mode,
    });
    this.rememberChat(chat, { makeCurrent: true });
    this.broadcast(chat, {
      type: "chat_state",
      chat: this.chatSummary(chat),
    });
    this.addEvent(chat, {
      type: "system",
      level: "info",
      text: `Mode set to ${chat.mode}`,
    });

    return {
      ok: true,
      modeId: chat.mode,
      chat: this.chatSummary(chat),
    };
  }

  setRoots(chatId, additionalDirectories) {
    const roots = normalizeAdditionalDirectories(additionalDirectories, this.requireKnownChatCwd(chatId));
    const chat = this.chats.get(chatId);

    if (chat) {
      chat.additionalDirectories = roots;
      chat.updatedAt = nowIso();
      this.rememberChat(chat, { makeCurrent: true });
      this.broadcast(chat, {
        type: "chat_state",
        chat: this.chatSummary(chat),
      });
      return {
        ok: true,
        requiresRestart: Boolean(chat.peer && chat.sessionId),
        chat: this.chatSummary(chat),
      };
    }

    const record = this.registry.get(chatId);
    if (!record) throw new Error(`Unknown chat: ${chatId}`);
    record.additionalDirectories = roots;
    record.updatedAt = nowIso();
    this.registry.set(record.id, record);
    this.saveRegistry();
    return {
      ok: true,
      requiresRestart: false,
      chat: this.recordSummary(record),
    };
  }

  requireKnownChatCwd(chatId) {
    const chat = this.chats.get(chatId);
    if (chat) return chat.cwd;
    const record = this.registry.get(chatId);
    if (record) return record.cwd;
    throw new Error(`Unknown chat: ${chatId}`);
  }

  cancel(chatId) {
    const chat = this.requireChat(chatId);
    if (!chat.peer || !chat.sessionId) throw new Error("ACP session is not ready");

    const cancelledPermissions = this.cancelPendingPermissionsForChat(chat, "Cancel requested");
    const droppedQueue = chat.promptQueue.length;
    chat.promptQueue = [];
    chat.peer.notify("session/cancel", { sessionId: chat.sessionId });
    this.setStatus(chat, "cancelling", "Cancel requested");
    this.addEvent(chat, {
      type: "system",
      level: "warn",
      text: droppedQueue
        ? `Cancel requested; dropped ${droppedQueue} queued prompt(s)`
        : "Cancel requested",
    });
    return { ok: true, cancelledPermissions, droppedQueue };
  }

  permissionResponse(params) {
    const pending = this.pendingPermissions.get(params.permissionId);
    if (!pending) throw new Error("Permission request is no longer pending");

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(params.permissionId);

    if (params.optionId) {
      pending.resolve({
        outcome: {
          outcome: "selected",
          optionId: params.optionId,
        },
      });
    } else {
      pending.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
    }

    return { ok: true };
  }

  closeChat(chatId) {
    const chat = this.requireChat(chatId);
    chat.status = "closed";
    chat.updatedAt = nowIso();
    chat.turnActive = false;
    chat.promptQueue = [];
    this.cancelPendingPermissionsForChat(chat, "Chat closed");

    if (chat.peer && chat.sessionId && supportsSessionClose(chat)) {
      try {
        chat.peer.call("session/close", { sessionId: chat.sessionId }, { timeoutMs: 1000 }).catch(
          () => {},
        );
      } catch {
        // Closing is best effort.
      }
    }

    if (chat.process) {
      chat.process.kill("SIGTERM");
    }

    this.addEvent(chat, { type: "system", level: "info", text: "Chat closed" });
    this.rememberChat(chat);
    this.chats.delete(chat.id);
    this.persistState();
    return { ok: true };
  }

  async deleteChat(chatId) {
    const chat = this.chats.get(chatId);
    const record = this.registry.get(chatId);
    if (!chat && !record) throw new Error(`Unknown chat: ${chatId}`);

    const provider = chat?.provider || record?.provider;
    const cwd = chat?.cwd || record?.cwd;
    const sessionId = chat?.sessionId || record?.sessionId;

    let providerSupported = false;
    let providerDeleted = false;

    // Provider-side deletion is best effort: an adapter that fails to spawn
    // or lacks session/delete must never block the local removal (this used
    // to throw before the registry delete, so the chat "would not die").
    try {
      if (sessionId && provider) {
        if (chat?.peer && chat.sessionId) {
          // Active chat: delete through its live adapter when advertised.
          if (supportsSessionDelete(chat.agentCapabilities)) {
            providerSupported = true;
            await chat.peer.call("session/delete", { sessionId: chat.sessionId }, { timeoutMs: 30000 });
            providerDeleted = true;
          }
          this.sessionDeleteSupport.set(provider, supportsSessionDelete(chat.agentCapabilities));
        } else if (this.sessionDeleteSupport.get(provider) !== false) {
          // Saved chat with no live adapter: probe with a temporary adapter,
          // remembering the capability so bulk deletes probe at most once.
          const agent = this.agentConfig(provider);
          const temp = this.spawnAcpProcess(agent, cwd, () => {});
          try {
            const init = await this.initializePeer(temp.peer);
            const supported = supportsSessionDelete(init.agentCapabilities);
            this.sessionDeleteSupport.set(provider, supported);
            if (supported) {
              providerSupported = true;
              await temp.peer.call("session/delete", { sessionId }, { timeoutMs: 30000 });
              providerDeleted = true;
            }
          } finally {
            temp.peer.close();
            temp.child.kill("SIGTERM");
          }
        }
      }
    } catch {
      // Fall through to local removal; the tombstone keeps it deleted.
    }

    if (sessionId && provider && !providerDeleted) {
      this.tombstoneSession(provider, sessionId);
    }

    // Stop the live adapter and forget the chat locally.
    if (chat) {
      chat.status = "closed";
      chat.turnActive = false;
      chat.promptQueue = [];
      chat.suppressExitEvent = true;
      this.cancelPendingPermissionsForChat(chat, "Chat deleted");
      if (chat.process) chat.process.kill("SIGTERM");
      this.addEvent(chat, { type: "system", level: "info", text: "Chat deleted" });
      this.chats.delete(chat.id);
    }

    this.registry.delete(chatId);
    for (const [key, id] of this.currentByProject) {
      if (id === chatId) this.currentByProject.delete(key);
    }
    this.saveRegistry();
    this.persistState();
    this.clearTmuxWindowForChat(chatId);

    return { ok: true, providerSupported, providerDeleted };
  }

  // Transcript tail for the picker preview pane. Works for live chats (in-
  // memory history) and saved ones (registry history) alike.
  chatPreview(chatId) {
    const chat = this.chats.get(chatId);
    const record = this.registry.get(chatId);
    if (!chat && !record) throw new Error(`Unknown chat: ${chatId}`);

    const events = chat?.history || record?.history || [];
    return {
      chatId,
      title: cleanInline(chat?.title || record?.title || ""),
      provider: chat?.provider || record?.provider,
      active: Boolean(chat),
      status: chat ? chat.status : "saved",
      updatedAt: chat?.updatedAt || record?.updatedAt || null,
      events: events.slice(-160),
    };
  }

  // A window that displayed a deleted chat keeps stale metadata; clear it so
  // labels stop lying and the prefix+m/9/0 lookups skip the orphan view.
  clearTmuxWindowForChat(chatId) {
    if (!process.env.TMUX || !chatId) return;
    findTmuxWindowForChat(chatId)
      .then((windowId) => {
        if (!windowId) return;
        setTmuxWindowOptions(
          {
            "@vanzi_hub_chat_id": "",
            "@vanzi_hub_session_id": "",
            "@vanzi_hub_project_path": "",
            "@vanzi_hub_provider": "",
            "@vanzi_hub_provider_short": "",
            "@vanzi_hub_provider_icon": "",
            "@vanzi_hub_status": "closed",
            "@vanzi_hub_status_glyph": "",
            "@vanzi_hub_status_detail": "",
            "@vanzi_hub_title": "deleted",
            "@vanzi_hub_action": "",
            "@vanzi_hub_active": "",
          },
          windowId,
        );
      })
      .catch(() => {});
  }

  renameChat(chatId, title) {
    const cleanTitle = cleanInline(title);
    if (!cleanTitle) throw new Error("Title is empty");

    const chat = this.chats.get(chatId);
    if (chat) {
      chat.title = cleanTitle;
      chat.updatedAt = nowIso();
      this.rememberChat(chat, { makeCurrent: true });
      this.persistState();
      this.broadcast(chat, {
        type: "chat_state",
        chat: this.chatSummary(chat),
      });
      return this.chatSummary(chat);
    }

    const record = this.registry.get(chatId);
    if (!record) throw new Error(`Unknown chat: ${chatId}`);

    record.title = cleanTitle;
    record.updatedAt = nowIso();
    this.registry.set(record.id, record);
    this.currentByProject.set(projectKey(record.provider, record.cwd), record.id);
    this.saveRegistry();
    return this.recordSummary(record);
  }

  cancelPendingPermissionsForChat(chat, reason) {
    let count = 0;

    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.chatId !== chat.id) continue;

      clearTimeout(pending.timer);
      this.pendingPermissions.delete(permissionId);
      pending.resolve({
        outcome: {
          outcome: "cancelled",
        },
      });
      count += 1;
    }

    if (count > 0) {
      this.addEvent(chat, {
        type: "system",
        level: "warn",
        text: `${reason}; cancelled ${count} pending permission request(s)`,
      });
    }

    return count;
  }

  async loadRegistry() {
    const registry = await readJsonIfExists(REGISTRY_PATH);
    if (!registry) return;

    for (const raw of registry.tombstones || []) {
      if (raw?.provider && raw?.sessionId) {
        this.sessionTombstones.add(this.tombstoneKey(raw.provider, raw.sessionId));
      }
    }

    for (const raw of registry.chats || []) {
      const record = this.normalizeRecord(raw);
      if (record && !this.isSessionTombstoned(record.provider, record.sessionId)) {
        this.registry.set(record.id, record);
      }
    }

    for (const current of registry.current || []) {
      if (!current.provider || !current.cwd || !current.chatId) continue;
      if (!this.registry.has(current.chatId)) continue;
      this.currentByProject.set(projectKey(current.provider, current.cwd), current.chatId);
    }
  }

  normalizeRecord(raw) {
    if (!raw || !raw.provider || !raw.cwd) return null;
    const cwd = path.resolve(raw.cwd);
    const sessionId = raw.sessionId || null;
    const id = raw.id || chatIdFor(raw.provider, cwd, sessionId, raw.updatedAt || raw.title || cwd);
    const providerLabel = raw.providerLabel || this.config.agents?.[raw.provider]?.label || raw.provider;

    return {
      id,
      provider: raw.provider,
      providerLabel,
      cwd,
      projectName: raw.projectName || projectName(cwd),
      title:
        raw.title ||
        (raw.source === "agent-list"
          ? savedSessionTitle(providerLabel, cwd)
          : defaultChatTitle(providerLabel, cwd)),
      status: "saved",
      statusDetail: raw.statusDetail || "Saved ACP session",
      mode: raw.mode || null,
      pid: null,
      sessionId,
      startedAt: raw.startedAt || raw.createdAt || raw.updatedAt || nowIso(),
      updatedAt: raw.updatedAt || nowIso(),
      additionalDirectories: raw.additionalDirectories || [],
      configValues: sanitizeConfigValues(raw.configValues || {}),
      model: raw.model || raw.configValues?.model || null,
      effort: raw.effort || raw.configValues?.effort || raw.configValues?.reasoning || null,
      source: raw.source || "local",
      usage: raw.usage || null,
      // Transcript events survive daemon restarts; without this a restart
      // "lost" every conversation even though the session itself restored.
      history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_PERSIST_LIMIT) : [],
    };
  }

  rememberChat(chat, options = {}) {
    if (!chat.sessionId) return null;

    const record = this.normalizeRecord({
      id: chat.id,
      provider: chat.provider,
      providerLabel: chat.providerLabel,
      cwd: chat.cwd,
      projectName: chat.projectName,
      title: chat.title,
      statusDetail: "Saved ACP session",
      mode: chat.mode,
      sessionId: chat.sessionId,
      startedAt: chat.startedAt,
      updatedAt: chat.updatedAt || nowIso(),
      additionalDirectories: chat.additionalDirectories || [],
      configValues: selectedConfigValues(chat),
      model: chatModel(chat),
      effort: chatEffort(chat),
      source: options.source || "local",
      usage: chat.usage || null,
      history: (chat.history || []).slice(-HISTORY_PERSIST_LIMIT),
    });

    this.registry.set(record.id, record);
    if (options.makeCurrent === true) {
      this.currentByProject.set(projectKey(record.provider, record.cwd), record.id);
    }

    this.saveRegistry();
    return record;
  }

  projectConfigValues(provider, cwd) {
    const resolvedCwd = path.resolve(cwd);
    const candidates = [];

    for (const chat of this.chats.values()) {
      if (chat.provider !== provider || chat.cwd !== resolvedCwd) continue;
      const values = selectedConfigValues(chat);
      if (Object.keys(values).length) {
        candidates.push({ updatedAt: chat.updatedAt || "", values });
      }
    }

    for (const record of this.registry.values()) {
      if (record.provider !== provider || record.cwd !== resolvedCwd) continue;
      const values = sanitizeConfigValues(record.configValues || {});
      if (Object.keys(values).length) {
        candidates.push({ updatedAt: record.updatedAt || "", values });
      }
    }

    candidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return candidates[0]?.values || {};
  }

  markCurrentChat(chat) {
    if (!chat?.provider || !chat.cwd) return;

    chat.updatedAt = nowIso();
    this.currentByProject.set(projectKey(chat.provider, chat.cwd), chat.id);
    if (chat.sessionId) {
      this.rememberChat(chat, { makeCurrent: true });
    } else {
      this.saveRegistry();
    }
  }

  rememberSessionInfo(provider, session, fallbackCwd, options = {}) {
    if (!session || !session.sessionId) return null;
    // Locally deleted sessions stay deleted even when the provider still
    // lists them (no session/delete support on the adapter).
    if (this.isSessionTombstoned(provider, session.sessionId)) return null;

    const agent = this.agentConfig(provider);
    const cwd = path.resolve(session.cwd || fallbackCwd || process.cwd());
    const record = this.normalizeRecord({
      id: chatIdFor(provider, cwd, session.sessionId),
      provider,
      providerLabel: agent.label || provider,
      cwd,
      title: session.title || savedSessionTitle(agent.label || provider, cwd),
      sessionId: session.sessionId,
      mode: session.modes?.currentModeId || session.mode || null,
      configValues: session.configOptions
        ? selectedConfigValues({ configOptions: session.configOptions, mode: session.modes?.currentModeId || session.mode })
        : sanitizeConfigValues(session.configValues || {}),
      updatedAt: session.updatedAt || nowIso(),
      additionalDirectories: session.additionalDirectories || [],
      source: options.source || "agent-list",
      // A provider-side listing knows nothing about our transcript; keep it.
      history: this.registry.get(chatIdFor(provider, cwd, session.sessionId))?.history || [],
    });

    this.registry.set(record.id, record);
    if (options.makeCurrent === true) {
      this.currentByProject.set(projectKey(record.provider, record.cwd), record.id);
    }
    this.saveRegistry();
    return record;
  }

  saveRegistry() {
    if (this.registryTimer) return;

    this.registryTimer = setTimeout(() => {
      this.registryTimer = null;
      this.writeRegistryNow();
    }, 100);
  }

  writeRegistryNow() {
    const current = [...this.currentByProject.entries()].map(([key, chatId]) => {
      const [provider, cwd] = key.split("\0");
      return { provider, cwd, chatId };
    });

    const data = {
      version: 1,
      updatedAt: nowIso(),
      current,
      tombstones: [...this.sessionTombstones].slice(-500).map((key) => {
        const [provider, sessionId] = key.split("\0");
        return { provider, sessionId };
      }),
      chats: [...this.registry.values()].sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
      ),
    };

    try {
      fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    } catch {
      // Registry persistence is best effort.
    }
  }

  rekeyChat(chat, newId) {
    if (!newId || chat.id === newId) return;

    const oldId = chat.id;
    this.chats.delete(oldId);
    this.registry.delete(oldId);
    chat.id = newId;
    this.chats.set(chat.id, chat);
  }

  async refreshSessions(provider, rawCwd, includeAllProviders = false) {
    const cwd = rawCwd ? resolveProjectRoot(rawCwd) : process.cwd();
    const providers = provider
      ? [provider]
      : includeAllProviders
        ? Object.keys(this.config.agents || {})
        : [this.config.defaultAgent || "codex"];

    const results = [];
    for (const providerId of providers) {
      results.push(await this.refreshProviderSessions(providerId, cwd));
    }

    return {
      providers: results,
      chats: this.chatSummaries({ cwd, limit: 80 }),
    };
  }

  async refreshProviderSessions(provider, cwd) {
    const agent = this.agentConfig(provider);
    const temp = this.spawnAcpProcess(agent, cwd, () => {});

    try {
      const init = await this.initializePeer(temp.peer);
      const capabilities = init.agentCapabilities || {};

      if (!supportsSessionListCapabilities(capabilities)) {
        return { provider, supported: false, sessionCount: 0, sessions: [] };
      }

      const sessions = [];
      let cursor = null;

      do {
        const params = { cwd };
        if (cursor) params.cursor = cursor;
        const response = await temp.peer.call("session/list", params, { timeoutMs: 60000 });
        const items = response.sessions || response.items || [];
        for (const session of items) {
          const record = this.rememberSessionInfo(provider, session, cwd, { source: "agent-list" });
          if (record) sessions.push(record);
        }
        cursor = response.nextCursor || null;
      } while (cursor);

      return {
        provider,
        supported: true,
        sessionCount: sessions.length,
        sessions: sessions.slice(0, 50),
      };
    } finally {
      temp.peer.close();
      temp.child.kill("SIGTERM");
    }
  }

  requireChat(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    return chat;
  }

  handleSessionUpdate(chat, params) {
    const update = params.update || params;
    const type = update.sessionUpdate;

    switch (type) {
      case "agent_message_chunk":
        this.setStatus(chat, "responding", "Streaming response", { quiet: true });
        this.addEvent(chat, {
          type: "agent_chunk",
          text: contentText(update.content),
          messageId: update.messageId || null,
        });
        break;
      case "agent_thought_chunk":
        this.setStatus(chat, "thinking", "Streaming reasoning", { quiet: true });
        this.addEvent(chat, {
          type: "thought_chunk",
          text: contentText(update.content),
          messageId: update.messageId || null,
        });
        break;
      case "tool_call":
        chat.toolCalls.set(update.toolCallId, update);
        this.setStatus(chat, "working", update.title || update.kind || "Tool call");
        this.addEvent(chat, {
          type: "tool_call",
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status || "pending",
          summary: toolContentText(update.content),
        });
        break;
      case "tool_call_update": {
        const previous = chat.toolCalls.get(update.toolCallId) || {};
        const merged = { ...previous, ...update };
        chat.toolCalls.set(update.toolCallId, merged);
        this.setStatus(chat, "working", merged.title || merged.kind || "Tool update");
        this.addEvent(chat, {
          type: "tool_update",
          toolCallId: update.toolCallId,
          title: merged.title,
          kind: merged.kind,
          status: update.status || merged.status,
          summary: toolContentText(update.content),
        });
        break;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        chat.plan = entries.length ? { entries, updatedAt: nowIso() } : null;
        this.setStatus(chat, "planning", "Plan updated");
        this.addEvent(chat, {
          type: "plan",
          entries,
        });
        break;
      }
      case "available_commands_update":
        chat.availableCommands = update.availableCommands || [];
        this.addEvent(chat, {
          type: "system",
          level: "info",
          text: `Commands available: ${chat.availableCommands.length}`,
        });
        break;
      case "current_mode_update":
        if (update.modes) chat.modes = update.modes;
        chat.mode = update.currentModeId || null;
        chat.configValues = selectedConfigValues(chat, {
          ...chat.configValues,
          mode: chat.mode,
        });
        this.rememberChat(chat);
        this.addEvent(chat, {
          type: "system",
          level: "info",
          text: `Mode: ${chat.mode}`,
        });
        break;
      case "config_option_update":
        chat.configOptions = update.configOptions || [];
        syncChatModeFromConfig(chat);
        chat.configValues = selectedConfigValues(chat, chat.configValues);
        this.rememberChat(chat);
        this.addEvent(chat, {
          type: "system",
          level: "info",
          text: "Session config updated",
        });
        break;
      case "session_info_update":
        if (update.title !== undefined && update.title !== null) chat.title = update.title;
        chat.updatedAt = update.updatedAt || nowIso();
        this.rememberChat(chat);
        this.persistState();
        this.broadcast(chat, {
          type: "chat_state",
          chat: this.chatSummary(chat),
        });
        break;
      case "usage_update":
        chat.usage = {
          used: typeof update.used === "number" ? update.used : null,
          size: typeof update.size === "number" ? update.size : null,
          cost: update.cost || null,
        };
        chat.updatedAt = nowIso();
        this.rememberChat(chat);
        this.persistState();
        this.broadcast(chat, {
          type: "chat_state",
          chat: this.chatSummary(chat),
        });
        break;
      default:
        this.addEvent(chat, {
          type: "raw_update",
          update,
        });
    }
  }

  async handlePermissionRequest(chat, params) {
    const permissionId = `perm-${shortHash(`${Date.now()}-${Math.random()}`)}`;
    const options = params.options || [];

    this.setStatus(chat, "permission", params.toolCall?.title || "Permission required");
    this.addEvent(chat, {
      type: "permission",
      permissionId,
      toolCall: params.toolCall || {},
      options,
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(permissionId);
        resolve({
          outcome: {
            outcome: "cancelled",
          },
        });
      }, PERMISSION_TIMEOUT_MS);

      this.pendingPermissions.set(permissionId, {
        chatId: chat.id,
        options,
        resolve,
        timer,
      });

      // Deliver to any subscribed client. If none is connected (popup closed),
      // the request stays pending until a reopened popup answers it or it times
      // out; the chat status shows "permission" so tmux badges flag it.
      for (const client of this.clients) {
        if (!client.subscriptions.has(chat.id)) continue;
        client.conn.send({
          type: "event",
          event: "permission_request",
          chatId: chat.id,
          permissionId,
          params,
        });
      }
    });
  }

  setStatus(chat, status, detail, options = {}) {
    chat.status = status;
    chat.statusDetail = detail || "";
    chat.updatedAt = nowIso();
    this.persistState();
    this.scheduleTmuxSync(chat);

    if (!options.quiet) {
      this.broadcast(chat, {
        type: "chat_state",
        chat: this.chatSummary(chat),
      });
    }
  }

  addEvent(chat, event) {
    const enriched = {
      ...event,
      at: nowIso(),
    };

    if (canMergeHistoryChunk(chat.history.at(-1), enriched)) {
      const previous = chat.history.at(-1);
      previous.text = `${previous.text || ""}${enriched.text || ""}`;
      previous.at = enriched.at;
    } else {
      chat.history.push(enriched);
    }

    if (chat.history.length > HISTORY_LIMIT) {
      chat.history.splice(0, chat.history.length - HISTORY_LIMIT);
    }
    chat.updatedAt = enriched.at;

    // Keep the persisted transcript current (registry writes are debounced).
    const record = this.registry.get(chat.id);
    if (record) {
      record.history = chat.history.slice(-HISTORY_PERSIST_LIMIT);
      record.updatedAt = enriched.at;
      this.saveRegistry();
    }

    this.persistState();
    this.broadcast(chat, {
      type: "chat_event",
      chatId: chat.id,
      event: enriched,
      chat: this.chatSummary(chat),
    });
  }

  broadcast(chat, event) {
    this.scheduleTmuxSync(chat);
    for (const client of this.clients) {
      // Watchers (e.g. the interactive menu) get every chat's events so their
      // list stays live without subscribing to each chat.
      if (!client.watchAll && !client.subscriptions.has(chat.id)) continue;
      client.conn.send({ type: "event", ...event });
    }
  }

  // The daemon owns ongoing tmux window metadata: it sees every chat change
  // whether or not a popup is attached, so status glyphs in the status bar and
  // the prefix+s switcher no longer freeze when the popup closes mid-turn.
  // Trailing-edge throttle per chat; the window is found by @vanzi_hub_chat_id
  // (seeded by the popup when the chat is first opened).
  scheduleTmuxSync(chat) {
    if (!process.env.TMUX || !chat?.id) return;
    if (this.tmuxSyncTimers.has(chat.id)) return;

    const timer = setTimeout(() => {
      this.tmuxSyncTimers.delete(chat.id);
      this.syncTmuxWindowForChat(chat.id).catch(() => {});
    }, 500);
    timer.unref?.();
    this.tmuxSyncTimers.set(chat.id, timer);
  }

  async syncTmuxWindowForChat(chatId) {
    const windowId = await findTmuxWindowForChat(chatId);
    if (!windowId) return;

    const chat = this.chats.get(chatId);
    const summary = chat ? this.chatSummary(chat) : this.registryRecordSummary(chatId);
    if (!summary) return;

    setTmuxWindowOptions(tmuxWindowOptionValues(summary), windowId);
  }

  registryRecordSummary(chatId) {
    const record = this.registry.get(chatId);
    return record ? this.recordSummary(record) : null;
  }

  chatSummaries(filters = {}) {
    const summaries = new Map();

    for (const record of this.registry.values()) {
      summaries.set(record.id, this.recordSummary(record));
    }

    for (const chat of this.chats.values()) {
      summaries.set(chat.id, this.chatSummary(chat));
    }

    let result = [...summaries.values()];

    if (filters.provider) {
      result = result.filter((chat) => chat.provider === filters.provider);
    }

    if (filters.cwd) {
      const cwd = resolveProjectRoot(filters.cwd);
      result = result.filter((chat) => chat.cwd === cwd);
    }

    if (filters.sessionId) {
      result = result.filter((chat) => chat.sessionId === filters.sessionId);
    }

    if (filters.query) {
      const query = String(filters.query).toLowerCase();
      result = result.filter((chat) =>
        [
          chat.provider,
          chat.providerLabel,
          chat.projectName,
          chat.title,
          chat.cwd,
          chat.sessionId,
          chat.status,
          chat.source,
          chat.model,
          chat.effort,
          chatConfigLabel(chat),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query),
      );
    }

    result = result
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    const limit = Number(filters.limit || 0);
    if (Number.isInteger(limit) && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  recordSummary(record) {
    return {
      id: record.id,
      provider: record.provider,
      providerLabel: record.providerLabel,
      providerIcon: resolvedAgentIcon(this.config, record.provider),
      cwd: record.cwd,
      projectName: record.projectName,
      title: record.title,
      status: "saved",
      statusDetail: record.statusDetail || "Saved ACP session",
      mode: record.mode || null,
      modes: null,
      availableCommands: [],
      configOptions: [],
      configValues: sanitizeConfigValues(record.configValues || {}),
      model: record.model || record.configValues?.model || null,
      effort: record.effort || record.configValues?.effort || record.configValues?.reasoning || null,
      pid: null,
      sessionId: record.sessionId,
      additionalDirectories: record.additionalDirectories || [],
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      usage: record.usage || null,
      plan: null,
      queued: 0,
      authMethods: [],
      mcpServers: [],
      active: false,
      source: record.source || "local",
    };
  }

  chatSummary(chat) {
    return {
      id: chat.id,
      provider: chat.provider,
      providerLabel: chat.providerLabel,
      providerIcon: resolvedAgentIcon(this.config, chat.provider),
      cwd: chat.cwd,
      projectName: chat.projectName,
      title: chat.title,
      status: chat.status,
      statusDetail: chat.statusDetail,
      mode: chat.mode,
      modes: chat.modes || null,
      availableCommands: chat.availableCommands || [],
      configOptions: chat.configOptions || [],
      configValues: selectedConfigValues(chat),
      model: chatModel(chat),
      effort: chatEffort(chat),
      pid: chat.pid,
      sessionId: chat.sessionId,
      additionalDirectories: chat.additionalDirectories || [],
      startedAt: chat.startedAt,
      updatedAt: chat.updatedAt,
      usage: chat.usage || null,
      plan: chat.plan || null,
      queued: chat.promptQueue?.length || 0,
      authMethods: chat.authMethods || [],
      mcpServers: chat.mcpServers || [],
      active: true,
      source: "active",
    };
  }

  buildState() {
    return {
      updatedAt: nowIso(),
      pid: process.pid,
      socket: SOCKET_PATH,
      chats: this.chatSummaries(),
    };
  }

  persistState() {
    // Mark dirty only; building chatSummaries() is expensive and this is called
    // on every streamed chunk/status change. Defer the build to the debounced flush.
    this.stateDirty = true;
    if (this.persistTimer) return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.stateDirty) return;
      this.stateDirty = false;
      this.latestState = this.buildState();
      fsp
        .writeFile(STATE_PATH, `${JSON.stringify(this.latestState, null, 2)}\n`, "utf8")
        .catch(() => {});
    }, 200);
  }

  shutdown() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (this.registryTimer) {
      clearTimeout(this.registryTimer);
      this.registryTimer = null;
      this.writeRegistryNow();
    }

    for (const timer of this.tmuxSyncTimers.values()) clearTimeout(timer);
    this.tmuxSyncTimers.clear();

    try {
      fs.writeFileSync(STATE_PATH, `${JSON.stringify(this.buildState(), null, 2)}\n`, "utf8");
    } catch {
      // Best effort on shutdown.
    }

    for (const chat of this.chats.values()) {
      this.cancelPendingPermissionsForChat(chat, "Daemon stopped");
      if (chat.process) chat.process.kill("SIGTERM");
    }

    for (const client of this.clients) {
      client.conn.send({ type: "event", event: "shutdown" });
      client.conn.close();
    }

    if (this.server) this.server.close();

    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Already gone.
    }

    try {
      fs.unlinkSync(PID_PATH);
    } catch {
      // Already gone.
    }

    process.exit(0);
  }
}

class HubRpcClient {
  constructor(conn) {
    this.conn = conn;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();
  }

  call(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.conn.send({ type: "request", id, method, params });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
  }

  handleMessage(message) {
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const handler of this.eventHandlers) {
      handler(message);
    }
  }

  close() {
    this.conn.close();
  }
}

// fzf-style filtering for interactive picker entries: every whitespace-
// separated word must appear in the entry's search text. Section headers
// (disabled entries) are dropped while a query is active so results read as a
// flat list.
function pickerFilterEntries(entries, query) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return entries;

  const words = text.split(/\s+/);
  return entries.filter((entry) => {
    if (entry.disabled) return false;
    const haystack = String(entry.searchText || stripAnsi(entry.label || "")).toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// Moves the picker selection by `delta`, skipping disabled section headers.
// Returns the new index, or the first selectable index when the current one is
// invalid; -1 when nothing is selectable.
function pickerNextIndex(entries, index, delta) {
  const selectable = entries.some((entry) => !entry.disabled);
  if (!selectable) return -1;

  if (index < 0 || index >= entries.length || entries[index]?.disabled) {
    return entries.findIndex((entry) => !entry.disabled);
  }

  let next = index;
  const step = delta >= 0 ? 1 : -1;
  let remaining = Math.abs(delta);
  while (remaining > 0) {
    let probe = next + step;
    while (probe >= 0 && probe < entries.length && entries[probe].disabled) probe += step;
    if (probe < 0 || probe >= entries.length) break;
    next = probe;
    remaining -= 1;
  }
  return next;
}

function pickerValueEquals(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

// Collects cursor movements and text into one atomic stdout write so tmux
// repaints each UI update as a single frame instead of flickering through
// intermediate states.
class FramePainter {
  constructor() {
    this.parts = [];
  }

  to(column, row) {
    this.parts.push(`\x1b[${row + 1};${column + 1}H`);
    return this;
  }

  clearLine() {
    this.parts.push("\x1b[2K");
    return this;
  }

  text(value) {
    if (value) this.parts.push(value);
    return this;
  }

  flush() {
    if (this.parts.length) process.stdout.write(this.parts.join(""));
    this.parts = [];
  }
}

class PopupUi {
  constructor(hub, config, cwd, mode, options = {}) {
    this.hub = hub;
    this.config = config;
    this.cwd = resolveProjectRoot(cwd || process.cwd());
    this.mode = mode;
    this.options = options;
    this.rl = null;
    this.currentChat = null;
    this.pendingPermission = null;
    this.closed = false;
    this.questionActive = false;
    this.currentPrompt = "";
    this.rawInput = null;
    this.lastRawInputLayout = null;
    this.lastRawScrollBottom = null;
    this.inputHistory = loadInputHistory();
    this.pendingAttachments = [];
    this.fileMentionCache = new Map();
    this.killRing = [];
    this.lastEscapeAt = 0;
    this.composerSpinnerFrame = 0;
    this.composerSpinnerTimer = null;
    this.chunkBuffer = "";
    this.chunkBufferMarkdown = false;
    this.chunkBufferDim = false;
    this.markdownFence = false;
    this.lastTmuxMetadataAt = 0;
    this.showInternalEvents = options.debug === true || process.env.VANZI_HUB_DEBUG_UI === "1";
    this.activityMode = process.env.VANZI_HUB_ACTIVITY || "compact";
    this.lastActivityGroup = "";
    this.activityGroupLineCount = 0;
    this.pendingResponseBreak = false;
    this.lastStreamEventKey = "";
    this.lastPlanSignature = "";
    this.transcriptLines = [""];
    this.scrollOffsetRows = 0;
    this.scrollNewRows = 0;
    this.mdHeldLine = null;
    this.liveTable = null;
    this.liveTablePaintTimer = null;
    this.liveTablePaintPending = false;
    this.activePicker = null;
    this.menuTextActive = false;
    this.menuFilters = {
      provider: "all",
      scope: "project",
      query: "",
      limit: 80,
    };

    this.hub.onEvent((message) => this.handleHubEvent(message));
  }

  async run() {
    try {
      let action;
      if (this.mode === "chat") {
        if (this.options.chatId) {
          try {
            action = await this.openChat(this.options.chatId);
          } catch (error) {
            // Stale window pointing at a deleted/broken chat: fall back to the
            // project's provider flow instead of dying with a stack trace.
            this.logLine(c("red", `✗ ${error.message || String(error)}`));
            const provider = this.options.agent || this.config.defaultAgent || "codex";
            action = await this.openProvider(provider, this.cwd);
          }
        } else if (this.options.newChat) {
          const provider = this.options.agent || this.config.defaultAgent || "codex";
          action = await this.newProvider(provider, this.cwd);
        } else {
          const provider = this.options.agent || this.config.defaultAgent || "codex";
          action = await this.openProvider(provider, this.cwd);
        }
      } else {
        action = await this.menuLoop();
      }

      while (action === "menu") {
        action = await this.menuLoop();
      }
    } finally {
      this.closed = true;
      this.flushChunkBuffer({ force: true });
      this.resetStreamRenderState();
      this.disableRawInputLayout();
      this.stopComposerSpinner();
      flushLocalInputStateSync();
      if (this.rl) this.rl.close();
      this.hub.close();
    }
  }

  printHeader() {
    this.logLine(c("bold", `tmux Vanzi Hub :: ${projectName(this.cwd)}`));
    this.logLine(c("dim", this.cwd));
    this.logLine("");
  }

  async menuLoop() {
    if (!this.pickerSupported()) return this.menuLoopText();

    for (;;) {
      let selection;
      try {
        selection = await this.runMenuPicker();
      } catch (error) {
        this.logLine(c("red", error.message || String(error)));
        return this.menuLoopText();
      }

      if (!selection) {
        // Esc/Ctrl+C: minimize the popup but keep this menu process alive so
        // the next prefix+M reattaches instantly (killing it raced the reopen
        // against a dying blank pane).
        this.closePopupClient();
        continue;
      }

      try {
        let action = "menu";
        if (selection.type === "chat") {
          action = await this.openChat(selection.chatId);
        } else if (selection.type === "new") {
          action = await this.newProvider(selection.provider, this.cwd);
        } else if (selection.type === "provider") {
          action = await this.openProvider(selection.provider, this.cwd);
        }
        if (action === "exit") return "exit";
      } catch (error) {
        this.notify(`vanzi-hub: ${error.message || String(error)}`);
      }
    }
  }

  async runMenuPicker() {
    this.menuFilters.query = "";
    const menu = await this.buildMenu();

    let watched = false;
    try {
      await this.hub.call("watch");
      watched = true;
    } catch {
      // Older daemon without watch support: menu still works, just not live.
    }

    let refreshTimer = null;
    const scheduleRefresh = (controls) => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(async () => {
        refreshTimer = null;
        try {
          const fresh = await this.buildMenu();
          const keep = controls.state.done
            ? null
            : pickerFilterEntries(controls.state.items, controls.state.query)[controls.state.index]?.value ?? null;
          controls.replaceItems(this.buildMenuPickerItems(fresh), keep);
        } catch {
          // Menu refresh is best effort.
        }
      }, 200);
      refreshTimer.unref?.();
    };

    try {
      return await this.interactivePick({
        title: `Vanzi Hub · ${projectName(this.cwd)}`,
        hint: "↑↓ move · type filters · Enter open · Tab scope · ^E rename · ^D delete · Esc close",
        emptyText: "No chats match — Esc clears the filter",
        items: this.buildMenuPickerItems(menu),
        onTab: async () => {
          this.menuFilters.scope = this.menuFilters.scope === "project" ? "all" : "project";
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onRefresh: async () => {
          await this.refreshSessions().catch(() => {});
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onRename: async (entry, title) => {
          if (entry.value?.type !== "chat") return null;
          try {
            await this.hub.call("rename_chat", { chatId: entry.value.chatId, title });
          } catch (error) {
            this.notify(`vanzi-hub: rename failed: ${error.message || String(error)}`);
          }
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onDelete: async (entry) => {
          if (entry.value?.type !== "chat") return null;
          try {
            await this.hub.call("delete_chat", { chatId: entry.value.chatId });
          } catch (error) {
            this.notify(`vanzi-hub: delete failed: ${error.message || String(error)}`);
          }
          return this.buildMenuPickerItems(await this.buildMenu());
        },
        onPreview: async (entry) => {
          const chatId = entry.value?.chatId;
          if (!chatId) return null;
          return this.hub.call("chat_preview", { chatId });
        },
        onEvent: (message, controls) => {
          if (message.type !== "chat_state" && message.type !== "chat_event") return;
          scheduleRefresh(controls);
        },
      });
    } finally {
      if (refreshTimer) clearTimeout(refreshTimer);
      if (watched) this.hub.call("unwatch").catch(() => {});
    }
  }

  buildMenuPickerItems(menu) {
    const items = [];
    const chats = menu.visibleChats;
    const local = chats.filter((chat) => chat.cwd === this.cwd);
    const remote = chats.filter((chat) => chat.cwd !== this.cwd);

    const chatEntry = (chat) => {
      const title = truncateText(cleanInline(chat.title || chat.id), 48);
      const meta = [formatRelativeAge(chat.updatedAt), chat.mode, chatConfigLabel(chat)]
        .filter(Boolean)
        .join(" · ");
      // Saved is the default state of every stored chat; showing it on each
      // row is noise. Status appears only for live chats.
      const status = chat.active ? `  ${statusIndicator(chat.status)}` : "";
      return {
        label: `${coloredProviderIcon(chat)} ${c("bold", title)}${status}${
          meta ? `  ${c("dim", meta)}` : ""
        }`,
        searchText: [
          chat.provider,
          chat.providerLabel,
          chat.projectName,
          chat.title,
          chat.status,
          chat.cwd,
          chat.sessionId,
        ]
          .filter(Boolean)
          .join(" "),
        value: { type: "chat", chatId: chat.id },
        canRename: true,
        canDelete: true,
        renameInitial: cleanInline(chat.title || ""),
      };
    };

    if (local.length) {
      items.push({ label: c("bold", `${projectName(this.cwd)} · current project`), disabled: true });
      for (const chat of local) items.push(chatEntry(chat));
    }

    items.push({ label: c("bold", "New chat"), disabled: true });
    for (const agent of menu.agents) {
      const isDefault = agent.id === this.config.defaultAgent;
      const icon = coloredProviderIcon({ provider: agent.id, providerIcon: agent.icon });
      items.push({
        label: `${icon} New ${agent.label || agent.id} chat${isDefault ? c("dim", " · default") : ""}`,
        searchText: `new ${agent.id} ${agent.label || ""}`,
        value: { type: "new", provider: agent.id },
      });
    }

    const groups = new Map();
    for (const chat of remote) {
      if (!groups.has(chat.projectName)) groups.set(chat.projectName, []);
      groups.get(chat.projectName).push(chat);
    }
    for (const [group, groupChats] of groups) {
      items.push({ label: c("bold", group), disabled: true });
      for (const chat of groupChats) items.push(chatEntry(chat));
    }

    if (this.menuFilters.scope === "project" && !remote.length) {
      items.push({ label: c("dim", "Tab shows chats from all projects"), disabled: true });
    }

    return items;
  }

  // The text menu keeps a plain readline prompt even when a chat was opened
  // earlier in this process (currentChat set); the flag scopes only the menu's
  // own prompt, never nested chat loops.
  async menuQuestion(prompt) {
    this.menuTextActive = true;
    try {
      return await this.question(prompt);
    } finally {
      this.menuTextActive = false;
    }
  }

  async menuLoopText() {
    for (;;) {
      const menu = await this.buildMenu();
      this.renderMenu(menu);
      const answer = (await this.menuQuestion("open> ")).trim();
      if (!answer) continue;
      if (["q", "quit", "exit", "/exit"].includes(answer)) {
        this.closePopupClient();
        return "exit";
      }
      if (answer === "/help" || answer === "help") {
        this.printMenuHelp();
        continue;
      }
      if (answer === "/refresh" || answer === "refresh") {
        await this.refreshSessions();
        continue;
      }
      if (answer === "/clear" || answer === "clear") {
        this.menuFilters = { provider: "all", scope: "project", query: "", limit: 80 };
        continue;
      }
      if (answer.startsWith("/q ") || answer.startsWith("?")) {
        this.menuFilters.query = answer.startsWith("?")
          ? answer.slice(1).trim()
          : answer.slice(3).trim();
        continue;
      }
      if (answer === "/q") {
        this.menuFilters.query = "";
        continue;
      }
      if (answer.startsWith("/p ") || answer.startsWith("/provider ")) {
        const provider = answer.split(/\s+/)[1] || "all";
        if (provider !== "all" && !this.config.agents?.[provider]) {
          this.logLine(c("yellow", `Unknown provider: ${provider}`));
          continue;
        }
        this.menuFilters.provider = provider;
        continue;
      }
      if (answer.startsWith("/s ") || answer.startsWith("/scope ")) {
        const scope = answer.split(/\s+/)[1] || "project";
        if (!["project", "all"].includes(scope)) {
          this.logLine(c("yellow", "Scope must be project or all"));
          continue;
        }
        this.menuFilters.scope = scope;
        continue;
      }
      if (answer.startsWith("/new ")) {
        const provider = answer.slice(5).trim();
        if (!this.config.agents?.[provider]) {
          this.logLine(c("yellow", `Unknown agent: ${provider}`));
          continue;
        }
        return this.newProvider(provider, this.cwd);
      }

      const agentByNumber = Number(answer);
      if (Number.isInteger(agentByNumber) && agentByNumber >= 1 && agentByNumber <= menu.agents.length) {
        const action = await this.openProvider(menu.agents[agentByNumber - 1].id, this.cwd);
        if (action === "exit") return action;
        continue;
      }

      if (answer.startsWith("c")) {
        const chatNumber = Number(answer.slice(1));
        if (Number.isInteger(chatNumber) && chatNumber >= 1 && chatNumber <= menu.visibleChats.length) {
          const action = await this.openChat(menu.visibleChats[chatNumber - 1].id);
          if (action === "exit") return action;
          continue;
        }
      }

      if (this.config.agents?.[answer]) {
        const action = await this.openProvider(answer, this.cwd);
        if (action === "exit") return action;
        continue;
      }

      this.logLine(c("yellow", "Unknown option"));
    }
  }

  async buildMenu() {
    const agents = (await this.hub.call("list_agents")).agents;
    const params = {
      limit: this.menuFilters.limit,
      query: this.menuFilters.query || undefined,
    };

    if (this.menuFilters.provider !== "all") {
      params.provider = this.menuFilters.provider;
    }

    if (this.menuFilters.scope === "project") {
      params.cwd = this.cwd;
    }

    const chats = (await this.hub.call("list_chats", params)).chats;
    return {
      agents,
      chats,
      visibleChats: this.orderChatsForDisplay(chats.slice(0, this.menuFilters.limit)),
    };
  }

  orderChatsForDisplay(chats) {
    return [...chats].sort((a, b) => {
      const currentProjectA = a.cwd === this.cwd ? 0 : 1;
      const currentProjectB = b.cwd === this.cwd ? 0 : 1;
      if (currentProjectA !== currentProjectB) return currentProjectA - currentProjectB;

      const groupA = `${a.projectName}\0${a.provider}`;
      const groupB = `${b.projectName}\0${b.provider}`;
      if (groupA !== groupB) return groupA.localeCompare(groupB);
      const rank = chatAttentionRank(a) - chatAttentionRank(b);
      if (rank !== 0) return rank;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
  }

  renderMenu(menu) {
    this.clearScreen();
    this.printHeader();
    this.logLine(
      `${c("bold", "Filters")} provider=${this.menuFilters.provider} scope=${this.menuFilters.scope} query=${
        this.menuFilters.query ? JSON.stringify(this.menuFilters.query) : "-"
      }`,
    );
    this.logLine("");
    this.logLine(c("bold", "Agents"));
    menu.agents.forEach((agent, index) => {
      const marker = agent.id === this.config.defaultAgent ? "*" : " ";
      this.logLine(`${index + 1}. ${marker} ${agent.id} - ${agent.label}`);
    });

    this.logLine("");
    this.logLine(c("bold", `Chats (${menu.visibleChats.length})`));
    if (!menu.visibleChats.length) {
      this.logLine(c("dim", "No chats match current filters"));
    } else {
      this.renderGroupedChats(menu.visibleChats);
    }

    this.logLine("");
    this.logLine(c("dim", "cN open | /q text | /p codex|claude|all | /s project|all | /new <agent> | /refresh | /help"));
  }

  renderGroupedChats(chats) {
    const groups = new Map();
    for (const chat of chats) {
      const group = chat.cwd === this.cwd ? `${chat.projectName} / current project` : chat.projectName;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(chat);
    }

    let index = 1;
    for (const [group, groupChats] of groups) {
      this.logLine(c("bold", group));

      for (const chat of groupChats) {
        const status = chat.active ? `  ${statusIndicator(chat.status)}` : "";
        const title = truncateText(cleanInline(chat.title || chat.id), 60);
        const meta = [formatRelativeAge(chat.updatedAt), chat.mode, chatConfigLabel(chat)]
          .filter(Boolean)
          .join(" · ");
        this.logLine(
          `  ${c("dim", `c${index}`)}  ${coloredProviderIcon(chat)} ${c("bold", title)}${status}${
            meta ? `  ${c("dim", meta)}` : ""
          }`,
        );
        index += 1;
      }
    }
  }

  printMenuHelp() {
    this.logLine("");
    this.logLine(c("bold", "Menu commands"));
    this.logLine("cN                  open chat number N");
    this.logLine("1..N                open default/current chat for an agent");
    this.logLine("/q text or ?text    filter by title, project, path, provider, session id");
    this.logLine("/q                  clear search text");
    this.logLine("/p provider         provider filter: codex, claude, all");
    this.logLine("/s scope            scope filter: project or all");
    this.logLine("/new <agent>        create a new ACP session");
    this.logLine("/refresh            import provider sessions with session/list");
    this.logLine("/clear              reset filters");
    this.logLine("/exit               close popup client");
  }

  providerLabelFor(provider) {
    return compactProviderLabel(this.config.agents?.[provider]?.label || provider);
  }

  async openProvider(provider, cwd) {
    const result = await this.withStartupIndicator(
      () => this.hub.call("ensure_chat", { provider, cwd }),
      this.providerLabelFor(provider),
    );
    return this.openChat(result.id);
  }

  async newProvider(provider, cwd) {
    const result = await this.withStartupIndicator(
      () => this.hub.call("new_chat", { provider, cwd }),
      this.providerLabelFor(provider),
    );
    return this.openChat(result.id);
  }

  async withStartupIndicator(fn, label = "") {
    const promise = Promise.resolve().then(fn);
    if (!process.stdout.isTTY) return promise;

    const target = label ? `Connecting to ${c("bold", label)}…` : "Connecting…";
    let shown = false;
    let frame = 0;

    // Single-line spinner instead of wiping the screen: on the last row of the
    // pinned output region when the composer layout is active, otherwise in
    // place on the current line.
    const spinnerRow = () => (this.canPaintPinned() ? this.pinnedOutputRows() - 1 : null);
    const render = () => {
      shown = true;
      const glyph = COMPOSER_SPINNER_FRAMES[frame++ % COMPOSER_SPINNER_FRAMES.length];
      const line = `  ${c("cyan", glyph)} ${target}`;
      const row = spinnerRow();
      const painter = new FramePainter();
      if (row !== null) painter.to(0, row);
      else painter.text("\r");
      painter.clearLine().text(line);
      painter.flush();
    };
    // Only surface the indicator when the call is actually slow (adapter spawn),
    // so fast already-running chats don't flash a connecting line.
    const delay = setTimeout(render, 150);
    const timer = setInterval(() => {
      if (shown) render();
    }, COMPOSER_SPINNER_INTERVAL_MS);
    timer.unref?.();

    try {
      return await promise;
    } finally {
      clearTimeout(delay);
      clearInterval(timer);
      if (shown) {
        const row = spinnerRow();
        const painter = new FramePainter();
        if (row !== null) painter.to(0, row);
        else painter.text("\r");
        painter.clearLine();
        painter.flush();
      }
    }
  }

  async openChat(chatId) {
    if (this.currentChat?.id) {
      await this.hub.call("unsubscribe", { chatId: this.currentChat.id }).catch(() => {});
    }

    const result = await this.withStartupIndicator(() =>
      this.hub.call("subscribe", { chatId }),
    );
    this.currentChat = result.chat;
    this.pendingPermission = null;
    this.syncTmuxWindow(this.currentChat, { force: true });

    this.disableRawInputLayout();
    this.markdownFence = false;
    this.lastActivityGroup = "";
    this.activityGroupLineCount = 0;
    this.lastPlanSignature = "";
    this.resetStreamRenderState();
    this.clearScreen();
    this.resetTranscriptBuffer();
    this.printChatTitle(this.currentChat);

    this.renderHistory(result.history || []);
    this.flushChunkBuffer({ force: true });

    this.pendingPermission = result.pendingPermission || null;
    if (this.pendingPermission) {
      this.logLine(
        `${c("yellow", "▎")} ${c("yellow", "⏸ Pending permission request")}  ${c("dim", "/allow <n> · /deny")}`,
      );
    }

    return this.chatLoop();
  }

  renderHistory(events) {
    let pendingChunk = null;

    const flushPendingChunk = () => {
      if (!pendingChunk) return;
      this.renderEvent(pendingChunk, { replay: true });
      pendingChunk = null;
    };

    for (const event of events) {
      if (event.type === "agent_chunk" || event.type === "thought_chunk") {
        if (
          pendingChunk &&
          pendingChunk.type === event.type &&
          (pendingChunk.messageId || null) === (event.messageId || null)
        ) {
          pendingChunk.text = `${pendingChunk.text || ""}${event.text || ""}`;
        } else {
          flushPendingChunk();
          pendingChunk = { ...event };
        }
        continue;
      }

      flushPendingChunk();
      this.renderEvent(event, { replay: true });
    }

    flushPendingChunk();
  }

  printChatTitle(chat) {
    const dot = c("dim", "·");
    const title = chat.title && chat.title !== chat.id ? cleanInline(chat.title) : "";
    const status =
      chat.status && chat.status !== "idle" ? c(statusColorName(chat.status), chat.status) : "";
    const parts = [
      `${coloredProviderIcon(chat)} ${coloredProviderLabel(chat)}`,
      c("bold", chat.projectName),
      title ? c("bold", title) : "",
      chat.mode ? c("dim", chat.mode) : "",
      status,
    ].filter(Boolean);
    this.logLine(parts.join(` ${dot} `), { recordTranscript: false });
    if (this.showInternalEvents) this.logLine(c("dim", chat.cwd), { recordTranscript: false });
    this.logLine("", { recordTranscript: false });
  }

  async chatLoop() {
    try {
      for (;;) {
        const prompt = this.inputPrompt();
        const line = (await this.question(prompt, { draft: true })).trim();

        if (!line) {
          if (this.pendingAttachments.length) await this.sendAgentText("");
          continue;
        }
        if (this.attachPathInput(line)) continue;
        if (line.startsWith("//")) {
          await this.sendAgentText(line.slice(1));
          continue;
        }
        if (line.startsWith("/agent ")) {
          await this.sendAgentText(line.slice(7).trim());
          continue;
        }
        if (line === "/exit" || line === "/quit") {
          this.closePopupClient();
          return "exit";
        }
        if (line === "/menu") {
          if (await this.showAgentMenu()) continue;
          return "menu";
        }
        if (line === "/chats") {
          if (await this.showChatsPicker()) continue;
          if (await this.showChatsMenu()) continue;
          await this.printChats();
          continue;
        }
        if (line === "/refresh") {
          await this.refreshSessions();
          continue;
        }
        if (line === "/control" || line === "/cmd" || line === "/panel") {
          if (this.showCommandCenterPanel()) continue;
          this.printHelp();
          continue;
        }
        if (line === "/config" || line.startsWith("/config ")) {
          const handled = await this.handleConfigCommand(line);
          if (!handled && this.showConfigPanel()) continue;
          if (!handled) this.textFallback("ACP config menu unavailable", () => this.printConfig());
          continue;
        }
        if (line === "/commands") {
          if (this.showProviderCommandsPanel()) continue;
          this.textFallback("Provider commands menu unavailable", () => this.printProviderCommands());
          continue;
        }
        if (line === "/modes" || line === "/mode") {
          if (await this.showModesPicker()) continue;
          if (this.showModesPanel()) continue;
          this.textFallback("ACP modes menu unavailable", () => this.printModes());
          continue;
        }
        if (line.startsWith("/mode ")) {
          await this.applyMode(line.slice(6).trim());
          continue;
        }
        if (line === "/access" || line === "/permissions") {
          if (await this.showAccessPicker()) continue;
          if (this.showAccessPanel()) continue;
          this.textFallback("Access menu unavailable", () => this.printAccessHelp());
          continue;
        }
        if (line.startsWith("/access ") || line.startsWith("/permissions ")) {
          await this.applyAccess(line.replace(/^\/(?:access|permissions)\s+/, "").trim());
          continue;
        }
        if (line === "/roots" || line.startsWith("/roots ")) {
          await this.handleRootsCommand(line);
          continue;
        }
        if (line === "/attach" || line.startsWith("/attach ")) {
          await this.handleAttachCommand(line);
          continue;
        }
        if (line === "/attachments" || line === "/files") {
          this.printAttachments();
          continue;
        }
        if (line === "/detach" || line.startsWith("/detach ")) {
          this.detachAttachments(line);
          continue;
        }
        if (line === "/model") {
          if (await this.showConfigOptionPicker("model", "Model")) continue;
          if (this.showConfigOptionPanel("model", "ACP Model")) continue;
          this.textFallback("ACP model menu unavailable", () => this.printConfigOption("model"));
          continue;
        }
        if (line.startsWith("/model ")) {
          await this.handleShortcutConfigCommand("model", line.slice(6).trim());
          continue;
        }
        if (line === "/effort") {
          if (await this.showConfigOptionPicker("effort", "Effort")) continue;
          if (this.showConfigOptionPanel("effort", "ACP Effort")) continue;
          this.textFallback("ACP effort menu unavailable", () => this.printConfigOption("effort"));
          continue;
        }
        if (line.startsWith("/effort ")) {
          await this.handleShortcutConfigCommand("effort", line.slice(7).trim());
          continue;
        }
        if (line.startsWith("/new ")) {
          const provider = line.slice(5).trim();
          if (!this.config.agents?.[provider]) {
            this.logLine(c("yellow", `Unknown agent: ${provider}`));
            continue;
          }
          return this.newProvider(provider, this.cwd);
        }
        if (line === "/cancel") {
          await this.hub.call("cancel", { chatId: this.currentChat.id }).catch((error) => {
            this.logLine(c("red", error.message));
          });
          continue;
        }
        if (line === "/plan") {
          if (this.showPlanPanel()) continue;
          this.showPlan();
          continue;
        }
        if (line === "/auth") {
          if (this.showAuthPanel()) continue;
          this.printAuthMethods();
          continue;
        }
        if (line.startsWith("/auth ")) {
          await this.authenticateCurrentChat(line.slice(6).trim());
          continue;
        }
        if (line === "/mcp") {
          if (this.showMcpPanel()) continue;
          this.printMcpServers();
          continue;
        }
        if (line.startsWith("/allow")) {
          await this.answerPermission(line, "allow");
          continue;
        }
        if (line === "/deny" || line.startsWith("/deny ")) {
          await this.answerPermission(line, "deny");
          continue;
        }
        if (line.startsWith("/rename ") || line.startsWith("/title ")) {
          await this.renameCurrentChat(line.replace(/^\/(?:rename|title)\s+/, ""));
          continue;
        }
        if (line === "/close") {
          await this.hub.call("close_chat", { chatId: this.currentChat.id });
          return "menu";
        }
        if (line === "/delete") {
          if (await this.deleteCurrentChat()) return "menu";
          continue;
        }
        if (line === "/help") {
          if (this.showCommandCenterPanel()) continue;
          this.printHelp();
          continue;
        }
        if (line === "/compose" || line === "/multiline") {
          const composed = await this.composeInput();
          if (composed) await this.sendAgentText(composed);
          continue;
        }
        if (line === "/edit" || line === "/editor") {
          const edited = await this.editorInput();
          if (edited) await this.sendAgentText(edited);
          continue;
        }
        if (line === "/debug") {
          this.showInternalEvents = !this.showInternalEvents;
          this.notify(`vanzi-hub debug UI ${this.showInternalEvents ? "on" : "off"}`);
          continue;
        }
        if (line === "/activity" || line.startsWith("/activity ")) {
          this.setActivityMode(line);
          continue;
        }

        await this.sendAgentText(line);
      }
    } finally {
      this.disableRawInputLayout();
    }
  }

  inputPrompt() {
    const chat = this.currentChat || {};
    const provider = truncateText(chat.provider || "agent", 12);
    const project = truncateText(chat.projectName || projectName(this.cwd), 28);
    const status = chat.status && chat.status !== "idle" ? ` ${chat.status}` : "";
    const mode = chat.mode ? ` [${truncateText(chat.mode, 12)}]` : "";
    return `${provider}:${project}${status}${mode}> `;
  }

  async composeInput() {
    this.logLine(c("dim", "compose mode: finish with a single '.'; cancel with /cancel"));
    const lines = [];

    for (;;) {
      const prompt = lines.length ? "... " : ">>> ";
      const line = await this.question(prompt);
      const trimmed = line.trim();

      if (trimmed === ".") break;
      if (trimmed === "/cancel") {
        this.notify("compose cancelled");
        return "";
      }

      lines.push(line);
    }

    return lines.join("\n").trim();
  }

  async editorInput() {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tmux-vanzi-hub-prompt-"));
    const filePath = path.join(tempDir, "prompt.md");

    try {
      await fsp.writeFile(filePath, "", "utf8");
      this.notify(`opening ${editor}; save and quit to send, leave empty to cancel`);

      const result = spawnSync("sh", ["-lc", `${editor} ${shellQuote(filePath)}`], {
        stdio: "inherit",
      });

      if (result.error) {
        this.logLine(c("red", result.error.message));
        return "";
      }

      if (result.status) {
        this.notify("editor cancelled");
        return "";
      }

      return (await fsp.readFile(filePath, "utf8")).trim();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async sendAgentText(text) {
    const cleanText = String(text || "").trim();
    const attachments = this.pendingAttachments;
    if (!cleanText && !attachments.length) return;

    try {
      const result = await this.hub.call("send_prompt", {
        chatId: this.currentChat.id,
        text: cleanText,
        attachments,
      });
      if (result?.queued) {
        this.notify(`queued (${result.queueLength} pending) — sends when the current turn finishes`);
      }
      this.pendingAttachments = [];
      this.refreshRawInputPrompt();
    } catch (error) {
      this.logLine(c("red", error.message));
    }
  }

  attachPathInput(text) {
    const attachments = attachmentsFromPathOnlyText(text, this.currentChat?.cwd || this.cwd);
    if (!attachments.length) return false;

    const added = this.addPendingAttachments(attachments);
    this.refreshRawInputPrompt();
    this.notifyAttachmentResult(added, attachments.length, "path");
    return true;
  }

  addPendingAttachments(attachments) {
    const added = [];
    for (const attachment of attachments || []) {
      if (!attachment?.path) continue;
      const exists = this.pendingAttachments.some((item) => item.path === attachment.path);
      if (exists) continue;
      this.pendingAttachments.push(attachment);
      added.push(attachment);
    }
    return added;
  }

  notifyAttachmentResult(added, requested, source = "attach") {
    if (added.length) {
      const imageCount = added.filter((attachment) => attachment.kind === "image").length;
      const fileCount = added.length - imageCount;
      const parts = [
        imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "",
        fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      this.notify(`attached ${parts.join(", ")} from ${source}; Enter sends`);
      return;
    }

    this.notify(`${requested} file${requested === 1 ? "" : "s"} already attached`);
  }

  async renameCurrentChat(title) {
    const cleanTitle = cleanInline(title);
    if (!cleanTitle) {
      this.notify("usage: /rename <title>");
      return;
    }

    const chat = await this.hub.call("rename_chat", {
      chatId: this.currentChat.id,
      title: cleanTitle,
    });
    this.currentChat = chat;
    this.syncTmuxWindow(this.currentChat, { force: true });
    this.notify(`renamed: ${cleanTitle}`);
  }

  async deleteCurrentChat() {
    const chatId = this.currentChat?.id;
    if (!chatId) return false;

    const answer = (await this.question("Delete this chat permanently? (y/N) ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      this.notify("delete cancelled");
      return false;
    }

    try {
      const result = await this.hub.call("delete_chat", { chatId });
      this.notify(
        result.providerDeleted
          ? "chat deleted"
          : "chat removed locally (provider keeps the saved session)",
      );
      return true;
    } catch (error) {
      this.logLine(c("red", `Delete failed: ${error.message}`));
      return false;
    }
  }

  async printChats() {
    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    if (!chats.length) {
      this.logLine(c("dim", "No chats yet"));
      return;
    }

    this.renderGroupedChats(this.orderChatsForDisplay(chats));
  }

  printHelp() {
    this.logLine("/menu              open agent/chat menu");
    this.logLine("/control           open tmux command center");
    this.logLine("/chats             list daemon chats");
    this.logLine("/compose           write a multiline prompt; finish with a single .");
    this.logLine("/edit              write a prompt in $VISUAL or $EDITOR");
    this.logLine("/new <agent>       create a new provider chat for this project");
    this.logLine("/refresh           discover saved ACP sessions from providers");
    this.logLine("/config [id value] show or set ACP session config options");
    this.logLine("/model <value>     set model config option when available");
    this.logLine("/effort <value>    set effort/reasoning config when available");
    this.logLine("/commands          show provider commands reported by ACP");
    this.logLine("/modes             show ACP modes reported by the provider");
    this.logLine("/mode <value>      set ACP session mode");
    this.logLine("/access <profile>  set read-only/agent/full/plan/auto access alias");
    this.logLine("/roots             show additional workspace directories");
    this.logLine("/roots add <path>  add an extra workspace directory for next restore");
    this.logLine("/attach <path>     attach file(s) to the next prompt");
    this.logLine("/attachments       show pending prompt attachments");
    this.logLine("/detach <n>|all    remove pending prompt attachments");
    this.logLine("@file              mention and attach a project file; Tab completes");
    this.logLine("//command          send a slash command directly to the provider");
    this.logLine("/agent <text>      send raw text directly to the provider");
    this.logLine("/cancel            cancel current ACP turn");
    this.logLine("/allow <n>         choose a pending permission option");
    this.logLine("/deny              reject or cancel a pending permission");
    this.logLine("/rename <title>    rename this chat for menus/search");
    this.logLine("/close             close this chat and stop its ACP adapter");
    this.logLine("/activity <mode>   tool activity: compact, hidden, debug");
    this.logLine("/debug             toggle internal Vanzi hub logs in the chat pane");
    this.logLine("/exit              close popup client only");
  }

  printConfig() {
    const chat = this.currentChat || {};
    this.logLine("");
    this.logLine(c("bold", "ACP Config"));
    this.logLine(`provider           ${chat.providerLabel || chat.provider}`);
    this.logLine(`mode               ${chat.mode || "-"}`);

    const options = chat.configOptions || [];
    if (!options.length) {
      this.logLine(c("dim", "No config options reported by this adapter yet."));
      return;
    }

    for (const option of options) {
      this.logLine(formatConfigOption(option));
    }
  }

  async handleConfigCommand(line) {
    const rest = line === "/config" ? "" : line.slice(8).trim();
    if (!rest) return false;

    const parts = splitCommandWords(rest);
    const configId = parts.shift() || "";
    const value = parts.join(" ").trim();

    if (!configId) return false;
    if (!value) {
      if (this.showConfigOptionPanel(configId)) return true;
      this.textFallback("ACP config option menu unavailable", () => this.printConfigOption(configId));
      return true;
    }

    await this.applyConfigOption(configId, value);
    return true;
  }

  async handleShortcutConfigCommand(configId, value) {
    if (!value) {
      if (this.showConfigOptionPanel(configId)) return;
      this.textFallback("ACP config option menu unavailable", () => this.printConfigOption(configId));
      return;
    }

    await this.applyConfigOption(configId, value);
  }

  printConfigOption(configId) {
    const option = resolveConfigOption(this.currentChat?.configOptions || [], configId);
    this.logLine("");

    if (!option) {
      this.logLine(c("yellow", `No ACP config option found for ${configId}.`));
      this.logLine(c("dim", "Use /config to inspect the options reported by this adapter."));
      return;
    }

    const id = configOptionId(option);
    this.logLine(c("bold", `ACP Config: ${id}`));
    this.logLine(formatConfigOption(option));

    const values = configOptionValues(option);
    if (!values.length && !isBooleanConfigOption(option)) {
      this.logLine(c("dim", `Use /config ${id} <value>.`));
      return;
    }

    if (isBooleanConfigOption(option)) {
      this.logLine(`${c("dim", "values")} true, false`);
      return;
    }

    this.logLine(c("dim", "values"));
    for (const entry of values.slice(0, 80)) {
      const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
      const label = entry.label && entry.label !== entry.value ? ` ${c("dim", entry.label)}` : "";
      this.logLine(`${marker} ${entry.value}${label}`);
    }
  }

  async applyConfigOption(configId, value) {
    if (!this.currentChat?.id) return;

    try {
      const result = await this.hub.call("set_config_option", {
        chatId: this.currentChat.id,
        configId,
        value,
      });
      this.currentChat = result.chat || this.currentChat;
      this.syncTmuxWindow(this.currentChat, { force: true });
      this.refreshRawInputPrompt();
      this.notify(`ACP config ${result.configId || configId}=${valueLabel(result.value) || value}`);
    } catch (error) {
      this.logLine(c("red", error.message || String(error)));
      if (this.showConfigOptionPanel(configId)) return;
      this.textFallback("ACP config options unavailable", () => this.printConfigOption(configId));
    }
  }

  async applyMode(modeId) {
    if (!modeId) {
      this.printModes();
      return;
    }
    if (!this.currentChat?.id) return;

    try {
      const result = await this.hub.call("set_mode", {
        chatId: this.currentChat.id,
        modeId,
      });
      this.currentChat = result.chat || this.currentChat;
      this.syncTmuxWindow(this.currentChat, { force: true });
      this.refreshRawInputPrompt();
      this.notify(`ACP mode=${result.modeId || modeId}`);
    } catch (error) {
      this.logLine(c("red", error.message || String(error)));
      if (this.showModesPanel()) return;
      this.textFallback("ACP modes menu unavailable", () => this.printModes());
    }
  }

  printAccessHelp() {
    this.logLine("");
    this.logLine(c("bold", "Access / Permission Modes"));
    this.logLine(`provider           ${this.currentChat?.providerLabel || this.currentChat?.provider || "-"}`);
    this.logLine(`current            ${this.currentChat?.mode || "-"}`);
    this.logLine("");
    this.logLine("/access read-only  read/plan mode when available");
    this.logLine("/access agent      normal/default agent mode");
    this.logLine("/access full       bypass/don't-ask/full access when available");
    this.logLine("/access plan       planning mode when available");
    this.logLine("/access auto       provider auto permission mode when available");
    this.logLine("");
    this.printModes();
  }

  async applyAccess(value) {
    if (!value) {
      this.printAccessHelp();
      return;
    }

    const target = resolveAccessTarget(this.currentChat, value);
    if (!target) {
      this.logLine(c("yellow", `No access mode matching ${value}.`));
      if (this.showAccessPanel()) return;
      this.textFallback("Access menu unavailable", () => this.printAccessHelp());
      return;
    }

    if (target.kind === "mode") {
      await this.applyMode(target.value);
    } else {
      await this.applyConfigOption(target.configId, target.value);
    }
  }

  async handleRootsCommand(line) {
    const rest = line === "/roots" ? "" : line.slice(7).trim();
    const parts = splitCommandWords(rest);
    const action = parts.shift() || "list";

    if (["list", "ls", "show"].includes(action)) {
      if (this.showRootsPanel()) return;
      this.textFallback("Workspace roots panel unavailable", () => this.printRoots());
      return;
    }

    if (["add", "+", "remove", "rm", "delete", "del", "clear"].includes(action)) {
      await this.updateRoots(action, parts);
      return;
    }

    this.logLine(c("yellow", "Usage: /roots, /roots add <path>, /roots remove <path>, /roots clear"));
  }

  printRoots() {
    const chat = this.currentChat || {};
    const roots = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || this.cwd);
    this.logLine("");
    this.logLine(c("bold", "Workspace Roots"));
    this.logLine(`main               ${displayPath(chat.cwd || this.cwd)}`);
    if (!roots.length) {
      this.logLine(c("dim", "No additional directories configured."));
      this.logLine(c("dim", "Use /roots add <path>; active sessions apply changes after /close and reopen."));
      return;
    }

    roots.forEach((root, index) => {
      this.logLine(`${index + 1}. ${displayPath(root)}`);
    });
  }

  async updateRoots(action, args) {
    if (!this.currentChat?.id) return;

    const current = normalizeAdditionalDirectories(
      this.currentChat.additionalDirectories || [],
      this.currentChat.cwd || this.cwd,
    );
    let next = current;

    if (action === "clear") {
      next = [];
    } else if (["add", "+"].includes(action)) {
      if (!args.length) {
        this.logLine(c("yellow", "Usage: /roots add <path>"));
        return;
      }
      next = normalizeAdditionalDirectories([...current, args.join(" ")], this.currentChat.cwd || this.cwd);
    } else {
      if (!args.length) {
        this.logLine(c("yellow", "Usage: /roots remove <path-or-number>"));
        return;
      }
      const query = args.join(" ");
      const number = Number(query);
      if (Number.isInteger(number) && number >= 1 && number <= current.length) {
        next = current.filter((_, index) => index !== number - 1);
      } else {
        const resolved = normalizeAdditionalDirectories([query], this.currentChat.cwd || this.cwd)[0];
        next = current.filter((root) => root !== resolved);
      }
    }

    const result = await this.hub.call("set_roots", {
      chatId: this.currentChat.id,
      additionalDirectories: next,
    });
    this.currentChat = result.chat || this.currentChat;
    this.syncTmuxWindow(this.currentChat, { force: true });
    if (this.tmuxPane() && !this.showInternalEvents) {
      this.notify(`workspace roots saved${result.requiresRestart ? "; restart adapter to apply" : ""}`);
    } else {
      this.printRoots();
      if (result.requiresRestart) {
        this.logLine(c("dim", "Root changes are saved; use /close and reopen this chat to pass them to ACP."));
      }
    }
  }

  async handleAttachCommand(line) {
    const rest = line === "/attach" ? "" : line.slice(8).trim();
    const files = splitCommandWords(rest);

    if (!files.length) {
      this.notify("usage: /attach <path> [path...]");
      return;
    }

    const added = [];
    for (const file of files) {
      try {
        const attachment = await resolvePromptAttachment(file, this.currentChat?.cwd || this.cwd);
        const exists = this.pendingAttachments.some((item) => item.path === attachment.path);
        if (!exists) {
          this.pendingAttachments.push(attachment);
          added.push(attachment);
        }
      } catch (error) {
        this.logLine(c("red", `attach failed: ${file}: ${error.message || String(error)}`));
      }
    }

    if (added.length) {
      this.notify(`attached ${added.length} file(s) for next prompt`);
      this.refreshRawInputPrompt();
    }
  }

  printAttachments() {
    this.logLine("");
    this.logLine(c("bold", "Pending Attachments"));
    if (!this.pendingAttachments.length) {
      this.logLine(c("dim", "No files attached. Use /attach <path>."));
      return;
    }

    this.pendingAttachments.forEach((attachment, index) => {
      this.logLine(
        `${attachmentChip(attachment, index)} ${c("dim", attachment.mimeType)} ${c(
          "dim",
          formatBytes(attachment.size),
        )} ${c(
          "dim",
          displayPath(attachment.path),
        )}`,
      );
    });
    this.logLine(c("dim", "Use /detach <n>, /detach last, or /detach all to remove pending attachments."));
  }

  detachAttachments(line) {
    const rest = line === "/detach" ? "all" : line.slice(8).trim();
    if (!this.pendingAttachments.length) {
      this.notify("no pending attachments");
      return;
    }

    if (!rest || rest === "all" || rest === "clear") {
      const count = this.pendingAttachments.length;
      this.pendingAttachments = [];
      this.notify(`detached ${count} file(s)`);
      this.refreshRawInputPrompt();
      return;
    }

    if (["last", "-1"].includes(rest)) {
      const removed = this.pendingAttachments.pop();
      this.notify(`detached ${removed.name}`);
      this.refreshRawInputPrompt();
      return;
    }

    const number = Number(rest);
    if (!Number.isInteger(number) || number < 1 || number > this.pendingAttachments.length) {
      this.notify("usage: /detach <n>|last|all");
      return;
    }

    const [removed] = this.pendingAttachments.splice(number - 1, 1);
    this.notify(`detached ${removed.name}`);
    this.refreshRawInputPrompt();
  }

  detachLastAttachmentFromComposer(session) {
    const removed = this.pendingAttachments.pop();
    if (!removed) return;
    session.lastPasteSummary = `removed ${removed.name || path.basename(removed.path || "") || "attachment"}`;
    this.refreshRawInputPrompt({ render: false });
  }

  printProviderCommands() {
    const commands = this.currentChat?.availableCommands || [];
    this.logLine("");
    this.logLine(c("bold", "Provider Commands"));

    if (!commands.length) {
      this.logLine(c("dim", "No provider commands reported by ACP yet."));
      this.logLine(c("dim", "Provider slash commands can still be sent with //command."));
      return;
    }

    for (const command of commands) {
      this.logLine(formatProviderCommand(command));
    }

    this.logLine(c("dim", "Use //command or /agent <text> to send provider-specific slash commands."));
  }

  printModes() {
    const modes = this.currentChat?.modes || null;
    this.logLine("");
    this.logLine(c("bold", "ACP Modes"));
    this.logLine(`current            ${this.currentChat?.mode || "-"}`);

    if (!modes) {
      this.logLine(c("dim", "No modes reported by this adapter yet."));
      return;
    }

    const entries = modes.availableModes || modes.modes || modes.options || [];
    if (!Array.isArray(entries) || !entries.length) {
      this.logLine(c("dim", JSON.stringify(modes)));
      return;
    }

    for (const mode of entries) {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      const marker = id === this.currentChat?.mode ? "*" : " ";
      this.logLine(`${marker} ${id} ${c("dim", label === id ? "" : label)}`);
    }
  }

  async showAgentMenu() {
    if (!this.tmuxPane()) return false;

    try {
      await runTmuxMenu({
        cwd: this.cwd,
        session: this.tmuxFormat("#{session_name}"),
        client: this.tmuxFormat("#{client_name}"),
        pane: this.tmuxPane(),
      });
      return true;
    } catch (error) {
      this.notify(`vanzi-hub menu failed: ${error.message || String(error)}`);
      return false;
    }
  }

  async buildChatsPickerItems() {
    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    const visibleChats = this.orderChatsForDisplay(chats).slice(0, 40);

    const items = [];
    let currentGroup = "";
    for (const chat of visibleChats) {
      const group =
        chat.cwd === this.cwd ? `${chat.projectName} · current project` : chat.projectName;
      if (group !== currentGroup) {
        items.push({ label: c("bold", group), disabled: true });
        currentGroup = group;
      }

      const isCurrent = chat.id === this.currentChat?.id;
      const title = truncateText(cleanInline(chat.title || chat.id), 44);
      const meta = [formatRelativeAge(chat.updatedAt), chat.mode, chatConfigLabel(chat)]
        .filter(Boolean)
        .join(" · ");
      const status = chat.active ? `  ${statusIndicator(chat.status)}` : "";
      items.push({
        label: `${coloredProviderIcon(chat)} ${c("bold", title)}${status}${
          meta ? `  ${c("dim", meta)}` : ""
        }`,
        searchText: [chat.provider, chat.projectName, chat.title, chat.status, chat.cwd]
          .filter(Boolean)
          .join(" "),
        current: isCurrent,
        canRename: true,
        // The open chat is deleted with /delete (it needs the return-to-menu
        // flow); everything else can be pruned right from the list.
        canDelete: !isCurrent,
        renameInitial: cleanInline(chat.title || ""),
        value: { cwd: chat.cwd, provider: chat.provider, chatId: chat.id },
      });
    }

    return items;
  }

  async showChatsPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const items = await this.buildChatsPickerItems();
    if (!items.length) return false;

    const picked = await this.interactivePick({
      title: "ACP Chats",
      hint: "↑↓ move · type filters · Enter switch · ^E rename · ^D delete · Esc cancel",
      items,
      onRename: async (entry, title) => {
        try {
          await this.hub.call("rename_chat", { chatId: entry.value.chatId, title });
          if (entry.value.chatId === this.currentChat?.id) {
            this.currentChat = { ...this.currentChat, title };
            this.syncTmuxWindow(this.currentChat, { force: true });
          }
        } catch (error) {
          this.notify(`vanzi-hub: rename failed: ${error.message || String(error)}`);
        }
        return this.buildChatsPickerItems();
      },
      onDelete: async (entry) => {
        try {
          await this.hub.call("delete_chat", { chatId: entry.value.chatId });
        } catch (error) {
          this.notify(`vanzi-hub: delete failed: ${error.message || String(error)}`);
        }
        return this.buildChatsPickerItems();
      },
      onPreview: async (entry) => {
        const chatId = entry.value?.chatId;
        if (!chatId) return null;
        return this.hub.call("chat_preview", { chatId });
      },
    });

    if (picked && picked.chatId !== this.currentChat?.id) {
      this.switchToChatWindow(picked);
    }
    return true;
  }

  // Switching chats means selecting (or creating) that chat's tmux window;
  // workspace.sh owns that logic, so run it through tmux.
  switchToChatWindow({ cwd, provider, chatId }) {
    const command = tmuxWorkspaceShellCommand(cwd, this.tmuxContext(), provider, chatId, "open");
    try {
      const child = spawn("tmux", ["run-shell", command], { stdio: "ignore" });
      child.on("error", () => {});
      child.unref?.();
    } catch {
      this.notify("vanzi-hub: failed to switch chat window");
    }
  }

  async showConfigOptionPicker(configId, title) {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const option = resolveConfigOption(this.currentChat?.configOptions || [], configId);
    if (!option) return false;

    const id = configOptionId(option);
    const values = configOptionMenuValues(option);
    if (!values.length) return false;

    const items = values.map((entry) => ({
      label: `${entry.value}${
        entry.label && entry.label !== entry.value ? c("dim", ` · ${entry.label}`) : ""
      }`,
      searchText: `${entry.value} ${entry.label || ""}`,
      current: configOptionValueMatches(option, entry.value),
      value: entry.value,
    }));

    const picked = await this.interactivePick({
      title: `${title} · ${this.currentChat?.providerLabel || this.currentChat?.provider || ""}`,
      hint: "↑↓ move · Enter apply · Esc cancel",
      items,
    });

    if (picked !== null) await this.applyConfigOption(id, picked);
    return true;
  }

  async showModesPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const modes = modeEntries(this.currentChat?.modes);
    if (!modes.length) return false;

    const items = modes.map((mode) => {
      const id = mode.id || mode.modeId || mode.name || String(mode);
      const label = mode.label || mode.title || mode.name || id;
      return {
        label: `${id}${label === id ? "" : c("dim", ` · ${label}`)}`,
        searchText: `${id} ${label}`,
        current: id === this.currentChat?.mode,
        value: id,
      };
    });

    const picked = await this.interactivePick({
      title: `Mode · ${this.currentChat?.providerLabel || this.currentChat?.provider || ""}`,
      hint: "↑↓ move · Enter apply · Esc cancel",
      items,
    });

    if (picked !== null) await this.applyMode(picked);
    return true;
  }

  async showAccessPicker() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const chat = this.currentChat;
    if (!chat) return false;

    const profiles = [
      ["read-only", "Read-only / plan"],
      ["agent", "Agent / default"],
      ["full", "Full access / don't ask"],
      ["plan", "Plan"],
      ["auto", "Auto"],
    ];

    const items = [];
    for (const [profile, label] of profiles) {
      const target = resolveAccessTarget(chat, profile);
      if (!target) continue;
      const targetLabel =
        target.kind === "mode" ? `mode=${target.value}` : `${target.configId}=${target.value}`;
      const option =
        target.kind === "mode" ? null : resolveConfigOption(chat.configOptions || [], target.configId);
      const isCurrent =
        target.kind === "mode"
          ? target.value === chat.mode
          : Boolean(option && configOptionValueMatches(option, target.value));
      items.push({
        label: `${label}  ${c("dim", targetLabel)}`,
        searchText: `${profile} ${label} ${targetLabel}`,
        current: isCurrent,
        value: profile,
      });
    }
    if (!items.length) return false;

    const picked = await this.interactivePick({
      title: `Access · ${chat.providerLabel || chat.provider || ""}`,
      hint: "↑↓ move · Enter apply · Esc cancel",
      items,
    });

    if (picked !== null) await this.applyAccess(picked);
    return true;
  }

  async showChatsMenu() {
    if (!this.tmuxPane()) return false;

    const chats = (await this.hub.call("list_chats", { limit: 80 })).chats;
    const visibleChats = this.orderChatsForDisplay(chats).slice(0, 30);
    const context = this.tmuxContext();
    const items = [];

    if (!visibleChats.length) {
      items.push({ label: "No chats yet", disabled: true });
      return this.showTmuxMenu("ACP Chats", items);
    }

    let currentGroup = "";
    for (const chat of visibleChats) {
      const group = chat.cwd === this.cwd ? `${chat.projectName} / current project` : chat.projectName;
      if (group !== currentGroup) {
        if (currentGroup) items.push({ separator: true });
        items.push({ label: group, disabled: true });
        currentGroup = group;
      }

      const status = chat.active ? ` · ${chat.status}` : "";
      const title = truncateText(cleanInline(chat.title || chat.id), 46);
      const config = chatConfigLabel(chat);
      const age = formatRelativeAge(chat.updatedAt);
      items.push({
        label: `${providerIconFor(chat.provider, chat)} ${title}${status}${config ? ` · ${config}` : ""}${age ? ` · ${age}` : ""}`,
        command: tmuxRunWorkspace(chat.cwd, context, chat.provider, chat.id),
      });
    }

    if (chats.length > visibleChats.length) {
      items.push({ separator: true });
      items.push({ label: `${chats.length - visibleChats.length} more hidden; use /q in full menu`, disabled: true });
    }

    return this.showTmuxMenu("ACP Chats", items);
  }

  showCommandCenterPanel() {
    const chat = this.currentChat || {};
    const provider = chat.providerLabel || chat.provider || "Agent";
    const project = chat.projectName || projectName(this.cwd);
    const status = chat.status || "unknown";
    const config = chatConfigLabel(chat);
    const subtitle = [status, chat.mode, config].filter(Boolean).join("  ");
    const context = this.tmuxContext();
    const chatId = chat.id || "";

    return this.showTmuxMenu("ACP Command Center", [
      { label: `${provider} - ${project}`, disabled: true },
      { label: subtitle || "ready", disabled: true },
      { separator: true },
      { label: "Chats", key: "s", command: this.tmuxSubmitCommand("/chats") },
      { label: "Full agent menu", key: "m", command: this.tmuxSubmitCommand("/menu") },
      { label: "Refresh provider sessions", key: "r", command: this.tmuxSubmitCommand("/refresh") },
      { separator: true },
      { label: "Provider commands", key: "c", command: tmuxPanelCommand(this.cwd, context, "commands", chatId) },
      { label: "Config", key: "g", command: tmuxPanelCommand(this.cwd, context, "config", chatId) },
      { label: "Model", key: "l", command: tmuxPanelCommand(this.cwd, context, "model", chatId) },
      { label: "Effort / reasoning", key: "f", command: tmuxPanelCommand(this.cwd, context, "effort", chatId) },
      { label: "Modes", key: "o", command: tmuxPanelCommand(this.cwd, context, "modes", chatId) },
      { label: "Plan", key: "P", command: tmuxPanelCommand(this.cwd, context, "plan", chatId) },
      { label: "Access / permissions", key: "a", command: tmuxPanelCommand(this.cwd, context, "access", chatId) },
      { label: "Workspace roots", key: "w", command: tmuxPanelCommand(this.cwd, context, "roots", chatId) },
      { label: "New chat", key: "n", command: tmuxPanelCommand(this.cwd, context, "new", chatId) },
      { separator: true },
      { label: "Compose multiline prompt", key: "p", command: this.tmuxSubmitCommand("/compose") },
      { label: "Open editor prompt", key: "e", command: this.tmuxSubmitCommand("/edit") },
      { label: "Attach file to next prompt", key: "t", command: tmuxPromptSubmitToPane(context, "Attach file", "/attach ") },
      { label: "Rename chat", key: "r", command: tmuxPromptActionCommand(this.cwd, context, "rename", chatId, "Rename chat", chat.title || "") },
      { label: "Activity display", key: "v", command: tmuxPanelCommand(this.cwd, context, "activity", chatId) },
      { separator: true },
      { label: "Cancel current turn", key: "x", command: tmuxConfirmActionCommand(this.cwd, context, "cancel", chatId, "Cancel current ACP turn?") },
      { label: "Close adapter", key: "k", command: tmuxConfirmCommand(context, "Close this ACP adapter?", this.tmuxSubmitCommand("/close")) },
      { label: "Close popup", key: "q", command: this.tmuxSubmitCommand("/exit") },
    ]);
  }

  showConfigPanel() {
    const chat = this.currentChat || {};
    const context = this.tmuxContext();
    const chatId = chat.id || "";
    const items = [
      { label: `provider  ${chat.providerLabel || chat.provider || "-"}`, disabled: true },
      { label: `mode      ${chat.mode || "-"}`, disabled: true },
      { separator: true },
    ];

    const options = (chat.configOptions || []).slice(0, 12);
    if (!options.length) {
      items.push({ label: "No config options reported by this adapter yet", disabled: true });
    } else {
      for (const option of options) {
        const id = configOptionId(option);
        items.push({ label: stripAnsi(formatConfigOption(option)), disabled: true });

        const values = configOptionMenuValues(option);
        for (const entry of values.slice(0, 10)) {
          const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
          const label = entry.label && entry.label !== entry.value ? ` ${entry.label}` : "";
          items.push({
            label: `  ${marker} ${truncateText(`${entry.value}${label}`, 62)}`,
            command: tmuxActionCommand(this.cwd, context, "config", chatId, actionPayload({ configId: id, value: entry.value })),
          });
        }
      }
    }

    return this.showTmuxMenu("ACP Config", items);
  }

  showConfigOptionPanel(configId, title = "ACP Config") {
    const option = resolveConfigOption(this.currentChat?.configOptions || [], configId);
    if (!option) return false;

    const context = this.tmuxContext();
    const chatId = this.currentChat?.id || "";
    const id = configOptionId(option);
    const items = [
      { label: stripAnsi(formatConfigOption(option)), disabled: true },
      { separator: true },
    ];

    const values = configOptionMenuValues(option);
    if (!values.length) {
      items.push({ label: `No selectable values. Type /config ${id} <value>.`, disabled: true });
    } else {
      for (const entry of values.slice(0, 40)) {
        const marker = configOptionValueMatches(option, entry.value) ? "*" : " ";
        const detail = [entry.label !== entry.value ? entry.label : "", entry.description]
          .filter(Boolean)
          .join(" - ");
        items.push({
          label: `${marker} ${truncateText(`${entry.value}${detail ? ` ${detail}` : ""}`, 70)}`,
          command: tmuxActionCommand(this.cwd, context, "config", chatId, actionPayload({ configId: id, value: entry.value })),
        });
      }
    }

    return this.showTmuxMenu(title, items);
  }

  showAccessPanel() {
    const context = this.tmuxContext();
    const chatId = this.currentChat?.id || "";
    const profiles = [
      ["read-only", "Read-only / plan"],
      ["agent", "Agent / default"],
      ["full", "Full access / don't ask"],
      ["plan", "Plan"],
      ["auto", "Auto"],
    ];
    const items = [
      { label: `current  ${this.currentChat?.mode || "-"}`, disabled: true },
      { separator: true },
    ];

    let enabled = 0;
    for (const [profile, label] of profiles) {
      const target = resolveAccessTarget(this.currentChat, profile);
      if (!target) {
        items.push({ label: `- ${label}`, disabled: true });
        continue;
      }

      enabled += 1;
      const targetLabel =
        target.kind === "mode" ? `mode=${target.value}` : `${target.configId}=${target.value}`;
      items.push({
        label: `${label}  ${targetLabel}`,
        command: tmuxActionCommand(this.cwd, context, "access", chatId, profile),
      });
    }

    if (enabled === 0) {
      items.push({ separator: true });
      items.push({ label: "No matching access modes reported by this adapter", disabled: true });
    }

    const modes = modeEntries(this.currentChat?.modes);
    if (modes.length) {
      items.push({ separator: true });
      items.push({ label: "Reported modes", disabled: true });
      for (const mode of modes.slice(0, 20)) {
        const id = mode.id || mode.modeId || mode.name || String(mode);
        const label = mode.label || mode.title || mode.name || id;
        const marker = id === this.currentChat?.mode ? "*" : " ";
        items.push({
          label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
          command: tmuxActionCommand(this.cwd, context, "mode", chatId, id),
        });
      }
    }

    return this.showTmuxMenu("ACP Access", items);
  }

  showProviderCommandsPanel() {
    const commands = this.currentChat?.availableCommands || [];
    const items = [];

    if (!commands.length) {
      return this.showTmuxMenu("Provider Commands", [
        { label: "No provider commands reported by ACP yet", disabled: true },
        { label: "You can still type //command manually", disabled: true },
      ]);
    }

    items.push({ label: "Select a command to insert it at the prompt", disabled: true });
    items.push({ separator: true });

    for (const command of commands.slice(0, 30)) {
      const name = command.name || command.command || command.id || command.title || "command";
      const text = `//${String(name).replace(/^\/+/, "")}`;
      items.push({
        label: stripAnsi(formatProviderCommand(command)),
        command: this.tmuxInsertCommand(text),
      });
    }

    return this.showTmuxMenu("Provider Commands", items);
  }

  showModesPanel() {
    const modes = this.currentChat?.modes || null;
    const context = this.tmuxContext();
    const chatId = this.currentChat?.id || "";
    const items = [{ label: `current  ${this.currentChat?.mode || "-"}`, disabled: true }];

    if (!modes) {
      items.push({ separator: true });
      items.push({ label: "No modes reported by this adapter yet", disabled: true });
      return this.showTmuxMenu("ACP Modes", items);
    }

    const entries = modes.availableModes || modes.modes || modes.options || [];
    items.push({ separator: true });

    if (!Array.isArray(entries) || !entries.length) {
      items.push({ label: JSON.stringify(modes), disabled: true });
    } else {
      for (const mode of entries.slice(0, 30)) {
        const id = mode.id || mode.modeId || mode.name || String(mode);
        const label = mode.label || mode.title || mode.name || id;
        const marker = id === this.currentChat?.mode ? "*" : " ";
        items.push({
          label: `${marker} ${id}${label === id ? "" : ` ${label}`}`,
          command: tmuxActionCommand(this.cwd, context, "mode", chatId, id),
        });
      }
    }

    return this.showTmuxMenu("ACP Modes", items);
  }

  showRootsPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("Workspace Roots", buildRootsPanelItems(this.currentChat, context, this.cwd));
  }

  showPlanPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("ACP Plan", buildPlanPanelItems(this.currentChat, context));
  }

  showTmuxMenu(title, items) {
    const result = displayTmuxMenu(title, items, {
      client: this.tmuxClient(),
      pane: this.tmuxPane(),
    });
    if (!result.ok && this.showInternalEvents && result.error) {
      this.logLine(c("dim", `tmux display-menu failed: ${result.error}`));
    }
    return result.ok;
  }

  tmuxPane() {
    const envPane = process.env.TMUX_PANE || "";
    if (this.isUsableTmuxPane(envPane)) return envPane;

    const chatId = this.currentChat?.id || "";
    if (chatId) {
      const result = spawnSync(
        "tmux",
        ["list-panes", "-a", "-F", "#{pane_id}\t#{@vanzi_hub_chat_id}\t#{pane_dead}"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );

      if (!result.error && result.status === 0) {
        for (const line of String(result.stdout || "").split("\n")) {
          const [paneId, paneChatId, paneDead] = line.split("\t");
          if (paneId && paneChatId === chatId && paneDead === "0") return paneId;
        }
      }
    }

    const active = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!active.error && active.status === 0 && String(active.stdout || "").trim()) {
      return String(active.stdout || "").trim();
    }

    return envPane;
  }

  isUsableTmuxPane(pane) {
    if (!pane) return false;

    const result = spawnSync(
      "tmux",
      ["display-message", "-p", "-t", pane, "#{pane_dead}\t#{@vanzi_hub_chat_id}\t#{@vanzi_hub_provider}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.error || result.status !== 0) return false;

    const [paneDead, chatId, provider] = String(result.stdout || "").trim().split("\t");
    if (paneDead === "1") return false;
    if (this.currentChat?.id) {
      if (chatId && chatId !== this.currentChat.id) return false;
      if (!provider) return false;
    }

    return true;
  }

  tmuxClient() {
    const direct = this.tmuxFormat("#{client_name}");
    if (direct) return direct;

    const active = spawnSync("tmux", ["display-message", "-p", "#{client_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!active.error && active.status === 0 && String(active.stdout || "").trim()) {
      return String(active.stdout || "").trim();
    }

    const session = this.tmuxFormat("#{session_name}");
    if (!session) return "";

    const parent = spawnSync("tmux", ["show-option", "-t", session, "-qv", "@vanzi_hub_parent_client"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (parent.error || parent.status !== 0) return "";
    return String(parent.stdout || "").trim();
  }

  tmuxFormat(format) {
    const pane = this.tmuxPane();
    if (!pane) return "";

    const result = spawnSync("tmux", ["display-message", "-p", "-t", pane, format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (result.error || result.status !== 0) return "";
    return String(result.stdout || "").trim();
  }

  closePopupClient() {
    const pane = this.tmuxPane();
    if (!pane) return false;

    const session = this.tmuxFormat("#{session_name}");
    const client = this.tmuxFormat("#{client_name}");
    if (!session || !client) return false;

    const projectOption = spawnSync("tmux", ["show-option", "-t", session, "-qv", "@vanzi_hub_project_path"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (projectOption.error || projectOption.status !== 0 || !String(projectOption.stdout || "").trim()) {
      return false;
    }

    const result = spawnSync("tmux", ["detach-client", "-t", client], {
      stdio: "ignore",
    });
    return !result.error && result.status === 0;
  }

  tmuxContext() {
    return {
      session: this.tmuxFormat("#{session_name}"),
      client: this.tmuxFormat("#{client_name}"),
      pane: this.tmuxPane(),
    };
  }

  tmuxInsertCommand(text) {
    return `send-keys -t ${tmuxDoubleQuote(this.tmuxPane())} -l ${tmuxDoubleQuote(text)}`;
  }

  tmuxSubmitCommand(text) {
    return tmuxSubmitToPane(this.tmuxPane(), text);
  }

  notify(message) {
    const pane = this.tmuxPane();
    if (pane) {
      const result = spawnSync("tmux", ["display-message", "-t", pane, String(message)], {
        stdio: "ignore",
      });
      if (!result.error && result.status === 0) return;
    }

    this.logLine(c("dim", String(message)));
  }

  textFallback(message, render) {
    if (this.tmuxPane() && !this.showInternalEvents) {
      this.notify(`${message}; use /debug to print details in chat`);
      return;
    }

    render();
  }

  async refreshSessions() {
    this.notify("Refreshing ACP sessions...");
    const result = await this.hub.call("refresh_sessions", {
      cwd: this.cwd,
      includeAllProviders: true,
    });

    const lines = [];
    for (const provider of result.providers || []) {
      const count = provider.sessionCount ?? provider.sessions?.length ?? 0;
      const status = provider.supported ? `${count} session(s)` : "not supported";
      lines.push(`${provider.provider}: ${status}`);
    }

    if (!this.showTmuxMenu("ACP Refresh", lines.map((line) => ({ label: line, disabled: true })))) {
      this.textFallback("ACP refresh panel unavailable", () => {
        for (const line of lines) this.logLine(line);
      });
    }
  }

  async question(prompt, options = {}) {
    if (this.canUseRawInput()) {
      return this.rawQuestion(prompt, options);
    }

    this.questionActive = true;
    this.currentPrompt = prompt;
    try {
      return await this.ensureReadline().question(prompt);
    } catch (error) {
      if (error.code === "ERR_USE_AFTER_CLOSE") return "/exit";
      throw error;
    } finally {
      this.questionActive = false;
      this.currentPrompt = "";
      this.flushChunkBuffer({ force: true });
    }
  }

  ensureReadline() {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }

    return this.rl;
  }

  canUseRawInput() {
    // Gate on having an open chat, not on the launch mode: a chat opened from
    // the popup menu (--mode menu) must get the same composer as --mode chat.
    // The text-menu fallback keeps its plain readline prompt.
    return (
      (this.mode === "chat" || Boolean(this.currentChat)) &&
      !this.menuTextActive &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      typeof process.stdin.setRawMode === "function" &&
      process.env.VANZI_HUB_RAW_INPUT !== "0"
    );
  }

  currentDraftKey() {
    const chat = this.currentChat || {};
    return draftKey(chat.id || "", chat.cwd || this.cwd);
  }

  rawQuestion(prompt, options = {}) {
    return new Promise((resolve, reject) => {
      const draftKey = options.draft ? this.currentDraftKey() : "";
      const draftText = draftKey ? loadDraft(draftKey) : "";
      const session = {
        prompt,
        line: draftText,
        cursor: draftText.length,
        draftKey,
        historyIndex: this.inputHistory.length,
        searchActive: false,
        searchQuery: "",
        searchIndex: 0,
        searchOriginalLine: "",
        searchOriginalCursor: 0,
        previousRawMode: process.stdin.isRaw,
        pinned: this.shouldUsePinnedInput(),
        bracketedPaste: this.shouldUseBracketedPaste(),
        pasteActive: false,
        pasteBuffer: "",
        lastPasteSummary: "",
        escapePrefixAt: 0,
        autocompleteIndex: 0,
        autocompleteKey: "",
        autocompleteSuppressedKey: "",
        done: false,
        resizeHandler: null,
        resizeTimer: null,
      };

      const scheduleResizeRender = () => {
        if (session.done || this.rawInput !== session || !session.pinned) return;
        if (session.resizeTimer) clearTimeout(session.resizeTimer);
        session.resizeTimer = setTimeout(() => {
          session.resizeTimer = null;
          if (session.done || this.rawInput !== session || !session.pinned) return;
          this.renderRawInput();
        }, 20);
      };

      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
        if (session.bracketedPaste) this.disableBracketedPaste();
        if (session.resizeTimer) {
          clearTimeout(session.resizeTimer);
          session.resizeTimer = null;
        }
        if (session.resizeHandler) {
          process.removeListener("SIGWINCH", session.resizeHandler);
          session.resizeHandler = null;
        }
        this.stopComposerSpinner();
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(Boolean(session.previousRawMode));
        }
      };

      const finish = (value) => {
        if (session.done) return;
        session.done = true;
        cleanup();
        const text = String(value || "");
        if (this.scrollOffsetRows > 0) {
          // Submitting returns the viewport to the live tail.
          this.scrollOffsetRows = 0;
          this.scrollNewRows = 0;
          if (session.pinned) this.repaintPinnedOutput(this.rawInputLayout(session));
        }
        this.clearRawInputLine();
        if (session.pinned) {
          this.enableRawInputLayout(session);
          if (this.shouldEchoSubmittedInput(text)) {
            this.emitTranscript(`\n${this.formatSubmittedInput(text)}\n`);
            this.pendingResponseBreak = true;
          }
        } else {
          const output = `${session.prompt}${text}\n`;
          this.recordTranscriptOutput(output);
          process.stdout.write(output);
        }
        this.rawInput = null;
        this.questionActive = false;
        this.currentPrompt = "";
        this.flushChunkBuffer({ force: true });

        this.rememberInputHistory(text);

        if (session.draftKey && text.trim() && !["/exit", "/quit"].includes(text.trim())) {
          clearDraft(session.draftKey);
        }

        resolve(text);
      };

      const fail = (error) => {
        if (session.done) return;
        session.done = true;
        cleanup();
        this.clearRawInputLine();
        if (session.pinned) this.disableRawInputLayout();
        this.rawInput = null;
        this.questionActive = false;
        this.currentPrompt = "";
        reject(error);
      };

      const onKeypress = (input, key = {}) => {
        try {
          this.handleRawKeypress(session, input, key, finish);
        } catch (error) {
          fail(error);
        }
      };

      this.rawInput = session;
      this.questionActive = true;
      this.currentPrompt = prompt;
      readlineTerminal.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      if (session.bracketedPaste) this.enableBracketedPaste();
      if (session.pinned) {
        session.resizeHandler = scheduleResizeRender;
        process.on("SIGWINCH", session.resizeHandler);
        this.enableRawInputLayout(session);
      }
      this.renderRawInput();
      this.syncComposerSpinner();
      if (session.pinned) scheduleResizeRender();
    });
  }

  handleRawKeypress(session, input, key, finish) {
    if (this.handleRawHistorySearchKey(session, input, key)) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      if (this.cancelCurrentTurnFromInput(session)) {
        this.renderRawInput();
        return;
      }
      if (session.line) {
        this.pushKillRing(session.line);
        session.line = "";
        session.cursor = 0;
        this.saveRawDraft(session);
        this.renderRawInput();
        return;
      }
      finish("/exit");
      return;
    }

    if (key.ctrl && key.name === "d" && !session.line) {
      finish("/exit");
      return;
    }

    if (this.handleAutocompleteKey(session, input, key)) {
      return;
    }

    if (key.name === "pageup" || key.name === "pagedown") {
      const page = Math.max(1, (this.rawInputLayout(session).outputBottom || 2) - 1);
      this.scrollTranscript(key.name === "pageup" ? page : -page);
      return;
    }

    if (key.name === "escape") {
      if (this.scrollOffsetRows > 0) {
        this.scrollTranscript(-this.scrollOffsetRows);
        return;
      }
      session.escapePrefixAt = Date.now();
      this.handleRawEscape(session);
      return;
    }

    if (key.ctrl && key.name === "r") {
      this.startRawHistorySearch(session);
      this.renderRawInput();
      return;
    }

    if (this.handleBracketedPasteKey(session, input, key)) {
      return;
    }

    if (this.handleRawEscapePrefix(session, input, key)) {
      return;
    }

    if (this.shouldInsertRawNewline(input, key)) {
      this.insertRawInputText(session, "\n");
      this.renderRawInput();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      finish(session.line);
      return;
    }

    if (key.name === "tab") {
      if (this.completeRawFileMention(session)) {
        this.renderRawInput();
        return;
      }
      this.completeRawSlashCommand(session);
      this.renderRawInput();
      return;
    }

    if (key.name === "backspace") {
      if (session.cursor > 0) {
        session.line = `${session.line.slice(0, session.cursor - 1)}${session.line.slice(session.cursor)}`;
        session.cursor -= 1;
        this.saveRawDraft(session);
      } else if (!session.line && this.pendingAttachments.length) {
        this.detachLastAttachmentFromComposer(session);
      }
      this.renderRawInput();
      return;
    }

    if (key.name === "delete") {
      if (session.cursor < session.line.length) {
        session.line = `${session.line.slice(0, session.cursor)}${session.line.slice(session.cursor + 1)}`;
        this.saveRawDraft(session);
      }
      this.renderRawInput();
      return;
    }

    if (key.meta && key.name === "b") {
      session.cursor = rawPreviousWord(session.line, session.cursor);
      this.renderRawInput();
      return;
    }

    if (key.meta && key.name === "f") {
      session.cursor = rawNextWord(session.line, session.cursor);
      this.renderRawInput();
      return;
    }

    if (key.name === "left") {
      session.cursor = Math.max(0, session.cursor - 1);
      this.renderRawInput();
      return;
    }

    if (key.name === "right") {
      session.cursor = Math.min(session.line.length, session.cursor + 1);
      this.renderRawInput();
      return;
    }

    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      session.cursor = this.rawCurrentLineBounds(session).start;
      this.renderRawInput();
      return;
    }

    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      session.cursor = this.rawCurrentLineBounds(session).end;
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "u") {
      const bounds = this.rawCurrentLineBounds(session);
      this.pushKillRing(session.line.slice(bounds.start, session.cursor));
      session.line = `${session.line.slice(0, bounds.start)}${session.line.slice(session.cursor)}`;
      session.cursor = bounds.start;
      this.saveRawDraft(session);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "k") {
      const bounds = this.rawCurrentLineBounds(session);
      this.pushKillRing(session.line.slice(session.cursor, bounds.end));
      session.line = `${session.line.slice(0, session.cursor)}${session.line.slice(bounds.end)}`;
      this.saveRawDraft(session);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "w") {
      const before = session.line.slice(0, session.cursor).replace(/\s+\S*$/, "").replace(/\S+$/, "");
      this.pushKillRing(session.line.slice(before.length, session.cursor));
      session.line = `${before}${session.line.slice(session.cursor)}`;
      session.cursor = before.length;
      this.saveRawDraft(session);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "y") {
      const text = this.killRing[0] || "";
      if (text) this.insertRawInputText(session, text);
      this.renderRawInput();
      return;
    }

    if (key.ctrl && key.name === "l") {
      this.redrawScreen();
      return;
    }

    if (key.name === "up") {
      if (this.moveRawCursorVertically(session, -1)) {
        this.renderRawInput();
        return;
      }
      if (this.inputHistory.length) {
        session.historyIndex = Math.max(0, session.historyIndex - 1);
        session.line = this.inputHistory[session.historyIndex] || "";
        session.cursor = session.line.length;
        this.saveRawDraft(session);
      }
      this.renderRawInput();
      return;
    }

    if (key.name === "down") {
      if (this.moveRawCursorVertically(session, 1)) {
        this.renderRawInput();
        return;
      }
      if (this.inputHistory.length) {
        session.historyIndex = Math.min(this.inputHistory.length, session.historyIndex + 1);
        session.line = this.inputHistory[session.historyIndex] || "";
        session.cursor = session.line.length;
        this.saveRawDraft(session);
      }
      this.renderRawInput();
      return;
    }

    if (input && !key.ctrl && !key.meta && input >= " ") {
      this.insertRawInputText(session, input);
      session.historyIndex = this.inputHistory.length;
      this.renderRawInput();
    }
  }

  handleBracketedPasteKey(session, input, key = {}) {
    if (key.name === "paste-start") {
      session.pasteActive = true;
      session.pasteBuffer = "";
      this.renderRawInput();
      return true;
    }

    if (key.name === "paste-end") {
      const text = normalizePastedText(session.pasteBuffer);
      session.pasteActive = false;
      session.pasteBuffer = "";
      if (text) this.handlePastedText(session, text);
      this.renderRawInput();
      return true;
    }

    if (!session.pasteActive) return false;

    if (input) {
      session.pasteBuffer += input;
    } else if (key.sequence && key.sequence.length === 1) {
      session.pasteBuffer += key.sequence;
    }

    return true;
  }

  handlePastedText(session, text) {
    const cwd = this.currentChat?.cwd || this.cwd;
    const attachments = attachmentsFromPathOnlyText(text, cwd);
    if (attachments.length) {
      const added = this.addPendingAttachments(attachments);
      session.lastPasteSummary = added.length
        ? `attached ${pastedAttachmentSummary(added)} from paste · Enter sends`
        : "pasted file path is already attached";
      this.refreshRawInputPrompt({ render: false });
      return;
    }

    if (shouldStorePasteAsAttachment(text)) {
      const attachment = createPastedTextAttachment(text);
      const added = this.addPendingAttachments([attachment]);
      session.lastPasteSummary = added.length
        ? `large paste saved as ${attachment.name} · Enter sends`
        : "large paste already attached";
      this.refreshRawInputPrompt({ render: false });
      return;
    }

    this.insertRawInputText(session, text, { paste: true });
    session.lastPasteSummary = pastedTextSummary(text);
  }

  startRawHistorySearch(session) {
    session.searchActive = true;
    session.searchQuery = "";
    session.searchIndex = 0;
    session.searchOriginalLine = session.line;
    session.searchOriginalCursor = session.cursor;
    this.applyRawHistorySearch(session);
  }

  handleRawHistorySearchKey(session, input, key = {}) {
    if (!session.searchActive) return false;

    if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "g"))) {
      session.searchActive = false;
      session.line = session.searchOriginalLine;
      session.cursor = session.searchOriginalCursor;
      this.renderRawInput();
      return true;
    }

    if (key.name === "return" || key.name === "enter" || key.name === "tab") {
      session.searchActive = false;
      this.saveRawDraft(session);
      this.renderRawInput();
      return true;
    }

    if ((key.ctrl && key.name === "r") || key.name === "down") {
      session.searchIndex += 1;
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    if (key.name === "up") {
      session.searchIndex = Math.max(0, session.searchIndex - 1);
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    if (key.name === "backspace") {
      session.searchQuery = session.searchQuery.slice(0, -1);
      session.searchIndex = 0;
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    if (input && !key.ctrl && !key.meta && input >= " ") {
      session.searchQuery += input;
      session.searchIndex = 0;
      this.applyRawHistorySearch(session);
      this.renderRawInput();
      return true;
    }

    return true;
  }

  applyRawHistorySearch(session) {
    const matches = this.rawHistorySearchMatches(session.searchQuery);
    if (!matches.length) {
      session.line = session.searchOriginalLine;
      session.cursor = session.searchOriginalCursor;
      return;
    }

    const index = Math.max(0, Math.min(session.searchIndex, matches.length - 1));
    session.searchIndex = index;
    session.line = matches[index];
    session.cursor = session.line.length;
  }

  rawHistorySearchMatches(query) {
    const normalized = String(query || "").toLowerCase();
    const seen = new Set();
    const matches = [];

    for (let index = this.inputHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.inputHistory[index];
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      if (!normalized || entry.toLowerCase().includes(normalized)) matches.push(entry);
    }

    return matches;
  }

  shouldInsertRawNewline(input, key = {}) {
    if (key.ctrl && key.name === "j") return true;
    if (input === "\n") return true;
    if (key.meta && key.name === "j") return true;
    if (key.meta && input === "j") return true;
    if (key.meta && (key.name === "return" || key.name === "enter")) return true;
    if (input === "\x1bj" || input === "\x1bJ") return true;
    if (process.platform === "darwin" && input === "∆") return true;
    return input === "\x1b\r" || input === "\x1b\n";
  }

  handleRawEscapePrefix(session, input, key = {}) {
    if (!session.escapePrefixAt || Date.now() - session.escapePrefixAt > 700) return false;
    if (key.name !== "j" && input !== "j" && input !== "J") return false;

    session.escapePrefixAt = 0;
    this.lastEscapeAt = 0;
    this.insertRawInputText(session, "\n");
    this.renderRawInput();
    return true;
  }

  insertRawInputText(session, text, options = {}) {
    if (!options.paste) session.lastPasteSummary = "";
    session.line = `${session.line.slice(0, session.cursor)}${text}${session.line.slice(session.cursor)}`;
    session.cursor += text.length;
    session.historyIndex = this.inputHistory.length;
    this.saveRawDraft(session);
  }

  saveRawDraft(session) {
    if (!session?.draftKey) return;
    saveDraft(session.draftKey, session.line);
  }

  rememberInputHistory(text) {
    const entry = String(text || "");
    if (!entry.trim() || ["/exit", "/quit"].includes(entry.trim())) return;

    this.inputHistory = this.inputHistory.filter((item) => item !== entry);
    this.inputHistory.push(entry);
    if (this.inputHistory.length > INPUT_HISTORY_LIMIT) {
      this.inputHistory.splice(0, this.inputHistory.length - INPUT_HISTORY_LIMIT);
    }
    saveInputHistory(this.inputHistory);
  }

  canCancelCurrentTurn() {
    return Boolean(this.currentChat?.id && isActiveChatStatus(this.currentChat.status));
  }

  cancelCurrentTurnFromInput(session) {
    if (!this.canCancelCurrentTurn()) return false;

    if (session.line) {
      this.pushKillRing(session.line);
      session.line = "";
      session.cursor = 0;
      this.saveRawDraft(session);
    }

    const chatId = this.currentChat.id;
    this.hub
      .call("cancel", { chatId })
      .then(() => this.notify("cancel requested"))
      .catch((error) => this.notify(`cancel failed: ${error.message || String(error)}`));
    return true;
  }

  pushKillRing(text) {
    if (!text) return;
    this.killRing.unshift(text);
    this.killRing = this.killRing.filter((entry, index, list) => entry && list.indexOf(entry) === index);
    if (this.killRing.length > KILL_RING_LIMIT) this.killRing.length = KILL_RING_LIMIT;
  }

  handleRawEscape(session) {
    const now = Date.now();
    if (now - this.lastEscapeAt < 700 && session.line) {
      this.pushKillRing(session.line);
      session.line = "";
      session.cursor = 0;
      this.saveRawDraft(session);
      this.lastEscapeAt = 0;
      this.renderRawInput();
      return;
    }

    this.lastEscapeAt = now;
    this.notify("press Esc again to clear input");
    this.renderRawInput();
  }

  rawCurrentLineBounds(session) {
    const line = session.line || "";
    const cursor = Math.max(0, Math.min(session.cursor, line.length));
    const start = line.slice(0, cursor).lastIndexOf("\n") + 1;
    const endIndex = line.indexOf("\n", cursor);
    return {
      start,
      end: endIndex === -1 ? line.length : endIndex,
    };
  }

  moveRawCursorVertically(session, direction) {
    const visualLines = rawInputVisualLines(session.line, this.rawInputTextWidth(session));
    if (visualLines.length <= 1) return false;

    const cursor = Math.max(0, Math.min(session.cursor, session.line.length));
    const currentIndex = rawVisualLineIndexAtCursor(visualLines, cursor);

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= visualLines.length) return false;

    const current = visualLines[currentIndex];
    const next = visualLines[nextIndex];
    const column = Math.max(0, cursor - current.start);
    session.cursor = next.start + Math.min(column, next.end - next.start);
    return true;
  }

  renderRawInput(options = {}) {
    const session = this.rawInput;
    if (!session || !process.stdout.isTTY) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    if (session.pinned) {
      const layout = this.rawInputLayout(session);
      const shouldRepaintOutput =
        this.lastRawInputLayout &&
        (this.lastRawInputLayout.outputBottom !== layout.outputBottom ||
          this.lastRawInputLayout.columns !== layout.columns ||
          this.lastRawInputLayout.rows !== layout.rows);
      this.enableRawInputLayout(session, layout);
      if (options.clear === true || !sameRawInputLayout(this.lastRawInputLayout, layout)) {
        this.clearRawInputLayoutRows([this.lastRawInputLayout, layout]);
      }
      if (shouldRepaintOutput) this.repaintPinnedOutput(layout);
      this.renderPinnedRawInput(session, layout);
      return;
    }

    this.clearRawInputLine();
    const promptWidth = visibleLength(session.prompt);
    const lineWidth = Math.max(8, columns - promptWidth - 1);
    const view = this.rawInputViewport(session, lineWidth);
    const hint = this.inputHint(session.line);
    const hintLine = hint ? c("dim", `  ${truncateText(hint, columns - 3)}`) : "";

    process.stdout.write(`${session.prompt}${view.text}${hintLine ? ` ${hintLine.trimStart()}` : ""}`);
    readlineTerminal.cursorTo(process.stdout, promptWidth + view.cursorColumn);
  }

  clearRawInputLine() {
    if (!this.rawInput || !process.stdout.isTTY) return;
    if (!this.rawInput.pinned) {
      readlineTerminal.clearLine(process.stdout, 0);
      readlineTerminal.cursorTo(process.stdout, 0);
      return;
    }

    const layout = this.rawInputLayout(this.rawInput);
    this.clearRawInputLayoutRows([this.lastRawInputLayout, layout]);
    readlineTerminal.cursorTo(process.stdout, 0);
  }

  clearRawInputLayoutRows(layouts) {
    const screenRows = Math.max(1, process.stdout.rows || 24);
    const rows = new Set();

    for (const layout of layouts) {
      if (!layout) continue;
      for (const row of layout.composerRows || []) {
        if (Number.isInteger(row) && row >= 0 && row < screenRows) rows.add(row);
      }
    }

    for (const row of [...rows].sort((a, b) => a - b)) {
      readlineTerminal.cursorTo(process.stdout, 0, row);
      readlineTerminal.clearLine(process.stdout, 0);
    }
  }

  repaintPinnedOutput(layout = this.rawInputLayout(this.rawInput)) {
    if (!process.stdout.isTTY) return;
    if (this.activePicker) {
      // The picker owns the output region; repaint it instead of the
      // transcript (the transcript returns when the picker closes).
      this.activePicker.repaint();
      return;
    }

    const outputRows = Math.max(0, layout.outputBottom);
    if (!outputRows) return;

    const width = Math.max(1, layout.columns - 1);
    const painter = new FramePainter();
    this.paintTranscriptViewport(painter, outputRows, width);
    this.restoreComposerCursor(painter);
    painter.flush();
  }

  paintTranscriptViewport(painter, outputRows, width) {
    const window = this.collectTranscriptRowsFromEnd(width, outputRows, this.scrollOffsetRows);
    const rows = window.rows;
    const startRow = Math.max(0, outputRows - rows.length);

    for (let row = 0; row < outputRows; row += 1) {
      painter.to(0, row).clearLine();
      const content = rows[row - startRow];
      if (content) painter.text(content).text(colors.reset || "");
    }
  }

  // Soft-wrapped visual rows for the transcript tail: the last `count` rows
  // after skipping `skipFromEnd` rows from the bottom. Wraps lazily from the
  // end so cost is proportional to the window, not the whole buffer.
  collectTranscriptRowsFromEnd(width, count, skipFromEnd = 0) {
    const needed = Math.max(0, count) + Math.max(0, skipFromEnd);
    const lines = this.transcriptLines;
    let end = lines.length;
    while (end > 0 && stripAnsi(lines[end - 1] || "").trim() === "") end -= 1;

    const collected = [];
    for (let index = end - 1; index >= 0 && collected.length < needed; index -= 1) {
      const rows = wrapAnsiLine(lines[index], width);
      for (let row = rows.length - 1; row >= 0; row -= 1) collected.push(rows[row]);
    }
    collected.reverse();

    const sliceEnd = Math.max(0, collected.length - Math.max(0, skipFromEnd));
    const sliceStart = Math.max(0, sliceEnd - Math.max(0, count));
    return {
      rows: collected.slice(sliceStart, sliceEnd),
      total: collected.length,
      atTop: collected.length < needed,
    };
  }

  transcriptWrapWidth() {
    const columns = Math.max(24, process.stdout.columns || 80);
    return Math.max(1, columns - 1);
  }

  pinnedOutputRows() {
    return Math.max(1, this.lastRawScrollBottom || 1);
  }

  // Pinned layout is active whenever the scroll region is set; transcript
  // output must then be soft-wrapped and confined to the region.
  canPaintPinned() {
    return Boolean(process.stdout.isTTY && this.lastRawScrollBottom !== null);
  }

  // Records transcript text and paints it inside the pinned scroll region as
  // one atomic frame. The single choke point for transcript output while the
  // composer layout is active.
  emitTranscript(text, options = {}) {
    let output = String(text ?? "");
    if (!output) return;
    if (!output.endsWith("\n")) output += "\n";
    if (options.recordTranscript !== false) this.recordTranscriptOutput(output);
    this.paintTranscriptAppend(output);
  }

  paintTranscriptAppend(text) {
    const width = this.transcriptWrapWidth();
    const lines = String(text).split("\n");
    lines.pop();

    if (this.activePicker) {
      // A picker owns the screen: buffer only; the close repaint catches up.
      return;
    }

    if (this.scrollOffsetRows > 0) {
      // Viewing history: keep the viewport still and count what arrived.
      let arrived = 0;
      for (const line of lines) arrived += wrapAnsiLine(line, width).length;
      this.scrollNewRows += arrived;
      if (this.rawInput) this.renderRawInput();
      return;
    }

    if (!this.canPaintPinned()) {
      process.stdout.write(text);
      return;
    }

    const bottom = this.pinnedOutputRows() - 1;
    const painter = new FramePainter();
    painter.to(0, bottom);
    for (const line of lines) {
      for (const row of wrapAnsiLine(line, width)) {
        painter.text("\r\n").clearLine().text(row).text(colors.reset || "");
      }
    }
    this.restoreComposerCursor(painter);
    painter.flush();
  }

  restoreComposerCursor(painter) {
    const session = this.rawInput;
    if (!session || !session.pinned || session.done) return;
    const layout = this.rawInputLayout(session);
    const view = this.rawInputMultilineViewport(session, layout.inputWidth, layout.inputRows);
    const row = view.rows[view.cursorRow] || { prefix: "" };
    const borderOffset = layout.boxed ? COMPOSER_BOX_SIDE_WIDTH : 0;
    painter.to(
      borderOffset + visibleLength(row.prefix) + view.cursorColumn,
      layout.inputRow + view.cursorRow,
    );
  }

  scrollTranscript(deltaRows) {
    const session = this.rawInput;
    if (!session?.pinned || !this.canPaintPinned()) return;

    const layout = this.rawInputLayout(session);
    const viewport = Math.max(1, layout.outputBottom);
    const width = Math.max(1, layout.columns - 1);
    let offset = Math.max(0, this.scrollOffsetRows + deltaRows);

    if (offset > 0) {
      const probe = this.collectTranscriptRowsFromEnd(width, viewport, offset);
      if (probe.atTop) offset = Math.max(0, probe.total - viewport);
    }

    if (offset === this.scrollOffsetRows) return;
    this.scrollOffsetRows = offset;
    if (offset === 0) this.scrollNewRows = 0;

    this.renderRawInput();
    this.repaintPinnedOutput(this.rawInputLayout(session));
  }

  redrawScreen() {
    if (!process.stdout.isTTY) return;
    this.scrollOffsetRows = 0;
    this.scrollNewRows = 0;

    if (this.rawInput?.pinned && this.canPaintPinned()) {
      process.stdout.write("\x1b[2J");
      this.lastRawInputLayout = null;
      this.renderRawInput({ clear: true });
      this.repaintPinnedOutput();
      return;
    }

    this.clearScreen();
    this.renderRawInput();
  }

  pickerSupported() {
    return Boolean(
      process.stdin.isTTY &&
        process.stdout.isTTY &&
        typeof process.stdin.setRawMode === "function" &&
        process.env.VANZI_HUB_INTERACTIVE_UI !== "0",
    );
  }

  // Full-viewport interactive list: arrows/Ctrl+N/Ctrl+P move, typing filters
  // fzf-style, Enter resolves the highlighted entry's value, Esc clears the
  // query first and cancels (null) second. Inside a chat it paints over the
  // transcript region (composer stays); the transcript is repainted on close.
  async interactivePick(config) {
    if (!this.pickerSupported()) return null;

    return new Promise((resolve) => {
      const state = {
        title: config.title || "Select",
        hint: config.hint || "↑↓ move · type to filter · Enter select · Esc cancel",
        emptyText: config.emptyText || "No matches",
        items: config.items || [],
        query: "",
        index: -1,
        scroll: 0,
        done: false,
        renaming: null,
        renameText: "",
        confirmDelete: null,
        previewEnabled: Boolean(config.onPreview),
        previewKey: null,
        previewData: null,
        previousRawMode: process.stdin.isRaw,
      };

      const visible = () => pickerFilterEntries(state.items, state.query);

      // Preview pane: fetch the transcript tail for the selected chat, debounced
      // so arrow-key travel doesn't hammer the daemon. Entries are cached with a
      // short TTL to stay fresh while chats stream.
      const previewCache = new Map();
      let previewTimer = null;
      const syncPreview = (entries) => {
        if (!config.onPreview) return;
        const entry = entries[state.index];
        const key = entry && !entry.disabled ? (entry.value?.chatId ?? null) : null;
        const cached = key ? previewCache.get(key) : null;
        const fresh = cached && Date.now() - cached.at < 3000;
        if (key === state.previewKey && (fresh || !key)) return;

        state.previewKey = key;
        state.previewData = cached?.data ?? null;
        if (previewTimer) {
          clearTimeout(previewTimer);
          previewTimer = null;
        }
        if (!key || fresh) return;

        previewTimer = setTimeout(() => {
          previewTimer = null;
          Promise.resolve(config.onPreview(entry))
            .then((data) => {
              if (state.done) return;
              previewCache.set(key, { data: data || { events: [] }, at: Date.now() });
              if (state.previewKey === key) {
                state.previewData = data || { events: [] };
                repaint();
              }
            })
            .catch(() => {});
        }, 80);
        previewTimer.unref?.();
      };

      const ensureSelection = (entries, preferValue = null) => {
        if (preferValue !== null) {
          const preferred = entries.findIndex(
            (entry) => !entry.disabled && pickerValueEquals(entry.value, preferValue),
          );
          if (preferred !== -1) {
            state.index = preferred;
            return;
          }
        }
        const current = entries.findIndex((entry) => !entry.disabled && entry.current);
        state.index =
          current !== -1 ? current : pickerNextIndex(entries, state.index, 0);
      };

      const repaint = () => {
        const entries = visible();
        syncPreview(entries);
        this.paintPicker(state, entries);
      };

      const replaceItems = (items, keepValue = null) => {
        if (state.done) return;
        state.items = items || [];
        ensureSelection(visible(), keepValue);
        repaint();
      };

      const finish = (value) => {
        if (state.done) return;
        state.done = true;
        if (previewTimer) clearTimeout(previewTimer);
        process.stdin.off("keypress", onKeypress);
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(Boolean(state.previousRawMode));
        }
        this.activePicker = null;
        this.restorePickerBackdrop();
        resolve(value);
      };

      const rebuildWith = (producer) => {
        Promise.resolve()
          .then(producer)
          .then((items) => {
            if (Array.isArray(items)) {
              const keep = visible()[state.index]?.value ?? null;
              replaceItems(items, keep);
            }
          })
          .catch(() => {});
      };

      const onKeypress = (input, key = {}) => {
        try {
          if (key.ctrl && key.name === "c") {
            finish(null);
            return;
          }

          // Rename mode: the query line becomes a title editor.
          if (state.renaming) {
            if (key.name === "escape") {
              state.renaming = null;
              state.renameText = "";
              repaint();
              return;
            }
            if (key.name === "return" || key.name === "enter") {
              const entry = state.renaming;
              const title = state.renameText.trim();
              state.renaming = null;
              state.renameText = "";
              if (title && config.onRename) {
                Promise.resolve(config.onRename(entry, title))
                  .then((items) => {
                    if (Array.isArray(items)) replaceItems(items, entry.value);
                    else repaint();
                  })
                  .catch(() => repaint());
              } else {
                repaint();
              }
              return;
            }
            if (key.name === "backspace") {
              state.renameText = state.renameText.slice(0, -1);
              repaint();
              return;
            }
            if (input && !key.ctrl && !key.meta && input >= " ") {
              state.renameText += input;
              repaint();
            }
            return;
          }

          const currentEntries = visible();
          const selected = currentEntries[state.index];

          if (key.ctrl && key.name === "e" && config.onRename && selected?.canRename) {
            state.confirmDelete = null;
            state.renaming = selected;
            state.renameText = String(selected.renameInitial ?? stripAnsi(selected.label || "")).trim();
            repaint();
            return;
          }

          if (key.ctrl && key.name === "d" && config.onDelete && selected?.canDelete) {
            if (state.confirmDelete !== selected) {
              // First press arms the delete; the hint explains the second one.
              state.confirmDelete = selected;
              repaint();
              return;
            }
            state.confirmDelete = null;
            // Keep the selection near the removed row.
            const fallback =
              currentEntries.slice(state.index + 1).find((entry) => !entry.disabled)?.value ??
              [...currentEntries.slice(0, state.index)].reverse().find((entry) => !entry.disabled)?.value ??
              null;
            Promise.resolve(config.onDelete(selected))
              .then((items) => {
                if (Array.isArray(items)) replaceItems(items, fallback);
                else repaint();
              })
              .catch(() => repaint());
            return;
          }

          if (state.confirmDelete) state.confirmDelete = null;

          if (key.name === "escape") {
            if (state.query) {
              state.query = "";
              ensureSelection(visible());
              repaint();
            } else {
              finish(null);
            }
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            const entries = visible();
            const entry = entries[state.index];
            if (entry && !entry.disabled) finish(entry.value);
            return;
          }
          if (key.name === "up" || (key.ctrl && key.name === "p")) {
            state.index = pickerNextIndex(visible(), state.index, -1);
            repaint();
            return;
          }
          if (key.name === "down" || (key.ctrl && key.name === "n")) {
            state.index = pickerNextIndex(visible(), state.index, 1);
            repaint();
            return;
          }
          if (key.name === "pageup" || key.name === "pagedown") {
            const page = Math.max(1, this.pickerListCapacity() - 1);
            state.index = pickerNextIndex(visible(), state.index, key.name === "pageup" ? -page : page);
            repaint();
            return;
          }
          if (key.name === "tab" && config.onTab) {
            rebuildWith(config.onTab);
            return;
          }
          if (key.ctrl && key.name === "r" && config.onRefresh) {
            rebuildWith(config.onRefresh);
            return;
          }
          if (key.name === "backspace") {
            if (state.query) {
              state.query = state.query.slice(0, -1);
              ensureSelection(visible());
            }
            repaint();
            return;
          }
          if (input && !key.ctrl && !key.meta && input >= " ") {
            state.query += input;
            ensureSelection(visible());
            repaint();
          }
        } catch {
          finish(null);
        }
      };

      this.activePicker = {
        repaint,
        onEvent: config.onEvent ? (message) => config.onEvent(message, { replaceItems, state }) : null,
      };

      readlineTerminal.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      ensureSelection(visible());
      repaint();
    });
  }

  pickerViewportRows() {
    if (this.canPaintPinned()) return this.pinnedOutputRows();
    return Math.max(6, process.stdout.rows || 24);
  }

  pickerListCapacity() {
    // title + query + separator above, hint row below
    return Math.max(1, this.pickerViewportRows() - 4);
  }

  paintPicker(state, entries) {
    if (!process.stdout.isTTY) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    const width = Math.max(1, columns - 1);
    const viewportRows = this.pickerViewportRows();
    const capacity = Math.max(1, viewportRows - 4);
    const painter = new FramePainter();

    const selectableCount = entries.filter((entry) => !entry.disabled).length;
    const counter = c("dim", `${selectableCount} item${selectableCount === 1 ? "" : "s"}`);
    const queryText = state.renaming
      ? `${c("yellow", "Rename:")} ${state.renameText}`
      : state.query || c("dim", "type to filter…");

    if (state.index >= state.scroll + capacity) state.scroll = state.index - capacity + 1;
    if (state.index !== -1 && state.index < state.scroll) state.scroll = state.index;
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, entries.length - capacity)));

    const writeRow = (row, content) => {
      painter.to(0, row).clearLine();
      if (content) painter.text(fitAnsiLine(content, width)).text(colors.reset || "");
    };

    // Two-column layout: list left, transcript preview right, when a preview
    // provider is wired and the popup is wide enough to be useful.
    const previewActive = state.previewEnabled && width >= 96;
    const listWidth = previewActive ? Math.min(64, Math.floor(width * 0.45)) : width;
    const previewWidth = previewActive ? width - listWidth - 3 : 0;
    const previewLines = previewActive
      ? formatChatPreview(state.previewData?.events, previewWidth, capacity, (text) =>
          this.renderMarkdownDetached(text, previewWidth),
        )
      : [];
    const previewPending = previewActive && state.previewKey && !state.previewData;

    writeRow(0, `${c("bold", state.title)}  ${counter}`);
    writeRow(1, `${c("cyan", "❯")} ${queryText}`);
    writeRow(2, c("dim", "─".repeat(Math.min(width, 96))));

    for (let slot = 0; slot < capacity; slot += 1) {
      const entry = entries[state.scroll + slot];
      let content = "";
      if (entry) {
        if (entry.disabled) {
          content = entry.label || "";
        } else {
          const selected = state.scroll + slot === state.index;
          const marker = selected ? c("cyan", "❯ ") : "  ";
          const currentMark = entry.current ? c("green", "● ") : "  ";
          content = `${marker}${currentMark}${entry.label || ""}`;
        }
      } else if (slot === 0 && !entries.length) {
        content = c("dim", `  ${state.emptyText}`);
      }

      if (previewActive) {
        const left = padAnsiToWidth(fitAnsiLine(content, listWidth), listWidth);
        const right = previewLines[slot] ?? (slot === 0 && previewPending ? c("dim", "…") : "");
        content = `${left} ${c("dim", "│")} ${right}`;
      }
      writeRow(3 + slot, content);
    }

    const hintLine = state.renaming
      ? c("dim", " Enter apply · Esc cancel")
      : state.confirmDelete
        ? c("yellow", " Ctrl+D again deletes this chat permanently · any key cancels")
        : c("dim", ` ${state.hint}`);
    writeRow(viewportRows - 1, hintLine);

    const cursorText = state.renaming ? `Rename: ${state.renameText}` : state.query;
    painter.to(2 + visibleLength(cursorText), 1);
    painter.flush();
  }

  restorePickerBackdrop() {
    if (!process.stdout.isTTY) return;
    if (this.canPaintPinned()) {
      this.repaintPinnedOutput();
      if (this.rawInput) this.renderRawInput();
      return;
    }
    this.clearScreen();
  }

  resetTranscriptBuffer() {
    this.transcriptLines = [""];
    this.scrollOffsetRows = 0;
    this.scrollNewRows = 0;
  }

  resetStreamRenderState() {
    if (this.liveTablePaintTimer) {
      clearTimeout(this.liveTablePaintTimer);
      this.liveTablePaintTimer = null;
    }
    this.liveTablePaintPending = false;
    this.liveTable = null;
    this.mdHeldLine = null;
  }

  recordTranscriptOutput(text = "") {
    const parts = String(text || "").split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) this.transcriptLines.push("");
      this.transcriptLines[this.transcriptLines.length - 1] += parts[index];
    }

    if (this.transcriptLines.length > TRANSCRIPT_SCREEN_LINE_LIMIT) {
      const removed = this.transcriptLines.length - TRANSCRIPT_SCREEN_LINE_LIMIT;
      this.transcriptLines.splice(0, removed);
      if (this.liveTable) {
        this.liveTable.startIndex -= removed;
        if (this.liveTable.startIndex < 0) this.liveTable = null;
      }
    }
  }

  // The rounded composer box costs two border rows; small popups fall back to
  // the flat divider layout so the transcript keeps enough room.
  shouldUseBoxedComposer(rows = process.stdout.rows || 24) {
    return rows >= 15 && process.env.VANZI_HUB_COMPOSER_BOX !== "0";
  }

  rawInputLayout(session = this.rawInput) {
    const rows = Math.max(10, process.stdout.rows || 24);
    const columns = Math.max(24, process.stdout.columns || 80);
    const boxed = this.shouldUseBoxedComposer(rows) && session?.pinned !== false;
    const attachmentRows = this.rawAttachmentRowCount(columns);
    const inputRows = this.rawInputRowCount(session, this.rawInputTextWidth(session, columns, boxed));
    const dropdown = boxed ? this.activeAutocomplete(session) : null;
    const dropdownRows = dropdown ? Math.min(5, dropdown.matches.length) : 0;
    const hintRows = dropdownRows ? 0 : this.rawHintRowCount(session);
    const inputPadRows = COMPOSER_INPUT_VERTICAL_PADDING;
    // Flat chrome: divider + footer. Boxed chrome: top border + bottom border,
    // then either the footer or the autocomplete dropdown.
    const chromeRows = boxed ? (dropdownRows ? 2 : 3) : 2;
    // One blank row between the transcript and the box so responses never sit
    // glued to the top border (skipped in the flat layout: rows are scarce).
    const gapRows = boxed ? 1 : 0;
    const composerHeight =
      attachmentRows + inputRows + inputPadRows * 2 + chromeRows + dropdownRows + hintRows + gapRows;
    const outputBottom = Math.max(1, rows - composerHeight);
    const gapRow = gapRows ? rows - composerHeight : null;
    const attachmentRow = rows - composerHeight + gapRows;
    const dividerRow = attachmentRow + attachmentRows;
    const inputPadTopRow = dividerRow + 1;
    const inputRow = inputPadTopRow + inputPadRows;
    const inputPadBottomRow = inputRow + inputRows;
    const boxBottomRow = boxed ? inputPadBottomRow + inputPadRows : null;
    const dropdownRow = dropdownRows ? boxBottomRow + 1 : null;
    const footerRow = dropdownRows ? null : boxed ? boxBottomRow + 1 : inputPadBottomRow + inputPadRows;
    const hintRow = hintRows ? footerRow + 1 : null;

    return {
      rows,
      columns,
      boxed,
      attachmentRows,
      hintRows,
      inputPadRows,
      attachmentRow,
      inputPadTopRow,
      inputWidth: this.rawInputTextWidth(session, columns, boxed),
      inputRows,
      inputPadBottomRow,
      outputBottom,
      gapRow,
      dividerRow,
      boxBottomRow,
      dropdown,
      dropdownRows,
      dropdownRow,
      inputRow,
      footerRow,
      hintRow,
      composerRows: [
        ...(gapRow !== null ? [gapRow] : []),
        ...Array.from({ length: attachmentRows }, (_, index) => attachmentRow + index),
        dividerRow,
        ...Array.from({ length: inputPadRows }, (_, index) => inputPadTopRow + index),
        ...Array.from({ length: inputRows }, (_, index) => inputRow + index),
        ...Array.from({ length: inputPadRows }, (_, index) => inputPadBottomRow + index),
        ...(boxed ? [boxBottomRow] : []),
        ...Array.from({ length: dropdownRows }, (_, index) => dropdownRow + index),
        ...(footerRow !== null ? [footerRow] : []),
        ...(hintRows ? [hintRow] : []),
      ],
    };
  }

  rawInputRowCount(session = this.rawInput, inputWidth = this.rawInputTextWidth(session)) {
    const rows = session?.line ? rawInputVisualLines(session.line, inputWidth).length : 1;
    return Math.max(MIN_COMPOSER_INPUT_ROWS, Math.min(MAX_COMPOSER_INPUT_ROWS, rows));
  }

  rawInputTextWidth(
    session = this.rawInput,
    columns = process.stdout.columns || 80,
    boxed = this.shouldUseBoxedComposer() && session?.pinned !== false,
  ) {
    const safeColumns = Math.max(1, Math.max(24, columns) - 1);
    if (session?.pinned !== false) {
      const borderColumns = boxed ? COMPOSER_BOX_SIDE_WIDTH * 2 : 0;
      return Math.max(
        8,
        safeColumns - borderColumns - COMPOSER_INPUT_SIDE_PADDING - COMPOSER_MARKER_WIDTH,
      );
    }
    const promptWidth = visibleLength(session?.prompt || "");
    return Math.max(8, safeColumns - promptWidth);
  }

  rawAttachmentRowCount(columns = process.stdout.columns || 80) {
    if (!this.pendingAttachments.length) return 0;
    return wrapAttachmentChips(this.pendingAttachments, Math.max(1, Math.max(24, columns) - 1)).length;
  }

  rawHintRowCount(session = this.rawInput) {
    return this.inputHint(session?.line || "") ? 1 : 0;
  }

  enableRawInputLayout(session = this.rawInput, layout = this.rawInputLayout(session)) {
    if (!process.stdout.isTTY) return;
    if (this.lastRawScrollBottom === layout.outputBottom) return;
    process.stdout.write(`\x1b[1;${layout.outputBottom}r`);
    this.lastRawScrollBottom = layout.outputBottom;
  }

  disableRawInputLayout() {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[r");
    this.lastRawScrollBottom = null;
  }

  shouldUsePinnedInput() {
    return process.env.VANZI_HUB_PINNED_INPUT !== "0";
  }

  shouldUseBracketedPaste() {
    return process.env.VANZI_HUB_BRACKETED_PASTE !== "0";
  }

  enableBracketedPaste() {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[?2004h");
  }

  disableBracketedPaste() {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[?2004l");
  }

  renderPinnedRawInput(session, layout = this.rawInputLayout(session)) {
    if (layout.boxed) {
      this.renderBoxedComposer(session, layout);
      return;
    }

    const columns = layout.columns;
    const safeColumns = Math.max(1, columns - 1);
    const inputWidth =
      layout.inputWidth || Math.max(8, safeColumns - COMPOSER_INPUT_SIDE_PADDING - COMPOSER_MARKER_WIDTH);
    const view = this.rawInputMultilineViewport(session, inputWidth, layout.inputRows);
    const footer = this.composerFooter();
    const hint = this.inputHint(session.line);
    const painter = new FramePainter();

    const attachmentRows = wrapAttachmentChips(this.pendingAttachments, safeColumns);
    for (let index = 0; index < layout.attachmentRows; index += 1) {
      painter.to(0, layout.attachmentRow + index).text(fitAnsiLine(attachmentRows[index] || "", safeColumns));
    }

    painter.to(0, layout.dividerRow).text(fitAnsiLine(this.composerDividerLine(safeColumns), safeColumns));

    for (let index = 0; index < layout.inputPadRows; index += 1) {
      painter.to(0, layout.inputPadTopRow + index).text(inputComposerLine("", safeColumns));
    }

    for (let index = 0; index < layout.inputRows; index += 1) {
      const row = view.rows[index] || { prefix: "  ", text: "" };
      painter
        .to(0, layout.inputRow + index)
        .text(inputComposerLine(`${row.prefix}${row.text}`, safeColumns, row.placeholder));
    }

    for (let index = 0; index < layout.inputPadRows; index += 1) {
      painter.to(0, layout.inputPadBottomRow + index).text(inputComposerLine("", safeColumns));
    }

    painter.to(0, layout.footerRow).text(fitAnsiLine(this.composerMetaLine(footer), safeColumns));

    if (layout.hintRows) {
      painter.to(0, layout.hintRow).text(c("dim", fitPlainLine(this.composerMetaLine(hint), safeColumns)));
    }

    const cursorRow = view.rows[view.cursorRow] || { prefix: "" };
    painter.to(visibleLength(cursorRow.prefix) + view.cursorColumn, layout.inputRow + view.cursorRow);
    painter.flush();
    this.lastRawInputLayout = layout;
  }

  // Border color: provider accent in neutral states; attention states take
  // over the whole frame (permission/auth yellow, error red).
  composerBorderSeq() {
    if (!process.stdout.isTTY) return "";
    const status = normalizeToken(this.currentChat?.status || "");
    if (this.pendingPermission || status === "permission" || status === "auth") return "\x1b[33m";
    if (status === "error") return "\x1b[31m";
    return providerAccentSeq(this.currentChat?.provider);
  }

  boxedComposerTitle() {
    const chat = this.currentChat || {};
    const status = this.composerStatusLabelStyled(chat.status || "idle");
    const provider = `${coloredProviderIcon(chat)} ${coloredProviderLabel(chat)}`;
    const badges = this.composerBadges(chat, chat.status || "idle")
      .map((badge) => c("yellow", badge))
      .join(" ");
    const main = [status, provider].filter(Boolean).join(` ${c("dim", "·")} `);
    return `${main}${badges ? `  ${badges}` : ""}`;
  }

  renderBoxedComposer(session, layout) {
    const safeColumns = Math.max(1, layout.columns - 1);
    const interiorWidth = Math.max(4, safeColumns - COMPOSER_BOX_SIDE_WIDTH * 2);
    const inputWidth = layout.inputWidth || Math.max(8, interiorWidth - 3);
    const view = this.rawInputMultilineViewport(session, inputWidth, layout.inputRows);
    const border = this.composerBorderSeq();
    const reset = colors.reset || "";
    const edge = (text) => `${border}${text}${reset}`;
    const painter = new FramePainter();

    if (layout.gapRow !== null) {
      painter.to(0, layout.gapRow).clearLine();
    }

    const attachmentRows = wrapAttachmentChips(this.pendingAttachments, safeColumns);
    for (let index = 0; index < layout.attachmentRows; index += 1) {
      painter
        .to(0, layout.attachmentRow + index)
        .clearLine()
        .text(fitAnsiLine(attachmentRows[index] || "", safeColumns));
    }

    // Top border with the embedded title: ╭─ <title> ───╮
    const rawTitle = this.boxedComposerTitle();
    const title = truncateAnsiText(rawTitle, Math.max(4, safeColumns - 8));
    const fill = Math.max(0, safeColumns - 5 - visibleLength(title));
    painter
      .to(0, layout.dividerRow)
      .clearLine()
      .text(`${edge("╭─")} ${title} ${edge(`${"─".repeat(fill)}╮`)}`);

    for (let index = 0; index < layout.inputRows; index += 1) {
      const row = view.rows[index] || { prefix: "  ", text: "" };
      const interior = inputComposerLine(`${row.prefix}${row.text}`, interiorWidth, row.placeholder);
      painter
        .to(0, layout.inputRow + index)
        .clearLine()
        .text(`${edge("│")} ${interior} ${edge("│")}`);
    }

    // Bottom border; wrapped-input overflow counters sit inside it.
    const overflowParts = [];
    if (view.hiddenAbove) overflowParts.push(`↑ ${view.hiddenAbove} more`);
    if (view.hiddenBelow) overflowParts.push(`↓ ${view.hiddenBelow} more`);
    painter.to(0, layout.boxBottomRow).clearLine();
    if (overflowParts.length) {
      const label = overflowParts.join(" · ");
      const left = Math.max(0, safeColumns - 5 - visibleLength(label));
      painter.text(
        `${edge(`╰${"─".repeat(left)}`)} ${c("dim", label)} ${edge("─╯")}`,
      );
    } else {
      painter.text(edge(`╰${"─".repeat(Math.max(0, safeColumns - 2))}╯`));
    }

    if (layout.dropdownRows) {
      this.paintAutocompleteDropdown(painter, layout, safeColumns);
    }

    if (layout.footerRow !== null) {
      painter
        .to(0, layout.footerRow)
        .clearLine()
        .text(fitAnsiLine(this.composerMetaLine(this.composerFooter()), safeColumns));
    }

    if (layout.hintRows) {
      painter
        .to(0, layout.hintRow)
        .clearLine()
        .text(c("dim", fitPlainLine(this.composerMetaLine(this.inputHint(session.line)), safeColumns)));
    }

    const cursorRow = view.rows[view.cursorRow] || { prefix: "" };
    painter.to(
      COMPOSER_BOX_SIDE_WIDTH + visibleLength(cursorRow.prefix) + view.cursorColumn,
      layout.inputRow + view.cursorRow,
    );
    painter.flush();
    this.lastRawInputLayout = layout;
  }

  paintAutocompleteDropdown(painter, layout, safeColumns) {
    const dropdown = layout.dropdown;
    if (!dropdown) return;

    const nameWidth = Math.min(
      24,
      Math.max(...dropdown.matches.map((entry) => visibleLength(entry.name))) + 2,
    );

    for (let index = 0; index < layout.dropdownRows; index += 1) {
      const entry = dropdown.matches[index];
      const selected = index === dropdown.index;
      const marker = selected ? c("cyan", "❯") : " ";
      const name = selected ? c("bold", entry.name) : entry.name;
      const hint = entry.hint ? c("dim", entry.hint) : "";
      const padding = " ".repeat(Math.max(1, nameWidth - visibleLength(entry.name)));
      painter
        .to(0, layout.dropdownRow + index)
        .clearLine()
        .text(fitAnsiLine(`  ${marker} ${name}${hint ? `${padding}${hint}` : ""}`, safeColumns));
    }
  }

  // Provider-tinted input marker using an fg-only reset (\x1b[39m) so it keeps
  // the shaded input background applied by inputComposerLine.
  inputMarker() {
    if (!process.stdout.isTTY) return "❯ ";
    const code = { magenta: 35, cyan: 36, blue: 34 }[providerColorName(this.currentChat?.provider)] || 36;
    return `\x1b[${code}m❯\x1b[39m `;
  }

  composerStatusLabelStyled(status) {
    if (normalizeToken(status) === "permission") return "";
    const color = statusColorName(status);
    if (!isActiveChatStatus(status)) return c(color, `${statusGlyph(status)} ${status || "idle"}`);
    const frame = COMPOSER_SPINNER_FRAMES[this.composerSpinnerFrame % COMPOSER_SPINNER_FRAMES.length];
    return c(color, `${frame} ${status}`);
  }

  composerTitleStyled() {
    const chat = this.currentChat || {};
    const provider = `${coloredProviderIcon(chat)} ${coloredProviderLabel(chat)}`;
    const status = chat.status || "idle";
    const badges = this.composerBadges(chat, status).map((badge) => c("yellow", badge));
    return [provider, this.composerStatusLabelStyled(status), ...badges].filter(Boolean).join(" ");
  }

  composerDividerLine(columns) {
    const title = this.composerTitleStyled();
    const width = visibleLength(title);
    if (width >= columns) return truncateAnsiText(title, columns);
    return `${title} ${c("dim", "─".repeat(Math.max(0, columns - width - 1)))}`;
  }

  composerMetaLine(text) {
    return `${" ".repeat(COMPOSER_META_SIDE_PADDING)}${text || ""}`;
  }

  composerBadges(chat, status) {
    const badges = [];

    if (this.pendingPermission || normalizeToken(status) === "permission") {
      badges.push("[PERMISSION]");
    }
    if (this.rawInput?.pasteActive) badges.push("[PASTE]");
    if (this.rawInput?.searchActive) badges.push("[SEARCH]");
    if (this.scrollOffsetRows > 0) {
      badges.push(this.scrollNewRows > 0 ? `[↑ ${this.scrollNewRows} new · PgDn]` : "[↑ SCROLL]");
    }

    return badges;
  }

  composerFooter() {
    const chat = this.currentChat || {};
    const modelLabel =
      [chatModel(chat), chatEffort(chat)].filter(Boolean).join(" ") || chat.provider || "agent";
    const dim = (value) => (value ? c("dim", value) : "");
    const segments = [
      dim(this.composerAttachmentLabel()),
      dim(modelLabel),
      this.composerContextLabel(),
      this.composerQueueLabel(),
      dim(this.composerMcpLabel()),
      dim(chatAccessLabel(chat)),
      dim(displayPath(chat.cwd || this.cwd)),
      dim(this.composerRootsLabel(chat)),
    ].filter(Boolean);
    return segments.join(c("dim", " · "));
  }

  composerContextLabel() {
    const usage = (this.currentChat || {}).usage;
    const text = formatContextUsage(usage);
    if (!text) return "";
    const used = usage?.used;
    const size = usage?.size;
    if (typeof used === "number" && typeof size === "number" && size > 0) {
      const pct = used / size;
      const color = pct >= 0.85 ? "red" : pct >= 0.6 ? "yellow" : "green";
      return c(color, text);
    }
    return c("dim", text);
  }

  composerQueueLabel() {
    const pending = this.currentChat?.queued || 0;
    return pending ? c("yellow", `${pending} queued`) : "";
  }

  composerMcpLabel() {
    const count = this.currentChat?.mcpServers?.length || 0;
    return count ? `+${count} mcp` : "";
  }

  composerAttachmentLabel() {
    const count = this.pendingAttachments.length;
    if (!count) return "";
    const totalSize = this.pendingAttachments.reduce((sum, attachment) => sum + (Number(attachment.size) || 0), 0);
    return `${count} attachment${count === 1 ? "" : "s"} ${formatBytes(totalSize)}`;
  }

  composerRootsLabel(chat) {
    const roots = normalizeAdditionalDirectories(chat.additionalDirectories || [], chat.cwd || this.cwd);
    if (!roots.length) return "";
    return `+${roots.length} root${roots.length === 1 ? "" : "s"}`;
  }

  shouldEchoSubmittedInput(text) {
    const trimmed = String(text || "").trim();
    return Boolean(trimmed) && (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/agent "));
  }

  formatSubmittedInput(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("//")) return this.formatSubmittedBlock(trimmed.slice(1));
    if (trimmed.startsWith("/agent ")) return this.formatSubmittedBlock(trimmed.slice(7).trim());
    return this.formatSubmittedBlock(trimmed);
  }

  formatSubmittedBlock(text) {
    // Provider-tinted rail so each chat's user turns carry its accent.
    const accent = providerAccentSeq(this.currentChat?.provider);
    const reset = colors.reset || "";
    const rail = (glyph) =>
      accent ? `${accent}${colors.bold || ""}${glyph}${reset}` : c("cyan", c("bold", glyph));
    return String(text || "")
      .split("\n")
      .map((line, index) => `${rail(index === 0 ? "❯" : "│")} ${c("bold", line)}`)
      .join("\n");
  }

  renderUserTurn(text) {
    // A blank line before the user turn separates it from the previous response;
    // the pending break inserts a gap before the next response starts.
    this.logLine(`\n${this.formatSubmittedBlock(cleanInline(text))}`);
    this.pendingResponseBreak = true;
  }

  rawInputViewport(session, maxWidth) {
    const line = String(session.line || "").replace(/\n/g, " ");
    const cursor = Math.max(0, Math.min(session.cursor, line.length));

    if (line.length <= maxWidth) {
      return { text: line, cursorColumn: cursor };
    }

    const marker = "...";
    const bodyWidth = Math.max(4, maxWidth - marker.length * 2);
    let start = Math.max(0, cursor - Math.floor(bodyWidth * 0.7));
    let end = Math.min(line.length, start + bodyWidth);

    if (end === line.length) {
      start = Math.max(0, end - bodyWidth);
    }

    const left = start > 0 ? marker : "";
    const right = end < line.length ? marker : "";
    const visible = `${left}${line.slice(start, end)}${right}`;
    const cursorColumn =
      left.length + stringDisplayWidth(line.slice(start, Math.max(start, Math.min(cursor, end))));

    return { text: visible, cursorColumn };
  }

  rawInputMultilineViewport(session, maxWidth, maxRows) {
    const line = session.line || "";
    const visualLines = rawInputVisualLines(line, maxWidth);
    const cursor = Math.max(0, Math.min(session.cursor, line.length));
    const cursorLine = rawVisualLineIndexAtCursor(visualLines, cursor);
    const start = Math.min(Math.max(0, cursorLine - maxRows + 1), Math.max(0, visualLines.length - maxRows));
    const end = Math.min(visualLines.length, start + maxRows);
    const visibleLines = visualLines.slice(start, end);
    const rows = visibleLines.map((segment, offset) => {
      const index = start + offset;
      const isCursorLine = index === cursorLine;
      const prefix = this.rawInputRowPrefix(segment, index, offset, start, end, visualLines.length);
      const cursorUnits = Math.max(0, Math.min(cursor - segment.start, segment.text.length));
      return {
        prefix,
        text: segment.text,
        // Cursor column in display columns (wide chars take two).
        cursorColumn: isCursorLine ? stringDisplayWidth(segment.text.slice(0, cursorUnits)) : 0,
      };
    });

    if (!line) {
      rows[0] = {
        prefix: this.rawInputPrefix(this.inputMarker()),
        text: COMPOSER_PLACEHOLDER,
        cursorColumn: 0,
        placeholder: true,
      };
    }

    return {
      rows,
      cursorRow: Math.max(0, Math.min(maxRows - 1, cursorLine - start)),
      cursorColumn: rows[Math.max(0, Math.min(maxRows - 1, cursorLine - start))]?.cursorColumn || 0,
      hiddenAbove: start,
      hiddenBelow: Math.max(0, visualLines.length - end),
    };
  }

  rawInputRowPrefix(segment, index) {
    // Overflow is signalled by ↑/↓ counters in the box border, not by prefix
    // markers, so every row after the first just aligns under the marker.
    if (index === 0) return this.rawInputPrefix(this.inputMarker());
    return this.rawInputPrefix("  ");
  }

  rawInputPrefix(marker) {
    return `${" ".repeat(COMPOSER_INPUT_SIDE_PADDING)}${marker}`;
  }

  // Autocomplete dropdown state, derived from the input each render/keypress.
  // Only the selection index and the Esc suppression are stateful (on the
  // session, keyed by kind+query so they reset the moment the input changes).
  composerAutocomplete(session) {
    if (!session || session.pinned === false || session.searchActive || session.pasteActive) {
      return null;
    }

    const line = session.line || "";
    if (!line) return null;

    if (line.startsWith("/") && !line.startsWith("//")) {
      const token = line.split(/\s+/)[0];
      const cursor = Math.max(0, Math.min(session.cursor, line.length));
      if (cursor > token.length) return null;

      const matches = this.chatCommands().filter((command) => command.name.startsWith(token));
      if (!matches.length) return null;
      if (matches.length === 1 && matches[0].name === token) return null;
      // An exactly-typed command sorts first so Enter submits it instead of
      // accepting a longer completion (e.g. /mode while /model also matches).
      const exactIndex = matches.findIndex((command) => command.name === token);
      if (exactIndex > 0) matches.unshift(...matches.splice(exactIndex, 1));
      return { kind: "command", token, matches: matches.slice(0, 5), key: `c:${token}` };
    }

    const mention = this.currentFileMention(session);
    if (mention) {
      const files = this.fileMentionMatches(mention.query, 5);
      if (!files.length) return null;
      return {
        kind: "mention",
        mention,
        matches: files.map((file) => ({ name: `@${file}`, file })),
        key: `m:${mention.query}`,
      };
    }

    return null;
  }

  activeAutocomplete(session = this.rawInput) {
    if (!session) return null;
    if (!(this.shouldUseBoxedComposer() && session.pinned !== false)) return null;

    const state = this.composerAutocomplete(session);
    if (!state) return null;
    if (session.autocompleteSuppressedKey === state.key) return null;

    if (session.autocompleteKey !== state.key) {
      session.autocompleteKey = state.key;
      session.autocompleteIndex = 0;
    }
    state.index = Math.max(0, Math.min(session.autocompleteIndex, state.matches.length - 1));
    return state;
  }

  acceptAutocomplete(session, dropdown) {
    const entry = dropdown.matches[dropdown.index];
    if (!entry) return;

    if (dropdown.kind === "command") {
      const replacement = `${entry.name} `;
      session.line = `${replacement}${session.line.slice(dropdown.token.length).trimStart()}`;
      session.cursor = replacement.length;
      session.historyIndex = this.inputHistory.length;
      this.saveRawDraft(session);
    } else {
      this.replaceRawRange(
        session,
        dropdown.mention.start,
        dropdown.mention.end,
        `@${escapeMentionPath(entry.file)}`,
      );
    }
  }

  // Returns true when the key drove the dropdown (caller stops processing).
  handleAutocompleteKey(session, input, key) {
    const dropdown = this.activeAutocomplete(session);
    if (!dropdown) return false;

    const count = dropdown.matches.length;

    if (key.name === "down" || (key.name === "tab" && !key.shift && count > 1)) {
      session.autocompleteIndex = (dropdown.index + 1) % count;
      this.renderRawInput();
      return true;
    }

    if (key.name === "up" || (key.name === "tab" && key.shift)) {
      session.autocompleteIndex = (dropdown.index - 1 + count) % count;
      this.renderRawInput();
      return true;
    }

    if (key.name === "tab") {
      this.acceptAutocomplete(session, dropdown);
      this.renderRawInput();
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      // An exactly-typed command falls through so Enter still submits.
      if (dropdown.kind === "command" && dropdown.matches[dropdown.index]?.name === dropdown.token) {
        return false;
      }
      this.acceptAutocomplete(session, dropdown);
      this.renderRawInput();
      return true;
    }

    if (key.name === "right" && session.cursor === session.line.length) {
      this.acceptAutocomplete(session, dropdown);
      this.renderRawInput();
      return true;
    }

    if (key.name === "escape") {
      session.autocompleteSuppressedKey = dropdown.key;
      this.renderRawInput();
      return true;
    }

    return false;
  }

  completeRawSlashCommand(session) {
    if (!session.line.startsWith("/") || session.line.startsWith("//")) return;

    const token = session.line.split(/\s+/)[0];
    const matches = this.chatCommands()
      .map((command) => command.name)
      .filter((name) => name.startsWith(token));

    if (matches.length !== 1) return;

    const replacement = `${matches[0]} `;
    session.line = `${replacement}${session.line.slice(token.length).trimStart()}`;
    session.cursor = replacement.length;
  }

  completeRawFileMention(session) {
    const mention = this.currentFileMention(session);
    if (!mention) return false;

    const matches = this.fileMentionMatches(mention.query, 8);
    if (!matches.length) return false;

    if (matches.length === 1) {
      this.replaceRawRange(session, mention.start, mention.end, `@${escapeMentionPath(matches[0])}`);
      return true;
    }

    const common = commonPathPrefix(matches);
    if (common && common.length > mention.query.length) {
      this.replaceRawRange(session, mention.start, mention.end, `@${escapeMentionPath(common)}`);
      return true;
    }

    return false;
  }

  replaceRawRange(session, start, end, text) {
    session.line = `${session.line.slice(0, start)}${text}${session.line.slice(end)}`;
    session.cursor = start + text.length;
    session.historyIndex = this.inputHistory.length;
    this.saveRawDraft(session);
  }

  inputHint(line) {
    if (this.scrollOffsetRows > 0) {
      return "viewing history · PgUp/PgDn scroll · Esc jumps to latest";
    }
    if (this.rawInput?.searchActive) {
      const matches = this.rawHistorySearchMatches(this.rawInput.searchQuery);
      const position = matches.length ? `${this.rawInput.searchIndex + 1}/${matches.length}` : "0/0";
      return `history ${position}: ${this.rawInput.searchQuery || "-"}`;
    }
    if (this.rawInput?.pasteActive) return "pasting block...";
    if (!line && this.pendingAttachments.length) {
      return footerParts([
        this.rawInput?.lastPasteSummary,
        "Enter sends attachments",
        "Backspace removes last",
        "/detach all clears",
      ]).join(" · ");
    }
    if (this.rawInput?.lastPasteSummary) return this.rawInput.lastPasteSummary;
    const mention = this.currentFileMention(this.rawInput);
    if (mention) {
      const matches = this.fileMentionMatches(mention.query, 5);
      if (!matches.length) return "@ no file matches";
      return matches.map((match) => `@${match}`).join(" ");
    }
    if (looksLikePathInput(line)) {
      const pathAttachments = attachmentsFromPathOnlyText(line, this.currentChat?.cwd || this.cwd);
      if (pathAttachments.length) return `Enter attaches ${pastedAttachmentSummary(pathAttachments)}`;
    }
    if (line && line.includes("\n")) return "Enter sends · Ctrl+J, Alt+J, or Alt+Enter inserts newline";
    if (!line) return "";
    if (!line.startsWith("/") || line.startsWith("//")) return "";

    const token = line.split(/\s+/)[0];
    const matches = this.chatCommands().filter((command) => command.name.startsWith(token));
    if (!matches.length) return "unknown command";
    if (matches.length === 1 && matches[0].name === token) return matches[0].hint;

    return matches
      .slice(0, 5)
      .map((command) => command.name)
      .join(" ");
  }

  currentFileMention(session) {
    if (!session?.line) return null;
    const cursor = Math.max(0, Math.min(session.cursor, session.line.length));
    const before = session.line.slice(0, cursor);
    const match = /(^|[\s([{,])@([^\s]*)$/.exec(before);
    if (!match) return null;
    const start = before.length - match[2].length - 1;
    const end = cursor;
    return {
      start,
      end,
      query: unescapeMentionPath(match[2]),
    };
  }

  fileMentionMatches(query, limit = 10) {
    const files = this.projectFileMentions(this.currentChat?.cwd || this.cwd);
    const cleanQuery = normalizeMentionQuery(query);
    const matches = [];

    for (const file of files) {
      const score = fileMentionScore(file, cleanQuery);
      if (score < 0) continue;
      matches.push({ file, score });
    }

    return matches
      .sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file))
      .slice(0, limit)
      .map((entry) => entry.file);
  }

  projectFileMentions(cwd) {
    const root = path.resolve(cwd || this.cwd);
    const cached = this.fileMentionCache.get(root);
    if (cached && Date.now() - cached.timestamp < FILE_MENTION_CACHE_MS) return cached.files;

    const files = listProjectFiles(root, FILE_MENTION_LIMIT);
    this.fileMentionCache.set(root, { timestamp: Date.now(), files });
    return files;
  }

  chatCommands() {
    return [
      { name: "/menu", hint: "open agent/chat menu" },
      { name: "/control", hint: "open command center" },
      { name: "/cmd", hint: "open command center" },
      { name: "/panel", hint: "open command center" },
      { name: "/chats", hint: "show chat selector" },
      { name: "/compose", hint: "multiline prompt; finish with ." },
      { name: "/edit", hint: "write prompt in $VISUAL or $EDITOR" },
      { name: "/new", hint: "create another provider chat" },
      { name: "/refresh", hint: "import provider sessions" },
      { name: "/config", hint: "show or set ACP config options" },
      { name: "/model", hint: "set model config option" },
      { name: "/effort", hint: "set effort/reasoning option" },
      { name: "/commands", hint: "show provider commands" },
      { name: "/modes", hint: "show provider modes" },
      { name: "/mode", hint: "set provider mode" },
      { name: "/access", hint: "set access alias" },
      { name: "/permissions", hint: "set access alias" },
      { name: "/roots", hint: "manage additional directories" },
      { name: "/attach", hint: "attach file(s) to next prompt" },
      { name: "/attachments", hint: "show pending attachments" },
      { name: "/files", hint: "show pending attachments" },
      { name: "/detach", hint: "remove pending attachments" },
      { name: "/cancel", hint: "cancel current turn" },
      { name: "/allow", hint: "approve permission option" },
      { name: "/deny", hint: "reject permission" },
      { name: "/rename", hint: "rename this chat" },
      { name: "/title", hint: "rename this chat" },
      { name: "/activity", hint: "tool activity: compact, hidden, debug" },
      { name: "/debug", hint: "toggle hub internals" },
      { name: "/help", hint: "show command help" },
      { name: "/exit", hint: "close popup client" },
    ];
  }

  logLine(text = "", options = {}) {
    if (!options.skipChunkFlush) {
      this.flushChunkBuffer({ force: true, preservePendingMarkdownTable: true });
    }
    if (this.canPaintPinned()) {
      this.emitTranscript(`${text}\n`, options);
      return;
    }
    if (options.recordTranscript !== false) this.recordTranscriptOutput(`${text}\n`);
    this.beforeAsyncOutput();
    process.stdout.write(`${text}\n`);
    this.afterAsyncOutput();
  }

  hasPendingStreamState() {
    return Boolean(this.chunkBuffer || this.mdHeldLine !== null || this.liveTable);
  }

  writeChunk(text = "", options = {}) {
    if (!text) return;

    const markdown = options.markdown === true;
    const dim = options.dim === true;
    if (
      this.hasPendingStreamState() &&
      (this.chunkBufferMarkdown !== markdown || this.chunkBufferDim !== dim)
    ) {
      this.flushChunkBuffer({ force: true });
    }

    this.chunkBufferMarkdown = markdown;
    this.chunkBufferDim = dim;
    this.chunkBuffer += String(text);
    this.flushChunkBuffer();
  }

  renderMarkdown(text, { width = null } = {}) {
    const input = String(text || "");
    const hasTrailingNewline = input.endsWith("\n");
    const lines = input.split("\n");
    if (hasTrailingNewline) lines.pop();

    const output = [];
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const fence = line.match(/^\s*```(\S*)?\s*$/);

      if (fence) {
        this.markdownFence = !this.markdownFence;
        output.push(this.markdownFence && fence[1] ? codeFenceHeader(fence[1], width) : "");
        index += 1;
        continue;
      }

      if (this.markdownFence) {
        output.push(codeBlockLine(line, { width }));
        index += 1;
        continue;
      }

      if (isMarkdownTableStart(lines, index)) {
        const tableLines = [lines[index], lines[index + 1]];
        index += 2;

        while (index < lines.length && isMarkdownTableRow(lines[index])) {
          tableLines.push(lines[index]);
          index += 1;
        }

        output.push(renderMarkdownTable(tableLines));
        continue;
      }

      output.push(this.renderMarkdownLine(line, width));
      index += 1;
    }

    const rendered = output.join("\n");
    return `${rendered}${hasTrailingNewline ? "\n" : ""}`;
  }

  // renderMarkdown for text outside the transcript stream (picker preview):
  // the fence flag is streaming state shared with the live chunk machine, so
  // it must survive this call untouched.
  renderMarkdownDetached(text, width = null) {
    const savedFence = this.markdownFence;
    this.markdownFence = false;
    try {
      return this.renderMarkdown(text, { width });
    } finally {
      this.markdownFence = savedFence;
    }
  }

  renderMarkdownLine(line, width = null) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) return c("bold", renderInlineMarkdown(heading[2].trim()));

    if (/^\s*[-*_]{3,}\s*$/.test(line)) return c("dim", horizontalRuleLine(width));

    const quote = line.match(/^(\s*)>\s?(.*)$/);
    if (quote) return `${quote[1]}${c("dim", "|")} ${renderInlineMarkdown(quote[2])}`;

    const task = line.match(/^(\s*)[-*+]\s+\[([ xX-])\]\s+(.+)$/);
    if (task) {
      const marker = /x/i.test(task[2]) ? c("green", "x") : c("dim", " ");
      return `${task[1]}[${marker}] ${renderInlineMarkdown(task[3])}`;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (unordered) return `${unordered[1]}${c("dim", "-")} ${renderInlineMarkdown(unordered[2])}`;

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      return `${ordered[1]}${c("dim", `${ordered[2]}.`)} ${renderInlineMarkdown(ordered[3])}`;
    }

    return renderInlineMarkdown(line);
  }

  flushChunkBuffer(options = {}) {
    // Markdown streamed into the pinned layout goes through the line machine:
    // tables render progressively and are re-painted in place as rows arrive.
    if (this.chunkBufferMarkdown && !this.chunkBufferDim && this.canPaintPinned()) {
      this.flushMarkdownStream(options);
      return;
    }

    if (!this.chunkBuffer) return;

    let text;
    if (options.force) {
      if (
        options.preservePendingMarkdownTable &&
        this.chunkBufferMarkdown &&
        hasPendingMarkdownTable(this.chunkBuffer)
      ) {
        return;
      }
      text = this.chunkBuffer;
      this.chunkBuffer = "";
    } else {
      const newline = this.chunkBuffer.lastIndexOf("\n");
      if (newline === -1) return;
      if (this.chunkBufferMarkdown && hasPendingMarkdownTable(this.chunkBuffer)) return;

      text = this.chunkBuffer.slice(0, newline + 1);
      this.chunkBuffer = this.chunkBuffer.slice(newline + 1);
    }

    const output = this.formatChunkBufferText(text);
    let written = output;
    if (options.force && !output.endsWith("\n")) written += "\n";

    if (this.canPaintPinned()) {
      // Pinned layout active (e.g. dim thought chunks): soft-wrapped emit so
      // painted rows match the recorded transcript.
      this.emitTranscript(written);
    } else {
      this.recordTranscriptOutput(written);
      this.beforeAsyncOutput();
      process.stdout.write(output);
      if (options.force && !output.endsWith("\n")) {
        process.stdout.write("\n");
      }
      this.afterAsyncOutput();
    }

    if (!this.chunkBuffer) {
      this.chunkBufferMarkdown = false;
      this.chunkBufferDim = false;
    }
  }

  flushMarkdownStream(options = {}) {
    let complete = "";
    if (options.force) {
      complete = this.chunkBuffer;
      this.chunkBuffer = "";
    } else {
      const newline = this.chunkBuffer.lastIndexOf("\n");
      if (newline === -1) return;
      complete = this.chunkBuffer.slice(0, newline + 1);
      this.chunkBuffer = this.chunkBuffer.slice(newline + 1);
    }

    if (complete) {
      const lines = complete.split("\n");
      const trailing = lines.pop();
      // A force flush can cut a line mid-stream; render the partial as a line.
      if (trailing) lines.push(trailing);
      for (const line of lines) this.feedMarkdownLine(line);
    }

    if (options.force) {
      this.finalizeMarkdownStream();
      this.chunkBufferMarkdown = false;
      this.chunkBufferDim = false;
    }
  }

  // One logical markdown line at a time: fences pass through, a lone table row
  // is held until the separator proves a table started, and table rows feed
  // the live table which re-renders in place.
  feedMarkdownLine(line) {
    const fence = line.match(/^\s*```(\S*)?\s*$/);
    if (fence) {
      this.finalizeMarkdownStream();
      this.markdownFence = !this.markdownFence;
      this.emitTranscript(`${this.markdownFence && fence[1] ? codeFenceHeader(fence[1]) : ""}\n`);
      return;
    }

    if (this.markdownFence) {
      this.emitTranscript(`${codeBlockLine(line)}\n`);
      return;
    }

    if (this.liveTable) {
      if (isMarkdownTableRow(line)) {
        this.liveTable.sourceLines.push(line);
        this.scheduleLiveTablePaint();
        return;
      }
      this.finalizeLiveTable();
    }

    if (this.mdHeldLine !== null) {
      const held = this.mdHeldLine;
      this.mdHeldLine = null;
      if (isMarkdownTableSeparator(line)) {
        this.startLiveTable([held, line]);
        return;
      }
      this.emitTranscript(`${this.renderMarkdownLine(held)}\n`);
    }

    if (isMarkdownTableRow(line) && !isMarkdownTableSeparator(line)) {
      this.mdHeldLine = line;
      return;
    }

    this.emitTranscript(`${this.renderMarkdownLine(line)}\n`);
  }

  finalizeMarkdownStream() {
    if (this.mdHeldLine !== null) {
      const held = this.mdHeldLine;
      this.mdHeldLine = null;
      this.emitTranscript(`${this.renderMarkdownLine(held)}\n`);
    }
    this.finalizeLiveTable();
  }

  renderLiveTableLines(sourceLines) {
    const width = this.transcriptWrapWidth();
    return renderMarkdownTable(sourceLines)
      .split("\n")
      .map((row) => (visibleLength(row) > width ? truncateAnsiText(row, width) : row));
  }

  startLiveTable(sourceLines) {
    const rendered = this.renderLiveTableLines(sourceLines);
    this.liveTable = {
      sourceLines,
      startIndex: this.transcriptLines.length - 1,
      lineCount: rendered.length,
      paintedCount: rendered.length,
      rendered,
    };
    this.emitTranscript(`${rendered.join("\n")}\n`);
  }

  // Re-renders the streaming table with widths recomputed from all rows so far
  // and replaces its logical lines in the transcript. Runs synchronously per
  // row so the buffer (scrollback, repaints) is always current.
  syncLiveTableBuffer() {
    const table = this.liveTable;
    if (!table) return [];

    const rendered = this.renderLiveTableLines(table.sourceLines);
    this.transcriptLines.splice(table.startIndex, table.lineCount, ...rendered);
    table.lineCount = rendered.length;
    table.rendered = rendered;
    return rendered;
  }

  scheduleLiveTablePaint() {
    if (!this.liveTable) return;
    this.syncLiveTableBuffer();

    if (this.liveTablePaintTimer) {
      this.liveTablePaintPending = true;
      return;
    }

    this.paintLiveTable();
    this.liveTablePaintTimer = setTimeout(() => {
      this.liveTablePaintTimer = null;
      if (this.liveTablePaintPending && this.liveTable) {
        this.liveTablePaintPending = false;
        this.paintLiveTable();
      }
    }, LIVE_TABLE_PAINT_MS);
    this.liveTablePaintTimer.unref?.();
  }

  // Paints the current table block in place at the bottom of the scroll
  // region: scrolls up for rows added since the last paint, then rewrites the
  // visible block rows (widths may have changed).
  paintLiveTable() {
    const table = this.liveTable;
    if (!table) return;

    const rendered = table.rendered || this.syncLiveTableBuffer();
    const delta = table.lineCount - table.paintedCount;
    table.paintedCount = table.lineCount;

    if (this.activePicker) return;

    if (this.scrollOffsetRows > 0) {
      if (delta > 0) this.scrollNewRows += delta;
      if (this.rawInput) this.renderRawInput();
      return;
    }

    if (!this.canPaintPinned()) return;

    if (delta < 0) {
      this.repaintPinnedOutput();
      return;
    }

    const bottom = this.pinnedOutputRows();
    const painter = new FramePainter();
    if (delta > 0) {
      painter.to(0, bottom - 1).text("\r\n".repeat(delta));
    }

    const blockTop = bottom - rendered.length;
    const visible = rendered.slice(Math.max(0, -blockTop));
    const startRow = Math.max(0, blockTop);
    visible.forEach((row, index) => {
      painter.to(0, startRow + index).clearLine().text(row).text(colors.reset || "");
    });
    this.restoreComposerCursor(painter);
    painter.flush();
  }

  finalizeLiveTable() {
    if (!this.liveTable) return;
    if (this.liveTablePaintTimer) {
      clearTimeout(this.liveTablePaintTimer);
      this.liveTablePaintTimer = null;
    }
    this.liveTablePaintPending = false;
    this.syncLiveTableBuffer();
    this.paintLiveTable();
    this.liveTable = null;
  }

  formatChunkBufferText(text) {
    let output = this.chunkBufferMarkdown ? this.renderMarkdown(text) : text;
    if (this.chunkBufferDim) output = c("dim", output);
    return output;
  }

  beforeAsyncOutput() {
    if (!this.questionActive) return;

    if (this.rawInput) {
      this.clearRawInputLine();
      if (this.rawInput.pinned) {
        this.enableRawInputLayout(this.rawInput);
        readlineTerminal.cursorTo(process.stdout, 0, this.rawInputLayout(this.rawInput).outputBottom - 1);
      }
      return;
    }

    if (process.stdout.isTTY) {
      readlineTerminal.clearLine(process.stdout, 0);
      readlineTerminal.cursorTo(process.stdout, 0);
    } else {
      process.stdout.write("\n");
    }
  }

  afterAsyncOutput() {
    if (!this.questionActive || !process.stdout.isTTY) return;

    if (this.rawInput) {
      this.renderRawInput();
      return;
    }

    const line = this.rl.line || "";
    process.stdout.write(`${this.currentPrompt}${line}`);
  }

  clearScreen() {
    if (process.stdout.isTTY) {
      this.disableRawInputLayout();
      process.stdout.write("\x1b[2J\x1b[H");
    }
  }

  handleHubEvent(message) {
    if (this.closed) return;

    if (message.event === "shutdown") {
      this.logLine(c("yellow", "\nACP daemon stopped"));
      this.closed = true;
      if (this.rl) this.rl.close();
      return;
    }

    if (message.event === "permission_request" && message.chatId === this.currentChat?.id) {
      this.pendingPermission = {
        permissionId: message.permissionId,
        options: message.params.options || [],
      };
      return;
    }

    if (this.activePicker?.onEvent) {
      this.activePicker.onEvent(message);
    }

    if (message.type === "chat_state" && message.chat?.id === this.currentChat?.id) {
      this.currentChat = message.chat;
      this.refreshRawInputPrompt({ render: false });
      if (isSettledChatStatus(this.currentChat.status)) {
        this.flushChunkBuffer({ force: true });
      }
      this.refreshRawInputPrompt();
      return;
    }

    if (message.type === "chat_event" && message.chatId === this.currentChat?.id) {
      this.currentChat = message.chat || this.currentChat;
      this.refreshRawInputPrompt({ render: false });
      this.renderEvent(message.event);
    }
  }

  refreshRawInputPrompt(options = {}) {
    if (!this.rawInput) return;
    this.rawInput.prompt = this.inputPrompt();
    this.syncComposerSpinner();
    if (options.render !== false) this.renderRawInput();
  }

  syncComposerSpinner() {
    if (!this.rawInput?.pinned || !isActiveChatStatus(this.currentChat?.status)) {
      this.stopComposerSpinner();
      return;
    }

    if (this.composerSpinnerTimer) return;
    this.composerSpinnerTimer = setInterval(() => {
      if (!this.rawInput?.pinned || !isActiveChatStatus(this.currentChat?.status)) {
        this.stopComposerSpinner();
        if (this.rawInput) this.renderRawInput();
        return;
      }

      this.composerSpinnerFrame += 1;
      this.renderRawInput();
    }, COMPOSER_SPINNER_INTERVAL_MS);
    this.composerSpinnerTimer.unref?.();
  }

  stopComposerSpinner() {
    if (!this.composerSpinnerTimer) return;
    clearInterval(this.composerSpinnerTimer);
    this.composerSpinnerTimer = null;
  }

  // Seeds/refreshes the current window's metadata on direct user actions
  // (open, rename, mode change). Ongoing status updates are owned by the
  // daemon, which keeps windows fresh even when no popup is attached.
  syncTmuxWindow(chat, options = {}) {
    if (!chat || !process.env.TMUX) return;

    const now = Date.now();
    if (!options.force && now - this.lastTmuxMetadataAt < 750) return;
    this.lastTmuxMetadataAt = now;

    setTmuxWindowOptions(tmuxWindowOptionValues(chat));
  }

  renderEvent(event, options = {}) {
    switch (event.type) {
      case "system":
        if (options.replay && event.text?.startsWith("Starting ")) return;
        if (event.level === "error") {
          this.logLine(c("red", `\n✗ ${event.text}`));
        } else if (event.level === "warn") {
          this.logLine(c("yellow", `\n⚠ ${event.text}`));
        } else if (this.showInternalEvents) {
          this.logLine(c("dim", `[${event.level || "info"}] ${event.text}`));
        }
        break;
      case "adapter_log":
        if (!options.replay && this.showInternalEvents) this.logLine(c("dim", `[adapter] ${event.text}`));
        break;
      case "user":
        if (options.replay) this.renderUserTurn(event.text);
        break;
      case "agent_chunk":
        this.closeActivityBlock();
        this.renderResponseChunk(event);
        break;
      case "thought_chunk":
        this.renderThoughtChunk(event, options);
        break;
      case "tool_call":
        this.renderToolEvent(event, options);
        break;
      case "tool_update":
        this.renderToolEvent(event, options);
        break;
      case "plan":
        this.renderPlan(event.entries || [], options);
        break;
      case "permission":
        this.renderPermission(event);
        break;
      case "auth_required":
        this.logLine(`\n${c("yellow", event.text || "Authentication required")}`);
        break;
      case "turn_done":
        this.flushChunkBuffer({ force: true });
        this.closeActivityBlock();
        this.pendingResponseBreak = false;
        this.lastStreamEventKey = "";
        this.markdownFence = false;
        if (this.showInternalEvents || event.stopReason === "cancelled") {
          this.logLine(c("dim", `\n[done] ${event.stopReason}`));
        }
        break;
      case "error":
        this.logLine(c("red", `\n✗ ${event.text}`));
        break;
      case "raw_update":
        if (this.showInternalEvents) {
          this.logLine(c("dim", `\n[update] ${JSON.stringify(event.update)}`));
        }
        break;
      default:
        if (this.showInternalEvents) {
          this.logLine(c("dim", `\n[event] ${JSON.stringify(event)}`));
        }
    }
  }

  renderResponseChunk(event) {
    this.ensureResponseBreak();
    this.ensureStreamBoundary("agent", event.messageId);
    this.writeChunk(event.text || "", { markdown: true });
  }

  renderThoughtChunk(event, options = {}) {
    const visible = this.showInternalEvents || this.activityMode === "debug";
    if (!visible) return;

    this.closeActivityBlock();
    this.ensureResponseBreak();
    this.ensureStreamBoundary("thought", event.messageId);
    this.writeChunk(event.text || "", { markdown: true, dim: true });
  }

  ensureResponseBreak() {
    if (!this.pendingResponseBreak) return;

    this.flushChunkBuffer({ force: true, preservePendingMarkdownTable: true });
    if (this.canPaintPinned()) {
      this.emitTranscript("\n");
    } else {
      this.recordTranscriptOutput("\n");
      this.beforeAsyncOutput();
      process.stdout.write("\n");
      this.afterAsyncOutput();
    }
    this.pendingResponseBreak = false;
  }

  ensureStreamBoundary(type, messageId) {
    const key = `${type}:${messageId || ""}`;
    if (this.lastStreamEventKey && this.lastStreamEventKey !== key) {
      if (this.hasPendingStreamState()) {
        if (this.chunkBuffer && !/\n\s*$/.test(this.chunkBuffer)) this.chunkBuffer += "\n\n";
        this.flushChunkBuffer();
        // A held table-row candidate or live table must not leak into the next
        // message stream.
        if (!this.chunkBuffer && (this.mdHeldLine !== null || this.liveTable)) {
          this.finalizeMarkdownStream();
        }
      }
      // A new message stream starts fresh: don't let an unclosed code fence from
      // the previous message leak in and render everything after it raw.
      this.markdownFence = false;
    }
    this.lastStreamEventKey = key;
  }

  renderToolEvent(event, options = {}) {
    // A tool interrupts the agent's text run. Flush the buffered text first (so a
    // pending code block renders), then close any open code fence so a leftover
    // ``` doesn't render the following text (e.g. a results table) raw.
    this.flushChunkBuffer({ force: true });
    this.markdownFence = false;

    const status = event.status || "pending";
    const title = event.title || event.toolCallId || "tool";
    const kind = event.kind || "";
    const failed = /fail|error|denied|rejected|cancelled/i.test(status);

    if (failed && !this.showInternalEvents && this.activityMode !== "debug") {
      this.logLine(`\n${c("red", "✗")} ${c("red", status)} ${kind} ${cleanInline(title)}`);
      if (event.summary) this.logLine(c("dim", event.summary));
      return;
    }

    if (this.showInternalEvents || this.activityMode === "debug") {
      const color = failed ? "red" : "yellow";
      this.logLine(`\n${c(color, "[tool]")} ${status} ${kind} ${title}`);
      if (event.summary) this.logLine(c("dim", event.summary));
      return;
    }

    if (this.activityMode !== "hidden" && isCompletedToolStatus(status)) {
      this.renderActivityEvent(event);
      return;
    }

    if (!options.replay && /pending|progress|running/i.test(status)) {
      this.notify(`tool ${kind || "call"}: ${title}`);
    }
  }

  renderActivityEvent(event) {
    const group = activityGroupFor(event);
    const title = cleanInline(event.title || event.toolCallId || "tool");
    const summary = cleanActivitySummary(event.summary || "", group);

    if (this.lastActivityGroup && this.lastActivityGroup !== group) {
      this.logLine(c("dim", activityDividerLine()));
      this.activityGroupLineCount = 0;
    }

    if (this.lastActivityGroup !== group) {
      this.logLine("");
      this.logLine(`${c("green", "●")} ${c("bold", group)}`);
      this.lastActivityGroup = group;
      this.activityGroupLineCount = 0;
    }

    const prefix = this.activityGroupLineCount === 0 ? "  └ " : "    ";
    this.logLine(`${prefix}${title}`);
    this.activityGroupLineCount += 1;

    for (const line of summary) {
      this.logLine(c("dim", `      ${line}`));
    }
  }

  closeActivityBlock() {
    if (!this.lastActivityGroup) return;
    this.logLine(c("dim", activityDividerLine()));
    this.lastActivityGroup = "";
    this.activityGroupLineCount = 0;
    this.pendingResponseBreak = true;
    this.lastStreamEventKey = "";
  }

  renderPlan(entries, options = {}) {
    if (!entries.length) return;

    const signature = entries.map((entry) => `${entry.status} ${cleanInline(entry.content)}`).join("");
    // ACP re-sends the whole plan on every status change; skip identical repeats
    // so the transcript shows progression instead of duplicate blocks.
    if (!options.replay && signature === this.lastPlanSignature) return;
    this.lastPlanSignature = signature;

    const done = entries.filter((entry) => entry.status === "completed").length;
    this.closeActivityBlock();
    this.logLine(`\n${c("bold", "Plan")} ${c("dim", `(${done}/${entries.length})`)}`);
    for (const entry of entries) {
      this.logLine(`  ${planMarker(entry.status)} ${renderInlineMarkdown(cleanInline(entry.content))}`);
    }
  }

  showPlan() {
    const plan = this.currentChat?.plan;
    if (!plan?.entries?.length) {
      this.notify("no active plan for this chat");
      return;
    }
    this.lastPlanSignature = "";
    this.renderPlan(plan.entries, { replay: true });
  }

  showAuthPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("ACP Authentication", buildAuthPanelItems(this.currentChat, context, this.cwd));
  }

  printAuthMethods() {
    const methods = this.currentChat?.authMethods || [];
    if (!methods.length) {
      this.notify("no auth methods reported by this adapter");
      return;
    }
    this.logLine(c("bold", "\nAuthentication methods"));
    methods.forEach((method, index) => {
      const id = method.id || method.methodId || `method-${index + 1}`;
      const name = method.name || id;
      const type = method.type ? c("dim", ` (${method.type})`) : "";
      this.logLine(`${index + 1}. ${name} ${c("dim", `[${id}]`)}${type}`);
      if (method.description) this.logLine(c("dim", `   ${method.description}`));
    });
    this.logLine(c("dim", "Use /auth <id> or /auth <n>"));
  }

  async authenticateCurrentChat(arg) {
    const chatId = this.currentChat?.id;
    if (!chatId) return;
    const methods = this.currentChat?.authMethods || [];
    if (!methods.length) {
      this.notify("no auth methods reported by this adapter");
      return;
    }

    let methodId = arg;
    const byNumber = Number(arg);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= methods.length) {
      methodId = methods[byNumber - 1].id || methods[byNumber - 1].methodId;
    } else if (!methodId && methods.length === 1) {
      methodId = methods[0].id || methods[0].methodId;
    } else if (!methodId) {
      this.printAuthMethods();
      return;
    }

    try {
      await this.hub.call("authenticate", { chatId, methodId });
      this.notify("authenticated");
    } catch (error) {
      this.logLine(c("red", `Auth failed: ${error.message}`));
    }
  }

  showMcpPanel() {
    const context = this.tmuxContext();
    return this.showTmuxMenu("MCP Servers", buildMcpPanelItems(this.currentChat, context));
  }

  printMcpServers() {
    const servers = this.currentChat?.mcpServers || [];
    if (!servers.length) {
      this.notify("no MCP servers configured for this chat");
      return;
    }
    this.logLine(c("bold", "\nMCP servers"));
    servers.forEach((server, index) => {
      const target = server.url || server.command || "";
      this.logLine(`${index + 1}. ${mcpServerLabel(server)} ${c("dim", target)}`);
    });
  }

  setActivityMode(line) {
    const requested = line.split(/\s+/)[1] || "";
    const next = requested || (this.activityMode === "compact" ? "hidden" : "compact");
    const allowed = new Set(["compact", "hidden", "debug"]);

    if (!allowed.has(next)) {
      this.notify("activity modes: compact, hidden, debug");
      return;
    }

    this.activityMode = next;
    this.notify(`tool activity ${next}`);
  }

  // Permission is the one block that stops the agent, so it gets the
  // strongest flat treatment: a yellow rail card.
  renderPermission(event) {
    const tool = event.toolCall || {};
    const rail = c("yellow", "▎");
    const title = tool.title || tool.toolCallId || "Agent request";
    this.logLine("");
    this.logLine(`${rail} ${c("yellow", `⏸ Permission · ${cleanInline(title)}`)}${
      tool.kind ? `  ${c("dim", tool.kind)}` : ""
    }`);

    const options = event.options || [];
    const choices = options
      .map((option, index) => `${c("bold", String(index + 1))} ${option.name}`)
      .join("   ");
    if (choices) this.logLine(`${rail} ${choices}`);
    this.logLine(`${rail} ${c("dim", "/allow <n> · /deny")}`);
  }

  async answerPermission(line, intent) {
    if (!this.pendingPermission) {
      this.logLine(c("yellow", "No pending permission request"));
      return;
    }

    const options = this.pendingPermission.options || [];
    let option = null;

    if (intent === "allow") {
      const requested = Number(line.split(/\s+/)[1]);
      if (Number.isInteger(requested) && requested >= 1 && requested <= options.length) {
        option = options[requested - 1];
      } else {
        option =
          options.find((candidate) => String(candidate.kind || "").startsWith("allow")) ||
          options[0];
      }
    } else {
      option =
        options.find((candidate) => String(candidate.kind || "").startsWith("reject")) || null;
    }

    await this.hub.call("permission_response", {
      permissionId: this.pendingPermission.permissionId,
      optionId: option?.optionId || null,
    });
    this.pendingPermission = null;
  }
}

function statusGlyph(status) {
  switch (status) {
    case "idle":
      return "●";
    case "responding":
    case "thinking":
    case "working":
    case "planning":
      return "◐";
    case "starting":
    case "cancelling":
      return "◌";
    case "permission":
      return "⏸";
    case "auth":
      return "⊘";
    case "error":
      return "✗";
    case "stopped":
    case "closed":
      return "○";
    case "saved":
      return "·";
    default:
      return "•";
  }
}

function statusColorName(status) {
  switch (status) {
    case "idle":
    case "responding":
      return "green";
    case "error":
      return "red";
    case "permission":
    case "auth":
    case "planning":
    case "working":
    case "thinking":
    case "cancelling":
      return "yellow";
    case "starting":
      return "cyan";
    default:
      return "dim";
  }
}

function statusIndicator(status) {
  return c(statusColorName(status), `${statusGlyph(status)} ${status || "idle"}`);
}

function statusBadge(status) {
  const table = {
    saved: c("dim", "saved"),
    idle: c("green", "idle"),
    responding: c("cyan", "responding"),
    thinking: c("cyan", "thinking"),
    planning: c("yellow", "planning"),
    working: c("yellow", "working"),
    permission: c("yellow", "permission"),
    starting: c("dim", "starting"),
    cancelling: c("yellow", "cancelling"),
    stopped: c("dim", "stopped"),
    closed: c("dim", "closed"),
    error: c("red", "error"),
  };
  return table[status] || status || "unknown";
}

function isSettledChatStatus(status) {
  return ["idle", "error", "stopped", "closed", "saved"].includes(status);
}

function isActiveChatStatus(status) {
  return ["responding", "thinking", "planning", "working", "permission", "cancelling"].includes(
    normalizeToken(status || ""),
  );
}

function canMergeHistoryChunk(previous, next) {
  if (!previous || !next) return false;
  if (!["agent_chunk", "thought_chunk"].includes(next.type)) return false;
  if (previous.type !== next.type) return false;
  return (previous.messageId || null) === (next.messageId || null);
}

function cleanInline(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function rawLogicalLines(value) {
  return String(value || "").split("\n");
}

function rawLinePositions(value) {
  const text = String(value || "");
  const lines = rawLogicalLines(text);
  let offset = 0;

  return lines.map((line) => {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;
    return { start, end };
  });
}

function normalizePastedText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function shouldStorePasteAsAttachment(text) {
  const value = normalizePastedText(text);
  const lineCount = value.split("\n").length;
  return (
    Buffer.byteLength(value, "utf8") >= PASTE_TEXT_ATTACHMENT_MIN_CHARS ||
    lineCount >= PASTE_TEXT_ATTACHMENT_MIN_LINES
  );
}

function pastedTextSummary(text) {
  const value = normalizePastedText(text);
  const lineCount = value.split("\n").length;
  if (lineCount <= 1 && value.length < 1200) return "";
  return `pasted ${lineCount} line${lineCount === 1 ? "" : "s"} / ${formatBytes(
    Buffer.byteLength(value, "utf8"),
  )}`;
}

function pastedAttachmentSummary(attachments) {
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  const fileCount = attachments.length - imageCount;
  return [
    imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "",
    fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function createPastedTextAttachment(text) {
  const value = normalizePastedText(text);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `paste-${stamp}-${shortHash(value)}.txt`;
  const filePath = path.join(PASTES_DIR, name);
  fs.mkdirSync(PASTES_DIR, { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    name,
    size: stat.size,
    mimeType: "text/plain",
    kind: "file",
    generated: true,
  };
}

function attachmentsFromPathOnlyText(text, cwd) {
  const lines = normalizePastedText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length || lines.length > MAX_AUTO_ATTACH_PASTE_PATHS) return [];

  const attachments = [];
  const seen = new Set();
  for (const line of lines) {
    const lineAttachments = attachmentsFromPathLine(line, cwd);
    if (!lineAttachments.length) return [];

    for (const attachment of lineAttachments) {
      if (seen.has(attachment.path)) continue;
      seen.add(attachment.path);
      attachments.push(attachment);
      if (attachments.length > MAX_AUTO_ATTACH_PASTE_PATHS) return [];
    }
  }

  return attachments;
}

function attachmentsFromPathLine(line, cwd) {
  const direct = attachmentFromPathToken(line, cwd);
  if (direct) return [direct];

  const words = splitCommandWords(line);
  if (!words.length || words.length > MAX_AUTO_ATTACH_PASTE_PATHS) return [];

  const attachments = [];
  for (const word of words) {
    const attachment = attachmentFromPathToken(word, cwd);
    if (!attachment) return [];
    attachments.push(attachment);
  }
  return attachments;
}

function attachmentFromPathToken(token, cwd) {
  const resolved = resolvePastedPathToken(token, cwd);
  if (!resolved) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    const mimeType = mimeTypeForPath(resolved);
    return {
      path: resolved,
      name: path.basename(resolved),
      size: stat.size,
      mimeType,
      kind: mimeType.startsWith("image/") ? "image" : "file",
    };
  } catch {
    return null;
  }
}

function resolvePastedPathToken(token, cwd) {
  const value = normalizePastedPathToken(token);
  if (!value) return null;
  return path.resolve(cwd || process.cwd(), value.replace(/^~(?=$|\/)/, os.homedir()));
}

function normalizePastedPathToken(token) {
  let value = stripMatchingQuotes(String(token || "").trim());
  if (!value) return "";

  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      try {
        value = decodeURIComponent(value.replace(/^file:\/\//i, ""));
      } catch {}
    }
  }

  return stripMatchingQuotes(value).replace(/\\(.)/g, "$1");
}

function looksLikePathInput(value) {
  const text = stripMatchingQuotes(String(value || "").trim());
  return /^(?:file:\/\/|~(?:\/|$)|\/|\.{1,2}\/)/i.test(text);
}

function stripMatchingQuotes(value) {
  const text = String(value || "").trim();
  const quoted =
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")));
  if (quoted) {
    return text.slice(1, -1);
  }
  return text;
}

function rawInputVisualLines(value, width) {
  const maxWidth = Math.max(1, width || 1);
  const text = String(value || "");
  const logicalLines = rawLogicalLines(text);
  const positions = rawLinePositions(text);
  const result = [];

  logicalLines.forEach((line, logicalLine) => {
    const base = positions[logicalLine]?.start || 0;

    if (!line) {
      result.push({
        text: "",
        start: base,
        end: base,
        logicalLine,
        wrapIndex: 0,
      });
      return;
    }

    // Wrap by display columns (wide chars take two) while keeping segment
    // offsets in code units so cursor math stays unit-based.
    let offset = 0;
    let wrapIndex = 0;
    while (offset < line.length) {
      let end = offset;
      let width = 0;
      while (end < line.length) {
        const codePoint = line.codePointAt(end);
        const char = String.fromCodePoint(codePoint);
        const charWidth = stringDisplayWidth(char);
        if (width > 0 && width + charWidth > maxWidth) break;
        end += char.length;
        width += charWidth;
      }
      result.push({
        text: line.slice(offset, end),
        start: base + offset,
        end: base + end,
        logicalLine,
        wrapIndex,
      });
      offset = end;
      wrapIndex += 1;
    }
  });

  return result.length
    ? result
    : [
        {
          text: "",
          start: 0,
          end: 0,
          logicalLine: 0,
          wrapIndex: 0,
        },
      ];
}

function rawVisualLineIndexAtCursor(visualLines, cursor) {
  const safeCursor = Math.max(0, cursor || 0);
  const startMatch = visualLines.findIndex((line, index) => index > 0 && safeCursor === line.start);
  if (startMatch !== -1) return startMatch;

  const contains = visualLines.findIndex((line) => safeCursor >= line.start && safeCursor < line.end);
  if (contains !== -1) return contains;

  for (let index = visualLines.length - 1; index >= 0; index -= 1) {
    const line = visualLines[index];
    if (safeCursor === line.end || (line.start === line.end && safeCursor === line.start)) return index;
  }

  return Math.max(0, visualLines.length - 1);
}

function rawPreviousWord(text, cursor) {
  let index = Math.max(0, Math.min(cursor, String(text || "").length));
  const value = String(text || "");
  while (index > 0 && /\s/.test(value[index - 1])) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1])) index -= 1;
  return index;
}

function rawNextWord(text, cursor) {
  let index = Math.max(0, Math.min(cursor, String(text || "").length));
  const value = String(text || "");
  while (index < value.length && !/\s/.test(value[index])) index += 1;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function listProjectFiles(root, limit = FILE_MENTION_LIMIT) {
  return listProjectFilesWithRg(root, limit) || listProjectFilesFallback(root, limit);
}

function listProjectFilesWithRg(root, limit) {
  const result = spawnSync("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!node_modules", "-g", "!vendor"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error || result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function listProjectFilesFallback(root, limit) {
  const ignored = new Set([".git", "node_modules", "vendor", ".next", "dist", "build", ".cache"]);
  const files = [];
  const stack = [root];

  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(relative);
        if (files.length >= limit) break;
      }
    }
  }

  return files;
}

function normalizeMentionQuery(value) {
  return String(value || "")
    .replace(/^@/, "")
    .replace(/\\ /g, " ")
    .toLowerCase();
}

function fileMentionScore(file, query) {
  if (!query) return 1;

  const target = file.toLowerCase();
  const base = path.basename(file).toLowerCase();
  if (target === query) return 1000;
  if (base === query) return 900;
  if (target.startsWith(query)) return 800 - target.length * 0.01;
  if (base.startsWith(query)) return 750 - base.length * 0.01;
  if (target.includes(query)) return 650 - target.indexOf(query) - target.length * 0.01;
  if (base.includes(query)) return 600 - base.indexOf(query) - base.length * 0.01;

  let cursor = 0;
  let score = 0;
  for (const char of query) {
    const index = target.indexOf(char, cursor);
    if (index === -1) return -1;
    score += index === cursor ? 8 : 2;
    cursor = index + 1;
  }
  return score - target.length * 0.02;
}

function commonPathPrefix(paths) {
  if (!paths.length) return "";
  let prefix = paths[0];
  for (const file of paths.slice(1)) {
    while (prefix && !file.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.replace(/[^/]*$/, "");
}

function escapeMentionPath(value) {
  return String(value || "").replace(/\s/g, "\\ ");
}

function unescapeMentionPath(value) {
  return String(value || "").replace(/\\ /g, " ");
}

function extractFileMentions(text) {
  const mentions = [];
  const pattern = /(^|[\s([{,])@((?:\\\s|[^\s])+)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const value = unescapeMentionPath(match[2]).replace(/[),.;:!?]+$/, "");
    if (value && !value.startsWith("@")) mentions.push(value);
  }
  return mentions;
}

function mentionAttachmentsForText(root, text, existingAttachments = []) {
  const existing = new Set();
  for (const attachment of existingAttachments || []) {
    const rawPath = typeof attachment === "string" ? attachment : attachment?.path;
    if (!rawPath) continue;
    existing.add(path.resolve(root || process.cwd(), rawPath));
  }

  const attachments = [];
  for (const mention of extractFileMentions(text)) {
    const resolved = path.resolve(root || process.cwd(), mention);
    if (existing.has(resolved)) continue;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) continue;
      existing.add(resolved);
      const mimeType = mimeTypeForPath(resolved);
      attachments.push({
        path: resolved,
        name: path.basename(resolved),
        size: stat.size,
        mimeType,
        kind: mimeType.startsWith("image/") ? "image" : "file",
      });
    } catch {
      // Unresolved @mentions remain plain prompt text.
    }
  }
  return attachments;
}

function stripAnsi(value) {
  return stripAnsiSequences(value);
}

function visibleLength(value) {
  return stringDisplayWidth(value);
}

function sameRawInputLayout(left, right) {
  if (!left || !right) return false;
  const keys = [
    "rows",
    "columns",
    "boxed",
    "attachmentRows",
    "hintRows",
    "inputPadRows",
    "inputRows",
    "outputBottom",
    "gapRow",
    "dividerRow",
    "boxBottomRow",
    "dropdownRows",
    "dropdownRow",
    "attachmentRow",
    "inputPadTopRow",
    "inputRow",
    "inputPadBottomRow",
    "footerRow",
    "hintRow",
  ];
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }

  const leftRows = left.composerRows || [];
  const rightRows = right.composerRows || [];
  if (leftRows.length !== rightRows.length) return false;
  return leftRows.every((row, index) => row === rightRows[index]);
}

function padVisible(value, width) {
  const text = String(value || "");
  const padding = Math.max(0, width - visibleLength(text));
  return `${text}${" ".repeat(padding)}`;
}

function renderInlineMarkdown(value) {
  const tokens = [];
  const protect = (rendered) => {
    const token = `\x00MD${tokens.length}\x00`;
    tokens.push(rendered);
    return token;
  };
  let text = String(value || "");

  text = text.replace(/`([^`]+)`/g, (_, code) => {
    return protect(c("cyan", code));
  });

  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const label = alt ? `image: ${alt}` : "image";
    return protect(`[${label}] ${c("dim", `(${url})`)}`);
  });
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, url) => protect(`${label} ${c("dim", `(${url})`)}`),
  );
  text = text.replace(/<((?:https?:|file:)[^>\s]+)>/g, (_, url) => protect(c("dim", url)));
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, rendered) => c("bold", rendered));
  text = text.replace(/(^|[^\w_])__([^_\n]+)__(?![\w_])/g, (_, prefix, rendered) => {
    if (/^\w+$/.test(rendered)) return `${prefix}__${rendered}__`;
    return `${prefix}${c("bold", rendered)}`;
  });
  text = text.replace(/~~([^~]+)~~/g, (_, rendered) => c("strike", rendered));
  text = text.replace(/(^|[^\w*])\*([^\s*]|[^\s*][^*\n]*?[^\s*])\*(?![\w*])/g, (_, prefix, rendered) => {
    return `${prefix}${c("italic", rendered)}`;
  });
  text = text.replace(/(^|[^\w_])_([^\s_]|[^\s_][^_\n]*?[^\s_])_(?![\w_])/g, (_, prefix, rendered) => {
    return `${prefix}${c("italic", rendered)}`;
  });

  return text.replace(/\x00MD(\d+)\x00/g, (_, index) => tokens[Number(index)] || "");
}

function isMarkdownTableStart(lines, index) {
  return (
    index + 1 < lines.length &&
    isMarkdownTableRow(lines[index]) &&
    isMarkdownTableSeparator(lines[index + 1])
  );
}

function isMarkdownTableRow(line) {
  const text = String(line || "").trim();
  return text.includes("|") && splitMarkdownTableRow(text).length >= 2;
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function hasPendingMarkdownTable(text) {
  const raw = String(text || "");
  const endsWithNewline = /\n$/.test(raw);
  const segments = raw.split("\n");
  // The trailing segment is a partial (un-terminated) line while streaming.
  const partial = endsWithNewline ? "" : segments[segments.length - 1] || "";
  // Only fully newline-terminated lines are "complete"; detect table structure
  // on those so a partial line (e.g. a separator or row mid-arrival) never lets
  // the header flush ahead of the rest and render raw.
  const lines = segments.slice(0, segments.length - 1);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length && !partial) return false;

  const last = lines.length - 1;

  // A complete table row that isn't a separator and isn't already opening a
  // known table start: a header whose separator/rows may still be streaming.
  if (last >= 0 && isMarkdownTableRow(lines[last]) && !isMarkdownTableSeparator(lines[last])) {
    if (last === 0 || !isMarkdownTableStart(lines, last - 1)) return true;
  }

  // A completed table start (header + separator) followed only by rows: more
  // rows may still stream in.
  for (let index = 0; index < lines.length; index += 1) {
    if (!isMarkdownTableStart(lines, index)) continue;
    let cursor = index + 2;
    while (cursor < lines.length && isMarkdownTableRow(lines[cursor])) cursor += 1;
    if (cursor === lines.length) return true;
  }

  // The buffer ends mid-line with a pipe-ish partial right after a table row or
  // separator: a separator or the next row is still arriving.
  if (partial && /\|/.test(partial) && last >= 0 &&
    (isMarkdownTableRow(lines[last]) || isMarkdownTableSeparator(lines[last]))) {
    return true;
  }

  return false;
}

function splitMarkdownTableRow(line) {
  const escapedPipe = "__ACP_ESCAPED_PIPE__";
  let text = String(line || "").trim().replace(/\\\|/g, escapedPipe);

  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);

  return text.split("|").map((cell) => cell.replaceAll(escapedPipe, "|").trim());
}

function renderMarkdownTable(lines) {
  const rows = lines.map(splitMarkdownTableRow);
  const header = rows[0] || [];
  const alignments = (rows[1] || []).map(tableAlignment);
  const body = rows.slice(2);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const renderedRows = [header, ...body].map((row) =>
    Array.from({ length: columnCount }, (_, index) => renderInlineMarkdown(row[index] || "")),
  );
  const naturalWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...renderedRows.map((row) => visibleLength(row[index] || ""))),
  );
  const widths = fitMarkdownTableWidths(naturalWidths);

  const formatRow = (row, options = {}) => {
    const prefix = options.header ? `${c("bold", "•")} ` : "  ";
    return `${prefix}${row
      .map((cell, index) => {
        const width = widths[index] || 3;
        const text = truncateAnsiText(cell, width);
        const value = options.header ? c("bold", stripAnsi(text)) : text;
        const align = alignments[index] || (looksNumeric(stripAnsi(text)) ? "right" : "left");
        return alignVisible(value, widths[index], align);
      })
      .join("  ")}`;
  };

  const separatorWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 2;
  const headerSeparator = () => `  ${c("dim", "━".repeat(separatorWidth))}`;
  const rowSeparator = () => `  ${c("dim", "─".repeat(separatorWidth))}`;
  const output = [formatRow(renderedRows[0] || [], { header: true }), headerSeparator()];

  renderedRows.slice(1).forEach((row, index) => {
    output.push(formatRow(row));
    if (index < renderedRows.length - 2) output.push(rowSeparator());
  });

  return output.join("\n");
}

function fitMarkdownTableWidths(naturalWidths) {
  const columnCount = naturalWidths.length;
  if (!columnCount) return [];

  const columns = Math.max(40, process.stdout.columns || 100);
  const tableWidth = Math.max(24, Math.min(columns - 1, 160));
  const gapWidth = Math.max(0, columnCount - 1) * 2;
  const prefixWidth = 2;
  const available = Math.max(columnCount * 4, tableWidth - prefixWidth - gapWidth);
  const minWidth = columnCount <= 3 ? 8 : 5;
  const singleColumnCap = Math.max(minWidth, Math.floor(available * (columnCount <= 2 ? 0.7 : 0.55)));
  const widths = naturalWidths.map((width) => Math.max(minWidth, Math.min(width, singleColumnCap)));

  let total = widths.reduce((sum, width) => sum + width, 0);
  while (total > available) {
    let widest = -1;
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index] <= minWidth) continue;
      if (widest === -1 || widths[index] > widths[widest]) widest = index;
    }
    if (widest === -1) break;
    widths[widest] -= 1;
    total -= 1;
  }

  while (total < available) {
    let expanded = false;
    for (let index = 0; index < widths.length && total < available; index += 1) {
      if (widths[index] >= naturalWidths[index]) continue;
      widths[index] += 1;
      total += 1;
      expanded = true;
    }
    if (!expanded) break;
  }

  return widths;
}

function tableAlignment(cell) {
  const text = String(cell || "").trim();
  if (text.startsWith(":") && text.endsWith(":")) return "center";
  if (text.endsWith(":")) return "right";
  return "left";
}

function looksNumeric(value) {
  return /^[-+]?\d[\d,]*(?:\.\d+)?%?$/.test(String(value || "").trim());
}

function alignVisible(value, width, align = "left") {
  const text = String(value || "");
  const padding = Math.max(0, width - visibleLength(text));
  if (align === "right") return `${" ".repeat(padding)}${text}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
  }
  return `${text}${" ".repeat(padding)}`;
}

function truncateText(value, maxLength) {
  const text = cleanInline(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function fitPlainLine(value, width) {
  const text = String(value || "").replace(/\s+/g, " ");
  if (text.length === width) return text;
  if (text.length > width) return truncateText(text, width);
  return `${text}${" ".repeat(Math.max(0, width - text.length))}`;
}

function inputComposerLine(value, width, muted = false) {
  const style = muted ? colors.inputMuted : colors.inputBg;
  return `${style}${fitAnsiLine(String(value || ""), width)}${colors.reset}`;
}

function fitAnsiLine(value, width) {
  const text = String(value || "").replace(/\n/g, " ");
  const visible = visibleLength(text);
  if (visible === width) return text;
  if (visible > width) return truncateAnsiText(text, width);
  return `${text}${" ".repeat(Math.max(0, width - visible))}`;
}

function truncateAnsiText(value, maxLength) {
  return truncateAnsiToWidth(String(value || ""), maxLength);
}

function horizontalRuleLine(width = null) {
  const columns = width ?? Math.max(24, (process.stdout.columns || 80) - 1);
  return "─".repeat(Math.max(1, Math.min(columns, 96)));
}

function activityDividerLine() {
  const columns = Math.max(24, (process.stdout.columns || 80) - 1);
  return "─".repeat(columns);
}

function isCompletedToolStatus(status) {
  return /complete|completed|done|success|succeeded/i.test(String(status || ""));
}

function activityGroupFor(event) {
  const text = `${event.kind || ""} ${event.title || ""} ${event.summary || ""}`.toLowerCase();

  if (/\b(edit|write|patch|modify|create|delete|rename|move|apply)\b/.test(text)) {
    return "Edited";
  }

  if (/\b(exec|execute|run|shell|bash|test|build|check|status)\b/.test(text)) {
    return "Ran";
  }

  if (/\b(read|search|grep|find|list|inspect|open|scan|explore)\b/.test(text)) {
    return "Explored";
  }

  return "Used Tools";
}

function cleanActivitySummary(value, group) {
  const maxLines = group === "Edited" ? 12 : 4;
  return String(value || "")
    .split("\n")
    .map((line) => cleanInline(line))
    .filter(Boolean)
    .filter((line) => line.length > 2)
    .slice(0, maxLines)
    .map((line) => truncateText(line, 120));
}

function displayPath(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  const home = os.homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, resolved)}`;
  }
  return resolved;
}

function normalizeAdditionalDirectories(directories, cwd) {
  const base = path.resolve(cwd || process.cwd());
  const seen = new Set();
  const result = [];

  for (const entry of directories || []) {
    const text = String(entry || "").trim();
    if (!text) continue;
    const resolved = path.resolve(base, text.replace(/^~(?=$|\/)/, os.homedir()));
    if (resolved === base || seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

function findConfigOptionValue(options, needles) {
  const normalizedNeedles = needles.map((needle) => String(needle).toLowerCase());

  for (const option of options || []) {
    if (!option || typeof option !== "object") continue;

    const haystack = [
      option.id,
      option.optionId,
      option.name,
      option.key,
      option.label,
      option.title,
      option.description,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (!normalizedNeedles.some((needle) => haystack.includes(needle))) continue;

    const value = configOptionDisplayValue(option);
    if (value) return value;
  }

  return "";
}

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function splitCommandWords(input) {
  const words = [];
  let current = "";
  let quote = "";
  let escaped = false;

  for (const char of String(input || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function configOptionId(option) {
  return String(option?.id || option?.optionId || option?.key || option?.name || "option");
}

function configOptionAliases(option) {
  return [
    option?.id,
    option?.optionId,
    option?.key,
    option?.name,
    option?.label,
    option?.title,
  ]
    .filter(Boolean)
    .map(normalizeToken);
}

function resolveConfigOption(options, query) {
  const target = normalizeToken(query);
  if (!target) return null;

  const entries = (options || []).filter((option) => option && typeof option === "object");
  return (
    entries.find((option) => configOptionAliases(option).includes(target)) ||
    entries.find((option) => configOptionAliases(option).some((alias) => alias.includes(target))) ||
    null
  );
}

function sanitizeConfigValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const result = {};

  for (const [key, value] of Object.entries(values)) {
    const id = cleanInline(key);
    if (!id) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "boolean") {
      result[id] = value;
    } else {
      const label = valueLabel(value);
      if (label) result[id] = label;
    }
  }

  return result;
}

function agentDefaultConfigValues(agent) {
  return sanitizeConfigValues(
    agent?.configDefaults ||
      agent?.acpConfigDefaults ||
      agent?.defaultConfig ||
      {},
  );
}

function sortConfigEntries(entries) {
  const priority = (id) => {
    const normalized = normalizeToken(id);
    if (normalized === "model" || normalized.includes("model")) return 0;
    if (normalized === "effort" || normalized.includes("reasoning")) return 1;
    if (normalized === "mode" || normalized.includes("permission")) return 2;
    return 3;
  };

  return [...entries].sort((a, b) => priority(a[0]) - priority(b[0]) || String(a[0]).localeCompare(String(b[0])));
}

function selectedConfigValues(chat, fallback = {}) {
  const result = sanitizeConfigValues(fallback);

  for (const option of chat?.configOptions || []) {
    if (!option || typeof option !== "object") continue;
    const id = configOptionId(option);
    const value = configOptionDisplayValue(option);
    if (id && value) result[id] = value;
  }

  if (chat?.mode && !result.mode) result.mode = chat.mode;
  return result;
}

function chatModel(chat) {
  return (
    findConfigOptionValue(chat?.configOptions || [], ["model"]) ||
    valueLabel(chat?.configValues?.model) ||
    valueLabel(chat?.model)
  );
}

function compactProviderLabel(value) {
  const label = cleanInline(value || "Agent").replace(/\s+ACP$/i, "").trim();
  if (!label) return "Agent";
  if (/^[a-z][a-z0-9_-]*$/.test(label)) return label[0].toUpperCase() + label.slice(1);
  return label;
}

function providerColorName(provider) {
  const id = String(provider || "").toLowerCase();
  if (id.includes("claude")) return "magenta";
  if (id.includes("codex")) return "cyan";
  if (id.includes("gemini")) return "blue";
  return "blue";
}

function coloredProviderLabel(chat) {
  const label = compactProviderLabel(chat.providerLabel || chat.provider || "Agent");
  return c(providerColorName(chat.provider), label);
}

function chatEffort(chat) {
  return (
    findConfigOptionValue(chat?.configOptions || [], ["effort", "reasoning"]) ||
    valueLabel(chat?.configValues?.effort) ||
    valueLabel(chat?.configValues?.reasoning) ||
    valueLabel(chat?.effort)
  );
}

function chatAccessLabel(chat) {
  return (
    valueLabel(chat?.mode) ||
    findConfigOptionValue(chat?.configOptions || [], ["access", "permission", "mode"]) ||
    valueLabel(chat?.configValues?.access) ||
    valueLabel(chat?.configValues?.permission) ||
    valueLabel(chat?.configValues?.mode)
  );
}

function chatConfigLabel(chat) {
  return [chat?.model || chatModel(chat), chat?.effort || chatEffort(chat)]
    .filter(Boolean)
    .join(" ");
}

function footerParts(parts) {
  const result = [];
  const seen = new Set();

  for (const part of parts) {
    const text = cleanInline(part);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
}

function attachmentChip(attachment, index) {
  const kind = attachment.kind === "image" ? "Image" : "File";
  const name = truncateText(attachment.name || path.basename(attachment.path || "") || kind.toLowerCase(), 32);
  return c(attachment.kind === "image" ? "cyan" : "green", `[${kind} #${index + 1} ${name}]`);
}

function wrapAttachmentChips(attachments, width) {
  if (!attachments?.length) return [];

  const maxWidth = Math.max(16, width || 80);
  const chips = attachments.map((attachment, index) => attachmentChip(attachment, index));
  const rows = [];
  let row = "";
  let consumed = 0;

  for (let index = 0; index < chips.length; index += 1) {
    const chip = chips[index];
    const next = row ? `${row} ${chip}` : chip;
    if (visibleLength(next) <= maxWidth) {
      row = next;
      consumed = index + 1;
      continue;
    }

    if (row) {
      rows.push(row);
      if (rows.length >= MAX_ATTACHMENT_CHIP_ROWS) break;
    }
    if (visibleLength(chip) <= maxWidth) {
      row = chip;
      consumed = index + 1;
    } else {
      rows.push(truncateAnsiText(chip, maxWidth));
      consumed = index + 1;
      row = "";
      if (rows.length >= MAX_ATTACHMENT_CHIP_ROWS) break;
    }
  }

  if (row && rows.length < MAX_ATTACHMENT_CHIP_ROWS) rows.push(row);

  const hidden = Math.max(0, attachments.length - consumed);
  if (hidden > 0 && rows.length) {
    const suffix = c("dim", `[+${hidden} more]`);
    const last = rows[rows.length - 1];
    const next = `${last} ${suffix}`;
    rows[rows.length - 1] = visibleLength(next) <= maxWidth
      ? next
      : fitAnsiLine(`${truncateAnsiText(last, Math.max(8, maxWidth - visibleLength(suffix) - 1))} ${suffix}`, maxWidth);
  }

  return rows;
}

function configOptionValues(option) {
  const rawValues = option?.values || option?.options || option?.choices || [];
  if (!Array.isArray(rawValues)) return [];

  const values = [];
  const visit = (entry) => {
    if (entry === null || entry === undefined) return;
    if (typeof entry !== "object") {
      values.push({ value: String(entry), label: String(entry), description: "" });
      return;
    }

    if (Array.isArray(entry.options)) {
      for (const child of entry.options) visit(child);
      return;
    }

    const value = valueLabel(entry.value ?? entry.id ?? entry.modelId ?? entry.name ?? entry.label ?? entry.title);
    if (!value) return;

    values.push({
      value,
      label: valueLabel(entry.label ?? entry.title ?? entry.name ?? entry.displayName ?? entry.description) || value,
      description: valueLabel(entry.description),
    });
  };

  for (const entry of rawValues) visit(entry);
  return values;
}

function configOptionMenuValues(option) {
  if (isBooleanConfigOption(option)) {
    return [
      { value: "true", label: "true" },
      { value: "false", label: "false" },
    ];
  }

  return configOptionValues(option);
}

function isBooleanConfigOption(option) {
  return (
    option?.type === "boolean" ||
    typeof option?.value === "boolean" ||
    typeof option?.currentValue === "boolean" ||
    typeof option?.selectedValue === "boolean" ||
    typeof option?.defaultValue === "boolean"
  );
}

function parseBooleanConfigValue(value) {
  const normalized = normalizeToken(value);
  if (["1", "true", "yes", "y", "on", "enabled", "enable"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "disabled", "disable"].includes(normalized)) return false;
  throw new Error(`Expected boolean value, got ${value}`);
}

function resolveConfigOptionValue(option, value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`Value is empty for config option ${configOptionId(option)}`);

  if (isBooleanConfigOption(option)) return parseBooleanConfigValue(raw);

  const values = configOptionValues(option);
  if (!values.length) return raw;

  const target = normalizeToken(raw);
  const exact = values.find((entry) => normalizeToken(entry.value) === target);
  if (exact) return exact.value;

  const labelMatch = values.find(
    (entry) => normalizeToken(entry.label) === target || normalizeToken(entry.description) === target,
  );
  if (labelMatch) return labelMatch.value;

  const includesMatch = values.find((entry) => {
    const haystack = `${entry.value} ${entry.label} ${entry.description}`.toLowerCase();
    return haystack.includes(target);
  });
  if (includesMatch) return includesMatch.value;

  // Some adapters, notably Claude, accept model aliases such as "sonnet" and
  // resolve them server-side. Let the adapter be the final source of truth.
  return raw;
}

function buildSetConfigOptionRequest(sessionId, option, value) {
  const configId = configOptionId(option);
  const resolvedValue = resolveConfigOptionValue(option, value);
  const request = {
    sessionId,
    configId,
    value: resolvedValue,
  };

  if (typeof resolvedValue === "boolean") request.type = "boolean";
  return request;
}

function applyLocalConfigOptionValue(options, configId, value) {
  const target = normalizeToken(configId);
  return (options || []).map((option) => {
    if (!option || typeof option !== "object") return option;
    if (!configOptionAliases(option).includes(target)) return option;

    if (Object.prototype.hasOwnProperty.call(option, "currentValue")) {
      return { ...option, currentValue: value };
    }
    if (Object.prototype.hasOwnProperty.call(option, "selectedValue")) {
      return { ...option, selectedValue: value };
    }
    return { ...option, value };
  });
}

function configOptionValueMatches(option, value) {
  const current = configOptionDisplayValue(option);
  return normalizeToken(current) === normalizeToken(value);
}

function syncChatModeFromConfig(chat) {
  const option = resolveConfigOption(chat.configOptions || [], "mode");
  const mode = option ? configOptionDisplayValue(option) : "";
  if (mode) chat.mode = mode;
}

function modeEntries(modes) {
  const entries = modes?.availableModes || modes?.modes || modes?.options || [];
  return Array.isArray(entries) ? entries : [];
}

function resolveMode(modes, query) {
  const target = normalizeToken(query);
  if (!target) return null;

  return (
    modeEntries(modes).find((mode) => {
      const aliases = [mode?.id, mode?.modeId, mode?.name, mode?.label, mode?.title]
        .filter(Boolean)
        .map(normalizeToken);
      return aliases.includes(target);
    }) ||
    modeEntries(modes).find((mode) => {
      const aliases = [mode?.id, mode?.modeId, mode?.name, mode?.label, mode?.title]
        .filter(Boolean)
        .map(normalizeToken);
      return aliases.some((alias) => alias.includes(target));
    }) ||
    null
  );
}

function accessAliases(value) {
  const normalized = normalizeToken(value);
  const table = {
    "read-only": ["read-only", "readonly", "read", "plan", "planning"],
    readonly: ["read-only", "readonly", "read", "plan", "planning"],
    read: ["read-only", "readonly", "read", "plan", "planning"],
    agent: ["agent", "default", "accept-edits", "acceptedits", "write"],
    default: ["default", "agent"],
    write: ["agent", "default", "accept-edits", "acceptedits"],
    full: ["full", "full-access", "bypass-permissions", "bypasspermissions", "dont-ask", "dontask", "no-ask"],
    "full-access": ["full", "full-access", "bypass-permissions", "bypasspermissions", "dont-ask", "dontask", "no-ask"],
    bypass: ["bypass-permissions", "bypasspermissions", "full-access", "dont-ask", "dontask"],
    "dont-ask": ["dont-ask", "dontask", "bypass-permissions", "bypasspermissions", "full-access"],
    dontask: ["dont-ask", "dontask", "bypass-permissions", "bypasspermissions", "full-access"],
    auto: ["auto"],
    plan: ["plan", "planning", "read-only", "readonly"],
    planning: ["plan", "planning", "read-only", "readonly"],
  };

  return table[normalized] || [normalized];
}

function resolveAccessTarget(chat, value) {
  const aliases = accessAliases(value);
  const modes = modeEntries(chat?.modes);

  for (const alias of aliases) {
    const mode = resolveMode({ availableModes: modes }, alias);
    if (mode) {
      return {
        kind: "mode",
        value: String(mode.id || mode.modeId || mode.name || alias),
      };
    }
  }

  const option =
    resolveConfigOption(chat?.configOptions || [], "mode") ||
    resolveConfigOption(chat?.configOptions || [], "permission") ||
    resolveConfigOption(chat?.configOptions || [], "access");
  if (!option) return null;

  for (const alias of aliases) {
    const values = configOptionValues(option);
    const match = values.find((entry) => {
      const haystack = [entry.value, entry.label, entry.description].filter(Boolean).map(normalizeToken);
      return haystack.includes(alias) || haystack.some((entryAlias) => entryAlias.includes(alias));
    });
    if (match) {
      return {
        kind: "config",
        configId: configOptionId(option),
        value: match.value,
      };
    }
  }

  return {
    kind: "config",
    configId: configOptionId(option),
    value,
  };
}

function configOptionDisplayValue(option) {
  for (const key of ["value", "currentValue", "selectedValue", "current", "defaultValue"]) {
    if (!Object.prototype.hasOwnProperty.call(option, key)) continue;
    const value = valueLabel(option[key]);
    if (value) return value;
  }

  return "";
}

function valueLabel(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(valueLabel).filter(Boolean).join(",");
  }
  if (typeof value === "object") {
    return valueLabel(value.value ?? value.id ?? value.name ?? value.label ?? value.title);
  }
  return "";
}

function compactTmuxText(value, maxLength = 80) {
  return truncateText(String(value || "").replace(/[#{}]/g, ""), maxLength);
}

function shortSession(sessionId) {
  if (!sessionId) return "";
  const text = String(sessionId);
  if (text.length <= 12) return text;
  return text.slice(0, 8);
}

function formatConfigOption(option) {
  if (!option || typeof option !== "object") return `- ${String(option)}`;

  const id = option.id || option.optionId || option.name || option.key || "option";
  const label = option.label || option.title || option.name || id;
  const value = option.value ?? option.currentValue ?? option.defaultValue ?? "";
  const values = option.values || option.options || option.choices || [];
  const suffix = [];

  if (value !== "") suffix.push(`value=${JSON.stringify(value)}`);
  if (option.type) suffix.push(`type=${option.type}`);
  if (Array.isArray(values) && values.length) {
    suffix.push(`choices=${values.map((entry) => entry.id || entry.value || entry.name || entry).join(",")}`);
  }

  return `- ${id} ${c("dim", label === id ? "" : label)}${suffix.length ? ` ${c("dim", suffix.join(" "))}` : ""}`;
}

function formatProviderCommand(command) {
  if (!command || typeof command !== "object") return `- ${String(command)}`;

  const name = command.name || command.command || command.id || command.title || "command";
  const description = command.description || command.title || "";
  const aliases = command.aliases || [];
  const aliasText = Array.isArray(aliases) && aliases.length ? ` aliases=${aliases.join(",")}` : "";

  return `- ${name}${description && description !== name ? ` ${c("dim", description)}` : ""}${c("dim", aliasText)}`;
}

function planMarker(status) {
  if (status === "completed") return c("green", "✓");
  if (status === "in_progress") return c("yellow", "▸");
  if (status === "skipped" || status === "cancelled") return c("dim", "⊘");
  return c("dim", "·");
}

async function buildPromptContent(chat, text, attachments = []) {
  const prompt = [];
  const cleanText = String(text || "").trim();
  if (cleanText) prompt.push({ type: "text", text: cleanText });

  for (const input of attachments || []) {
    const attachment = await resolvePromptAttachment(input?.path || input, chat.cwd);
    prompt.push(await attachmentContentBlock(chat, attachment));
  }

  return prompt;
}

async function resolvePromptAttachment(input, cwd) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("attachment path is empty");

  const resolved = path.resolve(cwd || process.cwd(), raw.replace(/^~(?=$|\/)/, os.homedir()));
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) throw new Error("not a regular file");

  const mimeType = mimeTypeForPath(resolved);
  return {
    path: resolved,
    name: path.basename(resolved),
    size: stat.size,
    mimeType,
    kind: mimeType.startsWith("image/") ? "image" : "file",
  };
}

async function attachmentContentBlock(chat, attachment) {
  const capabilities = chat.agentCapabilities?.promptCapabilities || {};
  const uri = pathToFileURL(attachment.path).href;

  if (attachment.kind === "image" && capabilities.image === true && attachment.size <= MAX_IMAGE_ATTACHMENT_BYTES) {
    return {
      type: "image",
      mimeType: attachment.mimeType,
      data: (await fsp.readFile(attachment.path)).toString("base64"),
      uri,
    };
  }

  if (capabilities.embeddedContext === true && attachment.size <= MAX_EMBEDDED_TEXT_ATTACHMENT_BYTES) {
    const embedded = await embeddedResourceForAttachment(attachment, uri);
    if (embedded) return embedded;
  }

  return {
    type: "resource_link",
    uri,
    name: attachment.name,
    title: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

async function embeddedResourceForAttachment(attachment, uri) {
  if (attachment.kind === "image") return null;
  const buffer = await fsp.readFile(attachment.path);
  if (buffer.includes(0)) return null;

  return {
    type: "resource",
    resource: {
      uri,
      mimeType: attachment.mimeType,
      text: buffer.toString("utf8"),
    },
  };
}

function promptDisplayText(text, prompt) {
  const lines = [];
  const cleanText = String(text || "").trim();
  if (cleanText) lines.push(cleanText);

  let imageIndex = 0;
  let fileIndex = 0;
  for (const block of prompt || []) {
    if (block?.type === "text") continue;
    if (block?.type === "image" || contentBlockIsImage(block)) {
      imageIndex += 1;
      lines.push(`[IMAGE${imageIndex}] ${fileNameFromUri(block.uri) || block.mimeType || "image"}`);
      continue;
    }
    fileIndex += 1;
    lines.push(`[FILE${fileIndex}] ${contentBlockName(block)}`);
  }

  return lines.join("\n");
}

function contentBlockIsImage(block) {
  const mimeType = block?.mimeType || block?.resource?.mimeType || "";
  return String(mimeType).startsWith("image/");
}

function contentBlockName(block) {
  if (block?.type === "resource_link") return block.title || block.name || block.uri || "file";
  if (block?.type === "resource") return fileNameFromUri(block.resource?.uri) || block.resource?.uri || "resource";
  return "file";
}

function fileNameFromUri(uri) {
  if (!uri) return "";
  try {
    return path.basename(new URL(uri).pathname);
  } catch {
    return "";
  }
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".c": "text/x-c",
    ".cc": "text/x-c++",
    ".cpp": "text/x-c++",
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".go": "text/x-go",
    ".h": "text/x-c",
    ".heic": "image/heic",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsx": "text/javascript",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".py": "text/x-python",
    ".rb": "text/x-ruby",
    ".rs": "text/x-rust",
    ".svg": "image/svg+xml",
    ".toml": "application/toml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  return map[ext] || "application/octet-stream";
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${(k >= 100 ? Math.round(k) : Number(k.toFixed(1)))}k`;
  }
  const m = n / 1_000_000;
  return `${(m >= 100 ? Math.round(m) : Number(m.toFixed(1)))}M`;
}

function formatCost(cost) {
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount)) return "";
  const amount = cost.amount;
  const text = amount === 0 || amount >= 0.01 ? amount.toFixed(2) : amount.toFixed(4);
  const currency = typeof cost.currency === "string" ? cost.currency : "";
  if (currency === "USD" || currency === "") return `$${text}`;
  return `${text} ${currency}`;
}

// Builds the compact context-window segment for the composer footer from an ACP
// `usage_update` (stable `used`/`size` fields, optional cost).
function formatContextUsage(usage) {
  if (!usage) return "";
  const used = usage.used == null ? NaN : Number(usage.used);
  const size = usage.size == null ? NaN : Number(usage.size);
  const parts = [];

  if (Number.isFinite(size) && size > 0) {
    if (Number.isFinite(used) && used >= 0) {
      const pct = Math.round((used / size) * 100);
      parts.push(`${formatTokenCount(used)}/${formatTokenCount(size)} (${pct}%)`);
    } else {
      parts.push(`ctx ${formatTokenCount(size)}`);
    }
  } else if (Number.isFinite(used) && used >= 0) {
    parts.push(`${formatTokenCount(used)} ctx`);
  }

  const cost = formatCost(usage.cost);
  if (cost) parts.push(cost);

  return parts.join(" ");
}

function planProgressLabel(chat) {
  const entries = chat?.plan?.entries || [];
  if (!entries.length) return "";
  const done = entries.filter((entry) => entry.status === "completed").length;
  return `${done}/${entries.length}`;
}

// Accept ACP `[{name,value}]` lists or ergonomic `{KEY: "value"}` objects.
function normalizeKeyValueList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry && typeof entry.name === "string")
      .map((entry) => ({ name: entry.name, value: String(entry.value ?? "") }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([name, val]) => ({ name, value: String(val ?? "") }));
  }
  return [];
}

function mcpCapabilityFlags(capabilities) {
  const mcp = capabilities?.mcpCapabilities || {};
  return { http: mcp.http === true, sse: mcp.sse === true };
}

function normalizeMcpServer(entry, caps) {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;

  const type = entry.type || (entry.url ? "http" : entry.command ? "stdio" : "");

  if (type === "http" || type === "sse") {
    if (!entry.url) return null;
    if (type === "http" && !caps.http) return { skipped: name, reason: "http unsupported" };
    if (type === "sse" && !caps.sse) return { skipped: name, reason: "sse unsupported" };
    return {
      server: { type, name, url: String(entry.url), headers: normalizeKeyValueList(entry.headers) },
    };
  }

  // stdio transport is mandatory for every agent, so it never needs gating.
  if (!entry.command) return null;
  return {
    server: {
      name,
      command: String(entry.command),
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: normalizeKeyValueList(entry.env),
    },
  };
}

function resolveMcpServers(config, agent, capabilities) {
  const caps = mcpCapabilityFlags(capabilities);
  const raw = [
    ...(Array.isArray(config?.mcpServers) ? config.mcpServers : []),
    ...(Array.isArray(agent?.mcpServers) ? agent.mcpServers : []),
  ];

  const servers = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of raw) {
    const result = normalizeMcpServer(entry, caps);
    if (!result) continue;
    if (result.skipped) {
      skipped.push(result);
      continue;
    }
    if (seen.has(result.server.name)) continue;
    seen.add(result.server.name);
    servers.push(result.server);
  }
  return { servers, skipped };
}

function mcpServerLabel(server) {
  if (server.url) return `${server.name} (${server.type || "http"})`;
  return `${server.name} (stdio)`;
}

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;

  switch (content.type) {
    case "text":
      return content.text || "";
    case "resource_link":
      return `[resource: ${content.title || content.name || content.uri}]`;
    case "resource":
      return "[resource]";
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return JSON.stringify(content);
  }
}

function toolContentText(content) {
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (item.type === "content") return contentText(item.content);
      if (item.type === "diff") return `diff ${item.path}`;
      if (item.type === "terminal") return `terminal ${item.terminalId}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function supportsSessionClose(chat) {
  return hasSessionCapability(chat.agentCapabilities, "close");
}

function supportsSessionLoad(chat) {
  const capabilities = chat.agentCapabilities || {};
  return (
    hasSessionCapability(capabilities, "load") ||
    capabilities.loadSession === true ||
    capabilities.sessionLoad === true
  );
}

function supportsSessionResume(chat) {
  const capabilities = chat.agentCapabilities || {};
  return (
    hasSessionCapability(capabilities, "resume") ||
    capabilities.resumeSession === true ||
    capabilities.sessionResume === true
  );
}

function supportsSessionListCapabilities(capabilities) {
  return (
    hasSessionCapability(capabilities, "list") ||
    capabilities?.listSessions === true ||
    capabilities?.sessionList === true
  );
}

function supportsSessionDelete(capabilities) {
  return hasSessionCapability(capabilities, "delete");
}

function hasSessionCapability(capabilities, name) {
  if (!capabilities) return false;
  const sessionCapabilities = capabilities.sessionCapabilities || capabilities.session || {};
  const value = sessionCapabilities[name];
  return value === true || (value && typeof value === "object");
}

function isRestoreUnsupported(error) {
  const message = error?.message || "";
  return (
    message.includes("does not advertise session/resume or session/load") ||
    message.includes("Method not found: session/resume") ||
    message.includes("Method not found: session/load") ||
    message.includes("Resource not found")
  );
}

function isMethodNotFound(error, method) {
  const message = error?.message || "";
  return message.includes(`Method not found: ${method}`) || message.includes("-32601");
}

async function connectHub(timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out connecting to Vanzi hub"));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      const client = new HubRpcClient(
        new LineConnection(
          socket,
          (message) => client.handleMessage(message),
          () => {},
        ),
      );
      resolve(client);
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

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
        // back to its menu instead of re-prompting through /delete.
        const result = await hub.call("delete_chat", { chatId });
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

// Attention first: chats waiting on the user (permission/auth) or broken
// float above other live chats, which float above saved ones.
function chatAttentionRank(chat) {
  if (!chat.active) return 2;
  if (["permission", "auth", "error"].includes(chat.status)) return 0;
  return 1;
}

function orderProjectChats(chats) {
  return [...chats].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    const rank = chatAttentionRank(a) - chatAttentionRank(b);
    if (rank !== 0) return rank;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tmuxDoubleQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tmuxMenuTargetAttempts(context = {}) {
  const targetAttempts = [];
  if (context.client && context.pane) targetAttempts.push(["-c", context.client, "-t", context.pane]);
  if (context.pane) targetAttempts.push(["-t", context.pane]);
  if (context.client) targetAttempts.push(["-c", context.client]);
  targetAttempts.push([]);

  const seen = new Set();
  return targetAttempts.filter((targetArgs) => {
    const key = targetArgs.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function displayTmuxMenu(title, items, context = {}) {
  const menuItems = [];
  for (const item of items) {
    if (item.separator) {
      menuItems.push("", "", "");
      continue;
    }

    const label = truncateText(stripAnsi(item.label || ""), 72);
    if (item.disabled) {
      menuItems.push(`- ${label}`, "", "");
    } else {
      menuItems.push(label, item.key || "", item.command || "");
    }
  }

  let lastError = "";
  for (const targetArgs of tmuxMenuTargetAttempts(context)) {
    const tmuxArgs = [
      "display-menu",
      ...targetArgs,
      "-T",
      title,
      "-x",
      "P",
      "-y",
      "P",
      "--",
      ...menuItems,
    ];
    const result = spawnSync("tmux", tmuxArgs, {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (!result.error && result.status === 0) return { ok: true, error: "" };
    lastError =
      result.error?.message ||
      String(result.stderr || "").trim() ||
      `tmux exited ${result.status ?? "unknown"}`;
  }

  return { ok: false, error: lastError };
}

function tmuxDisplayMessage(context = {}, message) {
  for (const targetArgs of tmuxMenuTargetAttempts(context)) {
    const tmuxArgs = ["display-message", ...targetArgs, String(message)];
    const result = spawnSync("tmux", tmuxArgs, { stdio: "ignore" });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

function tmuxPaneFormat(pane, format) {
  if (!pane) return "";
  const result = spawnSync("tmux", ["display-message", "-p", "-t", pane, format], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

// Window metadata rendered by the status bar, the prefix+s switcher, and the
// workspace scripts. Takes a chat summary (daemon and popup share the shape).
function tmuxWindowOptionValues(chat) {
  return {
    "@vanzi_hub_provider": chat.provider || "",
    "@vanzi_hub_provider_label": chat.providerLabel || chat.provider || "",
    "@vanzi_hub_provider_short": compactProviderLabel(chat.providerLabel || chat.provider || ""),
    "@vanzi_hub_provider_icon": providerIconFor(chat.provider, chat),
    "@vanzi_hub_chat_id": chat.id || "",
    "@vanzi_hub_session_id": chat.sessionId || "",
    "@vanzi_hub_project_path": chat.cwd || "",
    "@vanzi_hub_project_name": chat.projectName || projectName(chat.cwd || ""),
    "@vanzi_hub_status": chat.status || "",
    "@vanzi_hub_status_glyph": statusGlyph(chat.status),
    "@vanzi_hub_status_detail": compactTmuxText(chat.statusDetail || ""),
    "@vanzi_hub_mode": chat.mode || "",
    "@vanzi_hub_model": compactTmuxText(chat.model || chatModel(chat) || ""),
    "@vanzi_hub_effort": compactTmuxText(chat.effort || chatEffort(chat) || ""),
    "@vanzi_hub_plan": planProgressLabel(chat),
    "@vanzi_hub_title": compactTmuxText(chat.title || chat.id || ""),
    "@vanzi_hub_active": chat.active ? "live" : "stored",
    "@vanzi_hub_updated_at": chat.updatedAt || "",
    // A window that renders a chat is a chat view, whatever action created it.
    // Without this, a menu window that opened a chat kept action=menu and the
    // prefix+9/0 lookups skipped it, spawning a duplicate view of the chat.
    "@vanzi_hub_action": "chat",
  };
}

// One async tmux invocation with ';'-chained commands: sequential spawnSync
// calls per option blocked the event loop during streaming. `target` optional
// (defaults to the caller's current window).
function setTmuxWindowOptions(values, target = "") {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (args.length) args.push(";");
    args.push("set-window-option", "-q");
    if (target) args.push("-t", target);
    args.push(key, String(value));
  }

  // tmux does not re-render window-status labels when a user option changes;
  // without an explicit refresh the status bar shows stale titles until the
  // client reattaches. Resolves to the session's active client (the popup);
  // harmless no-op when none exists.
  args.push(";", "refresh-client", "-S");

  try {
    const child = spawn("tmux", args, { stdio: "ignore" });
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // Best effort: tmux metadata sync must never break the hub.
  }
}

// Resolves the tmux window carrying @vanzi_hub_chat_id == chatId, if any.
function findTmuxWindowForChat(chatId) {
  return new Promise((resolve) => {
    if (!chatId) {
      resolve("");
      return;
    }

    let output = "";
    let child;
    try {
      child = spawn("tmux", ["list-windows", "-a", "-F", "#{window_id}\t#{@vanzi_hub_chat_id}"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve("");
      return;
    }

    child.on("error", () => resolve(""));
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", () => {
      for (const line of output.split("\n")) {
        const [windowId, id] = line.split("\t");
        if (id === chatId && windowId) {
          resolve(windowId);
          return;
        }
      }
      resolve("");
    });
  });
}

function syncTmuxChatMetadata(context, chat) {
  if (!chat) return;

  const target = tmuxPaneFormat(context?.pane || "", "#{window_id}") || context?.pane || "";
  if (!target) return;

  setTmuxWindowOptions(tmuxWindowOptionValues(chat), target);
}

function isAcpPane(context) {
  return Boolean(tmuxPaneFormat(context?.pane || "", "#{@vanzi_hub_provider}"));
}

function tmuxSubmitToPane(pane, text) {
  const target = shellQuote(pane || "");
  const literal = shellQuote(text);
  const command = `tmux send-keys -t ${target} -l ${literal}; tmux send-keys -t ${target} Enter`;
  return `run-shell ${tmuxDoubleQuote(command)}`;
}

function tmuxPromptSubmitToPane(context, prompt, prefix = "") {
  const pane = tmuxDoubleQuote(context.pane || "");
  const template = [
    `send-keys -t ${pane} -l ${tmuxDoubleQuote(prefix)}`,
    `send-keys -t ${pane} -l "%%"`,
    `send-keys -t ${pane} Enter`,
  ].join("; ");
  return tmuxCommandPrompt(context, prompt, template);
}

function submitCommandToTmuxPane(pane, text) {
  if (!pane) return false;
  const input = spawnSync("tmux", ["send-keys", "-t", pane, "-l", String(text || "")], {
    stdio: "ignore",
  });
  if (input.error || input.status !== 0) return false;

  const enter = spawnSync("tmux", ["send-keys", "-t", pane, "Enter"], {
    stdio: "ignore",
  });
  return !enter.error && enter.status === 0;
}

function tmuxInsertToPane(pane, text) {
  return `send-keys -t ${tmuxDoubleQuote(pane || "")} -l ${tmuxDoubleQuote(text)}`;
}

function tmuxCommandPrompt(context, prompt, template, initial = "") {
  const args = ["command-prompt"];
  if (context.client) args.push("-t", context.client);
  if (initial) args.push("-I", initial);
  args.push("-p", prompt, template);
  return args.map((arg, index) => (index === 0 ? arg : tmuxDoubleQuote(arg))).join(" ");
}

function tmuxConfirmCommand(context, prompt, command) {
  const args = ["confirm-before"];
  if (context.client) args.push("-t", context.client);
  args.push("-p", prompt, command);
  return args.map((arg, index) => (index === 0 ? arg : tmuxDoubleQuote(arg))).join(" ");
}

function tmuxPanelCommand(cwd, context, panel, chatId = "") {
  const command = [
    shellQuote(process.execPath),
    shellQuote(SCRIPT_PATH),
    "tmux-panel",
    "--cwd",
    shellQuote(cwd || ""),
    "--session",
    shellQuote(context.session || ""),
    "--client",
    shellQuote(context.client || ""),
    "--pane",
    shellQuote(context.pane || ""),
    "--panel",
    shellQuote(panel || "control"),
  ];
  if (chatId) {
    command.push("--chat-id", shellQuote(chatId));
  }
  return `run-shell ${tmuxDoubleQuote(command.join(" "))}`;
}

function tmuxActionShellCommand(cwd, context, action, chatId = "", valueExpression = null) {
  const command = [
    shellQuote(process.execPath),
    shellQuote(SCRIPT_PATH),
    "tmux-action",
    "--cwd",
    shellQuote(cwd || ""),
    "--session",
    shellQuote(context.session || ""),
    "--client",
    shellQuote(context.client || ""),
    "--pane",
    shellQuote(context.pane || ""),
    "--action",
    shellQuote(action || ""),
  ];
  if (chatId) {
    command.push("--chat-id", shellQuote(chatId));
  }
  if (valueExpression !== null) {
    command.push("--value", valueExpression);
  }
  return command.join(" ");
}

function actionPayload(value) {
  return JSON.stringify(value);
}

function parseActionPayload(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { value };
  }
}

function tmuxActionCommand(cwd, context, action, chatId = "", value = null) {
  const valueExpression = value === null ? null : shellQuote(value);
  return `run-shell ${tmuxDoubleQuote(tmuxActionShellCommand(cwd, context, action, chatId, valueExpression))}`;
}

function tmuxPromptActionCommand(cwd, context, action, chatId, prompt, initial = "") {
  const command = tmuxActionShellCommand(cwd, context, action, chatId, `"%%"`);
  return tmuxCommandPrompt(context, prompt, `run-shell ${tmuxDoubleQuote(command)}`, initial);
}

function tmuxConfirmActionCommand(cwd, context, action, chatId, prompt, value = null) {
  return tmuxConfirmCommand(context, prompt, tmuxActionCommand(cwd, context, action, chatId, value));
}

function tmuxWorkspaceShellCommand(cwd, context, provider = "", chatId = "", kind = "open") {
  const script = path.join(PLUGIN_DIR, "scripts", "workspace.sh");
  return [
    "sh",
    shellQuote(script),
    shellQuote(cwd),
    shellQuote(context.session || ""),
    shellQuote(context.client || ""),
    shellQuote(context.pane || ""),
    shellQuote(provider || ""),
    shellQuote(chatId || ""),
    shellQuote(kind || ""),
  ].join(" ");
}

function tmuxRunWorkspace(cwd, context, provider = "", chatId = "", kind = "open") {
  return `run-shell ${tmuxDoubleQuote(tmuxWorkspaceShellCommand(cwd, context, provider, chatId, kind))}`;
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
      await runTmuxMenu(args);
      break;
    case "tmux-toggle-menu":
      await runTmuxToggleMenu(args);
      break;
    case "tmux-close-menu":
      await runTmuxCloseMenu(args);
      break;
    case "tmux-panel":
      await runTmuxPanel(args);
      break;
    case "tmux-action":
      await runTmuxAction(args);
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
};
