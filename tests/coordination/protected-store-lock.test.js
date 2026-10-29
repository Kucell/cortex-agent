"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const lock = require("../../lib/coordination/protected-store-lock");
const supported = Number(process.versions.node.split(".")[0]) >= 24;
function fixture(t) {
  // The root is canonicalised because the temporary directory is reached
  // through a platform alias on macOS (/var is a symbolic link to
  // /private/var). The lock implementation resolves the anchor path, so the
  // paths the test compares against must be canonical as well -- otherwise a
  // legitimate anchor is reported under two spellings and the comparison
  // silently fails.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "store-lock-")));
  const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  const file = path.join(dbDir, "state.sqlite");
  const options = { expectedDecisionId: "D-lock-test", minimumEpoch: 1, anchorDir, clock: () => 1000000, anchorMode: "permissive",
    audit: { by: "synthetic-test", reason: "crash-test" }, acceptDatabaseAsTruth: true };
  const store = Store.initialize(file, { ...options, decisionId: "D-lock-test" });
  const lease = store.acquire({ owner: "test", sessionId: "s", hostId: "h", workerId: "w", runId: "r", generation: "g",
    desktopKey: "d", ownedAppId: "a", idempotencyKey: "lease", ttlMs: 60000 });
  const fields = { ...lease, idempotencyKey: "permit", operation: "uia.invoke", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 10000 };
  const children = [];
  t.after(async () => { for (const c of children) { if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGKILL"); await c.done; } store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function child(mode, point = "") {
    const proc = spawn(process.execPath, [path.join(__dirname, "fixtures/m044-store-window.js"), file, anchorDir, mode, point, path.join(root, "release"), JSON.stringify(fields)], { stdio: ["ignore", "pipe", "pipe"] });
    const events = [], waiters = []; let stderr = "";
    proc.stderr.on("data", x => { stderr += x; });
    readline.createInterface({ input: proc.stdout }).on("line", line => { const e = JSON.parse(line); events.push(e); for (const w of [...waiters]) if (w.name === e.event) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(e); } });
    const done = new Promise((resolve, reject) => { proc.once("error", reject); proc.once("close", (code, signal) => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(`missing ${w.name}: ${code}/${signal} ${stderr}`)); } resolve({ code, signal }); }); });
    const c = { proc, done, events, wait(name) { const found = events.find(e => e.event === name); if (found) return Promise.resolve(found); return new Promise((resolve, reject) => { const w = { name, resolve, reject }; w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`deadline: ${name}`)); }, 12000); waiters.push(w); }); } };
    children.push(c); return c;
  }
  return { root, file, anchorDir, options, store, fields, child, release() { fs.writeFileSync(path.join(root, "release"), "go"); } };
}
test("live post-COMMIT writer excludes a second open and issues one permit", { skip: !supported }, async t => {
  const f = fixture(t), writer = f.child("writer", "db"); await writer.wait("paused");
  const reader = f.child("reader"); await reader.wait("starting");
  assert.equal(reader.events.some(e => e.event === "result"), false);
  f.release(); const a = await writer.wait("result"), b = await reader.wait("result");
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b)); assert.equal(a.permitId, b.permitId);
  assert.equal(Object.keys(f.store.snapshot().permits).length, 1);
});
for (const point of ["intent", "db", "journal", "highwater"]) test(`real SIGKILL at ${point} releases coordination without laundering state`, { skip: !supported }, async t => {
  const f = fixture(t), writer = f.child("writer", point); await writer.wait("paused"); writer.proc.kill("SIGKILL");
  assert.equal((await writer.done).signal, "SIGKILL");
  if (point === "db") {
    assert.throws(() => Store.open(f.file, f.options), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
    assert.throws(() => f.store.reserve(f.fields), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
    assert.throws(() => f.store.snapshot(), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
    assert.equal(Store.recoverFromAnchorCrash(f.file, f.options).recovered, true);
  }
  const reopened = Store.open(f.file, f.options);
  try { const a = reopened.reserve(f.fields), b = reopened.reserve(f.fields); assert.equal(a.permitId, b.permitId); assert.equal(Object.keys(reopened.snapshot().permits).length, 1); }
  finally { reopened.close(); }
});
test("contention is bounded, never auto-recovers or retries business work", { skip: !supported }, async t => {
  const f = fixture(t), writer = f.child("writer", "db"); await writer.wait("paused");
  const reader = f.child("reader"); const start = Date.now(); const result = await reader.wait("result");
  assert.deepEqual(result, { event: "result", ok: false, code: "ERR_COORDINATION_BUSY" });
  assert.ok(Date.now() - start < 10000); f.release(); assert.equal((await writer.wait("result")).ok, true);
});
test("recovery waits for live writer then refuses non-crash recovery", { skip: !supported }, async t => {
  const f = fixture(t), writer = f.child("writer", "db"); await writer.wait("paused");
  const recovery = f.child("recover"); await recovery.wait("starting"); f.release(); await writer.done;
  assert.deepEqual(await recovery.wait("result"), { event: "result", ok: false, code: "ERR_RECOVERY_NOT_APPLICABLE" });
});
for (const kind of ["missing", "symlink", "hardlink", "mode", "corrupt", "replaced"]) test(`coordination ${kind} fails closed without repair`, { skip: !supported }, t => {
  const f = fixture(t), file = path.join(f.anchorDir, lock.FILE), backup = path.join(f.root, "original");
  if (kind === "missing") fs.unlinkSync(file);
  if (kind === "symlink") { fs.renameSync(file, backup); fs.symlinkSync(backup, file); }
  if (kind === "hardlink") fs.linkSync(file, backup);
  if (kind === "mode") fs.chmodSync(file, 0o666);
  if (kind === "corrupt") fs.writeFileSync(file, "broken");
  if (kind === "replaced") { fs.renameSync(file, backup); fs.copyFileSync(backup, file); }
  assert.throws(() => f.store.reserve(f.fields));
  assert.equal(fs.existsSync(file), kind !== "missing");
});
test("reset keeps the lock inode and invalidates old lease instead of split lock domains", { skip: !supported }, t => {
  const f = fixture(t), file = path.join(f.anchorDir, lock.FILE), before = fs.statSync(file).ino;
  const reset = Store.resetAfterAnchorLoss(f.file, f.options); assert.equal(reset.reset, true);
  assert.equal(fs.statSync(file).ino, before);
  assert.throws(() => f.store.reserve(f.fields), { code: "ERR_ANCHOR_STORE_MISMATCH" });
});

// Frozen production v1 from 31ffc2f7; execute its real open/write/recovery code.
function oldStore() {
  const Module = require("node:module");
  const filename = path.resolve(__dirname, "../../lib/coordination/protected-permit-store.js");
  const m = new Module(filename, module);
  m.filename = filename; m.paths = module.paths;
  m._compile(fs.readFileSync(path.join(__dirname, "fixtures/protected-permit-store-v1-source.txt"), "utf8"), filename);
  return m.exports.ProtectedPermitStore;
}
test("real v1 implementation refuses v2 open and recovery", { skip: !supported }, t => {
  const f = fixture(t), Old = oldStore();
  for (const method of ["open", "recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
    assert.throws(() => Old[method](f.file, f.options), { code: "ERR_STATE_INVALID" });
  }
});
test("an already-open real v1 handle refuses a v2 body before writing", { skip: !supported }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "store-v1-handle-")));
  const dir = path.join(root, "db"), anchorDir = path.join(root, "anchor"); fs.mkdirSync(dir); fs.mkdirSync(anchorDir);
  const file = path.join(dir, "state.sqlite"), Old = oldStore();
  const old = Old.initialize(file, { decisionId: "D-old", anchorDir, anchorMode: "permissive", clock: () => 1000000 });
  t.after(() => { old.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(file);
  const body = JSON.parse(db.prepare("SELECT body FROM protected_state").get().body); body.schema_version = 2;
  const text = JSON.stringify(body), hash = require("node:crypto").createHash("sha256").update(text).digest("hex");
  db.prepare("UPDATE protected_state SET body=?,sha256=?").run(text, hash); db.exec("PRAGMA user_version=2"); db.close();
  // Synthetic format switch only: no production upgrade entry point is provided.
  assert.throws(() => old.acquire({ owner: "test", sessionId: "s", hostId: "h", workerId: "w", runId: "r", generation: "g", desktopKey: "d", ownedAppId: "a", idempotencyKey: "lease", ttlMs: 60000 }), { code: "ERR_STATE_INVALID" });
});
test("v1 database and absent lock are never silently upgraded", { skip: !supported }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "store-v1-refuse-")));
  const dir = path.join(root, "db"), anchorDir = path.join(root, "anchor"); fs.mkdirSync(dir); fs.mkdirSync(anchorDir);
  const file = path.join(dir, "state.sqlite"), old = oldStore().initialize(file, { decisionId: "D-old", anchorDir, anchorMode: "permissive" }); old.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readFileSync(file);
  for (const method of ["open", "recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
    assert.throws(() => Store[method](file, { expectedDecisionId: "D-old", minimumEpoch: 1, anchorDir, anchorMode: "permissive" }), { code: "ERR_STATE_INVALID" });
  }
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(anchorDir, lock.FILE)), false);
});

