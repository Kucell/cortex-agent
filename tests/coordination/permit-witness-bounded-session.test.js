"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const childProcess = require("node:child_process"), crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const { SessionBudget, startBoundedSession } = require("../../lib/coordination/permit-witness-bounded-session");
const { OVERHEAD } = require("../../lib/coordination/permit-witness-bounded-session-wire");
const root = testRuntime("bounded-session-tests");
fs.mkdirSync(root, { recursive: true });
const supported = { skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) !== 24, timeout: 15000 };
const deadline = (ms = 4000) => process.hrtime.bigint() + BigInt(ms) * 1000000n;
async function bounded(promise, ms = 6000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("missing completion")), ms); })]); }
  finally { clearTimeout(timer); }
}
function launch(t, mode = "normal", options = {}) {
  const budget = options.budget || new SessionBudget();
  const ticket = startBoundedSession({ modulePath: path.join(__dirname, "fixtures/permit-witness-bounded-session-peer.js"),
    args: [mode], runtimeDirectory: root, budget, deadlineNs: deadline(), allowedOperations: [1, 2, 3], ...options });
  t.after(async () => {
    ticket.session?.abort();
    ticket.terminate();
    await bounded(ticket.directExit);
    if (ticket.session) await bounded(ticket.session.closed);
    const log = fs.mkdtempSync(path.join(root, mode + "-"));
    fs.writeFileSync(path.join(log, "evidence.json"), JSON.stringify(ticket.snapshot(), null, 2));
  });
  return { ticket, budget };
}
test("real inherited FIFOs handshake, multi-round requests and authenticated close without Node IPC", supported, async t => {
  const { ticket, budget } = launch(t);
  const ready = await bounded(ticket.ready), session = ticket.session;
  assert.equal(ready.authenticated, true); assert.equal(ticket.snapshot().nodeIPC, false);
  assert.equal((await session.request(1, Buffer.alloc(0))).toString(), "NOIPC");
  for (const bytes of [Buffer.from([0, 255, 10]), Buffer.alloc(4096, 7), Buffer.from("third")]) {
    assert.deepEqual(await session.request(2, bytes), bytes);
  }
  assert.deepEqual(await session.request(3, Buffer.from("async timer")), Buffer.from("async timer"));
  assert.throws(() => session.request(99, Buffer.alloc(0)), { code: "ERR_BOUNDED_SESSION_OPERATION" });
  const pending = session.request(2, Buffer.from("one writer"));
  assert.throws(() => session.request(2, Buffer.alloc(0)), { code: "ERR_BOUNDED_SESSION_BUSY" });
  await pending; await session.close();
  const closed = await session.closed;
  assert.equal(closed.state, "closed"); assert.equal(closed.incomingFrames, 8);
  assert.ok(closed.maxReadBytes <= 4096); assert.equal(closed.executionAuthorized, false);
  await bounded(ticket.directExit);
  assert.equal(budget.snapshot().directExits, 1); assert.equal(budget.snapshot().sessions, 1);
  assert.equal(budget.snapshot().treeExitProven, false);
});
test("close does not establish direct exit or recycle budget while controlled child stays alive", supported, async t => {
  const budget = new SessionBudget({ maxSessions: 1 }), { ticket } = launch(t, "hold-exit", { budget });
  await ticket.ready; await ticket.session.close(); await ticket.session.closed;
  assert.equal(ticket.snapshot().directExitObserved, false);
  assert.equal(budget.snapshot().sessions, 1); assert.equal(budget.snapshot().chargesRetained, true);
  assert.throws(() => startBoundedSession({ modulePath: path.join(__dirname, "fixtures/permit-witness-bounded-session-peer.js"),
    runtimeDirectory: root, budget, deadlineNs: deadline() }), { code: "ERR_BOUNDED_SESSION_ADMISSION" });
  ticket.terminate(); await bounded(ticket.directExit);
  assert.equal(budget.snapshot().sessions, 1);
});
for (const [mode, code] of [["bad-handshake", "MAC"], ["mac", "MAC"], ["direction", "DOMAIN"], ["session", "DOMAIN"],
  ["sequence", "SEQUENCE"], ["replay", "SEQUENCE"], ["request-id", "CORRELATION"], ["operation", "CORRELATION"],
  ["binding", "CORRELATION"], ["child-request", "UNEXPECTED_MESSAGE"], ["oversize", "LENGTH"], ["truncated", "TRUNCATED"], ["disconnect", "DISCONNECTED"]]) {
  test(`real child finite ${mode} frame is terminally refused`, supported, async t => {
    const { ticket } = launch(t, mode);
    if (mode === "bad-handshake") await assert.rejects(bounded(ticket.ready), { code: "ERR_BOUNDED_SESSION_" + code });
    else {
      await bounded(ticket.ready);
      if (mode === "replay") await ticket.session.request(2, Buffer.from("first"));
      await assert.rejects(bounded(ticket.session.request(2, Buffer.from("second"))), { code: "ERR_BOUNDED_SESSION_" + code });
    }
    const final = await bounded(ticket.session.closed);
    assert.equal(final.state, "ERR_BOUNDED_SESSION_" + code);
    ticket.session.abort(); assert.deepEqual(ticket.session.snapshot(), final);
  });
}
test("one absolute deadline terminates a stalled round; direct exit remains separate", supported, async t => {
  const deadlineNs = deadline(700), { ticket, budget } = launch(t, "stall", { deadlineNs });
  await ticket.ready;
  await assert.rejects(bounded(ticket.session.request(2, Buffer.from("wait"))), { code: "ERR_BOUNDED_SESSION_DEADLINE" });
  assert.ok(process.hrtime.bigint() >= deadlineNs);
  assert.equal((await ticket.session.closed).state, "ERR_BOUNDED_SESSION_DEADLINE");
  assert.equal(budget.snapshot().chargesRetained, true);
});
test("absolute deadline is shared by progressing rounds and ignores late child work", supported, async t => {
  const deadlineNs = deadline(500), { ticket } = launch(t, "late", { deadlineNs });
  await ticket.ready;
  await assert.rejects(bounded(ticket.session.request(2, Buffer.from("late"))), { code: "ERR_BOUNDED_SESSION_DEADLINE" });
  const final = await ticket.session.closed;
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(ticket.session.snapshot(), final);
});
test("finite maximum writes encounter a real paused FIFO and remain subject to deadline", supported, async t => {
  // Keep the child read descriptor open but do not read: this is kernel FIFO
  // backpressure, not a delayed write callback or a simulated stream.
  const budget = new SessionBudget(), { ticket } = launch(t, "paused-reader", {
    budget, deadlineNs: deadline(700), maxPayloadBytes: 65536 });
  await ticket.ready;
  await assert.rejects(bounded(ticket.session.request(2, Buffer.alloc(65536, 7))), { code: "ERR_BOUNDED_SESSION_DEADLINE" });
  assert.ok(ticket.session.snapshot().writeWaits > 0);
  assert.equal(budget.snapshot().chargesRetained, true);
});
test("abort closes pending read and writer without releasing worker or byte reservation", supported, async t => {
  const { ticket, budget } = launch(t, "stall"); await ticket.ready;
  const pending = ticket.session.request(2, Buffer.from("cancel")); ticket.session.abort();
  await assert.rejects(pending, { code: "ERR_BOUNDED_SESSION_ABORTED" });
  assert.equal((await ticket.session.closed).state, "ERR_BOUNDED_SESSION_ABORTED");
  assert.equal(budget.snapshot().sessions, 1);
});
test("raw received quota is exact before each syscall including concurrent sessions", supported, async t => {
  const budget = new SessionBudget({ maxReceivedBytes: OVERHEAD + 32 + 5 });
  const read = fs.readSync;
  let calls = 0;
  t.mock.method(fs, "readSync", function (fd, buffer, offset, count, position) {
    assert.ok(count > 0 && count <= budget.snapshot().maxReceivedBytes - budget.snapshot().receivedBytes);
    calls++; return read(fd, buffer, offset, count, position);
  });
  const { ticket } = launch(t, "normal", { budget }); await ticket.ready;
  await assert.rejects(bounded(ticket.session.request(1, Buffer.alloc(0))), { code: "ERR_BOUNDED_SESSION_TOTAL_RECEIVED" });
  assert.equal(budget.snapshot().receivedBytes, budget.snapshot().maxReceivedBytes);
  assert.ok(calls > 2);
  const other = launch(t, "normal", { budget }).ticket;
  await assert.rejects(bounded(other.ready), { code: "ERR_BOUNDED_SESSION_TOTAL_RECEIVED" });
  assert.equal(budget.snapshot().receivedBytes, budget.snapshot().maxReceivedBytes);
});
test("frame count and send byte quotas fail closed without reset", supported, async t => {
  const { ticket } = launch(t, "normal", { maxFrames: 2 }); await ticket.ready;
  await ticket.session.request(1, Buffer.alloc(0));
  await assert.rejects(ticket.session.request(1, Buffer.alloc(0)), { code: "ERR_BOUNDED_SESSION_FRAME_LIMIT" });
  const budget = new SessionBudget({ maxSentBytes: OVERHEAD + 32 });
  const other = launch(t, "normal", { budget }).ticket; await other.ready;
  await assert.rejects(other.session.request(1, Buffer.alloc(0)), { code: "ERR_BOUNDED_SESSION_TOTAL_SENT" });
  assert.equal(budget.snapshot().sentBytes, OVERHEAD + 32);
});

