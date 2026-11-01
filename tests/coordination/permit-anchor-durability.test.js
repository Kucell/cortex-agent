"use strict";

// All fixtures live under this project's .agent/runtime. These are syscall and
// process-local failure tests, NOT power-cut, device-cache or service evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const anchorModule = require("../../lib/coordination/protected-anchor");
const capabilities = new Map();
// Test-only explicit binding: production store integration is owned by another
// agent. Bare module calls below separately verify the legacy default behavior.
const anchor = { ...anchorModule,
  appendEntry: (journal, value) => anchorModule.appendEntry(journal, value, capabilities.get(path.dirname(journal))),
  appendHighWater: (dir, value) => anchorModule.appendHighWater(dir, value, capabilities.get(dir)) };
const modulePath = require.resolve("../../lib/coordination/protected-anchor");
const supported = { skip: !["darwin", "linux"].includes(process.platform) };
const STORE_ID = "synthetic-store";
const A = "a".repeat(64);

function fixture(t) {
  const runtime = path.resolve(__dirname, "../../.agent/runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const root = fs.mkdtempSync(path.join(runtime, "permit-anchor-durability-"));
  const dir = path.join(root, "anchor"); fs.mkdirSync(dir, { mode: 0o700 });
  if (!supported.skip) capabilities.set(dir, anchorModule.preflightAuthorityDurability(dir));
  t.after(() => { capabilities.delete(dir); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dir, journal: path.join(dir, anchor.JOURNAL_FILE), highWater: path.join(dir, anchor.HIGH_WATER_FILE) };
}
function entry(type = "intent", sequence = 1) {
  return { type, sequence, body_digest: A, store_id: STORE_ID, attempt: 1 };
}
function ioError() { return Object.assign(new Error("synthetic I/O failure"), { code: "EIO" }); }
function fault(patches, body) {
  const originals = {};
  for (const key of Object.keys(patches)) { originals[key] = fs[key]; fs[key] = patches[key](fs[key]); }
  try { return body(); } finally { Object.assign(fs, originals); }
}
function trace(body) {
  const events = [];
  fault({
    writeSync: original => function(fd, ...args) { events.push("write"); return original(fd, ...args); },
    fsyncSync: original => function(fd) {
      events.push(fs.fstatSync(fd).isDirectory() ? "dir-sync" : "file-sync"); return original(fd);
    },
    renameSync: original => function(...args) { events.push("rename"); return original(...args); },
  }, () => body(events));
  return events;
}
function entryFile(f) { return fs.readdirSync(f.dir).find(n => n.startsWith("protected-anchor-entry-") && !n.includes(".tmp-")); }
function noTemps(f) { assert.ok(fs.readdirSync(f.dir).every(n => !n.includes(".tmp-"))); }

test("entry file flush precedes rename and mandatory parent sync; format stays v1", supported, t => {
  const f = fixture(t);
  assert.deepEqual(trace(() => anchor.appendEntry(f.journal, entry())), ["dir-sync", "write", "file-sync", "rename", "dir-sync"]);
  const record = JSON.parse(fs.readFileSync(path.join(f.dir, entryFile(f)), "utf8"));
  assert.equal(record.schema_version, 1);
  assert.equal(record.entry_digest, anchor.sha256([1, "intent", 1, A, STORE_ID, 1].join("\n")));
  assert.equal(anchor.readJournal(f.journal).intentsBySeq.get(1).body_digest, A);
  noTemps(f);
});

test("independent legacy v1 decoders accept new records but cannot attest stronger writer semantics", supported, t => {
  const f = fixture(t); anchor.appendEntry(f.journal, entry("commit")); anchor.appendHighWater(f.dir, entry("commit"));
  const e = JSON.parse(fs.readFileSync(path.join(f.dir, entryFile(f)), "utf8"));
  assert.deepEqual(Object.keys(e).sort(), ["schema_version", "type", "sequence", "body_digest", "store_id", "attempt", "entry_digest"].sort());
  assert.equal(e.schema_version, 1);
  assert.equal(e.entry_digest, anchor.sha256([e.schema_version, e.type, e.sequence, e.body_digest, e.store_id, e.attempt].join("\n")));
  const h = JSON.parse(fs.readFileSync(f.highWater, "utf8"));
  assert.deepEqual(Object.keys(h).sort(), ["sequence", "body_digest", "store_id", "attempt", "record_digest"].sort());
  assert.equal(h.record_digest, anchor.sha256([h.sequence, h.body_digest, h.store_id, h.attempt].join("\n")));
  // No new on-disk marker makes an old binary refuse these records. This test
  // intentionally does not claim mixed-writer safety or retroactive durability.
});

for (const failure of ["preflight", "write", "file-sync", "rename", "post-rename-dir-sync"]) {
  test(`entry ${failure} error propagates without deleting published evidence`, supported, t => {
    const f = fixture(t); const error = ioError(); let dirs = 0;
    const patches = {
      fsyncSync: original => function(fd) {
        if (fs.fstatSync(fd).isDirectory()) {
          dirs++;
          if ((failure === "preflight" && dirs === 1) || (failure === "post-rename-dir-sync" && dirs === 2)) throw error;
        } else if (failure === "file-sync") throw error;
        return original(fd);
      },
      writeSync: original => function(...args) { if (failure === "write") throw error; return original(...args); },
      renameSync: original => function(...args) { if (failure === "rename") throw error; return original(...args); },
    };
    fault(patches, () => assert.throws(() => anchor.appendEntry(f.journal, entry()), e => e === error));
    assert.equal(Boolean(entryFile(f)), failure === "post-rename-dir-sync");
    noTemps(f);
    // A retry must verify/sync the remaining exact entry, not erase it.
    anchor.appendEntry(f.journal, entry()); assert.equal(anchor.readJournal(f.journal).entries.length, 1);
  });
}

test("short entry write is refused; no partial record becomes a published name", supported, t => {
  const f = fixture(t);
  fault({ writeSync: original => (fd, bytes) => original(fd, bytes, 0, Math.floor(bytes.length / 2)) }, () => {
    assert.throws(() => anchor.appendEntry(f.journal, entry()), { code: "ERR_ANCHOR_WRITE_INCOMPLETE" });
  });
  assert.equal(entryFile(f), undefined); noTemps(f);
});

test("identical existing entry is checked and re-synced without replacing its inode", supported, t => {
  const f = fixture(t); anchor.appendEntry(f.journal, entry());
  const file = path.join(f.dir, entryFile(f)), before = fs.statSync(file);
  assert.deepEqual(trace(() => anchor.appendEntry(f.journal, entry())), ["dir-sync", "file-sync", "dir-sync"]);
  assert.equal(fs.statSync(file).ino, before.ino); noTemps(f);
});

for (const damage of ["different-same-length", "truncated", "directory", "symlink", "hardlink"]) {
  test(`existing entry ${damage} is refused without overwriting it`, supported, t => {
    const f = fixture(t); anchor.appendEntry(f.journal, entry());
    const file = path.join(f.dir, entryFile(f)), original = fs.readFileSync(file);
    if (damage === "different-same-length") { const b = Buffer.from(original); b[1] ^= 1; fs.writeFileSync(file, b); }
    if (damage === "truncated") fs.writeFileSync(file, original.subarray(0, original.length - 1));
    if (["directory", "symlink", "hardlink"].includes(damage)) {
      fs.unlinkSync(file);
      if (damage === "directory") fs.mkdirSync(file);
      else {
        const other = path.join(f.root, "synthetic-other"); fs.writeFileSync(other, original);
        if (damage === "symlink") fs.symlinkSync(other, file); else fs.linkSync(other, file);
      }
    }
    const before = fs.lstatSync(file), contents = before.isFile() ? fs.readFileSync(file) : null;
    assert.throws(() => anchor.appendEntry(f.journal, entry()), { code: ["different-same-length", "truncated"].includes(damage) ? "ERR_ANCHOR_CORRUPT" : "ERR_UNSAFE_PATH" });
    assert.equal(fs.lstatSync(file).ino, before.ino);
    if (contents) assert.deepEqual(fs.readFileSync(file), contents);
    noTemps(f);
  });
}

for (const destination of ["identical", "conflicting", "missing"]) {
  test(`rename EEXIST ${destination} destination requires exact verification`, supported, t => {
    const f = fixture(t);
    fault({ renameSync: () => (from, to) => {
      if (destination === "identical") fs.copyFileSync(from, to);
      if (destination === "conflicting") fs.writeFileSync(to, "synthetic conflicting record\n");
      throw Object.assign(new Error("synthetic exists"), { code: "EEXIST" });
    } }, () => {
      if (destination === "identical") anchor.appendEntry(f.journal, entry());
      else assert.throws(() => anchor.appendEntry(f.journal, entry()), { code: destination === "missing" ? "EEXIST" : "ERR_ANCHOR_CORRUPT" });
    });
    noTemps(f);
    if (destination === "identical") assert.equal(anchor.readJournal(f.journal).entries.length, 1);
  });
}

test("existing-entry file and parent sync failures still propagate", supported, t => {
  const f = fixture(t); anchor.appendEntry(f.journal, entry());
  for (const kind of ["file", "directory"]) {
    const error = ioError(); let dirs = 0;
    fault({ fsyncSync: original => fd => {
      if (fs.fstatSync(fd).isDirectory()) { if (++dirs === 2 && kind === "directory") throw error; }
      else if (kind === "file") throw error;
      return original(fd);
    } }, () => assert.throws(() => anchor.appendEntry(f.journal, entry()), e => e === error));
  }
});

test("high-water first creation and existing append both flush contents and parent", supported, t => {
  const f = fixture(t);
  assert.deepEqual(trace(() => anchor.appendHighWater(f.dir, entry())), ["dir-sync", "write", "file-sync", "dir-sync"]);
  const ino = fs.statSync(f.highWater).ino;
  assert.deepEqual(trace(() => anchor.appendHighWater(f.dir, entry("commit", 2))), ["dir-sync", "write", "file-sync", "dir-sync"]);
  assert.equal(fs.statSync(f.highWater).ino, ino); assert.equal(anchor.readHighWater(f.dir).mark, 2);
});

for (const failure of ["preflight", "file-sync", "parent-sync"]) {
  test(`high-water first-create ${failure} fails closed; retry synchronizes retained name`, supported, t => {
    const f = fixture(t); const error = ioError(); let dirs = 0;
    fault({ fsyncSync: original => fd => {
      if (fs.fstatSync(fd).isDirectory()) {
        dirs++;
        if ((failure === "preflight" && dirs === 1) || (failure === "parent-sync" && dirs === 2)) throw error;
      } else if (failure === "file-sync") throw error;
      return original(fd);
    } }, () => assert.throws(() => anchor.appendHighWater(f.dir, entry()), e => e === error));
    assert.equal(fs.existsSync(f.highWater), failure !== "preflight");
    anchor.appendHighWater(f.dir, entry()); assert.equal(anchor.readHighWater(f.dir).mark, 1);
  });
}

test("short high-water append leaves corrupt evidence, never silently repairs or appends past its tail", supported, t => {
  const f = fixture(t); anchor.appendHighWater(f.dir, entry());
  fault({ writeSync: original => (fd, line) => original(fd, Buffer.from(line).subarray(0, 5)) }, () => {
    assert.throws(() => anchor.appendHighWater(f.dir, entry("commit", 2)), { code: "ERR_ANCHOR_WRITE_INCOMPLETE" });
  });
  const before = fs.readFileSync(f.highWater);
  assert.throws(() => anchor.appendHighWater(f.dir, entry("commit", 2)), { code: "ERR_ANCHOR_CORRUPT" });
  assert.deepEqual(fs.readFileSync(f.highWater), before);
});

function seedCompaction(f) {
  const lines = [];
  for (let sequence = 1; sequence <= 1600; sequence++) {
    const r = { sequence, body_digest: A, store_id: STORE_ID, attempt: 1 };
    r.record_digest = anchor.sha256([sequence, A, STORE_ID, 1].join("\n"));
    lines.push(JSON.stringify(r));
  }
  fs.writeFileSync(f.highWater, lines.join("\n") + "\n", { mode: 0o600 });
  assert.ok(fs.statSync(f.highWater).size >= 256 * 1024);
}

for (const existing of [false, true]) for (const damage of ["attempt-zero", "attempt-missing", "store-missing", "store-empty", "sequence-zero", "bad-digest"]) {
  test(`strict new high-water ${damage} has zero writes (${existing ? "existing" : "new"})`, supported, t => {
    const f = fixture(t); if (existing) seedCompaction(f); // Invalid input must not even compact.
    const before = existing ? fs.readFileSync(f.highWater) : null;
    const value = entry("commit", 1601);
    if (damage === "attempt-zero") value.attempt = 0;
    if (damage === "attempt-missing") delete value.attempt;
    if (damage === "store-missing") delete value.store_id;
    if (damage === "store-empty") value.store_id = "";
    if (damage === "sequence-zero") value.sequence = 0;
    if (damage === "bad-digest") value.body_digest = "invalid";
    assert.deepEqual(trace(() => assert.throws(() => anchor.appendHighWater(f.dir, value),
      { code: "ERR_ANCHOR_CORRUPT" })), ["dir-sync"]);
    if (existing) assert.deepEqual(fs.readFileSync(f.highWater), before);
    else assert.equal(fs.existsSync(f.highWater), false);
    noTemps(f);
  });
}

test("legacy new high-water retains its old input acceptance and has no directory barrier", supported, t => {
  const f = fixture(t);
  assert.deepEqual(trace(() => anchorModule.appendHighWater(f.dir, { ...entry(), attempt: 0 })), ["write", "file-sync"]);
  assert.equal(JSON.parse(fs.readFileSync(f.highWater, "utf8")).attempt, 0);
});

for (const route of ["directory", "existing-entry", "new-entry", "high-water", "compaction"]) {
  for (const failure of ["fsync", "short-write-or-read"]) {
    test(`${route} ${failure} plus close failure keeps primary and closes fd once`, supported, t => {
      const f = fixture(t);
      if (route === "existing-entry") anchor.appendEntry(f.journal, entry());
      if (route === "compaction") seedCompaction(f);
      const primary = ioError(), cleanup = Object.assign(new Error("synthetic close"), { code: "EIO" });
      let selected, closes = 0, realShortWrites = 0;
      function chosen(fd) {
        const stat = fs.fstatSync(fd);
        return route === "directory" ? stat.isDirectory() : stat.isFile();
      }
      const invoke = () => route === "directory" ? anchorModule.preflightAuthorityDurability(f.dir) :
        route === "high-water" || route === "compaction" ? anchor.appendHighWater(f.dir, entry("commit", 1601)) :
        anchor.appendEntry(f.journal, entry());
      fault({
        fsyncSync: original => fd => {
          if (failure === "fsync" && chosen(fd)) { selected = fd; throw primary; }
          return original(fd);
        },
        fstatSync: original => fd => {
          const stat = original(fd);
          if (failure === "short-write-or-read" && route === "directory" && stat.isDirectory()) {
            selected = fd; throw primary;
          }
          return stat;
        },
        readSync: original => (fd, ...args) => {
          if (failure === "short-write-or-read" && route === "existing-entry") { selected = fd; throw primary; }
          return original(fd, ...args);
        },
        writeSync: original => (fd, data, ...args) => {
          if (failure === "short-write-or-read" && ["new-entry", "high-water", "compaction"].includes(route)) {
            const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
            selected = fd; realShortWrites++;
            return original(fd, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)));
          }
          return original(fd, data, ...args);
        },
        closeSync: original => fd => {
          const result = original(fd);
          if (fd === selected) { closes++; throw cleanup; }
          return result;
        },
      }, () => assert.throws(invoke, error => {
        if (realShortWrites) assert.equal(error.code, "ERR_ANCHOR_WRITE_INCOMPLETE");
        else assert.equal(error, primary);
        assert.equal(error.cleanupError, cleanup); return true;
      }));
      assert.equal(closes, 1);
      if (failure === "short-write-or-read" && ["new-entry", "high-water", "compaction"].includes(route)) assert.equal(realShortWrites, 1);
      noTemps(f);
      if (route === "high-water" && realShortWrites) assert.throws(() => anchor.readHighWater(f.dir), { code: "ERR_ANCHOR_CORRUPT" });
      if (route === "compaction") assert.equal(anchor.readHighWater(f.dir).mark, 1600);
    });
  }
}

