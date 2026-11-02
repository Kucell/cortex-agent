"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const vm = require("node:vm");
const { connectBounded, ByteBudget } = require("../../lib/coordination/permit-witness-bounded-channel");
const base = testRuntime("bounded-tests");
fs.mkdirSync(base, { recursive: true });
const supported = { skip: Number(process.versions.node.split(".")[0]) !== 24, timeout: 15000 };
const untilDeadline = ms => process.hrtime.bigint() + BigInt(ms) * 1000000n;
async function bounded(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("missing " + label)), ms);
  })]); } finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("missing " + label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
// A real socket and peer still carry every byte. Gate only the local write
// completion callback so EOF ordering never depends on kernel buffer capacity.
function holdWriteCompletion(t) {
  const Socket = net.Socket;
  let completion, target;
  t.mock.method(net, "Socket", function (options) {
    const boundedRead = !!options?.onread;
    const socket = new Socket(options);
    if (boundedRead) {
      target = socket;
      // connect() restores Socket.prototype.write; install after it connects.
      socket.once("connect", () => {
        const write = socket.write;
        t.mock.method(socket, "write", function (bytes, callback) {
          return write.call(this, bytes, failure => { completion = () => callback(failure); });
        });
      });
    }
    return socket;
  });
  return { ready: () => !!completion, close: () => target.destroy(),
    release: () => { const callback = completion; completion = null; callback(); } };
}
async function peer(t, mode) {
  const root = fs.mkdtempSync(path.join(base, mode + "-")), events = [], channels = [];
  let text = "", stderr = "", exit;
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", path.join(__dirname, "fixtures/permit-witness-bounded-peer.js"), mode],
    { env: { PATH: "/usr/bin:/bin", TMPDIR: root, TMP: root, TEMP: root,
      ...(process.platform === "darwin" ? { __CF_USER_TEXT_ENCODING: "0x0:0:0" } : {}) },
    stdio: ["pipe", "pipe", "pipe"], detached: false });
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.on("error", rejectReady);
  child.stdin.on("error", () => {});
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(0, 4096); });
  child.stdout.on("data", chunk => {
    if (text.length + chunk.length > 512 || events.length > 64) { rejectReady(new Error("peer diagnostic bound")); child.kill("SIGKILL"); return; }
    text += chunk.toString("ascii");
    let end;
    while ((end = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, end); text = text.slice(end + 1); events.push(line);
      if (line.startsWith("READY ")) {
        const match = /^READY ([0-9]{1,5}) NOIPC$/.exec(line);
        if (!match) rejectReady(new Error("unexpected peer channel")); else resolveReady(Number(match[1]));
      }
    }
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    exit = { code, signal }; rejectReady(new Error("peer exit " + JSON.stringify(exit))); resolve(exit);
  }));
  t.after(async () => {
    try {
      for (const channel of channels) channel.abort();
      await Promise.all(channels.map(channel => bounded(channel.closed, "socket close")));
      if (!exit) {
        child.stdin.end("stop\n");
        try { await bounded(exited, "cooperative direct peer exit", 1000); }
        catch { child.kill("SIGKILL"); await bounded(exited, "forced direct peer exit", 3000); }
      }
    } finally {
      fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify({ mode, events, stderr, exit,
        channels: channels.map(channel => channel.snapshot()), treeExitProven: false, authenticated: false }, null, 2));
    }
  });
  const port = await bounded(ready, "peer ready");
  return { root, child, events, command: value => child.stdin.write(value + "\n"), connect(options = {}) {
    const channel = connectBounded({ port, budget: new ByteBudget(), deadlineNs: untilDeadline(5000),
      maxFrameBytes: 32768, readChunkBytes: 32, ...options });
    channels.push(channel); return channel;
  } };
}

