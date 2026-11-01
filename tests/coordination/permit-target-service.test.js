"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const { ProtectedPinStore } = require("../../lib/coordination/protected-pin-store");
const delivery = require("../../lib/coordination/permit-delivery");
const { signRevocationList } = require("../../lib/coordination/permit-revocation-signing");
const { createPermitTargetService } = require("../../lib/coordination/permit-target-service");

function fixture(revoked) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-target-test-"));
  const pinDir = path.join(root, "pin");
  fs.mkdirSync(pinDir);
  const pinStore = ProtectedPinStore.initialize(pinDir, { decisionId: "D-test", anchorMode: "permissive" });
  const batch = delivery.createBatchKeyPair();
  pinStore.registerPin({ batchIdentity: { decision_id: "D-test", instance_id: "instance",
    fingerprint: batch.fingerprint }, publicKeyPem: batch.publicKeyPem, nowMs: 1000,
  sourceDigest: "sha256:" + "a".repeat(64), deploymentDigest: "sha256:" + "b".repeat(64),
  runId: "run", generation: "1", validFrom: 1, validUntil: 5000,
  write: () => { const fd = fs.openSync(path.join(pinDir, "marker"), "wx", 0o600); fs.closeSync(fd); return true; } });
  const signed = delivery.buildSignedPermit({ privateKeyRef: batch.privateKeyRef, issuedAtMs: 1000,
    permit: { permitId: "p", leaseId: "l", sessionId: "s", hostId: "h", workerId: "w",
      runId: "run", generation: "1", desktopKey: "d", ownedAppId: "a", serviceEpoch: 1,
      fencing: 1, operation: "op", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64),
      sequence: 1, deadline: 2000 } });
  const list = signRevocationList({ privateKeyRef: batch.privateKeyRef, publicKeyPem: batch.publicKeyPem,
    state: delivery.createRevocationState(), fingerprints: revoked ? [batch.fingerprint] : [], issuedAtMs: 1000 });
  return { root, pinStore, batch, signed, list, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function currentState(f, overrides = {}) {
  const message = f.signed.message;
  const permit = { permitId: message.permit_id, status: "reserved", batchFingerprint: f.batch.fingerprint,
    deadline: message.deadline_ms, ...Object.fromEntries(delivery.BINDING_FIELD_MAP.map(([storage, signed]) => [storage, message[signed]])),
    ...overrides };
  const lease = { ...permit, status: "active", expiresAt: 5000 };
  return { permits: { [permit.permitId]: permit }, lease, service_epoch: permit.serviceEpoch,
    fencing: permit.fencing, desktop: { status: "held", key: permit.desktopKey } };
}

test("verification first applies a signed fresh revocation list", () => {
  const f = fixture(false);
  try {
    const service = createPermitTargetService({ pinStore: f.pinStore, pullRevocation: () => f.list,
      resolvePermitState: () => currentState(f), clock: () => 1000 });
    assert.equal(service.key(f.batch.fingerprint).publicKeyPem, f.batch.publicKeyPem);
    const result = service.verify({ fingerprint: f.batch.fingerprint, message: f.signed.message, signature: f.signed.signature });
    assert.equal(result.ok, true);
    assert.equal(result.executionAuthorized, false);
    assert.equal(Object.hasOwn(result, "bytes"), false);
    assert.equal(f.pinStore.revocationState().appliedRevocationSequence, 1);
  } finally { f.cleanup(); }
});

test("accepted permit sequence survives reopening and rejects replay", () => {
  const f = fixture(false);
  try {
    const makeService = (pinStore) => createPermitTargetService({ pinStore, clock: () => 1000,
      resolvePermitState: () => currentState(f), pullRevocation: () => signRevocationList({
        privateKeyRef: f.batch.privateKeyRef, publicKeyPem: f.batch.publicKeyPem,
        state: pinStore.revocationState(), fingerprints: [], issuedAtMs: 1000 }) });
    const request = { fingerprint: f.batch.fingerprint, message: f.signed.message, signature: f.signed.signature };
    assert.equal(makeService(f.pinStore).verify(request).ok, true);
    const reopened = ProtectedPinStore.open(f.pinStore.pinDir, { decisionId: "D-test", anchorMode: "permissive" });
    assert.throws(() => makeService(reopened).verify(request), { key: "ERR_PERMIT_SEQUENCE_REPLAY" });
    assert.equal(reopened.assertPermitReplayState(), 1);
    assert.equal(reopened.revocationState().appliedRevocationSequence, 2);
  } finally { f.cleanup(); }
});

test("legacy pin state is not treated as an empty permit history", () => {
  const f = fixture(false);
  try {
    const statePath = path.join(f.pinStore.pinDir, "pin-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.schema_version = 1;
    delete state.highest_accepted_permit_sequence;
    fs.writeFileSync(statePath, JSON.stringify(state));
    let pulled = false;
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      resolvePermitState: () => currentState(f), pullRevocation: () => { pulled = true; return f.list; } });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.equal(pulled, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), state);
  } finally { f.cleanup(); }
});

