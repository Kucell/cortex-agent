"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const childProcess = require("node:child_process");

// Stub only the OS evidence transport. Exercise the production Windows adapter,
// including snapshot parsing, owner/writer comparison and token membership.
const execFileSync = childProcess.execFileSync;
const SERVICE = "S-1-5-21-1000-1001";
const GROUP = "S-1-5-80-111-222-333-444-555";
let evidence;
childProcess.execFileSync = function(file, args, options) {
  if (file !== "powershell.exe") return execFileSync.apply(this, arguments);
  if (evidence.unavailable) throw new Error("PowerShell unavailable");
  if (evidence.malformed) return "invalid JSON";
  if (!options.input) return JSON.stringify({ CurrentSid: SERVICE, Groups: evidence.groups || [] });
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  const paths = JSON.parse(options.input);
  const snapshots = paths.map(p => {
    evidence.checked.add(p);
    const override = evidence.paths.get(p) || {};
    return { Path: p, Owner: override.owner || SERVICE, CurrentSid: SERVICE,
      Groups: evidence.groups || [], Access: override.access || [
        { Sid: SERVICE, Type: "Allow", Rights: "FullControl" },
      ] };
  });
  return JSON.stringify(snapshots.length === 1 ? snapshots[0] : snapshots);
};
const { ProtectedPinStore } = require("../../lib/coordination/protected-pin-store");
const lock = require("../../lib/coordination/protected-store-lock");
childProcess.execFileSync = execFileSync;

