"use strict";

// Proposal R3 §5.1/5.2: observation only, deliberately not wired into upgrade.
// The caller supplies ONE explicitly resolved DB path, not a declaration,
// resolver, fs adapter, provider, receipt or gate. A string is NOT a binding.
// Node's string-path syscalls cannot exclude ancestor substitution/ABA, mounts
// or same-UID interference, even with held directories and O_NOFOLLOW. If an
// ancestor changes before the first sidecar lookup, DB lstat/open/fstat may all
// agree on the replacement: we may READ its full 100-byte header before final
// verification returns changed-unknown. This is after-the-fact detection, NOT
// read confinement; never claim the replacement was untouched or unread.
// Production requires native directory-FD-relative, confined resolution AND
// a trusted live guard for identity/isolation; neither is implemented here.
// Reads can update atime (including directory atime); do not restore timestamps.
// Bounds are bytes/syscall counts, not a timeout for regular-file/network IO.
// There is no SQLite connection, directory scan, business read, lock or write.
const fs = require("node:fs");
const path = require("node:path");

const HEADER_BYTES = 100;
const SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"]);
const MARKERS = ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"];
const active = new Set(); // Reentry refusal only; NOT cross-process exclusion.
const same = (a, b) => a === null || b === null ? a === b : MARKERS.every(k => a[k] === b[k]);

function failure(state, code) { throw Object.freeze({ preflight: true, state, code }); }
function nativeFailure(error) {
  if (error && (error.code === "EACCES" || error.code === "EPERM")) {
    return { state: "permission-unknown", code: "ERR_PERMIT_SQLITE_PERMISSION_UNKNOWN" };
  }
  return { state: "io-unknown", code: "ERR_PERMIT_SQLITE_IO_UNKNOWN" };
}
function validPath(value) {
  return typeof value === "string" && value.length > 1 && value.length <= 4096 &&
    Buffer.byteLength(value, "utf8") <= 4096 && path.isAbsolute(value) &&
    Buffer.from(value, "utf8").toString("utf8") === value &&
    !/[\x00-\x1f\x7f\\]/.test(value) && path.normalize(value) === value &&
    !value.endsWith(path.sep) && value.split(path.sep).length <= 65;
}
function fileType(st) {
  if (!st) return "absent";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "regular-file";
  if (st.isDirectory()) return "directory";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice()) return "block-device";
  if (st.isCharacterDevice()) return "character-device";
  return "other";
}
function headerHint(bytes, size) {
  if (bytes.length !== HEADER_BYTES || !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "ascii"))) return null;
  const rawPage = bytes.readUInt16BE(16), page = rawPage === 1 ? 65536 : rawPage;
  if (page < 512 || page > 65536 || (page & (page - 1)) !== 0 ||
      ![1, 2].includes(bytes[18]) || ![1, 2].includes(bytes[19]) || page - bytes[20] < 480 ||
      bytes[21] !== 64 || bytes[22] !== 32 || bytes[23] !== 32 ||
      bytes.readUInt32BE(44) > 4 || bytes.readUInt32BE(56) > 3 ||
      bytes.subarray(72, 92).some(byte => byte !== 0) ||
      size < BigInt(page) || size % BigInt(page) !== 0n) return null;
  // No page count/schema/row validation, integrity check or anchor comparison.
  // SQLite PRAGMA user_version exposes this field as a signed 32-bit integer.
  return Object.freeze({ user_version: bytes.readInt32BE(60), page_size: page });
}

