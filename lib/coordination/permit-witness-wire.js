"use strict";

const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const frame = require("./permit-witness-frame");
const contract = require("./permit-witness-contract");
const { BINDING_FIELD_MAP } = require("./permit-delivery");

// Stage A, OFFLINE candidate only. No listener, authentication, persistence,
// dispatch, facts derivation, retry or execution authorization. These unsigned
// development flags do not isolate signing keys from production trust domains.
// A transport owner must authenticate the peer and supply a separately created
// host context; JSON (including owner/host/worker labels) cannot create one.
//
// transition v1: {format_version:1, action:"register"|"issue"|"consume", args}.
// args map WITHOUT RENAMING/DEFAULTS to host.dispatch(context, action, args),
// and then registerWitnessTarget/issueWitnessPermit/consumeWithCheckpoint.
// They are NOT deriveTransition facts. Host-owned observation/signing/revocation,
// resource authorization and the store's atomic consumption remain mandatory.
// checkpoint v1 is syntax only: the existing host has no authorized history
// query. toHostRequest refuses it instead of reading a snapshot as authority.
// Header UUID is only per-exchange correlation; args.requestId is the existing
// registration idempotency key and is preserved independently. This module has
// no durable UUID replay history. Candidate response status assignments below
// are Stage A semantics, NOT semantics implemented by the native frame helpers.
const STATUS = Object.freeze({ committed: 0, rejected: 1, unknown: 2, unavailable: 3 });
const PIN = ["decision_id", "instance_id", "fingerprint", "public_key_pem", "source_digest",
  "deployment_digest", "run_id", "generation", "valid_from", "valid_until"];
const LEASE = ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"];
const PERMIT = ["idempotencyKey", "operation", "targetDigest", "paramsDigest", "ttlMs"];
const SIGNED = [...BINDING_FIELD_MAP.map(([, name]) => name), "issued_at_ms", "deadline_ms", "permit_id"];
const REQUESTS = Object.freeze({ register: ["targetId", "requestId", "checkpoint", "pin"],
  issue: ["targetId", "checkpoint", "lease", "permit", "batchFingerprint"],
  consume: ["targetId", "checkpoint", "message", "signature"] });

class PermitWitnessWireError extends Error {
  constructor(code) { super(code); this.name = "PermitWitnessWireError"; this.code = code; }
}
function fail(code = "ERR_WITNESS_WIRE_SCHEMA") { throw new PermitWitnessWireError(code); }
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail();
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d.enumerable || !Object.hasOwn(d, "value")) fail();
  }
}
function text(value) { if (typeof value !== "string" || !value) fail(); }
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) fail();
}
function hash(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); }
function mapKey(value) {
  text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ||
      ["__proto__", "constructor", "prototype"].includes(value)) fail();
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonical(value) {
  try { return contract.canonicalBytes(value); }
  catch { fail("ERR_WITNESS_WIRE_JSON"); }
}

