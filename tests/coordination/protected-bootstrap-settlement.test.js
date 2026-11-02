"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

// Contract tests for the settlement of a bootstrap that failed after it had
// started producing objects. The tests use a disposable anchor directory and
// a disposable SQLite database, and they never touch a real service, a key
// or a certificate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const anchorModule = require("../../lib/coordination/protected-anchor");
const bootstrapModule = require("../../lib/coordination/protected-bootstrap");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");

const root = testRuntime("test-tmp");

function fixture(t) {
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-bootstrap-settle-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(dbDir);
  fs.mkdirSync(anchorDir, { mode: 0o700 });
  const file = path.join(dbDir, "state.sqlite");
  const options = { decisionId: "D-settle", expectedDecisionId: "D-settle", minimumEpoch: 1,
    anchorDir, anchorMode: "permissive", clock: () => 1000 };
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the fixture may already be gone */ } });
  return { dir, dbDir, anchorDir, file, options };
}

// Fail the initialize exactly at the high-water barrier, which is the last
// step of the bootstrap. The database and the anchor entries exist at that
// point, so the bootstrap produced objects and cannot simply be retried.
function failAtHighWater(f) {
  const original = anchorModule.appendHighWater;
  anchorModule.appendHighWater = () => { throw Error("highwater barrier missing"); };
  try { Store.initialize(f.file, f.options); }
  catch (error) { assert.match(error.message, /highwater barrier missing/); }
  finally { anchorModule.appendHighWater = original; }
}

test("a failed bootstrap leaves the domain blocked and does not release the claim", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const state = bootstrapModule.bootstrapState(f.anchorDir);
  assert.equal(state.pending.length, 1);
  // The claim advanced to the publishing phase before the first side effect,
  // so the phase itself records that the domain is no longer untouched.
  assert.equal(state.pending[0].phase, "publishing");
  assert.throws(() => Store.open(f.file, f.options), { code: "ERR_BOOTSTRAP_PENDING" });
});

test("the failed bootstrap is classified as produced objects, not as untouched", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const plan = bootstrapModule.bootstrapState(f.anchorDir).pending[0];
  const verdict = bootstrapModule.classifyFailedBootstrap(f.anchorDir, plan);
  assert.equal(verdict.settled, false);
  assert.equal(verdict.clean, false);
  assert.equal(verdict.phase, "publishing");
});

test("a settlement on unique evidence completes the bootstrap and unblocks the domain", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const plan = bootstrapModule.bootstrapState(f.anchorDir).pending[0];
  const settled = Store.settleFailedBootstrap(f.file, { ...f.options,
    audit: { by: "fixture", reason: "contract test" }, bootstrapPlan: plan });
  assert.equal(settled.settled, true);
  assert.equal(settled.bootstrapId, plan.bootstrap_id);
  // The claim is retired and the high-water declaration exists, so the
  // ordinary open accepts the store again.
  const state = bootstrapModule.bootstrapState(f.anchorDir);
  assert.equal(state.pending.length, 0);
  assert.equal(state.completed.length, 1);
  const store = Store.open(f.file, f.options);
  assert.equal(store.snapshot().store_id, plan.store_id);
  store.close();
});

test("a settlement without an audit record is refused", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const plan = bootstrapModule.bootstrapState(f.anchorDir).pending[0];
  assert.throws(() => Store.settleFailedBootstrap(f.file, { ...f.options, bootstrapPlan: plan }),
    { code: "ERR_RECOVERY_AUDIT_REQUIRED" });
});

test("a settlement for a database that does not match the plan is refused", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const plan = bootstrapModule.bootstrapState(f.anchorDir).pending[0];
  const other = path.join(f.dbDir, "other.sqlite");
  fs.copyFileSync(f.file, other);
  assert.throws(() => Store.settleFailedBootstrap(other, { ...f.options,
    audit: { by: "fixture", reason: "contract test" }, bootstrapPlan: plan }),
    { code: "ERR_BOOTSTRAP_PLAN_MISMATCH" });
});

