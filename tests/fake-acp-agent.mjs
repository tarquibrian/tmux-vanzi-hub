#!/usr/bin/env node

let buffer = "";
let nextId = 1000;
const pending = new Map();
let currentSessionId = null;
let currentMode = "test";
let currentModel = "fake-small";
let currentEffort = "low";
const requireAuth = process.env.FAKE_REQUIRE_AUTH === "1";
let authed = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;

    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    handleMessage(JSON.parse(line)).catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
  }
});

async function handleMessage(message) {
  if (Object.prototype.hasOwnProperty.call(message, "id") && pending.has(message.id)) {
    const pendingRequest = pending.get(message.id);
    pending.delete(message.id);
    pendingRequest.resolve(message.result || message.error);
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, {
      agentInfo: {
        name: "fake-acp-agent",
        title: "Fake ACP Agent",
        version: "0.1.0",
      },
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          close: {},
          delete: {},
          list: {},
          load: {},
          resume: {},
        },
      },
      authMethods: requireAuth
        ? [{ id: "token", name: "Token login", description: "Fake interactive auth" }]
        : [],
    });
    return;
  }

  if (message.method === "authenticate") {
    if (message.params?.methodId !== "token") {
      respondError(message.id, -32602, `Unknown auth method: ${message.params?.methodId}`);
      return;
    }
    authed = true;
    respond(message.id, {});
    return;
  }

  if (message.method === "session/new") {
    if (requireAuth && !authed) {
      respondError(message.id, -32000, "Authentication required");
      return;
    }
    currentSessionId = `fake-session-${process.pid}`;
    currentMode = "test";
    const mcpServers = Array.isArray(message.params?.mcpServers) ? message.params.mcpServers : [];
    const mcpEcho = mcpServers.some((server) => server.name === "echo-mcp")
      ? { title: `mcp-ok:${mcpServers.length}` }
      : {};
    respond(message.id, {
      sessionId: currentSessionId,
      ...mcpEcho,
      modes: {
        currentModeId: currentMode,
        availableModes: [
          { id: "test", name: "Test" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: configOptions(),
    });
    return;
  }

  if (message.method === "session/list") {
    if (process.env.FAKE_EXPECT_CWD && message.params?.cwd !== process.env.FAKE_EXPECT_CWD) {
      respondError(message.id, -32000, `Expected cwd ${process.env.FAKE_EXPECT_CWD}`);
      return;
    }

    respond(message.id, {
      sessions: [
        {
          sessionId: "listed-session",
          cwd: message.params?.cwd || process.cwd(),
          title: "Listed fake session",
          updatedAt: new Date().toISOString(),
          additionalDirectories: process.env.FAKE_EXTRA_DIR ? [process.env.FAKE_EXTRA_DIR] : [],
        },
      ],
    });
    return;
  }

  if (message.method === "session/load" || message.method === "session/resume") {
    if (message.params.sessionId === "listed-session" && process.env.FAKE_EXTRA_DIR) {
      if (!message.params.additionalDirectories?.includes(process.env.FAKE_EXTRA_DIR)) {
        respondError(message.id, -32000, "Expected additionalDirectories for listed-session");
        return;
      }
    }

    currentSessionId = message.params.sessionId;
    currentMode = "restored";
    respond(message.id, {
      sessionId: currentSessionId,
      modes: {
        currentModeId: currentMode,
        availableModes: [
          { id: "restored", name: "Restored" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: configOptions(),
    });
    return;
  }

  if (message.method === "session/set_config_option") {
    if (message.params.configId === "model") currentModel = message.params.value;
    if (message.params.configId === "effort") currentEffort = message.params.value;
    if (message.params.configId === "mode") currentMode = message.params.value;

    notify("session/update", {
      sessionId: currentSessionId || "fake-session",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: configOptions(),
      },
    });
    respond(message.id, {
      configOptions: configOptions(),
    });
    return;
  }

  if (message.method === "session/set_mode") {
    currentMode = message.params.modeId;
    notify("session/update", {
      sessionId: currentSessionId || "fake-session",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: currentMode,
      },
    });
    respond(message.id, {});
    return;
  }

  if (message.method === "session/prompt") {
    const prompt = message.params?.prompt || [];
    const promptText = prompt
      .map((part) => part?.text || "")
      .join("\n");

    if (/attachment/i.test(promptText)) {
      const summary = prompt
        .filter((part) => part.type !== "text")
        .map((part) => {
          if (part.type === "resource") return `resource:${part.resource?.uri || ""}`;
          if (part.type === "resource_link") return `link:${part.name || part.uri || ""}`;
          if (part.type === "image") return `image:${part.mimeType || ""}`;
          return part.type || "unknown";
        })
        .join(",");
      notify("session/update", {
        sessionId: currentSessionId || "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `attachments ${summary}`,
          },
        },
      });
      respond(message.id, {
        stopReason: "end_turn",
      });
      return;
    }

    if (/table/i.test(promptText)) {
      notify("session/update", {
        sessionId: currentSessionId || "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "| Carpeta | Archivos | Qué contiene |\n",
          },
        },
      });
      notify("session/update", {
        sessionId: currentSessionId || "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "|---|---:|---|\n| tmux/ | 425 | Configs, scripts y plugins |\n| nvim/ | 30 | Configuración de Neovim |",
          },
        },
      });

      respond(message.id, {
        stopReason: "end_turn",
      });
      return;
    }

    if (/usage/i.test(promptText)) {
      notify("session/update", {
        sessionId: currentSessionId || "fake-session",
        update: {
          sessionUpdate: "usage_update",
          used: 45000,
          size: 200000,
          cost: { amount: 0.12, currency: "USD" },
        },
      });
      respond(message.id, { stopReason: "end_turn" });
      return;
    }

    if (/plan/i.test(promptText)) {
      notify("session/update", {
        sessionId: currentSessionId || "fake-session",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read config", priority: "high", status: "completed" },
            { content: "Refactor module", priority: "medium", status: "in_progress" },
            { content: "Write tests", priority: "low", status: "pending" },
          ],
        },
      });
      respond(message.id, { stopReason: "end_turn" });
      return;
    }

    if (/diff/i.test(promptText)) {
      notify("session/update", {
        sessionId: currentSessionId || "fake-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "fake-edit",
          title: "Edit sample.js",
          kind: "edit",
          status: "in_progress",
        },
      });
      notify("session/update", {
        sessionId: currentSessionId || "fake-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "fake-edit",
          status: "completed",
          content: [
            {
              type: "diff",
              path: "sample.js",
              oldText: "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n",
              newText: "const a = 1;\nconst b = 20;\nconst c = 3;\nconsole.log(a + b + c);\n",
            },
          ],
        },
      });
      respond(message.id, { stopReason: "end_turn" });
      return;
    }

    const permission = await request("session/request_permission", {
      sessionId: currentSessionId || "fake-session",
      toolCall: {
        toolCallId: "fake-tool",
        title: "Fake edit",
        kind: "edit",
      },
      options: [
        {
          optionId: "allow",
          name: "Allow",
          kind: "allow_once",
        },
        {
          optionId: "reject",
          name: "Reject",
          kind: "reject_once",
        },
      ],
    });

    respond(message.id, {
      stopReason: permission?.outcome?.outcome || "unknown",
    });
    return;
  }

  if (message.method === "session/cancel") {
    return;
  }

  if (message.method === "session/close") {
    respond(message.id, {});
    return;
  }

  if (message.method === "session/delete") {
    if (!message.params?.sessionId) {
      respondError(message.id, -32602, "session/delete requires sessionId");
      return;
    }
    respond(message.id, {});
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    respondError(message.id, -32601, `Unknown method: ${message.method}`);
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: currentModel,
      options: [
        { value: "fake-small", name: "Fake Small" },
        { value: "fake-large", name: "Fake Large" },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      category: "model",
      currentValue: currentEffort,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    {
      id: "mode",
      name: "Mode",
      currentValue: currentMode,
      options: [
        { value: "test", name: "Test" },
        { value: "plan", name: "Plan" },
        { value: "restored", name: "Restored" },
      ],
    },
  ];
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function request(method, params) {
  const id = nextId;
  nextId += 1;

  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

  return new Promise((resolve) => {
    pending.set(id, { resolve });
  });
}
