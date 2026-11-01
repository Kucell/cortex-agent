"use strict";

// Stage A transport candidate: one opaque frame (u32 BE length + bytes) per
// direction, mandatory EOF before receive delivery. No JSON, codec, MAC,
// identity, write authority, listener, retry, worker launch or production hook.
// Requires Node 24's PUBLIC user-buffer onread API, not a post-'data' size cap.
// If an untrusted worker can ALSO reach Node IPC, this channel does NOT protect
// the coordinator from that independent JSON parser attack surface.
const net = require("node:net");
const { ByteBudget, BoundedChannelError, error, integer, reserve } = require("./permit-witness-bounded-budget");
const now = () => process.hrtime.bigint();
function connectBounded({ port, budget, deadlineNs, maxFrameBytes = 65536, readChunkBytes = 4096 } = {}) {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw error("RUNTIME_UNVERIFIED");
  integer(port, 65535); integer(maxFrameBytes, 1048576); integer(readChunkBytes, 16384);
  if (typeof deadlineNs !== "bigint" || deadlineNs > now() + 60000000000n) throw new TypeError("absolute monotonic deadline <= 60s required");
  if (deadlineNs <= now()) throw error("DEADLINE");
  // Reserve both directions BEFORE creating buffers or connecting. Raw libuv
  // input uses exactly slab.length. No advertised length chooses a read size.
  const lease = reserve(budget, 2 * maxFrameBytes + readChunkBytes + 8);
  let initialCredit;
  try { initialCredit = lease.readCapacity(readChunkBytes); } catch (failure) { lease.closed(0); throw failure; }
  const slab = Buffer.alloc(readChunkBytes), header = Buffer.alloc(4);
  let supplied = slab.subarray(0, initialCredit);
  let socket, timer, body = null, used = 0, headerUsed = 0, ended = false, state = "reading", sendUsed = false, sendComplete = false;
  let resolveResult, rejectResult, resolveClosed, sendReject;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const stats = { receivedBytes: 0, maxReadBytes: 0, bodyAllocations: 0, allocatedBodyBytes: 0,
    readBufferBytes: slab.length, backpressureEvents: 0, writeQueuedPeak: 0, sentBytes: 0 };
  const snapshot = () => Object.freeze({ state, receiveEnded: ended, sendComplete, ...stats, budget: budget.snapshot(), authenticated: false });
  function fail(code) {
    if (state !== "reading") return;
    state = code;
    clearTimeout(timer);
    const failure = error(code);
    rejectResult(failure);
    if (sendReject) sendReject(failure);
    if (socket) socket.destroy();
  }
  function expired() {
    if (now() < deadlineNs) return false;
    fail("DEADLINE"); return true;
  }
  function complete() {
    // Peer EOF closes only its write direction. Keep an already-started send,
    // its deadline and its lease alive until our own write EOF has completed.
    if (state !== "reading" || !ended || (sendUsed && !sendComplete) || expired()) return;
    state = "received"; clearTimeout(timer);
    resolveResult(Object.freeze({ bytes: body, authenticated: false }));
    socket.destroy();
  }
  function readBuffer() {
    if (state !== "reading") return slab; // destroy has stopped further I/O.
    try {
      // Reserve credits BEFORE libuv can read into this view, shared across
      // concurrent channels. A peer cannot exceed the remaining total even
      // by one fixed chunk. EOF needs a spare read credit; quota exhaustion is
      // conservatively terminal, rather than a speculative uncharged read.
      supplied = slab.subarray(0, lease.readCapacity(readChunkBytes));
      return supplied;
    } catch (failure) { fail("TOTAL_RECEIVED"); return slab; }
  }
  function read(n, bytes) {
    if (state !== "reading") return false;
    try {
      // Fail explicitly if runtime ownership differs, rather than silently
      // treating default stream buffering as a hard pre-read limit.
      if (bytes !== supplied || n < 1 || n > supplied.length || socket.readableLength !== 0) throw error("READ_RUNTIME");
      stats.maxReadBytes = Math.max(stats.maxReadBytes, n);
      lease.received(n); stats.receivedBytes += n;
      if (expired()) return false;
      let offset = 0;
      if (headerUsed < 4) {
        const count = Math.min(4 - headerUsed, n);
        slab.copy(header, headerUsed, 0, count); headerUsed += count; offset += count;
        if (headerUsed < 4) return true;
        const size = header.readUInt32BE(0);
        if (!size || size > maxFrameBytes) throw error("LENGTH");
        // Only this fixed-size header has been interpreted. The entire body
        // admission is already reserved; no text decoding/allocation precedes it.
        body = Buffer.alloc(size); stats.bodyAllocations++; stats.allocatedBodyBytes = size;
      }
      const count = Math.min(n - offset, body.length - used);
      slab.copy(body, used, offset, offset + count); used += count; offset += count;
      if (offset !== n) throw error("TRAILING");
      return true;
    } catch (failure) {
      fail(failure instanceof BoundedChannelError ? failure.code.slice(12) : "READ_FAILURE");
      return false;
    }
  }
  try {
    socket = new net.Socket({ allowHalfOpen: true, onread: { buffer: readBuffer, callback: read }, writableHighWaterMark: 1024 });
    socket.on("error", () => fail("TRANSPORT"));
    socket.on("data", () => fail("READ_RUNTIME")); // onread must bypass Readable's data buffering.
    socket.on("end", () => {
      ended = true;
      if (state !== "reading" || expired()) return;
      if (!body || used !== body.length) { fail("TRUNCATED"); return; }
      complete();
    });
    socket.once("close", () => {
      if (state === "reading") fail("DISCONNECTED");
      if (sendReject) sendReject(error("DISCONNECTED"));
      lease.closed(state === "received" ? body.length : 0);
      if (state !== "received") body = null;
      resolveClosed(snapshot());
    });
    timer = setTimeout(() => fail("DEADLINE"), Number((deadlineNs - now() + 999999n) / 1000000n));
    socket.connect({ port, host: "127.0.0.1" });
  } catch (failure) {
    clearTimeout(timer);
    if (socket) socket.destroy(); else lease.closed(0);
    throw failure;
  }
  function send(bytes) {
    if (state !== "reading" || sendUsed || expired()) throw error("SEND_STATE");
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxFrameBytes) throw error("SEND_LENGTH");
    lease.sent(bytes.length + 4);
    sendUsed = true;
    const frame = Buffer.alloc(bytes.length + 4);
    frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
    stats.sentBytes = frame.length;
    const sent = new Promise((resolve, reject) => {
      let written = false, drained = true, finishing = false;
      const cleanup = () => { socket.off("drain", drain); sendReject = null; };
      sendReject = failure => { cleanup(); reject(failure); };
      function finish() {
        if (!written || !drained || finishing || state !== "reading" || expired()) return;
        finishing = true;
        socket.end(() => {
          if (state !== "reading" || expired()) return;
          sendComplete = true; cleanup(); resolve(); complete();
        });
      }
      function drain() { drained = true; finish(); }
      socket.on("drain", drain);
      try {
        drained = socket.write(frame, failure => {
          if (failure) { fail("WRITE"); return; }
          written = true; finish();
        });
        stats.writeQueuedPeak = Math.max(stats.writeQueuedPeak, socket.writableLength);
        if (!drained) stats.backpressureEvents++;
      } catch { fail("WRITE"); }
    });
    sent.catch(() => {});
    return sent;
  }
  return Object.freeze({ result, closed, snapshot, send, abort: () => fail("ABORTED") });
}
module.exports = { ByteBudget, BoundedChannelError, connectBounded };
