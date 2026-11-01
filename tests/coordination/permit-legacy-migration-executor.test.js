"use strict";

// Contract tests for the legacy migration executor. The executor applies the
// PREPARED bytes of a schema-1 migration to a real store and proves that the
// old writer loses its authority.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const core = require("../../lib/coordination/permit-legacy-migration-core");
const executor = require("../../lib/coordination/permit-legacy-migration-executor");
const anchor = require("../../lib/coordination/protected-anchor");
const coordination = require("../../lib/coordination/protected-store-lock");
const { openWithLegacyRepair } = require("../../lib/coordination/permit-store-open-with-repair");
const repairAdmission = require("../../lib/coordination/permit-store-open-with-repair");
const bootstrap = require("../../lib/coordination/protected-bootstrap");
const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 };

function compile(source) {
  const filename = require.resolve("../../lib/coordination/protected-permit-store");
  const module = new Module(filename);
  module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(source + "\nmodule.exports.testAssertState = assertState;\n", filename);
  return module.exports;
}

function readEvidence(file, anchorDir) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  let row;
  try { row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get(); }
  finally { db.close(); }
  const state = JSON.parse(row.body);
  const journal = fs.readdirSync(anchorDir)
    .filter((name) => name.startsWith("protected-anchor-entry-") && !name.includes(".tmp-")).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(anchorDir, name), "utf8")));
  const lines = (name) => fs.readFileSync(path.join(anchorDir, name), "utf8").trim().split("\n").map(JSON.parse);
  return { format_version: 1, source: { user_version: 1, ...row },
    expected: { decision_id: state.decision_id, store_id: state.store_id,
      body_digest: row.sha256, anchor_sequence: state.anchor_sequence },
    journal, high_water: lines(anchor.HIGH_WATER_FILE), audit: lines("protected-anchor-audit.log") };
}

let rawV1, oldReaderSource, dir, file, anchorDir, evidence;
let sourceDatabase, sourceAnchor;

test.before(() => {
  if (supported.skip) return;
  oldReaderSource = fs.readFileSync(path.join(__dirname, "fixtures/protected-permit-store-v1-source.txt"), "utf8");
  assert.equal(hash(oldReaderSource), core.FROZEN_SOURCE_SHA256);
  rawV1 = compile(oldReaderSource);
  const runtime = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
  fs.mkdirSync(runtime, { recursive: true });
  dir = fs.mkdtempSync(path.join(runtime, "permit-legacy-executor-"));
  const dbDir = path.join(dir, "db");
  anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  file = path.join(dbDir, "state.sqlite");
  let now = 1000;
  const old = rawV1.ProtectedPermitStore.initialize(file, { decisionId: "D-frozen", anchorDir,
    anchorMode: "permissive", clock: () => now, verifyRecovery: () => true });
  // One complete lease and permit cycle, so that the anchor carries the
  // audit trail the migration evidence describes and the counters the
  // migration core requires are all set.
  const lease = old.acquire({ owner: "fixture", sessionId: "s1", hostId: "h", workerId: "w",
    runId: "r", generation: "g", desktopKey: "desktop-1", ownedAppId: "a",
    idempotencyKey: "lease-1", ttlMs: 100 });
  const permit = old.reserve({ ...lease, idempotencyKey: "permit-1", operation: "invoke",
    targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 50 });
  // The migration core only accepts a DRAINED store: the lease and the permit
  // have to be finished and released, so that no live effect is carried over.
  now = permit.deadline;
  old.consume(permit);
  old.finish({ ...permit, outcome: "finished" });
  old.release(lease);
  old.recover({ fixture: "drained for the migration" });
  evidence = readEvidence(file, anchorDir);
  old.close();
  sourceDatabase = fs.readFileSync(file);
  sourceAnchor = fs.readdirSync(anchorDir).map(name => [name, fs.readFileSync(path.join(anchorDir, name))]);
});

test.after(() => {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the frozen 1.15.7 reader is recognized as fencing a foreign user_version", () => {
  const fence = executor.oldWriterFenceFromSource(oldReaderSource);
  assert.equal(fence.fenced, true);
  assert.equal(fence.mentions, true);
  assert.equal(fence.compares, true);
  assert.equal(fence.refuses, true);
});

test("a source that does not fence the old writer is not recognized as one", () => {
  assert.equal(executor.oldWriterFenceFromSource("// nothing here").fenced, false);
  assert.equal(executor.oldWriterFenceFromSource("user_version").fenced, false);
});

test("a migration applies the prepared bytes and fences the old writer", supported, () => {
  const result = executor.migrateLegacyPermitStore({ filePath: file, anchorDir,
    evidence, oldReaderSource, audit: { by: "fixture", reason: "contract test" } });
  assert.equal(result.migrated, true);
  assert.equal(result.oldWriterFenced, true);
  assert.equal(result.sourceUserVersion, 1);
  assert.equal(result.targetUserVersion, 2);
  // The database now carries the prepared body and the new schema version.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  let row, version;
  try {
    version = db.prepare("PRAGMA user_version").get().user_version;
    row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get();
  } finally { db.close(); }
  assert.equal(version, 2);
  assert.equal(hash(row.body), row.sha256);
  assert.equal(JSON.parse(row.body).schema_version, 2);
  // The old writer is fenced: the frozen reader refuses the migrated store.
  assert.throws(() => rawV1.ProtectedPermitStore.open(file, { expectedDecisionId: "D-frozen",
    minimumEpoch: 1, anchorDir, anchorMode: "permissive", clock: () => 2000, verifyRecovery: () => true }),
  { code: "ERR_STATE_INVALID" });
  // The new reader accepts it.
  const store = ProtectedPermitStore.open(file, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
    anchorDir, anchorMode: "permissive", clock: () => 2000 });
  assert.equal(store.snapshot().schema_version, 2);
  store.close();
});

test("a migration against a store that no longer matches the evidence is refused", supported, () => {
  // The evidence is rejected while it is PREPARED, before the executor ever
  // touches the live store: the prepared bytes have to describe the source
  // exactly, and a tampered digest is not a description of anything.
  assert.throws(() => executor.migrateLegacyPermitStore({ filePath: file, anchorDir,
    evidence: { ...evidence, source: { ...evidence.source, sha256: "0".repeat(64) } },
    oldReaderSource, audit: { by: "fixture", reason: "contract test" } }),
  { code: "ERR_LEGACY_MIGRATION_IDENTITY" });
});

test("a migration without an audit record is refused", supported, () => {
  assert.throws(() => executor.migrateLegacyPermitStore({ filePath: file, anchorDir,
    evidence, oldReaderSource }),
  { code: "ERR_LEGACY_MIGRATION_INPUT" });
});

test("a migration with a source that does not fence the old writer is refused", supported, () => {
  assert.throws(() => executor.migrateLegacyPermitStore({ filePath: file, anchorDir,
    evidence, oldReaderSource: "// nothing here", audit: { by: "fixture", reason: "contract test" } }),
  { code: "ERR_LEGACY_MIGRATION_OLD_WRITER_NOT_FENCED" });
});

test("fence verification is bound to the trusted fixture bytes and executable constant", supported, () => {
  for (const source of [
    oldReaderSource + "\n// user_version !== SCHEMA_VERSION ERR_STATE_INVALID",
    oldReaderSource.replace("const SCHEMA_VERSION = 1;", "const SCHEMA_VERSION = 2;"),
    "// user_version !== SCHEMA_VERSION ERR_STATE_INVALID\nconst SCHEMA_VERSION = 1;",
  ]) {
    assert.equal(executor.oldWriterFenceFromSource(source).fenced, false);
  }
});

