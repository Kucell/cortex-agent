"use strict";

// Ordinary discovery/import executes PURE VALIDATION ONLY. The physical driver
// is never selected by an environment flag, test name, constructor boolean or
// normal node:test run. Its explicit main entry additionally requires the fresh,
// attested supervisor's dedicated inherited socket and bound client FIFO FDs.
const assert = require("node:assert/strict");
const gatewayModule = require("../../lib/runtime-state/serialized-artifact-gateway");
const { CORPUS, SOURCE_PATHS, digest, validateRequest, evaluateGate, validateHello } = gatewayModule;

const physicalMode = require.main === module && process.argv.length === 4
  && ["--physical-supervised", "--physical-reconcile"].includes(process.argv[2])
  && /^[1-9][0-9]{0,2}$/.test(process.argv[3]) && !process.env.NODE_TEST_CONTEXT;

function registerPureTests() {
  const test = require("node:test");
  const run = "synthetic:" + "a".repeat(64);
  const request = (overrides = {}) => ({ protocol: 1, project: "synthetic:linux-sink", run, attempt: 1,
    channel: "synthetic:pipe-1", sequence: 1, operation: "synthetic:allowed", fence: 1,
    name: "a.txt", text: "alpha\n", ...overrides });
  const authority = { fence: 1, expiresAt: 2000, revoked: false, closed: false, quarantined: false };
  const identity = { run, attempt: 1, channel: "synthetic:pipe-1" };
  test("PHYSICAL_CANARY_NOT_RUN: default discovery is pure validation only", () => {
    assert.equal(physicalMode, false);
    assert.equal(Object.keys(CORPUS).length, 3);
    assert.equal(gatewayModule.LIMITS.publications, 3);
  });
  test("closed request accepts only the bounded synthetic corpus", () => {
    const value = validateRequest(JSON.stringify(request()));
    assert.equal(Object.isFrozen(value), true);
    assert.equal(value.text, "alpha\n");
    for (const [name, text] of Object.entries(CORPUS))
      assert.equal(validateRequest(JSON.stringify(request({ name, text }))).name, name);
  });
  test("malformed, oversized, extra fields and traversal fail pure validation", () => {
    for (const value of ["{", " ".repeat(2049), JSON.stringify({ ...request(), actor: "owner" }),
      JSON.stringify(request({ name: "../a.txt" })), JSON.stringify(request({ name: "/scratch/link" })),
      JSON.stringify(request({ name: ["a.txt"] })), JSON.stringify(request({ name: { toString: "a.txt" } })),
      JSON.stringify(request({ text: "arbitrary" })), JSON.stringify(request({ sequence: 49 })),
      JSON.stringify(request({ operation: "production-owner" }))]) assert.throws(() => validateRequest(value));
  });
  test("revocation, expiry, fences and budget gate before cached/dedupe success", () => {
    const value = request();
    assert.equal(evaluateGate(authority, value, identity, 1999, 0), null);
    assert.equal(evaluateGate(authority, value, identity, 2000, 0), "EXPIRED");
    assert.equal(evaluateGate({ ...authority, revoked: true }, value, identity, 1999, 0), "REVOKED");
    assert.equal(evaluateGate({ ...authority, fence: 2 }, value, identity, 1999, 0), "STALE_FENCE");
    assert.equal(evaluateGate(authority, value, identity, 1999, 3), "BUDGET");
    assert.equal(evaluateGate({ ...authority, quarantined: true }, value, identity, 1999, 0), "QUARANTINED");
    assert.equal(evaluateGate({ ...authority, closed: true }, value, identity, 1999, 0), "CLOSED");
  });
  test("claimed actor/channel/run never substitutes for endpoint binding", () => {
    assert.equal(evaluateGate(authority, request({ channel: "synthetic:pipe-2" }), identity, 1999, 0), "CHANNEL_BINDING");
    assert.equal(evaluateGate(authority, request({ run: "synthetic:" + "b".repeat(64) }), identity, 1999, 0), "BINDING");
    assert.equal(evaluateGate(authority, request({ attempt: 2 }), identity, 1999, 0), "BINDING");
    assert.throws(() => gatewayModule.openSupervisedGateway({ enabled: true }), { code: "SUPERVISOR_PERMIT_REQUIRED" });
    assert.throws(() => gatewayModule.reconcileSupervisedGateway({}), { code: "SUPERVISOR_PERMIT_REQUIRED" });
  });
  test("supervisor hello is closed and pipe metadata is bounded", () => {
    const hello = { type: "hello", protocol: 1, synthetic: true, nonce: "a".repeat(64),
      root: "/tmp/cortex-linux-sink-pure/sink", parent_pid: 12,
      source_manifest: Object.fromEntries(SOURCE_PATHS.map((name) => [name, "b".repeat(64)])),
      pipes: [0, 1].map((index) => ({ readFd: 4 + index, writeFd: 6 + index,
        readStat: { dev: "1", ino: String(10 + index) }, writeStat: { dev: "1", ino: String(20 + index) } })) };
    assert.equal(validateHello(hello, "sink"), hello);
    assert.throws(() => validateHello({ ...hello, enabled: true }, "sink"));
    assert.throws(() => validateHello({ ...hello, pipes: [] }, "sink"));
    assert.throws(() => validateHello({ ...hello, nonce: "caller-authority" }, "sink"));
    const recovered = { ...hello, pipes: [], recovery: { name: "c.txt", size: 6,
      sha256: digest(CORPUS["c.txt"]), operation: "synthetic:crash", journal_events: 12 } };
    assert.equal(validateHello(recovered, "reconcile"), recovered);
    assert.throws(() => validateHello({ ...recovered, recovery: { ...recovered.recovery, name: "../c.txt" } }, "reconcile"));
  });
  test("pure gate uses admission time, never enqueue time or a reservation", () => {
    const value = request();
    assert.equal(evaluateGate(authority, value, identity, 1900, 0), null);
    assert.equal(evaluateGate(authority, value, identity, 2001, 0), "EXPIRED");
    assert.equal(evaluateGate({ ...authority, revoked: true }, value, identity, 1901, 0), "REVOKED");
  });
  test("pure validators and refused construction call no filesystem operations", () => {
    const fs = require("node:fs");
    const names = ["openSync", "readFileSync", "readSync", "writeFileSync", "writeSync", "mkdirSync", "linkSync",
      "unlinkSync", "fsyncSync", "lstatSync", "fstatSync", "realpathSync", "readdirSync"];
    const originals = names.map((name) => fs[name]);
    try {
      for (const name of names) fs[name] = () => assert.fail("pure path invoked " + name);
      validateRequest(JSON.stringify(request()));
      evaluateGate(authority, request(), identity, 1900, 0);
      assert.throws(() => gatewayModule.openSupervisedGateway({}), { code: "SUPERVISOR_PERMIT_REQUIRED" });
    } finally { names.forEach((name, index) => { fs[name] = originals[index]; }); }
  });
}

