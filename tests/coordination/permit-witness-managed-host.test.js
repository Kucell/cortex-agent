"use strict";

// @runner-timeout 600
// This file drives real supervised child processes and real OS fact probes,
// so its normal runtime is minutes rather than seconds. The runner's default
// 60s is a hang detector for ordinary files; this file declares its real
// budget instead of dropping the real-subprocess coverage.

const { testRuntime } = require("../helpers/runtime-sandbox");

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { startPermitWitnessManagedHost, OPERATIONS, HISTORY_OPERATION } = require("../../lib/coordination/permit-witness-managed-host");
const delivery = require("../../lib/coordination/permit-delivery");
const { signRevocationList } = require("../../lib/coordination/permit-revocation-signing");

// Includes the existing macOS OS-fact helper's compiler scratch. No fact source
// replacements: successful binding below must use real kernel/process facts.
const base = testRuntime("test-tmp");
fs.mkdirSync(base, { recursive: true });
const scratch = fs.mkdtempSync(path.join(base, "permit-witness-managed-"));
const originalTemp = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map(key => [key, process.env[key]]));
for (const key of Object.keys(originalTemp)) process.env[key] = scratch;
after(() => {
  for (const [key, value] of Object.entries(originalTemp)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || process.platform === "win32", timeout: 120000 };
const executor = path.join(__dirname, "fixtures/permit-witness-managed-executor.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(scratch, "case-"));
  const db = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(db); fs.mkdirSync(anchorDir);
  const key = delivery.createBatchKeyPair();
  const resources = { targetId: "target-a", pin: { decision_id: "D-managed", instance_id: "target-a",
    fingerprint: key.fingerprint, public_key_pem: key.publicKeyPem, source_digest: "sha256:source",
    deployment_digest: "sha256:deployment", run_id: "run", generation: "1", valid_from: 1, valid_until: 100000 },
    lease: { owner: "principal", sessionId: "explicit-business-session", hostId: "assigned-host", workerId: "assigned-worker",
      runId: "run", generation: "1", desktopKey: "assigned-desktop", ownedAppId: "assigned-app" },
    permit: { operation: "invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64) },
    maxLeaseTtlMs: 5000, maxPermitTtlMs: 2000 };
  const calls = { observe: 0, sign: 0, pull: 0 };
  const options = { modulePath: executor, assignment: { businessSessionId: resources.lease.sessionId, principal: "principal",
    actions: ["register", "issue", "consume"], resources }, witness: {
    backend: "development-witness", mode: "development-only", access: "initialize", file: path.join(db, "authority.sqlite"),
    authorityId: "local-dev-authority", storeOptions: { decisionId: "D-managed", anchorDir, anchorMode: "permissive" },
    clock: () => 1000, providers: {
      observeTarget: () => { calls.observe++; return { targetHasProcess: false, targetHasPriorRun: false }; },
      signPermit: (fingerprint, permit, now) => {
        calls.sign++;
        return { fingerprint, publicKeyPem: key.publicKeyPem,
          signedPermit: delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit, issuedAtMs: now, nowMs: now }) };
      },
      pullRevocation: (_targetId, current, now) => {
        calls.pull++;
        return signRevocationList({ ...key, issuedAtMs: now, fingerprints: [], state: {
          appliedRevocationSequence: current.state.applied_revocation_sequence,
          revokedFingerprints: new Set(current.state.revoked_fingerprints) } });
      },
    } } };
  const hosts = [];
  async function start(patch = {}) {
    const host = await startPermitWitnessManagedHost({ ...options, ...patch });
    hosts.push(host);
    host.child.stdout.resume(); host.child.stderr.resume();
    return host;
  }
  function state() {
    const { DatabaseSync } = require("node:sqlite");
    const connection = new DatabaseSync(options.witness.file, { readOnly: true });
    try { return JSON.parse(connection.prepare("SELECT body FROM protected_state WHERE id=1").get().body); }
    finally { connection.close(); }
  }
  const checkpoint = () => state().witness_authority.targets[resources.targetId].current.checkpoint;
  const register = () => ({ targetId: resources.targetId, checkpoint: null, requestId: "registration", pin: structuredClone(resources.pin) });
  const issue = () => ({ targetId: resources.targetId, checkpoint: checkpoint(), batchFingerprint: key.fingerprint,
    lease: { ...resources.lease, idempotencyKey: "lease", ttlMs: 5000 },
    permit: { ...resources.permit, idempotencyKey: "permit", ttlMs: 2000 } });
  t.after(async () => {
    try { for (const host of hosts) await host.close(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  return { root, options, resources, calls, start, state, checkpoint, register, issue };
}

let counter = 0;
function exercise(host, operation, payload, type = "exercise") {
  const id = String(++counter);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("fixture response timeout")); }, 30000);
    function cleanup() { clearTimeout(timer); host.child.off("message", receive); }
    function receive(message) {
      if (message.type !== "exercise-result" || message.id !== id) return;
      cleanup(); resolve(message);
    }
    host.child.on("message", receive);
    host.child.send({ type, id, operation, payload }, error => { if (error) { cleanup(); reject(error); } });
  });
}
function committed(reply) {
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.result.status, "committed");
  assert.equal(reply.result.commit, "confirmed");
  assert.equal(reply.result.mode, "development-only");
  assert.equal(reply.result.executionAuthorized, false);
  assert.equal(reply.result.result.executionAuthorized, false);
  return reply.result.result;
}
function rejected(reply) {
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.result.status, "rejected");
  assert.equal(reply.result.commit, "not-attempted");
  assert.equal(reply.result.executionAuthorized, false);
}

