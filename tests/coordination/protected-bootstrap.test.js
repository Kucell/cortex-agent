"use strict";

// Contract tests for the candidate bootstrap protocol. The tests use a
// temporary anchor directory and never touch a business database, a
// certificate, a key or a real service.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const testRoot = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
fs.mkdirSync(testRoot, { recursive: true });
const crypto = require("node:crypto");
const bootstrap = require("../../lib/coordination/protected-bootstrap");

const createdDirs = [];
test.after(() => { for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function anchorDir() {
  const dir = path.join(testRoot, `permit-bootstrap-${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  createdDirs.push(dir);
  return dir;
}

function plan(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(testRoot, "permit-bootstrap-plan-"));
  createdDirs.push(dir);
  return {
    database_path: path.join(dir, "authority.sqlite"),
    bootstrap_id: bootstrap.newBootstrapId(),
    domain: "domain-a",
    store_id: "store-a",
    body_digest: crypto.randomBytes(32).toString("hex"),
    sequence: 1,
    attempt: 1,
    owner: { owner_id: "owner-a", owner_generation: 1, fence: 1 },
    ...overrides,
  };
}

test("settlement phase durably preserves the immutable plan, owner and recovery binding", () => {
  const dir = anchorDir(), p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  bootstrap.advanceBootstrapPhase(dir, p, "publishing", { at_ms: 1001 });
  const recovery = { claim_identity: "original-claim", lock_identity: "original-lock",
    database_identity: "original-database", evidence_digest: "a".repeat(64) };
  bootstrap.withBootstrapLock(dir, locked => {
    assert.throws(() => locked.advance(p, "settling"), { code: "ERR_BOOTSTRAP_INPUT" });
    locked.advance(p, "settling", { at_ms: 1002, recovery });
    const before = locked.readClaim();
    assert.deepStrictEqual(before.plan, bootstrap.bootstrapPlan(p));
    assert.deepStrictEqual(before.recovery, recovery);
    assert.strictEqual(before.at_ms, 1002);
    locked.advance(p, "settling", { at_ms: 9999, recovery: { ...recovery, lock_identity: "foreign" } });
    assert.deepStrictEqual(locked.readClaim(), before);
    assert.throws(() => locked.advance(p, "publishing"), { code: "ERR_BOOTSTRAP_PHASE_INVALID" });
    assert.throws(() => locked.advance({ ...p, owner: { ...p.owner, fence: 2 } }, "settling", { recovery }),
      { code: "ERR_BOOTSTRAP_PENDING" });
    locked.complete(p, { at_ms: 1002 });
  });
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 0);
  assert.strictEqual(bootstrap.bootstrapState(dir).completed.length, 1);
});

test("an empty anchor domain is empty", () => {
  const dir = anchorDir();
  const state = bootstrap.bootstrapState(dir);
  assert.strictEqual(state.empty, true);
  assert.strictEqual(state.started, false);
  assert.deepStrictEqual([...state.pending], []);
});

test("registering a bootstrap makes the domain non-empty", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const state = bootstrap.bootstrapState(dir);
  assert.strictEqual(state.empty, false);
  assert.strictEqual(state.started, true);
  assert.strictEqual(state.pending.length, 1);
  assert.strictEqual(state.pending[0].bootstrap_id, p.bootstrap_id);
});

test("the registration is persisted before it is reported", () => {
  const dir = anchorDir();
  const p = plan();
  const registration = bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  assert.ok(fs.existsSync(registration.path));
  const written = JSON.parse(fs.readFileSync(registration.path, "utf8"));
  assert.strictEqual(written.schema_version, bootstrap.BOOTSTRAP_SCHEMA_VERSION);
  assert.strictEqual(written.phase, "registered");
  assert.strictEqual(written.plan.bootstrap_id, p.bootstrap_id);
});

test("the registration claims the domain exclusively", () => {
  const dir = anchorDir();
  const first = plan();
  const second = plan();
  bootstrap.registerBootstrap(dir, first, { at_ms: 1000 });
  // A different bootstrap must not overwrite the winner's registration.
  assert.throws(
    () => bootstrap.registerBootstrap(dir, second, { at_ms: 1001 }),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
  const state = bootstrap.bootstrapState(dir);
  assert.strictEqual(state.pending[0].bootstrap_id, first.bootstrap_id);
});

test("re-registering the same bootstrap is idempotent", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const again = bootstrap.registerBootstrap(dir, p, { at_ms: 1001 });
  assert.strictEqual(again.reused, true);
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("a same-identity registration with a different plan is refused", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  // Same identity, different store: a recovery that trusted the identity
  // alone would act on the wrong object.
  const other = plan({ bootstrap_id: p.bootstrap_id, store_id: "store-other" });
  assert.throws(
    () => bootstrap.registerBootstrap(dir, other, { at_ms: 1001 }),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
  // The claim on disk still carries the original plan.
  const state = bootstrap.bootstrapState(dir);
  assert.strictEqual(state.pending[0].store_id, p.store_id);
});

test("a same-identity registration with a different digest is refused", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const other = plan({ bootstrap_id: p.bootstrap_id, body_digest: "b".repeat(64) });
  assert.throws(
    () => bootstrap.registerBootstrap(dir, other, { at_ms: 1001 }),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
});

test("a same-identity registration with a different database path is refused", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const other = plan({ bootstrap_id: p.bootstrap_id, database_path: path.join(testRoot, "other.sqlite") });
  assert.throws(
    () => bootstrap.registerBootstrap(dir, other, { at_ms: 1001 }),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
});

test("a same-identity registration with a different owner generation is refused", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const other = plan({ bootstrap_id: p.bootstrap_id, owner: { owner_id: p.owner.owner_id, owner_generation: 2, fence: p.owner.fence } });
  assert.throws(
    () => bootstrap.registerBootstrap(dir, other, { at_ms: 1000 }),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("a same-identity registration with a different fence is refused", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const other = plan({ bootstrap_id: p.bootstrap_id, owner: { owner_id: p.owner.owner_id, owner_generation: p.owner.owner_generation, fence: p.owner.fence + 1 } });
  assert.throws(
    () => bootstrap.registerBootstrap(dir, other, { at_ms: 1000 }),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("a plan without an owner binding is refused", () => {
  assert.throws(
    () => bootstrap.bootstrapPlan({ bootstrap_id: bootstrap.newBootstrapId(), domain: "d", store_id: "s",
      body_digest: "a".repeat(64), sequence: 1, attempt: 1, database_path: path.join(testRoot, "x.sqlite") }),
    (error) => error.code === "ERR_BOOTSTRAP_INPUT",
  );
});

test("a completed bootstrap leaves no unresolved pending", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  bootstrap.completeBootstrap(dir, p, { at_ms: 2000 });
  const state = bootstrap.bootstrapState(dir);
  assert.strictEqual(state.pending.length, 0);
  assert.strictEqual(state.completed.length, 1);
  assert.strictEqual(state.started, true);
});

test("the completion record is kept as evidence", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const completion = bootstrap.completeBootstrap(dir, p, { at_ms: 2000 });
  assert.ok(fs.existsSync(completion.path));
});

test("a completed bootstrap releases the claim for a later one", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  bootstrap.completeBootstrap(dir, p, { at_ms: 2000 });
  const later = plan();
  const registration = bootstrap.registerBootstrap(dir, later, { at_ms: 3000 });
  assert.strictEqual(registration.reused, false);
});

test("a different bootstrap is refused while one is pending", () => {
  const dir = anchorDir();
  bootstrap.registerBootstrap(dir, plan(), { at_ms: 1000 });
  assert.throws(
    () => bootstrap.assertBootstrapAllowed(dir, plan()),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
});

test("the same bootstrap may be re-asserted while pending", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const state = bootstrap.assertBootstrapAllowed(dir, p);
  assert.strictEqual(state.pending.length, 1);
});

test("a completed bootstrap does not block a later one", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  bootstrap.completeBootstrap(dir, p, { at_ms: 2000 });
  const state = bootstrap.assertBootstrapAllowed(dir, plan());
  assert.strictEqual(state.pending.length, 0);
});

test("a damaged registration blocks the domain", () => {
  const dir = anchorDir();
  const registration = bootstrap.registerBootstrap(dir, plan(), { at_ms: 1000 });
  fs.writeFileSync(registration.path, "{not json");
  assert.throws(
    () => bootstrap.bootstrapState(dir),
    (error) => error.code === "ERR_BOOTSTRAP_CORRUPT",
  );
});

test("a registration with an unknown schema version blocks the domain", () => {
  const dir = anchorDir();
  const registration = bootstrap.registerBootstrap(dir, plan(), { at_ms: 1000 });
  fs.writeFileSync(registration.path, JSON.stringify({ schema_version: 99, plan: plan(), at_ms: 1 }) + "\n");
  assert.throws(
    () => bootstrap.bootstrapState(dir),
    (error) => error.code === "ERR_BOOTSTRAP_CORRUPT",
  );
});

test("a temporary registration file is ignored, not treated as corruption", () => {
  const dir = anchorDir();
  bootstrap.registerBootstrap(dir, plan(), { at_ms: 1000 });
  fs.writeFileSync(path.join(dir, `${bootstrap.CLAIM_FILE}.tmp-123-abcdef`), "partial");
  const state = bootstrap.bootstrapState(dir);
  assert.strictEqual(state.pending.length, 1);
});

test("an invalid plan is refused", () => {
  assert.throws(
    () => bootstrap.bootstrapPlan({ bootstrap_id: "not-hex" }),
    (error) => error.code === "ERR_BOOTSTRAP_INPUT",
  );
});

test("a plan with a bad digest is refused", () => {
  const p = plan();
  assert.throws(
    () => bootstrap.bootstrapPlan({ ...p, body_digest: "short" }),
    (error) => error.code === "ERR_BOOTSTRAP_INPUT",
  );
});

test("a symbolic link in the bootstrap space is refused", () => {
  const dir = anchorDir();
  const target = path.join(dir, bootstrap.CLAIM_FILE);
  fs.symlinkSync(path.join(dir, "elsewhere.json"), target);
  assert.throws(
    () => bootstrap.bootstrapState(dir),
    (error) => error.code === "ERR_UNSAFE_PATH",
  );
});

test("a caller-supplied boolean cannot release a claim", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  // A probe that always claims success proves nothing on its own. The module
  // decides from its own observation, so a constant-true probe cannot unlock
  // a claim whose domain still holds evidence.
  fs.writeFileSync(p.database_path, "database");
  assert.throws(
    () => bootstrap.releaseUnattemptedBootstrap(dir, p, { probe: () => true }),
    (error) => error.code === "ERR_BOOTSTRAP_NOT_UNATTEMPTED",
  );
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("an observed untouched domain releases the claim", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const released = bootstrap.releaseUnattemptedBootstrap(dir, p);
  assert.strictEqual(released.released, true);
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 0);
});

test("an existing database object keeps the claim", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  fs.writeFileSync(p.database_path, "database");
  assert.throws(
    () => bootstrap.releaseUnattemptedBootstrap(dir, p),
    (error) => error.code === "ERR_BOOTSTRAP_NOT_UNATTEMPTED",
  );
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("an extra object in the anchor domain keeps the claim", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  fs.writeFileSync(path.join(dir, "protected-anchor-entry-000000000001-000001-intent-abcdef.json"), "{}");
  assert.throws(
    () => bootstrap.releaseUnattemptedBootstrap(dir, p),
    (error) => error.code === "ERR_BOOTSTRAP_NOT_UNATTEMPTED",
  );
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("a leftover temporary file keeps the claim", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  fs.writeFileSync(path.join(dir, `${bootstrap.CLAIM_FILE}.tmp-1-abc`), "partial");
  assert.throws(
    () => bootstrap.releaseUnattemptedBootstrap(dir, p),
    (error) => error.code === "ERR_BOOTSTRAP_NOT_UNATTEMPTED",
  );
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("a release for a different plan keeps the claim", () => {
  const dir = anchorDir();
  const p = plan();
  bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  const other = plan({ bootstrap_id: p.bootstrap_id });
  assert.throws(
    () => bootstrap.releaseUnattemptedBootstrap(dir, other),
    (error) => error.code === "ERR_BOOTSTRAP_PENDING",
  );
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});


test("completion requires a matching live claim before writing evidence", () => {
  const dir = anchorDir(), p = plan();
  assert.throws(() => bootstrap.completeBootstrap(dir, p), { code: "ERR_BOOTSTRAP_NOT_PENDING" });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  bootstrap.registerBootstrap(dir, p);
  assert.throws(() => bootstrap.completeBootstrap(dir, plan()), { code: "ERR_BOOTSTRAP_PENDING" });
  assert.strictEqual(bootstrap.bootstrapState(dir).completed.length, 0);
});

test("EEXIST retry repeats file and directory barriers after a failed registration", () => {
  const dir = anchorDir(), p = plan(), sync = fs.fsyncSync;
  let files = 0, directories = 0;
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory()) { directories++; throw Object.assign(Error("sync denied"), { code: "EIO" }); }
    files++;
    return sync(fd);
  };
  try {
    assert.throws(() => bootstrap.registerBootstrap(dir, p, { at_ms: 1000 }), { code: "ERR_BOOTSTRAP_SYNC_FAILED" });
    const before = files;
    assert.throws(() => bootstrap.registerBootstrap(dir, p, { at_ms: 1000 }), { code: "ERR_BOOTSTRAP_SYNC_FAILED" });
    assert.ok(files >= before + 2, "retry fsyncs both the temp and the existing claim");
    assert.strictEqual(directories, 2);
  } finally { fs.fsyncSync = sync; }
  const retry = bootstrap.registerBootstrap(dir, p, { at_ms: 1000 });
  assert.strictEqual(retry.reused, true);
  assert.strictEqual(retry.durability, "durable");
  bootstrap.releaseUnattemptedBootstrap(dir, p);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test("unsupported native bootstrap refuses before publishing a claim", () => {
  const dir = anchorDir(), p = plan(), platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    assert.throws(() => bootstrap.registerBootstrap(dir, p), { code: "ERR_BOOTSTRAP_SYNC_UNSUPPORTED_PLATFORM" });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("a competing process cannot roll a complete claim back during rename", () => {
  const dir = anchorDir(), p = plan(), rename = fs.renameSync;
  bootstrap.registerBootstrap(dir, p);
  let checked = false;
  fs.renameSync = function(source, target) {
    if (target === path.join(dir, bootstrap.CLAIM_FILE)) {
      const child = require("node:child_process").spawnSync(process.execPath, ["-e", `
        const b = require('./lib/coordination/protected-bootstrap');
        try { b.advanceBootstrapPhase(process.argv[1], JSON.parse(process.argv[2]), 'publishing'); process.exit(9); }
        catch (e) { if (e.code !== 'ERR_BOOTSTRAP_BUSY') throw e; }
      `, dir, JSON.stringify(p)], { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" });
      assert.strictEqual(child.status, 0, child.stderr);
      checked = true;
    }
    return rename.call(this, source, target);
  };
  try { bootstrap.advanceBootstrapPhase(dir, p, "complete"); }
  finally { fs.renameSync = rename; }
  assert.ok(checked);
  assert.strictEqual(bootstrap.bootstrapState(dir).phase, "complete");
  assert.throws(() => bootstrap.advanceBootstrapPhase(dir, p, "publishing"), { code: "ERR_BOOTSTRAP_PHASE_INVALID" });
});

test("release and new registration cannot interleave with an older advance", () => {
  const dir = anchorDir(), p = plan(), later = plan(), sync = fs.fsyncSync;
  bootstrap.registerBootstrap(dir, p);
  let checked = false;
  fs.fsyncSync = fd => {
    if (!checked && fs.fstatSync(fd).isFile()) {
      checked = true;
      assert.throws(() => bootstrap.releaseUnattemptedBootstrap(dir, p), { code: "ERR_BOOTSTRAP_BUSY" });
      assert.throws(() => bootstrap.registerBootstrap(dir, later), { code: "ERR_BOOTSTRAP_BUSY" });
      assert.throws(() => bootstrap.completeBootstrap(dir, p), { code: "ERR_BOOTSTRAP_BUSY" });
    }
    return sync(fd);
  };
  try { bootstrap.advanceBootstrapPhase(dir, p, "publishing"); }
  finally { fs.fsyncSync = sync; }
  assert.ok(checked);
  bootstrap.completeBootstrap(dir, p);
  bootstrap.registerBootstrap(dir, later);
  assert.throws(() => bootstrap.advanceBootstrapPhase(dir, p, "complete"), { code: "ERR_BOOTSTRAP_PENDING" });
  assert.strictEqual(bootstrap.bootstrapState(dir).pending[0].bootstrap_id, later.bootstrap_id);
});

test("replacing a claim with identical bytes before rename is refused by inode", () => {
  const dir = anchorDir(), p = plan(), sync = fs.fsyncSync;
  bootstrap.registerBootstrap(dir, p);
  const target = path.join(dir, bootstrap.CLAIM_FILE), bytes = fs.readFileSync(target);
  let replaced = false;
  fs.fsyncSync = fd => {
    if (!replaced && fs.fstatSync(fd).isFile()) {
      replaced = true;
      const other = target + ".replacement";
      fs.writeFileSync(other, bytes);
      fs.renameSync(other, target);
    }
    return sync(fd);
  };
  try { assert.throws(() => bootstrap.advanceBootstrapPhase(dir, p, "publishing"), { code: "ERR_BOOTSTRAP_CLAIM_CHANGED" }); }
  finally { fs.fsyncSync = sync; }
  assert.strictEqual(bootstrap.bootstrapState(dir).phase, "registered");
});

test("release removes only redundant claim temporaries", () => {
  const dir = anchorDir(), p = plan();
  bootstrap.registerBootstrap(dir, p);
  const target = path.join(dir, bootstrap.CLAIM_FILE);
  fs.linkSync(target, target + ".tmp-owned");
  bootstrap.releaseUnattemptedBootstrap(dir, p);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});


test("release rechecks side effects after a supplemental observer", () => {
  const dir = anchorDir(), p = plan();
  bootstrap.registerBootstrap(dir, p);
  assert.throws(() => bootstrap.releaseUnattemptedBootstrap(dir, p, { observe: () => {
    fs.writeFileSync(p.database_path, "unexpected database");
    return true;
  } }), { code: "ERR_BOOTSTRAP_NOT_UNATTEMPTED" });
  assert.strictEqual(bootstrap.bootstrapState(dir).pending.length, 1);
});

test("an orphaned mutation guard is never stolen to update a claim", () => {
  const dir = anchorDir(), p = plan();
  bootstrap.registerBootstrap(dir, p);
  fs.mkdirSync(path.join(dir, "protected-bootstrap-mutation.lock"));
  assert.throws(() => bootstrap.advanceBootstrapPhase(dir, p, "publishing"), { code: "ERR_BOOTSTRAP_BUSY" });
  assert.strictEqual(bootstrap.bootstrapState(dir).phase, "registered");
});
