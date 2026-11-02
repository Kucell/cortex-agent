"use strict";
// Controlled real child. Synthetic keys only; no Node IPC or credentials.
const fs = require("node:fs");
const { acceptBoundedSession, openChildPipes } = require("../../../lib/coordination/permit-witness-bounded-session");
const { rawIO, SessionBudget, admit } = require("../../../lib/coordination/permit-witness-bounded-session-io");
const wire = require("../../../lib/coordination/permit-witness-bounded-session-wire");
const maxPayloadBytes = Number(process.argv[2]), maxFrames = Number(process.argv[3]), mode = process.argv[4] || "normal";
const noIPC = !process.send && !process.channel && !process.env.NODE_CHANNEL_FD;
async function run() {
  if (!noIPC) throw new Error("unexpected IPC");
  if (mode === "no-handshake") { setInterval(() => {}, 1000); return; }
  if (mode === "child-copy-failure" || mode === "child-post-copy-failure") {
    const from = Buffer.from, alloc = Buffer.alloc, secrets = [];
    Buffer.from = function (bytes, ...args) {
      if (Buffer.isBuffer(bytes) && bytes.length === 16 && mode === "child-copy-failure") throw new Error("injected second copy failure");
      const copied = from(bytes, ...args);
      if (Buffer.isBuffer(bytes) && [16, 32].includes(bytes.length)) secrets.push(copied);
      return copied;
    };
    Buffer.alloc = function (length, ...args) {
      const bytes = alloc(length, ...args); if (length === 56) secrets.push(bytes); return bytes;
    };
    let rejected = false;
    try { await acceptBoundedSession({ maxPayloadBytes, maxFrames, allowedOperations: [0], handler: () => Buffer.alloc(0) }); }
    catch { rejected = true; }
    finally { Buffer.from = from; Buffer.alloc = alloc; }
    fs.writeFileSync("key-cleanup.json", JSON.stringify({ rejected, copies: secrets.length,
      cleared: secrets.length > 1 && secrets.every(bytes => bytes.every(byte => byte === 0)), nodeIPC: !noIPC }));
    return;
  }
  if (["normal", "hold-exit", "stall", "late"].includes(mode)) {
    const session = await acceptBoundedSession({ maxPayloadBytes, maxFrames, allowedOperations: [1, 2, 3],
      handler: (operation, bytes) => {
        if (mode === "stall") return new Promise(() => {});
        if (mode === "late") return new Promise(resolve => setTimeout(() => resolve(Buffer.from(bytes)), 1000));
        if (operation === 3) return new Promise(resolve => setTimeout(() => resolve(Buffer.from(bytes)), 20));
        return operation === 1 ? Buffer.from("NOIPC") : Buffer.from(bytes);
      } });
    await session.ready;
    await session.closed;
    fs.writeFileSync(`child-${process.pid}.json`, JSON.stringify(session.snapshot()));
    if (mode === "hold-exit") setInterval(() => {}, 1000);
    return;
  }
  // Explicit finite protocol-negative vectors. Use the same real nonblocking
  // pipes as the valid peer, never injected local EventEmitter messages.
  const account = admit(new SessionBudget(), maxPayloadBytes, maxFrames);
  const fds = openChildPipes();
  let key, id, seq = 0, previous;
  const bootstrap = Buffer.alloc(56);
  const secret = rawIO({ readFd: fds.secret, writeFd: fds.secret, account, maxPayloadBytes, maxFrames,
    deadlineNs: process.hrtime.bigint() + 5000000000n });
  await secret.readExact(bootstrap, 0, 56); secret.stop();
  key = Buffer.from(bootstrap.subarray(0, 32)); id = Buffer.from(bootstrap.subarray(32, 48));
  const deadlineNs = bootstrap.readBigUInt64BE(48); bootstrap.fill(0);
  const io = rawIO({ readFd: fds.read, writeFd: fds.write, account, maxPayloadBytes, maxFrames, deadlineNs,
    onEOF: () => io.stop(), onFailure: () => io.stop(), onFrame: frame => {
      const m = wire.decode(key, id, frame, 1, ++seq);
      let reply;
      if (m.type === wire.TYPES.HELLO) {
        reply = wire.encode(key, id, { direction: 2, type: wire.TYPES.HELLO_ACK, seq: 1, binding: m.digest, payload: m.payload });
        if (mode === "bad-handshake") reply[reply.length - 1] ^= 1;
        if (mode === "paused-reader") io.pauseReader();
        void io.write(reply).catch(() => io.stop()); return;
      }
      if (mode === "disconnect") { io.stop(); setTimeout(() => {}, 100); return; }
      if (mode === "oversize") {
        reply = Buffer.alloc(4); reply.writeUInt32BE(maxPayloadBytes + wire.OVERHEAD);
      } else {
        reply = wire.encode(key, id, { direction: mode === "direction" ? 1 : 2,
          type: mode === "child-request" ? wire.TYPES.REQUEST : wire.TYPES.RESPONSE,
          seq: mode === "sequence" ? 1 : seq, requestId: mode === "request-id" ? m.requestId + 1 : m.requestId,
          operation: mode === "operation" ? m.operation + 1 : m.operation,
          binding: mode === "binding" ? wire.zero : m.digest, payload: m.payload });
        if (mode === "session") { const different = Buffer.alloc(16, 9); reply = wire.encode(key, different, {
          direction: 2, type: wire.TYPES.RESPONSE, seq, requestId: m.requestId, operation: m.operation, binding: m.digest }); }
        if (mode === "mac") reply[reply.length - 1] ^= 1;
        if (mode === "replay" && previous) reply = previous;
        previous = reply;
      }
      void io.write(mode === "truncated" ? reply.subarray(0, 10) : reply).then(() => {
        if (mode === "truncated") { io.stop(); setTimeout(() => {}, 100); }
      }, () => io.stop());
    } });
  await io.readLoop();
  if (mode === "paused-reader") setInterval(() => {}, 1000);
  key.fill(0);
}
void run().catch(() => { process.exitCode = 1; });
