"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPermitWitnessHost } = require("../../lib/coordination/permit-witness-host");
const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const delivery = require("../../lib/coordination/permit-delivery");
const anchor = require("../../lib/coordination/protected-anchor");
const { signRevocationList } = require("../../lib/coordination/permit-revocation-signing");

// Local composition tests, not transport-authentication or production evidence.
// All databases, anchors, and runtime scratch stay below .agent/runtime.
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || process.platform === "win32" };
function fixture(t) {
  const base = testRuntime("test-tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "permit-witness-host-"));
  const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  const key = delivery.createBatchKeyPair();
  const resources = { targetId: "target-a", pin: { decision_id: "D-test", instance_id: "target-a",
    fingerprint: key.fingerprint, public_key_pem: key.publicKeyPem, source_digest: "sha256:source",
    deployment_digest: "sha256:deployment", run_id: "run", generation: "1", valid_from: 1, valid_until: 100000 },
    lease: { owner: "owner", sessionId: "business-session", hostId: "host", workerId: "worker", runId: "run",
      generation: "1", desktopKey: "desktop", ownedAppId: "app" },
    permit: { operation: "invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64) },
    maxLeaseTtlMs: 5000, maxPermitTtlMs: 2000 };
  const identity = Object.freeze({ sessionId: "transport-session", pid: 123 });
  const controls = { now: 1000, alive: true, revoked: [], observation: { targetHasProcess: false, targetHasPriorRun: false },
    signCalls: 0, pullCalls: 0, observeCalls: 0, clockCalls: 0, afterSign: null, afterPull: null };
  const config = { backend: "development-witness", mode: "development-only", access: "initialize",
    file: path.join(dbDir, "authority.sqlite"), authorityId: "test-authority",
    storeOptions: { decisionId: "D-test", anchorDir, anchorMode: "permissive" },
    clock: () => { controls.clockCalls++; return controls.now; },
    providers: {
      observeTarget: () => { controls.observeCalls++; return controls.observation; },
      signPermit: (fingerprint, permit, now) => {
        controls.signCalls++;
        const result = { fingerprint, publicKeyPem: key.publicKeyPem,
          signedPermit: delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit, issuedAtMs: now, nowMs: now }) };
        if (controls.afterSign) controls.afterSign();
        return result;
      },
      pullRevocation: (_targetId, current, now) => {
        controls.pullCalls++;
        const result = signRevocationList({ ...key, issuedAtMs: now, fingerprints: controls.revoked,
          state: { appliedRevocationSequence: current.state.applied_revocation_sequence,
            revokedFingerprints: new Set(current.state.revoked_fingerprints) } });
        if (controls.afterPull) controls.afterPull();
        return result;
      },
    } };
  const hosts = [];
  const start = (patch = {}) => { const host = createPermitWitnessHost({ ...config, ...patch }); hosts.push(host); return host; };
  const contextInput = (patch = {}) => ({ identity, principal: "owner", actions: ["register", "issue", "consume"],
    resources, isCurrent: (actual) => actual === identity && controls.alive, ...patch });
  // Independent read-only evidence, never supplied as authorization facts.
  function readState() {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(config.file, { readOnly: true });
    try { return JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id = 1").get().body); }
    finally { db.close(); }
  }
  t.after(() => {
    for (const host of hosts) host.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const registerRequest = () => ({ targetId: resources.targetId, requestId: "registration-1", checkpoint: null,
    pin: structuredClone(resources.pin) });
  const checkpoint = () => readState().witness_authority.targets[resources.targetId].current.checkpoint;
  const issueRequest = () => ({ targetId: resources.targetId, checkpoint: checkpoint(), batchFingerprint: key.fingerprint,
    lease: { ...resources.lease, idempotencyKey: "lease-1", ttlMs: 5000 },
    permit: { ...resources.permit, idempotencyKey: "permit-1", ttlMs: 2000 } });
  const consumeRequest = (issued) => ({ targetId: resources.targetId, checkpoint: checkpoint(),
    message: structuredClone(issued.signedPermit.message), signature: issued.signedPermit.signature });
  function prepare() {
    const host = start(), context = host.createContext(contextInput());
    assert.equal(host.dispatch(context, "register", registerRequest()).status, "committed");
    return { host, context };
  }
  function issue(host, context) {
    const result = host.dispatch(context, "issue", issueRequest());
    assert.equal(result.status, "committed");
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.result.executionAuthorized, false);
    return result.result;
  }
  return { root, key, config, controls, resources, identity, start, contextInput, readState, registerRequest,
    checkpoint, issueRequest, consumeRequest, prepare, issue };
}
function rejected(result) {
  assert.equal(result.status, "rejected");
  assert.equal(result.commit, "not-attempted");
  assert.equal(result.executionAuthorized, false);
}
function unknown(result) {
  assert.deepEqual(result, { status: "unknown", commit: "unknown", mode: "development-only",
    executionAuthorized: false, code: "ERR_WITNESS_TRANSACTION_OUTCOME_UNKNOWN" });
}

function historyQuery(f, operation, request) {
  return { operation, decisionId: "D-test", authorityId: "test-authority", issuerStoreId: f.readState().store_id,
    targetGeneration: request.checkpoint === null ? null : request.checkpoint.store_generation,
    resources: operation === "register" ? { fingerprint: f.key.fingerprint, lease: null, permit: null } : {
      fingerprint: f.key.fingerprint, lease: structuredClone(f.resources.lease), permit: structuredClone(f.resources.permit) },
    request: structuredClone(request) };
}
function historyInput(query, patch = {}) {
  const identity = Object.freeze({});
  return { identity, principal: "independent-reviewer", query,
    isCurrent: actual => actual === identity, ...patch };
}
function observed(result, status = "found") {
  assert.equal(result.status, "observed"); assert.equal(result.commit, "not-applicable");
  assert.equal(result.mode, "development-only"); assert.equal(result.executionAuthorized, false);
  assert.equal(result.resumeAllowed, false); assert.equal(result.originalRequestOutcome, "unknown");
  assert.equal(result.result.status, status); assert.equal(result.result.executionAuthorized, false);
  assert.equal(result.result.resumeAllowed, false); assert.equal(result.result.originalRequestOutcome, "unknown");
  const forbidden = new Set(["signature", "signedPermit", "signedIssuance", "message_bytes", "message", "bytes", "publicKeyPem", "public_key_pem"]);
  function scan(value) {
    if (value && typeof value === "object") {
      assert.ok(Object.isFrozen(value));
      for (const [key, child] of Object.entries(value)) { assert.equal(forbidden.has(key), false, key); scan(child); }
    }
  }
  scan(result);
}
function historyAudit(f) {
  return fs.readFileSync(path.join(f.config.storeOptions.anchorDir, "protected-anchor-audit.log"), "utf8")
    .trim().split("\n").map(JSON.parse).filter(row => row.event === "witness-history-observation");
}

test("independent reviewer observes all effects and bounded absence without providers or authority changes", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), reg = f.registerRequest(), req = f.issueRequest();
  const use = f.consumeRequest(f.issue(host, context));
  assert.equal(host.dispatch(context, "consume", use).status, "committed");
  const before = f.readState(), calls = [f.controls.observeCalls, f.controls.signCalls, f.controls.pullCalls, f.controls.clockCalls];
  for (const [operation, request] of [["register", reg], ["issue", req], ["consume", use]]) {
    const q = historyQuery(f, operation, request), reader = host.createHistoryContext(historyInput(q));
    const result = host.queryHistory(reader, q); observed(result);
    assert.equal(result.result.effect.historicalPrincipal, "not-recorded");
  }
  const absent = structuredClone(reg); absent.requestId = "absent";
  const q = historyQuery(f, "register", absent), reader = host.createHistoryContext(historyInput(q));
  observed(host.queryHistory(reader, q), "not-found-at-boundary");
  assert.deepEqual(f.readState(), before);
  assert.deepEqual([f.controls.observeCalls, f.controls.signCalls, f.controls.pullCalls, f.controls.clockCalls], calls);
  const audit = historyAudit(f); assert.equal(audit.length, 4);
  assert.equal(JSON.stringify(audit).includes(use.signature), false);
  assert.equal(JSON.stringify(audit).includes("independent-reviewer"), false);
});

