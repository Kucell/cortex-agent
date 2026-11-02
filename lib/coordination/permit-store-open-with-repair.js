"use strict";

// Repair is allowed only after a read-only eligibility check. A refused or
// uncertain repair blocks opening and preserves its own error and outcome.
const crypto = require("node:crypto");
const path = require("node:path");
const autoMigrate = require("./permit-legacy-auto-migrate");
const executor = require("./permit-legacy-migration-executor");
const { PENDING_FILE, migrationIsComplete } = executor;
const fs = require("node:fs");
const anchor = require("./protected-anchor");
const coordination = require("./protected-store-lock");
const entryNamespace = require("./protected-entry-namespace");
const ADMISSION_LOCK = "protected-migration-admission.lock";

// Both bootstrap registration and migration admission use this name. Unlike
// the coordination DB it can be acquired before bootstrap creates any object.
// Never steal a crashed holder's directory: an uncertain admission stays closed.
function withMigrationAdmission(anchorDir, action) {
  coordination.assertAnchorPathIsNotRedirected(anchorDir);
  const lock = path.join(anchorDir, ADMISSION_LOCK);
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") blocked("ERR_LEGACY_MIGRATION_BUSY", "admission-busy");
    throw error;
  }
  const held = fs.lstatSync(lock);
  try { return action(); }
  finally {
    const current = fs.lstatSync(lock);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) {
      blocked("ERR_LEGACY_MIGRATION_BUSY", "admission-replaced");
    }
    fs.rmdirSync(lock);
  }
}
function assertBootstrapDomainVacant(anchorDir) {
  executor.assertNoPendingMigration(anchorDir);
  if (require("./protected-bootstrap").bootstrapState(anchorDir).pending.length) {
    blocked("ERR_BOOTSTRAP_PENDING", "bootstrap-pending");
  }
  if (fs.readdirSync(anchorDir).some(name => name !== ADMISSION_LOCK)) {
    blocked("ERR_BOOTSTRAP_DOMAIN_OCCUPIED", "anchor-domain-occupied");
  }
}

const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const ABORTED_AUDIT_PATTERN = /^protected-legacy-migration-aborted-[a-f0-9]{64}\.json$/;
// The coordination database and its SQLite-owned sidecars belong to the lock
// domain, not to the migration evidence. SQLite creates, checkpoints, replaces
// and removes them around its own transactions, so their transient bytes must
// never become a permanent equality condition of a historical abort audit.
// The coordination file is still bound by its identity; only its bytes are
// treated as unstable.
const COORDINATION_SIDECARS = new Set([coordination.FILE + "-wal", coordination.FILE + "-shm",
  coordination.FILE + "-journal"]);
const OBSERVED_STABLE_FIELDS = ["user_version", "body_sha256", "journal_sha256", "high_water_sha256",
  "audit_sha256", "recovery_sha256"];
function stableAbortObservation(observed) {
  // Older audits also captured admission and registration inodes. Admission
  // is held and checked per call; a re-registered identical plan has a new inode.
  return { ...observed, objects: observed.objects.filter(object => object.name !== ADMISSION_LOCK &&
    !COORDINATION_SIDECARS.has(object.name))
    .map(object => {
      const stable = { ...object };
      if (stable.name === PENDING_FILE) delete stable.identity;
      // The coordination file is bound by identity; SQLite may rewrite its
      // bytes during a checkpoint without replacing it.
      if (stable.name === coordination.FILE) delete stable.sha256;
      return stable;
    }) };
}

