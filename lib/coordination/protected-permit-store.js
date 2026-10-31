"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PROTECTED_SCOPE, PROTECTED_LEASE_PREFIX } = require("./protected-scope");
const anchor = require("./protected-anchor");

// Version 2 requires the cross-storage coordination protocol. Version 1 writers
// must refuse this state; an online mixed-version rollout is not supported.
const SCHEMA_VERSION = 2;
// Explicitly provisioned, development-only authority stores fence old writers.
// No production activation or transport authentication exists here. PRODUCTION
// BLOCKER: the mode label and unsigned executionAuthorized wrapper do NOT isolate
// development signatures from other trust domains. The unchanged 14+3 signature
// can verify elsewhere if its key is trusted there. Trusted deployment/key-domain
// enforcement is still required; no request flag can establish that boundary.
const AUTHORITY_SCHEMA_VERSION = 3;
// Admission-only development stores fence schema-3 writers: they do not know
// about persistent reservations. No automatic migration or production mode.
const ADMISSION_SCHEMA_VERSION = 4;
// Explicit development-only preparation/call-gate format; no signer/T4 exists.
const SIGNING_GATE_SCHEMA_VERSION = 5;
function isAdmissionSchema(version) {
  return version === ADMISSION_SCHEMA_VERSION || version === SIGNING_GATE_SCHEMA_VERSION;
}
function configuredSchema(authority) {
  return authority?.signingGateMode ? SIGNING_GATE_SCHEMA_VERSION : authority?.admissionMode ? ADMISSION_SCHEMA_VERSION : null;
}
function isAuthoritySchema(version) {
  return version === AUTHORITY_SCHEMA_VERSION || isAdmissionSchema(version);
}
const coordination = require("./protected-store-lock");
const witness = require("./permit-witness-contract");

function authorityOptions(options) {
  if (options.witnessAuthority === undefined) return null;
  const value = options.witnessAuthority;
  if (!value || value.mode !== "development-only" ||
      Object.keys(value).some((key) => !["mode", "authorityId", "admissionMode", "signingGateMode", "prepareSigning", "authorize", "authorizeHistory", "observeTarget", "signPermit", "pullRevocation"].includes(key)) ||
      (value.signingGateMode !== undefined && (value.signingGateMode !== "development-only" ||
        value.admissionMode !== "development-only" || typeof value.prepareSigning !== "function")) ||
      (value.prepareSigning !== undefined && value.signingGateMode === undefined) ||
      (value.admissionMode !== undefined && value.admissionMode !== "development-only") ||
      (value.authorizeHistory !== undefined && typeof value.authorizeHistory !== "function") ||
      ["authorize", "observeTarget", "signPermit", "pullRevocation"].some((name) => typeof value[name] !== "function")) {
    fail("ERR_WITNESS_AUTHORITY_DISABLED");
  }
  requireText(value.authorityId);
  return Object.freeze({ ...value });
}
function dataRequest(value, fields) {
  const copy = JSON.parse(witness.canonicalBytes(value).toString("utf8"));
  if (!copy || Array.isArray(copy) || typeof copy !== "object" ||
      Object.keys(copy).length !== fields.length || fields.some((key) => !Object.hasOwn(copy, key))) fail("ERR_INVALID_INPUT");
  return copy;
}
function freezeData(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}
function requireMapKey(value) {
  requireText(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) ||
      ["__proto__", "constructor", "prototype"].includes(value)) fail("ERR_INVALID_INPUT");
}
function own(map, key) { return Object.hasOwn(map, key) ? map[key] : undefined; }
// Admission format v1 uses the existing bounded canonical UTF-8 encoder.
// Resource/business identities MUST be normalized and authorized by the host;
// neither caller labels nor peer properties establish identity or scope.
const ADMISSION_FIELDS = ["requestKey", "action", "resourceScope", "businessKey", "request"];
// Storage budget, independent of online canonical message limits. Charged as
// exact UTF-8 JSON bytes of request_admission, including escaped request_bytes,
// metadata and all indexes. No eviction/compaction of unresolved admissions.
const ADMISSION_MAX_ATTEMPTS = 1024;
const ADMISSION_MAX_BYTES = 8 * 1024 * 1024;
// Complete schema-4 body: up to 8 MiB admission plus 1 MiB of explicitly
// shaped metadata (including its JSON escaping). Legacy schemas retain their
// existing reader contract. This bounds transfer to JS, NOT SQLite allocations,
// page-cache/RSS, integrity checks, or the copies used by full-state validation.
const ADMISSION_METADATA_MAX_BYTES = 1024 * 1024;
const ADMISSION_BODY_MAX_BYTES = ADMISSION_MAX_BYTES + ADMISSION_METADATA_MAX_BYTES;
const SIGNING_MAX_BYTES = 2 * 1024 * 1024;
const SIGNING_BODY_MAX_BYTES = ADMISSION_BODY_MAX_BYTES + SIGNING_MAX_BYTES;
function readProtectedRow(db, admissionSchema, allowAuthority = true) {
  // Preserve the public constructor's legacy in-memory adapter contract. Those
  // values already reside in JS; this is NOT a SQLite reader or an admission
  // fallback. Every native DatabaseSync (even with legacy configuration) takes
  // the guarded query below. Admission adapters must supply that query contract.
  if (!admissionSchema && !(db instanceof sqliteRuntime())) {
    return db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get();
  }
  // Version/encoding/type/byte checks and payload projection share ONE SQLite
  // statement snapshot. Never SELECT body first or check a length in a separate
  // statement. Configuration is trusted; neither DB PRAGMA nor JSON claims can
  // turn an explicitly configured admission reader into an unbounded legacy one.
  // BLOB length counts UTF-8 bytes only after requiring the provisioned encoding.
  const allowed = admissionSchema
    ? !allowAuthority ? "0" : `v.user_version = ${admissionSchema} AND e.encoding = 'UTF-8'
       AND typeof(s.body) = 'text' AND length(CAST(s.body AS BLOB)) <= ${admissionSchema === SIGNING_GATE_SCHEMA_VERSION ? SIGNING_BODY_MAX_BYTES : ADMISSION_BODY_MAX_BYTES}
       AND typeof(s.sha256) = 'text' AND length(CAST(s.sha256 AS BLOB)) = 64`
    : `v.user_version IN (${SCHEMA_VERSION}, ${AUTHORITY_SCHEMA_VERSION})`;
  const row = db.prepare(`SELECT v.user_version AS version,
    CASE WHEN ${allowed} THEN s.body ELSE NULL END AS body,
    CASE WHEN ${allowed} THEN s.sha256 ELSE NULL END AS sha256
    FROM protected_state AS s CROSS JOIN pragma_user_version AS v CROSS JOIN pragma_encoding AS e
    WHERE s.id = 1`).get();
  if (!row || ![SCHEMA_VERSION, AUTHORITY_SCHEMA_VERSION, ADMISSION_SCHEMA_VERSION, SIGNING_GATE_SCHEMA_VERSION].includes(row.version)) fail("ERR_STATE_INVALID");
  if (isAdmissionSchema(row.version) && !allowAuthority) fail("ERR_WITNESS_RECOVERY_UNSUPPORTED");
  if ((isAdmissionSchema(row.version) ? row.version : null) !== admissionSchema) fail("ERR_WITNESS_AUTHORITY_DISABLED");
  if (row.body === null || row.sha256 === null) fail("ERR_STATE_INVALID");
  return row;
}
function assertAdmissionMetadata(state) {
  // Only flat, typed metadata and the explicitly empty business collections are
  // supported in this admission-only format. No arbitrary extension/padding bag.
  admissionObject(state, ["schema_version", "scope", "decision_id", "witness_authority", "service_epoch", "fencing",
    "lease_seq", "permit_seq", "last_clock_ms", "lease", "lease_idempotency", "permits", "idempotency", "desktop",
    "tombstones", "anchor_sequence", "store_id", "anchor_mode", "service_identity"]);
  const authority = admissionObject(state.witness_authority,
    ["mode", "authority_id", "clock_poisoned", "targets", "issuance_bindings", "request_admission",
      ...(state.schema_version === SIGNING_GATE_SCHEMA_VERSION ? ["signing_gate"] : [])]);
  admissionObject(state.desktop, ["status", "key"]);
  for (const map of [state.lease_idempotency, state.permits, state.idempotency, state.tombstones,
    authority.targets, authority.issuance_bindings]) admissionObject(map, []);
  const metadata = { ...state, witness_authority: { ...authority, request_admission: null,
    ...(state.schema_version === SIGNING_GATE_SCHEMA_VERSION ? { signing_gate: null } : {}) } };
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > ADMISSION_METADATA_MAX_BYTES) fail("ERR_STATE_INVALID");
}
function admissionObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("ERR_STATE_INVALID");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
      (fields && (keys.length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))))) fail("ERR_STATE_INVALID");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("ERR_STATE_INVALID");
  }
  return value;
}
function admissionCapacity(value, code) {
  if (Object.keys(value.attempts).length > ADMISSION_MAX_ATTEMPTS ||
      Buffer.byteLength(JSON.stringify(value), "utf8") > ADMISSION_MAX_BYTES) fail(code);
}
function admissionRequest(input) {
  const request = dataRequest(input, ADMISSION_FIELDS);
  for (const key of ADMISSION_FIELDS.slice(0, 4)) requireText(request[key]);
  if (!request.request || typeof request.request !== "object" || Array.isArray(request.request)) fail("ERR_INVALID_INPUT");
  return freezeData(request);
}
function admissionGrant(value, request) {
  if (value && typeof value.then === "function") {
    Promise.resolve(value).catch(() => {});
    fail("ERR_WITNESS_NOT_AUTHORIZED");
  }
  if (!value || typeof value !== "object") fail("ERR_WITNESS_NOT_AUTHORIZED");
  // Do not wrap resources in another online message: its bytes, node count and
  // nesting were budgeted at the request boundary, without this extra envelope.
  const authorization = admissionObject(value, ["principal", "grant", "resources"]);
  const principal = dataRequest(authorization.principal, ["subjectId", "issuer", "tenant"]);
  for (const key of ["subjectId", "issuer", "tenant"]) requireText(principal[key]);
  const grant = dataRequest(authorization.grant, ["id", "version"]);
  requireText(grant.id); requirePositiveMs(grant.version);
  if (!witness.canonicalBytes(authorization.resources).equals(witness.canonicalBytes(request))) fail("ERR_WITNESS_NOT_AUTHORIZED");
  return freezeData({ principal, grant }); // detached from provider-owned mutable objects
}
function admissionKeys(state, principal, input) {
  return {
    association: digest(witness.canonicalBytes({ authorityId: state.witness_authority.authority_id,
      principal, action: input.action, resourceScope: input.resourceScope, requestKey: input.requestKey })),
    // Deliberately not scoped by subject/run/attempt/requestKey. The host must
    // map aliases and generations onto stable authority-wide resource identities.
    business: digest(witness.canonicalBytes(input.businessKey)),
    resource: digest(witness.canonicalBytes(input.resourceScope)),
  };
}
function assertAdmissionState(state) {
  try {
    const a = admissionObject(state.witness_authority.request_admission,
      ["format_version", "sequence", "attempts", "associations", "business_keys", "resources"]);
    if (a.format_version !== 1 || !Number.isSafeInteger(a.sequence) || a.sequence < 0 ||
        a.sequence > ADMISSION_MAX_ATTEMPTS) fail("ERR_STATE_INVALID");
    for (const map of [a.attempts, a.associations, a.business_keys, a.resources]) {
      admissionObject(map);
      if (Object.keys(map).length !== a.sequence) fail("ERR_STATE_INVALID");
    }
    const associations = {}, business = {}, resources = {}, sequences = new Set();
    for (const [id, entry] of Object.entries(a.attempts)) {
      const record = admissionObject(entry, ["attempt_id", "sequence", "encoding_version", "request_bytes", "request_digest",
        "principal", "grant", "service_epoch", "admitted_at_ms", "status"]);
      const prefix = `admission:${state.store_id}:`;
      if (id !== record.attempt_id || !id.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(id.slice(prefix.length)) ||
          record.encoding_version !== 1 || record.status !== "admitted" ||
          !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > a.sequence ||
          sequences.has(record.sequence) || record.service_epoch !== state.service_epoch ||
          !Number.isSafeInteger(record.admitted_at_ms) || record.admitted_at_ms < 0 ||
          record.admitted_at_ms > state.last_clock_ms || typeof record.request_bytes !== "string" ||
          Buffer.byteLength(record.request_bytes, "utf8") > witness.LIMITS.bytes ||
          digest(record.request_bytes) !== record.request_digest) fail("ERR_STATE_INVALID");
      const request = admissionRequest(JSON.parse(record.request_bytes));
      if (witness.canonicalBytes(request).toString("utf8") !== record.request_bytes) fail("ERR_STATE_INVALID");
      admissionGrant({ principal: record.principal, grant: record.grant, resources: request }, request);
      const keys = admissionKeys(state, record.principal, request);
      if (Object.hasOwn(associations, keys.association) || Object.hasOwn(business, keys.business) ||
          Object.hasOwn(resources, keys.resource)) fail("ERR_STATE_INVALID");
      associations[keys.association] = id; business[keys.business] = id; resources[keys.resource] = id;
      sequences.add(record.sequence);
    }
    // Maps contain only validated digest/attempt IDs, not arbitrary data. Compare
    // directly, without a second message/entries/size budget on the collection.
    for (const [actual, expected] of [[a.associations, associations], [a.business_keys, business], [a.resources, resources]]) {
      if (Object.keys(actual).some((key) => !Object.hasOwn(expected, key) || actual[key] !== expected[key])) fail("ERR_STATE_INVALID");
    }
    if (sequences.size !== a.sequence) fail("ERR_STATE_INVALID");
    admissionCapacity(a, "ERR_STATE_INVALID");
  } catch { fail("ERR_STATE_INVALID"); }
}
// Schema 5 is a local development reservation, NOT active-ready registration,
// authentication, signer authority, or an R5 publication certificate. Its only
// capability consumer below abandons the gate as unknown; T4 is absent.
// Private control flow: conflict safety state must commit before refusal. The
// singleton cannot be supplied by a provider's result/error code or caller.
class SigningReservationConflict extends Error {}
const SIGNING_CONFLICT_RESULT = Object.freeze({});
const SIGNING_FACT_FIELDS = ["storeGeneration", "lifecycleVersion", "ownerIncarnation", "signerId", "validUntilMs"];
function signingFacts(value) {
  if (value && typeof value.then === "function") {
    Promise.resolve(value).catch(() => {}); fail("ERR_WITNESS_SIGNING_NOT_AUTHORIZED");
  }
  const facts = dataRequest(value, SIGNING_FACT_FIELDS);
  for (const name of SIGNING_FACT_FIELDS.slice(0, 4)) requireText(facts[name]);
  requirePositiveMs(facts.validUntilMs);
  return freezeData(facts);
}
function signingRequest(input, state, facts) {
  if (input.action !== "issue") fail("ERR_WITNESS_SIGNING_NOT_AUTHORIZED");
  const r = dataRequest(input.request, HISTORY_FIELDS.issue);
  requireMapKey(r.targetId);
  historyCheckpoint(r.checkpoint, state.witness_authority.authority_id, r.targetId, facts.storeGeneration);
  const lease = dataRequest(r.lease, [...HISTORY_LEASE, "idempotencyKey", "ttlMs"]);
  for (const key of [...HISTORY_LEASE, "idempotencyKey"]) requireText(lease[key]);
  requirePositiveMs(lease.ttlMs);
  const permit = dataRequest(r.permit, [...HISTORY_PERMIT, "idempotencyKey", "ttlMs"]);
  requireText(permit.idempotencyKey); validateReservationInput(permit);
  if (requireDigest(permit.targetDigest) !== permit.targetDigest || requireDigest(permit.paramsDigest) !== permit.paramsDigest ||
      requireDigest(r.batchFingerprint) !== r.batchFingerprint) fail("ERR_INVALID_INPUT");
  return r;
}
function signingPermit(state, input, facts, sequence, now) {
  const r = signingRequest(input, state, facts);
  const deadline = Math.min(now + r.lease.ttlMs, now + r.permit.ttlMs, facts.validUntilMs);
  if (!Number.isSafeInteger(deadline) || deadline <= now) fail("ERR_WITNESS_SIGNING_EXPIRED");
  return { ...Object.fromEntries(HISTORY_LEASE.slice(1).map((name) => [name, r.lease[name]])),
    leaseId: `${PROTECTED_LEASE_PREFIX}sign-${state.store_id}-${sequence}`, serviceEpoch: state.service_epoch, fencing: sequence,
    operation: r.permit.operation, targetDigest: r.permit.targetDigest, paramsDigest: r.permit.paramsDigest,
    permitId: `P-PERMIT-sign-${state.store_id}-${sequence}`, sequence, deadline };
}
function signingCapacity(gate, code) {
  if (Buffer.byteLength(JSON.stringify(gate), "utf8") > SIGNING_MAX_BYTES) fail(code);
}
function assertSigningState(state) {
  try {
    const gate = admissionObject(state.witness_authority.signing_gate, ["format_version", "sequence", "preparations"]);
    admissionObject(gate.preparations);
    if (gate.format_version !== 1 || !Number.isSafeInteger(gate.sequence) || gate.sequence < 0 ||
        gate.sequence > ADMISSION_MAX_ATTEMPTS || Object.keys(gate.preparations).length !== gate.sequence ||
        state.lease_seq !== gate.sequence || state.permit_seq !== gate.sequence || state.fencing !== gate.sequence) fail("ERR_STATE_INVALID");
    const seen = new Set();
    for (const [id, value] of Object.entries(gate.preparations)) {
      const record = admissionObject(value, ["attempt_id", "prepare_version", "sequence", "prepared_at_ms", "request_digest",
        "facts", "fingerprint", "permit", "signing_bytes", "signing_digest", "status", "call"]);
      const original = own(state.witness_authority.request_admission.attempts, id);
      if (!original || record.attempt_id !== id || record.prepare_version !== 1 || record.request_digest !== original.request_digest ||
          !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > gate.sequence || seen.has(record.sequence) ||
          !Number.isSafeInteger(record.prepared_at_ms) || record.prepared_at_ms < original.admitted_at_ms ||
          record.prepared_at_ms > state.last_clock_ms ||
          !["sign-prepared", "sign-call-possible", "sign-outcome-unknown"].includes(record.status)) fail("ERR_STATE_INVALID");
      const facts = signingFacts(record.facts);
      const input = admissionRequest(JSON.parse(original.request_bytes));
      const expectedPermit = signingPermit(state, input, facts, record.sequence, record.prepared_at_ms);
      const expected = require("./permit-delivery").preparePermitSigning({ permit: expectedPermit,
        issuedAtMs: record.prepared_at_ms, nowMs: record.prepared_at_ms });
      if (record.fingerprint !== input.request.batchFingerprint ||
          !witness.canonicalBytes(record.permit).equals(witness.canonicalBytes(expectedPermit)) ||
          record.signing_bytes !== expected.bytes ||
          record.signing_digest !== digest(Buffer.from(expected.bytes, "base64"))) fail("ERR_STATE_INVALID");
      if (record.status === "sign-prepared") {
        if (record.call !== null) fail("ERR_STATE_INVALID");
      } else {
        const call = dataRequest(record.call, ["owner", "service_epoch", "input_digest", "anchor_sequence", "at_ms"]);
        if (!/^[a-f0-9]{32}$/.test(call.owner) || call.service_epoch !== state.service_epoch ||
            call.input_digest !== record.signing_digest || !Number.isSafeInteger(call.anchor_sequence) ||
            call.anchor_sequence < 1 || call.anchor_sequence > state.anchor_sequence ||
            !Number.isSafeInteger(call.at_ms) || call.at_ms < record.prepared_at_ms || call.at_ms > state.last_clock_ms) fail("ERR_STATE_INVALID");
      }
      seen.add(record.sequence);
    }
    signingCapacity(gate, "ERR_STATE_INVALID");
  } catch { fail("ERR_STATE_INVALID"); }
}
function checkpointBinding(checkpoint) {
  const { authority_id, target_id, store_generation, revision } = checkpoint;
  return { authority_id, target_id, store_generation, revision };
}

