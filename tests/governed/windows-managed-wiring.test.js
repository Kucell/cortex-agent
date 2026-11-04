"use strict";

// Windows control-flow models run on POSIX. They are deliberately NOT native
// pipe/handle-table evidence; native W1-W9 remain a separate acceptance gate.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const signing = require("../../lib/governed/managed-caller-signing");
const transportApi = require("../../lib/governed/managed-caller-transport");
const secret = "a".repeat(64);
const pipeName = "\\\\.\\pipe\\cortex-managed-caller-v1-" + "b".repeat(64);

function load(file, overrides = {}, platform = "win32") {
  const filename = path.resolve(__dirname, "../../lib", file);
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module: mod, Buffer, process: { platform, pid: process.pid, execPath: process.execPath, execArgv: [], env: {} },
    setTimeout, clearTimeout, setImmediate, queueMicrotask, AbortController, performance, __dirname: path.dirname(filename),
    require(name) { return overrides[name] || require(name.startsWith(".") ? path.resolve(path.dirname(filename), name) : name); },
  }, { filename });
  return mod.exports;
}

function bootstrap(value, pieces) {
  const stream = new PassThrough();
  const child = { stdio: [null, null, null, null, stream] };
  const promise = transportApi.readExecutorBootstrap(child);
  assert.equal(transportApi.readExecutorBootstrap(child), promise);
  for (const chunk of pieces || [JSON.stringify(value) + "\n"]) stream.write(chunk);
  stream.end();
  return { stream, child, promise };
}

test("bootstrap: one shared read, split bytes, closes fd4 before resolving", async () => {
  const value = { version: 1, transport: "windows-named-pipe", pipeName, secret };
  const raw = Buffer.from(JSON.stringify(value) + "\n");
  const b = bootstrap(value, [...raw].map(byte => Buffer.from([byte])));
  assert.deepEqual(await b.promise, value);
  assert.equal(b.stream.closed, true);
  assert.equal(transportApi.readExecutorBootstrap(b.child), b.promise);
});
for (const [name, change] of [
  ["version", v => ({ ...v, version: 2 })], ["unknown field", v => ({ ...v, pid: 1 })],
  ["secret encoding", v => ({ ...v, secret: "z".repeat(64) })],
  ["secret length", v => ({ ...v, secret: "a".repeat(63) })],
  ["prefix", v => ({ ...v, pipeName: "arbitrary" })],
  ["random segment", v => ({ ...v, pipeName: pipeName + "0" })],
]) test(`bootstrap rejects ${name} with fixed code and closed descriptor`, async () => {
  const b = bootstrap(change({ version: 1, transport: "windows-named-pipe", pipeName, secret }));
  await assert.rejects(b.promise, error => error.message === "ERR_BOOTSTRAP_INVALID" && !error.message.includes(secret));
  assert.equal(b.stream.closed, true);
});
for (const [name, data, code] of [
  ["truncation", "{", "ERR_BOOTSTRAP_TRUNCATED"],
  ["multiple records", "{}\n{}\n", "ERR_BOOTSTRAP_INVALID"],
  ["oversize", "x".repeat(1025), "ERR_BOOTSTRAP_TOO_LARGE"],
  ["invalid utf8", Buffer.from([0xff, 10]), "ERR_BOOTSTRAP_INVALID"],
]) test(`bootstrap rejects ${name}`, async () => {
  const b = bootstrap(null, [data]);
  await assert.rejects(b.promise, { message: code });
  assert.equal(b.stream.closed, true);
});

function sessionModel(change = () => {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 4321, exitCode: null, signalCode: null });
  const transport = new EventEmitter();
  transport.connected = true;
  transport.close = () => { transport.connected = false; };
  const sends = [];
  const initialFacts = { pid: child.pid, startToken: "win32:638000000000000001", commandDigest: "sha256:constant" };
  const end = (pid, objectId) => ({ ok: true, pids: [pid], detail: {
    roleMatches: 1, connectedMatches: 1, holderSets: 1, peerIsChild: 1, peerOther: 0,
    firstClientPid: child.pid, firstServerPid: process.pid, objectId, handleId: "0000000000000004",
    holderSetsClean: 1, holderSetsWithThirdParty: 0,
  } });
  let rounds = 0;
  const factSource = {
    readSocketHolders() { throw new Error("old heuristic must not run"); },
    isPreciseStartToken: token => /^win32:[0-9]+$/.test(token),
    collectProcessFacts(_child, binding) {
      const facts = { ...initialFacts, channelFacts: {
        server: end(process.pid, "FFFF000000000001"), client: end(child.pid, "FFFF000000000002"),
      } };
      change(facts, ++rounds, binding);
      return facts;
    },
  };
  const api = load("governed/managed-caller-session.js", {
    "./managed-caller-transport": { readTransportBinding: t => t === transport ? { pipeName } : null },
  });
  transport.send = message => {
    sends.push(message);
    if (message.type === api.CHANNEL_MESSAGE.HELLO) {
      const body = { nonce: message.nonce };
      queueMicrotask(() => transport.emit("message", { type: api.CHANNEL_MESSAGE.RESPONSE,
        sessionId: message.sessionId, requestId: message.requestId, nonce: message.nonce, body,
        mac: signing.signResponse(secret, { kind: api.SIGNED_MESSAGE_KIND.HELLO, requestId: message.requestId,
          operation: "hello", body }) }));
    }
    return Promise.resolve();
  };
  const session = new api.ManagedCallerSession({ child, transport, secret, sessionId: "generation", initialFacts,
    startupDeadline: Date.now() + 10000, factSource });
  return { child, transport, sends, session, api };
}

