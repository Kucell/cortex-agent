"use strict";

// ─── Permit Ticket Agent (M-053 / R2-c: 跨机受管对端的票据代理) ─────────────
//
// WHAT THIS MODULE IS
//   The bridge's ticket agent: it lets a REMOTE managed peer obtain a client
//   ticket for the issuing endpoint over a duplex stream that reaches this
//   process from another machine.
//
// WHY THE TICKET EXISTED ONLY FOR THE LOCAL PEER
//   `permit-bridge-host.js` mints a ticket for the identity the LOCAL managed
//   session verified (`tickets.mint(assembly.peerIdentity)`), and the endpoint
//   refuses any ticket whose bound facts do not match that pinned identity.
//   That is the right rule — a ticket proves "the caller is the process the
//   host audited" — but it means the only peer that could ever hold a ticket
//   was the executor this bridge forked. A peer on another machine could
//   reach the endpoint and nothing else: it had no ticket, and there was no
//   path by which it could get one.
//
// WHAT THIS MODULE ADDS
//   A second, separate loopback listener that performs a pinned-trust
//   handshake with a remote peer and, on success, mints a ticket BOUND TO
//   THAT REMOTE PEER's attested identity facts. The ticket is delivered over
//   the handshake response, so the remote peer can then present it on the
//   permit endpoint exactly like the local peer does.
//
// WHY THE TRUST ROOT IS A PARAMETER AND NOT A REQUEST FIELD
//   The pinned peer keys come from the deployment (`peers` below), never from
//   the handshake request. A peer that could name its own key would be able
//   to mint a ticket for itself, which is the whole thing the ticket is for.
//
// WHY THE HANDSHAKE USES A SERVER-ISSUED ONE-SHOT CHALLENGE
//   The challenge is generated here, stored, handed out once and burned on the
//   first use — including a failed use. A signature over a client-chosen
//   challenge would be replayable; a signature over a challenge this process
//   issued and then destroyed cannot be.
//
// WHY THE AGENT IS A SEPARATE LISTENER
//   The permit endpoint answers exactly one shape of response (the grant), and
//   its access control is the ticket. Mounting the handshake on the same
//   socket would mean the endpoint had to answer two shapes and choose
//   between them by something in the request — and the request is the peer's
//   to choose. A second listener keeps the permit endpoint's contract intact.
//
// THE SCOPE OF THIS MODULE
//   It authenticates a remote peer and delivers a ticket. It does not sign
//   permits, does not open a service, does not create accounts, does not
//   touch ACLs and does not weaken the local peer's own ticket rules.

const crypto = require("node:crypto");
const http = require("node:http");
const { canonicalBytes } = require("./permit-delivery");

// The signed byte domain of the handshake. The domain prefix keeps a
// handshake signature from ever being readable as a signature over anything
// else in this codebase.
const HANDSHAKE_DOMAIN = "cortex.permit-ticket-agent-handshake.v1";

// The challenge window. A remote peer has to answer within it; the window is
// an acceptance bound, not a tunable.
const DEFAULT_CHALLENGE_TTL_MS = 5_000;
const MAX_CHALLENGE_TTL_MS = 30_000;

// How long a remote peer stays registered, and therefore how long a ticket
// minted for it can still match a live peer.
const DEFAULT_PEER_TTL_MS = 60_000;

// The cap on simultaneously live remote peers. A peer that connects and
// never uses its ticket must not be able to grow the registry without bound.
const MAX_LIVE_PEERS = 16;

// The request body cap. A handshake is a small JSON document.
const MAX_BODY_BYTES = 16 * 1024;

const LOOPBACK_ADDRESSES = Object.freeze(["127.0.0.1", "::1"]);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function isLoopback(host) {
  if (typeof host !== "string" || !host) return false;
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_ADDRESSES.includes(normalized);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value, name) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    fail("ERR_PERMIT_INPUT_INVALID: " + name);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("ERR_PERMIT_INPUT_INVALID: " + name);
  return value;
}

/**
 * Normalize a pinned peer entry.
 *
 * @param {object} peer
 * @returns {object}
 */
function normalizePeer(peer) {
  if (!isPlainObject(peer)) fail("ERR_PERMIT_INPUT_INVALID: peer");
  const peerId = requireText(peer.peerId, "peerId");
  const instanceId = requireText(peer.instanceId, "instanceId");
  // The PEM is NOT trim-checked: a PEM file's text ends with a newline, and
  // requiring the value to equal its trimmed form would refuse every key
  // that was read from a file. What matters is that it parses as an Ed25519
  // public key, which is checked below.
  if (typeof peer.publicKeyPem !== "string" || !peer.publicKeyPem) {
    fail("ERR_PERMIT_INPUT_INVALID: publicKeyPem");
  }
  const publicKeyPem = peer.publicKeyPem;
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(publicKeyPem);
  } catch (error) {
    fail("ERR_PERMIT_INPUT_INVALID: publicKeyPem");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("ERR_PERMIT_INPUT_INVALID: publicKeyPem");
  return Object.freeze({ peerId, instanceId, publicKeyPem, publicKey });
}

