"use strict";

// Route A CONTENT PREPARATION ONLY. This consumes an inert, serialized capture,
// never a live source path or caller-supplied evidence/validator/key/capability.
// A future managed bootstrap must authenticate the archive AND this exact capture
// and establish freshness, nonce consumption, fence, gate and external history.
// Digests below are content bindings, not credentials. Repeated calls are allowed
// and confer no execution right. Do not use this result as migration admission.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { types: { isProxy, isUint8Array } } = require("node:util");
const { parse } = require("../offline-migration/json");
const core = require("./permit-legacy-migration-core");

const ANCHOR_SOURCE_SHA256 = "24627d5f413da24937e2833d0dc22cc2522e55bd35a9546ef5459ddf1ba17bb4";
const LIMITS = Object.freeze({ inputBytes: 16 * 1024 * 1024, totalBytes: 8 * 1024 * 1024,
  databaseBytes: 4 * 1024 * 1024, fileBytes: 1024 * 1024, files: core.LIMITS.records + 3,
  records: core.LIMITS.records, depth: 16 });
const WATER = "anchor/protected-anchor-high-water.log", AUDIT = "anchor/protected-anchor-audit.log";
const DDL = "CREATE TABLE protected_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, sha256 TEXT NOT NULL)";
const BLOCKERS = Object.freeze(["managed-bootstrap-trust-root-missing", "archive-provenance-unverified",
  "trusted-directory-capture-unverified", "atomic-snapshot-unverified", "latest-head-unverified",
  "nonce-atomic-consumption-unverified", "old-writer-fence-unverified", "deployment-gate-unverified",
  "external-pin-revocation-history-unverified", "ordinary-migration-durability-cap-missing"]);
const diagnostics = new WeakMap();
const archiveErrors = new WeakSet();
const normalizedErrors = new WeakSet();
const CoreError = core.LegacyPermitMigrationError;
const coreErrorPrototype = core.LegacyPermitMigrationError.prototype;
const CORE_CODES = new Set(["EVIDENCE", "IDENTITY", "INPUT", "JSON", "LIMIT", "ORPHAN", "SOURCE_FORMAT", "STATE", "UNRESOLVED"]
  .map(code => "ERR_LEGACY_MIGRATION_" + code));
const ERROR_CODES = new Set(["INPUT", "FORMAT", "LIMIT", "UTF8", "JSON", "BASE64", "RECORDS", "NAMESPACE",
  "SCRATCH", "SCRATCH_CHANGED", "SQL_FORMAT", "SQL_ENCODING", "SQLITE", "SQLITE_UNAVAILABLE", "SQL_SCHEMA",
  "SQL_VERSION", "SQL_INTEGRITY", "SQL_ROW", "WRITE", "CLOSE", "INTERNAL", "JOURNAL_NAME", "JOURNAL_BYTES", "ARCHIVE_BYTES", "REPLAY_BYTES"]
  .map(code => "ERR_LEGACY_ARCHIVE_" + code));
class LegacyArchiveEvidenceError extends Error {
  constructor(code, cause) {
    const safeCode = ERROR_CODES.has(code) ? code : "ERR_LEGACY_ARCHIVE_INPUT";
    super(safeCode); this.name = "LegacyArchiveEvidenceError"; this.code = safeCode;
    // Even nonenumerable cause and normal Error.stack leak via util.inspect.
    // No raw object, private stack or artifact location lives on this Error.
    this.stack = this.name + ": " + safeCode;
    diagnostics.set(this, { cause });
    archiveErrors.add(this);
  }
}
/** Explicit same-process diagnostics, NOT an authorization/capability boundary.
 * Returns exact raw exceptions, which may contain secrets. Never log this value
 * in ordinary logs. Any code holding the Error can request it; no trust implied.
 */