test("real raw socket round trip preserves opaque authenticated-frame candidates without Node IPC or decoding", supported, async t => {
  const p = await peer(t, "echo"), channel = p.connect();
  const bytes = Buffer.from([0, 255, 123, 10, 128, 34, 0]);
  await bounded(channel.send(bytes), "write EOF");
  const result = await bounded(channel.result, "raw result");
  assert.deepEqual(result.bytes, bytes); assert.equal(result.authenticated, false);
  await channel.closed;
  assert.ok(channel.snapshot().maxReadBytes <= 32);
  assert.equal(channel.snapshot().budget.retainedResultBytes, bytes.length);
  assert.equal(channel.snapshot().budget.active, 0);
  assert.equal(channel.snapshot().budget.residentBytes, 2 * 32768 + 32 + 8);
});

test("fragmented header/body and EOF barrier allocate only after checked length, no early delivery", supported, async t => {
  const p = await peer(t, "fragment"), channel = p.connect();
  let delivered = false; void channel.result.then(() => { delivered = true; });
  await until(() => p.events.includes("CONNECTED"), "connected");
  p.command("header-a"); await until(() => channel.snapshot().receivedBytes === 2, "header part a");
  assert.equal(channel.snapshot().bodyAllocations, 0);
  p.command("header-b"); await until(() => channel.snapshot().bodyAllocations === 1, "checked body allocation");
  assert.equal(channel.snapshot().allocatedBodyBytes, 6);
  p.command("body-a"); await until(() => channel.snapshot().receivedBytes === 6, "body part a");
  p.command("body-b"); await until(() => channel.snapshot().receivedBytes === 10, "body complete");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(delivered, false);
  p.command("eof"); assert.equal((await channel.result).bytes.toString(), "opaque");
});

for (const [mode, code, allocations] of [["oversize", "LENGTH", 0], ["zero", "LENGTH", 0],
  ["node-ipc-json", "LENGTH", 0], ["truncated-header", "TRUNCATED", 0],
  ["truncated-body", "TRUNCATED", 1], ["trailing", "TRAILING", 1], ["flood", "LENGTH", 0]]) {
  test(`real hostile socket ${mode} fails before delivery with bounded allocation`, supported, async t => {
    const p = await peer(t, mode), channel = p.connect();
    await assert.rejects(bounded(channel.result, mode), { code: "ERR_BOUNDED_" + code });
    await channel.closed;
    assert.equal(channel.snapshot().bodyAllocations, allocations);
    assert.ok(channel.snapshot().maxReadBytes <= 32);
    assert.equal(channel.snapshot().budget.residentBytes, 2 * 32768 + 32 + 8);
  });
}

test("valid bounded deeply nested bytes remain bytes; receiver has no recursive JSON parser", supported, async t => {
  const p = await peer(t, "deep-raw"), channel = p.connect();
  const result = await channel.result;
  assert.equal(result.bytes.length, 24001); assert.equal(result.bytes[0], 0x5b);
  assert.ok(channel.snapshot().maxReadBytes <= 32);
});

test("delayed trailing byte is refused before EOF and terminal failure cannot revive", supported, async t => {
  const p = await peer(t, "late-tail"), channel = p.connect();
  await until(() => channel.snapshot().receivedBytes === 10, "body held before EOF");
  p.command("tail"); await assert.rejects(channel.result, { code: "ERR_BOUNDED_TRAILING" });
  await channel.closed; p.command("eof");
  assert.equal(channel.snapshot().state, "TRAILING");
});

test("shared concurrent and resident admission happens before a second socket/read buffer is created", supported, async t => {
  const p = await peer(t, "hold"), budget = new ByteBudget({ maxActive: 1 });
  const first = p.connect({ budget });
  await until(() => p.events.includes("CONNECTED"), "first channel");
  assert.throws(() => p.connect({ budget }), { code: "ERR_BOUNDED_ADMISSION" });
  assert.equal(budget.snapshot().active, 1);
  first.abort(); await assert.rejects(first.result, { code: "ERR_BOUNDED_ABORTED" }); await first.closed;
  const small = new ByteBudget({ maxResidentBytes: 1 });
  assert.throws(() => p.connect({ budget: small }), { code: "ERR_BOUNDED_ADMISSION" });
  assert.equal(small.snapshot().residentBytes, 0);
});

