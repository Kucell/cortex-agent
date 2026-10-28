"use strict";

// Tests for the cross-machine permit delivery core (M-044 / MS-004 step 1).
//
// The step covers the local signing half of the channel: a per-batch Ed25519
// key pair, a permit signed over every field consume() binds, the verifier,
// the sequence high-water mark and the local transaction boundary of the
// revocation bookkeeping. The pin store and the cross-machine key retrieval
// path are step 2 and step 3 and are NOT covered here.
//
// The tests below pin the contracts that a later change could silently
// break:
//
//   (a) the signature covers every field consume() binds -- asserted against
//       the live binding set exported by the store, not a hand-written list;
//   (b) both sides produce byte-identical canonical bytes;
//   (c) the signed deadline is the permit's own deadline, byte for byte,
//       including for a short lease;
//   (d) a broken, truncated or replaced revocation list is refused;
//   (e) the revoked set only grows;
//   (f) the private key is not reachable through any export path;
//   (g) the read-only check and the atomic registration are distinct.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const delivery = require("../../lib/coordination/permit-delivery");
const { CoordinationError } = require("../../lib/coordination/errors");
const {
  CONSUME_BINDING_FIELDS,
  ProtectedPermitStore,
} = require("../../lib/coordination/protected-permit-store");
const anchorModule = require("../../lib/coordination/protected-anchor");

function samplePermit(overrides) {
  return {
    permitId: "P-PERMIT-7",
    leaseId: "P-LEASE-1",
    sessionId: "sess-1",
    hostId: "host-a",
    workerId: "worker-a",
    runId: "run-1",
    generation: 3,
    desktopKey: "desktop-1",
    ownedAppId: "app-1",
    serviceEpoch: 2,
    fencing: 5,
    operation: "desktop.screenshot",
    targetDigest: "a".repeat(64),
    paramsDigest: "b".repeat(64),
    sequence: 7,
    deadline: 1_700_000_000_000,
    ...(overrides || {}),
  };
}

function sign(permit, keyPair, issuedAtMs) {
  return delivery.buildSignedPermit({
    privateKeyRef: keyPair.privateKeyRef,
    permit,
    issuedAtMs: issuedAtMs === undefined ? permit.deadline - 1000 : issuedAtMs,
  });
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CoordinationError, "expected a CoordinationError, got " + error);
    return error.key;
  }
  return null;
}

test("the signed message covers every field consume() binds", () => {
  const keyPair = delivery.createBatchKeyPair();
  const signed = sign(samplePermit(), keyPair);
  const covered = new Set(Object.keys(signed.message));
  // The baseline is the live binding set of the store. If consume() gains or
  // loses a field, this assertion turns red without anyone editing a list.
  assert.equal(CONSUME_BINDING_FIELDS.length, 14);
  for (const storage of CONSUME_BINDING_FIELDS) {
    const signedName = delivery.STORAGE_TO_SIGNED[storage];
    assert.ok(signedName, "the storage field " + storage + " has no signed counterpart");
    assert.ok(covered.has(signedName), "the binding field " + storage + " is not covered by the signature");
  }
  for (const name of delivery.ADDITIONAL_SIGNED_FIELDS) {
    assert.ok(covered.has(name), "the additional field " + name + " is not covered by the signature");
  }
});

test("the exported binding fields are the store's live set, not a local copy", () => {
  // The export has to answer the question that is being asked RIGHT NOW.
  // A snapshot taken when the module was loaded would answer the question
  // that was true at load time, and a consume() that gained a field since
  // then would be invisible to it -- silently, because the snapshot would
  // still agree with itself.
  const exported = delivery.consumeBindingFields().map((entry) => entry.storage);
  assert.deepEqual(exported, CONSUME_BINDING_FIELDS.slice());
  // Every live field has a signed spelling, and every exported entry names
  // one -- otherwise the export would hand a caller a field the signature
  // cannot cover.
  for (const entry of delivery.consumeBindingFields()) {
    assert.ok(entry.signed, "the live field " + entry.storage + " has no signed counterpart");
  }
});

test("a message that drops a binding field is refused", () => {
  const keyPair = delivery.createBatchKeyPair();
  const signed = sign(samplePermit(), keyPair);
  for (const storage of CONSUME_BINDING_FIELDS) {
    const signedName = delivery.STORAGE_TO_SIGNED[storage];
    const message = { ...signed.message };
    delete message[signedName];
    assert.equal(
      codeOf(() => delivery.verifyPermitSignature({
        message,
        signature: signed.signature,
        publicKeyPem: keyPair.publicKeyPem,
      })),
      "ERR_PERMIT_BINDING_UNCOVERED",
      "dropping " + storage + " must be refused",
    );
  }
});

