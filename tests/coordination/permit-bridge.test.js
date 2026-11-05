"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { createPermitAuthorityService } = require("../../lib/coordination/permit-authority-service");
const {
  ISSUER_ACTIONS,
  TARGET_ACTIONS,
  createPermitBridgePolicy,
  identityMatches,
} = require("../../lib/coordination/permit-bridge-policy");
const {
  createPermitBridgeEndpoint,
  parseProjection,
  buildGrant,
  isLoopback,
} = require("../../lib/coordination/permit-bridge-endpoint");
const {
  assemblePermitIssuer,
  assemblePermitTarget,
  attachPermitBridgeEndpoint,
  pinPeerIdentity,
} = require("../../lib/coordination/permit-bridge-assembly");
const { createTicketRegistry } = require("../../lib/coordination/permit-bridge-ticket");

// A verified identity as the managed session would produce it.
const PEER = Object.freeze({
  sessionId: "session-1",
  pid: 4242,
  startToken: "win32:133000000000000000",
  commandDigest: "sha256:abc",
});

function issueRequest() {
  return { lease: { sessionId: "s" }, permit: { operation: "read" } };
}

// The issuing side signs permits with one batch and the revocation list with
// ANOTHER batch: a list signed by a revocable batch could revoke its own
// signer, and `signRevocationList` refuses exactly that. The two are
// therefore separate objects with separate key pairs, and the assembly
// refuses to start without both.
function revocationBatch(overrides = {}) {
  return {
    signRevocation: ({ state, fingerprints }) => ({
      revocation_sequence: state.appliedRevocationSequence + 1,
      revoked_fingerprints: [...fingerprints].sort(),
      issued_at_ms: 1000,
      prev_revocation_sequence: state.appliedRevocationSequence,
      batch_public_key_fingerprint: "d".repeat(64),
      signature: "revocation-signature",
      ...overrides,
    }),
  };
}

function revocationStateSource(state = { appliedRevocationSequence: 3, revokedFingerprints: new Set() }) {
  return () => state;
}

// The endpoint authenticates its client by a ticket, so every test needs one.
// The registry is created per endpoint and the ticket is minted for the same
// peer the assembly pins, which is what the production host does.
function ticketEndpoint(perform, extra = {}) {
  const tickets = createTicketRegistry();
  const endpoint = createPermitBridgeEndpoint({ perform, action: "issue", tickets, ...extra });
  // A ticket is one-shot, so a test that issues several requests mints a
  // fresh one for each of them.
  return { endpoint, tickets, ticket: () => tickets.mint(PEER) };
}

function ticketHeaders(ticket) {
  return { "x-permit-bridge-ticket": ticket };
}

test("the bridge policy authorizes only the pinned identity on an allowed action", () => {
  const authorize = createPermitBridgePolicy({ actions: ISSUER_ACTIONS, peerIdentity: PEER });
  assert.equal(authorize(PEER, "issue", issueRequest()), true);

  // A different session is a different peer.
  assert.equal(authorize({ ...PEER, sessionId: "session-2" }, "issue", issueRequest()), false);
  // A recycled pid with a different start token is a different process.
  assert.equal(authorize({ ...PEER, startToken: "win32:999" }, "issue", issueRequest()), false);
  // A different command line is a different process.
  assert.equal(authorize({ ...PEER, commandDigest: "sha256:def" }, "issue", issueRequest()), false);
  // A missing fact cannot be confirmed, so it cannot match.
  assert.equal(authorize({ sessionId: "session-1", pid: 4242 }, "issue", issueRequest()), false);
});

test("the bridge policy refuses actions outside the side's allow-list", () => {
  const issuer = createPermitBridgePolicy({ actions: ISSUER_ACTIONS, peerIdentity: PEER });
  // The issuing side may not register, verify, fetch a key or revoke: the
  // target side owns those, and a side that could do both would let one
  // compromised host both mint and attest permits.
  assert.equal(issuer(PEER, "register", { batchIdentity: {}, publicKeyPem: "x", sourceDigest: "a",
    deploymentDigest: "b", runId: "c", generation: "d", validFrom: 1, validUntil: 2 }), false);
  assert.equal(issuer(PEER, "verify", { fingerprint: "f", message: {}, signature: "s" }), false);
  assert.equal(issuer(PEER, "key", { fingerprint: "f" }), false);
  assert.equal(issuer(PEER, "revoke", {}), false);

  const target = createPermitBridgePolicy({ actions: TARGET_ACTIONS, peerIdentity: PEER });
  // The target side may not issue.
  assert.equal(target(PEER, "issue", issueRequest()), false);
  assert.equal(target(PEER, "verify", { fingerprint: "f", message: {}, signature: "s" }), true);
});