test("shared lifetime received total is charged before header/body copy and cannot reset on close", supported, async t => {
  // One spare byte of credit is necessary to observe EOF without doing an
  // uncharged speculative read. The second channel can read ONLY that byte.
  const p = await peer(t, "valid"), budget = new ByteBudget({ maxReceivedBytes: 11 });
  const first = p.connect({ budget }); await first.result; await first.closed;
  const second = p.connect({ budget }); await assert.rejects(second.result, { code: "ERR_BOUNDED_TOTAL_RECEIVED" });
  await second.closed;
  assert.equal(second.snapshot().bodyAllocations, 0); assert.equal(budget.snapshot().receivedBytes, 11);
  assert.equal(second.snapshot().maxReadBytes, 1);
  assert.equal(budget.snapshot().pendingReadBytes, 0);
  assert.equal(budget.snapshot().retainedResultBytes, 6);
});

test("absolute deadline covers partial header, complete-without-EOF and stalled peer", supported, async t => {
  for (const mode of ["fragment", "no-eof", "hold"]) {
    const p = await peer(t, mode), deadlineNs = untilDeadline(250), channel = p.connect({ deadlineNs });
    if (mode === "fragment") {
      await until(() => p.events.includes("CONNECTED"), "fragment connection"); p.command("header-a");
    }
    await assert.rejects(channel.result, { code: "ERR_BOUNDED_DEADLINE" });
    assert.ok(process.hrtime.bigint() >= deadlineNs);
    await channel.closed;
  }
});

test("disconnect/reset fails closed and an already expired deadline never admits a channel", supported, async t => {
  const p = await peer(t, "reset"), channel = p.connect();
  await assert.rejects(channel.result, failure => /ERR_BOUNDED_(TRANSPORT|DISCONNECTED|TRUNCATED)/.test(failure.code));
  await channel.closed;
  const budget = new ByteBudget();
  assert.throws(() => p.connect({ budget, deadlineNs: process.hrtime.bigint() - 1n }), { code: "ERR_BOUNDED_DEADLINE" });
  assert.equal(budget.snapshot().active, 0);
});

test("one bounded write over a real socket cannot queue a second frame", supported, async t => {
  const p = await peer(t, "sink"), budget = new ByteBudget({ maxResidentBytes: 4194304 });
  const channel = p.connect({ budget, maxFrameBytes: 1048576, readChunkBytes: 64 });
  await until(() => p.events.includes("CONNECTED"), "paused peer");
  const sending = channel.send(Buffer.alloc(1048576, 7));
  assert.throws(() => channel.send(Buffer.from("second")), { code: "ERR_BOUNDED_SEND_STATE" });
  assert.ok(channel.snapshot().writeQueuedPeak <= 1048580);
  p.command("drain"); await bounded(sending, "backpressure drain");
  assert.equal((await channel.result).bytes.toString(), "ack");
  assert.equal(budget.snapshot().sentBytes, 1048580);
});

test("bounded write waits for real drain as well as write completion", supported, async t => {
  const p = await peer(t, "sink"), Socket = net.Socket;
  let target, completed = false, deferredDrain;
  t.mock.method(net, "Socket", function (options) {
    const socket = new Socket(options);
    if (options?.onread) {
      target = socket;
      socket.once("connect", () => {
        socket.cork();
        const write = socket.write, emit = socket.emit;
        t.mock.method(socket, "write", function (bytes, callback) {
          return write.call(this, bytes, error => { completed = true; callback(error); });
        });
        t.mock.method(socket, "emit", function (event, ...args) {
          if (event === "drain") { deferredDrain = () => emit.call(this, event, ...args); return true; }
          return emit.call(this, event, ...args);
        });
      });
    }
    return socket;
  });
  const budget = new ByteBudget({ maxResidentBytes: 4194304 });
  const channel = p.connect({ budget, maxFrameBytes: 1048576, readChunkBytes: 64 });
  await until(() => p.events.includes("CONNECTED"), "paused peer");
  let settled = false;
  const sending = channel.send(Buffer.alloc(1048576, 7));
  void sending.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(channel.snapshot().backpressureEvents, 1);
  assert.throws(() => channel.send(Buffer.from("second")), { code: "ERR_BOUNDED_SEND_STATE" });
  p.command("drain"); target.uncork();
  await until(() => completed && deferredDrain, "write completion and actual drain");
  assert.equal(settled, false);
  assert.equal(target.writableEnded, false);
  deferredDrain();
  await bounded(sending, "released drain");
  assert.equal((await channel.result).bytes.toString(), "ack");
  await channel.closed;
  assert.equal(budget.snapshot().active, 0);
});