test("Windows: pre/post HELLO audits, private binding and synchronous audit contracts", async () => {
  const m = sessionModel();
  assert.equal(m.session.childIdentity, null);
  await m.session.handshake();
  assert.equal(m.session.established, true);
  assert.equal(m.sends.length, 1);
  const audit = m.session.auditChannelHolders();
  assert.equal(audit.ok, true);
  assert.equal(audit.then, undefined);
  assert.equal(m.session.auditProcessContinuity().ok, true);
  const publicIdentity = JSON.stringify(m.session.childIdentity);
  assert.equal(publicIdentity.includes(pipeName), false);
  assert.equal(publicIdentity.includes("FFFF"), false);
  assert.equal(m.session.childIdentity.socketEndpoint, null);
  await m.session.close();
  assert.equal(m.transport.connected, false);
});

for (const [name, mutate, reason] of [
  ["server transfer", f => f.channelFacts.server.pids.push(9001), "channel_handle_transferred"],
  ["client transfer", f => f.channelFacts.client.pids.push(9001), "channel_handle_transferred"],
  ["wrong peer", f => f.channelFacts.server.detail.peerOther = 1, "channel_peer_mismatch"],
  ["decoy", f => f.channelFacts.server.detail.connectedMatches = 2, "channel_endpoint_ambiguous"],
  ["unknown", f => f.channelFacts.client.ok = false, "channel_holders_unavailable"],
  ["pid reuse", f => f.startToken = "win32:638000000000000002", "process_replaced_pid_reuse"],
  ["command change", f => f.commandDigest = "sha256:changed", "process_command_changed"],
]) test(`Windows: ${name} rejects BEFORE HELLO and latches invalidation`, async () => {
  let attack = true;
  const m = sessionModel(f => { if (attack) mutate(f); });
  await assert.rejects(m.session.handshake(), { message: reason });
  assert.equal(m.sends.length, 0);
  attack = false;
  assert.equal(m.session.auditChannelHolders().ok, false);
  assert.equal(m.session.closed, true);
});

test("Windows: object replacement after HELLO prevents established", async () => {
  const m = sessionModel((f, round) => { if (round > 1) f.channelFacts.client.detail.objectId = "FFFF000000000003"; });
  await assert.rejects(m.session.handshake(), { message: "channel_endpoint_changed" });
  assert.equal(m.session.established, false);
});
test("Windows: pre-send transfer writes zero business frames; empty EOF is terminal", async () => {
  let attack = false;
  const m = sessionModel(f => { if (attack) f.channelFacts.client.pids.push(9001); });
  await m.session.handshake();
  attack = true;
  await assert.rejects(m.session.request("ping", { private: true }), /channel_handle_transferred/);
  assert.equal(m.sends.some(message => message.type === m.api.CHANNEL_MESSAGE.REQUEST), false);
  const other = sessionModel();
  await other.session.handshake();
  other.transport.emit("disconnect");
  assert.equal(other.session.closed, true);
});