test("a rejected permit advances only a valid revocation list", () => {
  const f = fixture(false);
  try {
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      resolvePermitState: () => currentState(f), pullRevocation: () => f.list });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: "invalid" }));
    assert.equal(f.pinStore.revocationState().appliedRevocationSequence, 1);
    assert.equal(f.pinStore.assertPermitReplayState(), 0);
  } finally { f.cleanup(); }
});

test("only the authenticated revocation set is committed if the source object changes", () => {
  const f = fixture(false);
  try {
    const injected = "c".repeat(64);
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      pullRevocation: () => f.list, resolvePermitState: () => {
        f.list.revoked_fingerprints.push(injected);
        return currentState(f);
      } });
    assert.equal(service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }).ok, true);
    assert.equal(f.pinStore.revocationState().revokedFingerprints.has(injected), false);
  } finally { f.cleanup(); }
});

test("custom iteration cannot change the signed revocation set", () => {
  const f = fixture(false);
  try {
    const injected = "c".repeat(64);
    f.list.revoked_fingerprints[Symbol.iterator] = function* () { yield injected; };
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      pullRevocation: () => f.list, resolvePermitState: () => currentState(f) });
    assert.equal(service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }).ok, true);
    assert.equal(f.pinStore.revocationState().revokedFingerprints.has(injected), false);
  } finally { f.cleanup(); }
});

test("the committed revocation sequence is the authenticated sequence", () => {
  const f = fixture(false);
  try {
    let reads = 0;
    Object.defineProperty(f.list, "revocation_sequence", { enumerable: true, get: () => (++reads === 1 ? 1000 : 1) });
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      pullRevocation: () => f.list, resolvePermitState: () => currentState(f) });
    assert.equal(service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }).ok, true);
    assert.equal(f.pinStore.revocationState().appliedRevocationSequence, 1);
    assert.throws(() => f.pinStore.commitRevocation({ sequence: 3, revokedFingerprints: [] }),
      { key: "ERR_REVOCATION_SEQUENCE_BROKEN" });
  } finally { f.cleanup(); }
});

test("verification uses a detached authoritative snapshot", () => {
  const f = fixture(false);
  try {
    const state = currentState(f);
    let reads = 0;
    const service = createPermitTargetService({ pinStore: f.pinStore, pullRevocation: () => f.list,
      resolvePermitState: () => state, clock: () => {
        if (++reads === 3) state.permits.p.deadline = 1500;
        return 1200;
      } });
    assert.equal(service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }).ok, true);
  } finally { f.cleanup(); }
});

test("verification uses a detached request when a provider mutates the caller object", () => {
  const f = fixture(false);
  try {
    const state = currentState(f);
    const request = { fingerprint: f.batch.fingerprint, message: f.signed.message, signature: f.signed.signature };
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      pullRevocation: () => f.list, resolvePermitState: () => {
        request.message.operation = "other";
        return state;
      } });
    assert.equal(service.verify(request).ok, true);
    assert.equal(request.message.operation, "other");
  } finally { f.cleanup(); }
});

test("undefined signed bindings are refused even when the snapshot has the same value", () => {
  const f = fixture(false);
  try {
    const message = { ...f.signed.message, worker_identity: undefined };
    const signature = f.batch.privateKeyRef.sign(delivery.canonicalBytes(message)).toString("base64");
    const state = currentState(f);
    state.permits.p.workerId = undefined;
    state.lease.workerId = undefined;
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      pullRevocation: () => f.list, resolvePermitState: () => state });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint, message, signature }),
      { key: "ERR_PERMIT_INPUT_INVALID" });
    assert.equal(f.pinStore.assertPermitReplayState(), 0);
  } finally { f.cleanup(); }
});

test("lease expiry during verification is refused", () => {
  const f = fixture(false);
  try {
    let reads = 0;
    const state = currentState(f);
    state.lease.expiresAt = 1001;
    const service = createPermitTargetService({ pinStore: f.pinStore,
      clock: () => (++reads < 3 ? 1000 : 1001), pullRevocation: () => f.list,
      resolvePermitState: () => state });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }), { key: "ERR_PERMIT_INPUT_INVALID" });
  } finally { f.cleanup(); }
});