test("a settlement for a plan that does not match the pending claim is refused", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const plan = bootstrapModule.bootstrapState(f.anchorDir).pending[0];
  const foreign = { ...plan, bootstrap_id: bootstrapModule.newBootstrapId() };
  assert.throws(() => Store.settleFailedBootstrap(f.file, { ...f.options,
    audit: { by: "fixture", reason: "contract test" }, bootstrapPlan: foreign }),
    { code: "ERR_BOOTSTRAP_PENDING" });
});

test("a settlement without a pending claim is refused", t => {
  const f = fixture(t);
  const store = Store.initialize(f.file, f.options);
  store.close();
  assert.throws(() => Store.settleFailedBootstrap(f.file, { ...f.options,
    audit: { by: "fixture", reason: "contract test" }, bootstrapPlan: bootstrapModule.bootstrapPlan({
      bootstrap_id: bootstrapModule.newBootstrapId(), domain: "d", store_id: "s",
      body_digest: crypto.randomBytes(32).toString("hex"), sequence: 1, attempt: 1,
      database_path: f.file,
      owner: { owner_id: "owner-a", owner_generation: 1, fence: 1 },
    }) }), { code: "ERR_BOOTSTRAP_NOT_PENDING" });
});

test("a claim that never produced an object is released instead of settled forward", t => {
  const f = fixture(t);
  // A bootstrap that crashed between the registration and the first side
  // effect leaves a claim in the `registered` phase. Such a claim produced
  // nothing, so it is released and the domain becomes bootstrappable again
  // instead of staying blocked forever.
  const plan = bootstrapModule.bootstrapPlan({
    bootstrap_id: bootstrapModule.newBootstrapId(), domain: "d", store_id: "s",
    body_digest: crypto.randomBytes(32).toString("hex"), sequence: 1, attempt: 1,
    database_path: f.file,
    owner: { owner_id: "owner-a", owner_generation: 1, fence: 1 },
  });
  bootstrapModule.registerBootstrap(f.anchorDir, plan, { at_ms: 1000 });
  const result = Store.settleFailedBootstrap(f.file, { ...f.options,
    audit: { by: "fixture", reason: "contract test" }, bootstrapPlan: plan });
  assert.equal(result.settled, false);
  assert.equal(result.released, true);
  assert.equal(bootstrapModule.bootstrapState(f.anchorDir).pending.length, 0);
  // The domain is usable again.
  const store = Store.initialize(f.file, f.options);
  assert.equal(store.snapshot().store_id !== null, true);
  store.close();
});

test("a refused initialization leaves the claim released and the domain usable", t => {
  const f = fixture(t);
  // The parent directory is not empty, so the initialization is refused
  // before any object is created and the registration is released again.
  fs.writeFileSync(path.join(f.dbDir, "other.txt"), "x");
  assert.throws(() => Store.initialize(f.file, f.options), { code: "ERR_INIT_PATH_NOT_EMPTY" });
  const state = bootstrapModule.bootstrapState(f.anchorDir);
  assert.equal(state.pending.length, 0);
  assert.equal(state.empty, true);
});


function publicationName(f, fd) {
  const opened = fs.fstatSync(fd);
  return fs.readdirSync(f.anchorDir).find(name => {
    if (!name.includes(".tmp-bootstrap-")) return false;
    const named = fs.lstatSync(path.join(f.anchorDir, name));
    return named.dev === opened.dev && named.ino === opened.ino;
  });
}

function settleOptions(f, extra = {}) {
  return { ...f.options, audit: { by: "fixture", reason: "security regression" },
    bootstrapPlan: bootstrapModule.bootstrapState(f.anchorDir).pending[0], ...extra };
}
function changeBody(f, change) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(f.file);
  try {
    const body = JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id = 1").get().body);
    change(body);
    const bytes = JSON.stringify(body), hash = crypto.createHash("sha256").update(bytes).digest("hex");
    db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(bytes, hash);
    return hash;
  } finally { db.close(); }
}
function assertPending(f) {
  const state = bootstrapModule.bootstrapState(f.anchorDir);
  assert.equal(state.pending.length, 1);
  assert.equal(state.completed.length, 0);
}

