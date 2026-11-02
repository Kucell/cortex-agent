"use strict";

// One stable lock domain spans the business DB commit and its external witnesses.
// SQLite releases this lock on process death. Never unlink it to clear contention.
const fs = require("node:fs");
const path = require("node:path");
const FILE = "protected-store-coordination.sqlite";
const TIMEOUT_MS = 5000;
function fail(code) { throw Object.assign(new Error(code), { code }); }

// The lock domain must not be reachable through a redirected path. A plain
// `realpathSync(dir) !== dir` comparison cannot express that: on macOS the
// system temporary directory lives under /var, which is itself a symbolic
// link to /private/var, so the comparison is false for every anchor built
// under the temporary directory and the domain would be refused for a reason
// that has nothing to do with an attack.
//
// Walk the original path with dirname so drive letters and UNC share roots
// remain intact. On POSIX only, preserve the platform namespace exception
// ("/tmp" and "/var" on macOS); Windows ancestors have no such exception.
//
// Redirecting the lock file itself remains detected: the identity is built
// from the device and inode of the directory and of the lock file, so a
// replaced domain is caught by `expectedIdentity` even when the path still
// resolves.
function assertAnchorPathIsNotRedirected(dir) {
  let component = path.resolve(dir);
  // path.win32.parse treats \\?\UNC\ as the root. The filesystem root is
  // the share; walking above it would stat an incomplete server-only path.
  const uncRoot = process.platform === "win32" && /^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?=\\|$)/i.exec(component);
  const root = uncRoot ? uncRoot[0] : path.parse(component).root;
  while (component !== root) {
    const parent = path.dirname(component);
    if (process.platform !== "win32" && parent === root) break;
    let componentStat;
    try { componentStat = fs.lstatSync(component); }
    catch { fail("ERR_COORDINATION_LOCK_UNSAFE"); }
    if (!componentStat.isDirectory() || componentStat.isSymbolicLink()) fail("ERR_COORDINATION_LOCK_UNSAFE");
    component = parent;
  }
}

// Windows mode bits do not describe the DACL. Read the native adapter rather
// than accepting a caller's platform/adapter override as evidence that a lock
// is private. The store separately checks the declared service identity.
function assertWindowsFilePermissions(filePath) {
  const authz = require("./anchor-authorization");
  const adapter = authz.adapterFor("windows");
  const caller = adapter.currentIdentity();
  const owner = adapter.ownerIdentity(filePath);
  const writers = adapter.writableIdentities(filePath);
  if (!caller || !owner || !(writers instanceof Set)) fail("ERR_ANCHOR_AUTHORIZATION_UNKNOWN");
  if (owner !== caller) fail("ERR_ANCHOR_OWNERSHIP");
  if (writers.has(authz.ANY_IDENTITY)) fail("ERR_ANCHOR_PERMISSIONS");
  if (!writers.has(caller)) fail("ERR_ANCHOR_WRITER_SET");
  const extra = [...writers].filter((identity) => identity !== caller);
  if (extra.some((identity) => !authz.isServiceVirtualAccountSid(identity))) fail("ERR_ANCHOR_WRITER_SET");
  if (extra.length > 0) {
    const groups = adapter.currentGroups();
    if (!(groups instanceof Set)) fail("ERR_ANCHOR_AUTHORIZATION_UNKNOWN");
    if (extra.some((identity) => !groups.has(identity))) fail("ERR_ANCHOR_WRITER_SET");
  }
}

function identity(dir) {
  const parent = fs.lstatSync(dir);
  const file = fs.lstatSync(path.join(dir, FILE));
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
      (process.platform !== "win32" && ((file.mode & 0o077) !== 0 ||
       (typeof process.getuid === "function" && file.uid !== process.getuid())))) {
    fail("ERR_COORDINATION_LOCK_UNSAFE");
  }
  if (process.platform === "win32") assertWindowsFilePermissions(path.join(dir, FILE));
  assertAnchorPathIsNotRedirected(dir);
  // Even a read-only SQLite open can write shared memory or recover a journal.
  // SQLite may replace its own sidecars, so recheck their safety without
  // binding their inodes to the stable identity of the lock domain.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    let stat;
    try { stat = fs.lstatSync(path.join(dir, FILE) + suffix); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      fail("ERR_COORDINATION_LOCK_UNSAFE");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("ERR_COORDINATION_LOCK_UNSAFE");
  }
  return [parent.dev, parent.ino, file.dev, file.ino].join(":");
}

function prepareMainFileLock(db) {
  // WAL's writer lock lives in replaceable shared memory. EXCLUSIVE locking
  // mode also locks the stable main file until close, even if SHM is replaced.
  // Leave rollback-mode locking unchanged so ordinary shared readers can run.
  if (db.prepare("PRAGMA journal_mode").get().journal_mode === "wal") db.exec("PRAGMA locking_mode=EXCLUSIVE");
}

function assertMainFileLock(db) {
  // A mode switch between inspection and BEGIN must not admit an action under
  // a WAL-only lock. Inspect again inside the transaction, before any callback.
  if (db.prepare("PRAGMA journal_mode").get().journal_mode === "wal" &&
      db.prepare("PRAGMA locking_mode").get().locking_mode !== "exclusive") fail("ERR_COORDINATION_BUSY");
}

