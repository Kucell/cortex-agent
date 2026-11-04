"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { Duplex } = require("node:stream");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const api = require("../../lib/governed/managed-caller-transport");
const { createInheritedTransport, createStreamTransport, listenWindowsTransport,
  openExecutorTransport, FRAME_HEADER_BYTES, MAX_FRAME_BYTES, MAX_PENDING_SENDS, MAX_PENDING_BYTES } = api;

const PRIVATE = "private-name-secret-should-never-escape";
const tick = () => new Promise(resolve => setImmediate(resolve));
function frame(value, raw = false) {
  const body = raw ? Buffer.from(value) : Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function lengthHeader(size) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(size);
  return bytes;
}
function safeError(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.stack, new RegExp(PRIVATE));
  return true;
}

class Socket extends EventEmitter {
  constructor(writable = true) {
    super();
    this.destroyed = false;
    this.writable = writable;
    this.writes = [];
    this.callbacks = [];
  }
  write(bytes, callback) {
    this.writes.push(bytes);
    this.callbacks.push(callback);
    return this.writable;
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
  }
}
function fixture(writable) {
  const socket = new Socket(writable);
  const transport = createStreamTransport(socket);
  const messages = [], errors = [], disconnects = [];
  transport.on("message", message => messages.push(message));
  transport.on("error", error => errors.push(error));
  transport.on("disconnect", () => disconnects.push(true));
  return { socket, transport, messages, errors, disconnects };
}

test("framing handles every header/body split including UTF-8 code points", () => {
  const f = fixture();
  const value = { text: "中文🙂é", type: "opaque", seq: 7 };
  const bytes = frame(value);
  for (const byte of bytes) f.socket.emit("data", Buffer.from([byte]));
  assert.deepEqual(f.messages, [value]);
  assert.equal(f.errors.length, 0);
  f.transport.close();
});

test("framing handles coalesced messages and a trailing partial frame", () => {
  const f = fixture();
  const tail = frame({ tail: true });
  const expected = Array.from({ length: 1000 }, (_, seq) => ({ seq }));
  f.socket.emit("data", Buffer.concat([...expected.map(value => frame(value)), tail.subarray(0, 6)]));
  assert.deepEqual(f.messages, expected);
  f.socket.emit("data", tail.subarray(6));
  assert.deepEqual(f.messages, [...expected, { tail: true }]);
  f.transport.close();
});

test("framing is opaque JSON, preserves key order and does not interpret IPC controls", async () => {
  const f = fixture();
  const value = { seq: 4, requestId: "unchanged", payloadDigest: "opaque", mac: "opaque", cmd: "NODE_HANDLE" };
  const sent = f.transport.send(value);
  assert.deepEqual(f.socket.writes[0], frame(value));
  f.socket.callbacks.shift()();
  await sent;
  f.socket.emit("data", f.socket.writes[0]);
  assert.deepEqual(f.messages, [value]);
  f.transport.close();
});

test("frame limit covers a legal 1 MiB payload plus a signing envelope", () => {
  const f = fixture();
  const value = { type: "request", requestId: "r", seq: 1, payload: "x".repeat(1024 * 1024), mac: "a".repeat(64) };
  assert.ok(frame(value).length > 1024 * 1024);
  f.socket.emit("data", frame(value));
  assert.deepEqual(f.messages, [value]);
  f.transport.close();
});

test("exact maximum JSON byte length is accepted in both directions", async () => {
  const f = fixture();
  assert.equal(FRAME_HEADER_BYTES, 4);
  const value = "x".repeat(MAX_FRAME_BYTES - 2);
  const sent = f.transport.send(value);
  assert.equal(f.socket.writes[0].readUInt32BE(0), MAX_FRAME_BYTES);
  f.socket.emit("data", f.socket.writes[0]);
  assert.equal(f.messages[0], value);
  f.socket.callbacks[0]();
  await sent;
  f.transport.close();
});

for (const size of [MAX_FRAME_BYTES + 1, 0xffffffff]) {
  test(`oversized header ${size} fails before receiving or allocating its body`, () => {
    const f = fixture();
    f.socket.emit("data", lengthHeader(size));
    assert.equal(f.transport.connected, false);
    assert.equal(f.socket.destroyed, true);
    assert.equal(f.messages.length, 0);
    assert.equal(f.errors.length, 1);
    safeError(f.errors[0], "ERR_TRANSPORT_FRAME_TOO_LARGE");
    f.socket.emit("data", frame({ ignored: true }));
    assert.equal(f.messages.length, 0);
  });
}

