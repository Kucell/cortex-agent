"use strict";

// Contract tests for the automatic legacy repair. The repair is what makes
// an upgrade from 1.15.7 work without manual intervention, so it has to be
// automatic AND safe: it only runs when the deployment declares it, and it
// proves that the old writer loses its authority.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const core = require("../../lib/coordination/permit-legacy-migration-core");
const autoMigrate = require("../../lib/coordination/permit-legacy-auto-migrate");
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

let rawV1, oldReaderSource, runtime;

test.before(() => {
  if (supported.skip) return;
  oldReaderSource = fs.readFileSync(path.join(__dirname, "fixtures/protected-permit-store-v1-source.txt"), "utf8");
  assert.equal(hash(oldReaderSource), core.FROZEN_SOURCE_SHA256);
  rawV1 = compile(oldReaderSource);
  runtime = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
  fs.mkdirSync(runtime, { recursive: true });
});

// A drained schema-1 store, which is the only shape the migration core
// accepts.
function legacyStore(t, anchorMode = "permissive") {
  const dir = fs.mkdtempSync(path.join(runtime, "permit-auto-migrate-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  const file = path.join(dbDir, "state.sqlite");
  let now = 1000;
  const old = rawV1.ProtectedPermitStore.initialize(file, { decisionId: "D-frozen", anchorDir,
    anchorMode, clock: () => now, verifyRecovery: () => true });
  const lease = old.acquire({ owner: "fixture", sessionId: "s1", hostId: "h", workerId: "w", runId: "r",
    generation: "g", desktopKey: "desktop-1", ownedAppId: "a", idempotencyKey: "lease-1", ttlMs: 100 });
  const permit = old.reserve({ ...lease, idempotencyKey: "permit-1", operation: "invoke",
    targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 50 });
  now = permit.deadline;
  old.consume(permit);
  old.finish({ ...permit, outcome: "finished" });
  old.release(lease);
  old.recover({ fixture: "drained" });
  old.close();
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, anchorDir };
}

test("a legacy store is detected as needing the repair", supported, t => {
  const f = legacyStore(t);
  assert.equal(autoMigrate.needsLegacyRepair(f.file), true);
  assert.equal(autoMigrate.readUserVersion(f.file), 1);
});

test("a store that is not legacy is not detected as needing the repair", supported, t => {
  const f = legacyStore(t);
  const otherAnchor = path.join(f.dir, "other-anchor");
  fs.mkdirSync(otherAnchor, { mode: 0o700 });
  const otherDb = path.join(f.dir, "other-db");
  fs.mkdirSync(otherDb);
  const otherFile = path.join(otherDb, "other.sqlite");
  const store = ProtectedPermitStore.initialize(otherFile, {
    decisionId: "D-other", anchorDir: otherAnchor, anchorMode: "permissive", clock: () => 1000 });
  store.close();
  assert.equal(autoMigrate.needsLegacyRepair(otherFile), false);
});

test("a repair that is not declared does not touch the store", supported, t => {
  const f = legacyStore(t);
  const report = autoMigrate.autoRepairLegacyStore({ filePath: f.file, anchorDir: f.anchorDir,
    oldReaderSource, audit: { by: "fixture", reason: "contract test" } });
  assert.equal(report.repaired, false);
  assert.equal(report.reason, "auto-repair-not-declared");
  assert.equal(autoMigrate.readUserVersion(f.file), 1);
});

test("a repair without the frozen old reader is refused", supported, t => {
  const f = legacyStore(t);
  const report = autoMigrate.autoRepairLegacyStore({ filePath: f.file, anchorDir: f.anchorDir,
    autoRepair: true, audit: { by: "fixture", reason: "contract test" } });
  assert.equal(report.repaired, false);
  assert.equal(report.reason, "old-reader-source-missing");
  assert.equal(autoMigrate.readUserVersion(f.file), 1);
});

test("a declared repair migrates the store and fences the old writer", supported, t => {
  const f = legacyStore(t);
  const report = autoMigrate.autoRepairLegacyStore({ filePath: f.file, anchorDir: f.anchorDir,
    autoRepair: true, oldReaderSource, audit: { by: "fixture", reason: "contract test" } });
  assert.equal(report.repaired, true);
  assert.equal(report.oldWriterFenced, true);
  assert.equal(report.sourceUserVersion, 1);
  assert.equal(report.targetUserVersion, 2);
  assert.equal(autoMigrate.readUserVersion(f.file), 2);
  // The old writer cannot open the repaired store.
  assert.throws(() => rawV1.ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-frozen",
    minimumEpoch: 1, anchorDir: f.anchorDir, anchorMode: "permissive", clock: () => 2000, verifyRecovery: () => true }),
  { code: "ERR_STATE_INVALID" });
  // The current reader can.
  const store = ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
    anchorDir: f.anchorDir, anchorMode: "permissive", clock: () => 2000 });
  assert.equal(store.snapshot().schema_version, 2);
  store.close();
});

