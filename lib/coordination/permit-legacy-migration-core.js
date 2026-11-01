"use strict";

// PURE, PREPARED BYTES ONLY. No DB/FS/clock/signer/permission/activation APIs.
// Supports the closed, drained subset of frozen 1.15.7 schema1. Evidence here
// is content-checked, NOT authenticated; a caller cannot obtain authority by
// supplying matching hashes. Real isolation, SQL/sidecar validation and durable
// migration/CAS/receipts remain outside this module.
const { createHash } = require("node:crypto");
const { parse: parseJson } = require("../offline-migration/json");
const { PROTECTED_SCOPE, PROTECTED_LEASE_PREFIX } = require("./protected-scope");
const FROZEN_SOURCE_SHA256 = "26e20acab1dd50396c55b404b39b2340035c95c8835eaa425e13b07cc36b772a";
const LIMITS = Object.freeze({ evidenceBytes: 4 * 1024 * 1024, bodyBytes: 1024 * 1024, depth: 16, records: 8192, permits: 512 });
const BINDING = Object.freeze(["leaseId", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId", "serviceEpoch", "fencing"]);
const LEASE = Object.freeze(["leaseId", "status", "owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId",
  "idempotencyKey", "serviceEpoch", "fencing", "expiresAt", "ttlMs", "endedAt"]);
const PERMIT = Object.freeze([...BINDING, "operation", "targetDigest", "paramsDigest", "permitId", "status", "idempotencyKey", "sequence", "deadline"]);
class LegacyPermitMigrationError extends Error {
  constructor(code) { super(code); this.name = "LegacyPermitMigrationError"; this.code = code; }
}
function fail(code = "ERR_LEGACY_MIGRATION_STATE") { throw new LegacyPermitMigrationError(code); }
const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
function integer(value, min = 0) { if (!Number.isSafeInteger(value) || value < min || Object.is(value, -0)) fail(); return value; }
function text(value) { if (typeof value !== "string" || !value || value.length > 4096 || Buffer.from(value).toString("utf8") !== value) fail(); return value; }
function digest(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; }
function map(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (keys.length > LIMITS.records || keys.some(key => ["__proto__", "constructor", "prototype"].includes(key))) fail();
  return keys;
}
function exact(value, fields) { const keys = map(value); if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail(); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function json(input, max = LIMITS.evidenceBytes) {
  // Encoded string only: never reflect on Proxy/accessor/toJSON inputs.
  if (typeof input !== "string") fail("ERR_LEGACY_MIGRATION_INPUT");
  if (input.length > max || Buffer.byteLength(input) > max) fail("ERR_LEGACY_MIGRATION_LIMIT");
  if (Buffer.from(input).toString("utf8") !== input) fail("ERR_LEGACY_MIGRATION_INPUT");
  let depth = 0, quoted = false;
  for (let i = 0; i < input.length; i++) {
    if (quoted && input[i] === "\\") { i++; continue; }
    if (input[i] === '"') { quoted = !quoted; continue; }
    if (!quoted && (input[i] === "{" || input[i] === "[")) { if (++depth > LIMITS.depth) fail("ERR_LEGACY_MIGRATION_LIMIT"); }
    if (!quoted && (input[i] === "}" || input[i] === "]")) depth--;
  }
  // Frozen JSON.stringify output has integer numeric tokens only. Do not
  // accept fractional/exponent tokens that Number parsing can silently round.
  for (const token of input.matchAll(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (token[0][0] !== '"' && !/^-?(?:0|[1-9]\d*)$/.test(token[0])) fail();
  }
  try { return parseJson(input); } catch { fail("ERR_LEGACY_MIGRATION_JSON"); }
}
function list(value) { if (!Array.isArray(value) || !value.length || value.length > LIMITS.records) fail("ERR_LEGACY_MIGRATION_EVIDENCE"); }
function same(left, right) { if (canonical(left) !== canonical(right)) fail(); }
function stateCheck(s) {
  exact(s, ["schema_version", "scope", "decision_id", "service_epoch", "fencing", "lease_seq", "permit_seq", "last_clock_ms", "lease",
    "lease_idempotency", "permits", "idempotency", "desktop", "tombstones", "anchor_sequence", "store_id", "anchor_mode", "service_identity"]);
  if (s.schema_version !== 1 || s.scope !== PROTECTED_SCOPE) fail("ERR_LEGACY_MIGRATION_SOURCE_FORMAT");
  text(s.decision_id); text(s.store_id);
  if (!["strict", "permissive"].includes(s.anchor_mode) || !(s.service_identity === null || typeof s.service_identity === "string")) fail();
  if (s.service_identity !== null) text(s.service_identity);
  integer(s.service_epoch, 1); integer(s.fencing, 1); integer(s.lease_seq, 1); integer(s.permit_seq, 1); integer(s.last_clock_ms);
  if (integer(s.anchor_sequence, 1) === Number.MAX_SAFE_INTEGER) fail("ERR_LEGACY_MIGRATION_LIMIT");
  exact(s.desktop, ["status", "key"]);
  if (s.desktop.status !== "free" || s.desktop.key !== null) fail("ERR_LEGACY_MIGRATION_UNRESOLVED");
  const leases = new Map();
  const leaseKeys = map(s.lease_idempotency), permits = map(s.permits), idempotency = map(s.idempotency), tombstones = map(s.tombstones);
  if (permits.length > LIMITS.permits || leaseKeys.length > LIMITS.permits) fail("ERR_LEGACY_MIGRATION_LIMIT");
  if (leaseKeys.length !== s.lease_seq || permits.length !== s.permit_seq || idempotency.length !== permits.length) fail("ERR_LEGACY_MIGRATION_ORPHAN");
  for (const key of leaseKeys) {
    const lease = s.lease_idempotency[key]; exact(lease, LEASE);
    if (!["released", "revoked", "expired"].includes(lease.status)) fail("ERR_LEGACY_MIGRATION_UNRESOLVED");
    for (const field of LEASE.filter(field => !["serviceEpoch", "fencing", "expiresAt", "ttlMs", "endedAt"].includes(field))) text(lease[field]);
    integer(lease.serviceEpoch, 1); integer(lease.fencing, 1); integer(lease.ttlMs, 1); integer(lease.expiresAt, 1); integer(lease.endedAt);
    const number = Number(lease.leaseId.slice(PROTECTED_LEASE_PREFIX.length)); integer(number, 1);
    if (lease.leaseId !== PROTECTED_LEASE_PREFIX + number || number > s.lease_seq || leases.has(lease.leaseId) ||
        key !== lease.idempotencyKey || lease.serviceEpoch > s.service_epoch || lease.fencing > s.fencing || lease.endedAt > s.last_clock_ms) fail("ERR_LEGACY_MIGRATION_ORPHAN");
    if (lease.status === "expired" && lease.endedAt < lease.expiresAt) fail();
    // release() calls activeLease against the final expiry, whereas revoked
    // may come from recovery/restart after expiry. Do not conflate those paths.
    if (lease.status === "released" && lease.endedAt >= lease.expiresAt) fail();
    leases.set(lease.leaseId, lease);
  }
  if (!s.lease || s.lease.leaseId !== PROTECTED_LEASE_PREFIX + s.lease_seq || !leases.has(s.lease.leaseId)) fail("ERR_LEGACY_MIGRATION_ORPHAN");
  same(s.lease, leases.get(s.lease.leaseId));
  let previousFence = 0, previousEpoch = 0;
  for (let number = 1; number <= s.lease_seq; number++) {
    const lease = leases.get(PROTECTED_LEASE_PREFIX + number);
    if (!lease || lease.fencing <= previousFence || lease.serviceEpoch < previousEpoch) fail("ERR_LEGACY_MIGRATION_ORPHAN");
    previousFence = lease.fencing; previousEpoch = lease.serviceEpoch;
  }
  if (previousFence >= s.fencing) fail(); // Every accepted lease is already ended.
  for (const key of permits) {
    const p = s.permits[key];
    if (!p || !["finished", "failed", "revoked", "expired"].includes(p.status)) fail("ERR_LEGACY_MIGRATION_UNRESOLVED");
    const dispatched = p.status === "finished" || p.status === "failed";
    exact(p, [...PERMIT, ...(dispatched ? ["consumedAt", "finishedAt"] : [])]);
    for (const field of [...BINDING.filter(field => !["serviceEpoch", "fencing"].includes(field)), "operation", "idempotencyKey"]) text(p[field]);
    digest(p.targetDigest); digest(p.paramsDigest); integer(p.sequence, 1); integer(p.deadline, 1); integer(p.serviceEpoch, 1); integer(p.fencing, 1);
    const lease = leases.get(p.leaseId);
    if (!lease || p.sequence > s.permit_seq || key !== "P-PERMIT-" + p.sequence || p.permitId !== key ||
        !Object.hasOwn(s.idempotency, p.idempotencyKey) || s.idempotency[p.idempotencyKey] !== key || BINDING.some(field => p[field] !== lease[field])) fail("ERR_LEGACY_MIGRATION_ORPHAN");
    if (dispatched) {
      integer(p.consumedAt); integer(p.finishedAt);
      // Frozen v1 consumes at deadline equality; do not reinterpret its history
      // using current v2's >= boundary for NEW reservations.
      // Every subsequent renew also requires an active lease and sets expiry
      // to now + positive TTL. With a nondecreasing clock, the FINAL expiry
      // must still be strictly after consumption, even if renew shortened it
      // below the original permit deadline. finish/recover need not be before it.
      if (p.consumedAt > p.deadline || p.consumedAt >= lease.expiresAt || p.consumedAt > p.finishedAt || p.consumedAt > lease.endedAt || p.finishedAt > s.last_clock_ms || Object.hasOwn(s.tombstones, key)) fail();
    } else {
      const tombstone = s.tombstones[key]; exact(tombstone, ["reason", "at"]); integer(tombstone.at);
      if (tombstone.at > s.last_clock_ms || (p.status === "expired" ? tombstone.reason !== "deadline" || tombstone.at <= p.deadline
        : tombstone.reason !== lease.status || tombstone.at !== lease.endedAt)) fail();
    }
  }
  for (const key of idempotency) { text(key); if (!Object.hasOwn(s.permits, s.idempotency[key]) || s.permits[s.idempotency[key]].idempotencyKey !== key) fail("ERR_LEGACY_MIGRATION_ORPHAN"); }
  for (const key of tombstones) if (!Object.hasOwn(s.permits, key) || !["revoked", "expired"].includes(s.permits[key].status)) fail("ERR_LEGACY_MIGRATION_ORPHAN");
}
const entryHash = e => hash([e.schema_version, e.type, e.sequence, e.body_digest, e.store_id, e.attempt].join("\n"));
const waterHash = e => hash([e.sequence, e.body_digest, e.store_id, e.attempt].join("\n"));
function evidenceCheck(input, state) {
  list(input.journal); list(input.high_water); list(input.audit);
  const pairs = new Map();
  for (const e of input.journal) {
    exact(e, ["schema_version", "type", "sequence", "body_digest", "store_id", "attempt", "entry_digest"]);
    integer(e.sequence, 1); digest(e.body_digest); digest(e.entry_digest);
    // First implementation supports a complete unambiguous attempt1 prefix.
    // Retries, aborts, recovery extensions or dangling attempts are not erased.
    if (e.schema_version !== 1 || e.attempt !== 1 || !["intent", "commit"].includes(e.type) || e.store_id !== state.store_id ||
        e.sequence > state.anchor_sequence || e.entry_digest !== entryHash(e)) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
    const pair = pairs.get(e.sequence) || {};
    if (pair[e.type]) fail("ERR_LEGACY_MIGRATION_EVIDENCE"); pair[e.type] = e; pairs.set(e.sequence, pair);
  }
  if (pairs.size !== state.anchor_sequence) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
  for (let n = 1; n <= pairs.size; n++) {
    const pair = pairs.get(n);
    if (!pair || !pair.intent || !pair.commit || pair.intent.body_digest !== pair.commit.body_digest) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
  }
  if (pairs.get(state.anchor_sequence).commit.body_digest !== input.source.sha256) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
  let mark = 0;
  for (const e of input.high_water) {
    exact(e, ["sequence", "body_digest", "store_id", "attempt", "record_digest"]); integer(e.sequence, 1); digest(e.record_digest);
    const pair = pairs.get(e.sequence);
    // This supported subset has no authenticated compaction receipt: a final
    // high-water mark cannot prove that the intervening history existed.
    if (!pair || e.sequence !== mark + 1 || e.store_id !== state.store_id || e.attempt !== 1 || e.body_digest !== pair.commit.body_digest || e.record_digest !== waterHash(e)) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
    mark = e.sequence;
  }
  if (mark !== state.anchor_sequence) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
  const audited = new Set();
  for (const e of input.audit) {
    exact(e, ["schema_version", "at", "store_id", "event", "sequence", "body_digest"]);
    integer(e.sequence, 2);
    const pair = pairs.get(e.sequence);
    if (!pair || e.schema_version !== 1 || e.event !== "transaction" || e.store_id !== state.store_id ||
        typeof e.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.at) || !Number.isFinite(Date.parse(e.at)) || new Date(e.at).toISOString() !== e.at ||
        e.body_digest !== pair.commit.body_digest || audited.has(e.sequence)) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
    audited.add(e.sequence);
  }
  for (let n = 2; n <= pairs.size; n++) if (!audited.has(n)) fail("ERR_LEGACY_MIGRATION_EVIDENCE");
}
function replaceHeader(body, nextSequence) {
  // Replace only the two root numeric tokens; preserve all other original
  // UTF8 JSON bytes, including opaque binding strings and nested spelling.
  const tokens = [...body.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)];
  let depth = 0; const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i][0];
    if (t === "{" || t === "[") depth++;
    else if (t === "}" || t === "]") depth--;
    else if (depth === 1 && t[0] === '"' && tokens[i + 1]?.[0] === ":") {
      const key = JSON.parse(t);
      if (key === "schema_version" || key === "anchor_sequence") {
        const value = tokens[i + 2]; ranges.push({ start: value.index, end: value.index + value[0].length, text: String(key === "schema_version" ? 2 : nextSequence) });
      }
    }
  }
  if (ranges.length !== 2) fail();
  for (const r of ranges.sort((a, b) => b.start - a.start)) body = body.slice(0, r.start) + r.text + body.slice(r.end);
  return body;
}

