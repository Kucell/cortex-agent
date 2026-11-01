"use strict";

// Standalone R2 development model. No production store, signer, credentials,
// routing, OS identity, transport or real effects. restart() retains this heap;
// it is NOT a disk image, fsync, rollback protection or process-crash proof.
// Evidence and authority updates below are explicit simulator inputs, never
// authenticated statements. The synthetic signature is a public hash, NOT a MAC
// or a signature accepted by the existing permit verifier.
const { createHash } = require("node:crypto");
const { types: { isProxy } } = require("node:util");

const MODE = Object.freeze({ mode: "synthetic-development-only",
  durability: "in-memory-simulation", authority: false, executionAuthorized: false });
const SIGNED_FIELDS = Object.freeze([
  "lease_id", "session_id", "host_identity", "worker_identity", "run_id",
  "generation", "desktop_key", "owned_app_id", "service_epoch", "fencing",
  "operation", "target_digest", "params_digest", "sequence",
  "issued_at_ms", "deadline_ms", "permit_id",
]);
const BARRIER_PARTS = Object.freeze([
  "db-wal", "anchor-entry-content", "anchor-entry-name", "anchor-highwater-content",
  "anchor-highwater-name", "audit-content", "audit-name",
]);
const TUPLE_DOMAIN = Buffer.from("cortex.phase-a.synthetic.effect-tuple.v1\0", "utf8");
const MAX_BYTES = 65536;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function text(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 256 ||
      Buffer.from(value, "utf8").toString("utf8") !== value) fail("INVALID_TEXT");
  return value;
}
function integer(value, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail("INVALID_INTEGER");
  return value;
}

// Copy data without invoking getters, toJSON, Promise/then or caller callbacks.
// Finite limits make canonicalization and the built-in signer finite local work.
function copyData(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 4096 || depth > 16) fail("INPUT_LIMIT");
  // MUST precede Array.isArray and all prototype/descriptor/key reflection,
  // including for revoked proxies. Never give input a callback/reentry window.
  if (isProxy(value)) fail("DATA_ONLY");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_BYTES || Buffer.from(value).toString() !== value) fail("INVALID_TEXT");
    return value;
  }
  if (typeof value === "number") { integer(value); return value; }
  if (!value || typeof value !== "object" ||
      Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) fail("DATA_ONLY");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4096) fail("INPUT_LIMIT");
  const result = Array.isArray(value) ? [] : {};
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string" || key === "__proto__") fail("DATA_ONLY");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("DATA_ONLY");
    Object.defineProperty(result, key, { value: copyData(descriptor.value, depth + 1, budget),
      enumerable: true, writable: true, configurable: true });
  }
  if (Array.isArray(value) && (result.length !== value.length ||
      Object.keys(result).length !== result.length)) fail("DATA_ONLY");
  return result;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function encode(value) {
  const bytes = Buffer.from(canonical(value), "utf8");
  if (bytes.length > MAX_BYTES) fail("INPUT_LIMIT");
  return bytes;
}
function same(a, b) { return canonical(a) === canonical(b); }
function exact(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      !same(Object.keys(value).sort(), [...keys].sort())) fail("INVALID_FIELDS");
}
function signedMessage(value) {
  exact(value, SIGNED_FIELDS);
  for (const key of SIGNED_FIELDS) {
    if (["service_epoch", "fencing", "sequence"].includes(key)) integer(value[key], 1);
    else if (["issued_at_ms", "deadline_ms"].includes(key)) integer(value[key]);
    else if (key === "generation" && typeof value[key] === "number") integer(value[key]);
    else text(value[key]);
    if (["target_digest", "params_digest"].includes(key) && !/^[a-f0-9]{64}$/.test(value[key])) fail("INVALID_DIGEST");
  }
  if (value.deadline_ms <= value.issued_at_ms) fail("INVALID_DEADLINE");
  return value;
}