test("outgoing limit counts UTF-8 bytes rather than JS characters", () => {
  const f = fixture();
  assert.throws(() => f.transport.send("中".repeat(Math.ceil(MAX_FRAME_BYTES / 3))),
    error => safeError(error, "ERR_TRANSPORT_FRAME_TOO_LARGE"));
  assert.equal(f.socket.writes.length, 0);
  f.transport.close();
});

const malformed = [
  ["zero length", lengthHeader(0)],
  ["invalid JSON", frame("{", true)],
  ["invalid UTF-8", frame(Buffer.from([0x22, 0xc3, 0x28, 0x22]), true)],
  ["truncated UTF-8", frame(Buffer.from([0x22, 0xf0, 0x9f]), true)],
  ["UTF-8 BOM", frame(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), true)],
];
for (const [label, bytes] of malformed) {
  test(`rejects ${label} and stops dispatching coalesced frames`, () => {
    const f = fixture();
    f.socket.emit("data", Buffer.concat([bytes, frame({ after: true })]));
    assert.equal(f.messages.length, 0);
    assert.equal(f.errors.length, 1);
    safeError(f.errors[0], "ERR_TRANSPORT_MALFORMED_FRAME");
    assert.equal(f.disconnects.length, 1);
  });
}

for (const size of [1, 3, 4, 6]) {
  test(`rejects EOF after ${size} bytes of a frame`, () => {
    const f = fixture();
    f.socket.emit("data", frame({ pending: true }).subarray(0, size));
    f.socket.emit("end");
    f.socket.emit("close");
    assert.equal(f.errors.length, 1);
    safeError(f.errors[0], "ERR_TRANSPORT_MALFORMED_FRAME");
    assert.equal(f.disconnects.length, 1);
    assert.equal(f.socket.destroyed, true);
  });
}

test("abrupt close with a partial frame fails, while complete EOF disconnects cleanly", () => {
  for (const partial of [false, true]) {
    const f = fixture();
    const bytes = frame({ done: true });
    f.socket.emit("data", partial ? bytes.subarray(0, 5) : bytes);
    f.socket.emit("close");
    assert.equal(f.errors.length, Number(partial));
    assert.equal(f.disconnects.length, 1);
    assert.equal(f.transport.connected, false);
  }
});

test("close is idempotent, connected is read-only, and pending sends reject", async () => {
  const f = fixture(false);
  const sent = f.transport.send({ pending: true });
  assert.throws(() => { f.transport.connected = true; }, TypeError);
  assert.throws(() => Object.defineProperty(f.transport, "connected", { value: true }), TypeError);
  f.transport.close();
  assert.doesNotThrow(() => f.transport.close());
  await assert.rejects(sent, error => safeError(error, "ERR_TRANSPORT_CLOSED"));
  assert.throws(() => f.transport.send({}), error => safeError(error, "ERR_TRANSPORT_CLOSED"));
  f.socket.emit("drain");
  f.socket.callbacks[0]();
  f.socket.emit("error", new Error(PRIVATE));
  assert.equal(f.disconnects.length, 1);
  assert.equal(f.errors.length, 0);
  assert.equal(f.socket.listenerCount("data"), 0);
});

test("backpressure waits for BOTH drain and callback; admitted messages stay ordered", async () => {
  const f = fixture(false);
  const expected = Array.from({ length: MAX_PENDING_SENDS }, (_, seq) => ({ seq }));
  const sends = expected.map(value => f.transport.send(value));
  assert.throws(() => f.transport.send({ overflow: true }), { code: "ERR_TRANSPORT_QUEUE_FULL" });
  assert.equal(f.socket.writes.length, 1, "only one frame may be handed to the slow socket");
  for (let i = 0; i < expected.length; i++) {
    const callback = f.socket.callbacks[i];
    const before = f.socket.writes.length;
    if (i % 2) f.socket.emit("drain"); else callback();
    assert.equal(f.socket.writes.length, before, "one completion signal is insufficient");
    if (i % 2) callback(); else f.socket.emit("drain");
  }
  await Promise.all(sends);
  assert.deepEqual(f.socket.writes, expected.map(value => frame(value)));
  f.transport.close();
});

