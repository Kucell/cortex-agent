"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ProtectedPinStore, publicKeyFingerprint } = require("../../lib/coordination/protected-pin-store");
const anchorModule = require("../../lib/coordination/protected-anchor");
const delivery = require("../../lib/coordination/permit-delivery");
const bootstrap = require("../../lib/coordination/bootstrap-snapshot");
const cross = require("../../lib/coordination/cross-machine-permit");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms004-cross-"));
  const pinDir = path.join(dir, "pin");
  const snapshotDir = path.join(dir, "snapshot");
  fs.mkdirSync(pinDir, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  const store = ProtectedPinStore.open(pinDir, {
    decisionId: "D-test-cross",
    anchorMode: anchorModule.ANCHOR_MODE.permissive,
  });
  return {
    dir, pinDir, snapshotDir, store,
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function keyPair() {
  return delivery.createBatchKeyPair();
}

function batchIdentityFor(key, overrides = {}) {
  return Object.assign({
    decision_id: "D-test-cross",
    instance_id: "m044-instance",
    fingerprint: publicKeyFingerprint(key.publicKeyPem),
  }, overrides);
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error, "expected an error");
    assert.ok(error.key || error.code, "expected an error with a key, got " + error);
    return error.key || error.code;
  }
  return null;
}

function atomicCreate(target) {
  return (entry, fingerprint) => {
    try {
      const fd = fs.openSync(target, "wx", 0o600);
      fs.writeFileSync(fd, fingerprint);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error && error.code === "EEXIST") return false;
      throw error;
    }
  };
}

// A permit that verifies against the key the pin holds.
function signedPermit(key, overrides = {}) {
  const permit = Object.assign({
    permitId: "P-1",
    leaseId: "L-1",
    sessionId: "S-1",
    hostId: "H-1",
    workerId: "W-1",
    runId: "R-1",
    generation: 1,
    desktopKey: "D-1",
    ownedAppId: "A-1",
    serviceEpoch: 7,
    fencing: 11,
    operation: "op",
    targetDigest: "a".repeat(64),
    paramsDigest: "b".repeat(64),
    sequence: 1,
    deadline: 1_700_000_000_000,
  }, overrides);
  return delivery.buildSignedPermit({
    privateKeyRef: key.privateKeyRef,
    permit,
    issuedAtMs: 1_699_999_999_000,
  });
}

test("the registration stops when an exclusivity clause cannot be decided", () => {
  // Design section 2.2.2: a fact that cannot be decided is handled as NOT
  // satisfied. The target side decides, from its own state.
  const f = fixture();
  try {
    const key = keyPair();
    const result = codeOf(() => cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: undefined,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    }));
    assert.equal(result, "ERR_PIN_NOT_EXCLUSIVE");
    assert.equal(f.store.listPins().length, 0);
  } finally {
    f.cleanup();
  }
});

test("the registration stops when the target instance has a live process", () => {
  // Design counterexample 11: the target instance already has a process.
  const f = fixture();
  try {
    const key = keyPair();
    assert.equal(
      codeOf(() => cross.registerOnTarget({
        pinStore: f.store,
        batchIdentity: batchIdentityFor(key),
        publicKeyPem: key.publicKeyPem,
        targetHasProcess: true,
        targetHasPriorRun: false,
        nowMs: 1_000_000,
        write: atomicCreate(path.join(f.dir, "pin.marker")),
      })),
      "ERR_PIN_NOT_EXCLUSIVE",
    );
  } finally {
    f.cleanup();
  }
});

test("the registration succeeds and the receipt advances the snapshot in the same section", () => {
  const f = fixture();
  try {
    const key = keyPair();
    bootstrap.createSnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
      runId: "R-1",
      generation: 1,
      nowMs: 1_000_000,
    });
    const result = cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_001,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
      bootstrap: { snapshotDir: f.snapshotDir },
    });
    assert.equal(result.registered, true);
    assert.ok(result.receiptDigest);

    // The snapshot was advanced to "registered" WITH the receipt digest, in
    // the same critical section as the pin write.
    const snapshot = bootstrap.readSnapshot(f.snapshotDir);
    assert.equal(snapshot.snapshot_state, "registered");
    assert.equal(snapshot.registration_receipt_digest, result.receiptDigest);
  } finally {
    f.cleanup();
  }
});

