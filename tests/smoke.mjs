#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(TEST_DIR, "..");
const HUB_BIN = path.join(PLUGIN_DIR, "bin", "vanzi-hub.mjs");
const FAKE_AGENT = path.join(TEST_DIR, "fake-acp-agent.mjs");

class JsonSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Hub socket closed"));
      }
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;

    this.socket.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
  }

  close() {
    this.socket.end();
  }

  handleData(chunk) {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;

      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      const message = JSON.parse(line);
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;

        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        continue;
      }

      for (const handler of this.eventHandlers) {
        handler(message);
      }
    }
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tmux-vanzi-hub-"));
const hubHome = path.join(tmp, "hub");
const socketPath = path.join(hubHome, "hub.sock");
const configPath = path.join(tmp, "agents.json");
const projectPath = path.join(tmp, "project");
const extraPath = path.join(tmp, "extra-root");

await fs.mkdir(projectPath, { recursive: true });
await fs.mkdir(extraPath, { recursive: true });
await fs.writeFile(
  configPath,
  `${JSON.stringify(
    {
      defaultAgent: "fake",
      agents: {
        fake: {
          label: "Fake ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
        },
        fakeauth: {
          label: "Fake Auth ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          env: { FAKE_REQUIRE_AUTH: "1" },
        },
        fakemcp: {
          label: "Fake MCP ACP",
          command: process.execPath,
          args: [FAKE_AGENT],
          mcpServers: [
            { name: "echo-mcp", command: "node", args: ["-e", "0"], env: {} },
            { name: "gated-mcp", type: "http", url: "https://example.test/mcp", headers: {} },
          ],
        },
      },
    },
    null,
    2,
  )}\n`,
);

const env = {
  ...process.env,
  VANZI_HUB_HOME: hubHome,
  VANZI_HUB_SOCKET: socketPath,
  VANZI_HUB_CONFIG: configPath,
  FAKE_EXPECT_CWD: projectPath,
  FAKE_EXTRA_DIR: extraPath,
};

const daemonLogs = [];
let daemon = startDaemon();