test("version 2 pin state missing its permit high-water mark is refused", () => {
  const f = fixture(false);
  try {
    const statePath = path.join(f.pinStore.pinDir, "pin-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    delete state.highest_accepted_permit_sequence;
    fs.writeFileSync(statePath, JSON.stringify(state));
    assert.throws(() => f.pinStore.assertPermitReplayState(), { key: "ERR_PIN_STATE_CORRUPT" });
  } finally { f.cleanup(); }
});

test("a failed state replacement leaves no temporary file and can be retried", () => {
  const f = fixture(false);
  const originalRename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => {
      if (target === path.join(f.pinStore.pinDir, "pin-state.json")) {
        const error = new Error("injected write failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(source, target);
    };
    assert.throws(() => f.pinStore.commitRevocation({ sequence: 1, revokedFingerprints: [] }), { code: "EIO" });
    fs.renameSync = originalRename;
    assert.equal(fs.readdirSync(f.pinStore.pinDir).some((name) => name.startsWith(".pin-state.json.tmp-")), false);
    f.pinStore.commitRevocation({ sequence: 1, revokedFingerprints: [] });
    assert.equal(f.pinStore.revocationState().appliedRevocationSequence, 1);
  } finally { fs.renameSync = originalRename; f.cleanup(); }
});

test("fresh revocation and unavailable pulls both refuse verification", () => {
  const f = fixture(true);
  try {
    const request = { fingerprint: f.batch.fingerprint, message: f.signed.message, signature: f.signed.signature };
    const unavailable = createPermitTargetService({ pinStore: f.pinStore, pullRevocation: () => { throw new Error("offline"); },
      resolvePermitState: () => currentState(f), clock: () => 1000 });
    assert.throws(() => unavailable.verify(request), { key: "ERR_REVOCATION_PULL_FAILED" });
    assert.equal(f.pinStore.revocationState().appliedRevocationSequence, 0);
    const revoked = createPermitTargetService({ pinStore: f.pinStore, pullRevocation: () => f.list,
      resolvePermitState: () => currentState(f), clock: () => 1000 });
    assert.throws(() => revoked.verify(request), { key: "ERR_REVOCATION_SIGNER_INVALID" });
    assert.equal(f.pinStore.revocationState().appliedRevocationSequence, 1);
  } finally { f.cleanup(); }
});

test("a deadline differing from the trusted store is refused", () => {
  const f = fixture(false);
  try {
    const service = createPermitTargetService({ pinStore: f.pinStore, pullRevocation: () => f.list,
      resolvePermitState: () => currentState(f, { deadline: 1999 }), clock: () => 1000 });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }), { key: "ERR_PERMIT_DEADLINE_MISMATCH" });
  } finally { f.cleanup(); }
});

test("revoked, rebound or unavailable authoritative state rejects the permit", () => {
  for (const alter of [
    (state) => { state.permits.p.status = "revoked"; },
    (state) => { state.lease.status = "released"; },
    (state) => { state.service_epoch += 1; },
    (state) => { state.fencing += 1; },
    (state) => { state.permits.p.workerId = "other"; },
    (state) => { state.permits.p.batchFingerprint = "0".repeat(64); },
  ]) {
    const f = fixture(false);
    try {
      const state = currentState(f);
      alter(state);
      const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
        pullRevocation: () => f.list, resolvePermitState: () => state });
      assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
        message: f.signed.message, signature: f.signed.signature }), { key: "ERR_PERMIT_INPUT_INVALID" });
      assert.equal(f.pinStore.assertPermitReplayState(), 0);
    } finally { f.cleanup(); }
  }
  const f = fixture(false);
  try {
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => 1000,
      pullRevocation: () => f.list, resolvePermitState: () => null });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }), { key: "ERR_PERMIT_INPUT_INVALID" });
    assert.equal(f.pinStore.assertPermitReplayState(), 0);
  } finally { f.cleanup(); }
});

test("verification checks the deadline again after the revocation pull", () => {
  const f = fixture(false);
  try {
    let currentTime = 1000;
    const service = createPermitTargetService({ pinStore: f.pinStore,
      pullRevocation: () => { currentTime = 100000; return f.list; },
      resolvePermitState: () => currentState(f), clock: () => currentTime });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }), { key: "ERR_PERMIT_DEADLINE_EXPIRED" });
  } finally { f.cleanup(); }
});

test("invalid clock is refused before applying revocation", () => {
  const f = fixture(false);
  try {
    const service = createPermitTargetService({ pinStore: f.pinStore, pullRevocation: () => f.list,
      resolvePermitState: () => currentState(f), clock: () => -1 });
    assert.throws(() => service.verify({ fingerprint: f.batch.fingerprint,
      message: f.signed.message, signature: f.signed.signature }), { key: "ERR_CLOCK_INVALID" });
    assert.equal(f.pinStore.revocationState().appliedRevocationSequence, 0);
  } finally { f.cleanup(); }
});