function getLegacyArchiveErrorDiagnostics(error) {
  const d = diagnostics.get(error);
  return d ? Object.freeze({ ...d }) : undefined;
}
function retainScratch(error, scratch) {
  const d = diagnostics.get(error) || { stack: error.stack };
  diagnostics.set(error, { ...d, scratch: Object.freeze({ ...scratch }) });
  // Strict core errors contain stable codes but their native stack has paths.
  error.stack = error.name + ": " + error.code;
}
function fail(code) { throw new LegacyArchiveEvidenceError("ERR_LEGACY_ARCHIVE_" + code); }
function failure(error, code) {
  return cleanError(error, code);
}
function isCoreError(error) {
  // No instanceof or Symbol.hasInstance. Walk only ordinary prototypes and stop
  // BEFORE asking any Proxy (including a revoked one) for its prototype.
  let current = error;
  for (let i = 0; i < 32 && current && (typeof current === "object" || typeof current === "function"); i++) {
    if (isProxy(current)) return false;
    current = Object.getPrototypeOf(current);
    if (current === coreErrorPrototype) return true;
  }
  return false;
}
function boundaryFailure(error) {
  return cleanError(error, "INTERNAL");
}
function stableCode(error, allowed) {
  // Never evaluate a code accessor, even on a genuine known Error instance.
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && Object.hasOwn(descriptor, "value") && allowed.has(descriptor.value) ? descriptor.value : undefined;
}
function cleanSingle(error, fallback) {
  const own = archiveErrors.has(error), knownCore = !own && isCoreError(error);
  const code = own ? stableCode(error, ERROR_CODES) : knownCore ? stableCode(error, CORE_CODES) : undefined;
  const safe = knownCore && code ? new CoreError(code) : new LegacyArchiveEvidenceError(code || "ERR_LEGACY_ARCHIVE_" + fallback);
  safe.stack = safe.name + ": " + safe.code;
  // Copy only private metadata of our previous normalized wrapper. External
  // known Errors are still raw input: preserve their exact identity privately,
  // never their message, stack, cause, custom fields, getters or inspect hooks.
  const previous = normalizedErrors.has(error) ? diagnostics.get(error) : undefined;
  const d = previous ? { ...previous } : { cause: error };
  diagnostics.set(safe, d); normalizedErrors.add(safe);
  return safe;
}
function cleanError(error, code) {
  const safe = cleanSingle(error, code);
  // Never rethrow an arbitrary object after changing only its stack. Preserve
  // each raw cleanup failure privately; copy only a bounded sanitized data chain,
  // without invoking arbitrary cleanup getters or reflecting secret fields.
  const seen = new Set([error]); let raw = error, tail = safe;
  for (let i = 0; i < 16 && raw && (typeof raw === "object" || typeof raw === "function"); i++) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(raw, "cleanupError"); }
    catch (inspectionError) {
      // Keep the primary and any already recovered cleanup layers. A failing
      // descriptor trap is diagnostic-only; it must never escape this boundary.
      const d = diagnostics.get(safe);
      diagnostics.set(safe, { ...d, inspectionError });
      break;
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.value || seen.has(descriptor.value)) break;
    raw = descriptor.value; seen.add(raw);
    tail.cleanupError = cleanSingle(raw, "CLOSE"); tail = tail.cleanupError;
  }
  return safe;
}
function cleanupFailure(primary, cleanup) {
  if (!primary) return cleanup;
  let tail = primary;
  while (tail.cleanupError) tail = tail.cleanupError;
  tail.cleanupError = cleanup;
  return primary;
}
function withDescriptor(fd, operation, code) {
  let value, raw, closeRaw, failed = false, closeFailed = false;
  // Closing precedes ALL error classification/diagnostic reflection. Even a
  // classifier failure must never bypass this one mandatory close attempt.
  try { value = operation(fd); } catch (e) { raw = e; failed = true; }
  finally { try { fs.closeSync(fd); } catch (e) { closeRaw = e; closeFailed = true; } }
  let error = failed ? failure(raw, code) : undefined;
  if (closeFailed) error = cleanupFailure(error, failure(closeRaw, "CLOSE"));
  if (error) throw error;
  return value;
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) fail("FORMAT");
}
function json(text, max = LIMITS.fileBytes) {
  if (typeof text !== "string") fail("INPUT");
  if (text.length > max || Buffer.byteLength(text) > max) fail("LIMIT");
  if (Buffer.from(text).toString("utf8") !== text) fail("UTF8");
  let depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (quoted && text[i] === "\\") { i++; continue; }
    if (text[i] === '"') { quoted = !quoted; continue; }
    if (!quoted && (text[i] === "{" || text[i] === "[")) { if (++depth > LIMITS.depth) fail("LIMIT"); }
    if (!quoted && (text[i] === "}" || text[i] === "]")) depth--;
  }
  try { return parse(text); } catch { fail("JSON"); }
}
function decode(value, max) {
  if (typeof value !== "string") fail("FORMAT");
  if (value.length > Math.ceil(max / 3) * 4) fail("LIMIT");
  if (!value.length || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail("BASE64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > max) fail("LIMIT");
  if (bytes.toString("base64") !== value) fail("BASE64");
  return bytes;
}
function utf8(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) fail("UTF8");
  return text;
}
function records(bytes) {
  const text = utf8(bytes);
  if (!text.endsWith("\n")) fail("RECORDS");
  const lines = text.slice(0, -1).split("\n");
  if (!lines.length || lines.length > LIMITS.records) fail("LIMIT");
  // No filtering of blank, retry, abort, unknown or malformed records.
  return lines.map(line => json(line));
}
function snapshot(encoded) {
  const s = json(encoded, LIMITS.inputBytes);
  exact(s, ["format_version", "snapshot_id", "producer_store_sha256", "producer_anchor_sha256", "files", "archive_high_water_base64"]);
  if (s.format_version !== 1 || typeof s.snapshot_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(s.snapshot_id) ||
      s.producer_store_sha256 !== core.FROZEN_SOURCE_SHA256 || s.producer_anchor_sha256 !== ANCHOR_SOURCE_SHA256) fail("FORMAT");
  if (!Array.isArray(s.files) || s.files.length < 3 || s.files.length > LIMITS.files) fail("LIMIT");
  const files = new Map(), manifest = []; let total = 0;
  for (const item of s.files) {
    exact(item, ["path", "bytes_base64"]);
    const name = item.path;
    if (typeof name !== "string" || files.has(name)) fail("NAMESPACE");
    // The initial independently supported subset is an already checkpointed DB.
    // Reject all sidecars/unknown names BEFORE opening SQLite; never drop them.
    if (name !== "db/state.sqlite" && name !== WATER && name !== AUDIT &&
        !/^anchor\/protected-anchor-entry-\d{12}-\d{6}-(intent|commit|abort)-[a-f0-9]{16}\.json$/.test(name)) fail("NAMESPACE");
    const bytes = decode(item.bytes_base64, name === "db/state.sqlite" ? LIMITS.databaseBytes : LIMITS.fileBytes);
    total += bytes.length; if (total > LIMITS.totalBytes) fail("LIMIT");
    files.set(name, bytes); manifest.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const name of ["db/state.sqlite", WATER, AUDIT]) if (!files.has(name)) fail("NAMESPACE");
  const archive = decode(s.archive_high_water_base64, LIMITS.fileBytes);
  if (total + archive.length > LIMITS.totalBytes) fail("LIMIT");
  manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { id: s.snapshot_id, files, manifest, archive };
}
function directoryIdentity(file) {
  const s = fs.lstatSync(file);
  if (!s.isDirectory() || s.isSymbolicLink()) fail("SCRATCH");
  return [s.dev, s.ino, s.mode, s.uid, s.gid].join(":");
}
function runtimeBoundary(trustedProjectRoot) {
  if (typeof trustedProjectRoot !== "string" || !path.isAbsolute(trustedProjectRoot) ||
      path.resolve(trustedProjectRoot) !== trustedProjectRoot || trustedProjectRoot.includes("\0")) fail("SCRATCH");
  const runtime = path.join(trustedProjectRoot, ".agent", "runtime"), chain = [];
  for (let p = runtime; ; p = path.dirname(p)) {
    chain.push([p, directoryIdentity(p)]);
    if (path.dirname(p) === p) break;
  }
  const check = () => {
    for (const [p, identity] of chain) if (directoryIdentity(p) !== identity) fail("SCRATCH_CHANGED");
  };
  return { runtime, check };
}
function ownedFile(file, identity) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.dev !== identity[0] || s.ino !== identity[1]) fail("SCRATCH_CHANGED");
}
function readDatabase(bytes, trustedProjectRoot) {
  // Bound the declared page count BEFORE native SQLite traverses the file.
  if (bytes.length < 100 || bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0") fail("SQL_FORMAT");
  let pageSize = bytes.readUInt16BE(16); if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) || bytes.length % pageSize ||
      bytes.readUInt32BE(28) !== bytes.length / pageSize) fail("SQL_FORMAT");
  // This is a private disposable work copy, never a trusted source collector.
  // Native SQLite parsing is bounded by input sizes, not a hostile-code sandbox
  // or a hard CPU/RSS deadline. The managed host must provide that isolation.
  // lstat bracketing detects observed replacement, NOT hostile ancestor ABA.
  // Callers MUST provide a host-controlled project/runtime path whose ancestors
  // cannot be concurrently replaced by untrusted writers. JS path APIs do not
  // supply openat/unlinkat confinement; this is never an authorization boundary.
  let boundary, work, workIdentity, file, fileIdentity, db, result, error;
  try {
    boundary = runtimeBoundary(trustedProjectRoot); boundary.check();
    work = fs.mkdtempSync(path.join(boundary.runtime, "permit-legacy-archive-"));
    workIdentity = directoryIdentity(work); boundary.check();
    file = path.join(work, "state.sqlite");
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    withDescriptor(fd, () => {
      const s = fs.fstatSync(fd); fileIdentity = [s.dev, s.ino];
      fs.writeFileSync(fd, bytes);
    }, "WRITE");
    let DatabaseSync;
    try { ({ DatabaseSync } = require("node:sqlite")); } catch { fail("SQLITE_UNAVAILABLE"); }
    boundary.check();
    if (directoryIdentity(work) !== workIdentity) fail("SCRATCH_CHANGED");
    ownedFile(file, fileIdentity);
    // The closed capture has no sidecars. immutable applies ONLY to our fixed
    // disposable copy: it prevents read-only WAL databases creating WAL/SHM.
    // Never open a live source using immutable or infer source quiescence here.
    db = new DatabaseSync(pathToFileURL(file).href + "?immutable=1", { readOnly: true, allowExtension: false });
    db.exec("PRAGMA trusted_schema=OFF"); db.exec("PRAGMA query_only=ON");
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name LIMIT 2").all().map(r => ({ ...r }));
    if (JSON.stringify(objects) !== JSON.stringify([{ type: "table", name: "protected_state", tbl_name: "protected_state", sql: DDL }])) fail("SQL_SCHEMA");
    if (db.prepare("PRAGMA user_version").get().user_version !== 1 || db.prepare("PRAGMA application_id").get().application_id !== 0) fail("SQL_VERSION");
    if (db.prepare("PRAGMA integrity_check(1)").get().integrity_check !== "ok") fail("SQL_INTEGRITY");
    // CAST to BLOB returns the actual stored TEXT bytes without Node's lossy
    // UTF-8 text decoding. Reject other storage classes and UTF-16 databases;
    // otherwise CAST could transcode instead of preserving original bytes.
    if (bytes.readUInt32BE(56) !== 1) fail("SQL_ENCODING");
    const rows = db.prepare("SELECT id,typeof(body) AS body_type,CAST(body AS BLOB) AS body_bytes,sha256 FROM protected_state LIMIT 2").all();
    if (rows.length !== 1 || rows[0].id !== 1 || rows[0].body_type !== "text" ||
        !isUint8Array(rows[0].body_bytes) || rows[0].body_bytes.byteLength > core.LIMITS.bodyBytes ||
        typeof rows[0].sha256 !== "string") fail("SQL_ROW");
    const bodyBytes = Buffer.from(rows[0].body_bytes), body = utf8(bodyBytes);
    if (hash(bodyBytes) !== rows[0].sha256) fail("SQL_ROW");
    result = { user_version: 1, body, sha256: rows[0].sha256 };
    boundary.check();
    if (directoryIdentity(work) !== workIdentity) fail("SCRATCH_CHANGED");
    ownedFile(file, fileIdentity);
    const readFd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    withDescriptor(readFd, () => {
      const s = fs.fstatSync(readFd);
      if (s.dev !== fileIdentity[0] || s.ino !== fileIdentity[1] || !fs.readFileSync(readFd).equals(bytes)) fail("SCRATCH_CHANGED");
    }, "SQLITE");
  } catch (e) {
    error = failure(e, "SQLITE");
  } finally {
    try { if (db) db.close(); } catch (e) { error = cleanupFailure(error, failure(e, "CLOSE")); }
    // NO path-based deletion, on success OR failure. An inode check followed by
    // unlink is still a race; JS cannot prove exclusive OS ownership. Preserve
    // the artifact for a separately governed cleanup under real host isolation.
    // This is retention, not a cleanup failure; actual close failures stay errors.
    if (work) {
      const scratch = { relativePath: path.relative(trustedProjectRoot, work), retained: true,
        cleanup: "not-attempted-no-os-exclusivity" };
      if (error) retainScratch(error, scratch); else result = { source: result, scratch };
    }
  }
  if (error) throw error;
  return result;
}
function evidence(captured, source) {
  const state = json(source.body, core.LIMITS.bodyBytes), journal = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("FORMAT");
  for (const [name, bytes] of captured.files) if (name.startsWith("anchor/protected-anchor-entry-")) {
    const entry = json(utf8(bytes));
    exact(entry, ["schema_version", "type", "sequence", "body_digest", "store_id", "attempt", "entry_digest"]);
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 ||
        !["intent", "commit", "abort"].includes(entry.type)) fail("JOURNAL_NAME");
    if (utf8(bytes) !== JSON.stringify(entry) + "\n") fail("JOURNAL_BYTES");
    const expected = `anchor/protected-anchor-entry-${String(entry.sequence).padStart(12, "0")}-${String(entry.attempt).padStart(6, "0")}-${entry.type}-${hash(bytes).slice(0, 16)}.json`;
    if (name !== expected) fail("JOURNAL_NAME");
    journal.push(entry);
  }
  journal.sort((a, b) => a.sequence - b.sequence || a.attempt - b.attempt || (a.type < b.type ? -1 : 1));
  return { format_version: 1, source,
    expected: { decision_id: state.decision_id, store_id: state.store_id, body_digest: source.sha256, anchor_sequence: state.anchor_sequence },
    journal, high_water: records(captured.files.get(WATER)), audit: records(captured.files.get(AUDIT)) };
}
function replay(full) {
  // Fixed 1.15.7 appendHighWater/compactHighWaterIfNeeded success semantics,
  // pinned above. No dynamic import/eval of archived or installed code. Check
  // size BEFORE append; select 63 RECORDS excluding max, then retain ALL
  // occurrences of their sequences, in file order (not 64 distinct sequences).
  let retained = [], size = 0, compactions = 0;
  const line = entry => {
    const r = { sequence: entry.sequence, body_digest: entry.body_digest, store_id: entry.store_id, attempt: entry.attempt };
    r.record_digest = hash([r.sequence, r.body_digest, r.store_id, r.attempt].join("\n"));
    return JSON.stringify(r) + "\n";
  };
  for (const entry of full) {
    if (size >= 262144) {
      const mark = Math.max(...retained.map(r => r.sequence)), kept = new Set([mark]);
      for (const r of retained.filter(r => r.sequence !== mark).sort((a, b) => b.sequence - a.sequence).slice(0, 63)) kept.add(r.sequence);
      retained = retained.filter(r => kept.has(r.sequence));
      size = retained.reduce((n, r) => n + Buffer.byteLength(line(r)), 0); compactions++;
    }
    retained.push(entry); size += Buffer.byteLength(line(entry));
  }
  return { bytes: Buffer.from(retained.map(line).join("")), compactions };
}

