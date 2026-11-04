"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { TextDecoder } = require("node:util");

const FRAME_HEADER_BYTES = 4;
// This bounds the entire JSON envelope, not just its payload. Current inputs:
// permit-bridge-endpoint.MAX_BODY_BYTES = 64 KiB; isolated-contract admits
// 128 KiB messages; commands/permit-managed-cli accepts 1 MiB input files.
// dispatch/strict-domain-entry also allows 1 Mi UTF-16 JSON code units (up to
// 3 MiB UTF-8). 4 MiB leaves room for the session/HMAC envelope around those
// inputs. The existing session/signing modules impose no universal maximum;
// this is a NEW Windows wire ceiling, not a claim that legacy IPC was bounded.
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_SENDS = 64;
const MAX_PENDING_BYTES = 2 * (FRAME_HEADER_BYTES + MAX_FRAME_BYTES);
const DEFAULT_TIMEOUT_MS = 5000;
const PIPE_PREFIX = "\\\\.\\pipe\\cortex-managed-caller-v1-";

// One private fd4 read per executor, including a cached rejection. EOF is
// mandatory: resolving at the first newline would accept trailing records.
const bootstraps = new WeakMap();
const executorTransports = new WeakMap();
const transportBindings = new WeakMap();
const MAX_BOOTSTRAP_BYTES = 1024;
function readExecutorBootstrap(child) {
  if (!child || (typeof child !== "object" && typeof child !== "function")) {
    return Promise.reject(failure("ERR_BOOTSTRAP_INVALID"));
  }
  if (bootstraps.has(child)) return bootstraps.get(child);
  const promise = new Promise((resolve, reject) => {
    let stream, bytes = 0, chunks = [], ended = false, settled = false;
    const timer = setTimeout(() => finish("ERR_BOOTSTRAP_TIMEOUT"), 120000);
    function finish(code, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks = [];
      if (!stream || stream.closed) { reject(failure(code || "ERR_BOOTSTRAP_TRUNCATED")); return; }
      // Resolve only after autoClose has closed the inherited descriptor.
      stream.once("close", () => code ? reject(failure(code)) : resolve(value));
      stream.destroy();
    }
    try {
      stream = child.stdio && child.stdio[4] || fs.createReadStream(null, { fd: 4, autoClose: true });
      stream.on("error", () => finish("ERR_BOOTSTRAP_INVALID"));
      stream.on("close", () => {
        if (!ended && !settled) {
          settled = true; clearTimeout(timer); chunks = [];
          reject(failure("ERR_BOOTSTRAP_TRUNCATED"));
        }
      });
      stream.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BOOTSTRAP_BYTES) { finish("ERR_BOOTSTRAP_TOO_LARGE"); return; }
        chunks.push(Buffer.from(chunk));
      });
      stream.once("end", () => {
        ended = true;
        if (settled) return;
        let value;
        try {
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          if (!raw.endsWith("\n")) { finish("ERR_BOOTSTRAP_TRUNCATED"); return; }
          if (raw.slice(0, -1).includes("\n") || raw.includes("\r")) throw new Error();
          // Four scalar fields only. JSON.parse alone silently accepts a
          // repeated known key; count member tokens before accepting it.
          if ((raw.match(/"(?:\\.|[^"\\])*"\s*:/g) || []).length !== 4) throw new Error();
          value = JSON.parse(raw);
          if (!value || Array.isArray(value) ||
              Object.keys(value).sort().join(",") !== "pipeName,secret,transport,version" ||
              value.version !== 1 || value.transport !== "windows-named-pipe" ||
              typeof value.secret !== "string" || !/^[a-f0-9]{64}$/.test(value.secret) ||
              typeof value.pipeName !== "string" || !value.pipeName.startsWith(PIPE_PREFIX) ||
              !/^[a-f0-9]{64}$/.test(value.pipeName.slice(PIPE_PREFIX.length))) throw new Error();
        } catch (_) { finish("ERR_BOOTSTRAP_INVALID"); return; }
        finish(null, Object.freeze(value));
      });
    } catch (_) { finish("ERR_BOOTSTRAP_INVALID"); }
  });
  promise.catch(() => {});
  bootstraps.set(child, promise);
  return promise;
}

// The full name never appears on the EventEmitter or in public identity.
function readTransportBinding(transport) { return transportBindings.get(transport) || null; }

function failure(code) {
  // Never retain a native error/cause: listen/connect errors include the name.
  return Object.assign(new Error(code), { code });
}

function events(isConnected) {
  const transport = new EventEmitter();
  Object.defineProperty(transport, "connected", { enumerable: true, get: isConnected });
  // A failure can arrive before the caller receives the resolved transport.
  transport.on("error", () => {});
  return transport;
}

