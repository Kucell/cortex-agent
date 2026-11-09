"use strict";

// Tests for the cross-machine ticket agent (M-053 / R2-c).
//
// The agent is the component that lets a REMOTE managed peer obtain a client
// ticket for the issuing endpoint. These tests cover the handshake rules
// (pin, challenge, signature), the one-shot nature of both the challenge and
// the ticket, and the endpoint behaviour a remote peer's ticket produces.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  startPermitTicketAgent,
  handshakeFacts,
} = require("../../lib/coordination/permit-ticket-agent");
const {
  requestRemoteTicket,
  signHandshake,
} = require("../../lib/coordination/permit-remote-peer-client");
const { createRemotePeerRegistry } = require("../../lib/coordination/permit-remote-peer-registry");
const { createTicketRegistry } = require("../../lib/coordination/permit-bridge-ticket");
const { createPermitBridgeEndpoint } = require("../../lib/coordination/permit-bridge-endpoint");

const PEER_ID = "windows-test-1";
const INSTANCE_ID = "m053-r2r6-td-20261109";

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

// The identity facts the remote peer reports. They are what the ticket is
// bound to, so they have to survive the handshake unchanged.
const REMOTE_IDENTITY = Object.freeze({
  pid: 5151,
  startToken: "win32:133000000000000000",
  commandDigest: "sha256:remote",
});

async function startAgent(overrides = {}) {
  const keys = overrides.keys || keyPair();
  const minted = [];
  const registered = [];
  const agent = await startPermitTicketAgent(Object.assign({
    peers: [{ peerId: PEER_ID, instanceId: INSTANCE_ID, publicKeyPem: keys.publicKeyPem }],
    mintTicket: (identity) => {
      minted.push(identity);
      return "ticket-" + minted.length;
    },
    registerPeer: (identity, ttlMs) => registered.push({ identity, ttlMs }),
  }, overrides.options || {}));
  return { agent, keys, minted, registered };
}

async function getChallenge(agent) {
  const response = await fetch("http://127.0.0.1:" + agent.address.port + "/challenge");
  assert.equal(response.status, 200);
  return response.json();
}

async function postHandshake(agent, body) {
  return fetch("http://127.0.0.1:" + agent.address.port + "/handshake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function handshakeBody(agent, keys, challenge, overrides = {}) {
  const facts = handshakeFacts(Object.assign({
    peerId: PEER_ID,
    instanceId: INSTANCE_ID,
    pid: REMOTE_IDENTITY.pid,
    startToken: REMOTE_IDENTITY.startToken,
    commandDigest: REMOTE_IDENTITY.commandDigest,
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
  }, overrides));
  return Object.assign({}, facts, {
    signature: signHandshake(keys.privateKeyPem, facts),
  });
}

test("the agent issues a ticket to a pinned peer and binds it to the peer's attested identity", async () => {
  const { agent, keys, minted, registered } = await startAgent();
  try {
    const challenge = await getChallenge(agent);
    const response = await postHandshake(agent, await handshakeBody(agent, keys, challenge));

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ticket, "ticket-1");
    assert.equal(result.peerId, PEER_ID);

    // The ticket is bound to the facts the peer SIGNED, not to facts the
    // agent invented: the peer id, the process id, the start token and the
    // command digest all come from the handshake.
    assert.equal(minted.length, 1);
    assert.equal(minted[0].pid, REMOTE_IDENTITY.pid);
    assert.equal(minted[0].startToken, REMOTE_IDENTITY.startToken);
    assert.equal(minted[0].commandDigest, REMOTE_IDENTITY.commandDigest);
    assert.match(minted[0].sessionId, /^remote:windows-test-1:/);

    // The peer is registered for as long as a ticket minted for it can be
    // presented — the ticket's reach, not the bridge's lifetime.
    assert.equal(registered.length, 1);
    assert.ok(registered[0].ttlMs > 0);
  } finally {
    await agent.close();
  }
});