function historyQuery(f, operation, request) {
  return { operation, decisionId: f.options.witness.storeOptions.decisionId,
    authorityId: f.options.witness.authorityId, issuerStoreId: f.state().store_id,
    targetGeneration: request.checkpoint === null ? null : request.checkpoint.store_generation,
    resources: { fingerprint: f.resources.pin.fingerprint,
      lease: operation === "register" ? null : structuredClone(f.resources.lease),
      permit: operation === "register" ? null : structuredClone(f.resources.permit) }, request: structuredClone(request) };
}
function historyAccess(f, queries, assignment) {
  return { assignment, historyAssignment: { principal: "independent-reviewer", queries },
    witness: { ...f.options.witness, access: "open",
      storeOptions: { ...f.options.witness.storeOptions, minimumEpoch: 1 } } };
}
function observed(reply, status = "found") {
  assert.equal(reply.ok, true, reply.error);
  const result = reply.result;
  assert.equal(result.status, "observed"); assert.equal(result.commit, "not-applicable");
  for (const value of [result, result.result]) {
    assert.equal(value.mode, "development-only"); assert.equal(value.executionAuthorized, false);
    assert.equal(value.resumeAllowed, false); assert.equal(value.originalRequestOutcome, "unknown");
  }
  assert.equal(result.result.status, status);
  const forbidden = new Set(["signature", "signedPermit", "message", "bytes", "publicKeyPem", "public_key_pem"]);
  function scan(value) {
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, key); scan(child);
    }
  }
  scan(result);
  return result.result;
}
function historyAudit(f) {
  return fs.readFileSync(path.join(f.options.witness.storeOptions.anchorDir, "protected-anchor-audit.log"), "utf8")
    .trim().split("\n").map(JSON.parse).filter(row => row.event === "witness-history-observation");
}

test("an independently assigned real child observes all effects and bounded absence without write authority", supported, async t => {
  const f = fixture(t), writer = await f.start(), reg = f.register();
  committed(await exercise(writer, "permit.witness.register", reg));
  const req = f.issue(), issued = committed(await exercise(writer, "permit.witness.issue", req));
  const use = { targetId: f.resources.targetId, checkpoint: f.checkpoint(),
    message: issued.signedPermit.message, signature: issued.signedPermit.signature };
  committed(await exercise(writer, "permit.witness.consume", use));
  const oldIdentity = writer.session.childIdentity;
  await writer.close();
  const absent = { ...reg, requestId: "absent" };
  const queries = [["register", reg], ["issue", req], ["consume", use], ["register", absent]]
    .map(([operation, request]) => historyQuery(f, operation, request));
  const reader = await f.start(historyAccess(f, queries)), before = f.state(), calls = { ...f.calls };
  assert.notEqual(reader.session.childIdentity.sessionId, oldIdentity.sessionId);
  for (const field of ["identity", "context", "createHistoryContext", "queryHistory"]) assert.equal(Object.hasOwn(reader, field), false);
  for (const [index, query] of queries.entries()) {
    const result = observed(await exercise(reader, HISTORY_OPERATION, query), index === 3 ? "not-found-at-boundary" : "found");
    if (result.effect) assert.equal(result.effect.historicalPrincipal, "not-recorded");
  }
  for (const operation of Object.keys(OPERATIONS)) {
    const result = await exercise(reader, operation, reg);
    assert.equal(result.ok, false); assert.match(result.error, /operation_not_in_batch/);
  }
  assert.deepEqual(f.state(), before); assert.deepEqual(f.calls, calls);
  assert.equal(historyAudit(f).length, 4);
  assert.equal(JSON.stringify(historyAudit(f)).includes("independent-reviewer"), false);
});