/**
 * Thin adapter for ChildProcess (or process in an executor). Node delivers
 * messages on child, NOT on child.channel. No IPC serialization is changed.
 * @param {object} child With channel, send(message, callback), disconnect().
 * @returns {EventEmitter} send(message): Promise<void>; close(): void.
 * send throws synchronously when closed; asynchronous failures reject safely.
 */
function createInheritedTransport(child) {
  if (!child || !child.channel || typeof child.send !== "function") {
    throw failure("ERR_TRANSPORT_CLOSED");
  }
  const channel = child.channel;
  let closed = false;
  const pending = new Set();
  const transport = events(() => !closed && child.connected !== false);
  function finish(code) {
    if (closed) return;
    closed = true;
    child.removeListener("message", onMessage);
    child.removeListener("disconnect", onDisconnect);
    child.removeListener("exit", onDisconnect);
    for (const reject of pending) reject(failure(code || "ERR_TRANSPORT_CLOSED"));
    pending.clear();
    try { if (child.connected !== false) child.disconnect(); } catch (_) { /* already closed */ }
    // Keep the error guards until real process close, including late IPC errors.
    if (code) transport.emit("error", failure(code));
    transport.emit("disconnect");
  }
  const onMessage = message => { if (!closed) transport.emit("message", message); };
  const onDisconnect = () => finish();
  const onError = () => finish("ERR_TRANSPORT_IO_FAILED");
  child.on("message", onMessage);
  child.on("disconnect", onDisconnect);
  child.on("exit", onDisconnect);
  child.on("error", onError);
  channel.on("error", onError);
  child.once("close", () => {
    finish();
    child.removeListener("error", onError);
    channel.removeListener("error", onError);
  });
  transport.send = message => {
    if (!transport.connected) throw failure("ERR_TRANSPORT_CLOSED");
    const promise = new Promise((resolve, reject) => {
      pending.add(reject);
      try {
        // A false return is Node IPC backpressure, NOT failure; its callback
        // still reports completion. There is no child 'drain' event to await.
        child.send(message, error => {
          if (!pending.delete(reject)) return;
          if (error) {
            reject(failure("ERR_TRANSPORT_IO_FAILED"));
            finish("ERR_TRANSPORT_IO_FAILED");
          } else resolve();
        });
      } catch (_) {
        pending.delete(reject);
        reject(failure("ERR_TRANSPORT_IO_FAILED"));
        finish("ERR_TRANSPORT_IO_FAILED");
      }
    });
    // Callers may use send like the old fire-and-forget IPC API. The original
    // promise remains rejectable/awaitable without an unhandled rejection gap.
    promise.catch(() => {});
    return promise;
  };
  transport.close = () => finish();
  return transport;
}