for (const route of ["directory", "existing-entry", "new-entry", "high-water", "compaction"]) {
  test(`${route} lone close failure is not suppressed or retried`, supported, t => {
    const f = fixture(t);
    if (route === "existing-entry") anchor.appendEntry(f.journal, entry());
    if (route === "compaction") seedCompaction(f);
    const error = ioError(); let closes = 0;
    fault({ closeSync: original => fd => {
      const stat = fs.fstatSync(fd), selected = route === "directory" ? stat.isDirectory() : stat.isFile();
      const result = original(fd);
      if (selected) { closes++; throw error; }
      return result;
    } }, () => assert.throws(() => route === "directory" ? anchorModule.preflightAuthorityDurability(f.dir) :
      ["high-water", "compaction"].includes(route) ? anchor.appendHighWater(f.dir, entry("commit", 1601)) :
      anchor.appendEntry(f.journal, entry()), e => e === error));
    assert.equal(closes, 1); noTemps(f);
  });
}

for (const route of ["new-entry", "compaction"]) {
  test(`${route} rename plus temp cleanup failure remains primary with explicit unknown cleanup`, supported, t => {
    const f = fixture(t); if (route === "compaction") seedCompaction(f);
    const primary = ioError(), cleanup = ioError();
    fault({ renameSync: () => () => { throw primary; },
      unlinkSync: original => file => { if (String(file).includes(".tmp-")) throw cleanup; return original(file); },
    }, () => assert.throws(() => route === "compaction" ? anchor.appendHighWater(f.dir, entry("commit", 1601)) :
      anchor.appendEntry(f.journal, entry()), e => e === primary && e.cleanupError === cleanup &&
        e.temporaryCleanupError === cleanup && e.temporaryCleanupUnknown === true));
    assert.ok(fs.readdirSync(f.dir).some(n => n.includes(".tmp-")));
    assert.equal(entryFile(f), undefined);
    if (route === "compaction") assert.equal(anchor.readHighWater(f.dir).mark, 1600);
  });
}

