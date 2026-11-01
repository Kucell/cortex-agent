"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { SessionBudget, startBoundedSession } = require("../../lib/coordination/permit-witness-bounded-session");
const { admit, rawIO, limits } = require("../../lib/coordination/permit-witness-bounded-session-io");
const wire = require("../../lib/coordination/permit-witness-bounded-session-wire");
const appFrame = require("../../lib/coordination/permit-witness-v2-frame");
const P = 1048599, F = 1048697, HELLO = wire.OVERHEAD + 32, BOOT = 56;
const root = path.resolve(__dirname, "../../.agent/runtime/bounded-session-capacity-tests");
fs.mkdirSync(root, { recursive: true });
const supported = { skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) !== 24, timeout: 20000 };
const deadline = ms => process.hrtime.bigint() + BigInt(ms) * 1000000n;
function options(budget, extra = {}) {
  return { profile: "v2", modulePath: path.join(__dirname, "fixtures/permit-witness-bounded-session-capacity-peer.js"),
    runtimeDirectory: root, budget, deadlineNs: deadline(12000), ...extra };
}
function launch(t, extra = {}) {
  const budget = extra.budget || new SessionBudget();
  const ticket = startBoundedSession(options(budget, extra));
  t.after(async () => { ticket.session?.abort(); ticket.terminate(); await ticket.directExit; });
  return { ticket, budget };
}
function finalUnchanged(session, snapshot) {
  session.abort(); assert.deepEqual(session.snapshot(), snapshot);
  assert.throws(() => session.request(1, Buffer.alloc(0)), { code: "ERR_BOUNDED_SESSION_CLOSED" });
}
test("local fixed profiles preserve legacy limits and reject invalid or unselected expansion before admission", () => {
  assert.deepEqual(limits(), { profile: "default", maxPayloadBytes: 4096, maxFrames: 16 });
  assert.deepEqual(limits("v2"), { profile: "v2", maxPayloadBytes: P, maxFrames: 6 });
  assert.equal(wire.OVERHEAD + P, F);
  for (const profile of ["unknown", "__proto__", {}, null]) assert.throws(() => limits(profile), TypeError);
  for (const n of [null, P + 1, NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER]) assert.throws(() => limits("v2", n), TypeError);
  for (const profile of ["default", "v2"]) {
    assert.throws(() => limits(profile, null), TypeError);
    assert.throws(() => limits(profile, undefined, null), TypeError);
  }
  const budget = new SessionBudget();
  assert.throws(() => admit(budget, 65537, 6), TypeError);
  assert.throws(() => admit(budget, P + 1, 6, "v2"), TypeError);
  assert.equal(budget.snapshot().sessions, 0);
  assert.ok(Object.isFrozen(wire.CAPACITY_PROFILES.v2));
});
test("direct admission resolves finite defaults and rejects null without poisoning shared capacity", () => {
  const budget = new SessionBudget(); admit(budget);
  assert.equal(budget.snapshot().capacityBytes, 32 * (4096 + wire.OVERHEAD + 128) + 256);
  admit(budget, undefined, undefined, "v2");
  assert.ok(Number.isSafeInteger(budget.snapshot().capacityBytes));
  const before = budget.snapshot();
  assert.throws(() => admit(budget, null), TypeError);
  assert.throws(() => admit(budget, undefined, null), TypeError);
  assert.deepEqual(budget.snapshot(), before);
});
test("maximum complete v2 application frame survives four authenticated rounds, retained views and close", supported, async t => {
  const { ticket, budget } = launch(t); await ticket.ready;
  // The response is the larger application direction (22 header + 1 status).
  const bytes = appFrame.encodeFrame({ direction: "response", status: 0, operation: appFrame.OPERATIONS.transition,
    requestId: "07070707-0707-0707-0707-070707070707", payload: Buffer.alloc(1048576, 9) });
  assert.equal(bytes.length, P);
  const copies = [];
  for (let i = 0; i < 4; i++) { const reply = await ticket.session.request(1, bytes); assert.deepEqual(reply, bytes); copies.push(reply); }
  assert.equal(ticket.session.snapshot().maxFrameBytes, F);
  await ticket.session.close(); await ticket.directExit;
  for (const reply of copies) assert.deepEqual(reply, bytes);
  const a = budget.snapshot(), s = ticket.session.snapshot();
  assert.equal(a.sentBytes, BOOT + HELLO + 4 * F + wire.OVERHEAD);
  assert.equal(a.receivedBytes, HELLO + 4 * F + wire.OVERHEAD);
  assert.equal(a.capacityBytes, 12 * (F + 128) + 256);
  assert.equal(a.directExits, 1); assert.equal(a.sessions, 1); assert.equal(a.chargesRetained, true);
  assert.equal(s.incomingFrames, 6); assert.equal(s.outgoingFrames, 6); assert.ok(s.maxReadBytes <= 4096);
  assert.equal(s.executionAuthorized, false); assert.equal(s.treeExitProven, false);
});
test("public trusted configuration rejects null payload/frame limits before preparing files", supported, t => {
  const budget = new SessionBudget(); let prepared = 0;
  t.mock.method(fs, "mkdtempSync", () => { prepared++; throw new Error("must not prepare"); });
  for (const profile of ["default", "v2"]) for (const field of ["maxPayloadBytes", "maxFrames"]) {
    assert.throws(() => startBoundedSession(options(budget, { profile, [field]: null })), TypeError);
  }
  assert.equal(prepared, 0); assert.equal(budget.snapshot().sessions, 0);
});
test("oversize by one is rejected without encode, byte charge or loss of ready state", supported, async t => {
  const { ticket, budget } = launch(t); await ticket.ready;
  const over = Buffer.alloc(P + 1), before = budget.snapshot();
  let encodes = 0;
  const encode = wire.encode;
  t.mock.method(wire, "encode", (...args) => { encodes++; return encode(...args); });
  assert.throws(() => ticket.session.request(1, over), { code: "ERR_BOUNDED_SESSION_PAYLOAD_LENGTH" });
  assert.equal(encodes, 0); assert.equal(budget.snapshot().sentBytes, before.sentBytes);
  assert.equal(ticket.session.snapshot().state, "ready");
  // A request describing a profile is only opaque bytes and cannot alter policy.
  const data = Buffer.from('{"profile":"v2","maxPayloadBytes":999999999}');
  assert.deepEqual(await ticket.session.request(1, data), data);
  assert.equal(ticket.session.snapshot().maxPayloadBytes, P); await ticket.session.close();
});
test("shared root admits two concurrent maximum exchanges, serializes each endpoint and retains capacity after exit", supported, async t => {
  const budget = new SessionBudget({ maxSessions: 2, maxCapacityBytes: 33554432 });
  const a = launch(t, { budget }), b = launch(t, { budget }); await Promise.all([a.ticket.ready, b.ticket.ready]);
  const bytes = Buffer.alloc(P, 42), pending = a.ticket.session.request(1, bytes);
  assert.throws(() => a.ticket.session.request(1, bytes), { code: "ERR_BOUNDED_SESSION_BUSY" });
  for (const result of await Promise.all([pending, b.ticket.session.request(1, bytes)])) assert.deepEqual(result, bytes);
  await Promise.all([a.ticket.session.close(), b.ticket.session.close()]);
  await Promise.all([a.ticket.directExit, b.ticket.directExit]);
  assert.equal(budget.snapshot().sessions, 2); assert.equal(budget.snapshot().directExits, 2);
  assert.throws(() => startBoundedSession(options(budget)), { code: "ERR_BOUNDED_SESSION_ADMISSION" });
});
test("capacity exhaustion refuses launch before allocation and does not spend session slots", supported, t => {
  const budget = new SessionBudget({ maxCapacityBytes: 12 * (F + 128) + 255 });
  let allocations = 0;
  t.mock.method(fs, "mkdtempSync", () => { allocations++; throw new Error("must not prepare"); });
  assert.throws(() => startBoundedSession(options(budget)), { code: "ERR_BOUNDED_SESSION_ADMISSION" });
  assert.equal(allocations, 0); assert.equal(budget.snapshot().sessions, 0);
});
test("bootstrap quota is reserved before allocating or spawning and failure retains admission", supported, async t => {
  let prepared = 0, allocated = 0;
  const mkdir = fs.mkdtempSync, alloc = Buffer.alloc;
  t.mock.method(fs, "mkdtempSync", (...args) => { prepared++; return mkdir(...args); });
  t.mock.method(Buffer, "alloc", (n, ...args) => { if (n === BOOT) allocated++; return alloc(n, ...args); });
  const { ticket, budget } = launch(t, { budget: new SessionBudget({ maxSentBytes: BOOT - 1 }) });
  await assert.rejects(ticket.ready, { code: "ERR_BOUNDED_SESSION_TOTAL_SENT" });
  assert.equal((await ticket.directExit).kind, "not-started");
  assert.equal(budget.snapshot().sentBytes, 0); assert.equal(budget.snapshot().sessions, 1);
  assert.equal(prepared, 0); assert.equal(allocated, 0);
});
test("whole maximum write is reserved before encode; exhaustion is terminal and never refunds", supported, async t => {
  const budget = new SessionBudget({ maxSentBytes: BOOT + HELLO + F });
  const { ticket } = launch(t, { budget }); await ticket.ready;
  assert.deepEqual(await ticket.session.request(1, Buffer.alloc(P)), Buffer.alloc(P));
  let encodes = 0;
  t.mock.method(wire, "encode", () => { encodes++; throw new Error("must not encode"); });
  await assert.rejects(ticket.session.request(1, Buffer.alloc(0)), { code: "ERR_BOUNDED_SESSION_TOTAL_SENT" });
  const final = await ticket.session.closed; finalUnchanged(ticket.session, final);
  assert.equal(encodes, 0); assert.equal(budget.snapshot().sentBytes, BOOT + HELLO + F);
});
test("failed encode retains the complete accepted write reservation", supported, async t => {
  const { ticket, budget } = launch(t); await ticket.ready;
  const before = budget.snapshot().sentBytes;
  t.mock.method(wire, "encode", () => { throw new Error("finite allocation failure"); });
  await assert.rejects(ticket.session.request(1, Buffer.alloc(P)), { code: "ERR_BOUNDED_SESSION_PROTOCOL" });
  assert.equal(budget.snapshot().sentBytes, before + F);
  finalUnchanged(ticket.session, await ticket.session.closed);
});
test("maximum frame budget prevents empty retries and terminal revival", supported, async t => {
  const { ticket, budget } = launch(t, { maxFrames: 2 }); await ticket.ready;
  await ticket.session.request(1, Buffer.alloc(0));
  await assert.rejects(ticket.session.request(1, Buffer.alloc(0)), { code: "ERR_BOUNDED_SESSION_FRAME_LIMIT" });
  const charged = budget.snapshot().sentBytes;
  finalUnchanged(ticket.session, await ticket.session.closed);
  assert.equal(budget.snapshot().sentBytes, charged);
});
test("one absolute deadline rejects late maximum response and retains all reservations", supported, async t => {
  const { ticket, budget } = launch(t, { args: ["late"], deadlineNs: deadline(700) }); await ticket.ready;
  await assert.rejects(ticket.session.request(1, Buffer.alloc(P)), { code: "ERR_BOUNDED_SESSION_DEADLINE" });
  const final = await ticket.session.closed, charged = budget.snapshot().sentBytes;
  await new Promise(resolve => setTimeout(resolve, 600));
  finalUnchanged(ticket.session, final); assert.equal(budget.snapshot().sentBytes, charged);
});