test("pending byte bound applies independently of pending frame count", async () => {
  const f = fixture(false);
  const value = "x".repeat(MAX_FRAME_BYTES - 2);
  assert.equal(MAX_PENDING_BYTES, 2 * (MAX_FRAME_BYTES + FRAME_HEADER_BYTES));
  const sends = [f.transport.send(value), f.transport.send(value)];
  assert.throws(() => f.transport.send(null), { code: "ERR_TRANSPORT_QUEUE_FULL" });
  assert.equal(f.socket.writes.length, 1);
  f.transport.close();
  for (const sent of sends) await assert.rejects(sent, { code: "ERR_TRANSPORT_CLOSED" });
});

test("real slow Duplex consumer receives all admitted frames without unbounded writes", { timeout: 5000 }, async () => {
  const received = [];
  const socket = new Duplex({
    writableHighWaterMark: 1,
    read() {},
    write(bytes, _encoding, callback) {
      setImmediate(() => { received.push(Buffer.from(bytes)); callback(); });
    },
  });
  const transport = createStreamTransport(socket);
  try {
    const expected = Array.from({ length: MAX_PENDING_SENDS }, (_, seq) => ({ seq, text: "慢🙂" }));
    const sends = expected.map(value => transport.send(value));
    assert.ok(socket.writableLength <= frame(expected[0]).length);
    await Promise.all(sends);
    assert.deepEqual(received, expected.map(value => frame(value)));
  } finally { transport.close(); }
});

for (const mode of ["callback", "throw", "event"]) {
  test(`native write ${mode} failure is sanitized and rejects every queued send`, async () => {
    const f = fixture(false);
    if (mode === "throw") f.socket.write = () => { throw new Error(PRIVATE); };
    const sent = f.transport.send({ first: true });
    const second = f.transport.connected ? f.transport.send({ second: true }) : null;
    if (mode === "callback") f.socket.callbacks[0](new Error(PRIVATE));
    if (mode === "event") f.socket.emit("error", new Error(PRIVATE));
    await assert.rejects(sent, error => safeError(error, "ERR_TRANSPORT_IO_FAILED"));
    if (second) await assert.rejects(second, error => safeError(error, "ERR_TRANSPORT_IO_FAILED"));
    assert.equal(f.errors.length, 1);
    safeError(f.errors[0], "ERR_TRANSPORT_IO_FAILED");
    assert.equal(f.disconnects.length, 1);
  });
}

test("serialization failures never leak thrown text or write partial frames", () => {
  const f = fixture();
  const circular = {}; circular.self = circular;
  for (const value of [undefined, 1n, circular, { toJSON() { throw new Error(PRIVATE); } }]) {
    assert.throws(() => f.transport.send(value), error => safeError(error, "ERR_TRANSPORT_MALFORMED_FRAME"));
  }
  assert.equal(f.socket.writes.length, 0);
  f.transport.close();
});

test("close from a message listener discards subsequent coalesced messages", () => {
  const f = fixture();
  f.transport.prependListener("message", () => f.transport.close());
  f.socket.emit("data", Buffer.concat([frame({ first: true }), frame({ second: true })]));
  assert.deepEqual(f.messages, [{ first: true }]);
});

function childFixture() {
  const child = new EventEmitter();
  child.channel = new EventEmitter();
  child.connected = true;
  child.sent = [];
  child.send = (message, callback) => {
    child.sent.push(message);
    queueMicrotask(() => callback());
    return false;
  };
  child.disconnect = () => { child.connected = false; child.emit("disconnect"); };
  return child;
}

test("POSIX adapter forwards real child event semantics and preserves message objects", async () => {
  const child = childFixture();
  const transport = createInheritedTransport(child);
  const channel = child.channel;
  const send = child.send;
  const value = { untouched: Buffer.from("unchanged"), seq: 1 };
  const messages = [];
  transport.on("message", message => messages.push(message));
  child.emit("message", value);
  await transport.send(value);
  assert.equal(messages[0], value);
  assert.equal(child.sent[0], value);
  assert.equal(child.channel, channel);
  assert.equal(child.send, send, "no monkey-patching");
  let disconnected = 0;
  transport.on("disconnect", () => disconnected++);
  transport.close(); transport.close();
  assert.equal(disconnected, 1);
  assert.equal(transport.connected, false);
  assert.equal(child.listenerCount("message"), 0);
  assert.throws(() => transport.send(value), { code: "ERR_TRANSPORT_CLOSED" });
  child.emit("close");
  assert.equal(channel.listenerCount("error"), 0);
});

