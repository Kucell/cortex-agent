"use strict";

// Applies only prepared schema-1 -> schema-2 bytes. The coordination lock
// excludes current writers; BEGIN IMMEDIATE and CAS protect against old writers
// that do NOT participate in that lock. An immutable plan precedes all writes.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const core = require("./permit-legacy-migration-core");
const anchorModule = require("./protected-anchor");
const coordination = require("./protected-store-lock");
const PENDING_FILE = "protected-legacy-migration-pending.json";
const COMPLETE_FILE = "protected-legacy-migration-complete.json";
const STARTED_FILE = "protected-legacy-migration-started.json";
const PUBLICATION_FILE = "protected-legacy-migration-publication.json";
const PUBLICATION_TARGETS = { water: anchorModule.HIGH_WATER_FILE, recovery: "protected-anchor-recovery.log" };
const FROZEN_SOURCE_SHA256 = "26e20acab1dd50396c55b404b39b2340035c95c8835eaa425e13b07cc36b772a";

class LegacyMigrationExecutorError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "LegacyMigrationExecutorError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
function fail(code, details) { throw new LegacyMigrationExecutorError(code, details); }
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
const equal = (a, b) => canonical(a) === canonical(b);

// Execute ONLY the hash-pinned fixture, with inert FS/SQLite/anchor doubles.
// Prove the actual constant is 1 and open() rejects 2 but passes the version
// gate for 1. No fixture file is required in the installed runtime package.
function oldWriterFenceFromSource(sourceText) {
  if (typeof sourceText !== "string" || !sourceText) fail("ERR_LEGACY_MIGRATION_INPUT");
  const trusted = digest(sourceText) === FROZEN_SOURCE_SHA256;
  let compares = false, refuses = false;
  if (trusted) {
    let version = 2;
    const passed = {};
    const db = { exec() {}, close() {}, prepare(sql) {
      return { get: () => sql === "PRAGMA integrity_check" ? { integrity_check: "ok" } : { user_version: version } };
    } };
    const sandbox = { module: { exports: {} }, process: { versions: { node: "24.0.0" } }, require(name) {
      if (name === "node:crypto") return crypto;
      if (name === "node:path") return path;
      if (name === "node:fs") return { lstatSync: () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false }) };
      if (name === "node:sqlite") return { DatabaseSync: class { constructor() { return db; } } };
      if (name === "./protected-scope") return {};
      if (name === "./protected-anchor") return { anchorDirFor: x => x, assertSeparateDomains() {}, journalFileFor: x => x,
        readJournal() { throw passed; } };
      throw new Error("unexpected frozen reader dependency");
    } };
    try {
      vm.runInNewContext(sourceText + "\nmodule.exports.frozenSchemaVersion = SCHEMA_VERSION;", sandbox, { timeout: 1000 });
      const old = sandbox.module.exports;
      if (old.frozenSchemaVersion === 1) {
        const open = () => old.ProtectedPermitStore.open("fixture.sqlite", { expectedDecisionId: "fixture", minimumEpoch: 1, anchorDir: "anchor" });
        try { open(); } catch (error) { refuses = error.code === "ERR_STATE_INVALID"; }
        version = 1;
        try { open(); } catch (error) { compares = error === passed; }
      }
    } catch { /* fail closed on any unverified constant or execution path */ }
  }
  return Object.freeze({ mentions: trusted, compares, refuses, fenced: trusted && compares && refuses });
}