// Finite synthetic regular-file inputs isolate the pre-allocation/read credit
// contract. Real inherited FIFO exchanges are covered above, without patching
// their I/O. No credentials, listener or production entry is involved.
function reader(t, bytes, budget, { pauseOnFrame = true } = {}) {
  const directory = fs.mkdtempSync(path.join(root, "credit-"));
  const input = path.join(directory, "input.bin"), output = path.join(directory, "output.bin");
  fs.writeFileSync(input, bytes);
  const readFd = fs.openSync(input, "r"), writeFd = fs.openSync(output, "w");
  const account = admit(budget, P, 6, "v2"), frames = [];
  let reason, eof = false;
  const io = rawIO({ readFd, writeFd, account, profile: "v2", maxPayloadBytes: P, maxFrames: 6,
    deadlineNs: deadline(4000), onFrame: frame => { frames.push(frame); if (pauseOnFrame) io.pauseReader(); },
    onEOF: () => { eof = true; io.stop(); }, onFailure: error => { reason = error; io.stop(); } });
  t.after(() => io.stop());
  return { io, account, readFd, writeFd, frames, output, get reason() { return reason; }, get eof() { return eof; } };
}
function syntheticFrame(size = F) { const bytes = Buffer.alloc(size); bytes.writeUInt32BE(size - 4); return bytes; }
test("received maximum+1 and uint32 lengths reject after four bytes without frame allocation", async t => {
  for (const length of [F - 4 + 1, 0xffffffff, wire.OVERHEAD - 5]) {
    const header = Buffer.alloc(4); header.writeUInt32BE(length);
    const budget = new SessionBudget(), r = reader(t, header, budget);
    const alloc = Buffer.alloc; let largeAllocations = 0;
    const mock = t.mock.method(Buffer, "alloc", (n, ...args) => { if (n > 4) largeAllocations++; return alloc(n, ...args); });
    await r.io.readLoop(); mock.mock.restore();
    assert.equal(r.reason.code, "ERR_BOUNDED_SESSION_LENGTH"); assert.equal(largeAllocations, 0);
    assert.equal(budget.snapshot().receivedBytes, 4); assert.equal(budget.snapshot().receivedChargedBytes, 4);
  }
});
test("insufficient body credit refuses before allocation or any body read", async t => {
  const bytes = syntheticFrame(), budget = new SessionBudget({ maxReceivedBytes: F - 1 });
  const r = reader(t, bytes, budget), alloc = Buffer.alloc; let allocations = 0;
  t.mock.method(Buffer, "alloc", (n, ...args) => { if (n === F) allocations++; return alloc(n, ...args); });
  await r.io.readLoop();
  assert.equal(r.reason.code, "ERR_BOUNDED_SESSION_TOTAL_RECEIVED"); assert.equal(allocations, 0);
  assert.equal(budget.snapshot().receivedBytes, 4); assert.equal(budget.snapshot().receivedChargedBytes, 4);
});
test("accepted receive reservation survives frame allocation failure", async t => {
  const bytes = syntheticFrame(), budget = new SessionBudget(), r = reader(t, bytes, budget), alloc = Buffer.alloc;
  t.mock.method(Buffer, "alloc", (n, ...args) => {
    if (n === F) { assert.equal(budget.snapshot().receivedChargedBytes, F); throw new Error("finite allocation failure"); }
    return alloc(n, ...args);
  });
  await r.io.readLoop();
  assert.equal(r.reason.message, "finite allocation failure"); assert.equal(budget.snapshot().receivedChargedBytes, F);
  assert.equal(budget.snapshot().receivedBytes, 4); assert.equal(r.frames.length, 0);
});
test("partial receive and EOF retain full reservation, forbid retry and never publish a frame", async t => {
  const bytes = syntheticFrame().subarray(0, 17), budget = new SessionBudget(), r = reader(t, bytes, budget);
  await r.io.readLoop();
  assert.equal(r.reason.code, "ERR_BOUNDED_SESSION_TRUNCATED"); assert.equal(r.frames.length, 0);
  assert.equal(budget.snapshot().receivedBytes, 17); assert.equal(budget.snapshot().receivedChargedBytes, F);
  const before = budget.snapshot();
  await assert.rejects(r.io.readLoop(), { code: "ERR_BOUNDED_SESSION_READER_BUSY" });
  assert.deepEqual(budget.snapshot(), before);
});
test("shared receive reservation wins atomically before yielding; a competing body cannot overspend it", async t => {
  const bytes = syntheticFrame(), budget = new SessionBudget({ maxCapacityBytes: 33554432, maxReceivedBytes: F + 4 });
  const a = reader(t, bytes, budget), b = reader(t, bytes, budget), read = fs.readSync, alloc = Buffer.alloc;
  let bodyAllocations = 0, calls = 0;
  t.mock.method(Buffer, "alloc", (n, ...args) => { if (n === F) bodyAllocations++; return alloc(n, ...args); });
  t.mock.method(fs, "readSync", (fd, buffer, offset, count, position) => {
    if (fd === a.readFd || fd === b.readFd) {
      const s = budget.snapshot(); assert.ok(count <= 4096);
      assert.ok(count <= s.receivedChargedBytes - s.receivedBytes); calls++;
    }
    return read(fd, buffer, offset, count, position);
  });
  await Promise.all([a.io.readLoop(), b.io.readLoop()]);
  assert.equal(a.frames.length, 1); assert.equal(a.reason, undefined);
  assert.equal(b.reason.code, "ERR_BOUNDED_SESSION_TOTAL_RECEIVED"); assert.equal(b.frames.length, 0);
  assert.equal(bodyAllocations, 1); assert.ok(calls > 2);
  assert.equal(budget.snapshot().receivedBytes, F + 4); assert.equal(budget.snapshot().receivedChargedBytes, F + 4);
});
test("partial write failure retains the full reservation without rebuilding or retrying", async t => {
  const bytes = syntheticFrame(), budget = new SessionBudget(), r = reader(t, Buffer.alloc(0), budget);
  const write = fs.writeSync; let written = 0, builds = 0;
  t.mock.method(fs, "writeSync", (fd, buffer, offset, count, position) => {
    if (fd !== r.writeFd) return write(fd, buffer, offset, count, position);
    assert.equal(budget.snapshot().sentBytes, F);
    if (written) { const e = new Error("finite pipe failure"); e.code = "EPIPE"; throw e; }
    written += write(fd, buffer, offset, Math.min(17, count), position); return written;
  });
  const result = r.io.buildAndWrite(F, () => { builds++; return bytes; });
  await assert.rejects(result.writing, { code: "ERR_BOUNDED_SESSION_WRITE" }); r.io.stop();
  assert.equal(written, 17); assert.equal(builds, 1); assert.equal(budget.snapshot().sentBytes, F);
  assert.throws(() => r.io.buildAndWrite(F, () => bytes), { code: "ERR_BOUNDED_SESSION_CLOSED" });
});
test("exact received and sent quota including close settles as closed without speculative header charge", supported, async t => {
  const received = HELLO + F + wire.OVERHEAD;
  const budget = new SessionBudget({ maxReceivedBytes: received, maxSentBytes: BOOT + received });
  const { ticket } = launch(t, { budget }); await ticket.ready;
  await ticket.session.request(1, Buffer.alloc(P)); await ticket.session.close(); await ticket.directExit;
  assert.equal(ticket.session.snapshot().state, "closed");
  assert.equal(budget.snapshot().receivedBytes, received); assert.equal(budget.snapshot().receivedChargedBytes, received);
  assert.equal(budget.snapshot().sentBytes, BOOT + received);
  finalUnchanged(ticket.session, await ticket.session.closed);
});
test("exact ordinary response credit delivers once then terminally refuses the next header", supported, async t => {
  const budget = new SessionBudget({ maxReceivedBytes: HELLO + F });
  const { ticket } = launch(t, { budget }); await ticket.ready;
  assert.equal((await ticket.session.request(1, Buffer.alloc(P))).length, P);
  const final = await ticket.session.closed;
  assert.equal(final.state, "ERR_BOUNDED_SESSION_TOTAL_RECEIVED"); finalUnchanged(ticket.session, final);
  assert.equal(budget.snapshot().receivedBytes, HELLO + F); assert.equal(budget.snapshot().receivedChargedBytes, HELLO + F);
});