test("primary write, close and temp cleanup failures keep the first two plus temp uncertainty", supported, t => {
  const f = fixture(t), primary = ioError(), closeError = ioError(), unlinkError = ioError(); let selected, closes = 0;
  fault({ writeSync: () => fd => { selected = fd; throw primary; },
    closeSync: original => fd => { const r = original(fd); if (fd === selected) { closes++; throw closeError; } return r; },
    unlinkSync: original => file => { if (String(file).includes(".tmp-")) throw unlinkError; return original(file); },
  }, () => assert.throws(() => anchor.appendEntry(f.journal, entry()), e => e === primary &&
    e.cleanupError === closeError && e.temporaryCleanupError === unlinkError && e.temporaryCleanupUnknown === true));
  assert.equal(closes, 1);
});
test("high-water compaction syncs replacement before new append, preserves mark and v1 encoding", supported, t => {
  const f = fixture(t); seedCompaction(f);
  assert.deepEqual(trace(() => anchor.appendHighWater(f.dir, entry("commit", 1601))),
    ["dir-sync", "write", "file-sync", "rename", "dir-sync", "write", "file-sync", "dir-sync"]);
  const mark = anchor.readHighWater(f.dir);
  assert.equal(mark.mark, 1601); assert.equal(mark.digest, A); assert.equal(mark.storeId, STORE_ID);
  assert.ok(fs.statSync(f.highWater).size < 256 * 1024); noTemps(f);
});

