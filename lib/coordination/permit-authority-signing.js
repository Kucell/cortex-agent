"use strict";

// ─── Desktop Authority Permit Signing (M-053 / R6) ────────────────────────
//
// WHAT THIS IS
//   The signing primitive for the authorization-class permit defined by
//   D-AUTH-001 v1.2.0 §3.2: a `desktop_authority` permit, signed by the
//   issuing batch key, that lifts G1 (the desktop authority gate) for one
//   short window. It does NOT sign per-action (dispatch) permits — those
//   keep their existing shape and their existing reservation path.
//
// WHY IT IS A SEPARATE MODULE
//   The dispatch permit's field set IS its binding set: the store's
//   consume() compares every field, and `permit-delivery.assertCoversBinding`
//   refuses a message that misses one. An authority permit has a DIFFERENT
//   field set on purpose (§3.2 lists nine fields and §3.3 forbids the
//   action-binding trio). Widening the dispatch field set to "cover" both
//   would silently weaken the dispatch check — a message that omits
//   operation/target/params would still pass a looser coverage assertion.
//   So the two shapes are validated separately, and neither can stand in
//   for the other.
//
// WHY operation / target_digest / params_digest ARE HARD-REFUSED
//   INV-02: an authority permit must not be usable for any concrete action.
//   The prohibition is on the FIELDS, not on their values — a sentinel
//   operation would still be an operation the Worker could compare. A
//   message carrying any of the three is refused here, before signing, so
//   the issuing side cannot mint one by accident.
//
// WHY issued_at_ms IS PART OF THE MESSAGE
//   §3.2's field table lists deadline_ms but not issued_at_ms, while §6
//   requires the consumer to judge the signing clock against its own and
//   §2.1.1's projection carries issuedAtMs. A message without issued_at_ms
//   cannot be time-judged at all, so the field is included here and the
//   contract's §3.2 table is recorded as needing the field (see the R6
//   delivery note). Emitting it is the fail-closed choice: a consumer that
//   does not know the field still refuses the message as unknown/extra
//   rather than accepting it without a clock judgement.

const crypto = require("node:crypto");
const delivery = require("./permit-delivery");

const PERMIT_CATEGORY = "desktop_authority";

// The signed field set of an authority permit (D-AUTH-001 §3.2 + issued_at_ms).
const AUTHORITY_SIGNED_FIELDS = Object.freeze([
  "permit_id",
  "permit_category",
  "session_id",
  "desktop_key",
  "generation",
  "service_epoch",
  "fencing_token",
  "issued_at_ms",
  "deadline_ms",
  "sequence",
]);

// The dispatch-only fields an authority permit must never carry (INV-02).
const FORBIDDEN_SIGNED_FIELDS = Object.freeze([
  "operation",
  "target_digest",
  "params_digest",
]);

// §5.1: the authority TTL ceiling is 120 s, and the contract sets a 10 s
// floor so that a briefly jittering issuer cannot produce an unusable grant.
const AUTHORITY_MAX_TTL_MS = 120_000;
const AUTHORITY_MIN_TTL_MS = 10_000;

// §6: the fixed cross-machine clock allowance. Not a tuning knob.
const AUTHORITY_SKEW_TOLERANCE_MS = 2_000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function requireText(value, name) {
  if (typeof value !== "string" || value !== value.trim() || !value) {
    fail("ERR_PERMIT_INPUT_INVALID: " + name);
  }
  return value;
}

function requireInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("ERR_PERMIT_INPUT_INVALID: " + name);
  }
  return value;
}

/**
 * Validate the authority fields and build the signed message.
 *
 * @param {object} fields The §3.2 field values (snake_case).
 * @returns {object} The frozen message, ready for canonical bytes.
 */
function buildDesktopAuthorityMessage(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  // A forbidden field is refused even when it is present with a harmless
  // value: the prohibition is about the field existing in the signed set.
  for (const name of FORBIDDEN_SIGNED_FIELDS) {
    if (Object.hasOwn(fields, name)) fail("ERR_PERMIT_AUTHORITY_FIELD_FORBIDDEN: " + name);
  }
  // Any other unknown field is refused too: a message is exactly its signed
  // field set, and an extra field is a field nobody agreed to verify.
  for (const name of Object.keys(fields)) {
    if (!AUTHORITY_SIGNED_FIELDS.includes(name)) fail("ERR_PERMIT_INPUT_INVALID: " + name);
  }

  const message = {
    permit_id: requireText(fields.permit_id, "permit_id"),
    permit_category: requireText(fields.permit_category, "permit_category"),
    session_id: requireText(fields.session_id, "session_id"),
    desktop_key: requireText(fields.desktop_key, "desktop_key"),
    generation: requireInteger(fields.generation, "generation", 0),
    service_epoch: requireInteger(fields.service_epoch, "service_epoch", 1),
    fencing_token: requireInteger(fields.fencing_token, "fencing_token", 0),
    issued_at_ms: requireInteger(fields.issued_at_ms, "issued_at_ms", 1),
    deadline_ms: requireInteger(fields.deadline_ms, "deadline_ms", 1),
    sequence: requireInteger(fields.sequence, "sequence", 1),
  };

  if (message.permit_category !== PERMIT_CATEGORY) {
    fail("ERR_PERMIT_INPUT_INVALID: permit_category");
  }

  const ttl = message.deadline_ms - message.issued_at_ms;
  if (ttl <= 0) fail("ERR_PERMIT_INPUT_INVALID: window");
  if (ttl > AUTHORITY_MAX_TTL_MS) fail("ERR_PERMIT_AUTHORITY_TTL_TOO_LONG");
  if (ttl < AUTHORITY_MIN_TTL_MS) fail("ERR_PERMIT_AUTHORITY_TTL_TOO_SHORT");

  return Object.freeze(message);
}