test("peer EOF preserves an already-started send until delayed reads and local write completion", supported, async t => {
  const p = await peer(t, "early-eof"), gate = holdWriteCompletion(t);
  const budget = new ByteBudget({ maxResidentBytes: 4194304 });
  const channel = p.connect({ budget, maxFrameBytes: 1048576, readChunkBytes: 64 });
  await until(() => p.events.includes("CONNECTED"), "paused duplex peer");
  let sent = false, delivered = false, closed = false;
  const sending = channel.send(Buffer.alloc(1048576, 7));
  void sending.then(() => { sent = true; }, () => {});
  void channel.result.then(() => { delivered = true; }, () => {});
  void channel.closed.then(() => { closed = true; });
  p.command("early-eof");
  await until(() => channel.snapshot().receiveEnded, "peer EOF before write completion");
  assert.equal(sent, false); assert.equal(delivered, false); assert.equal(closed, false);
  assert.equal(channel.snapshot().state, "reading"); assert.equal(budget.snapshot().active, 1);
  assert.equal(budget.snapshot().retainedResultBytes, 0);
  assert.throws(() => channel.send(Buffer.from("second")), { code: "ERR_BOUNDED_SEND_STATE" });
  p.command("drain");
  await until(() => p.events.includes("FRAME_OK") && gate.ready(), "complete peer frame while completion held");
  assert.equal(sent, false); assert.equal(delivered, false); assert.equal(closed, false);
  gate.release(); await bounded(sending, "duplex write EOF");
  const result = await bounded(channel.result, "duplex result");
  assert.equal(result.bytes.toString(), "ack"); assert.equal(result.authenticated, false);
  const final = await bounded(channel.closed, "duplex close");
  await until(() => p.events.includes("INPUT_EOF"), "peer observed local EOF");
  assert.equal(final.state, "received"); assert.equal(final.sendComplete, true);
  assert.equal(final.budget.active, 0); assert.equal(final.budget.pendingReadBytes, 0);
  assert.equal(final.budget.retainedResultBytes, 3); assert.equal(final.budget.sentBytes, 1048580);
  assert.equal(final.budget.residentBytes, 2 * 1048576 + 64 + 8);
});

for (const terminal of ["DEADLINE", "ABORTED", "DISCONNECTED"]) {
  test(`peer EOF keeps pending send subject to ${terminal} and budget close`, supported, async t => {
    const p = await peer(t, "early-eof"), gate = holdWriteCompletion(t);
    const budget = new ByteBudget({ maxResidentBytes: 4194304 });
    const deadlineNs = untilDeadline(terminal === "DEADLINE" ? 1000 : 5000);
    const channel = p.connect({ budget, maxFrameBytes: 1048576, deadlineNs });
    await until(() => p.events.includes("CONNECTED"), "terminal duplex peer");
    const sending = channel.send(Buffer.alloc(1048576, 7));
    p.command("early-eof");
    await until(() => channel.snapshot().receiveEnded, "terminal peer EOF");
    assert.equal(channel.snapshot().sendComplete, false); assert.equal(budget.snapshot().active, 1);
    if (terminal === "ABORTED") channel.abort();
    if (terminal === "DISCONNECTED") gate.close();
    await assert.rejects(bounded(channel.result, "terminal duplex result"), { code: "ERR_BOUNDED_" + terminal });
    await assert.rejects(bounded(sending, "terminal duplex send"), { code: "ERR_BOUNDED_" + terminal });
    const final = await bounded(channel.closed, "terminal duplex close");
    if (terminal === "DEADLINE") assert.ok(process.hrtime.bigint() >= deadlineNs);
    assert.equal(final.budget.active, 0); assert.equal(final.budget.pendingReadBytes, 0);
    assert.equal(final.budget.retainedResultBytes, 0);
    assert.equal(final.budget.residentBytes, 2 * 1048576 + 32 + 8);
    // Even a late native callback cannot revive a closed terminal or refund it.
    await until(gate.ready, "late native write completion"); gate.release();
    await new Promise(resolve => setImmediate(resolve)); channel.abort();
    assert.deepEqual(channel.snapshot(), final);
  });
}