function fixture(t) {
  const tmp = testRuntime("test-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "pin-windows-")));
  const dir = path.join(root, "pin");
  fs.mkdirSync(dir, { mode: 0o700 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const lstat = fs.lstatSync;
  evidence = { paths: new Map(), checked: new Set() };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  // Windows reports 0666 even for a file restricted by its DACL.
  fs.lstatSync = function(file, ...args) {
    const stat = lstat.call(this, file, ...args);
    if ([".pin-critical-section.lock", lock.FILE].includes(path.basename(String(file)))) {
      stat.mode = (stat.mode & ~0o777) | 0o666;
    }
    return stat;
  };
  t.after(() => {
    fs.lstatSync = lstat;
    Object.defineProperty(process, "platform", platform);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { decisionId: "D-windows", serviceIdentity: "sid:" + SERVICE,
    controlledAncestorPath: root };
  return { root, dir, options, platform: platform.value, nativeLstat: lstat,
    initialize: () => ProtectedPinStore.initialize(dir, options) };
}

test("native Windows DACL accepts 0666 locks and preserves the strict ancestor audit", t => {
  const f = fixture(t);
  const store = f.initialize();
  store.commitRevocation({ sequence: 1, revokedFingerprints: ["retained"], permitSequence: 9 });
  const reopened = ProtectedPinStore.open(f.dir, f.options);
  assert.equal(reopened.assertPermitReplayState(), 9);
  assert.deepEqual([...reopened.revocationState().revokedFingerprints], ["retained"]);
  for (const name of [".pin-critical-section.lock", lock.FILE]) {
    assert.ok(evidence.checked.has(path.join(f.dir, name)), name + " DACL must be read");
  }
  const records = fs.readFileSync(path.join(f.dir, "protected-anchor-audit.log"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].event, "anchor_ancestor_segment_narrowing");
  assert.equal(records[0].controlled_ancestor_path, f.root);
  assert.ok(records[0].skipped_ancestors.length > 0);
});

for (const name of [".pin-critical-section.lock", lock.FILE]) {
  for (const [kind, override, code] of [
    ["broad writer", { access: [{ Sid: "S-1-1-0", Type: "Allow", Rights: "Write" }] }, "ERR_ANCHOR_PERMISSIONS"],
    ["other writer", { access: [{ Sid: "S-1-5-21-999", Type: "Allow", Rights: "Modify" }] }, "ERR_ANCHOR_WRITER_SET"],
    ["other owner", { owner: "S-1-5-21-999" }, "ERR_ANCHOR_OWNERSHIP"],
  ]) test(`native Windows ${name} rejects ${kind} despite a permissive injected adapter`, t => {
    const f = fixture(t), store = f.initialize();
    const state = fs.readFileSync(path.join(f.dir, "pin-state.json"));
    evidence.paths.set(path.join(f.dir, name), override);
    const forged = { ...f.options, anchorMode: "permissive", platform: "posix",
      adapter: { currentIdentity: () => "sid:" + SERVICE, normalizeIdentity: x => x,
        ownerIdentity: () => "sid:" + SERVICE, writableIdentities: () => new Set(["sid:" + SERVICE]) } };
    assert.throws(() => lock.assertWindowsFilePermissions(path.join(f.dir, name)), { code });
    // The full strict domain check reports an extra file owner as a writer.
    const domainCode = kind === "other owner" ? "ERR_ANCHOR_WRITER_SET" : code;
    assert.throws(() => ProtectedPinStore.open(f.dir, forged), { code: domainCode });
    assert.throws(() => store.listPins(), { code: domainCode });
    assert.throws(() => store.noteRevocationSeen(99), { code: domainCode });
    assert.deepEqual(fs.readFileSync(path.join(f.dir, "pin-state.json")), state);
  });
}

for (const kind of ["unavailable", "malformed"]) test(`native Windows ${kind} evidence refuses work`, t => {
  const f = fixture(t), store = f.initialize();
  evidence[kind] = true;
  assert.throws(() => store.listPins(), { code: "ERR_ANCHOR_AUTHORIZATION_UNKNOWN" });
  assert.throws(() => lock.withLock(f.dir, () => assert.fail("business work ran")),
    { code: "ERR_ANCHOR_AUTHORIZATION_UNKNOWN" });
});

test("native Windows lock accepts only service virtual groups present in the token", t => {
  const f = fixture(t);
  f.initialize();
  evidence.paths.set(path.join(f.dir, lock.FILE), { access: [
    { Sid: SERVICE, Type: "Allow", Rights: "FullControl" },
    { Sid: GROUP, Type: "Allow", Rights: "Write" },
  ] });
  assert.throws(() => lock.withLock(f.dir, () => true), { code: "ERR_ANCHOR_WRITER_SET" });
  evidence.groups = [GROUP];
  assert.equal(lock.withLock(f.dir, () => true), true);
});

test("Windows initialization still requires the declared service identity", t => {
  const f = fixture(t);
  assert.throws(() => ProtectedPinStore.initialize(f.dir, { ...f.options, serviceIdentity: undefined }),
    { code: "ERR_ANCHOR_SERVICE_IDENTITY_INVALID" });
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("a pre-existing audit log is not exempted from the empty-domain requirement", t => {
  const f = fixture(t), file = path.join(f.dir, "protected-anchor-audit.log");
  fs.writeFileSync(file, "existing evidence", { mode: 0o600 });
  assert.throws(() => f.initialize(), { key: "ERR_PIN_STATE_CORRUPT" });
  assert.equal(fs.readFileSync(file, "utf8"), "existing evidence");
  assert.deepEqual(fs.readdirSync(f.dir), ["protected-anchor-audit.log"]);
});

test("failed strict ancestor audit refuses initialization before creating either lock", t => {
  const f = fixture(t), append = fs.appendFileSync;
  fs.appendFileSync = function(file, ...args) {
    if (path.basename(String(file)) === "protected-anchor-audit.log") throw new Error("audit denied");
    return append.call(this, file, ...args);
  };
  try { assert.throws(() => f.initialize(), { code: "ERR_AUDIT_WRITE_FAILED" }); }
  finally { fs.appendFileSync = append; }
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("a Windows platform option does not disable native POSIX lock permission checks", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  // Return to the real host; only the deployment options claim Windows.
  Object.defineProperty(process, "platform", { value: f.platform, configurable: true });
  assert.throws(() => ProtectedPinStore.initialize(f.dir, { ...f.options, platform: "windows",
    anchorMode: "permissive" }), { key: "ERR_PIN_STATE_CORRUPT" });
});

function forgedOptions(f, overrides = {}) {
  const sid = overrides.serviceIdentity || f.options.serviceIdentity;
  return { ...f.options, platform: "posix", adapter: {
    currentIdentity: () => sid, normalizeIdentity: x => x,
    ownerIdentity: () => sid, writableIdentities: () => new Set([sid]),
  }, ...overrides };
}

for (const [kind, overrides] of [
  ["strict injected adapter", { anchorMode: "strict" }],
  ["permissive mode", { anchorMode: "permissive", platform: "windows", adapter: undefined }],
  ["combined forged options", { anchorMode: "permissive" }],
]) {
  for (const name of ["directory", "pin-state.json", "pin-domain.json", "protected-anchor-audit.log", "ancestor"]) {
    test(`native Windows ${name} rejects broad writes with ${kind}`, t => {
      const f = fixture(t);
      f.initialize();
      const options = forgedOptions(f, overrides);
      const store = ProtectedPinStore.open(f.dir, options);
      const statePath = path.join(f.dir, "pin-state.json");
      const auditPath = path.join(f.dir, "protected-anchor-audit.log");
      const state = fs.readFileSync(statePath), audit = fs.readFileSync(auditPath);
      const target = name === "directory" ? f.dir : name === "ancestor" ? f.root : path.join(f.dir, name);
      evidence.checked.clear();
      evidence.paths.set(target, { access: [{ Sid: "S-1-1-0", Type: "Allow", Rights: "Write" }] });
      assert.throws(() => ProtectedPinStore.open(f.dir, options), { code: "ERR_ANCHOR_PERMISSIONS" });
      assert.throws(() => store.listPins(), { code: "ERR_ANCHOR_PERMISSIONS" });
      assert.throws(() => store.noteRevocationSeen(99), { code: "ERR_ANCHOR_PERMISSIONS" });
      assert.ok(evidence.checked.has(target), "native DACL must supply the evidence");
      assert.deepEqual(fs.readFileSync(statePath), state);
      assert.deepEqual(fs.readFileSync(auditPath), audit);
    });
  }
}

for (const serviceIdentity of [undefined, "sid:S-1-5-21-999"]) {
  test(`native Windows refuses forged identity ${serviceIdentity} before provisioning`, t => {
    const f = fixture(t);
    const options = forgedOptions(f, { anchorMode: "permissive", serviceIdentity });
    const code = serviceIdentity === undefined
      ? "ERR_ANCHOR_SERVICE_IDENTITY_INVALID" : "ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH";
    assert.throws(() => ProtectedPinStore.initialize(f.dir, options), { code });
    assert.deepEqual(fs.readdirSync(f.dir), []);
    f.initialize();
    assert.throws(() => ProtectedPinStore.open(f.dir, options), { code });
    assert.throws(() => ProtectedPinStore.migrateOffline(f.dir, { ...options, offline: true }), { code });
  });
}

test("native Windows forged permissive options cannot suppress ancestor audit failures", t => {
  const f = fixture(t), append = fs.appendFileSync;
  fs.appendFileSync = function(file, ...args) {
    if (path.basename(String(file)) === "protected-anchor-audit.log") throw new Error("audit denied");
    return append.call(this, file, ...args);
  };
  try {
    assert.throws(() => ProtectedPinStore.initialize(f.dir, forgedOptions(f, { anchorMode: "permissive" })),
      { code: "ERR_AUDIT_WRITE_FAILED" });
  } finally { fs.appendFileSync = append; }
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("non-Windows development keeps injected adapters and permissive mode", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  Object.defineProperty(process, "platform", { value: f.platform, configurable: true });
  fs.lstatSync = f.nativeLstat;
  const options = forgedOptions(f, { platform: "windows", anchorMode: "strict" });
  const store = ProtectedPinStore.initialize(f.dir, options);
  store.noteRevocationSeen(1);
  assert.equal(ProtectedPinStore.open(f.dir, { ...options, anchorMode: "permissive" })
    .revocationState().highestSeenRevocationSequence, 1);
});

// Load the production lock with real win32 path semantics. SQLite remains real
// but uses :memory:, and synthetic lstat evidence avoids needing junction rights.
function windowsPathLock(dir, redirect = null, unreadable = null) {
  const win = path.win32, seen = [], directories = new Set();
  // A namespaced UNC server without its share is not a filesystem path.
  // Do not synthesize it as a readable directory and mask an overlong walk.
  const shareRoot = /^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?=\\|$)/i.exec(dir)?.[0];
  for (let current = dir;; current = win.dirname(current)) {
    directories.add(current);
    if (current === shareRoot || win.dirname(current) === current) break;
  }
  let opened = 0;
  const filename = require.resolve("../../lib/coordination/protected-store-lock");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = spec => {
    if (spec === "node:path") return win;
    if (spec === "node:fs") return {
      lstatSync(file) {
        seen.push(file);
        // The lock database has the same sidecar files as any other SQLite
        // database. They are absent in this synthetic file system, which the
        // loader has to report as "does not exist" rather than as an
        // unreadable path -- an unreadable ancestor is a different condition.
        const sidecar = ["-wal", "-shm", "-journal"]
          .some(suffix => file === win.join(dir, lock.FILE) + suffix);
        if (sidecar) throw Object.assign(new Error("absent sidecar"), { code: "ENOENT" });
        if (file === unreadable || (!directories.has(file) && file !== win.join(dir, lock.FILE))) {
          throw Object.assign(new Error("unreadable path"), { code: "EACCES" });
        }
        return { dev: 1, ino: file === win.join(dir, lock.FILE) ? 2 : 1, nlink: 1, mode: 0o666,
          isDirectory: () => directories.has(file), isFile: () => !directories.has(file),
          isSymbolicLink: () => file === redirect };
      },
      openSync() { assert.fail("redirected lock must not be created"); },
    };
    if (spec === "node:sqlite") return { DatabaseSync: class {
      constructor(file) {
        assert.equal(file, win.join(dir, lock.FILE));
        opened += 1;
        const db = new (require("node:sqlite").DatabaseSync)(":memory:");
        db.exec("PRAGMA user_version=1");
        return db;
      }
    } };
    return nativeRequire(spec);
  };
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return { lock: loaded.exports, seen, opened: () => opened };
}

for (const dir of ["C:\\review\\junction\\pin", "\\\\server\\share\\junction\\pin",
  "\\\\?\\C:\\review\\junction\\pin", "\\\\?\\UNC\\server\\share\\junction\\pin"]) {
  test(`Windows drive/UNC parent junction is refused: ${dir}`, t => {
    fixture(t);
    const parent = path.win32.dirname(dir), f = windowsPathLock(dir, parent);
    for (const create of [false, true]) {
      assert.throws(() => f.lock.withLock(dir, () => assert.fail("business work ran"), { create }),
        { code: "ERR_COORDINATION_LOCK_UNSAFE" });
    }
    assert.ok(f.seen.includes(parent));
    assert.equal(f.opened(), 0);
  });
  test(`Windows drive/UNC clean path uses its real root: ${dir}`, t => {
    fixture(t);
    const f = windowsPathLock(dir);
    assert.equal(f.lock.withLock(dir, () => "ran"), "ran");
    const root = /^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?=\\|$)/i.exec(dir)?.[0] || path.win32.parse(dir).root;
    for (let current = path.win32.dirname(dir); current !== root;
      current = path.win32.dirname(current)) {
      assert.ok(f.seen.includes(current));
    }
    if (dir.startsWith("\\\\?\\UNC\\")) assert.ok(!f.seen.includes("\\\\?\\UNC\\server"));
    assert.equal(f.opened(), 1);
  });
  test(`Windows drive/UNC unreadable parent is refused: ${dir}`, t => {
    fixture(t);
    const f = windowsPathLock(dir, null, path.win32.dirname(dir));
    assert.throws(() => f.lock.withLock(dir, () => assert.fail("business work ran")),
      { code: "ERR_COORDINATION_LOCK_UNSAFE" });
    assert.equal(f.opened(), 0);
  });
}

for (const dir of ["\\\\?\\UNC\\server\\share", "\\\\?\\unc\\server\\share\\",
  "\\\\?\\UNC\\server\\share with spaces\\pin"]) {
  test(`extended UNC stops at the share root: ${dir}`, t => {
    fixture(t);
    const f = windowsPathLock(path.win32.resolve(dir));
    assert.equal(f.lock.withLock(dir, () => "ran"), "ran");
    assert.ok(!f.seen.includes("\\\\?\\UNC\\server"));
    assert.ok(!f.seen.includes("\\\\?\\unc\\server"));
  });
}

test("an unreadable Windows ancestor refuses work", t => {
  fixture(t);
  const dir = "C:\\review\\parent\\pin", parent = path.win32.dirname(dir);
  const f = windowsPathLock(dir, null, parent);
  assert.throws(() => f.lock.withLock(dir, () => assert.fail("business work ran")),
    { code: "ERR_COORDINATION_LOCK_UNSAFE" });
  assert.equal(f.opened(), 0);
});

test("a real redirected parent refuses Windows provisioning before audit or lock creation", t => {
  const f = fixture(t), alias = path.join(f.root, "redirected-parent");
  fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => ProtectedPinStore.initialize(path.join(alias, "pin"), f.options),
    { code: "ERR_COORDINATION_LOCK_UNSAFE" });
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
