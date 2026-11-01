"use strict";

// Development authority audit barrier; legacy append semantics stay unchanged.
// Windows is explicitly refused, not claimed verified by these POSIX fixtures.
// Only disposable fixture databases/logs under .agent/runtime are touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const anchor = require("../../lib/coordination/protected-anchor");
const supported = Number(process.versions.node.split(".")[0]) >= 24;
const posix = process.platform !== "win32";
const { spawnSync } = require("node:child_process");

function fixture(t, existing = false, authority = true) {
  const root = path.resolve(__dirname, "../../.agent/runtime/test-tmp"); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-audit-durability-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor"); fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir, { mode: 0o700 });
  const file = path.join(dbDir, "state.sqlite"), log = path.join(anchorDir, "protected-anchor-audit.log");
  const options = { decisionId: "D-audit-fixture", expectedDecisionId: "D-audit-fixture", minimumEpoch: 1,
    anchorDir, anchorMode: "permissive", clock: () => 1000000,
    ...(authority ? { witnessAuthority: { mode: "development-only", authorityId: "audit-fixture",
      authorize: () => true, observeTarget: () => ({ targetHasProcess: false, targetHasPriorRun: false }),
      signPermit: () => { throw Error("must not sign"); }, pullRevocation: () => { throw Error("must not pull"); } } } : {}) };
  const store = Store.initialize(file, options); t.after(() => store.close());
  if (existing) fs.writeFileSync(log, '{"schema_version":1,"event":"legacy-fixture"}\n', { mode: 0o600 });
  const fields = { owner: "synthetic-owner", sessionId: "s", hostId: "h", workerId: "w", runId: "r", generation: "g",
    desktopKey: "d", ownedAppId: "a", idempotencyKey: "audit-fixture", ttlMs: 60000 };
  const publicKey = require("node:crypto").generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" });
  const registration = { targetId: "target-a", requestId: "audit-registration", checkpoint: null,
    pin: { decision_id: "D-audit-fixture", instance_id: "target-a",
      fingerprint: require("../../lib/coordination/permit-delivery").publicKeyFingerprint(publicKey), public_key_pem: publicKey,
      source_digest: "sha256:fixture", deployment_digest: "sha256:fixture", run_id: "r", generation: "g", valid_from: 0, valid_until: 2000000 } };
  return { dir, anchorDir, file, log, store, fields, options,
    act: () => authority ? store.registerWitnessTarget({}, registration) : store.acquire(fields) };
}
function rawState(f) {
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(f.file, { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id=1").get().body); }
  finally { db.close(); }
}
function childState(f) {
  const child = spawnSync(process.execPath, ["-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    process.stdout.write(db.prepare('SELECT body FROM protected_state WHERE id=1').get().body);
    db.close();
  `, f.file], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function instrument(f, fault = null) {
  const originals = Object.fromEntries(["openSync", "writeSync", "fsyncSync", "closeSync"].map(k => [k, fs[k]]));
  const descriptors = new Map(), events = [];
  const { DatabaseSync } = require("node:sqlite"), exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql, ...args) {
    if (sql === "COMMIT" && new Error().stack.includes("#transactionUnlocked")) events.push("db:commit");
    return exec.call(this, sql, ...args);
  };
  let injected = false;
  fs.openSync = function(p, ...args) {
    const kind = String(p) === f.log ? "audit" : String(p) === f.anchorDir && new Error().stack.includes("#writeAudit") ? "directory" : null;
    if (kind) events.push(kind + ":open");
    if (kind === "directory" && fault === "directory-open") { injected = true; throw Error("injected directory-open"); }
    const fd = originals.openSync.call(this, p, ...args); if (kind) descriptors.set(fd, kind); return fd;
  };
  fs.writeSync = function(fd, data, ...args) {
    if (descriptors.get(fd) === "audit") {
      events.push("audit:write");
      if (fault === "zero-write") { injected = true; return 0; }
      if (fault === "invalid-write") { injected = true; return data.length + 1; }
      if (fault === "partial-error" && injected) throw Error("injected write-error");
      if (fault === "partial-error") {
        injected = true; return originals.writeSync.call(this, fd, data, args[0], 7);
      }
      if (fault === "short-write" && Buffer.isBuffer(data) && data.length > 1) {
        injected = true; const offset = args[0] || 0, count = Math.min(7, args[1] || data.length);
        return originals.writeSync.call(this, fd, data, offset, count);
      }
    }
    return originals.writeSync.call(this, fd, data, ...args);
  };
  fs.fsyncSync = function(fd, ...args) {
    const kind = descriptors.get(fd);
    if (kind) events.push(kind + ":fsync");
    if ((kind === "audit" && ["file-fsync", "fsync-and-close"].includes(fault)) || (kind === "directory" && fault === "directory-fsync")) {
      injected = true; throw Error("injected " + fault);
    }
    return originals.fsyncSync.call(this, fd, ...args);
  };
  fs.closeSync = function(fd, ...args) {
    const kind = descriptors.get(fd);
    if (kind) events.push(kind + ":close");
    // Throw after a real close so the test itself does not leak descriptors.
    const result = originals.closeSync.call(this, fd, ...args); descriptors.delete(fd);
    if ((kind === "audit" && ["file-close", "fsync-and-close"].includes(fault)) || (kind === "directory" && fault === "directory-close")) {
      injected = true; throw Error("injected " + fault);
    }
    return result;
  };
  return { events, injected: () => injected, restore() { Object.assign(fs, originals); DatabaseSync.prototype.exec = exec; } };
}

test("host POSIX can sync file and directory; this is not Windows or power-loss evidence", { skip: !posix }, t => {
  const root = path.resolve(__dirname, "../../.agent/runtime/test-tmp"); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "audit-sync-capability-")), file = path.join(dir, "probe");
  const fd = fs.openSync(file, "wx", 0o600);
  try { const bytes = Buffer.from("synthetic\n"); assert.equal(fs.writeSync(fd, bytes), bytes.length); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  t.diagnostic(JSON.stringify({ platform: process.platform, fileAndDirectorySync: true, windowsVerified: false, powerLossVerified: false }));
});

for (const existing of [false, true]) {
  test(`transaction audit requires complete file+directory barrier before commit (${existing ? "legacy file" : "first creation"})`, { skip: !supported || !posix }, t => {
    const f = fixture(t, existing), probe = instrument(f); let result;
    try { result = f.act(); } finally { probe.restore(); }
    assert.ok(result.checkpoint);
    const lines = fs.readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.at(-1).event, "transaction"); if (existing) assert.equal(lines[0].event, "legacy-fixture");
    t.diagnostic(JSON.stringify({ fixture: f.file, events: probe.events, committed: true }));
    const write = probe.events.indexOf("audit:write"), sync = probe.events.indexOf("audit:fsync"), dirSync = probe.events.lastIndexOf("directory:fsync");
    assert.ok(write >= 0 && sync > write && dirSync > sync, "required audit file and directory sync must precede transaction success");
  });
}

for (const fault of ["file-fsync", "file-close", "directory-open", "directory-fsync", "directory-close", "zero-write", "invalid-write", "partial-error"]) {
  test(`${fault} must prevent database COMMIT`, { skip: !supported || !posix }, t => {
    const f = fixture(t), before = f.store.snapshot(), probe = instrument(f, fault); let error;
    try { f.act(); } catch (e) { error = e; } finally { probe.restore(); }
    const after = rawState(f);
    assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
    assert.ok(probe.injected(), "exercise real barrier fault");
    assert.ok(!probe.events.includes("db:commit"), "audit failure must precede any business COMMIT attempt");
    t.diagnostic(JSON.stringify({ fixture: f.file, fault, injected: probe.injected(), events: probe.events, databaseChanged: JSON.stringify(before) !== JSON.stringify(after) }));
    assert.ok(error && error.code === "ERR_AUDIT_WRITE_FAILED", "audit barrier failure must refuse transaction");
    assert.deepEqual(after, before);
    assert.equal(probe.events.filter(e => e === "audit:close").length, fault === "directory-open" ? 0 : 1);
  });
}

test("short writes complete the exact JSON record and still require sync", { skip: !supported || !posix }, t => {
  const f = fixture(t), probe = instrument(f, "short-write");
  try { f.act(); } finally { probe.restore(); }
  const bytes = fs.readFileSync(f.log); assert.equal(bytes.at(-1), 10); assert.equal(JSON.parse(bytes).event, "transaction");
  t.diagnostic(JSON.stringify({ shortWriteInjected: probe.injected(), events: probe.events }));
  assert.ok(probe.injected(), "exercise actual short write"); assert.ok(probe.events.includes("audit:fsync"));
});

test("legacy append error prevents COMMIT without changing its contract", { skip: !supported || !posix }, t => {
  const f = fixture(t, false, false), before = f.store.snapshot(), append = fs.appendFileSync;
  fs.appendFileSync = function(file, ...args) { if (String(file) === f.log) throw Error("injected append"); return append.call(this, file, ...args); };
  try { assert.throws(() => f.act(), { code: "ERR_AUDIT_WRITE_FAILED" }); } finally { fs.appendFileSync = append; }
  assert.deepEqual(f.store.snapshot(), before);
});

test("postcommit anchor error keeps committed DB and poisons handle; audit line is not commit proof", { skip: !supported || !posix }, t => {
  const f = fixture(t), before = f.store.snapshot(), append = anchor.appendEntry;
  anchor.appendEntry = function(file, entry, ...capability) { if (entry.type === "commit") throw Error("postcommit fixture"); return append(file, entry, ...capability); };
  try { assert.throws(() => f.act(), /postcommit fixture/); } finally { anchor.appendEntry = append; }
  assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(f.file, { readOnly: true });
  try { const state = JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id=1").get().body); assert.equal(state.anchor_sequence, before.anchor_sequence + 1); assert.ok(state.witness_authority.targets["target-a"]); }
  finally { db.close(); }
  assert.equal(JSON.parse(fs.readFileSync(f.log, "utf8")).event, "transaction");
  assert.ok(childState(f).witness_authority.targets["target-a"]);
});

test("legacy still uses append without the new authority barrier", { skip: !supported || !posix }, t => {
  const f = fixture(t, true, false), probe = instrument(f);
  try { assert.ok(f.act().leaseId); } finally { probe.restore(); }
  assert.ok(probe.events.includes("audit:write"));
  assert.ok(!probe.events.includes("audit:fsync"));
  assert.ok(!probe.events.includes("directory:open"));
  assert.equal(rawState(f).schema_version, 2);
});

test("first error and cleanup error survive; a closed fd is not retried", { skip: !supported || !posix }, t => {
  const f = fixture(t), before = f.store.snapshot(), probe = instrument(f, "fsync-and-close"); let error;
  try { f.act(); } catch (e) { error = e; } finally { probe.restore(); }
  assert.equal(error.code, "ERR_AUDIT_WRITE_FAILED");
  assert.match(error.cause.message, /injected fsync-and-close/);
  assert.match(error.cleanupError.message, /injected fsync-and-close/);
  assert.equal(probe.events.filter(e => e === "audit:close").length, 1);
  assert.throws(() => f.act(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  assert.deepEqual(childState(f), before);
});

for (const defect of ["partial-tail", "permissions", "hardlink", "symlink"]) {
  test(`authority refuses unsafe existing audit: ${defect}`, { skip: !supported || !posix }, t => {
    const f = fixture(t, true), before = f.store.snapshot();
    if (defect === "partial-tail") fs.appendFileSync(f.log, "incomplete");
    if (defect === "permissions") fs.chmodSync(f.log, 0o644);
    if (defect === "hardlink") fs.linkSync(f.log, path.join(f.dir, "alias"));
    if (defect === "symlink") { fs.renameSync(f.log, f.log + ".original"); fs.symlinkSync(f.log + ".original", f.log); }
    const bytes = fs.readFileSync(f.log);
    assert.throws(() => f.act(), { code: "ERR_AUDIT_WRITE_FAILED" });
    assert.deepEqual(fs.readFileSync(f.log), bytes);
    assert.deepEqual(rawState(f), before);
    assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  });
}

test("simulated Windows audit boundary refuses before writing; not a native Windows test", { skip: !supported || !posix }, t => {
  const f = fixture(t), before = f.store.snapshot(), append = anchor.appendEntry;
  const platform = Object.getOwnPropertyDescriptor(process, "platform"); let error;
  anchor.appendEntry = function(file, entry, ...capability) {
    if (entry.type === "abort") Object.defineProperty(process, "platform", platform);
    const result = append(file, entry, ...capability);
    if (entry.type === "intent") Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    return result;
  };
  try { f.act(); } catch (e) { error = e; }
  finally { Object.defineProperty(process, "platform", platform); anchor.appendEntry = append; }
  assert.equal(error.code, "ERR_AUDIT_WRITE_FAILED");
  assert.equal(error.cause.code, "ERR_AUDIT_DURABILITY_UNSUPPORTED");
  assert.equal(fs.existsSync(f.log), false);
  assert.deepEqual(rawState(f), before);
  assert.throws(() => f.act(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

for (const boundary of ["success", "before-commit", "after-commit"]) {
  test(`real SQLite COMMIT boundary: ${boundary}`, { skip: !supported || !posix }, t => {
    const f = fixture(t), before = f.store.snapshot(), probe = instrument(f);
    const { DatabaseSync } = require("node:sqlite"), exec = DatabaseSync.prototype.exec;
    let commits = 0, error;
    DatabaseSync.prototype.exec = function(sql, ...args) {
      if (sql === "COMMIT" && new Error().stack.includes("#transactionUnlocked")) {
        commits++;
        assert.deepEqual(probe.events.slice(-3), ["audit:close", "directory:fsync", "directory:close"]);
        if (boundary === "before-commit") throw Error("fixture before COMMIT");
        const result = exec.call(this, sql, ...args);
        if (boundary === "after-commit") throw Error("fixture after COMMIT");
        return result;
      }
      return exec.call(this, sql, ...args);
    };
    try { f.act(); } catch (e) { error = e; }
    finally { DatabaseSync.prototype.exec = exec; probe.restore(); }
    assert.equal(commits, 1);
    if (boundary === "success") { assert.equal(error, undefined); assert.ok(f.store.snapshot().witness_authority.targets["target-a"]); }
    else { assert.match(error.message, /fixture .* COMMIT/); assert.throws(() => f.act(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" }); }
    const state = childState(f);
    if (boundary === "before-commit") assert.deepEqual(state, before);
    else assert.ok(state.witness_authority.targets["target-a"]);
    // A complete precommit audit also exists in the rollback case.
    assert.equal(JSON.parse(fs.readFileSync(f.log, "utf8")).event, "transaction");
  });
}
