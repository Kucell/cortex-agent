"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const Module = require("node:module");
const { ProtectedPermitStore: Store, consumeBindingFields } = require("../../lib/coordination/protected-permit-store");
const delivery = require("../../lib/coordination/permit-delivery");
const witness = require("../../lib/coordination/permit-witness-contract");
const anchor = require("../../lib/coordination/protected-anchor");
const { signRevocationList } = require("../../lib/coordination/permit-revocation-signing");

// Public RFC 8032 TEST seed. Never a deployed credential; children use the same
// deterministic test signer without putting private material in files/env/argv.
function testKey() {
  const privateKey = crypto.createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex") });
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  return { publicKeyPem, fingerprint: delivery.publicKeyFingerprint(publicKeyPem),
    privateKeyRef: { sign: (bytes) => crypto.sign(null, bytes, privateKey) } };
}

const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || process.platform === "win32" };
const PEER = Object.freeze({ principal: "test-host" });
function fixture(t, overrides = {}) {
  const base = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "witness-authority-"));
  const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  const key = testKey();
  let now = 1000;
  const controls = { observation: { targetHasProcess: false, targetHasPriorRun: false }, revoked: [],
    signCalls: 0, afterPull: null, ...overrides };
  const authority = { mode: "development-only", authorityId: "test-authority",
    authorize: (peer) => peer === PEER,
    observeTarget: () => controls.observation,
    signPermit: (fingerprint, permit, at) => {
      controls.signCalls++;
      return { fingerprint, publicKeyPem: key.publicKeyPem,
        signedPermit: delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit, issuedAtMs: at, nowMs: at }) };
    },
    pullRevocation: (_targetId, current, at) => {
      const list = signRevocationList({ ...key, issuedAtMs: at, fingerprints: controls.revoked,
        state: { appliedRevocationSequence: current.state.applied_revocation_sequence,
          revokedFingerprints: new Set(current.state.revoked_fingerprints) } });
      if (controls.afterPull) controls.afterPull();
      return list;
    },
  };
  const file = path.join(dbDir, "authority.sqlite");
  const options = { decisionId: "D-test", anchorDir, anchorMode: "permissive", clock: () => now, witnessAuthority: authority };
  const store = Store.initialize(file, options);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const reopen = (extra = {}) => Store.open(file, { ...options, expectedDecisionId: "D-test", minimumEpoch: 1, ...extra });
  const registration = (targetId = "target-a", extra = {}) => ({ targetId, requestId: "registration-1", checkpoint: null,
    pin: { decision_id: "D-test", instance_id: targetId, fingerprint: key.fingerprint, public_key_pem: key.publicKeyPem,
      source_digest: "sha256:source", deployment_digest: "sha256:deployment", run_id: "run", generation: "run-generation",
      valid_from: 0, valid_until: 100000 }, ...extra });
  const checkpoint = (targetId = "target-a") => store.snapshot().witness_authority.targets[targetId].current.checkpoint;
  const issueRequest = (targetId = "target-a", extra = {}) => ({ targetId, checkpoint: checkpoint(targetId),
    batchFingerprint: key.fingerprint,
    lease: { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
      generation: "run-generation", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease-1", ttlMs: 5000 },
    permit: { idempotencyKey: "permit-1", operation: "invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 2000 },
    ...extra });
  const consumeRequest = (issued, extra = {}) => ({ targetId: "target-a", checkpoint: checkpoint(),
    message: issued.signedPermit.message, signature: issued.signedPermit.signature, ...extra });
  return { store, file, root, anchorDir, options, authority, controls, key, registration, checkpoint, issueRequest,
    consumeRequest, reopen, setTime: (value) => { now = value; } };
}
function prepared(t, overrides) {
  const f = fixture(t, overrides);
  f.store.registerWitnessTarget(PEER, f.registration());
  const issued = f.store.issueWitnessPermit(PEER, f.issueRequest());
  return { ...f, issued };
}

function injectAuditFsyncFailure(f) {
  const sync = fs.fsyncSync, file = path.join(f.anchorDir, "protected-anchor-audit.log");
  let calls = 0;
  fs.fsyncSync = function(fd, ...args) {
    // Match the real audit inode, not anchor/lock/DB sync or an obsolete append hook.
    const actual = fs.fstatSync(fd), expected = fs.statSync(file);
    if (actual.dev === expected.dev && actual.ino === expected.ino) {
      calls++;
      throw new Error("test audit fsync failure");
    }
    return sync.call(this, fd, ...args);
  };
  return { calls: () => calls, restore: () => { fs.fsyncSync = sync; } };
}

function assertPoisonAfterRestart(f, request, before) {
  const source = `
    const { ProtectedPermitStore: Store } = require(process.argv[1]);
    const input = JSON.parse(process.argv[2]);
    const store = Store.open(input.file, { expectedDecisionId: 'D-test', minimumEpoch: 1,
      anchorDir: input.anchorDir, anchorMode: 'permissive', clock: () => 1001,
      witnessAuthority: { mode: 'development-only', authorityId: 'test-authority',
        authorize: () => true,
        observeTarget: () => { throw new Error('must not observe'); },
        signPermit: () => { throw new Error('must not sign'); },
        pullRevocation: () => { throw new Error('must not pull'); } } });
    let denied;
    try { store.issueWitnessPermit({}, input.request); } catch (error) { denied = error.code; }
    process.stdout.write(JSON.stringify({ denied, state: store.snapshot() }));
    store.close();
  `;
  const child = spawnSync(process.execPath, ["-e", source, require.resolve("../../lib/coordination/protected-permit-store"),
    JSON.stringify({ file: f.file, anchorDir: f.anchorDir, request })], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.denied, "ERR_WITNESS_CLOCK");
  assert.equal(result.state.witness_authority.clock_poisoned, true);
  for (const target of Object.values(result.state.witness_authority.targets)) assert.equal(target.current.state.clock_poisoned, true);
  for (const field of ["lease", "lease_seq", "fencing", "permit_seq", "permits", "idempotency", "lease_idempotency", "desktop"]) {
    assert.deepEqual(result.state[field], before[field], field);
  }
  assert.deepEqual(result.state.witness_authority.issuance_bindings, before.witness_authority.issuance_bindings);
}

test("authority mode is explicit, development-only, and cannot upgrade a legacy store on open", supported, t => {
  const f = fixture(t);
  const legacyDir = path.join(f.root, "legacy"), legacyAnchor = path.join(f.root, "legacy-anchor");
  fs.mkdirSync(legacyDir); fs.mkdirSync(legacyAnchor);
  const file = path.join(legacyDir, "state.sqlite");
  const options = { ...f.options, anchorDir: legacyAnchor, witnessAuthority: undefined };
  const legacy = Store.initialize(file, options);
  try {
    assert.equal(legacy.snapshot().schema_version, 2);
    assert.throws(() => legacy.registerWitnessTarget(PEER, f.registration()), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    assert.throws(() => Store.open(file, { ...options, expectedDecisionId: "D-test", minimumEpoch: 1,
      witnessAuthority: f.authority }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  } finally { legacy.close(); }
  assert.throws(() => f.reopen({ witnessAuthority: undefined }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  for (const patch of [{ mode: "production" }, { productionEnabled: true }, { authorize: undefined }, { pullRevocation: undefined },
    { authorityId: "another-authority" }]) {
    assert.throws(() => f.reopen({ witnessAuthority: { ...f.authority, ...patch } }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  }
});

test("registration mints independent target generations, retains pins and returns idempotent receipts", supported, t => {
  const f = fixture(t), request = f.registration();
  const first = f.store.registerWitnessTarget(PEER, request);
  const retry = f.store.registerWitnessTarget(PEER, request);
  assert.deepEqual(retry, first);
  assert.equal(first.executionAuthorized, false);
  const other = f.store.registerWitnessTarget(PEER, f.registration("target-b"));
  assert.notEqual(first.checkpoint.store_generation, other.checkpoint.store_generation);
  assert.notEqual(first.checkpoint.store_generation, f.store.snapshot().store_id);
  const originalPin = f.store.snapshot().witness_authority.targets["target-a"].current.state.pins[0];
  const reconnect = f.registration("target-a", { requestId: "reconnect", checkpoint: first.checkpoint,
    pin: { ...request.pin, run_id: "later-run", valid_until: 200000, source_digest: "different-record" } });
  assert.equal(f.store.registerWitnessTarget(PEER, reconnect).reused, true);
  assert.deepEqual(f.store.snapshot().witness_authority.targets["target-a"].current.state.pins[0], originalPin);
  assert.throws(() => f.store.registerWitnessTarget(PEER, { ...request, pin: { ...request.pin, run_id: "different" } }),
    { code: "ERR_IDEMPOTENCY_MISMATCH" });
});

test("registration refuses caller facts, undecidable freshness, bad keys and unauthorized peers without writes", supported, t => {
  const f = fixture(t), before = f.store.snapshot();
  assert.throws(() => f.store.registerWitnessTarget({}, f.registration()), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.throws(() => f.store.registerWitnessTarget(PEER, { ...f.registration(), verified: true }));
  for (const observation of [undefined, {}, { targetHasProcess: true, targetHasPriorRun: false },
    { targetHasProcess: false, targetHasPriorRun: undefined }]) {
    f.controls.observation = observation;
    assert.throws(() => f.store.registerWitnessTarget(PEER, f.registration()), { code: "ERR_WITNESS_TARGET_NOT_FRESH" });
  }
  f.controls.observation = { targetHasProcess: false, targetHasPriorRun: false };
  const request = f.registration();
  assert.throws(() => f.store.registerWitnessTarget(PEER, { ...request, pin: { ...request.pin, fingerprint: "a".repeat(64) } }));
  assert.deepEqual(f.store.snapshot(), before);
});

test("issuance stores an immutable server binding while signed messages stay exactly 14+3", supported, t => {
  const f = prepared(t), request = f.issueRequest();
  const retry = f.store.issueWitnessPermit(PEER, request);
  assert.deepEqual(retry, f.issued);
  assert.equal(f.controls.signCalls, 1);
  assert.equal(consumeBindingFields().length, 14);
  assert.equal(Object.keys(f.issued.signedPermit.message).length, 17);
  assert.deepEqual(Object.keys(f.issued.signedPermit.message).sort(), [
    ...delivery.BINDING_FIELD_MAP.map(([, name]) => name), "permit_id", "issued_at_ms", "deadline_ms" ].sort());
  assert.equal(f.issued.executionAuthorized, false);
  const snapshot = f.store.snapshot(), id = f.issued.signedPermit.message.permit_id;
  const binding = snapshot.witness_authority.issuance_bindings[id];
  assert.equal(binding.target_generation, f.checkpoint().store_generation);
  assert.equal(binding.issuer_store_id, snapshot.store_id);
  assert.equal(binding.message_bytes, f.issued.signedPermit.bytes);
  const reopened = f.reopen();
  try { assert.deepEqual(reopened.snapshot(), snapshot); } finally { reopened.close(); }
  f.store.registerWitnessTarget(PEER, f.registration("target-b"));
  const before = f.store.snapshot();
  assert.throws(() => f.store.issueWitnessPermit(PEER, f.issueRequest("target-b")), { code: "ERR_IDEMPOTENCY_MISMATCH" });
  assert.deepEqual(f.store.snapshot(), before);
});

test("forged signing output rolls back lease, permit and issuance binding together", supported, t => {
  const f = fixture(t);
  f.store.registerWitnessTarget(PEER, f.registration());
  const bad = f.reopen({ witnessAuthority: { ...f.authority, signPermit: () => ({ fingerprint: f.key.fingerprint }) } });
  try {
    const before = bad.snapshot();
    assert.throws(() => bad.issueWitnessPermit(PEER, f.issueRequest()), { code: "ERR_INVALID_INPUT" });
    assert.deepEqual(bad.snapshot(), before);
  } finally { bad.close(); }
});

test("slow signing cannot commit an expired issuance or a future-dated signature", supported, t => {
  const f = fixture(t);
  f.store.registerWitnessTarget(PEER, f.registration());
  const before = f.store.snapshot();
  for (const scenario of ["expired", "future"]) {
    const bad = f.reopen({ witnessAuthority: { ...f.authority, signPermit: (fingerprint, permit, now) => {
      const result = f.authority.signPermit(fingerprint, permit, scenario === "future" ? now + 1 : now);
      if (scenario === "expired") f.setTime(result.signedPermit.deadline);
      return result;
    } } });
    try {
      assert.throws(() => bad.issueWitnessPermit(PEER, f.issueRequest()), { code: "ERR_CLOCK_INVALID" });
      assert.deepEqual(bad.snapshot(), before);
    } finally { bad.close(); f.setTime(1000); }
  }
});

for (const signerOutcome of ["valid", "malformed", "throws", "negative-clock"]) {
  test(`signing clock rollback persists poison without issuance when callback ${signerOutcome}`, supported, t => {
    const f = fixture(t);
    f.store.registerWitnessTarget(PEER, f.registration());
    f.store.registerWitnessTarget(PEER, f.registration("target-b"));
    const request = f.issueRequest(), before = f.store.snapshot();
    const bad = f.reopen({ witnessAuthority: { ...f.authority, signPermit: (...args) => {
      const result = f.authority.signPermit(...args);
      f.setTime(signerOutcome === "negative-clock" ? -1 : 999);
      if (signerOutcome === "throws") throw new Error("signer failed after rollback");
      return signerOutcome === "malformed" ? {} : result;
    } } });
    try {
      assert.throws(() => bad.issueWitnessPermit(PEER, request), { code: "ERR_WITNESS_CLOCK" });
      const after = bad.snapshot();
      assert.equal(after.anchor_sequence, before.anchor_sequence + 1);
      assert.equal(after.last_clock_ms, before.last_clock_ms);
      assert.equal(after.witness_authority.clock_poisoned, true);
      for (const [id, target] of Object.entries(after.witness_authority.targets)) {
        assert.equal(target.current.state.clock_poisoned, true);
        assert.equal(target.current.checkpoint.revision, before.witness_authority.targets[id].current.checkpoint.revision + 1);
        witness.assertCheckpointMatches(target.current, target.current.checkpoint);
      }
      f.setTime(1001);
      const reopened = f.reopen();
      try { assert.throws(() => reopened.issueWitnessPermit(PEER, request), { code: "ERR_WITNESS_CLOCK" }); }
      finally { reopened.close(); }
      assertPoisonAfterRestart(f, request, before);
    } finally { bad.close(); }
  });
}

for (const freshProcess of [false, true]) {
  test(`open clock rollback persists poison on ${freshProcess ? "process restart" : "reopen"}`, supported, t => {
    const f = prepared(t), request = f.issueRequest(), before = f.store.snapshot();
    if (freshProcess) {
      const source = `
        const { ProtectedPermitStore: Store } = require(process.argv[1]);
        const config = JSON.parse(process.argv[2]);
        try {
          const store = Store.open(config.file, { expectedDecisionId: 'D-test', minimumEpoch: 1,
            anchorDir: config.anchorDir, anchorMode: 'permissive', clock: () => 999,
            witnessAuthority: { mode: 'development-only', authorityId: 'test-authority',
              authorize: () => false, observeTarget: () => {}, signPermit: () => {}, pullRevocation: () => {} } });
          store.close();
          process.stdout.write('unexpected success');
        } catch (error) { process.stdout.write(error.code); }
      `;
      const child = spawnSync(process.execPath, ["-e", source, require.resolve("../../lib/coordination/protected-permit-store"),
        JSON.stringify({ file: f.file, anchorDir: f.anchorDir })], { encoding: "utf8", timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, "ERR_CLOCK_ROLLBACK");
    } else {
      f.setTime(999);
      assert.throws(() => f.reopen(), { code: "ERR_CLOCK_ROLLBACK" });
    }
    f.setTime(1001);
    assert.equal(f.store.snapshot().witness_authority.clock_poisoned, true);
    assert.throws(() => f.store.issueWitnessPermit(PEER, request), { code: "ERR_WITNESS_CLOCK" });
    assert.throws(() => f.store.restartService(), { code: "ERR_WITNESS_LEGACY_ENTRY_DISABLED" });
    assertPoisonAfterRestart(f, request, before);
  });
}

test("open persists its captured rollback observation without a second clock read", supported, t => {
  const f = prepared(t), request = f.issueRequest(), before = f.store.snapshot();
  let reads = 0;
  assert.throws(() => f.reopen({ clock: () => ++reads === 1 ? 999 : 1001 }), { code: "ERR_CLOCK_ROLLBACK" });
  assert.equal(reads, 1);
  f.setTime(1001);
  const after = f.store.snapshot();
  assert.equal(after.witness_authority.clock_poisoned, true);
  assert.equal(after.witness_authority.targets["target-a"].current.state.clock_poisoned, true);
  assert.deepEqual(after.permits, before.permits);
  assert.deepEqual(after.witness_authority.issuance_bindings, before.witness_authority.issuance_bindings);
  assertPoisonAfterRestart(f, request, before);
});

for (const secondRead of ["NaN", "throws"]) for (const freshProcess of [false, true]) {
  test(`captured open rollback survives second-read ${secondRead} across restart (${freshProcess ? "child open" : "same-process open"})`, supported, t => {
    const f = prepared(t), request = f.issueRequest(), before = f.store.snapshot();
    if (freshProcess) {
      const source = `
        const { ProtectedPermitStore: Store } = require(process.argv[1]);
        const input = JSON.parse(process.argv[2]);
        let reads = 0, error;
        try {
          const store = Store.open(input.file, { expectedDecisionId: 'D-test', minimumEpoch: 1,
            anchorDir: input.anchorDir, anchorMode: 'permissive', clock: () => {
              if (++reads === 1) return 999;
              if (input.secondRead === 'throws') throw new Error('second clock must not be read');
              return NaN;
            }, witnessAuthority: { mode: 'development-only', authorityId: 'test-authority',
              authorize: () => false, observeTarget: () => {}, signPermit: () => {}, pullRevocation: () => {} } });
          store.close();
        } catch (caught) { error = caught.code || caught.message; }
        process.stdout.write(JSON.stringify({ error, reads }));
      `;
      const child = spawnSync(process.execPath, ["-e", source, require.resolve("../../lib/coordination/protected-permit-store"),
        JSON.stringify({ file: f.file, anchorDir: f.anchorDir, secondRead })], { encoding: "utf8", timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), { error: "ERR_CLOCK_ROLLBACK", reads: 1 });
    } else {
      let reads = 0;
      assert.throws(() => f.reopen({ clock: () => {
        if (++reads === 1) return 999;
        if (secondRead === "throws") throw new Error("second clock must not be read");
        return NaN;
      } }), { code: "ERR_CLOCK_ROLLBACK" });
      assert.equal(reads, 1);
    }
    const after = f.store.snapshot();
    assert.equal(after.anchor_sequence, before.anchor_sequence + 1);
    assert.equal(after.last_clock_ms, before.last_clock_ms);
    assertPoisonAfterRestart(f, request, before);
  });
}

test("precommit open poison failure is not durable and requires external witness or isolated recovery", supported, t => {
  const f = prepared(t), before = f.store.snapshot();
  const fault = injectAuditFsyncFailure(f);
  try {
    assert.throws(() => f.reopen({ clock: () => 999 }), { code: "ERR_AUDIT_WRITE_FAILED" });
    assert.equal(fault.calls(), 1);
    // open failed and closed its new handle; the independent old reader is intact.
    assert.deepEqual(f.store.snapshot(), before);
  } finally { fault.restore(); }
  // A recovered clock cannot reconstruct the failed observation from the DB.
  // Do not interpret successful open as recovery approval or resume production:
  // this case needs independently durable evidence or an isolated recovery flow.
  const reopened = f.reopen({ clock: () => 1001 });
  try { assert.equal(reopened.snapshot().witness_authority.clock_poisoned, false); }
  finally { reopened.close(); }
});

test("negative integer time on open is a rollback and persists poison", supported, t => {
  const f = prepared(t), request = f.issueRequest(), before = f.store.snapshot();
  f.setTime(-1);
  assert.throws(() => f.reopen(), { code: "ERR_CLOCK_ROLLBACK" });
  f.setTime(1001);
  assertPoisonAfterRestart(f, request, before);
});

test("failed poison persistence during signing grants no issuance and writes no candidate signature", supported, t => {
  const f = fixture(t);
  f.store.registerWitnessTarget(PEER, f.registration());
  const before = f.store.snapshot(), request = f.issueRequest();
  const bad = f.reopen({ witnessAuthority: { ...f.authority, signPermit: (...args) => {
    const result = f.authority.signPermit(...args);
    f.setTime(999);
    return result;
  } } });
  const fault = injectAuditFsyncFailure(f);
  try {
    assert.throws(() => bad.issueWitnessPermit(PEER, request), { code: "ERR_AUDIT_WRITE_FAILED" });
    assert.equal(fault.calls(), 1);
    assert.throws(() => bad.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
    assert.throws(() => bad.issueWitnessPermit(PEER, request), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
    assert.equal(f.controls.signCalls, 1);
    assert.deepEqual(f.store.snapshot(), before);
  } finally { fault.restore(); bad.close(); }
  // Storage failure cannot promise durable poison. With the low clock still
  // present, reopen must retry persistence and refuse instead of signing.
  assert.throws(() => f.reopen(), { code: "ERR_CLOCK_ROLLBACK" });
  f.setTime(1001);
  assertPoisonAfterRestart(f, request, before);
});

test("development label and unsigned execution flag do not isolate signatures across trust domains", supported, t => {
  const f = prepared(t), { message, signature } = f.issued.signedPermit;
  // This counterexample is a production-enablement blocker, not an isolation
  // check. Removing/replacing the unsigned wrapper leaves a valid 14+3 permit.
  const rewrapped = { message, signature, executionAuthorized: true, mode: "production" };
  assert.equal(delivery.verifyPermitSignature({ ...rewrapped, publicKeyPem: f.key.publicKeyPem,
    expectedFingerprint: f.key.fingerprint, revokedFingerprints: new Set(),
    expectedDeadlineMs: message.deadline_ms, nowMs: 1000 }).ok, true);
  assert.equal(Object.keys(message).length, 17);
});

test("consume atomically commits full checkpoint, replay cursor, permit and binding; replay never grants execution", supported, t => {
  const f = prepared(t), before = f.store.snapshot(), request = f.consumeRequest(f.issued);
  const result = f.store.consumeWithCheckpoint(PEER, request);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.status, "consumed");
  const after = f.store.snapshot(), id = request.message.permit_id;
  const current = after.witness_authority.targets["target-a"].current;
  assert.equal(after.anchor_sequence, before.anchor_sequence + 1);
  assert.equal(after.permits[id].status, "consumed");
  assert.equal(after.witness_authority.issuance_bindings[id].status, "consumed");
  assert.deepEqual(after.witness_authority.issuance_bindings[id].consumption_record.checkpoint, current.checkpoint);
  assert.equal(current.state.highest_accepted_permit_sequence, request.message.sequence);
  assert.equal(current.state.applied_revocation_sequence, 1);
  assert.deepEqual(witness.assertCheckpointMatches(current, result.checkpoint), current);
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, request), { code: "ERR_WITNESS_CHECKPOINT_CONFLICT" });
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, { ...request, checkpoint: current.checkpoint }), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
  assert.deepEqual(f.store.snapshot(), after);
});

test("cross-target, forged-generation and unsigned-facts requests cannot move server bindings", supported, t => {
  const f = prepared(t);
  f.store.registerWitnessTarget(PEER, f.registration("target-b"));
  const before = f.store.snapshot(), request = f.consumeRequest(f.issued);
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, { ...request, targetId: "target-b", checkpoint: f.checkpoint("target-b") }),
    { code: "ERR_WITNESS_ISSUANCE_MISMATCH" });
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, { ...request, checkpoint: { ...request.checkpoint, store_generation: before.store_id } }),
    { code: "ERR_WITNESS_CHECKPOINT_CONFLICT" });
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, { ...request, facts: { verified: true } }));
  assert.throws(() => f.store.consumeWithCheckpoint({}, request), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.deepEqual(f.store.snapshot(), before);
});

test("every checkpoint binding is checked, and even a genuine new signature requires its issuance row", supported, t => {
  const f = prepared(t), request = f.consumeRequest(f.issued), before = f.store.snapshot();
  for (const patch of [{ authority_id: "other-authority" }, { target_id: "other-target" },
    { store_generation: "other-generation" }, { revision: request.checkpoint.revision + 1 },
    { full_state_digest: "a".repeat(64) }]) {
    assert.throws(() => f.store.consumeWithCheckpoint(PEER, { ...request, checkpoint: { ...request.checkpoint, ...patch } }),
      { code: "ERR_WITNESS_CHECKPOINT_CONFLICT" });
  }
  const message = { ...request.message, permit_id: "P-PERMIT-unissued" };
  const signature = f.key.privateKeyRef.sign(delivery.canonicalBytes(message)).toString("base64");
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, { ...request, message, signature }),
    { code: "ERR_WITNESS_ISSUANCE_MISMATCH" });
  assert.deepEqual(f.store.snapshot(), before);
});

test("loss of a server issuance binding cannot be silently repaired from a signed request", supported, t => {
  const f = prepared(t), request = f.consumeRequest(f.issued);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(f.file);
  try {
    const state = JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id = 1").get().body);
    delete state.witness_authority.issuance_bindings[f.issued.signedPermit.message.permit_id];
    const body = JSON.stringify(state);
    db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body,
      crypto.createHash("sha256").update(body).digest("hex"));
  } finally { db.close(); }
  assert.throws(() => f.reopen(), { code: "ERR_STATE_INVALID" });
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, request), { code: "ERR_STATE_INVALID" });
});