test("POSIX child/channel errors and send callback errors use fixed codes", async () => {
  for (const source of ["child", "channel", "callback", "throw", "disconnect", "exit"]) {
    const child = childFixture();
    let callback;
    child.send = (_message, done) => { callback = done; return true; };
    const transport = createInheritedTransport(child);
    const errors = [];
    transport.on("error", error => errors.push(error));
    if (source === "throw") child.send = () => { throw new Error(PRIVATE); };
    const sent = transport.send({});
    if (source === "child") child.emit("error", new Error(PRIVATE));
    if (source === "channel") child.channel.emit("error", new Error(PRIVATE));
    if (source === "callback") callback(new Error(PRIVATE));
    if (source === "disconnect" || source === "exit") child.emit(source);
    const code = source === "disconnect" || source === "exit" ? "ERR_TRANSPORT_CLOSED" : "ERR_TRANSPORT_IO_FAILED";
    await assert.rejects(sent, error => safeError(error, code));
    for (const error of errors) safeError(error, "ERR_TRANSPORT_IO_FAILED");
    assert.equal(transport.connected, false);
    child.emit("close");
  }
});

// Model only the listener lifecycle in isolation. These tests do NOT attest
// Windows/libuv pipe behavior, peer identity, holder sets or kernel exclusivity.
function windowsModel() {
  const servers = [], sockets = [], randomSizes = [];
  const fakeNet = {
    createServer(connection) {
      const server = new EventEmitter();
      server.accept = connection;
      server.closeCount = 0;
      server.close = () => { server.closeCount++; };
      server.listen = (name, callback) => {
        server.name = name;
        queueMicrotask(callback);
      };
      servers.push(server);
      return server;
    },
    connect(name) { const socket = new Socket(); socket.name = name; sockets.push(socket); return socket; },
  };
  const filename = path.resolve(__dirname, "../../lib/governed/managed-caller-transport.js");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, Buffer, process: { platform: "win32" }, setTimeout, clearTimeout, queueMicrotask, setImmediate,
    require(name) {
      if (name === "node:net") return fakeNet;
      if (name === "node:crypto") return { randomBytes(size) {
        randomSizes.push(size);
        return require("node:crypto").randomBytes(size);
      } };
      return require(name);
    },
  }, { filename });
  return { api: module.exports, servers, sockets, randomSizes };
}

test("listener model: independent 256-bit names; first accept stops listen immediately", async () => {
  const m = windowsModel();
  const names = [];
  for (let i = 0; i < 2; i++) {
    const socket = new Socket();
    const ready = m.api.listenWindowsTransport({ onListening({ pipeName }) {
      names.push(pipeName);
      m.servers[i].accept(socket);
      assert.equal(m.servers[i].closeCount, 1, "stop acceptance before resolving");
    } });
    const transport = await ready;
    assert.equal(transport.connected, true);
    transport.close();
    assert.equal(socket.destroyed, true);
  }
  assert.deepEqual(m.randomSizes, [32, 32]);
  assert.notEqual(names[0], names[1]);
  for (const name of names) assert.match(name, /^\\\\\.\\pipe\\cortex-managed-caller-v1-[a-f0-9]{64}$/);
});

test("listener model: queued extra connection destroys both sockets and invalidates bind", async () => {
  const m = windowsModel();
  const first = new Socket(), extra = new Socket();
  const ready = m.api.listenWindowsTransport({ onListening() { m.servers[0].accept(first); } });
  const transport = await ready;
  const errors = [], disconnected = [];
  transport.on("error", error => errors.push(error));
  transport.on("disconnect", () => disconnected.push(true));
  m.servers[0].accept(extra);
  assert.equal(first.destroyed, true);
  assert.equal(extra.destroyed, true);
  assert.equal(transport.connected, false);
  safeError(errors[0], "ERR_TRANSPORT_EXTRA_CONNECTION");
  assert.equal(disconnected.length, 1);
  assert.throws(() => transport.send({}), { code: "ERR_TRANSPORT_CLOSED" });
  const late = new Socket();
  m.servers[0].accept(late);
  assert.equal(late.destroyed, true);
});

