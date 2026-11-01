"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const wire = require("../../lib/coordination/permit-witness-wire");
const frame = require("../../lib/coordination/permit-witness-frame");
const contract = require("../../lib/coordination/permit-witness-contract");
const delivery = require("../../lib/coordination/permit-delivery");
const { createPermitWitnessHost } = require("../../lib/coordination/permit-witness-host");
const { signRevocationList } = require("../../lib/coordination/permit-revocation-signing");

const ID = "00112233-4455-6677-8899-aabbccddeeff";
const OTHER = "ffeeddcc-bbaa-9988-7766-554433221100";
const key = delivery.createBatchKeyPair();
const pin = { decision_id: "D-test", instance_id: "target-a", fingerprint: key.fingerprint,
  public_key_pem: key.publicKeyPem, source_digest: "sha256:source", deployment_digest: "sha256:deployment",
  run_id: "run", generation: "1", valid_from: 1, valid_until: 100000 };
const lease = { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
  generation: "1", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease-1", ttlMs: 5000 };
const permit = { idempotencyKey: "permit-1", operation: "invoke", targetDigest: "a".repeat(64),
  paramsDigest: "b".repeat(64), ttlMs: 2000 };
function checkpoint(revision = 2) {
  return { format_version: 1, authority_id: "authority", target_id: "target-a", store_generation: "store-generation",
    revision, full_state_digest: "c".repeat(64) };
}
function register() { return { targetId: "target-a", requestId: "registration-1", checkpoint: null, pin: { ...pin } }; }
function issue() {
  return { targetId: "target-a", checkpoint: checkpoint(), lease: { ...lease }, permit: { ...permit },
    batchFingerprint: key.fingerprint };
}
function message() {
  return { lease_id: "lease", session_id: lease.sessionId, host_identity: lease.hostId, worker_identity: lease.workerId,
    run_id: lease.runId, generation: lease.generation, desktop_key: lease.desktopKey, owned_app_id: lease.ownedAppId,
    service_epoch: 1, fencing: 1, operation: permit.operation, target_digest: permit.targetDigest,
    params_digest: permit.paramsDigest, sequence: 1, issued_at_ms: 1000, deadline_ms: 3000, permit_id: "permit-1" };
}
function consume() {
  const m = message();
  return { targetId: "target-a", checkpoint: checkpoint(), message: m,
    signature: key.privateKeyRef.sign(delivery.canonicalBytes(m)).toString("base64") };
}
function request(action = "register", args = register(), requestId = ID) {
  return wire.encodeRequest({ operation: frame.OPERATIONS.transition, requestId,
    body: { format_version: 1, action, args } });
}
function raw(payload, options = {}) {
  return frame.encodeFrame({ direction: "request", operation: 2, requestId: ID,
    payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload), ...options });
}
function refused(fn, code) { assert.throws(fn, code ? { code } : undefined); }
function success(result) {
  return { status: "committed", commit: "confirmed", mode: "development-only", executionAuthorized: false, result };
}
function registered() { return success({ registered: true, reused: false, checkpoint: checkpoint(), executionAuthorized: false }); }
function rawResponse(req, body, status = 0, options = {}) {
  const r = wire.decodeRequest(req);
  return frame.encodeFrame({ direction: "response", operation: r.operation, requestId: r.requestId, status,
    payload: Buffer.isBuffer(body) ? body : contract.canonicalBytes({ format_version: 1, ...body }), ...options });
}

test("all real request parameters survive the codec; UUID is correlation, not registration idempotency", () => {
  for (const [action, args] of [["register", register()], ["issue", issue()], ["consume", consume()]]) {
    const encoded = request(action, args, ID.toUpperCase());
    const decoded = wire.decodeRequest(encoded), mapped = wire.toHostRequest(encoded);
    assert.equal(decoded.operation, 2); assert.equal(decoded.requestId, ID);
    assert.deepEqual(mapped, { requestId: ID, action, args });
    assert.ok(Object.isFrozen(mapped.args)); assert.notEqual(mapped.args, args);
    assert.equal(Object.hasOwn(mapped, "identity"), false);
  }
  assert.equal(wire.toHostRequest(request()).args.requestId, "registration-1");
  const args = issue(); args.permit.targetDigest = "A".repeat(64);
  assert.equal(wire.toHostRequest(request("issue", args)).args.permit.targetDigest, "A".repeat(64));
});