for (const failure of ["open", "file-sync", "rename", "parent-sync"]) {
  test(`high-water compaction ${failure} failure propagates before advancing mark`, supported, t => {
    const f = fixture(t); seedCompaction(f); const before = fs.readFileSync(f.highWater), error = ioError(); let dirs = 0;
    fault({
      openSync: original => (file, ...args) => {
        if (failure === "open" && String(file).includes(".tmp-compact-")) throw error;
        return original(file, ...args);
      },
      fsyncSync: original => fd => {
        if (fs.fstatSync(fd).isDirectory()) { if (++dirs === 2 && failure === "parent-sync") throw error; }
        else if (failure === "file-sync") throw error;
        return original(fd);
      },
      renameSync: original => (...args) => { if (failure === "rename") throw error; return original(...args); },
    }, () => assert.throws(() => anchor.appendHighWater(f.dir, entry("commit", 1601)), e => e === error));
    assert.equal(anchor.readHighWater(f.dir).mark, 1600);
    if (failure !== "parent-sync") assert.deepEqual(fs.readFileSync(f.highWater), before);
    noTemps(f); anchor.appendHighWater(f.dir, entry("commit", 1601));
    assert.equal(anchor.readHighWater(f.dir).mark, 1601);
  });
}

test("corrupt oversized high-water is not silently skipped by compaction", supported, t => {
  const f = fixture(t); seedCompaction(f); fs.appendFileSync(f.highWater, "not-a-record\n");
  const before = fs.readFileSync(f.highWater);
  assert.throws(() => anchor.appendHighWater(f.dir, entry("commit", 1601)), { code: "ERR_ANCHOR_CORRUPT" });
  assert.deepEqual(fs.readFileSync(f.highWater), before); noTemps(f);
});

