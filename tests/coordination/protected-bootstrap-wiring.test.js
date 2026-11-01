"use strict";

// Wiring tests for the candidate bootstrap protocol inside the store.
//
// The property under test is the ordering: the bootstrap-pending record must
// exist before the business database is created. The test observes it by
// making the database creation fail and checking that the registration
// survived.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const testRoot = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
fs.mkdirSync(testRoot, { recursive: true });
const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const anchorModule = require("../../lib/coordination/protected-anchor");
const bootstrapModule = require("../../lib/coordination/protected-bootstrap");

function dirs() {
  const dir = fs.mkdtempSync(path.join(testRoot, "permit-bootstrap-wire-"));
  const anchorDir = path.join(path.dirname(dir), `${path.basename(dir)}-anchor`);
  fs.mkdirSync(anchorDir, { recursive: true });
  return { dir, anchorDir, file: path.join(dir, "authority.sqlite") };
}

function bootstrapFiles(anchorDir) {
  return fs.readdirSync(anchorDir).filter((name) => name.startsWith(bootstrapModule.COMPLETE_PREFIX) && !name.includes(".tmp-"));
}

test("a successful initialize leaves a completed bootstrap and no unresolved pending", () => {
  const { dir, anchorDir, file } = dirs();
  try {
    const store = ProtectedPermitStore.initialize(file, {
      decisionId: "D-bootstrap-init",
      anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
      clock: () => 1_000_000,
    });
    store.close();
    const state = bootstrapModule.bootstrapState(anchorDir);
    assert.strictEqual(state.pending.length, 0);
    assert.strictEqual(state.completed.length, 1);
    assert.strictEqual(bootstrapFiles(anchorDir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("the bootstrap registration survives a database creation failure", t => {
  const { dir, anchorDir, file } = dirs();
  try {
    // Inject a failure at creation in a genuinely empty domain. Occupied
    // domains must now be rejected before registering a claim at all.
    t.mock.method(require("../../lib/coordination/protected-store-lock"), "withLock", () => {
      throw Object.assign(new Error("creation denied"), { code: "EACCES" });
    });
    assert.throws(() => ProtectedPermitStore.initialize(file, {
      decisionId: "D-bootstrap-init",
      anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
      clock: () => 1_000_000,
    }));
    const state = bootstrapModule.bootstrapState(anchorDir);
    assert.strictEqual(state.started, true);
    assert.strictEqual(state.pending.length, 1);
    assert.strictEqual(state.empty, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("a second initialize on the same domain is refused while a bootstrap is pending", t => {
  const { dir, anchorDir, file } = dirs();
  try {
    // The second database lives in its own empty directory tree, so that the
    // empty-parent check does not fire for it. The block under test is the
    // unresolved bootstrap registration in the shared anchor domain.
    const secondRoot = fs.mkdtempSync(path.join(testRoot, "permit-bootstrap-second-"));
    const secondDir = path.join(secondRoot, "store");
    fs.mkdirSync(secondDir);
    t.mock.method(require("../../lib/coordination/protected-store-lock"), "withLock", () => {
      throw Object.assign(new Error("creation denied"), { code: "EACCES" });
    });
    assert.throws(() => ProtectedPermitStore.initialize(file, {
      decisionId: "D-bootstrap-init",
      anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
      clock: () => 1_000_000,
    }));
    const second = path.join(secondDir, "second.sqlite");
    assert.throws(() => ProtectedPermitStore.initialize(second, {
      decisionId: "D-bootstrap-init",
      anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
      clock: () => 1_000_000,
    }), { code: "ERR_BOOTSTRAP_PENDING" });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("initialize refuses an occupied anchor before any claim or audit write", () => {
  const { dir, anchorDir, file } = dirs();
  try {
    fs.writeFileSync(path.join(anchorDir, "protected-store-coordination.sqlite"), "occupied");
    const entries = fs.readdirSync(anchorDir);
    assert.throws(() => ProtectedPermitStore.initialize(file, {
      decisionId: "D-bootstrap-init", anchorDir, anchorMode: "permissive", clock: () => 1000,
    }), { code: "ERR_BOOTSTRAP_DOMAIN_OCCUPIED" });
    assert.deepStrictEqual(fs.readdirSync(anchorDir), entries);
    assert.strictEqual(bootstrapModule.bootstrapState(anchorDir).pending.length, 0);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("the registered plan names the store identity that was created", () => {
  const { dir, anchorDir, file } = dirs();
  try {
    const store = ProtectedPermitStore.initialize(file, {
      decisionId: "D-bootstrap-init",
      anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
      clock: () => 1_000_000,
    });
    const snapshot = store.snapshot();
    store.close();
    const state = bootstrapModule.bootstrapState(anchorDir);
    assert.strictEqual(state.completed.length, 1);
    assert.strictEqual(state.completed[0].store_id, snapshot.store_id);
    const journal = anchorModule.readJournal(anchorModule.journalFileFor(anchorDir));
    assert.strictEqual(journal.committedDigest, state.completed[0].body_digest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("a refused initialization leaves no registration behind", () => {
  const { dir, anchorDir, file } = dirs();
  try {
    // The parent directory is not empty, so the initialization is refused
    // before anything is created. The registration must be released again,
    // otherwise a refused call would block the domain forever.
    fs.writeFileSync(path.join(dir, "other.txt"), "x");
    assert.throws(() => ProtectedPermitStore.initialize(file, {
      decisionId: "D-bootstrap-init",
      anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
      clock: () => 1_000_000,
    }), { code: "ERR_INIT_PATH_NOT_EMPTY" });
    const state = bootstrapModule.bootstrapState(anchorDir);
    assert.strictEqual(state.pending.length, 0);
    assert.strictEqual(state.empty, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("a refused initialization leaves the anchor domain without stray files", () => {
  const { dir, anchorDir, file } = dirs();
  try {
    fs.writeFileSync(path.join(dir, "other.txt"), "x");
    assert.throws(() => ProtectedPermitStore.initialize(file, {
      decisionId: "D-bootstrap-init",
      anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
      clock: () => 1_000_000,
    }));
    assert.deepStrictEqual(fs.readdirSync(anchorDir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});


for (const durability of [undefined, "not-declared"]) test(`initialize refuses registration durability ${durability} before DB creation`, () => {
  const { dir, anchorDir, file } = dirs(), register = bootstrapModule.registerBootstrap;
  bootstrapModule.registerBootstrap = () => ({ durability });
  try {
    assert.throws(() => ProtectedPermitStore.initialize(file, { decisionId: "D-bootstrap-init", anchorDir,
      anchorMode: "permissive", clock: () => 1000 }), { code: "ERR_BOOTSTRAP_SYNC_FAILED" });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.deepStrictEqual(fs.readdirSync(anchorDir), []);
  } finally {
    bootstrapModule.registerBootstrap = register;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("initialize refuses a non-durable publishing phase before DB creation", () => {
  const { dir, anchorDir, file } = dirs(), advance = bootstrapModule.advanceBootstrapPhase;
  bootstrapModule.advanceBootstrapPhase = () => ({ durability: "not-declared" });
  try {
    assert.throws(() => ProtectedPermitStore.initialize(file, { decisionId: "D-bootstrap-init", anchorDir,
      anchorMode: "permissive", clock: () => 1000 }), { code: "ERR_BOOTSTRAP_SYNC_FAILED" });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    bootstrapModule.advanceBootstrapPhase = advance;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("audit refusal releases the claim and its identical registration temporary", () => {
  const { dir, anchorDir, file } = dirs(), register = bootstrapModule.registerBootstrap,
    audit = anchorModule.recordAnchorInspection;
  bootstrapModule.registerBootstrap = (...args) => {
    const result = register(...args);
    fs.linkSync(result.path, result.path + ".tmp-owned");
    return result;
  };
  anchorModule.recordAnchorInspection = () => { throw Object.assign(Error("audit denied"), { code: "ERR_AUDIT_WRITE_FAILED" }); };
  try {
    assert.throws(() => ProtectedPermitStore.initialize(file, { decisionId: "D-bootstrap-init", anchorDir,
      anchorMode: "permissive", clock: () => 1000 }), { code: "ERR_AUDIT_WRITE_FAILED" });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.deepStrictEqual(fs.readdirSync(anchorDir), []);
  } finally {
    bootstrapModule.registerBootstrap = register;
    anchorModule.recordAnchorInspection = audit;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});
