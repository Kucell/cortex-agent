"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const delivery = require("../../lib/coordination/permit-delivery");
const {
  AUTHORITY_MAX_TTL_MS,
  AUTHORITY_MIN_TTL_MS,
  AUTHORITY_SKEW_TOLERANCE_MS,
  FORBIDDEN_SIGNED_FIELDS,
  PERMIT_CATEGORY,
  buildDesktopAuthorityMessage,
  signDesktopAuthorityPermit,
  verifyDesktopAuthorityPermit,
} = require("../../lib/coordination/permit-authority-signing");

const ISSUED = 1_800_000_000_000;

function fields(overrides = {}) {
  return {
    permit_id: "permit-authority-1",
    permit_category: PERMIT_CATEGORY,
    session_id: "session-1",
    desktop_key: "desktop-1",
    generation: 7,
    service_epoch: 3,
    fencing_token: 42,
    issued_at_ms: ISSUED,
    deadline_ms: ISSUED + 60_000,
    sequence: 9,
    ...overrides,
  };
}

test("the signed message carries exactly the §3.2 field set", () => {
  const message = buildDesktopAuthorityMessage(fields());
  assert.deepEqual(Object.keys(message).sort(), [
    "deadline_ms",
    "desktop_key",
    "fencing_token",
    "generation",
    "issued_at_ms",
    "permit_category",
    "permit_id",
    "sequence",
    "service_epoch",
    "session_id",
  ]);
  assert.equal(message.permit_category, "desktop_authority");
});

test("an authority permit refuses every dispatch-only field (INV-02)", () => {
  for (const name of FORBIDDEN_SIGNED_FIELDS) {
    assert.throws(
      () => buildDesktopAuthorityMessage(fields({ [name]: "x" })),
      { code: "ERR_PERMIT_AUTHORITY_FIELD_FORBIDDEN: " + name },
    );
  }
});

test("an unknown signed field is refused rather than carried", () => {
  assert.throws(
    () => buildDesktopAuthorityMessage(fields({ extra_binding: "x" })),
    { code: "ERR_PERMIT_INPUT_INVALID: extra_binding" },
  );
});

test("the category cannot be anything but desktop_authority", () => {
  assert.throws(
    () => buildDesktopAuthorityMessage(fields({ permit_category: "dispatch" })),
    { code: "ERR_PERMIT_INPUT_INVALID: permit_category" },
  );
});

test("the TTL ceiling and floor are enforced at signing time", () => {
  assert.throws(
    () => buildDesktopAuthorityMessage(fields({ deadline_ms: ISSUED + AUTHORITY_MAX_TTL_MS + 1 })),
    { code: "ERR_PERMIT_AUTHORITY_TTL_TOO_LONG" },
  );
  assert.throws(
    () => buildDesktopAuthorityMessage(fields({ deadline_ms: ISSUED + AUTHORITY_MIN_TTL_MS - 1 })),
    { code: "ERR_PERMIT_AUTHORITY_TTL_TOO_SHORT" },
  );
  assert.doesNotThrow(() =>
    buildDesktopAuthorityMessage(fields({ deadline_ms: ISSUED + AUTHORITY_MAX_TTL_MS })));
});

test("every integer field is validated as a safe integer with its floor", () => {
  for (const [name, minimum] of [["generation", 0], ["service_epoch", 1], ["fencing_token", 0],
    ["issued_at_ms", 1], ["deadline_ms", 1], ["sequence", 1]]) {
    assert.throws(
      () => buildDesktopAuthorityMessage(fields({ [name]: minimum - 1 })),
      { code: "ERR_PERMIT_INPUT_INVALID: " + name },
    );
    assert.throws(
      () => buildDesktopAuthorityMessage(fields({ [name]: String(minimum) })),
      { code: "ERR_PERMIT_INPUT_INVALID: " + name },
    );
  }
});

test("a signed authority permit verifies with the batch public key", () => {
  const batch = delivery.createBatchKeyPair();
  const signed = signDesktopAuthorityPermit({ privateKeyRef: batch.privateKeyRef, fields: fields() });
  const result = verifyDesktopAuthorityPermit({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: batch.publicKeyPem,
    expectedFingerprint: batch.fingerprint,
    revokedFingerprints: new Set(),
    nowMs: ISSUED + 1_000,
    skewToleranceMs: AUTHORITY_SKEW_TOLERANCE_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fingerprint, batch.fingerprint);
  assert.equal(result.deadline, ISSUED + 60_000);
});

test("a tampered field breaks the signature", () => {
  const batch = delivery.createBatchKeyPair();
  const signed = signDesktopAuthorityPermit({ privateKeyRef: batch.privateKeyRef, fields: fields() });
  const tampered = { ...signed.message, sequence: 10 };
  assert.throws(() => verifyDesktopAuthorityPermit({
    message: tampered,
    signature: signed.signature,
    publicKeyPem: batch.publicKeyPem,
    expectedFingerprint: batch.fingerprint,
    revokedFingerprints: new Set(),
    nowMs: ISSUED + 1_000,
  }), { code: "ERR_PERMIT_SIGNATURE_INVALID" });
});

test("a revoked signing key is refused even with a valid signature", () => {
  const batch = delivery.createBatchKeyPair();
  const signed = signDesktopAuthorityPermit({ privateKeyRef: batch.privateKeyRef, fields: fields() });
  assert.throws(() => verifyDesktopAuthorityPermit({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: batch.publicKeyPem,
    expectedFingerprint: batch.fingerprint,
    revokedFingerprints: new Set([batch.fingerprint]),
    nowMs: ISSUED + 1_000,
  }), { code: "ERR_REVOCATION_SIGNER_INVALID" });
});

test("an expired authority permit is refused, and the allowance never extends the deadline", () => {
  const batch = delivery.createBatchKeyPair();
  const signed = signDesktopAuthorityPermit({ privateKeyRef: batch.privateKeyRef, fields: fields() });
  assert.throws(() => verifyDesktopAuthorityPermit({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: batch.publicKeyPem,
    expectedFingerprint: batch.fingerprint,
    revokedFingerprints: new Set(),
    nowMs: ISSUED + 60_000,
    skewToleranceMs: AUTHORITY_SKEW_TOLERANCE_MS,
  }), { code: "ERR_PERMIT_DEADLINE_EXPIRED" });
});

test("a local clock behind the issue instant beyond the fixed allowance is refused", () => {
  const batch = delivery.createBatchKeyPair();
  const signed = signDesktopAuthorityPermit({ privateKeyRef: batch.privateKeyRef, fields: fields() });
  const verify = (nowMs, skewToleranceMs) => verifyDesktopAuthorityPermit({
    message: signed.message,
    signature: signed.signature,
    publicKeyPem: batch.publicKeyPem,
    expectedFingerprint: batch.fingerprint,
    revokedFingerprints: new Set(),
    nowMs,
    skewToleranceMs,
  });
  assert.throws(() => verify(ISSUED - AUTHORITY_SKEW_TOLERANCE_MS - 1, AUTHORITY_SKEW_TOLERANCE_MS),
    { code: "ERR_PERMIT_CLOCK_SKEW_EXCEEDED" });
  assert.equal(verify(ISSUED - AUTHORITY_SKEW_TOLERANCE_MS, AUTHORITY_SKEW_TOLERANCE_MS).ok, true);
  // A wider allowance than the fixed 2 s bound is refused, not clipped.
  assert.throws(() => verify(ISSUED, AUTHORITY_SKEW_TOLERANCE_MS + 1),
    { code: "ERR_PERMIT_INPUT_INVALID: skewToleranceMs" });
});

