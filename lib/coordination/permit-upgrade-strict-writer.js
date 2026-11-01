"use strict";

// Phase A single-file primitive, deliberately not connected to upgrade/init.
// No portable Node path/CAS implementation can qualify as the platform below.
// A trusted composition root may supply a SYNCHRONOUS platform with acquire():
//   acquire(frozenRequest) -> { assertHeld(), publish(frozenNames), release() }
// assertHeld() must return true. The lease must bind EVERY path component and
// exclude untrusted writers, rename/unlink, mount/reparse changes and late owners
// until release. publish() must atomically create without replacement, or replace
// ONLY the expected inode under that protection; it must enforce the controller's
// owner/publication generation CAS. publish/release return undefined; promises
// are not supported. Node rename alone does
// not implement this contract. Callbacks are trusted code, never request data.
// No such qualified adapter ships here. Tests supply a private-directory model.
// Observations below detect mistakes; they do NOT close TOCTOU or prove a lease.
// The caller must durably record call-possible BEFORE calling, retain eligibility
// and independently confirm the receipt in its controller. This grants no right
// to migrate, activate, stamp or execute. No multi-file atomicity is implied.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, createHash } = require("node:crypto");
const { types } = require("node:util");
const MAX_BYTES = 1024 * 1024;
const receipts = new WeakSet();
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = Object.getOwnPropertyDescriptor(typed, "byteLength").get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const offsetOf = Object.getOwnPropertyDescriptor(typed, "byteOffset").get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const setBytes = Uint8Array.prototype.set;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function record(input, keys) {
  if (types.isProxy(input) || !input || typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail("DATA_ONLY");
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(k => !keys.includes(k))) fail("INVALID_FIELDS");
  const result = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, "value")) fail("DATA_ONLY");
    result[key] = d.value;
  }
  return result;
}
function bytes(input) {
  if (types.isProxy(input) || !types.isUint8Array(input) || !Buffer.isBuffer(input) ||
      Object.getPrototypeOf(input) !== Buffer.prototype) fail("EXACT_BYTES_REQUIRED");
  const size = lengthOf.call(input), backing = bufferOf.call(input);
  if (size > MAX_BYTES) fail("INPUT_LIMIT");
  if (types.isSharedArrayBuffer(backing) || (resizable && resizable.call(backing))) fail("EXACT_BYTES_REQUIRED");
  try {
    const view = new Uint8Array(backing, offsetOf.call(input), size), copy = Buffer.alloc(size);
    setBytes.call(copy, view);
    return copy;
  } catch { fail("EXACT_BYTES_REQUIRED"); }
}
function id(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail("INVALID_ID");
  return value;
}
function digest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("INVALID_DIGEST");
  return value;
}
function identity(input) {
  const value = record(input, ["dev", "ino"]);
  for (const key of ["dev", "ino"]) {
    if (typeof value[key] !== "string" || !/^(0|[1-9][0-9]{0,39})$/.test(value[key])) fail("INVALID_IDENTITY");
  }
  if (value.ino === "0") fail("INVALID_IDENTITY");
  return Object.freeze(value);
}
function filename(value) {
  // Deliberately narrow ASCII spelling: no URLs, escaping, alternate streams,
  // device names, separators, trailing dots/spaces, Unicode or case normalization.
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9.][A-Za-z0-9._-]*$/.test(value) ||
      value === "." || value === ".." || value.endsWith(".") ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail("UNSAFE_PATH");
  return value;
}
function request(input) {
  const r = record(input, ["directory", "name", "bytes", "expected", "candidateVersion", "artifactDigest", "upgradeId", "binding"]);
  if (typeof r.directory !== "string" || r.directory.length > 4096 || !r.directory.startsWith("/") ||
      path.posix.normalize(r.directory) !== r.directory || r.directory === "/" || r.directory.endsWith("/")) fail("UNSAFE_PATH");
  r.directory.slice(1).split("/").forEach(filename);
  filename(r.name); id(r.candidateVersion); id(r.upgradeId); digest(r.artifactDigest);
  r.bytes = bytes(r.bytes);
  if (r.expected !== null) {
    const e = record(r.expected, ["identity", "bytes"]);
    r.expected = Object.freeze({ identity: identity(e.identity), bytes: bytes(e.bytes) });
  }
  const b = record(r.binding, ["projectId", "snapshotDigest", "ownerGeneration", "publicationGeneration"]);
  id(b.projectId); digest(b.snapshotDigest);
  for (const key of ["ownerGeneration", "publicationGeneration"]) {
    if (!Number.isSafeInteger(b[key]) || b[key] < 1) fail("INVALID_GENERATION");
  }
  r.binding = Object.freeze(b);
  return r;
}
function statId(st) { return Object.freeze({ dev: String(st.dev), ino: String(st.ino) }); }
function sameId(st, expected) { return String(st.dev) === expected.dev && String(st.ino) === expected.ino; }
function file(st) {
  if (!st.isFile() || st.nlink !== 1n || st.ino === 0n) fail("UNSAFE_FILE");
}
function unchanged(a, b) {
  if (!sameId(a, statId(b)) || a.size !== b.size || a.mtimeNs !== b.mtimeNs ||
      a.ctimeNs !== b.ctimeNs || a.mode !== b.mode || a.nlink !== b.nlink) fail("FILE_CHANGED");
}
function checkFd(fd, name, expectedId, exactBytes) {
  const before = fs.fstatSync(fd, { bigint: true }); file(before);
  if (!sameId(before, expectedId) || before.size !== BigInt(exactBytes.length)) fail("FILE_MISMATCH");
  const actual = Buffer.alloc(exactBytes.length);
  let at = 0;
  while (at < actual.length) {
    const n = fs.readSync(fd, actual, at, actual.length - at, at);
    if (!Number.isSafeInteger(n) || n <= 0 || n > actual.length - at) fail("SHORT_READ");
    at += n;
  }
  if (fs.readSync(fd, Buffer.alloc(1), 0, 1, at) !== 0 || !actual.equals(exactBytes)) fail("BYTE_MISMATCH");
  const after = fs.fstatSync(fd, { bigint: true }); file(after); unchanged(before, after);
  const named = fs.lstatSync(name, { bigint: true }); file(named); unchanged(after, named);
}