test("the verifier rejects a message whose signed field was swapped", () => {
  const keyPair = delivery.createBatchKeyPair();
  const signed = sign(samplePermit(), keyPair);
  const tampered = { ...signed.message, lease_id: "P-LEASE-OTHER" };
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: tampered,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
    })),
    "ERR_PERMIT_SIGNATURE_INVALID",
  );
});

test("a permit signed by another batch key does not verify", () => {
  const signer = delivery.createBatchKeyPair();
  const other = delivery.createBatchKeyPair();
  const signed = sign(samplePermit(), signer);
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: other.publicKeyPem,
    })),
    "ERR_PERMIT_SIGNATURE_INVALID",
  );
});

test("both sides produce byte-identical canonical bytes", () => {
  // Two independent objects with the same content in a different insertion
  // order must produce the same bytes, and the verifier must accept the
  // bytes the signer produced -- not a re-serialization of the message.
  const keyPair = delivery.createBatchKeyPair();
  const permit = samplePermit();
  const signed = sign(permit, keyPair);
  const reordered = {};
  for (const key of Object.keys(signed.message).reverse()) reordered[key] = signed.message[key];
  assert.equal(
    delivery.canonicalBytes(reordered).toString("base64"),
    delivery.canonicalBytes(signed.message).toString("base64"),
  );
  assert.equal(delivery.canonicalBytes(signed.message).toString("base64"), signed.bytes);
  const verified = delivery.verifyPermitSignature({
    message: reordered,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    nowMs: permit.deadline - 1,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.bytes, signed.bytes);
});

test("the canonical form sorts keys and carries no whitespace", () => {
  const canonical = delivery.canonicalize({ b: 1, a: 2 });
  assert.equal(canonical, '{"a":2,"b":1}');
  assert.equal(delivery.canonicalize({ a: 1, b: 2 }), delivery.canonicalize({ b: 2, a: 1 }));
  // The key order follows the UTF-16 code unit order, so a non-ASCII key
  // sorts after every ASCII key.
  const mixed = delivery.canonicalize({ "z": 1, "a": 2, "\u00e9": 3 });
  assert.deepEqual(Object.keys(JSON.parse(mixed)), ["a", "z", "\u00e9"]);
});

test("a floating point value is refused rather than normalized", () => {
  assert.equal(codeOf(() => delivery.canonicalize({ a: 1.5 })), "ERR_PERMIT_INPUT_INVALID");
});

test("the signed deadline is the permit's own deadline, byte for byte", () => {
  // The signer must not compute issued_at_ms + ttl: for a short lease the
  // lease expiry is what bounds the permit, so the two numbers differ.
  const keyPair = delivery.createBatchKeyPair();
  const permit = samplePermit({ deadline: 1_700_000_000_000, sequence: 9 });
  // A short lease: the permit was issued with 50ms of budget left, so the
  // signed deadline is nowhere near issued_at_ms + ttl.
  const issuedAtMs = 1_700_000_000_000 - 50;
  const ttlMs = 30_000;
  const signed = sign(permit, keyPair, issuedAtMs);
  assert.equal(signed.message.deadline_ms, permit.deadline);
  assert.equal(signed.deadline, permit.deadline);
  // The deadline the signer could have computed itself would be a different
  // number; the signed value is the permit's own.
  assert.notEqual(signed.message.deadline_ms, issuedAtMs + ttlMs);
  const verified = delivery.verifyPermitSignature({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    nowMs: permit.deadline - 1,
  });
  assert.equal(verified.deadline, permit.deadline);
});

test("a signed deadline that differs from the stored deadline is refused", () => {
  // The signature alone does not prove the deadline is the permit's own: a
  // signer that computed its own deadline could sign a self-consistent
  // message whose deadline_ms is not the real one. The verifier compares
  // the two when it is given the stored value, so that is a refused input
  // rather than a discipline the caller has to remember.
  const keyPair = delivery.createBatchKeyPair();
  const permit = samplePermit({ deadline: 1_700_000_000_000 });
  const signed = sign(permit, keyPair);
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedDeadlineMs: permit.deadline,
    })),
    null,
  );
  // One millisecond off is still off.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedDeadlineMs: permit.deadline + 1,
    })),
    "ERR_PERMIT_DEADLINE_MISMATCH",
  );
});

