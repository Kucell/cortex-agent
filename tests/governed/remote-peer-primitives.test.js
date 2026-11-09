"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  REMOTE_PEER_LIMIT,
  REMOTE_PEER_REJECTION,
  canonicalizeRemoteFacts,
  validateRemoteTrustConfig,
  verifyRemoteFacts,
} = require("../../lib/governed/remote-peer-trust");

const {
  REMOTE_SESSION_REJECTION,
  REMOTE_SESSION_STATE,
  RemotePeerSession,
  assertPerCallAuthority,
} = require("../../lib/governed/remote-peer-session");

const SIGNING_SECRET = "remote-peer-primitives-test-secret";
const CONNECTION_ID = "conn-1";
const TLS_DIGEST = "tls-key-digest-1";
const ACTION = "permit.issue";

let clockNow = 1_700_000_000_000;
const clock = () => clockNow;

function sign(payload) {
  return crypto.createHmac("sha256", SIGNING_SECRET).update(payload).digest("hex");
}

function verifySignature({ payload, signature }) {
  if (typeof payload !== "string" || typeof signature !== "string") return false;
  const expected = Buffer.from(sign(payload), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(expected, given);
}

function makeTrust(overrides = {}) {
  return {
    instanceId: "samhmi-instance-1",
    audience: "permit-signing",
    peerScope: [ACTION],
    pinnedKey: { keyId: "w-key-1", keyDigest: "w-key-digest-1" },
    epoch: 7,
    notBeforeMs: clockNow - 1_000,
    expiresAtMs: clockNow + 600_000,
    limits: {
      handshakeTimeoutMs: REMOTE_PEER_LIMIT.handshakeTimeoutMs,
      factMaxAgeMs: REMOTE_PEER_LIMIT.factMaxAgeMs,
      ticketTtlMs: REMOTE_PEER_LIMIT.ticketTtlMs,
      requestTimeoutMs: REMOTE_PEER_LIMIT.requestTimeoutMs,
      revocationMaxStalenessMs: REMOTE_PEER_LIMIT.revocationMaxStalenessMs,
      maxClockSkewMs: REMOTE_PEER_LIMIT.maxClockSkewMs,
    },
    ...overrides,
  };
}

function makeFacts(overrides = {}, trust = makeTrust()) {
  const facts = {
    factVersion: 1,
    instanceId: trust.instanceId,
    runId: "run-1",
    generationText: "gen-text-1",
    epoch: trust.epoch,
    scope: [ACTION],
    challenge: "challenge-1",
    issuedAtMs: clockNow,
    expiresAtMs: clockNow + 500,
    signerKeyId: trust.pinnedKey.keyId,
    host: { pid: 4242, startToken: "start-token-1", commandDigest: "cmd-digest-1" },
    connection: { connectionId: CONNECTION_ID, tlsPublicKeyDigest: TLS_DIGEST },
    ...overrides,
  };
  facts.signature = sign(canonicalizeRemoteFacts(facts));
  return facts;
}

function rejectionCode(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error && error.name === "RemotePeerRejectedError",
      "expected a RemotePeerRejectedError, got " + (error && error.name),
    );
    return error.code;
  }
  throw new Error("expected the call to be rejected");
}

function makeSession(options = {}) {
  const trust = options.trust || makeTrust();
  const session = new RemotePeerSession({
    trust,
    verifySignature,
    now: clock,
    ...options,
  });
  const challenge = session.begin({ connectionId: CONNECTION_ID, tlsPublicKeyDigest: TLS_DIGEST });
  return { session, challenge, trust };
}

function makeEstablishedSession(options = {}) {
  const built = makeSession(options);
  const facts = makeFacts({ challenge: built.challenge.challenge }, built.trust);
  const peer = built.session.acceptFacts(facts);
  return { ...built, peer };
}

function makeAuthority(overrides = {}) {
  return {
    authorityHeld: true,
    epoch: 7,
    leaseFencing: 12,
    expectedLeaseFencing: 12,
    leaseExpiresAtMs: clockNow + 120_000,
    revocationAppliedAtMs: clockNow - 1_000,
    allowedActions: [ACTION],
    ...overrides,
  };
}

