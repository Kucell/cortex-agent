"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startPermitBridgeHost } = require("../../lib/coordination/permit-bridge-host");
const { createTicketRegistry } = require("../../lib/coordination/permit-bridge-ticket");

const EXECUTOR = path.join(__dirname, "../../lib/commands/permit-bridge-executor.js");

const PEER = Object.freeze({
  sessionId: "session-1",
  pid: 4242,
  startToken: "win32:133000000000000000",
  commandDigest: "sha256:abc",
});

const OTHER_PEER = Object.freeze({
  sessionId: "session-2",
  pid: 4343,
  startToken: "win32:144000000000000000",
  commandDigest: "sha256:def",
});

function productRequest() {
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
  };
}

function signedMessage() {
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
  };
}

function grantFor() {
  return {
    fingerprint: "c".repeat(64),
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
    signedPermit: { message: signedMessage(), signature: "sig", sequence: 5, deadline: 2000 },
  };
}

test("a ticket minted for another peer does not authorize the pinned peer", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  // The ticket names the peer it was minted for; the session pins the peer the
  // authority compares against. A ticket for one identity must not authorize
  // a request that another identity's session would carry.
  const issued = [];
  const bridge = await startPermitBridgeHost({
    executorPath: EXECUTOR,
    batchSession: {
      issue: (request) => {
        issued.push(request);
        return grantFor();
      },
    },
    leaseTtlMs: 60_000,
    permitTtlMs: 5_000,
  });
  try {
    // A registry the host does not own, holding a ticket for a foreign peer.
    const foreign = createTicketRegistry();
    const ticket = foreign.mint(OTHER_PEER);
    const response = await fetch("http://127.0.0.1:" + bridge.address.port + "/permit", {
      method: "POST",
      headers: { "x-permit-bridge-ticket": ticket },
      body: JSON.stringify(productRequest()),
    });
    assert.notEqual(response.status, 200);
    assert.equal(issued.length, 0);
  } finally {
    await bridge.close();
  }
});