test("listener model: pre-return extra connection cannot produce a connected transport", async () => {
  const m = windowsModel();
  const ready = m.api.listenWindowsTransport({ onListening() {
    m.servers[0].accept(new Socket());
    m.servers[0].accept(new Socket());
  } });
  await assert.rejects(ready, error => safeError(error, "ERR_TRANSPORT_EXTRA_CONNECTION"));
});

test("listener model: accepted bytes stay paused until readiness observers attach", async () => {
  const m = windowsModel();
  const socket = new Socket();
  socket.resume = () => { socket.paused = false; socket.emit("data", frame({ early: true })); };
  const transport = await m.api.listenWindowsTransport({ onListening() { m.servers[0].accept(socket); } });
  const messages = [];
  transport.on("message", message => messages.push(message));
  assert.equal(socket.paused, true);
  await tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].early, true);
  transport.close();
});

test("listener model: partial EOF before readiness rejects establishment and releases socket", async () => {
  const m = windowsModel();
  const socket = new Socket();
  const ready = m.api.listenWindowsTransport({ onListening() {
    m.servers[0].accept(socket);
    socket.emit("data", Buffer.from([0]));
    socket.emit("end");
  } });
  await assert.rejects(ready, { code: "ERR_TRANSPORT_MALFORMED_FRAME" });
  assert.equal(socket.destroyed, true);
});

test("listener model: failure after accept closes the accepted session, including late server errors", async () => {
  for (const source of ["callback", "error"]) {
    const m = windowsModel();
    const socket = new Socket();
    let rejectBootstrap;
    const ready = m.api.listenWindowsTransport({ onListening() {
      m.servers[0].accept(socket);
      return new Promise((_resolve, reject) => { rejectBootstrap = reject; });
    } });
    const transport = await ready;
    const errors = [];
    transport.on("error", error => errors.push(error));
    if (source === "callback") rejectBootstrap(new Error(PRIVATE));
    else m.servers[0].emit("error", new Error(PRIVATE));
    await tick();
    assert.equal(transport.connected, false);
    assert.equal(socket.destroyed, true);
    safeError(errors[0], "ERR_TRANSPORT_LISTEN_FAILED");
    m.servers[0].emit("error", new Error(PRIVATE));
    assert.equal(errors.length, 1);
  }
});

test("establishment model: already aborted signals start neither listen nor connect", async () => {
  const m = windowsModel();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(m.api.listenWindowsTransport({ signal: controller.signal, onListening() { assert.fail(); } }),
    { code: "ERR_TRANSPORT_CLOSED" });
  await assert.rejects(m.api.openExecutorTransport({ signal: controller.signal,
    pipeName: "\\\\.\\pipe\\cortex-managed-caller-v1-" + "a".repeat(64) }), { code: "ERR_TRANSPORT_CLOSED" });
  assert.equal(m.servers.length, 0);
  assert.equal(m.sockets.length, 0);
});

test("establishment model: invalid options fail with fixed codes before allocating resources", async () => {
  const m = windowsModel();
  for (const options of [null, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 0x80000000 },
    { signal: {} }]) {
    for (const open of [m.api.listenWindowsTransport, m.api.openExecutorTransport]) {
      await assert.rejects(open(options), error => safeError(error, "ERR_TRANSPORT_INVALID_OPTIONS"));
    }
  }
  assert.equal(m.servers.length, 0);
  assert.equal(m.sockets.length, 0);
});

