"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  createSyntheticPublication, canonicalEffectTuple, SIGNED_FIELDS, BARRIER_PARTS, sqliteSigningCodec,
} = require("../../lib/coordination/permit-phase-a-synthetic-publication");

function authority() {
  return { principalId: "synthetic-principal", grantId: "grant-1", storeGeneration: "store-1",
    lifecycleVersion: "lifecycle-1", reservationId: "reservation-1", checkpoint: "checkpoint-0",
    signerFingerprint: "synthetic-public-hash-only", serviceEpoch: 1, fencing: 2,
    authorized: true, revoked: false, registration: "active" };
}
function request() {
  return { attemptId: "attempt-1", tuple: { origin_authority_namespace: "origin-1", original_permit_id: "permit-1" },
    message: { lease_id: "lease-1", session_id: "session-1", host_identity: "host-1",
      worker_identity: "worker-1", run_id: "run-1", generation: 1, desktop_key: "desktop-1",
      owned_app_id: "app-1", service_epoch: 1, fencing: 2, operation: "synthetic-increment",
      target_digest: "a".repeat(64), params_digest: "b".repeat(64), sequence: 1,
      issued_at_ms: 100, deadline_ms: 200, permit_id: "permit-1" },
    authority: authority(), effect: { target: "synthetic-counter", params: { delta: 1 } },
    businessVersion: 1, actionFingerprint: "synthetic-action-1", finalCheckpoint: "checkpoint-1" };
}
function model() {
  return createSyntheticPublication({ namespace: "origin-1", serviceId: "service-1", authority: authority(), nowMs: 100 });
}
const ID = "attempt-1";
function admitted() { const m = model(); m.admit(request()); return m; }
function prepared() { const m = admitted(); m.prepare(ID); return m; }
function signed() { const m = prepared(); m.armSignCall(ID); m.invokeSigner(ID); return m; }
function committed() { const m = signed(); m.beginCommit(ID); m.commit(ID); return m; }
function evidence(m, scope, omit) {
  const binding = m.evidenceBinding(ID, scope);
  for (const part of BARRIER_PARTS) if (part !== omit) m.recordEvidence(ID, scope, { part, binding });
}
function qualified() { const m = committed(); evidence(m, "business"); m.qualify(ID); return m; }
function ready() { const m = qualified(); evidence(m, "eligibility"); return m; }
function error(code) { return { code }; }

// Fixed UTF-8 vector, independently enumerated in signed-name order. Expected
// digests were calculated with Python hashlib, not this module's encoder.
const SIGNED_VECTOR = '{"deadline_ms":200,"desktop_key":"desktop-1","fencing":2,"generation":1,"host_identity":"host-1","issued_at_ms":100,"lease_id":"lease-1","operation":"synthetic-increment","owned_app_id":"app-1","params_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","permit_id":"permit-1","run_id":"run-1","sequence":1,"service_epoch":1,"session_id":"session-1","target_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","worker_identity":"worker-1"}';

test("SQLite signing codec shares prepare bytes and public fixture hash; it grants no persistent calling rights", () => {
  const input = request(), body = sqliteSigningCodec.prepare(input), decoded = sqliteSigningCodec.inspect(body);
  assert.equal(Buffer.from(decoded.prepared.raw, "base64").toString(), SIGNED_VECTOR);
  assert.equal(decoded.prepared.digest, "4c2b7a0a447097feec4d0ab7178f0d4c8858178b732a0b117cb21a5c3d078186");
  assert.equal(sqliteSigningCodec.hashPrepared(body).toString("base64"), "89+1cVr9doPV0zO67pEp+QdlDegYryQgJXeYvoK+BU4=");
  const m = prepared(); assert.deepEqual(decoded.prepared, m.inspect(ID).prepared);
  input.message.issued_at_ms = 101; assert.equal(sqliteSigningCodec.inspect(body).request.message.issued_at_ms, 100);
  for (const mutate of [p => { p.prepared.raw = ""; }, p => { delete p.prepared.raw; }, p => { p.prepared.digest = "a".repeat(64); },
    p => { p.request.message.lease_id = "other"; }, p => { p.semanticFormat = 0; }]) {
    const p = JSON.parse(body); mutate(p); assert.throws(() => sqliteSigningCodec.inspect(JSON.stringify(p)));
  }
  let calls = 0; const proxy = new Proxy(input, { ownKeys() { calls++; throw Error("must not run"); } });
  assert.throws(() => sqliteSigningCodec.prepare(proxy), error("DATA_ONLY")); assert.equal(calls, 0);
  assert.equal(sqliteSigningCodec.arm, undefined); assert.equal(sqliteSigningCodec.publish, undefined);
});