function framedTransport(socket, onClose = () => {}) {
  let closed = false;
  const transport = events(() => !closed && !socket.destroyed);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  let headerUsed = 0;
  let body = null;
  let bodyUsed = 0;
  let pendingBytes = 0;
  const pending = [];
  let active = null;

  function finish(code) {
    if (closed) return;
    closed = true;
    body = null;
    for (const entry of pending) entry.reject(failure(code || "ERR_TRANSPORT_CLOSED"));
    pending.length = 0;
    pendingBytes = 0;
    active = null;
    socket.removeListener("data", onData);
    socket.removeListener("drain", onDrain);
    socket.destroy();
    onClose(code);
    if (code) transport.emit("error", failure(code));
    transport.emit("disconnect");
  }
  function completeWrite(entry) {
    if (closed || active !== entry || !entry.returned || !entry.written || !entry.drained) return;
    pending.shift();
    pendingBytes -= entry.frame.length;
    active = null;
    entry.resolve();
    pump();
  }
  function pump() {
    if (closed || active || !pending.length) return;
    const entry = active = pending[0];
    try {
      const writable = socket.write(entry.frame, error => {
        if (closed) return;
        if (error) { finish("ERR_TRANSPORT_IO_FAILED"); return; }
        entry.written = true;
        completeWrite(entry);
      });
      entry.returned = true;
      entry.drained = writable !== false;
      completeWrite(entry);
    } catch (_) { finish("ERR_TRANSPORT_IO_FAILED"); }
  }
  function onDrain() {
    if (!active) return;
    active.drained = true;
    completeWrite(active);
  }
  function onData(chunk) {
    if (closed) return;
    // Keep bytes until the complete frame exists. At most one bounded body
    // and a 4-byte header are retained; no incoming message/chunk queue.
    if (!Buffer.isBuffer(chunk)) { finish("ERR_TRANSPORT_MALFORMED_FRAME"); return; }
    let offset = 0;
    while (!closed && offset < chunk.length) {
      if (!body) {
        const size = Math.min(FRAME_HEADER_BYTES - headerUsed, chunk.length - offset);
        chunk.copy(header, headerUsed, offset, offset + size);
        headerUsed += size;
        offset += size;
        if (headerUsed < FRAME_HEADER_BYTES) continue;
        const length = header.readUInt32BE(0);
        if (!length) { finish("ERR_TRANSPORT_MALFORMED_FRAME"); return; }
        if (length > MAX_FRAME_BYTES) { finish("ERR_TRANSPORT_FRAME_TOO_LARGE"); return; }
        body = Buffer.alloc(length);
        bodyUsed = 0;
      }
      const size = Math.min(body.length - bodyUsed, chunk.length - offset);
      chunk.copy(body, bodyUsed, offset, offset + size);
      bodyUsed += size;
      offset += size;
      if (bodyUsed !== body.length) continue;
      let message;
      try { message = JSON.parse(decoder.decode(body)); }
      catch (_) { finish("ERR_TRANSPORT_MALFORMED_FRAME"); return; }
      body = null;
      bodyUsed = 0;
      headerUsed = 0;
      transport.emit("message", message);
    }
  }
  const onEof = () => finish(headerUsed || body ? "ERR_TRANSPORT_MALFORMED_FRAME" : undefined);
  socket.on("data", onData);
  socket.on("drain", onDrain);
  socket.on("end", onEof);
  socket.on("close", onEof);
  socket.on("error", () => finish("ERR_TRANSPORT_IO_FAILED"));

  transport.send = message => {
    if (!transport.connected) throw failure("ERR_TRANSPORT_CLOSED");
    if (pending.length >= MAX_PENDING_SENDS) throw failure("ERR_TRANSPORT_QUEUE_FULL");
    let json;
    try { json = JSON.stringify(message); }
    catch (_) { throw failure("ERR_TRANSPORT_MALFORMED_FRAME"); }
    if (typeof json !== "string") throw failure("ERR_TRANSPORT_MALFORMED_FRAME");
    const size = Buffer.byteLength(json, "utf8");
    if (size > MAX_FRAME_BYTES) throw failure("ERR_TRANSPORT_FRAME_TOO_LARGE");
    // Recheck after serialization: a toJSON hook can close or reenter send.
    if (!transport.connected) throw failure("ERR_TRANSPORT_CLOSED");
    if (pending.length >= MAX_PENDING_SENDS || pendingBytes + size + FRAME_HEADER_BYTES > MAX_PENDING_BYTES) {
      throw failure("ERR_TRANSPORT_QUEUE_FULL");
    }
    const frame = Buffer.alloc(FRAME_HEADER_BYTES + size);
    frame.writeUInt32BE(size, 0);
    frame.write(json, FRAME_HEADER_BYTES, size, "utf8");
    const promise = new Promise((resolve, reject) => {
      pending.push({ frame, resolve, reject, returned: false, written: false, drained: false });
      pendingBytes += frame.length;
    });
    promise.catch(() => {});
    pump();
    return promise;
  };
  transport.close = () => finish();
  return { transport, fail: finish };
}

/** Platform-independent byte-stream adapter, also usable with in-memory Duplexes. */
function createStreamTransport(socket) {
  return framedTransport(socket).transport;
}

function timeout(options) {
  if (!options || typeof options !== "object") throw failure("ERR_TRANSPORT_INVALID_OPTIONS");
  const value = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
    throw failure("ERR_TRANSPORT_INVALID_OPTIONS");
  }
  if (options.signal && (typeof options.signal.addEventListener !== "function" ||
      typeof options.signal.removeEventListener !== "function")) {
    throw failure("ERR_TRANSPORT_INVALID_OPTIONS");
  }
  return value;
}

/**
 * Windows coordinator. Resolves on the first accepted connection, not listen.
 * onListening({pipeName, close}) runs after listen succeeds so the coordinator
 * can privately bootstrap its child without a circular wait. Never log it.
 * signal/timeoutMs bound establishment; close() cancels it. A late extra
 * connection invalidates even an already resolved transport, never replaces it.
 * This is byte transport only: connected does NOT attest peer pid/holders.
 * @returns {Promise<EventEmitter>}
 */