try {
  const hub = await connectWithRetry(socketPath);
  const events = [];
  hub.onEvent((event) => events.push(event));

  const chat = await hub.call("ensure_chat", { provider: "fake", cwd: projectPath });
  assert.equal(chat.status, "idle");
  assert.equal(chat.mode, "test");
  assert.equal(chat.title, "New chat");
  assert.equal(
    chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-small",
  );

  await hub.call("subscribe", { chatId: chat.id });
  const modelUpdate = await hub.call("set_config_option", {
    chatId: chat.id,
    configId: "model",
    value: "large",
  });
  assert.equal(
    modelUpdate.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );

  const effortUpdate = await hub.call("set_config_option", {
    chatId: chat.id,
    configId: "effort",
    value: "high",
  });
  assert.equal(
    effortUpdate.chat.configOptions.find((option) => option.id === "effort")?.currentValue,
    "high",
  );

  const modeUpdate = await hub.call("set_mode", {
    chatId: chat.id,
    modeId: "plan",
  });
  assert.equal(modeUpdate.chat.mode, "plan");

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "config",
    "--chat-id",
    chat.id,
    "--value",
    JSON.stringify({ configId: "model", value: "small" }),
  ]);
  const actionConfig = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(
    actionConfig.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-small",
  );
  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "config",
    "--chat-id",
    chat.id,
    "--value",
    JSON.stringify({ configId: "model", value: "large" }),
  ]);
  const actionConfigRestore = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(
    actionConfigRestore.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "mode",
    "--chat-id",
    chat.id,
    "--value",
    "test",
  ]);
  const actionMode = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(actionMode.chat.mode, "test");

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "access",
    "--chat-id",
    chat.id,
    "--value",
    "plan",
  ]);
  const actionAccess = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(actionAccess.chat.mode, "plan");

  const rootsUpdate = await hub.call("set_roots", {
    chatId: chat.id,
    additionalDirectories: [extraPath],
  });
  assert.deepEqual(rootsUpdate.chat.additionalDirectories, [extraPath]);
  assert.equal(rootsUpdate.requiresRestart, true);

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "roots-clear",
    "--chat-id",
    chat.id,
  ]);
  const actionRootsClear = await hub.call("subscribe", { chatId: chat.id });
  assert.deepEqual(actionRootsClear.chat.additionalDirectories, []);

  runHubCli([
    "tmux-action",
    "--cwd",
    projectPath,
    "--action",
    "roots-add",
    "--chat-id",
    chat.id,
    "--value",
    extraPath,
  ]);
  const actionRootsAdd = await hub.call("subscribe", { chatId: chat.id });
  assert.deepEqual(actionRootsAdd.chat.additionalDirectories, [extraPath]);

  // Rename now runs through the composer's in-process prompt (no CLI/shell
  // action), so a title with quotes can never break a command. Exercise the
  // daemon RPC the composer calls, including such a title.
  await hub.call("rename_chat", { chatId: chat.id, title: `Bob's "fake" chat` });
  const actionRename = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(actionRename.chat.title, `Bob's "fake" chat`);

  await hub.call("send_prompt", { chatId: chat.id, text: "trigger permission" });
  await waitFor(() => events.some((event) => event.event === "permission_request"));

  // A pending permission must survive a popup close and be re-surfaced when the
  // chat is re-subscribed, so a reopened popup can still answer it.
  const permEvent = events.find((event) => event.event === "permission_request");
  const resubscribe = await hub.call("subscribe", { chatId: chat.id });
  assert.ok(resubscribe.pendingPermission, "subscribe should surface the pending permission");
  assert.equal(resubscribe.pendingPermission.permissionId, permEvent.permissionId);

  // promptQueueing: a prompt sent while the turn is still active is queued, not
  // rejected; cancelling the turn drops the queued prompts.
  const queuedWhileBusy = await hub.call("send_prompt", { chatId: chat.id, text: "queued while busy" });
  assert.equal(queuedWhileBusy.queued, true);
  assert.equal(queuedWhileBusy.queueLength, 1);
  assert.equal(queuedWhileBusy.chat.queued, 1);

  const cancel = await hub.call("cancel", { chatId: chat.id });
  assert.equal(cancel.cancelledPermissions, 1);
  assert.equal(cancel.droppedQueue, 1);

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.event?.type === "turn_done" &&
        event.event?.stopReason === "cancelled",
    ),
  );

  // usage_update: context-window usage (used/size) and cost flow into the chat
  // summary so the composer footer can show it.
  await hub.call("send_prompt", { chatId: chat.id, text: "report usage please" });
  await waitFor(() => events.some((event) => event.chat?.usage?.used === 45000));
  const usageChat = (await hub.call("subscribe", { chatId: chat.id })).chat;
  assert.equal(usageChat.usage.used, 45000);
  assert.equal(usageChat.usage.size, 200000);
  assert.equal(usageChat.usage.cost.amount, 0.12);

  // chat_preview: the picker preview pane fetches the transcript tail for any
  // known chat (live here; registry records use the same code path).
  const preview = await hub.call("chat_preview", { chatId: chat.id });
  assert.equal(preview.chatId, chat.id);
  assert.equal(preview.active, true);
  assert.ok(Array.isArray(preview.events) && preview.events.length > 0);
  assert.ok(preview.events.some((event) => event.type === "user"));
  await assert.rejects(hub.call("chat_preview", { chatId: "nope" }), /Unknown chat/);

  // plan: the latest plan is kept as chat state so a panel/footer can show live
  // step progress instead of only appending to the transcript.
  await hub.call("send_prompt", { chatId: chat.id, text: "draft a plan" });
  await waitFor(() => events.some((event) => event.chat?.plan?.entries?.length === 3));
  const planChat = (await hub.call("subscribe", { chatId: chat.id })).chat;
  assert.equal(planChat.plan.entries.length, 3);
  assert.equal(planChat.plan.entries[0].status, "completed");
  assert.equal(planChat.plan.entries[1].status, "in_progress");
  assert.equal(planChat.plan.entries[2].status, "pending");

  // promptQueueing drain: a prompt queued during an active turn is dispatched
  // once that turn finishes.
  const drainMark = events.length;
  await hub.call("send_prompt", { chatId: chat.id, text: "trigger permission" });
  await waitFor(() => events.slice(drainMark).some((event) => event.event === "permission_request"));
  const drainPerm = events.slice(drainMark).reverse().find((event) => event.event === "permission_request");
  const drainQueued = await hub.call("send_prompt", { chatId: chat.id, text: "draft a plan" });
  assert.equal(drainQueued.queued, true);
  await hub.call("permission_response", { permissionId: drainPerm.permissionId, optionId: "allow" });
  await waitFor(() =>
    events
      .slice(drainMark)
      .some(
        (event) =>
          event.type === "chat_event" &&
          event.event?.type === "user" &&
          /draft a plan/.test(event.event?.text || ""),
      ),
  );
  const drained = (await hub.call("subscribe", { chatId: chat.id })).chat;
  assert.equal(drained.queued, 0);

  // authenticate: an adapter that needs auth reports `auth` status with the
  // advertised methods; authenticating retries session creation to reach idle.
  const authChat = await hub.call("ensure_chat", { provider: "fakeauth", cwd: projectPath });
  assert.equal(authChat.status, "auth");
  assert.ok(authChat.authMethods.some((method) => method.id === "token"));
  assert.equal(authChat.sessionId, null);
  const authResult = await hub.call("authenticate", { chatId: authChat.id, methodId: "token" });
  assert.equal(authResult.chat.status, "idle");
  assert.ok(authResult.chat.sessionId);
  await hub.call("close_chat", { chatId: authResult.chat.id });

  // MCP servers: configured servers are passed to session/new. stdio is always
  // supported; http is gated out because this adapter advertises no
  // mcpCapabilities, so only the stdio server reaches the agent.
  const mcpChat = await hub.call("new_chat", { provider: "fakemcp", cwd: projectPath });
  assert.equal(mcpChat.status, "idle");
  assert.equal(mcpChat.title, "mcp-ok:1");
  assert.equal(mcpChat.mcpServers.length, 1);
  assert.equal(mcpChat.mcpServers[0].name, "echo-mcp");
  await hub.call("close_chat", { chatId: mcpChat.id });

  const secondChat = await hub.call("new_chat", { provider: "fake", cwd: projectPath });
  assert.notEqual(secondChat.id, chat.id);
  assert.equal(secondChat.status, "idle");
  assert.equal(secondChat.title, "New chat 2");
  assert.equal(secondChat.mode, "plan");
  assert.equal(
    secondChat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );
  assert.equal(
    secondChat.configOptions.find((option) => option.id === "effort")?.currentValue,
    "high",
  );

  await hub.call("subscribe", { chatId: chat.id });
  const renamed = await hub.call("rename_chat", { chatId: chat.id, title: "Primary fake chat" });
  assert.equal(renamed.title, "Primary fake chat");

  const currentAgain = await hub.call("ensure_chat", { provider: "fake", cwd: projectPath });
  assert.equal(currentAgain.id, chat.id);
  assert.equal(currentAgain.title, "Primary fake chat");

  await new Promise((resolve) => setTimeout(resolve, 150));
  const selectedProjectChat = runHubCli(["project-chat", "--cwd", projectPath]);
  assert.equal(selectedProjectChat.stdout.trim(), `fake|${chat.id}`);
  const missingProjectChat = runHubCli(["project-chat", "--cwd", extraPath]);
  assert.equal(missingProjectChat.stdout.trim(), "");

  // Without tmux the prefix+m toggle menu must degrade to direct creation
  // (TMUX stripped so the test never draws a menu in the developer's session).
  const headlessToggle = runHubCli(["tmux-toggle-menu", "--cwd", extraPath], { TMUX: "" });
  assert.equal(headlessToggle.stdout.trim(), "create");

  const renamedSearch = await hub.call("list_chats", {
    provider: "fake",
    query: "Primary fake",
    limit: 1,
  });
  assert.equal(renamedSearch.chats[0].id, chat.id);

  await hub.call("send_prompt", { chatId: chat.id, text: "table" });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("nvim"),
    ),
  );
  const tableHistory = await hub.call("subscribe", { chatId: chat.id });
  const tableChunks = tableHistory.history.filter((event) => event.type === "agent_chunk");
  assert.equal(tableChunks.length, 1);
  assert.ok(tableChunks[0].text.includes("| Carpeta |"));
  assert.ok(tableChunks[0].text.includes("| nvim/ |"));

  const renderedTable = renderMarkdown(
    [
      "| File | What it does | Notes |",
      "|---|---|---|",
      "| .gitignore | Ignores DS_Store, copilot, iterm2, tmux plugins except vanzi-hub, opencode runtime, avante state, lazygit and lazy-lock | Solid. vanzi-hub exception correct. |",
      "| blink-cmp.lua | blink.cmp config with rust fuzzy, LSP path buffer snippets sources, Tab accept, C-n/p nav, ghost text off, winblend from pumblend | Clean. Ghost text off intentional? |",
    ].join("\n"),
  );
  assert.match(renderedTable, /• File/);
  assert.match(renderedTable, /━+/);
  assert.doesNotMatch(renderedTable, /^\| blink-cmp\.lua \|/m);

  const attachmentPath = path.join(projectPath, "note.md");
  await fs.writeFile(attachmentPath, "# Attached note\n\nhello from attachment\n", "utf8");
  await hub.call("send_prompt", {
    chatId: chat.id,
    text: "attachment test",
    attachments: [attachmentPath],
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("resource:"),
    ),
  );
  const attachmentHistory = await hub.call("subscribe", { chatId: chat.id });
  const attachmentUser = attachmentHistory.history.find(
    (event) => event.type === "user" && event.text.includes("[FILE1] note.md"),
  );
  assert.ok(attachmentUser);

  const imagePath = path.join(projectPath, "screen.png");
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await hub.call("send_prompt", {
    chatId: chat.id,
    text: "attachment image",
    attachments: [imagePath],
  });
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("image:image/png"),
    ),
  );
  const imageHistory = await hub.call("subscribe", { chatId: chat.id });
  const imageUser = imageHistory.history.find(
    (event) => event.type === "user" && event.text.includes("[IMAGE1] screen.png"),
  );
  assert.ok(imageUser);

  await hub.call("send_prompt", {
    chatId: chat.id,
    text: "attachment mention @note.md",
  });
  await waitFor(() =>
    events.filter(
      (event) =>
        event.type === "chat_event" &&
        event.chatId === chat.id &&
        event.event?.type === "agent_chunk" &&
        event.event?.text?.includes("resource:"),
    ).length >= 2,
  );

  const listed = await hub.call("refresh_sessions", { provider: "fake", cwd: projectPath });
  assert.equal(listed.providers[0].supported, true);
  assert.ok(listed.providers[0].sessions.some((session) => session.sessionId === "listed-session"));
  const listedSession = listed.providers[0].sessions.find(
    (session) => session.sessionId === "listed-session",
  );
  assert.deepEqual(listedSession.additionalDirectories, [extraPath]);

  const listedRestored = await hub.call("subscribe", { chatId: listedSession.id });
  assert.equal(listedRestored.chat.status, "idle");
  assert.equal(listedRestored.chat.mode, "restored");

  await hub.call("close_chat", { chatId: chat.id });
  const restored = await hub.call("subscribe", { chatId: chat.id });
  assert.equal(restored.chat.status, "idle");
  assert.equal(restored.chat.mode, "plan");
  assert.equal(
    restored.chat.configOptions.find((option) => option.id === "model")?.currentValue,
    "fake-large",
  );
  assert.equal(
    restored.chat.configOptions.find((option) => option.id === "effort")?.currentValue,
    "high",
  );
  assert.deepEqual(restored.chat.additionalDirectories, [extraPath]);

  const chats = await hub.call("list_chats");
  assert.ok(chats.chats.length >= 3);
  assert.ok(chats.chats.some((candidate) => candidate.id === chat.id));
  assert.ok(chats.chats.some((candidate) => candidate.id === secondChat.id));
  assert.ok(chats.chats.some((candidate) => candidate.sessionId === "listed-session"));

  const scoped = await hub.call("list_chats", {
    provider: "fake",
    cwd: projectPath,
    limit: 10,
  });
  assert.ok(scoped.chats.some((candidate) => candidate.id === chat.id));
  assert.ok(scoped.chats.some((candidate) => candidate.id === secondChat.id));

  const filtered = await hub.call("list_chats", {
    provider: "fake",
    query: "fake-large",
    limit: 1,
  });
  assert.equal(filtered.chats.length, 1);
  assert.equal(filtered.chats[0].id, chat.id);

  const listedFiltered = await hub.call("list_chats", {
    provider: "fake",
    query: "listed",
    limit: 1,
  });
  assert.equal(listedFiltered.chats.length, 1);
  assert.equal(listedFiltered.chats[0].sessionId, "listed-session");

  // session/delete (capability-gated), live-peer path: a fresh active chat is
  // deleted through its running adapter and removed from the registry.
  const throwaway = await hub.call("new_chat", { provider: "fake", cwd: projectPath });
  const delActive = await hub.call("delete_chat", { chatId: throwaway.id });
  assert.equal(delActive.providerSupported, true);
  assert.equal(delActive.providerDeleted, true);
  const afterActiveDelete = await hub.call("list_chats");
  assert.ok(!afterActiveDelete.chats.some((candidate) => candidate.id === throwaway.id));

  await hub.call("shutdown");
  hub.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  daemon = startDaemon();
  const restartedHub = await connectWithRetry(socketPath);
  const persisted = await restartedHub.call("list_chats");
  assert.ok(persisted.chats.some((candidate) => candidate.id === chat.id));
  assert.ok(persisted.chats.some((candidate) => candidate.id === secondChat.id));
  assert.ok(persisted.chats.some((candidate) => candidate.sessionId === "listed-session"));

  // session/delete, saved-path: after a restart the chat is a stored record with
  // no live adapter, so the daemon uses a temporary one to delete it.
  const delSaved = await restartedHub.call("delete_chat", { chatId: chat.id });
  assert.equal(delSaved.providerSupported, true);
  assert.equal(delSaved.providerDeleted, true);
  const afterSavedDelete = await restartedHub.call("list_chats");
  assert.ok(!afterSavedDelete.chats.some((candidate) => candidate.id === chat.id));

  await restartedHub.call("shutdown");
  restartedHub.close();

  console.log("tmux-vanzi-hub smoke test passed");
} catch (error) {
  daemon.kill("SIGTERM");
  console.error(daemonLogs.join(""));
  throw error;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 100));
  daemon.kill("SIGTERM");
  await fs.rm(tmp, { recursive: true, force: true });
}

function startDaemon() {
  const child = spawn(process.execPath, [HUB_BIN, "daemon"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => daemonLogs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => daemonLogs.push(chunk.toString()));
  return child;
}

function runHubCli(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [HUB_BIN, ...args], {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `command failed: ${[HUB_BIN, ...args].join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function renderMarkdown(input) {
  const result = spawnSync(process.execPath, [HUB_BIN, "_render-markdown"], {
    env,
    input,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `render markdown failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

async function connectWithRetry(socketPath) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 5000) {
    try {
      return await connect(socketPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError || new Error("Could not connect to hub");
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(new JsonSocketClient(socket)));
    socket.once("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for condition");
}
