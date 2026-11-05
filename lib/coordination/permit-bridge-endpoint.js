"use strict";

// ─── Permit Bridge Endpoint (M-053 / MS-008 第 9 环阶段 C) ─────────────────
//
// WHAT THIS IS
//   The transport half of the bridge. It accepts one HTTP request and turns
//   it into exactly one `authority.dispatch(peer, action, args)` call on a
//   managed session, then returns the result verbatim.
//
// WHY THE TRANSPORT IS WHERE THE PEER COMES FROM
//   `permit-authority-service.dispatch` documents that the transport owns peer
//   authentication and must supply an opaque verified context. This module is
//   that transport, so the `peer` it passes to `dispatch` is the identity the
//   managed session verified — never a value taken from the request body.
//
// THE LOOPBACK BINDING IS A HARD CONSTRAINT, NOT A DEFAULT
//   The Owner ruling fixed the issuing endpoint to `127.0.0.1`. A bridge that
//   bound `0.0.0.0` would expose "whoever can reach me may ask for a permit"
//   to the network, and the product-side dispatcher sends NO authentication
//   header: `ManagedPermitDispatcher.TryCreateFromEnvironment` reads only the
//   endpoint address and the timeout. The endpoint's own access control is
//   therefore the only access control there is. So the bind address is
//   validated, not merely defaulted: a non-loopback address is refused.
//
// THE PROJECTION FIELDS ARE NOT FILLED IN HERE
//   The permit grant's projection fields (`operation`, `targetDigest`, …) are
//   part of the SIGNED message. `AutomationPermitEvidence` states plainly that
//   the projection is not an authorization: any process that can write those
//   fields can forge a conforming-looking projection. So the bridge parses
//   the projection out of the signed message and never from the request.
//   If the message cannot be parsed, the grant is refused rather than
//   completed with a half-filled projection.
//
// NO DOWNGRADE
//   Every failure path answers with a non-2xx status or an unparsable body.
//   The product side treats non-2xx, a timeout, an unparsable body and a
//   malformed grant identically — as "no permit" — and the worker's gate
//   fails closed. A bridge that answered 200 with a partial result would turn
//   a channel fault into a permission decision.
//
// THE CLIENT IS AUTHENTICATED BY A TICKET, NOT BY ITS ADDRESS
//   The loopback binding is necessary but not sufficient: on a development
//   machine every process of the interactive account shares the same loopback
//   interface, so "it came from 127.0.0.1" says nothing about who it was.
//   A bystander process that could post to this endpoint would obtain a
//   signed permit, which is exactly the counterexample the peer-authentication
//   ruling has to rule out.
//
//   So every request must carry a ticket that the bridge minted for a VERIFIED
//   managed-session peer. The ticket is one-shot: the first request that
//   presents it consumes it, so a captured ticket cannot be replayed. A
//   request without a valid ticket is refused before the payload is read,
//   let alone dispatched.

const http = require("node:http");
const { CoordinationError } = require("./errors");
const { readTicketHeader } = require("./permit-bridge-ticket");
const { canonicalize } = require("./permit-delivery");

// The request body cap. A permit request is a small JSON document; a body
// larger than this is not a permit request and must not be buffered.
const MAX_BODY_BYTES = 64 * 1024;

// The request timeout. The product side waits 5 seconds for a grant, so a
// bridge that takes longer than that has already lost the race; it must
// answer with a failure rather than hold the connection.
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

// How long close() keeps draining already-accepted connections before it
// destroys them. The product side only waits 5 seconds for a grant, so a
// bridge being torn down must not be held open by a slow or half-open
// client. The budget is deliberately short and fixed.
const DEFAULT_CLOSE_DRAIN_MS = 1_000;

const LOOPBACK_ADDRESSES = Object.freeze(["127.0.0.1", "::1"]);

// The signed message field -> product-side projection field. The product side
// expects camelCase projection names; the signed message carries snake_case.
const PROJECTION_FIELDS = Object.freeze([
  ["operation", "operation"],
  ["target_digest", "targetDigest"],
  ["params_digest", "paramsDigest"],
  ["desktop_key", "desktopKey"],
  ["session_id", "sessionId"],
  ["worker_identity", "workerIdentity"],
  ["run_id", "runId"],
  ["generation", "generation"],
  ["host_identity", "hostIdentity"],
  ["owned_app_id", "ownedAppId"],
]);