function isolatedMigration(t) {
  const root = fs.mkdtempSync(path.join(dir, "negative-"));
  const filePath = path.join(root, "db", "state.sqlite"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(path.dirname(filePath)); fs.mkdirSync(anchorDir);
  fs.writeFileSync(filePath, sourceDatabase);
  for (const [name, bytes] of sourceAnchor) fs.writeFileSync(path.join(anchorDir, name), bytes);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { filePath, anchorDir, evidence, oldReaderSource, audit: { by: "fixture", reason: "R1 regression" } };
}
function rewritingTrigger(target) {
  const state = JSON.parse(target.body); state.last_clock_ms++;
  const body = JSON.stringify(state);
  return `CREATE TRIGGER rewrite_target AFTER UPDATE ON protected_state BEGIN
    UPDATE protected_state SET body=CAST(X'${Buffer.from(body).toString("hex")}' AS TEXT), sha256='${hash(body)}' WHERE id=1;
    END`;
}
function assertMigrationRolledBack(input, highWaterBefore) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(input.filePath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
    assert.deepEqual({ ...db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get() },
      { body: evidence.source.body, sha256: evidence.source.sha256 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM protected_state").get().n, 1);
  } finally { db.close(); }
  const journal = anchor.readJournal(anchor.journalFileFor(input.anchorDir));
  assert.equal(journal.committed, evidence.expected.anchor_sequence);
  assert.equal(journal.entries.some(e => e.type === "commit" && e.sequence > evidence.expected.anchor_sequence), false);
  assert.deepEqual(fs.readFileSync(path.join(input.anchorDir, anchor.HIGH_WATER_FILE)), highWaterBefore);
  assert.equal(executor.migrationIsComplete(input.anchorDir), false);
  assert.equal(fs.existsSync(path.join(input.anchorDir, "protected-legacy-migration-complete.json")), false);
  assert.equal(fs.existsSync(path.join(input.anchorDir, "protected-anchor-recovery.log")), false);
}

for (const kind of ["trigger", "view", "index", "table"]) {
  test(`R1 rejects unexpected SQLite ${kind} before publishing migration intent`, supported, t => {
    const input = isolatedMigration(t), prepared = core.prepareLegacyPermitMigration(JSON.stringify(evidence));
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(input.filePath);
    try {
      db.exec(kind === "trigger" ? rewritingTrigger(prepared.target)
        : kind === "view" ? "CREATE VIEW unexpected AS SELECT * FROM protected_state"
        : kind === "index" ? "CREATE INDEX unexpected ON protected_state(sha256)"
        : "CREATE TABLE unexpected (value TEXT)");
      if (kind === "trigger") {
        // Prove this real trigger reproduces the review's coherent rewrite.
        db.exec("BEGIN IMMEDIATE");
        db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(prepared.target.body, prepared.target.sha256);
        const rewritten = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get();
        assert.notEqual(rewritten.body, prepared.target.body);
        assert.equal(hash(rewritten.body), rewritten.sha256);
        db.exec("ROLLBACK");
      }
    } finally { db.close(); }
    const journalBefore = anchor.readJournal(anchor.journalFileFor(input.anchorDir)).entries;
    const waterBefore = fs.readFileSync(path.join(input.anchorDir, anchor.HIGH_WATER_FILE));
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_SCHEMA_INVALID" });
    assertMigrationRolledBack(input, waterBefore);
    assert.deepEqual(anchor.readJournal(anchor.journalFileFor(input.anchorDir)).entries, journalBefore);
  });
}

for (const mutation of ["trigger-rewrite", "digest", "version", "missing-row", "extra-row"]) {
  test(`R1 re-reads complete target before commit after ${mutation}`, supported, t => {
    const input = isolatedMigration(t), prepared = core.prepareLegacyPermitMigration(JSON.stringify(evidence));
    const waterBefore = fs.readFileSync(path.join(input.anchorDir, anchor.HIGH_WATER_FILE));
    const { DatabaseSync } = require("node:sqlite"), prepare = DatabaseSync.prototype.prepare;
    // Fault injection after the schema precheck and CAS. Drop the late trigger
    // after it fires so this specifically proves the independent byte check.
    t.mock.method(DatabaseSync.prototype, "prepare", function(sql) {
      const statement = prepare.call(this, sql);
      if (!sql.startsWith("UPDATE protected_state SET body=?, sha256=? WHERE id=1 AND")) return statement;
      return { run: (...args) => {
        if (mutation === "trigger-rewrite") this.exec(rewritingTrigger(prepared.target));
        const result = statement.run(...args);
        if (mutation === "trigger-rewrite") this.exec("DROP TRIGGER rewrite_target");
        if (mutation === "digest") prepare.call(this, "UPDATE protected_state SET sha256=? WHERE id=1").run("0".repeat(64));
        if (mutation === "missing-row") this.exec("DELETE FROM protected_state WHERE id=1");
        if (mutation === "extra-row") {
          this.exec("PRAGMA ignore_check_constraints=ON");
          prepare.call(this, "INSERT INTO protected_state (id, body, sha256) VALUES (2, ?, ?)").run(...args.slice(0, 2));
        }
        return result;
      } };
    });
    if (mutation === "version") {
      const exec = DatabaseSync.prototype.exec;
      t.mock.method(DatabaseSync.prototype, "exec", function(sql) {
        const result = exec.call(this, sql);
        if (sql === "PRAGMA user_version=2") exec.call(this, "PRAGMA user_version=9");
        return result;
      });
    }
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_TARGET_MISMATCH" });
    assertMigrationRolledBack(input, waterBefore);
  });
}

const recoveryFile = "protected-anchor-recovery.log";
const completionFile = "protected-legacy-migration-complete.json";
function partialSnapshotWrite(t, input, target, count) {
  const opened = new Map(), open = fs.openSync, write = fs.writeSync;
  const failure = Object.assign(new Error("real partial write then EIO"), { code: "EIO" });
  let temporary;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const fd = open(file, ...args); opened.set(fd, file); return fd;
  });
  t.mock.method(fs, "writeSync", (fd, bytes, offset, length, position) => {
    const file = opened.get(fd);
    if (typeof file === "string" && (file === path.join(input.anchorDir, target) ||
        file.startsWith(path.join(input.anchorDir, target + ".tmp-legacy-migration-")))) {
      temporary = file;
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      assert.equal(write(fd, buffer, offset || 0, count, position ?? null), count);
      throw failure;
    }
    return write(fd, bytes, offset, length, position);
  });
  // Also catch the former appendFileSync path so this regression exercises a
  // real 37-byte public tail against the pre-fix executor.
  const append = fs.appendFileSync;
  t.mock.method(fs, "appendFileSync", (file, bytes, ...args) => {
    if (file !== path.join(input.anchorDir, target)) return append(file, bytes, ...args);
    const fd = open(file, "a", 0o600);
    temporary = file;
    try { assert.equal(write(fd, Buffer.from(bytes), 0, count, null), count); }
    finally { fs.closeSync(fd); }
    throw failure;
  });
  assert.throws(() => executor.migrateLegacyPermitStore(input), error => error === failure);
  assert.equal(fs.statSync(temporary).size, count, "fault must leave real bytes on the bound temporary inode");
  assert.equal(executor.migrationIsComplete(input.anchorDir), false);
  assert.equal(fs.existsSync(path.join(input.anchorDir, completionFile)), false);
  t.mock.restoreAll();
  return temporary;
}
function assertMigratedOpen(input) {
  const prepared = core.prepareLegacyPermitMigration(JSON.stringify(input.evidence));
  const store = ProtectedPermitStore.open(input.filePath, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
    anchorDir: input.anchorDir, anchorMode: "permissive", clock: () => 2000 });
  try {
    assert.equal(store.snapshot().schema_version, 2);
    assert.equal(anchor.readHighWater(input.anchorDir).mark, prepared.append.high_water.sequence);
  } finally { store.close(); }
}
function migrationRecords(input) {
  return fs.readFileSync(path.join(input.anchorDir, recoveryFile), "utf8").trim().split("\n").map(JSON.parse)
    .filter(row => row.migration === "legacy-schema1-to-schema2");
}