test("history contexts cannot be forged, serialized, reused across hosts or substituted for write grants", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  const reader = host.createHistoryContext(historyInput(q)), before = f.readState();
  for (const forged of [context, null, {}, { ...reader }, JSON.parse(JSON.stringify(reader))]) {
    assert.equal(host.queryHistory(forged, q).status, "rejected");
  }
  rejected(host.dispatch(reader, "register", f.registerRequest()));
  const other = f.start({ access: "open", storeOptions: { ...f.config.storeOptions, minimumEpoch: 1 } });
  assert.equal(other.queryHistory(reader, q).status, "rejected");
  assert.deepEqual(f.readState(), before); assert.equal(historyAudit(f).length, 0);
  observed(host.queryHistory(reader, q));
  host.revokeContext(reader);
  assert.equal(host.queryHistory(reader, q).status, "rejected");
  host.close();
  assert.equal(host.queryHistory(reader, q).status, "unavailable");
  assert.throws(() => host.createHistoryContext(historyInput(q)));
});

test("history assignments are exact detached grants and reject implicit permissions", supported, t => {
  const f = fixture(t), { host } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  for (const patch of [{ principal: "" }, { identity: null }, { isCurrent: () => false },
    { isCurrent: () => true, actions: ["register"] }, { query: { operation: "register" } },
    { query: { ...q, decisionId: "other" } }, { query: { ...q, authorityId: "other" } },
    { query: { ...q, operation: "constructor" } }, { isCurrent: () => Promise.resolve(true) }]) {
    assert.throws(() => host.createHistoryContext(historyInput(q, patch)));
  }
  const input = historyInput(structuredClone(q)), reader = host.createHistoryContext(input);
  input.principal = "changed-reviewer"; input.query.request.requestId = "other"; input.isCurrent = () => false;
  assert.equal(host.queryHistory(reader, input.query).status, "rejected");
  observed(host.queryHistory(reader, q));
  const crypto = require("node:crypto");
  assert.equal(historyAudit(f)[0].query_principal_digest,
    crypto.createHash("sha256").update("independent-reviewer").digest("hex"));
});