test("the snapshot state only moves forward", () => {
  const f = fixture();
  try {
    const key = keyPair();
    bootstrap.createSnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
      nowMs: 1_000_000,
    });
    bootstrap.advanceSnapshot({
      snapshotDir: f.snapshotDir,
      nextState: "registered",
      receiptDigest: "d".repeat(64),
      nowMs: 1_000_001,
    });
    // Moving backwards is corruption and it stops the route.
    assert.equal(
      codeOf(() => bootstrap.advanceSnapshot({
        snapshotDir: f.snapshotDir,
        nextState: "created",
        nowMs: 1_000_002,
      })),
      "ERR_BOOTSTRAP_STATE_INVALID",
    );
    // Moving forward to the same state is idempotent.
    const again = bootstrap.advanceSnapshot({
      snapshotDir: f.snapshotDir,
      nextState: "registered",
      receiptDigest: "d".repeat(64),
      nowMs: 1_000_003,
    });
    assert.equal(again.snapshot_state, "registered");
  } finally {
    f.cleanup();
  }
});

test("a leftover registered snapshot the target can verify is a normal reconnect", () => {
  // Design section 2.2.3 R3-B3 ruling 2, item 1: the judgement is the
  // state PLUS whether the target can independently verify the pin. A
  // leftover snapshot alone does NOT stop the route.
  const f = fixture();
  try {
    const key = keyPair();
    bootstrap.createSnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
      nowMs: 1_000_000,
    });
    bootstrap.advanceSnapshot({
      snapshotDir: f.snapshotDir,
      nextState: "registered",
      receiptDigest: "d".repeat(64),
      nowMs: 1_000_001,
    });
    const verdict = bootstrap.classifySnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
      canVerifyPinOwnership: () => "ours",
    });
    assert.equal(verdict.classification, "normal-reconnect");
    assert.equal(verdict.reconnectAllowed, true);
  } finally {
    f.cleanup();
  }
});

test("a leftover registered snapshot the target CANNOT verify stops the route", () => {
  // The conservative default: without the verification capability, a
  // leftover registered snapshot stops the route.
  const f = fixture();
  try {
    const key = keyPair();
    bootstrap.createSnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
      nowMs: 1_000_000,
    });
    bootstrap.advanceSnapshot({
      snapshotDir: f.snapshotDir,
      nextState: "registered",
      receiptDigest: "d".repeat(64),
      nowMs: 1_000_001,
    });

    const withoutCapability = bootstrap.classifySnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
    });
    assert.equal(withoutCapability.classification, "unverifiable");
    assert.equal(withoutCapability.reconnectAllowed, false);

    const withForeignPin = bootstrap.classifySnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
      canVerifyPinOwnership: () => "foreign",
    });
    assert.equal(withForeignPin.classification, "residue-or-replaced");
    assert.equal(withForeignPin.reconnectAllowed, false);
  } finally {
    f.cleanup();
  }
});

test("a snapshot from a different batch stops the route and is not cleaned up", () => {
  const f = fixture();
  try {
    const key = keyPair();
    bootstrap.createSnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key),
      nowMs: 1_000_000,
    });
    const verdict = bootstrap.classifySnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: batchIdentityFor(key, { instance_id: "other-instance" }),
      canVerifyPinOwnership: () => "ours",
    });
    assert.equal(verdict.classification, "foreign-batch");
    assert.equal(verdict.reconnectAllowed, false);
    // The snapshot is still there -- a foreign snapshot is not cleaned up.
    assert.ok(bootstrap.readSnapshot(f.snapshotDir));
  } finally {
    f.cleanup();
  }
});