test("R5 N1 audit EIO blocks every ordinary open with autoRepair disabled and preserves replay", supported, t => {
  const input = isolatedMigration(t);
  const temporary = partialSnapshotWrite(t, input, recoveryFile, 37);
  const options = { filePath: input.filePath, anchorDir: input.anchorDir, autoRepair: false,
    expectedDecisionId: "D-frozen", minimumEpoch: 1, anchorMode: "permissive", clock: () => 2000 };
  const before = fs.readFileSync(input.filePath), prefix = fs.readFileSync(temporary);
  const open = () => ProtectedPermitStore.open(input.filePath, options);
  assert.throws(open, { code: "ERR_LEGACY_REPAIR_PENDING" });
  for (const autoRepair of [false, true, undefined]) {
    assert.throws(() => openWithLegacyRepair(open, { ...options, autoRepair }),
      error => error.code === "ERR_LEGACY_REPAIR_PENDING" && error.legacyRepair.status === "blocked");
  }
  // The direct open must take the coordination lock before refusing use;
  // correctness must not depend on the wrapper's read-only precheck.
  const withLock = coordination.withLock;
  let locked = false;
  t.mock.method(coordination, "withLock", (dir, action, lockOptions) => withLock(dir, identity => {
    locked = true;
    return action(identity);
  }, lockOptions));
  assert.throws(open, { code: "ERR_LEGACY_REPAIR_PENDING" });
  assert.equal(locked, true);
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(input.filePath), before);
  assert.deepEqual(fs.readFileSync(temporary), prefix);
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  assert.equal(executor.migrationIsComplete(input.anchorDir), true);
  const store = openWithLegacyRepair(open, options).store;
  try { store.restartService(); }
  finally { store.close(); }
  assert.equal(migrationRecords(input).length, 1);
});

test("R5 N1 an already-open instance refuses every ordinary writer until the original plan completes", supported, t => {
  const input = isolatedMigration(t);
  executor.migrateLegacyPermitStore(input);
  const store = ProtectedPermitStore.open(input.filePath, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
    anchorDir: input.anchorDir, anchorMode: "permissive", clock: () => 2000 });
  try {
    const before = store.snapshot();
    assert.equal(before.service_epoch, 1);
    // Simulate a missing final receipt AFTER this handle was opened. Keep the
    // original plan, database, journal, publication binding and audit intact.
    fs.renameSync(path.join(input.anchorDir, completionFile), path.join(input.anchorDir, completionFile + ".held"));
    assert.equal(executor.migrationIsComplete(input.anchorDir), false);
    const database = fs.readFileSync(input.filePath);
    const records = fs.readdirSync(input.anchorDir).filter(name => !name.startsWith(coordination.FILE))
      .map(name => [name, fs.readFileSync(path.join(input.anchorDir, name))]);
    const lease = { ...before.lease, ttlMs: 100 };
    const permit = { ...Object.values(before.permits)[0], ttlMs: 50, idempotencyKey: "pending-permit" };
    const calls = {
      restartService: () => store.restartService(),
      acquire: () => store.acquire({ ...lease, idempotencyKey: "pending-lease" }),
      renew: () => store.renew(lease),
      reserve: () => store.reserve(permit),
      reserveBoundToBatch: () => store.reserveBoundToBatch(permit, "c".repeat(64)),
      consume: () => store.consume(permit),
      finish: () => store.finish({ ...permit, outcome: "finished" }),
      revoke: () => store.revoke(lease),
      release: () => store.release(lease),
      expire: () => store.expire(),
      recover: () => store.recover({ fixture: "pending" }),
    };
    const withLock = coordination.withLock, assertPending = executor.assertNoPendingMigration;
    let locked = false, pendingChecks = 0;
    t.mock.method(coordination, "withLock", (dir, action, options) => withLock(dir, identity => {
      locked = true;
      try { return action(identity); } finally { locked = false; }
    }, options));
    t.mock.method(executor, "assertNoPendingMigration", dir => {
      assert.equal(locked, true, "the pending gate must run under the coordination lock");
      pendingChecks++;
      return assertPending(dir);
    });
    for (const [name, call] of Object.entries(calls)) {
      assert.throws(call, { code: "ERR_LEGACY_REPAIR_PENDING" }, name);
      assert.deepEqual(store.snapshot(), before, `${name} must not advance epoch or any other state`);
      assert.deepEqual(fs.readFileSync(input.filePath), database, `${name} must leave the database unchanged`);
      for (const [file, bytes] of records) assert.deepEqual(fs.readFileSync(path.join(input.anchorDir, file)), bytes);
    }
    assert.equal(pendingChecks, Object.keys(calls).length);
    t.mock.restoreAll();
    // The gate belongs to normal use, not the executor: replay may restore the
    // receipt with this same handle still alive, without changing source bytes.
    assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
    assert.equal(executor.migrationIsComplete(input.anchorDir), true);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(migrationRecords(input).length, 1);
    assert.equal(store.restartService(), 2, "the same handle becomes writable only after completion");
    assert.equal(store.snapshot().service_epoch, 2);
  } finally { store.close(); }
});

