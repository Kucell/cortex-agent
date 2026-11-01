"use strict";

// Isolated in-memory fixtures only; no production identities, stores or TLS.
const delivery = require("../../../lib/coordination/permit-delivery");
const wire = require("../../../lib/coordination/permit-witness-v2-wire");
const frame = require("../../../lib/coordination/permit-witness-v2-frame");
const { SingleExchange, ExchangeBudget } = require("../../../lib/coordination/permit-witness-v2-exchange");
const ID = "00112233-4455-6677-8899-aabbccddeeff";
const OTHER = "ffeeddcc-bbaa-9988-7766-554433221100";
const key = delivery.createBatchKeyPair();
function checkpoint(revision = 2) {
  return { format_version: 1, authority_id: "test-authority", target_id: "target-a",
    store_generation: "test-generation", revision, full_state_digest: "c".repeat(64) };
}
function args(action = "register") {
  if (action === "register") return { targetId: "target-a", requestId: "registration-1", checkpoint: null,
    pin: { decision_id: "test-decision", instance_id: "target-a", fingerprint: key.fingerprint,
      public_key_pem: key.publicKeyPem, source_digest: "test-source", deployment_digest: "test-deployment",
      run_id: "run", generation: "1", valid_from: 1, valid_until: 100000 } };
  if (action === "issue") return { targetId: "target-a", checkpoint: checkpoint(),
    lease: { owner: "test-owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
      generation: "1", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease-key", ttlMs: 5000 },
    permit: { idempotencyKey: "permit-key", operation: "invoke", targetDigest: "a".repeat(64),
      paramsDigest: "b".repeat(64), ttlMs: 2000 }, batchFingerprint: key.fingerprint };
  const m = message();
  return { targetId: "target-a", checkpoint: checkpoint(), message: m,
    signature: key.privateKeyRef.sign(delivery.canonicalBytes(m)).toString("base64") };
}
function message() {
  return { lease_id: "lease", session_id: "session", host_identity: "host", worker_identity: "worker",
    run_id: "run", generation: "1", desktop_key: "desktop", owned_app_id: "app", service_epoch: 1,
    fencing: 1, operation: "invoke", target_digest: "a".repeat(64), params_digest: "b".repeat(64), sequence: 1,
    issued_at_ms: 1000, deadline_ms: 3000, permit_id: "permit-1" };
}
function request(action = "register", input = args(action), requestId = ID) {
  return wire.encodeRequest({ operation: 2, requestId, body: { format_version: 1, action, args: input } });
}
function outcome(status = "committed", action = "register") {
  const base = { status, commit: status === "committed" ? "confirmed" : status === "unknown" ? "unknown" : "not-attempted",
    mode: "development-only", executionAuthorized: false };
  if (status !== "committed") return { ...base, code: "ERR_TEST_RESULT" };
  let result;
  if (action === "register") result = { registered: true, reused: false, checkpoint: checkpoint(), executionAuthorized: false };
  else if (action === "consume") result = { status: "consumed", permitId: "permit-1", checkpoint: checkpoint(3), executionAuthorized: false };
  else {
    const m = message(), bytes = delivery.canonicalBytes(m);
    result = { fingerprint: key.fingerprint, publicKeyPem: key.publicKeyPem, executionAuthorized: false,
      signedPermit: { message: m, signature: key.privateKeyRef.sign(bytes).toString("base64"),
        sequence: 1, deadline: 3000, issuedAt: 1000, bytes: bytes.toString("base64"), nowMs: 1000 } };
  }
  return { ...base, result };
}
function raw(payload, response = false, overrides = {}) {
  return frame.encodeFrame({ direction: response ? "response" : "request", operation: 2, requestId: ID,
    ...(response ? { status: 0 } : {}), payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload), ...overrides });
}
function clock() {
  let at = 1000n;
  return { now: () => at, set(value) { at = value; }, advance(value) { at += value; } };
}
function exchange(role, extra = {}) {
  const time = clock(), budget = new ExchangeBudget();
  const instance = new SingleExchange({ role, ...(role === "client" ? { requestBytes: request() } : {}),
    deadlineNs: 2000n, now: time.now, budget, ...extra });
  return { instance, time, budget };
}
function sentClient(extra) { const f = exchange("client", extra); f.instance.takeRequest(); f.instance.sent(); return f; }
function types(instance) { return instance.diagnostics.events.map(e => e.type); }

module.exports = { ID, OTHER, key, checkpoint, args, request, outcome, raw, clock, exchange, sentClient, types };
