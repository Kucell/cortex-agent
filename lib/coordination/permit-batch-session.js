"use strict";

const delivery = require("./permit-delivery");
const { signRevocationList } = require("./permit-revocation-signing");
const { CoordinationError } = require("./errors");
const { validateReservationInput } = require("./protected-permit-store");

// Process-local primitive, not an authenticated service or a CLI endpoint.
// The caller owns the protected store, authorization and restart handling.
function createPermitBatchSession({ store, clock = Date.now } = {}) {
  if (!store || typeof store.acquire !== "function" || typeof store.reserve !== "function" ||
      typeof clock !== "function") throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  let key = delivery.createBatchKeyPair();
  delivery.assertNoPrivateKeyLeak({ privateKeyRef: key.privateKeyRef });

  function currentKey() {
    if (!key) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    return key;
  }

  function issue({ lease, permit } = {}) {
    const batch = currentKey();
    if (!lease || !permit || typeof lease !== "object" || typeof permit !== "object") {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    // An idempotent reserve may return a permit from an earlier batch.
    // Never sign it unless the store atomically binds the batch identity.
    if (typeof store.acquireAndReserveBoundToBatch !== "function") {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    const initialTime = clock();
    if (!Number.isSafeInteger(initialTime) || initialTime < 0) throw new CoordinationError("ERR_CLOCK_INVALID");
    validateReservationInput(permit);
    return store.acquireAndReserveBoundToBatch(lease, permit, batch.fingerprint, (reserved) => {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new CoordinationError("ERR_CLOCK_INVALID");
      if (!reserved || reserved.status !== "reserved" || !Number.isSafeInteger(reserved.deadline)) {
        throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
      }
      if (now >= reserved.deadline) throw new CoordinationError("ERR_PERMIT_DEADLINE_EXPIRED");
      const signed = delivery.buildSignedPermit({ privateKeyRef: batch.privateKeyRef,
        permit: reserved, issuedAtMs: now, nowMs: now });
      return { fingerprint: batch.fingerprint, publicKeyPem: batch.publicKeyPem, signedPermit: signed };
    });
  }

  function signRevocation({ state, fingerprints } = {}) {
    const batch = currentKey();
    return signRevocationList({ privateKeyRef: batch.privateKeyRef, publicKeyPem: batch.publicKeyPem,
      state, fingerprints, issuedAtMs: clock() });
  }

  return Object.freeze({
    issue,
    signRevocation,
    close() { key = null; },
  });
}

module.exports = { createPermitBatchSession };