function launchModel({ listenFailure = false, spawnFailure = false } = {}) {
  const steps = [];
  let child, bootstrapValue, spawnArgs, spawnOptions;
  const api = load("governed/managed-caller-supervisor.js", {
    "node:child_process": {
      fork() { throw new Error("Windows must never fork"); },
      spawn(executable, args, options) {
        steps.push("spawn");
        if (spawnFailure) throw new Error("native error with sensitive name");
        spawnArgs = [executable, args]; spawnOptions = options;
        child = new EventEmitter();
        Object.assign(child, { pid: 2345, exitCode: null, signalCode: null, stdio: [null, new PassThrough(), new PassThrough(), null, new PassThrough()] });
        child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
        child.stdio[4].on("data", chunk => { steps.push("bootstrap"); bootstrapValue = JSON.parse(chunk.toString()); });
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    },
    "./managed-caller-transport": {
      async listenWindowsTransport(options) {
        steps.push("listen");
        await Promise.resolve();
        if (listenFailure) throw new Error("native listen error");
        await options.onListening({ pipeName, close: () => {} });
        steps.push("connect");
        return Object.assign(new EventEmitter(), { connected: true, close() { this.connected = false; } });
      },
    },
    "./managed-caller-session": {
      newSessionId: () => "generation",
      ManagedCallerSession: class {
        constructor(options) { assert.ok(options.transport); this.childIdentity = {}; this.closed = false; }
        onRequest() {}
        async handshake() { steps.push("handshake"); }
        async close() { this.closed = true; }
      },
    },
  });
  const ticket = api.beginManagedCallerSession({ modulePath: "/fixed-executor.js", args: ["one"],
    handshakeTimeoutMs: 10000,
    factSource: { collectProcessFacts(child) { steps.push("facts"); return { pid: child.pid, startToken: "precise", commandDigest: "digest" }; },
      isPreciseStartToken: () => true },
    spawnOptions: { shell: true, detached: true, stdio: ["ipc"], execPath: "/untrusted", execArgv: ["--unhandled-rejections=strict"] },
  });
  return { ticket, steps, get child() { return child; }, get bootstrapValue() { return bootstrapValue; },
    get spawnArgs() { return spawnArgs; }, get spawnOptions() { return spawnOptions; } };
}
test("Windows launch: listen -> fixed spawn -> facts -> private bootstrap -> connect -> handshake", async () => {
  const m = launchModel();
  assert.deepEqual(m.steps, ["listen"]);
  const runtime = await m.ticket.ready;
  assert.deepEqual(m.steps, ["listen", "spawn", "facts", "bootstrap", "connect", "handshake"]);
  assert.equal(m.spawnArgs[0], process.execPath);
  assert.deepEqual(Array.from(m.spawnArgs[1]), ["--unhandled-rejections=strict", "/fixed-executor.js", "one"]);
  assert.deepEqual(Array.from(m.spawnOptions.stdio), ["ignore", "pipe", "pipe", "ignore", "pipe"]);
  assert.equal(m.spawnOptions.shell, false);
  assert.equal(m.spawnOptions.detached, false);
  assert.equal(m.spawnOptions.execPath, undefined);
  assert.equal(m.bootstrapValue.pipeName, pipeName);
  assert.match(m.bootstrapValue.secret, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(m.spawnArgs).includes(m.bootstrapValue.secret), false);
  let exited = false;
  m.ticket.directExit.then(() => { exited = true; });
  runtime.transport.close();
  await Promise.resolve();
  assert.equal(exited, false);
  m.child.emit("exit", 0, null);
  assert.equal((await m.ticket.directExit).kind, "exited");
});
test("Windows listen failure proves not-started; sync exception inside spawn stays uncertain", async () => {
  const before = launchModel({ listenFailure: true });
  await assert.rejects(before.ticket.ready, /ERR_WINDOWS_EXECUTOR_START_FAILED/);
  assert.deepEqual(before.steps, ["listen"]);
  assert.equal((await before.ticket.directExit).kind, "not-started");
  const after = launchModel({ spawnFailure: true });
  await assert.rejects(after.ticket.ready, /ERR_WINDOWS_EXECUTOR_START_FAILED/);
  let resolved = false;
  after.ticket.directExit.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
});

const cleanHolderOutput = [
  "HOLDERS=OK", "HOLDER_OBJECT=FFFF000000000001", "HOLDER_HANDLE=0000000000000004",
  "HOLDER_NAME_MATCHES=5", "HOLDER_ROLE_MATCHES=1", "HOLDER_CONNECTED_MATCHES=1",
  "HOLDER_PEER_IS_CHILD=1", "HOLDER_PEER_OTHER=0", "HOLDER_SETS=1", "HOLDER_SETS_CLEAN=1",
  "HOLDER_SETS_WITH_THIRD_PARTY=0", "HOLDER_MATCH_HAS_CLIENT=1", "HOLDER_MATCH_HAS_SERVER=5",
  "HOLDER_MATCH_FIRST_CLIENT_PID=4321", `HOLDER_MATCH_FIRST_SERVER_PID=${process.pid}`, "HOLDER_PIDS=4321",
].join("\n");
function parseHolders(stdout) {
  return load("governed/windows-channel-holders.js", { "./windows-identity-facts": {
    runPowerShellWithStdin(_script, _source, args, options) {
      assert.equal(options.privateInput, true);
      assert.equal(args[2], pipeName);
      return { status: 0, stdout, stderr: "", error: null };
    },
  } }).readWindowsChannelHoldersBound({ childPid: 4321, parentPid: process.pid, pipeName, end: "client" });
}
test("bound helper: strict output admits complete facts and rejects malformed/duplicate/truncated records", () => {
  assert.equal(parseHolders(cleanHolderOutput).ok, true);
  for (const bad of [cleanHolderOutput + "\nHOLDERS=OK", cleanHolderOutput.replace("HOLDER_PIDS=4321", "HOLDER_PIDS=4321,bad"),
    cleanHolderOutput.replace("HOLDER_SETS=1", "HOLDER_SETS=1junk"), cleanHolderOutput.replace("HOLDER_SETS=1", "HOLDER_SETS=0"),
    cleanHolderOutput.replace("HOLDER_OBJECT=FFFF000000000001\n", ""), cleanHolderOutput + "\nUNEXPECTED=1"]) {
    assert.equal(parseHolders(bad).ok, false);
  }
});
test("bound helper: full pipe name travels only on stdin, absent from command argv", () => {
  let seen;
  const facts = load("governed/windows-identity-facts.js", { "node:child_process": { spawnSync(_exe, args, options) {
    seen = { args, options };
    return { status: 0, stdout: "", stderr: "" };
  } } });
  facts.runPowerShellWithStdin("$source = $q.source", "C#", ["4321", pipeName], { privateInput: true, timeoutMs: 13 });
  assert.equal(JSON.stringify(seen.args).includes(pipeName), false);
  assert.equal(JSON.parse(seen.options.input).args[1], pipeName);
  assert.equal(seen.options.timeout, 13);
});

test("Windows executor consumers share bootstrap and exactly one connect", async () => {
  const socket = new PassThrough();
  let connects = 0;
  const api = load("governed/managed-caller-transport.js", { "node:net": { connect(name) {
    assert.equal(name, pipeName); connects++;
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  } } });
  const supervisor = load("governed/managed-caller-supervisor.js", { "./managed-caller-transport": api });
  const stream = new PassThrough();
  const child = { stdio: [null, null, null, null, stream] };
  const secretRead = supervisor.readSessionSecret(child);
  const connection = api.openExecutorTransport(child);
  assert.equal(connection, api.openExecutorTransport(child));
  assert.equal(connects, 0);
  stream.end(JSON.stringify({ version: 1, transport: "windows-named-pipe", pipeName, secret }) + "\n");
  assert.equal(await secretRead, secret);
  const transport = await connection;
  assert.equal(stream.closed, true);
  assert.equal(connects, 1);
  transport.close();
});
test("bootstrap rejects duplicate known members and premature descriptor close", async () => {
  const record = JSON.stringify({ version: 1, transport: "windows-named-pipe", pipeName, secret });
  const repeated = record.slice(0, -1) + ',"version":1}\n';
  await assert.rejects(bootstrap(null, [repeated]).promise, { message: "ERR_BOOTSTRAP_INVALID" });
  const stream = new PassThrough();
  const promise = transportApi.readExecutorBootstrap({ stdio: [null, null, null, null, stream] });
  stream.destroy();
  await assert.rejects(promise, { message: "ERR_BOOTSTRAP_TRUNCATED" });
});

test("Windows isolated adapter admits on transport BEFORE dispatch and detaches at direct exit", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 5555, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), stdio: [] });
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close"); return true; };
  const transport = new EventEmitter();
  let closed = false, businessMessages = 0, closeHandler;
  transport.on("message", message => { if (message.type === "request") businessMessages++; });
  const session = {
    established: true, get closed() { return closed; },
    onClose(handler) { closeHandler = handler; },
    auditChannelHolders: () => ({ ok: true }), auditProcessContinuity: () => ({ ok: true }),
    async close() { closed = true; session.established = false; closeHandler(); child.kill(); },
    async request() { transport.emit("message", { type: "request", operation: "unexpected" }); return { ready: true }; },
  };
  const api = load("coordination/permit-witness-isolated-adapter.js", {
    "../governed/managed-caller-supervisor": { startManagedCallerSession: async () => ({ child, session, transport }) },
  });
  const fixture = require("../coordination/fixtures/permit-witness-v2-history");
  const bytes = fixture.request(fixture.query());
  const providerPath = path.resolve(__dirname, "../coordination/fixtures/permit-witness-isolated-provider.js");
  const adapter = new api.IsolatedHistoryAdapter({ providerPath, runtimeDirectory: fs.realpathSync(path.dirname(providerPath)),
    budget: new api.IsolationBudget(), timeoutMs: 5000 });
  const context = adapter.authorizeHistory(bytes);
  const outcome = await adapter.observeHistory(context, bytes);
  assert.equal(outcome.code, "ERR_ISOLATED_UNEXPECTED_MESSAGE");
  assert.equal(businessMessages, 0);
  await adapter.historyLifecycle(context).directExit;
  assert.equal(transport.listenerCount("message"), 1, "only the model's dispatch listener remains");
  assert.equal(child.listenerCount("message"), 0);
});

