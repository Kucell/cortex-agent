"use strict";

// ─── Issuing-Side Revocation End (M-053 / MS-008 第 9 环阶段 C) ──────────
//
// WHAT THIS FILE COVERS
//   The Mac-side issuing end of the revocation channel: the issuer's own
//   revocation record, the list it signs from that record, and the endpoint
//   that serves the list in the shape the target side consumes.
//
// WHAT THESE TESTS REFUSE TO CLAIM
//   Nothing here proves the channel works ACROSS MACHINES. The wire shape is
//   checked against the target side's own verifier (`applyRevocationList`),
//   which is the strongest statement available on a single host. The
//   cross-machine transport is a separate concern with its own ruling.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const { createPermitBatchSession } = require("../../lib/coordination/permit-batch-session");
const { createPermitAuthorityService } = require("../../lib/coordination/permit-authority-service");
const { createPermitBridgePolicy } = require("../../lib/coordination/permit-bridge-policy");
const { buildRevocationList } = require("../../lib/coordination/permit-bridge-endpoint");
const delivery = require("../../lib/coordination/permit-delivery");

const PEER = Object.freeze({
  sessionId: "session-1",
  pid: 4242,
  startToken: "win32:133000000000000000",
  commandDigest: "sha256:abc",
});

function openStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-revocation-issuing-"));
  const dbDir = path.join(root, "db");
  const anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir);
  fs.mkdirSync(anchorDir);
  const store = ProtectedPermitStore.initialize(path.join(dbDir, "state.sqlite"), {
    decisionId: "test-decision",
    anchorDir,
    anchorMode: "permissive",
    clock: () => 1_000_000,
  });
  return { root, store };
}

test("the issuer's revocation record starts empty and at sequence zero", () => {
  const { store } = openStore();
  try {
    const state = store.revocationState();
    assert.equal(state.appliedRevocationSequence, 0);
    assert.equal(state.revokedFingerprints.size, 0);
  } finally { store.close(); }
});

test("committing a revocation advances the sequence and records the fingerprint", () => {
  const { store } = openStore();
  try {
    const fingerprint = "a".repeat(64);
    const committed = store.commitRevocation({ revokedFingerprints: [fingerprint] });
    assert.equal(committed.appliedRevocationSequence, 1);
    assert.deepEqual(committed.revokedFingerprints, [fingerprint]);
    const state = store.revocationState();
    assert.equal(state.appliedRevocationSequence, 1);
    assert.equal(state.revokedFingerprints.has(fingerprint), true);
  } finally { store.close(); }
});

test("a revocation commit refuses a malformed fingerprint and a shrinking set", () => {
  const { store } = openStore();
  try {
    assert.throws(() => store.commitRevocation({ revokedFingerprints: ["not-a-fingerprint"] }),
      { code: "ERR_INVALID_INPUT" });
    assert.throws(() => store.commitRevocation({ revokedFingerprints: "a".repeat(64) }),
      { code: "ERR_INVALID_INPUT" });
    assert.throws(() => store.commitRevocation({ revokedFingerprints: ["a".repeat(64), "a".repeat(64)] }),
      { code: "ERR_INVALID_INPUT" });

    store.commitRevocation({ revokedFingerprints: ["a".repeat(64), "b".repeat(64)] });
    // Dropping a fingerprint that a previous list already revoked would
    // produce a list the target side refuses as non-monotonic, so the
    // commit refuses it here instead of publishing one that breaks the
    // chain.
    assert.throws(() => store.commitRevocation({ revokedFingerprints: ["a".repeat(64)] }),
      { code: "ERR_REVOCATION_SET_NOT_MONOTONIC" });
    // The refused commit must not have advanced anything.
    assert.equal(store.revocationState().appliedRevocationSequence, 1);
  } finally { store.close(); }
});

test("the revocation list is signed by a batch that is not the permit batch", () => {
  const { store } = openStore();
  const permitBatch = createPermitBatchSession({ store });
  const revocationBatch = createPermitBatchSession({ store });
  try {
    store.commitRevocation({ revokedFingerprints: ["a".repeat(64)] });
    const state = store.revocationState();
    const list = revocationBatch.signRevocation({
      state,
      fingerprints: [...state.revokedFingerprints],
    });
    // The list is signed by the REVOCATION batch, so the signer is not the
    // permit batch's key. That is what keeps a revocation of the permit
    // batch from deadlocking the chain.
    assert.equal(list.batch_public_key_fingerprint, revocationBatch.fingerprint);
    assert.notEqual(revocationBatch.fingerprint, permitBatch.fingerprint);
    assert.equal(list.revocation_sequence, 2);
    assert.equal(list.prev_revocation_sequence, 1);
  } finally {
    permitBatch.close();
    revocationBatch.close();
    store.close();
  }
});