// This code is not entered during test discovery. No subprocess or namespace
// APIs are imported anywhere in this file. Python owns all process isolation.
async function physicalDriver() {
  const fs = require("node:fs");
  const net = require("node:net");
  const controlFd = Number(process.argv[3]);
  assert.ok(controlFd >= 3 && controlFd <= 255 && fs.fstatSync(controlFd).isSocket(), "dedicated supervisor socket required");
  const control = new net.Socket({ fd: controlFd, readable: true, writable: true });
  const endpointStreams = [];
  let transferred = 0;
  function reader(stream, maxLine, maxTotal) {
    let buffer = Buffer.alloc(0), total = 0, ended = false, error = null;
    const lines = [], waiting = [];
    function deliver() {
      while (waiting.length && (lines.length || error || ended)) {
        const waiter = waiting.shift(); clearTimeout(waiter.timer);
        if (lines.length) waiter.resolve(lines.shift()); else waiter.reject(error || new Error("PIPE_EOF"));
      }
    }
    stream.on("data", (chunk) => {
      total += chunk.length; transferred += chunk.length;
      if (total > maxTotal || transferred > 262144) { error = new Error("TRANSPORT_BOUND"); stream.destroy(); deliver(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (newline > maxLine) { error = new Error("FRAME_BOUND"); break; }
        lines.push(buffer.subarray(0, newline).toString("utf8")); buffer = buffer.subarray(newline + 1);
      }
      if (buffer.length > maxLine || lines.length > 64) error = new Error("FRAME_BOUND");
      if (error) stream.destroy();
      deliver();
    });
    stream.on("end", () => { ended = true; if (buffer.length) error = new Error("PARTIAL_FRAME"); deliver(); });
    stream.on("error", (value) => { error = value; deliver(); });
    return () => new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { error = new Error("CHANNEL_DEADLINE"); deliver(); }, 10000) };
      waiting.push(waiter); deliver();
    });
  }
  const readControl = reader(control, 16384, 65536);
  function write(stream, value) {
    const bytes = JSON.stringify(value) + "\n";
    assert.ok(Buffer.byteLength(bytes) <= 16384);
    return new Promise((resolve, reject) => stream.write(bytes, (error) => error ? reject(error) : resolve()));
  }
  const watchdog = setTimeout(() => { process.stderr.write("PHYSICAL_DRIVER_DEADLINE\n"); process.exit(1); }, 80000);
  let gateway;
  try {
    const mode = process.argv[2] === "--physical-reconcile" ? "reconcile" : "sink";
    const hello = JSON.parse(await readControl());
    const bound = gatewayModule.verifySupervisorBinding(hello, controlFd, mode);
    await write(control, { type: "ready", protocol: 1, synthetic: true });
    if (mode === "reconcile") {
      const reconciliation = gatewayModule.reconcileSupervisedGateway(bound.permit);
      assert.equal(reconciliation.status, "UNKNOWN");
      assert.equal(reconciliation.observed_match, true);
      assert.equal(reconciliation.replayed, false);
      await write(control, { type: "result", status: "SINK_CANARY_COMPONENT_PASS", synthetic: true, report: { reconciliation } });
      clearTimeout(watchdog); control.end(); return;
    }
    gateway = gatewayModule.openSupervisedGateway(bound.permit);
    const clients = bound.endpoints.map((endpoint) => {
      const input = fs.createReadStream(null, { fd: endpoint.readFd, autoClose: true });
      const output = fs.createWriteStream(null, { fd: endpoint.writeFd, autoClose: true });
      endpointStreams.push(input, output);
      return { ...endpoint, input, output, read: reader(input, 2048, 98304), sequence: 0 };
    });
    const report = { synthetic: true, production_authority: false, formal_acceptance: false,
      cases: [], transport_identity: "supervisor-attested-inherited-FIFO", physical_canary: "RUNNING" };
    const passed = (name, evidence) => {
      assert.ok(report.cases.length < 16);
      report.cases.push({ name, status: "PASS", evidence });
    };
    const effectSnapshot = () => {
      const value = gateway.snapshot();
      return { files: value.files, publications: value.publications, preparations: value.preparations };
    };
    async function emit(index, name, fence) {
      const client = clients[index];
      await write(client.output, { op: "emit", case: name, seq: ++client.sequence, fence });
      return { endpoint: client.endpoint, raw: await client.read() };
    }
    function queued(value) {
      const result = gateway.enqueue(value.endpoint, value.raw); assert.equal(result.status, "QUEUED"); return result;
    }
    function drainOne(value) { queued(value); const result = gateway.drain(); assert.equal(result.length, 1); return result[0]; }
    async function denied(index, name, fence, expected) {
      const value = await emit(index, name, fence), before = effectSnapshot();
      const enqueued = gateway.enqueue(value.endpoint, value.raw);
      const result = enqueued.status === "QUEUED" ? gateway.drain()[0] : enqueued;
      assert.equal(result.status, "DENIED");
      assert.ok(expected.includes(result.code), name + ": " + result.code);
      assert.deepEqual(effectSnapshot(), before);
      return result.code;
    }
    let controlId = 0;
    async function observation() {
      const id = ++controlId; await write(control, { type: "observe", id });
      const response = JSON.parse(await readControl());
      assert.equal(response.type, "observation"); assert.equal(response.id, id); assert.equal(response.ok, true);
      for (const name of ["namespaces_verified", "fds_verified", "mounts_verified", "sentinels_unchanged", "source_unchanged"])
        assert.equal(response.evidence[name], true, name);
      assert.ok(response.evidence.processes_observed <= 64 && response.evidence.clients_alive <= 2);
      return response.evidence;
    }
    for (const client of clients) {
      await write(client.output, { op: "bind", run: client.identity.run, channel: client.identity.channel });
      assert.deepEqual(JSON.parse(await client.read()), { type: "bound" });
    }
    const isolation = await observation(), probes = [];
    for (const client of clients) {
      await write(client.output, { op: "probe" });
      const result = JSON.parse(await client.read()); assert.equal(result.type, "probe");
      for (const name of ["scratch_writable", "readonly_inputs", "private_paths_hidden", "host_process_hidden", "loopback_blocked", "symlink_created"])
        assert.equal(result[name], true, name);
      probes.push(result);
    }
    passed("isolation-boundary", { supervisor: isolation, probes });
    passed("network-separation", { independently_observed: isolation.namespaces_verified, client_loopback_blocked: true });

    const first = drainOne(await emit(0, "allowed", 1));
    assert.equal(first.status, "PUBLISHED_PENDING_OBSERVATION");
    assert.equal(first.sha256, digest(CORPUS["a.txt"]));
    assert.equal(gateway.observe(first.ticket).status, "OBSERVED");
    passed("allowed-fixed-write", { name: first.name, sha256: first.sha256, readback_verified: true });

    const race = await Promise.all([emit(0, "race", 1), emit(1, "race", 1)]);
    race.forEach(queued);
    const outcomes = gateway.drain();
    assert.equal(outcomes[0].status, "PUBLISHED_PENDING_OBSERVATION");
    assert.equal(outcomes[1].code, "CLAIM_CONFLICT");
    assert.equal(gateway.snapshot().publications, 2);
    const held = outcomes[0];
    passed("two-channel-race", { publications: 1, loser: outcomes[1].code, response_held: true });

    passed("immutable-collision", { code: await denied(0, "collision", 1, ["CONTENT_CONFLICT"]), unchanged: true });
    const invalid = [];
    for (const [name, codes] of [["duplicate", ["SEQUENCE_REPLAY"]], ["wrong-run", ["RUN", "BINDING"]],
      ["wrong-attempt", ["BINDING"]], ["wrong-channel", ["CHANNEL_BINDING"]], ["malformed", ["MALFORMED_JSON"]]])
      invalid.push({ name, code: await denied(0, name, 1, codes) });
    passed("invalid-bindings-and-replay", invalid);
    passed("escape-and-scratch-symlink", { escape: await denied(0, "escape", 1, ["PATH"]),
      symlink: await denied(1, "symlink", 1, ["PATH"]), unchanged: true });

    queued(await emit(0, "queued-expiry", 1));
    const expiresAt = gateway.expireSoon();
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 5)));
    const beforeExpiry = effectSnapshot(), expiredQueued = gateway.drain()[0];
    assert.equal(expiredQueued.code, "EXPIRED"); assert.deepEqual(effectSnapshot(), beforeExpiry);
    passed("queued-before-expiry-denied-at-admission", { expires_at: expiresAt, observed_at: Date.now(), code: expiredQueued.code });
    passed("already-expired", { code: await denied(0, "expired", 1, ["EXPIRED"]) });
    const expiredCache = await denied(0, "cached", 1, ["EXPIRED"]);

    queued(await emit(0, "revoked", 1));
    const barrier = gateway.revoke(), beforeRevocation = effectSnapshot();
    const revoked = gateway.drain()[0]; assert.equal(revoked.code, "REVOKED");
    assert.deepEqual(effectSnapshot(), beforeRevocation);
    passed("revoke-before-admission", { barrier, code: revoked.code, preparations_created: 0 });
    const late = gateway.observe(held.ticket);
    assert.equal(late.status, "QUARANTINED_COMPLETION"); assert.equal(late.next_effect_authorized, false);
    assert.equal(late.executable_success, false);
    assert.ok(held.admitted_at < expiresAt && Date.now() >= expiresAt);
    const next = await denied(1, "late-next", 2, ["REVOKED"]);
    passed("admitted-completion-after-expiry-and-revoke", { ...late, admitted_at: held.admitted_at,
      expires_at: expiresAt, observed_at: Date.now(), next });
    passed("cached-after-boundary", { expired: expiredCache, revoked: await denied(0, "cached", 2, ["REVOKED"]) });

    const freshFence = gateway.rotate(); assert.equal(freshFence, 3);
    passed("old-fence-after-generation-change", { code: await denied(0, "old-fence", 1, ["STALE_FENCE"]), current_fence: freshFence });
    const crash = drainOne(await emit(0, "crash", freshFence));
    assert.equal(crash.status, "PUBLISHED_PENDING_OBSERVATION");
    assert.equal(crash.name, "c.txt"); assert.equal(crash.sha256, digest(CORPUS["c.txt"]));
    passed("three-publication-budget", { publications: gateway.snapshot().publications,
      denied: await denied(0, "budget", freshFence, ["BUDGET"]) });
    gateway.closeAdmission();

    // Retire the other actor first, so the remaining parent plus its fixed
    // descendant never exceed two simultaneously live client Node processes.
    const firstClientEOF = new Promise((resolve, reject) => {
      const input = clients[0].input;
      const timer = setTimeout(() => finish(new Error("CLIENT_EXIT_EOF_DEADLINE")), 5000);
      const onEnd = () => finish();
      const onError = (error) => finish(error);
      function finish(error) {
        clearTimeout(timer); input.off("end", onEnd); input.off("error", onError);
        if (error) reject(error); else resolve();
      }
      input.once("end", onEnd); input.once("error", onError);
      if (input.readableEnded) finish();
    });
    await write(clients[0].output, { op: "exit" });
    await firstClientEOF;
    await write(clients[1].output, { op: "orphan" });
    const orphan = JSON.parse(await clients[1].read());
    assert.equal(orphan.type, "orphan"); assert.ok(Number.isSafeInteger(orphan.pid) && orphan.pid > 1);
    // Client-reported PID alone is not evidence that a descendant existed.
    // The fixed parent remains alive until the supervisor captures that child.
    const descendant = await observation();
    assert.equal(descendant.descendant_observed, true);
    assert.equal(descendant.descendant_namespace_pid, orphan.pid);
    assert.match(descendant.descendant_starttime, /^[0-9]+$/);
    await write(clients[1].output, { op: "exit" });
    // No request or response FD survives the client-tree shutdown handshake.
    for (const stream of endpointStreams) stream.destroy();
    const shutdownId = ++controlId;
    await write(control, { type: "shutdown", id: shutdownId });
    const shutdown = JSON.parse(await readControl());
    assert.equal(shutdown.type, "shutdown-result"); assert.equal(shutdown.id, shutdownId); assert.equal(shutdown.ok, true);
    for (const name of ["namespace_exit_confirmed", "pipes_eof", "sentinels_unchanged"]) assert.equal(shutdown[name], true);
    passed("descendant-parent-death-and-cleanup", { orphan_namespace_pid: orphan.pid,
      descendant_observed: descendant.descendant_observed,
      descendant_starttime: descendant.descendant_starttime, ...shutdown });
    const snapshot = gateway.snapshot();
    assert.equal(snapshot.publications, 3); assert.equal(snapshot.preparations, 3);
    assert.ok(snapshot.requests <= 48);
    assert.deepEqual(snapshot.files.map((entry) => entry.name), [".journal", "a.txt", "b.txt", "c.txt"]);
    report.cases.push({ name: "crash-after-publication-before-receipt", status: "AWAITING_READ_ONLY_RECONCILIATION",
      evidence: { name: crash.name, sha256: crash.sha256, receipt_delivered: false } });
    assert.equal(report.cases.length, 16);
    report.counts = { requests: snapshot.requests, publications: snapshot.publications, preparations: snapshot.preparations };
    report.inventory = snapshot.files;
    report.physical_canary = "AWAITING_READ_ONLY_RECONCILIATION";
    const recovery = { name: "c.txt", size: 6, sha256: crash.sha256,
      operation: "synthetic:crash", journal_events: snapshot.journal_events };
    gateway.closeJournal();
    await write(control, { type: "crash-ready", synthetic: true, report, recovery });
    clearTimeout(watchdog);
    // Deliberate process death after durable publication and before receipt. The
    // next process may inspect only; it cannot reopen a fresh writer or replay.
    process.exit(86);
  } catch (error) {
    clearTimeout(watchdog);
    for (const stream of endpointStreams) stream.destroy();
    if (gateway) gateway.closeJournal();
    try { await write(control, { type: "result", status: "FAILED", synthetic: true,
      report: { code: error.code || "DRIVER_ASSERTION", message: String(error.message).slice(0, 512) } }); } catch (_) {}
    control.destroy(); process.exitCode = 1;
  }
}

if (physicalMode) physicalDriver();
else registerPureTests();