test("request resource changes cannot enlarge an independently assigned history grant", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), req = f.issueRequest();
  f.issue(host, context);
  const q = historyQuery(f, "issue", req), reader = host.createHistoryContext(historyInput(q));
  const patches = [q => { q.decisionId = "other"; }, q => { q.authorityId = "other"; },
    q => { q.issuerStoreId = "other"; }, q => { q.targetGeneration = "old-generation"; },
    q => { q.request.targetId = "other"; }, q => { q.resources.fingerprint = "f".repeat(64); },
    ...Object.keys(q.resources.lease).map(key => q => { q.resources.lease[key] = "other"; }),
    ...Object.keys(q.resources.permit).map(key => q => { q.resources.permit[key] = "other"; })];
  const lookup = ProtectedPermitStore.prototype.queryWitnessHistory;
  let entries = 0;
  ProtectedPermitStore.prototype.queryWitnessHistory = () => { entries++; throw new Error("must not inspect"); };
  try {
    for (const patch of patches) {
      const changed = structuredClone(q); patch(changed);
      assert.equal(host.queryHistory(reader, changed).status, "rejected");
    }
  } finally { ProtectedPermitStore.prototype.queryWitnessHistory = lookup; }
  assert.equal(entries, 0); assert.equal(historyAudit(f).length, 0);
  observed(host.queryHistory(reader, q));
});

for (const damage of ["target", "generation", "owner"]) test(`fresh independent authorization cannot replace the stored historical ${damage}`, supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), use = f.consumeRequest(f.issue(host, context));
  assert.equal(host.dispatch(context, "consume", use).status, "committed");
  const q = historyQuery(f, "consume", use);
  if (damage === "target") {
    const resources = structuredClone(f.resources); resources.targetId = "target-b"; resources.pin.instance_id = "target-b";
    const writer = host.createContext(f.contextInput({ resources }));
    const request = { targetId: "target-b", requestId: "registration-b", checkpoint: null, pin: resources.pin };
    const registered = host.dispatch(writer, "register", request);
    assert.equal(registered.status, "committed");
    q.request.targetId = "target-b"; q.request.checkpoint = registered.result.checkpoint;
    q.targetGeneration = registered.result.checkpoint.store_generation;
  } else if (damage === "generation") {
    q.targetGeneration = "old-generation"; q.request.checkpoint.store_generation = "old-generation";
  } else q.resources.lease.owner = "forged-owner";
  const reader = host.createHistoryContext(historyInput(q)), before = f.readState();
  const result = host.queryHistory(reader, q);
  assert.equal(result.status, "unknown"); assert.equal(Object.hasOwn(result, "result"), false);
  assert.equal(historyAudit(f).length, 0); assert.deepEqual(f.readState(), before);
  assert.equal(host.queryHistory(reader, q).status, "unavailable");
  rejected(host.dispatch(context, "consume", use));
});

for (const present of [true, false]) test(`blocked host permits ${present ? "found" : "absent"} history without reviving writes`, supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), req = f.issueRequest();
  const changed = structuredClone(req); changed.checkpoint.full_state_digest = "f".repeat(64);
  unknown(host.dispatch(context, "issue", changed));
  const request = f.registerRequest(); if (!present) request.requestId = "absent";
  const q = historyQuery(f, "register", request), before = f.readState();
  const reader = host.createHistoryContext(historyInput(q));
  observed(host.queryHistory(reader, q), present ? "found" : "not-found-at-boundary");
  rejected(host.dispatch(context, "issue", req));
  assert.throws(() => host.createContext(f.contextInput()), { code: "ERR_WITNESS_HOST_UNAVAILABLE" });
  assert.deepEqual(f.readState(), before); assert.equal(f.controls.signCalls, 0);
});

test("clock-poisoned authority remains observable and never regains write permission", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), req = f.issueRequest();
  f.controls.now = 999; unknown(host.dispatch(context, "issue", req));
  f.controls.now = 100000;
  const q = historyQuery(f, "register", f.registerRequest()), before = f.readState();
  const result = host.queryHistory(host.createHistoryContext(historyInput(q)), q);
  observed(result); assert.equal(result.result.clockPoisoned, true);
  rejected(host.dispatch(context, "issue", req)); assert.deepEqual(f.readState(), before);
});

test("poisoned store is never reopened, recovered or retried for history", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), use = f.consumeRequest(f.issue(host, context));
  const append = anchor.appendEntry;
  anchor.appendEntry = (file, entry) => { if (entry.type === "commit") throw new Error("postcommit"); return append(file, entry); };
  try { unknown(host.dispatch(context, "consume", use)); } finally { anchor.appendEntry = append; }
  const q = historyQuery(f, "consume", use), reader = host.createHistoryContext(historyInput(q)), before = f.readState();
  const methods = ["initialize", "open", "recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"];
  const originals = methods.map(name => ProtectedPermitStore[name]); let bypasses = 0;
  for (const name of methods) ProtectedPermitStore[name] = () => { bypasses++; throw new Error("forbidden bypass"); };
  try {
    const result = host.queryHistory(reader, q);
    assert.equal(result.status, "unknown"); assert.equal(result.resumeAllowed, false);
    assert.equal(Object.hasOwn(result, "result"), false);
    assert.equal(host.queryHistory(reader, q).status, "unavailable");
    assert.throws(() => host.createHistoryContext(historyInput(q)));
  } finally { methods.forEach((name, i) => { ProtectedPermitStore[name] = originals[i]; }); }
  assert.equal(bypasses, 0); assert.equal(historyAudit(f).length, 0);
  rejected(host.dispatch(context, "consume", use)); assert.deepEqual(f.readState(), before);
});