function isLoopback(host) {
  if (typeof host !== "string" || !host) return false;
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_ADDRESSES.includes(normalized);
}

function fail(code) {
  throw new CoordinationError(code);
}

/**
 * Parse a JSON text into a plain object, or null when it is not one.
 *
 * @param {string} text
 * @returns {object|null}
 */
function parseJsonObject(text) {
  if (typeof text !== "string" || !text) return null;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Parse the projection fields out of a signed permit message.
 *
 * The message is the signed original, so it is the only trustworthy source
 * for the projection. A message that cannot be parsed yields null: the caller
 * must then fail closed rather than send a grant without a projection.
 *
 * @param {object|string} message The signed message: an object, or the JSON
 *   text form.
 * @returns {object|null}
 */
function parseProjection(message) {
  if (typeof message === "string") {
    try { message = JSON.parse(message); }
    catch { return null; }
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;

  const projection = {};
  for (const [signed, projected] of PROJECTION_FIELDS) {
    const value = message[signed];
    // A missing binding field means the signed message does not carry the
    // full binding. The projection is then incomplete, and an incomplete
    // projection is indistinguishable from a forged one downstream.
    if (typeof value !== "string" || !value) return null;
    projection[projected] = value;
  }
  if (typeof message.permit_id !== "string" || !message.permit_id) return null;
  projection.permitId = message.permit_id;
  return projection;
}

/**
 * Build the product-side grant from a dispatch result.
 *
 * @param {object} result The dispatch result for the `issue` action.
 * @returns {object|null} The grant, or null when it cannot be built honestly.
 */
function buildGrant(result) {
  if (!result || typeof result !== "object") return null;
  const signed = result.signedPermit;
  if (!signed || typeof signed !== "object") return null;
  // The cortex signer produces the signed message as an OBJECT. The product
  // side canonicalizes a JSON TEXT and compares the resulting bytes with the
  // signed bytes, so the bridge has to hand over a text that reproduces the
  // signer's canonical form byte for byte. The signer's own canonicalizer is
  // the only thing that can produce that text: a generic JSON.stringify
  // would differ in key order and in whitespace, and the product would then
  // compute different bytes and refuse a perfectly valid signature.
  //
  // The text form is accepted too, because a caller may already hold the
  // signed message as text. It is parsed and then re-canonicalized, so both
  // forms yield the same bytes.
  const message = typeof signed.message === "string"
    ? parseJsonObject(signed.message)
    : signed.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  let messageJson;
  try { messageJson = canonicalize(message); }
  catch { return null; }
  if (typeof signed.signature !== "string" || !signed.signature) return null;
  if (typeof result.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(result.fingerprint)) return null;
  if (!Number.isSafeInteger(signed.sequence) || signed.sequence < 0) return null;
  if (!Number.isSafeInteger(signed.deadline)) return null;

  const projection = parseProjection(message);
  if (!projection) return null;

  return Object.freeze({
    messageJson,
    signatureBase64: signed.signature,
    fingerprint: result.fingerprint,
    sequence: signed.sequence,
    deadlineMs: signed.deadline,
    ...projection,
  });
}

/**
 * Build the revocation-list response from a dispatch result.
 *
 * This is a DIFFERENT response shape from the grant, not a variant of it:
 * the grant carries a signed permit plus its projection, while the list
 * carries a signed revocation envelope. `buildGrant` cannot produce this
 * shape (it reads `result.signedPermit`), so the two are built side by side.
 *
 * The list is returned in the SHAPE THE TARGET SIDE CONSUMES: the envelope's
 * fields at the TOP level, with `signature` beside them. The target side's
 * `applyRevocationList` reads `list.revocation_sequence`,
 * `list.revoked_fingerprints`, `list.issued_at_ms`,
 * `list.prev_revocation_sequence`, `list.batch_public_key_fingerprint` and
 * `list.signature` directly off the document it received — it does not look
 * inside a nested envelope. A response that nested the envelope would be a
 * well-formed JSON document that the target would reject as unparsable.
 *
 * The target canonicalizes the message it verifies, so the bytes it
 * recomputes have to be the bytes the signer canonicalized — which is why
 * the message is re-canonicalized here with the signer's own canonicalizer
 * rather than with `JSON.stringify` (whose key order and whitespace would
 * differ and would make the target compute different bytes for a perfectly
 * valid signature). The canonical form is carried alongside so a caller
 * that needs the exact bytes does not have to re-derive them.
 *
 * @param {object} result The dispatch result for the `revocation-list` action.
 * @returns {object|null} The list, or null when it cannot be built honestly.
 */
function buildRevocationList(result) {
  if (!result || typeof result !== "object") return null;
  const sequence = result.revocation_sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  const previous = result.prev_revocation_sequence;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous !== sequence - 1) return null;
  if (!Number.isSafeInteger(result.issued_at_ms) || result.issued_at_ms < 0) return null;
  if (typeof result.batch_public_key_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.batch_public_key_fingerprint)) return null;
  if (typeof result.signature !== "string" || !result.signature) return null;
  if (!Array.isArray(result.revoked_fingerprints)) return null;
  if (result.revoked_fingerprints.some((fingerprint) =>
    typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) return null;

  // The message is the part that was signed. It is rebuilt from the signed
  // fields — not copied from the response — so a response that carried an
  // extra field cannot smuggle it into the verified bytes.
  const message = {
    revocation_sequence: sequence,
    revoked_fingerprints: [...result.revoked_fingerprints].sort(),
    issued_at_ms: result.issued_at_ms,
    prev_revocation_sequence: previous,
    batch_public_key_fingerprint: result.batch_public_key_fingerprint,
  };
  let messageJson;
  try { messageJson = canonicalize(message); }
  catch { return null; }

  return Object.freeze({
    // The envelope fields, at the top level, exactly as the target side
    // reads them.
    revocation_sequence: sequence,
    revoked_fingerprints: message.revoked_fingerprints,
    issued_at_ms: result.issued_at_ms,
    prev_revocation_sequence: previous,
    batch_public_key_fingerprint: result.batch_public_key_fingerprint,
    signature: result.signature,
    // The canonical bytes of the signed message, carried so the target does
    // not have to re-derive them. It is NOT part of the signed message.
    messageJson,
  });
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { code: "ERR_BRIDGE_BODY_TOO_LARGE" }));
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
 * Create the bridge's HTTP endpoint.
 *
 * @param {object} options
 * @param {function} options.perform `(action, payload, ticketFacts) => Promise<result>`.
 *   The assembly layer's entry point for one action. The endpoint does not
 *   call `authority.dispatch` itself: the dispatch has to happen INSIDE the
 *   managed session, so that the peer the authority sees is the verified
 *   identity of the supervised process rather than a value the endpoint
 *   could have invented.
 *   `ticketFacts` are the identity facts the presented ticket was minted for.
 *   They are handed over so the assembly can require that the ticket and the
 *   session's pinned peer are the same peer — a ticket for one identity must
 *   not authorize a request that another identity's session would carry.
 * @param {string} [options.action] The single action this endpoint forwards.
 * @param {string} [options.bindAddress] Must be a loopback address.
 * @param {number} [options.port] The port to listen on. 0 selects a free port.
 * @param {number} [options.requestTimeoutMs]
 * @param {object} [options.tickets] The ticket registry. A request without a
 *   live ticket is refused.
 * @param {function} [options.onDiagnostic] Receives non-sensitive diagnostics.
 * @returns {object} The endpoint, with `listen`, `address` and `close`.
 */
