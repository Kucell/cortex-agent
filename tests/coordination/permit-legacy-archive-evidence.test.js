"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { inspect } = require("node:util");
const core = require("../../lib/coordination/permit-legacy-migration-core");
const api = require("../../lib/coordination/permit-legacy-archive-evidence");
const supported = Number(process.versions.node.split(".")[0]) >= 24 && process.platform !== "win32";
const opts = { skip: supported ? false : "Requires Node >=24 SQLite and POSIX legacy fixture", timeout: 240000 };
const f = supported ? require("./fixtures/permit-legacy-archive-evidence") : null;
let report, small;
const copy = value => JSON.parse(JSON.stringify(value));
function prepare(snapshot, project = f.PROJECT) { return api.prepareLegacyArchiveEvidence(JSON.stringify(snapshot), project); }
function reject(snapshot, code) { assert.throws(() => prepare(snapshot), { code }); }
test.before(() => {
  if (!supported) return;
  report = f.run(); small = f.small();
  console.log("archive evidence report: " + report);
});

test("real SQLite capture produces reusable strict-core bytes with no authentication or execution authority", opts, () => {
  const before = f.legacy.snapshot(small.source), input = JSON.stringify(small.snapshot), result = prepare(small.snapshot);
  assert.equal(result.status, "prepared-only");
  for (const flag of ["authority", "executionAuthorized", "authenticated", "trustedCaptureProven", "atomicSnapshotProven",
    "freshnessProven", "singleUseProven", "oldWriterFenceProven", "gateProven"]) assert.equal(result[flag], false);
  assert.equal(result.binding.snapshot_sha256, f.legacy.hash(input));
  assert.equal(result.binding.archive_sha256, f.legacy.hash(small.archive));
  assert.equal(result.binding.source_high_water_sha256, f.legacy.hash(f.readFile(small.snapshot, "anchor/" + f.legacy.WATER)));
  assert.deepEqual(core.prepareLegacyPermitMigration(result.recoveredEvidence), result.prepared);
  assert.equal(result.prepared.target.user_version, 2);
  assert.equal(result.replay.compactions, 0);
  assert.ok(result.blockers.includes("managed-bootstrap-trust-root-missing"));
  assert.ok(Object.isFrozen(result.prepared.target));
  // Repetition is deliberately just preparation, never a consumed nonce.
  const repeated = prepare(small.snapshot);
  assert.deepEqual({ ...repeated, scratch: undefined }, { ...result, scratch: undefined });
  assert.notEqual(repeated.scratch.relativePath, result.scratch.relativePath);
  assert.equal(repeated.scratch.retained, true);
  assert.equal(JSON.stringify(small.snapshot), input);
  assert.deepEqual(f.legacy.snapshot(small.source), before);
  f.save(report, "small-result.json", result);
});

test("P2 raw SQLite TEXT containing ff must fail before decoded replacement can pass hashes", opts, () => {
  const control = prepare(f.invalidBodyUtf8(small.snapshot, false));
  assert.ok(control.prepared.source.body.includes("\ufffd"));
  reject(f.invalidBodyUtf8(small.snapshot), "ERR_LEGACY_ARCHIVE_UTF8");
});

test("P2 no unlink after identity check: preserve scratch and any replacement without OS exclusivity", opts, () => {
  const originalUnlink = fs.unlinkSync, originalMkdtemp = fs.mkdtempSync;
  let work, unlinkCalls = 0;
  fs.mkdtempSync = function(...args) { work = originalMkdtemp.apply(this, args); return work; };
  fs.unlinkSync = function(file, ...args) {
    unlinkCalls++;
    // Reproduce the exact check-to-unlink race, after every identity check.
    fs.renameSync(file, path.join(work, "original-owned.sqlite"));
    fs.writeFileSync(file, "replacement-not-owned", { flag: "wx" });
    return originalUnlink.call(this, file, ...args);
  };
  try {
    try { prepare(small.snapshot); } catch (error) { assert.ok(error.code.startsWith("ERR_LEGACY_ARCHIVE_")); }
    assert.equal(unlinkCalls, 0, "must never invoke path-based deletion without OS exclusivity");
    assert.ok(fs.existsSync(path.join(work, "state.sqlite")));
  } finally { fs.unlinkSync = originalUnlink; fs.mkdtempSync = originalMkdtemp; }
});

test("P2 write and close double failure preserves primary and cleanup causes and cannot prepare", opts, () => {
  const open = fs.openSync, write = fs.writeFileSync, close = fs.closeSync;
  const writeError = Error("P2 write failure"), closeError = Error("P2 close failure");
  let targetFd, writeHit = false, closeHit = false;
  fs.openSync = function(file, flags, ...args) {
    const fd = open.call(this, file, flags, ...args);
    if (typeof file === "string" && path.basename(file) === "state.sqlite" && (flags & fs.constants.O_EXCL)) targetFd = fd;
    return fd;
  };
  fs.writeFileSync = function(file, ...args) {
    if (file === targetFd) { writeHit = true; throw writeError; }
    return write.call(this, file, ...args);
  };
  fs.closeSync = function(fd) {
    if (fd === targetFd) { closeHit = true; close.call(this, fd); throw closeError; }
    return close.call(this, fd);
  };
  try {
    assert.throws(() => prepare(small.snapshot), error => error.code === "ERR_LEGACY_ARCHIVE_WRITE" &&
      api.getLegacyArchiveErrorDiagnostics(error)?.cause === writeError && error.cleanupError?.code === "ERR_LEGACY_ARCHIVE_CLOSE" && api.getLegacyArchiveErrorDiagnostics(error.cleanupError)?.cause === closeError);
    assert.equal(writeHit, true); assert.equal(closeHit, true);
  } finally { fs.openSync = open; fs.writeFileSync = write; fs.closeSync = close; }
});

