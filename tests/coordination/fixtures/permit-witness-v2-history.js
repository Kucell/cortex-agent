"use strict";

// Dedicated synthetic offline fixtures. Keys are generated in memory, never
// loaded from credentials or persisted; no host, store, child or network I/O.
const crypto = require("node:crypto");
const delivery = require("../../../lib/coordination/permit-delivery");
const contract = require("../../../lib/coordination/permit-witness-contract");
const wire = require("../../../lib/coordination/permit-witness-v2-history-wire");
const frame = require("../../../lib/coordination/permit-witness-v2-frame");
const ID = "00112233-4455-6677-8899-aabbccddeeff", OTHER = "ffeeddcc-bbaa-9988-7766-554433221100";
const key = delivery.createBatchKeyPair();
const canonical = value => contract.canonicalBytes(value);
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
function checkpoint(revision = 4) {
  return { format_version: 1, authority_id: "authority", target_id: "target-a", store_generation: "target-generation",
    revision, full_state_digest: "c".repeat(64) };
}
function query(operation = "register") {
  const lease = { owner: "original-owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
    generation: "generation", desktopKey: "desktop", ownedAppId: "app" };
  const permit = { operation: "invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64) };
  const base = { operation, decisionId: "decision", authorityId: "authority", issuerStoreId: "issuer-store",
    targetGeneration: operation === "register" ? null : "target-generation",
    resources: { fingerprint: key.fingerprint, lease: operation === "register" ? null : lease,
      permit: operation === "register" ? null : permit } };
  let request;
  if (operation === "register") request = { targetId: "target-a", requestId: "registration", checkpoint: null,
    pin: { decision_id: "decision", instance_id: "target-a", fingerprint: key.fingerprint, public_key_pem: key.publicKeyPem,
      source_digest: "source", deployment_digest: "deployment", run_id: "run", generation: "generation", valid_from: 0, valid_until: 10000 } };
  else if (operation === "issue") request = { targetId: "target-a", checkpoint: checkpoint(2), batchFingerprint: key.fingerprint,
    lease: { ...lease, idempotencyKey: "lease-key", ttlMs: 5000 },
    permit: { ...permit, idempotencyKey: "permit-key", ttlMs: 2000 } };
  else {
    const message = { lease_id: "lease-1", session_id: "session", host_identity: "host", worker_identity: "worker",
      run_id: "run", generation: "generation", desktop_key: "desktop", owned_app_id: "app", service_epoch: 1,
      fencing: 1, sequence: 1, operation: "invoke", target_digest: permit.targetDigest, params_digest: permit.paramsDigest,
      issued_at_ms: 1000, deadline_ms: 3000, permit_id: "permit-1" };
    request = { targetId: "target-a", checkpoint: checkpoint(2), message,
      signature: key.privateKeyRef.sign(delivery.canonicalBytes(message)).toString("base64") };
  }
  return { ...base, request };
}
function request(q = query(), requestId = ID) {
  return wire.encodeRequest({ operation: 2, requestId, body: { format_version: 2, action: "history.query", args: q } });
}
const safety = () => ({ mode: "development-only", executionAuthorized: false, resumeAllowed: false, originalRequestOutcome: "unknown" });
function outcome(q = query(), status = "observed", found = true) {
  const base = { status, commit: "not-applicable", ...safety() };
  if (status !== "observed") return { ...base, code: "ERR_TEST_HISTORY" };
  let effect = null;
  if (found) {
    if (q.operation === "register") effect = { kind: "registration", registered: true, reused: false,
      checkpoint: checkpoint(2), requestDigest: digest(q.request), requestMatch: "full-request-digest", historicalPrincipal: "not-recorded" };
    else if (q.operation === "issue") effect = { kind: "issuance", permitId: "permit-1", status: "issued",
      requestDigest: digest({ targetId: q.request.targetId, lease: q.request.lease, permit: q.request.permit,
        fingerprint: q.request.batchFingerprint }), requestMatch: "business-effect-only", inputCheckpoint: "not-recorded", historicalPrincipal: "not-recorded" };
    else effect = { kind: "consumption", permitId: q.request.message.permit_id, atMs: 1500, checkpoint: checkpoint(3),
      requestMatch: "business-effect-only", inputCheckpoint: "not-recorded", fullRequestDigest: "not-recorded", historicalPrincipal: "not-recorded" };
  }
  return { ...base, result: { status: found ? "found" : "not-found-at-boundary", operation: q.operation, ...safety(), effect,
    boundary: { decisionId: q.decisionId, authorityId: q.authorityId, issuerStoreId: q.issuerStoreId, serviceEpoch: 1,
      anchorSequence: 5, bodyDigest: "d".repeat(64), journalSequence: 5, highWaterSequence: 4 },
    currentCheckpoint: checkpoint(), clockPoisoned: false } };
}
function raw(payload, response = false, overrides = {}) {
  return frame.encodeFrame({ direction: response ? "response" : "request", operation: 2, requestId: ID,
    ...(response ? { status: 0 } : {}), payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload), ...overrides });
}
module.exports = { ID, OTHER, query, checkpoint, request, outcome, raw, canonical, digest };
