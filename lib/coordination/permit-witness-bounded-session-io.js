"use strict";

// POSIX nonblocking inherited FIFOs only. fs.readSync's explicit count is the
// pre-native-read bound; no Readable, JSON parser, private handle or data cap.
const fs = require("node:fs");
const { failure, OVERHEAD, CAPACITY_PROFILES } = require("./permit-witness-bounded-session-wire");
const accounts = new WeakMap();
const pause = () => new Promise(resolve => setTimeout(resolve, 2));
function positive(n, max) { if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError("positive bounded integer required"); return n; }
function limits(profile = "default", maxPayloadBytes, maxFrames) {
  if (typeof profile !== "string" || !Object.hasOwn(CAPACITY_PROFILES, profile)) throw new TypeError("fixed local capacity profile required");
  const p = CAPACITY_PROFILES[profile];
  return Object.freeze({ profile, maxPayloadBytes: positive(maxPayloadBytes === undefined ? p.payloadBytes : maxPayloadBytes, p.maxPayloadBytes),
    maxFrames: positive(maxFrames === undefined ? p.maxFrames : maxFrames, 64) });
}
function reserveReceived(account, length) {
  positive(length, 67108864);
  if (length > account.maxReceivedBytes - account.receivedChargedBytes) throw failure("TOTAL_RECEIVED");
  account.receivedChargedBytes += length; // Includes failed/partial reservations; never refunded.
}
function reserveSent(account, length) {
  positive(length, 67108864);
  if (length > account.maxSentBytes - account.sentBytes) throw failure("TOTAL_SENT");
  account.sentBytes += length;
}
class SessionBudget {
  constructor({ maxSessions = 4, maxCapacityBytes = 16777216, maxReceivedBytes = 8388608, maxSentBytes = 8388608 } = {}) {
    accounts.set(this, { maxSessions: positive(maxSessions, 64), maxCapacityBytes: positive(maxCapacityBytes, 67108864),
      maxReceivedBytes: positive(maxReceivedBytes, 67108864), maxSentBytes: positive(maxSentBytes, 67108864),
      sessions: 0, capacityBytes: 0, receivedBytes: 0, receivedChargedBytes: 0, sentBytes: 0, directExits: 0 });
    Object.freeze(this);
  }
  snapshot() { return Object.freeze({ ...accounts.get(this), chargesRetained: true, treeExitProven: false }); }
}
Object.freeze(SessionBudget.prototype);
function admit(budget, maxPayloadBytes, maxFrames, profile = "default") {
  const a = accounts.get(budget);
  if (!a) throw new TypeError("shared SessionBudget required");
  ({ maxPayloadBytes, maxFrames } = limits(profile, maxPayloadBytes, maxFrames));
  // Lifetime frame allocations, including frames retained by result consumers.
  // Per direction/frame: one full frame + 128 for explicit hash/tag buffers.
  // Fixed 256: bootstrap, key/session copies, challenge and read header.
  // Not RSS: excludes kernel buffers, crypto/V8/allocator overhead, caller and
  // handler copies. Subarrays retain their charged full frame, without copying.
  const capacity = 2 * maxFrames * (maxPayloadBytes + OVERHEAD + 128) + 256;
  if (a.sessions >= a.maxSessions || capacity > a.maxCapacityBytes - a.capacityBytes) throw failure("ADMISSION");
  a.sessions++; a.capacityBytes += capacity;
  return a; // Deliberately never refunded, even on direct exit: no tree proof.
}
function rawIO({ readFd, writeFd, deadlineNs, account, maxPayloadBytes, maxFrames, profile = "default", onFrame, onEOF, onFailure }) {
  const full = profile === "v2";
  let stopped = false, reader = false, readerPaused = false, writer = false, incoming = 0, outgoing = 0;
  const stats = { maxReadBytes: 0, readCalls: 0, writeWaits: 0, incomingFrames: 0, outgoingFrames: 0 };
  function check() {
    if (stopped) throw failure("CLOSED");
    if (process.hrtime.bigint() >= deadlineNs) throw failure("DEADLINE");
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const fd of new Set([readFd, writeFd])) { try { fs.closeSync(fd); } catch {} }
  }
  async function readExact(bytes, offset, count, eof = false, reserved = false) {
    let used = 0, quantum = 0;
    while (used < count) {
      check();
      const credit = Math.min(4096, count - used, reserved ? count - used : account.maxReceivedBytes - account.receivedChargedBytes);
      if (credit < 1) throw failure("TOTAL_RECEIVED");
      let n;
      try { n = fs.readSync(readFd, bytes, offset + used, credit, null); }
      catch (e) { if (e.code === "EAGAIN" || e.code === "EWOULDBLOCK") { await pause(); continue; } throw failure("READ"); }
      stats.readCalls++; stats.maxReadBytes = Math.max(stats.maxReadBytes, n);
      account.receivedBytes += n;
      if (!reserved) account.receivedChargedBytes += n;
      check();
      if (!n) { if (eof && !used) return false; throw failure("TRUNCATED"); }
      used += n;
      if (full && (quantum += n) >= 65536) { quantum = 0; await new Promise(resolve => setImmediate(resolve)); }
    }
    return true;
  }
  async function readLoop() {
    if (reader) throw failure("READER_BUSY");
    reader = true;
    const header = Buffer.alloc(4);
    try {
      while (!stopped && !readerPaused) {
        // Reserve before any kernel read, then reserve the entire validated
        // body before allocating it. Other sessions cannot spend this credit.
        if (full) { check(); reserveReceived(account, 4); }
        if (!await readExact(header, 0, 4, true, full)) { onEOF(); return; }
        const size = header.readUInt32BE(0);
        if (++incoming > maxFrames) throw failure("FRAME_LIMIT");
        if (size < OVERHEAD - 4 || size > maxPayloadBytes + OVERHEAD - 4) throw failure("LENGTH");
        if (full) reserveReceived(account, size);
        const frame = Buffer.alloc(size + 4); header.copy(frame);
        await readExact(frame, 4, size, false, full);
        check(); stats.incomingFrames++; onFrame(frame);
      }
    } catch (e) { if (!stopped) onFailure(e); }
  }
  function buildAndWrite(length, build) {
    check();
    if (writer) throw failure("WRITER_BUSY");
    if (!Number.isSafeInteger(length) || length < 1 || length > maxPayloadBytes + OVERHEAD || outgoing >= maxFrames) throw failure("FRAME_LIMIT");
    // Charge the whole accepted frame before the first write; no retry refunds.
    reserveSent(account, length); outgoing++; writer = true;
    let frame;
    try { frame = build(); } catch (e) { writer = false; throw e; }
    return { frame, writing: writeReserved(frame) };
  }
  async function writeReserved(frame) {
    try {
      let offset = 0, quantum = 0;
      while (offset < frame.length) {
        check();
        try {
          const n = fs.writeSync(writeFd, frame, offset, Math.min(4096, frame.length - offset), null);
          if (!n) throw failure("WRITE");
          offset += n;
          if (full && (quantum += n) >= 65536) { quantum = 0; await new Promise(resolve => setImmediate(resolve)); }
        } catch (e) {
          if (e.code !== "EAGAIN" && e.code !== "EWOULDBLOCK") throw failure("WRITE");
          stats.writeWaits++; await pause();
        }
      }
      check(); stats.outgoingFrames++;
    } finally { writer = false; }
  }
  return { readLoop, readExact, buildAndWrite, write: async frame => buildAndWrite(frame.length, () => frame).writing,
    pauseReader: () => { readerPaused = true; }, stop, check, snapshot: () => Object.freeze({ ...stats }) };
}
module.exports = { SessionBudget, admit, rawIO, positive, limits, reserveReceived, reserveSent };