test("P2 read and close dual failure and SQLite close failure also prevent prepared success", opts, () => {
  const open = fs.openSync, read = fs.readFileSync, close = fs.closeSync;
  const primary = Error("P2 read failure"), secondary = Error("P2 read close failure");
  let targetFd;
  fs.openSync = function(file, flags, ...args) {
    const fd = open.call(this, file, flags, ...args);
    if (typeof file === "string" && path.basename(file) === "state.sqlite" && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) targetFd = fd;
    return fd;
  };
  fs.readFileSync = function(file, ...args) { if (file === targetFd) throw primary; return read.call(this, file, ...args); };
  fs.closeSync = function(fd) { close.call(this, fd); if (fd === targetFd) throw secondary; };
  try {
    assert.throws(() => prepare(small.snapshot), e => e.code === "ERR_LEGACY_ARCHIVE_SQLITE" && api.getLegacyArchiveErrorDiagnostics(e)?.cause === primary &&
      api.getLegacyArchiveErrorDiagnostics(e.cleanupError)?.cause === secondary && api.getLegacyArchiveErrorDiagnostics(e)?.scratch?.retained === true);
  } finally { fs.openSync = open; fs.readFileSync = read; fs.closeSync = close; }
  const { DatabaseSync } = require("node:sqlite"), dbClose = DatabaseSync.prototype.close, dbCloseError = Error("P2 db close failure");
  DatabaseSync.prototype.close = function() { dbClose.call(this); throw dbCloseError; };
  try {
    assert.throws(() => prepare(small.snapshot), e => e.code === "ERR_LEGACY_ARCHIVE_CLOSE" && api.getLegacyArchiveErrorDiagnostics(e)?.cause === dbCloseError && api.getLegacyArchiveErrorDiagnostics(e)?.scratch?.retained === true);
  } finally { DatabaseSync.prototype.close = dbClose; }
});

test("P2 default logs redact raw errors and recursive cleanup while explicit diagnostics retain exact failures", opts, () => {
  const open = fs.openSync, read = fs.readFileSync, close = fs.closeSync;
  const { DatabaseSync } = require("node:sqlite"), dbClose = DatabaseSync.prototype.close;
  const markers = ["SECRET_PRIMARY_7e96", "BODY_CLEANUP_a81d", "/private/diagnostic-only/path-901f", f.PROJECT];
  const raw = markers.slice(0, 3).map((m, i) => Object.assign(Error(m), { body: m, path: markers[2], secret: markers[0],
    cause: Error("nested " + m), stack: "Error: " + m + "\n at " + markers[2] + ":1:1" }));
  let targetFd, caught;
  fs.openSync = function(file, flags, ...args) {
    const fd = open.call(this, file, flags, ...args);
    if (typeof file === "string" && path.basename(file) === "state.sqlite" && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) targetFd = fd;
    return fd;
  };
  fs.readFileSync = function(file, ...args) { if (file === targetFd) throw raw[0]; return read.call(this, file, ...args); };
  fs.closeSync = function(fd) { close.call(this, fd); if (fd === targetFd) throw raw[1]; };
  DatabaseSync.prototype.close = function() { dbClose.call(this); throw raw[2]; };
  try { prepare(small.snapshot); assert.fail("must not prepare"); }
  catch (e) { caught = e; }
  finally { fs.openSync = open; fs.readFileSync = read; fs.closeSync = close; DatabaseSync.prototype.close = dbClose; }
  assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_SQLITE");
  assert.equal(caught.cleanupError.code, "ERR_LEGACY_ARCHIVE_CLOSE");
  assert.equal(caught.cleanupError.cleanupError.code, "ERR_LEGACY_ARCHIVE_CLOSE");
  const rendered = [], stderrWrite = process.stderr.write;
  // Exercise the real global console.error formatter, capturing its actual sink.
  process.stderr.write = function(chunk, encoding, callback) {
    rendered.push(String(chunk)); if (typeof encoding === "function") encoding(); else if (typeof callback === "function") callback(); return true;
  };
  try {
    for (let e = caught; e; e = e.cleanupError) {
      console.error(e); console.error("%o", e); console.error(e.stack);
      rendered.push(e.message, e.stack, String(e), inspect(e), inspect(e, { depth: null, showHidden: true, customInspect: false }), JSON.stringify(e));
    }
  } finally { process.stderr.write = stderrWrite; }
  for (const text of rendered) {
    for (const marker of markers) assert.equal(text.includes(marker), false, "private diagnostic marker leaked");
    assert.equal(text.includes("permit-legacy-archive-"), false, "scratch path leaked");
    assert.equal(text.includes(".js:"), false, "source stack path leaked");
  }
  for (let i = 0, e = caught; e; e = e.cleanupError, i++) {
    assert.equal(e.cause, undefined);
    assert.equal(api.getLegacyArchiveErrorDiagnostics(e).cause, raw[i]);
  }
  const diagnostic = api.getLegacyArchiveErrorDiagnostics(caught);
  assert.equal(diagnostic.scratch.retained, true);
  assert.ok(diagnostic.scratch.relativePath.startsWith(".agent/runtime/"));
  assert.equal(api.getLegacyArchiveErrorDiagnostics({}), undefined);
  assert.equal(Object.isFrozen(diagnostic), true);
  assert.equal(Object.isFrozen(diagnostic.scratch), true);
  const unsafeCode = new api.LegacyArchiveEvidenceError(markers[0], raw[0]);
  assert.equal(unsafeCode.code, "ERR_LEGACY_ARCHIVE_INPUT");
  assert.equal(inspect(unsafeCode, { showHidden: true }).includes(markers[0]), false);
  assert.equal(api.getLegacyArchiveErrorDiagnostics(unsafeCode).cause, raw[0]);
  // Core rejection stays its own type/code, but its default stack and scratch
  // location must also be log-safe; original core stack is diagnostic-only.
  const bad = copy(small.snapshot);
  bad.archive_high_water_base64 = Buffer.from(small.archive.toString().split("\n").slice(1).join("\n")).toString("base64");
  let rejection;
  try { prepare(bad); } catch (e) { rejection = e; }
  assert.ok(rejection instanceof core.LegacyPermitMigrationError);
  assert.equal(rejection.code, "ERR_LEGACY_MIGRATION_EVIDENCE");
  assert.equal(inspect(rejection, { showHidden: true }).includes(f.PROJECT), false);
  assert.equal(inspect(rejection).includes("relativePath"), false);
  assert.ok(api.getLegacyArchiveErrorDiagnostics(rejection).cause.stack.includes(f.PROJECT));
  f.save(report, "default-error-log-safety.json", { renderings: rendered, exactRawIdentityRetained: true, authority: false });
});

