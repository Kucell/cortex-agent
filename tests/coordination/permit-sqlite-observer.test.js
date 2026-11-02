"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const source = path.join(root, "packages/permit-sqlite-observer");
const peer = path.join(__dirname, "fixtures/permit-sqlite-observer-peer.c");
const hooks = path.join(__dirname, "fixtures/permit-sqlite-observer-hooks.h");
const runtime = testRuntime();
const SECRET = "observer-fixture-private-body-never-report";
const state = { observed: 0, missing: 1, input: 2, identity: 3, unsafe: 4, changed: 5, permission: 6, io: 7, close: 8 };
const format = { unproven: 0, missing: 1, corrupt: 2, schema1: 3, schema2: 4, schema3: 5, unknown: 6 };

test("directory-FD SQLite observer: real POSIX confinement and fail-closed observations", {
  skip: !["darwin", "linux"].includes(process.platform) || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async t => {
  fs.mkdirSync(runtime, { recursive: true });
  const build = fs.mkdtempSync(path.join(fs.realpathSync(runtime), "permit-sqlite-observer-"));
  const binary = path.join(build, "observer-peer"), plain = path.join(build, "observer-plain");
  const object = path.join(build, "observer-hooks.o");
  const flags = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Wpedantic", "-O2", "-g",
    ...(process.env.PERMIT_SQLITE_OBSERVER_SANITIZE === "1" ? ["-fsanitize=address,undefined", "-fno-sanitize-recover=all"] : [])];
  const observations = [];
  t.diagnostic(JSON.stringify({ build, platform: process.platform, arch: process.arch, linuxAccepted: false }));
  t.after(() => fs.writeFileSync(path.join(build, "evidence.json"), JSON.stringify({
    platform: process.platform, arch: process.arch, node: process.version,
    linuxAccepted: false, productionConnected: false, executionAuthorized: false,
    sources: Object.fromEntries([path.join(source, "observer.c"), path.join(source, "observer.h"), peer, hooks].map(file =>
      [path.relative(root, file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")])),
    observations,
  }, null, 2) + "\n"));
  function compile(args) {
    const result = spawnSync("cc", [...flags, ...args], { encoding: "utf8", timeout: 20000,
      env: { ...process.env, TMPDIR: build } });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  compile(["-include", hooks, "-c", path.join(source, "observer.c"), "-o", object]);
  compile([object, peer, "-o", binary]);
  compile([path.join(source, "observer.c"), peer, "-o", plain]);
  const { DatabaseSync } = require("node:sqlite");
  function database(file, version = 2, pageSize = 4096) {
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA page_size=${pageSize}; CREATE TABLE fixture_data(secret TEXT); PRAGMA user_version=${version}`);
      db.prepare("INSERT INTO fixture_data VALUES (?)").run(SECRET);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
    } finally { db.close(); }
  }
  function fixture(t, version = 2, pageSize = 4096) {
    const dir = fs.mkdtempSync(path.join(build, "case-")), bound = path.join(dir, "bound");
    fs.mkdirSync(bound, { mode: 0o700 });
    fs.mkdirSync(bound + "-other", { mode: 0o700 });
    const file = path.join(bound, "store.sqlite");
    database(file, version, pageSize);
    database(path.join(bound, "replacement.sqlite"), 1);
    database(path.join(bound + "-other", "store.sqlite"), 1);
    // Capture protected test bindings BEFORE mutation, never rediscover a new
    // target's identity to make an observation pass.
    const identity = name => { const st = fs.statSync(name, { bigint: true }); return [st.dev, st.ino, st.uid].map(String); };
    const f = { dir, bound, file, directory: identity(bound), target: identity(file) };
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return f;
  }
  function observe(f, mode = "normal", options = {}) {
    const fd = fs.openSync(options.fdPath || f.bound, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let run;
    try {
      run = spawnSync(options.plain ? plain : binary,
        [f.bound, options.name === undefined ? "store.sqlite" : options.name, mode,
          ...(options.directory || f.directory), ...(options.target || f.target)],
        { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8", timeout: 10000,
          env: { ...process.env, TMPDIR: build } });
    } finally { fs.closeSync(fd); }
    assert.ifError(run.error); assert.equal(run.signal, null, run.stderr);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /runtime error:|AddressSanitizer|LeakSanitizer/);
    assert.ok(!run.stdout.includes(SECRET) && !run.stdout.includes(f.bound));
    const r = JSON.parse(run.stdout);
    assert.equal(r.blocked, true); assert.equal(r.executionAuthorized, false);
    assert.equal(r.snapshotUnproven, true); assert.equal(r.pathBindingUnproven, true);
    assert.equal(r.wrongReads, 0);
    if (r.rc) {
      assert.equal(r.headerValid, 0); assert.equal(r.version, 0); assert.equal(r.pageSize, 0);
      assert.equal(r.format, format.unproven); assert.deepEqual(r.sidecars, [0, 0, 0]);
    }
    observations.push({ mode, ...r });
    return r;
  }
  function snapshot(dir) {
    return Object.fromEntries(fs.readdirSync(dir).sort().map(name => {
      const file = path.join(dir, name), st = fs.lstatSync(file, { bigint: true });
      return [name, { markers: ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(k => String(st[k])),
        hash: st.isFile() ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null }];
    }));
  }

  await t.test("ancestor substitution before first sidecar lookup: no replacement open/read", t => {
    const f = fixture(t), r = observe(f, "ancestor-before-sidecar");
    assert.equal(r.state, state.changed); assert.equal(r.bytesRead, 0);
    assert.equal(fs.lstatSync(f.bound).isSymbolicLink(), true);
    assert.equal(fs.statSync(path.join(f.bound + "-held", "store.sqlite"), { bigint: true }).ino.toString(), f.target[1]);
  });
  for (const mode of ["replace-at-open", "replace-after-open", "symlink-at-open"]) {
    await t.test(`${mode}: final-component replacement rejected BEFORE pread`, t => {
      const r = observe(fixture(t), mode);
      assert.equal(r.rc, -1); assert.equal(r.bytesRead, 0); assert.equal(r.reads, 0);
      assert.equal(r.opens, 1); assert.ok([state.changed, state.io].includes(r.state));
    });
  }
  await t.test("real unscheduled cross-process replacement race never reads another inode", t => {
    const r = observe(fixture(t), "race");
    assert.equal(r.iterations, 300); assert.ok(r.unknown > 0); assert.equal(r.wrongReads, 0);
    assert.ok(r.bytesRead <= 30000);
  });
  await t.test("same inode modified between final pre-read check and pread: changed header IS read, then hints cleared and blocked", t => {
    const f = fixture(t), before = fs.statSync(f.file, { bigint: true });
    const r = observe(f, "write-before-read"), after = fs.statSync(f.file, { bigint: true });
    for (const key of ["dev", "ino", "uid", "size"]) assert.equal(after[key], before[key]);
    assert.ok(after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs);
    assert.equal(r.changedHeaderRead, 1); assert.equal(r.bytesRead, 100); assert.equal(r.reads, 1);
    assert.equal(r.rc, -1); assert.equal(r.state, state.changed); assert.equal(r.cleanupUnknown, 0);
    assert.equal(r.headerValid, 0); assert.equal(r.version, 0); assert.equal(r.pageSize, 0);
    assert.equal(r.format, format.unproven); assert.equal(r.blocked, true); assert.equal(r.executionAuthorized, false);
  });

  for (const version of [1, 2, 3, 0, 19, 2147483647, -1, -2147483648]) {
    await t.test(`real SQLite signed version ${version} is only a header hint`, t => {
      const f = fixture(t, version), before = snapshot(f.bound), r = observe(f);
      assert.equal(r.state, state.observed); assert.equal(r.headerValid, 1); assert.equal(r.version, version);
      assert.equal(r.format, version === 1 ? format.schema1 : version === 2 ? format.schema2 : version === 3 ? format.schema3 : format.unknown);
      assert.equal(r.bytesRead, 100); assert.equal(r.opens, 1); assert.equal(r.stats, 9); assert.equal(r.closes, 2);
      assert.deepEqual(r.sidecars, [1, 1, 1]); assert.deepEqual(snapshot(f.bound), before);
    });
  }
  await t.test("uninstrumented build performs the same actual FD observation", t => {
    const f = fixture(t), before = snapshot(f.bound), r = observe(f, "normal", { plain: true });
    assert.equal(r.version, 2); assert.equal(r.format, format.schema2); assert.deepEqual(snapshot(f.bound), before);
  });
  for (const page of [512, 65536]) await t.test(`SQLite page size ${page}`, t => {
    assert.equal(observe(fixture(t, 2, page)).pageSize, page);
  });
  await t.test("short reads remain bounded to exactly 100 bytes and 100 calls", t => {
    const f = fixture(t); fs.truncateSync(f.file, 2 ** 34);
    const r = observe(f, "short-read"); assert.equal(r.version, 2); assert.equal(r.bytesRead, 100); assert.equal(r.reads, 100);
  });
  for (const mutation of ["empty", "truncated", "magic", "signature-nul", "page", "write-format", "read-format",
    "reserved-size", "fractions", "schema-format", "encoding", "reserved-header", "unaligned-size"]) {
    await t.test(`malformed ${mutation} is corrupt-header`, t => {
      const f = fixture(t), b = fs.readFileSync(f.file);
      if (mutation === "empty") fs.truncateSync(f.file, 0);
      else if (mutation === "truncated") fs.truncateSync(f.file, 99);
      else if (mutation === "unaligned-size") fs.appendFileSync(f.file, "x");
      else {
        if (mutation === "magic") b[0] = 0;
        if (mutation === "signature-nul") b[15] = 1;
        if (mutation === "page") b.writeUInt16BE(500, 16);
        if (mutation === "write-format") b[18] = 0;
        if (mutation === "read-format") b[19] = 3;
        if (mutation === "reserved-size") { b.writeUInt16BE(512, 16); b[20] = 33; }
        if (mutation === "fractions") b[21] = 0;
        if (mutation === "schema-format") b.writeUInt32BE(5, 44);
        if (mutation === "encoding") b.writeUInt32BE(4, 56);
        if (mutation === "reserved-header") b[72] = 1;
        fs.writeFileSync(f.file, b);
      }
      const before = snapshot(f.bound), r = observe(f);
      assert.equal(r.format, format.corrupt); assert.equal(r.headerValid, 0); assert.deepEqual(snapshot(f.bound), before);
    });
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) for (const type of ["empty", "regular", "directory", "symlink", "dangling", "fifo"]) {
    await t.test(`${suffix} ${type} receives ONLY no-follow metadata calls`, t => {
      const f = fixture(t), sidecar = f.file + suffix;
      if (type === "empty" || type === "regular") fs.writeFileSync(sidecar, type === "empty" ? "" : SECRET);
      if (type === "directory") fs.mkdirSync(sidecar);
      if (type === "symlink" || type === "dangling") fs.symlinkSync(type === "symlink" ? f.file : "absent", sidecar);
      if (type === "fifo") assert.equal(spawnSync("mkfifo", [sidecar], { timeout: 3000 }).status, 0);
      const before = snapshot(f.bound), r = observe(f);
      assert.equal(r.sidecars[["-wal", "-shm", "-journal"].indexOf(suffix)],
        type === "directory" ? 3 : ["symlink", "dangling"].includes(type) ? 4 : type === "fifo" ? 5 : 2);
      assert.equal(r.opens, 1); assert.equal(r.bytesRead, 100); assert.deepEqual(snapshot(f.bound), before);
    });
  }
  for (const mode of ["replace-after-read", "ancestor-after-read", "write-after-read", "grow-after-read", "truncate-after-read",
    "unlink-after-read", "link-after-read", "sidecar-after-read", "sidecar-replace", "sidecar-remove"]) {
    await t.test(`separate-process ${mode} invalidates hints without retry`, t => {
      const f = fixture(t);
      if (["sidecar-replace", "sidecar-remove"].includes(mode)) {
        fs.writeFileSync(f.file + "-wal", SECRET); fs.writeFileSync(path.join(f.bound, "sidecar-replacement"), "different");
      }
      const r = observe(f, mode); assert.equal(r.state, state.changed); assert.equal(r.reads, 1); assert.equal(r.bytesRead, 100);
    });
  }
  for (const which of ["directory", "target"]) for (const field of [0, 1, 2]) {
    await t.test(`protected ${which} ${["device", "inode", "owner"][field]} mismatch refuses before read`, t => {
      const f = fixture(t), id = [...f[which]]; id[field] = String(BigInt(id[field]) + 1n);
      const r = observe(f, "normal", { [which]: id }); assert.equal(r.state, state.identity); assert.equal(r.reads, 0); assert.equal(r.opens, 0);
    });
  }
  for (const kind of ["symlink", "hardlink", "directory", "fifo"]) await t.test(`unsafe target ${kind} is never opened`, t => {
    const f = fixture(t);
    if (kind === "hardlink") fs.linkSync(f.file, path.join(f.bound, "hardlink"));
    else {
      fs.unlinkSync(f.file);
      if (kind === "symlink") fs.symlinkSync("replacement.sqlite", f.file);
      if (kind === "directory") fs.mkdirSync(f.file);
      if (kind === "fifo") assert.equal(spawnSync("mkfifo", [f.file], { timeout: 3000 }).status, 0);
      const st = fs.lstatSync(f.file, { bigint: true }); f.target = [st.dev, st.ino, st.uid].map(String);
    }
    const r = observe(f); assert.equal(r.state, state.unsafe); assert.equal(r.opens, 0); assert.equal(r.reads, 0);
  });
  await t.test("writable directory and file-as-directory FD are rejected", t => {
    const f = fixture(t); fs.chmodSync(f.bound, 0o777);
    assert.equal(observe(f).state, state.unsafe);
    assert.equal(observe(f, "normal", { fdPath: f.file, directory: f.target }).state, state.unsafe);
  });
  for (const name of ["", ".", "..", "../store.sqlite", "/store.sqlite", "a/b", "bad\\name", "bad\nname", "a".repeat(248)]) {
    await t.test(`invalid single-component name ${JSON.stringify(name)} has no filesystem operations`, t => {
      const r = observe(fixture(t), "normal", { name }); assert.equal(r.state, state.input); assert.equal(r.stats, 0); assert.equal(r.closes, 0);
    });
  }
  for (const mode of ["at-fdcwd", "null-name", "closed-fd"]) await t.test(`invalid FD/input ${mode} cannot fall back to cwd`, t => {
    const r = observe(fixture(t), mode); assert.equal(r.state, mode === "closed-fd" ? state.io : state.input); assert.equal(r.opens, 0);
  });
  for (const orphan of [false, true]) await t.test(`missing DB orphan-sidecar=${orphan} never authorizes`, t => {
    const f = fixture(t); fs.unlinkSync(f.file); if (orphan) fs.writeFileSync(f.file + "-journal", SECRET);
    const r = observe(f); assert.equal(r.state, state.missing); assert.equal(r.format, format.missing); assert.equal(r.opens, 0); assert.equal(r.reads, 0);
    assert.deepEqual(r.sidecars, [1, 1, orphan ? 2 : 1]);
  });
  await t.test("missing DB appearing during observation is changed-unknown", t => {
    const f = fixture(t); fs.unlinkSync(f.file);
    assert.equal(observe(f, "missing-appears").state, state.changed);
  });
  for (const [mode, expected] of [["open-permission", state.permission], ["stat-permission", state.permission],
    ["stat-io", state.io], ["fstat-io", state.io], ["read-permission", state.permission],
    ["read-eintr", state.io], ["read-eof", state.changed]]) await t.test(`${mode} is unknown without retries`, t => {
    const r = observe(fixture(t), mode); assert.equal(r.state, expected); assert.ok(r.reads <= 1); assert.equal(r.bytesRead, 0);
  });
  for (const mode of ["close-before", "close-after", "close-reuse", "primary-and-close"]) {
    await t.test(`${mode}: close once, clear hints, preserve primary, never close reused number`, t => {
      const r = observe(fixture(t), mode);
      assert.equal(r.state, mode === "primary-and-close" ? state.permission : state.close);
      assert.equal(r.cleanupUnknown, 1); assert.equal(r.closes, 2);
    });
  }
});