async function listenWindowsTransport(options = {}) {
  if (process.platform !== "win32") throw failure("ERR_TRANSPORT_UNSUPPORTED_PLATFORM");
  const timeoutMs = timeout(options);
  if (typeof options.onListening !== "function") throw failure("ERR_TRANSPORT_INVALID_OPTIONS");
  return new Promise((resolve, reject) => {
    let server;
    let accepted = null;
    let stream = null;
    let ended = false;
    const signal = options.signal;
    const stopListener = () => {
      try { if (server) server.close(); } catch (_) { /* not listening/already stopped */ }
    };
    const clear = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const fail = code => {
      if (ended) return;
      ended = true;
      reject(failure(code));
      clear();
      stopListener();
      if (stream) stream.fail(code);
      else if (accepted) accepted.destroy();
    };
    const onAbort = () => fail("ERR_TRANSPORT_CLOSED");
    const timer = setTimeout(() => fail("ERR_TRANSPORT_TIMEOUT"), timeoutMs);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
    }
    try {
      const pipeName = PIPE_PREFIX + crypto.randomBytes(32).toString("hex");
      server = net.createServer(socket => {
        if (ended || accepted) {
          socket.on("error", () => {});
          socket.destroy();
          if (!ended) fail("ERR_TRANSPORT_EXTRA_CONNECTION");
          return;
        }
        accepted = socket;
        socket.pause();
        // Do not await close's callback: it waits for the accepted socket.
        stopListener();
        if (ended) { socket.destroy(); return; }
        stream = framedTransport(socket, code => {
          ended = true;
          clear();
          stopListener();
          // Has no effect after readiness, but covers EOF/close before handoff.
          reject(failure(code || "ERR_TRANSPORT_CLOSED"));
        });
        clear();
        queueMicrotask(() => {
          if (ended) return;
          transportBindings.set(stream.transport, Object.freeze({ pipeName }));
          resolve(stream.transport);
          // Promise observers attach handlers before any buffered data is read.
          setImmediate(() => { if (!ended) socket.resume(); });
        });
      });
      server.on("error", () => fail("ERR_TRANSPORT_LISTEN_FAILED"));
      server.listen(pipeName, () => {
        if (ended) { stopListener(); return; }
        try {
          Promise.resolve(options.onListening(Object.freeze({ pipeName, close: onAbort })))
            .catch(() => fail("ERR_TRANSPORT_LISTEN_FAILED"));
        } catch (_) { fail("ERR_TRANSPORT_LISTEN_FAILED"); }
      });
    } catch (_) { fail("ERR_TRANSPORT_LISTEN_FAILED"); }
  });
}

/**
 * Windows executor. options.pipeName comes ONLY from private bootstrap.
 * Makes one connection attempt. Rejects on failure; the executor entrypoint
 * owns process exit (this library never terminates its caller).
 * @returns {Promise<EventEmitter>}
 */
function openExecutorTransport(options = {}) {
  if (options && (options === process || (options.stdio && !options.pipeName))) {
    if (!executorTransports.has(options)) {
      const promise = readExecutorBootstrap(options).then(bootstrap => connectExecutorTransport({ pipeName: bootstrap.pipeName }));
      promise.catch(() => {});
      executorTransports.set(options, promise);
    }
    return executorTransports.get(options);
  }
  return connectExecutorTransport(options);
}

async function connectExecutorTransport(options = {}) {
  if (process.platform !== "win32") throw failure("ERR_TRANSPORT_UNSUPPORTED_PLATFORM");
  const timeoutMs = timeout(options);
  if (typeof options.pipeName !== "string" || !options.pipeName.startsWith(PIPE_PREFIX) ||
      !/^[a-f0-9]{64}$/.test(options.pipeName.slice(PIPE_PREFIX.length))) {
    throw failure("ERR_TRANSPORT_CONNECT_FAILED");
  }
  return new Promise((resolve, reject) => {
    let socket;
    let ended = false;
    const signal = options.signal;
    const clear = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const fail = code => {
      if (ended) return;
      ended = true;
      clear();
      if (socket) socket.destroy();
      reject(failure(code));
    };
    const onAbort = () => fail("ERR_TRANSPORT_CLOSED");
    const timer = setTimeout(() => fail("ERR_TRANSPORT_TIMEOUT"), timeoutMs);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
    }
    try {
      socket = net.connect(options.pipeName);
      socket.on("error", () => fail("ERR_TRANSPORT_CONNECT_FAILED"));
      socket.once("close", () => fail("ERR_TRANSPORT_CONNECT_FAILED"));
      socket.once("connect", () => {
        if (ended) return;
        ended = true;
        clear();
        resolve(createStreamTransport(socket));
      });
    } catch (_) { fail("ERR_TRANSPORT_CONNECT_FAILED"); }
  });
}

module.exports = {
  readExecutorBootstrap,
  readTransportBinding,
  MAX_BOOTSTRAP_BYTES,
  createInheritedTransport,
  createStreamTransport,
  listenWindowsTransport,
  openExecutorTransport,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_PENDING_SENDS,
  MAX_PENDING_BYTES,
};