test("write and drain wait share the absolute deadline; total send refusal precedes a write copy", supported, async t => {
  const p = await peer(t, "sink"), budget = new ByteBudget({ maxResidentBytes: 4194304 });
  const channel = p.connect({ budget, maxFrameBytes: 1048576, deadlineNs: untilDeadline(500) });
  await until(() => p.events.includes("CONNECTED"), "paused deadline peer");
  const sending = channel.send(Buffer.alloc(1048576));
  await assert.rejects(channel.result, { code: "ERR_BOUNDED_DEADLINE" });
  // Depending on kernel send capacity, send may have completed before the
  // receive deadline. It must never remain pending after channel termination.
  await bounded(sending.catch(() => {}), "terminated send"); await channel.closed;
  const q = await peer(t, "hold"), tiny = new ByteBudget({ maxSentBytes: 1 });
  const refused = q.connect({ budget: tiny });
  assert.throws(() => refused.send(Buffer.from("payload")), { code: "ERR_BOUNDED_TOTAL_SENT" });
  assert.equal(refused.snapshot().sentBytes, 0); refused.abort();
});

test("aggregate read credit is reserved before concurrent native reads; exact quota fails conservatively before EOF", supported, async t => {
  const p = await peer(t, "hold"), budget = new ByteBudget({ maxReceivedBytes: 32 });
  const first = p.connect({ budget });
  await until(() => p.events.includes("CONNECTED"), "reserved read");
  assert.equal(budget.snapshot().pendingReadBytes, 32);
  assert.throws(() => p.connect({ budget }), { code: "ERR_BOUNDED_TOTAL_RECEIVED" });
  assert.equal(budget.snapshot().receivedBytes, 0);
  first.abort(); await first.closed;
  assert.equal(budget.snapshot().pendingReadBytes, 0);
  const q = await peer(t, "valid"), exact = new ByteBudget({ maxReceivedBytes: 10 });
  const channel = q.connect({ budget: exact });
  await assert.rejects(channel.result, { code: "ERR_BOUNDED_TOTAL_RECEIVED" });
  await channel.closed;
  assert.equal(exact.snapshot().receivedBytes, 10);
});

test("lifetime reservation cannot be recycled by retaining closed handles, and maximum frame admission is exact", supported, async t => {
  const p = await peer(t, "echo");
  const maximum = 1024, capacity = 2 * maximum + 32 + 8;
  const budget = new ByteBudget({ maxResidentBytes: capacity });
  const channel = p.connect({ budget, maxFrameBytes: maximum });
  assert.throws(() => channel.send(Buffer.alloc(maximum + 1)), { code: "ERR_BOUNDED_SEND_LENGTH" });
  await channel.send(Buffer.alloc(maximum, 17));
  assert.equal((await channel.result).bytes.length, maximum); await channel.closed;
  assert.equal(budget.snapshot().residentBytes, capacity);
  assert.throws(() => p.connect({ budget, maxFrameBytes: maximum }), { code: "ERR_BOUNDED_ADMISSION" });
});