describe("governed/remote-peer-trust - trust configuration", () => {
  test("a valid configuration is normalized and frozen", () => {
    const trust = validateRemoteTrustConfig(makeTrust(), { nowMs: clockNow });
    assert.equal(trust.instanceId, "samhmi-instance-1");
    assert.equal(trust.epoch, 7);
    assert.deepEqual(trust.peerScope, [ACTION]);
    assert.ok(Object.isFrozen(trust));
    assert.ok(Object.isFrozen(trust.limits));
  });

  test("a missing instance is refused", () => {
    const trust = makeTrust();
    delete trust.instanceId;
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(trust, { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_FIELD_MISSING,
    );
  });

  test("a configuration without a pinned key is refused", () => {
    const trust = makeTrust();
    delete trust.pinnedKey.keyDigest;
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(trust, { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_KEY_NOT_PINNED,
    );
  });

  test("an empty peer scope is refused", () => {
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(makeTrust({ peerScope: [] }), { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_SCOPE_EMPTY,
    );
  });

  test("a negative epoch is refused", () => {
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(makeTrust({ epoch: -1 }), { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_EPOCH_INVALID,
    );
  });

  test("an expired configuration is refused", () => {
    const trust = makeTrust({ notBeforeMs: clockNow - 10_000, expiresAtMs: clockNow - 1 });
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(trust, { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_EXPIRED,
    );
  });

  test("a configuration that is not valid yet is refused", () => {
    const trust = makeTrust({ notBeforeMs: clockNow + 1_000, expiresAtMs: clockNow + 600_000 });
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(trust, { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_NOT_YET_VALID,
    );
  });

  test("a limit that is looser than the frozen ceiling is refused rather than clamped", () => {
    const trust = makeTrust();
    trust.limits.factMaxAgeMs = REMOTE_PEER_LIMIT.factMaxAgeMs + 1;
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(trust, { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_LIMIT_EXCEEDED,
    );
  });

  test("a limit of zero or less is refused", () => {
    const trust = makeTrust();
    trust.limits.ticketTtlMs = 0;
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(trust, { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_LIMIT_INVALID,
    );
  });

  test("a missing limit is refused", () => {
    const trust = makeTrust();
    delete trust.limits.requestTimeoutMs;
    assert.equal(
      rejectionCode(() => validateRemoteTrustConfig(trust, { nowMs: clockNow })),
      REMOTE_PEER_REJECTION.TRUST_LIMIT_INVALID,
    );
  });
});

describe("governed/remote-peer-trust - signed facts", () => {
  const trust = makeTrust();
  const connection = { connectionId: CONNECTION_ID, tlsPublicKeyDigest: TLS_DIGEST };

  function verify(facts, overrides = {}) {
    return verifyRemoteFacts({
      facts,
      trust,
      connection,
      expectedChallenge: "challenge-1",
      nowMs: clockNow,
      verifySignature,
      ...overrides,
    });
  }

  test("a complete fact set produces an opaque remote peer", () => {
    const peer = verify(makeFacts());
    assert.equal(peer.kind, "remote-peer");
    assert.equal(peer.instanceId, "samhmi-instance-1");
    assert.equal(peer.runId, "run-1");
    assert.equal(peer.generationText, "gen-text-1");
    assert.equal(peer.epoch, 7);
    assert.equal(peer.connectionId, CONNECTION_ID);
    assert.deepEqual(peer.scope, [ACTION]);
    assert.ok(Object.isFrozen(peer));
  });

  test("the remote peer is not shaped like a local managed caller identity", () => {
    const peer = verify(makeFacts());
    assert.equal(peer.kind, "remote-peer");
    assert.equal(peer.pid, undefined);
    assert.equal(peer.startToken, undefined);
    assert.equal(peer.host.startToken, "start-token-1");
  });

  test("a tampered field breaks the signature", () => {
    const facts = makeFacts();
    facts.runId = "run-2";
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_SIGNATURE_INVALID);
  });

  test("a fact set signed by another key is refused", () => {
    const facts = makeFacts({ signerKeyId: "other-key" });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_KEY_NOT_PINNED);
  });

  test("facts of another instance are refused", () => {
    const facts = makeFacts({ instanceId: "samhmi-instance-2" });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_INSTANCE_MISMATCH);
  });

  test("facts of an older epoch are refused", () => {
    const facts = makeFacts({ epoch: 6 });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_EPOCH_MISMATCH);
  });

  test("facts bound to another connection are refused", () => {
    const facts = makeFacts({ connection: { connectionId: "conn-2", tlsPublicKeyDigest: TLS_DIGEST } });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_MISMATCH);
  });

  test("facts bound to another TLS key are refused", () => {
    const facts = makeFacts({ connection: { connectionId: CONNECTION_ID, tlsPublicKeyDigest: "other-digest" } });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_CONNECTION_KEY_MISMATCH);
  });

  test("facts that do not answer the outstanding challenge are refused", () => {
    const facts = makeFacts({ challenge: "other-challenge" });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_CHALLENGE_MISMATCH);
  });

  test("stale facts are refused", () => {
    const facts = makeFacts({ issuedAtMs: clockNow - REMOTE_PEER_LIMIT.factMaxAgeMs - 1, expiresAtMs: clockNow + 100 });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_STALE);
  });

  test("facts dated too far in the future are refused", () => {
    const facts = makeFacts({ issuedAtMs: clockNow + REMOTE_PEER_LIMIT.maxClockSkewMs + 1, expiresAtMs: clockNow + 3_000 });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_CLOCK_SKEW);
  });

  test("expired facts are refused", () => {
    const facts = makeFacts({ issuedAtMs: clockNow - 100, expiresAtMs: clockNow - 1 });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_EXPIRED);
  });

  test("a validity window wider than the accepted fact age is refused", () => {
    const facts = makeFacts({ issuedAtMs: clockNow, expiresAtMs: clockNow + REMOTE_PEER_LIMIT.factMaxAgeMs + 1 });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_WINDOW_EXCEEDED);
  });

  test("a scope that exceeds the pinned scope is refused", () => {
    const facts = makeFacts({ scope: [ACTION, "permit.revoke"] });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_SCOPE_ESCALATION);
  });

  test("facts without a host binding are refused", () => {
    const facts = makeFacts({ host: undefined });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_HOST_UNBOUND);
  });

  test("facts without a process start token are refused", () => {
    const facts = makeFacts({ host: { pid: 1, startToken: "", commandDigest: "c" } });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_HOST_UNBOUND);
  });

  test("an unsupported fact version is refused", () => {
    const facts = makeFacts({ factVersion: 2 });
    assert.equal(rejectionCode(() => verify(facts)), REMOTE_PEER_REJECTION.REMOTE_FACT_VERSION_UNSUPPORTED);
  });

  test("a missing verifier is refused instead of silently accepting", () => {
    assert.equal(
      rejectionCode(() => verify(makeFacts(), { verifySignature: undefined })),
      REMOTE_PEER_REJECTION.TRUST_CONFIG_INVALID,
    );
  });
});