test("a repair of a store that does not need it does nothing", supported, t => {
  const f = legacyStore(t);
  autoMigrate.autoRepairLegacyStore({ filePath: f.file, anchorDir: f.anchorDir,
    autoRepair: true, oldReaderSource, audit: { by: "fixture", reason: "contract test" } });
  const second = autoMigrate.autoRepairLegacyStore({ filePath: f.file, anchorDir: f.anchorDir,
    autoRepair: true, oldReaderSource, audit: { by: "fixture", reason: "contract test" } });
  assert.equal(second.repaired, false);
  assert.equal(second.reason, "not-a-legacy-store");
});

const executor = require("../../lib/coordination/permit-legacy-migration-executor");
const anchor = require("../../lib/coordination/protected-anchor");
const coordination = require("../../lib/coordination/protected-store-lock");
const { openWithLegacyRepair } = require("../../lib/coordination/permit-store-open-with-repair");
const { createPermitWitnessHost } = require("../../lib/coordination/permit-witness-host");
function migrationInput(f) {
  return { filePath: f.file, anchorDir: f.anchorDir, evidence: autoMigrate.collectEvidence(f.file, f.anchorDir),
    oldReaderSource, audit: { by: "fixture", reason: "security regression" } };
}
function readRow(file) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { ...db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get(),
    user_version: db.prepare("PRAGMA user_version").get().user_version }; }
  finally { db.close(); }
}
function repairOptions(f, extra = {}) {
  return { filePath: f.file, anchorDir: f.anchorDir, autoRepair: true, oldReaderSource,
    expectedDecisionId: "D-frozen", minimumEpoch: 1, audit: { by: "fixture", reason: "open regression" }, ...extra };
}

test("legacy writer commit before lock entry is rejected without overwrite", supported, t => {
  const f = legacyStore(t), input = migrationInput(f);
  const original = coordination.withLock;
  let changed;
  t.mock.method(coordination, "withLock", (dir, action, options) => original(dir, identity => {
    if (!options?.create) {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(f.file);
      try {
        const state = JSON.parse(input.evidence.source.body); state.last_clock_ms++;
        const body = JSON.stringify(state); changed = { body, sha256: hash(body), user_version: 1 };
        db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(body, changed.sha256);
      } finally { db.close(); }
    }
    return action(identity);
  }, options));
  // The intervening writer may also remove the preflight sidecars on close;
  // that changed path binding now refuses before SQLite can read the new row.
  assert.throws(() => executor.migrateLegacyPermitStore(input), error =>
    ["ERR_LEGACY_MIGRATION_SOURCE_MISMATCH", "ERR_STATE_MISSING_OR_UNSAFE"].includes(error.code));
  assert.deepEqual(readRow(f.file), changed);
});

for (const field of ["body", "sha256", "user_version", "missing-row"]) {
  test(`CAS rejects ${field} changed after transaction evidence check`, supported, t => {
    const f = legacyStore(t), input = migrationInput(f), before = readRow(f.file);
    const { DatabaseSync } = require("node:sqlite");
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function(sql) {
      if (sql.startsWith("UPDATE protected_state SET body=?, sha256=? WHERE id=1 AND")) {
        if (field === "body") prepare.call(this, "UPDATE protected_state SET body=body || ' ' WHERE id=1").run();
        if (field === "sha256") prepare.call(this, "UPDATE protected_state SET sha256=? WHERE id=1").run("0".repeat(64));
        if (field === "user_version") this.exec("PRAGMA user_version=9");
        if (field === "missing-row") this.exec("DELETE FROM protected_state WHERE id=1");
      }
      return prepare.call(this, sql);
    });
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_SOURCE_MISMATCH" });
    assert.deepEqual(readRow(f.file), before, "transaction mutation must roll back");
    assert.equal(anchor.readJournal(anchor.journalFileFor(f.anchorDir)).committed, input.evidence.expected.anchor_sequence);
  });
}