test("the agent refuses a peer that is not pinned", async () => {
  const { agent, keys } = await startAgent();
  try {
    const challenge = await getChallenge(agent);
    const response = await postHandshake(agent, await handshakeBody(agent, keys, challenge, {
      peerId: "somebody-else",
    }));
    assert.equal(response.status, 401);
  } finally {
    await agent.close();
  }
});

test("the agent refuses a pinned peer that claims another instance", async () => {
  const { agent, keys } = await startAgent();
  try {
    const challenge = await getChallenge(agent);
    const response = await postHandshake(agent, await handshakeBody(agent, keys, challenge, {
      instanceId: "another-instance",
    }));
    assert.equal(response.status, 401);
  } finally {
    await agent.close();
  }
});

test("the agent refuses a handshake signed by another key", async () => {
  const { agent, keys } = await startAgent();
  const other = keyPair();
  try {
    const challenge = await getChallenge(agent);
    const body = await handshakeBody(agent, keys, challenge);
    // Same facts, different key: the pin is on the KEY, not on the peer id.
    body.signature = signHandshake(other.privateKeyPem, handshakeFacts(body));
    const response = await postHandshake(agent, body);
    assert.equal(response.status, 401);
  } finally {
    await agent.close();
  }
});

test("the agent refuses a tampered challenge", async () => {
  const { agent, keys } = await startAgent();
  try {
    const challenge = await getChallenge(agent);
    const body = await handshakeBody(agent, keys, challenge);
    body.challenge = crypto.randomBytes(32).toString("base64");
    const response = await postHandshake(agent, body);
    assert.equal(response.status, 401);
  } finally {
    await agent.close();
  }
});

test("the agent burns a challenge on its first use, successful or not", async () => {
  const { agent, keys } = await startAgent();
  try {
    const challenge = await getChallenge(agent);
    const body = await handshakeBody(agent, keys, challenge);
    // A first attempt with a broken signature must not leave the challenge
    // usable: otherwise an attacker gets unlimited tries at one challenge.
    body.signature = Buffer.alloc(64).toString("base64");
    assert.equal((await postHandshake(agent, body)).status, 401);

    const retry = await handshakeBody(agent, keys, challenge);
    assert.equal((await postHandshake(agent, retry)).status, 401);
  } finally {
    await agent.close();
  }
});

test("the agent refuses a challenge it never issued", async () => {
  const { agent, keys } = await startAgent();
  try {
    const challenge = await getChallenge(agent);
    const body = await handshakeBody(agent, keys, challenge);
    body.challengeId = crypto.randomBytes(16).toString("hex");
    assert.equal((await postHandshake(agent, body)).status, 401);
  } finally {
    await agent.close();
  }
});

test("the agent answers 405 on the wrong method and 404 on an unknown path", async () => {
  const { agent } = await startAgent();
  try {
    const wrongMethod = await fetch("http://127.0.0.1:" + agent.address.port + "/handshake");
    assert.equal(wrongMethod.status, 405);
    const wrongMethod2 = await fetch("http://127.0.0.1:" + agent.address.port + "/challenge", {
      method: "POST",
    });
    assert.equal(wrongMethod2.status, 405);
    const unknown = await fetch("http://127.0.0.1:" + agent.address.port + "/nope");
    assert.equal(unknown.status, 404);
  } finally {
    await agent.close();
  }
});

test("the agent refuses a non-loopback bind", async () => {
  await assert.rejects(() => startPermitTicketAgent({
    peers: [{ peerId: PEER_ID, instanceId: INSTANCE_ID, publicKeyPem: keyPair().publicKeyPem }],
    mintTicket: () => "ticket",
    registerPeer: () => {},
    bindAddress: "0.0.0.0",
  }), (error) => Boolean(error) && String(error.code).startsWith("ERR_PERMIT_INPUT_INVALID"));
});