for (const damage of ["checksum", "json", "trailing-prefix", "missing-store", "bad-attempt", "empty"]) {
  test(`strict small high-water ${damage} rejects before any append or replacement`, supported, t => {
    const f = fixture(t); anchor.appendHighWater(f.dir, entry());
    const original = fs.readFileSync(f.highWater, "utf8");
    let content = original;
    if (damage === "checksum") content = original.replace(A, "b".repeat(64));
    if (damage === "json") content = "invalid-json\n" + original;
    if (damage === "trailing-prefix") content = original + "{";
    if (["missing-store", "bad-attempt"].includes(damage)) {
      const r = JSON.parse(original);
      if (damage === "missing-store") delete r.store_id; else r.attempt = 0;
      r.record_digest = anchor.sha256([r.sequence, r.body_digest, r.store_id, r.attempt].map(String).join("\n"));
      content = JSON.stringify(r) + "\n";
    }
    if (damage === "empty") content = "";
    fs.writeFileSync(f.highWater, content); assert.ok(Buffer.byteLength(content) < 256 * 1024);
    const events = trace(() => assert.throws(() => anchor.appendHighWater(f.dir, entry("commit", 2)),
      { code: "ERR_ANCHOR_CORRUPT" }));
    assert.deepEqual(events, ["dir-sync"]); assert.equal(fs.readFileSync(f.highWater, "utf8"), content); noTemps(f);
  });
}