// History accepts the ORIGINAL request, not caller-supplied facts. Authorizers
// must independently authenticate the peer and grant this entire resource
// envelope. A frame UUID or a write grant is never a historical permission.
const HISTORY_FIELDS = Object.freeze({
  register: ["targetId", "requestId", "checkpoint", "pin"],
  issue: ["targetId", "checkpoint", "lease", "permit", "batchFingerprint"],
  consume: ["targetId", "checkpoint", "message", "signature"],
});
const HISTORY_LEASE = ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"];
const HISTORY_PERMIT = ["operation", "targetDigest", "paramsDigest"];
const HISTORY_PIN = ["decision_id", "instance_id", "fingerprint", "public_key_pem", "source_digest",
  "deployment_digest", "run_id", "generation", "valid_from", "valid_until"];
function historyCheckpoint(input, authorityId, targetId, generation) {
  const cp = dataRequest(input, ["format_version", "authority_id", "target_id", "store_generation", "revision", "full_state_digest"]);
  if (cp.format_version !== 1 || cp.authority_id !== authorityId || cp.target_id !== targetId ||
      typeof cp.store_generation !== "string" || !cp.store_generation ||
      (generation !== null && cp.store_generation !== generation) ||
      !Number.isSafeInteger(cp.revision) || cp.revision < 1 ||
      typeof cp.full_state_digest !== "string" || !/^[a-f0-9]{64}$/.test(cp.full_state_digest)) fail("ERR_WITNESS_HISTORY_BINDING");
  return cp;
}
function historyMessage(input) {
  const delivery = require("./permit-delivery");
  const message = dataRequest(input, [...delivery.BINDING_FIELD_MAP.map(([, name]) => name),
    "issued_at_ms", "deadline_ms", "permit_id"]);
  for (const [name, value] of Object.entries(message)) {
    if (["service_epoch", "fencing", "sequence"].includes(name)) requirePositiveMs(value);
    else if (["issued_at_ms", "deadline_ms"].includes(name)) {
      if (!Number.isSafeInteger(value) || value < 0) fail("ERR_INVALID_INPUT");
    } else if (["target_digest", "params_digest"].includes(name)) {
      if (requireDigest(value) !== value) fail("ERR_INVALID_INPUT");
    } else requireText(value);
  }
  requireMapKey(message.permit_id);
  if (message.deadline_ms <= message.issued_at_ms) fail("ERR_INVALID_INPUT");
  return message;
}
function historyRequest(input) {
  const query = dataRequest(input, ["operation", "decisionId", "authorityId", "issuerStoreId", "targetGeneration", "resources", "request"]);
  if (!Object.hasOwn(HISTORY_FIELDS, query.operation)) fail("ERR_INVALID_INPUT");
  for (const key of ["decisionId", "authorityId", "issuerStoreId"]) requireText(query[key]);
  const r = dataRequest(query.request, HISTORY_FIELDS[query.operation]);
  const resources = dataRequest(query.resources, ["fingerprint", "lease", "permit"]);
  if (requireDigest(resources.fingerprint) !== resources.fingerprint) fail("ERR_INVALID_INPUT");
  if (query.operation !== "register") {
    const lease = dataRequest(resources.lease, HISTORY_LEASE);
    HISTORY_LEASE.forEach((key) => requireText(lease[key]));
    const permit = dataRequest(resources.permit, HISTORY_PERMIT);
    requireText(permit.operation); requireDigest(permit.targetDigest); requireDigest(permit.paramsDigest);
  } else if (resources.lease !== null || resources.permit !== null) fail("ERR_WITNESS_HISTORY_BINDING");
  requireMapKey(r.targetId);
  if (query.targetGeneration === null) {
    if (query.operation !== "register" || r.checkpoint !== null) fail("ERR_WITNESS_HISTORY_BINDING");
  } else requireText(query.targetGeneration);
  if (r.checkpoint !== null) historyCheckpoint(r.checkpoint, query.authorityId, r.targetId, query.targetGeneration);
  else if (query.operation !== "register") fail("ERR_WITNESS_HISTORY_BINDING");
  if (query.operation === "register") {
    requireMapKey(r.requestId);
    const pin = dataRequest(r.pin, HISTORY_PIN);
    const normalized = witness.normalizeTargetState({ schema_version: 3, pins: [{ ...pin, registered_at_ms: 0 }],
      revoked_fingerprints: [], applied_revocation_sequence: 0, highest_seen_revocation_sequence: 0,
      highest_accepted_permit_sequence: 0, last_observed_clock_ms: 0, clock_poisoned: false });
    const delivery = require("./permit-delivery");
    if (normalized.pins.length !== 1 || pin.decision_id !== query.decisionId || pin.instance_id !== r.targetId ||
        crypto.createPublicKey(pin.public_key_pem).asymmetricKeyType !== "ed25519" ||
        delivery.publicKeyFingerprint(pin.public_key_pem) !== pin.fingerprint ||
        resources.fingerprint !== pin.fingerprint) fail("ERR_WITNESS_HISTORY_BINDING");
  } else if (query.operation === "issue") {
    const lease = dataRequest(r.lease, [...HISTORY_LEASE, "idempotencyKey", "ttlMs"]);
    HISTORY_LEASE.forEach((key) => requireText(lease[key]));
    requireMapKey(lease.idempotencyKey); requirePositiveMs(lease.ttlMs);
    const permit = dataRequest(r.permit, ["idempotencyKey", "operation", "targetDigest", "paramsDigest", "ttlMs"]);
    requireMapKey(permit.idempotencyKey); validateReservationInput(permit);
    if (requireDigest(r.batchFingerprint) !== r.batchFingerprint) fail("ERR_INVALID_INPUT");
    if (resources.fingerprint !== r.batchFingerprint || !matches(lease, resources.lease, HISTORY_LEASE) ||
        !matches(permit, resources.permit, HISTORY_PERMIT)) fail("ERR_WITNESS_HISTORY_BINDING");
  } else {
    const delivery = require("./permit-delivery");
    const message = historyMessage(r.message);
    requireText(r.signature);
    if (Buffer.from(r.signature, "base64").length !== 64 ||
        Buffer.from(r.signature, "base64").toString("base64") !== r.signature) fail("ERR_INVALID_INPUT");
    for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
      const expected = Object.hasOwn(resources.lease, storage) ? resources.lease : resources.permit;
      if (Object.hasOwn(expected, storage)) {
        const value = ["targetDigest", "paramsDigest"].includes(storage) ? requireDigest(expected[storage]) : expected[storage];
        if (message[signed] !== value) fail("ERR_WITNESS_HISTORY_BINDING");
      }
    }
  }
  return freezeData(query);
}

function historyEffect(state, query) {
  const r = query.request, authority = state.witness_authority;
  const target = own(authority.targets, r.targetId);
  if (target && query.targetGeneration !== null && target.current.checkpoint.store_generation !== query.targetGeneration) {
    fail("ERR_WITNESS_HISTORY_BINDING");
  }
  if (query.operation === "register") {
    if (!target || !Object.hasOwn(target.registrations, r.requestId)) return null;
    const receipt = own(target.registrations, r.requestId);
    const row = dataRequest(receipt, ["request_digest", "result"]);
    if (row.request_digest !== digest(witness.canonicalBytes(r))) fail("ERR_WITNESS_HISTORY_BINDING");
    const result = dataRequest(row.result, ["registered", "reused", "checkpoint"]);
    const cp = historyCheckpoint(result.checkpoint, query.authorityId, r.targetId, target.current.checkpoint.store_generation);
    if (typeof result.registered !== "boolean" || result.reused !== !result.registered ||
        cp.revision > target.current.checkpoint.revision ||
        !target.current.state.pins.some((pin) => pin.fingerprint === r.pin.fingerprint)) fail("ERR_STATE_INVALID");
    return { kind: "registration", registered: result.registered, reused: result.reused, checkpoint: cp,
      requestDigest: row.request_digest, requestMatch: "full-request-digest", historicalPrincipal: "not-recorded" };
  }
  const id = query.operation === "issue" ? own(state.idempotency, r.permit.idempotencyKey) : r.message.permit_id;
  if (query.operation === "issue" && Object.hasOwn(state.idempotency, r.permit.idempotencyKey)) requireMapKey(id);
  if (!id) {
    if (Object.values(state.permits).some((permit) => permit.idempotencyKey === r.permit.idempotencyKey)) fail("ERR_STATE_INVALID");
    return null;
  }
  const permit = own(state.permits, id), binding = own(authority.issuance_bindings, id);
  if (!permit && !binding) return null;
  if (!target || !permit || !binding || binding.target_id !== r.targetId ||
      binding.target_generation !== query.targetGeneration || binding.fingerprint !== query.resources.fingerprint) {
    fail("ERR_WITNESS_HISTORY_BINDING");
  }
  // Query-owner authentication is distinct from an old lease's recorded owner.
  // Require that persisted ownership/binding; never infer it from a signed label
  // or substitute the current lease when reading an older permit.
  const leases = Object.values(state.lease_idempotency).filter((lease) => lease && lease.leaseId === permit.leaseId);
  if (leases.length !== 1 || !matches(leases[0], query.resources.lease, HISTORY_LEASE) ||
      leases[0].serviceEpoch !== permit.serviceEpoch || leases[0].fencing !== permit.fencing) fail("ERR_WITNESS_HISTORY_BINDING");
  const delivery = require("./permit-delivery");
  const signed = permit.signedIssuance.signedPermit;
  const message = historyMessage(signed.message);
  const pin = target.current.state.pins.find((entry) => entry.fingerprint === binding.fingerprint);
  if (!pin || delivery.canonicalBytes(message).toString("base64") !== binding.message_bytes ||
      message.permit_id !== id || message.deadline_ms !== permit.deadline ||
      !Number.isSafeInteger(message.issued_at_ms) || message.issued_at_ms < 0 || message.issued_at_ms >= permit.deadline ||
      delivery.BINDING_FIELD_MAP.some(([storage, field]) => message[field] !== permit[storage]) ||
      Buffer.from(binding.signature, "base64").length !== 64 ||
      Buffer.from(binding.signature, "base64").toString("base64") !== binding.signature ||
      !crypto.verify(null, delivery.canonicalBytes(message), pin.public_key_pem, Buffer.from(binding.signature, "base64"))) {
    fail("ERR_STATE_INVALID");
  }
  if (query.operation === "issue") {
    const lease = own(state.lease_idempotency, r.lease.idempotencyKey);
    const expectedDigest = digest(witness.canonicalBytes({ targetId: r.targetId, lease: r.lease,
      permit: r.permit, fingerprint: r.batchFingerprint }));
    if (!lease || lease.leaseId !== permit.leaseId || !matches(lease, r.lease, [...HISTORY_LEASE, "ttlMs"]) ||
        !matches(permit, r.lease, HISTORY_LEASE.filter((key) => key !== "owner")) ||
        permit.idempotencyKey !== r.permit.idempotencyKey || permit.operation !== r.permit.operation ||
        permit.targetDigest !== requireDigest(r.permit.targetDigest) || permit.paramsDigest !== requireDigest(r.permit.paramsDigest) ||
        permit.requestedTtlMs !== r.permit.ttlMs || binding.fingerprint !== r.batchFingerprint ||
        binding.request_digest !== expectedDigest) fail("ERR_WITNESS_HISTORY_BINDING");
    return { kind: "issuance", permitId: id, status: binding.status, requestDigest: binding.request_digest,
      requestMatch: "business-effect-only", inputCheckpoint: "not-recorded", historicalPrincipal: "not-recorded" };
  }
  if (delivery.canonicalBytes(r.message).toString("base64") !== binding.message_bytes || r.signature !== binding.signature) {
    fail("ERR_WITNESS_HISTORY_BINDING");
  }
  if (binding.status !== "consumed") {
    if (Object.hasOwn(binding, "consumption_record")) fail("ERR_STATE_INVALID");
    return null;
  }
  const record = dataRequest(binding.consumption_record, ["permit_id", "at_ms", "checkpoint"]);
  const cp = historyCheckpoint(record.checkpoint, query.authorityId, r.targetId, query.targetGeneration);
  if (record.permit_id !== id || !Number.isSafeInteger(record.at_ms) || record.at_ms < 0 ||
      record.at_ms !== permit.consumedAt || cp.revision > target.current.checkpoint.revision ||
      target.current.state.highest_accepted_permit_sequence < permit.sequence) fail("ERR_STATE_INVALID");
  return { kind: "consumption", permitId: id, atMs: record.at_ms, checkpoint: cp,
    requestMatch: "business-effect-only", inputCheckpoint: "not-recorded", fullRequestDigest: "not-recorded",
    historicalPrincipal: "not-recorded" };
}
function poisonAuthorityState(state) {
  // This marker is durable only after the enclosing DB/anchor commit succeeds.
  // A precommit persistence failure cannot preserve the observation across a
  // restart. External witnessing or isolated recovery must govern resumption;
  // a recovered local clock alone is not evidence that it is safe to resume.
  const authority = state.witness_authority;
  authority.clock_poisoned = true;
  for (const target of Object.values(authority.targets)) {
    const current = target.current;
    if (!current.state.clock_poisoned) {
      target.current = witness.createCheckpoint({ ...checkpointBinding(current.checkpoint),
        revision: current.checkpoint.revision + 1 }, { ...current.state, clock_poisoned: true });
    }
  }
}

class ProtectedStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProtectedStoreError";
    this.code = code;
  }
}

