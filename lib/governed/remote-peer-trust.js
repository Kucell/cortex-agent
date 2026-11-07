"use strict";

// ─── Remote Peer Trust (M-053 / MS-008 P-009, C1) ──────────────────────────
//
// Independent primitives for the *remote* half of the cross-machine permit
// chain. They live next to the local managed-caller primitives on purpose and
// are deliberately NOT an extension of them.
//
// Why they cannot reuse the local session
// --------------------------------------
// `managed-caller-session.js` answers one narrow question: "is this request
// really from the child process I supervise?" It does that with an OS process
// handle, an inherited anonymous IPC channel and a session secret that never
// leaves a second pipe. None of those facts exist across a machine boundary:
// a remote peer has no handle, and a local fork session must never be used to
// impersonate a remote one. The design record makes that explicit: the remote
// path needs its own session type and its own opaque peer source.
//
// What this module guarantees
// ----------------------------
//  1. A trust configuration is validated before anything else happens. It
//     pins the instance, the audience, the signing key and the epoch, and it
//     refuses any time bound that is looser than the frozen ceilings.
//  2. A remote peer is produced only by `verifyRemoteFacts`, and only from a
//     fact set that passes every field check: signature, pinned key,
//     instance, epoch, host binding, connection binding, challenge, freshness,
//     clock skew and scope containment.
//  3. The produced peer is tagged `kind: "remote-peer"` and is a different
//     object type from the local managed caller identity, so the two can
//     never be substituted for one another by accident.
//  4. Every failure is a rejection with a stable code and the offending
//     field. There is no degraded or partial acceptance path.
//
// Approved decisions this implements
// ----------------------------------
//  - `D-M053-MS008-P009-R1-TRUSTED-W-OPEN` (A): W is the protected broker;
//    the fact signing key and the TLS key are separate purposes.
//  - `D-M053-MS008-P009-R2R3-CONNECTION-TOPOLOGY-OPEN` (A): each remote
//    request process holds its own proven connection.
//  - `D-M053-MS008-P009-R4-TRUSTED-CONTEXT-OPEN` (A): versioned, protected
//    deployment snapshot; self-reported values are rejected.
//  - `D-M053-MS008-P009-R5-TIMING-REVOCATION-OPEN` (A): the frozen time
//    bounds below, each of them clipped to the remaining lease/permit life.
//  - `D-M053-MS008-G0-CONNECTION-BINDING-BASIS-OPEN` (A): the keyholder signs
//    the handshake digest; the signer verifies with the pinned instance key.
//
// Hard boundaries
// ---------------
//  - No signing key material is created, read or stored here. Verification is
//    delegated to an injected verifier, so this module can be exercised
//    without a real key, a real TLS connection or a real machine.
//  - Nothing in this module authorizes an action. It only answers "is this a
//    real, current, correctly scoped remote peer on this connection?".

const crypto = require("node:crypto");

/**
 * The frozen time bounds, in milliseconds.
 *
 * These are the ceilings approved for the permit chain. A trust
 * configuration may tighten them but never loosen them: a configuration that
 * asks for a wider window is rejected rather than clamped, because silently
 * clamping would hide a misconfigured peer.
 */
const REMOTE_PEER_LIMIT = Object.freeze({
  handshakeTimeoutMs: 5_000,
  factMaxAgeMs: 1_000,
  ticketTtlMs: 2_000,
  requestTimeoutMs: 5_000,
  revocationMaxStalenessMs: 15_000,
  maxClockSkewMs: 2_000,
});

/** The only fact version this implementation understands. */
const REMOTE_FACT_VERSION = 1;

