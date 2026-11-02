"use strict";

// @runner-timeout 600
// The rehearsal spawns real producer subprocesses and performs durable
// writes with directory fsync. Under the parallel runner's load it can take
// well over the default hang-detection window.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const supported = Number(process.versions.node.split(".")[0]) >= 24 && process.platform !== "win32";
const opts = { skip: supported ? false : "Requires Node >=24 with node:sqlite and POSIX directory fsync; no platform gate claim" };
// The fixture captures its runtime root at load time, so the disposable
// sandbox has to exist before the require. Writing into the repository
// working copy would break the strict-hermetic gate
// (`.agent/rules/test-policy.md` §2.4).
const { createRuntimeSandboxWithEnv } = require("../helpers/runtime-sandbox");
const sandbox = supported ? createRuntimeSandboxWithEnv({ prefix: "cortex-legacy-rehearsal-" }) : null;
const driver = supported ? require("./fixtures/permit-legacy-sqlite-rehearsal") : null;
const child = path.join(__dirname, "fixtures/permit-legacy-sqlite-rehearsal.js");
let report;
test.after(() => { if (sandbox) sandbox.cleanup(); });
test.before(() => {
  if (!supported) return;
  report = driver.newRoot();
  fs.writeFileSync(path.join(report, "environment.json"), JSON.stringify({ node: process.version,
    nodeBinarySha256: driver.hash(fs.readFileSync(process.execPath)), sqlite: process.versions.sqlite,
    platform: process.platform, arch: process.arch, sources: driver.manifest,
    activation: "blocked", blockers: driver.BLOCKERS, npmTarVerified: false, platformGateVerified: false,
    businessStarted: false, sourceAtimeClaimedUnchanged: false }, null, 2));
  console.log("legacy SQLite rehearsal evidence: " + report);
});
function evidence(t, detail) {
  fs.appendFileSync(path.join(report, "results.jsonl"), JSON.stringify({ test: t.name, ...detail }) + "\n");
}
function fixture(t, options) {
  if (options?.wal) {
    const r = spawnSync(process.execPath, [child, "create-wal"], { encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const f = JSON.parse(r.stdout); return { ...f, ...driver.paths(f.root), close() {} };
  }
  const f = driver.createLegacy(options); t.after(() => f.close()); return f;
}
function fresh(root, version, row) {
  const r = spawnSync(process.execPath, [child, "verify", root, String(version), JSON.stringify(row || null)], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, TMPDIR: driver.ROOT, TMP: driver.ROOT, TEMP: driver.ROOT } });
  assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout);
}
function raw(root, version) {
  const r = spawnSync(process.execPath, [child, "inspect", root, String(version)], { encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout);
}
function restoreBackup(r) {
  const before = driver.snapshot(r.backup), restored = path.join(r.run, "restored");
  fs.cpSync(r.backup, restored, { recursive: true });
  const row = fresh(restored, 1, r.input.source);
  assert.deepEqual(driver.snapshot(r.backup), before); return row;
}
function alter(f, sql) {
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(f.file);
  try { db.exec(sql); } finally { db.close(); }
}
function unchanged(f, action) {
  const before = driver.snapshot(f.root);
  try { return action(); } finally { assert.deepEqual(driver.snapshot(f.root), before); }
}

test("real legacy SQLite nonempty history transaction -> schema2, strict fresh frozen v1.16.0 open; source untouched", opts, t => {
  const f = fixture(t), before = driver.snapshot(f.root), r = driver.rehearse(f.root);
  assert.equal(r.status, "copy-converted-not-activated"); assert.equal(r.executionAuthorized, false);
  assert.equal(r.activation, "blocked"); assert.ok(r.blockers.includes("ordinary-migration-durability-cap-missing"));
  const source = JSON.parse(r.input.source.body), target = JSON.parse(fresh(r.work, 2, r.prepared.target).body);
  assert.deepEqual(target, { ...source, schema_version: 2, anchor_sequence: source.anchor_sequence + 1 });
  assert.deepEqual(Object.values(target.permits).map(p => p.status), ["finished", "failed", "expired", "revoked", "revoked"]);
  assert.deepEqual(Object.values(target.lease_idempotency).map(l => l.status), ["released", "revoked", "released", "revoked", "expired"]);
  assert.equal(source.permits["P-PERMIT-1"].consumedAt, source.permits["P-PERMIT-1"].deadline);
  for (const field of ["store_id", "decision_id", "service_identity", "anchor_mode", "last_clock_ms", "fencing", "service_epoch",
    "lease_seq", "permit_seq", "lease_idempotency", "idempotency", "tombstones", "desktop", "permits"]) assert.deepEqual(target[field], source[field]);
  // Exact original anchor prefix bytes remain (append-only high-water/audit).
  const a = driver.paths(r.backup).anchor, b = driver.paths(r.work).anchor;
  for (const name of fs.readdirSync(a)) {
    const old = fs.readFileSync(path.join(a, name)), current = fs.readFileSync(path.join(b, name));
    assert.deepEqual(current.subarray(0, old.length), old);
  }
  restoreBackup(r);
  // Only schema rejection is established; existing old handles are NOT fenced.
  const old = driver.frozen("legacy").store.ProtectedPermitStore;
  assert.throws(() => old.open(driver.paths(r.work).file, { anchorDir: b, anchorMode: "permissive",
    expectedDecisionId: source.decision_id, minimumEpoch: 1, clock: () => source.last_clock_ms }), { code: "ERR_STATE_INVALID" });
  assert.deepEqual(driver.snapshot(f.root), before);
  evidence(t, { run: r.run, sourceUnchanged: true, targetDigest: r.prepared.target.sha256, counts: {
    leases: 5, permits: 5, journalPrefix: r.input.journal.length, highWaterPrefix: r.input.high_water.length }, activation: r.activation });
});

test("real committed WAL/SHM from exited legacy writer are copied before SQLite opens; every source file stays unchanged", opts, t => {
  const f = fixture(t, { wal: true });
  assert.ok(fs.statSync(f.file + "-wal").size > 32); assert.ok(fs.statSync(f.file + "-shm").size > 0);
  const before = driver.snapshot(f.root), r = driver.rehearse(f.root);
  for (const suffix of ["", "-wal", "-shm"]) assert.deepEqual(fs.readFileSync(driver.paths(r.backup).file + suffix), fs.readFileSync(f.file + suffix));
  fresh(r.work, 2, r.prepared.target); restoreBackup(r);
  assert.deepEqual(driver.snapshot(f.root), before);
  evidence(t, { run: r.run, walBytes: before["./db/state.sqlite-wal"].size, sourceUnchanged: true,
    limitation: "exited controlled fixture writer; no real deployment quiescence or TOCTOU proof" });
});

for (const unresolved of ["reserved", "consumed", "unknown"]) test(`real legacy ${unresolved} is preserved and refused before migration intent`, opts, t => {
  const f = fixture(t, { unresolved });
  assert.ok(Object.values(f.state.permits).some(p => p.status === unresolved));
  const e = unchanged(f, () => {
    try { driver.rehearse(f.root); assert.fail("must reject"); } catch (e) { return e; }
  });
  assert.equal(e.code, "ERR_LEGACY_MIGRATION_UNRESOLVED"); assert.equal(e.outcome, "aborted-before-commit");
  const work = path.join(e.run, "work");
  assert.deepEqual(JSON.parse(fresh(work, 1).body), f.state);
  assert.equal(fs.existsSync(path.join(e.run, "control.jsonl")), true);
  assert.equal(fs.existsSync(path.join(driver.paths(work).anchor, "protected-store-coordination.sqlite")), false);
  evidence(t, { run: e.run, status: unresolved, refused: e.code, historyUnchanged: true, activation: "blocked" });
});

const extraSQL = {
  table: "CREATE TABLE unexpected(value TEXT)",
  index: "CREATE INDEX unexpected ON protected_state(sha256)",
  view: "CREATE VIEW unexpected AS SELECT body FROM protected_state",
  virtual: "CREATE VIRTUAL TABLE unexpected USING fts5(value)",
  // This really fires if the migration ever reaches UPDATE; successful
  // SQLITE object refusal instead of trigger exception proves ordering.
  trigger: "CREATE TRIGGER unexpected BEFORE UPDATE ON protected_state BEGIN SELECT RAISE(ABORT,'PROJECT_SQL_EXECUTED'); END",
};
for (const [kind, sql] of Object.entries(extraSQL)) test(`closed SQL whitelist rejects real ${kind} before executing project UPDATE logic`, opts, t => {
  const f = fixture(t); alter(f, sql);
  const e = unchanged(f, () => { try { driver.rehearse(f.root); assert.fail(); } catch (e) { return e; } });
  assert.equal(e.code, "FIXTURE_SQL_OBJECTS"); assert.equal(e.outcome, "aborted-before-commit");
  assert.equal(fs.existsSync(path.join(e.run, "prepared.json")), false);
  evidence(t, { run: e.run, refused: e.code, sqlKind: kind, sourceUnchanged: true });
});

test("altered expected table DDL is refused even with the same table name and coherent row", opts, t => {
  const f = fixture(t);
  alter(f, "ALTER TABLE protected_state ADD COLUMN unexpected TEXT");
  unchanged(f, () => assert.throws(() => driver.rehearse(f.root), { code: "FIXTURE_SQL_OBJECTS" }));
});

for (const corruption of ["unknown-sidecar", "rollback-journal", "truncated-wal", "missing-water", "truncated-audit", "dangling-intent", "foreign-store", "unknown-anchor-file", "symlink", "hardlink"]) {
  test(`source ${corruption} is not repaired, discarded or silently migrated`, opts, t => {
    const f = fixture(t), a = f.anchor;
    if (corruption === "unknown-sidecar") fs.writeFileSync(f.file + "-other", "unrecognized");
    if (corruption === "rollback-journal") fs.writeFileSync(f.file + "-journal", "not reviewed");
    if (corruption === "truncated-wal") fs.writeFileSync(f.file + "-wal", Buffer.from("not a WAL"));
    if (corruption === "missing-water") fs.unlinkSync(path.join(a, "protected-anchor-high-water.log"));
    if (corruption === "truncated-audit") {
      const p = path.join(a, "protected-anchor-audit.log"); fs.truncateSync(p, fs.statSync(p).size - 1);
    }
    if (corruption === "dangling-intent") {
      const name = fs.readdirSync(a).filter(n => n.includes("-commit-")).sort().at(-1); fs.unlinkSync(path.join(a, name));
    }
    if (corruption === "foreign-store") driver.frozen("legacy").anchor.appendEntry(path.join(a, "protected-anchor.journal"), {
      type: "intent", sequence: f.state.anchor_sequence + 1, store_id: "foreign", body_digest: "a".repeat(64), attempt: 1 });
    if (corruption === "unknown-anchor-file") fs.writeFileSync(path.join(a, "unexpected"), "unknown");
    if (corruption === "symlink") fs.symlinkSync(f.file, f.file + "-shm");
    if (corruption === "hardlink") fs.linkSync(f.file, f.file + "-shm");
    // For rejected links compare the known DB bytes + raw directory, since
    // the evidence snapshot intentionally refuses unsafe links as well.
    const beforeBytes = fs.readFileSync(f.file), names = fs.readdirSync(path.dirname(f.file));
    let error;
    try { driver.rehearse(f.root); } catch (e) { error = e; }
    assert.ok(error, corruption + " must be refused");
    assert.deepEqual(fs.readFileSync(f.file), beforeBytes); assert.deepEqual(fs.readdirSync(path.dirname(f.file)), names);
    evidence(t, { run: error.run, refused: error.code || error.message, corruption });
  });
}

for (const failure of ["zero-cas", "after-intent", "deny-commit", "after-commit"]) test(`actual copy transaction ${failure}: retain boundary, source and original error`, opts, t => {
  const f = fixture(t), e = unchanged(f, () => { try { driver.rehearse(f.root, { failure }); assert.fail(); } catch (e) { return e; } });
  const committed = failure === "after-commit", work = path.join(e.run, "work");
  const row = raw(work, committed ? 2 : 1);
  assert.equal(JSON.parse(row.body).schema_version, committed ? 2 : 1);
  assert.equal(e.outcome, "unknown");
  if (failure === "deny-commit") { assert.equal(e.code, "ERR_SQLITE_ERROR"); assert.equal(e.errcode, 23); }
  const ctl = fs.readFileSync(path.join(e.run, "control.jsonl"), "utf8");
  assert.equal(ctl.includes('"stage":"witnessed"'), false);
  // Never append witnesses or retry from an unknown outcome, even if a fresh
  // raw reader finds either the exact source or the exact prepared target.
  evidence(t, { run: e.run, failure, error: driver.errorInfo(e), actualVersion: row.user_version,
    limitation: failure === "deny-commit" ? "SQLITE_AUTH is authorization denial, not disk/power failure" : undefined });
});

test("real rollback authorization error is retained separately and connection is disposed", opts, t => {
  const f = fixture(t);
  const e = unchanged(f, () => { try { driver.rehearse(f.root, { failure: "zero-cas", denyRollback: true }); assert.fail(); } catch (e) { return e; } });
  assert.equal(e.code, "FIXTURE_ZERO_CAS"); assert.equal(e.cleanupError.errcode, 23); assert.equal(e.outcome, "unknown");
  assert.equal(raw(path.join(e.run, "work"), 1).user_version, 1);
  evidence(t, { run: e.run, error: driver.errorInfo(e) });
});

for (const failure of ["exit-before-commit", "exit-after-commit"]) test(`real child ${failure}: fresh reader records facts without resuming or claiming activation`, opts, t => {
  const f = fixture(t), before = driver.snapshot(f.root), runParent = driver.newRoot(), run = path.join(runParent, "rehearsal");
  const r = spawnSync(process.execPath, [child, "rehearse", f.root, JSON.stringify({ failure, runParent })], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, failure === "exit-before-commit" ? 71 : 72, r.stdout + r.stderr);
  const work = path.join(run, "work");
  const committed = failure === "exit-after-commit", row = raw(work, committed ? 2 : 1);
  const control = fs.readFileSync(path.join(run, "control.jsonl"), "utf8");
  assert.ok(control.includes('"stage":"db-commit-possible"')); assert.equal(control.includes('"stage":"witnessed"'), false);
  if (committed) assert.throws(() => driver.verifyFresh(work, 2), { code: "FIXTURE_HIGH_WATER_PREFIX" });
  assert.deepEqual(driver.snapshot(f.root), before);
  evidence(t, { run, exit: r.status, outcome: "unknown", actualVersion: row.user_version,
    activation: "blocked", recoveryAttempted: false });
});

test("fresh schema2 reader rejects a lost high-water prefix instead of treating header=2 as success", opts, t => {
  const f = fixture(t), r = driver.rehearse(f.root), water = path.join(driver.paths(r.work).anchor, "protected-anchor-high-water.log");
  fs.writeFileSync(water, JSON.stringify(r.prepared.append.high_water) + "\n");
  assert.throws(() => driver.verifyFresh(r.work, 2), { code: "FIXTURE_HIGH_WATER_PREFIX" });
});

for (const loss of ["last-only", "missing-first", "missing-middle"]) test(`review P1: source high-water ${loss} is refused before preparing migration`, opts, t => {
  const f = fixture(t), water = path.join(f.anchor, "protected-anchor-high-water.log");
  const records = fs.readFileSync(water, "utf8").trim().split("\n");
  assert.equal(records.length, f.state.anchor_sequence); assert.ok(records.length > 2);
  const kept = loss === "last-only" ? records.slice(-1) : records.filter((_, i) => i !== (loss === "missing-first" ? 0 : 2));
  fs.writeFileSync(water, kept.join("\n") + "\n");
  let error;
  unchanged(f, () => assert.throws(() => driver.rehearse(f.root), e => {
    error = e; assert.equal(e.code, "FIXTURE_HIGH_WATER_PREFIX"); assert.equal(e.outcome, "aborted-before-commit"); return true;
  }));
  assert.equal(fs.existsSync(path.join(error.run, "prepared.json")), false);
  evidence(t, { run: error.run, originalRecords: records.length, remaining: kept.length, refused: error.code });
});

test("review P1: fresh reader rejects mutually truncated prepared source and target high-water", opts, t => {
  const f = fixture(t), r = driver.rehearse(f.root), preparedFile = path.join(r.run, "prepared.json");
  const stored = JSON.parse(fs.readFileSync(preparedFile, "utf8"));
  assert.ok(stored.input.high_water.length > 1);
  stored.input.high_water = stored.input.high_water.slice(-1);
  fs.writeFileSync(preparedFile, JSON.stringify(stored) + "\n");
  fs.writeFileSync(path.join(driver.paths(r.work).anchor, "protected-anchor-high-water.log"),
    [...stored.input.high_water, stored.prepared.append.high_water].map(JSON.stringify).join("\n") + "\n");
  assert.throws(() => driver.verifyFresh(r.work, 2), { code: "FIXTURE_HIGH_WATER_PREFIX" });
  evidence(t, { run: r.run, refused: "FIXTURE_HIGH_WATER_PREFIX", preparedSourceAlsoTruncated: true });
});

test("review P2: actual postcommit audit corruption remains unknown without witnessed", opts, t => {
  const f = fixture(t), original = fs.writeSync;
  let injected = false, caught;
  fs.writeSync = function(fd, data, ...args) {
    if (Buffer.isBuffer(data) && data.toString().startsWith('{"schema_version":1,"at":"2026-10-31T00:00:00.000Z"') && data.includes('"event":"transaction"')) {
      injected = true; data = Buffer.from(data.toString().replace('"event":"transaction"', '"event":"transactioX"'));
    }
    return original.call(this, fd, data, ...args);
  };
  try { unchanged(f, () => assert.throws(() => driver.rehearse(f.root), e => { caught = e; return true; })); }
  finally { fs.writeSync = original; }
  assert.equal(injected, true); assert.equal(caught.code, "FIXTURE_TARGET_AUDIT"); assert.equal(caught.outcome, "unknown");
  const stages = fs.readFileSync(path.join(caught.run, "control.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map(e => e.stage);
  assert.ok(stages.includes("db-commit-possible")); assert.ok(stages.includes("unknown"));
  assert.equal(stages.includes("witnessed"), false); assert.equal(stages.includes("copy-converted-not-activated"), false);
  assert.equal(raw(path.join(caught.run, "work"), 2).user_version, 2);
  evidence(t, { run: caught.run, error: driver.errorInfo(caught), stages, activation: "blocked" });
});

test("review P2: witnessed is appended only after actual writer close and frozen reader validation", opts, t => {
  const f = fixture(t), { DatabaseSync } = require("node:sqlite"), proto = DatabaseSync.prototype;
  const exec = proto.exec, close = proto.close, write = fs.writeSync;
  let writer, writerClosed = false, readerValidated = false, witnessed;
  proto.exec = function(sql, ...args) {
    if (sql === "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE") writer = this;
    return exec.call(this, sql, ...args);
  };
  proto.close = function(...args) {
    const result = close.apply(this, args);
    if (this === writer) writerClosed = true;
    else if (writerClosed) readerValidated = true;
    return result;
  };
  fs.writeSync = function(fd, data, ...args) {
    if (Buffer.isBuffer(data) && data.includes('"stage":"witnessed"')) witnessed = { writerClosed, readerValidated };
    return write.call(this, fd, data, ...args);
  };
  let r;
  try { r = driver.rehearse(f.root); }
  finally { proto.exec = exec; proto.close = close; fs.writeSync = write; }
  assert.deepEqual(witnessed, { writerClosed: true, readerValidated: true });
  evidence(t, { run: r.run, witnessed });
});

test("review P2: injected writer close response failure preserves original error and unknown without witnessed", opts, t => {
  const f = fixture(t), { DatabaseSync } = require("node:sqlite"), proto = DatabaseSync.prototype;
  const exec = proto.exec, close = proto.close;
  let writer, caught;
  proto.exec = function(sql, ...args) {
    if (sql === "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE") writer = this;
    return exec.call(this, sql, ...args);
  };
  proto.close = function(...args) {
    const result = close.apply(this, args);
    if (this === writer) throw Object.assign(new Error("FIXTURE_CLOSE_RESPONSE"), { code: "FIXTURE_CLOSE_RESPONSE" });
    return result;
  };
  try { unchanged(f, () => assert.throws(() => driver.rehearse(f.root), e => { caught = e; return true; })); }
  finally { proto.exec = exec; proto.close = close; }
  assert.equal(caught.code, "FIXTURE_CLOSE_RESPONSE"); assert.equal(caught.outcome, "unknown");
  const stages = fs.readFileSync(path.join(caught.run, "control.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map(e => e.stage);
  assert.ok(stages.includes("unknown")); assert.equal(stages.includes("witnessed"), false);
  assert.equal(stages.includes("copy-converted-not-activated"), false);
  evidence(t, { run: caught.run, error: driver.errorInfo(caught), stages, injectedResponseFailure: true });
});

test("review concurrency: real parallel crash children use only their preallocated run paths", { ...opts, timeout: 30000 }, async t => {
  const f = fixture(t), before = driver.snapshot(f.root), failures = ["exit-before-commit", "exit-after-commit"];
  const jobs = failures.map(failure => {
    const runParent = driver.newRoot(), run = path.join(runParent, "rehearsal");
    const c = spawn(process.execPath, [child, "rehearse", f.root, JSON.stringify({ failure, runParent })], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: driver.ROOT, TMP: driver.ROOT, TEMP: driver.ROOT } });
    let stdout = "", stderr = "";
    c.stdout.on("data", b => { stdout += b; }); c.stderr.on("data", b => { stderr += b; });
    const done = new Promise((resolve, reject) => { c.once("error", reject); c.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
    t.after(() => { if (c.exitCode === null) c.kill("SIGKILL"); });
    return { failure, runParent, run, c, done };
  });
  assert.notEqual(jobs[0].c.pid, jobs[1].c.pid); assert.notEqual(jobs[0].run, jobs[1].run);
  const outcomes = await Promise.all(jobs.map(job => job.done));
  for (const [i, job] of jobs.entries()) {
    const r = outcomes[i], committed = job.failure === "exit-after-commit";
    evidence(t, { run: job.run, pid: job.c.pid, failure: job.failure, ...r, outcome: "unknown", recoveryAttempted: false });
    assert.equal(r.code, committed ? 72 : 71, r.stderr); assert.equal(r.signal, null);
    assert.equal(r.stdout, "", "a crash need not deliver a receipt");
    const stages = fs.readFileSync(path.join(job.run, "control.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map(e => e.stage);
    assert.ok(stages.includes("db-commit-possible")); assert.equal(stages.includes("witnessed"), false);
    assert.equal(stages.includes("copy-converted-not-activated"), false);
    assert.equal(raw(path.join(job.run, "work"), committed ? 2 : 1).user_version, committed ? 2 : 1);
  }
  assert.deepEqual(driver.snapshot(f.root), before);
});

test("review P2: late source mutation is checked before witnessed or success and retains unknown", opts, t => {
  const f = fixture(t), { DatabaseSync } = require("node:sqlite"), proto = DatabaseSync.prototype;
  const exec = proto.exec, close = proto.close, readdir = fs.readdirSync;
  let writer, writerClosed = false, injected = false, caught;
  proto.exec = function(sql, ...args) {
    if (sql === "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE") writer = this;
    return exec.call(this, sql, ...args);
  };
  proto.close = function(...args) {
    const r = close.apply(this, args); if (this === writer) writerClosed = true; return r;
  };
  fs.readdirSync = function(dir, ...args) {
    if (dir === f.root && writerClosed && !injected) {
      injected = true; fs.appendFileSync(path.join(f.root, "fixture.json"), "\n");
    }
    return readdir.call(this, dir, ...args);
  };
  try { assert.throws(() => driver.rehearse(f.root), e => { caught = e; return true; }); }
  finally { proto.exec = exec; proto.close = close; fs.readdirSync = readdir; }
  assert.equal(injected, true); assert.equal(caught.code, "FIXTURE_SOURCE_CHANGED"); assert.equal(caught.outcome, "unknown");
  const stages = fs.readFileSync(path.join(caught.run, "control.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map(e => e.stage);
  assert.ok(stages.includes("unknown")); assert.equal(stages.includes("witnessed"), false);
  assert.equal(stages.includes("copy-converted-not-activated"), false);
  assert.equal(raw(path.join(caught.run, "work"), 2).user_version, 2);
  evidence(t, { run: caught.run, error: driver.errorInfo(caught), stages, sourceMutationInjected: true, activation: "blocked" });
});

test("review P2: unknown record failure preserves after-commit primary and independent record error", opts, t => {
  const f = fixture(t), write = fs.writeSync; let caught, injected = false;
  fs.writeSync = function(fd, data, ...args) {
    if (Buffer.isBuffer(data) && data.includes('"stage":"unknown"')) {
      injected = true; throw Object.assign(new Error("SECONDARY_CONTROL_WRITE"), { code: "SECONDARY_CONTROL_WRITE" });
    }
    return write.call(this, fd, data, ...args);
  };
  try { unchanged(f, () => assert.throws(() => driver.rehearse(f.root, { failure: "after-commit" }), e => { caught = e; return true; })); }
  finally { fs.writeSync = write; }
  assert.equal(injected, true); assert.equal(caught.code, "FIXTURE_AFTER_COMMIT"); assert.equal(caught.outcome, "unknown");
  assert.equal(caught.recordError.code, "SECONDARY_CONTROL_WRITE");
  const stages = fs.readFileSync(path.join(caught.run, "control.jsonl"), "utf8").trim().split("\n").map(JSON.parse).map(e => e.stage);
  assert.equal(stages.includes("unknown"), false, "failed persistence must not claim a durable unknown record");
  assert.equal(stages.includes("witnessed"), false); assert.equal(stages.includes("copy-converted-not-activated"), false);
  assert.equal(raw(path.join(caught.run, "work"), 2).user_version, 2);
  evidence(t, { run: caught.run, error: driver.errorInfo(caught), recordError: caught.recordError.code, stages, activation: "blocked" });
});
