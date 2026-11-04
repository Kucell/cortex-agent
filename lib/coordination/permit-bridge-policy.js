"use strict";

// ─── Permit Bridge Policy (M-053 / MS-008 第 9 环阶段 C) ──────────────────
//
// WHY THIS MODULE EXISTS
//   `permit-authority-service.js` says, in its own contract comment:
//
//     "The transport owns peer authentication and must supply an opaque
//      verified context; this function neither creates a listener nor
//      authenticates a peer."
//
//   The bridge IS that transport. `dispatch(peer, action, args)` calls
//   `authorize(peer, action, request)` and proceeds when it returns exactly
//   `true`:
//
//     if (authorized !== true) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
//
//   So the moment `authorize` returns true, the request is executed. A policy
//   that does not bind the peer to anything means that whoever can reach the
//   endpoint can issue permits.
//
// WHAT THIS MODULE DECIDES
//   The policy binds three things, all of them from trusted host state:
//
//   1. PEER IDENTITY — the peer must be a verified managed-session identity
//      (the object `managed-caller-session.js` produced after the secret-pipe
//      handshake and the identity audits). It is NOT an arbitrary object
//      the caller passes in, and it is NOT a network address.
//   2. ACTION ALLOW-LIST — each bridge side grants a different subset of the
//      five actions. The issuing side may issue; the target side may
//      register, fetch keys, verify and revoke. Neither side gets the whole
//      set: `dispatch` on the issuing side has no target service at all, so
//      an allow-list that named every action would be a lie about what the
//      side can actually do.
//   3. REQUEST CONSISTENCY — the request must match the shape the action
//      requires, and it must not carry private key material. A policy that
//      only checked the peer would still let a verified peer smuggle a
//      private key into the store.
//
// WHY THE IDENTITY IS FROZEN AND COMPARED FIELD BY FIELD
//   `managed-caller-session.js` keeps the identity in a private class field
//   precisely so that no property access can replace it. The policy therefore
//   does not merely check "is there an identity object" — it compares the
//   observed facts against the values the host pinned when the session was
//   established. A peer that can write to the identity object (or that
//   presents a different session's identity) is refused.
//
// FAIL-CLOSED
//   Every rejection is a refusal to authorize, and a refusal is always
//   `false`. Nothing here throws for a policy decision: `dispatch` only
//   distinguishes "authorized" from "not authorized", and an exception
//   thrown from `authorize` is converted into `ERR_PERMIT_INPUT_INVALID` by
//   the caller anyway. Returning `false` keeps the decision total and
//   avoids turning a policy miss into an error that looks like a transport
//   fault.

const { CoordinationError } = require("./errors");

// The six actions `permit-authority-service.dispatch` accepts.
const ALL_ACTIONS = Object.freeze(["issue", "revocation-list", "register", "key", "verify", "revoke"]);

// The issuing side signs permits AND publishes the revocation list. It has
// no target service, so the other four actions cannot succeed there even if
// they were allowed.
//
// `revocation-list` is on the issuing side because the issuer is the party
// that KNOWS which batch keys are revoked: the target side only holds the
// mirror image of that fact in its PIN domain. Letting the target publish
// the list would let a target decide what the issuer's keys may sign.
const ISSUER_ACTIONS = Object.freeze(["issue", "revocation-list"]);

// The target side registers the batch key, publishes it, verifies signatures
// and applies revocation. It never issues: signing happens on the issuing
// side, and a target that could also sign would let one compromised host
// both mint and attest permits.
const TARGET_ACTIONS = Object.freeze(["register", "key", "verify", "revoke"]);

// The identity facts the policy compares. `sessionId` binds the peer to one
// session; `pid` plus `startToken` and `commandDigest` bind it to one
// process. The channel facts are deliberately NOT compared here: they are
// re-derived by the session's own audit on every dispatch, and pinning them
// in the policy would make the policy depend on a platform-specific shape
// (a unix socket pair on Linux/macOS, a kernel object on Windows).
const IDENTITY_FACTS = Object.freeze([
  "sessionId",
  "pid",
  "startToken",
  "commandDigest",
]);

// `pid` is a number in the identity object; the other three are strings.
const NUMERIC_IDENTITY_FACTS = Object.freeze(["pid"]);