test("action failure is retained when lock rollback also fails, and close releases it", { skip: !supported }, t => {
  const f = fixture(t), { DatabaseSync } = require("node:sqlite"), exec = DatabaseSync.prototype.exec;
  const primary = new Error("PRIMARY"), cleanup = new Error("CLEANUP");
  DatabaseSync.prototype.exec = function(sql) { if (sql === "ROLLBACK") throw cleanup; return exec.call(this, sql); };
  try { assert.throws(() => lock.withLock(f.anchorDir, () => { throw primary; }), error => error === primary && error.cleanupError === cleanup); }
  finally { DatabaseSync.prototype.exec = exec; }
  assert.equal(lock.withLock(f.anchorDir, () => "released"), "released");
});
test("open closes its not-yet-delivered business connection if coordination commit fails", { skip: !supported }, t => {
  const f = fixture(t), { DatabaseSync } = require("node:sqlite"), exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  let closedBusiness = 0;
  const injected = new Error("LOCK_COMMIT_FAILED");
  const location = db => db.prepare("PRAGMA database_list").get().file;
  DatabaseSync.prototype.exec = function(sql) { if (sql === "COMMIT" && location(this).endsWith(lock.FILE)) throw injected; return exec.call(this, sql); };
  DatabaseSync.prototype.close = function() { if (location(this) === f.file) closedBusiness++; return close.call(this); };
  try { assert.throws(() => Store.open(f.file, f.options), error => error === injected); assert.equal(closedBusiness, 2); }
  finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close; }
  const reopened = Store.open(f.file, f.options); reopened.close();
});
test("an existing strict handle rechecks changed anchor permissions before read or write", { skip: !supported }, t => {
  const f = fixture(t);
  // Use a separate fresh strict store instead of changing committed witness data.
  const dir = path.join(f.root, "strict-db"), anchorDir = path.join(f.root, "strict-anchor"); fs.mkdirSync(dir); fs.mkdirSync(anchorDir, { mode: 0o700 });
  const store = Store.initialize(path.join(dir, "state.sqlite"), { decisionId: "D-strict", anchorDir });
  try {
    fs.chmodSync(anchorDir, 0o777);
    assert.throws(() => store.snapshot(), { code: "ERR_ANCHOR_PERMISSIONS" });
    assert.throws(() => store.reserve(f.fields), { code: "ERR_ANCHOR_PERMISSIONS" });
  }
  finally { fs.chmodSync(anchorDir, 0o700); store.close(); }
});