test("the signed deadline is the deadline a real store produced, short lease included", () => {
  // The read-back chain has to be the real one: reserve() produces the
  // permit, the signer reads it back, and the signed value is that number.
  // A hand-built permit object would not exercise the chain -- it would
  // only show that the signer copies whatever it is handed.
  if (Number(process.versions.node.split(".")[0]) < 24) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms004-s1-"));
  const file = path.join(dir, "authority.sqlite");
  const anchorDir = path.join(path.dirname(dir), `${path.basename(dir)}-anchor`);
  fs.mkdirSync(anchorDir, { recursive: true });
  let now = 1_000_000;
  const clock = () => now;
  const store = ProtectedPermitStore.initialize(file, {
    decisionId: "D-test-ms004-s1",
    clock,
    anchorDir,
    anchorMode: anchorModule.ANCHOR_MODE.permissive,
  });
  try {
    const lease = store.acquire({
      owner: "coordinator", sessionId: "session-1", hostId: "host-1",
      workerId: "worker-1", runId: "run-1", generation: "gen-1",
      desktopKey: "desktop-1", ownedAppId: "app-1",
      idempotencyKey: "lease-key-1", ttlMs: 60_000,
    });
    // Let the lease run almost to its end. The permit is bounded by the
    // lease expiry, so once the lease has 10ms left a 50ms permit budget is
    // cut short -- which is exactly where a self-computed deadline and the
    // store's deadline come apart.
    now += 59_990;
    const reserved = store.reserve({
      ...lease,
      idempotencyKey: "permit-key-1", operation: "uia.invoke",
      targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64),
      // A short lease: the permit is bounded by the lease expiry, so the
      // deadline is nowhere near issued_at_ms + ttl.
      ttlMs: 50,
    });
    const keyPair = delivery.createBatchKeyPair();
    const signed = delivery.buildSignedPermit({
      privateKeyRef: keyPair.privateKeyRef,
      permit: reserved,
      issuedAtMs: clock(),
    });
    // The signed deadline is the store's own number, bit for bit.
    assert.equal(signed.message.deadline_ms, reserved.deadline);
    // The number a signer would have computed for itself is a different one.
    assert.notEqual(signed.message.deadline_ms, clock() + 50);
    assert.ok(reserved.deadline < clock() + 50, "the permit must be bounded by the lease expiry");
    // And the verifier accepts it against the stored value.
    const verified = delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedDeadlineMs: reserved.deadline,
    });
    assert.equal(verified.deadline, reserved.deadline);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("an expired permit is refused", () => {
  const keyPair = delivery.createBatchKeyPair();
  const permit = samplePermit();
  const signed = sign(permit, keyPair);
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      nowMs: permit.deadline + 1,
    })),
    "ERR_PERMIT_DEADLINE_EXPIRED",
  );
});

test("a replayed sequence is refused and the high-water mark only advances on acceptance", () => {
  const tracker = delivery.createSequenceTracker();
  assert.equal(delivery.checkAndAdvanceSequence(tracker, 5), 5);
  assert.equal(codeOf(() => delivery.checkAndAdvanceSequence(tracker, 5)), "ERR_PERMIT_SEQUENCE_REPLAY");
  assert.equal(codeOf(() => delivery.checkAndAdvanceSequence(tracker, 4)), "ERR_PERMIT_SEQUENCE_REPLAY");
  assert.equal(tracker.highestSeen, 5);
  assert.equal(delivery.checkAndAdvanceSequence(tracker, 6), 6);
  assert.equal(tracker.highestSeen, 6);
});

test("a revoked fingerprint cannot authorize a permit", () => {
  const keyPair = delivery.createBatchKeyPair();
  const signed = sign(samplePermit(), keyPair);
  const revoked = new Set([keyPair.fingerprint]);
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: revoked,
      nowMs: 1,
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
});

// ── Revocation list ────────────────────────────────────────────────────────

function buildRevocationList(options) {
  const { keyPair, sequence, fingerprints, prev, issuedAtMs } = options;
  const message = {
    revocation_sequence: sequence,
    revoked_fingerprints: fingerprints.slice().sort(),
    issued_at_ms: issuedAtMs === undefined ? 1_700_000_000_000 : issuedAtMs,
    prev_revocation_sequence: prev === undefined ? sequence - 1 : prev,
    batch_public_key_fingerprint: keyPair.fingerprint,
  };
  const bytes = delivery.canonicalBytes(message);
  const signature = keyPair.privateKeyRef.sign(bytes).toString("base64");
  return { ...message, signature };
}