for (const mutation of ["body", "database-inode", "claim-inode", "journal", "high-water"]) {
  test(`settlement refuses ${mutation} changed immediately before lock acquisition`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f), lock = require("../../lib/coordination/protected-store-lock"), original = lock.withLock;
    lock.withLock = function(dir, action, opts) {
      if (mutation === "body") changeBody(f, state => { state.last_clock_ms++; });
      if (mutation === "database-inode" || mutation === "claim-inode") {
        const file = mutation === "database-inode" ? f.file : path.join(f.anchorDir, bootstrapModule.CLAIM_FILE);
        fs.copyFileSync(file, file + ".replacement");
        fs.renameSync(file + ".replacement", file);
      }
      if (mutation === "journal") {
        const name = fs.readdirSync(f.anchorDir).find(name => name.startsWith("protected-anchor-entry-") && name.includes("intent"));
        fs.unlinkSync(path.join(f.anchorDir, name));
      }
      if (mutation === "high-water") anchorModule.appendHighWater(f.anchorDir, { sequence: 1,
        body_digest: options.bootstrapPlan.body_digest, store_id: options.bootstrapPlan.store_id, attempt: 1 });
      return original(dir, action, opts);
    };
    try {
      assert.throws(() => Store.settleFailedBootstrap(f.file, options), error => /^ERR_/.test(error.code));
      assertPending(f);
    } finally { lock.withLock = original; }
  });
}

test("settlement compares expectedDecisionId to the committed body", t => {
  const f = fixture(t);
  failAtHighWater(f);
  assert.throws(() => Store.settleFailedBootstrap(f.file, settleOptions(f, { expectedDecisionId: "D-foreign" })),
    { code: "ERR_DECISION_MISMATCH" });
  assertPending(f);
  assert.equal(fs.existsSync(path.join(f.anchorDir, anchorModule.HIGH_WATER_FILE)), false);
  const { DatabaseSync } = require("node:sqlite");
  const lockDb = new DatabaseSync(path.join(f.anchorDir, require("../../lib/coordination/protected-store-lock").FILE), { readOnly: true });
  try { assert.equal(lockDb.prepare("PRAGMA user_version").get().user_version, 0); }
  finally { lockDb.close(); }
  assert.equal(Store.settleFailedBootstrap(f.file, settleOptions(f)).settled, true);
  const reopened = Store.open(f.file, f.options);
  reopened.close();
});

test("settlement retries after an audit EIO without losing recovery eligibility", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const options = settleOptions(f), write = fs.writeSync;
  let injected = false;
  fs.writeSync = function(fd, ...args) {
    if (!injected && publicationName(f, fd)?.startsWith("protected-anchor-recovery.log.tmp-bootstrap-")) {
      injected = true;
      throw Object.assign(Error("audit failure"), { code: "EIO" });
    }
    return write.call(this, fd, ...args);
  };
  try { assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "EIO" }); }
  finally { fs.writeSync = write; }
  assert.equal(injected, true);
  assertPending(f);
  assert.equal(Store.settleFailedBootstrap(f.file, options).settled, true);
  assert.equal(bootstrapModule.bootstrapState(f.anchorDir).pending.length, 0);
  const reopened = Store.open(f.file, f.options);
  reopened.close();
});

