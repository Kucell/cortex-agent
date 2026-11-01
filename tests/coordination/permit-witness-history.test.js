"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const delivery = require("../../lib/coordination/permit-delivery");
const witness = require("../../lib/coordination/permit-witness-contract");
const anchor = require("../../lib/coordination/protected-anchor");
const coordination = require("../../lib/coordination/protected-store-lock");
const { signRevocationList } = require("../../lib/coordination/permit-revocation-signing");

// Real DBs, anchors and child-process artifacts stay inside .agent/runtime.
// These test-generated development keys are never read from credentials.
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || process.platform === "win32" };
const WRITER = Object.freeze({}), READER = Object.freeze({});
function fixture(t, { history = true } = {}) {
  const base = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "witness-history-"));
  const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  const key = delivery.createBatchKeyPair();
  const controls = { now: 1000, clockCalls: 0, writes: 0, authCalls: 0, alive: true, grant: null, hook: null };
  const authority = { mode: "development-only", authorityId: "history-authority",
    authorize: peer => peer === WRITER,
    observeTarget: () => { controls.writes++; return { targetHasProcess: false, targetHasPriorRun: false }; },
    signPermit: (fingerprint, permit, at) => {
      controls.writes++;
      return { fingerprint, publicKeyPem: key.publicKeyPem,
        signedPermit: delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit, issuedAtMs: at, nowMs: at }) };
    },
    pullRevocation: (_id, current, at) => {
      controls.writes++;
      return signRevocationList({ ...key, issuedAtMs: at, fingerprints: [],
        state: { appliedRevocationSequence: current.state.applied_revocation_sequence,
          revokedFingerprints: new Set(current.state.revoked_fingerprints) } });
    } };
  if (history) authority.authorizeHistory = (peer, action, query) => {
    controls.authCalls++;
    assert.equal(Object.isFrozen(query), true);
    assert.equal(Object.isFrozen(query.request), true);
    if (controls.hook) controls.hook(action, query);
    if (peer !== READER || !controls.alive || action !== "history." + query.operation || !controls.grant) return false;
    return controls.grant;
  };
  const file = path.join(dbDir, "authority.sqlite");
  const options = { decisionId: "D-history", anchorDir, anchorMode: "permissive", witnessAuthority: authority,
    clock: () => { controls.clockCalls++; return controls.now; } };
  const store = Store.initialize(file, options), handles = [store];
  t.after(() => { for (const handle of handles) handle.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function readRaw() {
    const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get(); }
    finally { db.close(); }
  }
  const state = () => JSON.parse(readRaw().body);
  const cp = () => state().witness_authority.targets["target-a"].current.checkpoint;
  const registration = () => ({ targetId: "target-a", requestId: "registration-1", checkpoint: null,
    pin: { decision_id: "D-history", instance_id: "target-a", fingerprint: key.fingerprint, public_key_pem: key.publicKeyPem,
      source_digest: "source", deployment_digest: "deployment", run_id: "run", generation: "generation",
      valid_from: 0, valid_until: 100000 } });
  const issue = () => ({ targetId: "target-a", checkpoint: cp(), batchFingerprint: key.fingerprint,
    lease: { owner: "original-owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
      generation: "generation", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease-1", ttlMs: 5000 },
    permit: { idempotencyKey: "permit-1", operation: "invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 2000 } });
  const consume = issued => ({ targetId: "target-a", checkpoint: cp(),
    message: structuredClone(issued.signedPermit.message), signature: issued.signedPermit.signature });
  const query = (operation, request) => ({ operation, decisionId: "D-history", authorityId: authority.authorityId,
    issuerStoreId: state().store_id, targetGeneration: request.checkpoint === null ? null : request.checkpoint.store_generation,
    resources: operation === "register" ? { fingerprint: request.pin.fingerprint, lease: null, permit: null } : {
      fingerprint: key.fingerprint,
      lease: Object.fromEntries(["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"]
        .map(field => [field, (operation === "issue" ? request.lease : issue().lease)[field]])),
      permit: Object.fromEntries(["operation", "targetDigest", "paramsDigest"]
        .map(field => [field, (operation === "issue" ? request.permit : issue().permit)[field]])) },
    request: structuredClone(request) });
  const grant = q => { controls.grant = { principal: "recovery-reviewer", resources: structuredClone(q) }; return q; };
  const lookup = q => store.queryWitnessHistory(READER, grant(q));
  const audit = () => fs.readFileSync(path.join(anchorDir, "protected-anchor-audit.log"), "utf8")
    .trim().split("\n").map(JSON.parse).filter(row => row.event === "witness-history-observation");
  function prepare() {
    const reg = registration(); store.registerWitnessTarget(WRITER, reg);
    const req = issue(), issued = store.issueWitnessPermit(WRITER, req);
    return { reg, req, issued, use: consume(issued) };
  }
  function reopen(extra = {}) {
    const handle = Store.open(file, { ...options, expectedDecisionId: "D-history", minimumEpoch: 1, ...extra });
    handles.push(handle); return handle;
  }
  // Deliberately create well-anchored malformed fixtures to exercise validation
  // beyond the generic assertState. Never part of a runtime recovery path.
  function rewrite(change) {
    coordination.withLock(anchorDir, () => {
      const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file);
      try {
        const next = state(); change(next); next.anchor_sequence++;
        const body = JSON.stringify(next), hash = crypto.createHash("sha256").update(body).digest("hex");
        const entry = { sequence: next.anchor_sequence, body_digest: hash, store_id: next.store_id, attempt: 1 };
        anchor.appendEntry(anchor.journalFileFor(anchorDir), { ...entry, type: "intent" });
        db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, hash);
        anchor.appendEntry(anchor.journalFileFor(anchorDir), { ...entry, type: "commit" });
        anchor.appendHighWater(anchorDir, entry);
      } finally { db.close(); }
    });
  }
  return { root, file, anchorDir, store, controls, authority, options, key, state, readRaw, cp, registration,
    issue, consume, query, grant, lookup, audit, prepare, reopen, rewrite };
}
function safe(result) {
  assert.equal(result.executionAuthorized, false); assert.equal(result.resumeAllowed, false);
  assert.equal(result.originalRequestOutcome, "unknown"); assert.equal(result.mode, "development-only");
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.boundary));
  const forbidden = new Set(["signature", "signedPermit", "signedIssuance", "message_bytes", "message", "bytes", "publicKeyPem", "public_key_pem"]);
  function scan(value) {
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, key); scan(child);
    }
  }
  scan(result);
}