test("P2 unexpected content-preparation error is wrapped with private diagnostics and safe cleanup layers", opts, () => {
  const original = core.prepareLegacyPermitMigration, secret = "CONTENT_SECRET_b612", privatePath = "/private/content/body-secret-712";
  const cleanup = Object.assign(Error(privatePath), { cause: Error(secret), secret });
  const raw = Object.assign(Error(secret), { cause: Error(privatePath), body: secret, path: privatePath, cleanupError: cleanup });
  const rawStack = raw.stack;
  let caught;
  core.prepareLegacyPermitMigration = () => { throw raw; };
  try { prepare(small.snapshot); } catch (e) { caught = e; }
  finally { core.prepareLegacyPermitMigration = original; }
  assert.ok(caught);
  const rendered = [], write = process.stderr.write;
  process.stderr.write = function(chunk) { rendered.push(String(chunk)); return true; };
  try {
    for (let e = caught; e; e = e.cleanupError) {
      console.error(e); console.error("%o", e); console.error(e.stack);
      rendered.push(e.message, e.stack, inspect(e), inspect(e, { showHidden: true, depth: null, customInspect: false }), JSON.stringify(e));
    }
  } finally { process.stderr.write = write; }
  for (const text of rendered) for (const marker of [secret, privatePath, f.PROJECT]) assert.equal(text.includes(marker), false, "unexpected content error leaked");
  assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_INTERNAL");
  assert.notEqual(caught, raw);
  assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, raw);
  assert.equal(api.getLegacyArchiveErrorDiagnostics(caught.cleanupError).cause, cleanup);
  assert.equal(caught.cleanupError.code, "ERR_LEGACY_ARCHIVE_CLOSE");
  assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).scratch.retained, true);
  assert.equal(raw.stack, rawStack); // Do not mutate the original private failure.
  f.save(report, "unexpected-content-log-safety.json", { rendered, exactRawIdentityRetained: true });
});

