"use strict";

// Stage A OFFLINE candidate: explicit v2 framing / format 2 history only.
// No authentication, listener, dispatch, store access, retry or recovery. A
// trusted owner must independently bind a history context; JSON cannot make one.
// Byte 0 means observed ONLY in this contract, never committed. Existing codecs
// and native exchanges must keep rejecting this payload until separately gated.
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const frame = require("./permit-witness-v2-frame");
const contract = require("./permit-witness-contract");
const delivery = require("./permit-delivery");
const FORMAT_VERSION = 2;
const HISTORY_STATUS = Object.freeze({ observed: 0, rejected: 1, unknown: 2, unavailable: 3 });
const LEASE = ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"];
const PERMIT = ["operation", "targetDigest", "paramsDigest"];
const PIN = ["decision_id", "instance_id", "fingerprint", "public_key_pem", "source_digest", "deployment_digest",
  "run_id", "generation", "valid_from", "valid_until"];
const CHECKPOINT = ["format_version", "authority_id", "target_id", "store_generation", "revision", "full_state_digest"];
const MESSAGE = [...delivery.BINDING_FIELD_MAP.map(([, name]) => name), "issued_at_ms", "deadline_ms", "permit_id"];
const REQUESTS = Object.freeze({ register: ["targetId", "requestId", "checkpoint", "pin"],
  issue: ["targetId", "checkpoint", "lease", "permit", "batchFingerprint"],
  consume: ["targetId", "checkpoint", "message", "signature"] });
const SAFETY = ["mode", "executionAuthorized", "resumeAllowed", "originalRequestOutcome"];