test("history barrier covers context identity checks, store authorizations and final result release", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  let reader, checks = 0;
  const input = historyInput(q, { isCurrent: () => {
    checks++;
    rejected(host.dispatch(context, "register", f.registerRequest()));
    assert.equal(host.queryHistory(reader, q).status, "unavailable");
    assert.throws(() => host.createContext(f.contextInput()), { code: "ERR_WITNESS_HOST_UNAVAILABLE" });
    assert.throws(() => host.createHistoryContext(historyInput(q)), { code: "ERR_WITNESS_HOST_UNAVAILABLE" });
    assert.throws(() => host.close(), { code: "ERR_WITNESS_HOST_UNAVAILABLE" });
    return true;
  } });
  reader = host.createHistoryContext(input);
  observed(host.queryHistory(reader, q)); assert.equal(checks, 8);
  assert.equal(historyAudit(f).length, 1);
  assert.equal(host.dispatch(context, "register", f.registerRequest()).status, "committed");
});

test("a write provider cannot enter history inspection or create its grant while the host is active", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  const reader = host.createHistoryContext(historyInput(q));
  let checked = false;
  f.controls.afterSign = () => {
    checked = true;
    assert.equal(host.queryHistory(reader, q).status, "unavailable");
    assert.throws(() => host.createHistoryContext(historyInput(q)), { code: "ERR_WITNESS_HOST_UNAVAILABLE" });
  };
  f.issue(host, context); assert.equal(checked, true); assert.equal(historyAudit(f).length, 0);
  observed(host.queryHistory(reader, q));
});

for (const step of [1, 2, 3, 4, 5, 6, 7]) test(`history identity loss at query check ${step} never returns an observation or revives the context`, supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  let checking = false, checks = 0, alive = true;
  const reader = host.createHistoryContext(historyInput(q, { isCurrent: () => {
    if (checking && ++checks === step) return false;
    return alive;
  } }));
  checking = true;
  const result = host.queryHistory(reader, q);
  assert.equal(result.status, step === 1 ? "rejected" : "unknown");
  assert.equal(Object.hasOwn(result, "result"), false); assert.equal(result.resumeAllowed, false);
  checking = false; alive = true;
  assert.notEqual(host.queryHistory(reader, q).status, "observed");
  assert.equal(historyAudit(f).length, step >= 5 ? 1 : 0);
  if (step > 1) rejected(host.dispatch(context, "register", f.registerRequest()));
});

test("revoking a history context during authorization withholds its result and blocks writes", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  let reader, revoke = false, checks = 0;
  reader = host.createHistoryContext(historyInput(q, { isCurrent: () => {
    if (revoke && ++checks === 2) host.revokeContext(reader);
    return true;
  } }));
  revoke = true;
  assert.equal(host.queryHistory(reader, q).status, "unknown");
  assert.equal(historyAudit(f).length, 0);
  rejected(host.dispatch(context, "register", f.registerRequest()));
});

for (const behavior of ["promise", "rejected-promise", "throws"]) test(`history query rejects ${behavior} identity checks without later resurrection`, supported, t => {
  const f = fixture(t), { host } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  let asynchronous = false;
  const reader = host.createHistoryContext(historyInput(q, { isCurrent: () => {
    if (!asynchronous) return true;
    if (behavior === "throws") throw new Error("private identity detail");
    return behavior === "promise" ? Promise.resolve(true) : Promise.reject(new Error("private identity detail"));
  } }));
  asynchronous = true;
  const result = host.queryHistory(reader, q);
  assert.equal(result.status, "rejected"); assert.equal(Object.hasOwn(result, "result"), false);
  asynchronous = false;
  assert.equal(host.queryHistory(reader, q).status, "rejected");
  assert.equal(historyAudit(f).length, 0);
});

for (const damage of ["audit", "binding"]) test(`history ${damage} failure latches both surfaces without leaking private errors`, supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), request = f.registerRequest();
  if (damage === "binding") request.pin.source_digest = "different-original-request";
  const q = historyQuery(f, "register", request), reader = host.createHistoryContext(historyInput(q)), before = f.readState();
  const write = fs.writeSync;
  if (damage === "audit") fs.writeSync = () => { throw new Error("private audit detail"); };
  let result;
  try { result = host.queryHistory(reader, q); } finally { fs.writeSync = write; }
  assert.deepEqual(result, { status: "unknown", commit: "not-applicable", mode: "development-only",
    executionAuthorized: false, resumeAllowed: false, originalRequestOutcome: "unknown",
    code: "ERR_WITNESS_HISTORY_OBSERVATION_UNKNOWN" });
  assert.equal(host.queryHistory(reader, q).status, "unavailable");
  rejected(host.dispatch(context, "register", f.registerRequest()));
  assert.throws(() => host.createContext(f.contextInput()));
  assert.deepEqual(f.readState(), before);
});

for (const failure of ["read-rollback", "lock-close"]) test(`history ${failure} failure cannot return a result or reopen the host`, supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), q = historyQuery(f, "register", f.registerRequest());
  const reader = host.createHistoryContext(historyInput(q)), before = f.readState();
  const { DatabaseSync } = require("node:sqlite");
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  let read, lock, triggered = 0;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === "BEGIN") read = this;
    if (sql === "BEGIN IMMEDIATE") lock = this;
    if (failure === "read-rollback" && this === read) {
      if (sql === "COMMIT") throw new Error("private commit failure");
      if (sql === "ROLLBACK") { triggered++; throw new Error("private rollback failure"); }
    }
    return exec.call(this, sql);
  };
  DatabaseSync.prototype.close = function() {
    const result = close.call(this);
    if (failure === "lock-close" && this === lock) { triggered++; throw new Error("private lock cleanup failure"); }
    return result;
  };
  let result;
  try { result = host.queryHistory(reader, q); }
  finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close; }
  assert.equal(triggered, 1); assert.equal(result.status, "unknown");
  assert.equal(Object.hasOwn(result, "result"), false); assert.equal(result.resumeAllowed, false);
  assert.equal(historyAudit(f).length, failure === "lock-close" ? 1 : 0);
  assert.equal(host.queryHistory(reader, q).status, "unavailable");
  rejected(host.dispatch(context, "register", f.registerRequest()));
  assert.throws(() => host.createHistoryContext(historyInput(q)));
  assert.deepEqual(f.readState(), before);
});