test("clock rollback poisons the domain and stays poisoned after reopening", () => {
  const f = fixture(false);
  try {
    let time = 1000;
    const service = createPermitTargetService({ pinStore: f.pinStore, clock: () => time,
      resolvePermitState: () => currentState(f), pullRevocation: () => signRevocationList({
        privateKeyRef: f.batch.privateKeyRef, publicKeyPem: f.batch.publicKeyPem,
        state: f.pinStore.revocationState(), fingerprints: [], issuedAtMs: 1000 }) });
    const request = { fingerprint: f.batch.fingerprint, message: f.signed.message, signature: f.signed.signature };
    assert.equal(service.verify(request).ok, true);
    time = 999;
    assert.throws(() => service.verify(request), { key: "ERR_CLOCK_INVALID" });
    const reopened = ProtectedPinStore.open(f.pinStore.pinDir, { decisionId: "D-test", anchorMode: "permissive" });
    assert.equal(reopened.isClockPoisoned(), true);
    assert.equal(reopened.assertPermitReplayState(), 1);
  } finally { f.cleanup(); }
});

test("a failed rollback-marker write still poisons other in-process handles", () => {
  const f = fixture(false);
  const originalRename = fs.renameSync;
  try {
    f.pinStore.observePermitClock(1000);
    fs.renameSync = (source, target) => {
      if (target === path.join(f.pinStore.pinDir, "pin-state.json")) {
        const error = new Error("injected poison write failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(source, target);
    };
    assert.throws(() => f.pinStore.observePermitClock(999), { code: "EIO" });
    fs.renameSync = originalRename;
    const reopened = ProtectedPinStore.open(f.pinStore.pinDir, { decisionId: "D-test", anchorMode: "permissive" });
    assert.equal(reopened.isClockPoisoned(), true);
    assert.throws(() => reopened.observePermitClock(1000), { key: "ERR_CLOCK_INVALID" });
  } finally { fs.renameSync = originalRename; f.cleanup(); }
});

test("registration uses the host observer and creates a private exclusive pin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-register-test-"));
  try {
    const pinStore = ProtectedPinStore.initialize(root, { decisionId: "D-test", anchorMode: "permissive" });
    const batch = delivery.createBatchKeyPair();
    const request = { batchIdentity: { decision_id: "D-test", instance_id: "instance", fingerprint: batch.fingerprint },
      publicKeyPem: batch.publicKeyPem, sourceDigest: "sha256:" + "a".repeat(64),
      deploymentDigest: "sha256:" + "b".repeat(64), runId: "run", generation: "1",
      validFrom: 1, validUntil: 5000, targetHasProcess: false, targetHasPriorRun: false };
    const options = { pinStore, pullRevocation: () => null, resolvePermitState: () => null, clock: () => 1000 };
    const privatePem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    const privateInput = createPermitTargetService({ ...options,
      observeTarget: () => ({ targetHasProcess: false, targetHasPriorRun: false }) });
    assert.throws(() => privateInput.register({ ...request, publicKeyPem: privatePem }), { key: "ERR_PERMIT_INPUT_INVALID" });
    assert.equal(pinStore.listPins().length, 0);
    const unconfigured = createPermitTargetService(options);
    assert.throws(() => unconfigured.register(request), { key: "ERR_PERMIT_INPUT_INVALID" });
    const unknown = createPermitTargetService({ ...options,
      observeTarget: () => ({ targetHasProcess: null, targetHasPriorRun: false }) });
    assert.throws(() => unknown.register(request), { key: "ERR_PERMIT_INPUT_INVALID" });
    assert.equal(pinStore.listPins().length, 0);
    const rejected = createPermitTargetService({ ...options,
      observeTarget: () => ({ targetHasProcess: true, targetHasPriorRun: false }) });
    assert.throws(() => rejected.register(request), { key: "ERR_PIN_NOT_EXCLUSIVE" });
    assert.equal(pinStore.listPins().length, 0);
    const accepted = createPermitTargetService({ ...options,
      observeTarget: () => ({ targetHasProcess: false, targetHasPriorRun: false }) });
    assert.equal(accepted.register(request).registered, true);
    const file = path.join(root, `pin-${batch.fingerprint}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).fingerprint, batch.fingerprint);
    assert.throws(() => accepted.register(request), { key: "ERR_PIN_NOT_EXCLUSIVE" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