test("UUID syntax/version and bounded frame lengths come from the existing frame codec", () => {
  for (const requestId of [undefined, "", "00112233", ID + "\n", ID.replace("0", "z")]) {
    refused(() => request("register", register(), requestId === undefined ? null : requestId));
  }
  // The frame contract deliberately does not assume a UUID version/variant.
  assert.equal(wire.decodeRequest(request("register", register(), "00000000-0000-0000-0000-000000000000")).requestId,
    "00000000-0000-0000-0000-000000000000");
  const changed = request(); changed[4] = 2;
  refused(() => wire.decodeRequest(changed), "ERR_WITNESS_FRAME_PROTOCOL");
  refused(() => wire.decodeRequest(Buffer.concat([request(), request()])));
  refused(() => wire.decodeRequest(request().subarray(0, -1)));
});

test("checkpoint syntax is bounded but no history or state operation is fabricated", () => {
  const encoded = wire.encodeRequest({ operation: 1, requestId: ID,
    body: { format_version: 1, targetId: "target-a", checkpoint: checkpoint() } });
  assert.equal(wire.decodeRequest(encoded).operation, 1);
  refused(() => wire.toHostRequest(encoded), "ERR_WITNESS_WIRE_CHECKPOINT_QUERY_UNSUPPORTED");
  refused(() => wire.encodeResponse(encoded, registered()), "ERR_WITNESS_WIRE_CHECKPOINT_QUERY_UNSUPPORTED");
  for (const operation of ["register_pin", "accept_permit", "observe_clock", "apply_revocation"]) {
    refused(() => request(operation));
  }
});

test("raw canonical JSON rejects duplicate keys at every depth, including escaped names", () => {
  const valid = contract.canonicalBytes(wire.decodeRequest(request()).body).toString();
  const invalid = [valid.replace('"action":"register"', '"action":"register","action":"register"'),
    valid.replace('"targetId":"target-a"', '"targetId":"target-a","targetId":"target-a"'),
    valid.replace('"run_id":"run"', '"run_id":"run","run_id":"run"'),
    valid.replace('"action":"register"', '"action":"consume","\\u0061ction":"register"'),
    '{"x":[{"a":1,"a":2}]}'];
  for (const input of invalid) refused(() => wire.decodeRequest(raw(input)), "ERR_WITNESS_WIRE_NONCANONICAL");
});

test("reject whitespace, alternate key/string/number spellings, malformed JSON and multiple values", () => {
  const valid = contract.canonicalBytes(wire.decodeRequest(request()).body).toString();
  for (const input of [valid + "\n", valid + " ", valid.replace('{', '{ '),
    valid.replace('"action":"register"', '"action":"regist\\u0065r"'),
    valid.replace('"format_version":1', '"format_version":1.0'),
    valid.replace('"format_version":1', '"format_version":1e0'),
    '{"z":1,"a":2}', '{"x":-0}', '{"x":0.1}', '{"x":9007199254740993}', '{"x":1e999}',
    '{"x":NaN}', '{}{}', '{', '{}\uFEFF', '{"x":"\n"}', '{"x":}', '{"x":1,}']) {
    refused(() => wire.decodeRequest(raw(input)));
  }
  for (const prefix of [Buffer.from("\uFEFF"), Buffer.from(" ")]) {
    const encoded = raw("{}");
    const changed = Buffer.concat([encoded.subarray(0, 22), prefix, encoded.subarray(22)]);
    changed.writeUInt32BE(changed.length - 4);
    refused(() => wire.decodeRequest(changed));
  }
});

test("fatal UTF-8 rejects replacement attacks, overlong/truncated sequences and surrogate encodings", () => {
  for (const bytes of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80], [0x80]]) {
    const input = Buffer.concat([Buffer.from('{"x":"'), Buffer.from(bytes), Buffer.from('"}')]);
    refused(() => wire.decodeRequest(raw(input)), "ERR_WITNESS_WIRE_JSON");
  }
  const args = register(); args.pin.source_digest = "中文😀\ud800é e\u0301\ufffd";
  assert.equal(wire.toHostRequest(request("register", args)).args.pin.source_digest, args.pin.source_digest);
});