for (const point of ["phase-sync", "version-commit", "high-water-before", "high-water-after", "high-water-sync", "final-audit", "lock-commit", "claim-retirement"]) {
  test(`settlement replays the bound plan after failure at ${point}`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f), { DatabaseSync } = require("node:sqlite");
    const write = fs.writeSync, rename = fs.renameSync,
      exec = DatabaseSync.prototype.exec, unlink = fs.unlinkSync, sync = fs.fsyncSync;
    let injected = false, commits = 0;
    const fault = () => { injected = true; throw Object.assign(Error(point), { code: "EIO" }); };
    fs.fsyncSync = function(fd) {
      const opened = fs.fstatSync(fd), domain = fs.statSync(f.anchorDir);
      if (point === "phase-sync" && opened.isDirectory() && opened.ino === domain.ino && opened.dev === domain.dev) fault();
      if (point === "high-water-sync" && publicationName(f, fd)?.startsWith(anchorModule.HIGH_WATER_FILE + ".tmp-bootstrap-") && opened.size > 0) fault();
      return sync.call(this, fd);
    };
    fs.writeSync = function(fd, bytes, ...args) {
      const name = publicationName(f, fd);
      if (point === "high-water-before" && name?.startsWith(anchorModule.HIGH_WATER_FILE + ".tmp-bootstrap-")) fault();
      if (point === "final-audit" && name?.includes("-audit-final-") && name.startsWith("protected-anchor-recovery.log.tmp-bootstrap-")) fault();
      return write.call(this, fd, bytes, ...args);
    };
    fs.renameSync = function(from, to, ...args) {
      const result = rename.call(this, from, to, ...args);
      if (point === "high-water-after" && to === path.join(f.anchorDir, anchorModule.HIGH_WATER_FILE)) fault();
      return result;
    };
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === "COMMIT" && this.prepare("PRAGMA database_list").get().file.endsWith("protected-store-coordination.sqlite")) {
        commits++;
        if ((point === "version-commit" && commits === 1) || (point === "lock-commit" && commits === 2)) fault();
      }
      return exec.call(this, sql);
    };
    fs.unlinkSync = function(file, ...args) {
      if (point === "claim-retirement" && file === path.join(f.anchorDir, bootstrapModule.CLAIM_FILE)) fault();
      return unlink.call(this, file, ...args);
    };
    try { assert.throws(() => Store.settleFailedBootstrap(f.file, options),
      { code: point === "phase-sync" ? "ERR_BOOTSTRAP_SYNC_FAILED" : "EIO" }); }
    finally {
      fs.writeSync = write; fs.renameSync = rename;
      DatabaseSync.prototype.exec = exec; fs.unlinkSync = unlink; fs.fsyncSync = sync;
    }
    assert.equal(injected, true);
    assert.equal(bootstrapModule.bootstrapState(f.anchorDir).phase, "settling");
    assert.throws(() => Store.open(f.file, f.options), { code: "ERR_BOOTSTRAP_PENDING" });
    assert.equal(Store.settleFailedBootstrap(f.file, options).settled, true);
    assert.equal(anchorModule.readHighWater(f.anchorDir).records, 1);
    const reopened = Store.open(f.file, f.options);
    reopened.close();
  });
}

for (const mutation of ["owner", "fence", "database-inode", "lock-inode", "journal-inode"]) {
  test(`a replay after audit EIO still refuses changed ${mutation}`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f), write = fs.writeSync;
    fs.writeSync = function(fd, ...args) {
      if (publicationName(f, fd)?.startsWith("protected-anchor-recovery.log.tmp-bootstrap-")) throw Object.assign(Error("audit failure"), { code: "EIO" });
      return write.call(this, fd, ...args);
    };
    try { assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "EIO" }); }
    finally { fs.writeSync = write; }
    if (mutation === "owner" || mutation === "fence") {
      const owner = { ...options.bootstrapPlan.owner, [mutation === "owner" ? "owner_id" : "fence"]: mutation === "owner" ? "foreign" : 99 };
      assert.throws(() => Store.settleFailedBootstrap(f.file, { ...options, bootstrapPlan: { ...options.bootstrapPlan, owner } }),
        { code: "ERR_BOOTSTRAP_PENDING" });
      assert.equal(Store.settleFailedBootstrap(f.file, options).settled, true);
    } else {
      const file = mutation === "database-inode" ? f.file : mutation === "lock-inode"
        ? path.join(f.anchorDir, require("../../lib/coordination/protected-store-lock").FILE)
        : path.join(f.anchorDir, fs.readdirSync(f.anchorDir).find(name => name.startsWith("protected-anchor-entry-")));
      fs.copyFileSync(file, file + ".replacement");
      fs.renameSync(file + ".replacement", file);
      assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "ERR_BOOTSTRAP_EVIDENCE_CHANGED" });
      assertPending(f);
    }
  });
}

