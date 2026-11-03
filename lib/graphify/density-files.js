"use strict";

/**

 * Shared file primitives of the edge-density fallback (issue #154).

 *

 * The runtime file NAMES and PATHS, and the atomic / exclusive write

 * helpers every other density module builds on. Nothing here knows about

 * the baseline, the lock or the pending queue -- it is the bottom of the

 * dependency chain, so the write semantics live in exactly one place.

 */



const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");



const THRESHOLD_FILENAME = "threshold.json";
const BASELINE_FILENAME = ".density-baseline.json";

// Where the detached rebuild writes its log. The framework's runtime
// artifact convention requires every artifact to live under `.agent/`,
// never in the temp directory.
function rebuildLogDir(projectRoot) {
  return path.join(projectRoot, ".agent", "logs", "graphify");
}

function pluginDir(projectRoot) {
  return path.join(projectRoot, ".agent", "plugins", "graphify");
}

function thresholdPath(projectRoot) {
  return path.join(pluginDir(projectRoot), THRESHOLD_FILENAME);
}

function baselinePath(projectRoot) {
  return path.join(pluginDir(projectRoot), BASELINE_FILENAME);
}

function graphPath(projectRoot) {
  return path.join(projectRoot, "graphify-out", "graph.json");
}

// -- Atomic, exclusive writes ------------------------------------------------

/**
 * Write a file atomically, using a temp name that NO other writer can use.
 *
 * A shared temp name (`target.tmp`) is not safe under concurrency: writer A
 * can finish its temp file and rename it while writer B is still writing into
 * the SAME path, so A publishes B's half-written file and B's rename then
 * publishes nothing. The result is a corrupt state file that a reader cannot
 * parse. Making the temp name unique per writer (pid + random suffix) makes
 * the rename publish exactly the bytes that writer wrote.
 *
 * The temp file is removed when the write fails, so a crashed writer never
 * leaves a stale temp file behind.
 */
function writeFileAtomic(target, body) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const unique = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = path.join(dir, `.${path.basename(target)}.tmp-${unique}`);
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, target);
  } catch (err) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch (_) { /* already closed */ }
    }
    try { fs.unlinkSync(temporary); } catch (_) { /* nothing to clean up */ }
    throw err;
  }
}

// -- Exclusive publication ---------------------------------------------------

// Publish a file so that exactly one writer wins and the CONTENT is never
// observed half-written.
//
// `link()` is the primitive that gives both properties at once: it fails
// with EEXIST when the target exists, and it publishes the temp file's
// bytes in one atomic step. But hard links are not available on every
// filesystem (FAT32, some network mounts, some container volumes), and
// `linkSync` there fails with EOPNOTSUPP / ENOSYS / EPERM. A publication
// that only works on link-capable filesystems silently loses data
// elsewhere -- the baseline would never be written and the pending queue
// would never be filled, while the caller carried on as if it had worked.
//
// So the link is the fast path, and a direct exclusive create is the
// fallback. The fallback cannot be atomic in the same way, so a reader
// has to tolerate a momentarily incomplete file: `readJsonFile` retries
// the parse a few times before giving up.
function isLinkUnsupported(err) {
  if (!err || !err.code) return false;
  return err.code === "EOPNOTSUPP"
    || err.code === "ENOTSUP"
    || err.code === "ENOSYS"
    || err.code === "EPERM"
    || err.code === "EXDEV"
    || err.code === "EACCES";
}

