"use strict";

// TEST ONLY: reuse the current offline format1 schema/canonical/signature rules.
// The detached frame's version is translated solely to call the isolated v1
// offline codec. This is not wire negotiation, fallback or production routing.
// No key generation, certificate access, network, persistence or host dispatch.
const fs = require("node:fs");
const wire = require("../../../lib/coordination/permit-witness-wire");
const contract = require("../../../lib/coordination/permit-witness-contract");
const crypto = require("node:crypto");
const input = JSON.parse(fs.readFileSync(0, "utf8"));

function detached(hex) {
  const bytes = Buffer.from(hex, "hex");
  if (bytes[4] !== 2) throw new Error("ERR_TEST_VERSION");
  bytes[4] = 1;
  return bytes;
}
function fixtures() {
  // Public-only RFC 8032 test material, not a certificate or usable signer.
  const der = Buffer.from("302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
  const pem = crypto.createPublicKey({ key: der, format: "der", type: "spki" })
    .export({ format: "pem", type: "spki" }).toString();
  const checkpoint = { format_version: 1, authority_id: "test-authority", target_id: "target-a",
    store_generation: "test-generation", revision: 2, full_state_digest: "a".repeat(64) };
  const args = { targetId: "target-a", requestId: "registration-1", checkpoint: null,
    pin: { decision_id: "test-decision", instance_id: "target-a",
      fingerprint: crypto.createHash("sha256").update(der).digest("hex"), public_key_pem: pem,
      source_digest: "source", deployment_digest: "deployment", run_id: "test-run",
      generation: "1", valid_from: 1, valid_until: 100000 } };
  const body = { format_version: 1, action: "register", args };
  const request = wire.encodeRequest({ operation: 2, requestId: "00112233-4455-6677-8899-aabbccddeeff", body });
  const statuses = ["committed", "rejected", "unknown", "unavailable"];
  const responses = statuses.map((status, index) => wire.encodeResponse(request, {
    status, commit: index === 0 ? "confirmed" : index === 2 ? "unknown" : "not-attempted",
    mode: "development-only", executionAuthorized: false,
    ...(index === 0 ? { result: { registered: true, reused: false, checkpoint, executionAuthorized: false } }
      : { code: "ERR_TEST_REFUSAL" }),
  }).subarray(23).toString("hex"));
  const lease = { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
    generation: "1", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease-1", ttlMs: 5000 };
  const permit = { idempotencyKey: "permit-1", operation: "invoke", targetDigest: "a".repeat(64),
    paramsDigest: "b".repeat(64), ttlMs: 2000 };
  const message = { lease_id: "lease", session_id: "session", host_identity: "host", worker_identity: "worker",
    run_id: "run", generation: "1", desktop_key: "desktop", owned_app_id: "app", service_epoch: 1,
    fencing: 1, operation: "invoke", target_digest: "a".repeat(64), params_digest: "b".repeat(64),
    sequence: 1, issued_at_ms: 1000, deadline_ms: 3000, permit_id: "permit-1" };
  const consume = { format_version: 1, action: "consume", args: { targetId: "target-a", checkpoint,
    message, signature: Buffer.alloc(64).toString("base64") } }; // Syntax only, never authority dispatch.
  const consumeRequest = wire.encodeRequest({ operation: 2, requestId: "00112233-4455-6677-8899-aabbccddeeff", body: consume });
  const consumeResponse = wire.encodeResponse(consumeRequest, { status: "committed", commit: "confirmed",
    mode: "development-only", executionAuthorized: false, result: { status: "consumed", permitId: "permit-1",
      checkpoint: { ...checkpoint, revision: 3 }, executionAuthorized: false } });
  const issue = { format_version: 1, action: "issue", args: { targetId: "target-a", checkpoint,
    lease, permit, batchFingerprint: args.pin.fingerprint } };
  const issueRequest = wire.encodeRequest({ operation: 2, requestId: "00112233-4455-6677-8899-aabbccddeeff", body: issue });
  const issueUnavailable = wire.encodeResponse(issueRequest, { status: "unavailable", commit: "not-attempted",
    mode: "development-only", executionAuthorized: false, code: "ERR_TEST_REFUSAL" });
  const badIssueResult = { fingerprint: args.pin.fingerprint, publicKeyPem: pem, executionAuthorized: false,
    signedPermit: { message, signature: Buffer.alloc(64).toString("base64"), sequence: 1, deadline: 3000,
      issuedAt: 1000, nowMs: 1000, bytes: contract.canonicalBytes(message).toString("base64") } };
  return { request: contract.canonicalBytes(body).toString("hex"), responses,
    consume: contract.canonicalBytes(consume).toString("hex"), consumeResponse: consumeResponse.subarray(23).toString("hex"),
    issue: contract.canonicalBytes(issue).toString("hex"), issueUnavailable: issueUnavailable.subarray(23).toString("hex"),
    issueInvalidSignature: contract.canonicalBytes({ format_version: 1, status: "committed", commit: "confirmed",
      mode: "development-only", executionAuthorized: false, result: badIssueResult }).toString("hex"),
    checkpoint: contract.canonicalBytes({ format_version: 1, targetId: "target-a", checkpoint }).toString("hex") };
}
try {
  if (input.fixtures) process.stdout.write(JSON.stringify(fixtures()));
  else {
    const request = detached(input.request);
    if (input.response) wire.decodeResponse(detached(input.response), request);
    else wire.decodeRequest(request);
    process.stdout.write("OK");
  }
} catch { process.exitCode = 1; }