for (const unsafe of ["symlink", "hardlink", "directory", "parent-symlink"]) {
  test(`R5 N2 rejects ${unsafe} database before registering a plan or modifying source`, supported, t => {
    const input = isolatedMigration(t), original = input.filePath + ".original";
    const before = fs.readFileSync(input.filePath);
    if (unsafe === "hardlink") fs.linkSync(input.filePath, original);
    else if (unsafe === "parent-symlink") {
      const parent = path.dirname(input.filePath);
      fs.renameSync(parent, parent + ".original");
      fs.symlinkSync(path.basename(parent) + ".original", parent, "dir");
    } else {
      fs.renameSync(input.filePath, original);
      if (unsafe === "symlink") fs.symlinkSync(path.basename(original), input.filePath);
      else fs.mkdirSync(input.filePath);
    }
    const names = fs.readdirSync(input.anchorDir).sort();
    assert.throws(() => ProtectedPermitStore.open(input.filePath, { expectedDecisionId: "D-frozen",
      minimumEpoch: 1, anchorDir: input.anchorDir, anchorMode: "permissive" }), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
    const source = unsafe === "parent-symlink" ? input.filePath : original;
    assert.deepEqual(fs.readFileSync(source), before);
    assert.equal(executor.migrationIsComplete(input.anchorDir), false);
    assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
    assert.equal(fs.existsSync(path.join(input.anchorDir, completionFile)), false);
    assert.deepEqual(fs.readdirSync(input.anchorDir).sort(), names);
  });
}

for (const boundary of ["lock-entry", "sqlite-open", "transaction-entry", "before-cas"]) {
  test(`R5 N2 rejects database replacement at ${boundary} without completion`, supported, t => {
    const input = isolatedMigration(t), original = input.filePath + ".original";
    const before = fs.readFileSync(input.filePath);
    let replaced = false;
    const replace = () => {
      assert.equal(replaced, false);
      fs.renameSync(input.filePath, original);
      fs.writeFileSync(input.filePath, before);
      replaced = true;
    };
    if (boundary === "lock-entry") {
      const withLock = coordination.withLock;
      t.mock.method(coordination, "withLock", (dir, action, options) => withLock(dir, identity => {
        if (!options?.create) replace();
        return action(identity);
      }, options));
    } else {
      const sqlite = require("node:sqlite"), DatabaseSync = sqlite.DatabaseSync;
      if (boundary === "sqlite-open") {
        t.mock.method(sqlite, "DatabaseSync", class extends DatabaseSync {
          constructor(file, options) {
            super(file, options);
            if (file === path.resolve(input.filePath)) replace();
          }
        });
      } else {
        const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
        if (boundary === "transaction-entry") t.mock.method(DatabaseSync.prototype, "exec", function(sql) {
          const result = exec.call(this, sql);
          if (sql === "BEGIN IMMEDIATE" && prepare.call(this, "PRAGMA database_list").all()
            .some(row => row.file === path.resolve(input.filePath))) replace();
          return result;
        });
        else t.mock.method(DatabaseSync.prototype, "prepare", function(sql) {
          const statement = prepare.call(this, sql);
          if (sql === "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name" && !replaced) {
            return { all: () => { const result = statement.all(); replace(); return result; } };
          }
          return statement;
        });
      }
    }
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
    t.mock.restoreAll();
    assert.equal(replaced, true);
    assert.deepEqual(fs.readFileSync(original), before);
    assert.deepEqual(fs.readFileSync(input.filePath), before);
    assert.equal(executor.migrationIsComplete(input.anchorDir), false);
    assert.equal(fs.existsSync(path.join(input.anchorDir, completionFile)), false);
    // Restoring the exact original inode allows the original registered plan.
    fs.unlinkSync(input.filePath);
    fs.renameSync(original, input.filePath);
    assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  });
}

test("R4 F1 high-water writes 19 bytes then EIO and the original plan resumes", supported, t => {
  const input = isolatedMigration(t), target = path.join(input.anchorDir, anchor.HIGH_WATER_FILE);
  const before = fs.readFileSync(target);
  const temporary = partialSnapshotWrite(t, input, anchor.HIGH_WATER_FILE, 19);
  assert.deepEqual(fs.readFileSync(target), before, "partial snapshot must never reach the public declaration");
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(executor.migrationIsComplete(input.anchorDir), true);
  assert.equal(migrationRecords(input).length, 1);
  assertMigratedOpen(input);
});

for (const damage of ["empty", "truncated", "foreign-valid-json", "missing"]) {
  test(`R4 F1 refuses and preserves unowned ${damage} public high-water`, supported, t => {
    const input = isolatedMigration(t), target = path.join(input.anchorDir, anchor.HIGH_WATER_FILE);
    const temporary = partialSnapshotWrite(t, input, anchor.HIGH_WATER_FILE, 19);
    const ownedBytes = fs.readFileSync(temporary);
    if (damage === "missing") fs.unlinkSync(target);
    else fs.writeFileSync(target, damage === "empty" ? "" : damage === "truncated" ? '{"sequence":' : '{"foreign":true}\n');
    const damaged = damage === "missing" ? null : fs.readFileSync(target);
    for (let n = 0; n < 2; n++) {
      assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN" });
      if (damaged) assert.deepEqual(fs.readFileSync(target), damaged);
      else assert.equal(fs.existsSync(target), false);
      assert.deepEqual(fs.readFileSync(temporary), ownedBytes);
      assert.equal(executor.migrationIsComplete(input.anchorDir), false);
    }
  });
}

test("R4 F2 audit writes 37 bytes then EIO and replay publishes one valid record", supported, t => {
  const input = isolatedMigration(t), target = path.join(input.anchorDir, recoveryFile);
  // Preserve historical records as exact bytes, including their formatting.
  const history = '{ "migration": "historical", "by": "fixture" }\n';
  fs.writeFileSync(target, history);
  const temporary = partialSnapshotWrite(t, input, recoveryFile, 37);
  assert.equal(fs.readFileSync(target, "utf8"), history);
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  assert.equal(fs.existsSync(temporary), false);
  assert.ok(fs.readFileSync(target, "utf8").startsWith(history));
  assert.equal(migrationRecords(input).length, 1, "JSON.parse of every row must succeed");
  assertMigratedOpen(input);
});

test("R4 F2 completion failure reuses the exact audit record on every replay", supported, t => {
  const input = isolatedMigration(t), link = fs.linkSync;
  t.mock.method(fs, "linkSync", (from, to) => {
    if (to === path.join(input.anchorDir, completionFile)) throw Object.assign(new Error("receipt EIO"), { code: "EIO" });
    return link(from, to);
  });
  assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PENDING_IO" });
  const target = path.join(input.anchorDir, recoveryFile), published = fs.readFileSync(target);
  const record = migrationRecords(input)[0], inode = fs.statSync(target).ino;
  assert.equal(migrationRecords(input).length, 1);
  assert.equal(executor.migrationIsComplete(input.anchorDir), false);
  t.mock.restoreAll();
  for (let n = 0; n < 2; n++) {
    const result = executor.migrateLegacyPermitStore(input);
    assert.deepEqual(result.audit, record);
    assert.deepEqual(fs.readFileSync(target), published);
    assert.equal(fs.statSync(target).ino, inode, "reuse the already-published snapshot");
    assert.equal(migrationRecords(input).length, 1);
    assert.equal(executor.migrationIsComplete(input.anchorDir), true);
  }
  assertMigratedOpen(input);
});

for (const damage of ["empty", "truncated", "foreign-valid-json"]) {
  test(`R4 F2 refuses and preserves unowned ${damage} public audit`, supported, t => {
    const input = isolatedMigration(t), target = path.join(input.anchorDir, recoveryFile);
    const temporary = partialSnapshotWrite(t, input, recoveryFile, 37), owned = fs.readFileSync(temporary);
    fs.writeFileSync(target, damage === "empty" ? "" : damage === "truncated" ? '{"migration":' : '{"foreign":true}\n');
    const damaged = fs.readFileSync(target);
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN" });
    assert.deepEqual(fs.readFileSync(target), damaged);
    assert.deepEqual(fs.readFileSync(temporary), owned);
    assert.equal(executor.migrationIsComplete(input.anchorDir), false);
  });
}

for (const damage of ["replaced-inode", "different-prefix", "missing"]) {
  test(`R4 refuses ${damage} temporary high-water even at the bound name`, supported, t => {
    const input = isolatedMigration(t), target = path.join(input.anchorDir, anchor.HIGH_WATER_FILE);
    const before = fs.readFileSync(target), temporary = partialSnapshotWrite(t, input, anchor.HIGH_WATER_FILE, 19);
    const prefix = fs.readFileSync(temporary);
    if (damage === "replaced-inode") {
      fs.renameSync(temporary, temporary + ".foreign-evidence");
      fs.writeFileSync(temporary, prefix);
    } else if (damage === "different-prefix") fs.writeFileSync(temporary, "!".repeat(19));
    else fs.unlinkSync(temporary);
    const damaged = damage === "missing" ? null : fs.readFileSync(temporary);
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN" });
    assert.deepEqual(fs.readFileSync(target), before);
    if (damaged) assert.deepEqual(fs.readFileSync(temporary), damaged);
    else assert.equal(fs.existsSync(temporary), false);
    assert.equal(executor.migrationIsComplete(input.anchorDir), false);
  });
}

for (const target of [anchor.HIGH_WATER_FILE, recoveryFile]) {
  for (const boundary of ["rename-after-effect", "directory-fsync"]) {
    test(`R4 ${target} reuses publication after ${boundary} EIO`, supported, t => {
      const input = isolatedMigration(t), rename = fs.renameSync, sync = fs.fsyncSync;
      let renamed = false;
      const failure = Object.assign(new Error("uncertain publication barrier"), { code: "EIO" });
      t.mock.method(fs, "renameSync", (from, to) => {
        const result = rename(from, to);
        if (to === path.join(input.anchorDir, target)) {
          renamed = true;
          if (boundary === "rename-after-effect") throw failure;
        }
        return result;
      });
      if (boundary === "directory-fsync") t.mock.method(fs, "fsyncSync", fd => {
        if (renamed && fs.fstatSync(fd).isDirectory()) throw failure;
        return sync(fd);
      });
      assert.throws(() => executor.migrateLegacyPermitStore(input), error => error === failure);
      assert.equal(renamed, true);
      const file = path.join(input.anchorDir, target), bytes = fs.readFileSync(file), inode = fs.statSync(file).ino;
      assert.equal(executor.migrationIsComplete(input.anchorDir), false);
      t.mock.restoreAll();
      assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
      assert.deepEqual(fs.readFileSync(file), bytes);
      assert.equal(fs.statSync(file).ino, inode);
      assert.equal(migrationRecords(input).length, 1);
      assertMigratedOpen(input);
    });
  }
}

for (const afterEffect of [false, true]) {
  test(`R4 binding publication failure (after effect=${afterEffect}) resumes before data writes`, supported, t => {
    const input = isolatedMigration(t), link = fs.linkSync;
    const waterFile = path.join(input.anchorDir, anchor.HIGH_WATER_FILE), before = fs.readFileSync(waterFile);
    t.mock.method(fs, "linkSync", (from, to) => {
      if (path.basename(to) === "protected-legacy-migration-publication.json") {
        if (afterEffect) link(from, to);
        throw Object.assign(new Error("binding EIO"), { code: "EIO" });
      }
      return link(from, to);
    });
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PENDING_IO" });
    assertMigrationRolledBack(input, before);
    t.mock.restoreAll();
    assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
    assert.equal(migrationRecords(input).length, 1);
    assertMigratedOpen(input);
  });
}

for (const bytes of ["", '{"migration":', '{"historical":true}']) {
  test(`R4 rejects a preexisting invalid audit snapshot (${bytes.length} bytes) before DB mutation`, supported, t => {
    const input = isolatedMigration(t), file = path.join(input.anchorDir, recoveryFile);
    const before = fs.readFileSync(input.filePath), water = fs.readFileSync(path.join(input.anchorDir, anchor.HIGH_WATER_FILE));
    fs.writeFileSync(file, bytes);
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN" });
    assert.deepEqual(fs.readFileSync(input.filePath), before);
    assert.deepEqual(fs.readFileSync(path.join(input.anchorDir, anchor.HIGH_WATER_FILE)), water);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    assert.equal(executor.migrationIsComplete(input.anchorDir), false);
    assert.equal(fs.readdirSync(input.anchorDir).some(name => name.includes(".tmp-legacy-migration-")), false);
  });
}

function observeStoreOpens(t, filePath) {
  const sqlite = require("node:sqlite"), DatabaseSync = sqlite.DatabaseSync;
  let opens = 0;
  t.mock.method(sqlite, "DatabaseSync", class extends DatabaseSync {
    constructor(filename, options) {
      if (path.resolve(filename) === path.resolve(filePath)) opens++;
      super(filename, options);
    }
  });
  return () => opens;
}

for (const suffix of ["-wal", "-shm", "-journal"]) {
  for (const type of ["symlink", "dangling-symlink", "directory", "fifo"]) {
    test(`R6 F1 rejects ${type} ${suffix} before a plan or SQLite open`,
      { skip: supported.skip || (type === "fifo" && process.platform === "win32") }, t => {
        const input = isolatedMigration(t), sidecar = input.filePath + suffix;
        const victim = input.filePath + ".victim", bytes = Buffer.alloc(65536, 0x42);
        fs.writeFileSync(victim, bytes);
        if (type === "symlink") fs.symlinkSync(path.basename(victim), sidecar);
        else if (type === "dangling-symlink") fs.symlinkSync("absent", sidecar);
        else if (type === "directory") fs.mkdirSync(sidecar);
        else {
          const result = require("node:child_process").spawnSync("mkfifo", [sidecar], { encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
        }
        const before = fs.readFileSync(input.filePath), names = fs.readdirSync(input.anchorDir).sort();
        const opens = observeStoreOpens(t, input.filePath);
        assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
        assert.throws(() => ProtectedPermitStore.open(input.filePath, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
          anchorDir: input.anchorDir, anchorMode: "permissive" }), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
        assert.equal(opens(), 0);
        assert.deepEqual(fs.readFileSync(victim), bytes);
        assert.deepEqual(fs.readFileSync(input.filePath), before);
        assert.deepEqual(fs.readdirSync(input.anchorDir).sort(), names);
        assert.equal(executor.migrationIsComplete(input.anchorDir), false);
      });
  }

  for (const change of ["hardlink", "replacement", "disappearance", "appearance"]) {
    test(`R6 F1 binds ${suffix} at lock entry against ${change}`, supported, t => {
      const input = isolatedMigration(t), sidecar = input.filePath + suffix;
      if (change !== "appearance") fs.writeFileSync(sidecar, "");
      const victim = input.filePath + ".victim", bytes = Buffer.alloc(65536, 0x43);
      fs.writeFileSync(victim, bytes);
      const before = fs.readFileSync(input.filePath), withLock = coordination.withLock;
      let changed = false;
      t.mock.method(coordination, "withLock", (dir, action, options) => withLock(dir, identity => {
        if (!options?.create) {
          changed = true;
          // Keep the old inode alive so the OS cannot reuse its number.
          if (change !== "appearance") fs.renameSync(sidecar, sidecar + ".held");
          if (change === "hardlink") fs.linkSync(victim, sidecar);
          else if (change !== "disappearance") fs.writeFileSync(sidecar, "");
        }
        return action(identity);
      }, options));
      const opens = observeStoreOpens(t, input.filePath);
      assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
      assert.equal(changed, true);
      assert.equal(opens(), 0, "locked recheck must precede SQLite open");
      assert.deepEqual(fs.readFileSync(victim), bytes);
      assert.deepEqual(fs.readFileSync(input.filePath), before);
      assert.equal(executor.migrationIsComplete(input.anchorDir), false);
      assert.equal(fs.existsSync(path.join(input.anchorDir, completionFile)), false);
    });
  }

  test(`R6 F1 ordinary open rechecks ${suffix} under the lock before its writable SQLite open`, supported, t => {
    const input = isolatedMigration(t);
    assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
    const victim = input.filePath + ".victim", bytes = Buffer.alloc(65536, 0x44);
    fs.writeFileSync(victim, bytes);
    const before = fs.readFileSync(input.filePath), withLock = coordination.withLock;
    t.mock.method(coordination, "withLock", (dir, action, options) => withLock(dir, identity => {
      fs.rmSync(input.filePath + suffix, { force: true });
      fs.linkSync(victim, input.filePath + suffix);
      return action(identity);
    }, options));
    const opens = observeStoreOpens(t, input.filePath);
    assert.throws(() => ProtectedPermitStore.open(input.filePath, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
      anchorDir: input.anchorDir, anchorMode: "permissive", clock: () => 2000 }), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
    assert.equal(opens(), 1, "only the earlier safe read-only discovery may open SQLite");
    assert.deepEqual(fs.readFileSync(victim), bytes);
    assert.deepEqual(fs.readFileSync(input.filePath), before);
  });
}

for (const operation of ["migration", "ordinary-open"]) {
  test(`R6 F2 ${operation} accepts an ancestor alias to a separate real database domain`, supported, t => {
    const input = isolatedMigration(t), root = path.dirname(path.dirname(input.filePath));
    const nested = path.join(path.dirname(input.filePath), "nested-db");
    fs.mkdirSync(nested);
    const physical = path.join(nested, "state.sqlite");
    fs.renameSync(input.filePath, physical);
    const alias = path.join(root, "alias");
    fs.symlinkSync("db", alias, "dir");
    input.filePath = path.join(alias, "nested-db", "state.sqlite");
    assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
    assert.equal(executor.migrationIsComplete(input.anchorDir), true);
    if (operation === "ordinary-open") {
      const store = ProtectedPermitStore.open(input.filePath, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
        anchorDir: input.anchorDir, anchorMode: "permissive", clock: () => 2000 });
      try { assert.equal(store.snapshot().schema_version, 2); }
      finally { store.close(); }
    }
  });
}

for (const changedDomain of ["database-ancestor", "anchor"]) {
  test(`R6 F2 binds ${changedDomain} directory identity across lock entry`, supported, t => {
    const input = isolatedMigration(t), parent = path.dirname(input.filePath), nested = path.join(parent, "nested-db");
    fs.mkdirSync(nested);
    fs.renameSync(input.filePath, path.join(nested, "state.sqlite"));
    input.filePath = path.join(nested, "state.sqlite");
    const databaseIdentity = fs.lstatSync(input.filePath).ino, parentIdentity = fs.lstatSync(nested).ino;
    const before = fs.readFileSync(input.filePath), withLock = coordination.withLock;
    t.mock.method(coordination, "withLock", (dir, action, options) => withLock(dir, identity => {
      if (!options?.create) {
        if (changedDomain === "database-ancestor") {
          fs.renameSync(parent, parent + ".held");
          fs.mkdirSync(parent);
          fs.renameSync(path.join(parent + ".held", "nested-db"), nested);
        } else {
          fs.renameSync(input.anchorDir, input.anchorDir + ".held");
          fs.mkdirSync(input.anchorDir);
          for (const name of fs.readdirSync(input.anchorDir + ".held")) {
            fs.renameSync(path.join(input.anchorDir + ".held", name), path.join(input.anchorDir, name));
          }
        }
      }
      return action(identity);
    }, options));
    const opens = observeStoreOpens(t, input.filePath);
    assert.throws(() => executor.migrateLegacyPermitStore(input), {
      code: changedDomain === "anchor" ? "ERR_ANCHOR_NOT_SEPARATE" : "ERR_STATE_MISSING_OR_UNSAFE",
    });
    assert.equal(opens(), 0);
    assert.equal(fs.lstatSync(input.filePath).ino, databaseIdentity);
    assert.equal(fs.lstatSync(nested).ino, parentIdentity, "direct parent identity alone cannot detect this replacement");
    assert.deepEqual(fs.readFileSync(input.filePath), before);
    assert.equal(executor.migrationIsComplete(input.anchorDir), false);
    assert.equal(fs.existsSync(path.join(input.anchorDir, completionFile)), false);
  });
}

test("R6 F2 realpath comparison includes the anchor and refuses overlap in either direction", supported, t => {
  const input = isolatedMigration(t), root = path.dirname(input.anchorDir), alias = path.join(root, "alias");
  fs.symlinkSync("db", alias, "dir");
  const anchorInsideDatabase = path.join(path.dirname(input.filePath), "nested-anchor");
  fs.mkdirSync(anchorInsideDatabase);
  assert.throws(() => anchor.assertSeparateDomains(path.join(alias, "nested-anchor"), input.filePath),
    { code: "ERR_ANCHOR_NOT_SEPARATE" });
  const nestedDatabase = path.join(anchorInsideDatabase, "nested-db");
  fs.mkdirSync(nestedDatabase);
  assert.throws(() => anchor.assertSeparateDomains(path.join(alias, "nested-anchor"), path.join(nestedDatabase, "state.sqlite")),
    { code: "ERR_ANCHOR_NOT_SEPARATE" });
});

test("R6 F2 dot-prefixed child names remain inside their real rollback domain", supported, t => {
  const input = isolatedMigration(t), nested = path.join(input.anchorDir, "..nested-db");
  fs.mkdirSync(nested);
  assert.throws(() => anchor.assertSeparateDomains(input.anchorDir, path.join(nested, "state.sqlite")),
    { code: "ERR_ANCHOR_NOT_SEPARATE" });
  const nestedAnchor = path.join(path.dirname(input.filePath), "..nested-anchor");
  fs.mkdirSync(nestedAnchor);
  assert.throws(() => anchor.assertSeparateDomains(nestedAnchor, input.filePath), { code: "ERR_ANCHOR_NOT_SEPARATE" });
  const sibling = path.join(path.dirname(input.anchorDir), "anchor-sibling");
  fs.mkdirSync(sibling);
  assert.doesNotThrow(() => anchor.assertSeparateDomains(input.anchorDir, path.join(sibling, "state.sqlite")));
});

function pauseAfterPending(t, input) {
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (from, to) => {
    if (path.basename(to) === "protected-legacy-migration-started.json") {
      throw Object.assign(new Error("stopped before started receipt"), { code: "EIO" });
    }
    return link(from, to);
  });
  assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PENDING_IO" });
  t.mock.restoreAll();
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), true);
  assert.equal(fs.existsSync(path.join(input.anchorDir, "protected-legacy-migration-started.json")), false);
}
function openFixture(input, decisionId = "D-frozen") {
  return ProtectedPermitStore.open(input.filePath, { expectedDecisionId: decisionId, minimumEpoch: 1,
    anchorDir: input.anchorDir, anchorMode: "permissive", clock: () => 2000 });
}
function healthyStore(t) {
  const root = fs.mkdtempSync(path.join(dir, "healthy-")), anchorDir = path.join(root, "anchor");
  const filePath = path.join(root, "db", "state.sqlite");
  fs.mkdirSync(path.dirname(filePath)); fs.mkdirSync(anchorDir);
  ProtectedPermitStore.initialize(filePath, { decisionId: "D-healthy", anchorDir, anchorMode: "permissive", clock: () => 1000 }).close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...isolatedMigration(t), filePath, anchorDir };
}
function obsoletePlan(input) {
  const encoded = JSON.stringify(input.evidence), prepared = core.prepareLegacyPermitMigration(encoded);
  return { format_version: 1, database: path.resolve(input.filePath), source_evidence_digest: prepared.source_evidence_digest,
    encoded_evidence: encoded, evidence: input.evidence, prepared, old_reader_sha256: hash(input.oldReaderSource), audit: input.audit };
}
const abortAudit = { by: "security-fixture", reason: "verified not attempted" };

