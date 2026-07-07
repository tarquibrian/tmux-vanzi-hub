// The popup client: frame painting, pickers, composer, transcript renderer.
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
  padAnsiToWidth,
} from "./render.mjs";
import {
  providerIconFor,
  coloredProviderIcon,
  formatChatPreview,
  formatRelativeAge,
  providerAccentSeq,
  hubAccentSeq,
  codeBlockLine,
  codeFenceHeader,
  highlightCode,
  applyAcpStatusFormat,
  HUB_CLI_PATH,
  buildMcpPanelItems,
  buildAuthPanelItems,
  buildPlanPanelItems,
  buildRootsPanelItems,
  c,
  draftKey,
  loadDraft,
  saveDraft,
  clearDraft,
  loadInputHistory,
  saveInputHistory,
  flushLocalInputStateSync,
  resolveProjectRoot,
  projectName,
  pickerFilterEntries,
  pickerNextIndex,
  pickerValueEquals,
  statusGlyph,
  statusColorName,
  statusIndicator,
  isSettledChatStatus,
  isActiveChatStatus,
  cleanInline,
  normalizePastedText,
  shouldStorePasteAsAttachment,
  pastedTextSummary,
  pastedAttachmentSummary,
  createPastedTextAttachment,
  attachmentsFromPathOnlyText,
  looksLikePathInput,
  rawInputVisualLines,
  rawVisualLineIndexAtCursor,
  rawPreviousWord,
  rawNextWord,
  listProjectFiles,
  normalizeMentionQuery,
  fileMentionScore,
  commonPathPrefix,
  escapeMentionPath,
  unescapeMentionPath,
  stripAnsi,
  visibleLength,
  sameRawInputLayout,
  renderInlineMarkdown,
  isMarkdownTableStart,
  isMarkdownTableRow,
  isMarkdownTableSeparator,
  hasPendingMarkdownTable,
  renderMarkdownTable,
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
  normalizeToken,
  splitCommandWords,
  configOptionId,
  resolveConfigOption,
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
  configOptionValueMatches,
  modeEntries,
  resolveAccessTarget,
  valueLabel,
  formatConfigOption,
  formatProviderCommand,
  planMarker,
  resolvePromptAttachment,
  formatBytes,
  formatTokenCount,
  formatCost,
  formatContextUsage,
  mcpServerLabel,
  chatAttentionRank,
  shellQuote,
  tmuxDoubleQuote,
  displayTmuxMenu,
  tmuxWindowOptionValues,
  setTmuxWindowOptions,
  tmuxSubmitToPane,
  tmuxPromptSubmitToPane,
  tmuxConfirmCommand,
  tmuxPanelCommand,
  actionPayload,
  tmuxActionCommand,
  tmuxPromptActionCommand,
  tmuxConfirmActionCommand,
  tmuxWorkspaceShellCommand,
  tmuxRunWorkspace,
  INPUT_HISTORY_LIMIT,
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
  FILE_MENTION_LIMIT,
  FILE_MENTION_CACHE_MS,
  KILL_RING_LIMIT,
  COMPOSER_SPINNER_FRAMES,
  colors,
} from "./core.mjs";

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
    this.markdownFenceLang = "";
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

  // Single-shot: the menu is an ephemeral window. Every outcome (pick a chat,
  // create one, back out) routes to a dedicated chat window and returns, so
  // the menu process exits and its window auto-closes (remain-on-exit off) —
  // no lingering "ACP menu" pane, only chat windows remain. Off tmux there is
  // no workspace, so selections render inline and the loop continues.
  async menuLoop() {
    if (!this.pickerSupported()) return this.menuLoopText();

    let selection;
    try {
      selection = await this.runMenuPicker();
    } catch (error) {
      this.logLine(c("red", error.message || String(error)));
      return this.menuLoopText();
    }

    if (!selection) {
      // Esc/Ctrl+C: back out — reveal the open chat if there is one, else
      // minimize — then let the menu window close by exiting.
      this.returnFromMenuOrMinimize();
      return "closed";
    }

    if (!process.env.TMUX) {
      // No workspace to switch into: render the selection inline and keep the
      // menu loop going (legacy non-tmux path).
      try {
        if (selection.type === "chat") return await this.openChat(selection.chatId);
        if (selection.type === "new") return await this.newProvider(selection.provider, this.cwd);
        if (selection.type === "provider") return await this.openProvider(selection.provider, this.cwd);
      } catch (error) {
        this.notify(`vanzi-hub: ${error.message || String(error)}`);
      }
      return "menu";
    }

    try {
      if (selection.type === "chat") {
        this.switchToChatWindow(selection);
      } else if (selection.type === "new") {
        this.switchToChatWindow({ cwd: this.cwd, provider: selection.provider, action: "new" });
      } else if (selection.type === "provider") {
        this.switchToChatWindow({ cwd: this.cwd, provider: selection.provider, action: "open" });
      }
    } catch (error) {
      this.notify(`vanzi-hub: ${error.message || String(error)}`);
    }
    return "closed";
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
        hint: "↑↓ move · type filters · Enter open · Tab scope · ^S reply · ^E rename · ^D delete · Esc close",
        emptyText: "No chats match — Esc clears the filter",
        items: this.buildMenuPickerItems(menu),
        onReply: (entry, text) =>
          entry.value?.type === "chat" ? this.replyToChatFromPicker(entry, text) : null,
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
            await this.hub.call("delete_chat", {
              chatId: entry.value.chatId,
              keepPane: process.env.TMUX_PANE || "",
            });
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
        value: { type: "chat", chatId: chat.id, cwd: chat.cwd, provider: chat.provider },
        canRename: true,
        canDelete: true,
        canReply: Boolean(chat.active),
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
          // Switch to the chat's own window (deduped by chat id) rather than
          // rendering it inside the menu window; fall back to inline off tmux.
          const chat = menu.visibleChats[chatNumber - 1];
          if (process.env.TMUX) {
            this.switchToChatWindow({ cwd: chat.cwd, provider: chat.provider, chatId: chat.id });
            continue;
          }
          const action = await this.openChat(chat.id);
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
    this.markdownFenceLang = "";
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
        `${c("yellow", "▎")} ${c("yellow", "⏸ Pending permission request")}  ${c("dim", "Enter picks · /allow <n> · /deny")}`,
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

        // ← on an empty composer backs out to the menu overlay in this pane.
        if (this.pendingComposerAction === "menu") {
          this.pendingComposerAction = null;
          if (await this.showMenuOverlay()) continue;
        }

        if (!line) {
          // Empty Enter with a pending permission opens the option picker —
          // the plan-mode "ready to code?" flow answers without typing.
          if (this.pendingPermission && (await this.showPermissionPicker())) continue;
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
        if (line === "/allow") {
          if (await this.showPermissionPicker()) continue;
          await this.answerPermission(line, "allow");
          continue;
        }
        if (line.startsWith("/allow ")) {
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
      // keepPane: this window turns into the menu after the delete; the daemon
      // must not kill it out from under us.
      const result = await this.hub.call("delete_chat", {
        chatId,
        keepPane: process.env.TMUX_PANE || "",
      });
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

  // Tab (+1) / Shift+Tab (-1) step through the adapter's advertised modes,
  // wrapping around. Modes are a behavior axis (Claude plan/default/…),
  // independent of the model (/model); the footer's access label reflects the
  // new mode, so the change is visible without opening the picker.
  async cycleMode(direction) {
    if (this.cyclingMode) return;
    const modes = modeEntries(this.currentChat?.modes);
    if (modes.length < 2) {
      this.notify(modes.length ? "only one mode available" : "no modes for this adapter");
      return;
    }

    const idOf = (mode) => String(mode.id || mode.modeId || mode.name || mode);
    const current = String(this.currentChat?.mode ?? "");
    let index = modes.findIndex((mode) =>
      [mode?.id, mode?.modeId, mode?.name, mode?.label, mode?.title]
        .filter(Boolean)
        .map(String)
        .includes(current),
    );
    if (index === -1) index = 0;

    const nextId = idOf(modes[(index + direction + modes.length) % modes.length]);
    if (!nextId || nextId === current) return;

    this.cyclingMode = true;
    try {
      await this.applyMode(nextId, { silent: true });
    } finally {
      this.cyclingMode = false;
    }
  }

  async applyMode(modeId, { silent = false } = {}) {
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
      // Tab-cycling already shows the mode live in the hint and footer, so it
      // suppresses this toast — otherwise the same value shows up three times.
      if (!silent) this.notify(`ACP mode=${result.modeId || modeId}`);
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

    // Run the tmux-menu subcommand out of process: it lives in the CLI entry
    // point, which imports this module — calling it directly would need a
    // circular import.
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            HUB_CLI_PATH,
            "tmux-menu",
            "--cwd", this.cwd,
            "--session", this.tmuxFormat("#{session_name}"),
            "--client", this.tmuxFormat("#{client_name}"),
            "--pane", this.tmuxPane(),
          ],
          { stdio: "ignore" },
        );
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`tmux-menu exited ${code}`)),
        );
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
        // Only live chats have an adapter to receive a prompt.
        canReply: Boolean(chat.active),
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
      hint: "↑↓ move · type filters · Enter switch · ^S reply · ^E rename · ^D delete · Esc cancel",
      items,
      onReply: (entry, text) => this.replyToChatFromPicker(entry, text),
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
          await this.hub.call("delete_chat", {
            chatId: entry.value.chatId,
            keepPane: process.env.TMUX_PANE || "",
          });
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

  // The full Vanzi Hub menu as an overlay in the current chat's pane (← or
  // prefix+M inside a chat) instead of a separate window. Reuses the same
  // picker as the menu-host process; a selection focuses the target chat's
  // window (or creates one), leaving this pane on its own chat. Returns false
  // when the popup can't paint pinned so callers fall back.
  async showMenuOverlay() {
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const selection = await this.runMenuPicker();
    if (!selection) return true; // Esc: the backdrop restored this chat.

    if (selection.type === "chat") {
      if (selection.chatId !== this.currentChat?.id) this.switchToChatWindow(selection);
    } else if (selection.type === "new") {
      this.switchToChatWindow({ cwd: this.cwd, provider: selection.provider, action: "new" });
    } else if (selection.type === "provider") {
      this.switchToChatWindow({ cwd: this.cwd, provider: selection.provider, action: "open" });
    }
    return true;
  }

  // Send a one-line prompt to a live chat straight from a picker, without
  // switching to its window. Only offered for active chats (canReply), so the
  // adapter is running; an idle chat starts a turn, a busy one queues it.
  async replyToChatFromPicker(entry, text) {
    const chatId = entry?.value?.chatId;
    if (!chatId) return;
    try {
      await this.hub.call("send_prompt", { chatId, text });
    } catch (error) {
      this.notify(`vanzi-hub: reply failed: ${error.message || String(error)}`);
    }
  }

  // Switching chats means selecting (or creating) that chat's tmux window;
  // workspace.sh owns that logic, so run it through tmux.
  // Runs synchronously (run-shell blocks until workspace.sh finishes) so the
  // target chat window exists before the caller — the menu process — exits;
  // otherwise auto-closing the menu window could leave the session empty and
  // tear it down before the chat window is created.
  switchToChatWindow({ cwd, provider, chatId = "", action = "open" }) {
    const command = tmuxWorkspaceShellCommand(cwd, this.tmuxContext(), provider, chatId, action);
    try {
      const res = spawnSync("tmux", ["run-shell", command], { stdio: "ignore" });
      return !res.error && res.status === 0;
    } catch {
      this.notify("vanzi-hub: failed to switch chat window");
      return false;
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

  // Interactive picker over the pending permission's options (the plan-mode
  // approval submenu). ACP carries flat options ({optionId, name, kind}) — no
  // per-option previews or free-text notes exist at the protocol level.
  async showPermissionPicker() {
    const pending = this.pendingPermission;
    if (!pending) return false;
    if (!this.pickerSupported() || !this.canPaintPinned()) return false;

    const options = pending.options || [];
    if (!options.length) return false;

    const kindHints = {
      allow_once: "allow once",
      allow_always: "always allow",
      reject_once: "reject once",
      reject_always: "always reject",
    };
    const items = options.map((option, index) => {
      const name = option.name || option.optionId || `option ${index + 1}`;
      const kind = option.kind ? kindHints[option.kind] || option.kind : "";
      return {
        label: `${name}${kind ? c("dim", ` · ${kind}`) : ""}`,
        searchText: `${name} ${kind}`,
        current: index === 0,
        value: option.optionId || String(index),
      };
    });

    const tool = pending.toolCall || {};
    const picked = await this.quickSelect({
      title: `⏸ Permission · ${cleanInline(tool.title || "Agent request")}`,
      hint: `1-${Math.min(items.length, 9)} pick · ↑↓/^n^p move · Enter · Esc keeps pending`,
      items,
    });

    // Esc keeps the request pending (/allow <n> still works); a response that
    // raced another client is dropped silently.
    if (picked === null) return true;
    if (this.pendingPermission !== pending) return true;

    try {
      await this.hub.call("permission_response", {
        permissionId: pending.permissionId,
        optionId: picked,
      });
      this.pendingPermission = null;
    } catch (error) {
      this.logLine(c("red", `Permission response failed: ${error.message}`));
    }
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

  // Esc on the menu dismisses the list: if a chat window is open in this
  // workspace, reveal it (the popup stays); otherwise there is nothing behind
  // the menu, so minimize the popup. Keeps prefix+M from feeling like it
  // closes the whole session when you only wanted to back out of the list.
  returnFromMenuOrMinimize() {
    if (process.env.TMUX) {
      const session = this.tmuxFormat("#{session_name}");
      if (session) {
        const res = spawnSync(
          "tmux",
          [
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_active}|#{window_last_flag}|#{@vanzi_hub_action}|#{pane_dead}|#{window_activity}|#{window_id}",
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        if (!res.error && res.status === 0) {
          const chats = String(res.stdout || "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [active, last, action, dead, activity, id] = line.split("|");
              return { active, last, action, dead, activity: Number(activity) || 0, id };
            })
            .filter((w) => w.action !== "menu" && w.dead !== "1" && w.active !== "1");

          if (chats.length) {
            // Prefer the window active just before the menu opened.
            const target =
              chats.find((w) => w.last === "1") ||
              chats.sort((a, b) => b.activity - a.activity)[0];
            const sel = spawnSync("tmux", ["select-window", "-t", target.id], { stdio: "ignore" });
            if (!sel.error && sel.status === 0) return;
          }
        }
      }
    }
    // No chat to fall back to: minimize the popup instead.
    this.closePopupClient();
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
      // Empty input: Tab / Shift+Tab cycle the adapter's session modes
      // (e.g. Claude plan → default → acceptEdits), like opencode.
      if (!session.line) {
        this.cycleMode(key.shift ? -1 : 1);
        return;
      }
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
      // Empty input: ← backs out to the menu overlay in this same pane (the
      // agent-view "detach" gesture). With text, it just moves the cursor.
      if (
        !session.line &&
        !this.pendingAttachments.length &&
        this.currentChat?.id &&
        this.scrollOffsetRows === 0 &&
        this.pickerSupported() &&
        this.canPaintPinned()
      ) {
        this.pendingComposerAction = "menu";
        finish("");
        return;
      }
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

  // Compact numbered menu for a handful of options (permission/plan-mode
  // approvals): no filter row — press the number to pick instantly, or
  // Ctrl+N/Ctrl+P (arrows) + Enter. Esc cancels (null). Anchored to the bottom
  // of the viewport like the other pickers.
  async quickSelect(config) {
    if (!this.pickerSupported() || !this.canPaintPinned()) return null;

    const items = (config.items || []).filter((item) => item && !item.disabled);
    if (!items.length) return null;

    return new Promise((resolve) => {
      const state = {
        title: config.title || "Select",
        hint: config.hint || `1-${Math.min(items.length, 9)} pick · ↑↓ move · Enter · Esc`,
        items,
        index: Math.max(0, items.findIndex((item) => item.current)),
        done: false,
        resizeHandler: null,
        resizeTimer: null,
        previousRawMode: process.stdin.isRaw,
      };
      if (state.index < 0) state.index = 0;

      const repaint = () => this.paintQuickSelect(state);

      const finish = (value) => {
        if (state.done) return;
        state.done = true;
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        if (state.resizeHandler) process.removeListener("SIGWINCH", state.resizeHandler);
        process.stdin.off("keypress", onKeypress);
        if (typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(Boolean(state.previousRawMode));
        }
        this.activePicker = null;
        this.restorePickerBackdrop();
        resolve(value);
      };

      const onKeypress = (input, key = {}) => {
        try {
          if (key.name === "escape" || (key.ctrl && key.name === "c")) {
            finish(null);
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            finish(state.items[state.index]?.value ?? null);
            return;
          }
          if (key.name === "up" || (key.ctrl && key.name === "p") || key.name === "k") {
            state.index = (state.index - 1 + state.items.length) % state.items.length;
            repaint();
            return;
          }
          if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "j") {
            state.index = (state.index + 1) % state.items.length;
            repaint();
            return;
          }
          // Number key: jump straight to that option and resolve.
          if (input && /^[1-9]$/.test(input)) {
            const n = Number(input) - 1;
            if (n < state.items.length) finish(state.items[n].value);
            return;
          }
        } catch {
          finish(null);
        }
      };

      this.activePicker = { repaint, onEvent: null };
      readlineTerminal.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      state.resizeHandler = () => {
        if (state.done) return;
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
          state.resizeTimer = null;
          if (!state.done) repaint();
        }, 30);
      };
      process.on("SIGWINCH", state.resizeHandler);
      repaint();
    });
  }

  paintQuickSelect(state) {
    if (!process.stdout.isTTY) return;

    const columns = Math.max(24, process.stdout.columns || 80);
    const width = Math.max(1, columns - 1);
    const viewportRows = this.pickerViewportRows();
    const painter = new FramePainter();

    const rows = state.items.length;
    const itemsStart = viewportRows - 1 - rows;
    const titleRow = itemsStart - 2;

    const writeRow = (row, content) => {
      if (row < 0) return;
      painter.to(0, row).clearLine();
      if (content) painter.text(fitAnsiLine(content, width)).text(colors.reset || "");
    };

    for (let row = 0; row < titleRow; row += 1) writeRow(row, "");
    writeRow(titleRow, c("bold", state.title));
    writeRow(titleRow + 1, c("dim", "─".repeat(Math.min(width, 96))));

    state.items.forEach((item, index) => {
      const selected = index === state.index;
      const marker = selected ? c("cyan", "❯") : " ";
      const number = c(selected ? "cyan" : "dim", String(index + 1));
      const label = selected ? item.label : c("dim", stripAnsi(item.label));
      writeRow(itemsStart + index, `${marker} ${number}  ${label}`);
    });

    writeRow(viewportRows - 1, c("dim", ` ${state.hint}`));
    painter.to(0, viewportRows - 1);
    painter.flush();
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
        replying: null,
        replyText: "",
        replyBusy: false,
        confirmDelete: null,
        previewEnabled: Boolean(config.onPreview),
        previewKey: null,
        previewData: null,
        previousRawMode: process.stdin.isRaw,
        resizeHandler: null,
        resizeTimer: null,
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
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        if (state.resizeHandler) process.removeListener("SIGWINCH", state.resizeHandler);
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

          // Reply mode: the query line becomes a one-line prompt sent straight
          // to the selected live chat, without leaving the picker.
          if (state.replying) {
            if (key.name === "escape") {
              state.replying = null;
              state.replyText = "";
              repaint();
              return;
            }
            if (key.name === "return" || key.name === "enter") {
              if (state.replyBusy) return;
              const entry = state.replying;
              const text = state.replyText.trim();
              if (!text) {
                state.replying = null;
                state.replyText = "";
                repaint();
                return;
              }
              state.replyBusy = true;
              repaint();
              Promise.resolve(config.onReply(entry, text))
                .then(() => {
                  state.replying = null;
                  state.replyText = "";
                  state.replyBusy = false;
                  // Refresh the preview so the dispatched turn shows up.
                  state.previewKey = null;
                  repaint();
                })
                .catch(() => {
                  state.replyBusy = false;
                  repaint();
                });
              return;
            }
            if (key.name === "backspace") {
              if (!state.replyBusy) state.replyText = state.replyText.slice(0, -1);
              repaint();
              return;
            }
            if (input && !key.ctrl && !key.meta && input >= " " && !state.replyBusy) {
              state.replyText += input;
              repaint();
            }
            return;
          }

          const currentEntries = visible();
          const selected = currentEntries[state.index];

          if (key.ctrl && key.name === "s" && config.onReply && selected?.canReply) {
            state.confirmDelete = null;
            state.replying = selected;
            state.replyText = "";
            state.replyBusy = false;
            repaint();
            return;
          }

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
      // Repaint on terminal resize: the popup client can detach (Esc) and a
      // later prefix+M reattaches at a different size — without this the
      // reattached pane keeps a stale or blank frame.
      state.resizeHandler = () => {
        if (state.done) return;
        if (state.resizeTimer) clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(() => {
          state.resizeTimer = null;
          if (!state.done) repaint();
        }, 30);
      };
      process.on("SIGWINCH", state.resizeHandler);
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
      : state.replying
        ? `${c("cyan", state.replyBusy ? "Sending…" : "Reply:")} ${state.replyText}`
        : state.query || c("dim", "type to filter…");

    // Two-column layout: list left, transcript preview right, when a preview
    // provider is wired and the popup is wide enough to be useful.
    const previewActive = state.previewEnabled && width >= 96;

    // Short lists hug the bottom of the viewport (near the composer the eye
    // was already on) instead of teleporting to the top; the preview layout
    // keeps the full height so the transcript pane stays useful.
    const usedRows = previewActive
      ? capacity
      : Math.max(1, Math.min(Math.max(entries.length, 1), capacity));
    const itemsStart = viewportRows - 1 - usedRows;
    const titleRow = itemsStart - 3;

    if (state.index >= state.scroll + usedRows) state.scroll = state.index - usedRows + 1;
    if (state.index !== -1 && state.index < state.scroll) state.scroll = state.index;
    state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, entries.length - usedRows)));

    const writeRow = (row, content) => {
      painter.to(0, row).clearLine();
      if (content) painter.text(fitAnsiLine(content, width)).text(colors.reset || "");
    };

    const listWidth = previewActive ? Math.min(64, Math.floor(width * 0.45)) : width;
    const previewWidth = previewActive ? width - listWidth - 3 : 0;
    const previewLines = previewActive
      ? formatChatPreview(state.previewData?.events, previewWidth, usedRows, (text) =>
          this.renderMarkdownDetached(text, previewWidth),
        )
      : [];
    const previewPending = previewActive && state.previewKey && !state.previewData;

    for (let row = 0; row < titleRow; row += 1) writeRow(row, "");
    writeRow(titleRow, `${c("bold", state.title)}  ${counter}`);
    writeRow(titleRow + 1, `${c("cyan", "❯")} ${queryText}`);
    writeRow(titleRow + 2, c("dim", "─".repeat(Math.min(width, 96))));

    for (let slot = 0; slot < usedRows; slot += 1) {
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
      writeRow(itemsStart + slot, content);
    }

    const hintLine = state.renaming
      ? c("dim", " Enter apply · Esc cancel")
      : state.replying
        ? c("dim", state.replyBusy ? " sending…" : " Enter sends to the chat · Esc cancel")
        : state.confirmDelete
          ? c("yellow", " Ctrl+D again deletes this chat permanently · any key cancels")
          : c("dim", ` ${state.hint}`);
    writeRow(viewportRows - 1, hintLine);

    const cursorText = state.renaming
      ? `Rename: ${state.renameText}`
      : state.replying
        ? `${state.replyBusy ? "Sending… " : "Reply: "}${state.replyText}`
        : state.query;
    painter.to(2 + visibleLength(cursorText), titleRow + 1);
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

  // The half-box composer costs one border row (top rule with the status);
  // small popups fall back to the flat divider layout so the transcript keeps
  // enough room.
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
    // Flat chrome: divider + footer. Boxed chrome: top rule + bottom rule
    // wrapping the input, then either the footer or the autocomplete dropdown.
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
        ...(boxBottomRow !== null ? [boxBottomRow] : []),
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
      // Half-box: the input band is flush with the rule; only the in-band
      // padding and marker eat width.
      return Math.max(8, safeColumns - COMPOSER_INPUT_SIDE_PADDING - COMPOSER_MARKER_WIDTH);
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
    return hubAccentSeq() || providerAccentSeq(this.currentChat?.provider);
  }

  // Rule title is a single segment: the provider identity while quiet, the
  // spinner + activity word while the agent runs, the semantic state when it
  // needs attention. One thing at a time.
  boxedComposerTitle() {
    const chat = this.currentChat || {};
    const status = chat.status || "idle";
    const token = normalizeToken(status);
    const seq = this.composerBorderSeq();
    const reset = colors.reset || "";
    const badges = this.composerBadges(chat, status)
      .map((badge) => c("yellow", badge))
      .join(" ");

    let main;
    if (token === "permission") {
      main = ""; // the [PERMISSION] badge carries it
    } else if (isActiveChatStatus(status) || token === "starting") {
      const frame = COMPOSER_SPINNER_FRAMES[this.composerSpinnerFrame % COMPOSER_SPINNER_FRAMES.length];
      main = `${seq}${frame} ${status}${reset}`;
    } else if (token === "auth" || token === "error") {
      main = c(token === "error" ? "red" : "yellow", `${statusGlyph(status)} ${status}`);
    } else {
      main = `${seq}${providerIconFor(chat.provider, chat)} ${compactProviderLabel(
        chat.providerLabel || chat.provider,
      )}${reset}`;
    }

    return [main, badges].filter(Boolean).join("  ");
  }

  renderBoxedComposer(session, layout) {
    const safeColumns = Math.max(1, layout.columns - 1);
    const interiorWidth = Math.max(4, safeColumns);
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

    // Half-box: a single top rule carrying the title — ─ <title> ─────
    const rawTitle = this.boxedComposerTitle();
    const title = truncateAnsiText(rawTitle, Math.max(4, safeColumns - 8));
    const fill = Math.max(0, safeColumns - 3 - visibleLength(title));
    painter
      .to(0, layout.dividerRow)
      .clearLine()
      .text(`${edge("─")} ${title} ${edge("─".repeat(fill))}`);

    for (let index = 0; index < layout.inputRows; index += 1) {
      const row = view.rows[index] || { prefix: "  ", text: "" };
      const interior = inputComposerLine(`${row.prefix}${row.text}`, interiorWidth, row.placeholder);
      painter.to(0, layout.inputRow + index).clearLine().text(interior);
    }

    // Bottom rule closing the input band; wrapped-input overflow counters sit
    // inside it, right-aligned.
    if (layout.boxBottomRow !== null) {
      const overflowParts = [];
      if (view.hiddenAbove) overflowParts.push(`↑ ${view.hiddenAbove} more`);
      if (view.hiddenBelow) overflowParts.push(`↓ ${view.hiddenBelow} more`);
      painter.to(0, layout.boxBottomRow).clearLine();
      if (overflowParts.length) {
        const label = overflowParts.join(" · ");
        const left = Math.max(0, safeColumns - 4 - visibleLength(label));
        painter.text(`${edge("─".repeat(left))} ${c("dim", label)} ${edge("──")}`);
      } else {
        painter.text(edge("─".repeat(Math.max(1, safeColumns))));
      }
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
      visibleLength(cursorRow.prefix) + view.cursorColumn,
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
    const token = normalizeToken(status);
    if (token === "permission") return "";
    // Composer palette stays close to the theme: quiet states are dim, busy
    // states take the rule accent, and only warn/error keep semantic colors —
    // fewer hues competing with the accent.
    if (isActiveChatStatus(status)) {
      const frame = COMPOSER_SPINNER_FRAMES[this.composerSpinnerFrame % COMPOSER_SPINNER_FRAMES.length];
      return `${this.composerBorderSeq()}${frame} ${status}${colors.reset || ""}`;
    }
    if (token === "auth") return c("yellow", `${statusGlyph(status)} ${status}`);
    if (token === "error") return c("red", `${statusGlyph(status)} ${status}`);
    return c("dim", `${statusGlyph(status)} ${status || "idle"}`);
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
    // Color hierarchy: model in plain text (brightest), context by usage
    // semaphore, elevated access modes in yellow (risk signal), rest dim.
    const access = chatAccessLabel(chat);
    const accessElevated = access && /full|bypass|yolo|agent|write|edit/i.test(access);
    const segments = [
      dim(this.composerAttachmentLabel()),
      modelLabel,
      this.composerContextLabel(),
      this.composerQueueLabel(),
      dim(this.composerMcpLabel()),
      accessElevated ? c("yellow", access) : dim(access),
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
      // Compact and quiet while comfortable ("8%" dim); color and the full
      // used/size detail appear only once the window actually fills up.
      const cost = formatCost(usage.cost);
      const label =
        pct < 0.6
          ? `${Math.round(pct * 100)}%${cost ? ` ${cost}` : ""}`
          : `${formatTokenCount(used)}/${formatTokenCount(size)} (${Math.round(pct * 100)}%)${cost ? ` ${cost}` : ""}`;
      return c(pct >= 0.85 ? "red" : pct >= 0.6 ? "yellow" : "dim", label);
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

    // Ctrl+N/P (and the arrows) travel the list; Tab completes the selection
    // so the typing hand never leaves the home row.
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      session.autocompleteIndex = (dropdown.index + 1) % count;
      this.renderRawInput();
      return true;
    }

    if (key.name === "up" || (key.ctrl && key.name === "p") || (key.name === "tab" && key.shift)) {
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
    if (!line) {
      // Empty input: surface the Tab mode cycle when the adapter has modes,
      // folding the ← menu gesture in there so it never adds a hint row on its
      // own (the composer geometry stays unchanged when there's no hint).
      const modes = modeEntries(this.currentChat?.modes);
      if (modes.length >= 2) {
        const label = valueLabel(this.currentChat?.mode) || this.currentChat?.mode || "mode";
        const back = this.currentChat?.id ? "← menu  ·  " : "";
        return `${back}⇥ / ⇧⇥ mode · ${label}`;
      }
      return "";
    }
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
        this.markdownFenceLang = this.markdownFence ? fence[1] || "" : "";
        output.push(this.markdownFence && fence[1] ? codeFenceHeader(fence[1], width) : "");
        index += 1;
        continue;
      }

      if (this.markdownFence) {
        output.push(codeBlockLine(highlightCode(line, this.markdownFenceLang), { width }));
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
    const savedFenceLang = this.markdownFenceLang;
    this.markdownFence = false;
    this.markdownFenceLang = "";
    try {
      return this.renderMarkdown(text, { width });
    } finally {
      this.markdownFence = savedFence;
      this.markdownFenceLang = savedFenceLang;
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
      this.markdownFenceLang = this.markdownFence ? fence[1] || "" : "";
      this.emitTranscript(`${this.markdownFence && fence[1] ? codeFenceHeader(fence[1]) : ""}\n`);
      return;
    }

    if (this.markdownFence) {
      this.emitTranscript(`${codeBlockLine(highlightCode(line, this.markdownFenceLang))}\n`);
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
        toolCall: message.params.toolCall || null,
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

    // Target this UI's own pane/window explicitly. A bare set-window-option
    // writes to whatever window is "current", which during open — the menu
    // window closing, select-window still in flight — may not be this chat's
    // window yet. That left the chat window's @vanzi_hub_title (and the
    // @vanzi_hub_chat_id the daemon keys its own sync on) unset, so the tab
    // showed the raw canonical name until a reattach forced a refresh.
    const ownPane = process.env.TMUX_PANE || "";
    const values = tmuxWindowOptionValues(chat);
    setTmuxWindowOptions(values, ownPane);
    // Re-assert the session's ACP status format too — the popup/daemon boot
    // race can revert it to the theme default; then the tab falls back to the
    // window name, which we keep equal to the title so it stays clean.
    applyAcpStatusFormat(ownPane);

    // Keep the window name in sync with the chat title so #W (the tab's
    // fallback and the prefix+s tree label) reads as the title, never a hash.
    const windowName = values["@vanzi_hub_title"];
    if (ownPane && windowName && windowName !== this.lastSyncedWindowName) {
      this.lastSyncedWindowName = windowName;
      try {
        const child = spawn("tmux", ["rename-window", "-t", ownPane, windowName], { stdio: "ignore" });
        child.on("error", () => {});
        child.unref?.();
      } catch {
        // Cosmetic only.
      }
    }
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
      // Blank before the rule mirrors the blank after it — symmetric sections.
      this.logLine("");
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
    this.logLine("");
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
    this.logLine(`${rail} ${c("dim", "Enter picks · /allow <n> · /deny")}`);
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


export {
  FramePainter,
  PopupUi,
};
