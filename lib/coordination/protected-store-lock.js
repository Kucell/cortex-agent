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
// The anchor directory itself must be a real directory and not a symbolic
// link, and no component BELOW the platform namespace may be one either.
// The components above that point ("/tmp" and "/var" on macOS) belong to the
// platform, not to the protected path, and are absorbed rather than
// reported. This is the same rule `protected-anchor.js` already applies in
// `anchorDirFor`, so the two files agree on what a legitimate anchor is.
//
// Redirecting the lock file itself remains detected: the identity is built
// from the device and inode of the directory and of the lock file, so a
// replaced domain is caught by `expectedIdentity` even when the path still
// resolves.
function assertAnchorPathIsNotRedirected(dir) {
  const resolved = path.resolve(dir);
  const parts = resolved.split(path.sep).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const component = path.sep + parts.slice(0, i + 1).join(path.sep);
    let componentStat;
    try { componentStat = fs.lstatSync(component); }
    catch { break; }
    if (componentStat.isSymbolicLink()) fail("ERR_COORDINATION_LOCK_UNSAFE");
  }
}

function identity(dir) {
  const parent = fs.lstatSync(dir);
  const file = fs.lstatSync(path.join(dir, FILE));
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 || (typeof process.getuid === "function" && file.uid !== process.getuid())) {
    fail("ERR_COORDINATION_LOCK_UNSAFE");
  }
  assertAnchorPathIsNotRedirected(dir);
  return [parent.dev, parent.ino, file.dev, file.ino].join(":");
}
function withLock(anchorDir, action, { create = false, expectedIdentity = null } = {}) {
  const dir = path.resolve(anchorDir);
  const file = path.join(dir, FILE);
  if (create) {
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
    db.exec("BEGIN IMMEDIATE");
    locked = true;
    if (identity(dir) !== before) fail("ERR_COORDINATION_LOCK_REPLACED");
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
module.exports = { withLock, FILE, TIMEOUT_MS };