test("the bridge policy refuses a request whose shape does not match the action", () => {
  const issuer = createPermitBridgePolicy({ actions: ISSUER_ACTIONS, peerIdentity: PEER });
  assert.equal(issuer(PEER, "issue", { lease: {} }), false);
  assert.equal(issuer(PEER, "issue", { lease: {}, permit: {}, extra: 1 }), false);
  assert.equal(issuer(PEER, "issue", null), false);
  assert.equal(issuer(PEER, "issue", []), false);
});

test("the bridge policy refuses private key material in a request", () => {
  const issuer = createPermitBridgePolicy({ actions: ISSUER_ACTIONS, peerIdentity: PEER });
  const withPem = { lease: {}, permit: { note: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" } };
  assert.equal(issuer(PEER, "issue", withPem), false);
  const withRef = { lease: {}, permit: { privateKeyRef: "handle" } };
  assert.equal(issuer(PEER, "issue", withRef), false);
});

test("the bridge policy rejects an unknown action at construction time", () => {
  assert.throws(() => createPermitBridgePolicy({ actions: ["sign"], peerIdentity: PEER }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => createPermitBridgePolicy({ actions: [], peerIdentity: PEER }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => createPermitBridgePolicy({ actions: ISSUER_ACTIONS }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the projection is parsed from the signed message, never from the request", () => {
  const message = {
    operation: "read",
    target_digest: "a".repeat(64),
    params_digest: "b".repeat(64),
    desktop_key: "desk",
    session_id: "sess",
    worker_identity: "worker",
    run_id: "run",
    generation: "gen",
    host_identity: "host",
    owned_app_id: "app",
    permit_id: "permit-1",
  };
  const projection = parseProjection(JSON.stringify(message));
  assert.equal(projection.operation, "read");
  assert.equal(projection.targetDigest, "a".repeat(64));
  assert.equal(projection.permitId, "permit-1");

  // A message missing a binding field has no honest projection.
  const incomplete = { ...message };
  delete incomplete.desktop_key;
  assert.equal(parseProjection(JSON.stringify(incomplete)), null);
  assert.equal(parseProjection("not json"), null);
  assert.equal(parseProjection(""), null);
});

test("the grant is refused when the dispatch result cannot be projected honestly", () => {
  const message = {
    operation: "read",
    target_digest: "a".repeat(64),
    params_digest: "b".repeat(64),
    desktop_key: "desk",
    session_id: "sess",
    worker_identity: "worker",
    run_id: "run",
    generation: "gen",
    host_identity: "host",
    owned_app_id: "app",
    permit_id: "permit-1",
  };
  const good = {
    fingerprint: "c".repeat(64),
    signedPermit: { message: JSON.stringify(message), signature: "sig", sequence: 3, deadline: 99 },
  };
  const grant = buildGrant(good);
  assert.equal(grant.sequence, 3);
  assert.equal(grant.deadlineMs, 99);
  assert.equal(grant.signatureBase64, "sig");

  // A malformed fingerprint, a missing signature, an unparsable message and
  // a missing projection each make the grant unbuildable.
  assert.equal(buildGrant({ ...good, fingerprint: "short" }), null);
  assert.equal(buildGrant({ ...good, signedPermit: { ...good.signedPermit, signature: "" } }), null);
  assert.equal(buildGrant({ ...good, signedPermit: { ...good.signedPermit, message: "{" } }), null);
  assert.equal(buildGrant(null), null);
});

test("the endpoint binds loopback only", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("0.0.0.0"), false);
  assert.equal(isLoopback("192.168.2.110"), false);
  assert.equal(isLoopback("localhost"), false);

  const perform = async () => ({});
  assert.throws(() => createPermitBridgeEndpoint({ perform, bindAddress: "0.0.0.0" }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => createPermitBridgeEndpoint({ perform, bindAddress: "192.168.2.110" }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => createPermitBridgeEndpoint({ perform: null }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the endpoint close is idempotent and refuses work once it starts", async () => {
  const { endpoint, ticket } = ticketEndpoint(async () => ({
    fingerprint: "c".repeat(64),
    signedPermit: { message: "{}", signature: "s" },
  }));
  const address = await endpoint.listen();

  const first = endpoint.close();
  const second = endpoint.close();
  assert.equal(first, second, "concurrent close must share one promise");
  await first;
  await endpoint.close();

  await assert.rejects(fetch("http://127.0.0.1:" + address.port + "/permit", {
    method: "POST",
    headers: ticketHeaders(ticket()),
    body: "{}",
  }));
});

test("the endpoint close bounds draining of an open connection", async () => {
  const { endpoint } = ticketEndpoint(async () => ({}), { closeDrainMs: 100 });
  const address = await endpoint.listen();
  const socket = net.connect(address.port, "127.0.0.1");
  await once(socket, "connect");
  // Let the server register the accepted connection before closing.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const started = Date.now();
  await endpoint.close();
  assert.ok(Date.now() - started < 2_000, "close must not wait for the client");
  await Promise.race([
    once(socket, "close"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("socket stayed open")), 2_000)),
  ]);
  assert.equal(socket.destroyed, true);
  socket.destroy();
});

test("the endpoint forwards one request to the managed session and returns the grant", async () => {
  const message = {
    operation: "read",
    target_digest: "a".repeat(64),
    params_digest: "b".repeat(64),
    desktop_key: "desk",
    session_id: "sess",
    worker_identity: "worker",
    run_id: "run",
    generation: "gen",
    host_identity: "host",
    owned_app_id: "app",
    permit_id: "permit-1",
  };
  const seen = [];
  const perform = async (operation, payload) => {
      seen.push([operation, payload]);
      return {
        fingerprint: "c".repeat(64),
        signedPermit: { message: JSON.stringify(message), signature: "sig", sequence: 7, deadline: 1234 },
      };
  };
  const { endpoint, ticket } = ticketEndpoint(perform);
  const address = await endpoint.listen();
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST",
      headers: ticketHeaders(ticket()),
      body: JSON.stringify({ lease: { sessionId: "s" }, permit: { operation: "read" } }),
    });
    assert.equal(response.status, 200);
    const grant = await response.json();
    assert.equal(grant.permitId, "permit-1");
    assert.equal(grant.operation, "read");
    assert.equal(grant.sequence, 7);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], "issue");
  } finally {
    await endpoint.close();
  }
});

test("the endpoint answers non-2xx on every failure path and never degrades", async () => {
  const perform = async () => { throw new Error("managed operation rejected"); };
  const { endpoint, ticket } = ticketEndpoint(perform);
  const address = await endpoint.listen();
  try {
    const failed = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST", headers: ticketHeaders(ticket()), body: JSON.stringify({ lease: {} }),
    });
    assert.equal(failed.status, 502);

    const unparsable = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST", headers: ticketHeaders(ticket()), body: "{",
    });
    assert.equal(unparsable.status, 400);

    const wrongMethod = await fetch("http://127.0.0.1:" + address.port + "/permit", { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    const notAnObject = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST", headers: ticketHeaders(ticket()), body: JSON.stringify([1, 2, 3]),
    });
    assert.equal(notAnObject.status, 400);
  } finally {
    await endpoint.close();
  }
});