test("replaced parent identity refuses an already-open handle", { skip: !supported }, t => {
  const f = fixture(t), old = path.join(f.root, "old-anchor"); fs.renameSync(f.anchorDir, old); fs.mkdirSync(f.anchorDir);
  fs.copyFileSync(path.join(old, lock.FILE), path.join(f.anchorDir, lock.FILE));
  assert.throws(() => f.store.snapshot(), { code: "ERR_COORDINATION_LOCK_REPLACED" });
});
test("missing coordination domain refuses every recovery entry without recreating it", { skip: !supported }, t => {
  const f = fixture(t), file = path.join(f.anchorDir, lock.FILE); fs.unlinkSync(file);
  for (const method of ["open", "recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
    assert.throws(() => Store[method](f.file, f.options), { code: "ERR_COORDINATION_LOCK_MISSING" });
    assert.equal(fs.existsSync(file), false);
  }
});
test("nested coordination acquisition is bounded and releases the original lock", { skip: !supported }, t => {
  const f = fixture(t), start = Date.now();
  assert.throws(() => lock.withLock(f.anchorDir, () => lock.withLock(f.anchorDir, () => assert.fail("nested action"))), { code: "ERR_COORDINATION_BUSY" });
  assert.ok(Date.now() - start < 10000); assert.equal(lock.withLock(f.anchorDir, () => true), true);
});