for (const variant of ["empty", "lagging", "different-content", "high-water-empty", "high-water-different", "audit-different"]) {
  test(`live ${variant} evidence is rejected inside the transaction`, supported, t => {
    const f = legacyStore(t), input = migrationInput(f), before = readRow(f.file);
    const entries = fs.readdirSync(f.anchorDir).filter(n => n.startsWith("protected-anchor-entry-"));
    if (variant === "empty") for (const name of entries) fs.unlinkSync(path.join(f.anchorDir, name));
    if (variant === "lagging") for (const name of entries) {
      const entry = JSON.parse(fs.readFileSync(path.join(f.anchorDir, name), "utf8"));
      if (entry.sequence === input.evidence.expected.anchor_sequence) fs.unlinkSync(path.join(f.anchorDir, name));
    }
    if (variant === "different-content") {
      const entryFile = path.join(f.anchorDir, entries[0]);
      const e = JSON.parse(fs.readFileSync(entryFile, "utf8"));
      e.body_digest = "f".repeat(64);
      e.entry_digest = hash([e.schema_version, e.type, e.sequence, e.body_digest, e.store_id, e.attempt].join("\n"));
      fs.writeFileSync(entryFile, JSON.stringify(e) + "\n");
    }
    if (variant === "high-water-empty") fs.writeFileSync(path.join(f.anchorDir, anchor.HIGH_WATER_FILE), "");
    if (variant === "high-water-different") {
      const records = input.evidence.high_water.map(e => ({ ...e })); records[0].body_digest = "f".repeat(64);
      fs.writeFileSync(path.join(f.anchorDir, anchor.HIGH_WATER_FILE), records.map(JSON.stringify).join("\n") + "\n");
    }
    if (variant === "audit-different") {
      const records = input.evidence.audit.map(e => ({ ...e })); records[0].at = "2026-01-01T00:00:00.000Z";
      fs.writeFileSync(path.join(f.anchorDir, "protected-anchor-audit.log"), records.map(JSON.stringify).join("\n") + "\n");
    }
    assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_SOURCE_MISMATCH" });
    assert.deepEqual(readRow(f.file), before);
  });
}

test("pending publication failure leaves DB and journal untouched and the common lock initialized", supported, t => {
  const f = legacyStore(t), input = migrationInput(f), before = fs.readFileSync(f.file);
  const entries = fs.readdirSync(f.anchorDir).sort(), link = fs.linkSync;
  t.mock.method(fs, "linkSync", (from, to) => {
    if (path.basename(to) === executor.PENDING_FILE) throw Object.assign(new Error("publication denied"), { code: "EACCES" });
    return link(from, to);
  });
  assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PENDING_IO" });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), [...entries, coordination.FILE].sort());
  coordination.assertLockInitialized(f.anchorDir);
});

test("pending directory barrier failure leaves DB untouched", supported, t => {
  const f = legacyStore(t), input = migrationInput(f), before = fs.readFileSync(f.file);
  const sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", fd => {
    if (fs.fstatSync(fd).isDirectory() && fs.existsSync(path.join(f.anchorDir, executor.PENDING_FILE))) {
      throw Object.assign(new Error("sync failed"), { code: "EIO" });
    }
    return sync(fd);
  });
  assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_PENDING_IO" });
  assert.deepEqual(fs.readFileSync(f.file), before);
  coordination.assertLockInitialized(f.anchorDir);
});

