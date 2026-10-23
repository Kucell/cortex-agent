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
// The MAC covers:
//   - the message kind (handshake vs. request), so a handshake proof cannot
//     be replayed as a request answer and vice versa;
//   - the request id, so an answer cannot be moved to another request;
//   - the sequence number, so a stale answer cannot be passed off as fresh;
//   - the operation, so an answer cannot be moved to another operation;
//   - the response body, so the result cannot be swapped after signing.

const crypto = require("node:crypto");

/** The message kinds that can be authenticated. */
const SIGNED_MESSAGE_KIND = Object.freeze({
  HELLO: "hello",
  REQUEST: "request",
});

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
  signResponse,
  verifyResponse,
};