describe("governed/remote-peer-session - handshake", () => {
  test("the handshake challenge is bound to the connection and the frozen bound", () => {
    const { session, challenge } = makeSession();
    assert.equal(challenge.connectionId, CONNECTION_ID);
    assert.equal(challenge.timeoutMs, REMOTE_PEER_LIMIT.handshakeTimeoutMs);
    assert.equal(challenge.expiresAtMs, clockNow + REMOTE_PEER_LIMIT.handshakeTimeoutMs);
    assert.ok(challenge.challenge.length >= 16);
    assert.equal(session.state, REMOTE_SESSION_STATE.STARTING);
  });

  test("a session cannot be started twice", () => {
    const { session } = makeSession();
    assert.equal(
      rejectionCode(() => session.begin({ connectionId: CONNECTION_ID, tlsPublicKeyDigest: TLS_DIGEST })),
      REMOTE_SESSION_REJECTION.REMOTE_SESSION_ALREADY_STARTED,
    );
  });

  test("a connection without a key digest cannot be bound", () => {
    const session = new RemotePeerSession({ trust: makeTrust(), verifySignature, now: clock });
    assert.equal(
      rejectionCode(() => session.begin({ connectionId: CONNECTION_ID })),
      REMOTE_SESSION_REJECTION.REMOTE_SESSION_CONNECTION_INVALID,
    );
  });

  test("valid facts establish the peer", () => {
    const { session, challenge } = makeSession();
    const peer = session.acceptFacts(makeFacts({ challenge: challenge.challenge }));
    assert.equal(peer.kind, "remote-peer");
    assert.equal(session.state, REMOTE_SESSION_STATE.ESTABLISHED);
    assert.equal(session.established, true);
  });

  test("the challenge is single use: a second presentation is refused", () => {
    const { session, challenge } = makeSession();
    const facts = makeFacts({ challenge: challenge.challenge });
    session.acceptFacts(facts);
    assert.equal(
      rejectionCode(() => session.acceptFacts(facts)),
      REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
    );
  });

  test("a failed verification burns the challenge", () => {
    const { session, challenge } = makeSession();
    const bad = makeFacts({ challenge: challenge.challenge });
    bad.runId = "tampered-after-signing";
    assert.equal(
      rejectionCode(() => session.acceptFacts(bad)),
      REMOTE_PEER_REJECTION.REMOTE_FACT_SIGNATURE_INVALID,
    );
    assert.equal(
      rejectionCode(() => session.acceptFacts(makeFacts({ challenge: challenge.challenge }))),
      REMOTE_SESSION_REJECTION.REMOTE_HANDSHAKE_CONSUMED,
    );
  });

  test("facts that arrive after the handshake bound are refused and the session dies", () => {
    const { session, challenge } = makeSession();
    clockNow += REMOTE_PEER_LIMIT.handshakeTimeoutMs;
    assert.equal(
      rejectionCode(() => session.acceptFacts(makeFacts({ challenge: challenge.challenge }))),
      REMOTE_SESSION_REJECTION.REMOTE_HANDSHAKE_TIMEOUT,
    );
    assert.equal(session.state, REMOTE_SESSION_STATE.CLOSED);
    assert.equal(session.established, false);
  });
});