for (const kind of ["empty", "unreadable", "unstatable", "unknown-publication"]) {
  test(`settlement never treats ${kind} high-water as missing`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f), file = path.join(f.anchorDir, anchorModule.HIGH_WATER_FILE),
      read = fs.readFileSync, stat = fs.lstatSync;
    if (kind !== "unknown-publication") fs.writeFileSync(file, "");
    else fs.writeFileSync(file + ".tmp-compact-owned", "partial");
    if (kind === "unreadable") fs.readFileSync = function(target, ...args) {
      if (target === file) throw Object.assign(Error("permission denied"), { code: "EACCES" });
      return read.call(this, target, ...args);
    };
    if (kind === "unstatable") fs.lstatSync = function(target, ...args) {
      if (target === file) throw Object.assign(Error("permission denied"), { code: "EACCES" });
      return stat.call(this, target, ...args);
    };
    try {
      assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: kind === "empty"
        ? "ERR_BOOTSTRAP_HIGH_WATER_EMPTY" : kind === "unknown-publication" ? "ERR_BOOTSTRAP_PUBLICATION_UNKNOWN" : "ERR_ANCHOR_UNREADABLE" });
      assertPending(f);
      if (kind !== "unknown-publication") assert.equal(stat(file).size, 0);
    } finally { fs.readFileSync = read; fs.lstatSync = stat; }
  });
}

for (const field of ["store_id", "anchor_sequence", "schema_version", "owner"]) {
  test(`settlement validates ${field} even with a matching body digest`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f), target = path.join(f.anchorDir, bootstrapModule.CLAIM_FILE);
    const claim = JSON.parse(fs.readFileSync(target));
    if (field === "owner") claim.plan.owner.fence++;
    else claim.plan.body_digest = changeBody(f, state => { state[field] = field === "store_id" ? "foreign-store" : 99; });
    fs.writeFileSync(target, JSON.stringify(claim));
    assert.throws(() => Store.settleFailedBootstrap(f.file, { ...options, bootstrapPlan: claim.plan }), error => /^ERR_/.test(error.code));
    assertPending(f);
  });
}

test("an already initialized recovery lock is not proof of a failed bootstrap owner", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const options = settleOptions(f), lock = require("../../lib/coordination/protected-store-lock");
  lock.reinitializeUninitializedLock(f.anchorDir);
  assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "ERR_BOOTSTRAP_EVIDENCE_INCOMPLETE" });
  assertPending(f);
});

test("settlement rereads evidence after a callback changes the body while locked", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const options = settleOptions(f, { clock: () => { changeBody(f, state => { state.last_clock_ms++; }); return 1001; } });
  assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "ERR_BOOTSTRAP_PLAN_MISMATCH" });
  assertPending(f);
});

function interruptPublication(f, options, key, mode) {
  const write = fs.writeSync;
  let interrupted;
  fs.writeSync = function(fd, bytes, ...args) {
    const name = publicationName(f, fd);
    if (!interrupted && name?.includes(`-${key}-`)) {
      interrupted = path.join(f.anchorDir, name);
      const claim = bootstrapModule.bootstrapState(f.anchorDir);
      assert.equal(claim.phase, "settling");
      const binding = JSON.parse(fs.readFileSync(path.join(f.anchorDir, bootstrapModule.CLAIM_FILE))).recovery.publications[key];
      const stat = fs.fstatSync(fd);
      assert.equal(binding.object, `${stat.dev}:${stat.ino}`);
      assert.equal(binding.temporary, name);
      if (mode !== "empty-eio") {
        // Perform a REAL 19-byte write; merely returning 19 is not a short
        // write reproduction because it leaves no interrupted bytes on disk.
        assert.equal(write.call(this, fd, bytes.subarray(0, 19), 0, 19, 0), 19);
        if (mode === "short") return 19;
      }
      throw Object.assign(Error("interrupted publication"), { code: "EIO" });
    }
    return write.call(this, fd, bytes, ...args);
  };
  try {
    assert.throws(() => Store.settleFailedBootstrap(f.file, options),
      { code: mode === "short" ? "ERR_BOOTSTRAP_WRITE_INCOMPLETE" : "EIO" });
  } finally { fs.writeSync = write; }
  assert.ok(interrupted, "fault must reach the bound publication inode");
  assert.equal(fs.statSync(interrupted).size, mode === "empty-eio" ? 0 : 19);
  assertPending(f);
  assert.throws(() => Store.open(f.file, f.options), { code: "ERR_BOOTSTRAP_PENDING" });
  return interrupted;
}