test("the verification key comes from the pin and from nowhere else", () => {
  // Design section 2.3.1 R3-B2 ruling 2: the verifier trusts ONLY the key
  // in the pin.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    // Not registered yet: there is no key to retrieve.
    assert.equal(
      codeOf(() => cross.retrieveVerificationKey({ pinStore: f.store, fingerprint: identity.fingerprint })),
      "ERR_REVOCATION_SIGNER_INVALID",
    );
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    const retrieved = cross.retrieveVerificationKey({
      pinStore: f.store,
      fingerprint: identity.fingerprint,
    });
    assert.equal(retrieved.publicKeyPem, key.publicKeyPem);
  } finally {
    f.cleanup();
  }
});

test("a revoked signing key may not authorize a permit", () => {
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    const signed = signedPermit(key);
    // Before the revocation the permit verifies.
    const before = cross.verifyWithPinnedKey({
      pinStore: f.store,
      fingerprint: identity.fingerprint,
      message: signed.message,
      signature: signed.signature,
      nowMs: 1_699_999_999_500,
    });
    assert.equal(before.ok, true);

    f.store.commitRevocation({ sequence: 1, revokedFingerprints: [identity.fingerprint] });
    assert.equal(
      codeOf(() => cross.verifyWithPinnedKey({
        pinStore: f.store,
        fingerprint: identity.fingerprint,
        message: signed.message,
        signature: signed.signature,
        nowMs: 1_699_999_999_500,
      })),
      "ERR_REVOCATION_SIGNER_INVALID",
    );
  } finally {
    f.cleanup();
  }
});

// A revocation list signed by the batch key. The list carries the
// signature over the canonical encoding of its own fields, which is what
// step 1's applyRevocationList verifies.
function revocationList(key, options = {}) {
  const sequence = options.sequence === undefined ? 1 : options.sequence;
  const fingerprints = options.fingerprints || [];
  const message = {
    revocation_sequence: sequence,
    revoked_fingerprints: fingerprints.slice().sort(),
    issued_at_ms: options.issuedAtMs === undefined ? 1_000_000 : options.issuedAtMs,
    prev_revocation_sequence: options.prevSequence === undefined ? sequence - 1 : options.prevSequence,
    batch_public_key_fingerprint: options.signerFingerprint || key.fingerprint,
  };
  const bytes = delivery.canonicalBytes(message);
  const signature = key.privateKeyRef.sign(bytes).toString("base64");
  return Object.assign({}, message, { signature });
}

test("a revocation list signed by a pinned key is applied", () => {
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    const other = "d".repeat(64);
    const list = revocationList(key, { sequence: 1, fingerprints: [other] });
    const applied = cross.pullAndApplyRevocation({
      pinStore: f.store,
      pull: () => list,
      nowMs: 1_000_001,
    });
    assert.equal(applied.appliedRevocationSequence, 1);
    const state = f.store.revocationState();
    assert.equal(state.revokedFingerprints.has(other), true);
    assert.equal(state.appliedRevocationSequence, 1);
  } finally {
    f.cleanup();
  }
});

test("a revocation list signed by a key that is NOT in the pin is refused", () => {
  // Design section 2.3.1 R3-B2 ruling 2: the verifier trusts only the key
  // in the pin. A list that carries its own key is refused.
  const f = fixture();
  try {
    const key = keyPair();
    const stranger = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    // The stranger's key is not in the pin, so there is nothing to verify
    // the list against.
    const list = revocationList(stranger, {
      sequence: 1,
      fingerprints: ["e".repeat(64)],
      signerFingerprint: stranger.fingerprint,
    });
    assert.equal(
      codeOf(() => cross.pullAndApplyRevocation({
        pinStore: f.store,
        pull: () => list,
        nowMs: 1_000_001,
      })),
      "ERR_REVOCATION_SIGNER_INVALID",
    );
    // Nothing advanced.
    assert.equal(f.store.revocationState().appliedRevocationSequence, 0);
  } finally {
    f.cleanup();
  }
});

