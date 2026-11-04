"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startPermitBridgeHost } = require("../../lib/coordination/permit-bridge-host");
const { canonicalize } = require("../../lib/coordination/permit-delivery");

// The executor is a separate process: it is the peer whose identity the
// authority's policy is bound to. That is the whole point of the assembly —
// the HTTP handler cannot assert a peer, it can only relay into the session.
const EXECUTOR = path.join(__dirname, "../../lib/commands/permit-bridge-executor.js");

const LEASE_TTL_MS = 60_000;
const PERMIT_TTL_MS = 5_000;

function productRequest(overrides = {}) {
  return {
    operation: "read",
    targetDigest: "a".repeat(64),
    paramsDigest: "b".repeat(64),
    desktopKey: "desk",
    sessionId: "sess",
    workerIdentity: "worker",
    runId: "run",
    generation: "gen",
    hostIdentity: "host",
    ownedAppId: "app",
    correlationId: "corr",
    ...overrides,
  };
}

function signedMessage(overrides = {}) {
  return {
    lease_id: "lease-1",
    session_id: "sess",
    host_identity: "host",
    worker_identity: "worker",
    run_id: "run",
    generation: "gen",
    desktop_key: "desk",
    owned_app_id: "app",
    service_epoch: 1,
    fencing: 1,
    operation: "read",
    target_digest: "a".repeat(64),
    params_digest: "b".repeat(64),
    sequence: 5,
    issued_at_ms: 1000,
    deadline_ms: 2000,
    permit_id: "permit-1",
    ...overrides,
  };
}

function grantFor(overrides = {}) {
  return {
    fingerprint: "c".repeat(64),
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
    signedPermit: {
      message: signedMessage(overrides),
      signature: "sig",
      sequence: 5,
      deadline: 2000,
    },
  };
}

function startBridge(batchSession, extra = {}) {
  return startPermitBridgeHost({
    executorPath: EXECUTOR,
    batchSession,
    // The revocation list is signed by a SEPARATE batch: a list signed by a
    // revocable batch could revoke its own signer. The host refuses to
    // start without it, because an issuer that cannot publish a revocation
    // list has a revocation channel that is dead on arrival.
    revocationBatchSession: {
      signRevocation: ({ state, fingerprints }) => ({
        revocation_sequence: state.appliedRevocationSequence + 1,
        revoked_fingerprints: [...fingerprints].sort(),
        issued_at_ms: 1000,
        prev_revocation_sequence: state.appliedRevocationSequence,
        batch_public_key_fingerprint: "d".repeat(64),
        signature: "revocation-signature",
      }),
    },
    revocationStateSource: () => ({ appliedRevocationSequence: 0, revokedFingerprints: new Set() }),
    leaseTtlMs: LEASE_TTL_MS,
    permitTtlMs: PERMIT_TTL_MS,
    ...extra,
  });
}

function post(port, body, ticket) {
  const headers = {};
  if (ticket) headers["x-permit-bridge-ticket"] = ticket;
  return fetch("http://127.0.0.1:" + port + "/permit", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("the bridge host serves a signed permit over the loopback endpoint", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  const issued = [];
  const bridge = await startBridge({
    issue: (request) => {
      issued.push(request);
      return grantFor();
    },
  });
  try {
    const response = await post(bridge.address.port, productRequest(), bridge.issueTicket());
    assert.equal(response.status, 200);
    const grant = await response.json();
    // The projection came from the SIGNED message, not from the request.
    assert.equal(grant.permitId, "permit-1");
    assert.equal(grant.operation, "read");
    assert.equal(grant.targetDigest, "a".repeat(64));
    assert.equal(grant.sequence, 5);
    assert.equal(grant.deadlineMs, 2000);
    assert.equal(grant.signatureBase64, "sig");

    // The message text the product receives canonicalizes to the signer's
    // own canonical form, so the broker reproduces the signed bytes.
    assert.equal(grant.messageJson, canonicalize(signedMessage()));

    // The batch session really ran, with the mapped request.
    assert.equal(issued.length, 1);
    assert.equal(issued[0].lease.sessionId, "sess");
    assert.equal(issued[0].lease.hostId, "host");
    assert.equal(issued[0].lease.workerId, "worker");
    assert.equal(issued[0].permit.operation, "read");
    assert.equal(issued[0].permit.targetDigest, "a".repeat(64));
    assert.equal(issued[0].permit.ttlMs, PERMIT_TTL_MS);
  } finally {
    await bridge.close();
  }
});

test("the bridge host refuses a request whose shape the issuing side cannot serve", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  const bridge = await startBridge({ issue: () => grantFor() });
  try {
    // A request missing a binding field must not be honoured: a bridge that
    // filled it in would be issuing a permit for a binding nobody asked for.
    const incomplete = productRequest();
    delete incomplete.workerIdentity;
    const response = await post(bridge.address.port, incomplete, bridge.issueTicket());
    assert.notEqual(response.status, 200);
  } finally {
    await bridge.close();
  }
});