// A stored abort audit stays reusable while the evidence it described is
// unchanged. Later history may join the recorded set, but only a fully
// validated abort audit of this domain may do so: the enumeration validates
// every such file before it is accepted here. Nothing else may appear, and
// nothing that was recorded may change or disappear.
function abortHistoryCompatible(stored, fresh) {
  if (!stored || !fresh) return false;
  for (const field of OBSERVED_STABLE_FIELDS) {
    if (canonical(stored[field]) !== canonical(fresh[field])) return false;
  }
  const current = new Map(fresh.objects.map(object => [object.name, object]));
  for (const object of stored.objects) {
    const other = current.get(object.name);
    if (!other) return false;
    if (object.name === coordination.FILE) {
      if ((object.identity ?? null) !== (other.identity ?? null)) return false;
      continue;
    }
    if (object.sha256 !== other.sha256 || (object.identity ?? null) !== (other.identity ?? null)) return false;
  }
  const recorded = new Set(stored.objects.map(object => object.name));
  for (const object of fresh.objects) {
    if (recorded.has(object.name)) continue;
    if (!ABORTED_AUDIT_PATTERN.test(object.name)) return false;
  }
  return true;
}
function assertAbortAudit(record, name, database) {
  const digest = /^[a-f0-9]{64}$/;
  const observed = record?.observed;
  if (record?.format_version !== 1 || record.outcome !== "not-attempted" ||
      name !== `protected-legacy-migration-aborted-${record.plan_sha256}.json` ||
      !digest.test(record.plan_sha256) || record.plan?.format_version !== 1 ||
      sha256(canonical(record.plan)) !== record.plan_sha256 ||
      record.database !== database || record.plan.database !== database ||
      typeof record.by !== "string" || !record.by || typeof record.reason !== "string" || !record.reason ||
      typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) ||
      ![1, 2].includes(observed?.user_version) ||
      ![observed.body_sha256, observed.journal_sha256, observed.high_water_sha256].every(value => digest.test(value)) ||
      ![observed.audit_sha256, observed.recovery_sha256].every(value => value === null || digest.test(value)) ||
      !Array.isArray(observed.objects) || !observed.objects.length ||
      !observed.objects.every(object => object && typeof object.name === "string" && object.name &&
        (object.name === ADMISSION_LOCK ||
          // The coordination database is bound by identity only: SQLite may
          // rewrite its bytes during a checkpoint without replacing it.
          (object.name === coordination.FILE && typeof object.identity === "string" && /^\d+:\d+$/.test(object.identity)) ||
          (digest.test(object.sha256) &&
            (object.name === PENDING_FILE || (typeof object.identity === "string" && /^\d+:\d+$/.test(object.identity))))))) {
    blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "unknown-anchor-object");
  }
}
function readBoundRecord(file, parse = true) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd), bytes = fs.readFileSync(fd);
    const named = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== named.dev || stat.ino !== named.ino ||
        stat.size !== named.size || stat.mtimeMs !== named.mtimeMs || stat.ctimeMs !== named.ctimeMs) {
      blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "record-replaced");
    }
    return { identity: `${stat.dev}:${stat.ino}`, bytes, value: parse ? JSON.parse(bytes.toString("utf8")) : null };
  } finally { fs.closeSync(fd); }
}
function syncAdmissionDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Explicit, audited escape for a registration that never started. This is NOT
// an automatic open fallback. Missing/uncertain evidence or any started receipt
// requires forward replay of the original plan instead. The proof relies on
// the protected domain preserving receipts (the executor publishes started
// before its first intent); it cannot detect out-of-band deletion of evidence.
function abortUnstartedLegacyMigration(input, audit) {
  if (!input || !audit || typeof audit.by !== "string" || !audit.by ||
      typeof audit.reason !== "string" || !audit.reason) blocked("ERR_INVALID_INPUT", "abort-audit-required");
  const { filePath, anchorDir, oldReaderSource } = input;
  const dir = anchor.anchorDirFor(anchorDir);
  const domains = anchor.assertSeparateDomains(dir, filePath);
  const { ProtectedPermitStore } = require("./protected-permit-store");
  const databasePaths = ProtectedPermitStore.assertSafeDatabasePaths(filePath);
  const assertDatabase = (beforeOpen = false) => {
    ProtectedPermitStore.assertSafeDatabasePaths(filePath,
      beforeOpen ? databasePaths : { ...databasePaths, sidecars: undefined });
    anchor.assertSeparateDomains(dir, filePath, domains);
  };
  const encoded = typeof input.evidence === "string" ? input.evidence : JSON.stringify(input.evidence);
  const prepared = require("./permit-legacy-migration-core").prepareLegacyPermitMigration(encoded);
  if (!executor.oldWriterFenceFromSource(oldReaderSource).fenced) {
    blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "unverified-original-plan");
  }
  const plan = { format_version: 1, database: path.resolve(filePath), source_evidence_digest: prepared.source_evidence_digest,
    encoded_evidence: encoded, evidence: JSON.parse(encoded), prepared,
    old_reader_sha256: sha256(oldReaderSource), audit: { by: input.audit?.by, reason: input.audit?.reason } };
  const planDigest = sha256(canonical(plan));
  anchor.preflightAuthorityDurability(dir);
  if (!fs.existsSync(path.join(dir, coordination.FILE))) {
    withMigrationAdmission(dir, () => {
      if (canonical(readBoundRecord(path.join(dir, PENDING_FILE)).value) !== canonical(plan) ||
          require("./protected-bootstrap").bootstrapState(dir).pending.length) {
        blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "original-unstarted-plan-required");
      }
      try { coordination.withLock(dir, () => {}, { create: true }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    });
  }
  return coordination.withLock(dir, () => withMigrationAdmission(dir, () => {
    assertDatabase(true);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.resolve(filePath), { timeout: 5000 });
    try {
      assertDatabase();
      db.exec("BEGIN IMMEDIATE");
      assertDatabase();
      const pendingFile = path.join(dir, PENDING_FILE), pending = readBoundRecord(pendingFile);
      if (canonical(pending.value) !== canonical(plan)) blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "original-plan-required");
      const auditName = `protected-legacy-migration-aborted-${planDigest}.json`;
      const admission = fs.lstatSync(path.join(dir, ADMISSION_LOCK));
      function proveUnstarted() {
        const bootstrap = require("./protected-bootstrap");
        const allowed = new Set([anchor.JOURNAL_FILE, anchor.HIGH_WATER_FILE, "protected-anchor-audit.log",
          "protected-anchor-recovery.log", PENDING_FILE, bootstrap.CLAIM_FILE,
          coordination.FILE, coordination.FILE + "-journal"]);
        const objects = [];
        for (const name of fs.readdirSync(dir).sort()) {
          const full = path.join(dir, name), stat = fs.lstatSync(full);
          // Only our held admission directory is explainable. In particular,
          // readJournal skips directories, so its enumeration is not a proof.
          if (name === ADMISSION_LOCK && stat.isDirectory() && !stat.isSymbolicLink() &&
              stat.dev === admission.dev && stat.ino === admission.ino && fs.readdirSync(full).length === 0) {
            // This transient directory is checked in both proofs, not persisted.
            continue;
          }
          if (!stat.isFile() || stat.isSymbolicLink() || name.includes(".tmp-")) {
            blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "unknown-anchor-object");
          }
          const aborted = /^protected-legacy-migration-aborted-[a-f0-9]{64}\.json$/.test(name);
          // SQLite owns the coordination sidecars. They are legitimate members
          // of the lock domain, so a WAL checkpoint must not be reported as an
          // unknown anchor object. They are still bound to the lock domain and
          // are never accepted as migration evidence.
          const coordinationSidecar = COORDINATION_SIDECARS.has(name);
          if (name.startsWith("protected-legacy-migration-") && name !== PENDING_FILE && !aborted) {
            blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "started-or-uncertain-publication");
          }
          // ENTRY_PREFIX is private to protected-anchor; accept its namespace
          // only when readJournal will actually parse the record below.
          if (!allowed.has(name) && !aborted && !name.startsWith("protected-anchor-entry-") &&
              !new RegExp(`^${bootstrap.COMPLETE_PREFIX}[a-f0-9]{32}\\.json$`).test(name) &&
              !coordinationSidecar) {
            blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "unknown-anchor-object");
          }
          const record = readBoundRecord(full, false);
          if (aborted) {
            let value;
            try { value = JSON.parse(record.bytes.toString("utf8")); }
            catch { blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "unknown-anchor-object"); }
            assertAbortAudit(value, name, path.resolve(filePath));
          }
          // Our own durable audit appears between the two proofs. Its exact
          // content is checked separately; every other object must stay bound.
          // The coordination file and its sidecars belong to the lock domain:
          // SQLite may rewrite them at any time. Their identity is still
          // recorded, but their bytes are not part of the migration evidence
          // and must not become a permanent equality condition.
          if (name === auditName) { /* the audit under construction */ }
          else if (coordinationSidecar) {
            // A SQLite-owned sidecar carries no migration evidence. It is
            // accepted as a member of the lock domain and left out of the
            // snapshot, so a checkpoint cannot change the proof.
          } else if (name === coordination.FILE) {
            objects.push({ name, identity: record.identity });
          } else if (name === PENDING_FILE) {
            objects.push({ name, sha256: sha256(record.bytes) });
          } else {
            objects.push({ name, identity: record.identity, sha256: sha256(record.bytes) });
          }
        }
        if (bootstrap.bootstrapState(dir).pending.length) {
          blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "bootstrap-pending");
        }
        const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get();
        const version = db.prepare("PRAGMA user_version").get().user_version;
        const state = row && JSON.parse(row.body);
        if (!state || ![1, 2].includes(version) || version !== state.schema_version ||
            sha256(row.body) !== row.sha256 || Object.hasOwn(state, "witness_authority") ||
            row.sha256 === prepared.target.sha256) blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "database-not-provably-unstarted");
        let journal, conflicts;
        try {
          journal = anchor.readJournal(anchor.journalFileFor(dir));
          conflicts = entryNamespace.conflictsFor(journal.entries, { domain: sha256(path.resolve(dir)) });
        } catch {
          blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "ambiguous-journal");
        }
        if (conflicts.corrupt.length) blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "ambiguous-journal");
        if (conflicts.unterminated.length) blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "unterminated-journal");
        const water = anchor.readHighWater(dir);
        const slot = prepared.append.intent;
        if (journal.committed !== state.anchor_sequence || journal.committedDigest !== row.sha256 ||
            journal.entries.some(entry => entry.sequence > state.anchor_sequence ||
              (entry.store_id === slot.store_id && entry.sequence === slot.sequence)) ||
            water.mark !== state.anchor_sequence || water.digest !== row.sha256 || water.storeId !== state.store_id) {
          blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "migration-or-inconsistent-anchor-evidence");
        }
        const records = name => readBoundRecord(path.join(dir, name), false).bytes;
        const optionalRecords = name => {
          try { return records(name); }
          catch (error) { if (error.code === "ENOENT") return null; throw error; }
        };
        const permissionAudit = optionalRecords("protected-anchor-audit.log");
        const highWater = records(anchor.HIGH_WATER_FILE);
        const lines = bytes => bytes.toString("utf8").split("\n").filter(line => line.trim()).map(JSON.parse);
        if (lines(highWater).some(record => record.body_digest === prepared.target.sha256 ||
            (record.store_id === slot.store_id && record.sequence === slot.sequence))) {
          blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "migration-high-water-present");
        }
        let recovery = null;
        try { recovery = records("protected-anchor-recovery.log"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (recovery && lines(recovery).some(record =>
          record.source_evidence_digest === prepared.source_evidence_digest || record.target_sha256 === prepared.target.sha256)) {
          blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "migration-audit-present");
        }
        // Ordinary logs contain JSONL, so bind their raw bytes separately.
        return { user_version: version, body_sha256: row.sha256, journal_sha256: sha256(canonical(journal.entries)),
          high_water_sha256: sha256(highWater),
          audit_sha256: permissionAudit === null ? null : sha256(permissionAudit),
          recovery_sha256: recovery === null ? null : sha256(recovery), objects };
      }
      const observed = proveUnstarted();
      const auditFile = path.join(dir, auditName);
      let record = { format_version: 1, outcome: "not-attempted", plan_sha256: planDigest, plan,
        database: path.resolve(filePath), observed, by: audit.by, reason: audit.reason, at: new Date().toISOString() };
      let existing;
      try { existing = readBoundRecord(auditFile); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing) {
        record.at = existing.value.at;
        // The stored audit describes the evidence of its own moment. Later
        // history may join the anchor, so a strict snapshot equality would
        // make an earlier audit permanently unusable. The stable evidence and
        // every object the stored audit named must still match exactly; only a
        // fully validated abort audit may be added to the set.
        const storedObservation = stableAbortObservation(existing.value.observed);
        // Everything outside the observation is the audit's own identity: the
        // plan it was made for, the database it applies to and the auditor who
        // requested it. Those must agree with the stored record exactly. Only
        // the object SET of the observation may grow, and only with a fully
        // validated abort audit. A relaxed set comparison must never excuse a
        // rewritten auditor or reason.
        const sameIdentity = canonical({ ...existing.value, observed: null, at: null }) ===
          canonical({ ...record, observed: null, at: null });
        const sameObservation = canonical(storedObservation) === canonical(stableAbortObservation(record.observed));
        if (!Number.isFinite(Date.parse(record.at)) || !sameIdentity ||
            (!sameObservation && !abortHistoryCompatible(storedObservation, stableAbortObservation(record.observed)))) {
          blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "abort-audit-conflict");
        }
        const fd = fs.openSync(auditFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } else {
        const temporary = auditFile + ".tmp-" + crypto.randomBytes(12).toString("hex");
        try {
          const fd = fs.openSync(temporary, "wx", 0o600);
          try { fs.writeFileSync(fd, JSON.stringify(record) + "\n"); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
          fs.linkSync(temporary, auditFile);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      const boundAudit = readBoundRecord(auditFile);
      if (existing ? boundAudit.identity !== existing.identity || !boundAudit.bytes.equals(existing.bytes)
        : canonical(boundAudit.value) !== canonical(record)) {
        blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "abort-audit-conflict");
      }
      syncAdmissionDirectory(dir); // Audit is durable BEFORE removing the gate.
      assertDatabase();
      const current = readBoundRecord(pendingFile);
      if (current.identity !== pending.identity || !current.bytes.equals(pending.bytes) ||
          canonical(proveUnstarted()) !== canonical(observed)) blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "abort-evidence-changed");
      const currentAudit = readBoundRecord(auditFile);
      if (currentAudit.identity !== boundAudit.identity || !currentAudit.bytes.equals(boundAudit.bytes)) {
        blocked("ERR_LEGACY_MIGRATION_ABORT_UNSAFE", "abort-evidence-changed");
      }
      fs.unlinkSync(pendingFile);
      syncAdmissionDirectory(dir);
      db.exec("COMMIT");
      return Object.freeze({ aborted: true, outcome: "not-attempted", auditFile, planSha256: planDigest });
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no business bytes are written */ }
      throw error;
    } finally { db.close(); }
  }));
}