/**
 * The facts a remote peer signs.
 *
 * Every fact that ends up in the ticket's identity binding is in here, so a
 * peer cannot sign one set of facts and present another.
 *
 * @param {object} input
 * @returns {object}
 */
function handshakeFacts(input) {
  return {
    peerId: requireText(input.peerId, "peerId"),
    instanceId: requireText(input.instanceId, "instanceId"),
    pid: requirePositiveInteger(input.pid, "pid"),
    startToken: requireText(input.startToken, "startToken"),
    commandDigest: requireText(input.commandDigest, "commandDigest"),
    challengeId: requireText(input.challengeId, "challengeId"),
    challenge: requireText(input.challenge, "challenge"),
  };
}

/**
 * The bytes a remote peer signs.
 *
 * @param {object} facts
 * @returns {Buffer}
 */
function handshakeBytes(facts) {
  return canonicalBytes([HANDSHAKE_DOMAIN, facts]);
}

/**
 * Verify a remote peer's handshake signature against its pinned key.
 *
 * @param {object} facts
 * @param {object} peer The pinned peer.
 * @param {string} signatureBase64
 * @returns {boolean}
 */
function verifyHandshakeSignature(facts, peer, signatureBase64) {
  if (typeof signatureBase64 !== "string" || !signatureBase64) return false;
  let signature;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  try {
    return crypto.verify(null, handshakeBytes(facts), peer.publicKey, signature);
  } catch {
    return false;
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { code: "ERR_PERMIT_INPUT_INVALID" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Start the ticket agent.
 *
 * @param {object} options
 * @param {string[]} [options.peers] Pinned peer entries: `{ peerId, instanceId, publicKeyPem }`.
 * @param {function} options.mintTicket `(identity) => ticket`. The host's ticket registry.
 * @param {function} options.registerPeer `(identity, ttlMs) => void`. The host's peer registry.
 * @param {string} [options.bindAddress] Must be a loopback address.
 * @param {number} [options.port] 0 selects a free port.
 * @param {number} [options.challengeTtlMs]
 * @param {number} [options.peerTtlMs]
 * @param {function} [options.onDiagnostic]
 * @returns {Promise<object>} The running agent.
 */
async function startPermitTicketAgent(options = {}) {
  const {
    peers = [],
    mintTicket,
    registerPeer,
    bindAddress = "127.0.0.1",
    port = 0,
    challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
    peerTtlMs = DEFAULT_PEER_TTL_MS,
    onDiagnostic,
  } = options;

  if (!Array.isArray(peers) || !peers.length) fail("ERR_PERMIT_INPUT_INVALID: peers");
  if (typeof mintTicket !== "function") fail("ERR_PERMIT_INPUT_INVALID: mintTicket");
  if (typeof registerPeer !== "function") fail("ERR_PERMIT_INPUT_INVALID: registerPeer");
  if (!isLoopback(bindAddress)) fail("ERR_PERMIT_INPUT_INVALID: bindAddress");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail("ERR_PERMIT_INPUT_INVALID: port");
  if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs <= 0 ||
      challengeTtlMs > MAX_CHALLENGE_TTL_MS) {
    fail("ERR_PERMIT_INPUT_INVALID: challengeTtlMs");
  }
  if (!Number.isSafeInteger(peerTtlMs) || peerTtlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID: peerTtlMs");

  const pinned = new Map();
  for (const peer of peers) {
    const normalized = normalizePeer(peer);
    if (pinned.has(normalized.peerId)) fail("ERR_PERMIT_INPUT_INVALID: peers");
    pinned.set(normalized.peerId, normalized);
  }

  function diagnose(event, detail) {
    if (typeof onDiagnostic !== "function") return;
    try { onDiagnostic(event, detail); } catch { /* a diagnostic must not break the path */ }
  }

  // challengeId -> { challenge, expiresAt }
  const challenges = new Map();
  let closing = false;
  let closePromise = null;

  function purgeChallenges(now) {
    for (const [id, entry] of challenges) {
      if (entry.expiresAt <= now) challenges.delete(id);
    }
  }

  async function handleChallenge(response) {
    const now = Date.now();
    purgeChallenges(now);
    if (challenges.size >= MAX_LIVE_PEERS * 4) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end();
      return;
    }
    const challengeId = crypto.randomBytes(16).toString("hex");
    const challenge = crypto.randomBytes(32).toString("base64");
    challenges.set(challengeId, { challenge, expiresAt: now + challengeTtlMs });
    const body = JSON.stringify({ challengeId, challenge, expiresAtMs: now + challengeTtlMs });
    const encoded = Buffer.from(body, "utf8");
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(encoded.length),
    });
    response.end(encoded);
  }

  async function handleHandshake(request, response) {
    let body;
    try {
      body = await readBody(request, MAX_BODY_BYTES);
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end();
      return;
    }

    let payload;
    try { payload = JSON.parse(body); } catch { payload = null; }
    if (!isPlainObject(payload)) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end();
      return;
    }

    let facts;
    try {
      facts = handshakeFacts(payload);
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end();
      return;
    }

    // The challenge is burned on the FIRST use, successful or not. A failed
    // handshake must not leave a live challenge behind for a second try.
    const now = Date.now();
    purgeChallenges(now);
    const entry = challenges.get(facts.challengeId);
    challenges.delete(facts.challengeId);
    if (!entry || entry.expiresAt <= now || entry.challenge !== facts.challenge) {
      diagnose("challenge_rejected", facts.peerId);
      response.writeHead(401, { "content-type": "text/plain" });
      response.end();
      return;
    }

    const peer = pinned.get(facts.peerId);
    if (!peer || peer.instanceId !== facts.instanceId) {
      diagnose("peer_not_pinned", facts.peerId);
      response.writeHead(401, { "content-type": "text/plain" });
      response.end();
      return;
    }

    if (!verifyHandshakeSignature(facts, peer, payload.signature)) {
      diagnose("signature_rejected", facts.peerId);
      response.writeHead(401, { "content-type": "text/plain" });
      response.end();
      return;
    }

    // The remote peer's identity facts are the ones it just signed. They are
    // what the ticket is bound to, so the ticket says "this request came from
    // the remote process that proved this identity" and not merely "somebody
    // on the far end of a tunnel".
    const identity = Object.freeze({
      sessionId: "remote:" + facts.peerId + ":" + facts.challengeId,
      pid: facts.pid,
      startToken: facts.startToken,
      commandDigest: facts.commandDigest,
    });

    let ticket;
    try {
      registerPeer(identity, peerTtlMs);
      ticket = mintTicket(identity);
    } catch (error) {
      diagnose("ticket_mint_failed", error && (error.code || error.message));
      response.writeHead(502, { "content-type": "text/plain" });
      response.end();
      return;
    }

    diagnose("ticket_issued", facts.peerId);
    const encoded = Buffer.from(JSON.stringify({
      ticket,
      peerId: facts.peerId,
      sessionId: identity.sessionId,
      expiresAtMs: now + peerTtlMs,
    }), "utf8");
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(encoded.length),
    });
    response.end(encoded);
  }

  async function handle(request, response) {
    if (closing) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end();
      return;
    }
    const url = (request.url || "").split("?")[0];
    if (url === "/challenge") {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "text/plain" });
        response.end();
        return;
      }
      await handleChallenge(response);
      return;
    }
    if (url === "/handshake") {
      if (request.method !== "POST") {
        response.writeHead(405, { "content-type": "text/plain" });
        response.end();
        return;
      }
      await handleHandshake(request, response);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end();
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      try {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        response.end();
      } catch { /* the socket is already gone */ }
    });
  });

  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindAddress, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  diagnose("agent_listening", address && address.port);

  return Object.freeze({
    server,
    address,
    /**
     * The live challenge count. Diagnostics only.
     *
     * @returns {number}
     */
    pendingChallenges() {
      purgeChallenges(Date.now());
      return challenges.size;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise((resolve, reject) => {
        challenges.clear();
        for (const socket of sockets) {
          try { socket.destroy(); } catch { /* the socket is already gone */ }
        }
        sockets.clear();
        if (!server.listening) {
          resolve();
          return;
        }
        try {
          server.close((error) => (error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
        } catch (error) {
          reject(error);
        }
      });
      return closePromise;
    },
  });
}

module.exports = Object.freeze({
  HANDSHAKE_DOMAIN,
  MAX_CHALLENGE_TTL_MS,
  MAX_LIVE_PEERS,
  handshakeBytes,
  handshakeFacts,
  normalizePeer,
  startPermitTicketAgent,
  verifyHandshakeSignature,
});