function syncDirectory(dir) {
  if (!["darwin", "linux"].includes(process.platform)) fail("ERR_LEGACY_MIGRATION_PENDING_IO");
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readPlan(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) fail("ERR_LEGACY_MIGRATION_PLAN_MISMATCH");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
// fsync the complete bytes, then publish with an exclusive hard link. Never
// overwrite a prior plan, including after an uncertain publication barrier.
function registerPlan(dir, plan, name = PENDING_FILE) {
  const target = path.join(dir, name);
  const temp = target + ".tmp-" + process.pid + "-" + crypto.randomBytes(12).toString("hex");
  let owned = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    owned = true;
    try { fs.writeFileSync(fd, JSON.stringify(plan) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, target); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!equal(readPlan(target), plan)) fail("ERR_LEGACY_MIGRATION_PLAN_MISMATCH");
      const existing = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(existing); } finally { fs.closeSync(existing); }
    }
    syncDirectory(dir);
    fs.unlinkSync(temp); owned = false;
    syncDirectory(dir);
  } catch (error) {
    if (error instanceof LegacyMigrationExecutorError) throw error;
    fail("ERR_LEGACY_MIGRATION_PENDING_IO", { cause: error.code || error.message });
  } finally {
    if (owned) { try { fs.unlinkSync(temp); } catch { /* retain failed publication evidence */ } }
  }
}
function readLines(dir, name) {
  const file = path.join(dir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim());
  try { return lines.map(JSON.parse); }
  catch { fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH"); }
}

// Bind both snapshots to the original plan BEFORE writing any snapshot data.
// Only a prefix in the bound temporary inode is resumable; public corruption
// and replaced/missing temporary objects remain evidence, never repair input.
function readObject(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
    const bytes = fs.readFileSync(fd), after = fs.lstatSync(file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
    return { object: `${stat.dev}:${stat.ino}`, hex: bytes.toString("hex") };
  } finally { fs.closeSync(fd); }
}
function logRecords(hex) {
  const bytes = Buffer.from(hex, "hex"), text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text)) || !text.endsWith("\n")) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
  try { return text.split("\n").filter(line => line.trim()).map(JSON.parse); }
  catch { fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN"); }
}
function inspectPublication(dir, publication) {
  const temporary = readObject(path.join(dir, publication.temporary));
  const target = readObject(path.join(dir, publication.target));
  const published = target?.object === publication.object && target.hex === publication.hex;
  if (published ? temporary !== null : !temporary || temporary.object !== publication.object ||
      !publication.hex.startsWith(temporary.hex) || !equal(target, publication.previous)) {
    fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
  }
  return published;
}
function auditRecordFor(plan, fence, at) {
  const { prepared, audit } = plan;
  return {
    schema_version: 1, at, by: audit.by, reason: audit.reason,
    database: plan.database, migration: "legacy-schema1-to-schema2", old_writer_fenced: true,
    old_writer_fence_evidence: { mentions: fence.mentions, compares: fence.compares, refuses: fence.refuses },
    source_sha256: prepared.source.sha256, target_sha256: prepared.target.sha256,
    target_sequence: prepared.append.intent.sequence, source_evidence_digest: prepared.source_evidence_digest,
  };
}
function readPublications(dir, plan, fence) {
  const object = readObject(path.join(dir, PUBLICATION_FILE));
  if (!object) {
    assertKnownTemporaries(dir, []);
    return null;
  }
  let binding;
  try { binding = JSON.parse(Buffer.from(object.hex, "hex").toString("utf8")); }
  catch { fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN"); }
  if (binding?.format_version !== 1 || binding.plan_sha256 !== digest(canonical(plan)) ||
      typeof binding.audit?.at !== "string" || !Number.isFinite(Date.parse(binding.audit.at)) ||
      !equal(binding.audit, auditRecordFor(plan, fence, binding.audit.at)) ||
      !equal(Object.keys(binding.publications || {}).sort(), Object.keys(PUBLICATION_TARGETS).sort())) {
    fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
  }
  for (const [key, target] of Object.entries(PUBLICATION_TARGETS)) {
    const p = binding.publications?.[key], prefix = target + ".tmp-legacy-migration-";
    const validObject = value => value && /^\d+:\d+$/.test(value.object) &&
      typeof value.hex === "string" && /^(?:[a-f0-9]{2})*$/.test(value.hex);
    if (!p || p.target !== target || typeof p.temporary !== "string" || !p.temporary.startsWith(prefix) ||
        !/^[a-f0-9]{24}$/.test(p.temporary.slice(prefix.length)) || !validObject(p) ||
        (p.previous !== null && !validObject(p.previous))) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
    const suffix = key === "water" ? anchorModule.highWaterPublicationBytes(plan.prepared.append.high_water)
      : Buffer.from(JSON.stringify(binding.audit) + "\n");
    if (p.hex !== (p.previous?.hex || "") + suffix.toString("hex") ||
        (key === "water" && (!p.previous || !equal(logRecords(p.previous.hex), plan.evidence.high_water)))) {
      fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
    }
    if (p.previous) logRecords(p.previous.hex);
    inspectPublication(dir, p);
  }
  assertKnownTemporaries(dir, Object.values(binding.publications).map(p => p.temporary));
  return binding;
}
function assertKnownTemporaries(dir, known) {
  for (const name of fs.readdirSync(dir)) {
    if (Object.values(PUBLICATION_TARGETS).some(target => name.startsWith(target + ".tmp-")) && !known.includes(name)) {
      fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
    }
  }
}
function bindPublications(dir, plan, fence) {
  const binding = { format_version: 1, plan_sha256: digest(canonical(plan)),
    audit: auditRecordFor(plan, fence, new Date().toISOString()), publications: {} };
  try {
    for (const [key, target] of Object.entries(PUBLICATION_TARGETS)) {
      const previous = readObject(path.join(dir, target));
      if (previous) logRecords(previous.hex);
      if (key === "water" && (!previous || !equal(logRecords(previous.hex), plan.evidence.high_water))) {
        fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
      }
      const bytes = key === "water" ? anchorModule.highWaterPublicationBytes(plan.prepared.append.high_water)
        : Buffer.from(JSON.stringify(binding.audit) + "\n");
      const temporary = target + ".tmp-legacy-migration-" + crypto.randomBytes(12).toString("hex");
      const fd = fs.openSync(path.join(dir, temporary), "wx", 0o600);
      try {
        const stat = fs.fstatSync(fd);
        binding.publications[key] = { target, previous, temporary, object: `${stat.dev}:${stat.ino}`,
          hex: (previous?.hex || "") + bytes.toString("hex") };
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    syncDirectory(dir);
    registerPlan(dir, binding, PUBLICATION_FILE);
  } catch (error) {
    // A descriptor may have reached its name before a failed directory fsync.
    // Keep all bound objects in that case so the same plan can retry the barrier.
    if (!readObject(path.join(dir, PUBLICATION_FILE))) {
      for (const p of Object.values(binding.publications)) {
        const current = readObject(path.join(dir, p.temporary));
        if (current?.object === p.object && current.hex === "") fs.unlinkSync(path.join(dir, p.temporary));
      }
    }
    throw error;
  }
  return binding;
}
function publishSnapshot(dir, binding, key) {
  const p = binding.publications[key], published = inspectPublication(dir, p);
  const file = path.join(dir, published ? p.target : p.temporary);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (`${opened.dev}:${opened.ino}` !== p.object || opened.nlink !== 1) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
    if (!published) {
      const expected = Buffer.from(p.hex, "hex"), existing = fs.readFileSync(fd);
      if (!expected.subarray(0, existing.length).equals(existing)) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
      const remainder = expected.subarray(existing.length);
      if (remainder.length && fs.writeSync(fd, remainder, 0, remainder.length, existing.length) !== remainder.length) {
        fail("ERR_LEGACY_MIGRATION_WRITE_INCOMPLETE");
      }
      const written = Buffer.alloc(fs.fstatSync(fd).size);
      if (fs.readSync(fd, written, 0, written.length, 0) !== written.length || !written.equals(expected)) {
        fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
      }
    }
    fs.fsyncSync(fd);
    if (!equal(readPlan(path.join(dir, PUBLICATION_FILE)), binding)) fail("ERR_LEGACY_MIGRATION_PLAN_MISMATCH");
    if (!inspectPublication(dir, p)) {
      if (!equal(readObject(path.join(dir, p.temporary)), { object: p.object, hex: p.hex })) {
        fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
      }
      fs.renameSync(path.join(dir, p.temporary), path.join(dir, p.target));
    }
    if (!inspectPublication(dir, p)) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
    syncDirectory(dir);
  } finally { fs.closeSync(fd); }
}
function matchesState(db, expected) {
  const rows = db.prepare("SELECT id, body, sha256 FROM protected_state").all();
  const row = rows[0];
  return rows.length === 1 && row.id === 1 && db.prepare("PRAGMA user_version").get().user_version === expected.user_version &&
    row.body === expected.body && row.sha256 === expected.sha256 && digest(row.body) === row.sha256;
}
function assertMigrationSchema(db) {
  // The frozen v1 writer creates exactly this table, with no indexes, views
  // or triggers. In particular, an AFTER UPDATE trigger can undo a valid CAS.
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all();
  if (!equal(objects, [{ type: "table", name: "protected_state", tbl_name: "protected_state",
    sql: "CREATE TABLE protected_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, sha256 TEXT NOT NULL)" }])) {
    fail("ERR_LEGACY_MIGRATION_SCHEMA_INVALID");
  }
}
// Exact original evidence plus only the already-published prefix of THIS plan.
// Empty/lagging/different histories, extra attempts and foreign plans all fail.
function inspectProgress(dir, prepared, evidence, targetLive, binding) {
  const journal = anchorModule.readJournal(anchorModule.journalFileFor(dir));
  const sorted = entries => entries.map(canonical).sort();
  const base = evidence.journal;
  let phase = -1;
  for (let n = 0; n <= 2; n++) {
    const extra = [prepared.append.intent, prepared.append.commit].slice(0, n);
    if (equal(sorted(journal.entries), sorted([...base, ...extra]))) phase = n;
  }
  const seq = prepared.append.intent.sequence;
  if (phase < 0 || journal.committed !== (phase === 2 ? seq : seq - 1) ||
      (targetLive ? phase < 1 : phase === 2)) fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
  const water = readLines(dir, anchorModule.HIGH_WATER_FILE);
  const waterDone = equal(water, [...evidence.high_water, prepared.append.high_water]);
  if ((!equal(water, evidence.high_water) && !waterDone) || (waterDone && (!targetLive || phase !== 2)) ||
      !equal(readLines(dir, "protected-anchor-audit.log"), evidence.audit)) fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
  if (waterDone && (!binding || !inspectPublication(dir, binding.publications.water))) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
  if (binding && inspectPublication(dir, binding.publications.recovery) && !waterDone) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
  return { phase, waterDone };
}

function migrateLegacyPermitStore(input) {
  if (!input || typeof input !== "object") fail("ERR_LEGACY_MIGRATION_INPUT");
  const { filePath, anchorDir, evidence, oldReaderSource, audit } = input;
  if (typeof filePath !== "string" || !filePath || typeof anchorDir !== "string" || !anchorDir ||
      !audit || typeof audit.by !== "string" || !audit.by || typeof audit.reason !== "string" || !audit.reason) fail("ERR_LEGACY_MIGRATION_INPUT");
  const encoded = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  const prepared = core.prepareLegacyPermitMigration(encoded);
  if (prepared.status !== "prepared-only" || prepared.executionAuthorized !== false) fail("ERR_LEGACY_MIGRATION_NOT_PREPARED");
  if (input.expectedSource !== undefined && !equal(input.expectedSource, prepared.source)) fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
  const fence = oldWriterFenceFromSource(oldReaderSource);
  if (!fence.fenced) fail("ERR_LEGACY_MIGRATION_OLD_WRITER_NOT_FENCED");
  const original = JSON.parse(encoded);
  const dir = anchorModule.anchorDirFor(anchorDir);
  const domains = anchorModule.assertSeparateDomains(anchorDir, filePath);
  // Share the ordinary open contract, and bind the object before publishing
  // any plan. Recheck that identity under the coordination lock and around
  // SQLite's path-based open before any migration writes.
  const { ProtectedPermitStore } = require("./protected-permit-store");
  const databasePaths = ProtectedPermitStore.assertSafeDatabasePaths(filePath);
  // Once SQLite is open it owns sidecar creation/removal. Keep checking their
  // safety, but only require the exact preflight set before the first open.
  const assertDatabase = (beforeOpen = false) => {
    ProtectedPermitStore.assertSafeDatabasePaths(filePath,
      beforeOpen ? databasePaths : { ...databasePaths, sidecars: undefined });
    anchorModule.assertSeparateDomains(anchorDir, filePath, domains);
  };
  const plan = { format_version: 1, database: path.resolve(filePath), source_evidence_digest: prepared.source_evidence_digest,
    encoded_evidence: encoded, evidence: original, prepared, old_reader_sha256: FROZEN_SOURCE_SHA256, audit: { by: audit.by, reason: audit.reason } };
  const durability = anchorModule.preflightAuthorityDurability(dir);
  // Initialize the lock independently so a failed migration does not leave an
  // unversioned lock that would make forward-only replay impossible.
  if (!fs.existsSync(path.join(dir, coordination.FILE))) {
    require("./permit-store-open-with-repair").withMigrationAdmission(dir, () => {
      if (require("./protected-bootstrap").bootstrapState(dir).pending.length) fail("ERR_BOOTSTRAP_PENDING");
      try { coordination.withLock(dir, () => {}, { create: true }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    });
  }
  return coordination.withLock(dir, () => {
    assertDatabase(true);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    let progress, binding;
    try {
      assertDatabase();
      db.exec("PRAGMA synchronous=FULL");
      db.exec("BEGIN IMMEDIATE");
      assertDatabase();
      const receipt = { format_version: 1, plan_sha256: digest(canonical(plan)) };
      const startedFile = path.join(dir, STARTED_FILE);
      let sourceLive;
      require("./permit-store-open-with-repair").withMigrationAdmission(dir, () => {
        if (require("./protected-bootstrap").bootstrapState(dir).pending.length) fail("ERR_BOOTSTRAP_PENDING");
        if (fs.existsSync(path.join(dir, PENDING_FILE)) && !equal(readPlan(path.join(dir, PENDING_FILE)), plan)) {
          fail("ERR_LEGACY_MIGRATION_PLAN_MISMATCH");
        }
        assertMigrationSchema(db);
        sourceLive = matchesState(db, prepared.source);
        const targetLive = matchesState(db, prepared.target);
        if (!sourceLive && !targetLive) fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
        binding = readPublications(dir, plan, fence);
        progress = inspectProgress(dir, prepared, original, targetLive, binding);
        if (fs.existsSync(startedFile)) {
          if (!equal(readPlan(startedFile), receipt)) fail("ERR_LEGACY_MIGRATION_PLAN_MISMATCH");
        } else if (!sourceLive || progress.phase !== 0 || progress.waterDone) {
          fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
        }
        // Applicability precedes pending under BOTH the common writer lock
        // and BEGIN IMMEDIATE. Bootstrap cannot race this registration either.
        registerPlan(dir, plan);
      });
      // The started receipt proves the original, exact source prefix was
      // verified under BOTH locks before this plan published any intent.
      // Merely registering pending cannot adopt an already-orphaned target.
      if (fs.existsSync(startedFile)) {
        if (!equal(readPlan(startedFile), receipt)) fail("ERR_LEGACY_MIGRATION_PLAN_MISMATCH");
      } else {
        if (!sourceLive || progress.phase !== 0 || progress.waterDone) fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
        registerPlan(dir, receipt, STARTED_FILE);
      }
      if (!binding) {
        if (!sourceLive || progress.phase !== 0 || progress.waterDone) fail("ERR_LEGACY_MIGRATION_PUBLICATION_UNKNOWN");
        binding = bindPublications(dir, plan, fence);
      }
      syncDirectory(dir); // retry any uncertain binding publication barrier
      const journalFile = anchorModule.journalFileFor(dir);
      if (progress.phase === 0) anchorModule.appendEntry(journalFile, prepared.append.intent, durability);
      if (sourceLive) {
        assertDatabase();
        // A legacy writer cannot commit during BEGIN IMMEDIATE. CAS is still
        // mandatory: never silently overwrite bytes that changed after check.
        const changed = db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1 AND body=? AND sha256=? AND (SELECT user_version FROM pragma_user_version)=?")
          .run(prepared.target.body, prepared.target.sha256, prepared.source.body, prepared.source.sha256, prepared.source.user_version);
        if (Number(changed.changes) !== 1 || db.prepare("PRAGMA user_version").get().user_version !== prepared.source.user_version) {
          fail("ERR_LEGACY_MIGRATION_SOURCE_MISMATCH");
        }
        db.exec("PRAGMA user_version=" + prepared.target.user_version);
      }
      // CAS proves only that one source row matched. Re-read ALL target bytes,
      // the digest and the version under the same write transaction, including
      // on replay, before any commit/high-water/completion evidence is emitted.
      assertMigrationSchema(db);
      if (!matchesState(db, prepared.target)) fail("ERR_LEGACY_MIGRATION_TARGET_MISMATCH");
      assertDatabase();
      db.exec("COMMIT");
      assertDatabase();
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* may already be committed */ }
      throw error;
    } finally { db.close(); }
    const journalFile = anchorModule.journalFileFor(dir);
    if (progress.phase < 2) anchorModule.appendEntry(journalFile, prepared.append.commit, durability);
    publishSnapshot(dir, binding, "water");
    publishSnapshot(dir, binding, "recovery");
    assertDatabase();
    registerPlan(dir, { format_version: 1, plan_sha256: digest(canonical(plan)) }, COMPLETE_FILE);
    return Object.freeze({ migrated: true, oldWriterFenced: true, sourceUserVersion: prepared.source.user_version,
      targetUserVersion: prepared.target.user_version, targetSequence: prepared.append.intent.sequence,
      bodySha256: prepared.target.sha256, audit: binding.audit });
  });
}

// A durable receipt permits future ordinary opens even after later legitimate
// transactions. It never permits recollecting evidence from a rolled-back v1 DB.
function migrationIsComplete(anchorDir) {
  try {
    const plan = readPlan(path.join(anchorDir, PENDING_FILE));
    return equal(readPlan(path.join(anchorDir, COMPLETE_FILE)), { format_version: 1, plan_sha256: digest(canonical(plan)) });
  } catch { return false; }
}
function assertNoPendingMigration(anchorDir) {
  try { fs.lstatSync(path.join(anchorDir, PENDING_FILE)); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!migrationIsComplete(anchorDir)) {
    const error = new LegacyMigrationExecutorError("ERR_LEGACY_REPAIR_PENDING");
    error.legacyRepair = Object.freeze({ repaired: false, status: "blocked",
      reason: "original-migration-plan-required", code: error.code });
    throw error;
  }
}
module.exports = { LegacyMigrationExecutorError, oldWriterFenceFromSource, migrateLegacyPermitStore, PENDING_FILE, migrationIsComplete, assertNoPendingMigration };