/** Stable rejection codes. Every refusal reports one of these. */
const REMOTE_PEER_REJECTION = Object.freeze({
  TRUST_CONFIG_INVALID: "TRUST_CONFIG_INVALID",
  TRUST_FIELD_MISSING: "TRUST_FIELD_MISSING",
  TRUST_INSTANCE_MISMATCH: "TRUST_INSTANCE_MISMATCH",
  TRUST_KEY_NOT_PINNED: "TRUST_KEY_NOT_PINNED",
  TRUST_EPOCH_INVALID: "TRUST_EPOCH_INVALID",
  TRUST_NOT_YET_VALID: "TRUST_NOT_YET_VALID",
  TRUST_EXPIRED: "TRUST_EXPIRED",
  TRUST_LIMIT_INVALID: "TRUST_LIMIT_INVALID",
  TRUST_LIMIT_EXCEEDED: "TRUST_LIMIT_EXCEEDED",
  TRUST_SCOPE_EMPTY: "TRUST_SCOPE_EMPTY",
  REMOTE_FACT_MALFORMED: "REMOTE_FACT_MALFORMED",
  REMOTE_FACT_FIELD_MISSING: "REMOTE_FACT_FIELD_MISSING",
  REMOTE_FACT_VERSION_UNSUPPORTED: "REMOTE_FACT_VERSION_UNSUPPORTED",
  REMOTE_FACT_SIGNATURE_INVALID: "REMOTE_FACT_SIGNATURE_INVALID",
  REMOTE_FACT_KEY_NOT_PINNED: "REMOTE_FACT_KEY_NOT_PINNED",
  REMOTE_FACT_INSTANCE_MISMATCH: "REMOTE_FACT_INSTANCE_MISMATCH",
  REMOTE_FACT_EPOCH_MISMATCH: "REMOTE_FACT_EPOCH_MISMATCH",
  REMOTE_FACT_HOST_UNBOUND: "REMOTE_FACT_HOST_UNBOUND",
  REMOTE_FACT_CONNECTION_MISMATCH: "REMOTE_FACT_CONNECTION_MISMATCH",
  REMOTE_FACT_CONNECTION_KEY_MISMATCH: "REMOTE_FACT_CONNECTION_KEY_MISMATCH",
  REMOTE_FACT_CHALLENGE_MISMATCH: "REMOTE_FACT_CHALLENGE_MISMATCH",
  REMOTE_FACT_STALE: "REMOTE_FACT_STALE",
  REMOTE_FACT_CLOCK_SKEW: "REMOTE_FACT_CLOCK_SKEW",
  REMOTE_FACT_EXPIRED: "REMOTE_FACT_EXPIRED",
  REMOTE_FACT_WINDOW_EXCEEDED: "REMOTE_FACT_WINDOW_EXCEEDED",
  REMOTE_FACT_SCOPE_ESCALATION: "REMOTE_FACT_SCOPE_ESCALATION",
});

/**
 * A rejection. The code is stable so that a caller can assert on it, and the
 * field names the exact input that was refused.
 */
class RemotePeerRejectedError extends Error {
  constructor(code, field, message) {
    super(field ? `${code} [${field}]: ${message}` : `${code}: ${message}`);
    this.name = "RemotePeerRejectedError";
    this.code = code;
    this.field = field || null;
  }
}

function reject(code, field, message) {
  throw new RemotePeerRejectedError(code, field, message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, field, code) {
  if (typeof value !== "string" || value.length === 0) {
    reject(code || REMOTE_PEER_REJECTION.TRUST_FIELD_MISSING, field, "expected a non-empty string");
  }
  return value;
}

function requireInteger(value, field, code) {
  if (!Number.isInteger(value)) {
    reject(code || REMOTE_PEER_REJECTION.TRUST_FIELD_MISSING, field, "expected an integer");
  }
  return value;
}

function requireScope(value, field, code) {
  if (!Array.isArray(value) || value.length === 0) {
    reject(code || REMOTE_PEER_REJECTION.TRUST_SCOPE_EMPTY, field, "expected a non-empty array of action names");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      reject(code || REMOTE_PEER_REJECTION.TRUST_SCOPE_EMPTY, field, "scope entries must be non-empty strings");
    }
  }
  return Object.freeze([...new Set(value)]);
}

/**
 * Canonical bytes a fact signature is computed over.
 *
 * The signature field itself is excluded, and the key order is fixed, so the
 * signer and the verifier always agree on the exact byte string.
 */