test("R6 F3 pending initialize leaves no claim and original migration replay restores opening", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const secondDir = path.join(path.dirname(input.filePath), "second");
  fs.mkdirSync(secondDir);
  const before = fs.readdirSync(input.anchorDir).sort();
  assert.throws(() => ProtectedPermitStore.initialize(path.join(secondDir, "second.sqlite"), {
    decisionId: "D-other", anchorDir: input.anchorDir, anchorMode: "permissive", clock: () => 2000,
  }), { code: "ERR_LEGACY_REPAIR_PENDING" });
  assert.deepEqual(fs.readdirSync(input.anchorDir).sort(), before);
  assert.equal(bootstrap.bootstrapState(input.anchorDir).pending.length, 0);
  assert.deepEqual(fs.readdirSync(secondDir), []);
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  openFixture(input).close();
});

test("R6 F4 wrong schema1 evidence cannot poison a healthy schema2 database", supported, t => {
  const input = healthyStore(t), before = fs.readFileSync(input.filePath);
  assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_SOURCE_MISMATCH" });
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
  assert.deepEqual(fs.readFileSync(input.filePath), before);
  openFixture(input, "D-healthy").close();
});

test("R6 F4 applicable unstarted pending can exit only with a durable audit", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const before = fs.readFileSync(input.filePath);
  const result = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  assert.equal(result.aborted, true);
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
  assert.deepEqual(fs.readFileSync(input.filePath), before);
  const record = JSON.parse(fs.readFileSync(result.auditFile));
  assert.equal(record.outcome, "not-attempted");
  assert.equal(record.by, abortAudit.by);
  assert.equal(record.plan_sha256, result.planSha256);
  assert.deepEqual(record.plan, obsoletePlan(input));
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  openFixture(input).close();
});