test("contract string/depth/node/entry and total byte ceilings are enforced on original input", () => {
  const args = register(); args.pin.source_digest = "x".repeat(contract.LIMITS.stringBytes);
  assert.equal(wire.toHostRequest(request("register", args)).args.pin.source_digest.length, contract.LIMITS.stringBytes);
  args.pin.source_digest += "x";
  refused(() => request("register", args));
  for (const payload of ['{"x":"' + "x".repeat(65537) + '"}',
    '{"x":' + "[".repeat(18) + "0" + "]".repeat(18) + "}",
    '{"x":[' + Array(1025).fill("0").join(",") + "]}",
    '{"x":[' + Array(21).fill("[" + Array(1000).fill("0").join(",") + "]").join(",") + "]}"]) {
    refused(() => wire.decodeRequest(raw(payload)), "ERR_WITNESS_WIRE_JSON");
  }
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(frame.LIMITS.requestLength + 1);
  refused(() => wire.decodeRequest(oversized), "ERR_WITNESS_FRAME_SIZE");
  const boundary = Buffer.concat([Buffer.from("{"), Buffer.alloc(contract.LIMITS.bytes - 1, 32)]);
  refused(() => wire.decodeRequest(raw(boundary)), "ERR_WITNESS_WIRE_JSON");
  refused(() => raw(Buffer.alloc(contract.LIMITS.bytes + 1, 123)), "ERR_WITNESS_FRAME_SIZE");
});

test("exact schemas reject facts, identity, state, providers and unsigned authorization at every boundary", () => {
  for (const field of ["facts", "identity", "peer", "context", "principal", "verified", "state", "authorize",
    "executionAuthorized", "targetHasProcess", "revocation", "now_ms"]) {
    const body = { format_version: 1, action: "register", args: register(), [field]: true };
    refused(() => wire.decodeRequest(raw(contract.canonicalBytes(body))));
    const args = register(); args[field] = true;
    refused(() => request("register", args));
    const nested = register(); nested.pin[field] = true;
    refused(() => request("register", nested));
  }
  for (const value of [0, 2, "1", null]) {
    refused(() => wire.decodeRequest(raw(contract.canonicalBytes({ format_version: value, action: "register", args: register() }))));
  }
  for (const input of ["{}", '{"__proto__":{}}', "{\"constructor\":1}"]) refused(() => wire.decodeRequest(raw(input)));
  let invoked = false;
  const args = register(); Object.defineProperty(args, "pin", { enumerable: true, get() { invoked = true; return pin; } });
  refused(() => request("register", args)); assert.equal(invoked, false);
});

test("registration, issuance, consumption and checkpoint fields reject incompatible values", () => {
  const changes = [
    ["register", register, r => { delete r.pin.deployment_digest; }],
    ["register", register, r => { r.pin.instance_id = "other"; }],
    ["register", register, r => { r.pin.fingerprint = "0".repeat(64); }],
    ["register", register, r => { r.pin.public_key_pem = "-----BEGIN PRIVATE KEY-----"; }],
    ["register", register, r => { r.pin.valid_until = r.pin.valid_from; }],
    ["register", register, r => { r.pin.registered_at_ms = 1; }],
    ["register", register, r => { r.targetId = "__proto__"; }],
    ["register", register, r => { r.requestId = "x".repeat(129); }],
    ["issue", issue, r => { r.checkpoint = null; }],
    ["issue", issue, r => { r.checkpoint.target_id = "other"; }],
    ["issue", issue, r => { r.checkpoint.revision = 0; }],
    ["issue", issue, r => { r.checkpoint.full_state_digest = "x".repeat(64); }],
    ["issue", issue, r => { r.lease.ttlMs = -1; }],
    ["issue", issue, r => { r.lease.serviceEpoch = 1; }],
    ["issue", issue, r => { r.permit.ttlMs = 1.5; }],
    ["issue", issue, r => { r.permit.paramsDigest = "x"; }],
    ["consume", consume, r => { r.message.fencing = 0; }],
    ["consume", consume, r => { delete r.message.worker_identity; }],
    ["consume", consume, r => { r.message.deadline_ms = r.message.issued_at_ms; }],
    ["consume", consume, r => { r.signature = "AA=="; }],
    ["consume", consume, r => { r.signature += "\n"; }],
  ];
  for (const [action, factory, change] of changes) { const args = factory(); change(args); refused(() => request(action, args)); }
});