// The private-key refusal. The CLI already refuses private material on the
// input side; the policy refuses it again on the request side, because the
// policy is the component that decides whether a request is allowed to
// reach the store at all.
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsPrivateMaterial(value) {
  if (typeof value === "string") {
    if (PRIVATE_KEY_PATTERN.test(value)) return true;
    // A key reference is a pointer to key material. It has no place in a
    // request that the bridge forwards, and its presence is a strong sign
    // that the caller is trying to name a key instead of using one.
    return /"privateKeyRef"\s*:/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsPrivateMaterial);
  if (isPlainObject(value)) {
    // A KEY whose NAME is `privateKeyRef` names key material even when its
    // value is an opaque handle. The name is the signal, not the value: the
    // handle would let the caller name a key the bridge did not select.
    if (Object.hasOwn(value, "privateKeyRef")) return true;
    return Object.values(value).some(containsPrivateMaterial);
  }
  return false;
}

// The per-action request shape. A request that does not match exactly is
// refused: the bridge never fills in a missing field, because a field the
// bridge invented is a field the peer chose.
const REQUEST_FIELDS = Object.freeze({
  issue: Object.freeze(["lease", "permit"]),
  // The revocation list is produced from the issuer's OWN state, so the
  // request carries no fields at all. An empty request shape is deliberate:
  // a request that could name fingerprints would let a peer ask for a list
  // that revokes a specific key, which is a management action, not a read.
  "revocation-list": Object.freeze([]),
  register: Object.freeze(["batchIdentity", "publicKeyPem", "sourceDigest", "deploymentDigest",
    "runId", "generation", "validFrom", "validUntil"]),
  key: Object.freeze(["fingerprint"]),
  verify: Object.freeze(["fingerprint", "message", "signature"]),
  revoke: Object.freeze([]),
});

function requestShapeMatches(action, request) {
  const required = REQUEST_FIELDS[action];
  if (!required) return false;
  if (!isPlainObject(request)) return false;
  const keys = Object.keys(request).sort();
  const expected = required.slice().sort();
  if (keys.length !== expected.length) return false;
  return keys.every((key, index) => key === expected[index]);
}

/**
 * Compare the peer's observed identity facts against the pinned ones.
 *
 * @param {object} identity The identity object the session produced.
 * @param {object} pinned The identity facts the host pinned at setup time.
 * @returns {boolean}
 */
function identityMatches(identity, pinned) {
  if (!isPlainObject(identity) || !isPlainObject(pinned)) return false;
  for (const fact of IDENTITY_FACTS) {
    // Every pinned fact must be present AND equal. A pinned fact that the
    // peer does not report is a fact the host could not confirm, and an
    // unconfirmable fact is treated as a mismatching one.
    if (!Object.hasOwn(pinned, fact)) return false;
    const expected = pinned[fact];
    const observed = identity[fact];
    if (NUMERIC_IDENTITY_FACTS.includes(fact)) {
      if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(observed)) return false;
    } else if (typeof expected !== "string" || typeof observed !== "string") {
      return false;
    }
    if (expected !== observed) return false;
  }
  return true;
}

/**
 * Build the bridge's authorize policy.
 *
 * @param {object} options
 * @param {string[]} options.actions The actions this bridge side allows.
 * @param {object} options.peerIdentity The pinned identity facts of the
 *   single peer this bridge is allowed to talk to.
 * @returns {(peer: object, action: string, request: object) => boolean}
 */
function createPermitBridgePolicy({ actions, peerIdentity } = {}) {
  if (!Array.isArray(actions) || !actions.length) {
    throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  for (const action of actions) {
    if (!ALL_ACTIONS.includes(action)) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  if (!isPlainObject(peerIdentity)) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");

  const allowed = new Set(actions);

  return function authorize(peer, action, request) {
    if (typeof action !== "string" || !allowed.has(action)) return false;
    if (!identityMatches(peer, peerIdentity)) return false;
    if (!requestShapeMatches(action, request)) return false;
    if (containsPrivateMaterial(request)) return false;
    return true;
  };
}

module.exports = Object.freeze({
  ALL_ACTIONS,
  ISSUER_ACTIONS,
  TARGET_ACTIONS,
  IDENTITY_FACTS,
  REQUEST_FIELDS,
  createPermitBridgePolicy,
  identityMatches,
  containsPrivateMaterial,
});