test("the remote peer client obtains a ticket from the agent", async () => {
  const { agent, keys } = await startAgent();
  try {
    const result = await requestRemoteTicket({
      agentUrl: "http://127.0.0.1:" + agent.address.port,
      peerId: PEER_ID,
      instanceId: INSTANCE_ID,
      identity: REMOTE_IDENTITY,
      privateKeyPem: keys.privateKeyPem,
    });

    assert.equal(result.ticket, "ticket-1");
    assert.equal(result.peerId, PEER_ID);
    assert.match(result.sessionId, /^remote:windows-test-1:/);
  } finally {
    await agent.close();
  }
});

test("the remote peer client is refused by an agent that pins another key", async () => {
  const { agent } = await startAgent();
  const stranger = keyPair();
  try {
    await assert.rejects(() => requestRemoteTicket({
      agentUrl: "http://127.0.0.1:" + agent.address.port,
      peerId: PEER_ID,
      instanceId: INSTANCE_ID,
      identity: REMOTE_IDENTITY,
      privateKeyPem: stranger.privateKeyPem,
    }), (error) => error && error.code === "ERR_PERMIT_AGENT_REJECTED");
  } finally {
    await agent.close();
  }
});

test("the peer registry accepts a registered remote peer and drops it when it expires", () => {
  let now = 1000;
  const registry = createRemotePeerRegistry({ clock: () => now });
  const identity = {
    sessionId: "remote:windows-test-1:abc",
    pid: 5151,
    startToken: "win32:1",
    commandDigest: "sha256:remote",
  };

  assert.equal(registry.matches(identity, { sessionId: "local" }), false);
  registry.register(identity, 500);
  assert.equal(registry.matches(identity, { sessionId: "local" }), true);

  now = 1501;
  assert.equal(registry.matches(identity, { sessionId: "local" }), false);
  assert.equal(registry.size(), 0);
});

test("the endpoint accepts a remote peer's ticket once and refuses the replay", async () => {
  const registry = createRemotePeerRegistry();
  const tickets = createTicketRegistry();
  const identity = {
    sessionId: "remote:windows-test-1:abc",
    pid: 5151,
    startToken: "win32:1",
    commandDigest: "sha256:remote",
  };
  registry.register(identity, 60_000);

  const endpoint = createPermitBridgeEndpoint({
    action: "issue",
    tickets,
    perform: async (action, request, ticketFacts) => {
      // The same rule the host applies: the ticket must belong to a live peer.
      if (!registry.matches(ticketFacts, { sessionId: "local" })) {
        const error = new Error("peer mismatch");
        error.code = "ERR_PERMIT_INPUT_INVALID";
        throw error;
      }
      return {
        signedPermit: {
          message: {
            permit_id: "P-1",
            operation: "read",
            target_digest: "t",
            params_digest: "p",
            desktop_key: "d",
            session_id: "s",
            worker_identity: "w",
            run_id: "r",
            generation: "1",
            host_identity: "h",
            owned_app_id: "o",
          },
          signature: "sig",
          sequence: 1,
          deadline: 2000,
        },
        fingerprint: "f".repeat(64),
      };
    },
  });
  const address = await endpoint.listen();
  try {
    const ticket = tickets.mint(identity);
    const headers = { "x-permit-bridge-ticket": ticket };

    const granted = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST",
      headers,
      body: JSON.stringify({ lease: { sessionId: "s" }, permit: { operation: "read" } }),
    });
    assert.equal(granted.status, 200);

    // The same ticket again: it was consumed by the first request.
    const replayed = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST",
      headers,
      body: JSON.stringify({ lease: { sessionId: "s" }, permit: { operation: "read" } }),
    });
    assert.equal(replayed.status, 401);

    // No ticket at all.
    const unticketed = await fetch("http://127.0.0.1:" + address.port + "/permit", {
      method: "POST",
      body: JSON.stringify({ lease: { sessionId: "s" }, permit: { operation: "read" } }),
    });
    assert.equal(unticketed.status, 401);
  } finally {
    await endpoint.close();
  }
});