test("write grants never imply history and detached history grants cannot be enlarged or mutated", supported, async t => {
  const f = fixture(t), writer = await f.start(), reg = f.register();
  committed(await exercise(writer, "permit.witness.register", reg));
  const query = historyQuery(f, "register", reg);
  const denied = await exercise(writer, HISTORY_OPERATION, query);
  assert.equal(denied.ok, false); assert.match(denied.error, /operation_not_in_batch/);
  await writer.close();
  const patch = historyAccess(f, [structuredClone(query)]), reader = await f.start(patch), before = f.state();
  patch.historyAssignment.queries[0].request.requestId = "mutated";
  patch.historyAssignment.queries.push({ ...query, principal: "principal" });
  for (const changed of [patch.historyAssignment.queries[0], { ...query, principal: "principal" },
    { ...query, identity: reader.session.childIdentity }, { ...query, issuerStoreId: "other" },
    { ...query, request: { ...query.request, targetId: "other" } }]) {
    const reply = await exercise(reader, HISTORY_OPERATION, changed);
    assert.equal(reply.ok, false); assert.match(reply.error, /managed_operation_rejected/);
  }
  await exercise(reader, HISTORY_OPERATION, query, "forge");
  assert.ok(reader.session.rejections.some(entry => entry.reason === "inbound_request_signature_mismatch"));
  assert.equal(historyAudit(f).length, 0);
  observed(await exercise(reader, HISTORY_OPERATION, query));
  assert.equal(historyAudit(f).length, 1); assert.deepEqual(f.state(), before);
});

test("independent history remains observation after a write blocks without retrying or reviving writes", supported, async t => {
  const f = fixture(t), first = await f.start(), reg = f.register();
  committed(await exercise(first, "permit.witness.register", reg));
  await first.close();
  const query = historyQuery(f, "register", reg);
  const host = await f.start(historyAccess(f, [query], f.options.assignment));
  const invalid = f.issue(); invalid.checkpoint.full_state_digest = "f".repeat(64);
  const failure = await exercise(host, "permit.witness.issue", invalid);
  assert.equal(failure.result.status, "unknown");
  const before = f.state(), calls = { ...f.calls };
  observed(await exercise(host, HISTORY_OPERATION, query));
  rejected(await exercise(host, "permit.witness.issue", f.issue()));
  assert.deepEqual(f.state(), before); assert.deepEqual(f.calls, calls); assert.equal(f.calls.sign, 0);
  assert.equal(historyAudit(f).length, 1);
});

test("history failure remains latched after its evidence is repaired and never retries or revives writes", supported, async t => {
  const f = fixture(t), first = await f.start(), reg = f.register();
  committed(await exercise(first, "permit.witness.register", reg)); await first.close();
  const query = historyQuery(f, "register", reg), host = await f.start(historyAccess(f, [query], f.options.assignment));
  const before = f.state(), calls = { ...f.calls };
  const auditFile = path.join(f.options.witness.storeOptions.anchorDir, "protected-anchor-audit.log");
  const mode = fs.statSync(auditFile).mode & 0o777;
  fs.chmodSync(auditFile, 0o644);
  let reply;
  try { reply = await exercise(host, HISTORY_OPERATION, query); }
  finally { fs.chmodSync(auditFile, mode); }
  assert.equal(reply.ok, true); assert.equal(reply.result.status, "unknown");
  assert.equal(reply.result.resumeAllowed, false); assert.equal(reply.result.originalRequestOutcome, "unknown");
  assert.equal(historyAudit(f).length, 0);
  const retry = await exercise(host, HISTORY_OPERATION, query);
  assert.equal(retry.ok, true); assert.equal(retry.result.status, "unavailable");
  rejected(await exercise(host, "permit.witness.issue", f.issue()));
  assert.equal(historyAudit(f).length, 0); assert.deepEqual(f.state(), before); assert.deepEqual(f.calls, calls);
});

test("real history identity loss permanently revokes observation even after channel holders become clean", supported, async t => {
  const f = fixture(t), first = await f.start(), reg = f.register();
  committed(await exercise(first, "permit.witness.register", reg)); await first.close();
  const query = historyQuery(f, "register", reg), host = await f.start(historyAccess(f, [query]));
  const before = f.state(), calls = { ...f.calls };
  const transfer = await exercise(host, null, null, "transfer");
  const denied = await exercise(host, HISTORY_OPERATION, query);
  assert.equal(denied.ok, false); assert.match(denied.error, /managed_caller_identity_unavailable/);
  assert.equal((await exercise(host, null, null, "release")).ok, true);
  assert.throws(() => process.kill(transfer.pid, 0), { code: "ESRCH" });
  assert.equal(host.session.auditChannelHolders().ok, true);
  assert.equal(host.session.auditProcessContinuity().ok, true);
  const retry = await exercise(host, HISTORY_OPERATION, query);
  assert.equal(retry.ok, false); assert.match(retry.error, /managed_caller_identity_unavailable|managed_operation_rejected/);
  assert.equal(historyAudit(f).length, 0); assert.deepEqual(f.state(), before); assert.deepEqual(f.calls, calls);
});

