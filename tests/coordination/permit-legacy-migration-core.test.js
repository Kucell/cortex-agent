"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const core = require("../../lib/coordination/permit-legacy-migration-core");
const anchor = require("../../lib/coordination/protected-anchor");
const delivery = require("../../lib/coordination/permit-delivery");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || process.platform === "win32" };
let evidence, sameEpochEvidence, temporalEvidence, signed, publicKeyPem, rawV1, dir;
function compile(source) {
  const filename = require.resolve("../../lib/coordination/protected-permit-store"), module = new Module(filename);
  module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(source + "\nmodule.exports.testAssertState = assertState;\n", filename); return module.exports;
}
function readEvidence(file, anchorDir) {
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file, { readOnly: true });
  let row;
  try { row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get(); assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1); }
  finally { db.close(); }
  const state = JSON.parse(row.body);
  const journal = fs.readdirSync(anchorDir).filter(name => name.startsWith("protected-anchor-entry-") && !name.includes(".tmp-")).sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(anchorDir, name), "utf8")));
  const lines = name => fs.readFileSync(path.join(anchorDir, name), "utf8").trim().split("\n").map(JSON.parse);
  return { format_version: 1, source: { user_version: 1, ...row },
    expected: { decision_id: state.decision_id, store_id: state.store_id, body_digest: row.sha256, anchor_sequence: state.anchor_sequence },
    journal, high_water: lines(anchor.HIGH_WATER_FILE), audit: lines("protected-anchor-audit.log") };
}
test.before(() => {
  if (supported.skip) return;
  const source = fs.readFileSync(path.join(__dirname, "fixtures/protected-permit-store-v1-source.txt"), "utf8");
  assert.equal(hash(source), core.FROZEN_SOURCE_SHA256);
  rawV1 = compile(source);
  const runtime = path.resolve(__dirname, "../../.agent/runtime/test-tmp"); fs.mkdirSync(runtime, { recursive: true });
  dir = fs.mkdtempSync(path.join(runtime, "permit-legacy-core-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor"); fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  const file = path.join(dbDir, "state.sqlite"); let now = 1000;
  const old = rawV1.ProtectedPermitStore.initialize(file, { decisionId: "D-frozen", anchorDir, anchorMode: "permissive", clock: () => now, verifyRecovery: () => true });
  const lease = i => old.acquire({ owner: "fixture", sessionId: "s" + i, hostId: "h", workerId: "w", runId: "r", generation: "g",
    desktopKey: "desktop-" + i, ownedAppId: "a", idempotencyKey: "lease-" + i, ttlMs: 100 });
  const reserve = (l, i) => old.reserve({ ...l, idempotencyKey: "permit-" + i, operation: "invoke", targetDigest: String(i).repeat(64), paramsDigest: "b".repeat(64), ttlMs: 10 });
  try {
    const l1 = lease(1); old.renew({ ...l1, ttlMs: 150 }); const p1 = reserve(l1, 1);
    const key = delivery.createBatchKeyPair(); publicKeyPem = key.publicKeyPem;
    signed = delivery.buildSignedPermit({ privateKeyRef: key.privateKeyRef, permit: p1, issuedAtMs: now, nowMs: now });
    now = p1.deadline; old.consume(p1); old.finish({ ...p1, outcome: "finished" });
    assert.equal(old.consume(p1).status, "already-consumed");
    assert.equal(reserve(l1, 1).status, "finished"); // original idempotent result, never reserved anew
    assert.throws(() => old.reserve({ ...l1, workerId: "other", idempotencyKey: "permit-1", operation: "invoke",
      targetDigest: "1".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 10 }), { code: "ERR_IDEMPOTENCY_MISMATCH" });
    now++; old.release(l1); old.recover({ fixture: "completed" });
    now = 1020; const l2 = lease(2), p2 = reserve(l2, 2); old.consume(p2); now++; old.finish({ ...p2, outcome: "failed" });
    now++; old.recover({ fixture: "completed" }); // failed action already drains; recovery revokes its live lease
    now = 1040; const l3 = lease(3), p3 = reserve(l3, 3); now = p3.deadline + 1;
    assert.throws(() => old.consume(p3), { code: "ERR_PERMIT_NOT_CONSUMABLE" }); old.release(l3); old.recover({ fixture: "completed" });
    now = 1060; const l4 = lease(4); reserve(l4, 4); now++; old.revoke(l4); old.recover({ fixture: "completed" });
    // Preserve the actual same-epoch source before the original restart case.
    sameEpochEvidence = readEvidence(file, anchorDir);
    fs.writeFileSync(path.join(dir, "same-epoch-evidence.json"), JSON.stringify(sameEpochEvidence), { mode: 0o600 });
    old.restartService();
    for (const permit of Object.values(old.snapshot().permits)) assert.throws(() => old.consume(permit), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    evidence = readEvidence(file, anchorDir);
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(evidence), { mode: 0o600 });
  } finally { old.close(); }

  const timingDb = path.join(dir, "timing-db"), timingAnchor = path.join(dir, "timing-anchor"); fs.mkdirSync(timingDb); fs.mkdirSync(timingAnchor);
  const timingFile = path.join(timingDb, "state.sqlite"); now = 2000;
  const timing = rawV1.ProtectedPermitStore.initialize(timingFile, { decisionId: "D-timing", anchorDir: timingAnchor,
    anchorMode: "permissive", clock: () => now, verifyRecovery: () => true });
  const acquire = n => timing.acquire({ owner: "fixture", sessionId: "timing-" + n, hostId: "h", workerId: "w", runId: "r", generation: "g",
    desktopKey: "timing-" + n, ownedAppId: "a", idempotencyKey: "lease-" + n, ttlMs: 100 });
  const permit = (l, n) => timing.reserve({ ...l, idempotencyKey: "permit-" + n, operation: "invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 90 });
  try {
    const l1 = acquire(1), p1 = permit(l1, 1);
    now = 2010; timing.consume(p1); now = 2020; timing.renew({ ...l1, ttlMs: 1 });
    // Renewal can shorten final expiry below the original permit deadline;
    // finish/recover do not call activeLease and may run after that expiry.
    now = 2022; timing.finish({ ...p1, outcome: "failed" }); timing.recover({ fixture: "late finish" });
    now = 2030; const l2 = acquire(2), p2 = permit(l2, 2); now = l2.expiresAt - 1;
    // Expired permit does not require activeLease; releasing its lease does.
    assert.throws(() => timing.consume(p2), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    timing.release(l2); timing.recover({ fixture: "released one millisecond before expiry" });
    now = 2200; const l3 = acquire(3), p3 = timing.reserve({ ...l3, idempotencyKey: "permit-3", operation: "invoke",
      targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 100 });
    now = l3.expiresAt; assert.throws(() => timing.release(l3), { code: "ERR_LEASE_NOT_CURRENT" });
    assert.equal(p3.deadline, now);
    assert.throws(() => timing.consume(p3), { code: "ERR_LEASE_NOT_CURRENT" });
    timing.expire(); timing.recover({ fixture: "expire at equality" });
    now = 2400; const l4 = acquire(4), p4 = timing.reserve({ ...l4, idempotencyKey: "permit-4", operation: "invoke",
      targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 100 });
    now = l4.expiresAt - 1; timing.consume(p4);
    now = l4.expiresAt + 1; timing.finish({ ...p4, outcome: "finished" });
    timing.restartService(); // revocation after expiry is valid; no activeLease guard here
    timing.recover({ fixture: "late finish and restart" });
    temporalEvidence = readEvidence(timingFile, timingAnchor);
    fs.writeFileSync(path.join(dir, "temporal-evidence.json"), JSON.stringify(temporalEvidence), { mode: 0o600 });
  } finally { timing.close(); }
});
function clone() { return JSON.parse(JSON.stringify(evidence)); }
function prepare(input = evidence) { return core.prepareLegacyPermitMigration(JSON.stringify(input)); }
function changeState(input, change) {
  const state = JSON.parse(input.source.body); change(state); input.source.body = JSON.stringify(state);
  input.source.sha256 = hash(input.source.body); input.expected.body_digest = input.source.sha256;
  // Corruption cases still have coherent LAST hashes: rejection must come
  // from the actual state invariant, not an incidental stale checksum.
  for (const e of input.journal.filter(e => e.sequence === input.expected.anchor_sequence)) {
    e.body_digest = input.source.sha256;
    e.entry_digest = hash([e.schema_version, e.type, e.sequence, e.body_digest, e.store_id, e.attempt].join("\n"));
  }
  for (const e of input.high_water.filter(e => e.sequence === input.expected.anchor_sequence)) {
    e.body_digest = input.source.sha256; e.record_digest = hash([e.sequence, e.body_digest, e.store_id, e.attempt].join("\n"));
  }
  for (const e of input.audit.filter(e => e.sequence === input.expected.anchor_sequence)) e.body_digest = input.source.sha256;
}
function refused(change, code) {
  const input = clone(); change(input); const encoded = JSON.stringify(input);
  assert.throws(() => core.prepareLegacyPermitMigration(encoded), error => {
    assert.ok(error instanceof core.LegacyPermitMigrationError); if (code) assert.equal(error.code, code); return true;
  });
  assert.equal(JSON.stringify(input), encoded);
}

test("exact frozen real 1.15.7 nonempty history changes only format and next anchor sequence", supported, () => {
  const encoded = JSON.stringify(evidence), result = prepare(), source = JSON.parse(evidence.source.body), target = JSON.parse(result.target.body);
  assert.deepEqual(Object.values(source.permits).map(p => p.status), ["finished", "failed", "expired", "revoked"]);
  assert.equal(Object.keys(source.lease_idempotency).length, 4); assert.equal(source.service_epoch, 2);
  assert.deepEqual(target, { ...source, schema_version: 2, anchor_sequence: source.anchor_sequence + 1 });
  assert.equal(result.target.body, evidence.source.body.replace('"schema_version":1', '"schema_version":2')
    .replace('"anchor_sequence":' + source.anchor_sequence, '"anchor_sequence":' + (source.anchor_sequence + 1)));
  assert.equal(result.target.sha256, hash(result.target.body)); assert.equal(JSON.stringify(evidence), encoded);
  assert.equal(result.executionAuthorized, false); assert.equal(result.status, "prepared-only");
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.append.commit), true);
  // Frozen from the local v1.16.0 tag; CI must not depend on tag availability.
  const tagSource = fs.readFileSync(path.join(__dirname, "fixtures/protected-permit-store-v2-source.txt"), "utf8");
  assert.equal(hash(tagSource), "9d584b29d9f25e392b9fa2d6157318c9334372e5ae6bf14692acfe33622f62c6");
  compile(tagSource).testAssertState(target);
  const current = compile(fs.readFileSync(require.resolve("../../lib/coordination/protected-permit-store"), "utf8")); current.testAssertState(target);
  assert.throws(() => rawV1.testAssertState(target), { code: "ERR_STATE_INVALID" });
});

test("source high-water history must contain every sequence, not only the final mark", supported, () => {
  assert.ok(evidence.high_water.length > 2);
  for (const missing of ["first", "middle", "all-but-last"]) {
    refused(input => {
      if (missing === "all-but-last") input.high_water = input.high_water.slice(-1);
      else input.high_water.splice(missing === "first" ? 0 : 1, 1);
    }, "ERR_LEGACY_MIGRATION_EVIDENCE");
  }
});

test("all 14 replay binding fields, external signature bytes and v1 deadline equality history survive", supported, () => {
  const result = prepare(), original = JSON.parse(evidence.source.body), target = JSON.parse(result.target.body);
  assert.deepEqual(rawV1.consumeBindingFields(), require("../../lib/coordination/protected-permit-store").consumeBindingFields());
  const p = target.permits[signed.message.permit_id], old = original.permits[p.permitId];
  for (const field of rawV1.consumeBindingFields()) assert.equal(p[field], old[field]);
  assert.equal(p.consumedAt, p.deadline); assert.equal(p.status, "finished");
  const bytes = delivery.canonicalBytes(signed.message).toString("base64"); assert.equal(bytes, signed.bytes);
  const targetMessage = { ...signed.message };
  for (const [field, wire] of delivery.BINDING_FIELD_MAP) targetMessage[wire] = p[field];
  assert.equal(delivery.canonicalBytes(targetMessage).toString("base64"), signed.bytes);
  assert.equal(delivery.verifyPermitSignature({ message: targetMessage, signature: signed.signature, publicKeyPem,
    expectedFingerprint: delivery.publicKeyFingerprint(publicKeyPem), revokedFingerprints: new Set(),
    expectedDeadlineMs: p.deadline, nowMs: signed.issuedAt }).ok, true);
  assert.deepEqual(target.idempotency, original.idempotency); assert.deepEqual(target.lease_idempotency, original.lease_idempotency);
  assert.equal(Object.values(target.permits).some(p => ["reserved", "consumed", "unknown"].includes(p.status)), false);
});

test("actual current pure transition bodies reject replay changes and cannot mint from the drained target", supported, () => {
  let source = fs.readFileSync(require.resolve("../../lib/coordination/protected-permit-store"), "utf8");
  // Test-only accessors to existing private pure methods, no transaction/DB
  // driver and no production module changes. The transition bodies stay exact.
  source = source.replace("  close() {", `
    testConsume(state, now, fields) { return this.#consumeInState(state, now, fields); }
    testReserve(state, now, fields) { return this.#reserveInState(state, now, fields, null, validateReservationInput(fields)); }
    close() {`);
  const Current = compile(source).ProtectedPermitStore, prepared = prepare(), state = JSON.parse(prepared.target.body), before = JSON.stringify(state);
  const current = new Current(null, { anchorFile: "synthetic-journal", anchorDir: "synthetic-anchor", storeId: state.store_id });
  for (const permit of Object.values(state.permits)) {
    if (["finished", "failed"].includes(permit.status) && permit.serviceEpoch === state.service_epoch) assert.equal(current.testConsume(state, state.last_clock_ms, permit).status, "already-consumed");
    else assert.throws(() => current.testConsume(state, state.last_clock_ms, permit), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    for (const field of rawV1.consumeBindingFields()) {
      const changed = { ...permit, [field]: typeof permit[field] === "number" ? permit[field] + 1 : permit[field] + "-changed" };
      assert.throws(() => current.testConsume(state, state.last_clock_ms, changed), { code: "ERR_BINDING_MISMATCH" });
    }
    assert.equal(current.testReserve(state, state.last_clock_ms, { ...permit, ttlMs: 10 }).permitId, permit.permitId);
    assert.throws(() => current.testReserve(state, state.last_clock_ms, { ...permit, ttlMs: 10, idempotencyKey: "new-key" }), { code: "ERR_LEASE_NOT_CURRENT" });
  }
  assert.equal(JSON.stringify(state), before);
});

test("real same-epoch drained v1 history actually reaches schema2 already-consumed for finished and failed", supported, () => {
  const original = JSON.parse(sameEpochEvidence.source.body);
  assert.equal(original.service_epoch, 1);
  const result = prepare(sameEpochEvidence), state = JSON.parse(result.target.body);
  assert.deepEqual(state, { ...original, schema_version: 2, anchor_sequence: original.anchor_sequence + 1 });
  let source = fs.readFileSync(require.resolve("../../lib/coordination/protected-permit-store"), "utf8");
  source = source.replace("  close() {", `
    testConsume(state, now, fields) { return this.#consumeInState(state, now, fields); }
    close() {`);
  const Current = compile(source).ProtectedPermitStore;
  const current = new Current(null, { anchorFile: "synthetic-journal", anchorDir: "synthetic-anchor", storeId: state.store_id });
  const before = JSON.stringify(state), statuses = [];
  for (const permit of Object.values(state.permits)) {
    assert.equal(permit.serviceEpoch, state.service_epoch);
    if (["finished", "failed"].includes(permit.status)) {
      assert.deepEqual(current.testConsume(state, state.last_clock_ms, permit), { status: "already-consumed", permitId: permit.permitId });
      statuses.push(permit.status);
    } else assert.throws(() => current.testConsume(state, state.last_clock_ms, permit), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    for (const field of rawV1.consumeBindingFields()) {
      const changed = { ...permit, [field]: typeof permit[field] === "number" ? permit[field] + 1 : permit[field] + "-changed" };
      assert.throws(() => current.testConsume(state, state.last_clock_ms, changed), { code: "ERR_BINDING_MISMATCH" });
    }
  }
  assert.deepEqual(statuses, ["finished", "failed"]);
  assert.equal(JSON.stringify(state), before);
});

test("real renewal can shorten final expiry; late finish/recovery and expire equality stay valid", supported, () => {
  const source = JSON.parse(temporalEvidence.source.body), result = prepare(temporalEvidence), state = JSON.parse(result.target.body);
  const p = state.permits["P-PERMIT-1"], lease = state.lease_idempotency["lease-1"];
  assert.equal(lease.status, "revoked"); assert.equal(p.status, "failed");
  assert.ok(p.consumedAt < lease.expiresAt);
  assert.ok(lease.expiresAt < p.deadline, "final renewal may shorten expiry below the original deadline");
  assert.ok(p.finishedAt > lease.expiresAt && lease.endedAt > lease.expiresAt, "finish/recovery do not require a live lease");
  const released = state.lease_idempotency["lease-2"], expired = state.lease_idempotency["lease-3"];
  assert.equal(released.endedAt, released.expiresAt - 1);
  assert.equal(expired.endedAt, expired.expiresAt); assert.equal(expired.status, "expired");
  const late = state.permits["P-PERMIT-4"], lateLease = state.lease_idempotency["lease-4"];
  assert.equal(late.consumedAt, lateLease.expiresAt - 1);
  assert.equal(late.finishedAt, lateLease.expiresAt + 1);
  assert.equal(lateLease.status, "revoked"); assert.equal(lateLease.endedAt, lateLease.expiresAt + 1);
  assert.deepEqual(state, { ...source, schema_version: 2, anchor_sequence: source.anchor_sequence + 1 });
});

for (const relation of ["consume-at-expiry", "consume-after-expiry", "release-at-expiry", "release-after-expiry"]) {
  test(`contradictory final lease relation ${relation} rejects even with coherent latest digests`, supported, () => {
    const input = JSON.parse(JSON.stringify(temporalEvidence));
    changeState(input, state => {
      if (relation.startsWith("consume")) state.lease_idempotency["lease-1"].expiresAt = state.permits["P-PERMIT-1"].consumedAt - (relation === "consume-after-expiry" ? 1 : 0);
      else state.lease_idempotency["lease-2"].expiresAt = state.lease_idempotency["lease-2"].endedAt - (relation === "release-after-expiry" ? 1 : 0);
    });
    const encoded = JSON.stringify(input);
    assert.throws(() => core.prepareLegacyPermitMigration(encoded), { code: "ERR_LEGACY_MIGRATION_STATE" });
    assert.equal(JSON.stringify(input), encoded);
  });
}

for (const field of ["schema_version", "consumedAt"]) {
  test(`body escaped-equivalent duplicate key ${field} rejects before checksum/shape acceptance`, supported, () => {
    const input = clone();
    const token = field === "schema_version" ? '"schema_version":1' : '"consumedAt":1010';
    assert.ok(input.source.body.includes(token));
    const escaped = field === "schema_version" ? '"schema_\\u0076ersion":1' : '"consumed\\u0041t":1010';
    input.source.body = input.source.body.replace(token, token + "," + escaped);
    input.source.sha256 = hash(input.source.body); input.expected.body_digest = input.source.sha256;
    // Keep all latest digests coherent so a parser silently accepting the
    // duplicate would not be rejected merely by downstream checksum mismatch.
    const n = input.expected.anchor_sequence;
    for (const e of input.journal.filter(e => e.sequence === n)) {
      e.body_digest = input.source.sha256; e.entry_digest = hash([e.schema_version, e.type, e.sequence, e.body_digest, e.store_id, e.attempt].join("\n"));
    }
    for (const e of input.high_water.filter(e => e.sequence === n)) { e.body_digest = input.source.sha256; e.record_digest = hash([e.sequence, e.body_digest, e.store_id, e.attempt].join("\n")); }
    for (const e of input.audit.filter(e => e.sequence === n)) e.body_digest = input.source.sha256;
    const encoded = JSON.stringify(input);
    assert.throws(() => core.prepareLegacyPermitMigration(encoded), { code: "ERR_LEGACY_MIGRATION_JSON" });
    assert.equal(JSON.stringify(input), encoded);
  });
}

test("repeat preparation and exact target verification never migrate twice or mint IDs", supported, () => {
  const first = prepare(), second = prepare(); assert.deepEqual(second, first);
  assert.deepEqual(core.verifyLegacyPermitMigrationTarget(JSON.stringify(evidence), JSON.stringify(first.target)), first);
  const transformed = clone(); transformed.source = JSON.parse(JSON.stringify(first.target));
  assert.throws(() => prepare(transformed), { code: "ERR_LEGACY_MIGRATION_SOURCE_FORMAT" });
  const target = { ...first.target, body: first.target.body + " " }; target.sha256 = hash(target.body);
  assert.throws(() => core.verifyLegacyPermitMigrationTarget(JSON.stringify(evidence), JSON.stringify(target)), core.LegacyPermitMigrationError);
  for (const type of ["intent", "commit"]) {
    const e = first.append[type]; assert.equal(e.entry_digest, hash([1, type, e.sequence, e.body_digest, e.store_id, 1].join("\n")));
    assert.equal(e.store_id, evidence.expected.store_id); assert.equal(e.sequence, evidence.expected.anchor_sequence + 1);
  }
});

for (const status of ["unknown", "reserved", "consumed"]) test(`unresolved ${status} is never made eligible`, supported, () => {
  refused(input => changeState(input, state => { state.permits["P-PERMIT-1"].status = status; }), "ERR_LEGACY_MIGRATION_UNRESOLVED");
});
for (const change of [state => { state.desktop.status = "draining"; }, state => { state.lease.status = "active"; },
  state => { state.permit_seq++; }, state => { delete state.idempotency["permit-1"]; }, state => { state.idempotency.extra = "P-PERMIT-999"; },
  state => { state.permits["P-PERMIT-1"].leaseId = "P-LEASE-999"; }, state => { delete state.tombstones["P-PERMIT-3"]; },
  state => { state.tombstones.orphan = { reason: "deadline", at: 0 }; }, state => { state.permits["P-PERMIT-1"].finishedAt = state.last_clock_ms + 1; },
  state => { state.last_clock_ms = 0; }, state => { state.permits["P-PERMIT-1"].workerId = "other"; },
  state => { state.permits["P-PERMIT-1"].signedIssuance = {}; }, state => { state.witness_authority = {}; }]) {
  test("state ambiguity/orphan/extension is rejected: " + change.toString().slice(0, 85), supported, () => refused(input => changeState(input, change)));
}
for (const change of [input => { input.source.sha256 = "a".repeat(64); }, input => { input.expected.store_id = "another"; },
  input => { input.expected.decision_id = "another"; }, input => { input.expected.anchor_sequence++; },
  input => { input.journal.pop(); }, input => { input.journal[0].store_id = "foreign"; }, input => { input.journal[0].attempt = 2; },
  input => { input.journal[0].type = "abort"; }, input => { input.journal.push(input.journal[0]); },
  input => { input.high_water = []; }, input => { input.high_water.pop(); }, input => { input.high_water[0].record_digest = "f".repeat(64); },
  input => { input.audit.pop(); }, input => { input.audit.push(input.audit[0]); }, input => { input.audit[0].body_digest = "0".repeat(64); }]) {
  test("missing/mismatched evidence rejected: " + change.toString().slice(0, 85), supported, () => refused(change));
}
test("unknown schemas, empty history, malformed JSON and duplicate keys fail without input hooks", supported, () => {
  for (const version of [2, 3, 99]) refused(input => { input.source.user_version = version; }, "ERR_LEGACY_MIGRATION_SOURCE_FORMAT");
  refused(input => changeState(input, s => { s.schema_version = 3; }), "ERR_LEGACY_MIGRATION_SOURCE_FORMAT");
  refused(input => changeState(input, s => { s.permits = {}; s.permit_seq = 0; s.idempotency = {}; }));
  for (const input of ["{", '{"format_version":1,"format_version":1}', "null", "[]", JSON.stringify(evidence) + "x"])
    assert.throws(() => core.prepareLegacyPermitMigration(input), core.LegacyPermitMigrationError);
  let calls = 0; const proxy = new Proxy({}, { get: () => { calls++; throw Error("hook"); } });
  for (const input of [proxy, evidence, Buffer.from("{}"), null]) assert.throws(() => core.prepareLegacyPermitMigration(input), { code: "ERR_LEGACY_MIGRATION_INPUT" });
  assert.equal(calls, 0);
  assert.throws(() => core.prepareLegacyPermitMigration("[".repeat(100) + "0" + "]".repeat(100)), { code: "ERR_LEGACY_MIGRATION_LIMIT" });
});

test("numeric precision, allocation bounds and malformed audit dates reject deterministically", supported, () => {
  const encoded = JSON.stringify(evidence);
  assert.throws(() => core.prepareLegacyPermitMigration(encoded.replace('"format_version":1', '"format_version":1.0000000000000001')), core.LegacyPermitMigrationError);
  const state = JSON.parse(evidence.source.body);
  refused(input => changeState(input, s => { s.anchor_sequence = Number.MAX_SAFE_INTEGER; }), "ERR_LEGACY_MIGRATION_LIMIT");
  refused(input => changeState(input, s => {
    s.lease_idempotency["lease-2"].fencing = s.lease_idempotency["lease-1"].fencing;
    s.permits["P-PERMIT-2"].fencing = s.lease_idempotency["lease-1"].fencing;
  }), "ERR_LEGACY_MIGRATION_ORPHAN");
  refused(input => { input.audit[0].at = "2026-02-30T00:00:00.000Z"; });
  assert.throws(() => core.prepareLegacyPermitMigration(" ".repeat(core.LIMITS.evidenceBytes + 1)), { code: "ERR_LEGACY_MIGRATION_LIMIT" });
  refused(input => { input.source.body += " ".repeat(core.LIMITS.bodyBytes); }, "ERR_LEGACY_MIGRATION_LIMIT");
  assert.equal(JSON.parse(prepare().target.body).last_clock_ms, state.last_clock_ms);
});

test("raw body whitespace/key spelling stays exact except the two permitted numeric tokens", supported, () => {
  const input = clone(), state = JSON.parse(input.source.body);
  input.source.body = JSON.stringify(state, null, 2).replace('"schema_version"', '"schema_\\u0076ersion"');
  input.source.sha256 = hash(input.source.body); input.expected.body_digest = input.source.sha256;
  for (const e of input.journal.filter(e => e.sequence === state.anchor_sequence)) {
    e.body_digest = input.source.sha256; e.entry_digest = hash([e.schema_version, e.type, e.sequence, e.body_digest, e.store_id, e.attempt].join("\n"));
  }
  for (const e of input.high_water.filter(e => e.sequence === state.anchor_sequence)) { e.body_digest = input.source.sha256; e.record_digest = hash([e.sequence, e.body_digest, e.store_id, e.attempt].join("\n")); }
  for (const e of input.audit.filter(e => e.sequence === state.anchor_sequence)) e.body_digest = input.source.sha256;
  const result = prepare(input);
  assert.equal(result.target.body, input.source.body.replace('"schema_\\u0076ersion": 1', '"schema_\\u0076ersion": 2')
    .replace('"anchor_sequence": ' + state.anchor_sequence, '"anchor_sequence": ' + (state.anchor_sequence + 1)));
});

test("core imports no filesystem, database, store, clock or signer service", supported, () => {
  const child = spawnSync(process.execPath, ["-e", `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(name, ...args) {
      if (/^(?:node:)?(?:fs|path|sqlite|child_process|net|tls|http|https)(?:\\/|$)/.test(name) || /protected-permit-store|permit-delivery/.test(name)) throw Error('forbidden dependency');
      return load.call(this, name, ...args);
    };
    Date.now = () => { throw Error('wall clock read'); };
    const core = require(process.argv[1]);
    process.stdout.write(core.prepareLegacyPermitMigration(process.argv[2]).target.sha256);
  `, require.resolve("../../lib/coordination/permit-legacy-migration-core"), JSON.stringify(evidence)], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, prepare().target.sha256);
});