test("response statuses, UUID, operation, frame direction and exact result must agree", () => {
  const req = request(), ok = wire.encodeResponse(req, registered());
  const decoded = wire.decodeResponse(ok, req);
  assert.equal(decoded.status, "committed"); assert.equal(decoded.executionAuthorized, false);
  assert.ok(Object.isFrozen(decoded.result.checkpoint));
  for (const [status, commit] of [["rejected", "not-attempted"], ["unknown", "unknown"], ["unavailable", "not-attempted"]]) {
    const outcome = { status, commit, mode: "development-only", executionAuthorized: false, code: "ERR_TEST" };
    assert.deepEqual(wire.decodeResponse(wire.encodeResponse(req, outcome), req), { format_version: 1, ...outcome });
  }
  for (const options of [{ requestId: OTHER }, { operation: 1 }, { status: 1 }]) {
    refused(() => wire.decodeResponse(rawResponse(req, registered(), 0, options), req));
  }
  for (const patch of [{ mode: "production" }, { executionAuthorized: true }, { commit: "unknown" },
    { status: "unknown" }, { facts: {} }, { result: { ...registered().result, executionAuthorized: true } },
    { result: { ...registered().result, registered: true, reused: true } }]) {
    refused(() => wire.decodeResponse(rawResponse(req, { ...registered(), ...patch }), req));
  }
  for (const result of [
    { ...registered().result, checkpoint: { ...checkpoint(), target_id: "other" } },
    { ...registered().result, checkpoint: { ...checkpoint(), revision: 1 } },
    { ...registered().result, checkpoint: { ...checkpoint(), state: {} } },
  ]) refused(() => wire.decodeResponse(rawResponse(req, success(result)), req));
  refused(() => wire.encodeResponse(req, { format_version: 1, ...registered() }));
  for (const patch of [{ result: {} }, { commit: "confirmed" }, { code: "server says ok" }]) {
    const body = { status: "rejected", commit: "not-attempted", mode: "development-only",
      executionAuthorized: false, code: "ERR_REJECTED", ...patch };
    refused(() => wire.decodeResponse(rawResponse(req, body, 1), req));
  }
  refused(() => wire.decodeResponse(req, req));
  refused(() => wire.decodeRequest(ok));
  for (const bytes of [ok.subarray(0, -1), Buffer.concat([ok, Buffer.from([0])]), Buffer.concat([ok, ok])]) {
    refused(() => wire.decodeResponse(bytes, req));
  }
  const badStatus = Buffer.from(ok); badStatus[22] = 4;
  refused(() => wire.decodeResponse(badStatus, req));
  const validBody = contract.canonicalBytes({ format_version: 1, ...registered() }).toString();
  for (const text of [validBody + "\n", validBody.replace('"status":"committed"', '"status":"committed","status":"committed"')]) {
    refused(() => wire.decodeResponse(rawResponse(req, Buffer.from(text)), req));
  }
  const invalidUtf8 = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  refused(() => wire.decodeResponse(rawResponse(req, invalidUtf8), req), "ERR_WITNESS_WIRE_JSON");
  const unknown = { status: ["unknown"], commit: "unknown", mode: "development-only",
    executionAuthorized: false, code: "ERR_TEST" };
  const malformed = rawResponse(req, unknown, wire.STATUS.unknown);
  refused(() => wire.decodeResponse(malformed, req));
  refused(() => wire.encodeResponse(req, unknown));
  const exchange = new wire.WireExchange(req);
  exchange.append(malformed);
  refused(() => exchange.finish());
  assert.equal(exchange.outcome.status, "unknown");
  const requestBody = { format_version: 1, action: ["consume"], args: consume() };
  refused(() => wire.decodeRequest(raw(contract.canonicalBytes(requestBody))));
});

