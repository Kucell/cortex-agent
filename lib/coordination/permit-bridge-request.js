"use strict";

// ─── Permit Bridge Request Mapping (M-053 / MS-008 第 9 环阶段 C) ──────────
//
// WHAT THIS IS
//   The wire mapping between the PRODUCT side and the CORTEX side of the
//   bridge. The product posts a flat `AutomationPermitRequest` (camelCase,
//   C# `JsonSerializerDefaults.Web`); the cortex authority's `issue` action
//   wants `{ lease, permit }` with its own field names.
//
// WHY THE MAPPING IS NOT OPTIONAL
//   The bridge policy compares the request shape field by field
//   (`REQUEST_FIELDS.issue` is exactly `["lease", "permit"]`). A flat
//   product request would therefore be refused before it ever reached the
//   store — not because the request was wrong, but because it was spelled in
//   the other language.
//
// WHY THE MAPPING FILLS IN NOTHING
//   Every field below is either carried across from the product request or
//   derived from it by a rule that is stated here and nowhere else. The
//   mapping does not invent a binding: a product request that lacks a
//   required binding field is refused, because a bridge that completed it
//   would be issuing a permit for a binding nobody asked for.
//
// THE IDEMPOTENCY KEY IS DERIVED, NOT CHOSEN
//   The store's idempotency is keyed on a caller-supplied key. The product
//   request already carries a `correlationId` and a `sessionId`; the key is
//   built from those plus the operation, so that the SAME logical dispatch
//   maps to the SAME key (and is therefore idempotent) while two different
//   dispatches never collide. A key built from a timestamp would be unique
//   but not idempotent, and a key built from the operation alone would
//   collapse every dispatch of an operation into one.
//
// THE LEASE TTL AND THE PERMIT TTL ARE SEPARATE
//   The lease is the desktop slot; the permit is the one-shot authority. The
//   product side does not send either. The lease TTL is the bridge's own
//   lease-window bound and the permit TTL is the one-shot validity; both are
//   configuration, not request data, and both are bounded by the store.

const { CoordinationError } = require("./errors");

function fail(code) {
  throw new CoordinationError(code);
}

// The product-side field -> the lease field it supplies. `owner` and the
// TTLs are the only fields the product does not supply.
const LEASE_FIELD_MAP = Object.freeze({
  sessionId: "sessionId",
  hostIdentity: "hostId",
  workerIdentity: "workerId",
  runId: "runId",
  generation: "generation",
  desktopKey: "desktopKey",
  ownedAppId: "ownedAppId",
});

// The product-side field -> the permit field it supplies.
const PERMIT_FIELD_MAP = Object.freeze({
  operation: "operation",
  targetDigest: "targetDigest",
  paramsDigest: "paramsDigest",
});

const REQUIRED_PRODUCT_FIELDS = Object.freeze([
  "operation",
  "targetDigest",
  "paramsDigest",
  "desktopKey",
  "sessionId",
  "workerIdentity",
  "runId",
  "generation",
  "hostIdentity",
  "ownedAppId",
  "correlationId",
]);

function requireText(value) {
  if (typeof value !== "string" || !value) fail("ERR_PERMIT_INPUT_INVALID");
  return value;
}

function requireDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail("ERR_PERMIT_INPUT_INVALID");
  return value.toLowerCase();
}

/**
 * Derive the idempotency key for a dispatch.
 *
 * The key must be stable for the same logical dispatch and different for
 * every other dispatch. `correlationId` is the product's own identifier for
 * this dispatch, so it is the natural discriminator; the session and the
 * operation are folded in so that two dispatches that reused a correlation
 * id across sessions or operations still get distinct keys.
 *
 * @param {object} request The product-side request.
 * @returns {string}
 */
function deriveIdempotencyKey(request) {
  const correlationId = requireText(request.correlationId);
  const sessionId = requireText(request.sessionId);
  const operation = requireText(request.operation);
  return ["p", sessionId, operation, correlationId].join(":");
}

/**
 * Map a product-side request onto the cortex authority's `issue` request.
 *
 * @param {object} request The product-side `AutomationPermitRequest`.
 * @param {object} [options]
 * @param {string} [options.owner] The lease owner. Defaults to the session id.
 * @param {number} [options.leaseTtlMs]
 * @param {number} [options.permitTtlMs]
 * @returns {{lease: object, permit: object}}
 */
function mapIssueRequest(request, options = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("ERR_PERMIT_INPUT_INVALID");
  }
  for (const field of REQUIRED_PRODUCT_FIELDS) requireText(request[field]);

  const leaseTtlMs = options.leaseTtlMs;
  const permitTtlMs = options.permitTtlMs;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (!Number.isSafeInteger(permitTtlMs) || permitTtlMs <= 0) fail("ERR_PERMIT_INPUT_INVALID");

  const lease = {
    owner: requireText(options.owner || request.sessionId),
    idempotencyKey: deriveIdempotencyKey(request),
    ttlMs: leaseTtlMs,
  };
  for (const [product, leaseField] of Object.entries(LEASE_FIELD_MAP)) {
    lease[leaseField] = requireText(request[product]);
  }

  const permit = {
    idempotencyKey: lease.idempotencyKey,
    ttlMs: permitTtlMs,
  };
  for (const [product, permitField] of Object.entries(PERMIT_FIELD_MAP)) {
    permit[permitField] = product === "targetDigest" || product === "paramsDigest"
      ? requireDigest(request[product])
      : requireText(request[product]);
  }

  return { lease, permit };
}

module.exports = Object.freeze({
  LEASE_FIELD_MAP,
  PERMIT_FIELD_MAP,
  REQUIRED_PRODUCT_FIELDS,
  deriveIdempotencyKey,
  mapIssueRequest,
});
