// The hub daemon: owns ACP adapter processes, chat state, and the registry.
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
// (no imports needed from ./render.mjs)
import {
  resolvedAgentIcon,
  nowIso,
  shortHash,
  mkdirp,
  readJsonIfExists,
  resolveProjectRoot,
  projectName,
  defaultChatTitle,
  newChatTitle,
  savedSessionTitle,
  projectKey,
  chatIdFor,
  agentEntries,
  canMergeHistoryChunk,
  cleanInline,
  mentionAttachmentsForText,
  normalizeAdditionalDirectories,
  configOptionId,
  resolveConfigOption,
  sanitizeConfigValues,
  agentDefaultConfigValues,
  sortConfigEntries,
  selectedConfigValues,
  chatModel,
  chatEffort,
  chatConfigLabel,
  resolveConfigOptionValue,
  buildSetConfigOptionRequest,
  applyLocalConfigOptionValue,
  configOptionValueMatches,
  syncChatModeFromConfig,
  resolveMode,
  valueLabel,
  buildPromptContent,
  promptDisplayText,
  resolveMcpServers,
  contentText,
  toolContentText,
  toolContentDiffs,
  supportsSessionClose,
  supportsSessionLoad,
  supportsSessionResume,
  supportsSessionListCapabilities,
  supportsSessionDelete,
  isRestoreUnsupported,
  isMethodNotFound,
  tmuxWindowOptionValues,
  setTmuxWindowOptions,
  applyAcpStatusFormat,
  findTmuxWindowForChat,
  HUB_DIR,
  SOCKET_PATH,
  PID_PATH,
  STATE_PATH,
  REGISTRY_PATH,
  HISTORY_LIMIT,
  HISTORY_PERSIST_LIMIT,
  PERMISSION_TIMEOUT_MS,
} from "./core.mjs";
import {
  canConnectToSocket,
  LineConnection,
  AcpPeer,
} from "./rpc.mjs";

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
    // Transcripts, drafts, and pastes are plaintext; keep the state dir private
    // (fixes both fresh and pre-existing 0755 dirs on multi-user systems).
    await fsp.chmod(HUB_DIR, 0o700).catch(() => {});
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
    await fsp.writeFile(PID_PATH, String(process.pid), { encoding: "utf8", mode: 0o600 });
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

    // Subscribe to the chat's *current* id: activateStoredChat can rekey a
    // recovered chat (stale session → fresh session) to a new id, and broadcast
    // matches on chat.id — subscribing to the old param id would miss events.
    client.subscriptions.add(chat.id);
    this.markCurrentChat(chat);

    let pendingPermission = null;
    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.chatId === chat.id) {
        pendingPermission = {
          permissionId,
          options: pending.options || [],
          toolCall: pending.toolCall || null,
        };
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
    // Nothing has streamed yet: the agent is thinking. "responding" arrives
    // with the first agent_message_chunk, "working" with tool calls.
    this.setStatus(chat, "thinking", "Prompt submitted");
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
    this.killTmuxWindowForChat(chatId);

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

  // The chat is gone, so its view goes too — for whichever pane triggered the
  // delete, including the current one. Windows are disposable views over
  // daemon-held chats, so killing one never loses data; leaving the requester's
  // own window behind (the old keepPane path) turned it into a stale "menu" tab
  // with the deleted chat's UI still running.
  killTmuxWindowForChat(chatId) {
    if (!process.env.TMUX || !chatId) return;
    findTmuxWindowForChat(chatId)
      .then((windowId) => {
        if (!windowId) return;
        const child = spawn("tmux", ["kill-window", "-t", windowId], { stdio: "ignore" });
        child.on("error", () => {});
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
      fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

    // Move any client subscriptions to the new id so live events keep flowing
    // to whoever was watching the chat before it was rekeyed.
    for (const client of this.clients) {
      if (client.subscriptions.delete(oldId)) client.subscriptions.add(newId);
    }
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
      // One broken/unauthenticated adapter must not sink the whole refresh:
      // report it as failed and keep importing the others.
      try {
        results.push(await this.refreshProviderSessions(providerId, cwd));
      } catch (error) {
        results.push({
          provider: providerId,
          supported: false,
          sessionCount: 0,
          sessions: [],
          error: error.message || String(error),
        });
      }
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
          diffs: toolContentDiffs(update.content),
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
          diffs: toolContentDiffs(update.content),
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
        toolCall: params.toolCall || null,
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
    // Heal the session's window-status-format if the boot race reverted it, so
    // the tab keeps showing the chat title rather than the raw window name.
    applyAcpStatusFormat(windowId);
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
        .writeFile(STATE_PATH, `${JSON.stringify(this.latestState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
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

export { HubDaemon };