function preflightPermitSqlite(databasePath) {
  let state = "observed", code = null, format = "path/runtime-unproven", migration = "unproven";
  let hint = null, sidecars = null, sidecarStatus = "unknown", cleanup = null;
  let absent = null, registered = false;
  const held = [];
  function stat(name) { return fs.lstatSync(name, { bigint: true }); }
  function optional(name) {
    try { return stat(name); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function changed() { failure("changed-unknown", "ERR_PERMIT_SQLITE_SOURCE_CHANGED"); }
  function identity(st) {
    if (!MARKERS.every(k => typeof st[k] === "bigint") || st.ino <= 0n || st.nlink <= 0n || st.size < 0n) {
      failure("identity-unknown", "ERR_PERMIT_SQLITE_IDENTITY_UNKNOWN");
    }
  }
  function open(name, directory, before) {
    identity(before);
    if (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n) {
      failure("unsafe-path-unknown", "ERR_PERMIT_SQLITE_UNSAFE_PATH");
    }
    const c = fs.constants;
    const flags = c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK | (directory ? c.O_DIRECTORY : 0);
    const fd = fs.openSync(name, flags);
    // Register immediately, before any fstat failure, and close exactly once.
    const entry = { name, fd, before };
    held.push(entry);
    if (!same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, optional(name))) changed();
    return entry;
  }
  function inspectSidecars() {
    // Only these THREE names; even symlink targets and hot journals are unread.
    return SUFFIXES.map(suffix => optional(databasePath + suffix));
  }
  function verify() {
    for (const entry of held) {
      if (!same(entry.before, fs.fstatSync(entry.fd, { bigint: true })) || !same(entry.before, optional(entry.name))) changed();
    }
    if (absent !== null && optional(absent) !== null) changed();
    const after = inspectSidecars();
    if (!sidecars.every((before, i) => same(before, after[i]))) {
      sidecarStatus = "changed-unknown";
      changed();
    }
  }
  try {
    if (arguments.length !== 1 || !validPath(databasePath)) failure("invalid-input", "ERR_PERMIT_SQLITE_INPUT");
    // Capability probe ONLY; no constructor or SQL, and no imported store code.
    if (Number(process.versions.node.split(".")[0]) < 24) failure("runtime-unsupported", "ERR_PERMIT_SQLITE_RUNTIME_UNSUPPORTED");
    let sqlite;
    try { sqlite = require("node:sqlite"); } catch { failure("runtime-unsupported", "ERR_PERMIT_SQLITE_RUNTIME_UNSUPPORTED"); }
    if (typeof sqlite.DatabaseSync !== "function") failure("runtime-unsupported", "ERR_PERMIT_SQLITE_RUNTIME_UNSUPPORTED");
    const c = fs.constants;
    if (!["darwin", "linux"].includes(process.platform) || !Number.isInteger(c.O_RDONLY) ||
        ![c.O_NOFOLLOW, c.O_DIRECTORY, c.O_NONBLOCK].every(n => Number.isInteger(n) && n !== 0)) {
      failure("path-unsupported", "ERR_PERMIT_SQLITE_READER_UNSUPPORTED");
    }
    if (active.has(databasePath)) failure("concurrent-unknown", "ERR_PERMIT_SQLITE_REENTRY");
    active.add(databasePath); registered = true;

    // Walk each lexical ancestor, refusing symlinks. These are still STRING
    // lookups, not openat2/RESOLVE_BENEATH, and do not enforce confinement.
    const parents = [];
    for (let dir = path.dirname(databasePath); ; dir = path.dirname(dir)) {
      parents.unshift(dir);
      if (dir === path.dirname(dir)) break;
    }
    for (const dir of parents) {
      const before = optional(dir);
      if (before === null) { absent = dir; break; }
      open(dir, true, before);
    }
    sidecars = inspectSidecars();
    sidecarStatus = sidecars.some(Boolean) ? "observed-present" : "absent-unproven";
    const before = absent === null ? optional(databasePath) : null;
    if (before === null) {
      absent = absent === null ? databasePath : absent;
      state = "missing"; format = "missing";
    } else {
      const file = open(databasePath, false, before), bytes = Buffer.alloc(HEADER_BYTES);
      const limit = Number(before.size < BigInt(HEADER_BYTES) ? before.size : BigInt(HEADER_BYTES));
      let used = 0;
      while (used < limit) {
        const count = fs.readSync(file.fd, bytes, used, limit - used, used);
        if (!Number.isInteger(count) || count <= 0 || count > limit - used) changed();
        used += count;
      }
      hint = headerHint(bytes.subarray(0, used), before.size);
      if (!hint) format = "corrupt-header";
      else if (hint.user_version === 1) { format = "schema1-needs-migration"; migration = "required-unproven"; }
      else if (hint.user_version === 2) format = "schema2-header-only";
      else if (hint.user_version === 3) { format = "schema3-development-authority-unsupported"; migration = "unsupported"; }
      else { format = "unknown-schema"; migration = "unsupported"; }
    }
    verify(); // Point observations only, not freshness through close/return.
    // Never retry until a superficially passing observation appears.
  } catch (error) {
    const problem = error && error.preflight === true ? error : nativeFailure(error);
    state = problem.state; code = problem.code;
    hint = null; format = "path/runtime-unproven"; migration = "unproven";
  } finally {
    while (held.length) {
      const entry = held.pop();
      try { fs.closeSync(entry.fd); }
      catch { cleanup = "ERR_PERMIT_SQLITE_CLOSE_UNKNOWN"; }
      // Do not retry close: it may have released the FD before throwing, and
      // that number may now belong to another observer. Leak is also possible.
    }
    if (registered) active.delete(databasePath);
  }
  if (cleanup) {
    if (!code) { state = "close-unknown"; code = cleanup; }
    hint = null; format = "path/runtime-unproven"; migration = "unproven";
  }
  // No paths, OS messages, raw bytes, inode/owner identifiers or caller fields.
  // All states, INCLUDING missing/absent sidecars/schema2, remain blocked.
  return Object.freeze({
    status: "partial", ok: false, blocked: true, executionAuthorized: false,
    scope: "header-only", snapshot_assurance: "snapshot-unproven",
    snapshot_status: "sqlite_snapshot_unproven", path_binding: "path_binding_unproven",
    replacement_object_access: "not-excluded", atime_effect: "may-change",
    observation_status: state, error_code: code, cleanup_error_code: cleanup,
    format_status: format, migration_status: migration, deployment_status: "unproven",
    authority_scope: hint && hint.user_version === 3 ? "separately-configured-development-authority-outside-migration-scope" : null,
    header: hint,
    sidecar_status: sidecarStatus,
    sidecars: Object.freeze(SUFFIXES.map((suffix, i) => Object.freeze({ suffix, type: sidecars ? fileType(sidecars[i]) : "unknown" }))),
  });
}

module.exports = { preflightPermitSqlite };