test("explicit development backend owns register, issue and atomic consume without granting execution", supported, t => {
  const f = fixture(t), { host, context } = f.prepare();
  const issued = f.issue(host, context), request = f.consumeRequest(issued);
  const result = host.dispatch(context, "consume", request);
  assert.equal(result.status, "committed"); assert.equal(result.commit, "confirmed");
  assert.equal(result.executionAuthorized, false); assert.equal(result.result.executionAuthorized, false);
  assert.equal(result.result.status, "consumed");
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.result.checkpoint));
  const state = f.readState(), id = request.message.permit_id;
  const current = state.witness_authority.targets["target-a"].current;
  assert.equal(state.schema_version, 3);
  assert.equal(state.permits[id].status, "consumed");
  assert.equal(state.witness_authority.issuance_bindings[id].status, "consumed");
  assert.deepEqual(current.checkpoint, result.result.checkpoint);
  assert.equal(current.state.highest_accepted_permit_sequence, request.message.sequence);
  assert.equal(current.state.applied_revocation_sequence, 1);
  assert.equal(f.controls.observeCalls, 1); assert.equal(f.controls.signCalls, 1); assert.equal(f.controls.pullCalls, 1);
  unknown(host.dispatch(context, "consume", request));
  assert.equal(f.controls.pullCalls, 1);
});

test("factory refuses implicit, production, injected-store and fallback configurations before provisioning", supported, t => {
  const f = fixture(t);
  for (const patch of [{ backend: undefined }, { backend: "legacy" }, { mode: "production" }, { access: "auto" },
    { productionEnabled: true }, { store: {} }, { batchSession: {} }, { targetService: {} }, { fallback: () => {} },
    { storeOptions: { ...f.config.storeOptions, witnessAuthority: {} } },
    { storeOptions: { ...f.config.storeOptions, adapter: {} } }, { providers: { ...f.config.providers, authorize: () => true } }]) {
    assert.throws(() => f.start(patch));
  }
  assert.equal(fs.existsSync(f.config.file), false);
});

test("open cannot initialize, adopt or upgrade a legacy store", supported, t => {
  const f = fixture(t);
  assert.throws(() => f.start({ access: "open", storeOptions: { ...f.config.storeOptions, minimumEpoch: 1 } }));
  assert.equal(fs.existsSync(f.config.file), false);
  const store = ProtectedPermitStore.initialize(f.config.file, { ...f.config.storeOptions, clock: () => 1000 });
  store.close();
  const before = f.readState();
  assert.throws(() => f.start({ access: "open", storeOptions: { ...f.config.storeOptions, minimumEpoch: 1 } }),
    { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  assert.deepEqual(f.readState(), before);
});

test("contexts reject forgery, serialization, cross-host reuse, closed sessions and wrong actions", supported, t => {
  const f = fixture(t), host = f.start(), context = host.createContext(f.contextInput());
  const before = f.readState();
  for (const forged of [null, undefined, "verified", {}, { ...context }, JSON.parse(JSON.stringify(context)),
    { authenticated: true, principal: "test-principal", identity: f.identity }]) rejected(host.dispatch(forged, "register", f.registerRequest()));
  const other = f.start({ access: "open", storeOptions: { ...f.config.storeOptions, minimumEpoch: 1 } });
  rejected(other.dispatch(context, "register", f.registerRequest()));
  const restricted = host.createContext(f.contextInput({ actions: ["consume"] }));
  rejected(host.dispatch(restricted, "register", f.registerRequest()));
  f.controls.alive = false;
  rejected(host.dispatch(context, "register", f.registerRequest()));
  assert.deepEqual(f.readState(), before); assert.equal(f.controls.observeCalls, 0);
});

test("trusted host registration still requires exact grants and a synchronous live-session predicate", supported, t => {
  const f = fixture(t), host = f.start();
  for (const patch of [{ principal: "" }, { identity: null }, { actions: ["key"] }, { actions: ["register", "register"] },
    { isCurrent: () => false }, { isCurrent: () => "true" }, { isCurrent: () => Promise.resolve(true) },
    { isCurrent: () => { throw new Error("private credential detail"); } },
    { resources: { ...f.resources, targetId: "target-b" } },
    { resources: { ...f.resources, pin: { ...f.resources.pin, generation: "2" } } },
    { resources: { ...f.resources, permit: { ...f.resources.permit, targetDigest: "invalid" } } },
    { resources: { ...f.resources, maxPermitTtlMs: 0 } }, { resources: { ...f.resources, arbitrary: true } }]) {
    assert.throws(() => host.createContext(f.contextInput(patch)));
  }
  const context = host.createContext(f.contextInput());
  host.revokeContext(context);
  rejected(host.dispatch(context, "register", f.registerRequest()));
  const another = host.createContext(f.contextInput());
  host.close();
  rejected(host.dispatch(another, "register", f.registerRequest()));
  assert.throws(() => host.createContext(f.contextInput()));
});

test("unsupported legacy operations and request-controlled dependencies never reach a provider", supported, t => {
  const f = fixture(t), host = f.start(), context = host.createContext(f.contextInput()), before = f.readState();
  for (const action of ["verify", "key", "revoke", "consumeWithCheckpoint", "constructor", "__proto__", "issueWitnessPermit"]) {
    rejected(host.dispatch(context, action, f.registerRequest()));
  }
  for (const extra of [{ authenticated: true }, { mode: "production" }, { backend: "legacy" }, { provider: {} },
    { facts: { targetHasProcess: false } }, { executionAuthorized: true }]) {
    rejected(host.dispatch(context, "register", { ...f.registerRequest(), ...extra }));
  }
  const getter = f.registerRequest();
  Object.defineProperty(getter, "pin", { enumerable: true, get() { throw new Error("must not invoke accessor"); } });
  rejected(host.dispatch(context, "register", getter));
  rejected(host.dispatch(context, "register", { toJSON: () => f.registerRequest() }));
  assert.equal(f.controls.observeCalls, 0); assert.deepEqual(f.readState(), before);
});

test("registration binds every approved pin field and target before transaction entry", supported, t => {
  const f = fixture(t), host = f.start(), context = host.createContext(f.contextInput()), before = f.readState();
  for (const field of Object.keys(f.resources.pin)) {
    const request = f.registerRequest();
    request.pin[field] = typeof request.pin[field] === "number" ? request.pin[field] + 1 : request.pin[field] + "changed";
    rejected(host.dispatch(context, "register", request));
  }
  rejected(host.dispatch(context, "register", { ...f.registerRequest(), targetId: "target-b" }));
  assert.deepEqual(f.readState(), before); assert.equal(f.controls.observeCalls, 0);
});

test("issue binds every lease/action field, fingerprint, TTL and checkpoint domain", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), before = f.readState();
  for (const group of ["lease", "permit"]) {
    for (const field of Object.keys(f.resources[group])) {
      const request = f.issueRequest(); request[group][field] += "other";
      rejected(host.dispatch(context, "issue", request));
    }
  }
  for (const mutate of [r => { r.targetId = "target-b"; }, r => { r.batchFingerprint = "f".repeat(64); },
    r => { r.lease.ttlMs++; }, r => { r.permit.ttlMs++; }, r => { r.checkpoint = null; },
    r => { r.checkpoint.authority_id = "other"; }, r => { r.checkpoint.target_id = "other"; },
    r => { r.lease.extra = true; }, r => { r.permit.extra = true; }]) {
    const request = f.issueRequest(); mutate(request); rejected(host.dispatch(context, "issue", request));
  }
  assert.equal(f.controls.signCalls, 0); assert.deepEqual(f.readState(), before);
});

