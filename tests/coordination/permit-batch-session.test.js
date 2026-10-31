"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const { createPermitBatchSession } = require("../../lib/coordination/permit-batch-session");
const delivery = require("../../lib/coordination/permit-delivery");

test("invalid signing clock refuses issuance before acquiring or reserving", () => {
  let mutations = 0;
  const store = {
    acquire() { mutations += 1; },
    reserve() { mutations += 1; },
    reserveBoundToBatch() { mutations += 1; },
    acquireAndReserveBoundToBatch() { mutations += 1; },
  };
  const batch = createPermitBatchSession({ store, clock: () => -1 });
  try {
    assert.throws(() => batch.issue({ lease: {}, permit: {} }), { key: "ERR_CLOCK_INVALID" });
    assert.equal(mutations, 0);
  } finally { batch.close(); }
});

test("invalid permit input does not acquire a lease", () => {
  let acquired = false;
  const store = { acquire() { acquired = true; }, reserve() {}, acquireAndReserveBoundToBatch() { acquired = true; } };
  const batch = createPermitBatchSession({ store, clock: () => 1000 });
  try {
    assert.throws(() => batch.issue({ lease: {}, permit: { idempotencyKey: "id", operation: "read",
      targetDigest: "invalid", paramsDigest: "b".repeat(64), ttlMs: 1000 } }), { code: "ERR_INVALID_INPUT" });
    assert.equal(acquired, false);
  } finally { batch.close(); }
});