for (const boundary of ["intent", "commit", "high-water"]) {
  test(`interruption at ${boundary} resumes only the immutable original plan`, supported, t => {
    const f = legacyStore(t), input = migrationInput(f), source = readRow(f.file);
    const entry = anchor.appendEntry, rename = fs.renameSync;
    const failure = Object.assign(new Error("injected crash"), { code: "INJECTED_CRASH" });
    if (boundary === "high-water") t.mock.method(fs, "renameSync", (from, to) => {
      if (to === path.join(f.anchorDir, anchor.HIGH_WATER_FILE)) throw failure;
      return rename(from, to);
    });
    else t.mock.method(anchor, "appendEntry", (...args) => {
      if (args[1].type === boundary) {
        if (boundary === "intent") entry(...args); // crash after intent, before DB update
        throw failure;
      }
      return entry(...args);
    });
    assert.throws(() => executor.migrateLegacyPermitStore(input), failure);
    const journal = anchor.readJournal(anchor.journalFileFor(f.anchorDir));
    const targetSeq = input.evidence.expected.anchor_sequence + 1;
    assert.ok(journal.entries.some(e => e.type === "intent" && e.sequence === targetSeq));
    if (boundary === "intent") assert.deepEqual(readRow(f.file), source);
    else assert.equal(readRow(f.file).user_version, 2);
    assert.equal(executor.migrationIsComplete(f.anchorDir), false);
    assert.throws(() => openWithLegacyRepair(() => assert.fail("must not open"), repairOptions(f)),
      { code: "ERR_LEGACY_REPAIR_PENDING" });
    t.mock.restoreAll();
    assert.throws(() => executor.migrateLegacyPermitStore({ ...input, audit: { ...input.audit, reason: "different plan" } }),
      { code: "ERR_LEGACY_MIGRATION_PLAN_MISMATCH" });
    const result = executor.migrateLegacyPermitStore(input);
    assert.equal(result.migrated, true);
    assert.equal(executor.migrationIsComplete(f.anchorDir), true);
    assert.equal(anchor.readJournal(anchor.journalFileFor(f.anchorDir)).committed, targetSeq);
    assert.equal(anchor.readHighWater(f.anchorDir).mark, targetSeq);
    const waterBytes = fs.readFileSync(path.join(f.anchorDir, anchor.HIGH_WATER_FILE));
    executor.migrateLegacyPermitStore(input);
    assert.deepEqual(fs.readFileSync(path.join(f.anchorDir, anchor.HIGH_WATER_FILE)), waterBytes, "no duplicate declaration on replay");
    assert.equal(openWithLegacyRepair(() => "opened", repairOptions(f)).store, "opened");
  });
}

test("frozen source digest mismatch and comment spoof both reject without DB writes", supported, t => {
  const f = legacyStore(t), input = migrationInput(f), before = fs.readFileSync(f.file);
  for (const source of [oldReaderSource + "\n", "// user_version !== SCHEMA_VERSION ERR_STATE_INVALID\nconst SCHEMA_VERSION = 1;"] ) {
    assert.equal(executor.oldWriterFenceFromSource(source).fenced, false);
    assert.throws(() => executor.migrateLegacyPermitStore({ ...input, oldReaderSource: source }),
      { code: "ERR_LEGACY_MIGRATION_OLD_WRITER_NOT_FENCED" });
  }
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(path.join(f.anchorDir, executor.PENDING_FILE)), false);
});

for (const variant of ["authority", "null-authority", "decision", "missing-decision", "schema"]) {
  test(`open preflight rejects ${variant} before any repair or open`, supported, t => {
    const f = legacyStore(t), before = fs.readFileSync(f.file), entries = fs.readdirSync(f.anchorDir).sort();
    const extra = variant === "authority" ? { witnessAuthority: { mode: "development-only", authorityId: "a" } }
      : variant === "null-authority" ? { witnessAuthority: null }
      : variant === "decision" ? { expectedDecisionId: "wrong" }
      : variant === "missing-decision" ? { expectedDecisionId: undefined } : { targetUserVersion: 3 };
    const code = ["authority", "null-authority", "schema"].includes(variant) ? "ERR_LEGACY_REPAIR_TARGET_INCOMPATIBLE"
      : variant === "decision" ? "ERR_DECISION_MISMATCH" : "ERR_INVALID_INPUT";
    assert.throws(() => openWithLegacyRepair(() => assert.fail("must not open"), repairOptions(f, extra)),
      error => error.code === code && error.legacyRepair.status === "blocked");
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), entries);
  });
}

test("development witness host cannot migrate schema1 to an ordinary schema2 store", supported, t => {
  const f = legacyStore(t), before = fs.readFileSync(f.file), entries = fs.readdirSync(f.anchorDir).sort();
  assert.throws(() => createPermitWitnessHost({ backend: "development-witness", mode: "development-only", access: "open",
    file: f.file, authorityId: "authority", clock: () => 2000,
    storeOptions: { decisionId: "D-frozen", minimumEpoch: 1, anchorDir: f.anchorDir, anchorMode: "permissive" },
    providers: { observeTarget() {}, signPermit() {}, pullRevocation() {} },
    legacyRepair: { oldReaderSource, audit: { by: "fixture", reason: "authority rejection" } } }),
  { code: "ERR_LEGACY_REPAIR_TARGET_INCOMPATIBLE" });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), entries);
});