test("consume checks session/run/desktop/app/action bindings before pulling revocation", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), issued = f.issue(host, context), before = f.readState();
  for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
    if (!Object.hasOwn(f.resources.lease, storage) && !Object.hasOwn(f.resources.permit, storage)) continue;
    const request = f.consumeRequest(issued); request.message[signed] += "other";
    rejected(host.dispatch(context, "consume", request));
  }
  assert.equal(f.controls.pullCalls, 0); assert.deepEqual(f.readState(), before);
});

test("uppercase authorized digests survive issuance normalization and consumption", supported, t => {
  const f = fixture(t);
  f.resources.permit.targetDigest = "Aa".repeat(32);
  f.resources.permit.paramsDigest = "B".repeat(64);
  const { host, context } = f.prepare();
  const issued = f.issue(host, context);
  assert.equal(issued.signedPermit.message.target_digest, "a".repeat(64));
  assert.equal(issued.signedPermit.message.params_digest, "b".repeat(64));
  for (const field of ["target_digest", "params_digest"]) {
    const tampered = f.consumeRequest(issued);
    tampered.message[field] = "c".repeat(64);
    rejected(host.dispatch(context, "consume", tampered));
  }
  assert.equal(f.controls.pullCalls, 0);
  const result = host.dispatch(context, "consume", f.consumeRequest(issued));
  assert.equal(result.status, "committed");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.result.executionAuthorized, false);
  assert.equal(f.readState().permits[issued.signedPermit.message.permit_id].status, "consumed");
});

for (const action of ["register", "issue", "consume"]) {
  test(`reentrant context revocation prevents the ${action} provider from running`, supported, t => {
    const f = fixture(t), host = f.start();
    const setup = host.createContext(f.contextInput());
    let request = f.registerRequest();
    if (action !== "register") {
      assert.equal(host.dispatch(setup, "register", request).status, "committed");
      request = f.issueRequest();
    }
    if (action === "consume") request = f.consumeRequest(f.issue(host, setup));
    let context, calls = 0;
    context = host.createContext(f.contextInput({ isCurrent: () => {
      if (context && ++calls === 3) host.revokeContext(context);
      return true;
    } }));
    const before = f.readState();
    const providerCalls = [f.controls.observeCalls, f.controls.signCalls, f.controls.pullCalls];
    unknown(host.dispatch(context, action, request));
    assert.deepEqual([f.controls.observeCalls, f.controls.signCalls, f.controls.pullCalls], providerCalls);
    assert.deepEqual(f.readState(), before);
  });
}