test("history-only assignments cannot initialize authority or smuggle caller identity and callbacks", supported, async t => {
  const f = fixture(t), pidFile = path.join(f.root, "history-invalid.pid");
  const invalid = [undefined, null, { principal: "", queries: [{}] }, { principal: "reviewer", queries: [] },
    { principal: "reviewer", queries: [{}, {}] }, { principal: "reviewer", queries: [{}], identity: {} },
    { principal: "reviewer", queries: [{}], isCurrent: () => true }];
  for (const historyAssignment of invalid) {
    await assert.rejects(f.start({ assignment: undefined, historyAssignment, args: [`--pid-file=${pidFile}`] }));
    assert.equal(fs.existsSync(pidFile), false); assert.equal(fs.existsSync(f.options.witness.file), false);
  }
  await assert.rejects(f.start({ assignment: undefined, historyAssignment: { principal: "reviewer", queries: [{}] },
    args: [`--pid-file=${pidFile}`] }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  assert.equal(fs.existsSync(pidFile), false); assert.equal(fs.existsSync(f.options.witness.file), false);
});

test("invalid detached history queries are refused before child spawn or opening existing authority", supported, async t => {
  const f = fixture(t), first = await f.start(), reg = f.register();
  committed(await exercise(first, "permit.witness.register", reg)); await first.close();
  const query = historyQuery(f, "register", reg), pidFile = path.join(f.root, "invalid-history.pid");
  function files() {
    return Object.fromEntries(fs.readdirSync(f.root, { recursive: true }).sort().map(name => {
      const file = path.join(f.root, name);
      return [name, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file)];
    }));
  }
  const before = files(); let clocks = 0;
  for (const invalid of [{}, { ...query, authorityId: "other" }, { ...query, decisionId: "other" },
    { ...query, resources: { ...query.resources, fingerprint: "invalid" } },
    { ...query, request: { ...reg, pin: { ...reg.pin, fingerprint: "c".repeat(64) } } }]) {
    const patch = historyAccess(f, [invalid]);
    await assert.rejects(f.start({ ...patch, args: [`--pid-file=${pidFile}`], witness: {
      ...patch.witness, clock: () => { clocks++; return 999; },
    } }));
    assert.equal(fs.existsSync(pidFile), false, "invalid history must not start a child");
    assert.equal(clocks, 0, "invalid history must not open the store or check its clock");
    assert.deepEqual(files(), before);
  }
});

test("invalid witness configuration never executes the real history child", supported, async t => {
  const f = fixture(t), first = await f.start(), reg = f.register();
  committed(await exercise(first, "permit.witness.register", reg)); await first.close();
  const query = historyQuery(f, "register", reg), before = f.state(), calls = { ...f.calls };
  const cases = [
    ["providers.signPermit=42", config => { config.providers.signPermit = 42; }],
    ["minimumEpoch=0", config => { config.storeOptions.minimumEpoch = 0; }],
    ["empty file", config => { config.file = ""; }],
    ["clock=42", config => { config.clock = 42; }],
  ];
  const evidence = [];
  for (const [name, mutate] of cases) {
    const patch = historyAccess(f, [query]), pidFile = path.join(f.root, "invalid-config.pid");
    patch.witness.providers = { ...patch.witness.providers };
    let clockCalls = 0;
    patch.witness.clock = () => { clockCalls++; return 999; };
    mutate(patch.witness);
    await assert.rejects(f.start({ ...patch, args: [`--pid-file=${pidFile}`] }));
    const childStarted = fs.existsSync(pidFile);
    if (childStarted) {
      assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
      fs.unlinkSync(pidFile);
    }
    evidence.push({ name, childStarted, clockCalls });
    assert.deepEqual(f.state(), before); assert.deepEqual(f.calls, calls);
  }
  t.diagnostic(JSON.stringify(evidence));
  assert.deepEqual(evidence.map(row => row.childStarted), cases.map(() => false));
  assert.deepEqual(evidence.map(row => row.clockCalls), cases.map(() => 0));
});

test("complete pure configuration preflight prevents spawn and storage effects for writer and history grants", supported, async t => {
  const f = fixture(t), pidFile = path.join(f.root, "invalid-config.pid");
  const invalid = [
    config => { config.backend = "legacy"; }, config => { config.mode = "production"; },
    config => { config.access = "recover"; }, config => { config.file = ""; },
    config => { config.file = 42; }, config => { config.file = "bad\0file"; },
    config => { config.authorityId = ""; }, config => { config.authorityId = 42; },
    config => { config.storeOptions = null; }, config => { delete config.storeOptions.decisionId; },
    config => { config.storeOptions.decisionId = ""; }, config => { config.storeOptions.decisionId = 42; },
    config => { config.storeOptions.anchorDir = ""; }, config => { config.storeOptions.anchorDir = 42; },
    config => { config.storeOptions.anchorDir = "bad\0anchor"; },
    config => { config.storeOptions.anchorMode = "unknown"; },
    config => { config.storeOptions.serviceIdentity = ""; }, config => { config.storeOptions.serviceIdentity = 42; },
    config => { config.storeOptions.minimumEpoch = 0; }, config => { config.storeOptions.minimumEpoch = 1.5; },
    config => { config.storeOptions.minimumEpoch = Number.MAX_SAFE_INTEGER + 1; },
    config => { config.storeOptions.extra = true; }, config => { config.extra = true; },
    config => { config.clock = null; }, config => { config.clock = 42; },
    config => { config.providers = null; }, config => { delete config.providers.observeTarget; },
    ...["observeTarget", "signPermit", "pullRevocation"].flatMap(name => [
      config => { config.providers[name] = 42; }, config => { config.providers[name] = null; },
    ]),
    config => { config.providers.extra = () => {}; },
    config => { Object.defineProperty(config.providers, "signPermit", {
      enumerable: true, get() { throw new Error("configuration accessor must never run"); },
    }); },
  ];
  function files() {
    return Object.fromEntries(fs.readdirSync(f.root, { recursive: true }).sort().map(name => {
      const file = path.join(f.root, name);
      return [name, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file)];
    }));
  }
  async function check(patch) {
    const before = files(), calls = { ...f.calls };
    let clocks = 0;
    for (const mutate of invalid) {
      const config = { ...patch.witness, providers: { ...patch.witness.providers },
        storeOptions: { ...patch.witness.storeOptions }, clock: () => { clocks++; throw new Error("preflight called clock"); } };
      mutate(config);
      await assert.rejects(f.start({ ...patch, args: [`--pid-file=${pidFile}`], witness: config }));
      assert.equal(fs.existsSync(pidFile), false, String(mutate));
      assert.equal(clocks, 0); assert.deepEqual(f.calls, calls); assert.deepEqual(files(), before);
    }
    if (patch.witness.access === "open") {
      const config = { ...patch.witness, storeOptions: { ...patch.witness.storeOptions } };
      delete config.storeOptions.minimumEpoch;
      await assert.rejects(f.start({ ...patch, args: [`--pid-file=${pidFile}`], witness: config }));
      assert.equal(fs.existsSync(pidFile), false); assert.deepEqual(files(), before);
    }
  }
  await check({ witness: f.options.witness });
  const first = await f.start(), reg = f.register();
  committed(await exercise(first, "permit.witness.register", reg)); await first.close();
  const observer = historyAccess(f, [historyQuery(f, "register", reg)]);
  await check({ witness: observer.witness });
  await check(observer);
  await check({ ...observer, assignment: f.options.assignment });
});