test("the bridge host answers non-2xx when the batch session refuses", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  const bridge = await startBridge({ issue: () => { throw new Error("no lease"); } });
  try {
    const response = await post(bridge.address.port, productRequest(), bridge.issueTicket());
    // A refused issuance must not degrade into a 200 with a partial body.
    assert.notEqual(response.status, 200);
  } finally {
    await bridge.close();
  }
});

test("the bridge host refuses a client that presents no ticket", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  // The loopback binding alone does not authenticate anything: every process
  // of the interactive account shares the loopback interface. A bystander
  // process that posts without a ticket must not obtain a signed permit.
  const issued = [];
  const bridge = await startBridge({
    issue: (request) => {
      issued.push(request);
      return grantFor();
    },
  });
  try {
    const response = await post(bridge.address.port, productRequest());
    assert.equal(response.status, 401);
    // The request must not have reached the batch session at all.
    assert.equal(issued.length, 0);
  } finally {
    await bridge.close();
  }
});

test("the bridge host refuses a ticket that is presented twice", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  // A ticket that could be replayed would make the endpoint's access control
  // only as strong as the secrecy of one captured value.
  const bridge = await startBridge({ issue: () => grantFor() });
  try {
    const ticket = bridge.issueTicket();
    const first = await post(bridge.address.port, productRequest(), ticket);
    assert.equal(first.status, 200);
    const second = await post(bridge.address.port, productRequest(), ticket);
    assert.equal(second.status, 401);
  } finally {
    await bridge.close();
  }
});

test("the bridge host enforces its configured ticket lifetime", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let bridge;
  try {
    bridge = await startBridge({ issue: () => grantFor() }, { ticketTtlMs: 10 });
    const ticket = bridge.issueTicket();
    t.mock.timers.tick(11);
    const response = await post(bridge.address.port, productRequest(), ticket);
    assert.equal(response.status, 401);
  } finally {
    t.mock.timers.reset();
    if (bridge) await bridge.close();
  }
});

test("the bridge host refuses a ticket that was never minted", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  const bridge = await startBridge({ issue: () => grantFor() });
  try {
    const response = await post(bridge.address.port, productRequest(), "a".repeat(64));
    assert.equal(response.status, 401);
  } finally {
    await bridge.close();
  }
});

test("the bridge host refuses to start without an executor or a batch session", async () => {
  await assert.rejects(
    startPermitBridgeHost({
      batchSession: { issue: () => ({}) },
      leaseTtlMs: LEASE_TTL_MS,
      permitTtlMs: PERMIT_TTL_MS,
    }),
    { key: "ERR_PERMIT_INPUT_INVALID" },
  );
  await assert.rejects(
    startPermitBridgeHost({
      executorPath: EXECUTOR,
      leaseTtlMs: LEASE_TTL_MS,
      permitTtlMs: PERMIT_TTL_MS,
    }),
    { key: "ERR_PERMIT_INPUT_INVALID" },
  );
});

test("the bridge host refuses to start without the lease and permit TTLs", async () => {
  // The TTLs are configuration, not request data. A bridge that invented a
  // default at request time would be choosing the lease window itself.
  await assert.rejects(
    startPermitBridgeHost({ executorPath: EXECUTOR, batchSession: { issue: () => ({}) } }),
    { key: "ERR_PERMIT_INPUT_INVALID" },
  );
  await assert.rejects(
    startPermitBridgeHost({
      executorPath: EXECUTOR,
      batchSession: { issue: () => ({}) },
      leaseTtlMs: LEASE_TTL_MS,
    }),
    { key: "ERR_PERMIT_INPUT_INVALID" },
  );
});

test("the bridge host refuses a non-loopback bind address", async () => {
  await assert.rejects(
    startPermitBridgeHost({
      executorPath: EXECUTOR,
      batchSession: { issue: () => ({}) },
      bindAddress: "0.0.0.0",
      leaseTtlMs: LEASE_TTL_MS,
      permitTtlMs: PERMIT_TTL_MS,
    }),
    { key: "ERR_PERMIT_INPUT_INVALID" },
  );
});