// Failure injection below changes only local OS-call results/clock checkpoints.
// Lifecycle stubs test uncertainty classification, not a working byte channel.
function startOptions(budget = new SessionBudget()) {
  return { modulePath: path.join(__dirname, "fixtures/permit-witness-bounded-session-peer.js"),
    runtimeDirectory: root, budget, deadlineNs: deadline(), allowedOperations: [1, 2, 3] };
}
async function pendingAfterTurn(promise) {
  let done = false; void promise.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
}
function assertRetained(budget) {
  assert.equal(budget.snapshot().sessions, 1);
  assert.ok(budget.snapshot().capacityBytes > 0);
  assert.equal(budget.snapshot().chargesRetained, true);
}
function captureKeys(t) {
  const buffers = [], random = crypto.randomBytes, alloc = Buffer.alloc;
  t.mock.method(crypto, "randomBytes", size => { const bytes = random(size); buffers.push(bytes); return bytes; });
  t.mock.method(Buffer, "alloc", function (size, ...args) {
    const bytes = alloc(size, ...args); if (size === 56) buffers.push(bytes); return bytes;
  });
  return () => { assert.ok(buffers.length > 0); for (const bytes of buffers) assert.ok(bytes.every(byte => byte === 0)); };
}
test("native asynchronous pre-spawn failure proves not-started but never direct exit or a refund", supported, async t => {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (file, args, options) => spawn(file, args, { ...options, cwd: path.join(root, "missing-cwd") }));
  const budget = new SessionBudget(), ticket = startBoundedSession(startOptions(budget));
  await assert.rejects(bounded(ticket.ready));
  assert.deepEqual(await bounded(ticket.directExit), { kind: "not-started" });
  const final = ticket.snapshot();
  assert.equal(final.launchState, "not-started"); assert.equal(final.launchUncertain, false);
  assert.equal(final.directExitObserved, false); assert.equal(budget.snapshot().directExits, 0); assertRetained(budget);
});
test("generic asynchronous launch error and close without a PID retain unknown lifecycle", supported, async t => {
  let child, kills = 0;
  t.mock.method(childProcess, "spawn", () => {
    child = new EventEmitter(); child.spawnfile = process.execPath;
    child.kill = () => { kills++; return false; };
    queueMicrotask(() => { child.emit("error", new Error("injected generic failure")); child.emit("close", 1, null); });
    return child;
  });
  const budget = new SessionBudget(), ticket = startBoundedSession(startOptions(budget));
  await assert.rejects(ticket.ready);
  await pendingAfterTurn(ticket.directExit);
  assert.equal(ticket.snapshot().launchState, "uncertain"); assert.equal(ticket.snapshot().launchUncertain, true);
  assert.equal(ticket.snapshot().directExitObserved, false); assert.equal(ticket.snapshot().terminationAttempted, false);
  assert.equal(kills, 0); assert.equal(ticket.terminate(), false);
  assert.equal(budget.snapshot().directExits, 0); assertRetained(budget);
});
test("real spawned child error stays uncertain through failed termination until actual exit", supported, async t => {
  const spawn = childProcess.spawn; let realChild, terminate, killChecks = 0, ticket;
  t.mock.method(childProcess, "spawn", (...args) => {
    realChild = spawn(...args); terminate = realChild.kill.bind(realChild);
    realChild.kill = () => {
      killChecks++; assert.equal(ticket.snapshot().launchUncertain, true);
      assert.equal(ticket.snapshot().directExitObserved, false); throw new Error("injected kill failure");
    };
    realChild.once("spawn", () => setImmediate(() => realChild.emit("error", new Error("injected post-spawn error"))));
    return realChild;
  });
  const budget = new SessionBudget(); ticket = startBoundedSession(startOptions(budget));
  t.after(async () => { terminate("SIGKILL"); await bounded(ticket.directExit); });
  await assert.rejects(bounded(ticket.ready), { code: "ERR_BOUNDED_SESSION_SPAWN" });
  assert.ok(killChecks > 0); assert.equal(ticket.snapshot().cleanupFailed, true); assertRetained(budget);
  terminate("SIGKILL"); const exited = await bounded(ticket.directExit);
  assert.equal(exited.kind, "exited"); assert.equal(ticket.snapshot().directExitObserved, true);
  assert.equal(ticket.snapshot().launchUncertain, false); assert.equal(budget.snapshot().directExits, 1); assertRetained(budget);
});
test("synchronous spawn throw is uncertain; fallback closes every prepared fd and wipes synthetic keys", supported, async t => {
  const verifyKeys = captureKeys(t), opened = [], directories = [], open = fs.openSync, mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); opened.push(fd); return fd; });
  t.mock.method(fs, "mkdtempSync", (...args) => { const directory = mkdtemp(...args); directories.push(directory); return directory; });
  t.mock.method(childProcess, "spawn", () => { throw new Error("injected uncertain spawn"); });
  const budget = new SessionBudget(), ticket = startBoundedSession(startOptions(budget));
  await assert.rejects(ticket.ready, /injected uncertain spawn/); await pendingAfterTurn(ticket.directExit);
  assert.equal(ticket.snapshot().launchUncertain, true); assert.equal(opened.length, 6);
  for (const fd of opened) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
  verifyKeys(); assertRetained(budget);
});
for (const step of ["mkdtempSync", "chmodSync", "mkfifo", "read-open", "write-open", "key", "session", "bootstrap", "spawn-args"]) {
  test(`same short deadline stops after ${step} and forbids spawn with fallback cleanup`, supported, async t => {
    const sample = process.hrtime.bigint(), until = sample + 200000000n;
    let expired = false, spawns = 0, fifos = 0;
    const directories = [], opened = [], mkdtemp = fs.mkdtempSync, open = fs.openSync, sync = childProcess.spawnSync;
    // Both production timeout calculation and its assertion see THIS sample;
    // real helper runtime cannot consume an unrelated later timing sample.
    t.mock.method(process.hrtime, "bigint", () => expired ? until : sample);
    t.mock.method(fs, "mkdtempSync", (...args) => {
      const value = mkdtemp(...args); directories.push(value); if (step === "mkdtempSync") expired = true; return value;
    });
    const chmod = fs.chmodSync;
    t.mock.method(fs, "chmodSync", (...args) => { const value = chmod(...args); if (step === "chmodSync") expired = true; return value; });
    t.mock.method(childProcess, "spawnSync", (...args) => {
      fifos++; const remaining = until - sample;
      assert.ok(BigInt(args[2].timeout) * 1000000n <= remaining);
      assert.equal(args[2].killSignal, "SIGKILL");
      const value = sync(...args); if (step === "mkfifo") expired = true; return value;
    });
    t.mock.method(fs, "openSync", (...args) => {
      const fd = open(...args); opened.push(fd);
      if (step === "read-open" || (step === "write-open" && opened.length === 2)) expired = true;
      return fd;
    });
    const random = crypto.randomBytes, synthetic = [], alloc = Buffer.alloc;
    t.mock.method(crypto, "randomBytes", size => {
      const bytes = random(size); synthetic.push(bytes);
      if ((step === "key" && size === 32) || (step === "session" && size === 16)) expired = true;
      return bytes;
    });
    t.mock.method(Buffer, "alloc", (size, ...args) => {
      const bytes = alloc(size, ...args);
      if (size === 56) { synthetic.push(bytes); if (step === "bootstrap") expired = true; }
      return bytes;
    });
    t.mock.method(childProcess, "spawn", () => { spawns++; throw new Error("late spawn forbidden"); });
    const args = [];
    if (step === "spawn-args") args[Symbol.iterator] = function* () { expired = true; };
    const budget = new SessionBudget(), ticket = startBoundedSession({ ...startOptions(budget), args, deadlineNs: until });
    await assert.rejects(ticket.ready, { code: "ERR_BOUNDED_SESSION_DEADLINE" });
    assert.deepEqual(await ticket.directExit, { kind: "not-started" });
    assert.equal(spawns, 0); assert.equal(ticket.snapshot().launchUncertain, false);
    for (const fd of opened) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    for (const directory of directories) assert.equal(fs.existsSync(directory), false);
    for (const bytes of synthetic) assert.ok(bytes.every(byte => byte === 0));
    if (!["mkdtempSync", "chmodSync"].includes(step)) assert.ok(fifos > 0);
    assertRetained(budget);
  });
}
test("sub-millisecond remainder refuses mkfifo rather than disabling its timeout", supported, async t => {
  const now = process.hrtime.bigint.bind(process.hrtime), until = now() + 100000000n;
  const chmod = fs.chmodSync; let fractional = false, calls = 0;
  t.mock.method(process.hrtime, "bigint", () => fractional ? until - 500000n : now());
  t.mock.method(fs, "chmodSync", (...args) => { const value = chmod(...args); fractional = true; return value; });
  t.mock.method(childProcess, "spawnSync", () => { calls++; throw new Error("must not run"); });
  const ticket = startBoundedSession({ ...startOptions(), deadlineNs: until });
  await assert.rejects(ticket.ready, { code: "ERR_BOUNDED_SESSION_DEADLINE" });
  assert.equal(calls, 0); assert.deepEqual(await ticket.directExit, { kind: "not-started" });
});
test("post-spawn bootstrap failure invokes fallback termination, fd cleanup and key wipe", supported, async t => {
  const verifyKeys = captureKeys(t), opened = [], open = fs.openSync, write = fs.writeSync;
  t.mock.method(fs, "openSync", (...args) => { const fd = open(...args); opened.push(fd); return fd; });
  t.mock.method(fs, "writeSync", (fd, bytes, ...args) => {
    if (Buffer.isBuffer(bytes) && bytes.length === 56) throw new Error("injected bootstrap write failure");
    return write(fd, bytes, ...args);
  });
  const budget = new SessionBudget(), ticket = startBoundedSession(startOptions(budget));
  t.after(async () => { ticket.terminate(); await bounded(ticket.directExit); });
  await assert.rejects(ticket.ready, /injected bootstrap write failure/);
  assert.equal(ticket.snapshot().terminationAttempted, true);
  for (const fd of opened) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  verifyKeys(); assertRetained(budget);
  assert.equal((await bounded(ticket.directExit)).kind, "exited");
});
for (const mode of ["child-copy-failure", "child-post-copy-failure"]) {
  test(`real child ${mode} clears bootstrap and every owned key copy`, supported, async t => {
    const directory = fs.mkdtempSync(path.join(root, "key-cleanup-"));
    const { ticket, budget } = launch(t, mode, { runtimeDirectory: directory });
    await assert.rejects(bounded(ticket.ready)); await bounded(ticket.directExit);
    const proof = JSON.parse(fs.readFileSync(path.join(directory, "key-cleanup.json"), "utf8"));
    assert.deepEqual(proof, { rejected: true, copies: mode === "child-copy-failure" ? 2 : 3, cleared: true, nodeIPC: false });
    assertRetained(budget);
  });
}
test("mkfifo timeout kills a controlled stalled helper within the remaining preparation budget", supported, async t => {
  const sync = childProcess.spawnSync; let helpers = 0, spawns = 0;
  t.mock.method(childProcess, "spawnSync", (file, args, options) => {
    helpers++; assert.ok(options.timeout > 0 && options.timeout <= 80);
    const result = sync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)"], options);
    assert.equal(result.error?.code, "ETIMEDOUT"); assert.equal(result.signal, "SIGKILL"); return result;
  });
  t.mock.method(childProcess, "spawn", () => { spawns++; throw new Error("late launch forbidden"); });
  const budget = new SessionBudget(), ticket = startBoundedSession({ ...startOptions(budget), deadlineNs: deadline(80) });
  await assert.rejects(ticket.ready, { code: "ERR_BOUNDED_SESSION_DEADLINE" });
  assert.equal(helpers, 1); assert.equal(spawns, 0);
  assert.deepEqual(await ticket.directExit, { kind: "not-started" }); assertRetained(budget);
});
test("handshake deadline triggers fallback termination while only actual exit proves termination", supported, async t => {
  const { ticket, budget } = launch(t, "no-handshake", { deadlineNs: deadline(200) });
  await assert.rejects(bounded(ticket.ready), { code: "ERR_BOUNDED_SESSION_DEADLINE" });
  assert.equal(ticket.snapshot().terminationAttempted, true);
  const exited = await bounded(ticket.directExit);
  assert.equal(exited.kind, "exited"); assert.equal(exited.signal, "SIGKILL");
  assert.equal(ticket.snapshot().directExitObserved, true); assertRetained(budget);
});
test("partial FIFO open failure closes earlier descriptors and removes prepared paths", supported, async t => {
  const open = fs.openSync, opened = [], mkdtemp = fs.mkdtempSync, directories = [];
  t.mock.method(fs, "mkdtempSync", (...args) => { const directory = mkdtemp(...args); directories.push(directory); return directory; });
  t.mock.method(fs, "openSync", (...args) => {
    if (opened.length === 1) throw new Error("injected writer open failure");
    const fd = open(...args); opened.push(fd); return fd;
  });
  const budget = new SessionBudget(), ticket = startBoundedSession(startOptions(budget));
  await assert.rejects(ticket.ready, /injected writer open failure/);
  assert.deepEqual(await ticket.directExit, { kind: "not-started" });
  assert.throws(() => fs.fstatSync(opened[0]), { code: "EBADF" });
  assert.ok(directories.every(directory => !fs.existsSync(directory))); assertRetained(budget);
});