describe("governed/remote-peer-session - request binding and replay", () => {
  test("a request is bound to the peer and the connection", () => {
    const { session, peer } = makeEstablishedSession();
    const bound = session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: { a: 1 }, seq: 1 });
    assert.equal(bound.peerId, peer.peerId);
    assert.equal(bound.connectionId, CONNECTION_ID);
    assert.match(bound.payloadDigest, /^[0-9a-f]{64}$/);
  });

  test("the same request identifier cannot be used twice", () => {
    const { session } = makeEstablishedSession();
    session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: {}, seq: 1 });
    assert.equal(
      rejectionCode(() => session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: {}, seq: 2 })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_REPLAY,
    );
  });

  test("the sequence number has to advance", () => {
    const { session } = makeEstablishedSession();
    session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: {}, seq: 5 });
    assert.equal(
      rejectionCode(() => session.bindInboundRequest({ requestId: "r2", action: ACTION, payload: {}, seq: 5 })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_SEQUENCE,
    );
  });

  test("an action outside the peer scope is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => session.bindInboundRequest({ requestId: "r1", action: "permit.revoke", payload: {}, seq: 1 })),
      REMOTE_SESSION_REJECTION.REMOTE_ACTION_OUT_OF_SCOPE,
    );
  });

  test("the replay registry fails closed instead of evicting", () => {
    const { session } = makeEstablishedSession({ maxTrackedRequests: 2 });
    session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: {}, seq: 1 });
    session.bindInboundRequest({ requestId: "r2", action: ACTION, payload: {}, seq: 2 });
    assert.equal(
      rejectionCode(() => session.bindInboundRequest({ requestId: "r3", action: ACTION, payload: {}, seq: 3 })),
      REMOTE_SESSION_REJECTION.REMOTE_REPLAY_REGISTRY_FULL,
    );
  });

  test("a response has to match the request it answers", () => {
    const { session } = makeEstablishedSession();
    const bound = session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: { a: 1 }, seq: 1 });
    assert.equal(
      rejectionCode(() => session.completeInboundRequest({ requestId: "r1", seq: 2 })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_SEQUENCE,
    );
    assert.equal(
      rejectionCode(() => session.completeInboundRequest({ requestId: "r1", seq: 1, payloadDigest: "0".repeat(64) })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_PAYLOAD_MISMATCH,
    );
    assert.ok(session.completeInboundRequest({ requestId: "r1", seq: 1, payloadDigest: bound.payloadDigest }));
  });

  test("an unknown request cannot be completed", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => session.completeInboundRequest({ requestId: "nope", seq: 1 })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_UNKNOWN,
    );
  });
});