test("repair error preserves unknown outcome and is never masked by open error", supported, t => {
  const f = legacyStore(t), failure = Object.assign(new Error("specific repair failure"), { code: "INJECTED_FAILURE" });
  t.mock.method(executor, "migrateLegacyPermitStore", () => { throw failure; });
  assert.throws(() => openWithLegacyRepair(() => assert.fail("must not open"), repairOptions(f)),
    error => error === failure && error.legacyRepair.status === "unknown" && error.legacyRepair.code === "INJECTED_FAILURE");
  assert.equal(autoMigrate.readUserVersion(f.file), 1);
});

test("refused repair report blocks opening and retains original reason", supported, t => {
  const f = legacyStore(t);
  assert.throws(() => openWithLegacyRepair(() => assert.fail("must not open"), repairOptions(f, { oldReaderSource: undefined })),
    error => error.code === "ERR_LEGACY_REPAIR_BLOCKED" && error.legacyRepair.status === "blocked" &&
      error.legacyRepair.reason === "old-reader-source-missing");
});

test("eligible ordinary open repairs once and can reopen with its completion receipt", supported, t => {
  const f = legacyStore(t);
  const open = () => ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
    anchorDir: f.anchorDir, anchorMode: "permissive", clock: () => 2000 });
  const first = openWithLegacyRepair(open, repairOptions(f));
  assert.equal(first.repair.repaired, true); first.store.close();
  const second = openWithLegacyRepair(open, repairOptions(f));
  assert.equal(second.store.snapshot().schema_version, 2); second.store.close();
});

for (const targetLive of [false, true]) {
  test(`a new pending plan cannot adopt preexisting target intent (target DB=${targetLive})`, supported, t => {
    const f = legacyStore(t), input = migrationInput(f);
    const prepared = core.prepareLegacyPermitMigration(JSON.stringify(input.evidence));
    anchor.appendEntry(anchor.journalFileFor(f.anchorDir), prepared.append.intent);
    if (targetLive) {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(f.file);
      try {
        db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(prepared.target.body, prepared.target.sha256);
        db.exec("PRAGMA user_version=2");
      } finally { db.close(); }
    }
    const before = readRow(f.file);
    for (let n = 0; n < 2; n++) {
      assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_LEGACY_MIGRATION_SOURCE_MISMATCH" });
      assert.deepEqual(readRow(f.file), before);
    }
    assert.equal(anchor.readJournal(anchor.journalFileFor(f.anchorDir)).committed, input.evidence.expected.anchor_sequence);
  });
}

test("preflight source is bound to evidence if a legacy writer changes Decision before collection", supported, t => {
  const f = legacyStore(t);
  const collect = autoMigrate.collectEvidence;
  let changed;
  t.mock.method(autoMigrate, "collectEvidence", (...args) => {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(f.file);
    try {
      const state = JSON.parse(readRow(f.file).body); state.decision_id = "other-decision";
      const body = JSON.stringify(state); changed = { body, sha256: hash(body), user_version: 1 };
      db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(body, changed.sha256);
      // Coherent legacy evidence after the concurrent change: the final pair,
      // declaration and audit agree, so only the preflight binding rejects it.
      const seq = state.anchor_sequence;
      for (const name of fs.readdirSync(f.anchorDir).filter(n => n.startsWith("protected-anchor-entry-"))) {
        const full = path.join(f.anchorDir, name), entry = JSON.parse(fs.readFileSync(full, "utf8"));
        if (entry.sequence === seq) {
          entry.body_digest = changed.sha256;
          entry.entry_digest = hash([entry.schema_version, entry.type, entry.sequence, entry.body_digest, entry.store_id, entry.attempt].join("\n"));
          fs.writeFileSync(full, JSON.stringify(entry) + "\n");
        }
      }
      for (const name of [anchor.HIGH_WATER_FILE, "protected-anchor-audit.log"]) {
        const full = path.join(f.anchorDir, name);
        const records = fs.readFileSync(full, "utf8").trim().split("\n").map(JSON.parse);
        for (const entry of records) if (entry.sequence === seq) {
          entry.body_digest = changed.sha256;
          if (name === anchor.HIGH_WATER_FILE) entry.record_digest = hash([entry.sequence, entry.body_digest, entry.store_id, entry.attempt].join("\n"));
        }
        fs.writeFileSync(full, records.map(JSON.stringify).join("\n") + "\n");
      }
    } finally { db.close(); }
    const evidence = collect(...args);
    assert.equal(core.prepareLegacyPermitMigration(JSON.stringify(evidence)).status, "prepared-only");
    return evidence;
  });
  assert.throws(() => openWithLegacyRepair(() => assert.fail("must not open"), repairOptions(f)),
    { code: "ERR_LEGACY_MIGRATION_SOURCE_MISMATCH" });
  assert.deepEqual(readRow(f.file), changed);
  assert.equal(fs.existsSync(path.join(f.anchorDir, executor.PENDING_FILE)), false);
});