test("history needs an independent explicit capability; write authorization never suffices", supported, t => {
  const f = fixture(t, { history: false }), request = f.registration();
  f.store.registerWitnessTarget(WRITER, request);
  assert.throws(() => f.store.queryWitnessHistory(WRITER, f.query("register", request)), { code: "ERR_WITNESS_HISTORY_NOT_AUTHORIZED" });
});

test("all three effects are auditable and immutable without returning signatures or mutating authority", supported, t => {
  const f = fixture(t), { reg, req, issued, use } = f.prepare();
  const consumed = f.store.consumeWithCheckpoint(WRITER, use);
  const raw = f.readRaw(), writes = f.controls.writes, clocks = f.controls.clockCalls;
  const qs = [f.query("register", reg), f.query("issue", req), f.query("consume", use)];
  const results = qs.map(f.lookup);
  results.forEach(result => { safe(result); assert.equal(result.status, "found"); });
  assert.equal(results[0].effect.requestMatch, "full-request-digest");
  assert.equal(results[1].effect.requestMatch, "business-effect-only");
  assert.equal(results[2].effect.fullRequestDigest, "not-recorded");
  assert.deepEqual(results[2].effect.checkpoint, consumed.checkpoint);
  assert.notDeepEqual(results[0].effect.checkpoint, results[0].currentCheckpoint);
  assert.equal(results[1].effect.permitId, issued.signedPermit.message.permit_id);
  results.forEach(result => assert.equal(result.effect.historicalPrincipal, "not-recorded"));
  assert.deepEqual(f.readRaw(), raw); assert.equal(f.controls.writes, writes); assert.equal(f.controls.clockCalls, clocks);
  const audit = f.audit(); assert.equal(audit.length, 3);
  assert.deepEqual(audit.map(row => row.status), ["found", "found", "found"]);
  audit.forEach((row, index) => {
    assert.equal(row.executionAuthorized, false); assert.equal(row.resumeAllowed, false);
    assert.deepEqual(row.boundary, results[index].boundary);
    assert.equal(row.query_digest, crypto.createHash("sha256").update(witness.canonicalBytes(qs[index])).digest("hex"));
  });
  assert.equal(JSON.stringify(audit).includes(use.signature), false);
  assert.equal(JSON.stringify(audit).includes("original-owner"), false);
  assert.throws(() => f.store.consumeWithCheckpoint(WRITER, use), { code: "ERR_WITNESS_CHECKPOINT_CONFLICT" });
});