test("independent fixed 14+3 signing-input bytes survive prepare, commit and restart", () => {
  const m = prepared();
  assert.equal(Buffer.from(m.inspect(ID).prepared.raw, "base64").toString("utf8"), SIGNED_VECTOR);
  assert.equal(m.inspect(ID).prepared.digest, "4c2b7a0a447097feec4d0ab7178f0d4c8858178b732a0b117cb21a5c3d078186");
  m.armSignCall(ID); m.invokeSigner(ID); m.beginCommit(ID); m.commit(ID); evidence(m, "business");
  const restarted = m.restart(101), output = restarted.publish(ID, restarted.inspect(ID).requestDigest);
  assert.equal(Buffer.from(output.bytes, "base64").toString("utf8"), SIGNED_VECTOR);
  assert.equal(output.syntheticSignature, "synthetic-sha256:89+1cVr9doPV0zO67pEp+QdlDegYryQgJXeYvoK+BU4=");
});

for (const change of [a => { a.revoked = true; }, a => { a.authorized = false; },
  a => { a.registration = "registration-pending"; }, a => { a.grantId = "grant-2"; },
  a => { a.lifecycleVersion = "lifecycle-2"; }, a => { a.checkpoint = "checkpoint-other"; }]) {
  test(`authority ABA cannot resurrect old binding: ${change}`, () => {
    let m = ready(); const original = m.inspect(ID), before = m.inspectLedger().authorityVersion;
    const next = authority(); change(next); m.setAuthority(next);
    assert.equal(m.inspectLedger().authorityVersion, before + 1);
    assert.equal(m.inspectLedger().authorityTombstones, 1);
    assert.throws(() => m.setAuthority(authority()), error("AUTHORITY_TOMBSTONED"));
    m = m.restart(101);
    assert.throws(() => m.setAuthority(authority()), error("AUTHORITY_TOMBSTONED"));
    assert.throws(() => m.publish(ID, original.requestDigest)); assert.throws(() => m.dispatchSynthetic(ID));
    assert.deepEqual(m.inspect(ID).result, original.result); assert.equal(m.inspectLedger().receipts, 0);
    assert.equal(m.inspectLedger().authorityVersion, before + 1);
  });
}

test("authority version is owner assigned; fence regressions and stale manifests fail closed", () => {
  const m = prepared(), before = m.inspectLedger(), plan = migration(m);
  m.setAuthority(authority()); assert.equal(m.inspectLedger().authorityVersion, before.authorityVersion);
  const next = authority(); next.fencing = 3; m.setAuthority(next);
  assert.throws(() => m.setAuthority({ ...next, fencing: 2 }), error("AUTHORITY_REGRESSION"));
  assert.throws(() => m.setAuthority({ ...next, serviceEpoch: 0 }));
  assert.throws(() => m.setAuthority({ ...next, authorityVersion: 999 }), error("INVALID_FIELDS"));
  assert.throws(() => m.armSignCall(ID)); assert.throws(() => m.migrate(plan), error("MIGRATION_FROZEN"));
  assert.equal(m.inspectLedger().simulatedSignerCalls, 0);
});

test("revoked grant cannot be renewed by changing its lifecycle/fence; a new binding cannot revive old attempts", () => {
  let m = ready(); m.setAuthority({ ...authority(), revoked: true });
  const next = { ...authority(), lifecycleVersion: "lifecycle-2", fencing: 3 };
  assert.throws(() => m.setAuthority(next), error("GRANT_REVOKED"));
  next.grantId = "genuinely-new-grant"; m.setAuthority(next);
  assert.equal(m.inspectLedger().authorityVersion, 3);
  assert.throws(() => m.dispatchSynthetic(ID), error("AUTHORITY_INVALIDATED"));
  m = m.restart(101); assert.throws(() => m.publish(ID, m.inspect(ID).requestDigest), error("AUTHORITY_INVALIDATED"));
  assert.throws(() => m.setAuthority(authority())); assert.equal(m.inspectLedger().receipts, 0);
  assert.ok(m.inspect(ID).invalidation);
});

