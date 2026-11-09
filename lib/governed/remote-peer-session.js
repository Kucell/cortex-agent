"use strict";

// ─── Remote Peer Session (M-053 / MS-008 P-009, C1) ────────────────────────
//
// The remote counterpart of managed-caller-session.js. It owns the life of
// one proven remote connection: the challenge handshake, the opaque
// VerifiedRemotePeer, the direction and replay rules for the requests that
// arrive over it, and the per-call authority check that has to pass before
// any request may reach a signing path.
//
// What this module guarantees
// ----------------------------
//  1. A session only exists on one connection. The connection id and the TLS
//     key digest are bound at begin() and every later fact must match them.
//  2. The handshake challenge is single use and expires on the frozen
//     handshake bound. A second presentation of the same facts fails.
//  3. Requests are bound to the connection and to the peer, carry a strictly
//     increasing sequence number, and can be presented only once. The replay
//     registry never evicts: when it is full the session fails closed
//     instead of forgetting an old request and accepting it again.
//  4. Tickets are issued by this session, bound to the peer and the
//     connection, expire on the frozen ticket bound, and can be consumed at
//     most once.
//  5. assertPerCallAuthority() is the gate that has to run for every single
//     call. It re-checks the session state, the peer epoch, the authority
//     lease and its fencing token, the revocation freshness and the ticket,
//     so a decision taken once for a connection cannot be reused after the
//     authority changed.
//  6. Loss of the session is terminal. There is no degraded mode in which
//     requests are served without a verified peer.
//
// Approved decisions this implements
// ----------------------------------
//  - D-M053-MS008-P009-R2R3-CONNECTION-TOPOLOGY-OPEN (A): one proven
//    connection per remote request process.
//  - D-M053-MS008-P009-R5-TIMING-REVOCATION-OPEN (A): the frozen bounds and
//    the requirement to clip every deadline to the remaining authority
//    lifetime.
//  - D-M053-MS008-G0-A-SCOPE-NARROW-OPEN (B): the .NET side connects
//    directly, the Node side is delegated; both end up here as scoped peers.
//
// Hard boundaries
// ---------------
//  - This module never signs, never issues a permit and never talks to a
//    socket. It is the policy half of the remote path; the transport half is
//    wired by the assembly layer that is still under review.
//  - No real key, certificate or machine is needed to exercise it, so the
//    whole rejection matrix can be tested on one host.

const crypto = require("node:crypto");

const {
  REMOTE_PEER_REJECTION,
  RemotePeerRejectedError,
  validateRemoteTrustConfig,
  verifyRemoteFacts,
} = require("./remote-peer-trust");

/** The life of a remote session. The transitions are one way. */
const REMOTE_SESSION_STATE = Object.freeze({
  STOPPED: "stopped",
  STARTING: "starting",
  ESTABLISHED: "established",
  DRAINING: "draining",
  CLOSED: "closed",
});