test("a well-formed revocation list is applied", () => {
  const keyPair = delivery.createBatchKeyPair();
  const other = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const list = buildRevocationList({
    keyPair,
    sequence: 1,
    fingerprints: [other.fingerprint],
  });
  const result = delivery.applyRevocationList({
    state,
    list,
    publicKeyPem: keyPair.publicKeyPem,
    pinnedFingerprints: new Set([keyPair.fingerprint]),
  });
  assert.equal(result.appliedRevocationSequence, 1);
  assert.equal(state.appliedRevocationSequence, 1);
  assert.ok(state.revokedFingerprints.has(other.fingerprint));
});

test("a broken revocation chain is refused", () => {
  // A gap in the sequence is a broken chain.
  const keyPair = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const list = buildRevocationList({ keyPair, sequence: 2, fingerprints: ["f".repeat(64)] });
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list,
      publicKeyPem: keyPair.publicKeyPem,
      pinnedFingerprints: new Set([keyPair.fingerprint]),
    })),
    "ERR_REVOCATION_SEQUENCE_BROKEN",
  );
  assert.equal(state.appliedRevocationSequence, 0);
});

test("a truncated revocation list is refused and nothing advances", () => {
  const keyPair = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const first = buildRevocationList({ keyPair, sequence: 1, fingerprints: ["a".repeat(64)] });
  delivery.applyRevocationList({
    state,
    list: first,
    publicKeyPem: keyPair.publicKeyPem,
    pinnedFingerprints: new Set([keyPair.fingerprint]),
  });
  assert.equal(state.appliedRevocationSequence, 1);
  // A list that repeats the applied sequence is a truncation attempt.
  const truncated = buildRevocationList({ keyPair, sequence: 1, fingerprints: ["a".repeat(64)] });
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list: truncated,
      publicKeyPem: keyPair.publicKeyPem,
      pinnedFingerprints: new Set([keyPair.fingerprint]),
    })),
    "ERR_REVOCATION_SEQUENCE_BROKEN",
  );
  assert.equal(state.appliedRevocationSequence, 1);
});

test("a replaced revocation list is refused", () => {
  const keyPair = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const original = buildRevocationList({ keyPair, sequence: 1, fingerprints: ["a".repeat(64)] });
  // The replacement happens before the list is applied: the content is
  // swapped while the signature stays the one the signer produced. The
  // chain check passes -- the sequence is still the expected one -- so the
  // signature is what has to catch it.
  const replaced = { ...original, revoked_fingerprints: ["b".repeat(64)] };
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list: replaced,
      publicKeyPem: keyPair.publicKeyPem,
      pinnedFingerprints: new Set([keyPair.fingerprint]),
    })),
    "ERR_PERMIT_SIGNATURE_INVALID",
  );
  assert.equal(state.appliedRevocationSequence, 0);
  assert.ok(!state.revokedFingerprints.has("b".repeat(64)));
});

test("a revocation list that replays an applied sequence is refused", () => {
  const keyPair = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const original = buildRevocationList({ keyPair, sequence: 1, fingerprints: ["a".repeat(64)] });
  delivery.applyRevocationList({
    state,
    list: original,
    publicKeyPem: keyPair.publicKeyPem,
    pinnedFingerprints: new Set([keyPair.fingerprint]),
  });
  // Same sequence, different content, properly signed: the high-water mark
  // stops it before the content is ever considered.
  const replaced = buildRevocationList({ keyPair, sequence: 1, fingerprints: ["b".repeat(64)] });
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list: replaced,
      publicKeyPem: keyPair.publicKeyPem,
      pinnedFingerprints: new Set([keyPair.fingerprint]),
    })),
    "ERR_REVOCATION_SEQUENCE_BROKEN",
  );
  assert.equal(state.appliedRevocationSequence, 1);
  assert.ok(!state.revokedFingerprints.has("b".repeat(64)));
});

