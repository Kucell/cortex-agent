"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
const auto = require("../../lib/coordination/permit-legacy-auto-migrate");
const repair = require("../../lib/coordination/permit-store-open-with-repair");
const executor = require("../../lib/coordination/permit-legacy-migration-executor");
const { ProtectedPermitStore, assertSafeDatabasePaths } = require("../../lib/coordination/protected-permit-store");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 };
const modes = new Map();
let runtime, source;

test.before(() => {
  if (supported.skip) return;
  runtime = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
  fs.mkdirSync(runtime, { recursive: true });
  source = fs.readFileSync(path.join(__dirname, "fixtures/protected-permit-store-v1-source.txt"), "utf8");
  assert.equal(crypto.createHash("sha256").update(source).digest("hex"),
    require("../../lib/coordination/permit-legacy-migration-core").FROZEN_SOURCE_SHA256);
  const filename = require.resolve("../../lib/coordination/protected-permit-store");
  const frozen = new Module(filename);
  frozen.filename = filename; frozen.paths = Module._nodeModulePaths(path.dirname(filename));
  frozen._compile(source, filename);
  for (const mode of ["permissive", "strict"]) {
    const root = fs.mkdtempSync(path.join(runtime, "read-path-template-"));
    try {
      const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
      fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
      const file = path.join(dbDir, "state.sqlite");
      let now = 1000;
      const old = frozen.exports.ProtectedPermitStore.initialize(file, { decisionId: "D-read-path", anchorDir,
        anchorMode: mode, clock: () => now, verifyRecovery: () => true });
      try {
        const lease = old.acquire({ owner: "fixture", sessionId: "s", hostId: "h", workerId: "w", runId: "r",
          generation: "g", desktopKey: "d", ownedAppId: "a", idempotencyKey: "lease", ttlMs: 100 });
        const permit = old.reserve({ ...lease, idempotencyKey: "permit", operation: "invoke",
          targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 50 });
        now = permit.deadline;
        old.consume(permit); old.finish({ ...permit, outcome: "finished" });
        old.release(lease); old.recover({ fixture: "drained" });
      } finally { old.close(); }
      // Preserve valid WAL bytes after closing ALL handles, so a new SQLite
      // connection really has to map/rebuild the named -shm object.
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(file);
      let wal;
      try {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1;");
        wal = fs.readFileSync(file + "-wal");
        assert.ok(wal.length > 32);
      } finally { db.close(); }
      modes.set(mode, { database: fs.readFileSync(file), wal,
        anchor: fs.readdirSync(anchorDir).map(name => [name, fs.readFileSync(path.join(anchorDir, name))]) });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

function fixture(t, mode) {
  const root = fs.mkdtempSync(path.join(runtime, "permit-read-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir);
  const filePath = path.join(dbDir, "state.sqlite"), template = modes.get(mode);
  fs.writeFileSync(filePath, template.database);
  fs.writeFileSync(filePath + "-wal", template.wal);
  for (const [name, bytes] of template.anchor) fs.writeFileSync(path.join(anchorDir, name), bytes);
  return { root, filePath, anchorDir, autoRepair: true, oldReaderSource: source,
    expectedDecisionId: "D-read-path", minimumEpoch: 1, anchorMode: mode, clock: () => 2000,
    audit: { by: "fixture", reason: "pre-open sidecar regression" } };
}

function hardlink(f, suffix) {
  const victim = path.join(f.root, "victim"), bytes = Buffer.alloc(65536, 0x5a);
  fs.writeFileSync(victim, bytes);
  fs.rmSync(f.filePath + suffix, { force: true });
  fs.linkSync(victim, f.filePath + suffix);
  return () => assert.deepEqual(fs.readFileSync(victim), bytes, "victim must remain byte-for-byte unchanged");
}

function observeOpens(t, f, afterClose) {
  const sqlite = require("node:sqlite"), Native = sqlite.DatabaseSync;
  let opens = 0;
  t.mock.method(sqlite, "DatabaseSync", class extends Native {
    constructor(filename, options) {
      const target = path.resolve(filename) === path.resolve(f.filePath);
      if (target) opens++;
      super(filename, options);
      // node:test's constructor proxy does not retain subclass prototypes.
      const close = this.close.bind(this);
      this.close = () => {
        close();
        if (target && opens === 1 && afterClose) afterClose();
      };
    }
  });
  return () => opens;
}

function assertNoPublication(f, anchorBefore) {
  assert.equal(executor.migrationIsComplete(f.anchorDir), false);
  assert.equal(fs.existsSync(path.join(f.anchorDir, executor.PENDING_FILE)), false);
  assert.equal(fs.existsSync(path.join(f.anchorDir, "protected-legacy-migration-complete.json")), false);
  assert.deepEqual(fs.readdirSync(f.anchorDir).sort(), anchorBefore);
}

const entries = {
  "shared export": f => assertSafeDatabasePaths(f.filePath),
  "version discovery": f => auto.readUserVersion(f.filePath),
  "legacy detection": f => auto.needsLegacyRepair(f.filePath),
  "evidence collection": f => auto.collectEvidence(f.filePath, f.anchorDir),
  "automatic repair": f => auto.autoRepairLegacyStore(f),
  "wrapped open": f => repair.openWithLegacyRepair(() => ProtectedPermitStore.open(f.filePath, f), f),
};

for (const mode of ["permissive", "strict"]) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    for (const [entry, action] of Object.entries(entries)) {
      test(`F1 end-to-end ${mode} ${entry} refuses hardlinked ${suffix} before SQLite`, supported, t => {
        const f = fixture(t, mode), unchanged = hardlink(f, suffix);
        const before = fs.readFileSync(f.filePath), anchorBefore = fs.readdirSync(f.anchorDir).sort();
        const opens = observeOpens(t, f);
        assert.throws(() => action(f), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
        assert.equal(opens(), 0);
        unchanged();
        assert.deepEqual(fs.readFileSync(f.filePath), before);
        assertNoPublication(f, anchorBefore);
      });
    }

    test(`F1 end-to-end ${mode} wrapper preflight independently refuses new hardlinked ${suffix}`, supported, t => {
      const f = fixture(t, mode), before = fs.readFileSync(f.filePath);
      const anchorBefore = fs.readdirSync(f.anchorDir).sort();
      let unchanged;
      // Introduce the link AFTER discovery to exercise the separate preflight.
      t.mock.method(auto, "needsLegacyRepair", () => { unchanged = hardlink(f, suffix); return true; });
      const opens = observeOpens(t, f);
      assert.throws(() => repair.openWithLegacyRepair(() => assert.fail("must not open"), f),
        { code: "ERR_STATE_MISSING_OR_UNSAFE" });
      assert.equal(opens(), 0);
      unchanged();
      assert.deepEqual(fs.readFileSync(f.filePath), before);
      assertNoPublication(f, anchorBefore);
    });

    for (const entry of ["automatic repair", "wrapped open"]) {
      test(`F1 end-to-end ${mode} ${entry} rechecks ${suffix} after safe discovery`, supported, t => {
        const f = fixture(t, mode), before = fs.readFileSync(f.filePath);
        const anchorBefore = fs.readdirSync(f.anchorDir).sort();
        let unchanged;
        const opens = observeOpens(t, f, () => { unchanged = hardlink(f, suffix); });
        if (entry === "automatic repair") {
          const report = auto.autoRepairLegacyStore(f);
          assert.equal(report.repaired, false);
          assert.equal(report.reason, "evidence-unavailable");
          assert.equal(report.code, "ERR_STATE_MISSING_OR_UNSAFE");
        } else {
          assert.throws(() => entries[entry](f), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
        }
        assert.equal(opens(), 1, "no second SQLite open may occur after the link appears");
        unchanged();
        assert.deepEqual(fs.readFileSync(f.filePath), before);
        assertNoPublication(f, anchorBefore);
      });
    }
  }

  for (const entry of ["automatic repair", "wrapped open"]) {
    test(`F1 end-to-end ${mode} ${entry} still accepts ordinary hot-WAL sidecars`, supported, t => {
      const f = fixture(t, mode);
      assert.equal(fs.lstatSync(f.filePath + "-wal").nlink, 1);
      if (entry === "automatic repair") assert.equal(auto.autoRepairLegacyStore(f).repaired, true);
      else {
        const result = entries[entry](f);
        try { assert.equal(result.repair.repaired, true); assert.equal(result.store.snapshot().schema_version, 2); }
        finally { result.store.close(); }
      }
      assert.equal(executor.migrationIsComplete(f.anchorDir), true);
    });

    test(`F2 resolved domains ${mode} ${entry} accepts an ancestor alias outside the anchor`, supported, t => {
      const f = fixture(t, mode), parent = path.dirname(f.filePath), nested = path.join(parent, "nested-db");
      fs.mkdirSync(nested);
      for (const suffix of ["", "-wal"]) {
        fs.renameSync(f.filePath + suffix, path.join(nested, "state.sqlite") + suffix);
      }
      const alias = path.join(f.root, "alias"); fs.symlinkSync("db", alias, "dir");
      f.filePath = path.join(alias, "nested-db", "state.sqlite");
      assert.equal(fs.lstatSync(path.dirname(f.filePath)).isSymbolicLink(), false);
      if (entry === "automatic repair") assert.equal(auto.autoRepairLegacyStore(f).repaired, true);
      else {
        const result = entries[entry](f);
        try { assert.equal(result.store.snapshot().schema_version, 2); }
        finally { result.store.close(); }
      }
      assert.equal(executor.migrationIsComplete(f.anchorDir), true);
    });
  }

  test(`F2 resolved domains ${mode} migration detects a retargeted ancestor alias under the lock`, supported, t => {
    const f = fixture(t, mode), evidence = auto.collectEvidence(f.filePath, f.anchorDir);
    const parent = path.dirname(f.filePath), nested = path.join(parent, "nested-db");
    fs.mkdirSync(nested);
    const physical = path.join(nested, "state.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(f.filePath + suffix)) fs.renameSync(f.filePath + suffix, physical + suffix);
    }
    const other = path.join(f.root, "other-db", "nested-db"); fs.mkdirSync(other, { recursive: true });
    const before = fs.readFileSync(physical), replacement = path.join(other, "state.sqlite");
    fs.writeFileSync(replacement, before);
    const alias = path.join(f.root, "alias"); fs.symlinkSync("db", alias, "dir");
    f.filePath = path.join(alias, "nested-db", "state.sqlite");
    const coordination = require("../../lib/coordination/protected-store-lock"), withLock = coordination.withLock;
    t.mock.method(coordination, "withLock", (dir, action, options) => withLock(dir, identity => {
      if (!options?.create) { fs.unlinkSync(alias); fs.symlinkSync("other-db", alias, "dir"); }
      return action(identity);
    }, options));
    const opens = observeOpens(t, f);
    assert.throws(() => executor.migrateLegacyPermitStore({ ...f, evidence }), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
    assert.equal(opens(), 0);
    assert.deepEqual(fs.readFileSync(physical), before);
    assert.deepEqual(fs.readFileSync(replacement), before);
    assert.equal(executor.migrationIsComplete(f.anchorDir), false);
    assert.equal(fs.existsSync(path.join(f.anchorDir, "protected-legacy-migration-complete.json")), false);
  });
}