/** Stable rejection codes for the session and the authority gate. */
const REMOTE_SESSION_REJECTION = Object.freeze({
  REMOTE_SESSION_INVALID_STATE: "REMOTE_SESSION_INVALID_STATE",
  REMOTE_SESSION_ALREADY_STARTED: "REMOTE_SESSION_ALREADY_STARTED",
  REMOTE_SESSION_CONNECTION_INVALID: "REMOTE_SESSION_CONNECTION_INVALID",
  REMOTE_HANDSHAKE_TIMEOUT: "REMOTE_HANDSHAKE_TIMEOUT",
  REMOTE_HANDSHAKE_CONSUMED: "REMOTE_HANDSHAKE_CONSUMED",
  REMOTE_REQUEST_REPLAY: "REMOTE_REQUEST_REPLAY",
  REMOTE_REQUEST_UNKNOWN: "REMOTE_REQUEST_UNKNOWN",
  REMOTE_REQUEST_SEQUENCE: "REMOTE_REQUEST_SEQUENCE",
  REMOTE_REQUEST_PAYLOAD_MISMATCH: "REMOTE_REQUEST_PAYLOAD_MISMATCH",
  REMOTE_ACTION_OUT_OF_SCOPE: "REMOTE_ACTION_OUT_OF_SCOPE",
  REMOTE_REPLAY_REGISTRY_FULL: "REMOTE_REPLAY_REGISTRY_FULL",
  REMOTE_TICKET_UNKNOWN: "REMOTE_TICKET_UNKNOWN",
  REMOTE_TICKET_REPLAY: "REMOTE_TICKET_REPLAY",
  REMOTE_TICKET_ACTION_MISMATCH: "REMOTE_TICKET_ACTION_MISMATCH",
  REMOTE_TICKET_EXPIRED: "REMOTE_TICKET_EXPIRED",
  REMOTE_TICKET_TTL_EXCEEDED: "REMOTE_TICKET_TTL_EXCEEDED",
  REMOTE_TICKET_PEER_MISMATCH: "REMOTE_TICKET_PEER_MISMATCH",
  REMOTE_TICKET_CONNECTION_MISMATCH: "REMOTE_TICKET_CONNECTION_MISMATCH",
  REMOTE_AUTHORITY_NOT_HELD: "REMOTE_AUTHORITY_NOT_HELD",
  REMOTE_AUTHORITY_EPOCH_MISMATCH: "REMOTE_AUTHORITY_EPOCH_MISMATCH",
  REMOTE_AUTHORITY_FENCING_MISMATCH: "REMOTE_AUTHORITY_FENCING_MISMATCH",
  REMOTE_AUTHORITY_LEASE_EXPIRED: "REMOTE_AUTHORITY_LEASE_EXPIRED",
  REMOTE_AUTHORITY_LIFETIME_TOO_SHORT: "REMOTE_AUTHORITY_LIFETIME_TOO_SHORT",
  REMOTE_AUTHORITY_ACTION_NOT_ALLOWED: "REMOTE_AUTHORITY_ACTION_NOT_ALLOWED",
  REMOTE_REVOCATION_STALE: "REMOTE_REVOCATION_STALE",
  REMOTE_REQUEST_DEADLINE_PASSED: "REMOTE_REQUEST_DEADLINE_PASSED",
  REMOTE_REQUEST_DEADLINE_EXCEEDED: "REMOTE_REQUEST_DEADLINE_EXCEEDED",
});

/** The replay registry is a hard bound: it fails closed instead of evicting. */
const DEFAULT_MAX_TRACKED_REQUESTS = 4_096;