test("R6 F4 historical wrong pending exits with audit and restores a healthy database", supported, t => {
  const input = healthyStore(t), pendingFile = path.join(input.anchorDir, executor.PENDING_FILE);
  fs.writeFileSync(pendingFile, JSON.stringify(obsoletePlan(input)) + "\n");
  assert.throws(() => openFixture(input, "D-healthy"), { code: "ERR_LEGACY_REPAIR_PENDING" });
  const result = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  assert.equal(JSON.parse(fs.readFileSync(result.auditFile)).outcome, "not-attempted");
  openFixture(input, "D-healthy").close();
});

for (const marker of ["started", "publication", "complete", "unknown.tmp-artifact"]) {
  test(`R6 F4 abort preserves uncertain pending with ${marker} evidence`, supported, t => {
    const input = isolatedMigration(t);
    pauseAfterPending(t, input);
    fs.writeFileSync(path.join(input.anchorDir, `protected-legacy-migration-${marker}.json`), "{}\n");
    const pending = fs.readFileSync(path.join(input.anchorDir, executor.PENDING_FILE));
    assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(input, abortAudit), { code: "ERR_LEGACY_MIGRATION_ABORT_UNSAFE" });
    assert.deepEqual(fs.readFileSync(path.join(input.anchorDir, executor.PENDING_FILE)), pending);
    assert.equal(fs.readdirSync(input.anchorDir).some(name => name.startsWith("protected-legacy-migration-aborted-")), false);
  });
}

