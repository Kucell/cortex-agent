"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { preflightPermitSqlite: preflight } = require("../../lib/coordination/permit-sqlite-preflight");
const supported = Number(process.versions.node.split(".")[0]) >= 24 && ["darwin", "linux"].includes(process.platform);
const localTest = (name, fn) => test(name, { skip: !supported, timeout: 15000 }, fn);
const runtime = testRuntime("permit-sqlite-preflight");
const peer = path.join(__dirname, "fixtures/permit-sqlite-preflight-peer.js");
const modulePath = require.resolve("../../lib/coordination/permit-sqlite-preflight");
const SECRET = "fixture-private-body-do-not-echo";

function fixture(version = 2, { large = false, pageSize = 4096 } = {}) {
  fs.mkdirSync(runtime, { recursive: true });
  // Canonicalize only the TEST directory; product never follows a path alias.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(runtime), "case-"));
  const file = path.join(dir, "explicit.sqlite");
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA page_size=${pageSize}; CREATE TABLE fixture_data(id INTEGER PRIMARY KEY, secret TEXT); PRAGMA user_version=${version}`);
    db.prepare("INSERT INTO fixture_data(secret) VALUES (?)").run(large ? SECRET.repeat(16000) : SECRET);
  } finally { db.close(); }
  return { dir, file };
}
function invariant(r, frozen = true) {
  assert.equal(r.executionAuthorized, false); assert.equal(r.ok, false); assert.equal(r.blocked, true);
  assert.equal(r.status, "partial"); assert.equal(r.scope, "header-only");
  assert.equal(r.snapshot_assurance, "snapshot-unproven"); assert.equal(r.snapshot_status, "sqlite_snapshot_unproven");
  assert.equal(r.path_binding, "path_binding_unproven"); assert.equal(r.deployment_status, "unproven");
  assert.equal(r.replacement_object_access, "not-excluded"); assert.equal(r.atime_effect, "may-change");
  if (frozen) {
    assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.sidecars));
    for (const s of r.sidecars) assert.ok(Object.isFrozen(s));
    if (r.header) assert.ok(Object.isFrozen(r.header));
  }
  const out = JSON.stringify(r);
  for (const value of [SECRET, "private-error", runtime, "explicit.sqlite", "ENOENT", "EACCES", "EPERM"])
    assert.equal(out.includes(value), false, "output must contain only allowlisted observations");
  return r;
}
function patched(methods, action) {
  const saved = {};
  for (const [name, wrapper] of Object.entries(methods)) { saved[name] = fs[name]; fs[name] = wrapper(saved[name]); }
  try { return action(); } finally { for (const [name, value] of Object.entries(saved)) fs[name] = value; }
}
function loaded({ node = process.versions.node, platform = process.platform, sqlite, constants = fs.constants } = {}) {
  const source = fs.readFileSync(modulePath, "utf8"), nativeRequire = createRequire(modulePath);
  const context = { module: { exports: {} }, Buffer, process: { versions: { node }, platform }, require(name) {
    if (name === "node:fs") return new Proxy(Object.create(null), { get(_target, key) { return key === "constants" ? constants : fs[key]; } });
    if (name === "node:sqlite" && sqlite) return sqlite();
    assert.ok(["node:fs", "node:path", "node:sqlite"].includes(name), "no business/provider imports");
    return nativeRequire(name);
  } };
  vm.runInNewContext(source, context, { filename: modulePath });
  return context.module.exports.preflightPermitSqlite;
}
function snapshot(dir) {
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name), st = fs.lstatSync(file, { bigint: true });
    result[name] = { markers: ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeNs", "ctimeNs"].map(k => String(st[k])),
      digest: st.isFile() ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null };
  }
  return result;
}
function forbidSideEffects() {
  const methods = {};
  for (const name of ["readFileSync", "readdirSync", "opendirSync", "writeFileSync", "appendFileSync", "writeSync", "writevSync",
    "mkdirSync", "mkdtempSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "copyFileSync", "cpSync", "truncateSync",
    "ftruncateSync", "chmodSync", "chownSync", "fchmodSync", "fchownSync", "utimesSync", "futimesSync", "fsyncSync", "fdatasyncSync",
    "linkSync", "symlinkSync", "readlinkSync", "realpathSync"]) {
    methods[name] = () => () => assert.fail("forbidden product filesystem operation: " + name);
  }
  return methods;
}
function guardedRead(file, action) {
  const fdNames = new Map(), closes = [], reads = [], opens = [];
  const sidecarChecks = new Map();
  let result;
  patched({ ...forbidSideEffects(),
    lstatSync: old => (name, ...args) => {
      if (["-wal", "-shm", "-journal"].some(suffix => name === file + suffix)) {
        sidecarChecks.set(name, (sidecarChecks.get(name) || 0) + 1);
      } else assert.ok(name === file || file.startsWith(name === path.sep ? name : name + path.sep), "metadata only DB and ancestors");
      return old(name, ...args);
    },
    openSync: old => (name, flags, ...args) => {
      assert.equal(typeof flags, "number");
      const c = fs.constants;
      assert.equal(flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND), 0);
      assert.ok(flags & c.O_NOFOLLOW); assert.ok(flags & c.O_NONBLOCK);
      assert.ok(name === file || file.startsWith(name === path.sep ? name : name + path.sep), "open only DB and ancestors");
      const fd = old(name, flags, ...args); fdNames.set(fd, name); opens.push(fd); return fd;
    },
    readSync: old => (fd, buffer, offset, length, position) => {
      assert.equal(fdNames.get(fd), file); assert.equal(buffer.length, 100);
      assert.ok(position >= 0 && position + length <= 100); reads.push({ position, length });
      return old(fd, buffer, offset, length, position);
    },
    closeSync: old => fd => { assert.ok(!closes.includes(fd)); closes.push(fd); return old(fd); },
  }, () => { result = action(); });
  assert.deepEqual(new Set(closes), new Set(opens));
  for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(sidecarChecks.get(file + suffix), 2);
  return { result: invariant(result), reads };
}

for (const [version, expected, migration] of [[1, "schema1-needs-migration", "required-unproven"],
  [2, "schema2-header-only", "unproven"], [3, "schema3-development-authority-unsupported", "unsupported"],
  [0, "unknown-schema", "unsupported"], [19, "unknown-schema", "unsupported"], [2147483647, "unknown-schema", "unsupported"]]) {
  localTest(`real SQLite user_version=${version} is only an immutable header hint`, () => {
    const f = fixture(version), before = snapshot(f.dir);
    const { result, reads } = guardedRead(f.file, () => preflight(f.file));
    assert.equal(result.format_status, expected); assert.equal(result.migration_status, migration);
    assert.equal(result.observation_status, "observed"); assert.equal(result.header.user_version, version);
    assert.equal(result.sidecar_status, "absent-unproven");
    assert.equal(result.authority_scope, version === 3 ? "separately-configured-development-authority-outside-migration-scope" : null);
    assert.equal(reads.reduce((n, r) => n + r.length, 0), 100); assert.deepEqual(snapshot(f.dir), before);
  });
}

for (const pageSize of [512, 65536]) localTest(`real SQLite page size ${pageSize} is supported`, () => {
  const f = fixture(2, { pageSize }); assert.equal(invariant(preflight(f.file)).header.page_size, pageSize);
});

for (const version of [-1, -2147483648]) localTest(`P3 real SQLite signed PRAGMA user_version=${version} matches the header hint`, t => {
  const f = fixture(version), { DatabaseSync } = require("node:sqlite");
  // SQL is a test oracle only; the product still must not construct a connection.
  const oracle = new DatabaseSync(f.file, { readOnly: true });
  let sqliteVersion;
  try { sqliteVersion = oracle.prepare("PRAGMA user_version").get().user_version; }
  finally { oracle.close(); }
  assert.equal(sqliteVersion, version);
  const before = snapshot(f.dir), { result } = guardedRead(f.file, () => preflight(f.file));
  assert.equal(result.header.user_version, sqliteVersion);
  assert.equal(result.format_status, "unknown-schema"); assert.equal(result.migration_status, "unsupported");
  assert.deepEqual(snapshot(f.dir), before);
  t.diagnostic(JSON.stringify({ review: "P3", sqliteUserVersion: sqliteVersion, headerUserVersion: result.header.user_version }));
});

localTest("capability probing never constructs SQLite or reads any business byte, and atime is not restored", t => {
  const f = fixture(2, { large: true });
  const probe = loaded({ sqlite: () => ({ DatabaseSync: function () { assert.fail("SQLite connection attempted"); } }) });
  const oldTime = new Date("2001-01-01T00:00:00Z"); fs.utimesSync(f.file, oldTime, oldTime);
  const before = fs.statSync(f.file, { bigint: true });
  const { result } = guardedRead(f.file, () => probe(f.file));
  const after = fs.statSync(f.file, { bigint: true });
  assert.equal(result.format_status, "schema2-header-only");
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[field], before[field]);
  t.diagnostic(JSON.stringify({ atimeChangedOnThisFilesystem: after.atimeNs !== before.atimeNs, forensicZeroTraceClaimed: false }));
});

localTest("fixed budget handles one-byte short reads, and arbitrarily large sparse files without body reads", () => {
  const f = fixture(); fs.truncateSync(f.file, 2 ** 34);
  let reads = 0, total = 0;
  patched({ readSync: old => (fd, bytes, offset, length, position) => {
    reads++; const n = old(fd, bytes, offset, Math.min(1, length), position); total += n; return n;
  } }, () => assert.equal(invariant(preflight(f.file)).format_status, "schema2-header-only"));
  assert.equal(reads, 100); assert.equal(total, 100);
});

for (const mutation of ["empty", "truncated", "magic", "page-size", "write-format", "read-format", "reserved-size",
  "fractions", "schema-format", "encoding", "reserved-header", "unaligned-size"]) {
  localTest(`static malformed ${mutation} is corrupt-header without raw bytes`, () => {
    const f = fixture(), bytes = fs.readFileSync(f.file);
    if (mutation === "empty") fs.truncateSync(f.file, 0);
    else if (mutation === "truncated") fs.truncateSync(f.file, 99);
    else if (mutation === "unaligned-size") fs.appendFileSync(f.file, "x");
    else {
      if (mutation === "magic") bytes.write(SECRET.slice(0, 16));
      if (mutation === "page-size") bytes.writeUInt16BE(500, 16);
      if (mutation === "write-format") bytes[18] = 0;
      if (mutation === "read-format") bytes[19] = 3;
      if (mutation === "reserved-size") { bytes.writeUInt16BE(512, 16); bytes[20] = 33; }
      if (mutation === "fractions") bytes[21] = 0;
      if (mutation === "schema-format") bytes.writeUInt32BE(5, 44);
      if (mutation === "encoding") bytes.writeUInt32BE(4, 56);
      if (mutation === "reserved-header") bytes[72] = 1;
      fs.writeFileSync(f.file, bytes);
    }
    const before = snapshot(f.dir), r = invariant(preflight(f.file));
    assert.equal(r.format_status, "corrupt-header"); assert.equal(r.header, null); assert.deepEqual(snapshot(f.dir), before);
  });
}

for (const suffix of ["-wal", "-shm", "-journal"]) for (const kind of ["empty", "regular", "directory", "symlink", "dangling-symlink", "fifo"]) {
  localTest(`${suffix} ${kind}: lstat only; presence is never ignorable`, () => {
    const f = fixture(), sidecar = f.file + suffix, outside = path.join(f.dir, "outside");
    if (kind === "empty" || kind === "regular") fs.writeFileSync(sidecar, kind === "empty" ? "" : SECRET);
    else if (kind === "directory") fs.mkdirSync(sidecar);
    else if (kind === "fifo") assert.equal(spawnSync("mkfifo", [sidecar], { timeout: 3000 }).status, 0);
    else { if (kind === "symlink") fs.writeFileSync(outside, SECRET); fs.symlinkSync(outside, sidecar); }
    const before = snapshot(f.dir);
    const { result } = guardedRead(f.file, () => preflight(f.file));
    assert.equal(result.sidecar_status, "observed-present"); assert.equal(result.format_status, "schema2-header-only");
    assert.equal(result.sidecars.find(s => s.suffix === suffix).type,
      kind.includes("symlink") ? "symlink" : kind === "empty" || kind === "regular" ? "regular-file" : kind);
    assert.deepEqual(snapshot(f.dir), before);
  });
}

for (const missing of ["database", "parent"]) localTest(`missing ${missing} remains missing, never not_configured or authorized`, () => {
  const f = fixture(); fs.unlinkSync(f.file);
  const file = missing === "parent" ? path.join(f.dir, "absent", "store.sqlite") : f.file;
  const before = snapshot(f.dir), r = invariant(preflight(file));
  assert.equal(r.format_status, "missing"); assert.equal(r.observation_status, "missing");
  assert.equal(r.sidecar_status, "absent-unproven"); assert.deepEqual(snapshot(f.dir), before);
});

localTest("orphan sidecars beside a missing DB remain untouched and snapshot-unproven", () => {
  const f = fixture(); fs.unlinkSync(f.file); fs.writeFileSync(f.file + "-wal", SECRET);
  const before = snapshot(f.dir), { result } = guardedRead(f.file, () => preflight(f.file));
  assert.equal(result.format_status, "missing"); assert.equal(result.sidecar_status, "observed-present");
  assert.deepEqual(snapshot(f.dir), before);
});

for (const kind of ["symlink", "hardlink", "directory", "fifo", "ancestor-symlink", "ancestor-file"]) {
  localTest(`reject ${kind} before opening the DB`, () => {
    const f = fixture(), other = path.join(f.dir, "other"); let target = f.file;
    if (kind === "hardlink") fs.linkSync(f.file, other);
    else if (kind === "ancestor-symlink") { fs.symlinkSync(f.dir, other); target = path.join(other, "explicit.sqlite"); }
    else if (kind === "ancestor-file") target = path.join(f.file, "nested.sqlite");
    else {
      fs.renameSync(f.file, other);
      if (kind === "symlink") fs.symlinkSync(other, f.file);
      if (kind === "directory") fs.mkdirSync(f.file);
      if (kind === "fifo") assert.equal(spawnSync("mkfifo", [f.file], { timeout: 3000 }).status, 0);
    }
    patched({ openSync: old => (name, ...args) => { assert.notEqual(name, target); return old(name, ...args); } }, () => {
      assert.equal(invariant(preflight(target)).observation_status, "unsafe-path-unknown");
    });
  });
}

for (const kind of ["replace-at-open", "replace-after-read", "same-size-write", "grow", "truncate", "unlink", "hardlink-added", "ancestor-replaced"]) {
  localTest(`real FS race ${kind} becomes unknown, with one close per descriptor and no retry`, () => {
    const f = fixture(), replacement = fixture(1); let fd, hit = false, reads = 0;
    const opened = new Set(), closed = new Set();
    function change() {
      hit = true;
      if (kind === "replace-at-open" || kind === "replace-after-read") fs.renameSync(replacement.file, f.file);
      else if (kind === "same-size-write") {
        const writer = fs.openSync(f.file, "r+"); const b = Buffer.alloc(4); b.writeUInt32BE(1);
        fs.writeSync(writer, b, 0, 4, 60); fs.closeSync(writer);
      } else if (kind === "grow") fs.appendFileSync(f.file, "x");
      else if (kind === "truncate") { const writer = realOpen(f.file, "r+"); fs.ftruncateSync(writer, 0); realClose(writer); }
      else if (kind === "unlink") fs.unlinkSync(f.file);
      else if (kind === "hardlink-added") fs.linkSync(f.file, path.join(f.dir, "hardlink"));
      else { fs.renameSync(f.dir, f.dir + "-old"); fs.mkdirSync(f.dir); fs.copyFileSync(replacement.file, f.file); }
    }
    // Exclude the deliberate race actor's own writable FD from observer counts.
    const realOpen = fs.openSync, realClose = fs.closeSync, realWrite = fs.writeSync;
    patched({
      openSync: old => (name, ...args) => {
        if (kind === "replace-at-open" && name === f.file && !hit) change();
        const result = old(name, ...args); if (args[0] !== "r+") opened.add(result);
        if (name === f.file && args[0] !== "r+") fd = result; return result;
      },
      readSync: old => (number, ...args) => {
        const count = old(number, ...args); reads++;
        if (number === fd && !hit) {
          if (kind === "same-size-write") {
            hit = true; const writer = realOpen(f.file, "r+"), b = Buffer.alloc(4); b.writeUInt32BE(1);
            realWrite(writer, b, 0, 4, 60); realClose(writer);
          } else change();
        }
        return count;
      },
      closeSync: old => number => { assert.ok(!closed.has(number)); closed.add(number); return old(number); },
    }, () => {
      const r = invariant(preflight(f.file)); assert.equal(r.observation_status, "changed-unknown"); assert.equal(r.header, null);
    });
    assert.ok(hit); assert.equal(reads, kind === "replace-at-open" ? 0 : 1); assert.deepEqual(closed, opened);
  });
}

localTest("ancestor string TOCTOU can OPEN a substituted DB before detecting it; no untouched-object claim", () => {
  const f = fixture(), replacement = fixture(1); let touched = false, read = false;
  const replacementInode = fs.statSync(replacement.file, { bigint: true }).ino;
  patched({
    openSync: old => (name, ...args) => {
      if (name === f.file) {
        fs.renameSync(f.dir, f.dir + "-old"); fs.symlinkSync(replacement.dir, f.dir);
        const fd = old(name, ...args); touched = fs.fstatSync(fd, { bigint: true }).ino === replacementInode; return fd;
      }
      return old(name, ...args);
    },
    readSync: old => (...args) => { read = true; return old(...args); },
  }, () => assert.equal(invariant(preflight(f.file)).observation_status, "changed-unknown"));
  assert.equal(touched, true); assert.equal(read, false);
});

localTest("P2 ancestor swap before first sidecar lookup READS 100 replacement DB bytes before changed-unknown", t => {
  const f = fixture(2), replacement = fixture(1);
  const expectedHeader = fs.readFileSync(replacement.file).subarray(0, 100);
  const replacementIdentity = fs.statSync(replacement.file, { bigint: true });
  const originalBefore = snapshot(f.dir), replacementBefore = snapshot(replacement.dir);
  const realRename = fs.renameSync, realSymlink = fs.symlinkSync;
  const opened = new Set(), closed = new Set();
  let swapped = false, replacementFd, bytesRead = 0, reads = 0, result;
  patched({ ...forbidSideEffects(),
    lstatSync: old => (name, ...args) => {
      if (!swapped && name === f.file + "-wal") {
        // Real namespace mutation at the precise interleaving; no fake Stats or
        // read bytes. All directory handles already refer to the ORIGINAL tree.
        swapped = true; realRename(f.dir, f.dir + "-old"); realSymlink(replacement.dir, f.dir);
      }
      return old(name, ...args);
    },
    openSync: old => (name, flags, ...args) => {
      const c = fs.constants;
      assert.equal(flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND), 0);
      assert.ok(flags & c.O_NOFOLLOW); assert.ok(flags & c.O_NONBLOCK);
      assert.ok(name === f.file || f.file.startsWith(name === path.sep ? name : name + path.sep));
      const fd = old(name, flags, ...args); opened.add(fd);
      if (name === f.file) {
        const st = fs.fstatSync(fd, { bigint: true });
        assert.equal(st.dev, replacementIdentity.dev); assert.equal(st.ino, replacementIdentity.ino);
        replacementFd = fd;
      }
      return fd;
    },
    readSync: old => (fd, bytes, offset, length, position) => {
      assert.equal(fd, replacementFd); assert.equal(position, 0); assert.equal(length, 100);
      const count = old(fd, bytes, offset, length, position); bytesRead += count; reads++;
      assert.ok(bytes.subarray(offset, offset + count).equals(expectedHeader), "real read must match replacement header");
      return count;
    },
    closeSync: old => fd => { assert.ok(!closed.has(fd)); closed.add(fd); return old(fd); },
  }, () => { result = invariant(preflight(f.file)); });
  assert.equal(swapped, true); assert.equal(bytesRead, 100); assert.equal(reads, 1);
  assert.equal(result.observation_status, "changed-unknown"); assert.equal(result.error_code, "ERR_PERMIT_SQLITE_SOURCE_CHANGED");
  assert.equal(result.header, null); assert.equal(result.format_status, "path/runtime-unproven");
  assert.deepEqual(closed, opened);
  assert.deepEqual(snapshot(f.dir + "-old"), originalBefore); assert.deepEqual(snapshot(replacement.dir), replacementBefore);
  t.diagnostic(JSON.stringify({ review: "P2", replacementBytesRead: bytesRead, replacementIdentityMatched: true,
    observationStatus: result.observation_status, executionAuthorized: result.executionAuthorized, readConfinementProven: false }));
});

for (const suffix of ["-wal", "-shm", "-journal"]) for (const race of ["appears", "disappears", "replaced", "changes-type", "mutates"]) {
  localTest(`sidecar ${suffix} ${race}: metadata race cannot turn into a successful snapshot`, () => {
    const f = fixture(), sidecar = f.file + suffix; let hit = false;
    if (race !== "appears") fs.writeFileSync(sidecar, SECRET);
    patched({ readSync: old => (...args) => {
      const n = old(...args);
      if (!hit) {
        hit = true;
        if (race === "appears") fs.writeFileSync(sidecar, "");
        else if (race === "disappears") fs.unlinkSync(sidecar);
        else if (race === "mutates") fs.appendFileSync(sidecar, "x");
        else { fs.renameSync(sidecar, sidecar + "-old"); if (race === "changes-type") fs.mkdirSync(sidecar); else fs.writeFileSync(sidecar, SECRET); }
      }
      return n;
    } }, () => assert.equal(invariant(preflight(f.file)).observation_status, "changed-unknown"));
    assert.ok(hit);
  });
}

for (const suffix of ["-wal", "-shm", "-journal"]) for (const race of ["appears", "disappears", "replaced", "changes-type"]) {
  localTest(`late sidecar ${suffix} ${race} after directory checks is detected by sidecar revalidation itself`, () => {
    const f = fixture(), name = f.file + suffix; let checks = 0;
    if (race !== "appears") fs.writeFileSync(name, "");
    patched({ lstatSync: old => (target, ...args) => {
      if (target === name && ++checks === 2) {
        if (race === "appears") fs.writeFileSync(name, "");
        else if (race === "disappears") fs.unlinkSync(name);
        else { fs.renameSync(name, name + "-old"); if (race === "changes-type") fs.mkdirSync(name); else fs.writeFileSync(name, ""); }
      }
      return old(target, ...args);
    } }, () => {
      const r = invariant(preflight(f.file));
      assert.equal(r.observation_status, "changed-unknown"); assert.equal(r.sidecar_status, "changed-unknown");
    });
    assert.equal(checks, 2);
  });
}

localTest("a missing DB appearing before revalidation is changed-unknown", () => {
  const f = fixture(); fs.unlinkSync(f.file); let calls = 0;
  patched({ lstatSync: old => (name, ...args) => {
    if (name === f.file && ++calls === 2) fs.writeFileSync(f.file, "new");
    return old(name, ...args);
  } }, () => assert.equal(invariant(preflight(f.file)).observation_status, "changed-unknown"));
  assert.equal(calls, 2);
});

for (const method of ["lstatSync", "openSync", "fstatSync", "readSync"]) for (const errorCode of ["EACCES", "EPERM", "EIO"]) {
  localTest(`${method} ${errorCode}: unknown, sanitized and never missing`, () => {
    const f = fixture();
    patched({ [method]: () => () => { const e = Error("private-error: " + SECRET); e.code = errorCode; e.path = f.file; throw e; } }, () => {
      const r = invariant(preflight(f.file));
      assert.equal(r.observation_status, errorCode === "EIO" ? "io-unknown" : "permission-unknown");
      assert.equal(r.header, null); assert.equal(r.format_status, "path/runtime-unproven");
    });
  });
}

localTest("sidecar permission denial does not open the DB or follow its target", () => {
  const f = fixture();
  patched({
    lstatSync: old => (name, ...args) => { if (name === f.file + "-wal") { const e = Error(SECRET); e.code = "EACCES"; throw e; } return old(name, ...args); },
    openSync: old => (name, ...args) => { assert.notEqual(name, f.file); return old(name, ...args); },
  }, () => assert.equal(invariant(preflight(f.file)).observation_status, "permission-unknown"));
});

localTest("real OS permission denial is unknown when this process cannot bypass permissions", t => {
  if (process.getuid && process.getuid() === 0) { t.skip("root may bypass DAC"); return; }
  const f = fixture(); fs.chmodSync(f.file, 0);
  try { assert.equal(invariant(preflight(f.file)).observation_status, "permission-unknown"); }
  finally { fs.chmodSync(f.file, 0o600); }
});

for (const fault of ["eof", "EINTR", "identity-before-read", "identity-after-read", "identity-unavailable"]) {
  localTest(`bounded FD fault ${fault} never returns a header result`, () => {
    const f = fixture(); let fd, reads = 0;
    patched({
      openSync: old => (name, ...args) => { const n = old(name, ...args); if (name === f.file) fd = n; return n; },
      fstatSync: old => (number, ...args) => {
        const st = old(number, ...args);
        if (number === fd && (fault === "identity-before-read" || fault === "identity-after-read" && reads)) st.ino += 1n;
        return st;
      },
      lstatSync: old => (name, ...args) => { const st = old(name, ...args); if (name === f.file && fault === "identity-unavailable") st.ino = 0n; return st; },
      readSync: old => (...args) => {
        reads++; if (fault === "eof") return 0;
        if (fault === "EINTR") { const e = Error(SECRET); e.code = "EINTR"; throw e; }
        return old(...args);
      },
    }, () => {
      const r = invariant(preflight(f.file)); assert.equal(r.header, null);
      assert.equal(r.observation_status, fault === "EINTR" ? "io-unknown" : fault === "identity-unavailable" ? "identity-unknown" : "changed-unknown");
    });
    assert.ok(reads <= 1);
  });
}

for (const when of ["before-close", "after-close"]) for (const primary of [false, true]) {
  localTest(`${when} failure with primary=${primary}: close once, preserve primary, report uncertain cleanup`, () => {
    const f = fixture(), realClose = fs.closeSync, leaked = [], closed = new Map(); let failed = 0;
    try {
      patched({
        readSync: old => (...args) => { if (primary) { const e = Error(SECRET); e.code = "EACCES"; throw e; } return old(...args); },
        closeSync: old => fd => {
          closed.set(fd, (closed.get(fd) || 0) + 1);
          if (failed++ < 2) { if (when === "after-close") old(fd); else leaked.push(fd); throw Error("private-error"); }
          return old(fd);
        },
      }, () => {
        const r = invariant(preflight(f.file));
        assert.equal(r.observation_status, primary ? "permission-unknown" : "close-unknown");
        assert.equal(r.error_code, primary ? "ERR_PERMIT_SQLITE_PERMISSION_UNKNOWN" : "ERR_PERMIT_SQLITE_CLOSE_UNKNOWN");
        assert.equal(r.cleanup_error_code, "ERR_PERMIT_SQLITE_CLOSE_UNKNOWN"); assert.equal(r.header, null);
      });
      for (const n of closed.values()) assert.equal(n, 1);
    } finally { for (const fd of leaked) realClose(fd); } // Only test can know which fault leaked.
    assert.equal(invariant(preflight(f.file)).format_status, "schema2-header-only");
  });
}

localTest("close-after-release failure must not close a newly reused descriptor number", () => {
  const f = fixture(), realOpen = fs.openSync, realClose = fs.closeSync;
  let reused, failed = false;
  try {
    patched({ closeSync: old => fd => {
      if (!failed) {
        failed = true; old(fd); reused = realOpen(f.file, fs.constants.O_RDONLY);
        assert.equal(reused, fd); throw Error("private-error");
      }
      return old(fd);
    } }, () => assert.equal(invariant(preflight(f.file)).observation_status, "close-unknown"));
    assert.equal(fs.fstatSync(reused).isFile(), true, "reused descriptor must still be open");
  } finally { if (reused !== undefined) realClose(reused); }
});

localTest("same-path reentry is unknown without disturbing the outer observation or leaking active state", () => {
  const f = fixture(); let inner;
  patched({ readSync: old => (...args) => { inner = invariant(preflight(f.file)); return old(...args); } }, () => {
    assert.equal(invariant(preflight(f.file)).format_status, "schema2-header-only");
  });
  assert.equal(inner.observation_status, "concurrent-unknown");
  assert.equal(invariant(preflight(f.file)).format_status, "schema2-header-only");
});

test("strict primitive input and arity reject without coercion, getters, provider execution or IO", () => {
  let calls = 0; const trap = () => { calls++; throw Error("input getter invoked"); };
  const hostile = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const invalid = [undefined, null, 7, {}, hostile, new String("/path"), "", "relative.sqlite", "file:/db", "/",
    "/a/../db", "/a/./db", "/a//db", "/db/", "/bad\0path", "/bad\npath", "/bad\\path", "/bad\ud800",
    "/" + "a".repeat(4096), "/" + "汉".repeat(1400), "/" + "a/".repeat(65) + "db"];
  patched({ lstatSync: () => () => assert.fail("invalid input must not touch FS"), openSync: () => () => assert.fail("invalid input open") }, () => {
    for (const input of invalid) assert.equal(invariant(preflight(input)).observation_status, "invalid-input");
    assert.equal(invariant(preflight("/unused", hostile)).observation_status, "invalid-input");
    assert.equal(invariant(preflight()).observation_status, "invalid-input");
  });
  assert.equal(calls, 0);
});

for (const node of ["16.20.2", "18.20.8", "22.23.2"]) test(`Node ${node} refuses before SQLite/FS probing`, () => {
  const probe = loaded({ node, sqlite: () => assert.fail("module must not be loaded on older Node") });
  patched({ lstatSync: () => () => assert.fail("runtime unsupported IO") }, () => {
    assert.equal(invariant(probe("/unused.sqlite")).observation_status, "runtime-unsupported");
  });
});

for (const missing of ["module", "constructor"]) test(`Node24 missing SQLite ${missing} is runtime unsupported without connection`, () => {
  const probe = loaded({ node: "24.19.0", sqlite: () => { if (missing === "module") throw Error(SECRET); return {}; } });
  assert.equal(invariant(probe("/unused.sqlite")).observation_status, "runtime-unsupported");
});

for (const platform of ["win32", "freebsd"]) test(`unsupported ${platform} has no fallback to unsafe path IO`, () => {
  const probe = loaded({ node: "24.19.0", platform, sqlite: () => ({ DatabaseSync() {} }) });
  assert.equal(invariant(probe("/unused.sqlite")).observation_status, "path-unsupported");
});

for (const flag of ["O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"]) test(`missing ${flag} refuses before FS IO`, () => {
  const probe = loaded({ node: "24.19.0", constants: { ...fs.constants, [flag]: undefined }, sqlite: () => ({ DatabaseSync() {} }) });
  patched({ lstatSync: () => () => assert.fail("unsupported flags IO") }, () => {
    assert.equal(invariant(probe("/unused.sqlite")).observation_status, "path-unsupported");
  });
});

async function holder(t, mode, file) {
  const child = spawn(process.execPath, [peer, mode, file], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit"); let stderr = "";
  child.stderr.on("data", b => { stderr += b; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } });
  const [bytes] = await Promise.race([once(child.stdout, "data"), exit.then(() => { throw Error("fixture exited before ready: " + stderr); })]);
  assert.equal(String(bytes).trim(), "ready");
  return { child, exit };
}

localTest("live real WAL may contain schema2 while DB header says schema1: never connect, checkpoint or authorize", async t => {
  const f = fixture(1), h = await holder(t, "wal-holder", f.file);
  assert.ok(fs.existsSync(f.file + "-wal")); assert.ok(fs.existsSync(f.file + "-shm"));
  const before = snapshot(f.dir), { result } = guardedRead(f.file, () => preflight(f.file));
  assert.equal(result.format_status, "schema1-needs-migration"); assert.equal(result.sidecar_status, "observed-present");
  assert.deepEqual(snapshot(f.dir), before);
  h.child.stdin.end(); assert.equal((await h.exit)[0], 0);
});

localTest("a genuine crashed hot rollback journal is not opened, recovered, changed or removed", async t => {
  const f = fixture(1, { large: true }), h = await holder(t, "hot-journal", f.file);
  h.child.kill("SIGKILL"); await h.exit;
  const journal = fs.readFileSync(f.file + "-journal");
  // SQLite's hot-journal magic, not merely an empty/artificial filename.
  assert.deepEqual(journal.subarray(0, 8), Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]));
  const before = snapshot(f.dir), { result } = guardedRead(f.file, () => preflight(f.file));
  assert.equal(result.sidecar_status, "observed-present"); assert.deepEqual(snapshot(f.dir), before);
});

localTest("real separate-process SQLite commit during the fixed-header observation is changed-unknown", () => {
  const f = fixture(); let invoked = 0;
  patched({ readSync: old => (...args) => {
    const n = old(...args); invoked++;
    const peerResult = spawnSync(process.execPath, [peer, "mutate", f.file], { timeout: 5000, encoding: "utf8" });
    assert.equal(peerResult.status, 0, peerResult.stderr); return n;
  } }, () => assert.equal(invariant(preflight(f.file)).observation_status, "changed-unknown"));
  assert.equal(invoked, 1);
});

localTest("separate-process observers share no lock, connection or cached authorization", async () => {
  const f = fixture(), before = snapshot(f.dir);
  const children = Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [peer, "observe", f.file], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { stderr += b; });
    child.on("error", reject); child.on("exit", code => { try { assert.equal(code, 0, stderr); resolve(invariant(JSON.parse(output), false)); } catch (e) { reject(e); } });
  }));
  // Serialized transport loses freezing; validate common evidence separately.
  const results = await Promise.allSettled(children);
  for (const r of results) { if (r.status === "rejected") throw r.reason; assert.equal(r.value.format_status, "schema2-header-only"); }
  assert.deepEqual(snapshot(f.dir), before);
});