function blocked(code, reason) {
  const error = Object.assign(new Error(code), { code });
  error.legacyRepair = Object.freeze({ repaired: false, status: "blocked", reason, code });
  throw error;
}
function validateLegacyOpenOptions(options) {
  // ProtectedPermitStore.open() and #openUnlocked() require a positive safe
  // integer minimumEpoch and a nonempty string expectedDecisionId. Those
  // validators are private; mirror their exact predicates here BEFORE any
  // discovery/registration. Do not coerce or default an absent epoch.
  if (!Number.isSafeInteger(options.minimumEpoch) || options.minimumEpoch < 1) {
    blocked("ERR_INVALID_INPUT", "invalid-minimum-epoch");
  }
  if (typeof options.expectedDecisionId !== "string" || !options.expectedDecisionId) {
    blocked("ERR_INVALID_INPUT", "expected-decision-required");
  }
  // Reuse the store's pure anchor-mode validator instead of duplicating it.
  try { anchor.assertKnownAnchorMode(options.anchorMode); }
  catch (error) { blocked(error.code, "invalid-anchor-mode"); }
}
function preflightLegacyRepair(options) {
  require("./protected-permit-store").assertSafeDatabasePaths(options.filePath);
  anchor.assertSeparateDomains(options.anchorDir, options.filePath);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.resolve(options.filePath), { readOnly: true, timeout: 5000 });
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get();
    if (!row || crypto.createHash("sha256").update(row.body).digest("hex") !== row.sha256) {
      blocked("ERR_LEGACY_REPAIR_PREFLIGHT", "invalid-source");
    }
    const state = JSON.parse(row.body);
    if (version !== state.schema_version) blocked("ERR_LEGACY_REPAIR_PREFLIGHT", "schema-mismatch");
    if (state.decision_id !== options.expectedDecisionId) blocked("ERR_DECISION_MISMATCH", "decision-mismatch");
    // This executor produces ONLY ordinary schema2. Authority creation or a
    // schema upgrade to 3/4/5 requires its own explicitly authorized path.
    if (Object.hasOwn(state, "witness_authority") || options.witnessAuthority !== undefined ||
        (options.targetUserVersion !== undefined && options.targetUserVersion !== 2)) {
      blocked("ERR_LEGACY_REPAIR_TARGET_INCOMPATIBLE", "target-incompatible");
    }
    if (state.service_epoch < options.minimumEpoch) blocked("ERR_EPOCH_ROLLBACK", "epoch-rollback");
    if (state.anchor_mode === "strict" && options.anchorMode !== "strict") blocked("ERR_LEGACY_REPAIR_PREFLIGHT", "anchor-mode-downgrade");
    if (options.serviceIdentity !== undefined && state.service_identity !== options.serviceIdentity) {
      blocked("ERR_LEGACY_REPAIR_PREFLIGHT", "service-identity-mismatch");
    }
    return { user_version: version, body: row.body, sha256: row.sha256 };
  } finally { db.close(); }
}
function openWithLegacyRepair(openStore, options) {
  if (typeof openStore !== "function") throw new TypeError("openStore must be a function");
  if (!options || typeof options !== "object") throw new TypeError("options must be an object");
  const { filePath, anchorDir, autoRepair, oldReaderSource, audit } = options;
  let report = Object.freeze({ repaired: false, reason: "auto-repair-not-declared" });
  if (typeof anchorDir === "string") executor.assertNoPendingMigration(anchorDir);
  if (autoRepair === true && typeof filePath === "string" && typeof anchorDir === "string") {
    try {
      validateLegacyOpenOptions(options);
      // A pending migration must be settled with the original executor plan;
      // never recollect evidence or bypass it by opening an already-schema2 DB.
      const needsRepair = autoMigrate.needsLegacyRepair(filePath);
      if (fs.existsSync(path.join(anchorDir, PENDING_FILE)) && (needsRepair || !migrationIsComplete(anchorDir))) {
        blocked("ERR_LEGACY_REPAIR_PENDING", "original-migration-plan-required");
      }
      if (needsRepair) {
        const expectedSource = preflightLegacyRepair(options);
        if (typeof oldReaderSource !== "string" || !oldReaderSource) {
          blocked("ERR_LEGACY_REPAIR_BLOCKED", "old-reader-source-missing");
        }
        // Bind the preflight snapshot to the prepared source as well as the
        // transaction CAS. A legacy writer changing Decision between preflight
        // and evidence collection must not authorize a different migration.
        const evidence = autoMigrate.collectEvidence(filePath, anchorDir);
        const result = executor.migrateLegacyPermitStore({ filePath, anchorDir, evidence,
          oldReaderSource, audit, expectedSource });
        report = Object.freeze({ repaired: true, migrated: result.migrated, oldWriterFenced: result.oldWriterFenced,
          sourceUserVersion: result.sourceUserVersion, targetUserVersion: result.targetUserVersion,
          targetSequence: result.targetSequence, bodySha256: result.bodySha256 });
      }
    } catch (error) {
      if (!error.legacyRepair) error.legacyRepair = Object.freeze({ repaired: false, status: "unknown", reason: "repair-failed", code: error.code || null });
      throw error;
    }
  }
  try { return { store: openStore(), repair: report }; }
  catch (error) {
    if (error.legacyRepair) throw error;
    error.legacyRepair = report.repaired
      ? Object.freeze({ ...report, status: "repaired-open-rejected", reason: "open-rejected-after-repair",
        code: error.code || null, retryAllowed: false })
      : report;
    throw error;
  }
}

module.exports = { openWithLegacyRepair, withMigrationAdmission, assertBootstrapDomainVacant, abortUnstartedLegacyMigration };
