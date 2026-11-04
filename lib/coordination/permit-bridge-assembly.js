"use strict";

// ─── Permit Bridge Assembly (M-053 / MS-008 第 9 环阶段 C) ────────────────
//
// WHAT THIS MODULE IS
//   The assembly layer. The evidence for this ring established that the
//   permit chain was DELIVERED as libraries but had NO production caller:
//   `createPermitAuthorityService`, `createPermitBatchSession`,
//   `createPermitTargetService` and `startPermitManagedSession` had no
//   production entry point, and `lib/` contained no `createServer` at all.
//   So the missing pieces are an ASSEMBLY LAYER and a TRANSPORT, not more
//   business logic.
//
//   This module is the assembly layer. It wires:
//
//     HTTP request
//       -> the bridge policy (peer identity + action allow-list)
//       -> authority.dispatch(verifiedPeer, action, request)
//       -> the batch session (issue) or the target service (the rest)
//
// THE PEER IS AN ESTABLISHED FACT, NOT A REQUEST FIELD
//   `permit-authority-service.dispatch` requires the transport to supply an
//   opaque verified context. The verified context here is the identity of the
//   managed session the host established: the session secret travelled on a
//   dedicated pipe, the handshake proved the peer holds it, and the identity
//   facts were audited before and after each exchange.
//
//   The assembly therefore pins the peer's identity ONCE, when the session is
//   established, and the policy compares every later request against that
//   pin. A request body can never introduce or replace a peer.
//
// THE TWO SIDES ARE NOT INTERCHANGEABLE
//   `dispatch` checks its components lazily: `issue` needs `batchSession`,
//   the other four actions need `targetService`. So the issuing side is
//   assembled with a batch session and no target service, and the target side
//   with a target service and no batch session. Each side's policy allows
//   exactly the actions its components can serve. A side that allowed all five
//   would be claiming authority it does not have.
//
// WHY NOTHING HERE FILLS IN A MISSING FIELD
//   A bridge that completes a request is making a decision the request did
//   not carry. The permit's projection fields are part of the signed message,
//   and the evidence for this ring is explicit that a projection is not an
//   authorization. So the assembly forwards the request unchanged and lets
//   the components refuse it.

const { CoordinationError } = require("./errors");
const { createPermitAuthorityService } = require("./permit-authority-service");
const { createPermitBridgeEndpoint } = require("./permit-bridge-endpoint");
const {
  ISSUER_ACTIONS,
  TARGET_ACTIONS,
  createPermitBridgePolicy,
} = require("./permit-bridge-policy");

function fail(code) {
  throw new CoordinationError(code);
}

/**
 * The identity facts an assembly pins from an established session.
 *
 * The assembly copies them out of the session's identity object at setup
 * time and then compares against the copy. It does not hold a reference to
 * the session's identity object: the session keeps its identity in a private
 * field precisely so that no property access can replace it, and a policy
 * that re-read the live object would inherit whatever the object said at the
 * moment of the check rather than what it said when the peer was verified.
 *
 * @param {object} identity
 * @returns {object}
 */
function pinPeerIdentity(identity) {
  if (!identity || typeof identity !== "object") fail("ERR_PERMIT_INPUT_INVALID");
  const pinned = {};
  for (const fact of ["sessionId", "pid", "startToken", "commandDigest"]) {
    if (!Object.hasOwn(identity, fact)) fail("ERR_PERMIT_INPUT_INVALID");
    pinned[fact] = identity[fact];
  }
  if (typeof pinned.sessionId !== "string" || !pinned.sessionId) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(pinned.pid)) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof pinned.startToken !== "string" || !pinned.startToken) fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof pinned.commandDigest !== "string" || !pinned.commandDigest) fail("ERR_PERMIT_INPUT_INVALID");
  return Object.freeze(pinned);
}

/**
 * Assemble the ISSUING side of the bridge.
 *
 * The issuing side signs permits and publishes the revocation list. It holds
 * a permit batch session, a revocation batch session and no target service,
 * so `dispatch` can only serve `issue` and `revocation-list`.
 *
 * @param {object} options
 * @param {object} options.batchSession The batch session that signs.
 * @param {object} options.revocationBatchSession The batch session that signs
 *   the revocation list. It must NOT be the permit batch: a revocation list
 *   signed by a revocable batch could revoke its own signer.
 * @param {function} options.revocationStateSource Returns the issuer's own
 *   revocation state. It is a function, not a value, so the state is read
 *   at dispatch time rather than pinned at assembly time.
 * @param {object} options.peerIdentity The pinned identity of the peer.
 * @returns {object} The assembled issuing bridge.
 */
function assemblePermitIssuer({
  batchSession,
  revocationBatchSession,
  revocationStateSource,
  peerIdentity,
} = {}) {
  if (!batchSession || typeof batchSession.issue !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  if (!revocationBatchSession || typeof revocationBatchSession.signRevocation !== "function") {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  if (typeof revocationStateSource !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  const pinned = pinPeerIdentity(peerIdentity);

  const authorize = createPermitBridgePolicy({ actions: ISSUER_ACTIONS, peerIdentity: pinned });
  const authority = createPermitAuthorityService({
    authorize,
    batchSession,
    targetService: null,
    revocationBatchSession,
    revocationStateSource,
  });

  return Object.freeze({
    side: "issuer",
    authority,
    peerIdentity: pinned,
    actions: ISSUER_ACTIONS,
    // The peer handed to `dispatch` is the PINNED identity, never a value
    // that arrived with the request.
    perform(action, request) {
      return authority.dispatch(pinned, action, request);
    },
  });
}

/**
 * Assemble the TARGET side of the bridge.
 *
 * The target side registers the batch key, publishes it, verifies signatures
 * and applies revocation. It never issues.
 *
 * @param {object} options
 * @param {object} options.targetService The target service.
 * @param {object} options.peerIdentity The pinned identity of the peer.
 * @returns {object} The assembled target bridge.
 */
function assemblePermitTarget({ targetService, peerIdentity } = {}) {
  if (!targetService || typeof targetService.verify !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  const pinned = pinPeerIdentity(peerIdentity);

  const authorize = createPermitBridgePolicy({ actions: TARGET_ACTIONS, peerIdentity: pinned });
  const authority = createPermitAuthorityService({ authorize, batchSession: null, targetService });

  return Object.freeze({
    side: "target",
    authority,
    peerIdentity: pinned,
    actions: TARGET_ACTIONS,
    perform(action, request) {
      return authority.dispatch(pinned, action, request);
    },
  });
}

/**
 * Attach an HTTP endpoint to an assembled bridge.
 *
 * @param {object} options
 * @param {object} options.assembly One of the assemblies above.
 * @param {string} [options.action] The single action this endpoint forwards.
 * @param {string} [options.bindAddress] Must be loopback.
 * @param {number} [options.port]
 * @param {number} [options.requestTimeoutMs]
 * @param {function} [options.onDiagnostic]
 * @returns {object} The endpoint.
 */
function attachPermitBridgeEndpoint(options = {}) {
  const { assembly, ...rest } = options;
  if (!assembly || typeof assembly.perform !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  const action = rest.action || assembly.actions[0];
  if (!assembly.actions.includes(action)) fail("ERR_PERMIT_INPUT_INVALID");
  return createPermitBridgeEndpoint({ ...rest, action, perform: assembly.perform });
}

module.exports = Object.freeze({
  assemblePermitIssuer,
  assemblePermitTarget,
  attachPermitBridgeEndpoint,
  pinPeerIdentity,
});