for (const minimumEpoch of [0, NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, true, 1n]) {
  test(`R3 rejects minimumEpoch=${String(minimumEpoch)} (${typeof minimumEpoch}) before migration discovery`, supported, t => {
    const f = legacyStore(t), before = fs.readFileSync(f.file), entries = fs.readdirSync(f.anchorDir).sort();
    const options = repairOptions(f, { minimumEpoch });
    // Bind the duplicated predicate to the real store entry contract.
    assert.throws(() => ProtectedPermitStore.open(f.file, options), { code: "ERR_INVALID_INPUT" });
    t.mock.method(autoMigrate, "needsLegacyRepair", () => assert.fail("must not discover repair"));
    t.mock.method(autoMigrate, "collectEvidence", () => assert.fail("must not collect evidence"));
    t.mock.method(executor, "migrateLegacyPermitStore", () => assert.fail("must not migrate"));
    assert.throws(() => openWithLegacyRepair(() => assert.fail("must not open"), options),
      error => error.code === "ERR_INVALID_INPUT" && error.legacyRepair.repaired === false &&
        error.legacyRepair.status === "blocked" && error.legacyRepair.reason === "invalid-minimum-epoch");
    assert.equal(autoMigrate.readUserVersion(f.file), 1);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), entries, "no plan, lock or receipt may be registered");
  });
}

test("R3 validates anchor mode before any migration discovery", supported, t => {
  const f = legacyStore(t), entries = fs.readdirSync(f.anchorDir).sort();
  t.mock.method(autoMigrate, "needsLegacyRepair", () => assert.fail("must not discover repair"));
  assert.throws(() => openWithLegacyRepair(() => assert.fail("must not open"), repairOptions(f, { anchorMode: "typo" })),
    error => error.code === "ERR_ANCHOR_MODE_INVALID" && error.legacyRepair.status === "blocked");
  assert.equal(autoMigrate.readUserVersion(f.file), 1);
  assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), entries);
});

test("R3 a completed repair followed by a rejected open is explicit and not retryable", supported, t => {
  const f = legacyStore(t);
  const options = repairOptions(f, { anchorMode: "permissive", clock: () => NaN });
  assert.throws(() => openWithLegacyRepair(() => ProtectedPermitStore.open(f.file, options), options),
    error => error.code === "ERR_CLOCK_ROLLBACK" && error.legacyRepair.repaired === true && error.legacyRepair.migrated === true &&
      error.legacyRepair.status === "repaired-open-rejected" && error.legacyRepair.reason === "open-rejected-after-repair" &&
      error.legacyRepair.code === "ERR_CLOCK_ROLLBACK" && error.legacyRepair.retryAllowed === false);
  assert.equal(autoMigrate.readUserVersion(f.file), 2);
  assert.equal(executor.migrationIsComplete(f.anchorDir), true);
});

// Count the actual native constructor, rather than replacing it with a refusal:
// a regression must expose SQLite's side effects as well as the early-open bug.
function observeDatabaseOpens(t, file) {
  const sqlite = require("node:sqlite"), DatabaseSync = sqlite.DatabaseSync;
  let opens = 0;
  t.mock.method(sqlite, "DatabaseSync", class extends DatabaseSync {
    constructor(filename, options) {
      if (path.resolve(filename) === path.resolve(file)) opens++;
      super(filename, options);
    }
  });
  return () => opens;
}