test("R6 F4 abort refuses published intent even without a started marker", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const prepared = core.prepareLegacyPermitMigration(JSON.stringify(input.evidence));
  anchor.appendEntry(anchor.journalFileFor(input.anchorDir), prepared.append.intent);
  assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(input, abortAudit), { code: "ERR_LEGACY_MIGRATION_ABORT_UNSAFE" });
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), true);
});

// R10-01: the relaxed object-set comparison must never excuse a rewritten
// auditor or reason. Those fields are the audit's own identity, not part of
// the growing history, so they must match the stored record exactly.
for (const field of ["by", "reason"]) {
  test(`R10-01 a rewritten historical abort audit ${field} is refused`, supported, t => {
    const input = isolatedMigration(t);
    pauseAfterPending(t, input);
    const first = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
    const record = JSON.parse(fs.readFileSync(first.auditFile));
    record[field] = field === "by" ? "forged-by" : "forged-reason";
    fs.writeFileSync(first.auditFile, JSON.stringify(record) + "\n");
    pauseAfterPending(t, input);
    assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(input, abortAudit),
      { code: "ERR_LEGACY_MIGRATION_ABORT_UNSAFE" });
    assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), true);
  });
}

// R10-01: the auditor of the CURRENT request must also agree with the stored
// audit. A different auditor is a different registration, not a retry of the
// stored one, and must not silently reuse the stored audit.
test("R10-01 a changed auditor for the same plan is refused", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const first = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  assert.equal(first.aborted, true);
  pauseAfterPending(t, input);
  const other = { by: "other-fixture", reason: abortAudit.reason };
  assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(input, other),
    { code: "ERR_LEGACY_MIGRATION_ABORT_UNSAFE" });
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), true);
});

// R9-01: a historical abort audit must stay reusable when later, fully
// validated history joins the anchor. A strict snapshot equality made the
// first plan permanently unabortable as soon as a second plan was aborted.
test("R9-01 an abort audit survives later validated history and stays reusable", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const first = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  const firstBytes = fs.readFileSync(first.auditFile);
  const firstStat = fs.statSync(first.auditFile);

  // A different plan is aborted as well. Its audit joins the anchor and must
  // not invalidate the first one. The plan carries the registration audit, so
  // changing it produces a genuinely different plan and a separate file.
  const other = { ...input, audit: { by: "security-fixture", reason: "second plan" } };
  pauseAfterPending(t, other);
  const second = repairAdmission.abortUnstartedLegacyMigration(other, { by: "security-fixture", reason: "second plan" });
  assert.notEqual(second.auditFile, first.auditFile);

  // The original plan is registered and aborted a third time. The stored
  // audit must keep its bytes, its identity and its timestamp.
  pauseAfterPending(t, input);
  const third = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  assert.equal(third.aborted, true);
  assert.equal(third.auditFile, first.auditFile);
  assert.deepEqual(fs.readFileSync(first.auditFile), firstBytes);
  assert.equal(fs.statSync(first.auditFile).mtimeMs, firstStat.mtimeMs);
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
});

// R9-01: the loosened comparison must not accept a rewritten historical
// audit. A changed observed evidence value is still a conflict.
test("R9-01 a rewritten historical abort audit is refused", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const first = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  const record = JSON.parse(fs.readFileSync(first.auditFile));
  record.observed.body_sha256 = "f".repeat(64);
  fs.writeFileSync(first.auditFile, JSON.stringify(record) + "\n");
  pauseAfterPending(t, input);
  assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(input, abortAudit), { code: "ERR_LEGACY_MIGRATION_ABORT_UNSAFE" });
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), true);
});

// R9-02: the coordination database may run in WAL mode. Its sidecars belong
// to the lock domain and must not be reported as unknown anchor objects.
test("R9-02 an unstarted abort works on a WAL coordination database", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(input.anchorDir, coordination.FILE);
  const keeper = new DatabaseSync(file);
  try { keeper.exec("PRAGMA journal_mode=WAL"); }
  finally { keeper.close(); }
  const result = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  assert.equal(result.aborted, true);
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
});

// R9-02: a sidecar of the coordination database is accepted, but it never
// becomes part of the historical evidence: a checkpoint that rewrites it
// must not change the proof of an earlier abort.
test("R9-02 a coordination sidecar does not become part of the abort evidence", supported, t => {
  const input = isolatedMigration(t);
  pauseAfterPending(t, input);
  const first = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  const record = JSON.parse(fs.readFileSync(first.auditFile));
  assert.equal(record.observed.objects.some(object => object.name.endsWith("-wal") || object.name.endsWith("-shm")), false);
  assert.equal(record.observed.objects.some(object => object.name === coordination.FILE && object.sha256 === undefined), true);
  assert.equal(fs.existsSync(first.auditFile), true);
});

for (const afterEffect of [false, true]) {
  test(`R6 F4 failed abort audit barrier (published=${afterEffect}) retains pending and retries`, supported, t => {
    const input = isolatedMigration(t);
    pauseAfterPending(t, input);
    const link = fs.linkSync, sync = fs.fsyncSync;
    let auditPublished = false;
    t.mock.method(fs, "linkSync", (from, to) => {
      if (path.basename(to).startsWith("protected-legacy-migration-aborted-")) {
        if (!afterEffect) throw Object.assign(new Error("audit denied"), { code: "EIO" });
        const result = link(from, to); auditPublished = true; return result;
      }
      return link(from, to);
    });
    t.mock.method(fs, "fsyncSync", fd => {
      if (auditPublished && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("audit barrier"), { code: "EIO" });
      return sync(fd);
    });
    assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(input, abortAudit), { code: "EIO" });
    assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), true);
    t.mock.restoreAll();
    assert.equal(repairAdmission.abortUnstartedLegacyMigration(input, abortAudit).aborted, true);
  });
}

test("R6 F3 shared admission prevents a concurrent initializer from registering", supported, t => {
  const input = isolatedMigration(t), secondDir = path.join(path.dirname(input.filePath), "new-store");
  fs.mkdirSync(secondDir);
  // Use an empty domain for the nested initializer so the mutex, rather than
  // preexisting evidence, is the reason registration is refused.
  const emptyAnchor = path.join(path.dirname(input.anchorDir), "empty-anchor"); fs.mkdirSync(emptyAnchor);
  repairAdmission.withMigrationAdmission(emptyAnchor, () => {
    assert.throws(() => ProtectedPermitStore.initialize(path.join(secondDir, "new.sqlite"), {
      decisionId: "D-race", anchorDir: emptyAnchor, anchorMode: "permissive", clock: () => 2000,
    }), { code: "ERR_LEGACY_MIGRATION_BUSY" });
    assert.equal(bootstrap.bootstrapState(emptyAnchor).pending.length, 0);
  });
  assert.deepEqual(fs.readdirSync(emptyAnchor), []);
});