test("a signature or payload rejection still persists valid revocation without consuming", supported, t => {
  const f = prepared(t), request = f.consumeRequest(f.issued);
  f.controls.revoked = ["a".repeat(64)];
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, { ...request, message: { ...request.message, operation: "changed" } }),
    { code: "ERR_WITNESS_ISSUANCE_MISMATCH" });
  const snapshot = f.store.snapshot(), current = snapshot.witness_authority.targets["target-a"].current;
  assert.deepEqual(current.state.revoked_fingerprints, f.controls.revoked);
  assert.equal(current.state.applied_revocation_sequence, 1);
  assert.equal(current.state.highest_accepted_permit_sequence, 0);
  assert.equal(snapshot.permits[request.message.permit_id].status, "reserved");
  assert.equal(snapshot.witness_authority.issuance_bindings[request.message.permit_id].status, "issued");
  const reopened = f.reopen();
  try { assert.deepEqual(reopened.snapshot(), snapshot); } finally { reopened.close(); }
});

test("a fresh revocation of the actual signer is committed and blocks consumption", supported, t => {
  const f = prepared(t);
  f.controls.revoked = [f.key.fingerprint];
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, f.consumeRequest(f.issued)), { code: "ERR_REVOCATION_SIGNER_INVALID" });
  const current = f.store.snapshot().witness_authority.targets["target-a"].current;
  assert.deepEqual(current.state.revoked_fingerprints, [f.key.fingerprint]);
  assert.equal(current.state.highest_accepted_permit_sequence, 0);
});