test("P2 proxy cleanup reflection fails closed without leaking trap failures", opts, () => {
  const original = core.prepareLegacyPermitMigration, secret = "PROXY_TRAP_SECRET_a337";
  const trapError = Object.assign(Error(secret), { path: "/private/" + secret, cause: Error(secret) });
  let descriptorCalls = 0;
  const proxy = new Proxy(Error("private raw error"), {
    getOwnPropertyDescriptor() { descriptorCalls++; throw trapError; }
  });
  // Exercise both a top-level Proxy and a safely reachable cleanup Proxy.
  const parent = Object.assign(Error("private parent"), { cleanupError: proxy });
  const prototypeProxy = new Proxy({}, { getPrototypeOf() { throw trapError; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const raw of [proxy, parent, prototypeProxy, revoked.proxy]) {
    let caught;
    core.prepareLegacyPermitMigration = () => { throw raw; };
    try { prepare(small.snapshot); } catch (e) { caught = e; }
    finally { core.prepareLegacyPermitMigration = original; }
    const rendered = [], write = process.stderr.write;
    process.stderr.write = function(chunk) { rendered.push(String(chunk)); return true; };
    try {
      for (let e = caught; e; e = e.cleanupError) {
        console.error(e); console.error("%o", e);
        rendered.push(e.message, e.stack, inspect(e, { showHidden: true, depth: null, customInspect: false }), JSON.stringify(e));
      }
    } finally { process.stderr.write = write; }
    for (const text of rendered) assert.equal(text.includes(secret), false, "Proxy trap error leaked");
    assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_INTERNAL");
    assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, raw);
    assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).scratch.retained, true);
    if (raw === parent) assert.equal(api.getLegacyArchiveErrorDiagnostics(caught.cleanupError).cause, proxy);
    if (raw === proxy || raw === parent) assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).inspectionError, trapError);
  }
  assert.equal(descriptorCalls, 2);
});

test("P2 prototype-chain proxies and hasInstance never interrupt descriptor close or lose primary failures", opts, () => {
  const open = fs.openSync, write = fs.writeFileSync, close = fs.closeSync, prepareCore = core.prepareLegacyPermitMigration;
  const secret = "PROTOTYPE_SECRET_1c2e", trapError = Error(secret), cleanup = Error("private cleanup " + secret);
  let trapCalls = 0, hasInstanceCalls = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { trapCalls++; throw trapError; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const prototypeRaw = Object.defineProperty(Object.create(proxy), "cleanupError", { value: cleanup });
  const revokedRaw = Object.defineProperty(Object.create(revoked.proxy), "cleanupError", { value: cleanup });
  const classes = [api.LegacyArchiveEvidenceError, core.LegacyPermitMigrationError];
  const descriptors = classes.map(c => Object.getOwnPropertyDescriptor(c, Symbol.hasInstance));
  const checkLogs = error => {
    const output = [], stderrWrite = process.stderr.write;
    process.stderr.write = function(chunk) { output.push(String(chunk)); return true; };
    try {
      for (let e = error; e; e = e.cleanupError) {
        console.error(e); console.error("%o", e);
        output.push(e.message, e.stack, inspect(e, { showHidden: true, depth: null, customInspect: false }), JSON.stringify(e));
      }
    } finally { process.stderr.write = stderrWrite; }
    for (const text of output) assert.equal(text.includes(secret), false, "prototype workflow leaked");
  };
  try {
    for (const c of classes) Object.defineProperty(c, Symbol.hasInstance, { configurable: true, value() { hasInstanceCalls++; throw trapError; } });
    for (const raw of [prototypeRaw, revokedRaw, Error(secret)]) {
      let fd, closed = 0, caught;
      fs.openSync = function(file, flags, ...args) {
        const opened = open.call(this, file, flags, ...args);
        if (typeof file === "string" && path.basename(file) === "state.sqlite" && (flags & fs.constants.O_EXCL)) fd = opened;
        return opened;
      };
      fs.writeFileSync = function(file, ...args) { if (file === fd) throw raw; return write.call(this, file, ...args); };
      fs.closeSync = function(file) { close.call(this, file); if (file === fd) { closed++; throw cleanup; } };
      const beforeWrite = hasInstanceCalls;
      try { prepare(small.snapshot); } catch (e) { caught = e; }
      finally {
        fs.openSync = open; fs.writeFileSync = write; fs.closeSync = close;
        // Red-run fixture cleanup only: never leave the intentionally exposed FD.
        if (!closed && fd !== undefined) close(fd);
      }
      assert.equal(hasInstanceCalls, beforeWrite, "write error classification must not call hasInstance");
      assert.equal(closed, 1, "descriptor close must execute exactly once despite classification traps");
      assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_WRITE");
      assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, raw);
      assert.equal(api.getLegacyArchiveErrorDiagnostics(caught.cleanupError).cause, cleanup);
      if (raw !== prototypeRaw && raw !== revokedRaw) assert.equal(caught.cleanupError.cleanupError, undefined);
      else assert.equal(api.getLegacyArchiveErrorDiagnostics(caught.cleanupError.cleanupError).cause, cleanup);
      checkLogs(caught);
      core.prepareLegacyPermitMigration = () => { throw raw; };
      const beforeContent = hasInstanceCalls;
      try { prepare(small.snapshot); } catch (e) { caught = e; }
      finally { core.prepareLegacyPermitMigration = prepareCore; }
      assert.equal(hasInstanceCalls, beforeContent, "content error classification must not call hasInstance");
      assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_INTERNAL");
      assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, raw);
      checkLogs(caught);
    }
    assert.equal(trapCalls, 0);
  } finally {
    fs.openSync = open; fs.writeFileSync = write; fs.closeSync = close; core.prepareLegacyPermitMigration = prepareCore;
    classes.forEach((c, i) => { if (descriptors[i]) Object.defineProperty(c, Symbol.hasInstance, descriptors[i]); else delete c[Symbol.hasInstance]; });
  }
});

