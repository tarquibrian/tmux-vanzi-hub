// JSON-RPC line framing, the ACP peer, and the hub client connection.
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
  SOCKET_PATH,
} from "./core.mjs";

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


export {
  linePrefixJson,
  canConnectToSocket,
  LineConnection,
  AcpPeer,
  HubRpcClient,
  connectHub,
};
