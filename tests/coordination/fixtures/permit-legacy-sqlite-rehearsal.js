"use strict";

// TEST FIXTURE ONLY. Never imported by an updater/host. These local files and
// hashes grant no migration, durability, isolation or activation capability.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createHash } = require("node:crypto");
const { DatabaseSync, constants: SQL } = require("node:sqlite");
const { parse } = require("../../../lib/offline-migration/json");
const core = require("../../../lib/coordination/permit-legacy-migration-core");
// The rehearsal root must be a disposable project `.agent/runtime/`, never the
// repository working copy: `.agent/rules/test-policy.md` §2.4 forbids a test
// from writing the real `.agent/` tree, and the strict-hermetic gate in
// `scripts/test-runner.cjs` fails the suite on any write under `.agent/`.
// The parent test injects the sandbox root; a subprocess spawned by the parent
// inherits it through the environment so both use the same tree.
const ROOT = process.env.CORTEX_PERMIT_TEST_RUNTIME_ROOT
  || require("../../helpers/runtime-sandbox").testRuntime();
const SOURCES = path.join(__dirname, "permit-legacy-sqlite-sources");
const manifest = require("./permit-legacy-sqlite-sources/manifest.json");
const DDL = "CREATE TABLE protected_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, sha256 TEXT NOT NULL)";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const BLOCKERS = Object.freeze(["deployment-gate-unverified", "ordinary-migration-durability-cap-missing",
  "old-writer-fence-unverified", "external-pin-revocation-history-unverified", "candidate-npm-tar-unverified"]);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function equal(a, b, code) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(code); }

// Pin the whole local require closure, not just the store while silently
// resolving its anchor/lock dependencies against the changing working tree.
function frozen(version) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const store = name === "protected-permit-store", spec = manifest[version];
    const file = store ? path.join(__dirname, spec.store_fixture) : path.join(SOURCES, name + ".txt");
    if (!store && !Object.hasOwn(manifest.dependencies, name)) fail("FIXTURE_DEPENDENCY");
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== (store ? spec.store_sha256 : manifest.dependencies[name])) fail("FIXTURE_SOURCE_HASH");
    const m = new Module(file); m.filename = file; cache.set(name, m);
    m.require = request => {
      if (["node:fs", "node:path", "node:crypto", "node:sqlite", "node:child_process"].includes(request)) return require(request);
      if (!request.startsWith("./")) fail("FIXTURE_DEPENDENCY");
      return load(request.slice(2));
    };
    m._compile(bytes.toString("utf8"), file);
    return m.exports;
  }
  return { store: load("protected-permit-store"), anchor: load("protected-anchor"),
    lock: version === "candidate" ? load("protected-store-lock") : null };
}