class PermitWitnessHistoryWireError extends Error {
  constructor(code) { super(code); this.name = "PermitWitnessHistoryWireError"; this.code = code; }
}
function fail(code = "ERR_WITNESS_HISTORY_WIRE_SCHEMA") { throw new PermitWitnessHistoryWireError(code); }
function exact(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail();
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d.enumerable || !Object.hasOwn(d, "value")) fail();
  }
}
function text(value) { if (typeof value !== "string" || !value) fail(); }
function integer(value, min = 0) { if (!Number.isSafeInteger(value) || value < min || Object.is(value, -0)) fail(); }
function hash(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); }
function digestInput(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail();
  return value.toLowerCase();
}
function mapKey(value) {
  text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) fail();
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonical(value) {
  try { return contract.canonicalBytes(value); } catch { fail("ERR_WITNESS_HISTORY_WIRE_JSON"); }
}
function digest(value) { return crypto.createHash("sha256").update(canonical(value)).digest("hex"); }
function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > contract.LIMITS.bytes) fail("ERR_WITNESS_HISTORY_WIRE_SIZE");
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { fail("ERR_WITNESS_HISTORY_WIRE_JSON"); }
  // Compare ORIGINAL bytes: duplicates/escaped aliases, BOM, whitespace, number
  // spelling, ordering and UTF-8 cannot be laundered by an upstream JSON parser.
  if (!canonical(value).equals(bytes)) fail("ERR_WITNESS_HISTORY_WIRE_NONCANONICAL");
  return value;
}
function safety(value) {
  if (value.mode !== "development-only" || value.executionAuthorized !== false || value.resumeAllowed !== false ||
      value.originalRequestOutcome !== "unknown") fail();
}
function checkpoint(cp, query, generation = query.targetGeneration) {
  exact(cp, CHECKPOINT);
  if (cp.format_version !== 1 || cp.authority_id !== query.authorityId || cp.target_id !== query.request.targetId ||
      (generation !== null && cp.store_generation !== generation)) fail();
  text(cp.store_generation); integer(cp.revision, 1); hash(cp.full_state_digest);
}
function message(m) {
  exact(m, MESSAGE);
  for (const [key, value] of Object.entries(m)) {
    if (["service_epoch", "fencing", "sequence"].includes(key)) integer(value, 1);
    else if (["issued_at_ms", "deadline_ms"].includes(key)) integer(value);
    else if (["target_digest", "params_digest"].includes(key)) hash(value);
    else text(value);
  }
  mapKey(m.permit_id);
  if (m.deadline_ms <= m.issued_at_ms) fail();
}
function queryBody(q) {
  exact(q, ["operation", "decisionId", "authorityId", "issuerStoreId", "targetGeneration", "resources", "request"]);
  if (typeof q.operation !== "string" || !Object.hasOwn(REQUESTS, q.operation)) fail();
  [q.decisionId, q.authorityId, q.issuerStoreId].forEach(text);
  if (q.targetGeneration !== null) text(q.targetGeneration);
  const r = q.request, resources = q.resources;
  exact(r, REQUESTS[q.operation]); mapKey(r.targetId);
  exact(resources, ["fingerprint", "lease", "permit"]); hash(resources.fingerprint);
  if (q.targetGeneration === null && (q.operation !== "register" || r.checkpoint !== null)) fail();
  if (r.checkpoint !== null) checkpoint(r.checkpoint, q);
  else if (q.operation !== "register") fail();
  if (q.operation === "register") {
    if (resources.lease !== null || resources.permit !== null) fail();
    mapKey(r.requestId); exact(r.pin, PIN);
    try {
      contract.normalizeTargetState({ schema_version: 3, pins: [{ ...r.pin, registered_at_ms: 0 }],
        revoked_fingerprints: [], applied_revocation_sequence: 0, highest_seen_revocation_sequence: 0,
        highest_accepted_permit_sequence: 0, last_observed_clock_ms: 0, clock_poisoned: false });
      if (crypto.createPublicKey(r.pin.public_key_pem).asymmetricKeyType !== "ed25519" ||
          delivery.publicKeyFingerprint(r.pin.public_key_pem) !== r.pin.fingerprint) fail();
    } catch { fail(); }
    if (r.pin.decision_id !== q.decisionId || r.pin.instance_id !== r.targetId || r.pin.fingerprint !== resources.fingerprint) fail();
    return;
  }
  exact(resources.lease, LEASE); Object.values(resources.lease).forEach(text);
  exact(resources.permit, PERMIT); text(resources.permit.operation);
  digestInput(resources.permit.targetDigest); digestInput(resources.permit.paramsDigest);
  if (q.operation === "issue") {
    exact(r.lease, [...LEASE, "idempotencyKey", "ttlMs"]);
    exact(r.permit, [...PERMIT, "idempotencyKey", "ttlMs"]);
    LEASE.forEach(key => text(r.lease[key])); text(r.permit.operation);
    for (const item of [r.lease, r.permit]) { mapKey(item.idempotencyKey); integer(item.ttlMs, 1); }
    digestInput(r.permit.targetDigest); digestInput(r.permit.paramsDigest); hash(r.batchFingerprint);
    if (r.batchFingerprint !== resources.fingerprint || LEASE.some(k => r.lease[k] !== resources.lease[k]) ||
        PERMIT.some(k => r.permit[k] !== resources.permit[k])) fail();
  } else {
    message(r.message); text(r.signature);
    const sig = Buffer.from(r.signature, "base64");
    if (sig.length !== 64 || sig.toString("base64") !== r.signature) fail();
    for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
      const expected = Object.hasOwn(resources.lease, storage) ? resources.lease : resources.permit;
      if (Object.hasOwn(expected, storage) && r.message[signed] !==
          (["targetDigest", "paramsDigest"].includes(storage) ? digestInput(expected[storage]) : expected[storage])) fail();
    }
  }
}
function requestBody(body) {
  exact(body, ["format_version", "action", "args"]);
  if (body.format_version !== FORMAT_VERSION || body.action !== "history.query") fail();
  queryBody(body.args);
}
function encodeRequest(input) {
  exact(input, ["operation", "requestId", "body"]);
  const data = { ...input };
  exact(data, ["operation", "requestId", "body"]);
  if (data.operation !== frame.OPERATIONS.transition) fail();
  const payload = canonical(data.body);
  requestBody(parse(payload));
  return frame.encodeFrame({ direction: "request", operation: data.operation, requestId: data.requestId, payload });
}
function decodeRequest(bytes) {
  const decoded = frame.decodeFrame(bytes, { direction: "request" });
  if (decoded.operation !== frame.OPERATIONS.transition) fail();
  const body = parse(decoded.payload); requestBody(body);
  return freeze({ operation: decoded.operation, requestId: decoded.requestId, body });
}
function toHostRequest(bytes) {
  const request = decodeRequest(bytes);
  return freeze({ kind: "history", requestId: request.requestId, query: request.body.args });
}
function effectBody(effect, result, q) {
  const r = q.request, current = result.currentCheckpoint;
  if (!current) fail();
  if (q.operation === "register") {
    exact(effect, ["kind", "registered", "reused", "checkpoint", "requestDigest", "requestMatch", "historicalPrincipal"]);
    if (effect.kind !== "registration" || typeof effect.registered !== "boolean" || effect.reused !== !effect.registered ||
        effect.requestDigest !== digest(r) || effect.requestMatch !== "full-request-digest") fail();
  } else if (q.operation === "issue") {
    exact(effect, ["kind", "permitId", "status", "requestDigest", "requestMatch", "inputCheckpoint", "historicalPrincipal"]);
    mapKey(effect.permitId);
    if (effect.kind !== "issuance" || !["issued", "consumed", "invalidated"].includes(effect.status) ||
        effect.requestDigest !== digest({ targetId: r.targetId, lease: r.lease, permit: r.permit, fingerprint: r.batchFingerprint }) ||
        effect.requestMatch !== "business-effect-only" || effect.inputCheckpoint !== "not-recorded") fail();
  } else {
    exact(effect, ["kind", "permitId", "atMs", "checkpoint", "requestMatch", "inputCheckpoint", "fullRequestDigest", "historicalPrincipal"]);
    integer(effect.atMs);
    if (effect.kind !== "consumption" || effect.permitId !== r.message.permit_id ||
        effect.atMs < r.message.issued_at_ms || effect.atMs >= r.message.deadline_ms ||
        effect.requestMatch !== "business-effect-only" || effect.inputCheckpoint !== "not-recorded" ||
        effect.fullRequestDigest !== "not-recorded") fail();
  }
  if (effect.historicalPrincipal !== "not-recorded") fail();
  if (q.operation !== "issue") {
    checkpoint(effect.checkpoint, q, current.store_generation);
    if (effect.checkpoint.revision > current.revision || (effect.checkpoint.revision === current.revision &&
        !canonical(effect.checkpoint).equals(canonical(current)))) fail();
  }
}
function observation(result, q) {
  exact(result, ["status", "operation", ...SAFETY, "effect", "boundary", "currentCheckpoint", "clockPoisoned"]);
  safety(result);
  if (result.operation !== q.operation || !["found", "not-found-at-boundary"].includes(result.status) ||
      typeof result.clockPoisoned !== "boolean") fail();
  const b = result.boundary;
  exact(b, ["decisionId", "authorityId", "issuerStoreId", "serviceEpoch", "anchorSequence", "bodyDigest", "journalSequence", "highWaterSequence"]);
  if (["decisionId", "authorityId", "issuerStoreId"].some(k => b[k] !== q[k])) fail();
  for (const k of ["serviceEpoch", "anchorSequence", "journalSequence", "highWaterSequence"]) integer(b[k], 1);
  hash(b.bodyDigest);
  if (b.anchorSequence !== b.journalSequence || b.highWaterSequence > b.anchorSequence) fail();
  if (result.currentCheckpoint !== null) checkpoint(result.currentCheckpoint, q);
  if (result.status === "found") effectBody(result.effect, result, q);
  else if (result.effect !== null) fail();
}
function responseBody(request, status, body) {
  const success = body.status === "observed";
  exact(body, ["format_version", "queryDigest", "status", "commit", ...SAFETY, success ? "result" : "code"]);
  if (body.format_version !== FORMAT_VERSION || typeof body.status !== "string" || !Object.hasOwn(HISTORY_STATUS, body.status) ||
      HISTORY_STATUS[body.status] !== status || body.commit !== "not-applicable" ||
      body.queryDigest !== digest(request.body.args)) fail();
  safety(body);
  if (success) observation(body.result, request.body.args);
  else if (typeof body.code !== "string" || !/^ERR_[A-Z0-9_]{1,128}$/.test(body.code)) fail();
  return body;
}
function encodeResponse(requestBytes, outcome) {
  const request = decodeRequest(requestBytes), data = parse(canonical(outcome));
  exact(data, ["status", "commit", ...SAFETY, data.status === "observed" ? "result" : "code"]);
  const body = { format_version: FORMAT_VERSION, queryDigest: digest(request.body.args), ...data };
  responseBody(request, HISTORY_STATUS[body.status], body);
  return frame.encodeFrame({ direction: "response", operation: request.operation, requestId: request.requestId,
    status: HISTORY_STATUS[body.status], payload: canonical(body) });
}
function decodeResponse(bytes, requestBytes) {
  const request = decodeRequest(requestBytes);
  const decoded = frame.decodeFrame(bytes, { direction: "response", expectedOperation: request.operation, expectedRequestId: request.requestId });
  return freeze(responseBody(request, decoded.status, parse(decoded.payload)));
}

module.exports = { FORMAT_VERSION, HISTORY_STATUS, PermitWitnessHistoryWireError,
  encodeRequest, decodeRequest, toHostRequest, encodeResponse, decodeResponse };
