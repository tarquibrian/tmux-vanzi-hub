// Shared constants and pure helpers for tmux-vanzi-hub (daemon, UI, CLI).
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
} from "./render.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The CLI entry point, used when building tmux run-shell commands. Must not be
// import.meta.url here: lib/core.mjs is not the executable.
const HUB_CLI_PATH = path.join(PLUGIN_DIR, "bin", "vanzi-hub.mjs");
const BIN_PATH = path.join(PLUGIN_DIR, "bin", "vanzi-hub.mjs");
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

// Codex = characteristic blue, Claude = characteristic orange.
const PROVIDER_ACCENT_CODES = { claude: 173, codex: 39 };
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

// Optional UI accent from the @vanzi_hub_accent tmux option ("#rrggbb" or a
// 256-color number). When set it tints the composer rule instead of the
// provider accent, so the hub matches the user's tmux theme.
let cachedHubAccentSeq;
function hubAccentSeq() {
  if (cachedHubAccentSeq !== undefined) return cachedHubAccentSeq;
  cachedHubAccentSeq = "";
  if (process.env.TMUX && process.stdout.isTTY) {
    const result = spawnSync("tmux", ["show-option", "-gqv", "@vanzi_hub_accent"], {
      encoding: "utf8",
    });
    const value = result.status === 0 ? (result.stdout || "").trim() : "";
    const hex = value.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const number = Number.parseInt(hex[1], 16);
      cachedHubAccentSeq = `\x1b[38;2;${(number >> 16) & 255};${(number >> 8) & 255};${number & 255}m`;
    } else if (/^\d{1,3}$/.test(value)) {
      cachedHubAccentSeq = `\x1b[38;5;${value}m`;
    }
  }
  return cachedHubAccentSeq;
}

// --- Lightweight syntax highlighting for fenced code blocks -----------------------
//
// Zero-dependency, per-line regex tokenizer: comments, strings, numbers, and
// per-language keywords. Tokens use foreground-only SGR codes closed with
// \x1b[39m (never a full reset) so the shaded code-block background survives.
// Per-line means multi-line constructs (block comments, triple-quoted strings)
// lose their color on continuation lines — an accepted trade-off.

const CODE_TOKEN_COLORS = {
  keyword: "\x1b[38;5;176m",
  string: "\x1b[38;5;114m",
  number: "\x1b[38;5;179m",
  comment: "\x1b[38;5;245m",
  end: "\x1b[39m",
};

const CODE_STRINGS = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\``;
const CODE_NUMBERS = "\\b\\d(?:[\\d_]*\\.?[\\d_]*)?(?:[eE][+-]?\\d+)?\\b";
const COMMENT_SLASH = "//.*$|/\\*.*?\\*/";
const COMMENT_HASH = "#.*$";
const COMMENT_DASH = "--.*$";

const CODE_FAMILIES = {
  cfamily: {
    comment: COMMENT_SLASH,
    keywords:
      "const|let|var|function|return|if|else|for|while|do|class|extends|implements|interface|type|enum|import|export|from|as|async|await|new|try|catch|finally|throw|typeof|instanceof|switch|case|break|continue|default|null|undefined|true|false|this|of|in|yield|static|get|set|readonly|void|int|char|float|double|long|short|unsigned|struct|public|private|protected|final|abstract|package|nullptr|delete|namespace|using|template|virtual|override",
  },
  python: {
    comment: COMMENT_HASH,
    keywords:
      "def|return|if|elif|else|for|while|class|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|nonlocal|yield|async|await|not|and|or|in|is|None|True|False|del|assert|match|case",
  },
  shell: {
    comment: COMMENT_HASH,
    keywords:
      "if|then|else|elif|fi|for|while|until|do|done|case|esac|function|local|return|export|readonly|declare|set|unset|shift|exit|in|select|trap|source|alias|echo|printf|read|cd|test",
  },
  go: {
    comment: COMMENT_SLASH,
    keywords:
      "func|return|if|else|for|range|package|import|type|struct|interface|map|chan|go|defer|select|switch|case|break|continue|fallthrough|var|const|nil|true|false|make|new|append|len|cap|error|string|int|int64|float64|bool|byte|rune",
  },
  rust: {
    comment: COMMENT_SLASH,
    keywords:
      "fn|let|mut|return|if|else|for|while|loop|match|impl|trait|struct|enum|pub|use|mod|crate|self|super|where|async|await|move|ref|dyn|Box|Vec|String|Some|None|Ok|Err|Result|Option|true|false|const|static|unsafe|as|in|break|continue",
  },
  sql: {
    comment: COMMENT_DASH,
    caseInsensitive: true,
    keywords:
      "select|from|where|insert|update|delete|into|values|join|left|right|inner|outer|full|cross|on|group|by|order|limit|offset|having|as|and|or|not|null|is|in|like|between|exists|union|all|distinct|create|table|drop|alter|add|column|index|primary|foreign|key|references|constraint|default|unique|begin|commit|rollback|case|when|then|else|end|count|sum|avg|min|max",
  },
  css: { comment: "/\\*.*?\\*/", keywords: "" },
  html: { comment: "<!--.*?-->", keywords: "" },
  yaml: { comment: COMMENT_HASH, keywords: "true|false|null|yes|no" },
  json: { comment: "", keywords: "true|false|null" },
  lua: {
    comment: COMMENT_DASH,
    keywords:
      "function|local|return|if|then|else|elseif|end|for|while|repeat|until|do|break|and|or|not|nil|true|false|in",
  },
};

