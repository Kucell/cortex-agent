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

// The verifier's clock. It has to be a PLAUSIBLE instant: the verifier
// refuses a clock that is zero or below (a vacuous expiry verdict) and a
// clock that precedes the signed issued_at_ms (a reading the verifier
// could not have taken). The permit's own issue instant is the natural
// choice -- it is inside the validity window of every permit these tests
// build, and it is what a verifier with a synchronised clock would see.
const VERIFIER_CLOCK_MS = 1_700_000_000_000 - 1000;

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CoordinationError, "expected a CoordinationError, got " + error);
    return error.key;
  }
  return null;
}

// The local revoked set is a MANDATORY input to the verification path, so
// every call site has to say what it is. An empty set says "nothing is
// revoked"; omitting the argument says "the caller has no set at all",
// which is refused. A test that is about some other property passes the
// empty set explicitly, so it states that fact rather than depending on the
// argument being optional.
const NOTHING_REVOKED = new Set();

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
          revokedFingerprints: NOTHING_REVOKED,
        message,
        signature: signed.signature,
        publicKeyPem: keyPair.publicKeyPem,
        expectedFingerprint: keyPair.fingerprint,
        nowMs: VERIFIER_CLOCK_MS,
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
        revokedFingerprints: NOTHING_REVOKED,
      message: tampered,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      nowMs: VERIFIER_CLOCK_MS,
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
      expectedFingerprint: other.fingerprint,
      nowMs: VERIFIER_CLOCK_MS,
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
      revokedFingerprints: NOTHING_REVOKED,
    message: reordered,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    expectedFingerprint: keyPair.fingerprint,
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
      revokedFingerprints: NOTHING_REVOKED,
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    expectedFingerprint: keyPair.fingerprint,
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
        revokedFingerprints: NOTHING_REVOKED,
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      nowMs: VERIFIER_CLOCK_MS,
      expectedDeadlineMs: permit.deadline,
    })),
    null,
  );
  // One millisecond off is still off.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
        revokedFingerprints: NOTHING_REVOKED,
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      nowMs: VERIFIER_CLOCK_MS,
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
        revokedFingerprints: NOTHING_REVOKED,
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      // The store runs on an injected clock, so the verifier is given the
      // same reading -- the permit was signed at that instant, and a
      // verifier clock behind the issue instant is refused.
      nowMs: clock(),
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
        revokedFingerprints: NOTHING_REVOKED,
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
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
        revokedFingerprints: NOTHING_REVOKED,
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: revoked,
      nowMs: VERIFIER_CLOCK_MS,
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
});

test("the revoked set is a mandatory input to the verification path", () => {
  // The revoked set is a STATE, not a hint: the caller holds the local
  // revoked set, and the question "is this key revoked" cannot be answered
  // without it. Making it optional would mean the strongest rule -- a
  // revoked key authorizes nothing -- is the one rule that a forgotten
  // argument turns off, and "no argument" and "an empty set" would mean
  // opposite things while looking the same at the call site.
  const keyPair = delivery.createBatchKeyPair();
  const signed = sign(samplePermit(), keyPair);
  const revoked = new Set([keyPair.fingerprint]);
  // With the set, the revoked key is refused.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: revoked,
      nowMs: VERIFIER_CLOCK_MS,
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
  // With the set omitted, the SAME revoked key is refused too -- the
  // omission is not a way to have the check skipped.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      nowMs: VERIFIER_CLOCK_MS,
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
  // An explicitly empty set says "nothing is revoked" and is accepted.
  const ok = delivery.verifyPermitSignature({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    expectedFingerprint: keyPair.fingerprint,
    revokedFingerprints: new Set(),
    nowMs: VERIFIER_CLOCK_MS,
  });
  assert.equal(ok.ok, true);
});

