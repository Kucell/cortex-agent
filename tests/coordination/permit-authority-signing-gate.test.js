"use strict";

// @runner-timeout 600
// The signing gate drives real durable transactions through the protected
// store, so this file needs more than the default hang-detection window.

const { testRuntime } = require("../helpers/runtime-sandbox");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const sqlite = Number(process.versions.node.split(".")[0]) >= 24 ? require("node:sqlite") : {};
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const anchor = require("../../lib/coordination/protected-anchor");
const lock = require("../../lib/coordination/protected-store-lock");
const delivery = require("../../lib/coordination/permit-delivery");
const helper = require("./fixtures/permit-authority-signing-gate");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || !["darwin", "linux"].includes(process.platform) };
function fixture(t, override = {}) {
  const root = testRuntime("test-tmp"); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-authority-signing-gate-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor"); fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir, { mode: 0o700 });
  const a = helper.authority(override), file = path.join(dbDir, "state.sqlite"), options = helper.options(anchorDir, a.providers), stores = [];
  const track = store => { stores.push(store); return store; };
  const f = { ...a, file, dir, anchorDir, options, track };
  f.store = track(Store.initialize(file, options)); f.open = (extra = {}) => track(Store.open(file, { ...options, ...extra }));
  f.input = helper.request(); f.admitted = f.store.admitAuthorityRequest(f.peer, f.input);
  t.after(() => { for (const store of stores) store.close(); }); return f;
}
function raw(f) {
  const db = new sqlite.DatabaseSync(f.file, { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id=1").get().body); } finally { db.close(); }
}
function businessState(state) {
  const { last_clock_ms, anchor_sequence, ...business } = state;
  return business;
}
function assertConflictCommit(f, before, clock = before.last_clock_ms) {
  const after = raw(f);
  assert.deepEqual(businessState(after), businessState(before));
  assert.equal(after.last_clock_ms, clock); assert.equal(after.anchor_sequence, before.anchor_sequence + 1);
  const high = anchor.readHighWater(f.anchorDir);
  assert.equal(high.mark, after.anchor_sequence);
  return after;
}
function record(f) { return raw(f).witness_authority.signing_gate.preparations[f.admitted.attemptId]; }
function prepare(f) { return f.store.prepareAuthoritySigning(f.peer, f.input); }
function claim(f, p) { return f.store.claimAuthoritySigningCall(f.peer, f.input, p.ticket); }
function child(f, action, token, extra = {}) {
  const c = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", require.resolve("./fixtures/permit-authority-signing-gate"),
    JSON.stringify({ file: f.file, anchorDir: f.anchorDir, action, token, ...extra })], { encoding: "utf8", timeout: 15000 });
  const output = JSON.stringify({ stdout: c.stdout, stderr: c.stderr, error: c.error?.message, signal: c.signal });
  assert.equal(c.error, undefined, output); assert.equal(c.signal, null, output);
  assert.equal(c.status, action === "prepare-crash" ? 73 : action === "claim-crash" ? 74 : 0, output);
  assert.equal(c.stderr, "", output);
  if (action.endsWith("-crash")) { assert.equal(c.stdout, "", output); return null; }
  const parsed = JSON.parse(c.stdout);
  assert.deepEqual(Object.keys(parsed), [Object.hasOwn(parsed, "error") ? "error" : "result"], output);
  return parsed;
}
function patch(object, key, value, action) { const old = object[key]; object[key] = value; try { return action(old); } finally { object[key] = old; } }

test("schema5 prepares exact original 14+3 bytes and reserves numbering in protected_state, without a signature", supported, t => {
  const f = fixture(t), before = raw(f), p = prepare(f), state = raw(f), r = record(f);
  assert.equal(state.schema_version, 5); assert.equal(r.status, "sign-prepared");
  assert.deepEqual(state.witness_authority.request_admission, before.witness_authority.request_admission);
  assert.equal(r.request_digest, f.admitted.requestDigest);
  assert.equal(r.permit.sequence, 1); assert.equal(state.permit_seq, 1); assert.equal(state.lease_seq, 1); assert.equal(state.fencing, 1);
  const expected = delivery.preparePermitSigning({ permit: r.permit, issuedAtMs: 1000, nowMs: 1000 });
  assert.equal(r.signing_bytes, expected.bytes); assert.equal(Object.keys(expected.message).length, 17);
  assert.equal(r.signing_digest, crypto.createHash("sha256").update(Buffer.from(expected.bytes, "base64")).digest("hex"));
  assert.equal(r.fingerprint, f.input.request.batchFingerprint); assert.equal(r.permit.deadline, 6000);
  assert.equal(p.executionAuthorized, false); assert.deepEqual(Object.keys(p.ticket), []);
  assert.equal(Object.hasOwn(r, "signature"), false); assert.deepEqual(state.permits, {});
  const db = new sqlite.DatabaseSync(f.file, { readOnly: true });
  try { assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name), ["protected_state"]); }
  finally { db.close(); }
});