// Decode the ORIGINAL bytes, not JSON reserialized by an upstream parser.
// fatal UTF-8 + byte-for-byte canonical reencoding rejects duplicate keys at
// every depth (also escaped aliases), BOM, whitespace, key order/escapes,
// exponent/decimal spellings, negative zero and rounded/unsafe numbers. JSON.parse
// is bounded by the frame's 1 MiB ceiling; the contract then enforces depth,
// nodes, entries and strings before any schema or host mapping is released.
function parsePayload(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > contract.LIMITS.bytes) {
    fail("ERR_WITNESS_WIRE_SIZE");
  }
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { fail("ERR_WITNESS_WIRE_JSON"); }
  if (!canonical(value).equals(bytes)) fail("ERR_WITNESS_WIRE_NONCANONICAL");
  return value;
}
function checkpoint(value, targetId) {
  exact(value, ["format_version", "authority_id", "target_id", "store_generation", "revision", "full_state_digest"]);
  if (value.format_version !== 1 || value.target_id !== targetId) fail();
  for (const field of ["authority_id", "target_id", "store_generation"]) text(value[field]);
  integer(value.revision, 1); hash(value.full_state_digest);
}
function publicKey(pem, fingerprint) {
  text(pem); hash(fingerprint);
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem) || /PRIVATE KEY/.test(pem)) fail();
  let key;
  try { key = crypto.createPublicKey(pem); } catch { fail(); }
  if (key.asymmetricKeyType !== "ed25519" || crypto.createHash("sha256")
    .update(key.export({ type: "spki", format: "der" })).digest("hex") !== fingerprint) fail();
  return key;
}
function base64(value, length) {
  text(value);
  const bytes = Buffer.from(value, "base64");
  if ((length !== undefined && bytes.length !== length) || bytes.toString("base64") !== value) fail();
  return bytes;
}
function message(value) {
  exact(value, SIGNED);
  for (const name of SIGNED) {
    if (["service_epoch", "fencing", "sequence"].includes(name)) integer(value[name], 1);
    else if (["issued_at_ms", "deadline_ms"].includes(name)) integer(value[name]);
    else if (["target_digest", "params_digest"].includes(name)) hash(value[name]);
    else text(value[name]);
  }
  if (value.deadline_ms <= value.issued_at_ms) fail();
}
function requestBody(operation, body) {
  if (operation === frame.OPERATIONS.checkpoint) {
    exact(body, ["format_version", "targetId", "checkpoint"]);
    mapKey(body.targetId); checkpoint(body.checkpoint, body.targetId);
  } else if (operation === frame.OPERATIONS.transition) {
    exact(body, ["format_version", "action", "args"]);
    if (typeof body.action !== "string" || !Object.hasOwn(REQUESTS, body.action)) fail("ERR_WITNESS_WIRE_OPERATION");
    const r = body.args;
    exact(r, REQUESTS[body.action]); mapKey(r.targetId);
    if (r.checkpoint !== null || body.action !== "register") checkpoint(r.checkpoint, r.targetId);
    if (body.action === "register") {
      mapKey(r.requestId); exact(r.pin, PIN);
      for (const name of PIN.filter((name) => !["valid_from", "valid_until"].includes(name))) text(r.pin[name]);
      integer(r.pin.valid_from); integer(r.pin.valid_until, 1);
      if (r.pin.valid_until <= r.pin.valid_from || r.pin.instance_id !== r.targetId) fail();
      publicKey(r.pin.public_key_pem, r.pin.fingerprint);
    } else if (body.action === "issue") {
      exact(r.lease, [...LEASE, "idempotencyKey", "ttlMs"]); exact(r.permit, PERMIT);
      LEASE.forEach((key) => text(r.lease[key]));
      for (const item of [r.lease, r.permit]) { mapKey(item.idempotencyKey); integer(item.ttlMs, 1); }
      text(r.permit.operation);
      // The real reservation validator accepts case-insensitive digests and
      // lowercases them in the store. Preserve request spelling until then.
      for (const name of ["targetDigest", "paramsDigest"]) {
        if (typeof r.permit[name] !== "string" || !/^[a-f0-9]{64}$/i.test(r.permit[name])) fail();
      }
      hash(r.batchFingerprint);
    } else {
      message(r.message); base64(r.signature, 64);
    }
  } else fail("ERR_WITNESS_WIRE_OPERATION");
  if (body.format_version !== 1) fail();
  return body;
}

function encodeRequest(input) {
  exact(input, ["operation", "requestId", "body"]);
  const payload = canonical(input.body);
  requestBody(input.operation, parsePayload(payload));
  return frame.encodeFrame({ direction: "request", operation: input.operation, requestId: input.requestId, payload });
}
function decodeRequest(bytes) {
  const decoded = frame.decodeFrame(bytes, { direction: "request" });
  return freeze({ operation: decoded.operation, requestId: decoded.requestId,
    body: requestBody(decoded.operation, parsePayload(decoded.payload)) });
}
function toHostRequest(bytes) {
  const request = decodeRequest(bytes);
  if (request.operation !== frame.OPERATIONS.transition) fail("ERR_WITNESS_WIRE_CHECKPOINT_QUERY_UNSUPPORTED");
  return freeze({ requestId: request.requestId, action: request.body.action, args: request.body.args });
}