function assertSettledExactlyOnce(f, options) {
  const result = Store.settleFailedBootstrap(f.file, options);
  assert.equal(result.settled, true);
  assert.equal(result.bootstrapId, options.bootstrapPlan.bootstrap_id);
  assert.equal(bootstrapModule.bootstrapState(f.anchorDir).pending.length, 0);
  assert.equal(anchorModule.readHighWater(f.anchorDir).records, 1);
  const log = fs.readFileSync(path.join(f.anchorDir, "protected-anchor-recovery.log"), "utf8");
  assert.ok(log.endsWith("\n"));
  const records = log.trimEnd().split("\n").map(line => JSON.parse(line));
  const settlement = records.filter(record => record.bootstrap_id === result.bootstrapId);
  assert.deepEqual(settlement.map(record => record.settlement), [
    "failed-bootstrap-settlement-attempt", "failed-bootstrap-forward-settled",
  ]);
  assert.deepEqual(settlement[1], result.audit);
  const store = Store.open(f.file, f.options);
  try { assert.equal(store.snapshot().store_id, options.bootstrapPlan.store_id); }
  finally { store.close(); }
  return records;
}

test("F3: an independently created exact high-water cannot settle a claim without its publication descriptor", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const options = settleOptions(f);
  interruptPublication(f, options, "audit-attempt", "partial-eio");
  const claimFile = path.join(f.anchorDir, bootstrapModule.CLAIM_FILE);
  const claimBefore = fs.readFileSync(claimFile);
  assert.equal(JSON.parse(claimBefore).recovery.publications["high-water"], undefined);
  const water = path.join(f.anchorDir, anchorModule.HIGH_WATER_FILE);
  const bytes = anchorModule.highWaterPublicationBytes(options.bootstrapPlan);
  fs.writeFileSync(water, bytes, { flag: "wx", mode: 0o600 });
  const stat = fs.statSync(water);
  assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "ERR_BOOTSTRAP_EVIDENCE_CHANGED" });
  assert.deepEqual(fs.readFileSync(water), bytes);
  assert.equal(fs.statSync(water).ino, stat.ino);
  assert.deepEqual(fs.readFileSync(claimFile), claimBefore);
  assertPending(f);
});

for (const mutation of ["none", "inode", "bytes"]) {
  test(`F3: a settlement's published high-water requires its original inode and full bytes (${mutation})`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f);
    interruptPublication(f, options, "audit-final", "partial-eio");
    const water = path.join(f.anchorDir, anchorModule.HIGH_WATER_FILE);
    const binding = JSON.parse(fs.readFileSync(path.join(f.anchorDir, bootstrapModule.CLAIM_FILE))).recovery.publications["high-water"];
    const stat = fs.statSync(water);
    assert.equal(binding.object, `${stat.dev}:${stat.ino}`);
    assert.equal(binding.hex, fs.readFileSync(water, "hex"));
    assert.equal(fs.existsSync(path.join(f.anchorDir, binding.temporary)), false);
    if (mutation === "none") {
      assertSettledExactlyOnce(f, options);
      assert.equal(fs.statSync(water).ino, stat.ino);
    } else {
      if (mutation === "inode") {
        fs.copyFileSync(water, water + ".replacement");
        fs.renameSync(water + ".replacement", water);
      } else fs.appendFileSync(water, "\n"); // Same parsed declaration, different full bytes.
      const before = fs.readFileSync(water);
      assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "ERR_BOOTSTRAP_EVIDENCE_CHANGED" });
      assert.deepEqual(fs.readFileSync(water), before);
      assertPending(f);
    }
  });
}