test("not-found is only bounded absence, including a permit which has not been consumed", supported, t => {
  const f = fixture(t), reg = f.registration();
  const absentRegistration = f.lookup(f.query("register", reg));
  assert.equal(absentRegistration.status, "not-found-at-boundary"); safe(absentRegistration);
  assert.equal(absentRegistration.currentCheckpoint, null);
  f.store.registerWitnessTarget(WRITER, reg);
  const req = f.issue(), noIssue = f.lookup(f.query("issue", req));
  assert.equal(noIssue.status, "not-found-at-boundary"); safe(noIssue);
  const issued = f.store.issueWitnessPermit(WRITER, req), use = f.consume(issued);
  const notConsumed = f.lookup(f.query("consume", use));
  assert.equal(notConsumed.status, "not-found-at-boundary"); assert.equal(notConsumed.effect, null); safe(notConsumed);
  assert.deepEqual(f.audit().map(row => row.status), Array(3).fill("not-found-at-boundary"));
  // A later write is possible; bounded absence never asserted that it could not commit.
  f.store.consumeWithCheckpoint(WRITER, use);
  assert.equal(f.lookup(f.query("consume", use)).status, "found");
});

test("expired and poisoned history is observable without checking or repairing the clock", supported, t => {
  const f = fixture(t), { reg, req } = f.prepare();
  f.controls.now = 999;
  assert.throws(() => f.store.issueWitnessPermit(WRITER, req), { code: "ERR_WITNESS_CLOCK" });
  const before = f.readRaw(), clocks = f.controls.clockCalls;
  for (const operation of ["register", "issue"]) {
    const result = f.lookup(f.query(operation, operation === "register" ? reg : req));
    safe(result); assert.equal(result.status, "found"); assert.equal(result.clockPoisoned, true);
  }
  assert.deepEqual(f.readRaw(), before); assert.equal(f.controls.clockCalls, clocks);
  f.controls.now = 1000000;
  assert.equal(f.lookup(f.query("issue", req)).status, "found");
  const neverIssued = structuredClone(req); neverIssued.permit.idempotencyKey = "never-issued";
  const absent = f.lookup(f.query("issue", neverIssued));
  assert.equal(absent.status, "not-found-at-boundary"); assert.equal(absent.clockPoisoned, true); safe(absent);
  assert.throws(() => f.store.issueWitnessPermit(WRITER, req), { code: "ERR_WITNESS_CLOCK" });
});

for (const field of ["fingerprint", "owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId",
  "operation", "targetDigest", "paramsDigest"]) test(`consume history requires independently granted ${field} binding`, supported, t => {
  const f = fixture(t), { use } = f.prepare(), q = f.query("consume", use);
  f.grant(q);
  if (field === "fingerprint") q.resources.fingerprint = "f".repeat(64);
  else if (Object.hasOwn(q.resources.lease, field)) q.resources.lease[field] = "other";
  else q.resources.permit[field] = field === "operation" ? "other" : "f".repeat(64);
  assert.throws(() => f.store.queryWitnessHistory(READER, q));
});

test("even an explicit grant cannot replace a consumed permit's recorded lease owner or signer", supported, t => {
  const f = fixture(t), { use } = f.prepare(); f.store.consumeWithCheckpoint(WRITER, use);
  const q = f.query("consume", use); q.resources.lease.owner = "forged-owner";
  assert.throws(() => f.lookup(q), { code: "ERR_WITNESS_HISTORY_BINDING" });
});