test("all reflective input boundaries reject Proxy and revoked Proxy before traps or owner reentry", () => {
  const m = ready(); let calls = 0;
  function proxy(value) {
    const trap = () => { calls++; m.restart(101); throw Error("trap must not execute"); };
    return new Proxy(value, { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap });
  }
  const before = m.migrationManifest();
  const nested = request(); nested.attemptId = "proxy-attempt"; nested.effect = proxy(nested.effect);
  const array = request(); array.effect.params = proxy([]);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const bind = m.evidenceBinding(ID, "business");
  for (const invoke of [() => m.admit(proxy(request())), () => m.admit(nested), () => m.admit(array),
    () => m.admit(revoked.proxy), () => m.setAuthority(proxy(authority())),
    () => m.recordEvidence(ID, "business", { part: "db-wal", binding: proxy(bind) }),
    () => m.migrate(proxy(migration(m))), () => canonicalEffectTuple(proxy(request().tuple)),
    () => createSyntheticPublication(proxy({})), () => m.inspect(proxy({}))]) {
    assert.throws(invoke); assert.equal(calls, 0); assert.deepEqual(m.migrationManifest(), before);
  }
  assert.equal(m.dispatchSynthetic(ID).applications, 1);
});

for (const [stage, build] of [["prepared", prepared], ["call-gate", () => {
  const m = prepared(); m.armSignCall(ID); return m;
}], ["signed", signed], ["ready", ready]]) {
  test(`running wall-clock rollback poisons ${stage}, including forward time and restart`, () => {
    let m = build(); const count = m.inspectLedger().simulatedSignerCalls;
    const manifest = m.migrationManifest();
    assert.throws(() => m.advanceTo(99), error("CLOCK_ROLLBACK"));
    assert.equal(m.inspectLedger().clockPoisoned, true); assert.notDeepEqual(m.migrationManifest(), manifest);
    if (stage === "prepared") assert.throws(() => m.armSignCall(ID), error("CLOCK_POISONED"));
    if (stage === "call-gate") assert.throws(() => m.invokeSigner(ID), error("SIGN_CALL_ALREADY_POSSIBLE"));
    if (stage === "signed") assert.throws(() => m.beginCommit(ID), error("CANDIDATE_MISSING"));
    assert.throws(() => m.publish(ID, m.inspect(ID).requestDigest), error("CLOCK_POISONED"));
    assert.throws(() => m.dispatchSynthetic(ID), error("CLOCK_POISONED"));
    m.advanceTo(101); m.setAuthority(authority()); m = m.restart(102);
    assert.equal(m.inspectLedger().clockPoisoned, true);
    assert.throws(() => m.armSignCall(ID)); assert.throws(() => m.invokeSigner(ID));
    assert.throws(() => m.beginCommit(ID)); assert.throws(() => m.publish(ID, m.inspect(ID).requestDigest), error("CLOCK_POISONED"));
    assert.throws(() => m.dispatchSynthetic(ID), error("CLOCK_POISONED"));
    assert.equal(m.inspectLedger().simulatedSignerCalls, count); assert.equal(m.inspectLedger().receipts, 0);
  });
}

test("unknown canonical effect cannot escape by replacing permit, sequence, label or business version", () => {
  const m = prepared().restart(101); const before = m.inspectLedger();
  for (const businessVersion of [1, 2]) {
    const r = request(); r.attemptId = `relabel-${businessVersion}`; r.message.permit_id = "permit-2";
    r.tuple.original_permit_id = "permit-2"; r.message.sequence = 2;
    r.actionFingerprint = "arbitrary-new-label"; r.businessVersion = businessVersion;
    // Object insertion order cannot give the same counter effect a new identity.
    r.effect = { params: { delta: 1 }, target: "synthetic-counter" };
    assert.throws(() => m.admit(r), error("ACTION_QUARANTINED"));
  }
  assert.equal(m.inspect(ID).outcome, "sign-outcome-unknown");
  assert.equal(m.inspectLedger().attempts, before.attempts); assert.equal(m.inspectLedger().receipts, 0);
  assert.equal(m.inspectLedger().simulatedSignerCalls, 0);
});

test("unsupported effect shapes cannot masquerade as another semantic identity", () => {
  const m = model();
  for (const effect of [null, {}, [], "synthetic-counter", { target: "counter-alias", params: { delta: 1 } },
    { target: "synthetic-counter", params: { delta: 1, alias: true } },
    { target: "synthetic-counter", params: { delta: 0 } }]) {
    const r = request(); r.effect = effect; assert.throws(() => m.admit(r));
  }
  const r = request(); r.message.operation = "arbitrary-effect"; assert.throws(() => m.admit(r));
  assert.equal(m.inspectLedger().attempts, 0);
});