test("configuration snapshots cannot acquire unchecked proxy fields before spawn", supported, async t => {
  const f = fixture(t), first = await f.start(), reg = f.register();
  committed(await exercise(first, "permit.witness.register", reg)); await first.close();
  const query = historyQuery(f, "register", reg), before = f.state(), evidence = [];
  function changingFields(value, extra) {
    const target = { ...value, extra }; let reads = 0;
    return new Proxy(target, { ownKeys: object => ++reads === 1
      ? Reflect.ownKeys(object).filter(key => key !== "extra") : Reflect.ownKeys(object) });
  }
  for (const field of ["witness", "providers", "storeOptions"]) {
    const patch = historyAccess(f, [query]), pidFile = path.join(f.root, "proxy-config.pid");
    if (field === "witness") patch.witness = changingFields(patch.witness, true);
    else patch.witness[field] = changingFields(patch.witness[field], field === "providers" ? () => {} : true);
    await assert.rejects(f.start({ ...patch, args: [`--pid-file=${pidFile}`] }));
    const childStarted = fs.existsSync(pidFile);
    if (childStarted) {
      assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
      fs.unlinkSync(pidFile);
    }
    evidence.push({ field, childStarted }); assert.deepEqual(f.state(), before);
  }
  t.diagnostic(JSON.stringify(evidence));
  assert.deepEqual(evidence.map(row => row.childStarted), evidence.map(() => false));
});

test("issue and consume history grants validate every static binding before spawn or store open", supported, async t => {
  const f = fixture(t), first = await f.start();
  committed(await exercise(first, "permit.witness.register", f.register()));
  const req = f.issue(), issued = committed(await exercise(first, "permit.witness.issue", req));
  const use = { targetId: f.resources.targetId, checkpoint: f.checkpoint(),
    message: issued.signedPermit.message, signature: issued.signedPermit.signature };
  await first.close();
  const issue = historyQuery(f, "issue", req), consume = historyQuery(f, "consume", use);
  const pidFile = path.join(f.root, "invalid-history.pid"), before = f.state(), audit = historyAudit(f);
  const invalid = [
    [issue, q => { q.targetGeneration = null; }], [issue, q => { q.request.checkpoint = null; }],
    [issue, q => { q.request.checkpoint.revision = 0; }], [issue, q => { q.request.checkpoint.full_state_digest = "invalid"; }],
    [issue, q => { q.resources.lease.owner = "other"; }], [issue, q => { q.resources.permit.paramsDigest = "invalid"; }],
    [issue, q => { q.request.lease.idempotencyKey = "__proto__"; }], [issue, q => { q.request.permit.ttlMs = 0; }],
    [issue, q => { q.request.batchFingerprint = "c".repeat(64); }],
    [consume, q => { q.request.message.sequence = 0; }], [consume, q => { q.request.message.deadline_ms = 0; }],
    [consume, q => { q.request.message.params_digest = "other"; }], [consume, q => { q.request.message.worker_id = "other"; }],
    [consume, q => { q.request.signature = "invalid"; }],
  ];
  let clocks = 0;
  for (const [original, mutate] of invalid) {
    const query = structuredClone(original); mutate(query);
    const patch = historyAccess(f, [query]);
    await assert.rejects(f.start({ ...patch, args: [`--pid-file=${pidFile}`], witness: {
      ...patch.witness, clock: () => { clocks++; return 999; },
    } }));
    assert.equal(fs.existsSync(pidFile), false); assert.equal(clocks, 0);
    assert.deepEqual(f.state(), before); assert.deepEqual(historyAudit(f), audit);
  }
});