describe("governed/remote-peer-session - tickets", () => {
  test("a ticket is bound to the peer and the connection", () => {
    const { session, peer } = makeEstablishedSession();
    const ticket = session.registerTicket({ ticketId: "t1", action: ACTION, expiresAtMs: clockNow + 1_000 });
    assert.equal(ticket.peerId, peer.peerId);
    assert.equal(ticket.connectionId, CONNECTION_ID);
    assert.equal(ticket.consumed, false);
  });

  test("a ticket that outlives the frozen ticket bound is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => session.registerTicket({
        ticketId: "t1",
        action: ACTION,
        expiresAtMs: clockNow + REMOTE_PEER_LIMIT.ticketTtlMs + 1,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_TTL_EXCEEDED,
    );
  });

  test("a ticket for another peer or another connection is refused", () => {
    const { session, peer } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => session.registerTicket({
        ticketId: "t1",
        action: ACTION,
        expiresAtMs: clockNow + 1_000,
        peerId: "other-peer",
      })),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_PEER_MISMATCH,
    );
    assert.equal(
      rejectionCode(() => session.registerTicket({
        ticketId: "t2",
        action: ACTION,
        expiresAtMs: clockNow + 1_000,
        connectionId: "conn-2",
      })),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_CONNECTION_MISMATCH,
    );
    assert.ok(peer);
  });

  test("a ticket can be consumed only once", () => {
    const { session } = makeEstablishedSession();
    session.registerTicket({ ticketId: "t1", action: ACTION, expiresAtMs: clockNow + 1_000 });
    session.consumeTicket("t1");
    assert.equal(
      rejectionCode(() => session.consumeTicket("t1")),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_REPLAY,
    );
  });

  test("an unregistered ticket is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => session.consumeTicket("nope")),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_UNKNOWN,
    );
  });
});

