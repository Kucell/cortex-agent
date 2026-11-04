"use strict";

const { CoordinationError } = require("./errors");

function freezeRequest(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeRequest(child);
    Object.freeze(value);
  }
  return value;
}

// The transport owns peer authentication and must supply an opaque verified
// context; this function neither creates a listener nor authenticates a peer.
//
// `revocationBatchSession` and `revocationStateSource` exist for the
// `revocation-list` action. They are SEPARATE from `batchSession` on purpose:
// the permit-issuing batch may itself be revoked, while the batch that signs
// the revocation list must never be. Using one batch for both would make a
// revocation list able to revoke its own signer, and the chain would deadlock
// the first time the issuer revoked its permit batch.
function createPermitAuthorityService({
  authorize,
  batchSession,
  targetService,
  revocationBatchSession,
  revocationStateSource,
} = {}) {
  if (typeof authorize !== "function") throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");

  function dispatch(peer, action, args) {
    if (!["issue", "revocation-list", "register", "key", "verify", "revoke"].includes(action) ||
        !args || typeof args !== "object" || Array.isArray(args)) {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    // Authorize and execute the same detached request, including its resource
    // bindings. The host still has to compare those bindings to trusted state.
    let request;
    try { request = freezeRequest(JSON.parse(JSON.stringify(args))); }
    catch { throw new CoordinationError("ERR_PERMIT_INPUT_INVALID"); }
    // Promise-like and non-boolean results are deliberately not accepted.
    let authorized;
    try { authorized = authorize(peer, action, request); }
    catch { throw new CoordinationError("ERR_PERMIT_INPUT_INVALID"); }
    if (authorized !== true) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    if (action === "issue") {
      if (!batchSession || typeof batchSession.issue !== "function") throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
      return batchSession.issue({ lease: request.lease, permit: request.permit });
    }
    if (action === "revocation-list") {
      // The list is produced from the ISSUER's own revocation record and
      // signed by the issuer's revocation batch — a batch that is NOT itself
      // revocable. Signing it with the permit-issuing batch would mean the
      // list could revoke its own signer, which `signRevocationList` refuses
      // (`ERR_REVOCATION_SIGNER_INVALID`): a single batch deadlocks.
      if (!revocationBatchSession || typeof revocationBatchSession.signRevocation !== "function") {
        throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
      }
      const state = revocationStateSource();
      if (!state || !Number.isSafeInteger(state.appliedRevocationSequence) ||
          !(state.revokedFingerprints instanceof Set)) {
        throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
      }
      // The fingerprints that go INTO the list are the ones the issuer has
      // revoked but has not yet published. The published list is signed at
      // `applied + 1`, and the issuer's own sequence advances when the list
      // is committed, so the two stay in step.
      return revocationBatchSession.signRevocation({
        state,
        fingerprints: [...state.revokedFingerprints],
      });
    }
    if (!targetService || typeof targetService[action] !== "function") {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    if (action === "key") return targetService.key(request.fingerprint);
    if (action === "revoke") return targetService.revoke();
    return targetService[action](request);
  }

  return Object.freeze({ dispatch });
}

module.exports = { createPermitAuthorityService };
