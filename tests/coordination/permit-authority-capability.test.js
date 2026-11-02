"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

// Actual store + anchor integration with disposable local SQLite. No authority,
// execution permission, deployed key, Windows flush or power-loss claim.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sqlite = Number(process.versions.node.split(".")[0]) >= 24 ? require("node:sqlite") : {};
const { spawnSync } = require("node:child_process");
const anchor = require("../../lib/coordination/protected-anchor");
const lock = require("../../lib/coordination/protected-store-lock");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const delivery = require("../../lib/coordination/permit-delivery");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || !["darwin", "linux"].includes(process.platform) };

function authority() {
  return { mode: "development-only", authorityId: "capability-fixture", authorize: () => true,
    observeTarget: () => ({ targetHasProcess: false, targetHasPriorRun: false }),
    signPermit: () => { throw Error("must not sign"); }, pullRevocation: () => { throw Error("must not pull"); } };
}
function fixture(t, { initialize = true, legacy = false } = {}) {
  const root = testRuntime("test-tmp"); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-authority-capability-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir, { mode: 0o700 });
  const file = path.join(dbDir, "state.sqlite");
  const options = { decisionId: "D-capability", expectedDecisionId: "D-capability", minimumEpoch: 1,
    anchorDir, anchorMode: "permissive", clock: () => 1000, ...(!legacy ? { witnessAuthority: authority() } : {}) };
  const publicKey = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" });
  const registration = { targetId: "target", requestId: "register", checkpoint: null,
    pin: { decision_id: "D-capability", instance_id: "target", fingerprint: delivery.publicKeyFingerprint(publicKey),
      public_key_pem: publicKey, source_digest: "sha256:synthetic", deployment_digest: "sha256:synthetic",
      run_id: "run", generation: "generation", valid_from: 0, valid_until: 10000 } };
  const f = { dir, dbDir, anchorDir, file, options, registration, stores: [] };
  f.track = store => { f.stores.push(store); return store; };
  f.open = (extra = {}) => f.track(Store.open(file, { ...options, ...extra }));
  if (initialize) f.store = f.track(Store.initialize(file, options));
  t.after(() => { for (const store of f.stores) store.close(); });
  return f;
}
function raw(f) {
  const db = new sqlite.DatabaseSync(f.file, { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id=1").get().body); }
  finally { db.close(); }
}
function restartInChild(f) {
  const source = `
    const input = JSON.parse(process.argv[1]);
    const { ProtectedPermitStore: Store } = require(input.module);
    let store;
    try {
      store = Store.open(input.file, { expectedDecisionId: 'D-capability', minimumEpoch: 1,
        anchorDir: input.anchorDir, anchorMode: 'permissive', clock: () => 1000,
        witnessAuthority: (${authority.toString()})() });
      process.stdout.write(JSON.stringify({ state: store.snapshot() }));
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.code })); }
    finally { if (store) store.close(); }
  `;
  const child = spawnSync(process.execPath, ["-e", source, JSON.stringify({ file: f.file, anchorDir: f.anchorDir,
    module: require.resolve("../../lib/coordination/protected-permit-store") })], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function tree(dir) {
  const found = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    found[name] = fs.statSync(file).isDirectory() ? tree(file) : crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return found;
}
function patch(object, values, body) {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, object[key]]));
  Object.assign(object, values);
  try { return body(); } finally { Object.assign(object, original); }
}
function traceAnchor(body) {
  const events = [], capabilities = [], preflight = anchor.preflightAuthorityDurability;
  const append = anchor.appendEntry, high = anchor.appendHighWater;
  patch(anchor, {
    preflightAuthorityDurability: (...args) => { events.push({ type: "preflight" }); const cap = preflight(...args); capabilities.push(cap); return cap; },
    appendEntry: (...args) => { events.push({ type: args[1].type, sequence: args[1].sequence, args }); return append(...args); },
    appendHighWater: (...args) => { events.push({ type: "highwater", sequence: args[1].sequence, args }); return high(...args); },
  }, () => body({ events, capabilities }));
  return { events, capabilities };
}
function refuseSideEffects(body) {
  const calls = [], permissions = anchor.assertAnchorPermissionsWithIdentity;
  const denied = name => () => { calls.push(name); throw Error("forbidden side effect: " + name); };
  patch(sqlite, { DatabaseSync: denied("SQLite open") }, () =>
    patch(lock, { withLock: denied("lock") }, () =>
      patch(anchor, { assertAnchorPermissionsWithIdentity: denied("permission audit") }, body)));
  assert.deepEqual(calls, []);
  assert.equal(anchor.assertAnchorPermissionsWithIdentity, permissions);
}

for (const operation of ["initialize", "open"]) {
  for (const failure of ["unsupported-platform", "missing-directory", "directory-open", "directory-fsync", "directory-close", "missing-capability"]) {
    test(`${operation} ${failure} refuses before any SQLite/lock/permission side effect`, supported, t => {
      const f = fixture(t, { initialize: operation === "open" }); if (f.store) f.store.close();
      if (failure === "missing-directory") fs.rmSync(f.anchorDir, { recursive: true });
      const before = tree(f.dir), platform = Object.getOwnPropertyDescriptor(process, "platform");
      let injected = false;
      const open = fs.openSync, sync = fs.fsyncSync, close = fs.closeSync;
      const descriptors = new Set();
      const action = () => assert.throws(() => Store[operation](f.file, f.options), error => {
        if (failure === "unsupported-platform") return error.code === "ERR_ANCHOR_WRITE_INCOMPLETE" && error.details.reason === "unsupported-platform";
        if (failure === "missing-directory") return error.code === "ERR_ANCHOR_DIR_MISSING";
        if (failure === "missing-capability") return error.code === "ERR_WITNESS_AUTHORITY_DISABLED";
        return error.message === "fixture " + failure;
      });
      try {
        if (failure === "unsupported-platform") Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        refuseSideEffects(() => patch(fs, {
          openSync: function(file, ...args) {
            if (String(file) === f.anchorDir && failure === "directory-open") { injected = true; throw Error("fixture " + failure); }
            const fd = open(file, ...args); if (String(file) === f.anchorDir) descriptors.add(fd); return fd;
          },
          fsyncSync: function(fd) { if (descriptors.has(fd) && failure === "directory-fsync") { injected = true; throw Error("fixture " + failure); } return sync(fd); },
          closeSync: function(fd) {
            const isDir = descriptors.delete(fd); close(fd);
            if (isDir && failure === "directory-close") { injected = true; throw Error("fixture " + failure); }
          },
        }, () => failure === "missing-capability" ? patch(anchor, { preflightAuthorityDurability: () => undefined }, action) : action()));
      } finally { Object.defineProperty(process, "platform", platform); }
      if (failure.startsWith("directory-")) assert.equal(injected, true);
      assert.deepEqual(tree(f.dir), before);
    });
  }
}

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy" : "authority"} bootstrap and every transaction write retain correct arity/mode`, supported, t => {
    const f = fixture(t, { initialize: false, legacy });
    traceAnchor(({ events, capabilities }) => {
      const permissions = anchor.assertAnchorPermissionsWithIdentity, withLock = lock.withLock, Database = sqlite.DatabaseSync;
      const effects = [];
      patch(anchor, { assertAnchorPermissionsWithIdentity: (...args) => {
        effects.push("permissions"); if (!legacy) assert.equal(capabilities.length, 1); return permissions(...args);
      } }, () => patch(lock, { withLock: (...args) => {
        effects.push("lock"); if (!legacy) assert.equal(capabilities.length, 1); return withLock(...args);
      } }, () => patch(sqlite, { DatabaseSync: new Proxy(Database, { construct(target, args) {
        effects.push("db"); if (!legacy) assert.equal(capabilities.length, 1); return Reflect.construct(target, args);
      } }) }, () => { f.store = f.track(Store.initialize(f.file, f.options)); })));
      assert.ok(effects.includes("db") && effects.includes("lock") && effects.includes("permissions"));
      const initial = events.filter(event => event.args);
      assert.deepEqual(initial.map(event => event.type), ["intent", "commit", "highwater"]);
      const run = () => legacy ? f.store.acquire({ owner: "fixture", sessionId: "s", hostId: "h", workerId: "w", runId: "r", generation: "g",
        desktopKey: "d", ownedAppId: "a", idempotencyKey: "lease", ttlMs: 1000 }) : f.store.registerWitnessTarget({}, f.registration);
      run();
      const writes = events.filter(event => event.args);
      assert.deepEqual(writes.map(event => event.type), ["intent", "commit", "highwater", "intent", "commit", "highwater"]);
      assert.equal(capabilities.length, legacy ? 0 : 1);
      for (const event of writes) {
        assert.equal(event.args.length, legacy ? 2 : 3);
        if (!legacy) assert.equal(event.args[2], capabilities[0]);
      }
      assert.deepEqual(Object.keys(f.store), []);
    });
    traceAnchor(({ events, capabilities }) => {
      const reopened = f.open();
      assert.equal(capabilities.length, legacy ? 0 : 1);
      assert.equal(events.filter(event => event.args).length, 0);
      reopened.close();
    });
  });
}