function regular(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 16 * 1024 * 1024) fail("FIXTURE_UNSAFE_PATH");
  return s;
}
function runtimePath(dir) {
  const absolute = path.resolve(dir), rel = path.relative(ROOT, absolute);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) fail("FIXTURE_OUTSIDE_RUNTIME");
  for (let p = absolute; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) fail("FIXTURE_UNSAFE_PATH");
    if (p === ROOT) break;
  }
  return absolute;
}
function newRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(ROOT, "permit-legacy-sqlite-"));
}
function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function write(file, bytes, append = false) {
  const fd = fs.openSync(file, append ? "a" : "wx", 0o600);
  try {
    const b = Buffer.from(bytes);
    if (fs.writeSync(fd, b) !== b.length) fail("FIXTURE_SHORT_WRITE");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDir(path.dirname(file));
}
function snapshot(dir) {
  runtimePath(dir);
  const out = {};
  function visit(p, rel) {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink !== 1)) fail("FIXTURE_UNSAFE_PATH");
    out[rel] = { dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, nlink: s.nlink };
    if (s.isDirectory()) for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name), rel + "/" + name);
    else { regular(p); out[rel].sha256 = hash(fs.readFileSync(p)); }
  }
  visit(dir, "."); return out; // atime intentionally excluded and never claimed unchanged
}
function bytes(file) {
  const before = regular(file), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail("FIXTURE_SOURCE_CHANGED");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function paths(root) { return { file: path.join(root, "db/state.sqlite"), anchor: path.join(root, "anchor") }; }

// Creates ONLY synthetic history by running the exact frozen legacy engine.
// No governed operation, signer, supervisor, broker or business service runs.
function createLegacy({ unresolved = null, wal = false } = {}) {
  const root = newRoot();
  fs.mkdirSync(path.join(root, "db"), { mode: 0o700 }); fs.mkdirSync(path.join(root, "anchor"), { mode: 0o700 });
  write(path.join(root, "fixture.json"), JSON.stringify({ kind: "legacy-sqlite-rehearsal-only", version: "1.15.7" }) + "\n");
  const p = paths(root), { store } = frozen("legacy"); let now = 1000;
  const old = store.ProtectedPermitStore.initialize(p.file, { decisionId: "D-rehearsal", anchorDir: p.anchor,
    anchorMode: "permissive", clock: () => now, verifyRecovery: () => true });
  const lease = n => old.acquire({ owner: "fixture", sessionId: "s-" + n, hostId: "h", workerId: "w", runId: "r",
    generation: "g", desktopKey: "desktop-" + n, ownedAppId: "a", idempotencyKey: "lease-" + n, ttlMs: 100 });
  const permit = (l, n) => old.reserve({ ...l, operation: "fixture-no-dispatch", targetDigest: "a".repeat(64),
    paramsDigest: "b".repeat(64), idempotencyKey: "permit-" + n, ttlMs: 10 });
  try {
    for (const [i, status] of ["finished", "failed", "expired", "revoked", "lease-expired"].entries()) {
      now = 1000 + i * 200; const l = lease(i + 1), p1 = permit(l, i + 1);
      if (status === "finished" || status === "failed") {
        now = p1.deadline; old.consume(p1); now++; old.finish({ ...p1, outcome: status });
        if (status === "finished") old.release(l);
      } else if (status === "expired") {
        now = p1.deadline + 1;
        try { old.consume(p1); fail("FIXTURE_EXPECTED_EXPIRY"); } catch (e) { if (e.code !== "ERR_PERMIT_NOT_CONSUMABLE") throw e; }
        old.release(l);
      } else if (status === "lease-expired") { now = l.expiresAt; old.expire(); }
      else { now++; old.revoke(l); }
      old.recover({ fixture: "no external effect was dispatched" });
    }
    if (unresolved) {
      now = 2200; const l = lease(6), p1 = permit(l, 6);
      if (unresolved !== "reserved") old.consume(p1);
      if (unresolved === "unknown") old.restartService();
    }
    const state = old.snapshot();
    // A live, idle legacy SQLite handle retains a REAL committed WAL/SHM pair.
    // This is a reproducible single-writer fixture, NOT proof of deployment drain.
    if (!wal) old.close();
    return { root, ...p, state, close: () => old.close() };
  } catch (e) { old.close(); throw e; }
}

function namespace(root, { target = false } = {}) {
  runtimePath(root);
  equal(fs.readdirSync(root).sort(), ["anchor", "db", "fixture.json"], "FIXTURE_NAMESPACE");
  const mark = parse(bytes(path.join(root, "fixture.json")).toString("utf8"));
  equal(mark, { kind: "legacy-sqlite-rehearsal-only", version: "1.15.7" }, "FIXTURE_MARKER");
  const p = paths(root);
  for (const name of fs.readdirSync(path.join(root, "db"))) {
    if (!["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "state.sqlite-journal"].includes(name)) fail("FIXTURE_SIDECAR_UNKNOWN");
    regular(path.join(root, "db", name));
  }
  for (const name of fs.readdirSync(p.anchor)) {
    if (!/^protected-anchor-entry-\d{12}-\d{6}-(intent|commit|abort)-[a-f0-9]{16}\.json$/.test(name) &&
      !["protected-anchor-high-water.log", "protected-anchor-audit.log"].includes(name) &&
      !(target && ["protected-store-coordination.sqlite", "protected-store-coordination.sqlite-journal"].includes(name))) fail("FIXTURE_ANCHOR_NAMESPACE");
    regular(path.join(p.anchor, name));
  }
  return p;
}
function copyTree(source, dest) {
  fs.mkdirSync(dest, { mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    const src = path.join(source, name), dst = path.join(dest, name), s = fs.lstatSync(src);
    if (s.isDirectory()) copyTree(src, dst);
    else { write(dst, bytes(src)); fs.chmodSync(dst, s.mode & 0o777); }
  }
  syncDir(dest);
}
function compareBytes(left, right) {
  equal(fs.readdirSync(left).sort(), fs.readdirSync(right).sort(), "FIXTURE_COPY_MISMATCH");
  for (const name of fs.readdirSync(left)) {
    const a = path.join(left, name), b = path.join(right, name), s = fs.lstatSync(a);
    if (s.isDirectory()) compareBytes(a, b);
    else {
      if (!bytes(a).equals(bytes(b)) || (s.mode & 0o777) !== (fs.statSync(b).mode & 0o777)) fail("FIXTURE_COPY_MISMATCH");
    }
  }
}
function strictRow(db, expectedVersion) {
  // Enumerate EVERY SQL object including null-SQL autoindexes/internal tables.
  // Never run integrity_check or UPDATE before this closed whitelist passes.
  equal(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all().map(r => ({ ...r })),
    [{ type: "table", name: "protected_state", tbl_name: "protected_state", sql: DDL }], "FIXTURE_SQL_OBJECTS");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version !== expectedVersion || db.prepare("PRAGMA application_id").get().application_id !== 0) fail("FIXTURE_SQL_VERSION");
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") fail("FIXTURE_SQL_INTEGRITY");
  const rows = db.prepare("SELECT id,body,sha256 FROM protected_state").all();
  if (rows.length !== 1 || rows[0].id !== 1 || typeof rows[0].body !== "string" || hash(rows[0].body) !== rows[0].sha256) fail("FIXTURE_SQL_ROW");
  const state = parse(rows[0].body);
  if (state.schema_version !== version) fail("FIXTURE_SQL_VERSION");
  return { user_version: version, body: rows[0].body, sha256: rows[0].sha256 };
}
function completeHighWater(input) {
  // This adapter supports ONLY an uncompressed attempt=1 history from seq1.
  // A final mark (or caller's prepared input) cannot prove the missing prefix.
  // Legacy compaction has no verifiable receipt here, so reject it as well.
  const boundary = input.expected.anchor_sequence, records = input.high_water;
  if (!Number.isSafeInteger(boundary) || boundary < 1 || records.length !== boundary ||
      records.some((record, i) => record.sequence !== i + 1)) fail("FIXTURE_HIGH_WATER_PREFIX");
}
function evidence(root, row, { target = false } = {}) {
  const p = namespace(root, { target }), state = parse(row.body), journal = [];
  for (const name of fs.readdirSync(p.anchor).sort()) if (name.startsWith("protected-anchor-entry-")) {
    const content = bytes(path.join(p.anchor, name)).toString("utf8");
    if (!content.endsWith("\n")) fail("FIXTURE_ANCHOR_TRUNCATED");
    const e = parse(content);
    const expected = `protected-anchor-entry-${String(e.sequence).padStart(12, "0")}-${String(e.attempt).padStart(6, "0")}-${e.type}-${hash(content).slice(0, 16)}.json`;
    if (name !== expected) fail("FIXTURE_ANCHOR_NAME");
    journal.push(e);
  }
  function lines(name) {
    const content = bytes(path.join(p.anchor, name)).toString("utf8");
    if (!content.endsWith("\n") || !content.trim()) fail("FIXTURE_ANCHOR_TRUNCATED");
    return content.slice(0, -1).split("\n").map(parse);
  }
  const input = { format_version: 1, source: row,
    expected: { decision_id: state.decision_id, store_id: state.store_id, body_digest: row.sha256, anchor_sequence: state.anchor_sequence },
    journal, high_water: lines("protected-anchor-high-water.log"), audit: lines("protected-anchor-audit.log") };
  completeHighWater(input);
  return input;
}
function inspect(root, version = 1, target = version === 2) {
  const p = namespace(root, { target });
  const db = new DatabaseSync(p.file, { readOnly: true });
  try { db.exec("PRAGMA trusted_schema=OFF; BEGIN"); return strictRow(db, version); }
  finally { db.close(); }
}
function appendEntry(dir, entry) {
  const content = JSON.stringify(entry) + "\n";
  const name = `protected-anchor-entry-${String(entry.sequence).padStart(12, "0")}-${String(entry.attempt).padStart(6, "0")}-${entry.type}-${hash(content).slice(0, 16)}.json`;
  write(path.join(dir, name), content);
}
function control(run, stage, details = {}) {
  write(path.join(run, "control.jsonl"), JSON.stringify({ scope: "fixture-only-no-authority", stage, ...details }) + "\n", true);
}
function errorInfo(e) { return { code: e.code, errcode: e.errcode, outcome: e.outcome,
  cleanupError: e.cleanupError ? errorInfo(e.cleanupError) : undefined,
  sourceCheckError: e.sourceCheckError ? errorInfo(e.sourceCheckError) : undefined,
  recordError: e.recordError ? errorInfo(e.recordError) : undefined }; }

function allocateRun(source, runParent) {
  if (runParent === undefined) return newRoot();
  // Parent allocates a private empty directory BEFORE spawning. Child owns
  // exactly its exclusive 'rehearsal' subdirectory, known even without stdout
  // or a crash receipt. Never infer ownership from shared ROOT contents.
  const parent = runtimePath(runParent), rel = path.relative(source, parent);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel)) || fs.readdirSync(parent).length) fail("FIXTURE_RUN_PARENT");
  const run = path.join(parent, "rehearsal");
  fs.mkdirSync(run, { mode: 0o700 });
  return run;
}