test("isolated model advertises simulation and never grants real execution", () => {
  const m = ready();
  const result = m.publish(ID, m.inspect(ID).requestDigest);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.authority, false);
  assert.equal(result.durability, "in-memory-simulation");
  assert.match(result.syntheticSignature, /^synthetic-sha256:/);
  assert.equal(m.dispatchSynthetic(ID).executionAuthorized, false);
});

test("prepare stores exact canonical 14+3 bytes; metadata is outside signed message", () => {
  const m = model(); const input = request(); m.admit(input);
  input.message.deadline_ms = 999; input.effect.params.delta = 99;
  const before = m.prepare(ID);
  const bytes = Buffer.from(before.prepared.raw, "base64");
  const expected = request().message;
  const canonical = `{${Object.keys(expected).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(expected[k])}`).join(",")}}`;
  assert.equal(bytes.toString(), canonical);
  assert.deepEqual(Object.keys(JSON.parse(bytes)).sort(), [...SIGNED_FIELDS].sort());
  assert.equal(SIGNED_FIELDS.length, 17);
  assert.equal(before.prepared.digest, createHash("sha256").update(bytes).digest("hex"));
  before.prepared.raw = "changed"; before.prepared.authority.grantId = "changed";
  m.armSignCall(ID); m.invokeSigner(ID); m.beginCommit(ID); m.commit(ID); evidence(m, "business");
  const result = m.publish(ID, m.inspect(ID).requestDigest);
  assert.equal(result.bytes, bytes.toString("base64"));
  assert.equal(result.message.deadline_ms, 200);
  assert.equal(m.inspectLedger().simulatedSignerCalls, 1);
});

for (const mutation of [
  r => { delete r.message.fencing; }, r => { r.message.extra = "forbidden"; },
  r => { r.message.deadline_ms = 100; }, r => { r.message.sequence = 0; },
  r => { r.message.target_digest = "wrong"; }, r => { r.tuple.original_permit_id = "other"; },
  r => { r.authority.fencing = 3; },
]) test(`malformed admission ${mutation.toString()} has no signer/ledger side effect`, () => {
  const m = model(); const r = request(); mutation(r);
  assert.throws(() => m.admit(r));
  assert.equal(m.inspectLedger().attempts, 0);
  assert.equal(m.inspectLedger().simulatedSignerCalls, 0);
});

test("data copying rejects getters without calling them, thenables and oversized inputs", () => {
  const m = model(); const r = request(); let calls = 0;
  Object.defineProperty(r.effect, "callback", { enumerable: true, get() { calls++; return 1; } });
  assert.throws(() => m.admit(r), error("DATA_ONLY")); assert.equal(calls, 0);
  const thenable = request(); thenable.effect = { then() { calls++; } };
  assert.throws(() => m.admit(thenable), error("DATA_ONLY")); assert.equal(calls, 0);
  const huge = request(); huge.effect = "x".repeat(65537);
  assert.throws(() => m.admit(huge));
  assert.equal(m.inspectLedger().attempts, 0);
});

test("single owner can invoke signer at most once, no diagnostics expose signature", () => {
  const m = prepared();
  assert.throws(() => m.invokeSigner(ID), error("INVALID_TRANSITION"));
  m.armSignCall(ID); m.invokeSigner(ID);
  assert.throws(() => m.invokeSigner(ID), error("SIGN_CALL_ALREADY_POSSIBLE"));
  assert.throws(() => m.armSignCall(ID), error("INVALID_TRANSITION"));
  assert.equal(m.inspectLedger().simulatedSignerCalls, 1);
  assert.ok(!JSON.stringify(m.inspect(ID)).includes("syntheticSignature"));
  assert.throws(() => m.publish(ID, m.inspect(ID).requestDigest), error("NOT_COMMITTED"));
});

const stages = [
  ["admitted", admitted, "sign-outcome-unknown", 0],
  ["prepared", prepared, "sign-outcome-unknown", 0],
  ["armed before signer", () => { const m = prepared(); m.armSignCall(ID); return m; }, "sign-outcome-unknown", 0],
  ["private candidate", signed, "sign-outcome-unknown", 1],
  ["commit gate", () => { const m = signed(); m.beginCommit(ID); return m; }, "commit-outcome-unknown", 1],
  ["business commit", committed, "db-committed", 1],
  ["business barrier", () => { const m = committed(); evidence(m, "business"); return m; }, "db-committed", 1],
  ["eligibility commit", qualified, "db-committed", 1],
  ["eligibility barrier", ready, "db-committed", 1],
];
for (const [stage, build, outcome, count] of stages) test(`heap crash/restart at ${stage} retains conservative state and loses old owner`, () => {
  const old = build(); const before = old.inspect(ID); const m = old.restart(101);
  assert.equal(m.inspect(ID).outcome, outcome);
  assert.throws(() => old.inspect(ID), error("STALE_OWNER"));
  assert.throws(() => old.commit(ID), error("STALE_OWNER"));
  assert.throws(() => m.invokeSigner(ID), error("INVALID_TRANSITION"));
  assert.equal(m.inspectLedger().simulatedSignerCalls, count);
  assert.throws(() => m.admit(request()), error("ATTEMPT_ID_REUSED"));
  if (before.prepared) assert.deepEqual(m.inspect(ID).prepared, before.prepared);
  if (stage !== "eligibility barrier") assert.throws(() => m.dispatchSynthetic(ID));
  else assert.equal(m.dispatchSynthetic(ID).applications, 1);
});

test("lost call gate or missing original bytes never permits signer retry", () => {
  const m = signed(); m.simulateLoss(ID, "call-gate");
  assert.equal(m.inspect(ID).outcome, "sign-outcome-unknown");
  assert.throws(() => m.armSignCall(ID), error("INVALID_TRANSITION"));
  const p = prepared(); p.simulateLoss(ID, "prepared-bytes");
  assert.throws(() => p.armSignCall(ID), error("PREPARE_MISSING"));
  assert.equal(p.inspectLedger().simulatedSignerCalls, 0);
  assert.equal(p.inspect(ID).outcome, "aborted");
});

test("missing atomic result after commit is unknown, never inferred rolled back", () => {
  const old = committed(); old.simulateLoss(ID, "result"); const m = old.restart(101);
  assert.equal(m.inspect(ID).outcome, "commit-outcome-unknown");
  m.cancel(ID);
  assert.equal(m.inspect(ID).outcome, "commit-outcome-unknown");
  assert.throws(() => m.commit(ID), error("INVALID_TRANSITION"));
  assert.throws(() => m.publish(ID, m.inspect(ID).requestDigest), error("NOT_COMMITTED"));
});

for (const build of [admitted, prepared]) test(`cancel before call gate wins (${build.name})`, () => {
  const m = build(); m.cancel(ID); m.cancel(ID);
  assert.equal(m.inspect(ID).outcome, "aborted");
  assert.throws(() => m.armSignCall(ID), error("INVALID_TRANSITION"));
  const restarted = m.restart(101);
  assert.equal(restarted.inspect(ID).outcome, "aborted");
  assert.equal(restarted.inspectLedger().simulatedSignerCalls, 0);
});

test("cancel at call gate cannot claim signer was never called", () => {
  const m = prepared(); m.armSignCall(ID); m.cancel(ID);
  assert.equal(m.inspect(ID).outcome, "sign-outcome-unknown");
  assert.equal(m.inspectLedger().simulatedSignerCalls, 0);
  assert.throws(() => m.invokeSigner(ID), error("INVALID_TRANSITION"));
});

test("cancel before commit gate blocks it; cancel after gate cannot undo eventual commit", () => {
  const before = signed(); before.cancel(ID);
  assert.throws(() => before.beginCommit(ID), error("INVALID_TRANSITION"));
  const m = signed(); m.beginCommit(ID); m.cancel(ID); m.commit(ID);
  assert.equal(m.inspect(ID).outcome, "db-committed");
  assert.equal(m.inspect(ID).cancelRequested, true);
  evidence(m, "business"); assert.throws(() => m.qualify(ID), error("CANCELLED"));
  assert.equal(m.publish(ID, m.inspect(ID).requestDigest).delivery, "unknown");
});

test("cancel after qualification preserves business/eligibility facts and prevents effect", () => {
  const m = ready(); m.cancel(ID); m.cancel(ID);
  assert.equal(m.inspect(ID).outcome, "db-committed");
  assert.equal(m.inspect(ID).intent, "dispatch-eligible");
  assert.throws(() => m.dispatchSynthetic(ID), error("CANCELLED"));
  assert.equal(m.inspectLedger().receipts, 0);
});

for (const scope of ["business", "eligibility"]) for (const missing of BARRIER_PARTS) {
  test(`${scope} missing ${missing} blocks publication/dispatch without undoing commit`, () => {
    const m = scope === "business" ? committed() : qualified(); evidence(m, scope, missing);
    if (scope === "business") {
      assert.throws(() => m.qualify(ID), error("BARRIER_INCOMPLETE"));
      assert.throws(() => m.publish(ID, m.inspect(ID).requestDigest), error("BARRIER_INCOMPLETE"));
    }
    assert.throws(() => m.dispatchSynthetic(ID));
    assert.equal(m.inspect(ID).outcome, "db-committed");
    assert.equal(m.inspectLedger().receipts, 0);
  });
}

for (const key of ["attemptId", "dbSequence", "tuple", "canonicalTuple", "effectId", "requestDigest",
  "contentDigest", "resultDigest", "finalCheckpoint", "eligibilitySequence", "eligibilityDigest", "businessCertificateDigest"]) {
  test(`binding mismatch ${key} is rejected rather than treated as evidence`, () => {
    const m = qualified(); const b = m.evidenceBinding(ID, "eligibility");
    b[key] = typeof b[key] === "number" ? b[key] + 1 : "wrong";
    assert.throws(() => m.recordEvidence(ID, "eligibility", { part: BARRIER_PARTS[0], binding: b }), error("EVIDENCE_BINDING_MISMATCH"));
    assert.throws(() => m.dispatchSynthetic(ID), error("BARRIER_INCOMPLETE"));
  });
}

for (const scope of ["business", "eligibility"]) for (const key of ["canonicalAction", "authorityVersion"]) {
  test(`${scope} barrier rejects mismatched ${key} and cannot dispatch`, () => {
    const m = scope === "business" ? committed() : qualified();
    const part = "audit-name"; evidence(m, scope, part);
    const before = m.inspect(ID), binding = m.evidenceBinding(ID, scope);
    if (key === "canonicalAction") {
      // Change only the canonical bytes; retain its digest to test exact binding.
      binding.canonicalAction.raw = Buffer.from("different-canonical-action").toString("base64");
    } else binding.authorityVersion++;
    assert.throws(() => m.recordEvidence(ID, scope, { part, binding }), error("EVIDENCE_BINDING_MISMATCH"));
    assert.deepEqual(m.inspect(ID), before);
    if (scope === "business") {
      assert.throws(() => m.qualify(ID), error("BARRIER_INCOMPLETE"));
      assert.throws(() => m.publish(ID, before.requestDigest), error("BARRIER_INCOMPLETE"));
    }
    assert.throws(() => m.dispatchSynthetic(ID), error(scope === "business" ? "NOT_DISPATCH_ELIGIBLE" : "BARRIER_INCOMPLETE"));
    assert.equal(m.inspectLedger().receipts, 0);
    // The exact original binding completes the barrier and permits one effect.
    m.recordEvidence(ID, scope, { part, binding: m.evidenceBinding(ID, scope) });
    if (scope === "business") { m.qualify(ID); evidence(m, "eligibility"); }
    assert.equal(m.dispatchSynthetic(ID).applications, 1);
  });
}

test("claim rechecks both barriers even after qualification; restart cannot repair missing evidence", () => {
  const old = ready(); old.simulateLoss(ID, "business", "audit-name");
  assert.throws(() => old.dispatchSynthetic(ID), error("BARRIER_INCOMPLETE"));
  const m = old.restart(101);
  assert.throws(() => m.recordEvidence(ID, "business", { part: "audit-name", binding: m.evidenceBinding(ID, "business") }), error("RECOVERY_NOT_IMPLEMENTED"));
  assert.throws(() => m.dispatchSynthetic(ID), error("BARRIER_INCOMPLETE"));
});

test("partial qualification barrier cannot be completed by ordinary restarted owner", () => {
  const old = qualified(); evidence(old, "eligibility", "audit-content"); const m = old.restart(101);
  assert.throws(() => m.recordEvidence(ID, "eligibility", { part: "audit-content", binding: m.evidenceBinding(ID, "eligibility") }), error("RECOVERY_NOT_IMPLEMENTED"));
  assert.throws(() => m.dispatchSynthetic(ID), error("BARRIER_INCOMPLETE"));
});

test("lost response replays original bytes/signature only, never re-signs or reapplies", () => {
  const old = ready(); const digest = old.inspect(ID).requestDigest;
  const first = old.publish(ID, digest); const receipt = old.dispatchSynthetic(ID);
  const m = old.restart(101); const second = m.publish(ID, digest);
  assert.deepEqual(second, first); assert.deepEqual(m.dispatchSynthetic(ID), receipt);
  assert.equal(m.inspect(ID).delivery, "unknown");
  assert.equal(m.inspectLedger().simulatedSignerCalls, 1);
  assert.equal(m.inspectLedger().receipts, 1);
  assert.throws(() => m.publish(ID, "other-request"), error("REQUEST_BINDING_MISMATCH"));
});

for (const [field, value] of [["grantId", "grant-2"], ["storeGeneration", "store-2"],
  ["lifecycleVersion", "life-2"], ["reservationId", "reservation-2"], ["checkpoint", "checkpoint-other"],
  ["serviceEpoch", 2], ["fencing", 3], ["revoked", true], ["registration", "registration-pending"]]) {
  test(`final authorization gate rejects changed ${field}`, () => {
    const m = ready(); const next = authority(); next[field] = value; m.setAuthority(next);
    assert.throws(() => m.dispatchSynthetic(ID));
    assert.throws(() => m.publish(ID, m.inspect(ID).requestDigest));
    assert.equal(m.inspect(ID).outcome, "db-committed"); assert.equal(m.inspectLedger().receipts, 0);
  });
}

test("post-sign authorization failure preserves tombstone, expiry never refreshes prepared time", () => {
  const m = signed(); m.advanceTo(200);
  assert.throws(() => m.beginCommit(ID), error("EXPIRED"));
  assert.equal(m.inspect(ID).outcome, "aborted");
  assert.equal(JSON.parse(Buffer.from(m.inspect(ID).prepared.raw, "base64")).deadline_ms, 200);
  const p = ready(); p.advanceTo(200);
  assert.throws(() => p.dispatchSynthetic(ID), error("EXPIRED"));
  assert.throws(() => p.advanceTo(199), error("CLOCK_ROLLBACK"));
});

test("authorization is rechecked before signer and after commit gate, not just before dispatch", () => {
  const before = prepared(); const revoked = authority(); revoked.revoked = true;
  before.setAuthority(revoked);
  assert.throws(() => before.armSignCall(ID), error("NOT_AUTHORIZED"));
  assert.equal(before.inspectLedger().simulatedSignerCalls, 0);
  const after = signed(); after.beginCommit(ID); after.setAuthority(revoked);
  assert.throws(() => after.commit(ID), error("NOT_AUTHORIZED"));
  assert.equal(after.inspect(ID).outcome, "commit-outcome-unknown");
  assert.equal(after.inspect(ID).result, null);
  assert.throws(() => after.invokeSigner(ID), error("INVALID_TRANSITION"));
});

test("restart wall-clock rollback poisons model even after authority update", () => {
  const m = ready().restart(99); m.setAuthority(authority()); m.advanceTo(101);
  assert.throws(() => m.dispatchSynthetic(ID), error("CLOCK_POISONED"));
});

test("canonical tuple uses fixed domain and byte lengths, not separators or service identity", () => {
  const tuple = { origin_authority_namespace: "a", original_permit_id: "b" };
  const encoded = canonicalEffectTuple(tuple);
  const bytes = Buffer.concat([Buffer.from("cortex.phase-a.synthetic.effect-tuple.v1\0"),
    Buffer.from([0, 0, 0, 1]), Buffer.from("a"), Buffer.from([0, 0, 0, 1]), Buffer.from("b")]);
  assert.equal(encoded.canonicalTuple, bytes.toString("base64"));
  assert.equal(encoded.effectId, createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(canonicalEffectTuple({ origin_authority_namespace: "a:b", original_permit_id: "c" }).effectId,
    canonicalEffectTuple({ origin_authority_namespace: "a", original_permit_id: "b:c" }).effectId);
  assert.notEqual(canonicalEffectTuple({ origin_authority_namespace: "é", original_permit_id: "x" }).effectId,
    canonicalEffectTuple({ origin_authority_namespace: "e\u0301", original_permit_id: "x" }).effectId);
  assert.throws(() => canonicalEffectTuple({ origin_authority_namespace: "\ud800", original_permit_id: "x" }));
});

test("same tuple across retry attempts dedups, altered content conflicts, no new signing", () => {
  const m = ready(); const r = request(); r.attemptId = "retry-2";
  const duplicate = m.admit(r);
  assert.equal(duplicate.outcome, "duplicate"); assert.equal(duplicate.duplicateOf, ID);
  assert.equal(duplicate.effectId, m.inspect(ID).effectId);
  assert.throws(() => m.prepare("retry-2"), error("INVALID_TRANSITION"));
  const changed = request(); changed.attemptId = "retry-3"; changed.effect.params.delta = 2;
  assert.throws(() => m.admit(changed), error("CONTENT_CONFLICT"));
  const version = request(); version.attemptId = "retry-4"; version.businessVersion++;
  assert.throws(() => m.admit(version), error("CONTENT_CONFLICT"));
  const time = request(); time.attemptId = "retry-5"; time.message.issued_at_ms++;
  assert.throws(() => m.admit(time), error("CONTENT_CONFLICT"));
  assert.equal(m.inspectLedger().simulatedSignerCalls, 1);
});

test("same tuple with changed store/lifecycle binding conflicts, service identity alone does not rekey", () => {
  for (const field of ["storeGeneration", "lifecycleVersion"]) {
    const m = ready(); const next = authority(); next[field] = "new-version"; m.setAuthority(next);
    const r = request(); r.attemptId = "rebound-attempt"; r.authority = next;
    assert.throws(() => m.admit(r), error("CONTENT_CONFLICT"));
    assert.equal(m.inspectLedger().simulatedSignerCalls, 1);
  }
});

test("unknown action cannot be repackaged under new permit/namespace; sequence remains reserved", () => {
  const m = prepared().restart(101);
  const r = request(); r.attemptId = "attempt-2"; r.message.permit_id = "permit-2";
  r.tuple.original_permit_id = "permit-2";
  assert.throws(() => m.admit(r), error("ACTION_QUARANTINED"));
  r.tuple.origin_authority_namespace = "new-service-alias";
  assert.throws(() => m.admit(r), error("NAMESPACE_NOT_MANAGED"));
  r.tuple.origin_authority_namespace = "origin-1"; r.actionFingerprint = "genuinely-other-action";
  r.effect.params.delta = 2; // Actually different canonical effect, not just a new label.
  m.admit(r); assert.throws(() => m.prepare("attempt-2"), error("SEQUENCE_RESERVED"));
});

function migration(m, to = "service-2") {
  return { from: "service-1", to, nextFence: 2, manifest: m.migrationManifest(),
    oldManagerRevoked: true, fullHistoryLoaded: true };
}
test("service migration retains original tuple and receipts; old manager loses owner access", () => {
  const old = ready(); const before = old.dispatchSynthetic(ID);
  const m = old.migrate(migration(old));
  assert.throws(() => old.dispatchSynthetic(ID), error("STALE_OWNER"));
  assert.deepEqual(m.dispatchSynthetic(ID), before);
  assert.equal(m.inspect(ID).tuple.origin_authority_namespace, "origin-1");
  assert.equal(m.inspectLedger().serviceId, "service-2");
  assert.equal(m.inspectLedger().managementFence, 2);
  assert.equal(m.inspectLedger().receipts, 1);
  const retry = request(); retry.attemptId = "migrated-retry";
  assert.equal(m.admit(retry).effectId, before.effectId);
  assert.equal(m.inspectLedger().simulatedSignerCalls, 1);
});

for (const [name, change] of [
  ["missing history", v => { v.fullHistoryLoaded = false; }],
  ["old manager live", v => { v.oldManagerRevoked = false; }],
  ["stale head", v => { v.manifest.headVersion--; }],
  ["missing tombstones", v => { v.manifest.tombstoneCount++; }],
  ["cycle", v => { v.to = "service-1"; }],
  ["branch", v => { v.from = "unrelated-manager"; }],
  ["stale fence", v => { v.nextFence = 1; }],
]) test(`migration freezes ${name} without switching namespace or ledger`, () => {
  const m = prepared().restart(101); const input = migration(m); change(input);
  assert.throws(() => m.migrate(input), error("MIGRATION_FROZEN"));
  assert.equal(m.inspectLedger().serviceId, "service-1");
  assert.equal(m.inspect(ID).outcome, "sign-outcome-unknown");
});

test("migration manifest goes stale on ledger change and cannot erase unknown history", () => {
  const m = prepared(); const input = migration(m); m.cancel(ID);
  assert.throws(() => m.migrate(input), error("MIGRATION_FROZEN"));
  const next = m.migrate(migration(m));
  assert.equal(next.inspect(ID).outcome, "aborted");
  assert.equal(next.migrationManifest().tombstoneCount, 1);
});