test("a TRUNCATED revocation list is refused and does not advance the chain", () => {
  // Design counterexample 26: a list that drops revoked fingerprints is
  // refused by the chain check, and the high-water mark does not move.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    cross.pullAndApplyRevocation({
      pinStore: f.store,
      pull: () => revocationList(key, { sequence: 1, fingerprints: [a, b] }),
      nowMs: 1_000_001,
    });
    // The next list drops b. The local set only grows, so it is refused.
    assert.equal(
      codeOf(() => cross.pullAndApplyRevocation({
        pinStore: f.store,
        pull: () => revocationList(key, { sequence: 2, fingerprints: [a] }),
        nowMs: 1_000_002,
      })),
      "ERR_REVOCATION_SET_NOT_MONOTONIC",
    );
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 1);
    assert.equal(state.revokedFingerprints.size, 2);
  } finally {
    f.cleanup();
  }
});

test("a revocation list with a broken chain is refused", () => {
  // Design counterexample 25: a replaced list at the same sequence is
  // refused by the signature, and a list at the wrong sequence is refused
  // by the chain.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    // The first list skips sequence 1 and starts at 2.
    assert.equal(
      codeOf(() => cross.pullAndApplyRevocation({
        pinStore: f.store,
        pull: () => revocationList(key, {
          sequence: 2,
          fingerprints: ["a".repeat(64)],
          prevSequence: 1,
        }),
        nowMs: 1_000_001,
      })),
      "ERR_REVOCATION_SEQUENCE_BROKEN",
    );
    assert.equal(f.store.revocationState().appliedRevocationSequence, 0);
  } finally {
    f.cleanup();
  }
});

test("a revocation list signed by an ALREADY REVOKED key is refused", () => {
  // Design section 2.3.1 R4-B4 ruling 3: the signer of a list must still
  // be valid. A revoked key cannot authorize the list that would un-revoke
  // it.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    // The batch revokes itself. This is path A in the design and it does
    // not deadlock: the key is not yet revoked when the list is applied.
    cross.pullAndApplyRevocation({
      pinStore: f.store,
      pull: () => revocationList(key, { sequence: 1, fingerprints: [key.fingerprint] }),
      nowMs: 1_000_001,
    });
    assert.equal(f.store.revocationState().revokedFingerprints.has(key.fingerprint), true);

    // Now the revoked key signs another list. It is refused, and the
    // high-water mark does not move.
    assert.equal(
      codeOf(() => cross.pullAndApplyRevocation({
        pinStore: f.store,
        pull: () => revocationList(key, {
          sequence: 2,
          fingerprints: [key.fingerprint, "f".repeat(64)],
        }),
        nowMs: 1_000_002,
      })),
      "ERR_REVOCATION_SIGNER_INVALID",
    );
    assert.equal(f.store.revocationState().appliedRevocationSequence, 1);
  } finally {
    f.cleanup();
  }
});

test("a failed pull refuses the verification instead of using the last list", () => {
  // Design section 2.3.1: when the channel is unavailable the pull fails,
  // and this verification is refused. The previously pulled list must not
  // be used to keep accepting.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    cross.pullAndApplyRevocation({
      pinStore: f.store,
      pull: () => revocationList(key, { sequence: 1, fingerprints: ["a".repeat(64)] }),
      nowMs: 1_000_001,
    });
    // The channel goes down.
    assert.equal(
      codeOf(() => cross.pullAndApplyRevocation({
        pinStore: f.store,
        pull: () => { throw new Error("channel unavailable"); },
        nowMs: 1_000_002,
      })),
      "ERR_REVOCATION_PULL_FAILED",
    );
    // The state did not change: the last list is still the applied one,
    // and nothing was accepted on its basis.
    assert.equal(f.store.revocationState().appliedRevocationSequence, 1);
  } finally {
    f.cleanup();
  }
});

// The three blocking items from the independent review, covered by the
// product's own suite so that a future change cannot quietly reopen them.

test("a pin from a DIFFERENT batch is refused with ERR_PIN_BATCH_MISMATCH", () => {
  // Review blocking item B3: the batch comparison has to be reachable.
  // While the exclusivity clauses were asked first, every existing pin was
  // a plain ERR_PIN_NOT_EXCLUSIVE, so the specific "not your pin" refusal
  // never happened and a reconnect could not be told apart from a takeover.
  const f = fixture();
  try {
    const key = keyPair();
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });

    assert.equal(
      codeOf(() => cross.registerOnTarget({
        pinStore: f.store,
        // The same fingerprint, a different instance: a different batch.
        batchIdentity: batchIdentityFor(key, { instance_id: "other-instance" }),
        publicKeyPem: key.publicKeyPem,
        targetHasProcess: false,
        targetHasPriorRun: false,
        nowMs: 1_000_001,
        write: atomicCreate(path.join(f.dir, "pin.marker")),
      })),
      "ERR_PIN_BATCH_MISMATCH",
    );
    // The original pin is untouched.
    assert.equal(f.store.listPins().length, 1);
  } finally {
    f.cleanup();
  }
});

