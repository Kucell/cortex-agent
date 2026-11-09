"use strict";

// ─── Permit Remote Peer Client (M-053 / R2-c) ───────────────────────────────
//
// WHAT THIS MODULE IS
//   The remote managed peer's half of the ticket-agent handshake. It runs on
//   the peer machine (the Windows side), asks the issuing bridge's agent for a
//   challenge, signs the handshake with the peer's pinned private key and
//   receives a ticket that is bound to the peer's own attested identity.
//
// WHY THE CLIENT SIGNS AND THE AGENT VERIFIES
//   The agent holds the peer's PUBLIC key; the peer holds the private key.
//   The trust therefore travels one way only: the agent can verify, and the
//   peer can never make the agent believe a fact it did not sign.
//
// WHY THE CLIENT SENDS ITS OWN PROCESS FACTS
//   `pid`, `startToken` and `commandDigest` are the facts the ticket is bound
//   to. They are signed, so they are attested rather than asserted — but they
//   are still reported BY the peer. A deployment that wants them checked
//   against something else has to check them on the peer side; the issuing
//   side can only see the peer's own signed word about them.

const crypto = require("node:crypto");
const http = require("node:http");
const { handshakeBytes, handshakeFacts } = require("./permit-ticket-agent");

const DEFAULT_TIMEOUT_MS = 5_000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

/**
 * Sign the handshake facts with the peer's private key.
 *
 * @param {string} privateKeyPem The peer's private key (PEM).
 * @param {object} facts The handshake facts.
 * @returns {string} The Base64 signature.
 */
function signHandshake(privateKeyPem, facts) {
  if (typeof privateKeyPem !== "string" || !privateKeyPem) fail("ERR_PERMIT_INPUT_INVALID");
  let key;
  try {
    key = crypto.createPrivateKey(privateKeyPem);
  } catch {
    fail("ERR_PERMIT_INPUT_INVALID: privateKeyPem");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("ERR_PERMIT_INPUT_INVALID: privateKeyPem");
  const signature = crypto.sign(null, handshakeBytes(facts), key);
  return Buffer.from(signature).toString("base64");
}

/**
 * Perform one HTTP request and read the response body.
 *
 * @param {object} options
 * @returns {Promise<{ status: number, body: string }>}
 */
function request(options) {
  const { url, method, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const target = new URL(url);
  const payload = body === undefined ? null : Buffer.from(body, "utf8");
  const finalHeaders = Object.assign({}, headers);
  if (payload) finalHeaders["content-length"] = String(payload.length);

  return new Promise((resolve, reject) => {
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: finalHeaders,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("request timed out"), { code: "ERR_PERMIT_REQUEST_TIMEOUT" }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Ask the ticket agent for a client ticket.
 *
 * @param {object} options
 * @param {string} options.agentUrl The agent's base URL (loopback or a tunnel).
 * @param {string} options.peerId The pinned peer id.
 * @param {string} options.instanceId The pinned instance id.
 * @param {object} options.identity `{ pid, startToken, commandDigest }`.
 * @param {string} options.privateKeyPem The peer's private key (PEM).
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} `{ ticket, sessionId, peerId, expiresAtMs }`.
 */
async function requestRemoteTicket(options = {}) {
  const { agentUrl, peerId, instanceId, identity, privateKeyPem, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (typeof agentUrl !== "string" || !agentUrl) fail("ERR_PERMIT_INPUT_INVALID: agentUrl");
  if (!identity || typeof identity !== "object") fail("ERR_PERMIT_INPUT_INVALID: identity");

  const challengeResponse = await request({
    url: agentUrl.replace(/\/$/, "") + "/challenge",
    method: "GET",
    timeoutMs,
  });
  if (challengeResponse.status !== 200) fail("ERR_PERMIT_AGENT_UNREACHABLE");

  let challenge;
  try { challenge = JSON.parse(challengeResponse.body); } catch { fail("ERR_PERMIT_INPUT_INVALID"); }

  const facts = handshakeFacts({
    peerId,
    instanceId,
    pid: identity.pid,
    startToken: identity.startToken,
    commandDigest: identity.commandDigest,
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
  });
  const signature = signHandshake(privateKeyPem, facts);

  const handshakeResponse = await request({
    url: agentUrl.replace(/\/$/, "") + "/handshake",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Object.assign({}, facts, { signature })),
    timeoutMs,
  });
  if (handshakeResponse.status !== 200) fail("ERR_PERMIT_AGENT_REJECTED");

  let result;
  try { result = JSON.parse(handshakeResponse.body); } catch { fail("ERR_PERMIT_INPUT_INVALID"); }
  if (typeof result.ticket !== "string" || !result.ticket) fail("ERR_PERMIT_INPUT_INVALID: ticket");
  return result;
}

module.exports = Object.freeze({
  request,
  requestRemoteTicket,
  signHandshake,
});