for (const mode of ["empty-eio", "short", "partial-eio"]) {
  test(`R2: high-water ${mode} leaves a bound interrupted object and replays the original plan`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f);
    const interrupted = interruptPublication(f, options, "high-water", mode);
    // The interrupted object is the temporary inode: incomplete bytes must
    // never become the official high-water declaration.
    assert.equal(fs.existsSync(path.join(f.anchorDir, anchorModule.HIGH_WATER_FILE)), false);
    assertSettledExactlyOnce(f, options);
    assert.equal(fs.existsSync(interrupted), false);
  });
}

for (const key of ["audit-attempt", "audit-final"]) {
  for (const mode of ["empty-eio", "short", "partial-eio"]) {
    test(`MEDIUM: ${key} ${mode} replays without an invalid JSON tail or duplicate record`, t => {
      const f = fixture(t);
      failAtHighWater(f);
      const prior = JSON.stringify({ settlement: "prior-audit", reason: "保留既有审计" }) + "\n";
      const log = path.join(f.anchorDir, "protected-anchor-recovery.log");
      fs.writeFileSync(log, prior, { mode: 0o600 });
      const options = settleOptions(f);
      const interrupted = interruptPublication(f, options, key, mode);
      const visible = fs.readFileSync(log, "utf8");
      assert.ok(visible.startsWith(prior));
      assert.equal(visible.trimEnd().split("\n").length, key === "audit-attempt" ? 1 : 2);
      for (const line of visible.trimEnd().split("\n")) JSON.parse(line);
      const records = assertSettledExactlyOnce(f, options);
      assert.equal(records.length, 3);
      assert.deepEqual(records[0], JSON.parse(prior));
      assert.equal(fs.existsSync(interrupted), false);
    });
  }
}

for (const key of ["high-water", "audit-attempt", "audit-final"]) {
  for (const mutation of ["content", "inode", "symlink", "hardlink"]) {
    test(`bound ${key} temporary with foreign ${mutation} is never repaired or discarded`, t => {
      const f = fixture(t);
      failAtHighWater(f);
      const options = settleOptions(f), interrupted = interruptPublication(f, options, key, "partial-eio");
      if (mutation === "content") fs.writeFileSync(interrupted, '{"store_id":"someone-else",');
      if (mutation === "inode") {
        fs.copyFileSync(interrupted, interrupted + ".replacement");
        fs.renameSync(interrupted + ".replacement", interrupted);
      }
      if (mutation === "symlink") {
        const foreign = path.join(f.dir, "foreign-evidence");
        fs.renameSync(interrupted, foreign);
        fs.symlinkSync(foreign, interrupted);
      }
      if (mutation === "hardlink") fs.linkSync(interrupted, path.join(f.dir, "foreign-link"));
      const before = fs.readFileSync(interrupted);
      assert.throws(() => Store.settleFailedBootstrap(f.file, options), {
        code: mutation === "symlink" || mutation === "hardlink" ? "ERR_UNSAFE_PATH" : "ERR_BOOTSTRAP_EVIDENCE_CHANGED",
      });
      assert.deepEqual(fs.readFileSync(interrupted), before);
      assertPending(f);
    });
  }
}

for (const phase of ["publishing", "settling"]) {
  for (const content of ["", '{"store_id":"someone-else",', "a valid but foreign declaration"]) {
    test(`R2: unbound ${JSON.stringify(content)} formal high-water in ${phase} is refused`, t => {
      const f = fixture(t);
      failAtHighWater(f);
      const options = settleOptions(f);
      if (phase === "settling") interruptPublication(f, options, "high-water", "partial-eio");
      const water = path.join(f.anchorDir, anchorModule.HIGH_WATER_FILE);
      if (content === "a valid but foreign declaration") {
        anchorModule.appendHighWater(f.anchorDir, { sequence: 1, body_digest: "f".repeat(64), store_id: "someone-else", attempt: 1 });
      } else fs.writeFileSync(water, content);
      const before = fs.readFileSync(water);
      assert.throws(() => Store.settleFailedBootstrap(f.file, options), error => /^ERR_/.test(error.code));
      assert.deepEqual(fs.readFileSync(water), before);
      assertPending(f);
    });
  }
}