test("real supervised child registers, issues and atomically consumes with explicit business/resource mapping", supported, async t => {
  const f = fixture(t), host = await f.start();
  assert.equal(host.session.childIdentity.pid, host.child.pid);
  assert.notEqual(host.child.pid, process.pid);
  assert.notEqual(host.session.childIdentity.sessionId, f.resources.lease.sessionId);
  assert.equal(host.session.auditChannelHolders().ok, true);
  assert.equal(host.session.auditProcessContinuity().ok, true);
  assert.equal(host.executionAuthorized, false);
  assert.equal(host.mode, "development-only");
  for (const field of ["identity", "context", "dispatch", "createContext"]) assert.equal(Object.hasOwn(host, field), false);
  committed(await exercise(host, "permit.witness.register", f.register()));
  const issued = committed(await exercise(host, "permit.witness.issue", f.issue()));
  for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
    const expected = { ...f.resources.lease, ...f.resources.permit };
    if (Object.hasOwn(expected, storage)) assert.equal(issued.signedPermit.message[signed], expected[storage]);
  }
  const consumption = { targetId: f.resources.targetId, checkpoint: f.checkpoint(),
    message: issued.signedPermit.message, signature: issued.signedPermit.signature };
  const reserved = f.state();
  for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
    if (!Object.hasOwn(f.resources.lease, storage) && !Object.hasOwn(f.resources.permit, storage)) continue;
    rejected(await exercise(host, "permit.witness.consume", { ...consumption,
      message: { ...consumption.message, [signed]: "other" } }));
  }
  assert.deepEqual(f.state(), reserved); assert.equal(f.calls.pull, 0);
  const consumed = committed(await exercise(host, "permit.witness.consume", consumption));
  const state = f.state(), id = issued.signedPermit.message.permit_id;
  assert.equal(state.permits[id].status, "consumed");
  assert.equal(state.witness_authority.issuance_bindings[id].status, "consumed");
  assert.deepEqual(state.witness_authority.targets["target-a"].current.checkpoint, consumed.checkpoint);
  assert.deepEqual(f.calls, { observe: 1, sign: 1, pull: 1 });
  const exited = once(host.child, "exit");
  await host.close(); await exited; await host.close();
  assert.equal(host.session.closed, true);
  await assert.rejects(host.session.request("ping"), /not established/);
});

test("caller claims, legacy operations and resource substitution cannot reach providers", supported, async t => {
  const f = fixture(t), host = await f.start(), before = f.state();
  for (const operation of ["permit.issue", "permit.key", "permit.verify", "permit.revoke", "register", "constructor", "__proto__"]) {
    const result = await exercise(host, operation, f.register());
    assert.equal(result.ok, false);
    assert.match(result.error, /operation_not_in_batch/);
  }
  for (const claims of [{ identity: host.session.childIdentity }, { authenticated: true }, { principal: "principal" },
    { sessionId: host.session.sessionId }, { backend: "legacy" }, { mode: "production" }]) {
    rejected(await exercise(host, "permit.witness.register", { ...f.register(), ...claims }));
  }
  rejected(await exercise(host, "permit.witness.register", { ...f.register(), targetId: "other-target" }));
  rejected(await exercise(host, "permit.witness.register", { ...f.register(), pin: { ...f.resources.pin, run_id: "other" } }));
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.calls, { observe: 0, sign: 0, pull: 0 });
  committed(await exercise(host, "permit.witness.register", f.register()));
  const registered = f.state();
  // Every explicitly assigned lease field, including the business session,
  // must match; transport identity is not a default for any of these fields.
  for (const field of Object.keys(f.resources.lease)) {
    const request = f.issue(); request.lease[field] += "-forged";
    rejected(await exercise(host, "permit.witness.issue", request));
  }
  const request = f.issue(); request.lease.sessionId = host.session.sessionId;
  rejected(await exercise(host, "permit.witness.issue", request));
  assert.deepEqual(f.state(), registered); assert.equal(f.calls.sign, 0);
});