/**
 * Prepare a Route A candidate from ONE serialized captured byte set plus its
 * complete archive. files is the closed DB/anchor namespace, not a recursive
 * project backup. trustedProjectRoot must be host-controlled, with an existing
 * .agent/runtime and NO symlink in ANY ancestor. Only its .agent/runtime is used.
 * Ancestors must be protected against concurrent replacement: JS checks cannot
 * prove that protection or defeat hostile ABA. Never use an untrusted path.
 * Scratch is ALWAYS retained; no automatic unlink/rmdir is attempted without
 * OS exclusivity proof. Returned scratch metadata identifies the local artifact.
 * Raw causes and error scratch paths are private; explicit diagnostics can expose
 * them to same-process callers and grant no authorization. Default errors contain
 * stable codes and sanitized stacks, including the recursive cleanupError chain.
 * No source reads/writes, receipt verification, CAS, nonce consumption or switch.
 * Unsupported SQL/sidecars/history fail closed. Call only in an isolated host
 * when processing hostile SQLite; file-size limits do not replace OS isolation.
 */
function prepareLegacyArchiveEvidence(encodedSnapshot, trustedProjectRoot) {
  let scratch;
  try {
    const captured = snapshot(encodedSnapshot);
    const database = readDatabase(captured.files.get("db/state.sqlite"), trustedProjectRoot);
    scratch = database.scratch;
    return freeze({ ...prepareCaptured(captured, database.source, encodedSnapshot), scratch });
  } catch (error) {
    const safe = boundaryFailure(error);
    if (scratch) retainScratch(safe, scratch);
    throw safe;
  }
}
function prepareCaptured(captured, source, encodedSnapshot) {
  const input = evidence(captured, source);
  let direct;
  try {
    core.prepareLegacyPermitMigration(JSON.stringify(input));
    direct = { status: "prepared-only" };
  } catch (error) {
    if (!isCoreError(error) || stableCode(error, CORE_CODES) !== "ERR_LEGACY_MIGRATION_EVIDENCE") throw error;
    direct = { status: "rejected", code: "ERR_LEGACY_MIGRATION_EVIDENCE" };
  }
  const full = records(captured.archive);
  const recovered = JSON.stringify({ ...input, high_water: full });
  const prepared = core.prepareLegacyPermitMigration(recovered); // strict core unchanged
  // Archive must be the ORIGINAL append stream, not just equivalent JSON.
  if (full.map(r => JSON.stringify(r) + "\n").join("") !== utf8(captured.archive)) fail("ARCHIVE_BYTES");
  const replayed = replay(full);
  if (!replayed.bytes.equals(captured.files.get(WATER))) fail("REPLAY_BYTES");
  return freeze({ status: "prepared-only", authority: false, executionAuthorized: false,
    authenticated: false, trustedCaptureProven: false, atomicSnapshotProven: false,
    freshnessProven: false, singleUseProven: false, oldWriterFenceProven: false, gateProven: false,
    blockers: BLOCKERS, directSource: direct, snapshot_id: captured.id,
    binding: { domain: "permit-legacy-archive-content-v1", snapshot_sha256: hash(encodedSnapshot),
      source_manifest_sha256: hash(JSON.stringify(captured.manifest)), archive_sha256: hash(captured.archive),
      source_high_water_sha256: hash(captured.files.get(WATER)), recovered_evidence_sha256: hash(recovered),
      target_body_sha256: prepared.target.sha256, producer_store_sha256: core.FROZEN_SOURCE_SHA256,
      producer_anchor_sha256: ANCHOR_SOURCE_SHA256 },
    replay: { exactBytesMatched: true, compactions: replayed.compactions, archiveRecords: full.length },
    // Keep reconstructed evidence separate from the actual compressed source.
    // This is content for future authenticated admission, NOT an execution cap.
    recoveredEvidence: recovered, prepared });
}

module.exports = { LIMITS, ANCHOR_SOURCE_SHA256, LegacyArchiveEvidenceError, prepareLegacyArchiveEvidence, getLegacyArchiveErrorDiagnostics };