test("an unbound partial audit tail is refused and preserved", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const options = settleOptions(f), log = path.join(f.anchorDir, "protected-anchor-recovery.log");
  const partial = '{"settlement":"foreign-interrupted';
  fs.writeFileSync(log, partial);
  assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "ERR_BOOTSTRAP_EVIDENCE_CHANGED" });
  assert.equal(fs.readFileSync(log, "utf8"), partial);
  assertPending(f);
});

for (const key of ["high-water", "audit-attempt", "audit-final"]) {
  for (const point of ["empty-file-sync", "stage-directory-sync", "binding-directory-sync",
    "data-sync", "before-rename", "after-rename", "publication-directory-sync"]) {
    test(`${key} replays after ${point} failure with one declaration and two valid audit records`, t => {
      const f = fixture(t);
      failAtHighWater(f);
      const options = settleOptions(f), sync = fs.fsyncSync, rename = fs.renameSync;
      let injected = false, bindingRenamed = false, publicationRenamed = false;
      const fault = () => { injected = true; throw Object.assign(Error(point), { code: "EIO" }); };
      fs.renameSync = function(from, to, ...args) {
        const publishing = path.basename(from).includes(`-${key}-`) && path.basename(from).includes(".tmp-bootstrap-");
        if (!injected && publishing && point === "before-rename") fault();
        const result = rename.call(this, from, to, ...args);
        if (publishing) {
          publicationRenamed = true;
          if (!injected && point === "after-rename") fault();
        }
        if (to === path.join(f.anchorDir, bootstrapModule.CLAIM_FILE)) {
          const claim = JSON.parse(fs.readFileSync(to));
          if (claim.recovery?.publications?.[key]) bindingRenamed = true;
        }
        return result;
      };
      fs.fsyncSync = function(fd) {
        if (!injected) {
          const stat = fs.fstatSync(fd), name = publicationName(f, fd);
          if (name?.includes(`-${key}-`)) {
            if ((point === "empty-file-sync" && stat.size === 0) || (point === "data-sync" && stat.size > 0)) fault();
          }
          if (stat.isDirectory()) {
            const hasStage = fs.readdirSync(f.anchorDir).some(name => name.includes(".tmp-bootstrap-") && name.includes(`-${key}-`));
            if ((point === "stage-directory-sync" && hasStage && !bindingRenamed) ||
                (point === "binding-directory-sync" && bindingRenamed) ||
                (point === "publication-directory-sync" && publicationRenamed)) fault();
          }
        }
        return sync.call(this, fd);
      };
      try {
        assert.throws(() => Store.settleFailedBootstrap(f.file, options), {
          code: point.endsWith("directory-sync") ? "ERR_BOOTSTRAP_SYNC_FAILED" : "EIO",
        });
      } finally { fs.fsyncSync = sync; fs.renameSync = rename; }
      assert.equal(injected, true);
      assertPending(f);
      assertSettledExactlyOnce(f, options);
    });
  }
}

test("a changed audit identity cannot replace the original replay record", t => {
  const f = fixture(t);
  failAtHighWater(f);
  const options = settleOptions(f);
  interruptPublication(f, options, "audit-final", "partial-eio");
  assert.throws(() => Store.settleFailedBootstrap(f.file, { ...options,
    audit: { by: "different-admin", reason: "different-reason" } }), { code: "ERR_BOOTSTRAP_EVIDENCE_CHANGED" });
  assertPending(f);
  assertSettledExactlyOnce(f, options);
});

for (const key of ["audit-attempt", "audit-final"]) {
  test(`${key} refuses an unbound partial tail added to the formal audit log during replay`, t => {
    const f = fixture(t);
    failAtHighWater(f);
    const options = settleOptions(f);
    interruptPublication(f, options, key, "partial-eio");
    const log = path.join(f.anchorDir, "protected-anchor-recovery.log");
    fs.appendFileSync(log, '{"foreign":"partial');
    const evidence = fs.readFileSync(log);
    assert.throws(() => Store.settleFailedBootstrap(f.file, options), { code: "ERR_BOOTSTRAP_EVIDENCE_CHANGED" });
    assert.deepEqual(fs.readFileSync(log), evidence);
    assertPending(f);
  });
}