// ── The optional-argument fail-open family ────────────────────────────────
//
// Four rounds of review found the same shape four times: a precondition
// that the design states as mandatory was expressed as an OPTIONAL
// argument, and a caller that left the argument out got the check SKIPPED
// instead of REFUSED. A skipped check is fail-open, and the omitted
// argument is the easiest thing in the world to forget.
//
//   B3  pinnedFingerprints   -- the revocation signer must be in the pin
//   B4  revokedFingerprints  -- a revoked key must not authorize anything
//   B5  expectedFingerprint  -- the signer must BE the pinned key
//   M5  nowMs                -- an expired permit must not verify
//
// The tests below pin the closed shape for the last two, written so that a
// future change cannot turn an argument back into an optional one without
// one of them turning red.

test("the expected fingerprint is a mandatory input to the verification path", () => {
  // The verifier holds the pin, so the fingerprint of the authoritative key
  // is a value it has. Without it the module cannot answer "is this the key
  // we pinned", and a missing answer is not a yes.
  const keyPair = delivery.createBatchKeyPair();
  const signed = sign(samplePermit(), keyPair);

  // A key that was never registered must not be able to authorize anything.
  // This is the second disjunct of the design's negative case 1 ("a message
  // signed by an old key -> refuse: the key is revoked OR NOT IN THE PIN").
  const attacker = delivery.createBatchKeyPair();
  const attackerSigned = delivery.buildSignedPermit({
    privateKeyRef: attacker.privateKeyRef,
    permit: samplePermit(),
    issuedAtMs: 1,
  });
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: attackerSigned.message,
      signature: attackerSigned.signature,
      publicKeyPem: attacker.publicKeyPem,
      nowMs: VERIFIER_CLOCK_MS,
      revokedFingerprints: NOTHING_REVOKED,
    })),
    "ERR_PERMIT_SIGNATURE_INVALID",
    "an unregistered key must be refused when the expected fingerprint is omitted",
  );

  // Every shape of "no expectation was supplied" is refused. The guard is
  // the comparison, not the truthiness of the argument: an empty string, a
  // null, a zero and a false all used to slip past `if (expectedFingerprint)`.
  for (const missing of [undefined, null, "", 0, false]) {
    assert.equal(
      codeOf(() => delivery.verifyPermitSignature({
        message: signed.message,
        signature: signed.signature,
        publicKeyPem: keyPair.publicKeyPem,
        expectedFingerprint: missing,
        nowMs: VERIFIER_CLOCK_MS,
        revokedFingerprints: NOTHING_REVOKED,
      })),
      "ERR_PERMIT_SIGNATURE_INVALID",
      "expectedFingerprint=" + JSON.stringify(missing) + " must not skip the identity check",
    );
  }

  // The honest path still works: the pinned key's own permit verifies, and
  // the reported fingerprint is the DERIVED one -- the key that actually
  // signed, not a claim the caller made about it.
  const verified = delivery.verifyPermitSignature({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    expectedFingerprint: keyPair.fingerprint,
    nowMs: VERIFIER_CLOCK_MS,
    revokedFingerprints: NOTHING_REVOKED,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.fingerprint, keyPair.fingerprint);
});

test("the verifier clock is a mandatory input to the verification path", () => {
  // The expiry verdict depends on the verifier's local clock (design 2.3.3).
  // Without a clock there is no verdict at all, and a missing verdict is not
  // "not expired" -- leaving the argument out used to let an EXPIRED permit
  // through.
  const keyPair = delivery.createBatchKeyPair();
  const permit = samplePermit({ deadline: 1_700_000_000_000 });
  const signed = sign(permit, keyPair);

  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
    })),
    "ERR_PERMIT_INPUT_INVALID",
    "an expired permit must not verify just because the clock was left out",
  );

  // With the clock supplied, the expired permit is refused on its merits.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
      nowMs: permit.deadline + 1,
    })),
    "ERR_PERMIT_DEADLINE_EXPIRED",
  );
});