test("strict capability preflight is read-only, directory-bound and cannot be forged or omitted explicitly", supported, t => {
  const f = fixture(t), other = path.join(f.root, "other"); fs.mkdirSync(other);
  const cap = capabilities.get(f.dir), otherJournal = path.join(other, anchor.JOURNAL_FILE);
  for (const invalid of [{}, null, undefined]) {
    assert.throws(() => anchorModule.appendEntry(f.journal, entry(), invalid), { code: "ERR_INVALID_INPUT" });
    assert.throws(() => anchorModule.appendHighWater(f.dir, entry(), invalid), { code: "ERR_INVALID_INPUT" });
  }
  assert.throws(() => anchorModule.appendEntry(otherJournal, entry(), cap), { code: "ERR_INVALID_INPUT" });
  assert.deepEqual(fs.readdirSync(f.dir), []); assert.deepEqual(fs.readdirSync(other), []);
  let writes = 0;
  fault({ writeSync: () => () => { writes++; throw Error("must not write"); },
    renameSync: () => () => { writes++; throw Error("must not rename"); } }, () => anchorModule.preflightAuthorityDurability(f.dir));
  assert.equal(writes, 0);
  fs.renameSync(f.dir, path.join(f.root, "retired")); fs.mkdirSync(f.dir);
  assert.throws(() => anchorModule.appendEntry(f.journal, entry(), cap), { code: "ERR_UNSAFE_PATH" });
  assert.throws(() => anchorModule.appendHighWater(f.dir, entry(), cap), { code: "ERR_UNSAFE_PATH" });
});