test("signed child requests still obey host action scope; unsigned requests never dispatch", supported, async t => {
  const f = fixture(t);
  f.options.assignment.actions = ["register"];
  const host = await f.start(), before = f.state();
  await exercise(host, "permit.witness.register", f.register(), "forge");
  assert.ok(host.session.rejections.some(entry => entry.reason === "inbound_request_signature_mismatch"));
  assert.deepEqual(f.state(), before); assert.equal(f.calls.observe, 0);
  assert.equal((await exercise(host, "permit.witness.issue", {})).ok, false);
  // The host snapshots configuration; later mutation cannot enlarge the scope.
  f.options.assignment.actions.push("issue");
  f.resources.lease.workerId = "mutated";
  committed(await exercise(host, "permit.witness.register", f.register()));
  assert.equal((await exercise(host, "permit.witness.issue", {})).ok, false);
});

test("factory refuses external identity/session/facts and implicit business mappings before provisioning", supported, async t => {
  const f = fixture(t);
  for (const patch of [{ identity: Object.freeze({}) }, { session: {} }, { factSource: {} }, { host: {} },
    { onAuthorizedRequest: () => {} }, { onIdentityUnavailable: () => {} },
    { fallback: () => {} }, { env: {} }, { spawnOptions: {} },
    { assignment: { ...f.options.assignment, businessSessionId: undefined } },
    { assignment: { ...f.options.assignment, businessSessionId: "other-session" } },
    { assignment: { ...f.options.assignment, principal: "other" } },
    { assignment: { ...f.options.assignment, actions: ["register", "register"] } },
    { assignment: { ...f.options.assignment, actions: ["key"] } },
    { witness: { ...f.options.witness, backend: "legacy" } },
    { witness: { ...f.options.witness, mode: "production" } },
    { witness: { ...f.options.witness, fallback: () => {} } }]) {
    await assert.rejects(f.start(patch));
    assert.equal(fs.existsSync(f.options.witness.file), false);
  }
  assert.deepEqual(Object.values(OPERATIONS), ["register", "issue", "consume"]);
});

test("unavailable real OS audit conservatively refuses binding without initializing storage", supported, async t => {
  const f = fixture(t), originalPath = process.env.PATH;
  const pidFile = path.join(f.root, "rejected-child.pid");
  // Remove access to lsof/ps (and cc if not yet compiled). No invented facts.
  process.env.PATH = scratch;
  try { await assert.rejects(f.start({ args: [`--pid-file=${pidFile}`] }), { code: "ERR_WITNESS_MANAGED_IDENTITY_UNAVAILABLE" }); }
  finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
  assert.equal(fs.existsSync(f.options.witness.file), false);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(f.calls, { observe: 0, sign: 0, pull: 0 });
});

test("a supervisor pre-audit failure permanently revokes witness access after the real holder exits", supported, async t => {
  const f = fixture(t), host = await f.start(), before = f.state();
  const transfer = await exercise(host, null, null, "transfer");
  const audit = host.session.auditChannelHolders();
  assert.equal(audit.ok, false); assert.equal(audit.reason, "channel_handle_transferred");
  assert.ok(audit.holders.includes(transfer.pid));
  const reply = await exercise(host, "permit.witness.register", f.register());
  assert.equal(reply.ok, false);
  assert.match(reply.error, /managed_caller_identity_unavailable/);
  assert.deepEqual(f.state(), before); assert.equal(f.calls.observe, 0);
  assert.equal((await exercise(host, null, null, "release")).ok, true);
  assert.throws(() => process.kill(transfer.pid, 0), { code: "ESRCH" });
  assert.equal(host.session.established, true);
  assert.equal(host.session.auditChannelHolders().ok, true);
  assert.equal(host.session.auditProcessContinuity().ok, true);
  // Clean OS facts do not undo a prior identity failure on this same session.
  for (const operation of Object.keys(OPERATIONS)) {
    const retry = await exercise(host, operation, f.register());
    assert.equal(retry.ok, false);
    assert.match(retry.error, /managed_caller_identity_unavailable|managed_operation_rejected/);
  }
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.calls, { observe: 0, sign: 0, pull: 0 });
});

test("failed handshake reaps the actual child without provisioning or fallback", supported, async t => {
  const f = fixture(t), pidFile = path.join(f.root, "handshake-child.pid");
  await assert.rejects(f.start({ args: [`--pid-file=${pidFile}`, "--no-handshake"], handshakeTimeoutMs: 1000 }), /timed out/);
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
  assert.equal(fs.existsSync(f.options.witness.file), false);
  assert.deepEqual(f.calls, { observe: 0, sign: 0, pull: 0 });
});