function prepareLegacyPermitMigration(encodedEvidence) {
  const input = json(encodedEvidence);
  exact(input, ["format_version", "source", "expected", "journal", "high_water", "audit"]);
  exact(input.source, ["user_version", "body", "sha256"]);
  exact(input.expected, ["decision_id", "store_id", "body_digest", "anchor_sequence"]);
  if (input.format_version !== 1 || input.source.user_version !== 1) fail("ERR_LEGACY_MIGRATION_SOURCE_FORMAT");
  const state = json(input.source.body, LIMITS.bodyBytes); stateCheck(state);
  if (hash(input.source.body) !== digest(input.source.sha256) || input.expected.body_digest !== input.source.sha256 ||
      state.store_id !== input.expected.store_id || state.decision_id !== input.expected.decision_id || state.anchor_sequence !== input.expected.anchor_sequence) fail("ERR_LEGACY_MIGRATION_IDENTITY");
  evidenceCheck(input, state);
  const body = replaceHeader(input.source.body, state.anchor_sequence + 1), targetState = json(body, LIMITS.bodyBytes);
  same(targetState, { ...state, schema_version: 2, anchor_sequence: state.anchor_sequence + 1 });
  const next = { sequence: targetState.anchor_sequence, body_digest: hash(body), store_id: state.store_id, attempt: 1 };
  const intent = { schema_version: 1, type: "intent", ...next }; intent.entry_digest = entryHash(intent);
  const commit = { schema_version: 1, type: "commit", ...next }; commit.entry_digest = entryHash(commit);
  const highWater = { ...next, record_digest: waterHash(next) };
  return freeze({ status: "prepared-only", executionAuthorized: false, source_evidence_digest: hash(encodedEvidence),
    source: input.source, target: { user_version: 2, body, sha256: hash(body) }, append: { intent, commit, high_water: highWater } });
}
function verifyLegacyPermitMigrationTarget(encodedEvidence, encodedTarget) {
  const prepared = prepareLegacyPermitMigration(encodedEvidence), target = json(encodedTarget, LIMITS.evidenceBytes);
  exact(target, ["user_version", "body", "sha256"]);
  same(target, prepared.target);
  return prepared; // Same prepared bytes, never increment an already-schema2 source.
}

module.exports = { FROZEN_SOURCE_SHA256, LIMITS, LegacyPermitMigrationError, prepareLegacyPermitMigration, verifyLegacyPermitMigrationTarget };
