"use strict";

// tests/mcp/jsonrpc.test.js — JSON-RPC 2.0 over stdio frame tests (P-002 MS-003).

const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { readFrames, sendResult, sendError } = require("../../lib/mcp/jsonrpc");

async function collect(stream) {
  const frames = [];
  for await (const frame of readFrames(stream)) frames.push(frame);
  return frames;
}

function feed(stream, chunks) {
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
}

// ─── sendResult / sendError ─────────────────────────────────────────────────

test("sendResult writes a JSON-RPC 2.0 success frame", () => {
  const out = new PassThrough();
  let data = "";
  out.on("data", (c) => (data += c));
  sendResult(out, 42, { ok: true });
  assert.equal(data, '{"jsonrpc":"2.0","id":42,"result":{"ok":true}}\n');
});

test("sendError writes a JSON-RPC error frame with code and message", () => {
  const out = new PassThrough();
  let data = "";
  out.on("data", (c) => (data += c));
  sendError(out, "abc", -32601, "Method not found");
  assert.deepEqual(JSON.parse(data.trim()), {
    jsonrpc: "2.0",
    id: "abc",
    error: { code: -32601, message: "Method not found" },
  });
});

test("sendError includes structured data when provided", () => {
  const out = new PassThrough();
  let data = "";
  out.on("data", (c) => (data += c));
  sendError(out, 1, -32602, "Bad params", { reason: "invalid_json_rpc_request" });
  const parsed = JSON.parse(data.trim());
  assert.equal(parsed.error.data.reason, "invalid_json_rpc_request");
});

test("sendResult then readFrames round-trips the frame", async () => {
  const duplex = new PassThrough();
  sendResult(duplex, 7, { tools: [] });
  duplex.end();
  const frames = await collect(duplex);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].jsonrpc, "2.0");
  assert.equal(frames[0].id, 7);
  assert.deepEqual(frames[0].result, { tools: [] });
});

// ─── readFrames ──────────────────────────────────────────────────────────────

test("readFrames yields one frame per newline-delimited line", async () => {
  const inStream = new PassThrough();
  feed(inStream, [
    '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n',
    '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}\n',
  ]);
  const frames = await collect(inStream);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].method, "tools/list");
  assert.equal(frames[1].method, "ping");
});

test("readFrames skips empty lines", async () => {
  const inStream = new PassThrough();
  feed(inStream, ["\n", '{"jsonrpc":"2.0","id":1,"method":"ping"}\n', "\n\n"]);
  const frames = await collect(inStream);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, "ping");
});

test("readFrames skips malformed JSON frames without throwing", async () => {
  const inStream = new PassThrough();
  feed(inStream, ["{not json}\n", '{"jsonrpc":"2.0","id":1,"method":"ping"}\n']);
  const frames = await collect(inStream);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 1);
});

test("readFrames handles multiple frames inside a single chunk", async () => {
  const inStream = new PassThrough();
  feed(inStream, [
    '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n',
  ]);
  const frames = await collect(inStream);
  assert.deepEqual(frames.map((f) => f.id), [1, 2, 3]);
});

test("readFrames handles a frame split across chunks", async () => {
  const inStream = new PassThrough();
  inStream.write('{"jsonrpc":"2.0","id":1,"met');
  inStream.write('hod":"ping","params":{}}\n');
  inStream.end();
  const frames = await collect(inStream);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, "ping");
});

test("readFrames handles a frame with a trailing partial line before end", async () => {
  const inStream = new PassThrough();
  inStream.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  inStream.write('{"jsonrpc":"2.0","id":2,"metho'); // no newline before end
  inStream.end();
  const frames = await collect(inStream);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 1);
});

test("readFrames completes when the stream ends", async () => {
  const inStream = new PassThrough();
  inStream.end();
  const frames = await collect(inStream);
  assert.deepEqual(frames, []);
});
