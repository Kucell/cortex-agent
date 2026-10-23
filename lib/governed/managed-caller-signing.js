"use strict";

// ─── Managed Caller Signing (M-044 / MS-002) ───────────────────────────────
//
// The response authentication primitive of the managed caller session.
//
// Why the secret is not enough on its own
// -------------------------------------
// A nonce proves that the other end saw a value the coordinator generated.
// It does NOT prove that the other end is the process the coordinator
// supervises, because the IPC channel is transferable: a descendant that
// inherited the handle sees the nonce too, and can replay it.
//
// The fix is a second, independent channel. The session secret travels only
// on that channel, so it never reaches a process that merely inherited the
// IPC handle. Every response is then MAC-signed over the request identity,
// which binds the answer to one specific request and rules out both replay
// and substitution.
//
// Why the DIRECTION has to be part of the MAC
// -------------------------------------------
// The relay attack. A descendant that holds the transferred IPC handle can
// read the coordinator's own outbound REQUEST and replay it back as an
// inbound REQUEST. If the coordinator answers inbound requests with its own
// key — using the same MAC kind it uses for outbound requests — the
// descendant can feed that signed answer straight back into the
// coordinator's pending slot. The coordinator then accepts a response its
// supervised child never sent, computed from an attacker-chosen payload.
//
// The fix is to bind the direction into the signed kind. The coordinator only
// ever accepts answers signed as `REQUEST_OUT_RESPONSE`; the answers it
// produces for inbound requests are signed as `REQUEST_IN_RESPONSE`. A
// relayed answer therefore carries a kind the coordinator will never accept,
// and an inbound request is only executed after its own MAC verifies under
// `REQUEST_IN` — which a descendant without the secret cannot produce.
//
// The MAC covers:
//   - the message kind, which encodes both the role (handshake vs. request)
//     and the direction (outbound vs. inbound);
//   - the request id, so an answer cannot be moved to another request;
//   - the sequence number, so a stale answer cannot be passed off as fresh;
//   - the operation, so an answer cannot be moved to another operation;
//   - the request payload digest, so an answer is bound to the exact payload
//     of the request it answers and cannot be reused for another payload;
//   - the response body, so the result cannot be swapped after signing.

const crypto = require("node:crypto");

/**
 * The message kinds that can be authenticated.
 *
 * The naming is `<role>` for a handshake and `<direction>-<role>` for a
 * request exchange. The four request kinds are what stop the relay attack,
 * so they must never be collapsed into one another.
 */
const SIGNED_MESSAGE_KIND = Object.freeze({
  HELLO: "hello",

  // A request the coordinator sends to the supervised child.
  REQUEST_OUT: "request-out",
  // The supervised child's answer to an outbound request.
  REQUEST_OUT_RESPONSE: "request-out-response",

  // A request the supervised child sends to the coordinator.
  REQUEST_IN: "request-in",
  // The coordinator's answer to an inbound request.
  REQUEST_IN_RESPONSE: "request-in-response",
});

/**
 * Digest a request payload so that an answer can be bound to the exact
 * payload of the request it answers.
 *
 * Without this, a signed answer says nothing about WHICH payload produced it.
 * An attacker that relays the coordinator's own request could pick a payload,
 * have the coordinator compute a result for it, and reuse that signed answer
 * for the original request.
 *
 * @param {*} payload
 * @returns {string}
 */
function digestPayload(payload) {
  const canonical = payload === undefined ? "\u0000undefined" : JSON.stringify(payload);
  return crypto.createHash("sha256").update(String(canonical)).digest("hex");
}

/**
 * Build the canonical string that the MAC is computed over.
 *
 * @param {object} fields
 * @returns {string}
 */
function canonicalize(fields) {
  return [
    fields.kind,
    fields.requestId,
    String(fields.seq === undefined ? "" : fields.seq),
    fields.operation === undefined ? "" : fields.operation,
    fields.payloadDigest === undefined ? "" : fields.payloadDigest,
    JSON.stringify(fields.body === undefined ? null : fields.body),
  ].join("\n");
}

/**
 * Compute the MAC that authenticates one response.
 *
 * @param {string} secret Hex session secret.
 * @param {object} fields
 * @returns {string} Hex HMAC-SHA256.
 */
function signResponse(secret, fields) {
  return crypto.createHmac("sha256", secret).update(canonicalize(fields)).digest("hex");
}

/**
 * Verify a MAC in constant time.
 *
 * A malformed or truncated MAC is rejected rather than throwing: a bad
 * signature is a normal negative case, not an exceptional one.
 *
 * @param {string} secret
 * @param {object} fields
 * @param {string} mac
 * @returns {boolean}
 */
function verifyResponse(secret, fields, mac) {
  if (typeof mac !== "string" || !mac) return false;
  const expected = signResponse(secret, fields);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(mac, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  SIGNED_MESSAGE_KIND,
  canonicalize,
  digestPayload,
  signResponse,
  verifyResponse,
};
