"use strict";
// Internal persistence primitive, NOT a freeze provider or user-facing migration
// API. Only a separately verified control-domain service may own this file.
// Business DB/anchor backups must never include or restore this authority domain.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { parse } = require("../json");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const SCHEMA = Object.freeze({
  records: "CREATE TABLE records(revision INTEGER PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL)",
  binding: "CREATE TABLE binding(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,digest TEXT NOT NULL)",
  highwater: "CREATE TABLE highwater(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,digest TEXT NOT NULL)",
  audit: "CREATE TABLE audit(revision INTEGER PRIMARY KEY,payload_digest TEXT NOT NULL)",
});
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
function fields(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) fail("MIGRATION_AUTHORITY_INVALID");
}
function text(s) { if (typeof s !== "string" || !s || s.length > 4096 || s.includes("\0")) fail("MIGRATION_AUTHORITY_INVALID"); }
function sha(s) { if (typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s)) fail("MIGRATION_AUTHORITY_INVALID"); }
function identity(value, target = false) {
  fields(value, ["generation", "db_identity", "anchor_identity", "digest", ...(target ? ["schema"] : [])]);
  for (const key of ["generation", "db_identity", "anchor_identity"]) text(value[key]); sha(value.digest);
  if (target && value.schema !== 3) fail("MIGRATION_AUTHORITY_INVALID");
}
function validate(record) {
  fields(record, ["protocol", "domain_id", "control_epoch", "revision", "previous_digest", "state", "active_generation", "attempt_id", "plan_digest", "freeze_generation", "source", "target"]);
  if (record.protocol !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1) fail("MIGRATION_AUTHORITY_INVALID");
  for (const key of ["domain_id", "control_epoch", "active_generation", "attempt_id", "freeze_generation"]) text(record[key]);
  sha(record.plan_digest); identity(record.source);
  if (record.revision === 1 ? record.previous_digest !== null : !/^[a-f0-9]{64}$/.test(record.previous_digest)) fail("MIGRATION_AUTHORITY_INVALID");
  if (!["source_disabled", "prepared", "target_disabled", "quarantined"].includes(record.state)) fail("MIGRATION_AUTHORITY_ACTIVATION_FORBIDDEN");
  if (record.target !== null) identity(record.target, true);
  if (["prepared", "target_disabled"].includes(record.state) && !record.target) fail("MIGRATION_AUTHORITY_INVALID");
  if (record.target && record.target.generation === record.source.generation) fail("MIGRATION_AUTHORITY_INVALID");
  if (record.state !== "quarantined" && record.active_generation !== (record.state === "target_disabled" ? record.target.generation : record.source.generation)) fail("MIGRATION_AUTHORITY_INVALID");
}
function initial(record) {
  validate(record);
  if (record.revision !== 1 || record.state !== "source_disabled" || record.target !== null) fail("MIGRATION_AUTHORITY_INVALID");
}
function transition(expected, next) {
  validate(expected); validate(next);
  if (next.revision !== expected.revision + 1 || next.previous_digest !== digest(canonical(expected))) fail("MIGRATION_AUTHORITY_INVALID");
  for (const key of ["domain_id", "control_epoch", "attempt_id", "plan_digest", "freeze_generation", "source"]) if (canonical(next[key]) !== canonical(expected[key])) fail("MIGRATION_AUTHORITY_INVALID");
  if (!(next.state === "quarantined" || expected.state === "source_disabled" && next.state === "prepared" || expected.state === "prepared" && next.state === "target_disabled")) fail("MIGRATION_AUTHORITY_TRANSITION_FORBIDDEN");
  if (expected.target && canonical(next.target) !== canonical(expected.target)) fail("MIGRATION_AUTHORITY_INVALID");
}
function preflightHeader(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), header = Buffer.alloc(100);
  try {
    if (fs.readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== "SQLite format 3\0" ||
        header[18] !== 1 || header[19] !== 1 || header.readUInt32BE(60) !== 1) fail("MIGRATION_AUTHORITY_UNSUPPORTED_FORMAT");
  } finally { fs.closeSync(fd); }
}
function fileIdentity(file) {
  const dir = path.dirname(file), parent = fs.lstatSync(dir), st = fs.lstatSync(file);
  if (fs.realpathSync(dir) !== dir || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) ||
      !st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) ||
      typeof process.getuid !== "function" || parent.uid !== process.getuid() || st.uid !== process.getuid()) fail("MIGRATION_AUTHORITY_UNSAFE_PATH");
  return [parent.dev, parent.ino, st.dev, st.ino].join(":");
}
class AuthorityStore {
  #db; #file; #identity; #inside = false; #readOnly = false;
  constructor(directory, { create = false } = {}) {
    this.#file = path.join(path.resolve(directory), "authority.sqlite");
    // Never create parent paths, chmod existing state, or overwrite an old DB.
    const parent = fs.lstatSync(path.dirname(this.#file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory) || (parent.mode & 0o077) || parent.uid !== process.getuid()) fail("MIGRATION_AUTHORITY_UNSAFE_PATH");
    if (create) { const fd = fs.openSync(this.#file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_WRONLY, 0o600); fs.fsyncSync(fd); fs.closeSync(fd); }
    this.#identity = fileIdentity(this.#file);
    const { DatabaseSync } = require("node:sqlite");
    if (!create) preflightHeader(this.#file);
    this.#readOnly = !create;
    this.#db = new DatabaseSync(this.#file, { timeout: 5000, readOnly: !create });
    try {
      this.#checkIdentity();
      if (create) this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
      if (create) {
        this.#db.exec("BEGIN IMMEDIATE; " + Object.values(SCHEMA).join("; ") + "; PRAGMA user_version=1; COMMIT;");
        const fd = fs.openSync(path.dirname(this.#file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); fs.fsyncSync(fd); fs.closeSync(fd);
      }
      if (this.#db.prepare("PRAGMA user_version").get().user_version !== 1) fail("MIGRATION_AUTHORITY_INVALID");
      this.read();
      if (!create) {
        // Unknown inputs are rejected before opening a writable connection.
        // A hot journal requiring recovery is refused by read-only preflight;
        // only the future control-domain recovery workflow may authorize it.
        this.#db.close(); this.#checkIdentity(); this.#readOnly = false;
        this.#db = new DatabaseSync(this.#file, { timeout: 5000 });
        this.#db.exec("PRAGMA synchronous=FULL"); this.read();
      }
    } catch (error) { try { this.#db.close(); } catch {} throw error; }
  }
  #checkIdentity() { if (fileIdentity(this.#file) !== this.#identity) fail("MIGRATION_AUTHORITY_REPLACED"); }
  read() { return this.#inside ? this.#readSnapshot() : this.#transaction(() => this.#readSnapshot()); }
  #readSnapshot() {
    this.#checkIdentity();
    // This private format has exactly these four generated definitions. Reject
    // equivalent-but-unrecognized schemas too; never run caller-supplied triggers.
    const schema = this.#db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all();
    if (schema.length !== 4 || schema.some(row => row.type !== "table" || row.tbl_name !== row.name || !Object.hasOwn(SCHEMA, row.name) || row.sql !== SCHEMA[row.name])) fail("MIGRATION_AUTHORITY_UNSUPPORTED_SCHEMA");
    const head = this.#db.prepare("SELECT * FROM binding").all(), highwater = this.#db.prepare("SELECT * FROM highwater").all();
    const history = this.#db.prepare("SELECT * FROM records ORDER BY revision").all(), audit = this.#db.prepare("SELECT * FROM audit ORDER BY revision").all();
    if (!history.length) { if (head.length || highwater.length || audit.length) fail("MIGRATION_AUTHORITY_CORRUPT"); return null; }
    if (head.length !== 1 || highwater.length !== 1 || audit.length !== history.length || canonical(head) !== canonical(highwater)) fail("MIGRATION_AUTHORITY_CORRUPT");
    let previous = null, latest, priorRecord = null;
    for (let i = 0; i < history.length; i++) {
      const row = history[i]; latest = parse(row.payload); validate(latest);
      if (row.revision !== i + 1 || latest.revision !== row.revision || row.digest !== digest(row.payload) || latest.previous_digest !== previous || canonical(latest) !== row.payload || audit[i].revision !== row.revision || audit[i].payload_digest !== row.digest) fail("MIGRATION_AUTHORITY_CORRUPT");
      if (priorRecord) transition(priorRecord, latest); else initial(latest);
      priorRecord = latest; previous = row.digest;
    }
    if (head[0].revision !== latest.revision || head[0].digest !== previous) fail("MIGRATION_AUTHORITY_CORRUPT");
    this.#checkIdentity(); return latest;
  }
  #transaction(action) {
    this.#checkIdentity(); this.#db.exec(this.#readOnly ? "BEGIN" : "BEGIN IMMEDIATE"); this.#inside = true;
    try { const result = action(); this.#checkIdentity(); this.#db.exec("COMMIT"); return result; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch (cleanup) { error.cleanupError = cleanup; } throw error; }
    finally { this.#inside = false; }
  }
  #append(record) {
    validate(record); const payload = canonical(record), hash = digest(payload);
    this.#db.prepare("INSERT INTO records VALUES(?,?,?)").run(record.revision, payload, hash);
    this.#db.prepare("INSERT INTO audit VALUES(?,?)").run(record.revision, hash);
    this.#db.prepare("INSERT INTO binding VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest").run(record.revision, hash);
    this.#db.prepare("INSERT INTO highwater VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest").run(record.revision, hash);
    return parse(payload);
  }
  initialize(record) {
    initial(record);
    return this.#transaction(() => { if (this.read() !== null) fail("MIGRATION_AUTHORITY_EXISTS"); return this.#append(record); });
  }
  compareAndSwap(expected, next) {
    validate(expected); validate(next);
    return this.#transaction(() => {
      const actual = this.read(); if (canonical(actual) !== canonical(expected)) fail("MIGRATION_AUTHORITY_CAS_CONFLICT");
      transition(expected, next);
      return this.#append(next);
    });
  }
  close() { this.#db.close(); }
}
module.exports = { AuthorityStore, canonical, digest };