const CODE_LANG_ALIASES = {
  js: "cfamily", jsx: "cfamily", ts: "cfamily", tsx: "cfamily",
  javascript: "cfamily", typescript: "cfamily", mjs: "cfamily", cjs: "cfamily",
  java: "cfamily", c: "cfamily", h: "cfamily", cpp: "cfamily", cc: "cfamily",
  hpp: "cfamily", csharp: "cfamily", cs: "cfamily", swift: "cfamily",
  kotlin: "cfamily", kt: "cfamily", scala: "cfamily", php: "cfamily",
  python: "python", py: "python", ruby: "python", rb: "python",
  shell: "shell", sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  console: "shell", shellsession: "shell",
  go: "go", golang: "go",
  rust: "rust", rs: "rust",
  sql: "sql", mysql: "sql", postgres: "sql", postgresql: "sql", sqlite: "sql",
  css: "css", scss: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
  yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", conf: "yaml",
  dockerfile: "shell", makefile: "shell",
  json: "json", jsonc: "json", json5: "json",
  lua: "lua",
};

const codeTokenRegexCache = new Map();
function codeTokenRegex(familyName) {
  let regex = codeTokenRegexCache.get(familyName);
  if (regex !== undefined) return regex;

  const family = CODE_FAMILIES[familyName];
  const parts = [];
  if (family.comment) parts.push(`(?<comment>${family.comment})`);
  parts.push(`(?<string>${CODE_STRINGS})`);
  parts.push(`(?<number>${CODE_NUMBERS})`);
  if (family.keywords) parts.push(`\\b(?<keyword>${family.keywords})\\b`);
  regex = new RegExp(parts.join("|"), family.caseInsensitive ? "gi" : "g");
  codeTokenRegexCache.set(familyName, regex);
  return regex;
}

// Tints one code line for the given fence language. Unknown languages pass
// through untouched; so does non-TTY output (replay into pipes, tests).
function highlightCode(line, lang) {
  if (!line || !process.stdout.isTTY) return line;
  const familyName = CODE_LANG_ALIASES[String(lang || "").toLowerCase()];
  if (!familyName) return line;

  return line.replace(codeTokenRegex(familyName), (match, ...args) => {
    const groups = args[args.length - 1];
    const kind =
      groups.comment !== undefined
        ? "comment"
        : groups.string !== undefined
          ? "string"
          : groups.keyword !== undefined
            ? "keyword"
            : "number";
    return `${CODE_TOKEN_COLORS[kind]}${match}${CODE_TOKEN_COLORS.end}`;
  });
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
      inputBg: "",
      inputMuted: "\x1b[38;5;245m",
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


// fzf-style filtering for interactive picker entries: every whitespace-
// separated word must appear in the entry's search text. Section headers
// (disabled entries) are dropped while a query is active so results read as a
// flat list.
// ============================== Picker list primitives ==============================
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
// ============ Status glyphs, text/markdown rendering, attachments, chat metadata ============
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

// ============================== Chat ordering ==============================
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

// ============================== tmux command helpers ==============================
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
    // Untitled chats read "New chat" in the status bar — never the raw
    // window name or chat id.
    "@vanzi_hub_title": compactTmuxText(cleanInline(chat.title || "")) || "New chat",
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

  try {
    const child = spawn("tmux", args, { stdio: "ignore" });
    child.on("error", () => {});
    child.on("close", () => refreshTmuxStatusLine());
    child.unref?.();
  } catch {
    // Best effort: tmux metadata sync must never break the hub.
  }
}

