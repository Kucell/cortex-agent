"use strict";

// TEST FIXTURE ONLY. Real local SQLite atomicity, SYNTHETIC facts and clocks.
// No authority, authentication, real signatures, publication, effects or migration.
// Concurrent connection sessions are test request submitters within one fixture
// owner epoch, NOT a proof of exclusive OS ownership or a production service.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync, constants: SQLITE } = require("node:sqlite");
const { sqliteFixtureKernel: kernel, LIMITS } = require("../../../lib/coordination/permit-phase-a-synthetic-state");
const { sqliteSigningCodec: signing, BARRIER_PARTS } = require("../../../lib/coordination/permit-phase-a-synthetic-publication");

const APPLICATION_ID = 0x50574131, SCHEMA = 6; // Persisted barrier wall-clock terminal decisions; no migration.
const TABLES = Object.freeze([
  "CREATE TABLE fixture_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,semantic_format INTEGER NOT NULL,mode TEXT NOT NULL,database_id TEXT NOT NULL)",
  "CREATE TABLE fixture_state(id INTEGER PRIMARY KEY CHECK(id=1),row_version INTEGER NOT NULL CHECK(row_version>=0),owner_epoch INTEGER NOT NULL CHECK(owner_epoch>0),body TEXT NOT NULL,sha256 TEXT NOT NULL)",
  "CREATE TABLE fixture_attempt_sessions(attempt_id TEXT PRIMARY KEY,session_id TEXT NOT NULL)",
  "CREATE TABLE fixture_commit_guard(id INTEGER PRIMARY KEY,parent_ref INTEGER REFERENCES fixture_meta(id) DEFERRABLE INITIALLY DEFERRED)",
  "CREATE TABLE fixture_commits(row_version INTEGER PRIMARY KEY,previous_digest TEXT NOT NULL,state_digest TEXT NOT NULL,owner_epoch INTEGER NOT NULL,command_kinds TEXT NOT NULL,cas_changes INTEGER NOT NULL CHECK(cas_changes=1))",
  "CREATE TABLE fixture_sign_meta(id INTEGER PRIMARY KEY CHECK(id=1),semantic_format INTEGER NOT NULL,version INTEGER NOT NULL,body_digest TEXT NOT NULL)",
  "CREATE TABLE fixture_sign_records(attempt_id TEXT PRIMARY KEY,tuple_key TEXT NOT NULL UNIQUE,effect_id TEXT NOT NULL UNIQUE,sequence_key TEXT NOT NULL UNIQUE,action_key TEXT NOT NULL UNIQUE,body TEXT NOT NULL,body_digest TEXT NOT NULL,binding TEXT NOT NULL,owner_epoch INTEGER NOT NULL,creator_session TEXT NOT NULL,time_highwater INTEGER NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,gate_session TEXT,cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN(0,1)),result BLOB,result_digest TEXT,stored_result TEXT NOT NULL CHECK(stored_result IN('not-stored','committed-unpublishable')),original_delivery TEXT NOT NULL CHECK(original_delivery='unknown'),local_send_evidence TEXT NOT NULL CHECK(local_send_evidence IN('none','local-write-completed')))",
  "CREATE TABLE fixture_sign_commits(version INTEGER PRIMARY KEY,body_digest TEXT NOT NULL,attempt_id TEXT,operation TEXT NOT NULL,cas_changes INTEGER NOT NULL CHECK(cas_changes=1))",
  "CREATE TABLE fixture_barrier_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,body_digest TEXT NOT NULL)",
  "CREATE TABLE fixture_barriers(attempt_id TEXT PRIMARY KEY,version INTEGER NOT NULL,owner_epoch INTEGER NOT NULL,binding TEXT NOT NULL,binding_digest TEXT NOT NULL,intent_status TEXT NOT NULL CHECK(intent_status='committed-unpublishable'),evidence TEXT NOT NULL,eligibility TEXT,synthetic_claim TEXT,original_delivery TEXT NOT NULL CHECK(original_delivery='unknown'),time_domain TEXT NOT NULL CHECK(time_domain='synthetic-wall-ms'),time_highwater INTEGER NOT NULL CHECK(time_highwater>=0),terminal_reason TEXT CHECK(terminal_reason IN('expired','wall-rollback')),FOREIGN KEY(attempt_id) REFERENCES fixture_sign_records(attempt_id))",
  "CREATE TABLE fixture_barrier_commits(version INTEGER PRIMARY KEY,body_digest TEXT NOT NULL,attempt_id TEXT NOT NULL,operation TEXT NOT NULL,cas_changes INTEGER NOT NULL CHECK(cas_changes=1))",
]);
const RUNTIME = require("../../helpers/runtime-sandbox").testRuntime();
const FAILURES = Object.freeze(["none", "exit-before-commit", "exit-after-commit", "throw-before-commit-call", "throw-after-commit-call", "engine-commit-reject", "zero-row-cas", "zero-row-after-accept"]);
const sessions = new WeakMap(), capabilities = new WeakMap(), signCapabilities = new WeakMap();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function integer(n, min = 0) { if (!Number.isSafeInteger(n) || n < min || Object.is(n, -0)) fail("SQLITE_FIXTURE_INPUT"); return n; }
function digest(body) { return createHash("sha256").update(body).digest("hex"); }
function filePath(file, initializing = false) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.extname(file) !== ".sqlite") fail("SQLITE_FIXTURE_PATH");
  const absolute = path.resolve(file), parent = path.dirname(absolute);
  const relative = path.relative(RUNTIME, parent);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("SQLITE_FIXTURE_PATH");
  // Walk each existing component, refusing redirection rather than resolving it.
  for (let p = parent; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) fail("SQLITE_FIXTURE_PATH");
    if (p === RUNTIME) break;
  }
  if (initializing) {
    if (fs.readdirSync(parent).length) fail("SQLITE_FIXTURE_NONEMPTY");
  } else {
    const s = fs.lstatSync(absolute);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail("SQLITE_FIXTURE_PATH");
  }
  return absolute;
}
function identity(db) {
  if (db.prepare("PRAGMA application_id").get().application_id !== APPLICATION_ID ||
      db.prepare("PRAGMA user_version").get().user_version !== SCHEMA) fail("SQLITE_FIXTURE_FORMAT");
  // Exact reviewed DDL: names alone must not admit altered constraints, extra
  // triggers/views/indexes or a production DB impersonating fixture metadata.
  const ddl = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all().map(r => r.sql).sort();
  if (JSON.stringify(ddl) !== JSON.stringify([...TABLES].sort())) fail("SQLITE_FIXTURE_FORMAT");
  const meta = db.prepare("SELECT * FROM fixture_meta WHERE id=1").get();
  if (!meta || meta.schema_version !== SCHEMA || meta.semantic_format !== kernel.semanticFormat ||
      meta.mode !== "purely-synthetic-no-authority-no-execution" || typeof meta.database_id !== "string") fail("SQLITE_FIXTURE_FORMAT");
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r => r.name);
  if (JSON.stringify(names) !== JSON.stringify(["fixture_attempt_sessions", "fixture_barrier_commits", "fixture_barrier_meta", "fixture_barriers", "fixture_commit_guard", "fixture_commits", "fixture_meta", "fixture_sign_commits", "fixture_sign_meta", "fixture_sign_records", "fixture_state"]) ||
      db.prepare("SELECT COUNT(*) AS n FROM fixture_meta").get().n !== 1 || db.prepare("SELECT COUNT(*) AS n FROM fixture_state").get().n !== 1) fail("SQLITE_FIXTURE_FORMAT");
  return meta;
}
function readTransaction(db) {
  db.exec("BEGIN");
  try { const row = read(db); db.exec("COMMIT"); return row; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}
function preflight(file) {
  // Do NOT open the source through SQLite: even a mode=ro WAL reader may touch
  // shared-memory files, and a writable reader may recover a hot journal.
  // Copy with read-only source descriptors, then validate a private scratch DB
  // opened readOnly. Concurrent copies need not form a consistent snapshot:
  // failure refuses; success is revalidated on the real writable connection.
  // This is NOT an atomic file binding or a defense against hostile replacement.
  const dir = fs.mkdtempSync(path.join(RUNTIME, "permit-phase-a-preflight-"));
  const target = path.join(dir, "preflight.sqlite");
  let db;
  try {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const source = file + suffix;
      let fd;
      try {
        fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) fail("SQLITE_FIXTURE_PATH");
        fs.writeFileSync(target + suffix, fs.readFileSync(fd), { flag: "wx", mode: 0o600 });
      } catch (e) { if (suffix === "" || e.code !== "ENOENT") throw e; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    db = new DatabaseSync(target, { readOnly: true, timeout: 1000 });
    const row = readTransaction(db);
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") fail("SQLITE_FIXTURE_CORRUPT");
    return row;
  } finally { if (db) db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
function read(db) {
  const meta = identity(db), row = db.prepare("SELECT * FROM fixture_state WHERE id=1").get();
  if (!row || digest(row.body) !== row.sha256) fail("SQLITE_FIXTURE_CORRUPT");
  integer(row.row_version); integer(row.owner_epoch, 1); const facts = kernel.inspect(row.body);
  const commits = db.prepare("SELECT * FROM fixture_commits ORDER BY row_version").all();
  if (commits.length !== row.row_version || commits.length > LIMITS.events) fail("SQLITE_FIXTURE_CORRUPT");
  for (let i = 0; i < commits.length; i++) {
    if (commits[i].row_version !== i + 1 || commits[i].cas_changes !== 1 ||
        (i && commits[i].previous_digest !== commits[i - 1].state_digest)) fail("SQLITE_FIXTURE_CORRUPT");
  }
  if (commits.length && commits.at(-1).state_digest !== row.sha256) fail("SQLITE_FIXTURE_CORRUPT");
  const attempts = db.prepare("SELECT attempt_id FROM fixture_attempt_sessions ORDER BY attempt_id").all().map(r => r.attempt_id);
  if (JSON.stringify(attempts) !== JSON.stringify(facts.attempts.map(a => a.request.attemptId).sort())) fail("SQLITE_FIXTURE_CORRUPT");
  signingRows(db);
  barrierRows(db, row);
  return { ...row, databaseId: meta.database_id };
}
function signDigest(rows) {
  return digest(JSON.stringify(rows.map(r => ({ ...r, result: r.result === null ? null : Buffer.from(r.result).toString("base64") }))));
}
function signingRows(db) {
  const meta = db.prepare("SELECT * FROM fixture_sign_meta WHERE id=1").get();
  const rows = db.prepare("SELECT * FROM fixture_sign_records ORDER BY attempt_id").all();
  if (!meta || meta.semantic_format !== signing.semanticFormat || rows.length > LIMITS.attempts ||
      !Number.isSafeInteger(meta.version) || meta.version < 0 || meta.version > LIMITS.events || meta.body_digest !== signDigest(rows)) fail("SQLITE_FIXTURE_SIGN_CORRUPT");
  for (const r of rows) {
    const p = signing.inspect(r.body);
    if (digest(r.body) !== r.body_digest || p.request.attemptId !== r.attempt_id || p.canonicalTuple !== r.tuple_key || p.effectId !== r.effect_id ||
        p.sequenceKey !== r.sequence_key || p.canonicalAction.raw !== r.action_key || !Number.isSafeInteger(r.version) || r.version < 1 ||
        !Number.isSafeInteger(r.owner_epoch) || r.owner_epoch < 1 || typeof r.creator_session !== "string" || !Number.isSafeInteger(r.time_highwater) || r.time_highwater < 0 ||
        !["sign-prepared", "sign-call-possible", "sign-outcome-unknown", "hash-committed", "aborted"].includes(r.status) ||
        ![0, 1].includes(r.cancel_requested) || r.original_delivery !== "unknown" ||
        !["none", "local-write-completed"].includes(r.local_send_evidence)) fail("SQLITE_FIXTURE_SIGN_CORRUPT");
    let bound; try { bound = JSON.parse(r.binding); } catch { fail("SQLITE_FIXTURE_SIGN_CORRUPT"); }
    if (JSON.stringify(bound) !== r.binding || !bound.checkpoint || !bound.control) fail("SQLITE_FIXTURE_SIGN_CORRUPT");
    if (r.status === "hash-committed") {
      if (r.stored_result !== "committed-unpublishable") fail("SQLITE_FIXTURE_SIGN_CORRUPT");
      if (!r.result || digest(Buffer.from(r.result)) !== r.result_digest || Buffer.from(r.result).length !== 32) fail("SQLITE_FIXTURE_SIGN_CORRUPT");
      signing.verifyHash(r.body, Buffer.from(r.result)); // public hash verification, no calling right
    } else if (r.result !== null || r.result_digest !== null || r.stored_result !== "not-stored" || r.local_send_evidence !== "none") fail("SQLITE_FIXTURE_SIGN_CORRUPT");
    if (["sign-call-possible", "hash-committed"].includes(r.status) && !r.gate_session) fail("SQLITE_FIXTURE_SIGN_CORRUPT");
  }
  const log = db.prepare("SELECT * FROM fixture_sign_commits ORDER BY version").all();
  if (log.length !== meta.version || log.some((r, i) => r.version !== i + 1 || r.cas_changes !== 1) ||
      (log.length && log.at(-1).body_digest !== meta.body_digest)) fail("SQLITE_FIXTURE_SIGN_CORRUPT");
  return { meta, rows };
}
function signBinding(row) {
  const state = kernel.inspect(row.body);
  return JSON.stringify({ checkpoint: state.checkpoint, control: state.control });
}
function signGuard(row, record, now) {
  integer(now);
  const p = signing.inspect(record.body), state = kernel.inspect(row.body), c = JSON.parse(row.body).state.config;
  if (record.owner_epoch !== row.owner_epoch || record.binding !== signBinding(row) || state.clockPoisoned ||
      state.control.ownerRevoked || state.control.grantRevoked || state.control.lifecycleRevoked || c.lane !== "consumption-fixture" ||
      p.request.tuple.origin_authority_namespace !== c.authorityId || p.request.authority.storeGeneration !== c.storeGeneration ||
      p.request.authority.grantId !== state.control.grantId || p.request.authority.lifecycleVersion !== String(state.control.lifecycleVersion) ||
      String(p.request.message.generation) !== c.runGeneration || !p.request.authority.authorized || p.request.authority.revoked ||
      p.request.authority.registration !== "active" || now < state.clocks.wallClockHighWater || now < (record.time_highwater || 0) ||
      now < p.request.message.issued_at_ms || now >= p.request.message.deadline_ms) fail("SQLITE_FIXTURE_SIGN_BINDING");
}
function signSummary(row, calls) {
  const p = signing.inspect(row.body);
  return Object.freeze({ authority: false, executionAuthorized: false, publishable: false, dispatchAllowed: false,
    attemptId: row.attempt_id, status: row.status, version: row.version, ownerEpoch: row.owner_epoch,
    prepared: p.prepared, tuple: p.tuple, effectId: p.effectId, cancelRequested: !!row.cancel_requested,
    resultDigest: row.result_digest, storedResult: row.stored_result,
    originalDelivery: row.original_delivery, localSendEvidence: row.local_send_evidence,
    // Original delivery is independent of storage, cancel and recovery. Neither
    // an inspect response nor a successful local write is a client ACK.
    clientOutcome: row.status === "aborted" ? "cancelled" : "unknown",
    localSignerCalls: calls }); // instrumentation only, never restart evidence
}
function finish(db, failure) {
  if (failure === "engine-commit-reject") db.exec("INSERT INTO fixture_commit_guard VALUES(1,999)");
  if (failure === "exit-before-commit") process.exit(81);
  if (failure === "throw-before-commit-call") fail("SQLITE_FIXTURE_INJECTED_COMMIT");
  db.exec("COMMIT");
  if (failure === "exit-after-commit") process.exit(82);
  if (failure === "throw-after-commit-call") fail("SQLITE_FIXTURE_INJECTED_COMMIT");
}
function signLog(db, meta, id, operation) {
  const rows = db.prepare("SELECT * FROM fixture_sign_records ORDER BY attempt_id").all(), hash = signDigest(rows);
  const changes = db.prepare("UPDATE fixture_sign_meta SET version=version+1,body_digest=? WHERE id=1 AND version=?").run(hash, meta.version).changes;
  if (changes !== 1) fail("SQLITE_FIXTURE_SIGN_CAS");
  db.prepare("INSERT INTO fixture_sign_commits VALUES(?,?,?,?,1)").run(meta.version + 1, hash, id, operation);
}
const canonical = input => signing.canonicalData(input);
function parsedCanonical(body) {
  let v; try { v = JSON.parse(body); } catch { fail("SQLITE_FIXTURE_BARRIER_CORRUPT"); }
  if (canonical(v) !== body) fail("SQLITE_FIXTURE_BARRIER_CORRUPT"); return v;
}
function barrierDigest(rows) { return digest(canonical(rows.map(r => ({ ...r })))); } // SQLite rows have null prototypes
function barrierRows(db, stateRow) {
  const rows = db.prepare("SELECT * FROM fixture_barriers ORDER BY attempt_id").all();
  const meta = db.prepare("SELECT * FROM fixture_barrier_meta WHERE id=1").get();
  if (!meta || !Number.isSafeInteger(meta.version) || meta.version < 0 || meta.version > LIMITS.events ||
      rows.length > LIMITS.attempts || meta.body_digest !== barrierDigest(rows)) fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
  for (const r of rows) {
    const b = parsedCanonical(r.binding), evidence = parsedCanonical(r.evidence);
    const sign = db.prepare("SELECT * FROM fixture_sign_records WHERE attempt_id=?").get(r.attempt_id);
    const p = sign && signing.inspect(sign.body), facts = kernel.inspect(stateRow.body);
    const a = facts.attempts.find(a => a.request.attemptId === r.attempt_id);
    integer(r.version, 1); integer(r.owner_epoch, 1);
    integer(r.time_highwater);
    if (r.time_domain !== "synthetic-wall-ms" || ![null, "expired", "wall-rollback"].includes(r.terminal_reason)) fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
    if (!sign || sign.status !== "hash-committed" || !a || a.status !== "consumed-synthetic" || !a.commitOutcome ||
        digest(r.binding) !== r.binding_digest || r.intent_status !== "committed-unpublishable" || r.original_delivery !== "unknown" ||
        b.attemptId !== r.attempt_id || b.namespace !== p.tuple.origin_authority_namespace || b.canonicalTuple !== p.canonicalTuple || b.effectId !== p.effectId ||
        b.rawDigest !== p.prepared.digest || b.signedSequence !== p.request.message.sequence || b.requestDigest !== p.requestDigest || b.contentDigest !== p.contentDigest ||
        b.databaseId !== db.prepare("SELECT database_id FROM fixture_meta WHERE id=1").get().database_id ||
        b.intentDigest !== digest(canonical({ effect: p.request.effect, canonicalTuple: p.canonicalTuple, requestDigest: p.requestDigest })) ||
        b.resultDigest !== sign.result_digest || canonical(b.c0) !== canonical(JSON.parse(sign.binding).checkpoint) ||
        canonical(b.finalCheckpoint) !== canonical(a.commitOutcome.checkpoint) || !Number.isSafeInteger(b.businessSequence) || b.businessSequence < 1 || b.businessSequence > stateRow.row_version ||
        Object.keys(evidence).sort().join(",") !== "business,eligibility") fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
    for (const scope of ["business", "eligibility"]) {
      if (Object.keys(evidence[scope]).length > BARRIER_PARTS.length) fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
      for (const [part, e] of Object.entries(evidence[scope])) {
        if (!BARRIER_PARTS.includes(part) || e.kind !== "synthetic-fixture-evidence" || e.part !== part || e.scope !== scope ||
            e.timeDomain !== "synthetic-wall-ms" || e.bindingDigest !== digest(canonical(barrierBinding(r, scope))) || !Number.isSafeInteger(e.validUntil)) fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
      }
    }
    if (r.eligibility !== null) {
      const q = parsedCanonical(r.eligibility);
      if (q.kind !== "synthetic-qualification-only" || q.timeDomain !== "synthetic-wall-ms" || !Number.isSafeInteger(q.wallClockMs) || q.wallClockMs > r.time_highwater ||
          q.businessBindingDigest !== r.binding_digest || q.ownerEpoch !== r.owner_epoch ||
          q.businessEvidenceDigest !== digest(canonical(evidence.business))) fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
    }
    if (r.synthetic_claim !== null) {
      const claim = parsedCanonical(r.synthetic_claim);
      if (!r.eligibility || claim.kind !== "synthetic-claim-only" || claim.timeDomain !== "synthetic-wall-ms" || !Number.isSafeInteger(claim.wallClockMs) ||
          claim.wallClockMs > r.time_highwater || claim.bindingDigest !== r.binding_digest) fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
    }
  }
  const log = db.prepare("SELECT * FROM fixture_barrier_commits ORDER BY version").all();
  if (log.length !== meta.version || log.some((r, i) => r.version !== i + 1 || r.cas_changes !== 1) ||
      (log.length && log.at(-1).body_digest !== meta.body_digest)) fail("SQLITE_FIXTURE_BARRIER_CORRUPT");
  return { meta, rows };
}
function barrierBinding(r, scope) {
  if (!["business", "eligibility"].includes(scope)) fail("SQLITE_FIXTURE_SCOPE");
  const b = parsedCanonical(r.binding);
  if (scope === "eligibility") {
    if (!r.eligibility) fail("SQLITE_FIXTURE_QUALIFICATION_MISSING");
    b.eligibilityDigest = digest(r.eligibility); b.qualification = parsedCanonical(r.eligibility);
  }
  return { scope, ...b };
}
function syntheticCertificate(r, scope, now) {
  const e = parsedCanonical(r.evidence)[scope];
  for (const part of BARRIER_PARTS) {
    if (!e[part] || e[part].validUntil <= now || e[part].bindingDigest !== digest(canonical(barrierBinding(r, scope)))) fail("SQLITE_FIXTURE_SYNTHETIC_BARRIER_INCOMPLETE");
  }
  return digest(canonical(e));
}
function barrierLog(db, meta, id, operation, failure = "none") {
  if (meta.version >= LIMITS.events) fail("SQLITE_FIXTURE_LIMIT");
  const rows = db.prepare("SELECT * FROM fixture_barriers ORDER BY attempt_id").all(), hash = barrierDigest(rows);
  const expected = failure === "zero-meta-row-after-accept" ? meta.version + 1 : meta.version;
  if (db.prepare("UPDATE fixture_barrier_meta SET version=version+1,body_digest=? WHERE id=1 AND version=?").run(hash, expected).changes !== 1) fail("SQLITE_FIXTURE_BARRIER_META_CAS_AFTER_ACCEPT");
  db.prepare("INSERT INTO fixture_barrier_commits VALUES(?,?,?,?,1)").run(meta.version + 1, hash, id, operation);
}
function barrierSummary(r) {
  return { authority: false, executionAuthorized: false, publishable: false, dispatchAllowed: false, claimAllowed: false,
    attemptId: r.attempt_id, version: r.version, intentStatus: r.intent_status, binding: parsedCanonical(r.binding),
    evidenceKind: "synthetic-only-not-anchor-or-audit-proof", evidence: parsedCanonical(r.evidence),
    qualification: r.eligibility && parsedCanonical(r.eligibility), syntheticClaim: r.synthetic_claim && parsedCanonical(r.synthetic_claim),
    timeDomain: r.time_domain, wallClockHighWater: r.time_highwater, terminalReason: r.terminal_reason,
    storedResult: "committed-unpublishable", originalDelivery: r.original_delivery };
}
function barrierTransaction(driver, operation, id, input, now, options = {}) {
  const s = session(driver), { failure = "none", expectedVersion = null, cleanupFailure = "none" } = options;
  if (typeof id !== "string" || (!FAILURES.includes(failure) && failure !== "zero-meta-row-after-accept") ||
      !["none", "deny-rollback"].includes(cleanupFailure)) fail("SQLITE_FIXTURE_INPUT");
  // Barrier explicitly rejects the generic pre-accept probe. The post-accept
  // enum below injects an actual zero-row UPDATE and is always unknown/blocked.
  if (failure === "zero-row-cas") fail("SQLITE_FIXTURE_UNSUPPORTED_FAILURE");
  integer(now); if (expectedVersion !== null) integer(expectedVersion, 1);
  const data = parsedCanonical(canonical(input)); // rejects Proxy/accessor/extra code before transaction
  let attempted = false, businessDenied, timeDenied;
  try {
    s.db.exec("BEGIN IMMEDIATE"); const row = read(s.db); assertSession(s, row);
    const { meta, rows } = barrierRows(s.db, row);
    let r = rows.find(r => r.attempt_id === id);
    const sign = signingRows(s.db).rows.find(r => r.attempt_id === id);
    if (!sign || sign.status !== "hash-committed" || sign.cancel_requested) fail("SQLITE_FIXTURE_BUSINESS_UNAVAILABLE");
    if (operation === "business") {
      if (r) fail("SQLITE_FIXTURE_INTENT_EXISTS");
      if (sign.creator_session !== s.id) fail("SQLITE_FIXTURE_SIGN_OWNER");
      signGuard(row, sign, now);
      if (row.row_version >= LIMITS.events) fail("SQLITE_FIXTURE_LIMIT");
      if (Object.keys(data).sort().join(",") !== "clocks,observation" || data.clocks.wallClockNow !== now) fail("SQLITE_FIXTURE_INPUT");
      const p = signing.inspect(sign.body), facts = kernel.inspect(row.body), c = facts.control;
      const request = { attemptId: id, kind: "consume", checkpoint: JSON.parse(sign.binding).checkpoint,
        principal: p.request.authority.principalId, requestDigest: p.requestDigest, runGeneration: String(p.request.message.generation),
        ownerIncarnation: c.ownerIncarnation, ownerVersion: c.ownerVersion, grantId: c.grantId, grantVersion: c.grantVersion,
        lifecycleVersion: c.lifecycleVersion, monotonicDeadline: Number.MAX_SAFE_INTEGER, wallClockDeadline: p.request.message.deadline_ms,
        permitId: p.request.message.permit_id, fingerprint: digest(p.request.authority.signerFingerprint) }; // synthetic identity only
      let body = row.body;
      const commands = [
        { type: "admit", data: request }, { type: "reserve", data: { attemptId: id, version: 1, tokenId: "intent-" + id } },
        { type: "enter", data: { attemptId: id, version: 2, clocks: data.clocks, observation: data.observation } },
        { type: "commit", data: { attemptId: id, clocks: data.clocks } },
      ];
      for (const cmd of commands) {
        if (cmd.type === "commit" && kernel.inspect(body).attempts.find(a => a.request.attemptId === id).status !== "commit-possible") continue;
        body = kernel.transition(body, cmd);
      }
      const next = kernel.inspect(body), a = next.attempts.find(a => a.request.attemptId === id);
      if (a.status !== "consumed-synthetic") businessDenied = { authority: false, executionAuthorized: false,
        publishable: false, dispatchAllowed: false, claimAllowed: false, businessDenied: a.reason, state: next };
      const b = { databaseId: row.databaseId, namespace: p.tuple.origin_authority_namespace, attemptId: id,
        businessSequence: row.row_version + 1, signedSequence: p.request.message.sequence, rawDigest: p.prepared.digest,
        canonicalTuple: p.canonicalTuple, effectId: p.effectId, requestDigest: p.requestDigest, contentDigest: p.contentDigest,
        resultDigest: sign.result_digest, c0: request.checkpoint, finalCheckpoint: a.commitOutcome && a.commitOutcome.checkpoint,
        intentDigest: digest(canonical({ effect: p.request.effect, canonicalTuple: p.canonicalTuple, requestDigest: p.requestDigest })) };
      const binding = canonical(b);
      s.db.prepare("INSERT INTO fixture_attempt_sessions VALUES(?,?)").run(id, s.id);
      if (s.db.prepare("UPDATE fixture_state SET body=?,sha256=?,row_version=row_version+1 WHERE id=1 AND row_version=? AND owner_epoch=?")
        .run(body, digest(body), failure === "zero-row-after-accept" ? row.row_version + 1 : row.row_version, s.epoch).changes !== 1) fail("SQLITE_FIXTURE_BARRIER_CAS_AFTER_ACCEPT");
      s.db.prepare("INSERT INTO fixture_commits VALUES(?,?,?,?,?,1)").run(row.row_version + 1, row.sha256, digest(body), s.epoch, "synthetic-business-intent");
      if (!businessDenied) s.db.prepare("INSERT INTO fixture_barriers VALUES(?,1,?,?,?,'committed-unpublishable',?,NULL,NULL,'unknown','synthetic-wall-ms',?,NULL)")
        .run(id, s.epoch, binding, digest(binding), canonical({ business: {}, eligibility: {} }), now);
    } else {
      if (!r) fail("SQLITE_FIXTURE_INTENT_MISSING");
      // Terminal time facts survive recover and take precedence over a new
      // epoch's lack of recovery credentials. No caller can clear this axis.
      if (r.terminal_reason) fail("SQLITE_FIXTURE_BARRIER_TIME_TERMINAL");
      if (r.owner_epoch !== s.epoch || sign.owner_epoch !== s.epoch) fail("SQLITE_FIXTURE_RECOVERY_EVIDENCE_MISSING");
      if (expectedVersion !== null && expectedVersion !== r.version) fail("SQLITE_FIXTURE_BARRIER_CAS");
      const p = signing.inspect(sign.body), facts = kernel.inspect(row.body), final = parsedCanonical(r.binding).finalCheckpoint;
      if (canonical(facts.checkpoint) !== canonical(final) ||
          facts.clockPoisoned || Object.keys(facts.control).some(k => k.endsWith("Revoked") && facts.control[k])) fail("SQLITE_FIXTURE_BARRIER_BINDING");
      let evidence = r.evidence, eligibility = r.eligibility, claim = r.synthetic_claim;
      if (operation === "evidence") {
        if (Object.keys(data).sort().join(",") !== "binding,kind,part,scope,validUntil" || data.kind !== "synthetic-fixture-evidence" ||
            !BARRIER_PARTS.includes(data.part) || !["business", "eligibility"].includes(data.scope)) fail("SQLITE_FIXTURE_SYNTHETIC_EVIDENCE");
        integer(data.validUntil, 1);
        if (data.validUntil > p.request.message.deadline_ms || canonical(data.binding) !== canonical(barrierBinding(r, data.scope))) fail("SQLITE_FIXTURE_EVIDENCE_BINDING");
      }
      // All samples/validUntil values here are explicitly fixture wall-ms,
      // never process monotonic values. Persist time refusal BEFORE throwing.
      const entries = parsedCanonical(evidence);
      const expired = now >= p.request.message.deadline_ms ||
        Object.values(entries).some(parts => Object.values(parts).some(e => e.validUntil <= now)) ||
        (operation === "evidence" && data.validUntil <= now);
      timeDenied = now < Math.max(r.time_highwater, sign.time_highwater) ? "wall-rollback" : expired ? "expired" : null;
      if (timeDenied) { /* preserve all committed facts; never create qualification/claim */ }
      else if (operation === "evidence") {
        if ((data.scope === "business" && eligibility) || claim) fail("SQLITE_FIXTURE_EVIDENCE_FROZEN");
        const e = parsedCanonical(evidence);
        const entry = { kind: data.kind, timeDomain: "synthetic-wall-ms", scope: data.scope, part: data.part, bindingDigest: digest(canonical(data.binding)), validUntil: data.validUntil };
        if (e[data.scope][data.part] && canonical(e[data.scope][data.part]) !== canonical(entry)) fail("SQLITE_FIXTURE_EVIDENCE_CONFLICT");
        e[data.scope][data.part] = entry; evidence = canonical(e);
      } else if (operation === "qualify") {
        if (eligibility) fail("SQLITE_FIXTURE_QUALIFICATION_EXISTS");
        const cert = syntheticCertificate(r, "business", now);
        eligibility = canonical({ kind: "synthetic-qualification-only", timeDomain: "synthetic-wall-ms", wallClockMs: now, ownerEpoch: s.epoch,
          businessBindingDigest: r.binding_digest, businessEvidenceDigest: cert, qualificationSequence: meta.version + 1 });
      } else if (operation === "claim-test") {
        if (!eligibility) fail("SQLITE_FIXTURE_QUALIFICATION_MISSING");
        syntheticCertificate(r, "business", now); syntheticCertificate(r, "eligibility", now);
        if (claim) fail("SQLITE_FIXTURE_SYNTHETIC_CLAIM_EXISTS");
        claim = canonical({ kind: "synthetic-claim-only", timeDomain: "synthetic-wall-ms", wallClockMs: now, bindingDigest: r.binding_digest, qualificationDigest: digest(eligibility),
          testSequence: meta.version + 1 });
      } else fail("SQLITE_FIXTURE_INPUT");
      if (s.db.prepare("UPDATE fixture_barriers SET version=version+1,evidence=?,eligibility=?,synthetic_claim=?,time_highwater=MAX(time_highwater,?),terminal_reason=? WHERE attempt_id=? AND version=? AND owner_epoch=?")
        .run(evidence, eligibility, claim, now, timeDenied, id, failure === "zero-row-after-accept" ? r.version + 1 : r.version, s.epoch).changes !== 1) fail("SQLITE_FIXTURE_BARRIER_CAS_AFTER_ACCEPT");
    }
    barrierLog(s.db, meta, id, operation, failure);
    attempted = true; finish(s.db, failure);
    const result = businessDenied || barrierSummary(s.db.prepare("SELECT * FROM fixture_barriers WHERE attempt_id=?").get(id));
    return timeDenied ? { ...result, denied: "SQLITE_FIXTURE_BARRIER_TIME_TERMINAL" } : result;
  } catch (e) {
    if (attempted || ["SQLITE_FIXTURE_BARRIER_CAS_AFTER_ACCEPT", "SQLITE_FIXTURE_BARRIER_META_CAS_AFTER_ACCEPT"].includes(e.code)) { s.poisoned = true; e.outcome = "unknown"; }
    try {
      // Fixed fixture-only SQLite authorizer, never caller-supplied code. This
      // makes the actual ROLLBACK statement fail with SQLITE_AUTH, not a fake
      // wrapper return. It does NOT emulate a disk/VFS rollback I/O failure.
      if (cleanupFailure === "deny-rollback") s.db.setAuthorizer((action, verb) =>
        action === SQLITE.SQLITE_TRANSACTION && verb === "ROLLBACK" ? SQLITE.SQLITE_DENY : SQLITE.SQLITE_OK);
      s.db.exec("ROLLBACK");
    } catch (cleanup) {
      s.poisoned = true; e.outcome = "unknown"; e.cleanupError = cleanup;
    } finally {
      if (cleanupFailure === "deny-rollback") {
        try { s.db.setAuthorizer(null); }
        catch (reset) { s.poisoned = true; e.outcome = "unknown"; e.cleanupResetError = reset; }
      }
    }
    throw e;
  }
}
function signTransaction(driver, operation, input, now, options = {}) {
  const s = session(driver), { failure = "none", expectedVersion = null } = options;
  const hashFailure = ["exit-before-hash", "exit-after-hash"].includes(failure);
  if (!FAILURES.includes(failure) && !(operation === "invoke" && hashFailure)) fail("SQLITE_FIXTURE_INPUT");
  if (expectedVersion !== null) integer(expectedVersion, 1);
  let body, id, h;
  if (operation === "prepare") { body = signing.prepare(input); id = signing.inspect(body).request.attemptId; }
  else if (operation === "invoke") {
    h = signCapabilities.get(input);
    if (!h || h.driver !== driver || h.used || h.epoch !== s.epoch) fail("SQLITE_FIXTURE_CAPABILITY");
    id = h.id;
  } else { if (typeof input !== "string" || !input || input.length > 256) fail("SQLITE_FIXTURE_INPUT"); id = input; }
  integer(now);
  let commitAttempted = false, candidate, denial;
  try {
    s.db.exec("BEGIN IMMEDIATE");
    const stateRow = read(s.db); assertSession(s, stateRow);
    const { meta, rows } = signingRows(s.db);
    if (meta.version >= LIMITS.events) fail("SQLITE_FIXTURE_LIMIT");
    let r = rows.find(r => r.attempt_id === id);
    if (operation === "prepare") {
      if (rows.length >= LIMITS.attempts) fail("SQLITE_FIXTURE_LIMIT");
      if (r) fail("SQLITE_FIXTURE_SIGN_REPLAY");
      const p = signing.inspect(body);
      if (rows.some(r => r.tuple_key === p.canonicalTuple || r.effect_id === p.effectId || r.sequence_key === p.sequenceKey || r.action_key === p.canonicalAction.raw)) fail("SQLITE_FIXTURE_SIGN_RESERVED");
      r = { body, binding: signBinding(stateRow), owner_epoch: stateRow.owner_epoch };
      signGuard(stateRow, r, now);
      s.db.prepare("INSERT INTO fixture_sign_records VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'sign-prepared',NULL,0,NULL,NULL,'not-stored','unknown','none')")
        .run(id, p.canonicalTuple, p.effectId, p.sequenceKey, p.canonicalAction.raw, body, digest(body), r.binding, stateRow.owner_epoch, s.id, now);
    } else {
      if (!r) fail("SQLITE_FIXTURE_SIGN_NOT_FOUND");
      if (expectedVersion !== null && r.version !== expectedVersion) fail("SQLITE_FIXTURE_SIGN_CAS");
      let status, gate = r.gate_session;
      if (operation === "arm") {
        if (r.status !== "sign-prepared" || r.cancel_requested) fail("SQLITE_FIXTURE_SIGN_STATE");
        if (r.creator_session !== s.id) fail("SQLITE_FIXTURE_SIGN_OWNER");
        try { signGuard(stateRow, r, now); } catch (e) { denial = e; }
        status = denial ? "sign-outcome-unknown" : "sign-call-possible"; gate = s.id;
      } else if (operation === "cancel") {
        status = r.status === "sign-prepared" ? "aborted" : r.status === "sign-call-possible" ? "sign-outcome-unknown" : r.status;
      } else if (operation === "invoke") {
        if (r.status !== "sign-call-possible" || r.gate_session !== s.id || r.version !== h.version || r.cancel_requested) fail("SQLITE_FIXTURE_SIGN_STATE");
        try { signGuard(stateRow, r, now); } catch (e) { denial = e; }
        // Gate was committed by arm() in a PREVIOUS transaction. Its opaque
        // capability exists only in that winning session, only after COMMIT.
        // This transaction holds the DB writer lock through local hash+result.
        h.used = true;
        if (!denial) {
          if (failure === "exit-before-hash") process.exit(83);
          s.signCalls++;
          candidate = signing.hashPrepared(r.body); // no clock reconstruction
          if (failure === "exit-after-hash") process.exit(84);
        }
        status = denial ? "sign-outcome-unknown" : "hash-committed";
      } else fail("SQLITE_FIXTURE_INPUT");
      const changed = s.db.prepare("UPDATE fixture_sign_records SET status=?,gate_session=?,version=version+1,time_highwater=MAX(time_highwater,?),cancel_requested=?,result=?,result_digest=?,stored_result=? WHERE attempt_id=? AND version=? AND status=? AND owner_epoch=?")
        .run(status, gate, now, operation === "cancel" ? 1 : r.cancel_requested,
          candidate || r.result, candidate ? digest(candidate) : r.result_digest,
          status === "hash-committed" ? "committed-unpublishable" : "not-stored", id, r.version, r.status, s.epoch);
      if (changed.changes !== 1) fail("SQLITE_FIXTURE_SIGN_CAS");
    }
    signLog(s.db, meta, id, operation);
    commitAttempted = true; finish(s.db, hashFailure ? "none" : failure);
    const saved = s.db.prepare("SELECT * FROM fixture_sign_records WHERE attempt_id=?").get(id);
    if (denial) return { denied: denial.code, ...signSummary(saved, s.signCalls) };
    if (operation === "arm") {
      const capability = Object.freeze(Object.create(null));
      signCapabilities.set(capability, { driver, id, epoch: s.epoch, version: saved.version, used: false }); return capability;
    }
    return signSummary(saved, s.signCalls);
  } catch (e) {
    if (commitAttempted || (h && h.used)) { s.poisoned = true; e.outcome = "unknown"; }
    if (s.poisoned && h) h.used = true;
    try { s.db.exec("ROLLBACK"); } catch (cleanup) { if (!commitAttempted) { s.poisoned = true; e.outcome = "unknown"; } e.cleanupError = cleanup.message; }
    throw e;
  } finally { if (candidate) candidate.fill(0); }
}
function snapshot(row) {
  return Object.freeze({ mode: "sqlite-development-fixture", authority: false, executionAuthorized: false,
    rollbackProtected: false, databaseId: row.databaseId, rowVersion: row.row_version, ownerEpoch: row.owner_epoch,
    stateDigest: row.sha256, state: kernel.inspect(row.body) });
}
function session(driver) {
  const s = sessions.get(driver);
  if (!s || s.closed) fail("SQLITE_FIXTURE_CLOSED");
  if (s.poisoned) fail("SQLITE_FIXTURE_UNKNOWN"); return s;
}
function assertSession(s, row) { if (s.epoch !== row.owner_epoch) fail("SQLITE_FIXTURE_STALE_OWNER"); }
function owned(s, id) {
  const row = s.db.prepare("SELECT session_id FROM fixture_attempt_sessions WHERE attempt_id=?").get(id);
  if (!row || row.session_id !== s.id) fail("SQLITE_FIXTURE_ATTEMPT_OWNER");
}

// Commands already normalized before BEGIN; this function receives no hooks,
// providers or function arguments. Failpoints are fixed enums, never callbacks.
function transact(driver, commands, { expectedRowVersion = null, failure = "none", recover = false } = {}) {
  const s = session(driver);
  if (!FAILURES.includes(failure)) fail("SQLITE_FIXTURE_INPUT");
  if (expectedRowVersion !== null) integer(expectedRowVersion);
  const normalized = commands.map(c => kernel.normalizeCommand(c));
  if (normalized.some(c => c.type === "recover") !== recover || (recover && normalized.length !== 1)) fail("SQLITE_FIXTURE_INPUT");
  let begun = false, commitAttempted = false;
  try {
    s.db.exec("BEGIN IMMEDIATE"); begun = true;
    const row = read(s.db); assertSession(s, row);
    if (row.row_version >= LIMITS.events) fail("SQLITE_FIXTURE_LIMIT");
    const stale = expectedRowVersion !== null && expectedRowVersion !== row.row_version;
    const business = normalized.some(c => ["enter", "commit"].includes(c.type));
    // Administrative/admission CAS failure accepts no observation. For a
    // business command, stale version only denies business; safety is evaluated
    // independently below and stored with the CURRENT row's CAS operand.
    if (stale && !business) fail("SQLITE_FIXTURE_CAS");
    // Zero-row fault is exercised before accepting any safety observation.
    // BEGIN IMMEDIATE excludes legitimate competing writers after this point;
    // an unexpected zero after acceptance is an invariant/unknown, not refund.
    if (failure === "zero-row-cas") {
      const probe = s.db.prepare("UPDATE fixture_state SET row_version=row_version WHERE id=1 AND row_version=? AND owner_epoch=?")
        .run(row.row_version + 1, s.epoch);
      if (probe.changes !== 0) fail("SQLITE_FIXTURE_CORRUPT");
      fail("SQLITE_FIXTURE_CAS");
    }
    let body = row.body;
    for (const c of normalized) {
      // An atomic once request can reject at entry while accepting safety facts.
      // Do not turn that committed rejection into an error by forcing commit.
      if (c.type === "commit" && normalized.length > 1 &&
          kernel.inspect(body).attempts.find(a => a.request.attemptId === c.data.attemptId).status !== "commit-possible") continue;
      if (["reserve", "enter", "commit"].includes(c.type)) owned(s, c.data.attemptId);
      if (["enter", "commit"].includes(c.type)) {
        const state = kernel.inspect(body), a = state.attempts.find(a => a.request.attemptId === c.data.attemptId);
        const cp = a.request.checkpoint, actual = state.checkpoint;
        const conflict = c.type === "commit" && Object.keys(actual).some(k => cp[k] !== actual[k]);
        body = stale || conflict ? kernel.safetyOnly(body, c, stale ? "ROW_VERSION_CONFLICT" : "CHECKPOINT_CONFLICT") : kernel.transition(body, c);
      } else body = kernel.transition(body, c);
      if (c.type === "admit") s.db.prepare("INSERT INTO fixture_attempt_sessions VALUES (?,?)").run(c.data.attemptId, s.id);
    }
    // Always verify SQL's affected row count, even with BEGIN IMMEDIATE. A
    // caller's stale expected version cannot become an implicit retry.
    const expected = failure === "zero-row-after-accept" ? row.row_version + 1 : row.row_version;
    const epoch = recover ? row.owner_epoch + 1 : row.owner_epoch; integer(epoch, 1);
    if (recover) {
      const { meta } = signingRows(s.db);
      if (meta.version >= LIMITS.events) fail("SQLITE_FIXTURE_LIMIT");
      s.db.exec("UPDATE fixture_sign_records SET status='sign-outcome-unknown',version=version+1 WHERE status IN ('sign-prepared','sign-call-possible')");
      signLog(s.db, meta, null, "recover");
    }
    const changed = s.db.prepare("UPDATE fixture_state SET body=?,sha256=?,row_version=row_version+1,owner_epoch=? WHERE id=1 AND row_version=? AND owner_epoch=?")
      .run(body, digest(body), epoch, expected, s.epoch);
    if (changed.changes !== 1) { s.poisoned = true; const e = Object.assign(new Error("SQLITE_FIXTURE_CAS_AFTER_ACCEPT"), { code: "SQLITE_FIXTURE_CAS_AFTER_ACCEPT", outcome: "unknown" }); throw e; }
    s.db.prepare("INSERT INTO fixture_commits VALUES (?,?,?,?,?,?)")
      .run(row.row_version + 1, row.sha256, digest(body), epoch, normalized.map(c => c.type).join("+"), 1);
    if (failure === "engine-commit-reject") s.db.exec("INSERT INTO fixture_commit_guard VALUES(1,999)");
    if (failure === "exit-before-commit") process.exit(81);
    commitAttempted = true;
    if (failure === "throw-before-commit-call") fail("SQLITE_FIXTURE_INJECTED_COMMIT");
    s.db.exec("COMMIT"); begun = false;
    if (failure === "exit-after-commit") process.exit(82);
    if (failure === "throw-after-commit-call") fail("SQLITE_FIXTURE_INJECTED_COMMIT");
    if (recover) s.epoch = epoch;
    return snapshot({ ...row, body, sha256: digest(body), row_version: row.row_version + 1, owner_epoch: epoch });
  } catch (error) {
    if (commitAttempted) s.poisoned = true;
    if (begun) { try { s.db.exec("ROLLBACK"); } catch (cleanup) { s.poisoned = true; error.cleanupError = cleanup.message; } }
    if (commitAttempted) error.outcome = "unknown";
    throw error;
  }
}
class SqliteFixture {
  constructor(db) {
    let row;
    db.exec("BEGIN");
    try { row = read(db); db.exec("COMMIT"); }
    catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
    sessions.set(this, { db, id: randomUUID(), epoch: row.owner_epoch, poisoned: false, closed: false, signCalls: 0 });
    Object.freeze(this);
  }
  inspect() {
    const s = session(this); s.db.exec("BEGIN");
    try { const row = read(s.db); assertSession(s, row); s.db.exec("COMMIT"); return snapshot(row); }
    catch (e) { try { s.db.exec("ROLLBACK"); } catch { s.poisoned = true; } throw e; }
  }
  // General commands cannot request commit/recover or regain another session's
  // attempt. Cancel/invalidate/control are controlled competing fixture writers.
  command(input, options) {
    const c = kernel.normalizeCommand(input);
    if (["commit", "recover"].includes(c.type)) fail("SQLITE_FIXTURE_CAPABILITY");
    const result = transact(this, [c], options);
    if (c.type !== "enter" || result.state.attempts.find(a => a.request.attemptId === c.data.attemptId).status !== "commit-possible") return result;
    const h = Object.freeze(Object.create(null)); capabilities.set(h, { driver: this, id: c.data.attemptId, epoch: result.ownerEpoch, used: false });
    return h;
  }
  commit(handle, clocks, options) {
    const s = session(this), h = capabilities.get(handle);
    if (!h || h.driver !== this || h.used || h.epoch !== s.epoch) fail("SQLITE_FIXTURE_CAPABILITY");
    try { const result = transact(this, [{ type: "commit", data: { attemptId: h.id, clocks } }], options); h.used = true; return result; }
    catch (e) { if (s.poisoned) h.used = true; throw e; }
  }
  // Single transaction creates a private attempt, enters the boundary and fixes
  // its result. Used by independent contender processes, never resumes an old ID.
  consumeOnce(request, observation, clocks, options) {
    request = kernel.normalizeCommand({ type: "admit", data: request }).data;
    return transact(this, [
      { type: "admit", data: request },
      { type: "reserve", data: { attemptId: request.attemptId, version: 1, tokenId: "token-" + request.attemptId } },
      { type: "enter", data: { attemptId: request.attemptId, version: 2, clocks, observation } },
      { type: "commit", data: { attemptId: request.attemptId, clocks } },
    ], options);
  }
  // No automatic takeover on connect. Explicit fixture recovery CAS freezes old
  // observations and advances the DB epoch. This fences cooperative connections
  // only; it does not establish that a real OS process lost authority.
  recover(options = {}) { return transact(this, [{ type: "recover", data: {} }], { ...options, recover: true }); }
  prepareSigning(input, now, options) { return signTransaction(this, "prepare", input, now, options); }
  armSigning(id, now, options) {
    const result = signTransaction(this, "arm", id, now, options);
    if (result.denied) fail(result.denied); return result;
  }
  invokeSigning(handle, now, options) {
    const result = signTransaction(this, "invoke", handle, now, options);
    if (result.denied) fail(result.denied); return result;
  }
  cancelSigning(id, now, options) { return signTransaction(this, "cancel", id, now, options); }
  inspectSigning(id) {
    const s = session(this); s.db.exec("BEGIN");
    try {
      const stateRow = read(s.db); assertSession(s, stateRow);
      const rows = signingRows(s.db).rows, r = rows.find(r => r.attempt_id === id);
      if (!r) fail("SQLITE_FIXTURE_SIGN_NOT_FOUND");
      const result = signSummary(r, s.signCalls); s.db.exec("COMMIT"); return result;
    } catch (e) { try { s.db.exec("ROLLBACK"); } catch { s.poisoned = true; } throw e; }
  }
  commitBusiness(id, observation, clocks, options) { return barrierTransaction(this, "business", id, { observation, clocks }, clocks.wallClockNow, options); }
  recordSyntheticEvidence(id, evidence, now, options) { const r = barrierTransaction(this, "evidence", id, evidence, now, options); if (r.denied) fail(r.denied); return r; }
  qualifySynthetic(id, now, options) { const r = barrierTransaction(this, "qualify", id, {}, now, options); if (r.denied) fail(r.denied); return r; }
  claimSyntheticRecord(id, now, options) { const r = barrierTransaction(this, "claim-test", id, {}, now, options); if (r.denied) fail(r.denied); return r; }
  inspectBarrier(id, scope = null) {
    const s = session(this); s.db.exec("BEGIN");
    try {
      const row = read(s.db); assertSession(s, row);
      const r = barrierRows(s.db, row).rows.find(r => r.attempt_id === id);
      if (!r) fail("SQLITE_FIXTURE_INTENT_MISSING");
      const result = scope === null ? barrierSummary(r) : barrierBinding(r, scope);
      s.db.exec("COMMIT"); return result;
    } catch (e) {
      try { s.db.exec("ROLLBACK"); }
      catch (cleanup) { s.poisoned = true; e.outcome = "unknown"; e.cleanupError = cleanup; }
      throw e;
    }
  }
  // This fixture has NO trusted anchor/audit verifier, so no input or synthetic
  // qualification may reach a real publish/claim/dispatch path.
  publish() { fail("SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE"); }
  claim() { fail("SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE"); }
  dispatch() { fail("SQLITE_FIXTURE_REAL_BARRIER_UNAVAILABLE"); }
  // Called only by the controlled child after stdout's original invoke reply
  // write callback. Records a local observation, never an ACK/delivered state.
  // A crash before this bookkeeping loses evidence, so delivery stays unknown.
  recordSigningLocalSend(id, resultDigest, { failure = "none" } = {}) {
    const s = session(this);
    if (typeof id !== "string" || typeof resultDigest !== "string") fail("SQLITE_FIXTURE_INPUT");
    if (!["none", "exit-before-commit", "exit-after-commit", "throw-before-commit-call", "throw-after-commit-call", "engine-commit-reject"].includes(failure)) fail("SQLITE_FIXTURE_INPUT");
    let attempted = false;
    try {
      s.db.exec("BEGIN IMMEDIATE"); const state = read(s.db); assertSession(s, state);
      const { meta, rows } = signingRows(s.db), r = rows.find(r => r.attempt_id === id);
      if (!r || r.status !== "hash-committed" || r.creator_session !== s.id || r.result_digest !== resultDigest) fail("SQLITE_FIXTURE_DELIVERY_BINDING");
      if (meta.version >= LIMITS.events) fail("SQLITE_FIXTURE_LIMIT");
      const changed = s.db.prepare("UPDATE fixture_sign_records SET local_send_evidence='local-write-completed',version=version+1 WHERE attempt_id=? AND version=? AND result_digest=?")
        .run(id, r.version, resultDigest).changes;
      if (changed !== 1) fail("SQLITE_FIXTURE_SIGN_CAS");
      signLog(s.db, meta, id, "local-send-evidence"); attempted = true; finish(s.db, failure);
    } catch (e) {
      if (attempted) { s.poisoned = true; e.outcome = "unknown"; }
      try { s.db.exec("ROLLBACK"); } catch {} throw e;
    }
  }
  close() { const s = sessions.get(this); if (s && !s.closed) { s.db.close(); s.closed = true; } }
  static open(file) {
    const resolved = filePath(file), checked = preflight(resolved);
    // Path checks and the copied read-only preflight cannot eliminate TOCTOU.
    // Writable open can touch a replaced file before this revalidation; hostile
    // concurrent file replacement is explicitly outside this fixture boundary.
    filePath(resolved);
    const db = new DatabaseSync(resolved, { timeout: 1000 });
    try {
      const current = readTransaction(db);
      if (current.databaseId !== checked.databaseId) fail("SQLITE_FIXTURE_REPLACED");
      if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") fail("SQLITE_FIXTURE_CORRUPT");
      db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal" || db.prepare("PRAGMA synchronous").get().synchronous !== 2) fail("SQLITE_FIXTURE_FORMAT");
      return new SqliteFixture(db);
    } catch (error) { db.close(); throw error; }
  }
  static initialize(file, config) {
    const body = kernel.initial(config), resolved = filePath(file, true);
    fs.closeSync(fs.openSync(resolved, "wx", 0o600));
    const db = new DatabaseSync(resolved, { timeout: 1000 });
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
      db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA};`);
      for (const ddl of TABLES) db.exec(ddl);
      db.prepare("INSERT INTO fixture_meta VALUES(1,?,?,?,?)")
        .run(SCHEMA, kernel.semanticFormat, "purely-synthetic-no-authority-no-execution", randomUUID());
      db.prepare("INSERT INTO fixture_state VALUES(1,0,1,?,?)").run(body, digest(body));
      db.prepare("INSERT INTO fixture_sign_meta VALUES(1,?,0,?)").run(signing.semanticFormat, signDigest([]));
      db.prepare("INSERT INTO fixture_barrier_meta VALUES(1,0,?)").run(digest(canonical([])));
      db.exec("COMMIT"); return new SqliteFixture(db);
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} db.close(); throw error; }
  }
}
module.exports = Object.freeze({ SqliteFixture, APPLICATION_ID, SCHEMA });