test("strict capability rejects symlink directories and preflight sync failure creates nothing", supported, t => {
  const f = fixture(t); const alias = path.join(f.root, "alias"); fs.symlinkSync(f.dir, alias);
  assert.throws(() => anchorModule.preflightAuthorityDurability(alias), { code: "ERR_UNSAFE_PATH" });
  const error = ioError();
  fault({ fsyncSync: () => () => { throw error; } }, () => {
    assert.throws(() => anchorModule.preflightAuthorityDurability(f.dir), e => e === error);
  });
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

for (const damage of ["read-error", "changed-record"]) {
  test(`compaction second-read ${damage} is propagated without replacing evidence`, supported, t => {
    const f = fixture(t); seedCompaction(f); const before = fs.readFileSync(f.highWater), error = ioError(); let reads = 0;
    fault({ readFileSync: original => (file, ...args) => {
      const content = original(file, ...args);
      // One below-threshold/full precheck precedes compaction's two reads.
      if (String(file) === f.highWater && ++reads === 3) {
        if (damage === "read-error") throw error;
        return content.replace(A, "b".repeat(64)); // Invalid digest on the independent second read.
      }
      return content;
    } }, () => assert.throws(() => anchor.appendHighWater(f.dir, entry("commit", 1601)),
      e => damage === "read-error" ? e === error : e.code === "ERR_ANCHOR_CORRUPT"));
    assert.equal(reads, 3); assert.deepEqual(fs.readFileSync(f.highWater), before); noTemps(f);
  });
}

test("Windows gate refuses before any filesystem mutation; this is not native flush evidence", t => {
  const f = fixture(t); const source = fs.readFileSync(modulePath, "utf8");
  const sandbox = { module: { exports: {} }, require: createRequire(modulePath), Buffer,
    process: { platform: "win32", pid: process.pid } };
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  let calls = 0;
  fault({ openSync: () => () => { calls++; throw Error("must not open"); },
    renameSync: () => () => { calls++; throw Error("must not rename"); } }, () => {
    for (const invoke of [() => sandbox.module.exports.preflightAuthorityDurability(f.dir)]) {
      assert.throws(invoke, e => e.code === "ERR_ANCHOR_WRITE_INCOMPLETE" && e.details.reason === "unsupported-platform");
    }
  });
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(f.dir), []);
  // Legacy remains the historical two-argument contract even on Windows.
  let directories = 0;
  fault({ fsyncSync: original => fd => { if (fs.fstatSync(fd).isDirectory()) directories++; return original(fd); } }, () => {
    sandbox.module.exports.appendEntry(f.journal, entry());
    sandbox.module.exports.appendHighWater(f.dir, entry());
  });
  assert.equal(directories, 0); assert.equal(sandbox.module.exports.readHighWater(f.dir).mark, 1);
});

for (const failure of ["entry-rename", "entry-parent-sync", "high-water-file-sync", "high-water-parent-sync"]) {
  test(`test-wired strict anchor: real SQLite post-COMMIT ${failure} latches unknown`,
    { skip: supported.skip || Number(process.versions.node.split(".")[0]) < 24 }, t => {
      const f = fixture(t); const dbDir = path.join(f.root, "db"); fs.mkdirSync(dbDir);
      const file = path.join(dbDir, "synthetic.sqlite");
      const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
      const { DatabaseSync } = require("node:sqlite");
      // Until the store owner integrates its private capability, inject only
      // this trusted fixture binding; do not claim production wiring is ready.
      const append = anchorModule.appendEntry, highWater = anchorModule.appendHighWater;
      t.mock.method(anchorModule, "appendEntry", (p, e) => append(p, e, capabilities.get(f.dir)));
      t.mock.method(anchorModule, "appendHighWater", (p, e) => highWater(p, e, capabilities.get(f.dir)));
      const store = ProtectedPermitStore.initialize(file, { anchorDir: f.dir, anchorMode: "permissive",
        decisionId: "synthetic-anchor-durability", clock: () => 1000 });
      try {
        const lease = { owner: "synthetic-owner", sessionId: "session", hostId: "host", workerId: "worker",
          runId: "run", generation: "generation", desktopKey: "desktop", ownedAppId: "app",
          idempotencyKey: "synthetic-lease", ttlMs: 1000 };
        const error = ioError(); let publishedCommit = false, highWaterFd = null, flushedHighWater = false, triggered = false;
        fault({
          openSync: original => (p, ...args) => {
            const fd = original(p, ...args); if (String(p) === f.highWater) highWaterFd = fd; return fd;
          },
          renameSync: original => (from, to) => {
            if (String(to).includes("-commit-")) {
              if (failure === "entry-rename") { triggered = true; throw error; }
              const result = original(from, to); publishedCommit = true; return result;
            }
            return original(from, to);
          },
          fsyncSync: original => fd => {
            const directory = fs.fstatSync(fd).isDirectory();
            if ((failure === "entry-parent-sync" && directory && publishedCommit) ||
                (failure === "high-water-file-sync" && !directory && fd === highWaterFd) ||
                (failure === "high-water-parent-sync" && directory && flushedHighWater)) {
              triggered = true; throw error;
            }
            const result = original(fd); if (!directory && fd === highWaterFd) flushedHighWater = true;
            return result;
          },
        }, () => assert.throws(() => store.acquire(lease), e => e === error));
        assert.equal(triggered, true);
        assert.throws(() => store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
        assert.throws(() => store.acquire(lease), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
        const reader = new DatabaseSync(file, { readOnly: true });
        try {
          const state = JSON.parse(reader.prepare("SELECT body FROM protected_state WHERE id = 1").get().body);
          assert.equal(state.anchor_sequence, 2); assert.equal(state.lease.owner, "synthetic-owner");
        } finally { reader.close(); }
      } finally { store.close(); }
    });
}
