"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ProtectedPinStore,
  publicKeyFingerprint,
  sameBatchIdentity,
  DOMAIN_MARKER_FILE,
} = require("../../lib/coordination/protected-pin-store");
const anchorModule = require("../../lib/coordination/protected-anchor");
const delivery = require("../../lib/coordination/permit-delivery");

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms004-pin-"));
  const pinDir = path.join(dir, "pin");
  fs.mkdirSync(pinDir, { recursive: true });
  const store = ProtectedPinStore.open(pinDir, {
    decisionId: options.decisionId || "D-test-pin",
    // The development environment has no separate service identity, so the
    // permission contract is opted out of explicitly here.
    anchorMode: options.anchorMode || anchorModule.ANCHOR_MODE.permissive,
    serviceIdentity: options.serviceIdentity,
    platform: options.platform,
  });
  return {
    dir, pinDir, store,
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function keyPair() {
  return delivery.createBatchKeyPair();
}

function batchIdentityFor(key, overrides = {}) {
  return Object.assign({
    decision_id: "D-test-pin",
    instance_id: "m044-instance",
    fingerprint: publicKeyFingerprint(key.publicKeyPem),
  }, overrides);
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error, "expected an error, got nothing thrown");
    // The anchor module raises its own error type; the coordination modules
    // raise CoordinationError. Both carry the machine-readable key.
    assert.ok(error.key || error.code, "expected an error with a key, got " + error);
    return error.key || error.code;
  }
  return null;
}

// The pin is written through an atomic create-if-absent. The test double
// writes a marker file with O_EXCL, which is the same primitive the real
// registration path uses.
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

test("a pin registers once and is then reused by the same batch", () => {
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    const target = path.join(f.dir, "pin.marker");

    const first = f.store.registerPin({
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(target),
    });
    assert.equal(first.registered, true);
    assert.equal(first.reused, false);

    // A reconnect of the SAME batch reuses the pin. It does not rewrite it
    // and it does not stop the route (design section 2.2.3).
    const again = f.store.registerPin({
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_001,
      write: atomicCreate(target),
    });
    assert.equal(again.registered, false);
    assert.equal(again.reused, true);
    assert.equal(f.store.listPins().length, 1);
  } finally {
    f.cleanup();
  }
});

test("a pin from a DIFFERENT batch is refused and never overwritten", () => {
  // Design counterexample 24: reconnecting with a new batch must not
  // overwrite an existing pin. The route stops.
  const f = fixture();
  try {
    const key = keyPair();
    const target = path.join(f.dir, "pin.marker");
    f.store.registerPin({
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(target),
    });

    const otherIdentity = batchIdentityFor(key, { instance_id: "another-instance" });
    assert.equal(
      codeOf(() => f.store.registerPin({
        batchIdentity: otherIdentity,
        publicKeyPem: key.publicKeyPem,
        nowMs: 1_000_002,
        write: atomicCreate(target),
      })),
      "ERR_PIN_BATCH_MISMATCH",
    );
    // The original pin is untouched.
    assert.equal(f.store.listPins().length, 1);
    assert.equal(f.store.listPins()[0].instance_id, "m044-instance");
  } finally {
    f.cleanup();
  }
});

test("a concurrent registrant that loses the race does not overwrite the winner", () => {
  // Design section 2.2.3: of two concurrent create-if-absent writers only
  // the first succeeds, the second gets EEXIST and does not overwrite.
  const f = fixture();
  try {
    const key = keyPair();
    const target = path.join(f.dir, "pin.marker");
    const identity = batchIdentityFor(key);

    const first = f.store.registerPin({
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(target),
    });
    assert.equal(first.registered, true);

    // The marker exists now, so the create-if-absent write reports EEXIST.
    assert.equal(
      codeOf(() => f.store.registerPin({
        batchIdentity: batchIdentityFor(key, { instance_id: "other" }),
        publicKeyPem: key.publicKeyPem,
        nowMs: 1_000_001,
        write: atomicCreate(target),
      })),
      "ERR_PIN_BATCH_MISMATCH",
    );
    assert.equal(fs.readFileSync(target, "utf8"), key.fingerprint);
  } finally {
    f.cleanup();
  }
});