for (const operation of ["unlink", "rmdir"]) {
  test(`cleanup ${operation} failure is observable, retried and preserves authenticated close`, supported, async t => {
    const mkdtemp = fs.mkdtempSync, unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
    let directory, attempts = 0, failed = false;
    t.mock.method(fs, "mkdtempSync", (...args) => {
      const value = mkdtemp(...args);
      if (path.basename(value).startsWith("bounded-session-")) directory = value;
      return value;
    });
    t.mock.method(fs, operation === "unlink" ? "unlinkSync" : "rmdirSync", file => {
      const target = operation === "unlink" ? path.join(directory || "", "requests") : directory;
      if (file === target) {
        attempts++;
        if (!failed) { failed = true; throw Object.assign(new Error("injected cleanup failure"), { code: operation === "unlink" ? "EACCES" : "EBUSY" }); }
      }
      return (operation === "unlink" ? unlink : rmdir)(file);
    });
    const spawn = childProcess.spawn; let childClosed;
    t.mock.method(childProcess, "spawn", (...args) => {
      const child = spawn(...args); childClosed = new Promise(resolve => child.once("close", resolve)); return child;
    });
    const { ticket, budget } = launch(t, "hold-exit");
    await ticket.ready;
    assert.equal(ticket.snapshot().cleanupFailed, true);
    assert.deepEqual(ticket.snapshot().cleanupErrors, [{ operation, name: operation === "unlink" ? "requests" : "directory", code: operation === "unlink" ? "EACCES" : "EBUSY" }]);
    await ticket.session.close(); const business = await ticket.session.closed;
    assert.equal(business.state, "closed");
    ticket.terminate(); await ticket.directExit; await childClosed;
    assert.equal(attempts, 2); assert.equal(fs.existsSync(directory), false);
    assert.equal(ticket.snapshot().cleanupFailed, true); // historical failure stays visible after successful retry
    assert.deepEqual(ticket.session.snapshot(), business); assertRetained(budget);
    assert.ok(Object.isFrozen(ticket.snapshot().cleanupErrors));
  });
}
test("ENOENT cleanup is idempotent and later same-name files are never revisited", supported, async t => {
  const mkdtemp = fs.mkdtempSync, unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
  let directory, missing = 0, removals = 0;
  t.mock.method(fs, "mkdtempSync", (...args) => {
    const value = mkdtemp(...args); if (path.basename(value).startsWith("bounded-session-")) directory = value; return value;
  });
  t.mock.method(fs, "unlinkSync", file => {
    if (file === path.join(directory || "", "requests")) {
      removals++; unlink(file); missing++;
      throw Object.assign(new Error("already gone"), { code: "ENOENT" });
    }
    return unlink(file);
  });
  const spawn = childProcess.spawn; let childClosed;
  t.mock.method(childProcess, "spawn", (...args) => {
    const child = spawn(...args); childClosed = new Promise(resolve => child.once("close", resolve)); return child;
  });
  const { ticket } = launch(t, "hold-exit"); await ticket.ready;
  assert.equal(missing, 1); assert.equal(ticket.snapshot().cleanupFailed, false);
  assert.deepEqual(ticket.snapshot().cleanupErrors, []);
  // Once our directory has gone, reusing its old name must not authorize any
  // later cleanup to touch the replacement directory or its contents.
  fs.mkdirSync(directory); const replacement = path.join(directory, "requests");
  fs.writeFileSync(replacement, "later occupant");
  await ticket.session.close(); const business = await ticket.session.closed;
  ticket.terminate(); await ticket.directExit; await childClosed;
  assert.equal(removals, 1); assert.equal(fs.readFileSync(replacement, "utf8"), "later occupant");
  assert.equal(ticket.snapshot().cleanupFailed, false); assert.deepEqual(ticket.session.snapshot(), business);
  unlink(replacement); rmdir(directory);
});
test("unexpected directory contents survive nonrecursive cleanup and do not mask original failure", supported, async t => {
  const chmod = fs.chmodSync, rmdir = fs.rmdirSync, unlink = fs.unlinkSync;
  let directory, attempts = 0;
  t.mock.method(fs, "chmodSync", (file, mode) => {
    chmod(file, mode); directory = file;
    fs.writeFileSync(path.join(file, "unrelated"), "keep");
    throw new Error("original preparation failure");
  });
  t.mock.method(fs, "rmdirSync", file => { attempts++; return rmdir(file); });
  const budget = new SessionBudget(), ticket = startBoundedSession(startOptions(budget));
  await assert.rejects(ticket.ready, /original preparation failure/);
  assert.deepEqual(await ticket.directExit, { kind: "not-started" });
  assert.equal(attempts, 1); assert.equal(ticket.snapshot().cleanupFailed, true);
  assert.deepEqual(ticket.snapshot().cleanupErrors, [{ operation: "rmdir", name: "directory", code: "ENOTEMPTY" }]);
  assert.equal(fs.readFileSync(path.join(directory, "unrelated"), "utf8"), "keep"); assertRetained(budget);
  unlink(path.join(directory, "unrelated")); rmdir(directory);
});