test("bad revocation signatures never advance any state", supported, t => {
  const f = prepared(t), before = f.store.snapshot();
  const bad = f.reopen({ witnessAuthority: { ...f.authority, pullRevocation: (...args) => ({
    ...f.authority.pullRevocation(...args), signature: Buffer.alloc(64).toString("base64") }) } });
  try {
    assert.throws(() => bad.consumeWithCheckpoint(PEER, f.consumeRequest(f.issued)), { key: "ERR_PERMIT_SIGNATURE_INVALID" });
    assert.deepEqual(bad.snapshot(), before);
  } finally { bad.close(); }
});

test("deadline reached during revocation pull refuses consumption but commits the valid list", supported, t => {
  const f = prepared(t);
  f.controls.afterPull = () => f.setTime(f.issued.signedPermit.deadline);
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, f.consumeRequest(f.issued)), { code: "ERR_PERMIT_DEADLINE_EXPIRED" });
  const snapshot = f.store.snapshot(), current = snapshot.witness_authority.targets["target-a"].current;
  assert.equal(current.state.applied_revocation_sequence, 1);
  assert.equal(current.state.highest_accepted_permit_sequence, 0);
  assert.equal(snapshot.permits[f.issued.signedPermit.message.permit_id].status, "reserved");
});

for (const midPull of [false, true]) test(`clock rollback ${midPull ? "during pull" : "before transaction"} durably poisons the authority after commit`, supported, t => {
  const f = prepared(t), request = f.consumeRequest(f.issued);
  if (midPull) f.controls.afterPull = () => f.setTime(999);
  else f.setTime(999);
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, request), { code: "ERR_WITNESS_CLOCK" });
  f.setTime(1001);
  const snapshot = f.store.snapshot(), current = snapshot.witness_authority.targets["target-a"].current;
  assert.equal(snapshot.witness_authority.clock_poisoned, true);
  assert.equal(current.state.clock_poisoned, true);
  assert.equal(current.state.highest_accepted_permit_sequence, 0);
  assert.equal(snapshot.permits[request.message.permit_id].status, "reserved");
  const reopened = f.reopen();
  try {
    assert.throws(() => reopened.consumeWithCheckpoint(PEER, { ...request, checkpoint: current.checkpoint }), { code: "ERR_WITNESS_CLOCK" });
  } finally { reopened.close(); }
});