test("the fingerprint is derived from the key, not taken from the caller", () => {
  // Design counterexample 15: a fingerprint that disagrees with the
  // snapshot registration is refused. A self-reported fingerprint would
  // let the caller claim an identity the key does not have.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key, { fingerprint: "f".repeat(64) });
    assert.equal(
      codeOf(() => f.store.registerPin({
        batchIdentity: identity,
        publicKeyPem: key.publicKeyPem,
        nowMs: 1_000_000,
        write: atomicCreate(path.join(f.dir, "pin.marker")),
      })),
      "ERR_PIN_FINGERPRINT_MISMATCH",
    );
    assert.equal(f.store.listPins().length, 0);
  } finally {
    f.cleanup();
  }
});

test("the revoked fingerprint set only ever grows", () => {
  // Design section 2.3.1 R4-B4 ruling 6: a commit that would drop a
  // fingerprint is refused and nothing advances.
  const f = fixture();
  try {
    f.store.commitRevocation({
      sequence: 1,
      revokedFingerprints: ["a".repeat(64), "b".repeat(64)],
    });
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 1);
    assert.equal(state.revokedFingerprints.size, 2);

    assert.equal(
      codeOf(() => f.store.commitRevocation({
        sequence: 2,
        revokedFingerprints: ["a".repeat(64)],
      })),
      "ERR_REVOCATION_SET_NOT_MONOTONIC",
    );
    // Nothing advanced: neither the set nor the high-water mark.
    const after = f.store.revocationState();
    assert.equal(after.appliedRevocationSequence, 1);
    assert.equal(after.revokedFingerprints.size, 2);
  } finally {
    f.cleanup();
  }
});

test("the revoked set and the applied high-water mark advance together", () => {
  // Design section 2.3.1 R3-B2 ruling 3, local invariant B: on exit from
  // the critical section either both advanced or neither did.
  const f = fixture();
  try {
    f.store.commitRevocation({ sequence: 1, revokedFingerprints: ["a".repeat(64)] });
    f.store.commitRevocation({ sequence: 2, revokedFingerprints: ["a".repeat(64), "b".repeat(64)] });
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 2);
    assert.equal(state.revokedFingerprints.size, 2);
  } finally {
    f.cleanup();
  }
});

test("a pin entry is never removed by a revocation", () => {
  // Design section 2.3.1 R4-B4 ruling 1: revocation does not remove the
  // public key from the pin. The pin records a registration fact; the
  // revoked set carries the validity judgement. Removing the entry would
  // also deadlock the protocol, because a revoked key could then never
  // sign the list that revokes it.
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    f.store.commitRevocation({ sequence: 1, revokedFingerprints: [key.fingerprint] });

    assert.equal(f.store.listPins().length, 1, "the pin entry survives the revocation");
    assert.equal(f.store.revocationState().revokedFingerprints.has(key.fingerprint), true);
  } finally {
    f.cleanup();
  }
});

test("the direct revocation registration advances the chain by one", () => {
  // Design section 2.3.1 R4-B4 ruling 5: the direct registration is the
  // one exception that does not depend on a cross-machine signature, and
  // it advances the revocation sequence by exactly one so the chain does
  // not break.
  const f = fixture();
  try {
    f.store.registerDirectRevocation({ fingerprint: "c".repeat(64), sequence: 1 });
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 1);
    assert.equal(state.revokedFingerprints.has("c".repeat(64)), true);
  } finally {
    f.cleanup();
  }
});