test("invalid assignments are refused before child spawn or any store/anchor initialization or open", supported, async t => {
  const f = fixture(t), pidFile = path.join(f.root, "invalid-grant-child.pid");
  const invalid = [
    a => { a.businessSessionId = "other-session"; },
    a => { a.principal = "other-principal"; },
    a => { a.actions = []; },
    a => { a.actions = ["register", "register"]; },
    a => { a.actions = ["key"]; },
    a => { a.resources.targetId = ""; },
    a => { a.resources.extra = true; },
    a => { delete a.resources.permit; },
    a => { a.resources.pin.decision_id = "other-decision"; },
    a => { a.resources.pin.instance_id = "unassigned-target"; },
    a => { a.resources.pin.run_id = "other-run"; },
    a => { a.resources.pin.generation = "other-generation"; },
    a => { a.resources.pin.public_key_pem = "invalid"; },
    a => { a.resources.pin.fingerprint = "c".repeat(64); },
    a => { a.resources.pin.source_digest = ""; },
    a => { a.resources.pin.deployment_digest = ""; },
    a => { a.resources.pin.valid_from = -1; },
    a => { a.resources.pin.valid_until = a.resources.pin.valid_from; },
    a => { a.resources.pin.valid_until = 1.5; },
    a => { a.resources.lease.owner = "other-owner"; },
    a => { a.resources.lease.hostId = ""; },
    a => { a.resources.lease.extra = true; },
    a => { a.resources.permit.operation = ""; },
    a => { a.resources.permit.targetDigest = "invalid"; },
    a => { a.resources.permit.paramsDigest = "invalid"; },
    a => { a.resources.maxLeaseTtlMs = 0; },
    a => { a.resources.maxPermitTtlMs = 1.5; },
  ];
  function files() {
    return Object.fromEntries(fs.readdirSync(f.root, { recursive: true }).sort().map(name => {
      const file = path.join(f.root, name);
      return [name, fs.statSync(file).isDirectory() ? null : fs.readFileSync(file)];
    }));
  }
  for (const access of ["initialize", "open"]) {
    if (access === "open") {
      const host = await f.start();
      committed(await exercise(host, "permit.witness.register", f.register()));
      await host.close();
    }
    const before = files(), calls = { ...f.calls };
    let clockCalls = 0;
    for (const mutate of invalid) {
      const assignment = structuredClone(f.options.assignment);
      mutate(assignment);
      await assert.rejects(f.start({ assignment, args: [`--pid-file=${pidFile}`], witness: {
        ...f.options.witness, access, clock: () => { clockCalls++; return 1000; },
        storeOptions: { ...f.options.witness.storeOptions, ...(access === "open" ? { minimumEpoch: 1 } : {}) },
      } }));
      assert.deepEqual(files(), before, `${access}: ${mutate}`);
      assert.equal(fs.existsSync(pidFile), false);
      assert.equal(clockCalls, 0);
      assert.deepEqual(f.calls, calls);
    }
  }
});

test("reopening on a different real child does not infer resources from transport identity", supported, async t => {
  const f = fixture(t), first = await f.start();
  committed(await exercise(first, "permit.witness.register", f.register()));
  const oldIdentity = structuredClone(first.session.childIdentity);
  await first.close();
  const second = await f.start({ witness: { ...f.options.witness, access: "open",
    storeOptions: { ...f.options.witness.storeOptions, minimumEpoch: 1 } } });
  assert.notEqual(second.session.childIdentity.sessionId, oldIdentity.sessionId);
  rejected(await exercise(second, "permit.witness.issue", { ...f.issue(), identity: oldIdentity }));
  const issued = committed(await exercise(second, "permit.witness.issue", f.issue()));
  assert.equal(issued.signedPermit.message.session_id, f.options.assignment.businessSessionId);
});

test("real channel loss during a provider cannot report a successful transaction", supported, async t => {
  const f = fixture(t);
  let host;
  f.options.witness.providers.observeTarget = () => {
    f.calls.observe++;
    host.child.disconnect();
    return { targetHasProcess: false, targetHasPriorRun: false };
  };
  host = await f.start();
  const before = f.state(), disconnected = once(host.child, "disconnect");
  // There is intentionally no reply on a lost channel. Observe actual state
  // and terminal process/session behavior, never infer a committed response.
  host.child.send({ type: "exercise", id: "disconnect-test", operation: "permit.witness.register", payload: f.register() });
  await disconnected;
  await host.close();
  assert.deepEqual(f.state(), before);
  assert.equal(f.calls.observe, 1); assert.equal(f.calls.sign, 0);
  assert.equal(host.session.closed, true);
});

test("provider failure keeps the witness unknown/blocked without legacy retry", supported, async t => {
  const f = fixture(t);
  f.options.witness.providers.observeTarget = () => { f.calls.observe++; throw new Error("private provider failure"); };
  const host = await f.start(), before = f.state();
  const reply = await exercise(host, "permit.witness.register", f.register());
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { status: "unknown", commit: "unknown", mode: "development-only",
    executionAuthorized: false, code: "ERR_WITNESS_TRANSACTION_OUTCOME_UNKNOWN" });
  rejected(await exercise(host, "permit.witness.register", f.register()));
  assert.equal(f.calls.observe, 1); assert.deepEqual(f.state(), before);
});