// A read-only check of the lock domain's own version.
//
// The version is written INSIDE the transaction that creates the lock, so a
// failed action rolls it back and leaves the lock permanently uninitialised.
// That is the intended fail-closed behaviour, but it also means the caller
// has to learn about it before it starts any other work: a caller that
// inspects the domain first would report a less specific reason and hide
// the real one. The check is read-only, so it does not create, replace or
// modify the lock.
function assertLockInitialized(dir) {
  dir = path.resolve(dir);
  const file = path.join(dir, FILE);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") fail("ERR_COORDINATION_LOCK_MISSING");
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("ERR_COORDINATION_LOCK_UNSAFE");
  const before = identity(dir);
  const { DatabaseSync } = require("node:sqlite");
  let db;
  try { db = new DatabaseSync(file, { readOnly: true, timeout: TIMEOUT_MS }); }
  catch { fail("ERR_COORDINATION_LOCK_UNSAFE"); }
  let locked = false;
  try {
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    db.exec("BEGIN");
    locked = true;
    // BEGIN is deferred; reading the version acquires the shared lock.
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    if (version !== 1) fail("ERR_COORDINATION_LOCK_INVALID");
    db.exec("COMMIT");
    locked = false;
  } finally {
    try { if (locked) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

// Re-initialize the version marker of an existing but uninitialized lock.
//
// The version is written inside the creating transaction, so a failed
// action rolls it back and leaves the lock file present but unversioned.
// The lock database holds no business data -- it is used only to exclude a
// second writer -- so only the original empty, unversioned SQLite shape can
// be restored without discarding evidence of another database.
//
// Restoring the version is an administrative operation, never a side effect
// of an ordinary open: it is called only by an explicit settlement of a
// bootstrap that failed while the lock was being created. A lock that
// carries any schema object or non-default identity header is refused.
function reinitializeUninitializedLock(dir, beforeRestore) {
  dir = path.resolve(dir);
  const file = path.join(dir, FILE);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") fail("ERR_COORDINATION_LOCK_MISSING");
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("ERR_COORDINATION_LOCK_UNSAFE");
  const before = identity(dir);
  const { DatabaseSync } = require("node:sqlite");
  let db;
  try { db = new DatabaseSync(file, { timeout: TIMEOUT_MS }); }
  catch { fail("ERR_COORDINATION_LOCK_UNSAFE"); }
  let locked = false;
  try {
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    prepareMainFileLock(db);
    db.exec("PRAGMA synchronous=FULL");
    db.exec("BEGIN EXCLUSIVE");
    locked = true;
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    assertMainFileLock(db);
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version === 1) {
      db.exec("COMMIT"); locked = false;
      return Object.freeze({ restored: false, reason: "already-initialized" });
    }
    if (version !== 0 || db.prepare("PRAGMA application_id").get().application_id !== 0 ||
        db.prepare("PRAGMA schema_version").get().schema_version !== 0 ||
        db.prepare("PRAGMA encoding").get().encoding !== "UTF-8" ||
        db.prepare("PRAGMA auto_vacuum").get().auto_vacuum !== 0 ||
        db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n !== 0) fail("ERR_COORDINATION_LOCK_INVALID");
    // Drain the creator, then let settlement validate and durably bind its
    // replay plan BEFORE committing the version. A rejected check leaves 0.
    if (beforeRestore) beforeRestore(before);
    db.exec("PRAGMA user_version=1");
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    db.exec("COMMIT"); locked = false;
    return Object.freeze({ restored: true, reason: "empty-lock-reinitialized" });
  } finally {
    try { if (locked) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}
function withLock(anchorDir, action, { create = false, expectedIdentity = null } = {}) {
  const dir = path.resolve(anchorDir);
  const file = path.join(dir, FILE);
  if (create) {
    assertAnchorPathIsNotRedirected(dir);
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
  }
  let before;
  try { before = identity(dir); }
  catch (error) { if (error.code === "ENOENT") fail("ERR_COORDINATION_LOCK_MISSING"); throw error; }
  if (expectedIdentity !== null && before !== expectedIdentity) fail("ERR_COORDINATION_LOCK_REPLACED");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { timeout: TIMEOUT_MS });
  let locked = false;
  let primaryError = null;
  try {
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    prepareMainFileLock(db);
    db.exec("BEGIN IMMEDIATE");
    locked = true;
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    assertMainFileLock(db);
    if (create) db.exec("PRAGMA user_version=1");
    else if (db.prepare("PRAGMA user_version").get().user_version !== 1) fail("ERR_COORDINATION_LOCK_INVALID");
    const result = action(before);
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
    db.exec("COMMIT");
    locked = false;
    return result;
  } catch (error) {
    // No business-operation retries: contention is bounded and explicit.
    primaryError = error;
    if (error.errcode === 5 || error.errcode === 6) {
      primaryError = Object.assign(new Error("ERR_COORDINATION_BUSY", { cause: error }), { code: "ERR_COORDINATION_BUSY" });
    }
    throw primaryError;
  } finally {
    // Preserve the first failure, recording cleanup errors rather than replacing it.
    let cleanupError = null;
    try { if (locked) db.exec("ROLLBACK"); } catch (error) { cleanupError = error; }
    try { db.close(); } catch (error) { cleanupError ||= error; }
    if (cleanupError) {
      if (primaryError) primaryError.cleanupError = cleanupError;
      else throw cleanupError;
    }
  }
}
module.exports = { withLock, FILE, TIMEOUT_MS, assertWindowsFilePermissions, assertAnchorPathIsNotRedirected,
  assertLockInitialized, reinitializeUninitializedLock };