test("all legacy writers and all static recovery/reset routes refuse authority state", supported, t => {
  const f = prepared(t), before = f.store.snapshot(), lease = before.lease;
  const permit = { ...lease, ...f.issueRequest().permit };
  const fields = { permitId: f.issued.signedPermit.message.permit_id,
    ...Object.fromEntries(delivery.BINDING_FIELD_MAP.map(([storage, signed]) => [storage, f.issued.signedPermit.message[signed]])) };
  const calls = [() => f.store.acquire(f.issueRequest().lease), () => f.store.renew({ ...lease, ttlMs: 1000 }),
    () => f.store.reserve(permit), () => f.store.reserveBoundToBatch(permit, f.key.fingerprint),
    () => f.store.acquireAndReserveBoundToBatch(f.issueRequest().lease, f.issueRequest().permit, f.key.fingerprint, () => f.issued),
    () => f.store.consume(fields), () => f.store.finish({ ...fields, outcome: "finished" }),
    () => f.store.revoke(lease), () => f.store.release(lease), () => f.store.expire(),
    () => f.store.restartService(), () => f.store.recover({ verified: true })];
  for (const call of calls) assert.throws(call, { code: "ERR_WITNESS_LEGACY_ENTRY_DISABLED" });
  for (const name of ["recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
    assert.throws(() => Store[name](f.file, { ...f.options, expectedDecisionId: "D-test",
      audit: { by: "test", reason: "must not erase binding history" } }), { code: "ERR_WITNESS_RECOVERY_UNSUPPORTED" });
  }
  assert.deepEqual(f.store.snapshot(), before);
});

test("the real legacy schema-1 reader refuses opening schema-3 authority state", supported, t => {
  const f = prepared(t), before = f.store.snapshot();
  // Compile the preserved historical source with its original relative imports;
  // no compatibility wrapper substitutes a modern reader for the old binary.
  const filename = path.join(__dirname, "../../lib/coordination/legacy-permit-store-test.cjs");
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = fs.readFileSync(path.join(__dirname, "fixtures/protected-permit-store-v1-source.txt"), "utf8");
  compiled._compile(source, filename);
  assert.throws(() => compiled.exports.ProtectedPermitStore.open(f.file, {
    expectedDecisionId: "D-test", minimumEpoch: 1, anchorDir: f.anchorDir, anchorMode: "permissive", clock: () => 1000,
  }), { code: "ERR_STATE_INVALID" });
  assert.deepEqual(f.store.snapshot(), before);
});

test("a failed precommit audit rolls back consumption and checkpoint together", supported, t => {
  const f = prepared(t), before = f.store.snapshot(), request = f.consumeRequest(f.issued);
  const fault = injectAuditFsyncFailure(f);
  try { assert.throws(() => f.store.consumeWithCheckpoint(PEER, request), { code: "ERR_AUDIT_WRITE_FAILED" }); }
  finally { fault.restore(); }
  assert.equal(fault.calls(), 1);
  assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  assert.throws(() => f.store.consumeWithCheckpoint(PEER, request), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  const reopened = f.reopen();
  try {
    assert.deepEqual(reopened.snapshot(), before);
    assert.equal(reopened.consumeWithCheckpoint(PEER, request).status, "consumed");
  } finally { reopened.close(); }
});

test("postcommit witness failure poisons the handle while DB consumption and checkpoint remain atomic", supported, t => {
  const f = prepared(t), request = f.consumeRequest(f.issued), before = f.checkpoint();
  const append = anchor.appendEntry;
  anchor.appendEntry = function(file, entry, ...capability) {
    if (entry.type === "commit") throw new Error("test postcommit failure");
    return append(file, entry, ...capability);
  };
  try { assert.throws(() => f.store.consumeWithCheckpoint(PEER, request), /test postcommit failure/); }
  finally { anchor.appendEntry = append; }
  assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(f.file, { readOnly: true });
  try {
    const snapshot = JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id = 1").get().body);
    const current = snapshot.witness_authority.targets["target-a"].current;
    assert.equal(snapshot.permits[request.message.permit_id].status, "consumed");
    assert.equal(current.checkpoint.revision, before.revision + 1);
    assert.deepEqual(snapshot.witness_authority.issuance_bindings[request.message.permit_id].consumption_record.checkpoint, current.checkpoint);
  } finally { db.close(); }
  assert.throws(() => f.reopen(), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
});

test("two real processes race the same permit/checkpoint and commit exactly one consumption", supported, async t => {
  const f = prepared(t), request = f.consumeRequest(f.issued), before = f.store.snapshot();
  const source = `
    const { ProtectedPermitStore: Store } = require(process.argv[1]);
    const delivery = require(process.argv[2]);
    const { signRevocationList } = require(process.argv[3]);
    const crypto = require('node:crypto');
    const testKey = ${testKey.toString()};
    const key = testKey();
    const store = Store.open(process.argv[4], { expectedDecisionId: 'D-test', minimumEpoch: 1,
      anchorDir: process.argv[5], anchorMode: 'permissive', clock: () => 1000,
      witnessAuthority: { mode: 'development-only', authorityId: 'test-authority',
        authorize: peer => peer === 'test-host', observeTarget: () => { throw new Error('unused'); },
        signPermit: () => { throw new Error('unused'); },
        pullRevocation: (_id, current, at) => signRevocationList({ ...key, issuedAtMs: at,
          fingerprints: [], state: { appliedRevocationSequence: current.state.applied_revocation_sequence,
            revokedFingerprints: new Set(current.state.revoked_fingerprints) } }) } });
    process.once('message', request => {
      let result;
      try { result = store.consumeWithCheckpoint('test-host', request); }
      catch (error) { result = { error: error.code || error.key }; }
      store.close();
      process.send(result, () => process.disconnect());
    });
    process.send('ready');
  `;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ["-e", source,
      require.resolve("../../lib/coordination/protected-permit-store"), require.resolve("../../lib/coordination/permit-delivery"),
      require.resolve("../../lib/coordination/permit-revocation-signing"), f.file, f.anchorDir], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", part => { stderr += part; });
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("message", resolve);
      child.once("exit", code => { if (code !== 0) reject(new Error(stderr)); });
    });
    const result = new Promise((resolve, reject) => {
      child.on("message", value => { if (value !== "ready") resolve(value); });
      child.once("error", reject);
      child.once("exit", code => { if (code !== 0) reject(new Error(stderr)); });
    });
    const exited = new Promise(resolve => child.once("exit", resolve));
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, ready, result, exited };
  });
  await Promise.all(children.map(child => child.ready));
  children.forEach(({ child }) => child.send(request));
  const results = await Promise.all(children.map(child => child.result));
  assert.deepEqual(results.filter(result => result.error).map(result => result.error), ["ERR_WITNESS_CHECKPOINT_CONFLICT"]);
  assert.equal(results.filter(result => result.status === "consumed").length, 1);
  assert.equal(results.find(result => result.status === "consumed").executionAuthorized, false);
  await Promise.all(children.map(child => child.exited));
  assert.equal(f.store.snapshot().anchor_sequence, before.anchor_sequence + 1);
});
