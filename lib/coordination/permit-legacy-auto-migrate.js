"use strict";

// CANDIDATE automatic legacy repair. NOT an authority, NOT production
// wiring.
//
// A store created by 1.15.7 carries `user_version = 1`, and the current
// reader refuses it. The upgrade has to repair such a store, otherwise every
// existing deployment breaks on the first open after the upgrade.
//
// This module decides WHETHER a store needs the repair and drives the
// migration executor. It never migrates on its own initiative:
//
// - The caller has to declare that the deployment allows the automatic
//   repair (`autoRepair`), and the declaration has to name the frozen old
//   reader source that fences the old writer. Without that source the
//   migration cannot prove that the old writer loses its authority, so the
//   repair is refused.
// - The repair is a single attempt per store. A failure leaves the store in
//   the state the migration produced, and the next open reports the failure
//   instead of retrying silently.
//
// The repair itself is the executor's job. This module only decides whether
// to run it and reports what happened.

const fs = require("node:fs");
const path = require("node:path");
const executor = require("./permit-legacy-migration-executor");
const core = require("./permit-legacy-migration-core");
const anchorModule = require("./protected-anchor");

class LegacyAutoMigrateError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "LegacyAutoMigrateError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, details) { throw new LegacyAutoMigrateError(code, details); }

// The schema version the frozen 1.15.7 store carries.
const LEGACY_USER_VERSION = 1;

// Read the `user_version` without writing database rows. SQLite may still
// create/update shared memory, so its sidecars must pass the pre-open gate.
function readUserVersion(filePath) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); }
  catch { fail("ERR_RUNTIME_UNSUPPORTED"); }
  require("./protected-permit-store").assertSafeDatabasePaths(filePath);
  let db;
  try { db = new DatabaseSync(path.resolve(filePath), { readOnly: true, timeout: 5000 }); }
  catch { return null; }
  try { return db.prepare("PRAGMA user_version").get().user_version; }
  catch { return null; }
  finally { db.close(); }
}

// Whether the store at the path is a legacy store that the automatic repair
// would have to fix. The answer is a fact about the store, never about a
// caller's wish.
function needsLegacyRepair(filePath) {
  if (typeof filePath !== "string" || !filePath) fail("ERR_LEGACY_MIGRATION_INPUT");
  const version = readUserVersion(filePath);
  if (version === null) return false;
  return version === LEGACY_USER_VERSION;
}

// Collect the evidence from the bytes the frozen 1.15.7 store wrote. As with
// discovery, read-only SQLite still needs a safe sidecar set before opening.
function collectEvidence(filePath, anchorDir) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); }
  catch { fail("ERR_RUNTIME_UNSUPPORTED"); }
  const dir = anchorModule.anchorDirFor(anchorDir);
  require("./protected-permit-store").assertSafeDatabasePaths(filePath);
  anchorModule.assertSeparateDomains(dir, filePath);
  let db;
  try { db = new DatabaseSync(path.resolve(filePath), { readOnly: true, timeout: 5000 }); }
  catch { fail("ERR_LEGACY_MIGRATION_SOURCE_MISSING"); }
  let row;
  try { row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get(); }
  finally { db.close(); }
  if (!row) fail("ERR_LEGACY_MIGRATION_SOURCE_MISSING");
  const state = JSON.parse(row.body);
  const journal = fs.readdirSync(dir)
    .filter((name) => name.startsWith("protected-anchor-entry-") && !name.includes(".tmp-")).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  const readLines = (name) => {
    const full = path.join(dir, name);
    let content;
    try { content = fs.readFileSync(full, "utf8"); }
    catch { return []; }
    return content.trim().split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  };
  return {
    format_version: 1,
    source: { user_version: LEGACY_USER_VERSION, body: row.body, sha256: row.sha256 },
    expected: { decision_id: state.decision_id, store_id: state.store_id,
      body_digest: row.sha256, anchor_sequence: state.anchor_sequence },
    journal,
    high_water: readLines(anchorModule.HIGH_WATER_FILE),
    audit: readLines("protected-anchor-audit.log"),
  };
}

// Repair a legacy store in place, if the deployment allows it.
//
// The call returns a report that says what happened; it never throws for a
// store that simply does not need the repair. A refused or failed repair is
// reported as such, so the caller can decide whether to continue.
function autoRepairLegacyStore(options) {
  if (!options || typeof options !== "object") fail("ERR_LEGACY_MIGRATION_INPUT");
  const { filePath, anchorDir, oldReaderSource, audit } = options;
  if (typeof filePath !== "string" || !filePath) fail("ERR_LEGACY_MIGRATION_INPUT");
  if (typeof anchorDir !== "string" || !anchorDir) fail("ERR_LEGACY_MIGRATION_INPUT");
  if (options.autoRepair !== true) {
    return Object.freeze({ repaired: false, reason: "auto-repair-not-declared" });
  }
  if (typeof oldReaderSource !== "string" || !oldReaderSource) {
    // Without the frozen old reader the repair cannot prove that the old
    // writer loses its authority, so it is refused.
    return Object.freeze({ repaired: false, reason: "old-reader-source-missing" });
  }
  if (!audit || typeof audit !== "object" || typeof audit.by !== "string" || !audit.by ||
      typeof audit.reason !== "string" || !audit.reason) fail("ERR_LEGACY_MIGRATION_INPUT");
  if (!needsLegacyRepair(filePath)) {
    return Object.freeze({ repaired: false, reason: "not-a-legacy-store" });
  }
  let evidence;
  try { evidence = collectEvidence(filePath, anchorDir); }
  catch (error) {
    return Object.freeze({ repaired: false, reason: "evidence-unavailable", code: error.code || null });
  }
  try { core.prepareLegacyPermitMigration(JSON.stringify(evidence)); }
  catch (error) {
    return Object.freeze({ repaired: false, reason: "evidence-not-preparable", code: error.code || null });
  }
  const result = executor.migrateLegacyPermitStore({ filePath, anchorDir, evidence,
    oldReaderSource, audit });
  return Object.freeze({ repaired: true, migrated: result.migrated, oldWriterFenced: result.oldWriterFenced,
    sourceUserVersion: result.sourceUserVersion, targetUserVersion: result.targetUserVersion,
    targetSequence: result.targetSequence, bodySha256: result.bodySha256 });
}

module.exports = {
  LEGACY_USER_VERSION,
  LegacyAutoMigrateError,
  readUserVersion,
  needsLegacyRepair,
  collectEvidence,
  autoRepairLegacyStore,
};
