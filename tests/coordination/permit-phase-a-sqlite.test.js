"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { SyntheticState, sqliteFixtureKernel: kernel } = require("../../lib/coordination/permit-phase-a-synthetic-state");
const { BARRIER_PARTS, canonicalEffectTuple } = require("../../lib/coordination/permit-phase-a-synthetic-publication");
const supported = Number(process.versions.node.split(".")[0]) >= 24;
const driver = supported ? require("./fixtures/permit-phase-a-sqlite-driver") : {};
const childFile = path.join(__dirname, "fixtures/permit-phase-a-sqlite-child.js");
const runtime = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
const A = "a".repeat(64), B = "b".repeat(64);
const clock = (m = 1, w = 1000 + m) => ({ monotonicNow: m, wallClockNow: w });
const delta = (n = 1, revoked = []) => ({ previous: n - 1, sequence: n, revoked, clockPoisoned: false });
function config(lane = "consumption-fixture") {
  return { mode: "purely-synthetic", lane, authorityId: "synthetic-authority", targetId: "synthetic-target",
    storeGeneration: "store-1", runGeneration: "run-7", ownerIncarnation: "owner-3", ownerVersion: 1,
    grantId: "grant-1", grantVersion: 1, lifecycleVersion: 11 };
}
function request(s, id = "attempt-1", overrides = {}) {
  const c = s.control;
  return { attemptId: id, kind: "consume", checkpoint: s.checkpoint, principal: "synthetic-principal", requestDigest: A,
    runGeneration: "run-7", ownerIncarnation: c.ownerIncarnation, ownerVersion: c.ownerVersion,
    grantId: c.grantId, grantVersion: c.grantVersion, lifecycleVersion: c.lifecycleVersion,
    monotonicDeadline: 100, wallClockDeadline: 1100, permitId: "permit-" + id, fingerprint: A, ...overrides };
}
const command = (type, data) => ({ type, data });
function fixture(t, lane) {
  fs.mkdirSync(runtime, { recursive: true });
  const dir = fs.mkdtempSync(path.join(runtime, "permit-phase-a-sqlite-")), file = path.join(dir, "fixture.sqlite");
  const db = driver.SqliteFixture.initialize(file, config(lane));
  t.after(() => db.close()); // Keep runtime DBs for independent inspection.
  return { db, dir, file };
}
function attempt(s, id = "attempt-1") { return s.attempts.find(a => a.request.attemptId === id); }
function stage(db, r = request(db.inspect().state), observation = delta()) {
  db.command(command("admit", r)); db.command(command("reserve", { attemptId: r.attemptId, version: 1, tokenId: "token-" + r.attemptId }));
  return db.command(command("enter", { attemptId: r.attemptId, version: 2, clocks: clock(), observation }));
}
function fresh(file) {
  const out = spawnSync(process.execPath, [childFile, file], { input: "", encoding: "utf8", timeout: 5000 });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim()).snapshot;
}
async function child(t, file) {
  const p = spawn(process.execPath, [childFile, file], { stdio: ["pipe", "pipe", "pipe"] });
  const queue = [], pending = []; let stderr = "", ended = false;
  p.stderr.on("data", b => { stderr += b; });
  const lines = readline.createInterface({ input: p.stdout });
  lines.on("line", line => { const v = JSON.parse(line); if (pending.length) pending.shift().resolve(v); else queue.push(v); });
  const exited = new Promise(resolve => p.once("exit", (code, signal) => {
    ended = true; for (const w of pending.splice(0)) w.reject(Error(`child exit ${code}/${signal}: ${stderr}`)); resolve({ code, signal });
  }));
  p.on("error", e => { for (const w of pending.splice(0)) w.reject(e); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.reject(Error("child ended: " + stderr)) :
    new Promise((resolve, reject) => pending.push({ resolve, reject }));
  t.after(async () => { if (!ended) { p.stdin.end(); await exited; } });
  const ready = await next(); assert.equal(ready.ready, true);
  return { ready: ready.snapshot, exited,
    next,
    send(c) { p.stdin.write(JSON.stringify(c) + "\n"); return next(); },
    fire(c) { p.stdin.write(JSON.stringify(c) + "\n"); },
    async close() { p.stdin.end(); return exited; },
  };
}
function emit(t, f, data) { t.diagnostic(JSON.stringify({ fixture: f.file, ...data })); }

// Fixed vector from the publication codec review. No production signer/key.
const SIGN_BYTES = '{"deadline_ms":200,"desktop_key":"desktop-1","fencing":2,"generation":1,"host_identity":"host-1","issued_at_ms":100,"lease_id":"lease-1","operation":"synthetic-increment","owned_app_id":"app-1","params_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","permit_id":"permit-1","run_id":"run-1","sequence":1,"service_epoch":1,"session_id":"session-1","target_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","worker_identity":"worker-1"}';
function signRequest(fixed = false) {
  return { attemptId: "sign-1", tuple: { origin_authority_namespace: "synthetic-authority", original_permit_id: "permit-1" },
    message: { lease_id: "lease-1", session_id: "session-1", host_identity: "host-1", worker_identity: "worker-1", run_id: "run-1",
      generation: fixed ? 1 : "run-7", desktop_key: "desktop-1", owned_app_id: "app-1", service_epoch: 1, fencing: 2,
      operation: "synthetic-increment", target_digest: A, params_digest: B, sequence: 1, issued_at_ms: 100, deadline_ms: 200, permit_id: "permit-1" },
    authority: { principalId: "synthetic-principal", grantId: "grant-1", storeGeneration: "store-1", lifecycleVersion: "11",
      reservationId: "synthetic-reservation", checkpoint: "checkpoint-fixture", signerFingerprint: "synthetic-only-no-key",
      serviceEpoch: 1, fencing: 2, authorized: true, revoked: false, registration: "active" },
    effect: { target: "synthetic-counter", params: { delta: 1 } }, businessVersion: 1, actionFingerprint: "fixture-label", finalCheckpoint: "no-real-checkpoint" };
}
function inspectSignFresh(file, id = "sign-1") {
  const output = spawnSync(process.execPath, [childFile, file], { input: JSON.stringify({ op: "sign-inspect", id }) + "\n", encoding: "utf8", timeout: 5000 });
  assert.equal(output.status, 0, output.stderr); return JSON.parse(output.stdout.trim().split("\n")[1]);
}
function rawSigning(file) {
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT * FROM fixture_sign_records ORDER BY attempt_id").all(); } finally { db.close(); }
}
function business(t) {
  const f = fixture(t); f.db.prepareSigning(signRequest(), 100);
  f.db.invokeSigning(f.db.armSigning("sign-1", 101), 102);
  f.db.commitBusiness("sign-1", delta(), clock(1, 110)); return f;
}
function evidenceInput(binding, scope, part, validUntil = 190) { return { kind: "synthetic-fixture-evidence", scope, part, binding, validUntil }; }
function fillEvidence(db, scope, omit = null, validUntil = 190) {
  const b = db.inspectBarrier("sign-1", scope);
  const now = db.inspectBarrier("sign-1").wallClockHighWater;
  for (const part of BARRIER_PARTS) if (part !== omit) db.recordSyntheticEvidence("sign-1", evidenceInput(b, scope, part, validUntil), now);
}
function qualified(t) { const f = business(t); fillEvidence(f.db, "business"); f.db.qualifySynthetic("sign-1", 112); return f; }
function readyBarrier(t) { const f = qualified(t); fillEvidence(f.db, "eligibility"); return f; }
function freshBarrier(file) {
  const output = spawnSync(process.execPath, [childFile, file], { input: JSON.stringify({ op: "barrier-inspect", id: "sign-1" }) + "\n", encoding: "utf8", timeout: 5000 });
  assert.equal(output.status, 0, output.stderr); return JSON.parse(output.stdout.trim().split("\n")[1]);
}

function barrierOperation(f, operation, now, options) {
  if (operation === "business") return f.db.commitBusiness("sign-1", delta(), clock(1, now), options);
  if (operation === "evidence") return f.db.recordSyntheticEvidence("sign-1", evidenceInput(f.db.inspectBarrier("sign-1", "business"), "business", BARRIER_PARTS[0], 190), now, options);
  if (operation === "qualify") return f.db.qualifySynthetic("sign-1", now, options);
  return f.db.claimSyntheticRecord("sign-1", now, options);
}
function forOperation(t, operation) {
  if (operation === "evidence") return business(t);
  if (operation === "qualify") { const f = business(t); fillEvidence(f.db, "business"); return f; }
  if (operation === "claim-test") return readyBarrier(t);
  const f = fixture(t); f.db.prepareSigning(signRequest(), 100); f.db.invokeSigning(f.db.armSigning("sign-1", 101), 102); return f;
}

for (const operation of ["business", "evidence", "qualify", "claim-test"]) {
  test(`barrier ${operation} genuine rollback authorization failure preserves primary error and quarantines session`, { skip: !supported }, t => {
    const f = forOperation(t, operation), before = fresh(f.file), barrier = operation !== "business" ? freshBarrier(f.file) : null;
    let caught;
    try { barrierOperation(f, operation, 113, { failure: "zero-row-after-accept", cleanupFailure: "deny-rollback" }); } catch (e) { caught = e; }
    assert.ok(caught); assert.equal(caught.code, "SQLITE_FIXTURE_BARRIER_CAS_AFTER_ACCEPT");
    assert.equal(caught.outcome, "unknown"); assert.ok(caught.cleanupError instanceof Error);
    assert.equal(caught.cleanupError.code, "ERR_SQLITE_ERROR"); assert.equal(caught.cleanupError.errcode, 23); // SQLITE_AUTH
    assert.match(caught.cleanupError.message, /authoriz/i);
    assert.throws(() => f.db.inspect(), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.throws(() => f.db.inspectSigning("sign-1"), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.throws(() => barrierOperation(f, operation, 114), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.deepEqual(fresh(f.file), before); if (barrier) assert.deepEqual(freshBarrier(f.file), barrier);
    f.db.close(); assert.deepEqual(fresh(f.file), before); if (barrier) assert.deepEqual(freshBarrier(f.file), barrier);
    emit(t, f, { operation, primary: caught.code, cleanup: { code: caught.cleanupError.code, errcode: caught.cleanupError.errcode }, sourceFactsUnchanged: true });
  });
}

test("preaccept business error plus failed actual ROLLBACK cannot leave a reusable connection", { skip: !supported }, t => {
  const f = business(t), before = freshBarrier(f.file);
  assert.throws(() => f.db.qualifySynthetic("sign-1", 111, { cleanupFailure: "deny-rollback" }), e => {
    assert.equal(e.code, "SQLITE_FIXTURE_SYNTHETIC_BARRIER_INCOMPLETE");
    assert.equal(e.cleanupError.errcode, 23); assert.equal(e.outcome, "unknown"); return true;
  });
  assert.throws(() => f.db.inspectBarrier("sign-1"), { code: "SQLITE_FIXTURE_UNKNOWN" });
  assert.deepEqual(freshBarrier(f.file), before); f.db.close(); assert.deepEqual(freshBarrier(f.file), before);
});

test("child preserves primary and rollback error separately, then refuses further commands", { skip: !supported, timeout: 10000 }, async t => {
  const f = business(t), before = freshBarrier(f.file), c = await child(t, f.file);
  const failure = await c.send({ op: "barrier-qualify", id: "sign-1", now: 111, options: { cleanupFailure: "deny-rollback" } });
  assert.equal(failure.code, "SQLITE_FIXTURE_SYNTHETIC_BARRIER_INCOMPLETE");
  assert.equal(failure.cleanupError.code, "ERR_SQLITE_ERROR"); assert.equal(failure.cleanupError.errcode, 23);
  assert.equal(failure.outcome, "unknown");
  assert.equal((await c.send({ op: "barrier-inspect", id: "sign-1" })).code, "SQLITE_FIXTURE_UNKNOWN");
  await c.close(); assert.deepEqual(freshBarrier(f.file), before);
});

for (const operation of ["evidence", "qualify", "claim-test"]) for (const reason of ["expired", "wall-rollback"]) {
  for (const failure of ["throw-before-commit-call", "throw-after-commit-call", "engine-commit-reject"]) {
    test(`${operation} ${reason} terminal with ${failure}: retain exact durable fact, unknown caller and no revival`, { skip: !supported }, t => {
      const f = forOperation(t, operation), before = freshBarrier(f.file), state = fresh(f.file);
      assert.throws(() => barrierOperation(f, operation, reason === "expired" ? 200 : 109, { failure }), e => {
        assert.equal(e.outcome, "unknown");
        if (failure === "engine-commit-reject") { assert.equal(e.code, "ERR_SQLITE_ERROR"); assert.equal(e.errcode, 787); }
        else assert.equal(e.code, "SQLITE_FIXTURE_INJECTED_COMMIT");
        return true;
      });
      assert.throws(() => f.db.inspectBarrier("sign-1"), { code: "SQLITE_FIXTURE_UNKNOWN" });
      const actual = freshBarrier(f.file); assert.equal(actual.ok, true);
      assert.equal(actual.result.terminalReason, failure === "throw-after-commit-call" ? reason : null);
      assert.equal(actual.result.syntheticClaim, null);
      assert.deepEqual(fresh(f.file), state); assert.equal(inspectSignFresh(f.file).result.originalDelivery, "unknown");
      if (failure !== "throw-after-commit-call") assert.deepEqual(actual, before);
      const reopened = driver.SqliteFixture.open(f.file); t.after(() => reopened.close()); reopened.recover();
      assert.throws(() => reopened.claimSyntheticRecord("sign-1", 113), {
        code: failure === "throw-after-commit-call" ? "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" : "SQLITE_FIXTURE_RECOVERY_EVIDENCE_MISSING",
      });
      emit(t, f, { operation, reason, failure, persistedTerminal: actual.result.terminalReason });
    });
  }
}

for (const failure of ["zero-row-after-accept", "zero-meta-row-after-accept"]) for (const poison of [false, true]) {
  test(`accepted legal increment poison=${poison} then ${failure}: rollback without fabricated durable safety facts`, { skip: !supported }, t => {
    const f = forOperation(t, "business"), before = fresh(f.file), o = { ...delta(1, [B]), clockPoisoned: poison };
    assert.throws(() => f.db.commitBusiness("sign-1", o, clock(1, 110), { failure }), {
      code: failure === "zero-row-after-accept" ? "SQLITE_FIXTURE_BARRIER_CAS_AFTER_ACCEPT" : "SQLITE_FIXTURE_BARRIER_META_CAS_AFTER_ACCEPT", outcome: "unknown",
    });
    assert.throws(() => f.db.commitBusiness("sign-1", o, clock(2, 111)), { code: "SQLITE_FIXTURE_UNKNOWN" });
    const after = fresh(f.file); assert.deepEqual(after, before);
    assert.equal(after.state.clockPoisoned, false); assert.deepEqual(after.state.revoked, []); assert.equal(after.state.revocationSequence, 0);
    assert.equal(freshBarrier(f.file).code, "SQLITE_FIXTURE_INTENT_MISSING");
    assert.equal(inspectSignFresh(f.file).result.storedResult, "committed-unpublishable");
    emit(t, f, { failure, acceptedLegalIncrement: true, poison, outcome: "unknown", noSafetyPersistenceClaim: true });
  });
}

test("engine COMMIT rejection and failed rollback keep original 787 and cleanup 23; reopening remains conservative", { skip: !supported }, t => {
  const f = readyBarrier(t), before = freshBarrier(f.file);
  assert.throws(() => f.db.claimSyntheticRecord("sign-1", 200, { failure: "engine-commit-reject", cleanupFailure: "deny-rollback" }), e => {
    assert.equal(e.code, "ERR_SQLITE_ERROR"); assert.equal(e.errcode, 787); assert.equal(e.cleanupError.errcode, 23);
    assert.equal(e.outcome, "unknown"); return true;
  });
  assert.throws(() => f.db.inspect(), { code: "SQLITE_FIXTURE_UNKNOWN" });
  assert.deepEqual(freshBarrier(f.file), before); f.db.close(); assert.deepEqual(freshBarrier(f.file), before);
});

test("postcommit primary error plus failed rollback cannot erase the committed terminal or unknown delivery", { skip: !supported }, t => {
  const f = readyBarrier(t);
  assert.throws(() => f.db.claimSyntheticRecord("sign-1", 200, { failure: "throw-after-commit-call", cleanupFailure: "deny-rollback" }), e => {
    assert.equal(e.code, "SQLITE_FIXTURE_INJECTED_COMMIT"); assert.equal(e.cleanupError.errcode, 23); return true;
  });
  const actual = freshBarrier(f.file); assert.equal(actual.result.terminalReason, "expired");
  assert.equal(actual.result.originalDelivery, "unknown"); assert.equal(actual.result.syntheticClaim, null);
  f.db.close(); assert.deepEqual(freshBarrier(f.file), actual);
});

for (const operation of ["business", "evidence", "qualify", "claim-test"]) {
  test(`barrier meta UPDATE actually affects zero rows after ${operation}; data and log rollback with unknown latch`, { skip: !supported }, t => {
    const f = forOperation(t, operation), before = fresh(f.file), barrier = operation !== "business" ? freshBarrier(f.file) : null;
    assert.throws(() => barrierOperation(f, operation, 113, { failure: "zero-meta-row-after-accept" }),
      { code: "SQLITE_FIXTURE_BARRIER_META_CAS_AFTER_ACCEPT", outcome: "unknown" });
    assert.throws(() => f.db.inspect(), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.deepEqual(fresh(f.file), before); if (barrier) assert.deepEqual(freshBarrier(f.file), barrier);
    const { DatabaseSync } = require("node:sqlite"), raw = new DatabaseSync(f.file, { readOnly: true });
    try {
      const meta = raw.prepare("SELECT version FROM fixture_barrier_meta").get();
      const count = raw.prepare("SELECT COUNT(*) AS n FROM fixture_barrier_commits").get(); assert.equal(meta.version, count.n);
    } finally { raw.close(); }
  });
}

for (const operation of ["evidence", "qualify", "claim-test"]) for (const reason of ["expired", "wall-rollback"]) {
  test(`barrier ${operation} ${reason} is a persisted wall-time terminal, never revived by lower samples or recover`, { skip: !supported }, t => {
    const f = forOperation(t, operation), original = f.db.inspectSigning("sign-1");
    if (reason === "wall-rollback") {
      // First persist a forward wall sample without enabling the next stage.
      if (operation === "evidence") barrierOperation(f, operation, 120);
      else {
        const scope = operation === "claim-test" ? "eligibility" : "business";
        f.db.recordSyntheticEvidence("sign-1", evidenceInput(f.db.inspectBarrier("sign-1", scope), scope, BARRIER_PARTS[0]), 120);
      }
    }
    assert.throws(() => barrierOperation(f, operation, reason === "expired" ? 200 : 119), { code: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" });
    const denied = f.db.inspectBarrier("sign-1");
    assert.equal(denied.timeDomain, "synthetic-wall-ms"); assert.equal(denied.terminalReason, reason);
    assert.equal(denied.wallClockHighWater, reason === "expired" ? 200 : 120); assert.equal(denied.syntheticClaim, null);
    assert.throws(() => barrierOperation(f, operation, 113), { code: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" });
    assert.throws(() => f.db.claimSyntheticRecord("sign-1", 114), { code: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" });
    assert.deepEqual(freshBarrier(f.file).result, denied);
    f.db.recover(); assert.equal(f.db.inspectBarrier("sign-1").terminalReason, reason);
    assert.throws(() => f.db.claimSyntheticRecord("sign-1", 115), { code: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" });
    assert.equal(f.db.inspectSigning("sign-1").resultDigest, original.resultDigest);
    assert.equal(f.db.inspectSigning("sign-1").originalDelivery, "unknown");
    for (const name of ["publish", "claim", "dispatch"]) assert.throws(() => f.db[name](), { code: "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE" });
    emit(t, f, { operation, reason, highWater: denied.wallClockHighWater });
  });
}

for (const operation of ["business", "evidence", "qualify", "claim-test"]) {
  test(`barrier ${operation} explicitly rejects unsupported zero-row probe before transaction`, { skip: !supported }, t => {
    const f = forOperation(t, operation), before = fresh(f.file), barrier = operation !== "business" ? freshBarrier(f.file) : null;
    assert.throws(() => barrierOperation(f, operation, 113, { failure: "zero-row-cas" }), { code: "SQLITE_FIXTURE_UNSUPPORTED_FAILURE" });
    assert.deepEqual(fresh(f.file), before); if (barrier) assert.deepEqual(freshBarrier(f.file), barrier);
  });
  test(`barrier ${operation} actual zero-row after accepting facts rolls back and blocks the entire session as unknown`, { skip: !supported }, t => {
    const f = forOperation(t, operation), before = fresh(f.file), barrier = operation !== "business" ? freshBarrier(f.file) : null;
    assert.throws(() => barrierOperation(f, operation, 113, { failure: "zero-row-after-accept" }), { code: "SQLITE_FIXTURE_BARRIER_CAS_AFTER_ACCEPT", outcome: "unknown" });
    assert.throws(() => f.db.inspect(), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.throws(() => f.db.inspectSigning("sign-1"), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.throws(() => barrierOperation(f, operation, 114), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.deepEqual(fresh(f.file), before); if (barrier) assert.deepEqual(freshBarrier(f.file), barrier);
    else assert.equal(freshBarrier(f.file).code, "SQLITE_FIXTURE_INTENT_MISSING");
    emit(t, f, { operation, cas: "zero-after-accept", outcome: "unknown", rollbackVerified: true });
  });
}

for (const operation of ["evidence", "qualify", "claim-test"]) for (const reason of ["expired", "wall-rollback"]) for (const afterCommit of [false, true]) {
  test(`real ${operation} ${reason} terminal COMMIT ${afterCommit ? "after" : "before"} exit shows exact durable time decision`, { skip: !supported, timeout: 10000 }, async t => {
    const f = forOperation(t, operation), before = f.db.inspectBarrier("sign-1"), c = await child(t, f.file);
    const cmd = operation === "evidence" ? { op: "barrier-evidence", evidence: evidenceInput(f.db.inspectBarrier("sign-1", "business"), "business", BARRIER_PARTS[0]) } :
      { op: operation === "qualify" ? "barrier-qualify" : "barrier-claim-test" };
    c.fire({ ...cmd, id: "sign-1", now: reason === "expired" ? 200 : 109, options: { failure: afterCommit ? "exit-after-commit" : "exit-before-commit" } });
    assert.equal((await c.exited).code, afterCommit ? 82 : 81);
    const actual = freshBarrier(f.file); assert.equal(actual.ok, true);
    assert.equal(actual.result.terminalReason, afterCommit ? reason : null);
    assert.equal(actual.result.wallClockHighWater, afterCommit && reason === "expired" ? 200 : before.wallClockHighWater);
    assert.equal(actual.result.syntheticClaim, null);
    const reader = await child(t, f.file); await reader.send({ op: "recover" });
    const attempt = await reader.send({ op: "barrier-claim-test", id: "sign-1", now: 113 });
    assert.equal(attempt.code, afterCommit ? "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" : "SQLITE_FIXTURE_RECOVERY_EVIDENCE_MISSING");
    emit(t, f, { operation, reason, afterCommit, terminalPersisted: actual.result.terminalReason });
  });
}

test("complete populated schema3 signing DB is refused read-only without changing source files", { skip: !supported }, t => {
  const f = fixture(t); f.db.prepareSigning(signRequest(), 100); f.db.invokeSigning(f.db.armSigning("sign-1", 101), 102);
  const { DatabaseSync } = require("node:sqlite"), source = new DatabaseSync(f.file, { readOnly: true });
  const dir = fs.mkdtempSync(path.join(runtime, "permit-phase-a-schema3-")), oldFile = path.join(dir, "old.sqlite");
  const old = new DatabaseSync(oldFile);
  try {
    const names = ["fixture_meta", "fixture_state", "fixture_attempt_sessions", "fixture_commit_guard", "fixture_commits", "fixture_sign_meta", "fixture_sign_records", "fixture_sign_commits"];
    old.exec(`PRAGMA application_id=${driver.APPLICATION_ID}; PRAGMA user_version=3`);
    for (const name of names) {
      let sql = source.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name).sql;
      if (name === "fixture_sign_records") sql = sql.replace(/,stored_result TEXT[\s\S]*$/, ")");
      old.exec(sql);
      for (const sourceRow of source.prepare(`SELECT * FROM ${name}`).all()) {
        const r = { ...sourceRow };
        if (name === "fixture_meta") r.schema_version = 3;
        if (name === "fixture_sign_records") { delete r.stored_result; delete r.original_delivery; delete r.local_send_evidence; }
        const keys = Object.keys(r); old.prepare(`INSERT INTO ${name}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...Object.values(r));
      }
    }
    const rows = old.prepare("SELECT * FROM fixture_sign_records ORDER BY attempt_id").all();
    const hash = createHash("sha256").update(JSON.stringify(rows.map(r => ({ ...r, result: r.result === null ? null : Buffer.from(r.result).toString("base64") })))).digest("hex");
    old.prepare("UPDATE fixture_sign_meta SET body_digest=?").run(hash);
    old.prepare("UPDATE fixture_sign_commits SET body_digest=? WHERE version=(SELECT MAX(version) FROM fixture_sign_commits)").run(hash);
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table'").get().n, 8);
    assert.equal(rows[0].status, "hash-committed"); assert.equal(old.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { source.close(); old.close(); }
  const before = directoryDigests(dir);
  assert.throws(() => driver.SqliteFixture.open(oldFile), { code: "SQLITE_FIXTURE_FORMAT" });
  assert.deepEqual(directoryDigests(dir), before);
});

for (const cut of ["before-local-write", "before-callback-record", "evidence-before-commit", "evidence-after-commit", "after-callback-record"]) {
  test(`original local-send process exits ${cut}; committed hash and delivery axes remain independent`, { skip: !supported, timeout: 10000 }, async t => {
    const f = fixture(t), c = await child(t, f.file);
    await c.send({ op: "sign-prepare", request: signRequest(), now: 100 }); await c.send({ op: "sign-arm", id: "sign-1", handle: "h", now: 101 });
    const cmd = { op: "sign-invoke", handle: "h", now: 102 };
    if (cut.startsWith("evidence")) cmd.localSendOptions = { failure: cut.endsWith("before-commit") ? "exit-before-commit" : "exit-after-commit" };
    else cmd.deliveryFailure = "exit-" + cut;
    c.fire(cmd); const exit = await c.exited;
    assert.equal(exit.code, { "before-local-write": 85, "before-callback-record": 86, "evidence-before-commit": 81, "evidence-after-commit": 82, "after-callback-record": 87 }[cut]);
    const actual = inspectSignFresh(f.file); assert.equal(actual.ok, true);
    assert.equal(actual.result.storedResult, "committed-unpublishable"); assert.equal(actual.result.originalDelivery, "unknown");
    assert.equal(actual.result.localSendEvidence, ["evidence-after-commit", "after-callback-record"].includes(cut) ? "local-write-completed" : "none");
    const reader = await child(t, f.file); await reader.send({ op: "recover" });
    const recovered = await reader.send({ op: "sign-inspect", id: "sign-1" });
    assert.equal(recovered.result.originalDelivery, "unknown"); assert.equal(recovered.result.resultDigest, actual.result.resultDigest);
    assert.equal((await reader.send({ op: "sign-arm", id: "sign-1", handle: "new", now: 104 })).ok, false);
    emit(t, f, { cut, exit, localEvidence: actual.result.localSendEvidence });
  });
}

test("business rejection keeps accepted safety facts without fabricating an intent or claim", { skip: !supported }, t => {
  const f = fixture(t); f.db.prepareSigning(signRequest(), 100); f.db.invokeSigning(f.db.armSigning("sign-1", 101), 102);
  const fingerprint = createHash("sha256").update(signRequest().authority.signerFingerprint).digest("hex");
  const denied = f.db.commitBusiness("sign-1", delta(1, [fingerprint]), clock(1, 110));
  assert.equal(denied.businessDenied, "REVOKED"); assert.deepEqual(fresh(f.file).state.revoked, [fingerprint]);
  assert.equal(fresh(f.file).state.consumed.length, 0); assert.equal(freshBarrier(f.file).code, "SQLITE_FIXTURE_INTENT_MISSING");
  assert.throws(() => f.db.claim(), { code: "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE" });
});

test("qualification COMMIT errors preserve business intent and unknown delivery, never real eligibility", { skip: !supported }, t => {
  for (const failure of ["throw-before-commit-call", "throw-after-commit-call", "engine-commit-reject"]) {
    const f = business(t); fillEvidence(f.db, "business");
    assert.throws(() => f.db.qualifySynthetic("sign-1", 112, { failure }), e => {
      assert.equal(e.outcome, "unknown");
      if (failure === "engine-commit-reject") { assert.equal(e.code, "ERR_SQLITE_ERROR"); assert.equal(e.errcode, 787); }
      return true;
    });
    const actual = freshBarrier(f.file); assert.equal(actual.ok, true);
    assert.equal(!!actual.result.qualification, failure === "throw-after-commit-call");
    assert.equal(actual.result.claimAllowed, false); assert.equal(actual.result.originalDelivery, "unknown");
    assert.equal(fresh(f.file).state.consumed.length, 1);
    assert.throws(() => f.db.claim(), { code: "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE" });
  }
});

test("business/checkpoint/intent commit together; both synthetic barriers still never grant real publication or claim", { skip: !supported }, t => {
  const f = readyBarrier(t), before = f.db.inspectBarrier("sign-1");
  assert.equal(f.db.inspect().state.consumed.length, 1); assert.equal(before.intentStatus, "committed-unpublishable");
  const r = f.db.claimSyntheticRecord("sign-1", 113, { expectedVersion: before.version });
  assert.equal(r.syntheticClaim.kind, "synthetic-claim-only"); assert.equal(r.qualification.kind, "synthetic-qualification-only");
  assert.equal(r.claimAllowed, false); assert.equal(r.originalDelivery, "unknown");
  assert.equal(r.binding.effectId, canonicalEffectTuple(signRequest().tuple).effectId);
  for (const name of ["publish", "claim", "dispatch"]) for (const input of [undefined, true, { verified: true, publishable: true }]) {
    assert.throws(() => f.db[name](input), { code: "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE" });
  }
  assert.throws(() => f.db.claimSyntheticRecord("sign-1", 114), { code: "SQLITE_FIXTURE_SYNTHETIC_CLAIM_EXISTS" });
  assert.deepEqual(freshBarrier(f.file).result, r);
  f.db.cancelSigning("sign-1", 115); const cancelled = f.db.inspectBarrier("sign-1");
  assert.deepEqual(cancelled.binding, r.binding); assert.equal(cancelled.originalDelivery, "unknown");
  f.db.recover(); const recovered = f.db.inspectBarrier("sign-1"); assert.deepEqual(recovered.binding, r.binding);
  assert.equal(f.db.inspectSigning("sign-1").storedResult, "committed-unpublishable");
  assert.throws(() => f.db.claimSyntheticRecord("sign-1", 116));
});

for (const scope of ["business", "eligibility"]) for (const missing of BARRIER_PARTS) {
  test(`persistent ${scope} missing ${missing} blocks next synthetic transition and all real paths`, { skip: !supported }, t => {
    const f = scope === "business" ? business(t) : qualified(t); fillEvidence(f.db, scope, missing);
    if (scope === "business") assert.throws(() => f.db.qualifySynthetic("sign-1", 112), { code: "SQLITE_FIXTURE_SYNTHETIC_BARRIER_INCOMPLETE" });
    else assert.throws(() => f.db.claimSyntheticRecord("sign-1", 112), { code: "SQLITE_FIXTURE_SYNTHETIC_BARRIER_INCOMPLETE" });
    assert.throws(() => f.db.claim(), { code: "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE" });
    assert.equal(freshBarrier(f.file).result.syntheticClaim, null);
  });
}

for (const field of ["namespace", "attemptId", "businessSequence", "signedSequence", "rawDigest", "c0", "intentDigest", "effectId", "resultDigest"]) {
  test(`synthetic evidence exact binding rejects ${field} mismatch without writes`, { skip: !supported }, t => {
    const f = business(t), before = f.db.inspectBarrier("sign-1"), b = f.db.inspectBarrier("sign-1", "business");
    b[field] = typeof b[field] === "number" ? b[field] + 1 : "wrong";
    assert.throws(() => f.db.recordSyntheticEvidence("sign-1", evidenceInput(b, "business", BARRIER_PARTS[0]), 111), { code: "SQLITE_FIXTURE_EVIDENCE_BINDING" });
    assert.deepEqual(freshBarrier(f.file).result, before);
  });
}

test("booleans, expired evidence, wrong scope, stale CAS and restart cannot fill missing qualification proof", { skip: !supported }, t => {
  const f = business(t), before = f.db.inspectBarrier("sign-1"), binding = f.db.inspectBarrier("sign-1", "business");
  for (const invalid of [true, { verified: true }, { ...evidenceInput(binding, "business", BARRIER_PARTS[0]), kind: "real-anchor" },
    evidenceInput(binding, "wrong", BARRIER_PARTS[0])]) {
    assert.throws(() => f.db.recordSyntheticEvidence("sign-1", invalid, 111));
  }
  assert.throws(() => f.db.recordSyntheticEvidence("sign-1", evidenceInput(binding, "business", BARRIER_PARTS[0]), 111, { expectedVersion: before.version + 1 }), { code: "SQLITE_FIXTURE_BARRIER_CAS" });
  assert.deepEqual(freshBarrier(f.file).result, before);
  fillEvidence(f.db, "business", null, 115);
  assert.throws(() => f.db.qualifySynthetic("sign-1", 116), { code: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" });
  f.db.recover();
  assert.throws(() => f.db.recordSyntheticEvidence("sign-1", evidenceInput(binding, "business", BARRIER_PARTS[0]), 112), { code: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" });
  assert.equal(f.db.inspectBarrier("sign-1").qualification, null); assert.equal(f.db.inspectSigning("sign-1").originalDelivery, "unknown");
});

test("qualification evidence is bound to its own sequence/digest and expiry; log rows remain facts, not fsync credentials", { skip: !supported }, t => {
  const f = qualified(t), b = f.db.inspectBarrier("sign-1", "eligibility"), before = f.db.inspectBarrier("sign-1");
  for (const change of [v => { v.eligibilityDigest = A; }, v => { v.qualification.qualificationSequence++; },
    v => { v.qualification.businessEvidenceDigest = B; }]) {
    const wrong = JSON.parse(JSON.stringify(b)); change(wrong);
    assert.throws(() => f.db.recordSyntheticEvidence("sign-1", evidenceInput(wrong, "eligibility", BARRIER_PARTS[0]), 113), { code: "SQLITE_FIXTURE_EVIDENCE_BINDING" });
  }
  assert.deepEqual(freshBarrier(f.file).result, before);
  fillEvidence(f.db, "eligibility", null, 115);
  assert.throws(() => f.db.claimSyntheticRecord("sign-1", 116), { code: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" });
  assert.equal(f.db.inspectBarrier("sign-1").syntheticClaim, null);
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(f.file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM fixture_barrier_commits ORDER BY version").all();
    assert.ok(rows.some(r => r.operation === "business")); assert.ok(rows.some(r => r.operation === "qualify"));
    assert.ok(rows.every(r => r.cas_changes === 1)); assert.equal(Object.hasOwn(rows[0], "fsyncVerified"), false);
    const evidence = JSON.parse(db.prepare("SELECT evidence FROM fixture_barriers").get().evidence);
    assert.ok(Object.values(evidence.eligibility).every(v => v.kind === "synthetic-fixture-evidence"));
  } finally { db.close(); }
  assert.throws(() => f.db.dispatch({ fsyncVerified: true }), { code: "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE" });
});

for (const operation of ["qualify", "claim-test"]) {
  test(`two real processes compete synthetic ${operation} CAS; only one durable test record, no real claim`, { skip: !supported, timeout: 10000 }, async t => {
    const f = operation === "qualify" ? business(t) : readyBarrier(t);
    if (operation === "qualify") fillEvidence(f.db, "business");
    const version = f.db.inspectBarrier("sign-1").version, cs = await Promise.all([child(t, f.file), child(t, f.file)]);
    const results = await Promise.all(cs.map(c => c.send({ op: operation === "qualify" ? "barrier-qualify" : "barrier-claim-test", id: "sign-1", now: 113, options: { expectedVersion: version } })));
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).code, "SQLITE_FIXTURE_BARRIER_CAS");
    for (const c of cs) assert.equal((await c.send({ op: "real-claim", id: "sign-1", verified: true })).code, "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE");
    assert.equal(freshBarrier(f.file).result.version, version + 1);
    emit(t, f, { operation, results: results.map(r => ({ ok: r.ok, code: r.code })) });
  });
}

for (const operation of ["business", "business-evidence", "qualification", "eligibility-evidence", "synthetic-claim"]) for (const afterCommit of [false, true]) {
  test(`real ${operation} exit ${afterCommit ? "after" : "before"} COMMIT reopens facts without enabling publication`, { skip: !supported, timeout: 10000 }, async t => {
    const f = fixture(t), c = await child(t, f.file);
    assert.equal((await c.send({ op: "sign-prepare", request: signRequest(), now: 100 })).ok, true);
    await c.send({ op: "sign-arm", id: "sign-1", handle: "h", now: 101 });
    assert.equal((await c.send({ op: "sign-invoke", handle: "h", now: 102 })).ok, true);
    const fill = async (scope) => {
      const b = (await c.send({ op: "barrier-inspect", id: "sign-1", scope })).result;
      for (const part of BARRIER_PARTS) assert.equal((await c.send({ op: "barrier-evidence", id: "sign-1", evidence: evidenceInput(b, scope, part), now: scope === "business" ? 111 : 112 })).ok, true);
    };
    if (operation !== "business") assert.equal((await c.send({ op: "business", id: "sign-1", observation: delta(), clocks: clock(1, 110) })).ok, true);
    if (["qualification", "eligibility-evidence", "synthetic-claim"].includes(operation)) await fill("business");
    if (["eligibility-evidence", "synthetic-claim"].includes(operation)) await c.send({ op: "barrier-qualify", id: "sign-1", now: 112 });
    if (operation === "synthetic-claim") await fill("eligibility");
    const options = { failure: afterCommit ? "exit-after-commit" : "exit-before-commit" };
    let cmd;
    if (operation === "business") cmd = { op: "business", id: "sign-1", observation: delta(), clocks: clock(1, 110), options };
    else if (operation.endsWith("evidence")) {
      const scope = operation === "business-evidence" ? "business" : "eligibility", binding = (await c.send({ op: "barrier-inspect", id: "sign-1", scope })).result;
      cmd = { op: "barrier-evidence", id: "sign-1", evidence: evidenceInput(binding, scope, BARRIER_PARTS[0]), now: 113, options };
    } else cmd = { op: operation === "qualification" ? "barrier-qualify" : "barrier-claim-test", id: "sign-1", now: 113, options };
    c.fire(cmd); assert.equal((await c.exited).code, afterCommit ? 82 : 81);
    const read = freshBarrier(f.file);
    if (operation === "business" && !afterCommit) {
      assert.equal(read.code, "SQLITE_FIXTURE_INTENT_MISSING"); assert.equal(fresh(f.file).state.consumed.length, 0);
    } else {
      assert.equal(read.ok, true); assert.equal(read.result.originalDelivery, "unknown"); assert.equal(read.result.claimAllowed, false);
      if (operation === "qualification") assert.equal(!!read.result.qualification, afterCommit);
      if (operation === "synthetic-claim") assert.equal(!!read.result.syntheticClaim, afterCommit);
      if (operation.endsWith("evidence")) assert.equal(Object.keys(read.result.evidence[operation === "business-evidence" ? "business" : "eligibility"]).length, afterCommit ? 1 : 0);
      assert.equal(read.result.binding.effectId, canonicalEffectTuple(signRequest().tuple).effectId);
    }
    const reopened = await child(t, f.file); await reopened.send({ op: "recover" });
    assert.equal((await reopened.send({ op: "real-publish" })).code, "SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE");
    if (read.ok) assert.equal((await reopened.send({ op: "barrier-qualify", id: "sign-1", now: 114 })).ok, false);
    assert.equal((await reopened.send({ op: "sign-inspect", id: "sign-1" })).result.storedResult, "committed-unpublishable");
    emit(t, f, { operation, afterCommit, intentPresent: read.ok });
  });
}

test("SQLite numeric-generation prepared bytes match independent fixed 14+3 vector across real restart", { skip: !supported }, t => {
  fs.mkdirSync(runtime, { recursive: true });
  const dir = fs.mkdtempSync(path.join(runtime, "permit-phase-a-sign-vector-")), file = path.join(dir, "fixture.sqlite");
  const db = driver.SqliteFixture.initialize(file, { ...config(), runGeneration: "1" }); t.after(() => db.close());
  const p = db.prepareSigning(signRequest(true), 100);
  assert.equal(Buffer.from(p.prepared.raw, "base64").toString(), SIGN_BYTES);
  assert.equal(p.prepared.digest, "4c2b7a0a447097feec4d0ab7178f0d4c8858178b732a0b117cb21a5c3d078186");
  const h = db.armSigning("sign-1", 101); db.invokeSigning(h, 102);
  assert.equal(Buffer.from(rawSigning(file)[0].result).toString("base64"), "89+1cVr9doPV0zO67pEp+QdlDegYryQgJXeYvoK+BU4=");
  const reopened = inspectSignFresh(file); assert.equal(reopened.ok, true); assert.deepEqual(reopened.result.prepared, p.prepared);
});

test("cancellation before gate or after gate prevents calling; committed hash survives client unknown", { skip: !supported }, t => {
  for (const phase of ["prepared", "gate", "committed"]) {
    const f = fixture(t), canceler = driver.SqliteFixture.open(f.file); t.after(() => canceler.close());
    f.db.prepareSigning(signRequest(), 100);
    const h = phase !== "prepared" ? f.db.armSigning("sign-1", 101) : null;
    if (phase === "committed") f.db.invokeSigning(h, 102);
    const old = f.db.inspectSigning("sign-1"), cancelled = canceler.cancelSigning("sign-1", 103);
    assert.equal(cancelled.status, phase === "prepared" ? "aborted" : phase === "gate" ? "sign-outcome-unknown" : "hash-committed");
    assert.throws(() => f.db.armSigning("sign-1", 104));
    if (phase === "gate") assert.throws(() => f.db.invokeSigning(h, 104));
    const after = inspectSignFresh(f.file); assert.equal(after.ok, true); assert.equal(after.result.status, cancelled.status);
    assert.equal(after.result.resultDigest, old.resultDigest); assert.deepEqual(after.result.prepared, old.prepared);
  }
});

test("recovery fences live signing owner and keeps sequence tombstones and exact bytes", { skip: !supported }, t => {
  const f = fixture(t), other = driver.SqliteFixture.open(f.file); t.after(() => other.close());
  const prepared = f.db.prepareSigning(signRequest(), 100), h = f.db.armSigning("sign-1", 101);
  other.recover(); assert.throws(() => f.db.invokeSigning(h, 102), { code: "SQLITE_FIXTURE_STALE_OWNER" });
  const recovered = other.inspectSigning("sign-1"); assert.equal(recovered.status, "sign-outcome-unknown");
  assert.deepEqual(recovered.prepared, prepared.prepared); assert.equal(recovered.resultDigest, null);
  assert.throws(() => other.armSigning("sign-1", 102));
});

test("durable prepared bytes and unique reservations survive cancel/restart; fixture hash result is never publishable", { skip: !supported }, t => {
  const f = fixture(t), r = signRequest(), prepared = f.db.prepareSigning(r, 100);
  const fixed = SIGN_BYTES.replace('"generation":1', '"generation":"run-7"');
  assert.equal(Buffer.from(prepared.prepared.raw, "base64").toString(), fixed);
  assert.equal(prepared.localSignerCalls, 0); r.message.deadline_ms = 999;
  const h = f.db.armSigning("sign-1", 101, { expectedVersion: 1 });
  assert.deepEqual(f.db.inspectSigning("sign-1").prepared, prepared.prepared);
  const committed = f.db.invokeSigning(h, 102);
  assert.equal(committed.status, "hash-committed"); assert.equal(committed.localSignerCalls, 1);
  assert.equal(committed.storedResult, "committed-unpublishable");
  assert.equal(committed.originalDelivery, "unknown"); assert.equal(committed.localSendEvidence, "none");
  assert.equal(committed.clientOutcome, "unknown");
  assert.equal(committed.publishable, false); assert.equal(committed.executionAuthorized, false);
  assert.throws(() => f.db.invokeSigning(h, 103), { code: "SQLITE_FIXTURE_CAPABILITY" });
  const stored = rawSigning(f.file)[0];
  const expected = createHash("sha256").update("SYNTHETIC-NOT-A-SIGNATURE-v1\0").update(fixed).digest();
  assert.deepEqual(Buffer.from(stored.result), expected);
  const cancel = f.db.cancelSigning("sign-1", 103); assert.equal(cancel.status, "hash-committed"); assert.equal(cancel.clientOutcome, "unknown");
  assert.equal(cancel.resultDigest, committed.resultDigest);
  assert.equal(cancel.storedResult, committed.storedResult); assert.equal(cancel.originalDelivery, "unknown");
  const reopened = inspectSignFresh(f.file); assert.equal(reopened.ok, true); assert.equal(reopened.result.status, "hash-committed");
  assert.equal(reopened.result.localSignerCalls, 0); assert.deepEqual(reopened.result.prepared, prepared.prepared);
  f.db.recover(); assert.equal(f.db.inspectSigning("sign-1").status, "hash-committed");
  assert.throws(() => f.db.armSigning("sign-1", 104));
  emit(t, f, { signingStatus: committed.status, rawDigest: prepared.prepared.digest, resultDigest: committed.resultDigest });
});

test("normal original response records only local send evidence; restart never infers client acknowledgement", { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t), c = await child(t, f.file);
  assert.equal((await c.send({ op: "sign-prepare", request: signRequest(), now: 100 })).ok, true);
  assert.equal((await c.send({ op: "sign-arm", id: "sign-1", handle: "g", now: 101 })).ok, true);
  const deliveredLocally = await c.send({ op: "sign-invoke", handle: "g", now: 102 });
  assert.equal(deliveredLocally.ok, true); assert.equal(deliveredLocally.result.originalDelivery, "unknown");
  assert.equal(deliveredLocally.result.storedResult, "committed-unpublishable");
  // Wait for the sender's local write callback via subsequent serialized RPC,
  // then close the process. No client ACK API exists.
  await c.send({ op: "sign-inspect", id: "sign-1" }); await c.close();
  const actual = inspectSignFresh(f.file); assert.equal(actual.ok, true);
  assert.equal(actual.result.originalDelivery, "unknown"); assert.equal(actual.result.clientOutcome, "unknown");
  assert.equal(actual.result.localSendEvidence, "local-write-completed");
  assert.equal(actual.result.storedResult, "committed-unpublishable"); assert.equal(actual.result.resultDigest, deliveredLocally.result.resultDigest);
  const again = inspectSignFresh(f.file); assert.deepEqual(again.result, actual.result); // history read cannot rewrite original delivery
  f.db.recover(); const recovered = f.db.inspectSigning("sign-1");
  assert.equal(recovered.originalDelivery, "unknown"); assert.equal(recovered.localSendEvidence, "local-write-completed");
  assert.equal(recovered.storedResult, "committed-unpublishable");
  assert.throws(() => f.db.armSigning("sign-1", 104));
  emit(t, f, { storedResult: recovered.storedResult, originalDelivery: recovered.originalDelivery, localSendEvidence: recovered.localSendEvidence });
});

test("local send bookkeeping is result/session-bound and cannot change committed signature or original delivery", { skip: !supported }, t => {
  const f = fixture(t); f.db.prepareSigning(signRequest(), 100); const h = f.db.armSigning("sign-1", 101);
  const committed = f.db.invokeSigning(h, 102), bytes = Buffer.from(rawSigning(f.file)[0].result);
  assert.throws(() => f.db.recordSigningLocalSend("sign-1", A), { code: "SQLITE_FIXTURE_DELIVERY_BINDING" });
  const other = driver.SqliteFixture.open(f.file); t.after(() => other.close());
  assert.throws(() => other.recordSigningLocalSend("sign-1", committed.resultDigest), { code: "SQLITE_FIXTURE_DELIVERY_BINDING" });
  assert.equal(f.db.inspectSigning("sign-1").localSendEvidence, "none");
  f.db.recordSigningLocalSend("sign-1", committed.resultDigest);
  const cancel = f.db.cancelSigning("sign-1", 103);
  assert.equal(cancel.storedResult, "committed-unpublishable"); assert.equal(cancel.originalDelivery, "unknown");
  assert.equal(cancel.localSendEvidence, "local-write-completed"); assert.deepEqual(Buffer.from(rawSigning(f.file)[0].result), bytes);
  assert.throws(() => f.db.invokeSigning(h, 104), { code: "SQLITE_FIXTURE_CAPABILITY" });
});

for (const phase of ["prepare-before-commit", "prepare-after-commit", "gate-before-commit", "gate-after-commit", "before-hash", "after-hash", "result-before-commit", "result-after-commit"]) {
  test(`real signing process exit at ${phase}: no reconstructed calling right`, { skip: !supported, timeout: 10000 }, async t => {
    const f = fixture(t), c = await child(t, f.file), r = signRequest();
    if (!phase.startsWith("prepare")) assert.equal((await c.send({ op: "sign-prepare", request: r, now: 100 })).ok, true);
    if (["before-hash", "after-hash", "result-before-commit", "result-after-commit"].includes(phase)) {
      assert.equal((await c.send({ op: "sign-arm", id: "sign-1", now: 101, handle: "gate" })).ok, true);
    }
    const failure = phase === "before-hash" ? "exit-before-hash" : phase === "after-hash" ? "exit-after-hash" :
      phase.endsWith("before-commit") ? "exit-before-commit" : "exit-after-commit";
    c.fire(phase.startsWith("prepare") ? { op: "sign-prepare", request: r, now: 100, options: { failure } } :
      phase.startsWith("gate") ? { op: "sign-arm", id: "sign-1", now: 101, handle: "gate", options: { failure } } :
        { op: "sign-invoke", handle: "gate", now: 102, options: { failure } });
    const exit = await c.exited; assert.equal(exit.code, failure === "exit-before-hash" ? 83 : failure === "exit-after-hash" ? 84 : failure === "exit-before-commit" ? 81 : 82);
    const rows = rawSigning(f.file);
    if (phase === "prepare-before-commit") { assert.equal(rows.length, 0); emit(t, f, { phase, exit, persistedPrepare: false }); return; }
    const expected = phase === "result-after-commit" ? "hash-committed" : ["prepare-after-commit", "gate-before-commit"].includes(phase) ? "sign-prepared" : "sign-call-possible";
    assert.equal(rows[0].status, expected);
    assert.equal(rows[0].stored_result, expected === "hash-committed" ? "committed-unpublishable" : "not-stored");
    assert.equal(rows[0].original_delivery, "unknown"); assert.equal(rows[0].local_send_evidence, "none");
    const reader = await child(t, f.file);
    const original = await reader.send({ op: "sign-inspect", id: "sign-1" }); assert.equal(original.ok, true);
    assert.equal((await reader.send({ op: "sign-invoke", handle: "gate", now: 103 })).code, "SQLITE_FIXTURE_CAPABILITY");
    const rearm = await reader.send({ op: "sign-arm", id: "sign-1", handle: "new", now: 103 }); assert.equal(rearm.ok, false);
    assert.equal((await reader.send({ op: "recover" })).ok, true);
    const recovered = await reader.send({ op: "sign-inspect", id: "sign-1" }); assert.equal(recovered.ok, true);
    assert.equal(recovered.result.status, expected === "hash-committed" ? expected : "sign-outcome-unknown");
    assert.equal(recovered.result.originalDelivery, "unknown");
    assert.equal(recovered.result.storedResult, original.result.storedResult);
    assert.equal(recovered.result.clientOutcome, "unknown");
    assert.deepEqual(recovered.result.prepared, original.result.prepared); assert.equal(recovered.result.localSignerCalls, 0);
    assert.equal((await reader.send({ op: "sign-arm", id: "sign-1", handle: "new", now: 104 })).ok, false);
    const reuse = signRequest(); reuse.attemptId = "sign-2"; reuse.message.permit_id = "permit-2"; reuse.tuple.original_permit_id = "permit-2";
    reuse.effect.params.delta = 2; // different action, same permanently reserved sequence
    assert.equal((await reader.send({ op: "sign-prepare", request: reuse, now: 104 })).code, "SQLITE_FIXTURE_SIGN_RESERVED");
    emit(t, f, { phase, exit, persisted: expected, recovered: recovered.result.status, rawDigest: recovered.result.prepared.digest });
  });
}

for (const operation of ["arm", "invoke"]) for (const failure of ["throw-before-commit-call", "throw-after-commit-call", "engine-commit-reject"]) {
  test(`${operation} ${failure}: unknown session cannot sign or rearm`, { skip: !supported }, t => {
    const f = fixture(t); f.db.prepareSigning(signRequest(), 100);
    const h = operation === "invoke" ? f.db.armSigning("sign-1", 101) : null;
    assert.throws(() => operation === "arm" ? f.db.armSigning("sign-1", 101, { failure }) : f.db.invokeSigning(h, 102, { failure }), e => {
      assert.equal(e.outcome, "unknown");
      if (failure === "engine-commit-reject") { assert.equal(e.code, "ERR_SQLITE_ERROR"); assert.equal(e.errcode, 787); }
      return true;
    });
    assert.throws(() => f.db.inspectSigning("sign-1"), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.throws(() => f.db.invokeSigning(h, 103), { code: "SQLITE_FIXTURE_UNKNOWN" });
    const actual = inspectSignFresh(f.file); assert.equal(actual.ok, true);
    assert.equal(actual.result.status, operation === "invoke" ? failure === "throw-after-commit-call" ? "hash-committed" : "sign-call-possible" :
      failure === "throw-after-commit-call" ? "sign-call-possible" : "sign-prepared");
    assert.equal(actual.result.originalDelivery, "unknown"); assert.equal(actual.result.localSendEvidence, "none");
    assert.equal(actual.result.clientOutcome, "unknown");
    assert.equal(actual.result.storedResult, operation === "invoke" && failure === "throw-after-commit-call" ? "committed-unpublishable" : "not-stored");
    assert.equal(actual.result.localSignerCalls, 0); emit(t, f, { operation, failure, observed: actual.result.status });
  });
}

test("two real processes race the same prepare owner gate; only creator obtains it, and it cannot call twice", { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t), cs = await Promise.all([child(t, f.file), child(t, f.file)]);
  assert.equal((await cs[0].send({ op: "sign-prepare", request: signRequest(), now: 100 })).ok, true);
  const results = await Promise.all(cs.map(c => c.send({ op: "sign-arm", id: "sign-1", handle: "g", now: 101, options: { expectedVersion: 1 } })));
  assert.equal(results[0].ok, true); assert.equal(results[1].ok, false);
  const loser = await cs[1].send({ op: "sign-invoke", handle: "g", now: 102 }); assert.equal(loser.code, "SQLITE_FIXTURE_CAPABILITY");
  const signed = await cs[0].send({ op: "sign-invoke", handle: "g", now: 102 }); assert.equal(signed.ok, true); assert.equal(signed.result.localSignerCalls, 1);
  assert.equal((await cs[0].send({ op: "sign-invoke", handle: "g", now: 103 })).code, "SQLITE_FIXTURE_CAPABILITY");
  emit(t, f, { gateRace: results.map(r => ({ ok: r.ok, code: r.code })), localSignerCalls: signed.result.localSignerCalls });
});

test("signing fails closed on cancellation, byte corruption, control change, expiry and old signing schema", { skip: !supported }, t => {
  for (const fault of ["cancel", "control", "expiry", "rollback", "corrupt", "schema", "old-schema"]) {
    const f = fixture(t); f.db.prepareSigning(signRequest(), 100);
    if (fault === "cancel") f.db.cancelSigning("sign-1", 101);
    if (fault === "control") f.db.command(command("revokeControl", { axis: "grant", expectedVersion: 1 }));
    if (["corrupt", "schema", "old-schema"].includes(fault)) {
      const { DatabaseSync } = require("node:sqlite"), edit = new DatabaseSync(f.file);
      edit.exec(fault === "corrupt" ? "UPDATE fixture_sign_records SET body='{}'" : fault === "schema" ? "UPDATE fixture_sign_meta SET semantic_format=0" : "PRAGMA user_version=2"); edit.close();
      assert.throws(() => driver.SqliteFixture.open(f.file));
    }
    if (fault === "rollback") {
      const h = f.db.armSigning("sign-1", 110);
      assert.throws(() => f.db.invokeSigning(h, 109));
      assert.throws(() => f.db.invokeSigning(h, 111), { code: "SQLITE_FIXTURE_CAPABILITY" });
    } else assert.throws(() => f.db.armSigning("sign-1", fault === "expiry" ? 200 : 102));
    if (["expiry", "rollback", "control"].includes(fault)) {
      assert.equal(f.db.inspectSigning("sign-1").status, "sign-outcome-unknown");
      assert.throws(() => f.db.armSigning("sign-1", 105));
      assert.equal(f.db.inspectSigning("sign-1").localSignerCalls, 0);
    }
    const rows = rawSigning(f.file); assert.equal(rows[0].result, null);
  }
});
function directoryDigests(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex")]));
}

for (const mode of ["wal", "journal", "forged-schema-wal"]) {
  test(`foreign preflight is nonwriting even with ${mode} sidecars`, { skip: !supported }, t => {
    fs.mkdirSync(runtime, { recursive: true });
    const dir = fs.mkdtempSync(path.join(runtime, "permit-phase-a-foreign-")), file = path.join(dir, "foreign.sqlite");
    const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file);
    if (mode !== "journal") db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    db.exec("PRAGMA user_version=3; CREATE TABLE protected_state(id INTEGER PRIMARY KEY,body TEXT,sha256 TEXT); INSERT INTO protected_state VALUES(1,'original','not-a-fixture')");
    if (mode === "forged-schema-wal") db.exec(`PRAGMA application_id=${driver.APPLICATION_ID}; PRAGMA user_version=${driver.SCHEMA}`);
    if (mode === "journal") {
      db.close();
      const crash = spawnSync(process.execPath, ["-e", `
        const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE protected_state SET body='uncommitted';");
        for(let i=2;i<100;i++)db.prepare("INSERT INTO protected_state VALUES(?,?,?)").run(i,'x'.repeat(8192),'uncommitted');
        process.exit(93);`, file], { encoding: "utf8", timeout: 5000 });
      assert.equal(crash.status, 93, crash.stderr); assert.ok(fs.existsSync(file + "-journal"));
    } else assert.ok(fs.existsSync(file + "-wal"));
    const before = directoryDigests(dir);
    assert.throws(() => driver.SqliteFixture.open(file));
    assert.deepEqual(directoryDigests(dir), before); // includes WAL/SHM/journal, not just main DB
    if (mode !== "journal") db.close();
    emit(t, { file }, { mode, sourceFilesUnchanged: true });
  });
}

for (const chain of ["legal", "gap", "duplicate", "drops-revocation"]) for (const wallRollback of [false, true]) {
  test(`stale SQL row and C0: ${chain}, wallRollback=${wallRollback} retain only applicable facts`, { skip: !supported }, t => {
    const f = fixture(t), base = f.db.inspect();
    f.db.consumeOnce(request(base.state), delta(1, [B]), clock());
    const before = f.db.inspect();
    const o = chain === "legal" ? delta(2, [A, B]) : chain === "gap" ? delta(3, [A, B]) :
      chain === "duplicate" ? delta(1, [A, B]) : delta(2, [A]);
    if (chain !== "legal") o.clockPoisoned = true; // untrusted suffix cannot inject poison
    const after = f.db.consumeOnce(request(base.state, "late"), o, wallRollback ? clock(2, 1000) : clock(2), { expectedRowVersion: base.rowVersion });
    const a = attempt(after.state, "late");
    assert.equal(a.status, "safety-only"); assert.equal(a.commitOutcome.baseMatch, false);
    assert.equal(a.reason, wallRollback ? "WALL_CLOCK_ROLLBACK" : "ROW_VERSION_CONFLICT");
    assert.equal(after.rowVersion, before.rowVersion + 1); assert.equal(after.state.consumed.length, 1);
    assert.deepEqual(after.state.revoked, chain === "legal" ? [A, B] : [B]);
    assert.equal(after.state.revocationSequence, chain === "legal" ? 2 : 1);
    assert.equal(after.state.clockPoisoned, wallRollback); assert.deepEqual(fresh(f.file), after);
    emit(t, f, { chain, wallRollback, safetyAccepted: chain === "legal", rowVersion: after.rowVersion });
  });
}

test("stale SQL version denies business even when complete C0 still matches", { skip: !supported }, t => {
  const f = fixture(t), base = f.db.inspect();
  f.db.command(command("admit", request(base.state, "other")));
  const after = f.db.consumeOnce(request(base.state), delta(1, [B]), clock(), { expectedRowVersion: 0 });
  const a = attempt(after.state); assert.equal(a.commitOutcome.baseMatch, true);
  assert.equal(a.reason, "ROW_VERSION_CONFLICT"); assert.equal(a.status, "safety-only");
  assert.deepEqual(after.state.revoked, [B]); assert.equal(after.state.consumed.length, 0);
});

test("commit(handle) with stale rowVersion fixes safety-only against actual C0 and consumes its handle", { skip: !supported }, t => {
  const f = fixture(t), h = stage(f.db, undefined, delta(1, [B])), version = f.db.inspect().rowVersion;
  const other = driver.SqliteFixture.open(f.file); t.after(() => other.close());
  other.command(command("admit", request(other.inspect().state, "other")));
  const after = f.db.commit(h, clock(2), { expectedRowVersion: version });
  assert.equal(attempt(after.state).commitOutcome.baseMatch, true);
  assert.equal(attempt(after.state).reason, "ROW_VERSION_CONFLICT"); assert.equal(attempt(after.state).status, "safety-only");
  assert.deepEqual(after.state.revoked, [B]); assert.equal(after.state.consumed.length, 0);
  assert.throws(() => f.db.commit(h, clock(3)), { code: "SQLITE_FIXTURE_CAPABILITY" });
  assert.deepEqual(fresh(f.file), after);
});

for (const failure of ["throw-before-commit-call", "throw-after-commit-call", "engine-commit-reject", "zero-row-after-accept"]) {
  test(`commit(handle) ${failure} locks handle and session; restart reads exact result`, { skip: !supported }, t => {
    const f = fixture(t), h = stage(f.db, undefined, delta(1, [B])), before = f.db.inspect();
    let caught;
    try { f.db.commit(h, clock(2), { failure }); } catch (e) { caught = e; }
    assert.ok(caught); assert.equal(caught.outcome, "unknown");
    assert.throws(() => f.db.commit(h, clock(3)), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.throws(() => f.db.inspect(), { code: "SQLITE_FIXTURE_UNKNOWN" });
    assert.throws(() => f.db.command(command("cancel", { attemptId: "attempt-1", version: 3 })), { code: "SQLITE_FIXTURE_UNKNOWN" });
    const after = fresh(f.file), committed = failure === "throw-after-commit-call";
    assert.equal(after.state.consumed.length, committed ? 1 : 0);
    assert.equal(after.rowVersion, before.rowVersion + (committed ? 1 : 0));
    if (!committed) assert.deepEqual(after, before);
    else { assert.deepEqual(after.state.revoked, [B]); assert.equal(attempt(after.state).status, "consumed-synthetic"); }
    emit(t, f, { failure, code: caught.code, errcode: caught.errcode, outcome: caught.outcome, committed });
  });
}

test("held BEGIN IMMEDIATE forces busy; a second probe completes after release", { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t), holder = await child(t, f.file), contender = await child(t, f.file);
  assert.equal((await holder.send({ op: "hold-lock" })).result.held, true);
  assert.equal((await contender.send({ op: "probe-lock", timeout: 100 })).attemptingBegin, true);
  const busy = await contender.next(); assert.equal(busy.ok, false); assert.equal(busy.errcode, 5);
  assert.equal((await contender.send({ op: "probe-lock", timeout: 1000 })).attemptingBegin, true);
  let finished = false; const waiting = contender.next().then(v => { finished = true; return v; });
  await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(finished, false);
  assert.equal((await holder.send({ op: "release-lock" })).result.released, true);
  const acquired = await waiting; assert.equal(acquired.ok, true); assert.equal(acquired.result.acquired, true);
  assert.ok(acquired.result.elapsedMs >= 50);
  assert.equal(fresh(f.file).rowVersion, 0);
  emit(t, f, { busy: { code: busy.code, errcode: busy.errcode }, afterRelease: acquired.result });
});

test("fixture-only facts kernel shares exact transitions without command replay", { skip: !supported }, () => {
  const m = new SyntheticState(config()), before = kernel.initial(config());
  const r = request(m.snapshot());
  const commands = [command("admit", r), command("reserve", { attemptId: r.attemptId, version: 1, tokenId: "token-1" }),
    command("enter", { attemptId: r.attemptId, version: 2, clocks: clock(10, 1050), observation: delta(1, [B]) }),
    command("commit", { attemptId: r.attemptId, clocks: clock(9, 1049) })];
  m.admit(r); m.reserve(commands[1].data); const h = m.enter(commands[2].data); m.commit(h, commands[3].data.clocks);
  let body = before; for (const c of commands) body = kernel.transition(body, c);
  const expected = { ...m.snapshot(), retainedEvents: 0 }; assert.deepEqual(kernel.inspect(body), expected);
  const envelope = JSON.parse(body); assert.equal(envelope.semanticFormat, 3); assert.equal(envelope.state.events, undefined);
  assert.equal(envelope.events, undefined); assert.equal(envelope.kind, "purely-synthetic-state-facts");
  assert.throws(() => kernel.inspect(m.exportImage()));
  envelope.semanticFormat = 2; assert.throws(() => kernel.inspect(JSON.stringify(envelope)), { code: "ERR_SYNTHETIC_IMAGE_FORMAT" });
});

test("SQLite identity rejects production/foreign DB, schema/semantics mismatch and nonempty initialization", { skip: !supported }, t => {
  const f = fixture(t), { DatabaseSync } = require("node:sqlite");
  const before = f.db.inspect(); assert.equal(before.authority, false); assert.equal(before.executionAuthorized, false);
  assert.throws(() => driver.SqliteFixture.initialize(f.file, config()), { code: "SQLITE_FIXTURE_NONEMPTY" });
  const edit = new DatabaseSync(f.file);
  for (const [change, restore] of [
    ["PRAGMA application_id=0", `PRAGMA application_id=${driver.APPLICATION_ID}`],
    ["PRAGMA user_version=99", `PRAGMA user_version=${driver.SCHEMA}`],
    ["PRAGMA user_version=5", `PRAGMA user_version=${driver.SCHEMA}`],
    ["UPDATE fixture_meta SET semantic_format=2", "UPDATE fixture_meta SET semantic_format=3"],
  ]) { edit.exec(change); assert.throws(() => driver.SqliteFixture.open(f.file), { code: "SQLITE_FIXTURE_FORMAT" }); edit.exec(restore); }
  edit.close(); assert.deepEqual(f.db.inspect(), before);
  const foreignDir = fs.mkdtempSync(path.join(runtime, "permit-phase-a-sqlite-foreign-")), foreign = path.join(foreignDir, "production.sqlite");
  const prod = new DatabaseSync(foreign); prod.exec("PRAGMA user_version=3; CREATE TABLE protected_state(id INTEGER PRIMARY KEY,body TEXT,sha256 TEXT)"); prod.close();
  const bytes = fs.readFileSync(foreign);
  assert.throws(() => driver.SqliteFixture.open(foreign), { code: "SQLITE_FIXTURE_FORMAT" }); assert.deepEqual(fs.readFileSync(foreign), bytes);
  assert.throws(() => driver.SqliteFixture.initialize(foreign, config()), { code: "SQLITE_FIXTURE_NONEMPTY" });
  fs.writeFileSync(path.join(foreignDir, "not-empty"), "evidence");
  assert.throws(() => driver.SqliteFixture.initialize(path.join(foreignDir, "new.sqlite"), config()));
  assert.throws(() => driver.SqliteFixture.initialize(path.resolve("outside.sqlite"), config()), { code: "SQLITE_FIXTURE_PATH" });
});

for (const kind of ["full-match", "same-revision-other-digest", "wall-rollback"]) {
  test(`real SQLite atomic safety transition: ${kind}; new process reads facts`, { skip: !supported }, t => {
    const f = fixture(t), initial = f.db.inspect().state;
    const r = request(initial, "attempt-1", kind === "same-revision-other-digest" ? { checkpoint: { ...initial.checkpoint, digest: B } } : {});
    const h = stage(f.db, r, delta(1, [B]));
    const after = f.db.commit(h, kind === "wall-rollback" ? clock(2, 1000) : clock(2));
    assert.equal(attempt(after.state).status, kind === "full-match" ? "consumed-synthetic" : "safety-only");
    assert.equal(after.state.consumed.length, kind === "full-match" ? 1 : 0);
    assert.equal(after.state.revocationSequence, 1); assert.deepEqual(after.state.revoked, [B]);
    assert.equal(after.state.checkpoint.revision, initial.checkpoint.revision + 1);
    assert.equal(after.state.clockPoisoned, kind === "wall-rollback");
    assert.deepEqual(fresh(f.file), after); assert.throws(() => f.db.commit(h, clock(3)), { code: "SQLITE_FIXTURE_CAPABILITY" });
    emit(t, f, { kind, rowVersion: after.rowVersion, digest: after.stateDigest, outcome: attempt(after.state).status });
  });
}

for (const [failure, exitCode, committed] of [["exit-before-commit", 81, false], ["exit-after-commit", 82, true]]) {
  test(`real process ${failure} preserves all-or-none state`, { skip: !supported, timeout: 10000 }, async t => {
    const f = fixture(t), before = f.db.inspect(), c = await child(t, f.file);
    c.fire({ op: "consume", request: request(before.state), observation: delta(1, [B]), clocks: clock(), options: { failure } });
    const exit = await c.exited; assert.equal(exit.code, exitCode); assert.equal(exit.signal, null);
    const actual = fresh(f.file); assert.equal(actual.rowVersion, committed ? 1 : 0);
    assert.equal(actual.state.consumed.length, committed ? 1 : 0); assert.equal(actual.state.revocationSequence, committed ? 1 : 0);
    if (!committed) assert.deepEqual(actual, before);
    const reader = await child(t, f.file);
    const recovery = await reader.send({ op: "recover", options: { expectedRowVersion: actual.rowVersion } }); assert.equal(recovery.ok, true);
    assert.equal(recovery.result.state.control.ownerRevoked, true);
    assert.equal(recovery.result.state.consumed.length, actual.state.consumed.length);
    assert.throws(() => f.db.command(command("admit", request(before.state))), { code: "SQLITE_FIXTURE_STALE_OWNER" });
    emit(t, f, { failure, exit, committed, rowVersion: actual.rowVersion, digest: actual.stateDigest });
  });
}

test("crash before final COMMIT retains earlier admission/reservation and recovery never replays the pending command", { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t), c = await child(t, f.file), id = "attempt-1";
  assert.equal((await c.send({ op: "command", command: command("admit", request(c.ready.state)) })).ok, true);
  assert.equal((await c.send({ op: "command", command: command("reserve", { attemptId: id, version: 1, tokenId: "token-1" }) })).ok, true);
  assert.equal((await c.send({ op: "command", handle: "old-h", command: command("enter", { attemptId: id, version: 2, observation: delta(1, [B]), clocks: clock() }) })).ok, true);
  const pending = fresh(f.file); assert.equal(pending.rowVersion, 3); assert.equal(attempt(pending.state).status, "commit-possible");
  c.fire({ op: "commit", handle: "old-h", clocks: clock(2), options: { failure: "exit-before-commit" } });
  assert.equal((await c.exited).code, 81); assert.deepEqual(fresh(f.file), pending);
  const next = await child(t, f.file);
  assert.equal((await next.send({ op: "commit", handle: "old-h", clocks: clock(2) })).code, "SQLITE_FIXTURE_CAPABILITY");
  const recovered = await next.send({ op: "recover", options: { expectedRowVersion: 3 } }); assert.equal(recovered.ok, true);
  const a = attempt(recovered.result.state); assert.equal(a.status, "unknown"); assert.equal(a.staged, null);
  assert.equal(a.reservation.held, true); assert.equal(recovered.result.state.consumed.length, 0);
  assert.deepEqual(recovered.result.state.revoked, []); assert.deepEqual(fresh(f.file), recovered.result);
  emit(t, f, { crash: "pending-commit", pendingDigest: pending.stateDigest, recoveredDigest: recovered.result.stateDigest });
});

for (const failure of ["throw-before-commit-call", "throw-after-commit-call"]) {
  test(`${failure} latches unknown; fresh process distinguishes actual DB result without retry`, { skip: !supported }, t => {
    const f = fixture(t), before = f.db.inspect();
    assert.throws(() => f.db.consumeOnce(request(before.state), delta(1, [B]), clock(), { failure }),
      { code: "SQLITE_FIXTURE_INJECTED_COMMIT", outcome: "unknown" });
    assert.throws(() => f.db.inspect(), { code: "SQLITE_FIXTURE_UNKNOWN" });
    const after = fresh(f.file); assert.equal(after.state.consumed.length, failure === "throw-after-commit-call" ? 1 : 0);
    assert.equal(after.state.revocationSequence, after.state.consumed.length);
    emit(t, f, { failure, outcome: "unknown", rowVersion: after.rowVersion, digest: after.stateDigest });
  });
}

test("real SQLite COMMIT rejects deferred FK constraint; handle remains unknown and facts roll back", { skip: !supported }, t => {
  const f = fixture(t), before = f.db.inspect();
  let error;
  try { f.db.consumeOnce(request(before.state), delta(), clock(), { failure: "engine-commit-reject" }); }
  catch (e) { error = e; }
  assert.ok(error); assert.match(error.message, /FOREIGN KEY constraint failed/);
  assert.equal(error.outcome, "unknown"); assert.equal(error.code, "ERR_SQLITE_ERROR");
  assert.throws(() => f.db.inspect(), { code: "SQLITE_FIXTURE_UNKNOWN" });
  assert.deepEqual(fresh(f.file), before);
  emit(t, f, { failure: "engine-commit-reject", code: error.code, errcode: error.errcode, outcome: error.outcome });
});

test("atomic once rejects expired business at entry without losing accepted safety facts", { skip: !supported }, t => {
  const f = fixture(t), before = f.db.inspect();
  const after = f.db.consumeOnce(request(before.state), delta(1, [B]), clock(100));
  assert.equal(attempt(after.state).status, "invalidated"); assert.equal(attempt(after.state).reason, "MONOTONIC_DEADLINE");
  assert.deepEqual(after.state.revoked, [B]); assert.equal(after.state.consumed.length, 0);
  assert.deepEqual(fresh(f.file), after);
});

test("zero-row probe before accepting safety rolls back every write including attempt ownership and audit", { skip: !supported }, t => {
  const f = fixture(t), before = f.db.inspect(), r = request(before.state);
  for (const options of [{ failure: "zero-row-cas" }]) {
    assert.throws(() => f.db.consumeOnce(r, delta(), clock(), options), { code: "SQLITE_FIXTURE_CAS" });
    assert.deepEqual(fresh(f.file), before);
  }
  assert.equal(f.db.consumeOnce(r, delta(), clock()).state.consumed.length, 1);
});

test("two ready processes with identical C0 commit one business result; no implicit retry", { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t), base = f.db.inspect(); const cs = await Promise.all([child(t, f.file), child(t, f.file)]);
  assert.deepEqual(cs[0].ready.state.checkpoint, cs[1].ready.state.checkpoint);
  const results = await Promise.all(cs.map((c, i) => c.send({ op: "consume", request: request(base.state, `race-${i}`),
    observation: delta(), clocks: clock(), options: { expectedRowVersion: base.rowVersion } })));
  assert.equal(results.filter(r => r.ok).length, 2); // denial is committed result data
  const after = fresh(f.file); assert.equal(after.state.consumed.length, 1); assert.equal(after.rowVersion, 2);
  const denied = after.state.attempts.find(a => a.status === "safety-only");
  assert.equal(denied.reason, "ROW_VERSION_CONFLICT"); assert.equal(denied.reservation.held, true);
  assert.equal(after.state.revocationSequence, 1); // duplicate chain was NOT accepted
  emit(t, f, { outcomes: after.state.attempts.map(a => a.status), rowVersion: after.rowVersion });
});

test("two real connections submit the same expected row version; only one admission succeeds", { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t), cs = await Promise.all([child(t, f.file), child(t, f.file)]);
  const results = await Promise.all(cs.map((c, i) => c.send({ op: "command", command: command("admit", request(c.ready.state, `cas-${i}`)),
    options: { expectedRowVersion: 0 } })));
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok).code, "SQLITE_FIXTURE_CAS");
  const after = fresh(f.file); assert.equal(after.rowVersion, 1); assert.equal(after.state.attempts.length, 1);
  emit(t, f, { cas: results.map(r => ({ ok: r.ok, code: r.code })), rowVersion: after.rowVersion });
});

for (const order of ["cancel-first", "commit-first", "cancel-after-boundary"]) {
  test(`cancel/commit ordering in different processes: ${order}`, { skip: !supported, timeout: 10000 }, async t => {
    const f = fixture(t), owner = await child(t, f.file), other = await child(t, f.file), id = "attempt-1";
    assert.equal((await owner.send({ op: "command", command: command("admit", request(owner.ready.state)) })).ok, true);
    assert.equal((await owner.send({ op: "command", command: command("reserve", { attemptId: id, version: 1, tokenId: "token-1" }) })).ok, true);
    if (order === "cancel-first") {
      assert.equal((await other.send({ op: "command", command: command("cancel", { attemptId: id, version: 2 }) })).ok, true);
      assert.equal((await owner.send({ op: "command", handle: "h", command: command("enter", { attemptId: id, version: 2, observation: delta(), clocks: clock() }) })).code, "ERR_SYNTHETIC_CAS");
      assert.equal(attempt(fresh(f.file).state).status, "cancelled"); return;
    }
    assert.equal((await owner.send({ op: "command", handle: "h", command: command("enter", { attemptId: id, version: 2, observation: delta(), clocks: clock() }) })).ok, true);
    if (order === "cancel-after-boundary") assert.equal((await other.send({ op: "command", command: command("cancel", { attemptId: id, version: 3 }) })).ok, true);
    assert.equal((await owner.send({ op: "commit", handle: "h", clocks: clock(2) })).ok, true);
    if (order === "commit-first") assert.equal((await other.send({ op: "command", command: command("cancel", { attemptId: id, version: 4 }) })).ok, true);
    const after = fresh(f.file); assert.equal(after.state.consumed.length, 1);
    assert.equal(attempt(after.state).clientOutcome, order === "commit-first" ? "synthetic-committed" : "unknown");
    assert.equal(attempt(after.state).reservation.held, order !== "commit-first");
  });
}

for (const phase of ["before-entry", "before-commit", "after-pending"]) {
  test(`registration invalidation race ${phase} never activates or frees held reservation`, { skip: !supported, timeout: 10000 }, async t => {
    const f = fixture(t, "registration-only"), owner = await child(t, f.file), invalidator = await child(t, f.file);
    const r = request(owner.ready.state, "attempt-1", { kind: "register", permitId: null, fingerprint: null });
    await owner.send({ op: "command", command: command("admit", r) });
    await owner.send({ op: "command", command: command("reserve", { attemptId: r.attemptId, version: 1, tokenId: "token-1" }) });
    if (phase !== "before-entry") await owner.send({ op: "command", handle: "h", command: command("enter", { attemptId: r.attemptId, version: 2, observation: null, clocks: clock() }) });
    if (phase === "after-pending") await owner.send({ op: "commit", handle: "h", clocks: clock(2) });
    const invalidated = await invalidator.send({ op: "command", command: command("invalidate", { tokenId: "token-1", reason: "owner-dead" }) }); assert.equal(invalidated.ok, true);
    if (phase === "before-commit") assert.equal((await owner.send({ op: "commit", handle: "h", clocks: clock(2) })).ok, true);
    if (phase === "before-entry") assert.equal((await owner.send({ op: "command", handle: "h", command: command("enter", { attemptId: r.attemptId, version: 2, observation: null, clocks: clock() }) })).ok, false);
    const after = fresh(f.file), a = attempt(after.state);
    assert.equal(a.status, { "before-entry": "invalidated", "before-commit": "rejected", "after-pending": "registration-pending" }[phase]);
    assert.equal(a.invalidation, "owner-dead"); assert.equal(a.reservation.held, true); assert.equal(after.state.registrationActive, false);
  });
}

for (const first of ["invalidate", "commit"]) {
  test(`consume/invalidation ordered across connections: ${first} wins boundary`, { skip: !supported }, t => {
    const f = fixture(t), h = stage(f.db, undefined, delta(1, [B]));
    const other = driver.SqliteFixture.open(f.file); t.after(() => other.close());
    const invalidate = () => other.command(command("invalidate", { tokenId: "token-attempt-1", reason: "grant-revoked" }));
    if (first === "invalidate") invalidate(); f.db.commit(h, clock(2));
    const committed = f.db.inspect(); if (first === "commit") invalidate();
    const after = fresh(f.file), a = attempt(after.state);
    assert.equal(after.state.consumed.length, first === "commit" ? 1 : 0);
    assert.equal(a.status, first === "commit" ? "consumed-synthetic" : "safety-only");
    assert.deepEqual(after.state.revoked, [B]); assert.equal(a.invalidation, "grant-revoked");
    assert.deepEqual(a.commitOutcome, attempt(committed.state).commitOutcome);
  });
}

test("new connection cannot resume a committed enter; explicit restart fences old session/handle", { skip: !supported, timeout: 10000 }, async t => {
  const f = fixture(t), h = stage(f.db), second = driver.SqliteFixture.open(f.file); t.after(() => second.close());
  assert.throws(() => second.command(command("enter", { attemptId: "attempt-1", version: 3, observation: delta(), clocks: clock(2) })), { code: "SQLITE_FIXTURE_ATTEMPT_OWNER" });
  assert.throws(() => second.commit(h, clock(2)), { code: "SQLITE_FIXTURE_CAPABILITY" });
  assert.throws(() => second.command(command("commit", { attemptId: "attempt-1", clocks: clock(2) })), { code: "SQLITE_FIXTURE_CAPABILITY" });
  const reopener = await child(t, f.file); assert.equal(attempt(reopener.ready.state).status, "commit-possible");
  const recovered = await reopener.send({ op: "recover", options: { expectedRowVersion: reopener.ready.rowVersion } }); assert.equal(recovered.ok, true);
  assert.equal(attempt(recovered.result.state).status, "unknown"); assert.equal(attempt(recovered.result.state).reservation.held, true);
  assert.equal(recovered.result.state.control.ownerRevoked, true);
  assert.throws(() => f.db.commit(h, clock(2)), { code: "SQLITE_FIXTURE_STALE_OWNER" });
  assert.deepEqual(fresh(f.file), recovered.result);
});

test("SQLite WAL properties and committed audit rows describe real facts, not executable commands", { skip: !supported }, t => {
  const f = fixture(t); f.db.consumeOnce(request(f.db.inspect().state), delta(), clock());
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    const row = db.prepare("SELECT * FROM fixture_state").get(), commits = db.prepare("SELECT * FROM fixture_commits").all();
    assert.equal(commits.length, 1); assert.equal(commits[0].cas_changes, 1); assert.equal(commits[0].state_digest, row.sha256);
    assert.equal(createHash("sha256").update(row.body).digest("hex"), row.sha256);
    assert.equal(JSON.parse(row.body).state.events, undefined);
  } finally { db.close(); }
});