function fail(code) { throw new ProtectedStoreError(code); }
function nativePermissionOptions(options) {
  if (process.platform !== "win32") return options;
  // Deployment options cannot replace native Windows evidence or opt out of
  // the strict contract. Keep simulation/injected adapters on other hosts.
  anchor.assertKnownAnchorMode(options.anchorMode);
  return { ...options, anchorMode: anchor.ANCHOR_MODE.strict, platform: "windows", adapter: undefined };
}
function requireText(value) {
  if (typeof value !== "string" || !value) fail("ERR_INVALID_INPUT");
  return value;
}
function requireDigest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail("ERR_INVALID_INPUT");
  return value.toLowerCase();
}
function requirePositiveMs(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("ERR_INVALID_INPUT");
  return value;
}
function validateReservationInput(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) fail("ERR_INVALID_INPUT");
  for (const key of ["idempotencyKey", "operation", "targetDigest", "paramsDigest"]) requireText(fields[key]);
  return { targetDigest: requireDigest(fields.targetDigest), paramsDigest: requireDigest(fields.paramsDigest),
    ttlMs: requirePositiveMs(fields.ttlMs) };
}
function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function sqliteRuntime() {
  if (Number(process.versions.node.split(".")[0]) < 24) fail("ERR_RUNTIME_UNSUPPORTED");
  try { return require("node:sqlite").DatabaseSync; }
  catch { return fail("ERR_RUNTIME_UNSUPPORTED"); }
}
function checkFile(filePath) {
  const parent = path.dirname(path.resolve(filePath));
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("ERR_UNSAFE_PATH");
}
function initialState(now, decisionId, storeId, anchorMode, serviceIdentity, authority = null) {
  return {
    schema_version: authority ? (configuredSchema(authority) || AUTHORITY_SCHEMA_VERSION) : SCHEMA_VERSION, scope: PROTECTED_SCOPE, decision_id: decisionId,
    ...(authority ? { witness_authority: { mode: "development-only", authority_id: authority.authorityId,
      clock_poisoned: false, targets: {}, issuance_bindings: {},
      ...(authority.admissionMode ? { request_admission: { format_version: 1, sequence: 0,
        attempts: {}, associations: {}, business_keys: {}, resources: {} } } : {}),
      ...(authority.signingGateMode ? { signing_gate: { format_version: 1, sequence: 0, preparations: {} } } : {}) } } : {}),
    service_epoch: 1, fencing: 0, lease_seq: 0, permit_seq: 0,
    last_clock_ms: now, lease: null, lease_idempotency: {}, permits: {}, idempotency: {},
    desktop: { status: "free", key: null }, tombstones: {},
    anchor_sequence: 1,
    store_id: storeId || null,
    // The permission mode of the anchor domain is a property of the
    // deployment, not of the caller. It is stored with the state so that the
    // managed recovery entry points, which are invoked long after the store
    // was opened and by a different process, apply the same contract
    // instead of the one their own caller happened to pass.
    anchor_mode: anchorMode || anchor.ANCHOR_MODE.strict,
    // The identity the deployment promises the service runs as. It is part
    // of the committed state, so the managed recovery entry points -- which
    // run long after the store was opened and from a different process --
    // apply the same contract instead of the one their own caller happened
    // to pass. A null value means "not declared", which is only acceptable
    // on the platforms where the calling process identity is the service
    // identity by construction.
    service_identity: serviceIdentity === undefined ? null : serviceIdentity,
  };
}
function assertState(state) {
  if (!state || ![SCHEMA_VERSION, AUTHORITY_SCHEMA_VERSION, ADMISSION_SCHEMA_VERSION, SIGNING_GATE_SCHEMA_VERSION].includes(state.schema_version) || state.scope !== PROTECTED_SCOPE ||
      typeof state.decision_id !== "string" || !state.decision_id ||
      !Number.isSafeInteger(state.service_epoch) || state.service_epoch < 1 ||
      !Number.isSafeInteger(state.fencing) || state.fencing < 0 ||
      !Number.isSafeInteger(state.lease_seq) || state.lease_seq < 0 ||
      !Number.isSafeInteger(state.permit_seq) || state.permit_seq < 0 ||
      !Number.isSafeInteger(state.last_clock_ms) || state.last_clock_ms < 0 ||
      !state.lease_idempotency || Array.isArray(state.lease_idempotency) || typeof state.lease_idempotency !== "object" ||
      !state.permits || Array.isArray(state.permits) || typeof state.permits !== "object" ||
      !state.idempotency || Array.isArray(state.idempotency) || typeof state.idempotency !== "object" ||
      !state.desktop || !["free", "held", "draining"].includes(state.desktop.status) ||
      !(state.desktop.key === null || typeof state.desktop.key === "string") ||
      !Number.isSafeInteger(state.anchor_sequence) || state.anchor_sequence < 0 ||
      (state.store_id !== null && (typeof state.store_id !== "string" || !state.store_id)) ||
      !state.tombstones || Array.isArray(state.tombstones) || typeof state.tombstones !== "object") fail("ERR_STATE_INVALID");
  // The permission mode is part of the committed state, so it has to be a
  // known mode. An unknown value would otherwise be treated as a weaker one
  // by the callers that read it.
  if (!Object.prototype.hasOwnProperty.call(anchor.ANCHOR_MODE_STRENGTH, state.anchor_mode)) {
    fail("ERR_ANCHOR_MODE_INVALID");
  }
  // The declared service identity is part of the committed state, so a
  // tampered or unknown value has to be refused rather than ignored.
  if (state.service_identity !== null && state.service_identity !== undefined &&
      typeof state.service_identity !== "string") {
    fail("ERR_STATE_INVALID");
  }
  if (state.lease !== null && (!state.lease || typeof state.lease !== "object" ||
      typeof state.lease.leaseId !== "string" || !state.lease.leaseId.startsWith(PROTECTED_LEASE_PREFIX) ||
      !["active", "released", "revoked", "expired"].includes(state.lease.status) ||
      !Number.isSafeInteger(state.lease.serviceEpoch) || !Number.isSafeInteger(state.lease.fencing))) fail("ERR_STATE_INVALID");
  for (const permit of Object.values(state.permits)) {
    if (!permit || typeof permit !== "object" || typeof permit.permitId !== "string" ||
        !["reserved", "consumed", "finished", "failed", "unknown", "revoked", "expired"].includes(permit.status) ||
        !Number.isSafeInteger(permit.sequence) || !Number.isSafeInteger(permit.deadline) ||
        !Number.isSafeInteger(permit.serviceEpoch) || !Number.isSafeInteger(permit.fencing) ||
        (permit.requestedTtlMs !== undefined &&
          (!Number.isSafeInteger(permit.requestedTtlMs) || permit.requestedTtlMs <= 0)) ||
        (permit.batchFingerprint !== undefined &&
          (typeof permit.batchFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(permit.batchFingerprint)))) fail("ERR_STATE_INVALID");
  }
  if (state.schema_version === SCHEMA_VERSION) {
    if (Object.hasOwn(state, "witness_authority")) fail("ERR_STATE_INVALID");
  } else {
    const authority = state.witness_authority;
    if (!authority || authority.mode !== "development-only" || typeof authority.authority_id !== "string" ||
        !authority.authority_id || typeof authority.clock_poisoned !== "boolean" ||
        !authority.targets || Array.isArray(authority.targets) || typeof authority.targets !== "object" ||
        !authority.issuance_bindings || Array.isArray(authority.issuance_bindings) || typeof authority.issuance_bindings !== "object") fail("ERR_STATE_INVALID");
    for (const [targetId, target] of Object.entries(authority.targets)) {
      requireMapKey(targetId);
      if (!target || !target.current || !target.registrations || typeof target.registrations !== "object" ||
          Array.isArray(target.registrations)) fail("ERR_STATE_INVALID");
      const current = witness.assertCheckpointMatches(target.current, target.current.checkpoint);
      if (current.checkpoint.authority_id !== authority.authority_id || current.checkpoint.target_id !== targetId ||
          current.checkpoint.store_generation === state.store_id) fail("ERR_STATE_INVALID");
    }
    const generations = Object.values(authority.targets).map((target) => target.current.checkpoint.store_generation);
    if (new Set(generations).size !== generations.length) fail("ERR_STATE_INVALID");
    for (const [permitId, binding] of Object.entries(authority.issuance_bindings)) {
      const permit = own(state.permits, permitId);
      const target = own(authority.targets, binding && binding.target_id);
      if (!binding || !permit || !target || binding.authority_id !== authority.authority_id ||
          binding.issuer_store_id !== state.store_id || binding.permit_id !== permitId ||
          binding.target_generation !== target.current.checkpoint.store_generation ||
          binding.fingerprint !== permit.batchFingerprint || !permit.signedIssuance ||
          binding.message_bytes !== permit.signedIssuance.signedPermit.bytes ||
          binding.signature !== permit.signedIssuance.signedPermit.signature ||
          typeof binding.request_digest !== "string" ||
          !["issued", "consumed", "invalidated"].includes(binding.status) ||
          (binding.status === "issued" && permit.status !== "reserved") ||
          (binding.status === "consumed" && (permit.status !== "consumed" || !binding.consumption_record)) ||
          (binding.status === "invalidated" && permit.status !== "expired")) fail("ERR_STATE_INVALID");
    }
    if (Object.keys(state.permits).some((id) => !own(authority.issuance_bindings, id))) fail("ERR_STATE_INVALID");
    if (isAdmissionSchema(state.schema_version)) {
      // This slice has no business continuation. A writer must not inject an
      // issuance or lease behind the admission/call gate and still open here.
      if (state.lease !== null || state.desktop.status !== "free" ||
          (state.schema_version === ADMISSION_SCHEMA_VERSION && (state.lease_seq !== 0 || state.permit_seq !== 0)) ||
          Object.keys(state.lease_idempotency).length || Object.keys(state.permits).length ||
          Object.keys(state.idempotency).length || Object.keys(authority.targets).length ||
          Object.keys(authority.issuance_bindings).length) fail("ERR_STATE_INVALID");
      assertAdmissionMetadata(state);
      assertAdmissionState(state);
      if (state.schema_version === SIGNING_GATE_SCHEMA_VERSION) assertSigningState(state);
    } else if (Object.hasOwn(authority, "request_admission") || Object.hasOwn(authority, "signing_gate")) fail("ERR_STATE_INVALID");
  }
}
function matches(record, fields, names) {
  return names.every((name) => record[name] === fields[name]);
}

// The identity of a dispatched action. Two permits that agree on all four
// fields address the same action on the same desktop, no matter which
// idempotency key they were minted under. The idempotency key identifies one
// *attempt*; the action fingerprint identifies the *work*. A retried attempt
// must read back the original record, and a fresh attempt at an already
// dispatched action must be refused -- otherwise the same operation runs
// twice on one desktop.
function actionFingerprint(permit) {
  return [permit.desktopKey, permit.operation, permit.targetDigest, permit.paramsDigest].join("|");
}

// The permits that still hold the desktop for an action: one that has been
// minted but not yet consumed, and one that is being executed right now.
function isLivePermit(permit) {
  return permit.status === "reserved" || permit.status === "consumed";
}

// The permits that prove the action was already dispatched on this desktop:
// the action either reached the executor or it was explicitly closed out.
// A permit that was revoked or expired before it was ever consumed did not
// dispatch anything, so it does not block a later attempt of the same action.
function isDispatchedPermit(permit) {
  return isLivePermit(permit) || permit.status === "finished" || permit.status === "failed" ||
    permit.status === "unknown";
}
function activeLease(state, fields, now) {
  const lease = state.lease;
  if (!lease || lease.status !== "active" || lease.expiresAt <= now ||
      lease.fencing !== state.fencing || lease.serviceEpoch !== state.service_epoch ||
      !matches(lease, fields, ["leaseId", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "serviceEpoch", "fencing"])) {
    fail("ERR_LEASE_NOT_CURRENT");
  }
  if (state.desktop.status !== "held" || state.desktop.key !== lease.desktopKey) fail("ERR_DESKTOP_DRAINING");
  return lease;
}

class ProtectedPermitStore {
  #db;
  #clock;
  #verifyRecovery;
  #anchorFile;
  #anchorDir;
  #storeId;
  #closed = false;
  #poisoned = false;
  #lockIdentity = null;
  #permissionOptions;
  #authority;
  #authorityDurability;
  #historyActive = false;
  #admissionActive = false;
  #prepareTickets = new WeakMap();
  #callCapabilities = new WeakMap();
  #signingBlocked = false;
  #signingOwner = crypto.randomBytes(16).toString("hex");

  constructor(db, options = {}, authorityDurability) {
    // A store without an anchor would silently skip the rollback detection,
    // so the anchor is required at construction as well. The public entry
    // points are initialize() and open(); both of them bind the anchor, and
    // this check makes sure that no other construction path can produce a
    // store that runs without one.
    if (!options.anchorFile || !options.anchorDir || !options.storeId) fail("ERR_ANCHOR_REQUIRED");
    this.#db = db;
    this.#permissionOptions = nativePermissionOptions(options);
    this.#authority = authorityOptions(options);
    if (this.#authority && authorityDurability === undefined) fail("ERR_WITNESS_AUTHORITY_DISABLED");
    this.#authorityDurability = authorityDurability;
    this.#clock = options.clock || Date.now;
    this.#verifyRecovery = options.verifyRecovery || null;
    this.#anchorFile = options.anchorFile || null;
    this.#anchorDir = options.anchorDir || null;
    this.#storeId = options.storeId || null;
  }

  static initialize(filePath, options = {}) {
    options = nativePermissionOptions(options);
    const authority = authorityOptions(options); // Refuse unsupported modes before provisioning anything.
    if (authority) options = { ...options, witnessAuthority: authority };
    sqliteRuntime();
    requireText(options.decisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    const dir = anchor.anchorDirFor(options.anchorDir);
    const capability = authority ? anchor.preflightAuthorityDurability(dir) : undefined;
    if (authority && capability === undefined) fail("ERR_WITNESS_AUTHORITY_DISABLED");
    anchor.assertSeparateDomains(dir, filePath);
    anchor.assertAnchorPermissionsWithIdentity(dir,
      anchor.assertKnownAnchorMode(options.anchorMode), options.serviceIdentity, options);
    const parent = path.dirname(path.resolve(filePath));
    if (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink() ||
        fs.readdirSync(parent).length !== 0) fail("ERR_INIT_PATH_NOT_EMPTY");
    let store;
    try {
      return coordination.withLock(dir, (identity) => {
        store = this.#initializeUnlocked(filePath, options, capability);
        store.#lockIdentity = identity;
        return store;
      }, { create: true });
    } catch (error) {
      try { if (store) store.close(); } catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
  }

  // Validate the recorded authorization contract before touching the lock domain.
  // Re-read all state under the lock in the existing implementation below.
  static #withExistingLock(filePath, options, action, allowAuthority = false) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    const dir = anchor.anchorDirFor(options.anchorDir);
    anchor.assertSeparateDomains(dir, filePath);
    const db = new DatabaseSync(path.resolve(filePath), { readOnly: true, timeout: 5000 });
    try {
      const row = readProtectedRow(db, configuredSchema(authorityOptions(options)), allowAuthority);
      if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
      const state = JSON.parse(row.body);
      if (state.schema_version !== row.version) fail("ERR_STATE_INVALID");
      assertState(state);
      if (isAuthoritySchema(state.schema_version) && !allowAuthority) fail("ERR_WITNESS_RECOVERY_UNSUPPORTED");
      // The read-only discovery must not acquire a lock or write an audit for
      // an authority store opened without its matching explicit configuration.
      if (allowAuthority) {
        const configured = authorityOptions(options);
        if (isAuthoritySchema(state.schema_version) !== Boolean(configured) ||
            (isAdmissionSchema(state.schema_version) ? state.schema_version : null) !== configuredSchema(configured)) {
          fail("ERR_WITNESS_AUTHORITY_DISABLED");
        }
      }
      anchor.assertAnchorPermissionsWithIdentity(dir,
        anchor.assertNoAnchorModeDowngrade(state.anchor_mode, options.anchorMode),
        state.service_identity, options);
    } finally { db.close(); }
    return coordination.withLock(dir, action);
  }

  static open(filePath, options = {}) {
    options = nativePermissionOptions(options);
    const authority = authorityOptions(options);
    if (authority) options = { ...options, witnessAuthority: authority };
    if (!Number.isSafeInteger(options.minimumEpoch) || options.minimumEpoch < 1) fail("ERR_INVALID_INPUT");
    if (authority && !options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    // Explicit authority bootstraps preflight even before read-only SQLite
    // discovery, lock acquisition or permission-audit side effects.
    const capability = authority ? anchor.preflightAuthorityDurability(options.anchorDir) : undefined;
    if (authority && capability === undefined) fail("ERR_WITNESS_AUTHORITY_DISABLED");
    let store;
    try {
      return this.#withExistingLock(filePath, options, (identity) => {
        store = this.#openUnlocked(filePath, options, capability);
        store.#lockIdentity = identity;
        return store;
      }, true);
    } catch (error) {
      try { if (store) store.close(); } catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
  }

  static #initializeUnlocked(filePath, options = {}, capability) {
    requireText(options.decisionId);
    // The anchor is mandatory: without it the store cannot detect a
    // same-epoch rollback, which would make VC-044-007 fail open.
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    let anchorDir = null;
    let journalFile = null;
    if (options.anchorDir) {
      anchorDir = anchor.anchorDirFor(options.anchorDir);
      anchor.assertSeparateDomains(options.anchorDir, filePath);
      journalFile = anchor.journalFileFor(anchorDir);
    }
    // The anchor domain is checked before anything is written into it, so a
    // store that records the strict contract cannot be created in a domain
    // that does not satisfy it. Otherwise the store would come up, record a
    // mode it does not honour, and refuse its own first open.
    anchor.assertAnchorPermissionsWithIdentity(anchorDir,
      anchor.assertKnownAnchorMode(options.anchorMode), options.serviceIdentity, options);
    const DatabaseSync = sqliteRuntime();
    const resolved = path.resolve(filePath);
    const parent = path.dirname(resolved);
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(parent).length !== 0) fail("ERR_INIT_PATH_NOT_EMPTY");
    const now = (options.clock || Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) fail("ERR_CLOCK_INVALID");
    const db = new DatabaseSync(resolved, { timeout: 5000 });
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      db.exec("CREATE TABLE protected_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, sha256 TEXT NOT NULL)");
      // The store identity binds the journal to this database instance. It is
      // written into the database body so that a journal copied from another
      // instance is rejected on open, instead of being silently adopted.
      const storeId = crypto.randomBytes(16).toString("hex");
      const state = initialState(now, options.decisionId, storeId, options.anchorMode, options.serviceIdentity, authorityOptions(options));
      if (isAdmissionSchema(state.schema_version)) assertState(state);
      const body = JSON.stringify(state);
      db.prepare("INSERT INTO protected_state (id, body, sha256) VALUES (1, ?, ?)").run(body, digest(body));
      db.exec(`PRAGMA user_version=${state.schema_version}`);
      const store = new ProtectedPermitStore(db, { ...options, anchorFile: journalFile, anchorDir, storeId }, capability);
      if (journalFile) {
        store.#appendAnchorEntry({ type: "intent", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
        store.#appendAnchorEntry({ type: "commit", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
        store.#appendAnchorHighWater({ sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      }
      return store;
    } catch (error) { db.close(); throw error; }
  }