test("gate CAS is a separate complete transaction; opaque capability exists only after DB/anchor/coordination close", supported, t => {
  const f = fixture(t), p = prepare(f), sequence = raw(f).anchor_sequence, phases = [];
  let exposed;
  const append = anchor.appendEntry, high = anchor.appendHighWater, exec = sqlite.DatabaseSync.prototype.exec, close = sqlite.DatabaseSync.prototype.close;
  patch(anchor, "appendEntry", (...args) => {
    if (args[1].sequence === sequence + 1) { phases.push(args[1].type); assert.equal(exposed, undefined); }
    return append(...args);
  }, () => patch(anchor, "appendHighWater", (...args) => {
    if (args[1].sequence === sequence + 1) { phases.push("highwater"); assert.equal(exposed, undefined); }
    return high(...args);
  }, () => patch(sqlite.DatabaseSync.prototype, "exec", function(sql) {
    if (sql === "COMMIT") phases.push(new Error().stack.includes("#transactionUnlocked") ? "business-commit" : "coordination-commit");
    return exec.call(this, sql);
  }, () => patch(sqlite.DatabaseSync.prototype, "close", function() {
    if (new Error().stack.includes("Object.withLock")) { phases.push("coordination-close"); assert.equal(exposed, undefined); }
    return close.call(this);
  }, () => { exposed = claim(f, p); }))));
  assert.deepEqual(phases, ["intent", "business-commit", "commit", "highwater", "coordination-commit", "coordination-close"]);
  assert.equal(record(f).status, "sign-call-possible"); assert.equal(raw(f).anchor_sequence, sequence + 1);
  assert.equal(anchor.readHighWater(f.anchorDir).mark, sequence + 1);
  assert.deepEqual(Object.keys(exposed.capability), []);
  assert.throws(() => claim(f, p), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
  const abandoned = f.store.abandonAuthoritySigningCall(f.peer, f.input, exposed.capability);
  assert.equal(abandoned.status, "sign-outcome-unknown");
  assert.throws(() => f.store.abandonAuthoritySigningCall(f.peer, f.input, exposed.capability), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
});

for (const action of ["prepare-crash", "claim-crash"]) {
  test(`independent process ${action} cannot regain a ticket/capability or reuse reservation on restart`, supported, t => {
    const f = fixture(t); f.store.close(); child(f, action);
    const saved = record(f); assert.equal(saved.status, action === "prepare-crash" ? "sign-prepared" : "sign-call-possible");
    assert.equal(child(f, "prepare").error, "ERR_WITNESS_SIGNING_CONFLICT");
    assert.equal(child(f, "claim", saved).error, "ERR_WITNESS_SIGNING_CAPABILITY");
    assert.equal(child(f, "abandon", saved).error, "ERR_WITNESS_SIGNING_CAPABILITY");
    assert.equal(child(f, "lookup").result.attemptId, f.admitted.attemptId);
    const reopened = f.open();
    assert.throws(() => reopened.admitAuthorityRequest(f.peer, { ...f.input, requestKey: "another" }), { code: "ERR_WITNESS_REQUEST_BLOCKED" });
    assert.deepEqual(record(f), saved);
  });
}

test("tickets/capabilities are handle-local; serialized or cloned snapshots grant nothing", supported, t => {
  const f = fixture(t), p = prepare(f), other = f.open();
  assert.throws(() => other.claimAuthoritySigningCall(f.peer, f.input, p.ticket), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
  assert.throws(() => f.store.claimAuthoritySigningCall(f.peer, f.input, structuredClone(p.ticket)), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
  const c = claim(f, p);
  assert.throws(() => other.abandonAuthoritySigningCall(f.peer, f.input, c.capability), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
  assert.equal(child(f, "abandon", JSON.parse(JSON.stringify(c.capability))).error, "ERR_WITNESS_SIGNING_CAPABILITY");
  assert.equal(f.store.abandonAuthoritySigningCall(f.peer, f.input, c.capability).status, "sign-outcome-unknown");
});

function failAt(point, action) {
  const append = anchor.appendEntry, high = anchor.appendHighWater;
  const exec = sqlite.DatabaseSync.prototype.exec, prepareSql = sqlite.DatabaseSync.prototype.prepare, close = sqlite.DatabaseSync.prototype.close;
  const sync = fs.fsyncSync; let fired = false;
  function trip() { fired = true; throw Error("gate-fixture-fault:" + point); }
  patch(anchor, "appendEntry", (...args) => {
    const type = args[1].type;
    if (!fired && point === type + "-before") trip();
    const result = append(...args);
    if (!fired && point === type + "-after") trip();
    return result;
  }, () => patch(anchor, "appendHighWater", (...args) => {
    if (!fired && point === "highwater-before") trip();
    const result = high(...args);
    if (!fired && point === "highwater-after") trip();
    return result;
  }, () => patch(fs, "fsyncSync", fd => {
    if (!fired && point === "audit-fsync" && new Error().stack.includes("#writeAudit") && fs.fstatSync(fd).isFile()) trip();
    return sync(fd);
  }, () => patch(sqlite.DatabaseSync.prototype, "prepare", function(sql, ...args) {
    const stmt = prepareSql.call(this, sql, ...args);
    if (!sql.startsWith("UPDATE protected_state")) return stmt;
    return { run(...values) {
      if (!fired && point === "update-before") trip();
      const result = stmt.run(...values);
      if (!fired && point === "update-after") trip();
      return result;
    } };
  }, () => patch(sqlite.DatabaseSync.prototype, "exec", function(sql) {
    const kind = new Error().stack.includes("#transactionUnlocked") ? "db" : "coord";
    if (sql === "COMMIT" && !fired && point === kind + "-commit-before") trip();
    const result = exec.call(this, sql);
    if (sql === "COMMIT" && !fired && point === kind + "-commit-after") trip();
    return result;
  }, () => patch(sqlite.DatabaseSync.prototype, "close", function() {
    const coord = new Error().stack.includes("Object.withLock");
    const result = close.call(this);
    if (coord && !fired && point === "coord-close") trip();
    return result;
  }, action))))));
  assert.equal(fired, true, "fault boundary not reached: " + point);
}
const faults = ["intent-before", "intent-after", "audit-fsync", "update-before", "update-after", "db-commit-before",
  "db-commit-after", "commit-before", "commit-after", "highwater-before", "highwater-after", "coord-commit-before", "coord-commit-after", "coord-close"];
for (const stage of ["prepare", "gate"]) {
  for (const point of faults) {
    test(`${stage} ${point} failure returns no capability and preserves committed reservations without replay`, supported, t => {
      const f = fixture(t), p = stage === "gate" ? prepare(f) : null;
      const originalAdmission = raw(f).witness_authority.request_admission;
      let result;
      failAt(point, () => assert.throws(() => { result = stage === "prepare" ? prepare(f) : claim(f, p); }, /gate-fixture-fault|ERR_AUDIT_WRITE_FAILED/));
      assert.equal(result, undefined);
      assert.deepEqual(raw(f).witness_authority.request_admission, originalAdmission);
      assert.throws(() => prepare(f), { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
      const stored = record(f);
      if (stage === "gate") assert.ok(stored, "gate failure discarded the durable prepare");
      f.store.close();
      const observed = child(f, "lookup");
      if (observed.error) assert.equal(observed.error, "ERR_CRASH_WINDOW_RECOVERABLE");
      else {
        assert.equal(observed.result.attemptId, f.admitted.attemptId);
        if (stored) assert.equal(child(f, "prepare").error, "ERR_WITNESS_SIGNING_CONFLICT");
        assert.equal(child(f, "claim", p?.ticket || {}).error, "ERR_WITNESS_SIGNING_CAPABILITY");
      }
      if (stored) assert.equal(stored.permit.sequence, 1);
    });
  }
}

test("caller cannot supply prepared bytes, authorize itself, or replace the development provider", supported, t => {
  const f = fixture(t), before = raw(f);
  assert.throws(() => f.store.prepareAuthoritySigning({}, f.input), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.deepEqual(raw(f), before);
  const g = fixture(t);
  const forged = { ...g.input, signing_bytes: "forged", prepareSigning: "caller-claimed" };
  assert.throws(() => g.store.prepareAuthoritySigning(g.peer, forged));
  assert.deepEqual(raw(g).witness_authority.signing_gate, { format_version: 1, sequence: 0, preparations: {} });
  const h = fixture(t); h.input.request = { ...h.input.request, preparedBytes: "forged" };
  assert.throws(() => prepare(h), { code: "ERR_WITNESS_SIGNING_NOT_AUTHORIZED" });
});

for (const bad of [true, {}, Promise.resolve({})]) {
  test(`untrusted/async preparation facts (${String(bad)}) cannot create a reservation`, supported, t => {
    const f = fixture(t, { prepareSigning: () => bad }), before = raw(f);
    assert.throws(() => prepare(f)); assert.deepEqual(raw(f), before);
  });
}

test("changed grant or lifecycle/signer owner cannot claim an old preparation", supported, t => {
  const f = fixture(t), p = prepare(f); f.facts.ownerIncarnation = "new-owner";
  assert.throws(() => claim(f, p), { code: "ERR_WITNESS_SIGNING_NOT_AUTHORIZED" });
  assert.equal(record(f).status, "sign-prepared");
  assert.throws(() => claim(f, p), { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
  f.store.close(); assert.equal(child(f, "prepare").error, "ERR_WITNESS_SIGNING_CONFLICT");
});

test("expired or rolled-back clocks never produce a ticket or call capability", supported, t => {
  for (const value of [999, 7000]) {
    const f = fixture(t), p = prepare(f);
    let clock = 1000; f.store.close(); f.store = f.open({ clock: () => clock });
    // A restarted handle cannot claim, even before checking expiry.
    assert.throws(() => claim(f, p), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
    clock = value;
    assert.throws(() => prepare(f));
    assert.equal(raw(f).witness_authority.request_admission.sequence, 1);
  }
  const g = fixture(t); g.facts.validUntilMs = 999;
  assert.throws(() => prepare(g), { code: "ERR_WITNESS_SIGNING_EXPIRED" });
});

test("old API and static recovery stay closed in schema5; no signer is called", supported, t => {
  let calls = 0;
  const f = fixture(t, { signPermit: () => { calls++; throw Error("must not sign"); } });
  const p = prepare(f), c = claim(f, p); f.store.abandonAuthoritySigningCall(f.peer, f.input, c.capability);
  for (const name of ["registerWitnessTarget", "issueWitnessPermit", "consumeWithCheckpoint"]) {
    assert.throws(() => f.store[name](f.peer, {}), { code: "ERR_WITNESS_ADMISSION_ONLY" });
  }
  for (const name of ["restartService", "recover", "release", "expire", "consume"]) {
    assert.throws(() => f.store[name]({}), { code: "ERR_WITNESS_LEGACY_ENTRY_DISABLED" });
  }
  f.store.close();
  for (const name of ["recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
    assert.throws(() => Store[name](f.file, { ...f.options, audit: { by: "fixture", reason: "no unlock" } }), { code: "ERR_WITNESS_RECOVERY_UNSUPPORTED" });
  }
  assert.equal(calls, 0);
});

for (const version of [2, 3, 4]) {
  test(`schema${version} retains exact format and cannot silently enable schema5`, supported, t => {
    const f = fixture(t), legacyOptions = { ...f.options, witnessAuthority: version === 2 ? undefined : {
      ...f.providers, signingGateMode: undefined, prepareSigning: undefined, ...(version === 3 ? { admissionMode: undefined } : {}) } };
    // Configuration whitelist rejects explicitly present prepareSigning unless
    // the gate mode is enabled; omit these keys for old-mode compatibility.
    if (legacyOptions.witnessAuthority) { delete legacyOptions.witnessAuthority.signingGateMode; delete legacyOptions.witnessAuthority.prepareSigning; }
    const dir = path.join(f.dir, "legacy"); fs.mkdirSync(dir);
    const file = path.join(dir, "state.sqlite"), anchorDir = path.join(f.dir, "legacy-anchor"); fs.mkdirSync(anchorDir, { mode: 0o700 });
    const options = { ...legacyOptions, anchorDir };
    const store = Store.initialize(file, options), before = store.snapshot(); store.close();
    assert.equal(before.schema_version, version);
    assert.equal(Object.hasOwn(before.witness_authority || {}, "signing_gate"), false);
    assert.throws(() => Store.open(file, { ...f.options, anchorDir }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    const reopened = Store.open(file, options);
    try {
      assert.deepEqual(reopened.snapshot(), before);
      assert.throws(() => reopened.prepareAuthoritySigning(f.peer, f.input), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    } finally { reopened.close(); }
    f.store.close();
    assert.throws(() => Store.open(f.file, { ...f.options, witnessAuthority: options.witnessAuthority }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  });
}

async function independentPrepareClaim(f, input) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", require.resolve("./fixtures/permit-authority-signing-gate"),
      JSON.stringify({ file: f.file, anchorDir: f.anchorDir, action: "prepare-and-claim", input })]);
    let out = "", err = ""; c.stdout.on("data", data => { out += data; }); c.stderr.on("data", data => { err += data; });
    c.on("error", reject); c.on("close", (code, signal) => {
      try {
        const output = JSON.stringify({ stdout: out, stderr: err, code, signal });
        assert.equal(code, 0, output); assert.equal(signal, null, output); assert.equal(err, "", output);
        const parsed = JSON.parse(out);
        assert.deepEqual(Object.keys(parsed), [Object.hasOwn(parsed, "error") ? "error" : "result"], output);
        resolve(parsed);
      } catch (error) { reject(error); }
    });
  });
}

for (const different of [false, true]) {
  test(`two independent processes cannot both prepare/claim ${different ? "different admissions in the global lease domain" : "the same admission"}`, { ...supported, timeout: 20000 }, async t => {
    const f = fixture(t), other = different
      ? helper.request({ requestKey: "process-B", resourceScope: "different-resource", businessKey: "different-business" }) : f.input;
    if (different) f.store.admitAuthorityRequest(f.peer, other);
    f.store.close();
    const results = await Promise.all([independentPrepareClaim(f, f.input), independentPrepareClaim(f, other)]);
    assert.equal(results.filter(r => r.result).length, 1);
    assert.equal(results.find(r => r.error).error, "ERR_WITNESS_SIGNING_CONFLICT");
    const gate = raw(f).witness_authority.signing_gate;
    assert.equal(gate.sequence, 1); assert.equal(raw(f).fencing, 1);
    assert.equal(Object.values(gate.preparations)[0].status, "sign-call-possible");
  });
}

for (const status of ["sign-prepared", "sign-call-possible", "sign-outcome-unknown"]) {
  test(`single lease/fence conflict with ${status} preserves A and rejects B before any allocation`, supported, t => {
    let providerCalls = 0;
    const facts = helper.authority().facts;
    const f = fixture(t, { prepareSigning: () => { providerCalls++; return facts; } });
    const first = prepare(f);
    const call = status !== "sign-prepared" ? claim(f, first) : null;
    if (status === "sign-outcome-unknown") f.store.abandonAuthoritySigningCall(f.peer, f.input, call.capability);
    const secondInput = helper.request({ requestKey: "request-2", resourceScope: "distinct-resource", businessKey: "distinct-business" });
    const secondAdmission = f.store.admitAuthorityRequest(f.peer, secondInput);
    const before = raw(f), calls = providerCalls; let last = before;
    for (let i = 0; i < 2; i++) {
      assert.throws(() => f.store.prepareAuthoritySigning(f.peer, secondInput), { code: "ERR_WITNESS_SIGNING_CONFLICT" });
      last = assertConflictCommit(f, last); assert.equal(providerCalls, calls);
    }
    assert.equal(Object.hasOwn(before.witness_authority.signing_gate.preparations, secondAdmission.attemptId), false);
    assert.equal(before.fencing, 1); assert.equal(before.lease_seq, 1); assert.equal(before.permit_seq, 1);
    if (status === "sign-prepared") assert.equal(claim(f, first).attemptId, f.admitted.attemptId);
    if (status === "sign-call-possible") assert.equal(f.store.abandonAuthoritySigningCall(f.peer, f.input, call.capability).status, "sign-outcome-unknown");
    f.store.close(); f.store = f.open();
    const reopened = raw(f);
    assert.throws(() => f.store.prepareAuthoritySigning(f.peer, secondInput), { code: "ERR_WITNESS_SIGNING_CONFLICT" });
    assertConflictCommit(f, reopened);
  });
}

test("one oversized signing reservation rejects capacity before allocation and preserves both admissions", supported, t => {
  const f = fixture(t), input = helper.request({ requestKey: "large", resourceScope: "large-resource", businessKey: "large-business" });
  for (const key of ["sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"]) input.request.lease[key] = "\u0000".repeat(20000);
  input.request.permit.operation = "\u0000".repeat(20000);
  const admitted = f.store.admitAuthorityRequest(f.peer, input), before = raw(f);
  assert.throws(() => f.store.prepareAuthoritySigning(f.peer, input), { code: "ERR_WITNESS_SIGNING_CAPACITY" });
  assert.deepEqual(raw(f), before);
  assert.equal(Object.hasOwn(raw(f).witness_authority.request_admission.attempts, admitted.attemptId), true);
  assert.equal(before.permit_seq, 0); assert.equal(before.lease_seq, 0); assert.equal(before.fencing, 0);
  f.store.close(); f.store = f.open();
  assert.equal(raw(f).witness_authority.request_admission.sequence, 2);
  assert.equal(prepare(f).attemptId, f.admitted.attemptId);
});

test("original request byte mutation conflicts; original record and unknown reservations remain", supported, t => {
  const f = fixture(t), p = prepare(f), before = raw(f);
  const changed = structuredClone(f.input); changed.request.permit.paramsDigest = "e".repeat(64);
  assert.throws(() => f.store.admitAuthorityRequest(f.peer, changed), { code: "ERR_WITNESS_REQUEST_CONFLICT" });
  assert.deepEqual(raw(f).witness_authority.signing_gate, before.witness_authority.signing_gate);
  assert.throws(() => f.store.claimAuthoritySigningCall(f.peer, changed, p.ticket), { code: "ERR_WITNESS_SIGNING_NOT_AUTHORIZED" });
  assert.deepEqual(record(f), before.witness_authority.signing_gate.preparations[f.admitted.attemptId]);
});

test("post-provider authorization revocation or clock rollback creates no ticket", supported, t => {
  let revoked = false;
  const base = helper.authority();
  const f = fixture(t, { authorize: (...args) => revoked ? false : base.providers.authorize(base.peer, ...args.slice(1)),
    prepareSigning: () => { revoked = true; return base.facts; } });
  assert.throws(() => prepare(f), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.equal(raw(f).witness_authority.signing_gate.sequence, 0);
  const g = fixture(t); let now = 1000;
  g.store.close(); g.store = g.open({ clock: () => now });
  g.facts.validUntilMs = 99999;
  // A deployment provider is copied at construction, so use an explicit new
  // options object before opening, never a request callback.
  g.store.close(); g.store = g.open({ clock: () => now, witnessAuthority: { ...g.providers,
    prepareSigning: () => { now = 999; return g.facts; } } });
  assert.throws(() => prepare(g), { code: "ERR_WITNESS_CLOCK" });
  assert.equal(raw(g).witness_authority.clock_poisoned, true);
  assert.equal(record(g).status, "sign-prepared");
  g.store.close(); assert.equal(child(g, "prepare").error, "ERR_WITNESS_CLOCK");
});

for (const point of ["audit-fsync", "db-commit-after", "highwater-after", "coord-close"]) {
  test(`abandon ${point} failure burns the capability and retains sign-call/unknown across restart`, supported, t => {
    const f = fixture(t), p = prepare(f), c = claim(f, p);
    const original = raw(f).witness_authority.request_admission;
    failAt(point, () => assert.throws(() => f.store.abandonAuthoritySigningCall(f.peer, f.input, c.capability), /gate-fixture-fault|ERR_AUDIT_WRITE_FAILED/));
    assert.throws(() => f.store.abandonAuthoritySigningCall(f.peer, f.input, c.capability), { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
    assert.ok(["sign-call-possible", "sign-outcome-unknown"].includes(record(f).status));
    assert.deepEqual(raw(f).witness_authority.request_admission, original);
    f.store.close(); const restarted = child(f, "lookup");
    if (restarted.error) assert.equal(restarted.error, "ERR_CRASH_WINDOW_RECOVERABLE");
    else assert.equal(child(f, "prepare").error, "ERR_WITNESS_SIGNING_CONFLICT");
  });
}

test("closing a handle destroys all private tickets/capabilities, retaining persistent call evidence", supported, t => {
  const f = fixture(t), p = prepare(f), c = claim(f, p), saved = record(f);
  f.store.close(); f.store = f.open();
  assert.throws(() => f.store.abandonAuthoritySigningCall(f.peer, f.input, c.capability), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
  assert.throws(() => claim(f, p), { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
  assert.deepEqual(record(f), saved);
});

test("active provider cannot reenter store writers or observe an already-issued capability", supported, t => {
  let f, returned;
  const source = helper.authority();
  f = fixture(t, { prepareSigning(input, snapshot) {
    assert.equal(returned, undefined); assert.equal(Object.isFrozen(input.request.lease), true);
    assert.equal(Object.isFrozen(snapshot.witness_authority), true);
    for (const action of [() => prepare(f), () => f.store.snapshot(), () => f.store.restartService(), () => f.store.close()]) {
      assert.throws(action, { code: "ERR_WITNESS_ADMISSION_ACTIVE" });
    }
    return source.facts;
  } });
  const p = prepare(f); returned = claim(f, p);
  assert.equal(record(f).status, "sign-call-possible");
});

test("grant version and expiry are revalidated at the actual gate, not inferred from possession of a ticket", supported, t => {
  const source = helper.authority(); let version = 1, now = 1000;
  const f = fixture(t, { authorize(peer, operation, input) {
    const grant = source.providers.authorize(source.peer, operation, input);
    return { ...grant, grant: { id: "g", version } };
  } });
  const p = prepare(f); version = 2;
  assert.throws(() => claim(f, p), { code: "ERR_WITNESS_SIGNING_NOT_AUTHORIZED" });
  const g = fixture(t); g.store.close();
  g.store = g.open({ clock: () => now });
  const prepared = prepare(g); now = 7000;
  assert.throws(() => claim(g, prepared), { code: "ERR_WITNESS_SIGNING_EXPIRED" });
  assert.equal(record(g).status, "sign-prepared");
});

for (const stage of ["prepare", "gate"]) {
  for (const point of ["intent", "update", "db-commit", "commit", "highwater", "coord-commit", "coord-close"]) {
    test(`real process exit at ${stage}/${point} cannot restore any private signing authority`, supported, t => {
      const f = fixture(t); f.store.close();
      const c = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", require.resolve("./fixtures/permit-authority-signing-gate"),
        JSON.stringify({ file: f.file, anchorDir: f.anchorDir, action: "crash-boundary", stage, point })],
        { encoding: "utf8", timeout: 15000 });
      const output = JSON.stringify({ stdout: c.stdout, stderr: c.stderr, error: c.error?.message, signal: c.signal });
      assert.equal(c.error, undefined, output); assert.equal(c.signal, null, output);
      assert.equal(c.status, 75, output); assert.equal(c.stdout, "", output); assert.equal(c.stderr, "", output);
      const saved = record(f);
      if (stage === "gate") assert.ok(saved);
      const lookup = child(f, "lookup");
      if (lookup.error) assert.equal(lookup.error, "ERR_CRASH_WINDOW_RECOVERABLE");
      else {
        assert.equal(lookup.result.attemptId, f.admitted.attemptId);
        if (saved) assert.equal(child(f, "prepare").error, "ERR_WITNESS_SIGNING_CONFLICT");
        assert.equal(child(f, "claim", saved || {}).error, "ERR_WITNESS_SIGNING_CAPABILITY");
      }
      if (saved) assert.equal(saved.permit.sequence, 1);
      assert.equal(raw(f).witness_authority.request_admission.sequence, 1);
    });
  }
}

test("production or incomplete signing-gate configuration is refused before provisioning", supported, t => {
  const f = fixture(t);
  for (const patch of [{ signingGateMode: "production" }, { prepareSigning: undefined }, { admissionMode: undefined }]) {
    const dir = fs.mkdtempSync(path.join(f.dir, "refused-")), file = path.join(dir, "state.sqlite");
    assert.throws(() => Store.initialize(file, { ...f.options, witnessAuthority: { ...f.providers, ...patch } }),
      { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    assert.equal(fs.existsSync(file), false);
  }
});

for (const kind of ["ticket", "capability"]) {
  for (const outer of ["lookup", "competing-prepare"]) {
    test(`trusted authorization reentry with a valid ${kind} during ${outer} never consumes it`, supported, t => {
      let f, held, armed = false, attempts = 0, deletes = 0;
      const source = helper.authority();
      f = fixture(t, { authorize(peer, operation, input) {
        if (armed && (operation === "request.lookup" || operation === "sign.prepare")) {
          attempts++;
          const reenter = kind === "ticket"
            ? () => f.store.claimAuthoritySigningCall(f.peer, f.input, held)
            : () => f.store.abandonAuthoritySigningCall(f.peer, f.input, held);
          assert.throws(reenter, { code: "ERR_WITNESS_ADMISSION_ACTIVE" });
        }
        return source.providers.authorize(source.peer, operation, input);
      } });
      const p = prepare(f); held = kind === "ticket" ? p.ticket : claim(f, p).capability;
      const second = helper.request({ requestKey: "competing", resourceScope: "different-resource", businessKey: "different-business" });
      if (outer === "competing-prepare") f.store.admitAuthorityRequest(f.peer, second);
      const before = record(f), remove = WeakMap.prototype.delete;
      patch(WeakMap.prototype, "delete", function(key) {
        if (key === held) deletes++;
        return remove.call(this, key);
      }, () => {
        armed = true;
        if (outer === "lookup") assert.equal(f.store.lookupAuthorityRequest(f.peer, f.input).attemptId, f.admitted.attemptId);
        else assert.throws(() => f.store.prepareAuthoritySigning(f.peer, second), { code: "ERR_WITNESS_SIGNING_CONFLICT" });
        armed = false;
        assert.ok(attempts >= 2); assert.equal(deletes, 0);
        assert.deepEqual(record(f), before);
        if (kind === "ticket") assert.equal(f.store.claimAuthoritySigningCall(f.peer, f.input, held).attemptId, f.admitted.attemptId);
        else assert.equal(f.store.abandonAuthoritySigningCall(f.peer, f.input, held).status, "sign-outcome-unknown");
        assert.equal(deletes, 1);
      });
    });
  }
}

for (const kind of ["ticket", "capability"]) {
  test(`legitimate ${kind} entry with invalid input still burns exactly once; blocked/closed preflight invokes no input code`, supported, t => {
    const f = fixture(t), p = prepare(f), held = kind === "ticket" ? p.ticket : claim(f, p).capability;
    const invoke = input => kind === "ticket"
      ? f.store.claimAuthoritySigningCall(f.peer, input, held)
      : f.store.abandonAuthoritySigningCall(f.peer, input, held);
    let deletes = 0, traps = 0;
    const remove = WeakMap.prototype.delete;
    patch(WeakMap.prototype, "delete", function(key) { if (key === held) deletes++; return remove.call(this, key); }, () => {
      assert.throws(() => invoke({ invalid: true })); assert.equal(deletes, 1);
      const hostile = new Proxy({}, { getPrototypeOf() { traps++; throw Error("input must not be touched"); } });
      assert.throws(() => invoke(hostile), { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
      assert.equal(traps, 0); assert.equal(deletes, 1);
      f.store.close();
      assert.throws(() => invoke(hostile), { code: "ERR_STORE_CLOSED" });
      assert.equal(traps, 0); assert.equal(deletes, 1);
    });
    assert.equal(raw(f).witness_authority.signing_gate.sequence, 1);
  });
}

function witnessFiles(f) {
  const result = {};
  for (const name of fs.readdirSync(f.anchorDir).sort()) {
    if (name.startsWith("protected-store-coordination.sqlite")) continue;
    const file = path.join(f.anchorDir, name);
    result[name] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return result;
}
for (const kind of ["ticket", "capability"]) {
  for (const crossHandle of [false, true]) {
    test(`same-attempt duplicate prepare on ${crossHandle ? "another" : "same"} handle preserves original ${kind} while publishing clock safety`, supported, t => {
      let providerCalls = 0;
      const source = helper.authority();
      const f = fixture(t, { prepareSigning: () => { providerCalls++; return source.facts; } });
      const p = prepare(f), held = kind === "ticket" ? p.ticket : claim(f, p).capability;
      const duplicate = crossHandle ? f.open() : f.store;
      const before = raw(f), calls = providerCalls;
      let returned, last = before, witnesses = witnessFiles(f);
      for (let i = 0; i < 2; i++) {
        assert.throws(() => { returned = duplicate.prepareAuthoritySigning(f.peer, f.input); }, { code: "ERR_WITNESS_SIGNING_CONFLICT" });
        assert.equal(returned, undefined); last = assertConflictCommit(f, last);
        assert.notDeepEqual(witnessFiles(f), witnesses); witnesses = witnessFiles(f); assert.equal(providerCalls, calls);
      }
      if (crossHandle) {
        const useOther = kind === "ticket" ? () => duplicate.claimAuthoritySigningCall(f.peer, f.input, held)
          : () => duplicate.abandonAuthoritySigningCall(f.peer, f.input, held);
        assert.throws(useOther, { code: "ERR_WITNESS_SIGNING_CAPABILITY" });
      }
      if (kind === "ticket") {
        const c = claim(f, p);
        assert.equal(f.store.abandonAuthoritySigningCall(f.peer, f.input, c.capability).status, "sign-outcome-unknown");
      } else assert.equal(f.store.abandonAuthoritySigningCall(f.peer, f.input, held).status, "sign-outcome-unknown");
      const unknown = raw(f), unknownWitnesses = witnessFiles(f);
      assert.throws(() => duplicate.prepareAuthoritySigning(f.peer, f.input), { code: "ERR_WITNESS_SIGNING_CONFLICT" });
      const continued = assertConflictCommit(f, unknown); assert.notDeepEqual(witnessFiles(f), unknownWitnesses);
      f.store.close();
      assert.equal(child(f, "prepare").error, "ERR_WITNESS_SIGNING_CONFLICT");
      assertConflictCommit(f, continued);
    });
  }
}

for (const kind of ["ticket", "capability"]) {
  for (const safety of ["authorization-initial", "authorization-late", "clock-initial", "clock-late", "persisted-poison"]) {
    test(`duplicate prepare with ${kind} and ${safety} must not use the safe-conflict exception`, supported, t => {
      const source = helper.authority();
      let armed = false, checks = 0, reads = 0;
      const f = fixture(t, { authorize(peer, operation, input) {
        if (armed && operation === "sign.prepare") {
          checks++;
          if (safety === "authorization-initial" || (safety === "authorization-late" && checks === 3)) return false;
        }
        return source.providers.authorize(source.peer, operation, input);
      } });
      f.store.close(); f.store = f.open({ clock: () => {
        if (!armed) return 1000;
        reads++;
        if (safety === "clock-initial" || (safety === "clock-late" && reads === 2)) return 999;
        return 1000;
      } });
      const p = prepare(f), held = kind === "ticket" ? p.ticket : claim(f, p).capability;
      if (safety === "persisted-poison") {
        const poisoner = f.open({ clock: () => 1000 });
        // Existing public authority path persists a rollback observation, no
        // schema rewrite or fabricated DB state is used.
        let now = 1000;
        poisoner.close(); const writer = f.open({ clock: () => now }); now = 999;
        assert.throws(() => writer.lookupAuthorityRequest(f.peer, f.input), { code: "ERR_WITNESS_CLOCK" });
        assert.equal(raw(f).witness_authority.clock_poisoned, true);
      }
      const before = record(f); armed = true;
      const expected = safety.startsWith("authorization") ? "ERR_WITNESS_NOT_AUTHORIZED" : "ERR_WITNESS_CLOCK";
      assert.throws(() => prepare(f), { code: expected }); armed = false;
      const use = kind === "ticket" ? () => claim(f, p) : () => f.store.abandonAuthoritySigningCall(f.peer, f.input, held);
      assert.throws(use, { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
      assert.deepEqual(record(f), before);
      if (!safety.startsWith("authorization")) assert.equal(raw(f).witness_authority.clock_poisoned, true);
    });
  }
}


function timedSigningFixture(t, kind, different) {
  const f = fixture(t), clock = { now: 1000, samples: [] };
  const readClock = () => clock.samples.length ? clock.samples.shift() : clock.now;
  f.store.close(); f.store = f.open({ clock: readClock });
  const otherInput = different ? helper.request({ requestKey: "clock-B", businessKey: "clock-business-B", resourceScope: "clock-resource-B" }) : f.input;
  if (different) f.store.admitAuthorityRequest(f.peer, otherInput);
  const p = prepare(f), capability = kind === "capability" ? claim(f, p).capability : null;
  return { f, clock, readClock, otherInput, p, capability,
    use: () => kind === "ticket" ? claim(f, p) : f.store.abandonAuthoritySigningCall(f.peer, f.input, capability) };
}
for (const different of [false, true]) {
  for (const kind of ["ticket", "capability"]) {
    for (const crossHandle of [false, true]) {
      for (const reviewed of [1100, 1120]) {
        test(`${different ? "B" : "A"} conflict at 1100/recheck ${reviewed} publishes high-water across ${crossHandle ? "handles" : "same handle"}, retains ${kind}, and detects 1050 after restart`, supported, t => {
          const q = timedSigningFixture(t, kind, different), { f, clock } = q;
          const observer = crossHandle ? f.open({ clock: q.readClock }) : f.store;
          const before = raw(f), witnesses = witnessFiles(f);
          clock.now = reviewed; clock.samples = [1100, reviewed];
          assert.throws(() => observer.prepareAuthoritySigning(f.peer, q.otherInput), { code: "ERR_WITNESS_SIGNING_CONFLICT" });
          assert.equal(clock.samples.length, 0);
          assertConflictCommit(f, before, reviewed); assert.notDeepEqual(witnessFiles(f), witnesses);
          assert.equal(f.store.snapshot().last_clock_ms, reviewed);
          const restarted = child(f, "snapshot", undefined, { clockMs: reviewed });
          assert.equal(restarted.result.last_clock_ms, reviewed);
          assert.equal(restarted.result.witness_authority.clock_poisoned, false);
          assert.deepEqual(restarted.result.witness_authority.signing_gate, before.witness_authority.signing_gate);
          clock.now = 1050;
          assert.throws(q.use, { code: "ERR_WITNESS_CLOCK" });
          const poisoned = raw(f);
          assert.equal(poisoned.last_clock_ms, reviewed); assert.equal(poisoned.witness_authority.clock_poisoned, true);
          assert.deepEqual(poisoned.witness_authority.signing_gate, before.witness_authority.signing_gate);
          assert.equal(child(f, "lookup", undefined, { clockMs: reviewed }).error, "ERR_WITNESS_CLOCK");
        });
      }
    }
  }
}
for (const different of [false, true]) {
  for (const kind of ["ticket", "capability"]) {
    test(`${different ? "B" : "A"} conflict recheck rollback 1100 to 1050 persists both 1100 and poison for ${kind}`, supported, t => {
      const q = timedSigningFixture(t, kind, different), { f, clock } = q, before = record(f);
      clock.samples = [1100, 1050]; clock.now = 1100;
      assert.throws(() => f.store.prepareAuthoritySigning(f.peer, q.otherInput), { code: "ERR_WITNESS_CLOCK" });
      assert.equal(raw(f).last_clock_ms, 1100); assert.equal(raw(f).witness_authority.clock_poisoned, true);
      assert.deepEqual(record(f), before);
      assert.throws(q.use, { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
      const restarted = child(f, "snapshot", undefined, { clockMs: 1100 });
      assert.equal(restarted.result.last_clock_ms, 1100); assert.equal(restarted.result.witness_authority.clock_poisoned, true);
    });
  }
}

for (const kind of ["ticket", "capability"]) {
  for (const point of faults) {
    test(`conflict clock publication ${point} failure closes current handle and preserves ${kind} business reservation`, supported, t => {
      const q = timedSigningFixture(t, kind, false), { f, clock } = q, before = raw(f);
      clock.now = 1100;
      let returned;
      failAt(point, () => assert.throws(() => { returned = prepare(f); }, /gate-fixture-fault|ERR_AUDIT_WRITE_FAILED/));
      assert.equal(returned, undefined);
      assert.throws(q.use, { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
      const saved = raw(f); assert.deepEqual(businessState(saved), businessState(before));
      assert.ok([1000, 1100].includes(saved.last_clock_ms));
      f.store.close();
      const reopened = child(f, "snapshot", undefined, { clockMs: 1100 });
      if (reopened.error) assert.equal(reopened.error, "ERR_CRASH_WINDOW_RECOVERABLE");
      else {
        assert.equal(reopened.result.last_clock_ms, saved.last_clock_ms);
        assert.equal(reopened.result.witness_authority.signing_gate.sequence, 1);
      }
    });
  }
}

for (const kind of ["ticket", "capability"]) {
  for (const point of ["audit-fsync", "db-commit-after", "highwater-after", "coord-close"]) {
    test(`cross-handle ${point} failure is not a global latch; original ${kind} rechecks only durable evidence`, supported, t => {
      const q = timedSigningFixture(t, kind, true), { f, clock } = q;
      const observer = f.open({ clock: q.readClock }), original = record(f);
      clock.now = 1100;
      failAt(point, () => assert.throws(() => observer.prepareAuthoritySigning(f.peer, q.otherInput), /gate-fixture-fault|ERR_AUDIT_WRITE_FAILED/));
      assert.throws(() => observer.prepareAuthoritySigning(f.peer, q.otherInput), { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
      assert.deepEqual(record(f), original);
      clock.now = 1050;
      if (point === "audit-fsync") {
        // Publication failed before DB COMMIT. The observing handle is blocked,
        // but there is no durable 1100/poison to promise global failure closure.
        assert.equal(raw(f).last_clock_ms, 1000);
        const result = q.use(); assert.equal(result.attemptId, f.admitted.attemptId);
        assert.equal(raw(f).last_clock_ms, 1050);
        assert.equal(raw(f).witness_authority.clock_poisoned, false);
      } else if (point === "db-commit-after") {
        assert.equal(raw(f).last_clock_ms, 1100);
        assert.throws(q.use, { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
        assert.equal(raw(f).witness_authority.clock_poisoned, false); // Journal refusal precedes clock handling.
      } else {
        // Complete local evidence exists despite response/cleanup failure. The
        // old handle MUST see 1100 and poison on 1050, without a global latch.
        assert.equal(raw(f).last_clock_ms, 1100);
        assert.throws(q.use, { code: "ERR_WITNESS_CLOCK" });
        assert.equal(raw(f).last_clock_ms, 1100); assert.equal(raw(f).witness_authority.clock_poisoned, true);
      }
    });
  }
}

for (const kind of ["ticket", "capability"]) {
  test(`complete conflict publication on another handle preserves ${kind} for a current forward clock`, supported, t => {
    const q = timedSigningFixture(t, kind, true), { f, clock } = q;
    const observer = f.open({ clock: q.readClock }); clock.now = 1100;
    assert.throws(() => observer.prepareAuthoritySigning(f.peer, q.otherInput), { code: "ERR_WITNESS_SIGNING_CONFLICT" });
    assert.equal(q.use().attemptId, f.admitted.attemptId);
    assert.equal(raw(f).last_clock_ms, 1100); assert.equal(raw(f).witness_authority.clock_poisoned, false);
  });
}

for (const kind of ["ticket", "capability"]) {
  for (const invalid of [NaN, Infinity, -1]) {
    test(`conflict invalid review clock ${invalid} persists first 1100 and poison for ${kind}`, supported, t => {
      const q = timedSigningFixture(t, kind, false), { f, clock } = q, before = record(f);
      clock.samples = [1100, invalid]; clock.now = 1100;
      assert.throws(() => prepare(f), { code: "ERR_CLOCK_INVALID" });
      assert.equal(raw(f).last_clock_ms, 1100); assert.equal(raw(f).witness_authority.clock_poisoned, true);
      assert.deepEqual(record(f), before); assert.throws(q.use, { code: "ERR_WITNESS_SIGNING_UNKNOWN" });
      const restarted = child(f, "snapshot", undefined, { clockMs: 1100 });
      assert.equal(restarted.result.last_clock_ms, 1100); assert.equal(restarted.result.witness_authority.clock_poisoned, true);
    });
  }
}
