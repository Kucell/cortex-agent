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
    tickets,
    onDiagnostic,
  } = options;

  if (typeof perform !== "function") fail("ERR_PERMIT_INPUT_INVALID");
  if (typeof action !== "string" || !action) fail("ERR_PERMIT_INPUT_INVALID");
  if (!isLoopback(bindAddress)) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (!tickets || typeof tickets.consume !== "function") fail("ERR_PERMIT_INPUT_INVALID");

  function diagnose(event, detail) {
    if (typeof onDiagnostic !== "function") return;
    try { onDiagnostic(event, detail); } catch { /* a diagnostic must not break the path */ }
  }

  async function handle(request, response) {
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

    const grant = buildGrant(result);
    if (!grant) {
      // The dispatch succeeded but the result cannot be turned into an
      // honest grant. Refusing here is the whole point: a grant with a
      // missing projection would be unverifiable downstream, and the product
      // side would treat it as a permission it cannot check.
      diagnose("grant_incomplete", null);
      response.writeHead(502, { "content-type": "text/plain" });
      response.end();
      return;
    }

    const encoded = Buffer.from(JSON.stringify(grant), "utf8");
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
      return new Promise((resolve) => server.close(() => resolve()));
    },
  });
}

module.exports = Object.freeze({
  MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROJECTION_FIELDS,
  createPermitBridgeEndpoint,
  parseProjection,
  buildGrant,
  isLoopback,
});