// tmux does not re-render window-status labels when a user option changes.
// A bare `refresh-client -S` fails without a current client (daemon,
// run-shell), so refresh every attached client explicitly.
function refreshTmuxStatusLine() {
  try {
    const list = spawn("tmux", ["list-clients", "-F", "#{client_name}"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    list.stdout.on("data", (chunk) => {
      out += chunk;
    });
    list.on("close", () => {
      for (const client of out.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const refresh = spawn("tmux", ["refresh-client", "-S", "-t", client], { stdio: "ignore" });
        refresh.on("error", () => {});
        refresh.unref?.();
      }
    });
    list.on("error", () => {});
    list.unref?.();
  } catch {
    // Cosmetic only.
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
    shellQuote(HUB_CLI_PATH),
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

function planMenuMarker(status) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▸";
  if (status === "skipped" || status === "cancelled") return "⊘";
  return "·";
}

// Native tmux display-menu item builders shared by the tmux-panel subcommand
// and the in-chat /mcp, /auth panel, /plan, /roots fallbacks in the UI.
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

function tmuxActionShellCommand(cwd, context, action, chatId = "", valueExpression = null) {
  const command = [
    shellQuote(process.execPath),
    shellQuote(HUB_CLI_PATH),
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


export {
  providerIconFor,
  resolvedAgentIcon,
  coloredProviderIcon,
  formatChatPreview,
  formatRelativeAge,
  providerAccentSeq,
  hubAccentSeq,
  codeBlockLine,
  highlightCode,
  HUB_CLI_PATH,
  buildMcpPanelItems,
  buildAuthPanelItems,
  buildPlanPanelItems,
  buildRootsPanelItems,
  codeFenceHeader,
  c,
  nowIso,
  shortHash,
  parseArgs,
  mkdirp,
  readJsonIfExists,
  readJsonIfExistsSync,
  backupCorruptJsonFileSync,
  writeJsonFileSync,
  loadDrafts,
  scheduleDraftsFlush,
  flushDraftsSync,
  draftKey,
  loadDraft,
  saveDraft,
  clearDraft,
  normalizeInputHistory,
  loadInputHistory,
  scheduleInputHistoryFlush,
  flushInputHistorySync,
  saveInputHistory,
  flushLocalInputStateSync,
  mergeConfig,
  loadConfig,
  resolveProjectRoot,
  projectName,
  defaultChatTitle,
  newChatTitle,
  savedSessionTitle,
  projectKey,
  chatIdFor,
  agentEntries,
  pickerFilterEntries,
  pickerNextIndex,
  pickerValueEquals,
  statusGlyph,
  statusColorName,
  statusIndicator,
  statusBadge,
  isSettledChatStatus,
  isActiveChatStatus,
  canMergeHistoryChunk,
  cleanInline,
  rawLogicalLines,
  rawLinePositions,
  normalizePastedText,
  shouldStorePasteAsAttachment,
  pastedTextSummary,
  pastedAttachmentSummary,
  createPastedTextAttachment,
  attachmentsFromPathOnlyText,
  attachmentsFromPathLine,
  attachmentFromPathToken,
  resolvePastedPathToken,
  normalizePastedPathToken,
  looksLikePathInput,
  stripMatchingQuotes,
  rawInputVisualLines,
  rawVisualLineIndexAtCursor,
  rawPreviousWord,
  rawNextWord,
  listProjectFiles,
  listProjectFilesWithRg,
  listProjectFilesFallback,
  normalizeMentionQuery,
  fileMentionScore,
  commonPathPrefix,
  escapeMentionPath,
  unescapeMentionPath,
  extractFileMentions,
  mentionAttachmentsForText,
  stripAnsi,
  visibleLength,
  sameRawInputLayout,
  padVisible,
  renderInlineMarkdown,
  isMarkdownTableStart,
  isMarkdownTableRow,
  isMarkdownTableSeparator,
  hasPendingMarkdownTable,
  splitMarkdownTableRow,
  renderMarkdownTable,
  fitMarkdownTableWidths,
  tableAlignment,
  looksNumeric,
  alignVisible,
  truncateText,
  fitPlainLine,
  inputComposerLine,
  fitAnsiLine,
  truncateAnsiText,
  horizontalRuleLine,
  activityDividerLine,
  isCompletedToolStatus,
  activityGroupFor,
  cleanActivitySummary,
  displayPath,
  normalizeAdditionalDirectories,
  findConfigOptionValue,
  normalizeToken,
  splitCommandWords,
  configOptionId,
  configOptionAliases,
  resolveConfigOption,
  sanitizeConfigValues,
  agentDefaultConfigValues,
  sortConfigEntries,
  selectedConfigValues,
  chatModel,
  compactProviderLabel,
  providerColorName,
  coloredProviderLabel,
  chatEffort,
  chatAccessLabel,
  chatConfigLabel,
  footerParts,
  attachmentChip,
  wrapAttachmentChips,
  configOptionValues,
  configOptionMenuValues,
  isBooleanConfigOption,
  parseBooleanConfigValue,
  resolveConfigOptionValue,
  buildSetConfigOptionRequest,
  applyLocalConfigOptionValue,
  configOptionValueMatches,
  syncChatModeFromConfig,
  modeEntries,
  resolveMode,
  accessAliases,
  resolveAccessTarget,
  configOptionDisplayValue,
  valueLabel,
  compactTmuxText,
  shortSession,
  formatConfigOption,
  formatProviderCommand,
  planMarker,
  buildPromptContent,
  resolvePromptAttachment,
  attachmentContentBlock,
  embeddedResourceForAttachment,
  promptDisplayText,
  contentBlockIsImage,
  contentBlockName,
  fileNameFromUri,
  mimeTypeForPath,
  formatBytes,
  formatTokenCount,
  formatCost,
  formatContextUsage,
  planProgressLabel,
  normalizeKeyValueList,
  mcpCapabilityFlags,
  normalizeMcpServer,
  resolveMcpServers,
  mcpServerLabel,
  contentText,
  toolContentText,
  supportsSessionClose,
  supportsSessionLoad,
  supportsSessionResume,
  supportsSessionListCapabilities,
  supportsSessionDelete,
  hasSessionCapability,
  isRestoreUnsupported,
  isMethodNotFound,
  chatAttentionRank,
  orderProjectChats,
  shellQuote,
  tmuxDoubleQuote,
  tmuxMenuTargetAttempts,
  displayTmuxMenu,
  tmuxDisplayMessage,
  tmuxPaneFormat,
  tmuxWindowOptionValues,
  setTmuxWindowOptions,
  findTmuxWindowForChat,
  syncTmuxChatMetadata,
  isAcpPane,
  tmuxSubmitToPane,
  tmuxPromptSubmitToPane,
  submitCommandToTmuxPane,
  tmuxInsertToPane,
  tmuxCommandPrompt,
  tmuxConfirmCommand,
  tmuxPanelCommand,
  tmuxActionShellCommand,
  actionPayload,
  parseActionPayload,
  tmuxActionCommand,
  tmuxPromptActionCommand,
  tmuxConfirmActionCommand,
  tmuxWorkspaceShellCommand,
  tmuxRunWorkspace,
  PLUGIN_DIR,
  BIN_PATH,
  DEFAULT_CONFIG,
  CACHE_BASE,
  CONFIG_BASE,
  HUB_DIR,
  USER_CONFIG_PATH,
  PLUGIN_CONFIG_PATH,
  SOCKET_PATH,
  PID_PATH,
  LOG_PATH,
  STATE_PATH,
  REGISTRY_PATH,
  DRAFTS_PATH,
  INPUT_HISTORY_PATH,
  PASTES_DIR,
  HISTORY_LIMIT,
  HISTORY_PERSIST_LIMIT,
  INPUT_HISTORY_LIMIT,
  DRAFT_SAVE_DEBOUNCE_MS,
  INPUT_HISTORY_SAVE_DEBOUNCE_MS,
  PERMISSION_TIMEOUT_MS,
  MAX_EMBEDDED_TEXT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_AUTO_ATTACH_PASTE_PATHS,
  PASTE_TEXT_ATTACHMENT_MIN_CHARS,
  PASTE_TEXT_ATTACHMENT_MIN_LINES,
  TRANSCRIPT_SCREEN_LINE_LIMIT,
  MAX_COMPOSER_INPUT_ROWS,
  MIN_COMPOSER_INPUT_ROWS,
  COMPOSER_INPUT_SIDE_PADDING,
  COMPOSER_META_SIDE_PADDING,
  COMPOSER_MARKER_WIDTH,
  COMPOSER_INPUT_VERTICAL_PADDING,
  COMPOSER_BOX_SIDE_WIDTH,
  COMPOSER_SPINNER_INTERVAL_MS,
  LIVE_TABLE_PAINT_MS,
  COMPOSER_PLACEHOLDER,
  PROVIDER_ACCENT_CODES,
  PROVIDER_ACCENT_FALLBACK,
  PROVIDER_ICONS,
  PROVIDER_ICON_FALLBACK,
  MAX_ATTACHMENT_CHIP_ROWS,
  FILE_MENTION_LIMIT,
  FILE_MENTION_CACHE_MS,
  KILL_RING_LIMIT,
  COMPOSER_SPINNER_FRAMES,
  colors,
};