// There is deliberately no API taking a caller-selected writable database.
// The only conversion destination is a freshly allocated private WORK COPY.
function rehearse(source, { failure = "none", denyRollback = false, runParent } = {}) {
  if (!["none", "zero-cas", "deny-commit", "after-commit", "exit-before-commit", "exit-after-commit", "after-intent"].includes(failure)) fail("FIXTURE_FAULT");
  namespace(source);
  const before = snapshot(source), run = allocateRun(path.resolve(source), runParent), backup = path.join(run, "backup"), work = path.join(run, "work");
  write(path.join(run, "source-before.json"), JSON.stringify(before) + "\n");
  let db, primaryError, result, began = false, possible = false, intentWritten = false;
  try {
    // Raw backup precedes opening SQLite. Source descriptors are O_RDONLY.
    copyTree(source, backup); compareBytes(source, backup); copyTree(backup, work);
    equal(snapshot(source), before, "FIXTURE_SOURCE_CHANGED");
    const p = paths(work);
    // A hot rollback journal needs a separately reviewed recovery adapter.
    if (fs.existsSync(p.file + "-journal")) fail("FIXTURE_JOURNAL_UNSUPPORTED");
    if (fs.existsSync(p.file + "-wal")) {
      const wal = bytes(p.file + "-wal");
      if (wal.length < 32 || ![0x377f0682, 0x377f0683].includes(wal.readUInt32BE(0)) ||
          wal.readUInt32BE(4) !== 3007000) fail("FIXTURE_WAL_FORMAT");
      const page = wal.readUInt32BE(8);
      if (page < 512 || page > 65536 || (page & (page - 1)) || (wal.length - 32) % (24 + page)) fail("FIXTURE_WAL_FORMAT");
    }
    const sourceRow = inspect(work), input = evidence(work, sourceRow), encoded = JSON.stringify(input);
    const prepared = core.prepareLegacyPermitMigration(encoded);
    write(path.join(run, "prepared.json"), JSON.stringify({ input, prepared }) + "\n");
    control(run, "prepared", { source: sourceRow.sha256, target: prepared.target.sha256 });
    const { lock } = frozen("candidate");
    // Lock is created ONLY in the copy; this is not the platform/ordinary cap.
    lock.withLock(p.anchor, () => {
      db = new DatabaseSync(p.file);
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE"); began = true;
      equal(strictRow(db, 1), sourceRow, "FIXTURE_SOURCE_CAS");
      equal(evidence(work, sourceRow, { target: true }), input, "FIXTURE_ANCHOR_CAS");
      appendEntry(p.anchor, prepared.append.intent); intentWritten = true; control(run, "intent");
      if (failure === "after-intent") fail("FIXTURE_BEFORE_COMMIT");
      const changed = db.prepare("UPDATE protected_state SET body=?,sha256=? WHERE id=1 AND body=? AND sha256=?")
        .run(prepared.target.body, prepared.target.sha256, sourceRow.body, failure === "zero-cas" ? "0".repeat(64) : sourceRow.sha256).changes;
      if (changed !== 1) fail("FIXTURE_ZERO_CAS");
      db.exec("PRAGMA user_version=2");
      equal(strictRow(db, 2), prepared.target, "FIXTURE_TARGET");
      // This marker is local test evidence, NOT the protected control domain.
      control(run, "db-commit-possible"); possible = true;
      if (failure === "exit-before-commit") process.exit(71);
      if (failure === "deny-commit") db.setAuthorizer((action, verb) => action === SQL.SQLITE_TRANSACTION && verb === "COMMIT" ? SQL.SQLITE_DENY : SQL.SQLITE_OK);
      db.exec("COMMIT"); began = false;
      if (failure === "exit-after-commit") process.exit(72);
      if (failure === "after-commit") fail("FIXTURE_AFTER_COMMIT");
      appendEntry(p.anchor, prepared.append.commit);
      write(path.join(p.anchor, "protected-anchor-high-water.log"), JSON.stringify(prepared.append.high_water) + "\n", true);
      write(path.join(p.anchor, "protected-anchor-audit.log"), JSON.stringify({ schema_version: 1,
        at: "2026-10-31T00:00:00.000Z", store_id: input.expected.store_id, event: "transaction",
        sequence: prepared.append.commit.sequence, body_digest: prepared.target.sha256 }) + "\n", true);
    }, { create: true });
    db.close(); db = null;
    // Appending witnesses is not evidence that they match the committed DB.
    // Close the writer, then validate the complete DB/journal/water/audit and
    // unmodified frozen reader before persisting even this fixture-only fact.
    verifyFresh(work, 2, prepared.target);
    result = { run, backup, work, input, prepared, status: "copy-converted-not-activated", executionAuthorized: false,
      activation: "blocked", blockers: BLOCKERS, sourceUnchanged: true };
  } catch (e) {
    primaryError = e;
    // A dangling intent is not a verified abort. No recovery/abort protocol is
    // implemented here; retain unknown even when rollback can be observed.
    e.run = run; e.outcome = possible || intentWritten ? "unknown" : "aborted-before-commit";
    if (db && began) {
      try {
        if (denyRollback) db.setAuthorizer((action, verb) => action === SQL.SQLITE_TRANSACTION && verb === "ROLLBACK" ? SQL.SQLITE_DENY : SQL.SQLITE_OK);
        db.exec("ROLLBACK");
      } catch (cleanupError) { e.cleanupError = cleanupError; e.outcome = "unknown"; }
    }
  }
  // Finish ALL cleanup/source checks before publishing witnessed or success.
  // Do not throw from finally: a secondary close/check/record error must not
  // replace the original transaction failure or lose the possible-commit axis.
  if (db) {
    try { db.close(); }
    catch (cleanupError) {
      if (primaryError) primaryError.cleanupError ||= cleanupError;
      else primaryError = cleanupError;
      primaryError.outcome = "unknown";
    }
  }
  try {
    // Actual identity, directory entries, bytes and mtime/ctime checked, not
    // inferred from readOnly:true. Concurrent hostile writers are NOT fenced.
    const after = snapshot(source);
    write(path.join(run, "source-after.json"), JSON.stringify(after) + "\n");
    equal(after, before, "FIXTURE_SOURCE_CHANGED");
  } catch (sourceCheckError) {
    if (primaryError) primaryError.sourceCheckError = sourceCheckError;
    else primaryError = sourceCheckError;
  }
  function reportFailure(error) {
    error.run = run;
    error.outcome = possible || intentWritten || error.outcome === "unknown" ? "unknown" : "aborted-before-commit";
    try { control(run, error.outcome, errorInfo(error)); }
    catch (recordError) {
      error.recordError = recordError;
      error.outcome = "unknown"; // persistence failure is NOT a durable receipt
    }
    return error;
  }
  if (primaryError) throw reportFailure(primaryError);
  try {
    control(run, "witnessed");
    control(run, "copy-converted-not-activated");
  } catch (error) {
    throw reportFailure(error);
  }
  return result;
}