test("R6 F4 a normal writer holds the common lock past its gate before pending can register", supported, async t => {
  const input = healthyStore(t), { spawn } = require("node:child_process");
  const resultFile = path.join(path.dirname(input.anchorDir), "writer-result.json");
  const source = `
    const fs = require('node:fs');
    const { ProtectedPermitStore } = require('./lib/coordination/protected-permit-store');
    const executor = require('./lib/coordination/permit-legacy-migration-executor');
    const path = require('node:path');
    const [filePath, anchorDir, resultFile] = process.argv.slice(1);
    const store = ProtectedPermitStore.open(filePath, { expectedDecisionId: 'D-healthy', minimumEpoch: 1,
      anchorDir, anchorMode: 'permissive', clock: () => 2000 });
    const gate = executor.assertNoPendingMigration;
    let pendingWhileLocked;
    executor.assertNoPendingMigration = dir => {
      gate(dir);
      process.send({ passed: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      pendingWhileLocked = fs.existsSync(path.join(dir, executor.PENDING_FILE));
    };
    const epoch = store.restartService();
    store.close();
    fs.writeFileSync(resultFile, JSON.stringify({ epoch, pendingWhileLocked }));
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["-e", source, input.filePath, input.anchorDir, resultFile], {
    cwd: path.resolve(__dirname, "../.."), stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`writer failed ${code}/${signal}: ${stderr}`)));
  });
  // Attach the rejection handler before awaiting readiness.
  exited.catch(() => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer did not reach gate")), 10000);
    child.once("message", message => { clearTimeout(timer); assert.equal(message.passed, true); resolve(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr)); });
  });
  // A writer may create/remove its own SQLite sidecars while this executor
  // waits. The independent path gate can conservatively reject that changed
  // preflight set before the source comparison. Neither refusal may publish.
  assert.throws(() => executor.migrateLegacyPermitStore(input), error =>
    ["ERR_LEGACY_MIGRATION_SOURCE_MISMATCH", "ERR_STATE_MISSING_OR_UNSAFE"].includes(error.code));
  await exited;
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile)), { epoch: 2, pendingWhileLocked: false });
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
  assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_SOURCE_MISMATCH" });
  const store = openFixture(input, "D-healthy");
  assert.equal(store.snapshot().service_epoch, 2); store.close();
});

test("R6 F3 initializer rechecks occupancy inside admission immediately before registration", supported, t => {
  const input = isolatedMigration(t), root = path.dirname(input.anchorDir);
  const emptyAnchor = path.join(root, "vacant-anchor"), dbDir = path.join(root, "vacant-db");
  fs.mkdirSync(emptyAnchor); fs.mkdirSync(dbDir);
  const inspect = anchor.inspectAnchorPermissions;
  t.mock.method(anchor, "inspectAnchorPermissions", (...args) => {
    const result = inspect(...args);
    // Model an executor completing admission after the initial read-only
    // check, before this initializer acquires the shared admission lock.
    fs.writeFileSync(path.join(emptyAnchor, executor.PENDING_FILE), "{}\n");
    return result;
  });
  assert.throws(() => ProtectedPermitStore.initialize(path.join(dbDir, "new.sqlite"), {
    decisionId: "D-race", anchorDir: emptyAnchor, anchorMode: "permissive", clock: () => 2000,
  }), { code: "ERR_LEGACY_REPAIR_PENDING" });
  assert.equal(bootstrap.bootstrapState(emptyAnchor).pending.length, 0);
  assert.deepEqual(fs.readdirSync(emptyAnchor), [executor.PENDING_FILE]);
  assert.deepEqual(fs.readdirSync(dbDir), []);
});

test("R6 F3 migration cannot provision its coordination file while bootstrap admission is held", supported, t => {
  const input = isolatedMigration(t);
  repairAdmission.withMigrationAdmission(input.anchorDir, () => {
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_BUSY" });
    assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
    assert.equal(fs.existsSync(path.join(input.anchorDir, coordination.FILE)), false);
  });
});

for (const kind of ["database-target", "high-water", "recovery-audit", "wrong-plan"]) {
  test(`R6 F4 abort refuses ${kind} proof and preserves pending`, supported, t => {
    const input = isolatedMigration(t);
    pauseAfterPending(t, input);
    const prepared = core.prepareLegacyPermitMigration(JSON.stringify(input.evidence));
    let attempted = input;
    if (kind === "database-target") {
      const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(input.filePath);
      try {
        db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(prepared.target.body, prepared.target.sha256);
        db.exec("PRAGMA user_version=2");
      } finally { db.close(); }
    } else if (kind === "high-water") {
      anchor.appendHighWater(input.anchorDir, prepared.append.high_water);
    } else if (kind === "recovery-audit") {
      fs.writeFileSync(path.join(input.anchorDir, "protected-anchor-recovery.log"), JSON.stringify({
        source_evidence_digest: prepared.source_evidence_digest, target_sha256: prepared.target.sha256,
      }) + "\n");
    } else attempted = { ...input, audit: { ...input.audit, reason: "different original plan" } };
    const pending = fs.readFileSync(path.join(input.anchorDir, executor.PENDING_FILE));
    assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(attempted, abortAudit), { code: "ERR_LEGACY_MIGRATION_ABORT_UNSAFE" });
    assert.deepEqual(fs.readFileSync(path.join(input.anchorDir, executor.PENDING_FILE)), pending);
  });
}

test("R6 F3 an uncertain admission holder is never stolen by initialize or migration", supported, t => {
  const input = isolatedMigration(t), emptyAnchor = path.join(path.dirname(input.anchorDir), "guarded-anchor");
  const newDb = path.join(path.dirname(input.anchorDir), "new-db");
  fs.mkdirSync(emptyAnchor); fs.mkdirSync(newDb);
  fs.mkdirSync(path.join(emptyAnchor, "protected-migration-admission.lock"));
  assert.throws(() => ProtectedPermitStore.initialize(path.join(newDb, "state.sqlite"), {
    decisionId: "D-guarded", anchorDir: emptyAnchor, anchorMode: "permissive", clock: () => 1000,
  }), { code: "ERR_LEGACY_MIGRATION_BUSY" });
  fs.mkdirSync(path.join(input.anchorDir, "protected-migration-admission.lock"));
  assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_BUSY" });
  assert.equal(fs.existsSync(path.join(input.anchorDir, executor.PENDING_FILE)), false);
  assert.equal(bootstrap.bootstrapState(emptyAnchor).pending.length, 0);
});

test("R6 F4 historical unstarted registration without a coordination file can exit safely", supported, t => {
  const input = isolatedMigration(t);
  assert.equal(fs.existsSync(path.join(input.anchorDir, coordination.FILE)), false);
  fs.writeFileSync(path.join(input.anchorDir, executor.PENDING_FILE), JSON.stringify(obsoletePlan(input)) + "\n");
  repairAdmission.withMigrationAdmission(input.anchorDir, () => {
    assert.throws(() => repairAdmission.abortUnstartedLegacyMigration(input, abortAudit), { code: "ERR_LEGACY_MIGRATION_BUSY" });
    assert.equal(fs.existsSync(path.join(input.anchorDir, coordination.FILE)), false);
  });
  const result = repairAdmission.abortUnstartedLegacyMigration(input, abortAudit);
  assert.equal(result.aborted, true);
  assert.equal(JSON.parse(fs.readFileSync(result.auditFile)).outcome, "not-attempted");
  coordination.assertLockInitialized(input.anchorDir);
  assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
  openFixture(input).close();
});