function reject(code, field, message) {
  throw new RemotePeerRejectedError(code, field, message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digestPayload(payload) {
  const canonical = payload === undefined ? "\u0000undefined" : JSON.stringify(payload);
  return crypto.createHash("sha256").update(String(canonical)).digest("hex");
}

/**
 * One remote session on one proven connection.
 */
class RemotePeerSession {
  /**
   * @param {object} options
   * @param {object} options.trust The pinned trust configuration.
   * @param {Function} options.verifySignature Injected signature verifier.
   * @param {Function} [options.now] Clock, injected for deterministic tests.
   * @param {number} [options.maxTrackedRequests] Hard bound of the replay registry.
   */
  constructor(options = {}) {
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    this.trust = validateRemoteTrustConfig(options.trust, { nowMs: now() });
    if (typeof options.verifySignature !== "function") {
      reject(
        REMOTE_PEER_REJECTION.TRUST_CONFIG_INVALID,
        "verifySignature",
        "a signature verifier must be injected",
      );
    }
    this._verifySignature = options.verifySignature;
    this._now = now;
    this._maxTrackedRequests = Number.isInteger(options.maxTrackedRequests) && options.maxTrackedRequests > 0
      ? options.maxTrackedRequests
      : DEFAULT_MAX_TRACKED_REQUESTS;

    this.state = REMOTE_SESSION_STATE.STOPPED;
    this.connectionId = null;
    this.tlsPublicKeyDigest = null;
    this.peer = null;
    this.invalidatedReason = null;

    this._challenge = null;
    this._challengeExpiresAtMs = null;
    this._challengeConsumed = false;
    this._inboundSeq = 0;
    this._seenRequestIds = new Set();
    this._pendingRequests = new Map();
    this._tickets = new Map();
  }

  get established() {
    return this.state === REMOTE_SESSION_STATE.ESTABLISHED && this.peer !== null;
  }

  /**
   * Start the handshake on a proven connection and issue the challenge.
   *
   * @param {object} params
   * @param {string} params.connectionId The live connection identifier.
   * @param {string} params.tlsPublicKeyDigest The digest of the connection key.
   * @returns {object} The challenge handed to the remote side.
   */
  begin(params = {}) {
    if (this.state !== REMOTE_SESSION_STATE.STOPPED) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_SESSION_ALREADY_STARTED,
        "state",
        "a session in state " + this.state + " cannot be started again",
      );
    }
    const connectionId = params.connectionId;
    const tlsPublicKeyDigest = params.tlsPublicKeyDigest;
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_SESSION_CONNECTION_INVALID,
        "connectionId",
        "expected a non-empty connection identifier",
      );
    }
    if (typeof tlsPublicKeyDigest !== "string" || tlsPublicKeyDigest.length === 0) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_SESSION_CONNECTION_INVALID,
        "tlsPublicKeyDigest",
        "expected the digest of the connection key",
      );
    }

    this.state = REMOTE_SESSION_STATE.STARTING;
    this.connectionId = connectionId;
    this.tlsPublicKeyDigest = tlsPublicKeyDigest;
    this._challenge = crypto.randomBytes(16).toString("hex");
    this._challengeExpiresAtMs = this._now() + this.trust.limits.handshakeTimeoutMs;
    this._challengeConsumed = false;

    return Object.freeze({
      challenge: this._challenge,
      connectionId: this.connectionId,
      expiresAtMs: this._challengeExpiresAtMs,
      timeoutMs: this.trust.limits.handshakeTimeoutMs,
    });
  }

  /**
   * Verify the signed facts and establish the remote peer.
   *
   * @param {object} facts The signed fact set from the remote side.
   * @returns {object} The opaque VerifiedRemotePeer.
   */
  acceptFacts(facts) {
    if (this.state !== REMOTE_SESSION_STATE.STARTING) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
        "state",
        "facts cannot be accepted in state " + this.state,
      );
    }
    if (this._challengeConsumed || this._challenge === null) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_HANDSHAKE_CONSUMED,
        "challenge",
        "the handshake challenge was already consumed",
      );
    }
    const nowMs = this._now();
    if (nowMs >= this._challengeExpiresAtMs) {
      this.invalidate("handshake_timeout");
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_HANDSHAKE_TIMEOUT,
        "challenge",
        "the handshake challenge expired before the facts arrived",
      );
    }

    // The challenge is burned as soon as it is answered, before the facts are
    // verified. A fact set that does not verify must not be retried with the
    // same nonce, so a failed handshake cannot be turned into a second try.
    const answeredChallenge = this._challenge;
    this._challengeConsumed = true;
    this._challenge = null;

    const peer = verifyRemoteFacts({
      facts,
      trust: this.trust,
      connection: { connectionId: this.connectionId, tlsPublicKeyDigest: this.tlsPublicKeyDigest },
      expectedChallenge: answeredChallenge,
      nowMs,
      verifySignature: this._verifySignature,
    });

    this.peer = peer;
    this.state = REMOTE_SESSION_STATE.ESTABLISHED;
    return peer;
  }

  /**
   * Bind an inbound request to this session.
   *
   * @param {object} request
   * @param {string} request.requestId The request identifier.
   * @param {string} request.action The requested action.
   * @param {*} request.payload The request payload.
   * @param {number} request.seq The strictly increasing sequence number.
   * @returns {object} The bound request descriptor.
   */
  bindInboundRequest(request = {}) {
    if (!this.established) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
        "state",
        "requests are only accepted on an established session",
      );
    }
    const requestId = request.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      reject(
        REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING,
        "request.requestId",
        "expected a non-empty request identifier",
      );
    }
    if (this._seenRequestIds.has(requestId)) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_REPLAY,
        "request.requestId",
        "the request identifier was already used on this session",
      );
    }
    if (this._seenRequestIds.size >= this._maxTrackedRequests) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REPLAY_REGISTRY_FULL,
        "request.requestId",
        "the replay registry reached its hard bound; the session fails closed",
      );
    }
    const action = request.action;
    if (typeof action !== "string" || action.length === 0) {
      reject(
        REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING,
        "request.action",
        "expected a non-empty action name",
      );
    }
    if (!this.peer.scope.includes(action)) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_ACTION_OUT_OF_SCOPE,
        "request.action",
        "the peer is not scoped for this action",
      );
    }
    if (!Number.isInteger(request.seq)) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_SEQUENCE,
        "request.seq",
        "expected an integer sequence number",
      );
    }
    if (request.seq <= this._inboundSeq) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_SEQUENCE,
        "request.seq",
        "sequence " + request.seq + " does not advance past " + this._inboundSeq,
      );
    }

    this._inboundSeq = request.seq;
    this._seenRequestIds.add(requestId);
    const bound = Object.freeze({
      requestId,
      action,
      seq: request.seq,
      payloadDigest: digestPayload(request.payload),
      peerId: this.peer.peerId,
      connectionId: this.connectionId,
    });
    this._pendingRequests.set(requestId, bound);
    return bound;
  }

  /**
   * Complete a bound inbound request. The response must match the request it
   * answers in sequence and payload digest.
   */
  completeInboundRequest(request = {}) {
    const bound = this._pendingRequests.get(request.requestId);
    if (!bound) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_UNKNOWN,
        "request.requestId",
        "the request was never bound on this session",
      );
    }
    if (!Number.isInteger(request.seq) || request.seq !== bound.seq) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_SEQUENCE,
        "request.seq",
        "the response sequence does not match the request it answers",
      );
    }
    if (request.payloadDigest !== undefined && request.payloadDigest !== bound.payloadDigest) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_PAYLOAD_MISMATCH,
        "request.payloadDigest",
        "the response is bound to a different payload",
      );
    }
    this._pendingRequests.delete(request.requestId);
    return bound;
  }

  /**
   * Register a ticket that this session issues to its peer.
   *
   * The ticket is bound to the peer and to the connection, so a ticket that
   * is stolen and replayed on another connection is refused.
   */
  registerTicket(ticket = {}) {
    if (!this.established) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
        "state",
        "tickets are only issued on an established session",
      );
    }
    const ticketId = ticket.ticketId;
    if (typeof ticketId !== "string" || ticketId.length === 0) {
      reject(
        REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING,
        "ticket.ticketId",
        "expected a non-empty ticket identifier",
      );
    }
    if (this._tickets.has(ticketId)) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_REPLAY,
        "ticket.ticketId",
        "the ticket identifier was already registered",
      );
    }
    const action = ticket.action;
    if (typeof action !== "string" || action.length === 0 || !this.peer.scope.includes(action)) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_ACTION_OUT_OF_SCOPE,
        "ticket.action",
        "a ticket may only cover an action the peer is scoped for",
      );
    }
    const nowMs = this._now();
    if (!Number.isInteger(ticket.expiresAtMs)) {
      reject(
        REMOTE_PEER_REJECTION.REMOTE_FACT_FIELD_MISSING,
        "ticket.expiresAtMs",
        "expected an integer expiry",
      );
    }
    if (ticket.expiresAtMs <= nowMs) {
      reject(REMOTE_SESSION_REJECTION.REMOTE_TICKET_EXPIRED, "ticket.expiresAtMs", "the ticket is already expired");
    }
    if (ticket.expiresAtMs - nowMs > this.trust.limits.ticketTtlMs) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_TTL_EXCEEDED,
        "ticket.expiresAtMs",
        "the ticket lifetime exceeds the frozen bound " + this.trust.limits.ticketTtlMs + "ms",
      );
    }
    if (ticket.connectionId !== undefined && ticket.connectionId !== this.connectionId) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_CONNECTION_MISMATCH,
        "ticket.connectionId",
        "the ticket is bound to another connection",
      );
    }
    if (ticket.peerId !== undefined && ticket.peerId !== this.peer.peerId) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_PEER_MISMATCH,
        "ticket.peerId",
        "the ticket is bound to another peer",
      );
    }

    const registered = Object.freeze({
      ticketId,
      action,
      peerId: this.peer.peerId,
      connectionId: this.connectionId,
      expiresAtMs: ticket.expiresAtMs,
      consumed: false,
    });
    this._tickets.set(ticketId, registered);
    return registered;
  }

  /** Consume a registered ticket. A ticket is usable at most once. */
  consumeTicket(ticketId) {
    const ticket = this._tickets.get(ticketId);
    if (!ticket) {
      reject(REMOTE_SESSION_REJECTION.REMOTE_TICKET_UNKNOWN, "ticketId", "the ticket was never registered on this session");
    }
    if (ticket.consumed) {
      reject(REMOTE_SESSION_REJECTION.REMOTE_TICKET_REPLAY, "ticketId", "the ticket was already consumed");
    }
    if (ticket.expiresAtMs <= this._now()) {
      reject(REMOTE_SESSION_REJECTION.REMOTE_TICKET_EXPIRED, "ticketId", "the ticket has expired");
    }
    const consumed = Object.freeze({ ...ticket, consumed: true, consumedAtMs: this._now() });
    this._tickets.set(ticketId, consumed);
    return consumed;
  }

  /** Stop accepting new work and release the peer. */
  drain() {
    if (this.state === REMOTE_SESSION_STATE.CLOSED) return;
    this.state = REMOTE_SESSION_STATE.DRAINING;
    this.peer = null;
    this._pendingRequests.clear();
    this._tickets.clear();
  }

  /** Terminate the session. Terminal. */
  close() {
    this.state = REMOTE_SESSION_STATE.CLOSED;
    this.peer = null;
    this._challenge = null;
    this._pendingRequests.clear();
    this._tickets.clear();
  }

  /**
   * Invalidate the session because the peer identity or the connection
   * changed. The epoch of this session stops being usable immediately, and
   * every request and ticket that was still open is dropped.
   */
  invalidate(reason) {
    this.invalidatedReason = typeof reason === "string" && reason.length > 0 ? reason : "invalidated";
    this.peer = null;
    this._challenge = null;
    this._challengeConsumed = true;
    this._pendingRequests.clear();
    this._tickets.clear();
    this.state = REMOTE_SESSION_STATE.CLOSED;
  }
}