test("P2 known core and archive errors are clean copies with stable codes and private original diagnostics", opts, () => {
  const original = core.prepareLegacyPermitMigration, close = fs.closeSync, open = fs.openSync;
  const secret = "KNOWN_ERROR_SECRET_b981", proxy = new Proxy({}, { get() { throw Error(secret); } });
  const raws = [new core.LegacyPermitMigrationError("ERR_LEGACY_MIGRATION_STATE"), new api.LegacyArchiveEvidenceError("ERR_LEGACY_ARCHIVE_WRITE")];
  let getterCalls = 0;
  for (const raw of raws) {
    Object.assign(raw, { path: secret, body: secret, cause: proxy });
    Object.defineProperty(raw, "privateAccessor", { enumerable: true, get() { getterCalls++; throw Error(secret); } });
    const cleanup = Object.assign(new api.LegacyArchiveEvidenceError("ERR_LEGACY_ARCHIVE_CLOSE"), { secret, cause: proxy });
    raw.cleanupError = cleanup;
    const before = Object.getOwnPropertyDescriptors(raw);
    let caught;
    core.prepareLegacyPermitMigration = () => { throw raw; };
    try { prepare(small.snapshot); } catch (e) { caught = e; }
    finally { core.prepareLegacyPermitMigration = original; }
    const outputs = [], stderrWrite = process.stderr.write;
    process.stderr.write = function(chunk) { outputs.push(String(chunk)); return true; };
    try {
      for (let e = caught; e; e = e.cleanupError) {
        console.error(e); console.error("%o", e);
        outputs.push(e.message, e.stack, inspect(e, { showHidden: true, depth: null, customInspect: false }), JSON.stringify(e));
      }
    } finally { process.stderr.write = stderrWrite; }
    for (const text of outputs) assert.equal(text.includes(secret), false, "known error leaked");
    assert.notEqual(caught, raw); assert.equal(Object.getPrototypeOf(caught), Object.getPrototypeOf(raw));
    assert.equal(caught.code, raw.code); assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, raw);
    assert.equal(api.getLegacyArchiveErrorDiagnostics(caught.cleanupError).cause, cleanup);
    for (const key of Reflect.ownKeys(caught)) assert.ok(["message", "stack", "name", "code", "cleanupError"].includes(key));
    assert.deepEqual(Object.getOwnPropertyDescriptors(raw), before);
  }
  // A known error thrown by close must also be copied, with its extra fields
  // and accessor cause never read, even when no operation error preceded it.
  const rawClose = new api.LegacyArchiveEvidenceError("ERR_LEGACY_ARCHIVE_CLOSE");
  rawClose.path = secret;
  Object.defineProperty(rawClose, "cause", { get() { getterCalls++; throw Error(secret); } });
  let fd, caught;
  fs.openSync = function(file, flags, ...args) {
    const value = open.call(this, file, flags, ...args);
    if (typeof file === "string" && path.basename(file) === "state.sqlite" && (flags & fs.constants.O_EXCL)) fd = value;
    return value;
  };
  fs.closeSync = function(value) { close.call(this, value); if (value === fd) throw rawClose; };
  try { prepare(small.snapshot); } catch (e) { caught = e; }
  finally { fs.closeSync = close; fs.openSync = open; }
  assert.notEqual(caught, rawClose); assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_CLOSE");
  assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, rawClose);
  assert.equal(inspect(caught, { showHidden: true }).includes(secret), false);
  assert.equal(getterCalls, 0);
  const accessorCode = new core.LegacyPermitMigrationError("ERR_LEGACY_MIGRATION_STATE");
  Object.defineProperty(accessorCode, "code", { get() { getterCalls++; throw Error(secret); } });
  core.prepareLegacyPermitMigration = () => { throw accessorCode; };
  try { prepare(small.snapshot); } catch (e) { caught = e; }
  finally { core.prepareLegacyPermitMigration = original; }
  assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_INTERNAL");
  assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, accessorCode); assert.equal(getterCalls, 0);
  const accessorCleanup = new core.LegacyPermitMigrationError("ERR_LEGACY_MIGRATION_STATE");
  Object.defineProperty(accessorCleanup, "cleanupError", { get() { getterCalls++; throw Error(secret); } });
  core.prepareLegacyPermitMigration = () => { throw accessorCleanup; };
  try { prepare(small.snapshot); } catch (e) { caught = e; }
  finally { core.prepareLegacyPermitMigration = original; }
  assert.equal(caught.code, "ERR_LEGACY_MIGRATION_STATE"); assert.equal(caught.cleanupError, undefined);
  assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, accessorCleanup); assert.equal(getterCalls, 0);
  const proxyCode = new core.LegacyPermitMigrationError("ERR_LEGACY_MIGRATION_STATE"); proxyCode.code = proxy;
  core.prepareLegacyPermitMigration = () => { throw proxyCode; };
  try { prepare(small.snapshot); } catch (e) { caught = e; }
  finally { core.prepareLegacyPermitMigration = original; }
  assert.equal(caught.code, "ERR_LEGACY_ARCHIVE_INTERNAL"); assert.equal(api.getLegacyArchiveErrorDiagnostics(caught).cause, proxyCode);
});