function createPermitBridgeEndpoint(options = {}) {
  const {
    perform,
    action = "issue",
    bindAddress = "127.0.0.1",
    port = 0,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    closeDrainMs = DEFAULT_CLOSE_DRAIN_MS,
    tickets,
    onDiagnostic,
  } = options;

  if (typeof perform !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof action !== "string" || !action) fail("ERR_PERMIT_INPUT_INVALID");
  if (!isLoopback(bindAddress)) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(closeDrainMs) || closeDrainMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (!tickets || typeof tickets.consume !== "function") fail("ERR_PERMIT_INPUT_INVALID");

  function diagnose(event, detail) {
    if (typeof onDiagnostic !== "function") return;
    try { onDiagnostic(event, detail); } catch { /* a diagnostic must not break the path */ }
  }

  // Once close() begins the endpoint accepts no new work. A request that
  // raced the shutdown must not reach the dispatch path after the bridge has
  // declared itself closed.
  let closed = false;
  let closePromise = null;

  async function handle(request, response) {
    if (closed) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end();
      return;
    }

    // The ticket is consumed BEFORE the body is read. A request that cannot
    // authenticate itself must not get to make the bridge allocate a buffer
    // for it, and it must not get to reach the dispatch path at all.
    const ticket = readTicketHeader(request.headers);
    const ticketFacts = ticket ? tickets.consume(ticket) : null;
    if (!ticketFacts) {
      diagnose("ticket_rejected", null);
      response.writeHead(401, { "content-type": "text/plain" });
      response.end();
      return;
    }

    let body;
    try {
      body = await readBody(request, MAX_BODY_BYTES);
    } catch (error) {
      diagnose("body_rejected", error && error.code);
      response.writeHead(413, { "content-type": "text/plain" });
      response.end();
      return;
    }

    let payload;
    try { payload = JSON.parse(body); }
    catch {
      diagnose("body_unparsable", null);
      response.writeHead(400, { "content-type": "text/plain" });
      response.end();
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end();
      return;
    }

    // The dispatch runs inside the managed session, so the peer that
    // `authority.dispatch` sees is the identity the session verified. The
    // payload never carries an identity.
    let result;
    try {
      result = await perform(action, payload, ticketFacts);
    } catch (error) {
      diagnose("dispatch_failed", error && (error.code || error.message));
      response.writeHead(502, { "content-type": "text/plain" });
      response.end();
      return;
    }

    // The response shape depends on the action: `issue` produces a permit
    // grant, `revocation-list` produces a signed revocation envelope. Each
    // has its own builder, and a result that does not fit its builder is
    // refused rather than reshaped.
    const responseBody = action === "revocation-list" ? buildRevocationList(result) : buildGrant(result);
    if (!responseBody) {
      // The dispatch succeeded but the result cannot be turned into an
      // honest grant. Refusing here is the whole point: a grant with a
      // missing projection would be unverifiable downstream, and the product
      // side would treat it as a permission it cannot check.
      diagnose("grant_incomplete", null);
      response.writeHead(502, { "content-type": "text/plain" });
      response.end();
      return;
    }

    const encoded = Buffer.from(JSON.stringify(responseBody), "utf8");
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(encoded.length),
    });
    response.end(encoded);
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      try {
        if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
        response.end();
      } catch { /* the socket is already gone */ }
    });
  });

  // A slow peer must not be able to hold a connection open indefinitely.
  server.headersTimeout = requestTimeoutMs;
  server.requestTimeout = requestTimeoutMs;

  // Track accepted sockets so close() can destroy the ones that did not
  // drain within the budget. server.closeAllConnections() handles HTTP
  // connections; the set also covers connections that never completed a
  // request and therefore may not be visible to the HTTP layer.
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return Object.freeze({
    server,
    action,
    bindAddress,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bindAddress, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    address() {
      return server.address();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          for (const socket of sockets) {
            try { socket.destroy(); } catch { /* the socket is already gone */ }
          }
          sockets.clear();
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => {
          try {
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          } catch { /* best effort; the sockets below are the fallback */ }
          finish(null);
        }, closeDrainMs);
        // An endpoint that never listened has no resource to release. Treat
        // that expected state as a successful close instead of reporting an
        // error the caller cannot act on.
        if (!server.listening) {
          finish(null);
          return;
        }
        try {
          server.close((error) => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") finish(error);
            else finish(null);
          });
        } catch (error) {
          finish(error && error.code !== "ERR_SERVER_NOT_RUNNING" ? error : null);
        }
        // Stop accepting new keep-alive requests immediately; the drain timer
        // then bounds how long an idle connection may delay the close.
        try {
          if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
        } catch { /* best effort */ }
      });
      return closePromise;
    },
  });
}

module.exports = Object.freeze({
  MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_CLOSE_DRAIN_MS,
  PROJECTION_FIELDS,
  createPermitBridgeEndpoint,
  parseProjection,
  buildGrant,
  buildRevocationList,
  isLoopback,
});