// Candidate encoding, not a new production wire format: fixed domain followed
// by two uint32-BE UTF-8 byte lengths and the original, unnormalized strings.
function canonicalEffectTuple(input) {
  const tuple = copyData(input);
  exact(tuple, ["origin_authority_namespace", "original_permit_id"]);
  const parts = [tuple.origin_authority_namespace, tuple.original_permit_id].map(value => {
    const bytes = Buffer.from(text(value), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  const bytes = Buffer.concat([TUPLE_DOMAIN, ...parts]);
  return { tuple, canonicalTuple: bytes.toString("base64"), effectId: hash(bytes) };
}

const AUTH_FIELDS = ["principalId", "grantId", "storeGeneration", "lifecycleVersion",
  "reservationId", "checkpoint", "signerFingerprint", "serviceEpoch", "fencing",
  "authorized", "revoked", "registration"];
function authorityState(value) {
  exact(value, AUTH_FIELDS);
  for (const key of AUTH_FIELDS.slice(0, 7)) text(value[key]);
  integer(value.serviceEpoch, 1); integer(value.fencing, 1);
  if (typeof value.authorized !== "boolean" || typeof value.revoked !== "boolean" ||
      !["active", "registration-pending"].includes(value.registration)) fail("INVALID_AUTHORITY");
  return value;
}
function authorityKey(value) {
  // Flags cannot rename a revoked binding. Other changes burn the old full
  // binding as well; the owner-assigned version separately invalidates attempts.
  const { authorized, revoked, registration, ...binding } = value;
  return canonical(binding);
}
function grantKey(value) { return canonical([value.principalId, value.grantId]); }
function canonicalAction(request) {
  // Only this well-defined fixture effect is supported. We have no trusted
  // repeat-execution authorization or general semantic alias resolver. Identical
  // counter effects stay reserved for the lifetime of this heap ledger, across
  // labels, permits, signed digests and business/run/store/lifecycle versions.
  if (request.message.operation !== "synthetic-increment") fail("UNSUPPORTED_EFFECT");
  exact(request.effect, ["target", "params"]);
  if (request.effect.target !== "synthetic-counter") fail("UNSUPPORTED_EFFECT");
  exact(request.effect.params, ["delta"]); integer(request.effect.params.delta, 1);
  const bytes = encode({ operation: request.message.operation, effect: request.effect });
  return { raw: bytes.toString("base64"), digest: hash(Buffer.concat([
    Buffer.from("SYNTHETIC-COUNTER-ACTION-v1\0"), bytes,
  ])) };
}
function normalizedRequest(input) {
  const request = copyData(input);
  exact(request, ["attemptId", "tuple", "message", "authority", "effect", "businessVersion", "actionFingerprint", "finalCheckpoint"]);
  text(request.attemptId); text(request.actionFingerprint); text(request.finalCheckpoint); integer(request.businessVersion, 1);
  signedMessage(request.message); authorityState(request.authority); encode(request);
  const tuple = canonicalEffectTuple(request.tuple);
  if (tuple.tuple.original_permit_id !== request.message.permit_id) fail("PERMIT_TUPLE_MISMATCH");
  if (request.authority.serviceEpoch !== request.message.service_epoch || request.authority.fencing !== request.message.fencing) fail("FENCE_MISMATCH");
  const action = canonicalAction(request);
  const contentDigest = hash(encode({ rawMessage: encode(request.message).toString("base64"),
    effect: request.effect, businessVersion: request.businessVersion, actionFingerprint: request.actionFingerprint,
    authority: request.authority, finalCheckpoint: request.finalCheckpoint }));
  return { request, ...tuple, canonicalAction: action, contentDigest, requestDigest: hash(encode(request)) };
}
function preparedInput(message, authority) {
  const bytes = encode(message);
  return { raw: bytes.toString("base64"), digest: hash(bytes), encoding: "existing-14-plus-3-canonical-json-v1", authority: copyData(authority) };
}
function sequenceKey(namespace, message) {
  return canonical([namespace, message.lease_id, message.run_id, message.generation, message.sequence]);
}
function syntheticHash(bytes) {
  return createHash("sha256").update("SYNTHETIC-NOT-A-SIGNATURE-v1\0").update(bytes).digest();
}
function syntheticSign(bytes) { return syntheticHash(bytes); }
// Internal fixture codec only. Neither it nor the in-memory model owns durable
// calling rights. SQLite must independently commit/verify its owner CAS gate.
const sqliteSigningCodec = Object.freeze({
  semanticFormat: 1,
  prepare(input) {
    const n = normalizedRequest(input), prepared = preparedInput(n.request.message, n.request.authority);
    return encode({ semanticFormat: 1, ...n, prepared,
      sequenceKey: sequenceKey(n.tuple.origin_authority_namespace, n.request.message) }).toString("utf8");
  },
  inspect(body) {
    if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BYTES) fail("PREPARE_MISMATCH");
    let parsed; try { parsed = JSON.parse(body); } catch { fail("PREPARE_MISMATCH"); }
    if (parsed.semanticFormat !== 1 || sqliteSigningCodec.prepare(parsed.request) !== body) fail("PREPARE_MISMATCH");
    return parsed;
  },
  hashPrepared(body) {
    const record = sqliteSigningCodec.inspect(body);
    return syntheticSign(Buffer.from(record.prepared.raw, "base64"));
  },
  verifyHash(body, result) {
    if (isProxy(result) || !Buffer.isBuffer(result) || result.length !== 32) fail("RESULT_MISMATCH");
    // Public-hash verification does not invoke the fixture signer entry point
    // and does not recover a calling capability. Never replace with a signer.
    const record = sqliteSigningCodec.inspect(body);
    const expected = syntheticHash(Buffer.from(record.prepared.raw, "base64"));
    const valid = expected.equals(result); expected.fill(0);
    if (!valid) fail("RESULT_MISMATCH");
  },
  // Inert bounded fixture data only. Export canonical encoding rather than
  // duplicating it in the SQLite test driver; this confers no evidence trust.
  canonicalData(input) { return encode(copyData(input)).toString("utf8"); },
});

function createSyntheticPublication(options) {
  const config = copyData(options);
  exact(config, ["namespace", "serviceId", "authority", "nowMs"]);
  text(config.namespace); text(config.serviceId); integer(config.nowMs);
  const state = { namespace: config.namespace, serviceId: config.serviceId,
    authority: authorityState(config.authority), authorityVersion: 1,
    authorityTombstones: new Map(), revokedGrants: new Set(), nowMs: config.nowMs, epoch: 1,
    managementFence: 1, managers: [config.serviceId], migrations: [], version: 0, clockPoisoned: false,
    dbSequence: 0, signCalls: 0, attempts: new Map(), tuples: new Map(),
    effectIds: new Map(), actions: new Map(), sequences: new Map(), receipts: new Map() };
  let candidates = new Map();
  let callOwners = new Set();
  if (!state.authority.authorized || state.authority.revoked || state.authority.registration !== "active") {
    state.authorityTombstones.set(authorityKey(state.authority), { version: 1, reason: "INITIAL_INACTIVE" });
    if (!state.authority.authorized || state.authority.revoked) state.revokedGrants.add(grantKey(state.authority));
  }
  function touch() { state.version++; }
  function destroyCandidate(id) {
    const candidate = candidates.get(id);
    if (candidate) candidate.fill(0); // Best effort only; no JS physical-zeroization claim.
    candidates.delete(id); callOwners.delete(id);
  }
  function get(id) {
    text(id);
    const record = state.attempts.get(id);
    if (!record) fail("ATTEMPT_NOT_FOUND");
    return record;
  }
  function guard(record) {
    const a = state.authority;
    if (state.clockPoisoned) fail("CLOCK_POISONED");
    if (!a.authorized || a.revoked) fail("NOT_AUTHORIZED");
    if (a.registration !== "active") fail("REGISTRATION_PENDING");
    if (record.invalidation || record.authorityVersion !== state.authorityVersion ||
        state.authorityTombstones.has(authorityKey(record.authority)) ||
        state.revokedGrants.has(grantKey(record.authority))) fail("AUTHORITY_INVALIDATED");
    if (!same(a, record.authority)) fail("AUTHORITY_CHANGED");
    if (state.nowMs < record.message.issued_at_ms || state.nowMs >= record.message.deadline_ms) fail("EXPIRED");
  }
  function checkPrepared(record) {
    if (!record.prepared || typeof record.prepared.raw !== "string") fail("PREPARE_MISSING");
    const bytes = Buffer.from(record.prepared.raw, "base64");
    if (bytes.toString("base64") !== record.prepared.raw || hash(bytes) !== record.prepared.digest ||
        !bytes.equals(encode(record.message)) || !same(record.prepared.authority, record.authority)) fail("PREPARE_MISMATCH");
    if (state.sequences.get(record.sequenceKey) !== record.attemptId) fail("RESERVATION_LOST");
    return bytes;
  }
  function binding(record, scope) {
    if (!record.result) fail("RESULT_MISSING");
    const base = { scope, attemptId: record.attemptId, dbSequence: record.result.dbSequence,
      tuple: record.tuple, canonicalTuple: record.canonicalTuple, effectId: record.effectId,
      requestDigest: record.requestDigest, contentDigest: record.contentDigest,
      canonicalAction: record.canonicalAction, authorityVersion: record.authorityVersion,
      resultDigest: record.result.digest, finalCheckpoint: record.finalCheckpoint };
    if (scope === "eligibility") {
      if (!record.eligibility) fail("ELIGIBILITY_MISSING");
      base.eligibilitySequence = record.eligibility.dbSequence;
      base.eligibilityDigest = record.eligibility.digest;
      base.businessCertificateDigest = record.eligibility.businessCertificateDigest;
    } else if (scope !== "business") fail("INVALID_SCOPE");
    return base;
  }
  function certificate(record, scope) {
    checkPrepared(record);
    if (record.outcome !== "db-committed" || !record.result) fail("NOT_COMMITTED");
    const bytes = Buffer.from(record.prepared.raw, "base64");
    const expectedSignature = syntheticSign(bytes);
    const valid = record.result.signature.equals(expectedSignature) && record.result.digest ===
      resultDigest(record, record.result.signature, record.result.dbSequence);
    expectedSignature.fill(0);
    if (!valid) fail("RESULT_MISMATCH");
    const expected = binding(record, scope);
    const evidence = record.evidence[scope];
    for (const part of BARRIER_PARTS) {
      if (!evidence[part] || !same(evidence[part], { part, binding: expected })) fail("BARRIER_INCOMPLETE");
    }
    return hash(encode(evidence));
  }
  function resultDigest(record, signature, dbSequence) {
    return hash(encode({ attemptId: record.attemptId, dbSequence, canonicalTuple: record.canonicalTuple,
      requestDigest: record.requestDigest, contentDigest: record.contentDigest,
      finalCheckpoint: record.finalCheckpoint, raw: record.prepared.raw,
      syntheticSignature: signature.toString("base64") }));
  }
  function summary(record) {
    // Never expose an unpublished candidate or the stored signature in diagnostics.
    return copyData({ ...MODE, attemptId: record.attemptId, outcome: record.outcome,
      intent: record.intent, delivery: record.delivery, effectOutcome: record.effectOutcome,
      cancelRequested: record.cancelRequested, tuple: record.tuple,
      authorityVersion: record.authorityVersion, invalidation: record.invalidation,
      canonicalAction: record.canonicalAction,
      canonicalTuple: record.canonicalTuple, effectId: record.effectId,
      requestDigest: record.requestDigest, contentDigest: record.contentDigest,
      prepared: record.prepared, result: record.result ? { dbSequence: record.result.dbSequence,
        digest: record.result.digest } : null, eligibility: record.eligibility,
      duplicateOf: record.duplicateOf, evidence: record.evidence });
  }
  function manifest() {
    const records = [...state.attempts.values()].map(summary);
    const receipts = [...state.receipts.values()];
    const head = createHash("sha256").update("SYNTHETIC-MIGRATION-HEAD-v1\0");
    const control = { authority: state.authority, authorityVersion: state.authorityVersion,
      tombstones: [...state.authorityTombstones], revokedGrants: [...state.revokedGrants], clockPoisoned: state.clockPoisoned };
    for (const item of [state.namespace, control, ...records, ...receipts, ...state.migrations]) {
      const bytes = encode(item);
      const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
      head.update(length).update(bytes);
    }
    return { namespace: state.namespace, headVersion: state.version,
      headDigest: head.digest("hex"),
      tupleCount: state.tuples.size, attemptCount: state.attempts.size,
      tombstoneCount: records.filter(r => r.outcome === "aborted" || r.outcome.includes("unknown")).length };
  }
  function openOwner() {
    const epoch = state.epoch;
    function live() { if (epoch !== state.epoch) fail("STALE_OWNER"); }
    // All caller objects go through this boundary. copyData rejects Proxy and
    // descriptors with accessors, so later checks/encoders see only owned inert
    // data. Recheck even on exceptions before this owner may touch model state.
    // Hostile modification of Node/JS builtins is outside this local simulator.
    function inputData(input) {
      live(); try { return copyData(input); } finally { live(); }
    }
    function expected(record, outcome) { if (record.outcome !== outcome) fail("INVALID_TRANSITION"); }
    function finalGuard(record, failureOutcome) {
      try { checkPrepared(record); guard(record); live(); }
      catch (error) {
        live();
        record.outcome = failureOutcome; destroyCandidate(record.attemptId); touch(); throw error;
      }
    }
    const api = {
      ...MODE,
      inspect(id) { live(); return summary(get(id)); },
      inspectLedger() {
        live(); return copyData({ ...MODE, namespace: state.namespace, serviceId: state.serviceId,
          managementFence: state.managementFence, managers: state.managers, migrations: state.migrations,
          attempts: state.attempts.size, tuples: state.tuples.size, receipts: state.receipts.size,
          authorityVersion: state.authorityVersion, authorityTombstones: state.authorityTombstones.size,
          clockPoisoned: state.clockPoisoned,
          // Instrumentation only, explicitly NOT recovery evidence.
          simulatedSignerCalls: state.signCalls, manifest: manifest() });
      },
      setAuthority(input) {
        const next = authorityState(inputData(input)); encode(next); live();
        if (same(next, state.authority)) return;
        if (next.serviceEpoch < state.authority.serviceEpoch || next.fencing < state.authority.fencing) fail("AUTHORITY_REGRESSION");
        if (state.authorityTombstones.has(authorityKey(next))) fail("AUTHORITY_TOMBSTONED");
        if (next.authorized && !next.revoked && state.revokedGrants.has(grantKey(next))) fail("GRANT_REVOKED");
        if (state.authorityVersion === Number.MAX_SAFE_INTEGER) fail("AUTHORITY_VERSION_OVERFLOW");
        const version = state.authorityVersion + 1;
        const reason = !next.authorized || next.revoked ? "AUTHORITY_REVOKED" : "AUTHORITY_CHANGED";
        state.authorityTombstones.set(authorityKey(state.authority), { version, reason });
        if (!next.authorized || next.revoked) {
          state.revokedGrants.add(grantKey(next));
          state.authorityTombstones.set(authorityKey(next), { version, reason });
        } else if (next.registration !== "active") {
          state.authorityTombstones.set(authorityKey(next), { version, reason });
        }
        for (const r of state.attempts.values()) {
          if (!r.invalidation) r.invalidation = { version, reason };
          destroyCandidate(r.attemptId);
        }
        state.authority = next; state.authorityVersion = version; touch();
      },
      advanceTo(nowMs) {
        live(); integer(nowMs);
        if (nowMs < state.nowMs) {
          // Retain the high-water sample and poison before reporting refusal.
          // This is heap persistence only; neither restart nor a new authority
          // is an independently authorized recovery decision.
          state.clockPoisoned = true;
          for (const id of candidates.keys()) destroyCandidate(id);
          callOwners.clear(); touch(); fail("CLOCK_ROLLBACK");
        }
        state.nowMs = nowMs;
      },
      admit(input) {
        const n = normalizedRequest(inputData(input)), request = n.request;
        if (state.attempts.has(request.attemptId)) fail("ATTEMPT_ID_REUSED");
        const tuple = { tuple: n.tuple, canonicalTuple: n.canonicalTuple, effectId: n.effectId };
        if (tuple.tuple.origin_authority_namespace !== state.namespace) fail("NAMESPACE_NOT_MANAGED");
        if (tuple.tuple.original_permit_id !== request.message.permit_id) fail("PERMIT_TUPLE_MISMATCH");
        if (request.authority.serviceEpoch !== request.message.service_epoch ||
            request.authority.fencing !== request.message.fencing) fail("FENCE_MISMATCH");
        const contentDigest = n.contentDigest;
        const existing = state.tuples.get(tuple.canonicalTuple);
        const reverse = state.effectIds.get(tuple.effectId);
        if (reverse && reverse !== tuple.canonicalTuple) fail("EFFECT_ID_CONFLICT");
        if (existing && existing.contentDigest !== contentDigest) fail("CONTENT_CONFLICT");
        if (existing && !same(existing.tuple, tuple.tuple)) fail("TUPLE_CONFLICT");
        const action = n.canonicalAction;
        const reservedAction = state.actions.get(action.raw);
        if (reservedAction && reservedAction !== tuple.canonicalTuple) fail("ACTION_QUARANTINED");
        const record = { ...request, ...tuple, contentDigest, requestDigest: hash(encode(request)),
          authorityVersion: state.authorityVersion, invalidation: null, canonicalAction: action,
          outcome: existing ? "duplicate" : "admitted", duplicateOf: existing ? existing.attemptId : null,
          intent: "none", delivery: "not-attempted", effectOutcome: "not-started", cancelRequested: false,
          prepared: null, result: null, eligibility: null, evidence: { business: {}, eligibility: {} },
          commitEpoch: null, eligibilityEpoch: null };
        guard(record); live();
        state.attempts.set(record.attemptId, record);
        if (!existing) {
          state.tuples.set(tuple.canonicalTuple, record);
          state.effectIds.set(tuple.effectId, tuple.canonicalTuple);
          // Full canonical bytes are the key, not a collision-prone caller
          // label or only a hash. No automatic release/repeat-effect API.
          state.actions.set(action.raw, tuple.canonicalTuple);
        }
        touch(); return summary(record);
      },
      prepare(id) {
        live(); const r = get(id); expected(r, "admitted"); guard(r);
        // A lease/run scoped sequence and original permit tuple never become free.
        const key = sequenceKey(state.namespace, r.message);
        if (state.sequences.has(key)) fail("SEQUENCE_RESERVED");
        r.prepared = preparedInput(r.message, r.authority);
        r.sequenceKey = key; state.sequences.set(key, id);
        r.outcome = "sign-prepared"; touch(); return summary(r);
      },
      armSignCall(id) {
        live(); const r = get(id); expected(r, "sign-prepared");
        finalGuard(r, "aborted");
        // Simulated durable CAS BEFORE the only local signer can be invoked.
        r.outcome = "sign-call-possible"; callOwners.add(id); touch(); return summary(r);
      },
      invokeSigner(id) {
        live(); const r = get(id); expected(r, "sign-call-possible");
        if (!callOwners.has(id)) fail("SIGN_CALL_ALREADY_POSSIBLE");
        finalGuard(r, "sign-outcome-unknown");
        callOwners.delete(id); state.signCalls++;
        candidates.set(id, syntheticSign(checkPrepared(r)));
        // No signature is returned, even on the successful path.
        return summary(r);
      },
      beginCommit(id) {
        live(); const r = get(id); expected(r, "sign-call-possible");
        if (!candidates.has(id)) fail("CANDIDATE_MISSING");
        if (r.cancelRequested) fail("CANCELLED");
        finalGuard(r, "aborted"); r.outcome = "commit-possible"; touch(); return summary(r);
      },
      commit(id) {
        live(); const r = get(id); expected(r, "commit-possible");
        finalGuard(r, "commit-outcome-unknown");
        const candidate = candidates.get(id);
        if (!candidate) fail("CANDIDATE_MISSING");
        const verified = syntheticSign(checkPrepared(r));
        if (!candidate.equals(verified)) { verified.fill(0); fail("SIGNATURE_MISMATCH"); }
        verified.fill(0);
        // One simulated atomic business result + intent commit. No callbacks/IO.
        const dbSequence = ++state.dbSequence;
        r.result = { dbSequence, signature: Buffer.from(candidate), digest: resultDigest(r, candidate, dbSequence) };
        r.outcome = "db-committed"; r.intent = "committed-unpublishable"; r.commitEpoch = epoch;
        destroyCandidate(id); touch(); return summary(r);
      },
      cancel(id) {
        live(); const r = get(id); r.cancelRequested = true;
        if (["admitted", "sign-prepared"].includes(r.outcome)) r.outcome = "aborted";
        else if (r.outcome === "sign-call-possible") r.outcome = "sign-outcome-unknown";
        // After the commit gate this is only stop-waiting, not rollback evidence.
        if (r.outcome !== "commit-possible") destroyCandidate(id);
        touch(); return summary(r);
      },
      evidenceBinding(id, scope) { live(); return copyData(binding(get(id), scope)); },
      recordEvidence(id, scope, input) {
        const evidence = inputData(input); exact(evidence, ["part", "binding"]);
        const r = get(id);
        if (!BARRIER_PARTS.includes(evidence.part)) fail("INVALID_BARRIER_PART");
        const b = binding(r, scope);
        if (!same(b, evidence.binding)) fail("EVIDENCE_BINDING_MISMATCH");
        const writerEpoch = scope === "business" ? r.commitEpoch : r.eligibilityEpoch;
        if (writerEpoch !== epoch) fail("RECOVERY_NOT_IMPLEMENTED");
        // Contains only linkage/digests; never candidate bytes or signatures.
        live(); r.evidence[scope][evidence.part] = evidence; touch(); return summary(r);
      },
      qualify(id) {
        live(); const r = get(id); expected(r, "db-committed");
        if (r.eligibility) fail("ELIGIBILITY_ALREADY_COMMITTED");
        if (r.commitEpoch !== epoch) fail("RECOVERY_NOT_IMPLEMENTED");
        guard(r); if (r.cancelRequested) fail("CANCELLED");
        const businessCertificateDigest = certificate(r, "business");
        const dbSequence = ++state.dbSequence;
        r.eligibility = { dbSequence, businessCertificateDigest,
          digest: hash(encode({ binding: binding(r, "business"), dbSequence, businessCertificateDigest })) };
        r.eligibilityEpoch = epoch; r.intent = "dispatch-eligible";
        touch(); return summary(r);
      },
      publish(id, requestDigest) {
        live(); const r = get(id); text(requestDigest); guard(r);
        if (r.requestDigest !== requestDigest) fail("REQUEST_BINDING_MISMATCH");
        certificate(r, "business");
        r.delivery = "unknown"; touch(); // Sending cannot prove client receipt.
        return copyData({ ...MODE, message: r.message, bytes: r.prepared.raw,
          syntheticSignature: `synthetic-sha256:${r.result.signature.toString("base64")}`,
          attemptId: id, resultDigest: r.result.digest, delivery: "unknown" });
      },
      dispatchSynthetic(id) {
        live(); const r = get(id); guard(r);
        if (r.cancelRequested) fail("CANCELLED");
        if (r.intent !== "dispatch-eligible") fail("NOT_DISPATCH_ELIGIBLE");
        const business = certificate(r, "business");
        certificate(r, "eligibility");
        if (r.eligibility.businessCertificateDigest !== business) fail("CERTIFICATE_MISMATCH");
        // Synthetic receiver: dedup + fence check + effect counter + receipt in
        // ONE synchronous heap transition. No external claim lease/replay API.
        const existing = state.receipts.get(r.effectId);
        if (existing) {
          if (existing.canonicalTuple !== r.canonicalTuple || !same(existing.tuple, r.tuple) ||
              existing.contentDigest !== r.contentDigest) fail("RECEIPT_CONFLICT");
          return copyData(existing);
        }
        const receipt = { ...MODE, effectId: r.effectId, tuple: r.tuple, canonicalTuple: r.canonicalTuple,
          contentDigest: r.contentDigest, requestDigest: r.requestDigest, attemptId: id,
          businessSequence: r.result.dbSequence, eligibilitySequence: r.eligibility.dbSequence,
          authority: r.authority, receiverServiceId: state.serviceId, managementFence: state.managementFence,
          result: "simulated-applied", applications: 1 };
        state.receipts.set(r.effectId, receipt); r.effectOutcome = "simulated-applied"; touch();
        return copyData(receipt);
      },
      migrationManifest() { live(); return copyData(manifest()); },
      migrate(input) {
        const m = inputData(input);
        exact(m, ["from", "to", "nextFence", "manifest", "oldManagerRevoked", "fullHistoryLoaded"]);
        text(m.to);
        if (m.from !== state.serviceId || state.managers.includes(m.to) ||
            m.nextFence !== state.managementFence + 1 || m.oldManagerRevoked !== true ||
            m.fullHistoryLoaded !== true || !same(m.manifest, manifest())) fail("MIGRATION_FROZEN");
        live(); state.migrations.push(m); state.managers.push(m.to); state.serviceId = m.to;
        state.managementFence = m.nextFence;
        return api.restart(state.nowMs); // Same original ledger, no new namespace/table.
      },
      // Explicit destructive HEAP fault injection for development tests only.
      // There is no production snapshot import or general recovery/repair path.
      simulateLoss(id, kind, part) {
        live(); const r = get(id);
        if (kind === "prepared-bytes" && r.prepared) r.prepared.raw = null;
        else if (kind === "call-gate" && r.outcome === "sign-call-possible") {
          r.outcome = "sign-outcome-unknown"; destroyCandidate(id);
        }
        else if (kind === "result" && r.result) { r.result.signature.fill(0); r.result = null; }
        else if (["business", "eligibility"].includes(kind) && BARRIER_PARTS.includes(part)) delete r.evidence[kind][part];
        else fail("INVALID_SIMULATED_LOSS");
        touch();
      },
      restart(nowMs) {
        live(); integer(nowMs);
        // A new simulated wall-clock sample is mandatory, old monotonic handles
        // are not reused. Backwards time poisons this model until an independently
        // reviewed recovery (not implemented); updating authority cannot clear it.
        const rollback = nowMs < state.nowMs;
        state.nowMs = nowMs; state.epoch++;
        for (const r of state.attempts.values()) {
          destroyCandidate(r.attemptId);
          if (["admitted", "sign-prepared", "sign-call-possible"].includes(r.outcome)) r.outcome = "sign-outcome-unknown";
          if (r.outcome === "commit-possible" || (r.outcome === "db-committed" && !r.result)) r.outcome = "commit-outcome-unknown";
        }
        candidates = new Map(); callOwners = new Set();
        if (rollback) state.clockPoisoned = true;
        touch(); return openOwner();
      },
    };
    return Object.freeze(api);
  }
  return openOwner();
}

module.exports = { createSyntheticPublication, canonicalEffectTuple, SIGNED_FIELDS, BARRIER_PARTS, MODE, sqliteSigningCodec };