test("P2 ambiguous installed discovery and successful nonexistent executable must fail", opts, () => {
  const childProcess = require("node:child_process"), original = childProcess.spawnSync;
  const prior = process.env.CORTEX_LEGACY_1157_ROOT;
  delete process.env.CORTEX_LEGACY_1157_ROOT;
  try {
    for (const stderr of ["permission denied: package not installed", "not installed", "could not locate executable", "no executable found"]) {
      childProcess.spawnSync = () => ({ status: 1, stderr });
      assert.throws(() => f.installedAvailability(), { code: "ARCHIVE_INSTALLED_DISCOVERY_FAILED" });
    }
    childProcess.spawnSync = () => ({ status: 0, stdout: path.join(report, "nonexistent-executable"), stderr: "" });
    assert.throws(() => f.installedAvailability(), { code: "ENOENT" });
  } finally {
    childProcess.spawnSync = original;
    if (prior === undefined) delete process.env.CORTEX_LEGACY_1157_ROOT; else process.env.CORTEX_LEGACY_1157_ROOT = prior;
  }
});

test("encoded input, canonical base64, duplicate keys, namespace and size/depth limits fail closed", opts, () => {
  assert.throws(() => api.prepareLegacyArchiveEvidence(new Proxy({}, { get() { throw Error("must not reflect"); } }), f.PROJECT), { code: "ERR_LEGACY_ARCHIVE_INPUT" });
  assert.throws(() => api.prepareLegacyArchiveEvidence("{", f.PROJECT), { code: "ERR_LEGACY_ARCHIVE_JSON" });
  assert.throws(() => api.prepareLegacyArchiveEvidence('{"files":[],"f\\u0069les":[]}', f.PROJECT), { code: "ERR_LEGACY_ARCHIVE_JSON" });
  assert.throws(() => api.prepareLegacyArchiveEvidence("[".repeat(17) + "0" + "]".repeat(17), f.PROJECT), { code: "ERR_LEGACY_ARCHIVE_LIMIT" });
  assert.throws(() => api.prepareLegacyArchiveEvidence(" ".repeat(api.LIMITS.inputBytes + 1), f.PROJECT), { code: "ERR_LEGACY_ARCHIVE_LIMIT" });
  for (const name of ["../../outside", "/absolute", "db/state.sqlite-wal", "db/state.sqlite-shm", "db/state.sqlite-journal", "anchor/unknown", "db\\state.sqlite"]) {
    const s = copy(small.snapshot); s.files.push({ path: name, bytes_base64: "AA==" }); reject(s, "ERR_LEGACY_ARCHIVE_NAMESPACE");
  }
  let s = copy(small.snapshot); s.files.push(s.files[0]); reject(s, "ERR_LEGACY_ARCHIVE_NAMESPACE");
  s = copy(small.snapshot); s.files = s.files.filter(v => !v.path.endsWith("audit.log")); reject(s, "ERR_LEGACY_ARCHIVE_NAMESPACE");
  for (const value of ["", "YQ", "YR==", "AA==\n", "%%%="]) {
    s = copy(small.snapshot); s.archive_high_water_base64 = value; reject(s, "ERR_LEGACY_ARCHIVE_BASE64");
  }
  s = copy(small.snapshot); s.archive_high_water_base64 = Buffer.alloc(api.LIMITS.fileBytes + 1).toString("base64"); reject(s, "ERR_LEGACY_ARCHIVE_LIMIT");
  s = copy(small.snapshot); s.producer_anchor_sha256 = "0".repeat(64); reject(s, "ERR_LEGACY_ARCHIVE_FORMAT");
  // No caller key, signed payload, receipt head or capability is accepted.
  for (const key of ["publicKey", "receipt", "capability", "nonceConsumed", "evidence"]) {
    s = copy(small.snapshot); s[key] = true; reject(s, "ERR_LEGACY_ARCHIVE_FORMAT");
  }
});

test("scratch is confined to supplied project .agent/runtime; aliases and symlink ancestors refuse", opts, () => {
  const project = path.join(f.run(), "project");
  fs.mkdirSync(project); fs.mkdirSync(path.join(project, ".agent")); fs.mkdirSync(path.join(project, ".agent/runtime"));
  const runtime = path.join(project, ".agent/runtime"), before = fs.readdirSync(runtime);
  assert.equal(prepare(small.snapshot, project).status, "prepared-only");
  const retained = fs.readdirSync(runtime);
  assert.equal(retained.length, before.length + 1);
  assert.ok(fs.existsSync(path.join(runtime, retained[0], "state.sqlite")));
  for (const root of [runtime, path.join(project, "runtime"), project + "/../project", "relative", null]) {
    assert.throws(() => prepare(small.snapshot, root), error => error.code.startsWith("ERR_LEGACY_ARCHIVE_"));
  }
  const alias = path.join(path.dirname(project), "alias"); fs.symlinkSync(project, alias);
  assert.throws(() => prepare(small.snapshot, alias), { code: "ERR_LEGACY_ARCHIVE_SCRATCH" });
  const other = path.join(f.run(), "project"); fs.mkdirSync(other); fs.mkdirSync(path.join(other, ".agent"));
  fs.symlinkSync(runtime, path.join(other, ".agent/runtime"));
  assert.throws(() => prepare(small.snapshot, other), { code: "ERR_LEGACY_ARCHIVE_SCRATCH" });
  assert.deepEqual(fs.readdirSync(runtime), retained);
});