test("reentrant revocation during preflight refuses without starting a transaction", supported, t => {
  const f = fixture(t), host = f.start();
  let context;
  context = host.createContext(f.contextInput({ isCurrent: () => {
    if (context) host.revokeContext(context);
    return true;
  } }));
  const before = f.readState();
  rejected(host.dispatch(context, "register", f.registerRequest()));
  assert.equal(f.controls.observeCalls, 0);
  assert.deepEqual(f.readState(), before);
});

test("reentrant context revocation after commit returns unknown rather than committed", supported, t => {
  const f = fixture(t), host = f.start();
  let context;
  context = host.createContext(f.contextInput({ isCurrent: () => {
    if (context && f.readState().witness_authority.targets["target-a"]) host.revokeContext(context);
    return true;
  } }));
  unknown(host.dispatch(context, "register", f.registerRequest()));
  assert.ok(f.readState().witness_authority.targets["target-a"]);
  rejected(host.dispatch(context, "register", f.registerRequest()));
});

test("a mutated or shared public grant cannot enlarge an existing opaque context", supported, t => {
  const f = fixture(t), { host, context } = f.prepare();
  const original = structuredClone(f.resources);
  f.resources.lease.workerId = "forged-worker"; f.resources.permit.operation = "forged-operation";
  rejected(host.dispatch(context, "issue", f.issueRequest()));
  f.resources.lease = original.lease; f.resources.permit = original.permit;
  const issued = f.issue(host, context);
  assert.equal(issued.signedPermit.message.worker_identity, "worker");
  assert.equal(issued.signedPermit.message.operation, "invoke");
});

for (const field of ["owner", "fingerprint"]) test(`consume enforces server-side ${field} binding even with otherwise matching message`, supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), issued = f.issue(host, context);
  const resources = structuredClone(f.resources);
  if (field === "owner") resources.lease.owner = "other-owner";
  else {
    const otherKey = delivery.createBatchKeyPair();
    resources.pin.fingerprint = otherKey.fingerprint; resources.pin.public_key_pem = otherKey.publicKeyPem;
  }
  const other = host.createContext(f.contextInput({ resources, principal: resources.lease.owner, actions: ["consume"] }));
  const before = f.readState();
  unknown(host.dispatch(other, "consume", f.consumeRequest(issued)));
  assert.deepEqual(f.readState(), before); assert.equal(f.controls.pullCalls, 0);
});

test("explicit reopen preserves authority state and never reuses contexts", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), issued = f.issue(host, context);
  host.close();
  const reopened = f.start({ access: "open", storeOptions: { ...f.config.storeOptions, minimumEpoch: 1 } });
  rejected(reopened.dispatch(context, "consume", f.consumeRequest(issued)));
  const fresh = reopened.createContext(f.contextInput({ actions: ["consume"] }));
  assert.equal(reopened.dispatch(fresh, "consume", f.consumeRequest(issued)).status, "committed");
});

for (const provider of ["observeTarget", "signPermit", "pullRevocation"]) {
  for (const behavior of ["promise", "rejected-promise", "throws"]) test(`${provider} ${behavior} conservatively blocks without fallback`, supported, async t => {
    const f = fixture(t), original = f.config.providers[provider];
    f.config.providers[provider] = (...args) => {
      if (behavior === "throws") throw new Error("sensitive provider failure");
      if (behavior === "rejected-promise") return Promise.reject(new Error("sensitive async failure"));
      return Promise.resolve(original(...args));
    };
    const host = f.start(), context = host.createContext(f.contextInput());
    let action = "register", request = f.registerRequest();
    if (provider !== "observeTarget") {
      assert.equal(host.dispatch(context, "register", request).status, "committed");
      action = "issue"; request = f.issueRequest();
    }
    if (provider === "pullRevocation") { request = f.consumeRequest(f.issue(host, context)); action = "consume"; }
    const before = f.readState();
    unknown(host.dispatch(context, action, request));
    assert.deepEqual(f.readState(), before);
    rejected(host.dispatch(context, action, request));
    assert.throws(() => host.createContext(f.contextInput()));
    await Promise.resolve(); // rejected provider promises must be observed
  });
}

test("post-provider identity loss refuses issuance", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), before = f.readState();
  f.controls.afterSign = () => { f.controls.alive = false; };
  unknown(host.dispatch(context, "issue", f.issueRequest()));
  assert.deepEqual(f.readState(), before);
});

test("identity must remain synchronous on dispatch, not just on context creation", supported, t => {
  const f = fixture(t), host = f.start();
  let asynchronous = false;
  const context = host.createContext(f.contextInput({ isCurrent: () => asynchronous ? Promise.resolve(true) : true }));
  const before = f.readState();
  asynchronous = true;
  rejected(host.dispatch(context, "register", f.registerRequest()));
  assert.deepEqual(f.readState(), before); assert.equal(f.controls.observeCalls, 0);
});

test("identity loss detected after a successful commit returns unknown, never unchanged", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), issued = f.issue(host, context);
  const request = f.consumeRequest(issued);
  const consumer = host.createContext(f.contextInput({ actions: ["consume"],
    isCurrent: () => f.readState().permits[request.message.permit_id].status === "reserved" }));
  unknown(host.dispatch(consumer, "consume", request));
  assert.equal(f.readState().permits[request.message.permit_id].status, "consumed");
  rejected(host.dispatch(context, "consume", request));
});

test("core CAS conflicts cannot cause a retry with a substituted checkpoint", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), request = f.issueRequest(), before = f.readState();
  request.checkpoint.full_state_digest = "f".repeat(64);
  unknown(host.dispatch(context, "issue", request));
  assert.deepEqual(f.readState(), before); assert.equal(f.controls.signCalls, 0);
  rejected(host.dispatch(context, "issue", f.issueRequest()));
});