/**
 * Sign an authority permit with the issuing batch key.
 *
 * @param {object} options
 * @param {object} options.privateKeyRef The batch signing handle (never exported).
 * @param {object} options.fields The §3.2 field values.
 * @returns {object} `{ message, signature, bytes }` — the sample a consumer verifies.
 */
function signDesktopAuthorityPermit(options = {}) {
  const { privateKeyRef, fields } = options;
  if (!privateKeyRef || typeof privateKeyRef.sign !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID: privateKeyRef");
  }
  const message = buildDesktopAuthorityMessage(fields);
  const bytes = delivery.canonicalBytes(message);
  const signature = privateKeyRef.sign(bytes).toString("base64");
  return Object.freeze({
    message,
    signature,
    bytes: bytes.toString("base64"),
  });
}

/**
 * Verify an authority permit (the consumer half, used for test-domain evidence
 * and by the SamHMI side once it grows the category branch).
 *
 * @param {object} options
 * @returns {object} `{ ok, fingerprint, deadline }`
 */
function verifyDesktopAuthorityPermit(options = {}) {
  const {
    message, signature, publicKeyPem, expectedFingerprint, revokedFingerprints,
    nowMs, skewToleranceMs, expectedDeadlineMs,
  } = options;

  // Re-validate the shape: a verifier that only re-checks the signature
  // would accept a message with an extra binding field nobody looked at.
  const normalized = buildDesktopAuthorityMessage(message);
  if (!signature || typeof signature !== "string") fail("ERR_PERMIT_INPUT_INVALID: signature");
  if (typeof publicKeyPem !== "string" || !publicKeyPem) fail("ERR_PERMIT_INPUT_INVALID: publicKeyPem");
  if (!revokedFingerprints || typeof revokedFingerprints.has !== "function") {
    fail("ERR_REVOCATION_SIGNER_INVALID");
  }
  const now = requireInteger(nowMs, "nowMs", 1);

  const key = crypto.createPublicKey(publicKeyPem);
  const bytes = delivery.canonicalBytes(normalized);
  if (!crypto.verify(null, bytes, key, Buffer.from(signature, "base64"))) {
    fail("ERR_PERMIT_SIGNATURE_INVALID");
  }

  const fingerprint = delivery.publicKeyFingerprint(publicKeyPem);
  if (typeof expectedFingerprint !== "string" || expectedFingerprint !== fingerprint) {
    fail("ERR_PERMIT_SIGNATURE_INVALID");
  }
  if (revokedFingerprints.has(fingerprint)) fail("ERR_REVOCATION_SIGNER_INVALID");

  if (expectedDeadlineMs !== undefined && expectedDeadlineMs !== normalized.deadline_ms) {
    fail("ERR_PERMIT_DEADLINE_MISMATCH");
  }

  const tolerance = skewToleranceMs === undefined ? 0 : requireInteger(skewToleranceMs, "skewToleranceMs", 0);
  if (tolerance > AUTHORITY_SKEW_TOLERANCE_MS) fail("ERR_PERMIT_INPUT_INVALID: skewToleranceMs");

  // The window is exactly the signer's grant (§5.1): the allowance absorbs a
  // slow local clock before issuance, never extends the deadline.
  const lifetime = normalized.deadline_ms - normalized.issued_at_ms;
  const effective = Math.min(tolerance, lifetime);
  if (now + effective < normalized.issued_at_ms) fail("ERR_PERMIT_CLOCK_SKEW_EXCEEDED");
  if (now >= normalized.deadline_ms) fail("ERR_PERMIT_DEADLINE_EXPIRED");

  return Object.freeze({ ok: true, fingerprint, deadline: normalized.deadline_ms });
}

module.exports = Object.freeze({
  AUTHORITY_MAX_TTL_MS,
  AUTHORITY_MIN_TTL_MS,
  AUTHORITY_SIGNED_FIELDS,
  AUTHORITY_SKEW_TOLERANCE_MS,
  FORBIDDEN_SIGNED_FIELDS,
  PERMIT_CATEGORY,
  buildDesktopAuthorityMessage,
  signDesktopAuthorityPermit,
  verifyDesktopAuthorityPermit,
});