test("mixed DB/archive, missing history, renamed journal, duplicate records and raw-byte differences refuse", opts, () => {
  const other = f.small();
  let s = copy(small.snapshot); s.archive_high_water_base64 = other.snapshot.archive_high_water_base64;
  reject(s, "ERR_LEGACY_MIGRATION_EVIDENCE");
  s = copy(small.snapshot); f.changeFile(s, "db/state.sqlite", f.readFile(other.snapshot, "db/state.sqlite"));
  reject(s, "ERR_LEGACY_MIGRATION_EVIDENCE");
  s = copy(small.snapshot); s.archive_high_water_base64 = Buffer.from(small.archive.toString().split("\n").slice(1).join("\n")).toString("base64");
  reject(s, "ERR_LEGACY_MIGRATION_EVIDENCE");
  s = copy(small.snapshot); s.files = s.files.filter(v => !v.path.includes("-000001-intent-"));
  reject(s, "ERR_LEGACY_MIGRATION_EVIDENCE");
  s = copy(small.snapshot); const entry = s.files.find(v => v.path.includes("-intent-"));
  entry.path = entry.path.replace(/-([a-f0-9]{16})\.json$/, "-0000000000000000.json"); reject(s, "ERR_LEGACY_ARCHIVE_JOURNAL_NAME");
  s = copy(small.snapshot); s.archive_high_water_base64 = Buffer.concat([small.archive, small.archive.subarray(0, small.archive.indexOf(10) + 1)]).toString("base64");
  reject(s, "ERR_LEGACY_MIGRATION_EVIDENCE");
  s = copy(small.snapshot); s.archive_high_water_base64 = Buffer.concat([small.archive, Buffer.from("\n")]).toString("base64"); reject(s, "ERR_LEGACY_ARCHIVE_JSON");
  s = copy(small.snapshot); s.archive_high_water_base64 = Buffer.from(" " + small.archive.toString()).toString("base64"); reject(s, "ERR_LEGACY_ARCHIVE_ARCHIVE_BYTES");
  s = copy(small.snapshot); f.changeFile(s, "anchor/" + f.legacy.WATER, " " + f.readFile(s, "anchor/" + f.legacy.WATER).toString());
  reject(s, "ERR_LEGACY_ARCHIVE_REPLAY_BYTES");
  s = copy(small.snapshot); f.changeFile(s, "anchor/protected-anchor-audit.log", Buffer.from([255, 10])); reject(s, "ERR_LEGACY_ARCHIVE_UTF8");
  s = copy(small.snapshot); f.changeFile(s, "db/state.sqlite", Buffer.from("broken SQLite")); reject(s, "ERR_LEGACY_ARCHIVE_SQL_FORMAT");
});

test("unknown SQL and unresolved state remain rejected; scratch failures never grant prepared success", opts, () => {
  const { DatabaseSync } = require("node:sqlite"), dir = f.run(), file = path.join(dir, "schema.sqlite");
  fs.writeFileSync(file, f.readFile(small.snapshot, "db/state.sqlite"));
  const db = new DatabaseSync(file); db.exec("CREATE TABLE unexpected (x TEXT)"); db.close();
  const s = copy(small.snapshot); f.changeFile(s, "db/state.sqlite", fs.readFileSync(file)); reject(s, "ERR_LEGACY_ARCHIVE_SQL_SCHEMA");
  const live = f.rehearsal.createLegacy({ unresolved: "unknown" }); live.close();
  const snapshot = f.capture(live.root, fs.readFileSync(path.join(live.root, "anchor", f.legacy.WATER)));
  assert.throws(() => prepare(snapshot), error => error instanceof core.LegacyPermitMigrationError);
  assert.throws(() => prepare(small.snapshot, path.join(dir, "missing")), { code: "ERR_LEGACY_ARCHIVE_SQLITE" });
});

test("scratch replacement fails preparation and all original and replacement artifacts remain", opts, () => {
  const originalOpen = fs.openSync;
  let work, replaced = false;
  // Deterministic test-only race injection. Production accepts no hooks.
  fs.openSync = function(file, flags, ...args) {
    if (!replaced && typeof file === "string" && path.basename(file) === "state.sqlite" && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) {
      replaced = true; work = path.dirname(file);
      fs.renameSync(file, path.join(work, "original-owned.sqlite"));
      fs.writeFileSync(file, "unowned replacement", { flag: "wx" });
    }
    return originalOpen.call(this, file, flags, ...args);
  };
  try {
    assert.throws(() => prepare(small.snapshot), error => error.code === "ERR_LEGACY_ARCHIVE_SCRATCH_CHANGED" &&
      !error.cleanupError && api.getLegacyArchiveErrorDiagnostics(error)?.scratch?.retained === true);
  } finally { fs.openSync = originalOpen; }
  assert.equal(fs.readFileSync(path.join(work, "state.sqlite"), "utf8"), "unowned replacement");
  assert.ok(fs.existsSync(path.join(work, "original-owned.sqlite")));
});