test("unknown target freshness and forged signer output conservatively refuse without minting a permit", supported, t => {
  const f = fixture(t);
  f.controls.observation = { targetHasProcess: null, targetHasPriorRun: false };
  const host = f.start(), context = host.createContext(f.contextInput()), before = f.readState();
  unknown(host.dispatch(context, "register", f.registerRequest()));
  assert.deepEqual(f.readState(), before);
  host.close();
  f.controls.observation = { targetHasProcess: false, targetHasPriorRun: false };
  f.config.providers.signPermit = () => ({ fingerprint: f.key.fingerprint });
  const reopened = f.start({ access: "open", storeOptions: { ...f.config.storeOptions, minimumEpoch: 1 } });
  const fresh = reopened.createContext(f.contextInput());
  assert.equal(reopened.dispatch(fresh, "register", f.registerRequest()).status, "committed");
  const registered = f.readState();
  unknown(reopened.dispatch(fresh, "issue", f.issueRequest()));
  assert.deepEqual(f.readState(), registered);
});

test("request mutation by a trusted provider cannot change the detached authorized reservation", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), request = f.issueRequest();
  f.controls.afterSign = () => { request.lease.workerId = "other"; request.permit.operation = "other"; };
  const result = host.dispatch(context, "issue", request);
  assert.equal(result.status, "committed");
  assert.equal(result.result.signedPermit.message.worker_identity, "worker");
  assert.equal(result.result.signedPermit.message.operation, "invoke");
});

test("signature refusal may commit fresh revocation: unknown never claims unchanged", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), request = f.consumeRequest(f.issue(host, context));
  const before = f.readState();
  f.controls.revoked = ["f".repeat(64)];
  request.signature = Buffer.alloc(64).toString("base64");
  unknown(host.dispatch(context, "consume", request));
  const after = f.readState(), current = after.witness_authority.targets["target-a"].current;
  assert.equal(after.anchor_sequence, before.anchor_sequence + 1);
  assert.deepEqual(current.state.revoked_fingerprints, f.controls.revoked);
  assert.equal(current.state.highest_accepted_permit_sequence, 0);
  assert.equal(after.permits[request.message.permit_id].status, "reserved");
  rejected(host.dispatch(context, "consume", { ...request, checkpoint: current.checkpoint }));
});

test("clock rollback may commit poison without issuing: host returns unknown and stops", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), before = f.readState();
  f.controls.afterSign = () => { f.controls.now = 999; };
  unknown(host.dispatch(context, "issue", f.issueRequest()));
  const after = f.readState();
  assert.equal(after.witness_authority.clock_poisoned, true);
  assert.deepEqual(after.permits, before.permits);
  assert.equal(after.anchor_sequence, before.anchor_sequence + 1);
});

test("precommit audit failure is conservatively unknown even though DB rolled back", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), request = f.consumeRequest(f.issue(host, context)), before = f.readState();
  const audit = fs.statSync(path.join(f.config.storeOptions.anchorDir, "protected-anchor-audit.log"));
  const sync = fs.fsyncSync;
  let hits = 0;
  fs.fsyncSync = function(fd) {
    const target = fs.fstatSync(fd);
    if (target.dev === audit.dev && target.ino === audit.ino) {
      hits++;
      throw new Error("private audit failure");
    }
    return sync.call(this, fd);
  };
  try { unknown(host.dispatch(context, "consume", request)); }
  finally { fs.fsyncSync = sync; }
  assert.equal(hits, 1, "fault must reach the audit file sync");
  assert.deepEqual(f.readState(), before);
  rejected(host.dispatch(context, "consume", request));
});

test("postcommit anchor failure keeps actual consumption and checkpoint atomic, reports unknown", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), request = f.consumeRequest(f.issue(host, context));
  const append = anchor.appendEntry;
  anchor.appendEntry = (file, entry) => { if (entry.type === "commit") throw new Error("private anchor failure"); return append(file, entry); };
  try { unknown(host.dispatch(context, "consume", request)); }
  finally { anchor.appendEntry = append; }
  const state = f.readState(), binding = state.witness_authority.issuance_bindings[request.message.permit_id];
  assert.equal(state.permits[request.message.permit_id].status, "consumed");
  assert.equal(binding.status, "consumed");
  assert.deepEqual(binding.consumption_record.checkpoint, state.witness_authority.targets["target-a"].current.checkpoint);
  rejected(host.dispatch(context, "consume", request));
  assert.throws(() => f.start({ access: "open", storeOptions: { ...f.config.storeOptions, minimumEpoch: 1 } }),
    { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
});

test("development signatures remain a production blocker, regardless of result labels", supported, t => {
  const f = fixture(t), { host, context } = f.prepare(), issued = f.issue(host, context);
  assert.equal(delivery.verifyPermitSignature({ message: issued.signedPermit.message, signature: issued.signedPermit.signature,
    publicKeyPem: f.key.publicKeyPem, expectedFingerprint: f.key.fingerprint, revokedFingerprints: new Set(),
    expectedDeadlineMs: issued.signedPermit.deadline, nowMs: 1000 }).ok, true);
  assert.throws(() => f.start({ mode: "production" }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  assert.equal(Object.keys(issued.signedPermit.message).length, 17);
  assert.equal(issued.executionAuthorized, false);
});