function verifyFresh(work, version, expected) {
  const row = inspect(work, version), state = parse(row.body), frozenVersion = frozen(version === 1 ? "legacy" : "candidate");
  if (expected) equal(row, expected, "FIXTURE_TARGET");
  if (version === 2) {
    const { input, prepared } = parse(bytes(path.join(path.dirname(work), "prepared.json")).toString("utf8"));
    completeHighWater(input);
    core.verifyLegacyPermitMigrationTarget(JSON.stringify(input), JSON.stringify(row));
    const actual = evidence(work, row, { target: true });
    const sorted = entries => entries.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    equal(sorted(actual.journal), sorted([...input.journal, prepared.append.intent, prepared.append.commit]), "FIXTURE_TARGET_ANCHOR");
    equal(actual.high_water, [...input.high_water, prepared.append.high_water], "FIXTURE_TARGET_WATER");
    equal(actual.audit, [...input.audit, { schema_version: 1, at: "2026-10-31T00:00:00.000Z", store_id: state.store_id,
      event: "transaction", sequence: state.anchor_sequence, body_digest: row.sha256 }], "FIXTURE_TARGET_AUDIT");
  } else evidence(work, row);
  // Strict maintenance validation of actual SQLite/anchor/coordination lock
  // through the UNMODIFIED frozen public open/snapshot APIs. No operations.
  const opened = frozenVersion.store.ProtectedPermitStore.open(paths(work).file, {
    anchorDir: paths(work).anchor, anchorMode: "permissive", expectedDecisionId: state.decision_id,
    minimumEpoch: state.service_epoch, clock: () => state.last_clock_ms });
  try { equal(opened.snapshot(), state, "FIXTURE_REOPEN_STATE"); } finally { opened.close(); }
  return row;
}
module.exports = { ROOT, DDL, manifest, hash, frozen, paths, snapshot, bytes, namespace, inspect, evidence,
  createLegacy, rehearse, verifyFresh, errorInfo, BLOCKERS, newRoot };

if (require.main === module) {
  const [op, root] = process.argv.slice(2);
  try {
    if (op === "rehearse") {
      const result = rehearse(root, JSON.parse(process.argv[4] || "{}"));
      console.log(JSON.stringify({ status: result.status, run: result.run }));
    } else if (op === "create-wal") {
      const f = createLegacy({ wal: true });
      console.log(JSON.stringify({ root: f.root, state: f.state }));
      // Genuine OS teardown of the legacy writer, bypassing SQLite close and
      // its checkpoint. Stable nonempty WAL/SHM remain for copy-only recovery.
      process.exit(0);
    } else if (op === "verify") console.log(JSON.stringify(verifyFresh(root, Number(process.argv[4]), JSON.parse(process.argv[5] || "null"))));
    else if (op === "inspect") console.log(JSON.stringify(inspect(root, Number(process.argv[4]), true)));
    else fail("FIXTURE_COMMAND");
  } catch (e) { console.log(JSON.stringify({ error: errorInfo(e), run: e.run })); process.exitCode = 1; }
}