function canonicalizeRemoteFacts(facts) {
  if (!isPlainObject(facts)) {
    reject(REMOTE_PEER_REJECTION.REMOTE_FACT_MALFORMED, "facts", "expected an object");
  }
  const payload = { ...facts };
  delete payload.signature;
  return JSON.stringify([
    payload.factVersion,
    payload.instanceId,
    payload.runId,
    payload.generationText,
    payload.epoch,
    payload.scope,
    payload.challenge,
    payload.issuedAtMs,
    payload.expiresAtMs,
    payload.signerKeyId,
    payload.host,
    payload.connection,
  ]);
}

/** Stable digest of a fact set, used as the peer identity fingerprint. */
function digestRemoteFacts(facts) {
  return crypto.createHash("sha256").update(canonicalizeRemoteFacts(facts)).digest("hex");
}

/** True when every action of `scope` is contained in `allowed`. */
function scopeContains(scope, allowed) {
  const allow = new Set(Array.isArray(allowed) ? allowed : []);
  return Array.isArray(scope) && scope.every((action) => allow.has(action));
}

/**
 * Validate a trust configuration.
 *
 * @param {object} trust The pinned configuration for one remote instance.
 * @param {object} [options]
 * @param {number} [options.nowMs] Current time, for the validity window.
 * @returns {object} A frozen, normalized copy of the configuration.
 */
function validateRemoteTrustConfig(trust, options = {}) {
  if (!isPlainObject(trust)) {
    reject(REMOTE_PEER_REJECTION.TRUST_CONFIG_INVALID, "trust", "expected an object");
  }
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const instanceId = requireString(trust.instanceId, "trust.instanceId");
  const audience = requireString(trust.audience, "trust.audience");
  const peerScope = requireScope(trust.peerScope, "trust.peerScope");

  const pinnedKey = trust.pinnedKey;
  if (!isPlainObject(pinnedKey)) {
    reject(REMOTE_PEER_REJECTION.TRUST_KEY_NOT_PINNED, "trust.pinnedKey", "expected a pinned key object");
  }
  const keyId = requireString(pinnedKey.keyId, "trust.pinnedKey.keyId", REMOTE_PEER_REJECTION.TRUST_KEY_NOT_PINNED);
  const keyDigest = requireString(
    pinnedKey.keyDigest,
    "trust.pinnedKey.keyDigest",
    REMOTE_PEER_REJECTION.TRUST_KEY_NOT_PINNED,
  );

  const epoch = requireInteger(trust.epoch, "trust.epoch", REMOTE_PEER_REJECTION.TRUST_EPOCH_INVALID);
  if (epoch < 0) {
    reject(REMOTE_PEER_REJECTION.TRUST_EPOCH_INVALID, "trust.epoch", "epoch must not be negative");
  }

  const notBeforeMs = requireInteger(trust.notBeforeMs, "trust.notBeforeMs");
  const expiresAtMs = requireInteger(trust.expiresAtMs, "trust.expiresAtMs");
  if (expiresAtMs <= notBeforeMs) {
    reject(REMOTE_PEER_REJECTION.TRUST_CONFIG_INVALID, "trust.expiresAtMs", "expiry must be after the validity start");
  }
  if (nowMs < notBeforeMs) {
    reject(REMOTE_PEER_REJECTION.TRUST_NOT_YET_VALID, "trust.notBeforeMs", "trust configuration is not valid yet");
  }
  if (nowMs >= expiresAtMs) {
    reject(REMOTE_PEER_REJECTION.TRUST_EXPIRED, "trust.expiresAtMs", "trust configuration has expired");
  }

  const limits = isPlainObject(trust.limits) ? trust.limits : {};
  const normalizedLimits = {};
  for (const [name, ceiling] of Object.entries(REMOTE_PEER_LIMIT)) {
    const value = limits[name];
    if (!Number.isInteger(value) || value <= 0) {
      reject(REMOTE_PEER_REJECTION.TRUST_LIMIT_INVALID, `trust.limits.${name}`, "expected a positive integer");
    }
    if (value > ceiling) {
      reject(
        REMOTE_PEER_REJECTION.TRUST_LIMIT_EXCEEDED,
        `trust.limits.${name}`,
        `value ${value} exceeds the frozen ceiling ${ceiling}`,
      );
    }
    normalizedLimits[name] = value;
  }

  return Object.freeze({
    instanceId,
    audience,
    peerScope,
    pinnedKey: Object.freeze({ keyId, keyDigest }),
    epoch,
    notBeforeMs,
    expiresAtMs,
    limits: Object.freeze(normalizedLimits),
  });
}