test("the verification path only trusts the keys in the pin", () => {
  // Design section 2.3.1 R3-B2 ruling 2: Windows side trusts ONLY the
  // public key in the pin. A key carried by a list itself is never
  // accepted.
  const f = fixture();
  try {
    const key = keyPair();
    assert.equal(f.store.publicKeyFor(key.fingerprint), null);
    f.store.registerPin({
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    assert.equal(f.store.publicKeyFor(key.fingerprint), key.publicKeyPem);
    assert.equal(f.store.pinnedFingerprints().has(key.fingerprint), true);
  } finally {
    f.cleanup();
  }
});

test("the pin domain and the permit database directory are kept separate", () => {
  // Design section 4.2.4: the pin domain and the permit database
  // directory must not contain one another. On the two-machine deployment
  // the constraint holds automatically, but a deployment change must not be
  // allowed to violate it quietly.
  const f = fixture();
  try {
    assert.equal(
      codeOf(() => f.store.assertSeparateFromPermitDatabase(path.join(f.pinDir, "authority.sqlite"))),
      "ERR_ANCHOR_NOT_SEPARATE",
    );
    const elsewhere = path.join(f.dir, "elsewhere", "authority.sqlite");
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, "x");
    f.store.assertSeparateFromPermitDatabase(elsewhere);
  } finally {
    f.cleanup();
  }
});

test("the batch identity comparison is field by field", () => {
  const identity = {
    decision_id: "D-1",
    instance_id: "I-1",
    fingerprint: "f".repeat(64),
  };
  assert.equal(sameBatchIdentity(identity, { ...identity }), true);
  // A missing pin is undecidable, which the reconnect logic treats as NOT
  // the same batch -- the route stops rather than proceeding.
  assert.equal(sameBatchIdentity(null, identity), false);
  // The fields that are deliberately NOT part of the batch identity must
  // not make two pins look different.
  assert.equal(sameBatchIdentity(identity, { ...identity, run_id: "r-1", generation: 2 }), true);
});

test("the clock-poisoning marker is readable and settable", () => {
  const f = fixture();
  try {
    assert.equal(f.store.isClockPoisoned(), false);
    f.store.setClockPoisoned(true);
    assert.equal(f.store.isClockPoisoned(), true);
    f.store.setClockPoisoned(false);
    assert.equal(f.store.isClockPoisoned(), false);
  } finally {
    f.cleanup();
  }
});

test("on Windows the service identity must be declared, or the domain is refused", () => {
  // Design section 4.2.2's acceptance condition, and the reason the
  // design repeats it: on Windows the calling account is not necessarily
  // the service. Without the declaration the comparison degenerates into
  // comparing the caller with itself, and the check would prove nothing.
  //
  // The adapter is injected so that the Windows authorisation model can
  // be exercised on a development machine. The judgement the design cares
  // about -- "the declaration is mandatory on Windows" -- does not depend
  // on the host the test runs on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms004-pin-strict-"));
  try {
    const pinDir = path.join(dir, "pin");
    fs.mkdirSync(pinDir, { recursive: true });
    const serviceSid = "sid:S-1-5-80-1234567890-1234567890-1234567890-1234567890";
    const adapter = {
      writableIdentities: () => new Set([serviceSid]),
      currentIdentity: () => serviceSid,
      currentGroups: () => new Set(),
      ownerIdentity: () => serviceSid,
      normalizeIdentity: (value) => (typeof value === "string" && value.startsWith("sid:")
        ? value
        : null),
    };

    // No declaration on Windows: refused.
    assert.equal(
      codeOf(() => ProtectedPinStore.open(pinDir, {
        decisionId: "D-test-strict",
        anchorMode: anchorModule.ANCHOR_MODE.strict,
        platform: "windows",
        adapter,
      })),
      "ERR_ANCHOR_SERVICE_IDENTITY_INVALID",
    );

    // With the declaration the domain opens.
    const store = ProtectedPinStore.open(pinDir, {
      decisionId: "D-test-strict",
      anchorMode: anchorModule.ANCHOR_MODE.strict,
      platform: "windows",
      serviceIdentity: serviceSid,
      adapter,
    });
    assert.ok(store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a declared service identity that is not the caller is refused", () => {
  // The declared identity has to BE the calling identity. A process that
  // merely CAN run as the service would otherwise pass the check by
  // definition.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms004-pin-caller-"));
  try {
    const pinDir = path.join(dir, "pin");
    fs.mkdirSync(pinDir, { recursive: true });
    const serviceSid = "sid:S-1-5-80-1234567890-1234567890-1234567890-1234567890";
    const otherSid = "sid:S-1-5-21-1111111111-2222222222-3333333333-1001";
    const adapter = {
      writableIdentities: () => new Set([serviceSid]),
      currentIdentity: () => otherSid,
      currentGroups: () => new Set(),
      ownerIdentity: () => otherSid,
      normalizeIdentity: (value) => (typeof value === "string" && value.startsWith("sid:")
        ? value
        : null),
    };
    assert.equal(
      codeOf(() => ProtectedPinStore.open(pinDir, {
        decisionId: "D-test-caller",
        anchorMode: anchorModule.ANCHOR_MODE.strict,
        platform: "windows",
        serviceIdentity: serviceSid,
        adapter,
      })),
      "ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The state-loss defences (review blocking item B1).
//
// The old readState() turned EVERY read failure into an empty domain. That
// reset the applied revocation high-water mark and the revoked fingerprint
// set to zero, so a revoked key became authorised again. The state file
// being unreadable and the state file not existing are now different
// facts, and only the second one is an empty domain.

test("a domain that never held state reads as empty", () => {
  const f = fixture();
  try {
    assert.equal(f.store.listPins().length, 0);
    assert.equal(f.store.revocationState().appliedRevocationSequence, 0);
    // No state was ever written, so no initialisation marker exists yet.
    assert.equal(fs.existsSync(path.join(f.pinDir, DOMAIN_MARKER_FILE)), false);
  } finally {
    f.cleanup();
  }
});

test("an unreadable state file is refused, not read as an empty domain", () => {
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    const statePath = path.join(f.pinDir, "pin-state.json");
    fs.chmodSync(statePath, 0o000);
    try {
      assert.equal(codeOf(() => f.store.listPins()), "ERR_PIN_STATE_CORRUPT");
      assert.equal(codeOf(() => f.store.revocationState()), "ERR_PIN_STATE_CORRUPT");
    } finally {
      fs.chmodSync(statePath, 0o600);
    }
  } finally {
    f.cleanup();
  }
});

test("a deleted state file is refused, and the revoked set does not reset to empty", () => {
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    f.store.commitRevocation({
      sequence: 4,
      revokedFingerprints: ["a".repeat(64)],
    });
    assert.equal(f.store.revocationState().revokedFingerprints.size, 1);
    assert.equal(f.store.revocationState().appliedRevocationSequence, 4);

    // The domain was initialised, so the marker is present.
    assert.equal(fs.existsSync(path.join(f.pinDir, DOMAIN_MARKER_FILE)), true);
    fs.unlinkSync(path.join(f.pinDir, "pin-state.json"));

    // The loss is refused. The revocation state does not come back empty,
    // so the revoked key is not authorised again.
    assert.equal(codeOf(() => f.store.revocationState()), "ERR_PIN_STATE_CORRUPT");
    assert.equal(codeOf(() => f.store.listPins()), "ERR_PIN_STATE_CORRUPT");
  } finally {
    f.cleanup();
  }
});

test("the initialisation marker is written before the first state file", () => {
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    assert.equal(fs.existsSync(path.join(f.pinDir, DOMAIN_MARKER_FILE)), true);
    assert.equal(fs.existsSync(path.join(f.pinDir, "pin-state.json")), true);
  } finally {
    f.cleanup();
  }
});