test("the same batch triple WITHOUT a bootstrap snapshot is refused", () => {
  // Review blocking item B3, second half: the identical triple alone does
  // not make a reconnect. Two competitors of the same batch reach this
  // point too, and the loser of that race must not be told it succeeded.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    assert.equal(
      codeOf(() => cross.registerOnTarget({
        pinStore: f.store,
        batchIdentity: identity,
        publicKeyPem: key.publicKeyPem,
        targetHasProcess: false,
        targetHasPriorRun: false,
        nowMs: 1_000_001,
        write: atomicCreate(path.join(f.dir, "pin.marker")),
      })),
      "ERR_PIN_NOT_EXCLUSIVE",
    );
  } finally {
    f.cleanup();
  }
});

test("the same batch triple WITH a bootstrap snapshot reuses the pin", () => {
  // The negative control for the case above: with the snapshot as the
  // evidence the design asks for, the reconnect succeeds and the pin is
  // reused rather than rewritten.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    bootstrap.createSnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: identity,
      nowMs: 1_000_000,
    });
    // The first registration writes the pin and advances the snapshot to
    // "registered" inside the same critical section.
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      bootstrap: { snapshotDir: f.snapshotDir },
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_002,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    // The snapshot is still on disk, in the "registered" state, and the
    // target can independently verify that the pin is ours. That is the
    // normal reconnect the design describes.
    const verdict = bootstrap.classifySnapshot({
      snapshotDir: f.snapshotDir,
      batchIdentity: identity,
      canVerifyPinOwnership: () => "ours",
    });
    assert.equal(verdict.classification, "normal-reconnect");
    const again = cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      bootstrap: { snapshotDir: f.snapshotDir },
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_003,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    assert.equal(again.reused, true);
    assert.equal(f.store.listPins().length, 1);
  } finally {
    f.cleanup();
  }
});

test("a clock-poisoned domain refuses the retrieval, the pull and the verification", () => {
  // Review blocking item B2: the poisoning marker had no reader anywhere in
  // the tree, so poisoning a domain changed nothing and the domain kept
  // authorising.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    f.store.setClockPoisoned(true);

    assert.equal(
      codeOf(() => cross.retrieveVerificationKey({ pinStore: f.store, fingerprint: identity.fingerprint })),
      "ERR_CLOCK_INVALID",
    );
    assert.equal(
      codeOf(() => cross.pullAndApplyRevocation({
        pinStore: f.store,
        pull: () => revocationList(key, { sequence: 1, fingerprints: ["a".repeat(64)] }),
        nowMs: 1_000_001,
      })),
      "ERR_CLOCK_INVALID",
    );
    assert.equal(
      codeOf(() => cross.verifyWithPinnedKey({
        pinStore: f.store,
        fingerprint: identity.fingerprint,
        message: "m",
        signature: "s",
        expectedDeadlineMs: 1_700_000_000_000,
        nowMs: 1_000_002,
      })),
      "ERR_CLOCK_INVALID",
    );
  } finally {
    f.cleanup();
  }
});

test("a domain that was never poisoned still authorises", () => {
  // The negative control for the poisoning case: the poisoning check must
  // not refuse a domain that is fine.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    cross.registerOnTarget({
      pinStore: f.store,
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      targetHasProcess: false,
      targetHasPriorRun: false,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    assert.equal(f.store.isClockPoisoned(), false);
    const retrieved = cross.retrieveVerificationKey({
      pinStore: f.store,
      fingerprint: identity.fingerprint,
    });
    assert.equal(retrieved.fingerprint, identity.fingerprint);
  } finally {
    f.cleanup();
  }
});