test("Windows: transfer during round trip rejects post-audit and never revives", async () => {
  let attack = false;
  const m = sessionModel(f => { if (attack) f.channelFacts.client.pids.push(9001); });
  await m.session.handshake();
  const send = m.transport.send;
  m.transport.send = message => {
    const sent = send(message);
    if (message.type === m.api.CHANNEL_MESSAGE.REQUEST) {
      attack = true;
      const body = { seq: message.seq, result: { ok: true } };
      queueMicrotask(() => m.transport.emit("message", { type: m.api.CHANNEL_MESSAGE.RESPONSE,
        requestId: message.requestId, sessionId: message.sessionId, seq: message.seq, body,
        mac: signing.signResponse(secret, { kind: m.api.SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
          requestId: message.requestId, seq: message.seq, operation: message.operation,
          payloadDigest: message.payloadDigest, body }) }));
    }
    return sent;
  };
  await assert.rejects(m.session.request("ping", {}), /channel_handle_transferred/);
  attack = false;
  assert.equal(m.session.auditChannelHolders().ok, false);
});
test("Windows: inbound pre-audit blocks handler; one deadline covers handler and post-audit", async () => {
  let attack = false;
  const m = sessionModel(f => { if (attack) f.channelFacts.client.pids.push(9001); });
  await m.session.handshake();
  let effects = 0;
  m.session.onRequest(() => { effects++; });
  const message = { type: m.api.CHANNEL_MESSAGE.REQUEST, requestId: "inbound", seq: 1, operation: "ping", payload: {} };
  message.mac = signing.signResponse(secret, { kind: m.api.SIGNED_MESSAGE_KIND.REQUEST_IN, requestId: message.requestId,
    seq: 1, operation: "ping", payloadDigest: signing.digestPayload({}), body: null });
  attack = true;
  await m.session._dispatchInbound(message);
  assert.equal(effects, 0);
  assert.equal(m.session.closed, true);

  const deadlines = [];
  const other = sessionModel((_f, _round, binding) => { if (binding?.pipeName) deadlines.push(binding.deadline); });
  await other.session.handshake();
  deadlines.length = 0;
  other.session.onRequest(async () => { await new Promise(resolve => setTimeout(resolve, 5)); return true; });
  await other.session._dispatchInbound(message);
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines[0], deadlines[1]);
  await other.session.close();
});