test("the endpoint refuses to build a grant whose dispatch result has no projection", async () => {
  const perform = async () => ({ fingerprint: "c".repeat(64), signedPermit: { message: "{", signature: "s" } });
  const { endpoint, ticket } = ticketEndpoint(perform);
  const address = await endpoint.listen();
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST", headers: ticketHeaders(ticket()), body: JSON.stringify({ lease: {} }),
    });
    // Not 200: a 200 with a partial body would be a permission decision
    // dressed as a transport answer.
    assert.equal(response.status, 502);
  } finally {
    await endpoint.close();
  }
});

test("the authority refuses a peer the policy did not authorize", () => {
  const authorize = createPermitBridgePolicy({ actions: ISSUER_ACTIONS, peerIdentity: PEER });
  let issued = 0;
  const service = createPermitAuthorityService({
    authorize,
    batchSession: { issue: () => { issued += 1; return { ok: true }; } },
  });
  // The dispatch's peer is the identity the transport verified. A peer that
  // is not the pinned one is refused before the batch session runs.
  assert.throws(() => service.dispatch({ ...PEER, sessionId: "other" }, "issue", issueRequest()),
    { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.equal(issued, 0);
  assert.deepEqual(service.dispatch(PEER, "issue", issueRequest()), { ok: true });
  assert.equal(issued, 1);
});

test("identityMatches compares only the pinned facts", () => {
  assert.equal(identityMatches(PEER, PEER), true);
  assert.equal(identityMatches(PEER, { ...PEER, extra: "ignored" }), true);
  assert.equal(identityMatches(PEER, { sessionId: "session-1", pid: 4242, startToken: PEER.startToken }), false);
  assert.equal(identityMatches(null, PEER), false);
  assert.equal(identityMatches(PEER, null), false);
});

// Keep the unused import honest: the http module is referenced so that a
// future reader knows the endpoint is a plain node:http server.
assert.equal(typeof http.createServer, "function");

test("pinning a peer identity requires the four audited facts", () => {
  const pinned = pinPeerIdentity(PEER);
  assert.equal(pinned.sessionId, PEER.sessionId);
  assert.equal(pinned.pid, PEER.pid);
  // The pin is a copy: later mutation of the source object cannot change it.
  const mutable = { ...PEER };
  const pinnedMutable = pinPeerIdentity(mutable);
  mutable.sessionId = "changed";
  assert.equal(pinnedMutable.sessionId, PEER.sessionId);

  assert.throws(() => pinPeerIdentity({ sessionId: "s", pid: 1 }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => pinPeerIdentity(null), { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the issuing assembly serves issue and refuses the target-side actions", () => {
  let issued = 0;
  const assembly = assemblePermitIssuer({
    batchSession: { issue: () => { issued += 1; return { ok: true }; } },
    revocationBatchSession: revocationBatch(),
    revocationStateSource: revocationStateSource(),
    peerIdentity: PEER,
  });
  assert.equal(assembly.side, "issuer");
  assert.deepEqual(assembly.perform("issue", issueRequest()), { ok: true });
  assert.equal(issued, 1);

  // The issuing side has no target service at all, so the other actions
  // cannot be served here even if they were somehow requested.
  assert.throws(() => assembly.perform("verify", { fingerprint: "f", message: {}, signature: "s" }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => assembly.perform("register", { batchIdentity: {} }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the target assembly serves verify and refuses to issue", () => {
  const assembly = assemblePermitTarget({
    targetService: { verify: () => ({ ok: true }) },
    peerIdentity: PEER,
  });
  assert.equal(assembly.side, "target");
  assert.deepEqual(assembly.perform("verify", { fingerprint: "f", message: {}, signature: "s" }), { ok: true });
  assert.throws(() => assembly.perform("issue", issueRequest()), { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the assembly hands the pinned peer to dispatch, never a request-supplied one", () => {
  const issued = [];
  const assembly = assemblePermitIssuer({
    batchSession: { issue: (args) => { issued.push(args); return { ok: true }; } },
    revocationBatchSession: revocationBatch(),
    revocationStateSource: revocationStateSource(),
    peerIdentity: PEER,
  });
  // The request carries a session id of its own. The peer is the PINNED
  // identity, so the request's value is neither the peer nor a way to
  // redirect it: the request is forwarded with its own fields intact and the
  // dispatch still runs against the pinned peer.
  assert.deepEqual(
    assembly.perform("issue", { lease: { sessionId: "attacker" }, permit: { operation: "read" } }),
    { ok: true },
  );
  assert.equal(issued.length, 1);
  assert.equal(issued[0].lease.sessionId, "attacker");

  // A request whose SHAPE is wrong is still refused: the assembly does not
  // complete a malformed request to make the peer look right.
  assert.throws(() => assembly.perform("issue", { lease: {}, permit: {}, sessionId: "attacker" }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the assembly refuses an incomplete bridge component set", () => {
  assert.throws(() => assemblePermitIssuer({ peerIdentity: PEER }), { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => assemblePermitTarget({ peerIdentity: PEER }), { key: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => attachPermitBridgeEndpoint({ assembly: null }),
    { key: "ERR_PERMIT_INPUT_INVALID" });
});

test("the attached endpoint forwards through the assembly's pinned peer", async () => {
  const message = {
    operation: "read",
    target_digest: "a".repeat(64),
    params_digest: "b".repeat(64),
    desktop_key: "desk",
    session_id: "sess",
    worker_identity: "worker",
    run_id: "run",
    generation: "gen",
    host_identity: "host",
    owned_app_id: "app",
    permit_id: "permit-1",
  };
  const assembly = assemblePermitIssuer({
    batchSession: { issue: () => ({
      fingerprint: "c".repeat(64),
      signedPermit: { message: JSON.stringify(message), signature: "sig", sequence: 1, deadline: 5 },
    }) },
    revocationBatchSession: revocationBatch(),
    revocationStateSource: revocationStateSource(),
    peerIdentity: PEER,
  });
  const tickets = createTicketRegistry();
  const endpoint = attachPermitBridgeEndpoint({ assembly, action: "issue", tickets });
  const address = await endpoint.listen();
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST",
      headers: ticketHeaders(tickets.mint(PEER)),
      body: JSON.stringify({ lease: { sessionId: "s" }, permit: { operation: "read" } }),
    });
    assert.equal(response.status, 200);
  } finally {
    await endpoint.close();
  }
});