function sameCheckpointBinding(actual, previous) {
  for (const name of ["authority_id", "target_id", "store_generation"]) {
    if (actual[name] !== previous[name]) fail();
  }
}
function committedResult(request, result) {
  if (request.operation !== frame.OPERATIONS.transition) fail("ERR_WITNESS_WIRE_CHECKPOINT_QUERY_UNSUPPORTED");
  const { action, args } = request.body;
  if (action === "register") {
    exact(result, ["registered", "reused", "checkpoint", "executionAuthorized"]);
    if (typeof result.registered !== "boolean" || result.reused !== !result.registered) fail();
  } else if (action === "consume") {
    exact(result, ["status", "permitId", "checkpoint", "executionAuthorized"]);
    if (result.status !== "consumed" || result.permitId !== args.message.permit_id) fail();
  } else {
    exact(result, ["fingerprint", "publicKeyPem", "signedPermit", "executionAuthorized"]);
    if (result.fingerprint !== args.batchFingerprint) fail();
    const key = publicKey(result.publicKeyPem, result.fingerprint), signed = result.signedPermit;
    exact(signed, ["message", "signature", "sequence", "deadline", "issuedAt", "bytes", "nowMs"]);
    message(signed.message);
    const m = signed.message, bytes = canonical(m);
    if (!base64(signed.bytes).equals(bytes) || !crypto.verify(null, bytes, key, base64(signed.signature, 64)) ||
        signed.sequence !== m.sequence || signed.deadline !== m.deadline_ms ||
        signed.issuedAt !== m.issued_at_ms || signed.nowMs !== m.issued_at_ms) fail();
    for (const [storage, name] of BINDING_FIELD_MAP) {
      const source = Object.hasOwn(args.lease, storage) ? args.lease : args.permit;
      if (Object.hasOwn(source, storage)) {
        const expected = ["targetDigest", "paramsDigest"].includes(storage) ? source[storage].toLowerCase() : source[storage];
        if (m[name] !== expected) fail();
      }
    }
    // lease ID, epoch, fencing, sequence, permit ID and times are server state;
    // syntax/signature checks cannot establish their currentness or ownership.
  }
  if (result.executionAuthorized !== false) fail("ERR_WITNESS_WIRE_AUTHORIZATION_DISABLED");
  if (action !== "issue") {
    checkpoint(result.checkpoint, args.targetId);
    if (args.checkpoint) {
      sameCheckpointBinding(result.checkpoint, args.checkpoint);
      const increment = action === "consume" || result.registered ? 1 : 0;
      if (result.checkpoint.revision !== args.checkpoint.revision + increment) fail();
      if (!increment && !canonical(result.checkpoint).equals(canonical(args.checkpoint))) fail();
    } else if (!result.registered || result.checkpoint.revision !== 2) fail();
  }
}
function responseBody(request, status, body) {
  const success = status === STATUS.committed;
  exact(body, ["format_version", "status", "commit", "mode", "executionAuthorized", success ? "result" : "code"]);
  if (body.format_version !== 1 || body.mode !== "development-only" || body.executionAuthorized !== false ||
      typeof body.status !== "string" || !Object.hasOwn(STATUS, body.status) || STATUS[body.status] !== status) fail();
  const commit = success ? "confirmed" : status === STATUS.unknown ? "unknown" : "not-attempted";
  if (body.commit !== commit) fail();
  if (success) committedResult(request, body.result);
  else if (typeof body.code !== "string" || !/^ERR_[A-Z0-9_]{1,128}$/.test(body.code)) fail();
  return body;
}
function encodeResponse(requestBytes, outcome) {
  const request = decodeRequest(requestBytes);
  // Host outcomes have no format_version; add only this protocol discriminator.
  const detached = parsePayload(canonical(outcome));
  exact(detached, ["status", "commit", "mode", "executionAuthorized", detached.status === "committed" ? "result" : "code"]);
  const body = { format_version: 1, ...detached };
  responseBody(request, STATUS[body.status], body);
  return frame.encodeFrame({ direction: "response", operation: request.operation,
    requestId: request.requestId, status: STATUS[body.status], payload: canonical(body) });
}
function decodeResponse(bytes, requestBytes) {
  const request = decodeRequest(requestBytes);
  const decoded = frame.decodeFrame(bytes, { direction: "response", expectedOperation: request.operation,
    expectedRequestId: request.requestId });
  return freeze(responseBody(request, decoded.status, parsePayload(decoded.payload)));
}

function unknown() {
  return freeze({ format_version: 1, status: "unknown", commit: "unknown", mode: "development-only",
    executionAuthorized: false, code: "ERR_WITNESS_TRANSACTION_OUTCOME_UNKNOWN" });
}
// Caller owns deadlines and clean EOF evidence; this class has no timers or I/O.
// append never releases a response, even if all declared bytes arrived. Any
// timeout/cancel/reset/protocol error is terminal unknown, never rollback proof.
// Late responses cannot clear that latch. A new exchange is NOT a safe retry;
// recovery must reconcile authoritative history, which has no wire API yet.
class WireExchange {
  #request;
  #decoder;
  #outcome = null;
  constructor(requestBytes) {
    const request = decodeRequest(requestBytes);
    this.#request = Buffer.from(requestBytes);
    this.#decoder = new frame.FrameDecoder({ direction: "response", expectedOperation: request.operation,
      expectedRequestId: request.requestId });
  }
  get outcome() { return this.#outcome; }
  #open() { if (this.#outcome) fail("ERR_WITNESS_WIRE_CLOSED"); }
  append(bytes) {
    this.#open();
    try { this.#decoder.append(bytes); }
    catch (error) { this.#outcome = unknown(); this.#decoder = null; throw error; }
  }
  finish() {
    this.#open();
    try {
      const decoded = this.#decoder.finish(), request = decodeRequest(this.#request);
      this.#outcome = freeze(responseBody(request, decoded.status, parsePayload(decoded.payload)));
      return this.#outcome;
    } catch (error) { this.#outcome = unknown(); throw error; }
    finally { this.#decoder = null; }
  }
  abort() {
    if (!this.#outcome) { this.#outcome = unknown(); this.#decoder = null; }
    return this.#outcome;
  }
}

module.exports = { STATUS, PermitWitnessWireError, encodeRequest, decodeRequest, toHostRequest,
  encodeResponse, decodeResponse, WireExchange };