function produce(kind) {
  const dir = f.run();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "fixtures/permit-legacy-archive-evidence.js"), kind, dir], {
      env: { ...process.env, TMPDIR: f.ROOT, TMP: f.ROOT, TEMP: f.ROOT }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill(), 220000);
    child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer); fs.writeFileSync(path.join(dir, "producer-stderr.log"), err, { flag: "wx", mode: 0o600 });
      if (code !== 0) return reject(Error("legacy producer failed: " + kind + "; evidence " + dir));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}
function verifyNaturalCompaction(p) {
  const before = f.legacy.snapshot(p.source), bytes = f.legacy.fileBytes(p.source);
  const archive = fs.readFileSync(path.join(p.run, "observed-complete-high-water.log")), snapshot = f.capture(p.source, archive);
  const prepared = prepare(snapshot), original = JSON.parse(prepared.recoveredEvidence);
  original.high_water = f.legacy.lines(f.readFile(snapshot, "anchor/" + f.legacy.WATER));
  assert.throws(() => core.prepareLegacyPermitMigration(JSON.stringify(original)), { code: "ERR_LEGACY_MIGRATION_EVIDENCE" });
  assert.deepEqual(prepared.directSource, { status: "rejected", code: "ERR_LEGACY_MIGRATION_EVIDENCE" });
  assert.equal(prepared.replay.compactions, 1); assert.equal(prepared.replay.archiveRecords, p.state.anchor_sequence);
  assert.equal(prepared.executionAuthorized, false); assert.equal(prepared.authenticated, false);
  assert.equal(prepared.prepared.target.body, core.prepareLegacyPermitMigration(prepared.recoveredEvidence).target.body);
  const target = JSON.parse(prepared.prepared.target.body);
  assert.deepEqual(target, { ...p.state, schema_version: 2, anchor_sequence: p.state.anchor_sequence + 1 });
  const truncated = copy(snapshot); truncated.archive_high_water_base64 = f.readFile(snapshot, "anchor/" + f.legacy.WATER).toString("base64");
  reject(truncated, "ERR_LEGACY_MIGRATION_EVIDENCE");
  const changed = copy(snapshot); f.changeFile(changed, "anchor/" + f.legacy.WATER, " " + f.readFile(changed, "anchor/" + f.legacy.WATER));
  reject(changed, "ERR_LEGACY_ARCHIVE_REPLAY_BYTES");
  assert.deepEqual(f.legacy.fileBytes(p.source), bytes); assert.deepEqual(f.legacy.snapshot(p.source), before);
  f.save(report, p.kind + "-result.json", { producer: p, prepared, sourceBytesAndMetadataPreservedExceptAtime: true });
}
for (const kind of ["frozen", "installed"]) test(`${kind} 1.15.7 naturally compacts; production entry matches raw bytes and preserves core refusal`, opts, async t => {
  if (kind === "installed") {
    const availability = f.installedAvailability();
    if (!availability.available) return t.skip(availability.reason);
  }
  verifyNaturalCompaction(await produce(kind));
});

test("installed discovery skips only absent paths; wrong version, source or incomplete installation fails", opts, () => {
  const prior = process.env.CORTEX_LEGACY_1157_ROOT, dir = f.run();
  try {
    process.env.CORTEX_LEGACY_1157_ROOT = path.join(dir, "missing-installation");
    assert.equal(f.installedAvailability().available, false);
    process.env.CORTEX_LEGACY_1157_ROOT = dir;
    assert.throws(() => f.installedAvailability(), { code: "ENOENT" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.15.8" }));
    assert.throws(() => f.installedAvailability(), { code: "HIGHWATER_INSTALLED_VERSION" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.15.7" }));
    fs.mkdirSync(path.join(dir, "lib/coordination"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lib/coordination/protected-permit-store.js"), "wrong source bytes");
    assert.throws(() => f.installedAvailability(), { code: "HIGHWATER_INSTALLED_SOURCE_MISMATCH" });
    const childProcess = require("node:child_process"), discovery = childProcess.spawnSync;
    delete process.env.CORTEX_LEGACY_1157_ROOT;
    try {
      childProcess.spawnSync = () => ({ error: Object.assign(Error("missing Volta"), { code: "ENOENT" }) });
      assert.equal(f.installedAvailability().available, false);
      childProcess.spawnSync = () => ({ error: Object.assign(Error("discovery timed out"), { code: "ETIMEDOUT" }) });
      assert.throws(() => f.installedAvailability(), { code: "ETIMEDOUT" });
      childProcess.spawnSync = () => ({ status: 1, stderr: "unexpected discovery failure" });
      assert.throws(() => f.installedAvailability(), { code: "ARCHIVE_INSTALLED_DISCOVERY_FAILED" });
    } finally { childProcess.spawnSync = discovery; }
  } finally {
    if (prior === undefined) delete process.env.CORTEX_LEGACY_1157_ROOT; else process.env.CORTEX_LEGACY_1157_ROOT = prior;
  }
});