test("an impossible clock reading cannot make an expired permit verify", () => {
  // The expiry verdict is `now > deadline`. A clock reading that is not a
  // real instant makes that comparison vacuous: `now > deadline` is false
  // for every deadline once now is zero or below, so a permit that expired
  // decades ago would verify. The protected permit store refuses a
  // negative clock the same way (protected-permit-store.js:
  // `!Number.isSafeInteger(now) || now < 0`); the epoch is refused here
  // too, because no permit this module verifies can have a deadline at or
  // below it.
  const keyPair = delivery.createBatchKeyPair();
  const permit = samplePermit({ deadline: 1_700_000_000_000 });
  const signed = sign(permit, keyPair);

  for (const impossible of [0, -1, -1000, -1_700_000_000_000, Number.MIN_SAFE_INTEGER]) {
    assert.equal(
      codeOf(() => delivery.verifyPermitSignature({
        message: signed.message,
        signature: signed.signature,
        publicKeyPem: keyPair.publicKeyPem,
        expectedFingerprint: keyPair.fingerprint,
        revokedFingerprints: NOTHING_REVOKED,
        nowMs: impossible,
      })),
      "ERR_PERMIT_INPUT_INVALID",
      "nowMs=" + impossible + " is not a real instant and must be refused",
    );
  }

  // A clock that PRECEDES the signed issue instant is equally impossible:
  // the permit cannot have been issued by a signer that has not reached
  // that moment yet. Without this judgement the whole clock check is
  // vacuous for every permit ever issued.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
      nowMs: 1,
    })),
    "ERR_PERMIT_INPUT_INVALID",
    "a clock behind the signed issue instant must be refused",
  );

  // The skew allowance is the one thing that may let the verifier's clock
  // sit behind the issue instant -- the design applies it to the
  // issued-at and the expires-at judgements separately (section 2.3.3).
  // It may not be negative.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
      nowMs: permit.deadline - 1000,
      skewToleranceMs: -1,
    })),
    "ERR_PERMIT_INPUT_INVALID",
    "a negative skew allowance must be refused",
  );

  // And the honest path is unaffected: a real clock inside the validity
  // window verifies.
  const verified = delivery.verifyPermitSignature({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    expectedFingerprint: keyPair.fingerprint,
    revokedFingerprints: NOTHING_REVOKED,
    nowMs: permit.deadline - 1000,
  });
  assert.equal(verified.ok, true);
});

test("the skew allowance is bounded and applies to both judgements", () => {
  // The allowance exists to absorb the clock offset between two machines.
  // It is BOUNDED, because an allowance wide enough to cover any clock
  // offset would make the issued-at judgement vacuous -- a clock could
  // then sit behind the issue instant by any amount and still be
  // accepted. That is the same fail-open shape as the revoked set, the
  // expected fingerprint and the impossible clock, reached through a
  // different door.
  const keyPair = delivery.createBatchKeyPair();
  const permit = samplePermit({ deadline: 1_700_000_000_000 });
  const signed = sign(permit, keyPair);
  const issuedAt = signed.message.issued_at_ms;

  // The bound is exported so that the step 2/3 wiring can configure against
  // the same number instead of a second, drifting one.
  assert.equal(delivery.MAX_SKEW_TOLERANCE_MS, 5 * 60 * 1000);

  // At the bound it is still usable: a clock that sits exactly the bound
  // behind the issue instant verifies.
  const atBound = delivery.verifyPermitSignature({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: keyPair.publicKeyPem,
    expectedFingerprint: keyPair.fingerprint,
    revokedFingerprints: NOTHING_REVOKED,
    nowMs: issuedAt - delivery.MAX_SKEW_TOLERANCE_MS,
    skewToleranceMs: delivery.MAX_SKEW_TOLERANCE_MS,
  });
  assert.equal(atBound.ok, true);

  // One millisecond past the bound is refused.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
      nowMs: issuedAt - delivery.MAX_SKEW_TOLERANCE_MS,
      skewToleranceMs: delivery.MAX_SKEW_TOLERANCE_MS + 1,
    })),
    "ERR_PERMIT_INPUT_INVALID",
    "an allowance past the bound must be refused",
  );

  // The same bound applies to the EXPIRY judgement: the design says the
  // allowance is applied to the issued-at and the expires-at judgements
  // SEPARATELY, and it does not change the signed deadline_ms -- the
  // comparison is what moves.
  const expiredByOne = permit.deadline + 1;
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
      nowMs: expiredByOne,
      skewToleranceMs: 1,
    })),
    null,
    "the allowance reaches the expiry judgement as well as the issued-at one",
  );
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
      nowMs: expiredByOne,
    })),
    "ERR_PERMIT_DEADLINE_EXPIRED",
    "without an allowance a permit one millisecond past its deadline is refused",
  );

  // A negative allowance is refused: the design says the allowance may not
  // be negative, and a negative one would TIGHTEN the issued-at judgement
  // while pretending to be an allowance.
  assert.equal(
    codeOf(() => delivery.verifyPermitSignature({
      message: signed.message,
      signature: signed.signature,
      publicKeyPem: keyPair.publicKeyPem,
      expectedFingerprint: keyPair.fingerprint,
      revokedFingerprints: NOTHING_REVOKED,
      nowMs: issuedAt,
      skewToleranceMs: -1,
    })),
    "ERR_PERMIT_INPUT_INVALID",
  );

  // The allowance does NOT widen the signature: the signed field set has
  // no skew field, so a signer cannot ask for a wider window (design 2.3.3:
  // the allowance "does not take part in the signature", precisely so it
  // cannot be amplified).
  assert.ok(!Object.keys(signed.message).some((name) => /skew|tolerance/i.test(name)));
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