for (const mode of ["permissive", "strict"]) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    test(`R6 F1 ${mode} migration and pending open reject hardlinked ${suffix} before SQLite`, supported, t => {
      const f = legacyStore(t, mode), input = migrationInput(f);
      const database = fs.readFileSync(f.file), sidecar = f.file + suffix;
      const victim = path.join(f.dir, "victim"), bytes = Buffer.alloc(65536, 0x5a);
      fs.writeFileSync(victim, bytes);
      fs.rmSync(sidecar, { force: true });
      fs.linkSync(victim, sidecar);
      const names = fs.readdirSync(f.anchorDir).sort();
      const opens = observeDatabaseOpens(t, f.file);
      assert.throws(() => executor.migrateLegacyPermitStore(input), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
      assert.equal(opens(), 0, "migration must refuse before native SQLite construction");
      assert.deepEqual(fs.readFileSync(victim), bytes);
      assert.deepEqual(fs.readFileSync(f.file), database);
      assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), names);
      assert.equal(executor.migrationIsComplete(f.anchorDir), false);
      assert.equal(fs.existsSync(path.join(f.anchorDir, "protected-legacy-migration-complete.json")), false);
      // A pending plan must not defer path rejection until after discovery.
      fs.writeFileSync(path.join(f.anchorDir, executor.PENDING_FILE), "{}\n");
      assert.throws(() => ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
        anchorDir: f.anchorDir, anchorMode: mode, clock: () => 2000 }), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
      assert.equal(opens(), 0, "pending open must refuse before even read-only discovery");
      assert.deepEqual(fs.readFileSync(victim), bytes);
      assert.deepEqual(fs.readFileSync(f.file), database);
      assert.equal(fs.existsSync(path.join(f.anchorDir, "protected-legacy-migration-complete.json")), false);
    });
  }

  test(`R6 F2 ${mode} migration and open reject alias -> anchor in a database ancestor`, supported, t => {
    const f = legacyStore(t, mode), input = migrationInput(f), before = fs.readFileSync(f.file);
    const nested = path.join(f.anchorDir, "nested-db");
    fs.mkdirSync(nested);
    const physical = path.join(nested, "state.sqlite");
    fs.renameSync(f.file, physical);
    const alias = path.join(f.dir, "alias");
    fs.symlinkSync("anchor", alias, "dir");
    const file = path.join(alias, "nested-db", "state.sqlite");
    assert.equal(fs.lstatSync(path.dirname(file)).isDirectory(), true);
    assert.equal(fs.lstatSync(file).isFile(), true);
    assert.equal(fs.realpathSync(file), physical);
    const names = fs.readdirSync(f.anchorDir).sort(), opens = observeDatabaseOpens(t, file);
    assert.throws(() => executor.migrateLegacyPermitStore({ ...input, filePath: file }), { code: "ERR_ANCHOR_NOT_SEPARATE" });
    assert.throws(() => ProtectedPermitStore.open(file, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
      anchorDir: f.anchorDir, anchorMode: mode, clock: () => 2000 }), { code: "ERR_ANCHOR_NOT_SEPARATE" });
    assert.equal(opens(), 0);
    assert.deepEqual(fs.readFileSync(physical), before);
    assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), names);
    assert.equal(executor.migrationIsComplete(f.anchorDir), false);
    assert.equal(fs.existsSync(path.join(f.anchorDir, "protected-legacy-migration-complete.json")), false);
  });

  test(`R6 ${mode} ordinary files and separate real domains still migrate and open`, supported, t => {
    const f = legacyStore(t, mode), input = migrationInput(f);
    // These are ordinary, singly linked SQLite-owned files, not aliases.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      fs.rmSync(f.file + suffix, { force: true });
      fs.writeFileSync(f.file + suffix, Buffer.alloc(0));
    }
    assert.equal(executor.migrateLegacyPermitStore(input).migrated, true);
    assert.equal(executor.migrationIsComplete(f.anchorDir), true);
    const store = ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-frozen", minimumEpoch: 1,
      anchorDir: f.anchorDir, anchorMode: mode, clock: () => 2000 });
    try { assert.equal(store.snapshot().schema_version, 2); }
    finally { store.close(); }
  });
}