test("the revoked set only grows", () => {
  const keyPair = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const first = buildRevocationList({ keyPair, sequence: 1, fingerprints: ["a".repeat(64)] });
  delivery.applyRevocationList({
    state,
    list: first,
    publicKeyPem: keyPair.publicKeyPem,
    pinnedFingerprints: new Set([keyPair.fingerprint]),
  });
  // A second list that drops the already revoked fingerprint must be refused,
  // and the high-water mark must not advance.
  const shrinking = buildRevocationList({ keyPair, sequence: 2, fingerprints: [] });
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list: shrinking,
      publicKeyPem: keyPair.publicKeyPem,
      pinnedFingerprints: new Set([keyPair.fingerprint]),
    })),
    "ERR_REVOCATION_SET_NOT_MONOTONIC",
  );
  assert.equal(state.appliedRevocationSequence, 1);
  assert.ok(state.revokedFingerprints.has("a".repeat(64)));
});

test("a revoked key cannot sign the list that would un-revoke it", () => {
  const keyPair = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const first = buildRevocationList({ keyPair, sequence: 1, fingerprints: [keyPair.fingerprint] });
  delivery.applyRevocationList({
    state,
    list: first,
    publicKeyPem: keyPair.publicKeyPem,
    pinnedFingerprints: new Set([keyPair.fingerprint]),
  });
  // The signer is now revoked, so its next list is refused. This is what
  // makes "sign a list that removes my own fingerprint" impossible.
  const second = buildRevocationList({ keyPair, sequence: 2, fingerprints: [] });
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list: second,
      publicKeyPem: keyPair.publicKeyPem,
      pinnedFingerprints: new Set([keyPair.fingerprint]),
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
  assert.equal(state.appliedRevocationSequence, 1);
});

test("a revocation list signed by a key that is not pinned is refused", () => {
  const keyPair = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const list = buildRevocationList({ keyPair, sequence: 1, fingerprints: [] });
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list,
      publicKeyPem: keyPair.publicKeyPem,
      pinnedFingerprints: new Set(),
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
});

test("a revocation list cannot claim a pinned signer while being signed by another key", () => {
  // The signer identity has to be DERIVED from the key that verifies the
  // signature, not read from the fingerprint the list claims for itself.
  // The claimed fingerprint is a string inside the signed payload -- it
  // proves nothing about who signed. If the pin check ran against the
  // claim, a key that is not pinned at all could sign a list that names a
  // pinned key, and the list would be accepted.
  const pinned = delivery.createBatchKeyPair();
  const rogue = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const message = {
    revocation_sequence: 1,
    revoked_fingerprints: [],
    issued_at_ms: 1_700_000_000_000,
    prev_revocation_sequence: 0,
    batch_public_key_fingerprint: pinned.fingerprint,
  };
  const bytes = delivery.canonicalBytes(message);
  const signature = rogue.privateKeyRef.sign(bytes).toString("base64");
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list: { ...message, signature },
      publicKeyPem: rogue.publicKeyPem,
      pinnedFingerprints: new Set([pinned.fingerprint]),
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
  // Nothing advanced: a refused list leaves the chain exactly where it was.
  assert.equal(state.appliedRevocationSequence, 0);
  assert.equal(state.revokedFingerprints.size, 0);
});

// ── Private key reachability ───────────────────────────────────────────────

test("the private key is not reachable through any export path", () => {
  const keyPair = delivery.createBatchKeyPair();
  const result = delivery.assertNoPrivateKeyLeak({ privateKeyRef: keyPair.privateKeyRef });
  assert.equal(result.ok, true);
  assert.equal(result.covered, "js-visible-memory");
});

test("the export path is refused rather than producing key bytes", () => {
  const keyPair = delivery.createBatchKeyPair();
  // The handle carries no export path at all: the KeyObject stays inside
  // the module, so there is nothing on the handle to call.
  assert.equal(typeof keyPair.privateKeyRef.export, "undefined");
  assert.deepEqual(Object.keys(keyPair.privateKeyRef), ["sign"]);
});

test("the private key does not leak through inspect or JSON", () => {
  const keyPair = delivery.createBatchKeyPair();
  const inspected = require("node:util").inspect(keyPair.privateKeyRef);
  assert.ok(!/BEGIN PRIVATE KEY/.test(inspected));
  const serialized = JSON.stringify(keyPair.privateKeyRef);
  assert.ok(!/BEGIN PRIVATE KEY/.test(serialized));
});