test("successful history observation survives an explicit store reopen without adding actor facts", supported, t => {
  const f = fixture(t), { req } = f.prepare(), q = f.query("issue", req), before = f.readRaw();
  const reopened = f.reopen(); f.grant(q);
  const result = reopened.queryWitnessHistory(READER, q);
  assert.equal(result.status, "found"); safe(result); assert.deepEqual(f.readRaw(), before);
  assert.equal(result.effect.historicalPrincipal, "not-recorded"); assert.equal(f.audit().length, 1);
});

for (const damage of ["symlink", "hardlink", "partial-tail", "permissions"]) test(`unsafe audit ${damage} prevents a history result`, supported, t => {
  const f = fixture(t), { reg } = f.prepare(), audit = path.join(f.anchorDir, "protected-anchor-audit.log");
  if (damage === "partial-tail") fs.appendFileSync(audit, '{"partial":');
  else if (damage === "permissions") fs.chmodSync(audit, 0o644);
  else {
    const saved = path.join(f.root, "saved-audit"); fs.renameSync(audit, saved);
    if (damage === "symlink") fs.symlinkSync(saved, audit);
    else fs.linkSync(saved, audit);
  }
  const before = f.readRaw();
  assert.throws(() => f.lookup(f.query("register", reg)));
  assert.deepEqual(f.readRaw(), before);
  assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

for (const invalid of [true, false, {}, { principal: "reviewer", resources: {} }, Promise.resolve(true), Promise.reject(new Error("test rejection"))]) {
  // Observe the fixture Promise immediately; the store also observes async denials.
  if (invalid instanceof Promise) invalid.catch(() => {});
  test(`partial, boolean and asynchronous history grants are rejected (${String(invalid)})`, supported, t => {
    const f = fixture(t), q = f.query("register", f.registration());
    f.controls.grant = invalid;
    assert.throws(() => f.store.queryWitnessHistory(READER, q));
    assert.equal(fs.existsSync(path.join(f.anchorDir, "protected-anchor-audit.log")), false);
  });
}

test("forged peer and every resource-envelope field are refused before protected access", supported, t => {
  const f = fixture(t), { req } = f.prepare(), q = f.query("issue", req);
  f.grant(q);
  assert.throws(() => f.store.queryWitnessHistory(WRITER, q), { code: "ERR_WITNESS_HISTORY_NOT_AUTHORIZED" });
  const patches = [q => { q.decisionId = "other"; }, q => { q.authorityId = "other"; },
    q => { q.issuerStoreId = "other"; }, q => { q.targetGeneration = "other"; q.request.checkpoint.store_generation = "other"; },
    q => { q.request.targetId = "other"; q.request.checkpoint.target_id = "other"; },
    ...Object.keys(req.lease).map(key => q => { q.request.lease[key] = key === "ttlMs" ? 4999 : "other"; }),
    ...Object.keys(req.permit).map(key => q => { q.request.permit[key] = key === "ttlMs" ? 1999 :
      ["targetDigest", "paramsDigest"].includes(key) ? "f".repeat(64) : "other"; }),
    q => { q.request.batchFingerprint = "f".repeat(64); }];
  for (const patch of patches) {
    const changed = structuredClone(q); patch(changed);
    assert.throws(() => f.store.queryWitnessHistory(READER, changed));
  }
  assert.equal(f.audit().length, 0);
  assert.equal(f.lookup(q).status, "found");
});

for (const operation of ["issue", "consume"]) test(`freshly authorized cross-target ${operation} history is refused by persisted bindings`, supported, t => {
  const f = fixture(t), { req, use } = f.prepare();
  f.store.consumeWithCheckpoint(WRITER, use);
  const other = f.registration(); other.targetId = "target-b"; other.pin.instance_id = "target-b";
  f.store.registerWitnessTarget(WRITER, other);
  const request = structuredClone(operation === "issue" ? req : use);
  request.targetId = "target-b";
  request.checkpoint = f.state().witness_authority.targets["target-b"].current.checkpoint;
  const q = f.query(operation, request), before = f.readRaw();
  // Grant the changed query itself: a stale grant must not mask the storage check.
  f.grant(q);
  assert.throws(() => f.store.queryWitnessHistory(READER, q), { code: "ERR_WITNESS_HISTORY_BINDING" });
  assert.equal(f.controls.authCalls, 2); assert.equal(f.audit().length, 0);
  assert.deepEqual(f.readRaw(), before);
  assert.throws(() => f.lookup(q), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

for (const operation of ["register", "issue", "consume"]) test(`freshly authorized old-generation ${operation} history cannot report bounded absence`, supported, t => {
  const f = fixture(t), { reg, req, use } = f.prepare();
  const request = structuredClone(operation === "register" ? reg : operation === "issue" ? req : use);
  if (operation === "register") request.requestId = "registration-absent";
  else {
    request.checkpoint.store_generation = "old-generation";
    if (operation === "issue") request.permit.idempotencyKey = "permit-absent";
    else request.message.permit_id = "P-PERMIT-absent";
  }
  const q = f.query(operation, request), before = f.readRaw();
  q.targetGeneration = "old-generation";
  f.grant(q);
  assert.throws(() => f.store.queryWitnessHistory(READER, q), { code: "ERR_WITNESS_HISTORY_BINDING" });
  assert.equal(f.controls.authCalls, 2); assert.equal(f.audit().length, 0);
  assert.deepEqual(f.readRaw(), before);
  assert.throws(() => f.lookup(q), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

for (const operation of ["register", "issue", "consume"]) test(`persisted ${operation} resource mismatch cannot masquerade as not-found`, supported, t => {
  const f = fixture(t), { reg, req, use } = f.prepare();
  f.store.consumeWithCheckpoint(WRITER, use);
  const r = structuredClone(operation === "register" ? reg : operation === "issue" ? req : use);
  if (operation === "register") r.pin.source_digest = "other";
  else if (operation === "issue") r.lease.owner = "other";
  else r.signature = Buffer.alloc(64).toString("base64");
  assert.throws(() => f.lookup(f.query(operation, r)), { code: "ERR_WITNESS_HISTORY_BINDING" });
  assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

test("legacy issue/consume checkpoints are not falsely claimed as an exact original request match", supported, t => {
  const f = fixture(t), { req, use } = f.prepare();
  f.store.consumeWithCheckpoint(WRITER, use);
  for (const [operation, request] of [["issue", req], ["consume", use]]) {
    const different = structuredClone(request); different.checkpoint = f.cp();
    const result = f.lookup(f.query(operation, different));
    assert.equal(result.status, "found"); assert.equal(result.effect.requestMatch, "business-effect-only");
    assert.equal(result.effect.inputCheckpoint, "not-recorded"); safe(result);
  }
});

for (const [field, value] of [["service_epoch", 0], ["fencing", "1"], ["sequence", null],
  ["issued_at_ms", -1], ["deadline_ms", 0], ["lease_id", {}]]) {
  test(`malformed consume ${field} cannot produce a bounded-absence observation`, supported, t => {
    const f = fixture(t), { use } = f.prepare(), q = f.query("consume", use);
    q.request.message.permit_id = "P-PERMIT-absent";
    q.request.message[field] = value;
    assert.throws(() => f.lookup(q));
    assert.equal(f.audit().length, 0);
  });
}

for (const step of [2, 3, 4, 5]) test(`identity loss at history authorization step ${step} never releases a result`, supported, t => {
  const f = fixture(t), { reg } = f.prepare(), q = f.query("register", reg);
  f.grant(q);
  f.controls.hook = () => { if (f.controls.authCalls === step) f.controls.alive = false; };
  assert.throws(() => f.store.queryWitnessHistory(READER, q), { code: "ERR_WITNESS_HISTORY_NOT_AUTHORIZED" });
  assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

test("principal changes and reentrant writes are rejected during inspection", supported, t => {
  const f = fixture(t), { reg, req } = f.prepare(), q = f.query("register", reg);
  f.grant(q);
  f.controls.hook = () => {
    assert.throws(() => f.store.issueWitnessPermit(WRITER, req), { code: "ERR_WITNESS_HISTORY_ACTIVE" });
    assert.throws(() => f.store.close(), { code: "ERR_WITNESS_HISTORY_ACTIVE" });
    if (f.controls.authCalls === 3) f.controls.grant.principal = "another-reviewer";
  };
  assert.throws(() => f.store.queryWitnessHistory(READER, q), { code: "ERR_WITNESS_HISTORY_NOT_AUTHORIZED" });
});

for (const failure of ["write", "short-write", "fsync", "directory-fsync", "close"]) test(`mandatory audit ${failure} failure poisons the handle without changing authority`, supported, t => {
  const f = fixture(t), { reg } = f.prepare(), before = f.readRaw();
  const original = { writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync };
  let triggered = false;
  function auditFd(fd) {
    return fs.fstatSync(fd).isFile();
  }
  if (["write", "short-write"].includes(failure)) fs.writeSync = (fd, ...args) => {
    if (auditFd(fd)) { triggered = true; if (failure === "write") throw new Error("audit failure"); return 1; }
    return original.writeSync(fd, ...args);
  };
  if (["fsync", "directory-fsync"].includes(failure)) fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory() === (failure === "directory-fsync")) { triggered = true; throw new Error("sync failure"); }
    return original.fsyncSync(fd);
  };
  if (failure === "close") fs.closeSync = fd => {
    if (!triggered && auditFd(fd)) { triggered = true; throw new Error("close failure"); }
    return original.closeSync(fd);
  };
  try { assert.throws(() => f.lookup(f.query("register", reg)), { code: "ERR_AUDIT_WRITE_FAILED" }); }
  finally { Object.assign(fs, original); }
  assert.equal(triggered, true); assert.deepEqual(f.readRaw(), before);
  assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

test("read transaction rollback failure preserves the primary error and permanently withholds the observation", supported, t => {
  const f = fixture(t), { reg } = f.prepare(), q = f.grant(f.query("register", reg)), before = f.readRaw();
  const { DatabaseSync } = require("node:sqlite"), exec = DatabaseSync.prototype.exec;
  const primary = new Error("read commit failure"), rollback = new Error("read rollback failure");
  let reader, rollbacks = 0;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === "BEGIN") reader = this;
    if (this === reader && sql === "COMMIT") throw primary;
    if (this === reader && sql === "ROLLBACK") { rollbacks++; throw rollback; }
    return exec.call(this, sql);
  };
  try { assert.throws(() => f.store.queryWitnessHistory(READER, q), error => error === primary); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(rollbacks, 1); assert.equal(f.audit().length, 0);
  assert.deepEqual(f.readRaw(), before);
  assert.throws(() => f.lookup(q), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  assert.throws(() => f.store.registerWitnessTarget(WRITER, reg), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

for (const failure of ["rollback", "close"]) test(`coordination lock ${failure} failure never releases an observation or restores the handle`, supported, t => {
  const f = fixture(t), { reg } = f.prepare(), q = f.grant(f.query("register", reg)), before = f.readRaw();
  const { DatabaseSync } = require("node:sqlite");
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  const cleanup = new Error("lock " + failure + " failure");
  let lock, failures = 0;
  if (failure === "rollback") f.controls.hook = () => {
    if (f.controls.authCalls === 3) f.controls.alive = false;
  };
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === "BEGIN IMMEDIATE") lock = this;
    if (this === lock && sql === "ROLLBACK" && failure === "rollback") { failures++; throw cleanup; }
    return exec.call(this, sql);
  };
  DatabaseSync.prototype.close = function() {
    // Release the real connection before reporting failure; leave no test lock behind.
    const result = close.call(this);
    if (this === lock && failure === "close") { failures++; throw cleanup; }
    return result;
  };
  try {
    assert.throws(() => f.store.queryWitnessHistory(READER, q), error => failure === "close"
      ? error === cleanup
      : error.code === "ERR_WITNESS_HISTORY_NOT_AUTHORIZED" && error.cleanupError === cleanup);
  } finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close; }
  assert.equal(failures, 1); assert.deepEqual(f.readRaw(), before);
  // A close failure follows durable auditing, but the recorded observation never grants a response or recovery.
  const audit = f.audit(); assert.equal(audit.length, failure === "close" ? 1 : 0);
  audit.forEach(row => { assert.equal(row.executionAuthorized, false); assert.equal(row.resumeAllowed, false); });
  f.controls.hook = null; f.controls.alive = true;
  assert.throws(() => f.lookup(q), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  assert.throws(() => f.store.registerWitnessTarget(WRITER, reg), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

for (const damage of ["lock-missing", "lock-replaced", "journal-missing", "declaration-missing", "declaration-foreign"]) {
  test(`history refuses ${damage} and cannot repair its own trust evidence`, supported, t => {
    const f = fixture(t), { reg } = f.prepare(), before = f.readRaw();
    if (damage.startsWith("lock")) {
      const file = path.join(f.anchorDir, coordination.FILE);
      fs.renameSync(file, file + ".old");
      if (damage === "lock-replaced") {
        const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file);
        db.exec("PRAGMA user_version=1"); db.close(); fs.chmodSync(file, 0o600);
      }
    } else if (damage === "journal-missing") {
      for (const name of fs.readdirSync(f.anchorDir)) if (name.startsWith("protected-anchor-entry-")) fs.unlinkSync(path.join(f.anchorDir, name));
    } else if (damage === "declaration-missing") fs.unlinkSync(path.join(f.anchorDir, "protected-anchor-high-water.log"));
    else {
      fs.unlinkSync(path.join(f.anchorDir, "protected-anchor-high-water.log"));
      anchor.appendHighWater(f.anchorDir, { sequence: 1, body_digest: "a".repeat(64), store_id: "foreign", attempt: 1 });
    }
    assert.throws(() => f.lookup(f.query("register", reg)));
    assert.deepEqual(f.readRaw(), before);
    assert.throws(() => f.store.snapshot());
  });
}

test("postcommit unknown remains poisoned and cannot be cleared by a history query or ordinary reopen", supported, t => {
  const f = fixture(t), { use } = f.prepare(), append = anchor.appendEntry;
  anchor.appendEntry = (file, entry) => { if (entry.type === "commit") throw new Error("postcommit"); return append(file, entry); };
  try { assert.throws(() => f.store.consumeWithCheckpoint(WRITER, use), /postcommit/); }
  finally { anchor.appendEntry = append; }
  const q = f.query("consume", use);
  assert.throws(() => f.lookup(q), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  assert.throws(() => f.reopen(), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
});

for (const damage of ["receipt", "consumption", "index"]) test(`well-anchored malformed ${damage} is refused instead of projected`, supported, t => {
  const f = fixture(t), { reg, req, use } = f.prepare();
  f.store.consumeWithCheckpoint(WRITER, use);
  f.rewrite(state => {
    if (damage === "receipt") state.witness_authority.targets["target-a"].registrations[reg.requestId].result.signature = "injected";
    else if (damage === "consumption") state.witness_authority.issuance_bindings[use.message.permit_id].consumption_record.at_ms++;
    else delete state.idempotency[req.permit.idempotencyKey];
  });
  const operation = damage === "receipt" ? "register" : damage === "consumption" ? "consume" : "issue";
  assert.throws(() => f.lookup(f.query(operation, operation === "register" ? reg : operation === "consume" ? use : req)));
});

test("history participates in the same real process lock barrier as writers", supported, async t => {
  const f = fixture(t), { reg } = f.prepare(), before = f.readRaw();
  const source = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, 250);
  `;
  const child = spawn(process.execPath, ["-e", source, path.join(f.anchorDir, coordination.FILE)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr))); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", () => reject(new Error(stderr))); });
  const start = performance.now(), result = f.lookup(f.query("register", reg));
  assert.ok(performance.now() - start >= 100, "query must wait for the shared lock");
  assert.equal(result.status, "found"); safe(result); assert.deepEqual(f.readRaw(), before);
  await exited;
});