class PermitUpgradeStrictWriteError extends Error {
  constructor(cause, state, stage, operationId, temporaryPath, cleanupErrors) {
    super("Strict file publication failed", { cause });
    this.name = "PermitUpgradeStrictWriteError";
    this.code = "ERR_PERMIT_UPGRADE_STRICT_WRITE";
    this.state = state; // not-published refers ONLY to this invocation's rename.
    this.stage = stage;
    this.operationId = operationId;
    this.temporaryPath = temporaryPath; // May remain; NEVER automatically reused/deleted.
    this.cleanupErrors = Object.freeze(cleanupErrors);
    this.cleanupError = cleanupErrors[0];
    this.executionAuthorized = false;
  }
}

function createPermitUpgradeStrictWriter(platform) {
  // platform is a privileged dependency, NOT a capability supplied in input.
  // Supplying this interface is not evidence that its security contract holds.
  let busy = false;
  function write(input) {
    let stage = "input", possible = false, operationId = null, temporaryPath = null;
    let lease, fd, dirFd, tempIdentity, r, directories;
    const cleanupErrors = [];
    const close = key => {
      // Consume ownership before close: EINTR/error must never close a reused fd.
      const value = key === "file" ? fd : dirFd;
      if (key === "file") fd = undefined; else dirFd = undefined;
      if (value !== undefined) fs.closeSync(value);
    };
    const release = () => {
      const value = lease; lease = undefined;
      if (value && value.release() !== undefined) fail("INVALID_PLATFORM_RESULT");
    };
    function held() { if (lease.assertHeld() !== true) fail("PATH_BINDING_UNPROVEN"); }
    function bindDirectories() {
      const result = [];
      let current = "/";
      for (const part of ["", ...r.directory.slice(1).split("/")]) {
        if (part) current = path.join(current, part);
        const st = fs.lstatSync(current, { bigint: true });
        if (!st.isDirectory() || st.ino === 0n) fail("UNSAFE_PATH");
        result.push([current, statId(st)]);
      }
      if (fs.realpathSync(r.directory) !== r.directory) fail("UNSAFE_PATH");
      return result;
    }
    function recheckDirectories() {
      held();
      for (const [name, expected] of directories) {
        const st = fs.lstatSync(name, { bigint: true });
        if (!st.isDirectory() || !sameId(st, expected)) fail("DIRECTORY_CHANGED");
      }
      const st = fs.fstatSync(dirFd, { bigint: true });
      if (!st.isDirectory() || !sameId(st, directories.at(-1)[1])) fail("DIRECTORY_CHANGED");
    }
    function readNamed(name, expectedId, exactBytes) {
      let handle, primary;
      try {
        const st = fs.lstatSync(name, { bigint: true }); file(st);
        if (!sameId(st, expectedId)) fail("FILE_MISMATCH");
        handle = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        checkFd(handle, name, expectedId, exactBytes);
      } catch (error) { primary = error; }
      const owned = handle; handle = undefined;
      if (owned !== undefined) {
        try { fs.closeSync(owned); } catch (error) { if (primary) cleanupErrors.push(error); else primary = error; }
      }
      if (primary) throw primary;
    }
    function expectedTarget(target) {
      if (r.expected) readNamed(target, r.expected.identity, r.expected.bytes);
      else {
        try { fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
        fail("TARGET_EXISTS");
      }
    }
    if (busy) throw new PermitUpgradeStrictWriteError(new Error("WRITER_REENTRY"), "not-published", stage, null, null, []);
    busy = true;
    try {
      r = request(input);
      stage = "platform";
      if (!["linux", "darwin"].includes(process.platform) || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY ||
          !platform || typeof platform.acquire !== "function") fail("PATH_BINDING_UNPROVEN");
      operationId = randomBytes(24).toString("hex");
      const target = path.join(r.directory, r.name);
      const context = Object.freeze({ directory: r.directory, name: r.name, target,
        operationId, candidateVersion: r.candidateVersion, artifactDigest: r.artifactDigest,
        upgradeId: r.upgradeId, binding: r.binding, expectedIdentity: r.expected?.identity ?? null,
        expectedDigest: r.expected ? createHash("sha256").update(r.expected.bytes).digest("hex") : null,
        targetDigest: createHash("sha256").update(r.bytes).digest("hex") });
      lease = platform.acquire(context);
      if (!lease || typeof lease.assertHeld !== "function" || typeof lease.publish !== "function" ||
          typeof lease.release !== "function") {
        // A malformed lease can still own resources. Retain it for the
        // single cleanup attempt whenever it supplies a release method.
        if (!lease || typeof lease.release !== "function") lease = undefined;
        fail("PATH_BINDING_UNPROVEN");
      }
      held();
      stage = "directory-bind";
      directories = bindDirectories();
      dirFd = fs.openSync(r.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      recheckDirectories();
      stage = "target-precondition"; expectedTarget(target);
      stage = "temporary-open";
      const temp = path.join(r.directory, `.${r.name}.strict-${operationId}.tmp`);
      fd = fs.openSync(temp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      temporaryPath = temp;
      const st = fs.fstatSync(fd, { bigint: true }); file(st); tempIdentity = statId(st);
      if ((st.mode & 0o777n) !== 0o600n || st.size !== 0n) fail("UNSAFE_TEMPORARY");
      stage = "write";
      let at = 0;
      while (at < r.bytes.length) {
        const n = fs.writeSync(fd, r.bytes, at, r.bytes.length - at, at);
        if (!Number.isSafeInteger(n) || n <= 0 || n > r.bytes.length - at) fail("SHORT_WRITE");
        at += n;
      }
      stage = "file-fsync"; fs.fsyncSync(fd);
      stage = "temporary-verify"; checkFd(fd, temp, tempIdentity, r.bytes);
      stage = "file-close"; close("file");
      stage = "prepublication-verify";
      readNamed(temp, tempIdentity, r.bytes); recheckDirectories(); expectedTarget(target); held();
      stage = "rename";
      // Once called, even ENOENT/EEXIST/throw-before-rename cannot prove absence
      // of publication. The adapter may have renamed before losing its reply.
      possible = true;
      if (lease.publish(Object.freeze({ temporaryPath: temp, targetPath: target,
        temporaryIdentity: tempIdentity, expectedIdentity: context.expectedIdentity })) !== undefined) fail("INVALID_PLATFORM_RESULT");
      stage = "directory-fsync"; fs.fsyncSync(dirFd);
      stage = "published-verify";
      recheckDirectories(); readNamed(target, tempIdentity, r.bytes); held();
      stage = "directory-close"; close("directory");
      stage = "release"; release();
      const receipt = Object.freeze({ ...context, state: "published", fileIdentity: tempIdentity,
        byteLength: r.bytes.length, durability: "file-and-directory-fsync-observed",
        pathBinding: "trusted-platform-contract-required", executionAuthorized: false });
      receipts.add(receipt);
      return receipt;
    } catch (primary) {
      // Retain all temporary names, including partial data, rather than risk a
      // path-based unlink racing someone else's inode. Recovery needs a new lease
      // and ownership/byte verification. Never unlink/restore a published target.
      for (const action of [() => close("file"), () => close("directory"), release]) {
        try { action(); } catch (error) { cleanupErrors.push(error); }
      }
      throw new PermitUpgradeStrictWriteError(primary, possible ? "outcome-unknown" : "not-published",
        stage, operationId, temporaryPath, cleanupErrors);
    } finally { busy = false; }
  }
  return Object.freeze({ write });
}

// Process-local provenance only. A JSON copy, Proxy or spread copy cannot forge
// membership; this is neither a durable receipt nor controller authorization.
function isPermitUpgradeStrictWriteReceipt(value) { return receipts.has(value); }

module.exports = { createPermitUpgradeStrictWriter, isPermitUpgradeStrictWriteReceipt,
  PermitUpgradeStrictWriteError, MAX_BYTES };