  static #openUnlocked(filePath, options = {}, capability) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!Number.isSafeInteger(options.minimumEpoch) || options.minimumEpoch < 1) fail("ERR_INVALID_INPUT");
    // The anchor is mandatory and there is no opt-out. An earlier design had
    // an allowNoAnchor escape hatch whose validity depended on a flag inside
    // the database body; because the database is exactly what an attacker who
    // can replace it controls, that flag could be rewritten to disable the
    // rollback detection. The escape hatch was therefore removed: the
    // presence of the anchor is decided by the anchor directory, not by the
    // database.
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    let anchorDir = null;
    let journalFile = null;
    try {
      anchorDir = anchor.anchorDirFor(options.anchorDir);
      anchor.assertSeparateDomains(options.anchorDir, filePath);
      journalFile = anchor.journalFileFor(anchorDir);
    }
    catch (error) { fail(error.code || "ERR_STATE_MISSING_OR_UNSAFE"); }
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      const version = db.prepare("PRAGMA user_version").get().user_version;
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
          ![SCHEMA_VERSION, AUTHORITY_SCHEMA_VERSION, ADMISSION_SCHEMA_VERSION, SIGNING_GATE_SCHEMA_VERSION].includes(version)) fail("ERR_STATE_INVALID");
      // The store identity is bound to the journal on first use and inherited
      // from it on every later open, so entries written by any process share
      // the same identity and a journal from another instance is not adopted.
      let storeId = null;
      const journal = anchor.readJournal(journalFile);
      if (journal.entries.length === 0) fail("ERR_ANCHOR_MISSING");
      if (journal.storeIds.size !== 1) fail("ERR_ANCHOR_CORRUPT");
      storeId = [...journal.storeIds][0];
      const store = new ProtectedPermitStore(db, { ...options, anchorFile: journalFile, anchorDir, storeId }, capability);
      const raw = store.#readRaw();
      const snapshot = raw.state;
      if (snapshot.schema_version !== version) fail("ERR_STATE_INVALID");
      if (snapshot.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      if (snapshot.service_epoch < options.minimumEpoch) fail("ERR_EPOCH_ROLLBACK");
      // The recorded permission mode is the contract the store was created
      // under. A caller may not weaken it for a single open: the store was
      // initialised with a mode, and a mode that is weaker than the recorded
      // one would let this open pass while the recorded contract still
      // applies to every other process.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(snapshot.anchor_mode, options.anchorMode),
        snapshot.service_identity, options);
      // The database carries the store identity it was created with. A
      // journal that belongs to a different instance must not be adopted, so
      // the two identities have to agree.
      if (snapshot.store_id !== storeId) fail("ERR_ANCHOR_STORE_MISMATCH");
      // The high-water declaration is the second witness of the mark. It
      // survives the deletion of journal entries, so an attacker who can only
      // write the database cannot lower the mark, and one who deleted journal
      // entries cannot lower it either.
      const declared = anchor.readHighWater(anchorDir);
      if (declared.mark > 0) {
        if (snapshot.anchor_sequence < declared.mark) fail("ERR_STATE_ROLLED_BACK");
        if (snapshot.anchor_sequence === declared.mark && declared.digest !== digest(raw.body)) {
          fail("ERR_STATE_TAMPERED");
        }
      }
      if (journalFile) store.#verifyAnchor(journalFile, snapshot, raw.body);
      if (isAuthoritySchema(snapshot.schema_version) && declared.mark !== snapshot.anchor_sequence) {
        // A completed journal entry without its high-water barrier is still
        // an incomplete authority commit, not permission to resume on reopen.
        fail("ERR_CRASH_WINDOW_RECOVERABLE");
      }
      const now = (options.clock || Date.now)();
      if (!Number.isSafeInteger(now)) fail("ERR_CLOCK_ROLLBACK");
      if (now < snapshot.last_clock_ms) {
        if (isAuthoritySchema(snapshot.schema_version)) {
          // open() already holds the coordination lock: do not acquire it again.
          // Revalidate the DB/anchor, using the captured rollback observation.
          // A second clock read may throw/return NaN and must not erase it.
          store.#transactionUnlocked((state) => { poisonAuthorityState(state); }, true, now);
        }
        fail("ERR_CLOCK_ROLLBACK");
      }
      return store;
    } catch (error) { db.close(); throw error; }
  }

  #read() {
    return this.#readRaw().state;
  }

  // The raw body string matters: the anchor binds the exact bytes that were
  // committed, so the comparison must not re-serialize a parsed snapshot.
  #readRaw() {
    if (this.#closed) fail("ERR_STORE_CLOSED");
    if (this.#poisoned) fail("ERR_COMMIT_OUTCOME_UNKNOWN");
    let row;
    try { row = readProtectedRow(this.#db, configuredSchema(this.#authority)); }
    catch (error) {
      if (error instanceof ProtectedStoreError) throw error;
      fail("ERR_STATE_INVALID");
    }
    if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
    let state;
    try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
    if (row.version !== undefined && state.schema_version !== row.version) fail("ERR_STATE_INVALID");
    assertState(state);
    if (isAuthoritySchema(state.schema_version)) {
      if (!this.#authority || this.#authority.authorityId !== state.witness_authority.authority_id ||
          (isAdmissionSchema(state.schema_version) ? state.schema_version : null) !== configuredSchema(this.#authority)) fail("ERR_WITNESS_AUTHORITY_DISABLED");
    } else if (this.#authority) fail("ERR_WITNESS_AUTHORITY_DISABLED");
    return { state, body: row.body };
  }

  snapshot() {
    if (this.#admissionActive) fail("ERR_WITNESS_ADMISSION_ACTIVE");
    return coordination.withLock(this.#anchorDir, () => {
      const raw = this.#readRaw();
      this.#assertJournalStillValid(raw.state, raw.body);
      return structuredClone(raw.state);
    }, { expectedIdentity: this.#lockIdentity });
  }

  // Trusted in-process, development-only diagnostic surface. Not routed by the
  // existing witness host/wire, and never an unblocking/retry/recovery operation.
  // authorizeHistory(peer, "history.<operation>", frozenQuery) must synchronously
  // recheck identity and return { principal, resources: <complete allowed query> }.
  // It must derive that grant independently of request claims. Returning true,
  // a Promise, a write permission, or a partial resource grant is insufficient.
  queryWitnessHistory(peer, input) {
    if (this.#admissionActive) fail("ERR_WITNESS_ADMISSION_ACTIVE");
    if (this.#authority && this.#authority.admissionMode) fail("ERR_WITNESS_ADMISSION_ONLY");
    if (!this.#authority || typeof this.#authority.authorizeHistory !== "function") fail("ERR_WITNESS_HISTORY_NOT_AUTHORIZED");
    if (this.#closed) fail("ERR_STORE_CLOSED");
    if (this.#poisoned) fail("ERR_COMMIT_OUTCOME_UNKNOWN");
    if (this.#historyActive || this.#lockIdentity === null) fail("ERR_WITNESS_HISTORY_UNAVAILABLE");
    const query = historyRequest(input);
    const queryDigest = digest(witness.canonicalBytes(query));
    const authorize = () => {
      const value = this.#authority.authorizeHistory(peer, "history." + query.operation, query);
      if (value && typeof value.then === "function") {
        Promise.resolve(value).catch(() => {});
        fail("ERR_WITNESS_HISTORY_NOT_AUTHORIZED");
      }
      if (!value || typeof value !== "object") fail("ERR_WITNESS_HISTORY_NOT_AUTHORIZED");
      const grant = dataRequest(value, ["principal", "resources"]);
      requireText(grant.principal);
      if (digest(witness.canonicalBytes(grant.resources)) !== queryDigest) fail("ERR_WITNESS_HISTORY_NOT_AUTHORIZED");
      return digest(grant.principal);
    };
    this.#historyActive = true;
    try {
      const principalDigest = authorize(); // Before reading any protected history.
      const reauthorize = () => {
        if (authorize() !== principalDigest) fail("ERR_WITNESS_HISTORY_NOT_AUTHORIZED");
      };
      let result;
      try {
        result = coordination.withLock(this.#anchorDir, () => {
          reauthorize();
          this.#db.exec("BEGIN");
          let observation;
          try {
            const raw = this.#readRaw(), state = raw.state;
            if (state.schema_version !== AUTHORITY_SCHEMA_VERSION ||
                this.#db.prepare("PRAGMA user_version").get().user_version !== AUTHORITY_SCHEMA_VERSION ||
                state.witness_authority.mode !== "development-only") fail("ERR_WITNESS_AUTHORITY_DISABLED");
            if (state.decision_id !== query.decisionId || state.witness_authority.authority_id !== query.authorityId ||
                state.store_id !== query.issuerStoreId) fail("ERR_WITNESS_HISTORY_BINDING");
            const journal = this.#assertJournalStillValid(state, raw.body);
            const declared = anchor.readHighWater(this.#anchorDir);
            // Validate the declaration's identity even when it lags the journal.
            if (declared.storeId !== state.store_id) fail("ERR_ANCHOR_STORE_MISMATCH");
            const effect = historyEffect(state, query);
            const target = own(state.witness_authority.targets, query.request.targetId);
            observation = freezeData({ status: effect ? "found" : "not-found-at-boundary", operation: query.operation,
              mode: "development-only", executionAuthorized: false, resumeAllowed: false,
              originalRequestOutcome: "unknown", effect,
              boundary: { decisionId: state.decision_id, authorityId: query.authorityId, issuerStoreId: state.store_id,
                serviceEpoch: state.service_epoch, anchorSequence: state.anchor_sequence, bodyDigest: digest(raw.body),
                journalSequence: journal.committed, highWaterSequence: declared.mark },
              currentCheckpoint: target ? historyCheckpoint(target.current.checkpoint, query.authorityId,
                query.request.targetId, target.current.checkpoint.store_generation) : null,
              clockPoisoned: state.witness_authority.clock_poisoned || Boolean(target && target.current.state.clock_poisoned) });
            this.#db.exec("COMMIT");
          } catch (error) {
            try { this.#db.exec("ROLLBACK"); } catch { this.#poisoned = true; }
            throw error;
          }
          reauthorize();
          // Records an observation, not proof of response delivery, of the
          // original actor, or of a business transaction having not committed.
          this.#writeHistoryAudit({ event: "witness-history-observation", operation: query.operation,
            query_digest: queryDigest, query_principal_digest: principalDigest, status: observation.status,
            boundary: observation.boundary, executionAuthorized: false, resumeAllowed: false });
          reauthorize();
          return observation;
        }, { expectedIdentity: this.#lockIdentity });
        reauthorize(); // withLock also verifies identity and completes cleanup before release.
      } catch (error) {
        // Once protected inspection starts, failed identity/integrity/audit or
        // lock cleanup is terminal for this handle. Never clear an existing latch.
        this.#poisoned = true;
        throw error;
      }
      return result;
    } finally { this.#historyActive = false; }
  }

  #writeHistoryAudit(record) {
    let fd, dir, failure, cleanupError;
    try {
      fd = fs.openSync(path.join(this.#anchorDir, "protected-anchor-audit.log"),
        fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) {
        fail("ERR_AUDIT_WRITE_FAILED");
      }
      if (stat.size > 0) {
        const tail = Buffer.alloc(1);
        if (fs.readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10) fail("ERR_AUDIT_WRITE_FAILED");
      }
      const bytes = Buffer.from(JSON.stringify({ schema_version: 1, at: new Date().toISOString(), store_id: this.#storeId, ...record }) + "\n");
      if (fs.writeSync(fd, bytes) !== bytes.length) fail("ERR_AUDIT_WRITE_FAILED");
      fs.fsyncSync(fd);
      // close may release its descriptor before throwing. Relinquish it
      // before the attempt so cleanup cannot close a reused numeric fd.
      const fileToClose = fd; fd = undefined;
      fs.closeSync(fileToClose);
      // Persist creation as well as contents. If the platform cannot provide
      // this evidence, fail closed rather than claim a durable observation.
      dir = fs.openSync(this.#anchorDir, "r");
      fs.fsyncSync(dir);
      const dirToClose = dir; dir = undefined;
      fs.closeSync(dirToClose);
    } catch (error) { failure = error; }
    finally {
      for (const descriptor of [fd, dir]) {
        if (descriptor === undefined) continue;
        try { fs.closeSync(descriptor); }
        catch (error) {
          if (!failure) failure = error;
          else if (!cleanupError) cleanupError = error;
        }
      }
    }
    if (failure) {
      const error = new ProtectedStoreError("ERR_AUDIT_WRITE_FAILED");
      error.cause = failure;
      if (cleanupError) error.cleanupError = cleanupError;
      throw error;
    }
  }

  // The anchor records the high-water mark outside the database rollback
  // domain. A database whose recorded sequence is behind the anchor was
  // replaced by an older snapshot, so the service must refuse to start.
  #verifyAnchor(journalFile, snapshot, rawBody) {
    let journal;
    try { journal = anchor.readJournal(journalFile); }
    catch (error) { fail(error.code || "ERR_ANCHOR_UNREADABLE"); }
    if (journal.committed === 0) fail("ERR_ANCHOR_MISSING");
    const bodyDigest = digest(rawBody);
    // The database is older than the committed high-water mark: the database
    // was rolled back. This is never recoverable.
    if (snapshot.anchor_sequence < journal.committed) fail("ERR_STATE_ROLLED_BACK");
    if (snapshot.anchor_sequence > journal.committed) {
      // The database is ahead of the journal: the crash happened between the
      // database commit and the journal commit entry. This is recoverable
      // only when the dangling intent proves the sequence, because the intent
      // carries the digest the database must now have.
      const intent = journal.intentsBySeq.get(snapshot.anchor_sequence);
      if (!intent || intent.body_digest !== bodyDigest) fail("ERR_STATE_AHEAD_OF_ANCHOR");
      fail("ERR_CRASH_WINDOW_RECOVERABLE");
    }
    // The database matches the high-water mark: the journal's body digest at
    // that sequence must equal the digest of the committed database body.
    // This stops an attacker who only edits the database from forging a
    // matching anchor_sequence and recomputing the body checksum.
    const committed = journal.committedBySeq.get(journal.committed);
    if (!committed || committed.body_digest !== bodyDigest) fail("ERR_STATE_TAMPERED");
  }

  #appendAnchorEntry(entry) {
    if (this.#authority) return anchor.appendEntry(this.#anchorFile, entry, this.#authorityDurability);
    return anchor.appendEntry(this.#anchorFile, entry);
  }

  #appendAnchorHighWater(entry) {
    if (this.#authority) return anchor.appendHighWater(this.#anchorDir, entry, this.#authorityDurability);
    return anchor.appendHighWater(this.#anchorDir, entry);
  }

  #transaction(change, authorityAccess = false) {
    if (this.#admissionActive && !authorityAccess) fail("ERR_WITNESS_ADMISSION_ACTIVE");
    if (this.#historyActive) fail("ERR_WITNESS_HISTORY_ACTIVE");
    return coordination.withLock(this.#anchorDir, () => this.#transactionUnlocked(change, authorityAccess),
      { expectedIdentity: this.#lockIdentity });
  }

  #transactionUnlocked(change, authorityAccess, observedNow) {
    if (this.#closed) fail("ERR_STORE_CLOSED");
    if (this.#poisoned) fail("ERR_COMMIT_OUTCOME_UNKNOWN");
    this.#db.exec("BEGIN IMMEDIATE");
    let commitAttempted = false;
    let sequence = null;
    let bodyDigest = null;
    let attempt = null;
    try {
      const raw = this.#readRaw();
      const state = raw.state;
      // Every legacy writer (including lifecycle/recovery helpers) is fenced.
      if (isAuthoritySchema(state.schema_version) && !authorityAccess) fail("ERR_WITNESS_LEGACY_ENTRY_DISABLED");
      // An already-open store must re-check the journal before it advances
      // it. Otherwise a deleted or rolled-back journal would let the next
      // transaction silently lower the high-water mark.
      // The journal is read once here and reused: it decides the attempt
      // counter for this transaction and avoids a second full directory scan
      // for every entry that is appended.
      let journal = null;
      if (this.#anchorFile) journal = this.#assertJournalStillValid(raw.state, raw.body);
      // observedNow is private to the already-locked open rollback path; it is
      // never a caller/request clock override or a substitute for authentication.
      const now = observedNow === undefined ? this.#clock() : observedNow;
      if (!Number.isSafeInteger(now) || (!authorityAccess && (now < 0 || now < state.last_clock_ms))) fail("ERR_CLOCK_ROLLBACK");
      const result = change(state, now);
      state.last_clock_ms = Math.max(now, state.last_clock_ms);
      state.anchor_sequence += 1;
      assertState(state);
      const body = JSON.stringify(state);
      sequence = state.anchor_sequence;
      bodyDigest = digest(body);
      if (this.#anchorFile) {
        attempt = anchor.nextAttemptFor(journal, sequence);
        // Intent first: it records the digest the database is about to have,
        // so a crash between the database commit and the journal commit entry
        // is provable and not confusable with a rollback.
        this.#appendAnchorEntry({ type: "intent", sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt });
      }
      // The audit record is written before the database commits. Writing it
      // afterwards would leave a committed state without any trace of how it
      // was reached if the process died in between.
      this.#writeAudit({ event: "transaction", sequence, body_digest: bodyDigest });
      this.#db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, bodyDigest);
      commitAttempted = true;
      this.#db.exec("COMMIT");
      if (this.#anchorFile) {
        this.#appendAnchorEntry({ type: "commit", sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt });
        this.#appendAnchorHighWater({ sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt });
      }
      return result;
    } catch (error) {
      if (commitAttempted) this.#poisoned = true;
      try { this.#db.exec("ROLLBACK"); } catch { this.#poisoned = true; }
      // The database transaction did not commit, so the intent is abandoned.
      // Recording the abort keeps the journal explicit about the sequence
      // never having been committed, and keeps the sequence number reusable.
      if (!commitAttempted && this.#anchorFile && sequence !== null) {
        try { this.#appendAnchorEntry({ type: "abort", sequence, body_digest: bodyDigest, store_id: this.#storeId, attempt }); }
        catch { this.#poisoned = true; }
      }
      throw error;
    }
  }

  // The audit trail lives next to the anchor, outside the database rollback
  // domain, so restoring an old database cannot erase it.
  #writeAudit(record) {
    if (!this.#anchorDir) return;
    const entry = {
      schema_version: 1,
      at: new Date().toISOString(),
      store_id: this.#storeId,
      ...record,
    };
    if (this.#authority) {
      // Only the explicitly provisioned development authority uses this
      // stronger barrier. Legacy writers retain their existing audit contract.
      let fd, dir, failure, cleanupError;
      try {
        // No verified native Windows directory persistence backend exists here.
        // Never turn a missing barrier into a successful authority transaction.
        if (process.platform === "win32" || !Number.isInteger(fs.constants.O_NOFOLLOW) ||
            !Number.isInteger(fs.constants.O_DIRECTORY)) {
          fail("ERR_AUDIT_DURABILITY_UNSUPPORTED");
        }
        dir = fs.openSync(this.#anchorDir,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        if (!fs.fstatSync(dir).isDirectory()) fail("ERR_AUDIT_WRITE_FAILED");
        fd = fs.openSync(path.join(this.#anchorDir, "protected-anchor-audit.log"),
          fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT |
          fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid())) fail("ERR_AUDIT_WRITE_FAILED");
        if (stat.size > 0) {
          const tail = Buffer.alloc(1);
          if (fs.readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10) fail("ERR_AUDIT_WRITE_FAILED");
        }
        const bytes = Buffer.from(JSON.stringify(entry) + "\n");
        for (let offset = 0; offset < bytes.length;) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) fail("ERR_AUDIT_WRITE_FAILED");
          offset += written;
        }
        fs.fsyncSync(fd);
        // A failed close may already have released its fd: never retry that fd.
        const fileToClose = fd; fd = undefined;
        fs.closeSync(fileToClose);
        // Also sync existing files' directory: no prior creation barrier is assumed.
        fs.fsyncSync(dir);
        const dirToClose = dir; dir = undefined;
        fs.closeSync(dirToClose);
      } catch (error) { failure = error; }
      finally {
        for (const descriptor of [fd, dir]) {
          if (descriptor === undefined) continue;
          try { fs.closeSync(descriptor); }
          catch (error) {
            if (!failure) failure = error;
            else if (!cleanupError) cleanupError = error;
          }
        }
      }
      if (failure) {
        // The DB has not attempted COMMIT, but append/sync/cleanup may be
        // uncertain. Refuse reuse of this handle; this is not durable poison.
        this.#poisoned = true;
        const error = new ProtectedStoreError("ERR_AUDIT_WRITE_FAILED");
        error.cause = failure;
        if (cleanupError) error.cleanupError = cleanupError;
        throw error;
      }
      return;
    }
    try {
      fs.appendFileSync(path.join(this.#anchorDir, "protected-anchor-audit.log"),
        JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch {
      // The audit is mandatory: a transaction that cannot be recorded must
      // not commit.
      fail("ERR_AUDIT_WRITE_FAILED");
    }
  }

  // Re-check the journal against the committed database body before a
  // transaction advances it. A missing or inconsistent journal is a
  // fail-closed condition, never a reason to recreate the high-water mark.
  #assertJournalStillValid(state, rawBody) {
    anchor.assertAnchorPermissionsWithIdentity(this.#anchorDir,
      anchor.assertNoAnchorModeDowngrade(state.anchor_mode, this.#permissionOptions.anchorMode),
      state.service_identity, this.#permissionOptions);
    let journal;
    try { journal = anchor.readJournal(this.#anchorFile); }
    catch (error) { fail(error.code || "ERR_ANCHOR_UNREADABLE"); }
    if (journal.committed === 0) fail("ERR_ANCHOR_MISSING");
    if (state.anchor_sequence < journal.committed) fail("ERR_STATE_ROLLED_BACK");
    // The coordination lock excludes a live writer. A matching dangling
    // intent now proves an actual interrupted commit, never permission for
    // an already-open handle to silently finish it through a new operation.
    if (state.anchor_sequence > journal.committed) {
      const intent = journal.intentsBySeq.get(state.anchor_sequence);
      // The intent must prove the database: its digest has to equal the
      // committed body digest. Without this comparison a database that was
      // edited to carry a higher anchor_sequence would be accepted, and the
      // high-water mark would be silently rewritten to that forged value.
      if (!intent || intent.body_digest !== digest(rawBody)) fail("ERR_STATE_AHEAD_OF_ANCHOR");
      fail("ERR_CRASH_WINDOW_RECOVERABLE");
    }
    const committed = journal.committedBySeq.get(journal.committed);
    if (!committed) fail("ERR_ANCHOR_CORRUPT");
    if (state.anchor_sequence === journal.committed && committed.body_digest !== digest(rawBody)) {
      fail("ERR_STATE_TAMPERED");
    }
    if (state.store_id !== this.#storeId || journal.storeIds.size !== 1 ||
        !journal.storeIds.has(this.#storeId)) fail("ERR_ANCHOR_STORE_MISMATCH");
    const declared = anchor.readHighWater(this.#anchorDir);
    if (state.anchor_sequence < declared.mark) fail("ERR_STATE_ROLLED_BACK");
    if (state.anchor_sequence === declared.mark && declared.digest !== digest(rawBody)) fail("ERR_STATE_TAMPERED");
    if (isAuthoritySchema(state.schema_version) && declared.mark !== state.anchor_sequence) fail("ERR_CRASH_WINDOW_RECOVERABLE");
    return journal;
  }

  // Host-only development composition. The callbacks are trusted deployment
  // dependencies, NOT request-supplied facts, certificate verification or an RPC
  // authentication implementation. The unsigned result flag is advisory only;
  // cross-trust-domain signature isolation remains a production blocker above.
  #authorityTransaction(peer, operation, input, fields, change) {
    if (!this.#authority) fail("ERR_WITNESS_AUTHORITY_DISABLED");
    // Do not let old development issue/register/consume bypass admission. There
    // is deliberately no signer continuation until the independent durable
    // call gate, private one-shot owner and final business transaction exist.
    if (this.#authority.admissionMode) fail("ERR_WITNESS_ADMISSION_ONLY");
    const request = freezeData(dataRequest(input, fields));
    const result = this.#transaction((state, now) => {
      if (state.schema_version !== AUTHORITY_SCHEMA_VERSION) fail("ERR_WITNESS_AUTHORITY_DISABLED");
      const authority = state.witness_authority;
      if (this.#authority.authorize(peer, operation, request, freezeData(structuredClone(state))) !== true) {
        fail("ERR_WITNESS_NOT_AUTHORIZED");
      }
      if (now < state.last_clock_ms) {
        poisonAuthorityState(state);
      }
      if (authority.clock_poisoned) return { denied: "ERR_WITNESS_CLOCK" };
      return change(state, now, request);
    }, true);
    // Business refusals that advance safety state must be thrown AFTER commit.
    if (result.denied) fail(result.denied);
    return { ...structuredClone(result), executionAuthorized: false };
  }

  // Development admission/lookup only: no observation, signature, business
  // checkpoint, execution claim, result publication or recovery capability.
  // authorize is a trusted deployment dependency, not a caller callback. It
  // must derive stable subject/issuer/tenant from its private authenticated
  // context and independently grant the COMPLETE envelope (including aliases).
  admitAuthorityRequest(peer, input) {
    return this.#admissionTransaction(peer, input, false);
  }

  lookupAuthorityRequest(peer, input) {
    return this.#admissionTransaction(peer, input, true);
  }

  #admissionTransaction(peer, input, lookup) {
    if (!this.#authority || this.#authority.admissionMode !== "development-only") fail("ERR_WITNESS_AUTHORITY_DISABLED");
    if (this.#admissionActive) fail("ERR_WITNESS_ADMISSION_ACTIVE");
    const request = admissionRequest(input);
    const bytes = witness.canonicalBytes(request).toString("utf8");
    const requestDigest = digest(bytes);
    this.#admissionActive = true;
    try {
      const result = this.#transaction((state, now) => {
        if (!isAdmissionSchema(state.schema_version)) fail("ERR_WITNESS_AUTHORITY_DISABLED");
        // Both checks see the same immutable DB snapshot; keep one detached
        // copy rather than retaining two full histories during authorization.
        const authorizationState = freezeData(structuredClone(state));
        const authorize = () => admissionGrant(this.#authority.authorize(peer,
          lookup ? "request.lookup" : "request.admit", request, authorizationState), request);
        const authorization = authorize();
        // Require stable authenticated facts throughout the local transaction;
        // no identity is obtained from peer, request or boolean legacy grants.
        if (!witness.canonicalBytes(authorization).equals(witness.canonicalBytes(authorize()))) fail("ERR_WITNESS_NOT_AUTHORIZED");
        if (now < state.last_clock_ms) poisonAuthorityState(state);
        if (state.witness_authority.clock_poisoned) return { denied: "ERR_WITNESS_CLOCK" };
        const a = state.witness_authority.request_admission;
        const keys = admissionKeys(state, authorization.principal, request);
        const id = own(a.associations, keys.association);
        if (id) {
          const original = a.attempts[id];
          if (original.request_bytes !== bytes) return { denied: "ERR_WITNESS_REQUEST_CONFLICT" };
          return { attemptId: id, status: original.status, requestDigest: original.request_digest };
        }
        if (lookup) return { status: "not-found", requestDigest };
        // Every unresolved admission holds both reservations indefinitely.
        // No TTL, new subject/key/epoch or missing result can release them.
        if (own(a.business_keys, keys.business) || own(a.resources, keys.resource)) {
          return { denied: "ERR_WITNESS_REQUEST_BLOCKED" };
        }
        if (a.sequence >= ADMISSION_MAX_ATTEMPTS) fail("ERR_WITNESS_ADMISSION_CAPACITY");
        // A rolled-back sequence must not reuse an internally allocated ID on
        // retry. IDs are opaque, independently random, and collision-checked.
        const attemptId = `admission:${state.store_id}:${crypto.randomBytes(16).toString("hex")}`;
        if (Object.hasOwn(a.attempts, attemptId)) fail("ERR_STATE_INVALID");
        const record = { attempt_id: attemptId, sequence: a.sequence + 1, encoding_version: 1,
          request_bytes: bytes, request_digest: requestDigest, principal: authorization.principal,
          grant: authorization.grant, service_epoch: state.service_epoch, admitted_at_ms: now, status: "admitted" };
        // Preflight exact stored cost before changing history or allocator state.
        // Existing retries/lookups/conflicts above remain available at capacity.
        admissionCapacity({ ...a, sequence: a.sequence + 1,
          attempts: { ...a.attempts, [attemptId]: record },
          associations: { ...a.associations, [keys.association]: attemptId },
          business_keys: { ...a.business_keys, [keys.business]: attemptId },
          resources: { ...a.resources, [keys.resource]: attemptId } }, "ERR_WITNESS_ADMISSION_CAPACITY");
        a.sequence++;
        a.attempts[attemptId] = record;
        a.associations[keys.association] = attemptId;
        a.business_keys[keys.business] = attemptId;
        a.resources[keys.resource] = attemptId;
        return { attemptId, status: "admitted", requestDigest };
      }, true);
      if (result.denied) fail(result.denied);
      return { ...result, executionAuthorized: false, resumeAllowed: false, originalRequestOutcome: "unknown" };
    } finally { this.#admissionActive = false; }
  }

  // Explicit schema-5 development slice. The ticket/capability are opaque
  // object identities owned by THIS handle; snapshots and wire bytes cannot
  // reconstitute them. No method invokes signPermit or produces a signature.
  prepareAuthoritySigning(peer, input) {
    return this.#signingTransaction(peer, input, "sign.prepare", (state, now, request, original, authorization) => {
      const gate = state.witness_authority.signing_gate;
      // The current authority has ONE lease/fence domain, irrespective of
      // caller resource labels. Every prepared/call-possible/unknown record is
      // unresolved, including this attempt's duplicate prepare. Never mint a
      // replacement ticket/capability; no release/recovery writer exists. Refuse
      // before changing numbering/fence or invoking the preparation provider.
      if (Object.keys(gate.preparations).length) throw new SigningReservationConflict();
      const snapshot = freezeData(structuredClone(state));
      const facts = signingFacts(this.#authority.prepareSigning(request, snapshot));
      const signingInput = signingRequest(request, state, facts);
      if (signingInput.lease.owner !== authorization.principal.subjectId) fail("ERR_WITNESS_SIGNING_NOT_AUTHORIZED");
      const sequence = gate.sequence + 1;
      const permit = signingPermit(state, request, facts, sequence, now);
      const prepared = require("./permit-delivery").preparePermitSigning({ permit, issuedAtMs: now, nowMs: now });
      const record = { attempt_id: original.attempt_id, prepare_version: 1, sequence, prepared_at_ms: now,
        request_digest: original.request_digest, facts, fingerprint: signingInput.batchFingerprint, permit,
        signing_bytes: prepared.bytes, signing_digest: digest(Buffer.from(prepared.bytes, "base64")), status: "sign-prepared", call: null };
      // Reserve future gate/unknown growth now: reaching capacity after prepare
      // cannot become permission to drop reservation metadata.
      const reserved = Object.fromEntries(Object.entries({ ...gate.preparations, [original.attempt_id]: record }).map(([id, item]) =>
        [id, { ...item, status: "sign-outcome-unknown", call: { owner: "0".repeat(32), service_epoch: state.service_epoch,
          input_digest: item.signing_digest, anchor_sequence: Number.MAX_SAFE_INTEGER, at_ms: Number.MAX_SAFE_INTEGER } }]));
      signingCapacity({ ...gate, sequence, preparations: reserved }, "ERR_WITNESS_SIGNING_CAPACITY");
      gate.sequence = sequence; gate.preparations[original.attempt_id] = record;
      state.lease_seq = state.permit_seq = state.fencing = sequence;
      return { attemptId: original.attempt_id, signingDigest: record.signing_digest };
    }, (result) => {
      const ticket = Object.freeze(Object.create(null));
      this.#prepareTickets.set(ticket, { attemptId: result.attemptId, signingDigest: result.signingDigest });
      return { ...result, ticket, executionAuthorized: false, resumeAllowed: false };
    });
  }

  claimAuthoritySigningCall(peer, input, ticket) {
    this.#signingPreflight();
    const owned = this.#prepareTickets.get(ticket);
    if (!owned) fail("ERR_WITNESS_SIGNING_CAPABILITY");
    // Burn before validation/transaction: even a precommit failure cannot use
    // this process's ticket again. Restart never reconstructs a prepare ticket.
    this.#prepareTickets.delete(ticket);
    return this.#signingTransaction(peer, input, "sign.call-gate", (state, now, request, original) => {
      const record = own(state.witness_authority.signing_gate.preparations, original.attempt_id);
      if (owned.attemptId !== original.attempt_id || !record || record.status !== "sign-prepared" ||
          record.permit.serviceEpoch !== state.service_epoch || record.permit.fencing !== state.fencing ||
          owned.signingDigest !== record.signing_digest) return { denied: "ERR_WITNESS_SIGNING_UNKNOWN" };
      const facts = signingFacts(this.#authority.prepareSigning(request, freezeData(structuredClone(state))));
      if (!witness.canonicalBytes(facts).equals(witness.canonicalBytes(record.facts))) return { denied: "ERR_WITNESS_SIGNING_NOT_AUTHORIZED" };
      if (now >= record.permit.deadline) return { denied: "ERR_WITNESS_SIGNING_EXPIRED" };
      record.status = "sign-call-possible";
      record.call = { owner: this.#signingOwner, service_epoch: state.service_epoch, input_digest: record.signing_digest,
        anchor_sequence: state.anchor_sequence + 1, at_ms: now };
      return { attemptId: original.attempt_id, signingDigest: record.signing_digest };
    }, (result) => {
      // #transaction includes coordination COMMIT AND finally/close. Reaching
      // here proves only those existing local barriers, not an R5 B certificate.
      const capability = Object.freeze(Object.create(null));
      this.#callCapabilities.set(capability, { attemptId: result.attemptId, signingDigest: result.signingDigest });
      return { ...result, capability, executionAuthorized: false, resumeAllowed: false };
    });
  }

  abandonAuthoritySigningCall(peer, input, capability) {
    this.#signingPreflight();
    const owned = this.#callCapabilities.get(capability);
    if (!owned) fail("ERR_WITNESS_SIGNING_CAPABILITY");
    this.#callCapabilities.delete(capability); // One use, including failed use.
    return this.#signingTransaction(peer, input, "sign.abandon", (state, now, request, original) => {
      const record = own(state.witness_authority.signing_gate.preparations, original.attempt_id);
      if (owned.attemptId !== original.attempt_id || !record || record.status !== "sign-call-possible" ||
          record.call.owner !== this.#signingOwner || record.signing_digest !== owned.signingDigest) {
        return { denied: "ERR_WITNESS_SIGNING_UNKNOWN" };
      }
      record.status = "sign-outcome-unknown";
      return { attemptId: original.attempt_id, status: record.status, executionAuthorized: false, resumeAllowed: false };
    });
  }

  #signingPreflight() {
    // Private fields only: no caller data, clock, provider or external I/O before
    // consuming a ticket/capability. A rejected reentry never burns authority.
    if (this.#admissionActive) fail("ERR_WITNESS_ADMISSION_ACTIVE");
    if (this.#historyActive) fail("ERR_WITNESS_HISTORY_ACTIVE");
    if (this.#closed) fail("ERR_STORE_CLOSED");
    if (this.#signingBlocked) fail("ERR_WITNESS_SIGNING_UNKNOWN");
    if (this.#poisoned) fail("ERR_COMMIT_OUTCOME_UNKNOWN");
    if (!this.#authority?.signingGateMode) fail("ERR_WITNESS_AUTHORITY_DISABLED");
  }

  #signingTransaction(peer, input, operation, change, after = (result) => result) {
    this.#signingPreflight();
    this.#admissionActive = true;
    let conflictCompleted = false;
    try {
      const request = admissionRequest(input);
      const result = this.#transaction((state, now) => {
        if (state.schema_version !== SIGNING_GATE_SCHEMA_VERSION) fail("ERR_WITNESS_AUTHORITY_DISABLED");
        const snapshot = freezeData(structuredClone(state));
        const authorize = () => admissionGrant(this.#authority.authorize(peer, operation, request, snapshot), request);
        const authorization = authorize();
        if (!witness.canonicalBytes(authorization).equals(witness.canonicalBytes(authorize()))) fail("ERR_WITNESS_SIGNING_NOT_AUTHORIZED");
        const key = admissionKeys(state, authorization.principal, request).association;
        const original = own(state.witness_authority.request_admission.attempts,
          own(state.witness_authority.request_admission.associations, key));
        if (!original || original.request_bytes !== witness.canonicalBytes(request).toString("utf8") ||
            !witness.canonicalBytes(original.grant).equals(witness.canonicalBytes(authorization.grant))) fail("ERR_WITNESS_SIGNING_NOT_AUTHORIZED");
        if (now < state.last_clock_ms) poisonAuthorityState(state);
        if (state.witness_authority.clock_poisoned) return { denied: "ERR_WITNESS_CLOCK" };
        let changed, conflict;
        try { changed = change(state, now, request, original, authorization); }
        catch (error) {
          if (!(error instanceof SigningReservationConflict)) throw error;
          conflict = error;
        }
        // Business conflicts still commit authorized clock safety increments.
        // Recheck current host authorization after the trusted local provider.
        if (!witness.canonicalBytes(authorization).equals(witness.canonicalBytes(authorize()))) fail("ERR_WITNESS_SIGNING_NOT_AUTHORIZED");
        const observed = this.#clock();
        if (!Number.isSafeInteger(observed) || observed < 0) {
          // An unusable review sample cannot erase the valid first observation.
          state.last_clock_ms = Math.max(state.last_clock_ms, now);
          poisonAuthorityState(state); return { denied: "ERR_CLOCK_INVALID" };
        }
        const previousClock = state.last_clock_ms;
        state.last_clock_ms = Math.max(previousClock, now, observed);
        if (observed < now || observed < previousClock) {
          poisonAuthorityState(state); return { denied: "ERR_WITNESS_CLOCK" };
        }
        const prepared = own(state.witness_authority.signing_gate.preparations, original.attempt_id);
        if (operation !== "sign.abandon" && prepared && observed >= prepared.permit.deadline) {
          return { denied: "ERR_WITNESS_SIGNING_EXPIRED" };
        }
        if (conflict) return SIGNING_CONFLICT_RESULT; // commit safety state, no new authority
        return changed;
      }, true);
      if (result === SIGNING_CONFLICT_RESULT) {
        // #transaction returned through DB/audit/anchor AND lock commit/close.
        // Only this completed path may refuse without burning existing tickets.
        conflictCompleted = true;
        fail("ERR_WITNESS_SIGNING_CONFLICT");
      }
      if (result.denied) fail(result.denied);
      return after(result); // only after business transaction AND coordination release
    } catch (error) {
      if (conflictCompleted) throw error;
      // Failure/uncertainty before complete local publication is handle-local
      // unknown. No cross-handle persistent poison is implied by this latch.
      // No automatic retry, including failures before COMMIT. Persistent
      // reservations remain, and fresh handles cannot recover opaque tickets.
      this.#signingBlocked = true;
      this.#prepareTickets = new WeakMap(); this.#callCapabilities = new WeakMap();
      throw error;
    } finally { this.#admissionActive = false; }
  }

  #witnessTarget(state, targetId, checkpoint) {
    requireMapKey(targetId);
    const target = own(state.witness_authority.targets, targetId);
    if (!target) fail("ERR_WITNESS_TARGET_NOT_REGISTERED");
    witness.assertCheckpointMatches(target.current, checkpoint);
    if (target.current.state.clock_poisoned) fail("ERR_WITNESS_CLOCK");
    return target;
  }

  registerWitnessTarget(peer, input) {
    return this.#authorityTransaction(peer, "register", input, ["targetId", "requestId", "checkpoint", "pin"], (state, now, request) => {
      const { targetId, requestId } = request;
      requireMapKey(targetId);
      requireMapKey(requestId);
      const pin = { ...dataRequest(request.pin, ["decision_id", "instance_id", "fingerprint", "public_key_pem",
        "source_digest", "deployment_digest", "run_id", "generation", "valid_from", "valid_until"]), registered_at_ms: now };
      if (pin.decision_id !== state.decision_id || pin.instance_id !== targetId) fail("ERR_BINDING_MISMATCH");
      const authority = state.witness_authority;
      const existing = own(authority.targets, targetId);
      const requestDigest = digest(witness.canonicalBytes(request));
      const receipt = existing && own(existing.registrations, requestId);
      if (receipt) {
        if (receipt.request_digest !== requestDigest) fail("ERR_IDEMPOTENCY_MISMATCH");
        return receipt.result;
      }
      let current;
      if (existing) current = this.#witnessTarget(state, targetId, request.checkpoint).current;
      else {
        if (request.checkpoint !== null) fail("ERR_WITNESS_CHECKPOINT_CONFLICT");
        current = witness.createCheckpoint({ authority_id: authority.authority_id, target_id: targetId,
          store_generation: crypto.randomBytes(32).toString("hex"), revision: 1 }, {
          schema_version: 3, pins: [], revoked_fingerprints: [], applied_revocation_sequence: 0,
          highest_seen_revocation_sequence: 0, highest_accepted_permit_sequence: 0,
          last_observed_clock_ms: now, clock_poisoned: false,
        });
      }
      // Validate even reconnect metadata, but never rewrite the original pin.
      witness.normalizeTargetState({ ...current.state, pins: [pin] });
      if (crypto.createPublicKey(pin.public_key_pem).asymmetricKeyType !== "ed25519") fail("ERR_INVALID_INPUT");
      const oldPin = current.state.pins.find((entry) => entry.fingerprint === pin.fingerprint);
      if (oldPin && !matches(oldPin, pin, ["decision_id", "instance_id", "fingerprint"])) fail("ERR_BINDING_MISMATCH");
      if (!oldPin) {
        const observation = this.#authority.observeTarget(targetId, request, freezeData(structuredClone(current)));
        if (!observation || observation.targetHasProcess !== false || observation.targetHasPriorRun !== false) {
          fail("ERR_WITNESS_TARGET_NOT_FRESH");
        }
        current = witness.deriveTransition(current, { operation: "register_pin", checkpoint: current.checkpoint }, { pin });
      }
      const target = existing || { registrations: {} };
      target.current = current;
      const result = { registered: !oldPin, reused: Boolean(oldPin), checkpoint: current.checkpoint };
      target.registrations[requestId] = { request_digest: requestDigest, result: structuredClone(result) };
      authority.targets[targetId] = target;
      return result;
    });
  }

  issueWitnessPermit(peer, input) {
    return this.#authorityTransaction(peer, "issue", input, ["targetId", "checkpoint", "lease", "permit", "batchFingerprint"], (state, now, request) => {
      const target = this.#witnessTarget(state, request.targetId, request.checkpoint);
      const lease = dataRequest(request.lease, ["owner", "sessionId", "hostId", "workerId", "runId", "generation",
        "desktopKey", "ownedAppId", "idempotencyKey", "ttlMs"]);
      for (const key of Object.keys(lease).filter((name) => name !== "ttlMs")) requireText(lease[key]);
      requireMapKey(lease.idempotencyKey);
      const leaseTtl = requirePositiveMs(lease.ttlMs);
      if (!Number.isSafeInteger(now + leaseTtl)) fail("ERR_INVALID_INPUT");
      const permit = dataRequest(request.permit, ["idempotencyKey", "operation", "targetDigest", "paramsDigest", "ttlMs"]);
      requireMapKey(permit.idempotencyKey);
      const validated = validateReservationInput(permit);
      if (!Number.isSafeInteger(now + validated.ttlMs)) fail("ERR_INVALID_INPUT");
      const fingerprint = request.batchFingerprint;
      if (!target.current.state.pins.some((pin) => pin.fingerprint === fingerprint) ||
          target.current.state.revoked_fingerprints.includes(fingerprint)) fail("ERR_WITNESS_SIGNER");
      const requestDigest = digest(witness.canonicalBytes({ targetId: request.targetId, lease, permit, fingerprint }));
      const bindings = state.witness_authority.issuance_bindings;
      const oldId = own(state.idempotency, permit.idempotencyKey);
      if (oldId) {
        const binding = own(bindings, oldId);
        if (!binding || binding.target_id !== request.targetId ||
            binding.target_generation !== target.current.checkpoint.store_generation ||
            binding.request_digest !== requestDigest) fail("ERR_IDEMPOTENCY_MISMATCH");
      }
      // Signing can observe rollback and then return malformed data or throw.
      // Keep all candidate lease/permit/signature writes off the committed state
      // until the post-sign clock has been checked, including those error paths.
      const candidate = structuredClone(state);
      let issuance;
      let signingError;
      try {
        issuance = this.#issueInState(candidate, now, lease, permit, fingerprint,
          (reserved) => this.#authority.signPermit(fingerprint, freezeData(reserved), now), leaseTtl, validated);
      } catch (error) { signingError = error; }
      const signedAt = this.#clock();
      if (Number.isSafeInteger(signedAt) && signedAt < now) {
        poisonAuthorityState(state);
        return { denied: "ERR_WITNESS_CLOCK" };
      }
      if (signingError) throw signingError;
      if (!Number.isSafeInteger(signedAt) || signedAt < 0 || signedAt >= issuance.signedPermit.deadline ||
          issuance.signedPermit.issuedAt > signedAt) fail("ERR_CLOCK_INVALID");
      candidate.last_clock_ms = signedAt;
      const id = issuance.signedPermit.message.permit_id;
      const candidateBindings = candidate.witness_authority.issuance_bindings;
      if (!own(candidateBindings, id)) candidateBindings[id] = {
        authority_id: state.witness_authority.authority_id, issuer_store_id: state.store_id,
        target_id: request.targetId, target_generation: target.current.checkpoint.store_generation,
        permit_id: id, fingerprint, message_bytes: issuance.signedPermit.bytes,
        signature: issuance.signedPermit.signature, request_digest: requestDigest, status: "issued",
      };
      Object.assign(state, candidate);
      return issuance;
    });
  }

  consumeWithCheckpoint(peer, input) {
    return this.#authorityTransaction(peer, "consume", input, ["targetId", "checkpoint", "message", "signature"], (state, now, request) => {
      const target = this.#witnessTarget(state, request.targetId, request.checkpoint);
      const current = target.current;
      const delivery = require("./permit-delivery");
      const message = dataRequest(request.message, [...delivery.BINDING_FIELD_MAP.map(([, name]) => name),
        "issued_at_ms", "deadline_ms", "permit_id"]);
      const permit = own(state.permits, message.permit_id);
      const binding = own(state.witness_authority.issuance_bindings, message.permit_id);
      if (!permit || !binding || binding.target_id !== request.targetId ||
          binding.target_generation !== current.checkpoint.store_generation) fail("ERR_WITNESS_ISSUANCE_MISMATCH");
      if (binding.status !== "issued") fail("ERR_PERMIT_NOT_CONSUMABLE");
      // The next fresh signed list is supplied by a trusted host provider, never
      // by client facts. Authentication/freshness of that provider remains a host
      // integration requirement; this development core verifies its signature too.
      const list = dataRequest(this.#authority.pullRevocation(request.targetId, freezeData(structuredClone(current)), now),
        ["revocation_sequence", "prev_revocation_sequence", "revoked_fingerprints", "issued_at_ms", "batch_public_key_fingerprint", "signature"]);
      const signer = current.state.pins.find((pin) => pin.fingerprint === list.batch_public_key_fingerprint);
      if (!signer || !Number.isSafeInteger(list.issued_at_ms) || list.issued_at_ms < 0 || list.issued_at_ms > now) fail("ERR_WITNESS_SIGNER");
      const revocation = { appliedRevocationSequence: current.state.applied_revocation_sequence,
        highestSeenRevocationSequence: current.state.highest_seen_revocation_sequence,
        revokedFingerprints: new Set(current.state.revoked_fingerprints) };
      delivery.applyRevocationList({ state: revocation, list, publicKeyPem: signer.public_key_pem,
        pinnedFingerprints: new Set(current.state.pins.map((pin) => pin.fingerprint)), nowMs: now });
      const facts = { sequence: revocation.appliedRevocationSequence,
        revoked_fingerprints: [...revocation.revokedFingerprints].sort() };
      // A trusted provider can still take time. Never use its pre-pull time to
      // accept an already expired lease/permit, or miss a mid-call clock rollback.
      const checkedAt = this.#clock();
      if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) fail("ERR_CLOCK_INVALID");
      if (checkedAt < now) {
        state.witness_authority.clock_poisoned = true;
        const revoked = witness.deriveTransition(current,
          { operation: "apply_revocation", checkpoint: current.checkpoint }, facts);
        target.current = witness.createCheckpoint({ ...checkpointBinding(revoked.checkpoint),
          revision: revoked.checkpoint.revision + 1 }, { ...revoked.state, clock_poisoned: true });
        return { denied: "ERR_WITNESS_CLOCK" };
      }
      now = checkedAt;
      state.last_clock_ms = Math.max(now, state.last_clock_ms);
      try {
        if (delivery.canonicalBytes(message).toString("base64") !== binding.message_bytes || request.signature !== binding.signature) {
          fail("ERR_WITNESS_ISSUANCE_MISMATCH");
        }
        const pin = current.state.pins.find((entry) => entry.fingerprint === binding.fingerprint);
        if (!pin) fail("ERR_WITNESS_SIGNER");
        delivery.verifyPermitSignature({ message, signature: request.signature, publicKeyPem: pin.public_key_pem,
          expectedFingerprint: binding.fingerprint, revokedFingerprints: revocation.revokedFingerprints,
          expectedDeadlineMs: permit.deadline, nowMs: now });
        const next = witness.deriveTransition(current, { operation: "accept_permit", checkpoint: current.checkpoint },
          { now_ms: now, permit_sequence: permit.sequence, fingerprint: binding.fingerprint, revocation: facts });
        const fields = { permitId: message.permit_id,
          ...Object.fromEntries(delivery.BINDING_FIELD_MAP.map(([name, signed]) => [name, message[signed]])) };
        const consumed = this.#consumeInState(state, now, fields);
        if (consumed.status !== "consumed") fail("ERR_PERMIT_NOT_CONSUMABLE");
        target.current = next;
        binding.status = "consumed";
        binding.consumption_record = { permit_id: permit.permitId, at_ms: now, checkpoint: next.checkpoint };
        return { status: "consumed", permitId: permit.permitId, checkpoint: next.checkpoint };
      } catch (error) {
        if (!(error instanceof ProtectedStoreError || error instanceof witness.PermitWitnessContractError ||
            error instanceof require("./errors").CoordinationError)) throw error;
        if (permit.status === "expired") binding.status = "invalidated";
        target.current = witness.deriveTransition(current, { operation: "apply_revocation", checkpoint: current.checkpoint }, facts);
        if (now !== target.current.state.last_observed_clock_ms) {
          target.current = witness.deriveTransition(target.current,
            { operation: "observe_clock", checkpoint: target.current.checkpoint }, { now_ms: now });
        }
        return { denied: error.key || error.code };
      }
    });
  }

  acquire(fields) {
    for (const key of ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "idempotencyKey"]) requireText(fields[key]);
    const ttlMs = requirePositiveMs(fields.ttlMs);
    return this.#transaction((state, now) => this.#acquireInState(state, now, fields, ttlMs));
  }

  #acquireInState(state, now, fields, ttlMs) {
      const old = state.lease_idempotency[fields.idempotencyKey];
      if (old) {
        const names = ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "ttlMs"];
        if (!matches(old, { ...fields, ttlMs }, names)) fail("ERR_IDEMPOTENCY_MISMATCH");
        return structuredClone(state.lease && state.lease.leaseId === old.leaseId ? state.lease : old);
      }
      if (state.desktop.status !== "free") fail("ERR_DESKTOP_NOT_FREE");
      state.fencing += 1;
      state.lease_seq += 1;
      const lease = {
        leaseId: `${PROTECTED_LEASE_PREFIX}${state.lease_seq}`, status: "active",
        owner: fields.owner, sessionId: fields.sessionId, hostId: fields.hostId,
        workerId: fields.workerId, runId: fields.runId, generation: fields.generation,
        desktopKey: fields.desktopKey, ownedAppId: fields.ownedAppId,
        idempotencyKey: fields.idempotencyKey,
        serviceEpoch: state.service_epoch, fencing: state.fencing, expiresAt: now + ttlMs, ttlMs,
      };
      state.lease = lease;
      state.lease_idempotency[fields.idempotencyKey] = structuredClone(lease);
      state.desktop = { status: "held", key: fields.desktopKey };
      return structuredClone(lease);
  }

  acquireAndReserveBoundToBatch(leaseFields, permitFields, batchFingerprint, finalize) {
    if (!leaseFields || typeof leaseFields !== "object" || Array.isArray(leaseFields)) fail("ERR_INVALID_INPUT");
    for (const key of ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "idempotencyKey"]) requireText(leaseFields[key]);
    const leaseTtl = requirePositiveMs(leaseFields.ttlMs);
    const validated = validateReservationInput(permitFields);
    if (typeof batchFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(batchFingerprint)) fail("ERR_INVALID_INPUT");
    if (typeof finalize !== "function") fail("ERR_INVALID_INPUT");
    return this.#transaction((state, now) =>
      this.#issueInState(state, now, leaseFields, permitFields, batchFingerprint, finalize, leaseTtl, validated));
  }

  #issueInState(state, now, leaseFields, permitFields, batchFingerprint, finalize, leaseTtl, validated) {
      const lease = this.#acquireInState(state, now, leaseFields, leaseTtl);
      const fields = { ...permitFields, leaseId: lease.leaseId, sessionId: lease.sessionId,
        hostId: lease.hostId, workerId: lease.workerId, runId: lease.runId, generation: lease.generation,
        desktopKey: lease.desktopKey, ownedAppId: lease.ownedAppId, serviceEpoch: lease.serviceEpoch,
        fencing: lease.fencing };
      // A historical idempotency result is not itself an active authority.
      activeLease(state, fields, now);
      const previouslyReserved = Object.prototype.hasOwnProperty.call(state.idempotency, fields.idempotencyKey);
      const reserved = this.#reserveInState(state, now, fields, batchFingerprint, validated);
      if (reserved.status !== "reserved" || reserved.deadline <= now) fail("ERR_LEASE_NOT_CURRENT");
      const storedPermit = state.permits[reserved.permitId];
      if (previouslyReserved) {
        // An older reservation without the original signed bytes cannot be
        // safely reissued: a fresh timestamp would create a second message.
        if (!storedPermit.signedIssuance) fail("ERR_IDEMPOTENCY_MISMATCH");
        return structuredClone(storedPermit.signedIssuance);
      }
      // The trusted signer executes before commit. An exception rolls back the
      // lease and permit together; no key material is stored in the database.
      const candidate = finalize(structuredClone(reserved));
      if (candidate && typeof candidate.then === "function") fail("ERR_INVALID_INPUT");
      let result;
      try { result = structuredClone(candidate); } catch { fail("ERR_INVALID_INPUT"); }
      // Persist only the known public wire fields. Validate the actual key,
      // signature and every binding before committing the issuance record.
      const delivery = require("./permit-delivery");
      if (!result || result.fingerprint !== batchFingerprint ||
          typeof result.publicKeyPem !== "string" ||
          !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(result.publicKeyPem) ||
          !result.signedPermit || typeof result.signedPermit !== "object") fail("ERR_INVALID_INPUT");
      const signed = result.signedPermit;
      const message = signed.message;
      let canonicalPublicKey;
      try { canonicalPublicKey = crypto.createPublicKey(result.publicKeyPem).export({ type: "spki", format: "pem" }); }
      catch { fail("ERR_INVALID_INPUT"); }
      if (result.publicKeyPem !== canonicalPublicKey || typeof signed.signature !== "string" ||
          Buffer.from(signed.signature, "base64").length !== 64 ||
          Buffer.from(signed.signature, "base64").toString("base64") !== signed.signature ||
          !message || typeof message !== "object" || Array.isArray(message) ||
          !Number.isSafeInteger(message.issued_at_ms) || message.issued_at_ms < now ||
          message.issued_at_ms >= reserved.deadline) fail("ERR_INVALID_INPUT");
      delivery.verifyPermitSignature({ message, signature: signed.signature, publicKeyPem: result.publicKeyPem,
        expectedFingerprint: batchFingerprint, revokedFingerprints: new Set(),
        expectedDeadlineMs: reserved.deadline, nowMs: message.issued_at_ms });
      if (message.permit_id !== reserved.permitId ||
          delivery.BINDING_FIELD_MAP.some(([field, name]) => message[name] !== reserved[field]) ||
          Object.keys(message).length !== delivery.BINDING_FIELD_MAP.length + 3 ||
          signed.sequence !== reserved.sequence || signed.deadline !== reserved.deadline ||
          signed.issuedAt !== message.issued_at_ms || signed.nowMs !== message.issued_at_ms ||
          signed.bytes !== delivery.canonicalBytes(message).toString("base64")) fail("ERR_INVALID_INPUT");
      const issuance = { fingerprint: batchFingerprint, publicKeyPem: result.publicKeyPem,
        signedPermit: { message: structuredClone(message), signature: signed.signature,
          sequence: signed.sequence, deadline: signed.deadline, issuedAt: signed.issuedAt,
          bytes: signed.bytes, nowMs: signed.nowMs } };
      storedPermit.signedIssuance = issuance;
      return structuredClone(issuance);
  }

  renew(fields) {
    const ttlMs = requirePositiveMs(fields.ttlMs);
    return this.#transaction((state, now) => {
      const lease = activeLease(state, fields, now);
      lease.expiresAt = now + ttlMs;
      state.lease_idempotency[lease.idempotencyKey] = structuredClone(lease);
      return structuredClone(lease);
    });
  }

  reserve(fields) {
    return this.#reserve(fields, null);
  }

  reserveBoundToBatch(fields, batchFingerprint) {
    if (typeof batchFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(batchFingerprint)) {
      fail("ERR_INVALID_INPUT");
    }
    return this.#reserve(fields, batchFingerprint);
  }

  #reserve(fields, batchFingerprint) {
    const validated = validateReservationInput(fields);
    return this.#transaction((state, now) => this.#reserveInState(state, now, fields, batchFingerprint, validated));
  }

  #reserveInState(state, now, fields, batchFingerprint, { targetDigest, paramsDigest, ttlMs }) {
      const binding = {
        leaseId: fields.leaseId, sessionId: fields.sessionId, hostId: fields.hostId,
        workerId: fields.workerId, runId: fields.runId, generation: fields.generation,
        desktopKey: fields.desktopKey, ownedAppId: fields.ownedAppId,
        serviceEpoch: fields.serviceEpoch,
        fencing: fields.fencing, operation: fields.operation, targetDigest, paramsDigest,
      };
      const oldId = state.idempotency[fields.idempotencyKey];
      if (oldId) {
        const old = state.permits[oldId];
        if (!old || !matches(old, binding, Object.keys(binding))) fail("ERR_IDEMPOTENCY_MISMATCH");
        if (batchFingerprint !== null && old.batchFingerprint !== batchFingerprint) fail("ERR_IDEMPOTENCY_MISMATCH");
        if (batchFingerprint !== null && old.requestedTtlMs !== ttlMs) fail("ERR_IDEMPOTENCY_MISMATCH");
        return structuredClone(old);
      }
      const lease = activeLease(state, fields, now);
      // Action-level deduplication. The idempotency key above only covers a
      // retry of the *same* attempt; a fresh key for the same action would
      // otherwise mint a second permit for work that is already running or has
      // already run, and the same operation would be dispatched twice. The
      // guard therefore looks at the action fingerprint, not at the key.
      const fingerprint = actionFingerprint(binding);
      const sameAction = Object.values(state.permits)
        .filter((permit) => permit.desktopKey === fields.desktopKey)
        .filter((permit) => actionFingerprint(permit) === fingerprint);
      // A permit that is already in flight blocks a second one outright.
      if (sameAction.some(isLivePermit)) fail("ERR_ACTION_IN_FLIGHT");
      // An action that already ran must not be dispatched again, not even
      // after it completed successfully.
      if (sameAction.some(isDispatchedPermit)) fail("ERR_ACTION_ALREADY_DISPATCHED");
      // A different action on the same desktop still needs the desktop to be
      // free of work in flight.
      if (Object.values(state.permits).some((permit) => permit.status === "consumed" && permit.desktopKey === fields.desktopKey)) fail("ERR_ACTION_IN_FLIGHT");
      if (binding.serviceEpoch !== state.service_epoch || binding.fencing !== state.fencing) fail("ERR_BINDING_MISMATCH");
      state.permit_seq += 1;
      const permit = {
        ...binding, permitId: `P-PERMIT-${state.permit_seq}`, status: "reserved",
        idempotencyKey: fields.idempotencyKey, sequence: state.permit_seq,
        deadline: Math.min(now + ttlMs, lease.expiresAt),
      };
      if (batchFingerprint !== null) {
        permit.batchFingerprint = batchFingerprint;
        permit.requestedTtlMs = ttlMs;
      }
      state.permits[permit.permitId] = permit;
      state.idempotency[fields.idempotencyKey] = permit.permitId;
      return structuredClone(permit);
  }

  consume(fields) {
    const result = this.#transaction((state, now) => this.#consumeInState(state, now, fields));
    if (result.status === "expired") fail("ERR_PERMIT_NOT_CONSUMABLE");
    return result;
  }

  #consumeInState(state, now, fields) {
      const permit = state.permits[fields.permitId];
      if (!permit) fail("ERR_PERMIT_NOT_FOUND");
      if (!matches(permit, fields, CONSUME_BINDING_FIELDS)) fail("ERR_BINDING_MISMATCH");
      if (permit.serviceEpoch !== state.service_epoch || ["unknown", "revoked", "expired"].includes(permit.status)) {
        fail("ERR_PERMIT_NOT_CONSUMABLE");
      }
      if (["consumed", "finished", "failed"].includes(permit.status)) {
        return { status: "already-consumed", permitId: permit.permitId };
      }
      if (permit.status !== "reserved") fail("ERR_PERMIT_NOT_CONSUMABLE");
      // A permit that is consumed is the permission to execute the action
      // once. Two permits for the same action must never both reach that
      // state, and an action that has already run must not be run again.
      // The guard therefore covers the whole dispatched set of the action,
      // not just the permits that happen to be consumed at this instant.
      const fingerprint = actionFingerprint(permit);
      const sameAction = Object.values(state.permits)
        .filter((other) => other.desktopKey === permit.desktopKey)
        .filter((other) => other.permitId !== permit.permitId)
        .filter((other) => actionFingerprint(other) === fingerprint);
      if (sameAction.some(isLivePermit)) fail("ERR_ACTION_IN_FLIGHT");
      if (sameAction.some(isDispatchedPermit)) fail("ERR_ACTION_ALREADY_DISPATCHED");
      if (Object.values(state.permits).some((other) => other.status === "consumed" && other.desktopKey === permit.desktopKey)) fail("ERR_ACTION_IN_FLIGHT");
      if (now >= permit.deadline) {
        permit.status = "expired";
        state.tombstones[permit.permitId] = { reason: "deadline", at: now };
        return { status: "expired" };
      }
      activeLease(state, fields, now);
      permit.status = "consumed";
      permit.consumedAt = now;
      return structuredClone(permit);
  }

  finish(fields) {
    if (!["finished", "failed", "unknown"].includes(fields.outcome)) fail("ERR_INVALID_INPUT");
    return this.#transaction((state, now) => {
      const permit = state.permits[fields.permitId];
      if (!permit || permit.status !== "consumed" ||
          !matches(permit, fields, CONSUME_BINDING_FIELDS)) fail("ERR_PERMIT_NOT_CONSUMED");
      permit.status = fields.outcome;
      permit.finishedAt = now;
      if (fields.outcome !== "finished") state.desktop.status = "draining";
      return structuredClone(permit);
    });
  }

  #revoke(state, status, now) {
    if (!state.lease || state.lease.status !== "active") fail("ERR_LEASE_NOT_CURRENT");
    state.lease.status = status;
    state.lease.endedAt = now;
    state.lease_idempotency[state.lease.idempotencyKey] = structuredClone(state.lease);
    state.fencing += 1;
    for (const permit of Object.values(state.permits)) {
      if (permit.status === "reserved") {
        permit.status = "revoked";
        state.tombstones[permit.permitId] = { reason: status, at: now };
      }
    }
    state.desktop.status = "draining";
    return structuredClone(state.lease);
  }

  revoke(fields) {
    return this.#transaction((state, now) => {
      activeLease(state, fields, now);
      return this.#revoke(state, "revoked", now);
    });
  }

  release(fields) {
    return this.#transaction((state, now) => {
      activeLease(state, fields, now);
      return this.#revoke(state, "released", now);
    });
  }

  expire() {
    return this.#transaction((state, now) => {
      if (!state.lease || state.lease.status !== "active" || state.lease.expiresAt > now) fail("ERR_LEASE_NOT_EXPIRED");
      return this.#revoke(state, "expired", now);
    });
  }

  restartService() {
    return this.#transaction((state, now) => {
      if (state.lease && state.lease.status === "active") this.#revoke(state, "revoked", now);
      for (const permit of Object.values(state.permits)) {
        if (permit.status === "consumed") permit.status = "unknown";
      }
      state.service_epoch += 1;
      return state.service_epoch;
    });
  }

  recover(proof) {
    return this.#transaction((state, now) => {
      if (state.desktop.status !== "draining") fail("ERR_DESKTOP_NOT_DRAINING");
      if (Object.values(state.permits).some((permit) => permit.status === "consumed")) fail("ERR_ACTION_IN_FLIGHT");
      if (!this.#verifyRecovery || !this.#verifyRecovery(proof, structuredClone(state))) fail("ERR_RECOVERY_NOT_VERIFIED");
      if (state.lease && state.lease.status === "active") this.#revoke(state, "revoked", now);
      state.desktop = { status: "free", key: null };
      return { status: "free" };
    });
  }

  close() {
    if (this.#admissionActive) fail("ERR_WITNESS_ADMISSION_ACTIVE");
    if (this.#historyActive) fail("ERR_WITNESS_HISTORY_ACTIVE");
    this.#prepareTickets = new WeakMap(); this.#callCapabilities = new WeakMap();
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }

  // Managed recovery for the crash window between the anchor write and the
  // database commit. It is deliberately narrow: the anchor must be exactly
  // one step ahead of the database and its prev_body_digest must match the
  // committed database body. Anything else is treated as a suspected attack
  // and is refused, because silently recovering a rolled-back database would
  // erase the evidence of the rollback.
  //
  // The caller must supply an explicit audit record. The recovery is not
  // reachable from the normal start path; it is an administrator action.
  static recoverFromAnchorCrash(filePath, options = {}) {
    options = nativePermissionOptions(options);
    return this.#withExistingLock(filePath, options, () => this.#recoverFromAnchorCrashUnlocked(filePath, options));
  }

  static #recoverFromAnchorCrashUnlocked(filePath, options = {}) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    const audit = options.audit;
    if (!audit || typeof audit !== "object" || typeof audit.by !== "string" || !audit.by ||
        typeof audit.reason !== "string" || !audit.reason) fail("ERR_RECOVERY_AUDIT_REQUIRED");
    const anchorDir = anchor.anchorDirFor(options.anchorDir);
    anchor.assertSeparateDomains(options.anchorDir, filePath);
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    const journalFile = anchor.journalFileFor(anchorDir);
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = readProtectedRow(db, configuredSchema(authorityOptions(options)), false);
      if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
      let state;
      try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
      assertState(state);
      if (isAuthoritySchema(state.schema_version)) fail("ERR_WITNESS_RECOVERY_UNSUPPORTED");
      if (state.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      // The permission mode of the anchor domain is a property of the
      // deployment. The caller may state it explicitly, and otherwise the
      // mode that was recorded with the state is used, so that a recovery
      // run by a different process applies the same contract. A caller may
      // not weaken the recorded contract for a single recovery run.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(state.anchor_mode, options.anchorMode),
        state.service_identity, options);
      const journal = anchor.readJournal(journalFile);
      if (journal.committed === 0) fail("ERR_ANCHOR_MISSING");
      // The only recoverable shape is a database that is exactly one sequence
      // ahead of the committed high-water mark, with a dangling intent at
      // that sequence whose digest equals the committed database body. A
      // rolled-back database is behind the high-water mark and can never
      // satisfy this condition, so the recovery entry point cannot launder a
      // rollback.
      if (state.anchor_sequence !== journal.committed + 1) fail("ERR_RECOVERY_NOT_APPLICABLE");
      const intent = journal.intentsBySeq.get(state.anchor_sequence);
      if (!intent || intent.body_digest !== digest(row.body)) fail("ERR_RECOVERY_NOT_APPLICABLE");
      // Record the commit that the crash skipped. The high-water mark moves
      // forward to the database, never backward.
      anchor.appendEntry(journalFile, {
        type: "commit", sequence: state.anchor_sequence, body_digest: digest(row.body), store_id: intent.store_id,
        attempt: intent.attempt,
      });
      // The recovery is an administrator action and must leave a durable trace.
      // The record is written next to the anchor, outside the database
      // rollback domain, so restoring an old database cannot erase it.
      const auditRecord = {
        schema_version: 1,
        at: new Date().toISOString(),
        by: audit.by,
        reason: audit.reason,
        database: path.resolve(filePath),
        recovered_sequence: state.anchor_sequence,
        anchor_sequence_before: journal.committed,
        body_digest: digest(row.body),
      };
      fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"),
        JSON.stringify(auditRecord) + "\n", { mode: 0o600 });
      db.exec("COMMIT");
      return { recovered: true, sequence: state.anchor_sequence, audit: auditRecord };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may not have started */ }
      // A refused recovery attempt is evidence too: it shows that somebody
      // tried to move the high-water mark. It is recorded next to the anchor
      // so it survives a database rollback.
      try {
        fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"), JSON.stringify({
          schema_version: 1,
          at: new Date().toISOString(),
          by: audit.by,
          reason: audit.reason,
          database: path.resolve(filePath),
          refused: true,
          code: error.code || error.name,
        }) + "\n", { mode: 0o600 });
      } catch { /* the refusal is still reported through the thrown error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  // Managed rebuild of the anchor when the journal itself was lost or rolled
  // back. Without such an entry point the service would be permanently
  // refused after an anchor loss, which is not a usable recovery path.
  //
  // The rebuild never lowers the high-water mark. Every sequence the journal
  // still knows about, including the ones of a partially deleted journal, is
  // carried over. The database must therefore be at least at that sequence,
  // and the caller has to name the database as the truth explicitly.
  static rebuildAnchor(filePath, options = {}) {
    options = nativePermissionOptions(options);
    return this.#withExistingLock(filePath, options, () => this.#rebuildAnchorUnlocked(filePath, options));
  }

  static #rebuildAnchorUnlocked(filePath, options = {}) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    const audit = options.audit;
    if (!audit || typeof audit !== "object" || typeof audit.by !== "string" || !audit.by ||
        typeof audit.reason !== "string" || !audit.reason) fail("ERR_RECOVERY_AUDIT_REQUIRED");
    if (options.acceptDatabaseAsTruth !== true) fail("ERR_RECOVERY_NOT_APPLICABLE");
    const anchorDir = anchor.anchorDirFor(options.anchorDir);
    anchor.assertSeparateDomains(options.anchorDir, filePath);
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    const journalFile = anchor.journalFileFor(anchorDir);
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = readProtectedRow(db, configuredSchema(authorityOptions(options)), false);
      if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
      let state;
      try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
      assertState(state);
      if (isAuthoritySchema(state.schema_version)) fail("ERR_WITNESS_RECOVERY_UNSUPPORTED");
      if (state.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      // The permission mode of the anchor domain is a property of the
      // deployment. The caller may state it explicitly, and otherwise the
      // mode that was recorded with the state is used, so that a recovery
      // run by a different process applies the same contract. A caller may
      // not weaken the recorded contract for a single recovery run.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(state.anchor_mode, options.anchorMode),
        state.service_identity, options);
      // The known high-water mark includes every sequence the journal still
      // records, even when the commit entries were partially removed.
      const journal = anchor.readJournal(journalFile);
      const storeId = state.store_id;
      if (typeof storeId !== "string" || !storeId) fail("ERR_STATE_INVALID");
      // Only the entries that belong to this database count towards its
      // high-water mark. Entries of another instance were never part of this
      // store's history, and keeping them would leave the journal permanently
      // unusable: two store identities in one journal are corruption that no
      // other entry point can repair.
      const ownEntries = journal.entries.filter((entry) => entry.store_id === storeId);
      const known = ownEntries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
      // The declaration is the authoritative mark: it survives the deletion of
      // journal entries. The mark that the rebuild must reproduce is the
      // larger of the two witnesses.
      const declared = anchor.readHighWater(anchorDir);
      const mark = Math.max(known, declared.mark);
      // The database must sit exactly at the known high-water mark. A lower
      // sequence is a rollback and a higher one is either a crash window or a
      // forgery by whoever can write the database. Neither may be turned into
      // a new mark here: accepting a higher sequence would let an attacker who
      // only writes the database raise the mark and revive a one-shot permit,
      // and accepting a lower one would lower the mark.
      if (mark === 0) {
        // No witness of the mark is left at all. There is then nothing this
        // entry point can check the database against, and accepting it would
        // hand an attacker who can write the database a laundering channel:
        // wipe the anchor directory, forge the database, and rebuild. The
        // anchor domain loss is therefore not repairable here. It is handled
        // by resetAfterAnchorLoss(), which discards the database state instead
        // of trusting it.
        fail("ERR_RECOVERY_NOT_APPLICABLE");
      } else if (state.anchor_sequence !== mark) {
        fail("ERR_RECOVERY_NOT_APPLICABLE");
      }
      // The database must be byte-identical to the state the anchor domain
      // witnessed. The sequence alone is not a proof: an attacker who can
      // write the database can also raise its anchor_sequence to whatever
      // value the surviving witness happens to carry, and every sequence
      // check would pass while the body behind it was forged. The witness
      // holds the digest of the body that was actually committed, so the
      // rebuild is only allowed when the database body still hashes to it.
      // This is what makes the rebuild unable to launder a rollback: the
      // attacker can copy the sequence, but not the digest of a body the
      // anchor domain never saw.
      const bodyDigest = digest(row.body);
      // Only the digest that the anchor domain actually committed counts as a
      // witness. The digests of superseded attempts do not: an attempt that
      // was aborted was never committed, and letting its digest authorize a
      // rebuild would let a state that the store never reached be installed.
      const committedWitness = journal.committedBySeq.get(mark);
      const witnessed = new Set();
      if (committedWitness) witnessed.add(committedWitness.body_digest);
      if (declared.mark === mark && declared.digest) witnessed.add(declared.digest);
      if (witnessed.size === 0) fail("ERR_RECOVERY_NOT_APPLICABLE");
      if (!witnessed.has(bodyDigest)) fail("ERR_RECOVERY_NOT_APPLICABLE");
      // The witness for this sequence already describes the database body, so
      // the rebuild must not write a new attempt for it. A second attempt at
      // the same sequence would replace the original witness (the journal
      // keeps the highest attempt) and destroy the evidence of what the
      // anchor domain actually saw.
      const existingWitness = journal.committedBySeq.get(mark) || null;
      if (existingWitness && existingWitness.body_digest !== bodyDigest) {
        fail("ERR_RECOVERY_NOT_APPLICABLE");
      }
      // Entries of a foreign instance are moved aside instead of deleted, so
      // the evidence survives while the journal becomes usable again.
      const quarantined = anchor.quarantineForeignEntries(journalFile, storeId);
      // The rebuilt anchor starts at the database's own sequence, so the
      // high-water mark never moves backwards.
      // The journal is the single source of the attempt counter. The
      // declaration keeps a copy for the sequences it still remembers, but it
      // is compacted and therefore drops the counters of older sequences.
      // Merging both maps would let a number that was already used in the
      // journal be handed out again once the journal entry of that sequence
      // was pruned, and the journal could then no longer tell which attempt
      // of a sequence is the current one.
      const latestAttemptBySeq = new Map();
      for (const entry of ownEntries) {
        const known = latestAttemptBySeq.get(entry.sequence) || 0;
        if (entry.attempt > known) latestAttemptBySeq.set(entry.sequence, entry.attempt);
      }
      for (const [sequence, attempt] of declared.latestAttemptBySeq) {
        const known = latestAttemptBySeq.get(sequence) || 0;
        if (attempt > known) latestAttemptBySeq.set(sequence, attempt);
      }
      // A sequence that the anchor domain already witnessed must not be
      // written again. The journal keeps the highest attempt per sequence, so
      // a second attempt would replace the original witness and destroy the
      // digest of the body that was actually committed. The rebuild therefore
      // only fills a gap: it writes a witness for a sequence that has none.
      const alreadyWitnessed = journal.committedBySeq.has(state.anchor_sequence);
      const rebuildAttempt = anchor.nextAttemptFor({ latestAttemptBySeq }, state.anchor_sequence);
      if (!alreadyWitnessed) {
        anchor.appendEntry(journalFile, {
          type: "intent", sequence: state.anchor_sequence, body_digest: bodyDigest, store_id: storeId,
          attempt: rebuildAttempt,
        });
        anchor.appendEntry(journalFile, {
          type: "commit", sequence: state.anchor_sequence, body_digest: bodyDigest, store_id: storeId,
          attempt: rebuildAttempt,
        });
      }
      if (!alreadyWitnessed && declared.mark < state.anchor_sequence) {
        anchor.appendHighWater(anchorDir, {
          sequence: state.anchor_sequence, body_digest: bodyDigest, store_id: storeId, attempt: rebuildAttempt,
        });
      }
      const auditRecord = {
        schema_version: 1,
        at: new Date().toISOString(),
        by: audit.by,
        reason: audit.reason,
        database: path.resolve(filePath),
        rebuilt: true,
        sequence: state.anchor_sequence,
        known_sequence_before: known,
        quarantined_entries: quarantined,
        body_digest: digest(row.body),
      };
      fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"),
        JSON.stringify(auditRecord) + "\n", { mode: 0o600 });
      db.exec("COMMIT");
      return { rebuilt: true, sequence: state.anchor_sequence, audit: auditRecord };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may not have started */ }
      try {
        fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"), JSON.stringify({
          schema_version: 1,
          at: new Date().toISOString(),
          by: audit.by,
          reason: audit.reason,
          database: path.resolve(filePath),
          refused: true,
          code: error.code || error.name,
        }) + "\n", { mode: 0o600 });
      } catch { /* the refusal is still reported through the thrown error */ }
      throw error;
    } finally {
      db.close();
    }
  }

  // Recovery after the whole anchor domain was lost. The rebuild entry point
  // cannot serve this case: with no witness of the mark left, it would have
  // to trust the database, and the database is exactly what an attacker who
  // can write it controls. This entry point therefore does not trust the
  // database at all. It discards the stored state, issues a new store
  // identity, advances the service epoch so that every old session becomes
  // invalid, and starts a fresh anchor.
  //
  // Nothing is carried over. A permit that existed before the loss does not
  // exist afterwards, so there is nothing that could be consumed twice.
  static resetAfterAnchorLoss(filePath, options = {}) {
    options = nativePermissionOptions(options);
    return this.#withExistingLock(filePath, options, () => this.#resetAfterAnchorLossUnlocked(filePath, options));
  }

  static #resetAfterAnchorLossUnlocked(filePath, options = {}) {
    const DatabaseSync = sqliteRuntime();
    requireText(options.expectedDecisionId);
    if (!options.anchorDir) fail("ERR_ANCHOR_REQUIRED");
    const audit = options.audit;
    if (!audit || typeof audit !== "object" || typeof audit.by !== "string" || !audit.by ||
        typeof audit.reason !== "string" || !audit.reason) fail("ERR_RECOVERY_AUDIT_REQUIRED");
    const anchorDir = anchor.anchorDirFor(options.anchorDir);
    anchor.assertSeparateDomains(options.anchorDir, filePath);
    try { checkFile(filePath); } catch { fail("ERR_STATE_MISSING_OR_UNSAFE"); }
    const journalFile = anchor.journalFileFor(anchorDir);
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = readProtectedRow(db, configuredSchema(authorityOptions(options)), false);
      if (!row || digest(row.body) !== row.sha256) fail("ERR_STATE_INVALID");
      let state;
      try { state = JSON.parse(row.body); } catch { fail("ERR_STATE_INVALID"); }
      assertState(state);
      if (isAuthoritySchema(state.schema_version)) fail("ERR_WITNESS_RECOVERY_UNSUPPORTED");
      if (state.decision_id !== options.expectedDecisionId) fail("ERR_DECISION_MISMATCH");
      // The permission mode of the anchor domain is a property of the
      // deployment. The caller may state it explicitly, and otherwise the
      // mode that was recorded with the state is used, so that a recovery
      // run by a different process applies the same contract. A caller may
      // not weaken the recorded contract for a single recovery run.
      anchor.assertAnchorPermissionsWithIdentity(anchorDir,
        anchor.assertNoAnchorModeDowngrade(state.anchor_mode, options.anchorMode),
        state.service_identity, options);
      // The reset must use the same clock the service itself runs on. A reset
      // that stamps the fresh state with the wall clock while the service
      // runs on an injected clock would write a timestamp the service has
      // never seen, and the next open would refuse the store as a clock
      // rollback. The clock is therefore required rather than defaulted.
      //
      // The check has to happen BEFORE the anchor domain is retired. A reset
      // that fails after retiring the anchor leaves the database rolled back
      // but the anchor domain emptied, which is a state that is neither
      // "not reset" nor "reset": the old permit is still in the database
      // while no witness of it is left.
      if (typeof options.clock !== "function") fail("ERR_CLOCK_INVALID");
      const now = options.clock();
      if (!Number.isSafeInteger(now) || now < 0) fail("ERR_CLOCK_INVALID");
      // The whole old anchor domain is retired: its entries belong to the
      // identity that is being replaced, and its high-water declaration
      // would keep the old mark and stop the fresh instance from starting.
      const retiredStoreId = typeof state.store_id === "string" ? state.store_id : null;
      const quarantined = anchor.retireAnchorDomain(anchorDir);
      const storeId = crypto.randomBytes(16).toString("hex");
      // Nothing of the old state survives: no lease, no permit, no idempotency
      // key, and a new service epoch so that every old session is invalid.
      // The declared service identity survives the reset: it is a property of
      // the deployment, not of the state that was lost.
      const fresh = initialState(now, options.expectedDecisionId, storeId, options.anchorMode,
        state.service_identity);
      fresh.service_epoch = state.service_epoch + 1;
      // The clock is taken from the injected clock when one is given. Using
      // the wall clock here would write a timestamp the service's own clock
      // has never seen, and the next open would refuse the store as a clock
      // rollback.
      fresh.last_clock_ms = Math.max(now, state.last_clock_ms);
      const body = JSON.stringify(fresh);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, digest(body));
      db.exec("COMMIT");
      // The fresh anchor starts at sequence 1 with the new identity.
      anchor.appendEntry(journalFile, { type: "intent", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      anchor.appendEntry(journalFile, { type: "commit", sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      anchor.appendHighWater(anchorDir, { sequence: 1, body_digest: digest(body), store_id: storeId, attempt: 1 });
      const auditRecord = {
        schema_version: 1,
        at: new Date().toISOString(),
        by: audit.by,
        reason: audit.reason,
        database: path.resolve(filePath),
        reset: true,
        retired_store_id: retiredStoreId,
        new_store_id: storeId,
        service_epoch: fresh.service_epoch,
        quarantined_entries: quarantined,
      };
      fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"),
        JSON.stringify(auditRecord) + "\n", { mode: 0o600 });
      return { reset: true, storeId, serviceEpoch: fresh.service_epoch, audit: auditRecord };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* the transaction may not have started */ }
      try {
        fs.appendFileSync(path.join(anchorDir, "protected-anchor-recovery.log"), JSON.stringify({
          schema_version: 1,
          at: new Date().toISOString(),
          by: audit.by,
          reason: audit.reason,
          database: path.resolve(filePath),
          refused: true,
          code: error.code || error.name,
        }) + "\n", { mode: 0o600 });
      } catch { /* the refusal is still reported through the thrown error */ }
      throw error;
    } finally {
      db.close();
    }
  }
}

// The fields consume() compares before it lets an action run. They are
// exported so that the permit signature coverage can be asserted against
// this live fact instead of against a hand-written list: if consume() gains
// or loses a binding field, the coverage assertion turns red rather than
// silently leaving a field unsigned.
const CONSUME_BINDING_FIELDS = Object.freeze([
  "leaseId", "sessionId", "hostId", "workerId", "runId", "generation",
  "desktopKey", "ownedAppId", "serviceEpoch", "fencing", "operation",
  "targetDigest", "paramsDigest", "sequence",
]);

module.exports = {
  ProtectedPermitStore,
  ProtectedStoreError,
  PROTECTED_SCOPE,
  CONSUME_BINDING_FIELDS,
  validateReservationInput,
  consumeBindingFields: () => CONSUME_BINDING_FIELDS.slice(),
};
