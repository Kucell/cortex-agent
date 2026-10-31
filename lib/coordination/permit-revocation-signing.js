"use strict";

const { canonicalBytes, publicKeyFingerprint } = require("./permit-delivery");
const { CoordinationError } = require("./errors");
const crypto = require("node:crypto");

// This only signs an envelope; a protected service must own the key and
// provide an authenticated, current revocation state.
function signRevocationList({ privateKeyRef, publicKeyPem, state, fingerprints, issuedAtMs }) {
  if (!privateKeyRef || typeof privateKeyRef.sign !== "function" ||
      !state || !Number.isSafeInteger(state.appliedRevocationSequence) ||
      state.appliedRevocationSequence < 0 ||
      !Number.isSafeInteger(state.appliedRevocationSequence + 1) ||
      !(state.revokedFingerprints instanceof Set) || !Array.isArray(fingerprints) ||
      !Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
    throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  const signer = publicKeyFingerprint(publicKeyPem);
  if (state.revokedFingerprints.has(signer)) throw new CoordinationError("ERR_REVOCATION_SIGNER_INVALID");
  const incoming = new Set(fingerprints);
  if (incoming.size !== fingerprints.length ||
      fingerprints.some((fingerprint) => typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) {
    throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  for (const fingerprint of state.revokedFingerprints) {
    if (!incoming.has(fingerprint)) throw new CoordinationError("ERR_REVOCATION_SET_NOT_MONOTONIC");
  }
  const message = {
    revocation_sequence: state.appliedRevocationSequence + 1,
    revoked_fingerprints: [...incoming].sort(),
    issued_at_ms: issuedAtMs,
    prev_revocation_sequence: state.appliedRevocationSequence,
    batch_public_key_fingerprint: signer,
  };
  const bytes = canonicalBytes(message);
  const signature = privateKeyRef.sign(bytes);
  if (!Buffer.isBuffer(signature) || !crypto.verify(null, bytes, publicKeyPem, signature)) {
    throw new CoordinationError("ERR_REVOCATION_SIGNER_INVALID");
  }
  return { ...message, signature: signature.toString("base64") };
}

module.exports = { signRevocationList };