test("the mandatory pin precondition cannot be skipped by omitting it", () => {
  // "The signer has to be in the pin" is a mandatory precondition, so the
  // pin set has to be there. An absent pin set is a precondition that was
  // never established, and an unestablished fact is handled as not
  // satisfied. Skipping the check when the argument is missing would make
  // the strongest precondition the easiest one to bypass: omitting an
  // argument would be the same as pinning everything.
  const rogue = delivery.createBatchKeyPair();
  const state = delivery.createRevocationState();
  const list = buildRevocationList({ keyPair: rogue, sequence: 1, fingerprints: [] });
  // The pin set is omitted entirely.
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list,
      publicKeyPem: rogue.publicKeyPem,
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
  // And nothing advanced.
  assert.equal(state.appliedRevocationSequence, 0);
  assert.equal(state.revokedFingerprints.size, 0);
  // An empty pin set refuses it too -- the difference is between "no key is
  // pinned" and "the pin was never provided", and neither accepts.
  assert.equal(
    codeOf(() => delivery.applyRevocationList({
      state,
      list,
      publicKeyPem: rogue.publicKeyPem,
      pinnedFingerprints: new Set(),
    })),
    "ERR_REVOCATION_SIGNER_INVALID",
  );
  assert.equal(state.appliedRevocationSequence, 0);
});

test("the fingerprint identifies the key rather than the text that carries it", () => {
  // A PEM is a text encoding, and the same key has several legal text
  // encodings. Hashing the text gives one key several fingerprints, and a
  // key pinned under one encoding is then refused when it arrives under
  // another -- a false refusal of a correctly pinned key.
  const keyPair = delivery.createBatchKeyPair();
  const crlf = keyPair.publicKeyPem.replace(/\n/g, "\r\n");
  const noTrailingNewline = keyPair.publicKeyPem.trimEnd();
  // The CRLF and the trimmed forms are the same key.
  const sameKey = crypto.createPublicKey(crlf).export({ type: "spki", format: "der" })
    .equals(crypto.createPublicKey(keyPair.publicKeyPem).export({ type: "spki", format: "der" }));
  assert.equal(sameKey, true);
  // A list signed by the pinned key is accepted when the key arrives in a
  // different text encoding.
  const state = delivery.createRevocationState();
  const list = buildRevocationList({ keyPair, sequence: 1, fingerprints: [] });
  const result = delivery.applyRevocationList({
    state,
    list,
    publicKeyPem: crlf,
    pinnedFingerprints: new Set([keyPair.fingerprint]),
  });
  assert.equal(result.appliedRevocationSequence, 1);
  // And the same for the trimmed form.
  const state2 = delivery.createRevocationState();
  const result2 = delivery.applyRevocationList({
    state: state2,
    list,
    publicKeyPem: noTrailingNewline,
    pinnedFingerprints: new Set([keyPair.fingerprint]),
  });
  assert.equal(result2.appliedRevocationSequence, 1);
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
