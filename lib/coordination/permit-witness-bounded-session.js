"use strict";

// Independent DEVELOPMENT candidate. Trusted local parent chooses the fixed
// child entry, operations and shared budget. The child has no parent-call API.
// Synthetic session-key possession is not OS identity or witness authority.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { SessionBudget, admit, rawIO, positive, limits, reserveReceived, reserveSent } = require("./permit-witness-bounded-session-io");
const wire = require("./permit-witness-bounded-session-wire");
const { TYPES: T, failure, zero } = wire;
const retained = new Set(); // Strongly retain uncertain launch/direct-exit work.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function runtime() {
  if (process.platform === "win32" || Number(process.versions.node.split(".")[0]) !== 24) throw failure("RUNTIME_UNVERIFIED");
}
function deadline(value) {
  const now = process.hrtime.bigint();
  if (typeof value !== "bigint" || value <= now || value > now + 60000000000n) throw failure("DEADLINE");
}
function checkDeadline(value) { if (process.hrtime.bigint() >= value) throw failure("DEADLINE"); }
function pipe(directory, name, deadlineNs) {
  const file = path.join(directory, name);
  checkDeadline(deadlineNs);
  const timeout = Math.min(1000, Number((deadlineNs - process.hrtime.bigint()) / 1000000n));
  // A zero timeout disables spawnSync's limit. Refuse a sub-ms preparation
  // budget instead; integer-ms subprocess timeouts round DOWN, never up.
  if (timeout < 1) throw failure("DEADLINE");
  const made = childProcess.spawnSync("/usr/bin/mkfifo", ["-m", "600", file], { env: {}, stdio: "ignore", timeout, killSignal: "SIGKILL" });
  checkDeadline(deadlineNs);
  if (made.error?.code === "ETIMEDOUT") throw failure("DEADLINE");
  if (made.status !== 0) throw failure("PIPE_UNAVAILABLE");
  let r, w;
  try {
    r = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    checkDeadline(deadlineNs);
    w = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    checkDeadline(deadlineNs);
    return [r, w];
  } catch (e) {
    for (const fd of [r, w]) if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    throw e;
  }
}
function endpoint({ role, readFd, writeFd, key, session, deadlineNs, account, profile, maxPayloadBytes, maxFrames, operations, handler }) {
  const parent = role === "parent", ready = deferred(), closed = deferred();
  let state = parent ? "hello" : "await-hello", inSeq = 0, outSeq = 0, requestId = 0, pending = null, busy = false;
  let challenge, helloDigest, timer, successfulClose = false, helloWritten = false, helloReply = false;
  const inbound = parent ? 2 : 1, outbound = parent ? 1 : 2;
  const io = rawIO({ readFd, writeFd, deadlineNs, account, profile, maxPayloadBytes, maxFrames,
    onFrame, onEOF: () => { if (!successfulClose) fail(failure("DISCONNECTED")); }, onFailure: fail });
  function snapshot() { return Object.freeze({ state, role, profile, maxPayloadBytes, maxFrameBytes: maxPayloadBytes + wire.OVERHEAD, maxFrames,
    ...io.snapshot(), authenticated: state === "ready" || state === "closing" || successfulClose,
    provenance: "session-key-holder", executionAuthorized: false, treeExitProven: false }); }
  function finish() { clearTimeout(timer); io.stop(); key.fill(0); session.fill(0); closed.resolve(snapshot()); }
  function fail(e) {
    if (state === "closed" || state.startsWith("ERR_")) return;
    const reason = e?.code?.startsWith("ERR_BOUNDED_SESSION_") ? e : failure("PROTOCOL");
    state = reason.code; ready.reject(reason);
    if (pending) { pending.reject(reason); pending = null; }
    finish();
  }
  function send(type, id, operation, binding, payload) {
    io.check();
    if (payload.length > maxPayloadBytes) throw failure("PAYLOAD_LENGTH");
    const { frame, writing } = io.buildAndWrite(wire.OVERHEAD + payload.length, () => wire.encode(key, session,
      { direction: outbound, type, seq: ++outSeq, requestId: id, operation, binding, payload }));
    writing.catch(fail);
    return { writing, digest: wire.digest(frame) };
  }
  function match(message) {
    if (!pending || message.requestId !== pending.id || message.operation !== pending.operation || !message.binding.equals(pending.binding)) throw failure("CORRELATION");
  }
  function settlePending() {
    if (!pending || !pending.written || !pending.reply) return;
    io.check();
    const done = pending; pending = null;
    if (state === "closing") {
      successfulClose = true; state = "closed"; done.resolve(); finish();
    } else done.resolve(done.reply.payload);
  }
  function onFrame(frame) {
    io.check();
    const m = wire.decode(key, session, frame, inbound, ++inSeq);
    if (!parent && state === "await-hello") {
      if (m.type !== T.HELLO || m.requestId || m.operation || !m.binding.equals(zero) || m.payload.length !== 32) throw failure("HANDSHAKE");
      state = "hello-ack";
      send(T.HELLO_ACK, 0, 0, m.digest, m.payload).writing.then(() => {
        if (state !== "hello-ack") return;
        state = "ready"; ready.resolve(snapshot());
      }, fail);
      return;
    }
    if (parent && state === "hello") {
      if (m.type !== T.HELLO_ACK || m.requestId || m.operation || !m.binding.equals(helloDigest) || !m.payload.equals(challenge)) throw failure("HANDSHAKE");
      if (helloReply) throw failure("HANDSHAKE");
      helloReply = true;
      if (helloWritten) { state = "ready"; ready.resolve(snapshot()); }
      return;
    }
    if (parent) {
      if (state === "ready" && m.type === T.RESPONSE) {
        match(m); if (pending.reply) throw failure("CORRELATION");
        pending.reply = m; settlePending(); return;
      }
      if (state === "closing" && m.type === T.CLOSE_ACK && !m.payload.length) {
        match(m); if (pending.reply) throw failure("CORRELATION");
        if (profile === "v2") io.pauseReader(); // No speculative next header after authenticated close.
        pending.reply = m; settlePending(); return;
      }
      throw failure("UNEXPECTED_MESSAGE"); // Child REQUEST is never dispatched.
    }
    if (state !== "ready" || busy) throw failure("UNEXPECTED_MESSAGE");
    if (m.requestId !== requestId + 1 || !m.binding.equals(zero)) throw failure("CORRELATION");
    requestId = m.requestId;
    if (m.type === T.CLOSE && !m.operation && !m.payload.length) {
      if (profile === "v2") io.pauseReader();
      state = "closing";
      send(T.CLOSE_ACK, m.requestId, 0, m.digest, Buffer.alloc(0)).writing.then(() => {
        if (state !== "closing") return;
        successfulClose = true; state = "closed"; finish();
      }, fail);
      return;
    }
    if (m.type !== T.REQUEST || !operations.has(m.operation)) throw failure("OPERATION");
    busy = true;
    // Handler exists ONLY in the untrusted child process. Parent executes no
    // child-selected callbacks; authenticated output remains untrusted bytes.
    Promise.resolve().then(() => handler(m.operation, m.payload)).then(payload => {
      io.check();
      if (!Buffer.isBuffer(payload) || payload.length > maxPayloadBytes) throw failure("PAYLOAD_LENGTH");
      return send(T.RESPONSE, m.requestId, m.operation, m.digest, payload).writing;
    }).then(() => { busy = false; }, fail);
  }
  function exchange(type, operation, payload) {
    io.check();
    if (!parent || state !== "ready" || pending) throw failure("BUSY");
    if (!Buffer.isBuffer(payload) || payload.length > maxPayloadBytes) throw failure("PAYLOAD_LENGTH");
    if (type === T.REQUEST && !operations.has(operation)) throw failure("OPERATION");
    const task = deferred();
    pending = { ...task, id: ++requestId, operation, binding: null, written: false, reply: null };
    const entry = pending;
    if (type === T.CLOSE) state = "closing";
    try {
      const sent = send(type, requestId, operation, zero, payload); entry.binding = sent.digest;
      sent.writing.then(() => { if (pending !== entry) return; entry.written = true; settlePending(); }, fail).catch(fail);
    }
    catch (e) { fail(e); }
    return task.promise;
  }
  function armDeadline() {
    const remaining = deadlineNs - process.hrtime.bigint();
    if (remaining <= 0n) { fail(failure("DEADLINE")); return; }
    timer = setTimeout(armDeadline, Number((remaining + 999999n) / 1000000n));
  }
  try {
    if (parent) challenge = crypto.randomBytes(32);
    armDeadline();
    void io.readLoop();
    if (parent) {
      const hello = send(T.HELLO, 0, 0, zero, challenge); helloDigest = hello.digest;
      hello.writing.then(() => {
        if (state !== "hello") return;
        helloWritten = true; if (helloReply) { state = "ready"; ready.resolve(snapshot()); }
      }, fail);
    }
  } catch (e) { fail(e); }
  return Object.freeze({ ready: ready.promise, closed: closed.promise, snapshot,
    request: (operation, bytes) => exchange(T.REQUEST, operation, bytes),
    close: () => exchange(T.CLOSE, 0, Buffer.alloc(0)), abort: () => fail(failure("ABORTED")), fail,
    directExit: () => { if (state !== "closing") fail(failure("DIRECT_EXIT")); } });
}
function startBoundedSession({ modulePath, args = [], runtimeDirectory, budget, deadlineNs,
  profile = "default", maxPayloadBytes, maxFrames, allowedOperations = [1] } = {}) {
  runtime(); deadline(deadlineNs);
  ({ maxPayloadBytes, maxFrames } = limits(profile, maxPayloadBytes, maxFrames));
  if (!path.isAbsolute(modulePath) || fs.realpathSync(modulePath) !== modulePath) throw new TypeError("fixed real child entry required");
  checkDeadline(deadlineNs);
  if (!fs.statSync(modulePath).isFile()) throw new TypeError("fixed real child entry required");
  checkDeadline(deadlineNs);
  if (!path.isAbsolute(runtimeDirectory) || !fs.statSync(runtimeDirectory).isDirectory()) throw new TypeError("local runtime directory required");
  checkDeadline(deadlineNs);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new TypeError("local args required");
  if (!Array.isArray(allowedOperations) || !allowedOperations.length || allowedOperations.length > 64) throw new TypeError("fixed operations required");
  const operations = new Set(allowedOperations.map(n => positive(n, 65535)));
  const account = admit(budget, maxPayloadBytes, maxFrames, profile), ready = deferred(), directExit = deferred();
  const record = { child: null, session: null, directExitObserved: false, launchUncertain: false,
    launchState: "preparing", terminationAttempted: false, cleanupFailed: false };
  retained.add(record);
  const fds = new Set(); let directory, launching = false, bootstrap, key, session, spawnObserved = false, failureCleaned = false;
  const pendingPaths = new Set(["requests", "responses", "bootstrap"]), cleanupErrors = new Map();
  function pathCleanupFailure(operation, name, e) {
    record.cleanupFailed = true;
    cleanupErrors.set(operation + ":" + name, Object.freeze({ operation, name, code: e?.code || "UNKNOWN" }));
  }
  function cleanupPaths() {
    if (!directory) return;
    for (const name of pendingPaths) {
      try { fs.unlinkSync(path.join(directory, name)); pendingPaths.delete(name); }
      catch (e) {
        if (e.code === "ENOENT") pendingPaths.delete(name);
        else pathCleanupFailure("unlink", name, e);
      }
    }
    // Never recurse or revisit a successfully removed name: a later occupant
    // is not ours. Failed names alone may be retried on exit/close.
    if (pendingPaths.size) return;
    try { fs.rmdirSync(directory); directory = null; }
    catch (e) {
      if (e.code === "ENOENT") directory = null;
      else pathCleanupFailure("rmdir", "directory", e);
    }
  }
  function cleanFailure(e) {
    if (failureCleaned) { ready.reject(e); return; }
    failureCleaned = true;
    // Fallback runs even if endpoint construction/terminal cleanup threw.
    try { record.session?.fail(e); } catch { record.cleanupFailed = true; }
    bootstrap?.fill(0);
    key?.fill(0); session?.fill(0);
    for (const fd of fds) { try { fs.closeSync(fd); } catch { record.cleanupFailed = true; } }
    fds.clear(); cleanupPaths(); ready.reject(e);
    if (Number.isInteger(record.child?.pid) && record.child.pid > 0 && record.launchState !== "not-started" && !record.directExitObserved) {
      record.terminationAttempted = true;
      try { if (!record.child.kill("SIGKILL")) record.cleanupFailed = true; }
      catch { record.cleanupFailed = true; }
    }
  }
  try {
    // Synchronous syscalls/spawnSync cannot be preempted by a JS timer. Check
    // after EVERY preparation step and before spawn; cleanup is never skipped
    // on expiry. This refuses late launch, not a hard realtime return bound.
    checkDeadline(deadlineNs);
    if (profile === "v2") reserveSent(account, 56);
    directory = fs.mkdtempSync(path.join(runtimeDirectory, "bounded-session-")); checkDeadline(deadlineNs);
    fs.chmodSync(directory, 0o700); checkDeadline(deadlineNs);
    function make(name) { const pair = pipe(directory, name, deadlineNs); pair.forEach(fd => fds.add(fd)); return pair; }
    const [childRead, parentWrite] = make("requests"), [parentRead, childWrite] = make("responses"), [secretRead, secretWrite] = make("bootstrap");
    key = crypto.randomBytes(32); checkDeadline(deadlineNs);
    session = crypto.randomBytes(16); checkDeadline(deadlineNs);
    bootstrap = Buffer.alloc(56); key.copy(bootstrap); session.copy(bootstrap, 32); bootstrap.writeBigUInt64BE(deadlineNs, 48);
    checkDeadline(deadlineNs);
    const childArgs = ["--unhandled-rejections=strict", modulePath, String(maxPayloadBytes), String(maxFrames), ...args];
    const childOptions = {
      cwd: runtimeDirectory, env: { PATH: "/usr/bin:/bin", TMPDIR: directory, TMP: directory, TEMP: directory,
        ...(process.platform === "darwin" ? { __CF_USER_TEXT_ENCODING: "0x0:0:0" } : {}) },
      stdio: ["ignore", "ignore", "ignore", childRead, childWrite, secretRead], detached: false,
    };
    checkDeadline(deadlineNs);
    launching = true;
    const child = childProcess.spawn(process.execPath, childArgs, childOptions);
    record.child = child;
    record.launchState = "attempted";
    child.once("spawn", () => { spawnObserved = true; if (!record.launchUncertain) record.launchState = "spawned"; });
    child.on("error", e => {
      if (!record.directExitObserved) {
        // Only the native pre-spawn error with no PID proves non-start. A
        // generic error, a returned handle or close/kill is NOT exit evidence.
        const notStarted = child instanceof childProcess.ChildProcess && !spawnObserved && child.pid === undefined &&
          typeof child.spawnfile === "string" && e.syscall === "spawn " + child.spawnfile && typeof e.errno === "number" && e.errno < 0;
        record.launchState = notStarted ? "not-started" : "uncertain";
        record.launchUncertain = !notStarted;
        if (notStarted) { directExit.resolve(Object.freeze({ kind: "not-started" })); retained.delete(record); }
      }
      cleanFailure(failure("SPAWN"));
    });
    child.once("exit", (code, signal) => {
      record.directExitObserved = true; account.directExits++;
      record.launchState = "exited"; record.launchUncertain = false;
      record.session?.directExit(); cleanupPaths(); directExit.resolve(Object.freeze({ kind: "exited", code, signal }));
      if (record.session) record.session.closed.then(() => retained.delete(record));
      else retained.delete(record);
    });
    child.once("close", cleanupPaths); // Cleanup wake-up only; NEVER exit proof.
    checkDeadline(deadlineNs);
    for (const fd of [childRead, childWrite, secretRead]) { fs.closeSync(fd); fds.delete(fd); checkDeadline(deadlineNs); }
    // Small fixed bootstrap fits the private FIFO; no key in env, argv or file.
    if (fs.writeSync(secretWrite, bootstrap) !== bootstrap.length) throw failure("BOOTSTRAP_WRITE");
    checkDeadline(deadlineNs);
    fs.closeSync(secretWrite); fds.delete(secretWrite); bootstrap.fill(0); checkDeadline(deadlineNs);
    record.session = endpoint({ role: "parent", readFd: parentRead, writeFd: parentWrite, key, session, deadlineNs,
      account, profile, maxPayloadBytes, maxFrames, operations });
    fds.delete(parentRead); fds.delete(parentWrite);
    record.session.ready.then(ready.resolve, cleanFailure);
    record.session.ready.then(cleanupPaths, cleanupPaths);
    record.session.closed.then(() => { if (record.directExitObserved) retained.delete(record); });
  } catch (e) {
    if (launching) { record.launchUncertain = true; record.launchState = "uncertain"; }
    else { record.launchState = "not-started"; directExit.resolve(Object.freeze({ kind: "not-started" })); retained.delete(record); }
    cleanFailure(e);
  }
  return Object.freeze({ ready: ready.promise, directExit: directExit.promise,
    get session() { return record.session; },
    terminate: () => Number.isInteger(record.child?.pid) && record.child.pid > 0 && !record.directExitObserved ? record.child.kill("SIGKILL") : false,
    snapshot: () => Object.freeze({ directExitObserved: record.directExitObserved, launchUncertain: record.launchUncertain,
      launchState: record.launchState, terminationAttempted: record.terminationAttempted, cleanupFailed: record.cleanupFailed,
      cleanupErrors: Object.freeze([...cleanupErrors.values()]),
      nodeIPC: record.child ? !!record.child.channel : null, budget: budget.snapshot(), session: record.session?.snapshot() ?? null, treeExitProven: false }) });
}
async function acceptBoundedSession({ handler, allowedOperations = [1], profile = "default", maxPayloadBytes, maxFrames } = {}) {
  runtime();
  if (process.send || process.channel || process.env.NODE_CHANNEL_FD) throw failure("NODE_IPC_PRESENT");
  if (typeof handler !== "function") throw new TypeError("child handler required");
  ({ maxPayloadBytes, maxFrames } = limits(profile, maxPayloadBytes, maxFrames));
  // The child entry independently opts in; neither argv nor frames select its
  // profile. Its finite local root must fit every admitted lifetime frame.
  const local = new SessionBudget(profile === "v2" ? { maxCapacityBytes: 67108864 } : {});
  const account = admit(local, maxPayloadBytes, maxFrames, profile);
  const fds = openChildPipes();
  // Bootstrap has fixed length and a short local startup deadline. Parent's
  // absolute deadline from this same machine is authoritative after bootstrap.
  let bootstrap, input, key, session, keyTransferred = false;
  try {
    if (profile === "v2") reserveReceived(account, 56);
    bootstrap = Buffer.alloc(56);
    input = rawIO({ readFd: fds.secret, writeFd: fds.secret, deadlineNs: process.hrtime.bigint() + 5000000000n,
      account, maxPayloadBytes, maxFrames, onFailure: () => {} });
    await input.readExact(bootstrap, 0, 56, false, profile === "v2");
    key = Buffer.from(bootstrap.subarray(0, 32)); session = Buffer.from(bootstrap.subarray(32, 48));
    const deadlineNs = bootstrap.readBigUInt64BE(48); deadline(deadlineNs);
    const accepted = endpoint({ role: "child", readFd: fds.read, writeFd: fds.write, key, session, deadlineNs, account,
      profile, maxPayloadBytes, maxFrames, operations: new Set(allowedOperations.map(n => positive(n, 65535))), handler });
    keyTransferred = true; return accepted;
  } catch (e) {
    for (const fd of [fds.read, fds.write]) { try { fs.closeSync(fd); } catch {} }
    throw e;
  } finally {
    if (input) input.stop(); else { try { fs.closeSync(fds.secret); } catch {} }
    bootstrap?.fill(0);
    if (!keyTransferred) { key?.fill(0); session?.fill(0); }
  }
}
function openChildPipes() {
  // Numeric stdio inheritance can reset blocking flags during process launch.
  // Reopen through the fixed private startup names using PUBLIC fs APIs, then
  // close the inherited copies. Parent unlinks names only after authenticated
  // HELLO_ACK. No private fd/handle manipulation and no blocking read fallback.
  const directory = process.env.TMPDIR;
  if (!directory || !path.isAbsolute(directory)) throw failure("PIPE_UNAVAILABLE");
  const fds = [];
  try {
    for (const [index, [name, flags]] of [["requests", fs.constants.O_RDONLY], ["responses", fs.constants.O_WRONLY], ["bootstrap", fs.constants.O_RDONLY]].entries()) {
      const fd = fs.openSync(path.join(directory, name), flags | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      fds.push(fd);
      const opened = fs.fstatSync(fd), inherited = fs.fstatSync(index + 3);
      if (!opened.isFIFO() || opened.dev !== inherited.dev || opened.ino !== inherited.ino) throw failure("PIPE_UNAVAILABLE");
    }
    for (const fd of [3, 4, 5]) fs.closeSync(fd);
    return { read: fds[0], write: fds[1], secret: fds[2] };
  } catch (e) { for (const fd of fds) { try { fs.closeSync(fd); } catch {} } throw e; }
}
module.exports = { SessionBudget, startBoundedSession, acceptBoundedSession, openChildPipes };