describe("governed/remote-peer-session - per-call authority", () => {
  test("a call with a healthy authority is accepted and recorded", () => {
    const { session, peer } = makeEstablishedSession();
    const record = assertPerCallAuthority({
      session,
      action: ACTION,
      authority: makeAuthority(),
      nowMs: clockNow,
    });
    assert.equal(record.peerId, peer.peerId);
    assert.equal(record.connectionId, CONNECTION_ID);
    assert.equal(record.epoch, 7);
    assert.equal(record.authorityLeaseFencing, 12);
  });

  test("a session that is not established cannot authorize a call", () => {
    const { session } = makeSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        authority: makeAuthority(),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
    );
  });

  test("a call without held authority is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        authority: makeAuthority({ authorityHeld: false }),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_NOT_HELD,
    );
  });

  test("an authority of another epoch is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        authority: makeAuthority({ epoch: 6 }),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_EPOCH_MISMATCH,
    );
  });

  test("a stale fencing token is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        authority: makeAuthority({ leaseFencing: 11, expectedLeaseFencing: 12 }),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_FENCING_MISMATCH,
    );
  });

  test("an expired authority lease is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        authority: makeAuthority({ leaseExpiresAtMs: clockNow - 1 }),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_LEASE_EXPIRED,
    );
  });

  test("an action the authority does not allow is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        authority: makeAuthority({ allowedActions: [] }),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_ACTION_NOT_ALLOWED,
    );
  });

  test("a revocation list that is too old is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        authority: makeAuthority({ revocationAppliedAtMs: clockNow - REMOTE_PEER_LIMIT.revocationMaxStalenessMs - 1 }),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_REVOCATION_STALE,
    );
  });

  test("a call that is not bound to a request of this session is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        request: { requestId: "r-unknown" },
        authority: makeAuthority(),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_UNKNOWN,
    );
  });

  test("a call whose payload differs from the bound request is refused", () => {
    const { session } = makeEstablishedSession();
    const bound = session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: { a: 1 }, seq: 1 });
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        request: { requestId: "r1", payloadDigest: "0".repeat(64) },
        authority: makeAuthority(),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_PAYLOAD_MISMATCH,
    );
    assert.ok(bound);
  });

  test("a call with a deadline that already passed is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        request: { deadlineAtMs: clockNow - 1 },
        authority: makeAuthority(),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_DEADLINE_PASSED,
    );
  });

  test("a deadline beyond the frozen request bound is refused", () => {
    const { session } = makeEstablishedSession();
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        request: { deadlineAtMs: clockNow + REMOTE_PEER_LIMIT.requestTimeoutMs + 1 },
        authority: makeAuthority(),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_REQUEST_DEADLINE_EXCEEDED,
    );
  });

  test("a call that would outlive the authority lease is refused", () => {
    const { session } = makeEstablishedSession();
    const leaseExpiresAtMs = clockNow + 1_000;
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        request: { deadlineAtMs: clockNow + 2_000 },
        authority: makeAuthority({ leaseExpiresAtMs }),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_AUTHORITY_LIFETIME_TOO_SHORT,
    );
  });

  test("a consumed ticket cannot authorize another call", () => {
    const { session } = makeEstablishedSession();
    session.registerTicket({ ticketId: "t1", action: ACTION, expiresAtMs: clockNow + 1_000 });
    session.consumeTicket("t1");
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        request: { ticketId: "t1" },
        authority: makeAuthority(),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_REPLAY,
    );
  });

  test("a ticket that covers another action cannot authorize the call", () => {
    const trust = makeTrust({ peerScope: [ACTION, "permit.revoke"] });
    const built = makeSession({ trust });
    const session = built.session;
    session.acceptFacts(makeFacts(
      { challenge: built.challenge.challenge, scope: [ACTION, "permit.revoke"] },
      trust,
    ));
    session.registerTicket({ ticketId: "t1", action: "permit.revoke", expiresAtMs: clockNow + 1_000 });
    assert.equal(
      rejectionCode(() => assertPerCallAuthority({
        session,
        action: ACTION,
        request: { ticketId: "t1" },
        authority: makeAuthority(),
        nowMs: clockNow,
      })),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_ACTION_MISMATCH,
    );
  });
});

describe("governed/remote-peer-session - lifecycle", () => {
  test("draining stops the session from serving requests", () => {
    const { session } = makeEstablishedSession();
    session.drain();
    assert.equal(session.state, REMOTE_SESSION_STATE.DRAINING);
    assert.equal(session.established, false);
    assert.equal(
      rejectionCode(() => session.bindInboundRequest({ requestId: "r1", action: ACTION, payload: {}, seq: 1 })),
      REMOTE_SESSION_REJECTION.REMOTE_SESSION_INVALID_STATE,
    );
  });

  test("invalidation drops the peer and the open work", () => {
    const { session } = makeEstablishedSession();
    session.registerTicket({ ticketId: "t1", action: ACTION, expiresAtMs: clockNow + 1_000 });
    session.invalidate("identity_changed");
    assert.equal(session.state, REMOTE_SESSION_STATE.CLOSED);
    assert.equal(session.peer, null);
    assert.equal(session.invalidatedReason, "identity_changed");
    assert.equal(
      rejectionCode(() => session.consumeTicket("t1")),
      REMOTE_SESSION_REJECTION.REMOTE_TICKET_UNKNOWN,
    );
  });

  test("closing is terminal", () => {
    const { session } = makeEstablishedSession();
    session.close();
    assert.equal(session.state, REMOTE_SESSION_STATE.CLOSED);
    assert.equal(session.established, false);
  });
});