test("the batch public key is a public key and the handle carries no PEM", () => {
  const keyPair = delivery.createBatchKeyPair();
  assert.match(keyPair.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.ok(!/PRIVATE KEY/.test(keyPair.publicKeyPem));
  assert.match(keyPair.fingerprint, /^[a-f0-9]{64}$/);
});

// ── Pin exclusivity ────────────────────────────────────────────────────────

test("the read-only check reports the preconditions without reserving anything", () => {
  const clean = delivery.assertPinExclusive({
    existingPin: null,
    targetHasProcess: false,
    targetHasPriorRun: false,
  });
  assert.equal(clean.exclusive, true);
  assert.deepEqual(clean.reasons, []);
  for (const [input, reason] of [
    [{ existingPin: { fingerprint: "x" } }, "existing-pin"],
    [{ targetHasProcess: true }, "target-has-process"],
    [{ targetHasPriorRun: true }, "target-has-prior-run"],
  ]) {
    const verdict = delivery.assertPinExclusive({
      existingPin: null,
      targetHasProcess: false,
      targetHasPriorRun: false,
      ...input,
    });
    assert.equal(verdict.exclusive, false);
    assert.deepEqual(verdict.reasons, [reason]);
  }
});

test("an undecided clause blocks the route rather than counting as satisfied", () => {
  // "Undecidable is not the same as absent" (design document section
  // 2.2.2). The naive spelling -- !existingPin && !targetHasProcess --
  // reports a clause that was never decided as satisfied, because !undefined
  // is true, and the route then goes on as if the target were known to be
  // idle. Every clause that was not actually decided blocks the route and
  // says which clause blocked it.
  const verdict = delivery.assertPinExclusive({});
  assert.equal(verdict.exclusive, false);
  assert.deepEqual(verdict.reasons, [
    "existing-pin-undecidable",
    "target-has-process-undecidable",
    "target-has-prior-run-undecidable",
  ]);

  // One undecided clause is enough -- the others being decided does not
  // rescue the route.
  assert.equal(
    delivery.assertPinExclusive({ existingPin: null, targetHasPriorRun: false }).exclusive,
    false,
  );
  assert.deepEqual(
    delivery.assertPinExclusive({ existingPin: null, targetHasPriorRun: false }).reasons,
    ["target-has-process-undecidable"],
  );
  assert.equal(
    delivery.assertPinExclusive({ targetHasProcess: false, targetHasPriorRun: false }).exclusive,
    false,
  );

  // All three decided gives the exclusive verdict.
  assert.equal(
    delivery.assertPinExclusive({
      existingPin: null,
      targetHasProcess: false,
      targetHasPriorRun: false,
    }).exclusive,
    true,
  );
});

test("the atomic registration refuses an undecided precondition", () => {
  // The guarantee has to refuse what the check refuses. If the check
  // reported an undecided clause as exclusive, the registration would
  // write a pin on the strength of a fact nobody established.
  let entered = 0;
  assert.equal(
    codeOf(() => delivery.registerPinExclusively({
      criticalSection: (fn) => { entered += 1; return fn(); },
      registration: {
        existingPin: null,
        targetHasProcess: undefined,
        targetHasPriorRun: false,
        write: () => ({ written: true }),
      },
    })),
    "ERR_PIN_NOT_EXCLUSIVE",
  );
  assert.equal(entered, 1);
});

test("the atomic registration refuses a non-exclusive precondition inside the critical section", () => {
  let entered = 0;
  assert.equal(
    codeOf(() => delivery.registerPinExclusively({
      criticalSection: (fn) => { entered += 1; return fn(); },
      registration: {
        existingPin: { fingerprint: "x" },
        targetHasProcess: false,
        targetHasPriorRun: false,
        write: () => ({ written: true }),
      },
    })),
    "ERR_PIN_NOT_EXCLUSIVE",
  );
  assert.equal(entered, 1);
});

test("the atomic registration writes inside the critical section", () => {
  const order = [];
  const result = delivery.registerPinExclusively({
    criticalSection: (fn) => { order.push("enter"); const out = fn(); order.push("leave"); return out; },
    registration: {
      existingPin: null,
      targetHasProcess: false,
      targetHasPriorRun: false,
      write: () => { order.push("write"); return { written: true }; },
    },
  });
  assert.deepEqual(order, ["enter", "write", "leave"]);
  assert.equal(result.written, true);
});

test("the read-only check and the atomic registration are distinct exports", () => {
  // The misuse that the design warns about -- calling the check on the
  // registration path -- has to be visible in the API surface: the two
  // functions are separate exports with separate contracts.
  assert.equal(typeof delivery.assertPinExclusive, "function");
  assert.equal(typeof delivery.registerPinExclusively, "function");
  assert.notEqual(delivery.assertPinExclusive, delivery.registerPinExclusively);
  assert.equal(delivery.registerPinExclusively.length, 1);
});