test("a syntactically valid but forged issuance signature or changed signed resource is refused", () => {
  const req = request("issue", issue());
  function outcome(m = message(), signer = key) {
    const bytes = delivery.canonicalBytes(m);
    return success({ fingerprint: key.fingerprint, publicKeyPem: key.publicKeyPem, executionAuthorized: false,
      signedPermit: { message: m, signature: signer.privateKeyRef.sign(bytes).toString("base64"),
        bytes: bytes.toString("base64"), sequence: m.sequence, deadline: m.deadline_ms,
        issuedAt: m.issued_at_ms, nowMs: m.issued_at_ms } });
  }
  assert.equal(wire.decodeResponse(wire.encodeResponse(req, outcome()), req).status, "committed");
  refused(() => wire.encodeResponse(req, outcome(message(), delivery.createBatchKeyPair())));
  for (const field of ["session_id", "host_identity", "worker_identity", "run_id", "generation", "desktop_key",
    "owned_app_id", "operation", "target_digest", "params_digest"]) {
    const m = message(); m[field] = field.endsWith("digest") ? "0".repeat(64) : "other";
    refused(() => wire.decodeResponse(rawResponse(req, outcome(m)), req));
  }
  const bad = outcome(); bad.result.signedPermit.bytes = "e30=";
  refused(() => wire.encodeResponse(req, bad));
});

test("exchange waits for clean EOF, tolerates segmentation, and latches unknown after any failure", () => {
  const req = request(), response = wire.encodeResponse(req, registered());
  for (let split = 0; split <= response.length; split += 1) {
    const exchange = new wire.WireExchange(req);
    exchange.append(response.subarray(0, split)); exchange.append(response.subarray(split));
    assert.equal(exchange.outcome, null);
    assert.equal(exchange.finish().status, "committed");
    refused(() => exchange.finish(), "ERR_WITNESS_WIRE_CLOSED");
    assert.equal(exchange.abort().status, "committed");
  }
  for (const partial of [Buffer.alloc(0), response.subarray(0, 3), response.subarray(0, -1), response]) {
    const exchange = new wire.WireExchange(req); exchange.append(partial);
    const unknown = exchange.abort(); // deadline/cancellation/reset, even after complete data but before EOF
    assert.equal(unknown.status, "unknown"); assert.equal(unknown.commit, "unknown");
    assert.equal(unknown.executionAuthorized, false); assert.equal(exchange.abort(), unknown);
    refused(() => exchange.append(response), "ERR_WITNESS_WIRE_CLOSED");
    refused(() => exchange.finish(), "ERR_WITNESS_WIRE_CLOSED");
    assert.equal(exchange.outcome, unknown);
  }
  for (const bad of [response.subarray(0, -1), Buffer.concat([response, response]),
    rawResponse(req, { ...registered(), executionAuthorized: true }),
    rawResponse(req, registered(), 0, { requestId: OTHER })]) {
    const exchange = new wire.WireExchange(req);
    refused(() => { exchange.append(bad); exchange.finish(); });
    assert.equal(exchange.outcome.status, "unknown");
    refused(() => exchange.append(response));
  }
  const owned = Buffer.from(req), exchange = new wire.WireExchange(owned);
  owned.fill(0); exchange.append(response);
  assert.equal(exchange.finish().status, "committed");
});