test("listener model: listen errors, callback rejection, timeout and cancellation clean up", async () => {
  for (const source of ["error", "callback", "timeout", "cancel", "abort"]) {
    const m = windowsModel();
    const controller = new AbortController();
    const ready = m.api.listenWindowsTransport({ timeoutMs: 10, signal: controller.signal, onListening({ close }) {
      if (source === "error") m.servers[0].emit("error", new Error(PRIVATE));
      if (source === "callback") return Promise.reject(new Error(PRIVATE));
      if (source === "cancel") { close(); close(); }
      if (source === "abort") controller.abort();
    } });
    const code = source === "timeout" ? "ERR_TRANSPORT_TIMEOUT" :
      source === "cancel" || source === "abort" ? "ERR_TRANSPORT_CLOSED" : "ERR_TRANSPORT_LISTEN_FAILED";
    await assert.rejects(ready, error => safeError(error, code));
    assert.ok(m.servers[0].closeCount > 0);
    const late = new Socket(); m.servers[0].accept(late);
    assert.equal(late.destroyed, true);
  }
});

test("executor model: one connection attempt, no retry/reconnect, sanitized failure", async () => {
  for (const source of ["error", "close", "timeout", "abort", "connected"]) {
    const m = windowsModel();
    const controller = new AbortController();
    const ready = m.api.openExecutorTransport({ pipeName: "\\\\.\\pipe\\cortex-managed-caller-v1-" + "a".repeat(64),
      timeoutMs: 10, signal: controller.signal });
    const socket = m.sockets[0];
    if (source === "error") socket.emit("error", new Error(PRIVATE));
    if (source === "close") socket.destroy();
    if (source === "abort") controller.abort();
    if (source === "connected") {
      socket.emit("connect");
      const transport = await ready;
      transport.close();
      socket.emit("error", new Error(PRIVATE));
    } else {
      const code = source === "timeout" ? "ERR_TRANSPORT_TIMEOUT" :
        source === "abort" ? "ERR_TRANSPORT_CLOSED" : "ERR_TRANSPORT_CONNECT_FAILED";
      await assert.rejects(ready, error => safeError(error, code));
      assert.equal(socket.destroyed, true);
    }
    await tick();
    assert.equal(m.sockets.length, 1);
  }
});

test("executor model rejects names outside the private local namespace", async () => {
  const m = windowsModel();
  for (const pipeName of [undefined, PRIVATE, "\\\\remote\\pipe\\cortex-managed-caller-v1-" + "a".repeat(64),
    "\\\\.\\pipe\\cortex-managed-caller-v1-" + "a".repeat(63)]) {
    await assert.rejects(m.api.openExecutorTransport({ pipeName }),
      error => safeError(error, "ERR_TRANSPORT_CONNECT_FAILED"));
  }
  assert.equal(m.sockets.length, 0);
});

test("Windows-only entrypoints refuse non-Windows platforms", {
  skip: process.platform === "win32" ? "Non-Windows refusal only" : false,
}, async () => {
  await assert.rejects(listenWindowsTransport({}), { code: "ERR_TRANSPORT_UNSUPPORTED_PLATFORM" });
  await assert.rejects(openExecutorTransport({}), { code: "ERR_TRANSPORT_UNSUPPORTED_PLATFORM" });
});

test("Windows native pipe: first connection works and later connections cannot replace it", {
  skip: process.platform !== "win32" ? "Requires Windows named pipes/libuv; lifecycle models are not Windows evidence" : false,
  timeout: 10000,
}, async () => {
  let clientReady, pipeName;
  const serverReady = listenWindowsTransport({ onListening(info) {
    pipeName = info.pipeName; // private test memory only
    clientReady = openExecutorTransport({ pipeName });
  } });
  const server = await serverReady;
  const client = await clientReady;
  let extra;
  try {
    const received = once(server, "message");
    await client.send({ roundTrip: "中文🙂" });
    assert.deepEqual((await received)[0], { roundTrip: "中文🙂" });
    const reply = once(client, "message");
    await server.send({ answer: true });
    assert.deepEqual((await reply)[0], { answer: true });
    // A connection already queued by libuv MUST destroy the bind. Otherwise
    // closing the listener should make the next connect fail at the OS layer.
    const invalidated = new Promise(resolve => server.once("error", error => resolve(error.code)));
    const outcome = await new Promise(resolve => {
      extra = net.connect(pipeName);
      extra.once("error", () => resolve("refused"));
      extra.once("connect", () => resolve("connected"));
    });
    if (outcome === "connected") {
      assert.equal(await invalidated, "ERR_TRANSPORT_EXTRA_CONNECTION");
      assert.equal(server.connected, false);
    } else assert.equal(server.connected, true);
  } finally { if (extra) extra.destroy(); client.close(); server.close(); }
});