test("deadline remains absolute under progressing fragments, not an inactivity timeout", supported, async t => {
  const p = await peer(t, "fragment"), deadlineNs = untilDeadline(400), channel = p.connect({ deadlineNs });
  await until(() => p.events.includes("CONNECTED"), "slow peer connected");
  p.command("header-a"); await until(() => channel.snapshot().receivedBytes === 2, "progress header");
  await new Promise(resolve => setTimeout(resolve, 150));
  p.command("header-b"); await until(() => channel.snapshot().bodyAllocations === 1, "progress length");
  await assert.rejects(channel.result, { code: "ERR_BOUNDED_DEADLINE" }); await channel.closed;
  assert.ok(process.hrtime.bigint() >= deadlineNs);
  assert.equal(channel.snapshot().receivedBytes, 4);
});

test("continuous progress before the deadline does not postpone it", supported, async t => {
  // The lower bound asserted above cannot tell an absolute deadline apart from
  // an inactivity timeout: an inactivity timer that is refreshed on every
  // fragment still fails eventually, and it still fails after the original
  // deadline. This case keeps the peer progressing across the whole window,
  // so only an absolute deadline terminates it at the original instant.
  const p = await peer(t, "drip"), deadlineNs = untilDeadline(600), channel = p.connect({ deadlineNs });
  await until(() => p.events.includes("CONNECTED"), "progressing peer connected");
  const rejectedAt = await channel.result.then(() => null, error => {
    assert.equal(error.code, "ERR_BOUNDED_DEADLINE");
    return process.hrtime.bigint();
  });
  await channel.closed;
  assert.ok(rejectedAt !== null, "the channel must not have completed");
  // The peer really was making progress across the whole window.
  assert.ok(channel.snapshot().receivedBytes > 0, "the peer made no progress");
  // The rejection itself must not have happened before the deadline, and it
  // must not have been postponed past it either: an inactivity timer refreshed
  // by the feeding above would reject far later than the original deadline.
  assert.ok(rejectedAt >= deadlineNs, "rejected before the deadline");
  const overshootNs = rejectedAt - deadlineNs;
  assert.ok(overshootNs < 200000000n, "rejected long after the deadline: the deadline was extended");
});

test("a deadline reached during initialization never connects to the peer", supported, async t => {
  // The deadline can pass between the admission check and the timer being
  // armed. A channel that has already failed must not then connect: Node
  // re-initializes a destroyed socket, so an unconditional connect would open
  // a connection to the peer AFTER the channel reached its terminal state.
  const modulePath = require.resolve("../../lib/coordination/permit-witness-bounded-channel");
  const source = fs.readFileSync(modulePath, "utf8");
  const server = net.createServer({ allowHalfOpen: true }, socket => { socket.on("error", () => {}); });
  const peers = [];
  server.on("connection", socket => peers.push(socket));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { for (const peer of peers) peer.destroy(); server.close(resolve); }));

  let target, connects = 0, reads = 0;
  function Socket(options) {
    target = new net.Socket(options);
    const connect = target.connect;
    target.connect = function (...args) { connects++; return connect.apply(this, args); };
    return target;
  }
  const sandbox = {
    module: { exports: {} }, exports: {}, Buffer, setTimeout, clearTimeout,
    require: name => name === "node:net" ? { Socket } : require("node:module").createRequire(modulePath)(name),
    // The clock reports a time before the deadline for the admission checks and
    // a time past it once the channel starts initializing.
    process: { versions: process.versions, env: {}, hrtime: { bigint: () => (++reads <= 2 ? 0n : 10000000n) } },
  };
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  const channel = sandbox.module.exports.connectBounded({ port: server.address().port,
    budget: new sandbox.module.exports.ByteBudget(), deadlineNs: 10000000n });
  await assert.rejects(channel.result, { code: "ERR_BOUNDED_DEADLINE" });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(connects, 0, "the channel connected after it had already failed");
  assert.equal(channel.snapshot().state, "DEADLINE");
  assert.equal(channel.snapshot().budget.active, 0);
  if (target) target.destroy();
});
