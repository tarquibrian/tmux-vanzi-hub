#!/usr/bin/env node
// Unit tests for the hub RPC client's failure handling: a dying daemon closes
// the socket, which must reject in-flight calls instead of leaving the popup
// (or a tmux action) hanging forever. Calls made after close reject at once.
import assert from "node:assert/strict";
import { HubRpcClient } from "../lib/rpc.mjs";

function makeClient() {
  const sent = [];
  const conn = { send: (message) => sent.push(message), close: () => {} };
  return { client: new HubRpcClient(conn), sent };
}

// A matching response resolves the call and clears its timeout.
{
  const { client, sent } = makeClient();
  const pending = client.call("ping", { x: 1 });
  assert.equal(sent[0].method, "ping");
  client.handleMessage({ type: "response", id: sent[0].id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
}

// An error response rejects the call.
{
  const { client, sent } = makeClient();
  const pending = client.call("boom");
  client.handleMessage({ type: "response", id: sent[0].id, error: { message: "nope" } });
  await assert.rejects(pending, /nope/);
}

// A socket close rejects every in-flight call (no hang).
{
  const { client } = makeClient();
  const a = client.call("a");
  const b = client.call("b");
  client.handleClose();
  await assert.rejects(a, /connection closed/);
  await assert.rejects(b, /connection closed/);
}

// After close, new calls reject immediately without sending a request.
{
  const { client, sent } = makeClient();
  client.handleClose();
  await assert.rejects(client.call("late"), /connection is closed/);
  assert.equal(sent.length, 0, "no request is sent on a closed client");
}

console.log("rpc test passed");
