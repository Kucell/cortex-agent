"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const SERVICE = "S-1-5-21-1000-1001";
const IDENTITY = "sid:" + SERVICE;
let evidence;
// Replace only the OS transport, retaining the native adapter's SID/DACL parser.
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function(file, args, options) {
  if (file !== "powershell.exe") return execFileSync.apply(this, arguments);
  if (evidence.unavailable) throw new Error("PowerShell unavailable");
  if (evidence.malformed) return "invalid JSON";
  if (!options.input) return JSON.stringify({ CurrentSid: SERVICE, Groups: [] });
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  const snapshots = JSON.parse(options.input).map(p => {
    evidence.checked.add(p);
    return { Path: p, Owner: SERVICE, CurrentSid: SERVICE, Groups: [], Access: [
      { Sid: SERVICE, Type: "Allow", Rights: "FullControl" },
    ], ...evidence.paths.get(p) };
  });
  return JSON.stringify(snapshots.length === 1 ? snapshots[0] : snapshots);
};
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const lock = require("../../lib/coordination/protected-store-lock");
childProcess.execFileSync = execFileSync;

function fixture(t) {
  const tmp = testRuntime("test-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "permit-windows-")));
  const anchorDir = path.join(root, "anchor"), dbDir = path.join(root, "db");
  fs.mkdirSync(anchorDir, { mode: 0o700 }); fs.mkdirSync(dbDir);
  const file = path.join(dbDir, "state.sqlite");
  const platform = Object.getOwnPropertyDescriptor(process, "platform"), lstat = fs.lstatSync;
  evidence = { checked: new Set(), paths: new Map() };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  fs.lstatSync = function(p, ...args) {
    const stat = lstat.call(this, p, ...args);
    if (path.basename(String(p)) === lock.FILE) stat.mode = (stat.mode & ~0o777) | 0o666;
    return stat;
  };
  const handles = [];
  t.after(() => {
    for (const handle of handles) handle.close();
    fs.lstatSync = lstat;
    Object.defineProperty(process, "platform", platform);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { decisionId: "D-windows", expectedDecisionId: "D-windows", minimumEpoch: 1,
    serviceIdentity: IDENTITY, anchorDir, controlledAncestorPath: root, clock: () => 1_000_000,
    audit: { by: "synthetic-test", reason: "Windows regression" }, acceptDatabaseAsTruth: true };
  return { root, anchorDir, dbDir, file, options,
    track(store) { handles.push(store); return store; },
    initialize(opts = options) { return this.track(Store.initialize(file, opts)); },
    // Existing-store DACL tests provision on a host with directory fsync.
    // This is fixture setup, not a claim of Node publication on Windows.
    provision(opts) {
      return this.onHost(() => this.initialize({ ...opts, anchorMode: "strict", platform: "windows", adapter: undefined }));
    },
    onHost(body) {
      const windowsLstat = fs.lstatSync;
      fs.lstatSync = lstat;
      Object.defineProperty(process, "platform", platform);
      try { return body(); }
      finally {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        fs.lstatSync = windowsLstat;
      }
    },
  };
}

function forgedOptions(f, overrides = {}) {
  return { ...f.options, platform: "posix", adapter: {
    currentIdentity: () => IDENTITY, normalizeIdentity: x => x,
    ownerIdentity: () => IDENTITY, writableIdentities: () => new Set([IDENTITY]),
  }, ...overrides };
}
function leaseFields() {
  return { owner: "test", sessionId: "s", hostId: "h", workerId: "w", runId: "r", generation: "g",
    desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease", ttlMs: 60_000 };
}
function permitFields(lease) {
  return { ...lease, idempotencyKey: "permit", operation: "uia.invoke", targetDigest: "a".repeat(64),
    paramsDigest: "b".repeat(64), ttlMs: 10_000 };
}
function anchorBytes(f) {
  return fs.readdirSync(f.anchorDir).sort().map(name => [name, fs.readFileSync(path.join(f.anchorDir, name))]);
}
const broadWrites = { Access: [{ Sid: "S-1-1-0", Type: "Allow", Rights: "Modify" }] };
const entries = ["open", "recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"];

for (const [kind, overrides] of [
  ["injected adapter", { anchorMode: "strict" }],
  ["permissive mode", { anchorMode: "permissive", platform: "windows", adapter: undefined }],
  ["combined forged options", { anchorMode: "permissive" }],
]) {
  test(`native Windows initialization refuses broad anchor writes with ${kind}`, t => {
    const f = fixture(t);
    evidence.paths.set(f.anchorDir, broadWrites);
    assert.throws(() => f.initialize(forgedOptions(f, overrides)), { code: "ERR_ANCHOR_PERMISSIONS" });
    assert.deepEqual(fs.readdirSync(f.dbDir), []);
    assert.deepEqual(fs.readdirSync(f.anchorDir), []);
  });
  for (const name of ["directory", "ancestor", "journal", "high-water", "audit", "lock"]) {
    test(`native Windows ${name} rejects ${kind} on existing stores and recovery`, t => {
      const f = fixture(t), options = forgedOptions(f, overrides), store = f.provision(options);
      const lease = store.acquire(leaseFields());
      const target = name === "directory" ? f.anchorDir : name === "ancestor" ? f.root
        : path.join(f.anchorDir, name === "journal"
          ? fs.readdirSync(f.anchorDir).find(x => x.startsWith("protected-anchor-entry-"))
          : name === "high-water" ? "protected-anchor-high-water.log"
          : name === "audit" ? "protected-anchor-audit.log" : lock.FILE);
      const state = fs.readFileSync(f.file), witnesses = anchorBytes(f);
      evidence.paths.set(target, broadWrites);
      evidence.checked.clear();
      for (const entry of entries) {
        assert.throws(() => Store[entry](f.file, options), { code: "ERR_ANCHOR_PERMISSIONS" }, entry);
      }
      assert.throws(() => store.snapshot(), { code: "ERR_ANCHOR_PERMISSIONS" });
      assert.throws(() => store.reserve(permitFields(lease)), { code: "ERR_ANCHOR_PERMISSIONS" });
      assert.ok(evidence.checked.has(target), "native DACL evidence must be read");
      assert.deepEqual(fs.readFileSync(f.file), state);
      assert.deepEqual(anchorBytes(f), witnesses);
    });
  }
}

for (const serviceIdentity of [undefined, "sid:S-1-5-21-999"]) {
  test(`native Windows requires the declared identity despite forged options: ${serviceIdentity}`, t => {
    const f = fixture(t), options = forgedOptions(f, { anchorMode: "permissive", serviceIdentity });
    assert.throws(() => f.initialize(options), { code: serviceIdentity === undefined
      ? "ERR_ANCHOR_SERVICE_IDENTITY_INVALID" : "ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH" });
    assert.deepEqual(fs.readdirSync(f.anchorDir), []);
    assert.deepEqual(fs.readdirSync(f.dbDir), []);
  });
}

for (const kind of ["unavailable", "malformed"]) test(`native Windows ${kind} evidence cannot use an injected adapter`, t => {
  const f = fixture(t), options = forgedOptions(f), store = f.provision(options);
  evidence[kind] = true;
  assert.throws(() => store.snapshot(), { code: "ERR_ANCHOR_AUTHORIZATION_UNKNOWN" });
  for (const entry of entries) {
    assert.throws(() => Store[entry](f.file, options), { code: "ERR_ANCHOR_AUTHORIZATION_UNKNOWN" });
  }
});

test("native Windows persists strict mode and preserves normal permit and recovery behavior", t => {
  const f = fixture(t), options = forgedOptions(f, { anchorMode: "permissive" }), store = f.provision(options);
  assert.equal(store.snapshot().anchor_mode, "strict");
  const lease = store.acquire(leaseFields()), fields = permitFields(lease);
  const reserved = store.reserve(fields);
  assert.equal(store.reserve(fields).permitId, reserved.permitId);
  store.close();
  const reopened = f.track(Store.open(f.file, options));
  assert.equal(reopened.snapshot().permits[reserved.permitId].status, "reserved");
  assert.equal(reopened.consume(reserved).status, "consumed");
  assert.equal(reopened.consume(reserved).status, "already-consumed");
  assert.equal(reopened.finish({ ...reserved, outcome: "finished" }).status, "finished");
  reopened.close();
  assert.throws(() => Store.recoverFromAnchorCrash(f.file, options), { code: "ERR_RECOVERY_NOT_APPLICABLE" });
  assert.equal(Store.rebuildAnchor(f.file, options).rebuilt, true);
  assert.equal(Store.resetAfterAnchorLoss(f.file, options).reset, true);
  const reset = f.track(Store.open(f.file, options)).snapshot();
  assert.equal(reset.anchor_mode, "strict");
  assert.deepEqual(reset.permits, {});
});

test("native Windows forged options cannot bypass unsupported bootstrap durability", t => {
  const f = fixture(t), append = fs.appendFileSync;
  fs.appendFileSync = function(file, ...args) {
    if (path.basename(String(file)) === "protected-anchor-audit.log") throw new Error("audit denied");
    return append.call(this, file, ...args);
  };
  try {
    assert.throws(() => f.initialize(forgedOptions(f, { anchorMode: "permissive" })),
      { code: "ERR_BOOTSTRAP_SYNC_UNSUPPORTED_PLATFORM" });
  } finally { fs.appendFileSync = append; }
  assert.deepEqual(fs.readdirSync(f.anchorDir), []);
  assert.deepEqual(fs.readdirSync(f.dbDir), []);
});

test("native Windows rejects unknown permission modes instead of normalizing them", t => {
  const f = fixture(t), options = forgedOptions(f, { anchorMode: "invalid" });
  assert.throws(() => f.initialize(options), { code: "ERR_ANCHOR_MODE_INVALID" });
  assert.deepEqual(fs.readdirSync(f.anchorDir), []);
});

test("native Windows rechecks an existing permissive deployment with native evidence", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), options = forgedOptions(f, { anchorMode: "permissive" });
  f.onHost(() => f.initialize(options).close());
  evidence.paths.set(f.anchorDir, broadWrites);
  for (const entry of entries) {
    assert.throws(() => Store[entry](f.file, options), { code: "ERR_ANCHOR_PERMISSIONS" });
  }
});

test("non-Windows retains injected Windows adapters", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  f.onHost(() => {
    const options = forgedOptions(f, { platform: "windows", anchorMode: "strict" });
    const store = f.initialize(options), lease = store.acquire(leaseFields());
    assert.ok(store.reserve(permitFields(lease)).permitId);
    store.close();
    const reopened = f.track(Store.open(f.file, options));
    assert.equal(reopened.snapshot().anchor_mode, "strict");
    reopened.close();
    assert.throws(() => Store.resetAfterAnchorLoss(f.file, { ...options, anchorMode: "permissive" }),
      { code: "ERR_ANCHOR_MODE_DOWNGRADE" });
  });
});

test("non-Windows retains permissive deployments", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  f.onHost(() => {
    const options = { ...f.options, anchorMode: "permissive", serviceIdentity: undefined };
    const store = f.initialize(options), lease = store.acquire(leaseFields());
    assert.ok(store.reserve(permitFields(lease)).permitId);
    store.close();
    assert.equal(f.track(Store.open(f.file, options)).snapshot().anchor_mode, "permissive");
  });
});