test("the endpoint serves the list in the shape the target side consumes", () => {
  const { store } = openStore();
  const revocationBatch = createPermitBatchSession({ store });
  try {
    const revoked = "c".repeat(64);
    store.commitRevocation({ revokedFingerprints: [revoked] });
    const state = store.revocationState();
    const signed = revocationBatch.signRevocation({
      state,
      fingerprints: [...state.revokedFingerprints],
    });

    const response = buildRevocationList(signed);
    assert.ok(response, "the list must be buildable from the signed envelope");

    // The target side reads these fields OFF THE TOP LEVEL of the document.
    for (const field of ["revocation_sequence", "revoked_fingerprints", "issued_at_ms",
      "prev_revocation_sequence", "batch_public_key_fingerprint", "signature"]) {
      assert.ok(Object.hasOwn(response, field), `the response must carry ${field}`);
    }
    assert.equal(response.revocation_sequence, 2);
    assert.deepEqual(response.revoked_fingerprints, [revoked]);
  } finally {
    revocationBatch.close();
    store.close();
  }
});

test("the response body is accepted by the target side's own verifier", () => {
  const { store } = openStore();
  const revocationBatch = createPermitBatchSession({ store });
  try {
    const revoked = "e".repeat(64);
    store.commitRevocation({ revokedFingerprints: [revoked] });
    const state = store.revocationState();
    const signed = revocationBatch.signRevocation({
      state,
      fingerprints: [...state.revokedFingerprints],
    });
    const response = buildRevocationList(signed);

    // The target side verifies with the key from its PIN, never from the
    // list, so the test pins the revocation batch's own public key the way
    // the target's pin would.
    const publicKeyPem = revocationBatch.publicKeyPem;
    assert.equal(typeof publicKeyPem, "string");
    const pinned = new Set([delivery.publicKeyFingerprint(publicKeyPem)]);

    const targetState = { appliedRevocationSequence: 1, revokedFingerprints: new Set(),
      highestSeenRevocationSequence: 1 };
    const applied = delivery.applyRevocationList({
      state: targetState,
      list: {
        revocation_sequence: response.revocation_sequence,
        revoked_fingerprints: response.revoked_fingerprints,
        issued_at_ms: response.issued_at_ms,
        prev_revocation_sequence: response.prev_revocation_sequence,
        batch_public_key_fingerprint: response.batch_public_key_fingerprint,
        signature: response.signature,
      },
      publicKeyPem,
      pinnedFingerprints: pinned,
      nowMs: 1_000_000,
    });
    assert.equal(applied.appliedRevocationSequence, 2);
    assert.equal(targetState.revokedFingerprints.has(revoked), true);
  } finally {
    revocationBatch.close();
    store.close();
  }
});

test("the authority refuses a revocation-list request that carries fields", () => {
  const authorize = createPermitBridgePolicy({ actions: ["revocation-list"], peerIdentity: PEER });
  const authority = createPermitAuthorityService({
    authorize,
    batchSession: null,
    targetService: null,
    revocationBatchSession: { signRevocation: () => { throw new Error("must not be reached"); } },
    revocationStateSource: () => ({ appliedRevocationSequence: 0, revokedFingerprints: new Set() }),
  });
  // The list is derived from the issuer's own state, so a request that names
  // fingerprints would be a peer asking for a specific revocation — a
  // management action, not a read. It is refused.
  assert.throws(() => authority.dispatch(PEER, "revocation-list", { fingerprints: ["a".repeat(64)] }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the authority serves the list to a pinned peer with an empty request", () => {
  const { store } = openStore();
  const revocationBatch = createPermitBatchSession({ store });
  try {
    store.commitRevocation({ revokedFingerprints: ["a".repeat(64)] });
    const authorize = createPermitBridgePolicy({ actions: ["revocation-list"], peerIdentity: PEER });
    const authority = createPermitAuthorityService({
      authorize,
      batchSession: null,
      targetService: null,
      revocationBatchSession: revocationBatch,
      revocationStateSource: () => store.revocationState(),
    });
    const list = authority.dispatch(PEER, "revocation-list", {});
    assert.equal(list.revocation_sequence, 2);
    assert.deepEqual(list.revoked_fingerprints, ["a".repeat(64)]);
  } finally {
    revocationBatch.close();
    store.close();
  }
});