test("Windows bridge executor verifies HMAC/seq/digest BEFORE any collect forwarding", async () => {
  const transport = Object.assign(new EventEmitter(), { connected: true, send: () => Promise.resolve() });
  let forwarded = 0;
  load("commands/permit-bridge-executor.js", { "../governed/managed-caller-supervisor": {
    readSessionSecret: async () => secret, openExecutorTransport: async () => transport,
    createExecutorEndpoint: () => ({ answer() {}, async request() { forwarded++; return {}; } }),
  } });
  await new Promise(resolve => setImmediate(resolve));
  const { CHANNEL_MESSAGE, SIGNED_MESSAGE_KIND } = require("../../lib/governed/managed-caller-session");
  function signed(seq, operation, payload) {
    const message = { type: CHANNEL_MESSAGE.REQUEST, requestId: `r-${seq}`, seq, operation, payload,
      payloadDigest: signing.digestPayload(payload) };
    message.mac = signing.signResponse(secret, { kind: SIGNED_MESSAGE_KIND.REQUEST_OUT, requestId: message.requestId,
      seq, operation, payloadDigest: message.payloadDigest, body: null });
    return message;
  }
  transport.emit("message", signed(1, "permit.start", {}));
  const valid = signed(2, "permit.collect", { action: "permit.key", args: {} });
  transport.emit("message", { ...valid, mac: "bad" });
  transport.emit("message", { ...valid, payloadDigest: "bad" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forwarded, 0);
  transport.emit("message", valid);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forwarded, 1);
  transport.emit("message", valid);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forwarded, 1);
});