/**
 * Publish `body` at `target` EXCLUSIVELY: the target must not exist yet.
 *
 * Returns { created: true } when this call published the file,
 * { created: false, reason: "already_exists" } when somebody else got
 * there first. Throws when the publication failed for any other reason.
 *
 * The publication NEVER replaces an existing target. That is the whole
 * point of the function: the baseline sidecar has a fixed name, and a
 * publication that could replace it would let a stale value overwrite a
 * newer one -- which lowers the threshold and disables the guard.
 *
 * The earlier implementation reserved the name with an EMPTY placeholder
 * and then renamed the finished file over it. The reservation did not keep
 * the generation: a publisher that wrote a NEW baseline into the place
 * while the placeholder was in flight had its value replaced by the older
 * one when the rename finally landed. The baseline is exactly the value
 * that must never move backwards, so the reservation is gone: the
 * fallback creates the target exclusively and writes into it, and it never
 * renames over anything.
 */
function publishExclusive(target, body) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const unique = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = path.join(dir, `.${path.basename(target)}.tmp-${unique}`);
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (err) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch (_) { /* already closed */ }
    }
    try { fs.unlinkSync(temporary); } catch (_) { /* nothing to clean up */ }
    throw err;
  }

  try {
    // link() fails when the target already exists, so a concurrent writer
    // wins instead of being overwritten.
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    return { created: true, degraded: false };
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (_) { /* nothing to clean up */ }
    if (err && err.code === "EEXIST") {
      return { created: false, reason: "already_exists", degraded: false };
    }
    if (!isLinkUnsupported(err)) throw err;
  }

  // Fallback for filesystems without hard links: create the target
  // EXCLUSIVELY and write into it.
  //
  // The exclusive create is what keeps the "never replace" promise: the
  // fallback never renames over an existing target, so it can never
  // clobber a newer publication.
  //
  // The bytes are not published in one step, so a reader can observe the
  // file while it is being written. `readJsonFile` retries the parse, and
  // a baseline that cannot be parsed is treated as "no baseline", which
  // SKIPS the check instead of guessing. The pending queue does not use
  // this path at all: its file names are unique, so it publishes with an
  // atomic rename instead.
  let fallbackHandle;
  let fallbackCreated = false;
  try {
    fallbackHandle = fs.openSync(target, "wx", 0o600);
    fallbackCreated = true;
    fs.writeFileSync(fallbackHandle, body);
    fs.fsyncSync(fallbackHandle);
    fs.closeSync(fallbackHandle);
    fallbackHandle = undefined;
    return { created: true, degraded: true };
  } catch (err) {
    if (fallbackHandle !== undefined) {
      try { fs.closeSync(fallbackHandle); } catch (_) { /* already closed */ }
    }
    // A publication that failed half-way must not leave a file behind: a
    // truncated or empty file at a FIXED name is worse than no file at
    // all. It would be read as "a baseline exists" by the next migration
    // and would block every later attempt to publish a real one.
    if (fallbackCreated) {
      try { fs.unlinkSync(target); } catch (_) { /* best-effort */ }
    }
    if (err && err.code === "EEXIST") {
      return { created: false, reason: "already_exists", degraded: true };
    }
    throw err;
  }
}

/**
 * Sleep synchronously for a few milliseconds. Used to let a concurrent
 * writer finish the file it is publishing before the parse is retried.
 */
function sleepSync(ms) {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  } catch (_) {
    // A host without Atomics.wait simply does not wait; the retry loop
    // still gives the writer another chance.
  }
}

/**
 * Read and parse a JSON file, retrying briefly when the parse fails.
 *
 * A file published through the non-atomic fallback path can be observed
 * for a moment before its content is complete. Retrying turns that into
 * a non-event; a genuinely corrupt file still yields null.
 *
 * Returns the parsed value, or null when it cannot be read or parsed.
 */
function readJsonFile(file, { attempts = 5, delayMs = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (_) {
      if (attempt + 1 < attempts) sleepSync(delayMs);
    }
  }
  return null;
}



module.exports = {

  THRESHOLD_FILENAME,

  BASELINE_FILENAME,

  rebuildLogDir,

  pluginDir,

  thresholdPath,

  baselinePath,

  graphPath,

  writeFileAtomic,

  publishExclusive,

  sleepSync,

  readJsonFile,

};