test("authority open rechecks capability before SQLite and cannot reuse options/public snapshot as a token", supported, t => {
  const f = fixture(t); f.store.close();
  let opens = 0; const preflight = anchor.preflightAuthorityDurability, permission = anchor.assertAnchorPermissionsWithIdentity;
  patch(anchor, {
    preflightAuthorityDurability: (...args) => { opens++; return preflight(...args); },
    assertAnchorPermissionsWithIdentity: (...args) => { assert.equal(opens, 1); return permission(...args); },
  }, () => f.open({ authorityDurability: {} }).close());
  assert.equal(opens, 1);
  refuseSideEffects(() => patch(anchor, { preflightAuthorityDurability: () => undefined }, () =>
    assert.throws(() => f.open({ authorityDurability: f.options }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" })));
});

test("schema3 cannot reopen as legacy or enter any static recovery writer", supported, t => {
  const f = fixture(t); f.store.close();
  const before = { db: fs.readFileSync(f.file), anchor: tree(f.anchorDir) };
  const deny = () => { throw Error("must not lock or audit"); };
  patch(lock, { withLock: deny }, () => patch(anchor, { assertAnchorPermissionsWithIdentity: deny }, () => {
    assert.throws(() => f.open({ witnessAuthority: undefined }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    for (const method of ["recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
      assert.throws(() => Store[method](f.file, { ...f.options, audit: { by: "fixture", reason: "not authorized" } }), { code: "ERR_WITNESS_RECOVERY_UNSUPPORTED" });
    }
  }));
  assert.deepEqual({ db: fs.readFileSync(f.file), anchor: tree(f.anchorDir) }, before);
  // Discovering schema without an authority declaration still opens SQLite
  // read-only and may create/update WAL/SHM. It must never enter a writer.
  t.diagnostic(JSON.stringify({ readOnlyDiscoverySidecars: fs.readdirSync(f.dbDir).filter(name => /-(wal|shm)$/.test(name)) }));
});

for (const phase of ["initialize", "transaction"]) {
  test(`${phase} highwater failure cannot be bypassed by reopen`, supported, t => {
    const f = fixture(t, { initialize: phase === "transaction" });
    patch(anchor, { appendHighWater: () => { throw Error("highwater barrier missing"); } }, () =>
      assert.throws(() => phase === "initialize" ? Store.initialize(f.file, f.options) : f.store.registerWitnessTarget({}, f.registration), /highwater barrier missing/));
    // Failed initialization also rolls back the coordination lock's version.
    // The bootstrap guard is checked before the lock, so an initialization
    // that failed after it had produced objects reports the unsettled
    // bootstrap -- the domain really is blocked and only the managed
    // settlement can release it -- instead of the weaker lock symptom.
    assert.throws(() => f.open(), { code: phase === "initialize" ? "ERR_BOOTSTRAP_PENDING" : "ERR_CRASH_WINDOW_RECOVERABLE" });
    if (phase === "initialize") {
      // The lock itself was left unversioned by the rolled-back creation
      // transaction. The settlement is what restores it.
      assert.throws(() => lock.assertLockInitialized(f.anchorDir), { code: "ERR_COORDINATION_LOCK_INVALID" });
    }
    for (const method of ["recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
      assert.throws(() => Store[method](f.file, { ...f.options, audit: { by: "fixture", reason: "no authority recovery" } }), { code: "ERR_WITNESS_RECOVERY_UNSUPPORTED" });
    }
  });
}

test("open clock-poison transaction uses the newly preflighted capability at every write", supported, t => {
  const f = fixture(t); f.store.close();
  traceAnchor(({ events, capabilities }) => {
    assert.throws(() => f.open({ clock: () => 999 }), { code: "ERR_CLOCK_ROLLBACK" });
    assert.equal(capabilities.length, 1);
    const writes = events.filter(event => event.args);
    assert.deepEqual(writes.map(event => event.type), ["intent", "commit", "highwater"]);
    for (const event of writes) { assert.equal(event.args.length, 3); assert.equal(event.args[2], capabilities[0]); }
  });
  assert.equal(raw(f).witness_authority.clock_poisoned, true);
});

test("successful precommit abort retains the exact instance capability and no business state", supported, t => {
  const f = fixture(t, { initialize: false }), sync = fs.fsyncSync;
  traceAnchor(({ events, capabilities }) => {
    f.store = f.track(Store.initialize(f.file, f.options)); const before = raw(f);
    patch(fs, { fsyncSync: fd => {
      if (new Error().stack.includes("#writeAudit") && fs.fstatSync(fd).isFile()) throw Error("audit abort fixture");
      return sync(fd);
    } }, () => assert.throws(() => f.store.registerWitnessTarget({}, f.registration), { code: "ERR_AUDIT_WRITE_FAILED" }));
    const writes = events.filter(event => event.sequence === 2);
    assert.deepEqual(writes.map(event => event.type), ["intent", "abort"]);
    for (const event of writes) { assert.equal(event.args.length, 3); assert.equal(event.args[2], capabilities[0]); }
    assert.deepEqual(raw(f), before);
  });
});

for (const fake of [false, {}]) {
  test(`falsy/forged capability cannot select legacy during authority transaction (${typeof fake})`, supported, t => {
    const f = fixture(t), before = raw(f), append = anchor.appendEntry;
    let hit = 0;
    patch(anchor, { appendEntry: (...args) => {
      assert.equal(args.length, 3);
      if (args[1].type === "intent") { hit++; return append(args[0], args[1], fake); }
      return append(...args);
    } }, () => assert.throws(() => f.store.registerWitnessTarget({}, f.registration), { code: "ERR_INVALID_INPUT" }));
    assert.equal(hit, 1); assert.deepEqual(raw(f), before);
  });
}

for (const phase of ["initialize", "transaction"]) {
  for (const point of ["intent", "commit", "highwater"]) {
    test(`${phase} ${point}: dropped capability is refused, never legacy fallback`, supported, t => {
      const f = fixture(t, { initialize: phase === "transaction" }), before = f.store && raw(f);
      const append = anchor.appendEntry, high = anchor.appendHighWater; let hit = 0;
      const invoke = (kind, original, args) => {
        assert.equal(args.length, 3);
        if (kind === point) { hit++; return original(args[0], args[1], undefined); }
        return original(...args);
      };
      patch(anchor, {
        appendEntry: (...args) => invoke(args[1].type, append, args),
        appendHighWater: (...args) => invoke("highwater", high, args),
      }, () => assert.throws(() => phase === "initialize" ? Store.initialize(f.file, f.options) : f.store.registerWitnessTarget({}, f.registration), { code: "ERR_INVALID_INPUT" }));
      assert.equal(hit, 1);
      if (phase === "transaction") {
        const state = raw(f);
        if (point === "intent") assert.deepEqual(state, before);
        else {
          assert.ok(state.witness_authority.targets.target);
          assert.throws(() => f.store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
        }
      }
    });
  }
}

test("abort also carries capability; failed abort keeps audit error and latches unknown", supported, t => {
  const f = fixture(t), before = raw(f), sync = fs.fsyncSync, append = anchor.appendEntry;
  let aborts = 0;
  patch(anchor, { appendEntry: (...args) => {
    assert.equal(args.length, 3);
    if (args[1].type === "abort") { aborts++; return append(args[0], args[1], undefined); }
    return append(...args);
  } }, () => patch(fs, { fsyncSync: fd => {
    if (new Error().stack.includes("#writeAudit") && fs.fstatSync(fd).isFile()) throw Error("fixture audit failure");
    return sync(fd);
  } }, () => assert.throws(() => f.store.registerWitnessTarget({}, f.registration), error => error.code === "ERR_AUDIT_WRITE_FAILED" && error.cause.message === "fixture audit failure")));
  assert.equal(aborts, 1); assert.deepEqual(raw(f), before);
  assert.throws(() => f.store.registerWitnessTarget({}, f.registration), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
});

test("directory replacement after binding refuses old owner and fresh open still preflights", supported, t => {
  const f = fixture(t), moved = f.anchorDir + "-old", before = raw(f);
  fs.renameSync(f.anchorDir, moved); fs.cpSync(moved, f.anchorDir, { recursive: true });
  assert.throws(() => f.store.registerWitnessTarget({}, f.registration), { code: "ERR_COORDINATION_LOCK_REPLACED" });
  assert.deepEqual(raw(f), before);
  refuseSideEffects(() => patch(anchor, { preflightAuthorityDurability: () => { throw Error("fresh capability required"); } }, () =>
    assert.throws(() => f.open(), /fresh capability required/)));
});

test("replacement inside trusted observation cannot publish through a bound old capability", supported, t => {
  const f = fixture(t, { initialize: false }); let changed = false;
  f.options.witnessAuthority.observeTarget = () => {
    fs.renameSync(f.anchorDir, f.anchorDir + "-old"); fs.cpSync(f.anchorDir + "-old", f.anchorDir, { recursive: true });
    changed = true; return { targetHasProcess: false, targetHasPriorRun: false };
  };
  f.store = f.track(Store.initialize(f.file, f.options)); const before = raw(f);
  assert.throws(() => f.store.registerWitnessTarget({}, f.registration), { code: "ERR_UNSAFE_PATH" });
  assert.equal(changed, true); assert.deepEqual(raw(f), before);
  assert.throws(() => f.store.snapshot(), /ERR_COMMIT_OUTCOME_UNKNOWN|ERR_COORDINATION_LOCK_REPLACED/);
});

test("trusted provider cancellation before intent leaves no business commit; no new authority cancel API", supported, t => {
  const f = fixture(t, { initialize: false });
  f.options.witnessAuthority.observeTarget = () => { throw Object.assign(Error("fixture cancelled"), { code: "ERR_FIXTURE_CANCELLED" }); };
  f.store = f.track(Store.initialize(f.file, f.options)); const before = raw(f);
  traceAnchor(({ events }) => {
    assert.throws(() => f.store.registerWitnessTarget({}, f.registration), { code: "ERR_FIXTURE_CANCELLED" });
    assert.deepEqual(events, []);
  });
  assert.deepEqual(raw(f), before);
  assert.throws(() => f.store.release({}), { code: "ERR_WITNESS_LEGACY_ENTRY_DISABLED" });
});

for (const point of ["before-intent", "after-intent", "after-db-commit", "after-commit-entry", "after-highwater"]) {
  test(`real child exits ${point}; recovery facts and capabilities are not serialized`, supported, t => {
    const f = fixture(t), before = raw(f); f.store.close();
    const source = `
      const assert = require('node:assert/strict');
      const info = JSON.parse(process.argv[1]);
      const anchor = require(info.anchor), { ProtectedPermitStore: Store } = require(info.store);
      const store = Store.open(info.file, { expectedDecisionId: 'D-capability', minimumEpoch: 1,
        anchorDir: info.anchorDir, anchorMode: 'permissive', clock: () => 1000, witnessAuthority: (${authority.toString()})() });
      const append = anchor.appendEntry, high = anchor.appendHighWater;
      anchor.appendEntry = (...args) => {
        assert.equal(args.length, 3);
        if ((info.point === 'before-intent' && args[1].type === 'intent') || (info.point === 'after-db-commit' && args[1].type === 'commit')) process.exit(73);
        const result = append(...args);
        if (info.point === 'after-intent' && args[1].type === 'intent') process.exit(73);
        if (info.point === 'after-commit-entry' && args[1].type === 'commit') process.exit(73);
        return result;
      };
      anchor.appendHighWater = (...args) => { assert.equal(args.length, 3); const result = high(...args); if (info.point === 'after-highwater') process.exit(73); return result; };
      store.registerWitnessTarget({}, info.registration);
      process.exit(74);
    `;
    const child = spawnSync(process.execPath, ["-e", source, JSON.stringify({ point, file: f.file, anchorDir: f.anchorDir,
      registration: f.registration, anchor: require.resolve("../../lib/coordination/protected-anchor"), store: require.resolve("../../lib/coordination/protected-permit-store") })], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 73, child.stderr);
    const state = raw(f);
    if (point === "before-intent" || point === "after-intent") assert.deepEqual(state, before);
    else assert.ok(state.witness_authority.targets.target);
    const restarted = restartInChild(f);
    if (point === "after-db-commit" || point === "after-commit-entry") {
      assert.deepEqual(restarted, { error: "ERR_CRASH_WINDOW_RECOVERABLE" });
      assert.throws(() => f.open(), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
    } else {
      assert.deepEqual(restarted, { state });
      const reopened = f.open(); assert.deepEqual(reopened.snapshot(), state); reopened.close();
    }
    for (const method of ["recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
      assert.throws(() => Store[method](f.file, { ...f.options, audit: { by: "fixture", reason: "no authority recovery" } }), { code: "ERR_WITNESS_RECOVERY_UNSUPPORTED" });
    }
    t.diagnostic(JSON.stringify({ point, childExit: child.status, databaseChanged: state.anchor_sequence !== before.anchor_sequence }));
  });
}