test("batch binds issuance to the protected store and rejects a new batch on retry", {
  skip: Number(process.versions.node.split(".")[0]) < 24,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-batch-test-"));
  const dbDir = path.join(root, "db");
  const anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir);
  fs.mkdirSync(anchorDir);
  let store;
  try {
    let now = 1_000_000;
    store = ProtectedPermitStore.initialize(path.join(dbDir, "state.sqlite"), {
      decisionId: "test-decision", anchorDir, anchorMode: "permissive", clock: () => now,
    });
    const batch = createPermitBatchSession({ store, clock: () => now });
    const request = {
      lease: { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker",
        runId: "run", generation: "1", desktopKey: "desktop", ownedAppId: "app",
        idempotencyKey: "lease", ttlMs: 5000 },
      permit: { idempotencyKey: "permit", operation: "test", targetDigest: "a".repeat(64),
        paramsDigest: "b".repeat(64), ttlMs: 10000, fencing: -1 },
    };
    assert.throws(() => batch.issue({ ...request, permit: { ...request.permit, targetDigest: "invalid" } }),
      { code: "ERR_INVALID_INPUT" });
    assert.equal(store.snapshot().desktop.status, "free");
    const output = batch.issue(request);
    assert.equal(output.signedPermit.message.deadline_ms, now + 5000);
    now += 50;
    const retry = batch.issue(request);
    assert.deepEqual(retry, output);
    retry.signedPermit.message.operation = "tampered";
    assert.deepEqual(batch.issue(request), output);
    const reopened = ProtectedPermitStore.open(path.join(dbDir, "state.sqlite"), {
      expectedDecisionId: "test-decision", minimumEpoch: 1, anchorDir,
      anchorMode: "permissive", clock: () => now,
    });
    try {
      assert.deepEqual(reopened.snapshot().permits[output.signedPermit.message.permit_id].signedIssuance, output);
    } finally { reopened.close(); }
    assert.throws(() => batch.issue({ ...request, permit: { ...request.permit, ttlMs: 1 } }),
      { code: "ERR_IDEMPOTENCY_MISMATCH" });
    assert.equal(store.snapshot().permits[output.signedPermit.message.permit_id].batchFingerprint, output.fingerprint);
    delivery.verifyPermitSignature({ message: output.signedPermit.message,
      signature: output.signedPermit.signature, publicKeyPem: output.publicKeyPem,
      expectedFingerprint: output.fingerprint, revokedFingerprints: new Set(),
      expectedDeadlineMs: output.signedPermit.message.deadline_ms, nowMs: now });
    const state = delivery.createRevocationState();
    const list = batch.signRevocation({ state, fingerprints: ["a".repeat(64)] });
    assert.doesNotMatch(JSON.stringify(list), /PRIVATE KEY|privateKeyRef/);
    const replacement = createPermitBatchSession({ store, clock: () => now });
    assert.throws(() => replacement.issue(request), { code: "ERR_IDEMPOTENCY_MISMATCH" });
    replacement.close();
    now = output.signedPermit.message.deadline_ms;
    assert.throws(() => batch.issue(request), { code: "ERR_LEASE_NOT_CURRENT" });
    now += 1;
    assert.throws(() => batch.issue(request), { code: "ERR_LEASE_NOT_CURRENT" });
    batch.close();
    assert.throws(() => batch.issue({}), { key: "ERR_PERMIT_INPUT_INVALID" });
    assert.throws(() => batch.signRevocation({}), { key: "ERR_PERMIT_INPUT_INVALID" });
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reservation conflict rolls back a newly acquired lease in the same transaction", {
  skip: Number(process.versions.node.split(".")[0]) < 24,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-atomic-test-"));
  const dbDir = path.join(root, "db");
  const anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir);
  fs.mkdirSync(anchorDir);
  let store;
  try {
    store = ProtectedPermitStore.initialize(path.join(dbDir, "state.sqlite"), {
      decisionId: "test-decision", anchorDir, anchorMode: "permissive", clock: () => 1000,
      verifyRecovery: () => true,
    });
    const batch = createPermitBatchSession({ store, clock: () => 1000 });
    try {
      const lease = { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker",
        runId: "run", generation: "1", desktopKey: "desktop", ownedAppId: "app",
        idempotencyKey: "first-lease", ttlMs: 5000 };
      const permit = { idempotencyKey: "permit", operation: "test", targetDigest: "a".repeat(64),
        paramsDigest: "b".repeat(64), ttlMs: 1000 };
      let reads = 0;
      const invalidClockBatch = createPermitBatchSession({ store, clock: () => (++reads === 1 ? 1000 : -1) });
      const initial = store.snapshot();
      assert.throws(() => invalidClockBatch.issue({ lease, permit }), { key: "ERR_CLOCK_INVALID" });
      assert.deepEqual(store.snapshot(), initial);
      invalidClockBatch.close();
      batch.issue({ lease, permit });
      store.release(store.snapshot().lease);
      store.recover({});
      const before = store.snapshot();
      assert.throws(() => batch.issue({ lease: { ...lease, idempotencyKey: "second-lease" }, permit }),
        { code: "ERR_IDEMPOTENCY_MISMATCH" });
      assert.deepEqual(store.snapshot(), before);
      assert.equal(store.snapshot().desktop.status, "free");
    } finally { batch.close(); }
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("issuance refuses forged signer output and rolls back the reservation", {
  skip: Number(process.versions.node.split(".")[0]) < 24,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-signer-test-"));
  const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  let store;
  try {
    store = ProtectedPermitStore.initialize(path.join(dbDir, "state.sqlite"), {
      decisionId: "test-decision", anchorDir, anchorMode: "permissive", clock: () => 1000,
    });
    const lease = { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker",
      runId: "run", generation: "1", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease", ttlMs: 5000 };
    const permit = { idempotencyKey: "permit", operation: "test", targetDigest: "a".repeat(64),
      paramsDigest: "b".repeat(64), ttlMs: 1000 };
    const key = delivery.createBatchKeyPair();
    const before = store.snapshot();
    assert.throws(() => store.acquireAndReserveBoundToBatch(lease, permit, key.fingerprint, (reserved) => {
      reserved.operation = "other";
      return { fingerprint: key.fingerprint, publicKeyPem: key.publicKeyPem,
        signedPermit: delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit: reserved,
          issuedAtMs: 1000 }) };
    }), { code: "ERR_INVALID_INPUT" });
    assert.deepEqual(store.snapshot(), before);
    for (const tamper of [
      (result) => { result.publicKeyPem += "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n"; },
      (result) => { result.signedPermit.signature += "-----BEGIN PRIVATE KEY-----secret"; },
      (result) => {
        const message = Object.assign([], result.signedPermit.message);
        const bytes = delivery.canonicalBytes(message);
        result.signedPermit.message = message;
        result.signedPermit.signature = key.privateKeyRef.sign(bytes).toString("base64");
        result.signedPermit.bytes = bytes.toString("base64");
      },
    ]) {
      assert.throws(() => store.acquireAndReserveBoundToBatch(lease, permit, key.fingerprint, (reserved) => {
        const result = { fingerprint: key.fingerprint, publicKeyPem: key.publicKeyPem,
          signedPermit: delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit: reserved,
            issuedAtMs: 1000 }) };
        tamper(result);
        return result;
      }), { code: "ERR_INVALID_INPUT" });
      assert.deepEqual(store.snapshot(), before);
    }
  } finally {
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