test("real development host performs register/issue/consume with independent context and atomic store state", {
  skip: Number(process.versions.node.split(".")[0]) < 24 || process.platform === "win32",
}, t => {
  const base = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "permit-witness-wire-"));
  fs.mkdirSync(path.join(root, "db")); fs.mkdirSync(path.join(root, "anchor"));
  const resources = { targetId: "target-a", pin, lease: Object.fromEntries(Object.entries(lease)
    .filter(([name]) => !["idempotencyKey", "ttlMs"].includes(name))),
  permit: { operation: permit.operation, targetDigest: permit.targetDigest, paramsDigest: permit.paramsDigest },
  maxLeaseTtlMs: lease.ttlMs, maxPermitTtlMs: permit.ttlMs };
  let observations = 0, signatures = 0, pulls = 0, alive = true;
  const host = createPermitWitnessHost({ backend: "development-witness", mode: "development-only", access: "initialize",
    file: path.join(root, "db", "authority.sqlite"), authorityId: "authority", clock: () => 1000,
    storeOptions: { decisionId: pin.decision_id, anchorDir: path.join(root, "anchor"), anchorMode: "permissive" },
    providers: {
      observeTarget() { observations++; return { targetHasProcess: false, targetHasPriorRun: false }; },
      signPermit(fingerprint, reserved, now) {
        signatures++;
        return { fingerprint, publicKeyPem: key.publicKeyPem,
          signedPermit: delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit: reserved, issuedAtMs: now, nowMs: now }) };
      },
      pullRevocation(_target, current, now) {
        pulls++;
        return signRevocationList({ ...key, issuedAtMs: now, fingerprints: [],
          state: { appliedRevocationSequence: current.state.applied_revocation_sequence,
            revokedFingerprints: new Set(current.state.revoked_fingerprints) } });
      },
    } });
  t.after(() => { host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const identity = Object.freeze({ opaque: "trusted-local-session" });
  const context = host.createContext({ identity, principal: "owner", actions: ["register", "issue", "consume"], resources,
    isCurrent: actual => actual === identity && alive });
  function dispatch(action, args, suppliedContext = context) {
    const req = request(action, args), mapped = wire.toHostRequest(req);
    const outcome = host.dispatch(suppliedContext, mapped.action, mapped.args);
    return wire.decodeResponse(wire.encodeResponse(req, outcome), req);
  }
  assert.equal(dispatch("register", register(), {}).status, "rejected");
  assert.equal(observations, 0);
  const registeredResult = dispatch("register", register());
  assert.equal(registeredResult.status, "committed"); assert.equal(observations, 1);
  const args = issue(); args.checkpoint = registeredResult.result.checkpoint;
  for (const field of Object.keys(resources.lease)) {
    const forged = structuredClone(args); forged.lease[field] = "caller-claimed-resource";
    assert.equal(dispatch("issue", forged).status, "rejected");
  }
  for (const field of Object.keys(resources.permit)) {
    const forged = structuredClone(args);
    forged.permit[field] = field.endsWith("Digest") ? "0".repeat(64) : "caller-operation";
    assert.equal(dispatch("issue", forged).status, "rejected");
  }
  assert.equal(signatures, 0);
  const issued = dispatch("issue", args);
  assert.equal(issued.status, "committed"); assert.equal(signatures, 1);
  const use = { targetId: args.targetId, checkpoint: args.checkpoint,
    message: issued.result.signedPermit.message, signature: issued.result.signedPermit.signature };
  const consumeBytes = request("consume", use), exchange = new wire.WireExchange(consumeBytes);
  const mapped = wire.toHostRequest(consumeBytes);
  const committed = host.dispatch(context, mapped.action, mapped.args);
  // Simulate lost response AFTER commit: the caller must stay unknown despite
  // the real atomic consume and the subsequently available success bytes.
  assert.equal(exchange.abort().status, "unknown");
  const response = wire.encodeResponse(consumeBytes, committed);
  refused(() => exchange.append(response), "ERR_WITNESS_WIRE_CLOSED");
  assert.equal(exchange.outcome.status, "unknown");
  const consumed = wire.decodeResponse(response, consumeBytes); // independent offline evidence only
  assert.equal(consumed.status, "committed"); assert.equal(consumed.result.status, "consumed");
  assert.equal(pulls, 1); assert.equal(consumed.result.checkpoint.revision, args.checkpoint.revision + 1);
  for (const result of [registeredResult, issued, consumed]) {
    assert.equal(result.executionAuthorized, false); assert.equal(result.result.executionAuthorized, false);
  }
  // Independent read-only evidence of the SAME transaction, never input facts.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(root, "db", "authority.sqlite"), { readOnly: true });
  let state;
  try { state = JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id = 1").get().body); }
  finally { db.close(); }
  const id = use.message.permit_id;
  assert.equal(state.permits[id].status, "consumed");
  assert.equal(state.witness_authority.issuance_bindings[id].status, "consumed");
  assert.deepEqual(state.witness_authority.targets[args.targetId].current.checkpoint, consumed.result.checkpoint);
  alive = false;
  assert.equal(dispatch("issue", args).status, "rejected");
  assert.equal(signatures, 1); assert.equal(pulls, 1);
});