/**
 * The per-call authority gate.
 *
 * This is the check that has to run for every single call that may reach a
 * signing path. It never trusts the request body for identity: the peer comes
 * from the session, the scope comes from the verified peer, and the authority
 * facts come from the caller's own snapshot of the current authority state.
 *
 * @param {object} params
 * @param {RemotePeerSession} params.session The session the call belongs to.
 * @param {string} params.action The action being requested.
 * @param {object} [params.request] Optional binding: requestId, payloadDigest, ticketId, deadlineAtMs.
 * @param {object} params.authority The authority snapshot for this call.
 * @param {number} [params.nowMs] Current time.
 * @returns {object} A frozen record of the accepted call.
 */
function assertPerCallAuthority(params = {}) {
  const { session, action, request, authority } = params;
  const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();

  if (!(session instanceof RemotePeerSession)) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
      "session",
      "expected a remote peer session",
    );
  }
  if (!session.established) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
      "session.state",
      "the session is not established",
    );
  }
  if (!isPlainObject(authority)) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_NOT_HELD,
      "authority",
      "expected an authority snapshot",
    );
  }
  if (authority.authorityHeld !== true) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_NOT_HELD,
      "authority.authorityHeld",
      "the signing authority is not held",
    );
  }
  if (authority.epoch !== session.peer.epoch) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_EPOCH_MISMATCH,
      "authority.epoch",
      "the authority epoch " + authority.epoch + " does not match the peer epoch " + session.peer.epoch,
    );
  }
  if (
    authority.expectedLeaseFencing !== undefined
    && authority.leaseFencing !== authority.expectedLeaseFencing
  ) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_FENCING_MISMATCH,
      "authority.leaseFencing",
      "the lease fencing token does not match the expected one",
    );
  }
  if (!Number.isInteger(authority.leaseExpiresAtMs)) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_LEASE_EXPIRED,
      "authority.leaseExpiresAtMs",
      "expected an integer lease expiry",
    );
  }
  if (authority.leaseExpiresAtMs <= nowMs) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_LEASE_EXPIRED,
      "authority.leaseExpiresAtMs",
      "the authority lease has expired",
    );
  }
  if (!Array.isArray(authority.allowedActions) || !authority.allowedActions.includes(action)) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_ACTION_NOT_ALLOWED,
      "authority.allowedActions",
      "the authority does not allow this action",
    );
  }
  if (!session.peer.scope.includes(action)) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_ACTION_OUT_OF_SCOPE,
      "action",
      "the peer is not scoped for this action",
    );
  }
  if (!Number.isInteger(authority.revocationAppliedAtMs)) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_REVOCATION_STALE,
      "authority.revocationAppliedAtMs",
      "expected the moment the revocation list was last applied",
    );
  }
  if (nowMs - authority.revocationAppliedAtMs > session.trust.limits.revocationMaxStalenessMs) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_REVOCATION_STALE,
      "authority.revocationAppliedAtMs",
      "the revocation list is older than the accepted staleness bound",
    );
  }

  const binding = isPlainObject(request) ? request : {};
  if (binding.requestId !== undefined) {
    const bound = session._pendingRequests.get(binding.requestId);
    if (!bound) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_UNKNOWN,
        "request.requestId",
        "the request is not bound on this session",
      );
    }
    if (bound.action !== action) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_ACTION_MISMATCH,
        "request.action",
        "the call does not match the action of the bound request",
      );
    }
    if (binding.payloadDigest !== undefined && binding.payloadDigest !== bound.payloadDigest) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_PAYLOAD_MISMATCH,
        "request.payloadDigest",
        "the call does not match the payload of the bound request",
      );
    }
  }
  if (binding.deadlineAtMs !== undefined) {
    if (!Number.isInteger(binding.deadlineAtMs)) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_DEADLINE_PASSED,
        "request.deadlineAtMs",
        "expected an integer deadline",
      );
    }
    if (binding.deadlineAtMs <= nowMs) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_DEADLINE_PASSED,
        "request.deadlineAtMs",
        "the call deadline has passed",
      );
    }
    if (binding.deadlineAtMs - nowMs > session.trust.limits.requestTimeoutMs) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_REQUEST_DEADLINE_EXCEEDED,
        "request.deadlineAtMs",
        "the call deadline exceeds the frozen request bound",
      );
    }
  }
  if (binding.ticketId !== undefined) {
    const ticket = session._tickets.get(binding.ticketId);
    if (!ticket) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_UNKNOWN,
        "request.ticketId",
        "the ticket was never registered on this session",
      );
    }
    if (ticket.consumed) {
      reject(REMOTE_SESSION_REJECTION.REMOTE_TICKET_REPLAY, "request.ticketId", "the ticket was already consumed");
    }
    if (ticket.action !== action) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_ACTION_MISMATCH,
        "request.ticketId",
        "the ticket covers another action",
      );
    }
    if (ticket.connectionId !== session.connectionId) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_CONNECTION_MISMATCH,
        "request.ticketId",
        "the ticket is bound to another connection",
      );
    }
    if (ticket.peerId !== session.peer.peerId) {
      reject(
        REMOTE_SESSION_REJECTION.REMOTE_TICKET_PEER_MISMATCH,
        "request.ticketId",
        "the ticket is bound to another peer",
      );
    }
    if (ticket.expiresAtMs <= nowMs) {
      reject(REMOTE_SESSION_REJECTION.REMOTE_TICKET_EXPIRED, "request.ticketId", "the ticket has expired");
    }
  }

  // Every deadline is clipped to the remaining authority lifetime, so a call
  // may never outlive the lease that authorizes it.
  const authorityRemainingMs = authority.leaseExpiresAtMs - nowMs;
  if (binding.deadlineAtMs !== undefined && binding.deadlineAtMs - nowMs > authorityRemainingMs) {
    reject(
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_LIFETIME_TOO_SHORT,
      "request.deadlineAtMs",
      "the call would outlive the authority lease",
    );
  }

  return Object.freeze({
    peerId: session.peer.peerId,
    instanceId: session.peer.instanceId,
    connectionId: session.connectionId,
    epoch: session.peer.epoch,
    action,
    authorityLeaseFencing: authority.leaseFencing,
    checkedAtMs: nowMs,
  });
}

module.exports = {
  DEFAULT_MAX_TRACKED_REQUESTS,
  REMOTE_SESSION_REJECTION,
  REMOTE_SESSION_STATE,
  RemotePeerSession,
  assertPerCallAuthority,
};