/**
 * Verify a signed fact set and produce an opaque remote peer.
 *
 * @param {object} params
 * @param {object} params.facts The signed fact set from the remote side.
 * @param {object} params.trust The pinned trust configuration.
 * @param {object} params.connection The live connection the facts must bind to.
 * @param {string} params.expectedChallenge The outstanding challenge nonce.
 * @param {number} [params.nowMs] Current time.
 * @param {Function} params.verifySignature Verifier injected by the caller:
 *   `({ keyId, payload, signature }) => boolean`. No key material exists here.
 * @returns {object} A frozen `VerifiedRemotePeer`.
 */
function verifyRemoteFacts(params) {
  const { facts, trust, connection, expectedChallenge, verifySignature } = params || {};
  const nowMs = Number.isFinite(params && params.nowMs) ? params.nowMs : Date.now();

  if (!isPlainObject(facts)) {
    reject(REMOTE_PEER_REJECTION.REMOTE_FACT_MALFORMED, "facts", "expected an object");
  }
  if (typeof verifySignature !== "function") {
    reject(REMOTE_PEER_REJECTION.TRUST_CONFIG_INVALID, "verifySignature", "a signature verifier must be injected");
  }
  if (!isPlainObject(connection)) {
    reject(REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_MISMATCH, "connection", "expected the live connection binding");
  }

  if (facts.factVersion !== REMOTE_FACT_VERSION) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_VERSION_UNSUPPORTED,
      "facts.factVersion",
      `unsupported fact version ${String(facts.factVersion)}`,
    );
  }

  const signerKeyId = requireString(
    facts.signerKeyId,
    "facts.signerKeyId",
    REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING,
  );
  const instanceId = requireString(
    facts.instanceId,
    "facts.instanceId",
    REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING,
  );
  const runId = requireString(facts.runId, "facts.runId", REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING);
  const generationText = requireString(
    facts.generationText,
    "facts.generationText",
    REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING,
  );
  requireString(facts.challenge, "facts.challenge", REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING);
  requireString(facts.signature, "facts.signature", REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING);
  requireInteger(facts.issuedAtMs, "facts.issuedAtMs", REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING);
  requireInteger(facts.expiresAtMs, "facts.expiresAtMs", REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING);
  requireInteger(facts.epoch, "facts.epoch", REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING);

  const host = facts.host;
  if (!isPlainObject(host)) {
    reject(REMOTE_PEER_REJECTION.REMOTE_FACT_HOST_UNBOUND, "facts.host", "expected the host process binding");
  }
  requireInteger(host.pid, "facts.host.pid", REMOTE_PEER_REJECTION.REMOTE_FACT_HOST_UNBOUND);
  requireString(host.startToken, "facts.host.startToken", REMOTE_PEER_REJECTION.REMOTE_FACT_HOST_UNBOUND);
  requireString(host.commandDigest, "facts.host.commandDigest", REMOTE_PEER_REJECTION.REMOTE_FACT_HOST_UNBOUND);

  const factConnection = facts.connection;
  if (!isPlainObject(factConnection)) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_MISMATCH,
      "facts.connection",
      "expected the connection binding",
    );
  }
  requireString(
    factConnection.connectionId,
    "facts.connection.connectionId",
    REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_MISMATCH,
  );
  requireString(
    factConnection.tlsPublicKeyDigest,
    "facts.connection.tlsPublicKeyDigest",
    REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_KEY_MISMATCH,
  );

  // ── Trust matching ───────────────────────────────────────────────────────
  if (instanceId !== trust.instanceId) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_INSTANCE_MISMATCH,
      "facts.instanceId",
      "the facts were produced for a different instance",
    );
  }
  if (facts.epoch !== trust.epoch) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_EPOCH_MISMATCH,
      "facts.epoch",
      `fact epoch ${facts.epoch} does not match the pinned epoch ${trust.epoch}`,
    );
  }
  if (signerKeyId !== trust.pinnedKey.keyId) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_KEY_NOT_PINNED,
      "facts.signerKeyId",
      "the facts were signed by a key that is not pinned for this instance",
    );
  }

  // ── Signature ────────────────────────────────────────────────────────────
  let signatureOk = false;
  try {
    signatureOk = verifySignature({
      keyId: signerKeyId,
      payload: canonicalizeRemoteFacts(facts),
      signature: facts.signature,
    }) === true;
  } catch (_) {
    signatureOk = false;
  }
  if (!signatureOk) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_SIGNATURE_INVALID,
      "facts.signature",
      "the fact signature did not verify",
    );
  }

  // ── Connection binding ───────────────────────────────────────────────────
  if (factConnection.connectionId !== connection.connectionId) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_MISMATCH,
      "facts.connection.connectionId",
      "the facts are bound to a different connection",
    );
  }
  if (factConnection.tlsPublicKeyDigest !== connection.tlsPublicKeyDigest) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_KEY_MISMATCH,
      "facts.connection.tlsPublicKeyDigest",
      "the facts are bound to a different TLS key",
    );
  }

  // ── Challenge (anti-replay of the handshake) ────────────────────────────
  if (facts.challenge !== expectedChallenge) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_CHALLENGE_MISMATCH,
      "facts.challenge",
      "the facts do not answer the outstanding challenge",
    );
  }

  // ── Freshness and clock skew ─────────────────────────────────────────────
  if (facts.issuedAtMs - nowMs > trust.limits.maxClockSkewMs) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_CLOCK_SKEW,
      "facts.issuedAtMs",
      "the facts are dated too far in the future",
    );
  }
  if (nowMs - facts.issuedAtMs > trust.limits.factMaxAgeMs) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_STALE,
      "facts.issuedAtMs",
      "the facts are older than the accepted fact age",
    );
  }
  if (facts.expiresAtMs <= nowMs) {
    reject(REMOTE_PEER_REJECTION.REMOTE_FACT_EXPIRED, "facts.expiresAtMs", "the facts have expired");
  }
  if (facts.expiresAtMs - facts.issuedAtMs > trust.limits.factMaxAgeMs) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_WINDOW_EXCEEDED,
      "facts.expiresAtMs",
      "the validity window of the facts is wider than the accepted fact age",
    );
  }

  // ── Scope containment ────────────────────────────────────────────────────
  const scope = requireScope(facts.scope, "facts.scope", REMOTE_PEER_REJECTION.REMOTE_FACT_SCOPE_ESCALATION);
  if (!scopeContains(scope, trust.peerScope)) {
    reject(
      REMOTE_PEER_REJECTION.REMOTE_FACT_SCOPE_ESCALATION,
      "facts.scope",
      "the facts claim actions that the trust configuration does not grant",
    );
  }

  const factsDigest = digestRemoteFacts(facts);
  return Object.freeze({
    kind: "remote-peer",
    peerId: `remote-${factsDigest.slice(0, 16)}`,
    instanceId,
    runId,
    generationText,
    scope,
    epoch: facts.epoch,
    connectionId: factConnection.connectionId,
    host: Object.freeze({ pid: host.pid, startToken: host.startToken, commandDigest: host.commandDigest }),
    factsDigest,
    verifiedAtMs: nowMs,
  });
}

module.exports = {
  REMOTE_FACT_VERSION,
  REMOTE_PEER_LIMIT,
  REMOTE_PEER_REJECTION,
  RemotePeerRejectedError,
  canonicalizeRemoteFacts,
  digestRemoteFacts,
  scopeContains,
  validateRemoteTrustConfig,
  verifyRemoteFacts,
};
