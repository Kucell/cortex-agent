"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  createPermitUpgradeStrictWriter: createWriter, isPermitUpgradeStrictWriteReceipt: isReceipt,
  PermitUpgradeStrictWriteError, MAX_BYTES,
} = require("../../lib/coordination/permit-upgrade-strict-writer");
const supported = ["darwin", "linux"].includes(process.platform);
const localTest = (name, fn) => test(name, { skip: !supported }, fn);
const runtime = path.resolve(__dirname, "../../.agent/runtime");
const exact = Buffer.from([0, 255, 128, 13, 10, 65, 0]);
const hash = b => createHash("sha256").update(b).digest("hex");
const statId = name => {
  const st = fs.lstatSync(name, { bigint: true });
  return { dev: String(st.dev), ino: String(st.ino) };
};
function fixture(t) {
  fs.mkdirSync(runtime, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(runtime), "strict-writer-"));
  // Each test owns the entire unique private fixture; implementation never rm's.
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = { directory, name: ".cortex-version", bytes: Buffer.from(exact), expected: null,
    candidateVersion: "1.16.0", artifactDigest: "a".repeat(64), upgradeId: "upgrade-a",
    binding: { projectId: "project-a", snapshotDigest: "b".repeat(64), ownerGeneration: 1, publicationGeneration: 2 } };
  return { directory, target: path.join(directory, input.name), input };
}

// TEST MODEL ONLY. A private test directory plus cooperative synchronous code
// lets us exercise real syscalls. This does not qualify a controller/platform,
// close a hostile path race, enforce cross-process CAS or prove disk durability.
function model(f, hooks = {}) {
  const state = { acquires: 0, publishes: 0, releases: 0, held: true, context: null };
  const platform = { acquire(context) {
    state.acquires++; state.context = context;
    if (hooks.acquire) hooks.acquire(context);
    return {
      assertHeld() { if (hooks.assertHeld) return hooks.assertHeld(state); return state.held; },
      publish(names) {
        state.publishes++;
        if (hooks.publish) return hooks.publish(names, state);
        assert.ok(Object.isFrozen(names));
        assert.deepEqual(statId(names.temporaryPath), names.temporaryIdentity);
        if (names.expectedIdentity === null) assert.equal(fs.existsSync(names.targetPath), false);
        else assert.deepEqual(statId(names.targetPath), { ...names.expectedIdentity });
        fs.renameSync(names.temporaryPath, names.targetPath);
      },
      release() { state.releases++; state.held = false; if (hooks.release) return hooks.release(); },
    };
  } };
  return { writer: createWriter(platform), state };
}
function patched(methods, action) {
  const original = {};
  for (const [key, wrap] of Object.entries(methods)) { original[key] = fs[key]; fs[key] = wrap(original[key]); }
  try { return action(); } finally { for (const [key, value] of Object.entries(original)) fs[key] = value; }
}
function failure(action, state = "not-published", stage, cause) {
  let caught;
  assert.throws(action, error => {
    caught = error;
    assert.ok(error instanceof PermitUpgradeStrictWriteError);
    assert.equal(error.state, state);
    assert.equal(error.executionAuthorized, false);
    if (stage) assert.equal(error.stage, stage);
    if (cause) assert.equal(error.cause, cause);
    assert.equal(isReceipt(error), false);
    return true;
  });
  return caught;
}
function oldTarget(f) {
  fs.writeFileSync(f.target, Buffer.from("old\r\n"), { mode: 0o600 });
  f.input.expected = { identity: statId(f.target), bytes: fs.readFileSync(f.target) };
}
function untouched(f) {
  if (f.input.expected) {
    assert.deepEqual(fs.readFileSync(f.target), f.input.expected.bytes);
    assert.deepEqual(statId(f.target), f.input.expected.identity);
  } else assert.equal(fs.existsSync(f.target), false);
}

localTest("default writer refuses missing platform qualification before any file creation", t => {
  const f = fixture(t);
  const error = failure(() => createWriter().write(f.input), "not-published", "platform");
  assert.equal(error.cause.code, "PATH_BINDING_UNPROVEN");
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

localTest("exact binary bytes, syscall ordering, independent fresh-process reopen and unforgeable local receipt", t => {
  const f = fixture(t), m = model(f), events = [];
  const receipt = patched({
    writeSync: original => (...args) => { events.push("write"); return original(...args); },
    fsyncSync: original => fd => { events.push(fs.fstatSync(fd).isDirectory() ? "dir-sync" : "file-sync"); return original(fd); },
    renameSync: original => (...args) => { events.push("rename"); return original(...args); },
  }, () => m.writer.write(f.input));
  assert.deepEqual(events, ["write", "file-sync", "rename", "dir-sync"]);
  assert.equal(receipt.state, "published"); assert.equal(receipt.targetDigest, hash(exact));
  assert.equal(receipt.executionAuthorized, false);
  assert.equal(receipt.durability, "file-and-directory-fsync-observed");
  assert.equal(receipt.pathBinding, "trusted-platform-contract-required");
  assert.ok(isReceipt(receipt)); assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.binding)); assert.ok(Object.isFrozen(receipt.fileIdentity));
  for (const forged of [{ ...receipt }, JSON.parse(JSON.stringify(receipt)), new Proxy(receipt, {}), null]) assert.equal(isReceipt(forged), false);
  assert.deepEqual(statId(f.target), receipt.fileIdentity);
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
  assert.equal(m.state.releases, 1); assert.equal(m.state.publishes, 1);
  assert.deepEqual(fs.readdirSync(f.directory), [f.input.name]);
  const child = spawnSync(process.execPath, ["-e", "const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1]).toString('hex'))", f.target], { encoding: "utf8" });
  assert.equal(child.status, 0); assert.equal(child.stdout, exact.toString("hex"));
});

localTest("replacement requires exact old bytes and inode; unrelated history cannot be overwritten", t => {
  const f = fixture(t); oldTarget(f);
  const prior = f.input.expected.identity, m = model(f), receipt = m.writer.write(f.input);
  assert.deepEqual(fs.readFileSync(f.target), exact); assert.notDeepEqual(statId(f.target), prior);
  assert.equal(receipt.expectedDigest, hash(f.input.expected.bytes));
  // A historical create with the same name must fail, even for identical bytes.
  const history = { ...f.input, expected: null };
  failure(() => model(f).writer.write(history), "not-published", "target-precondition");
  assert.deepEqual(statId(f.target), receipt.fileIdentity);
});

localTest("short writes and short reads loop with explicit offsets; zero-length bytes publish", t => {
  const f = fixture(t), m = model(f); let writes = 0, reads = 0;
  patched({
    writeSync: original => (fd, b, offset, length, position) => { writes++; return original(fd, b, offset, Math.min(2, length), position); },
    readSync: original => (fd, b, offset, length, position) => { reads++; return original(fd, b, offset, Math.min(2, length), position); },
  }, () => m.writer.write(f.input));
  assert.ok(writes > 1); assert.ok(reads > 5); assert.deepEqual(fs.readFileSync(f.target), exact);
  f.input.name = "empty"; f.input.bytes = Buffer.alloc(0);
  assert.equal(model(f).writer.write(f.input).byteLength, 0); assert.equal(fs.statSync(path.join(f.directory, "empty")).size, 0);
});

localTest("all request record boundaries reject accessors, prototypes, symbols, proxies and revoked proxies without traps", t => {
  const f = fixture(t); let calls = 0;
  const trap = () => { calls++; throw Error("must never execute"); };
  const proxy = value => new Proxy(value, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const accessor = { ...f.input }; Object.defineProperty(accessor, "name", { get: trap, enumerable: true });
  const b = { ...f.input.binding }; Object.defineProperty(b, "ownerGeneration", { get: trap, enumerable: true });
  const inputs = [proxy(f.input), revoked.proxy, accessor, { ...f.input, binding: proxy(f.input.binding) },
    { ...f.input, binding: b }, { ...f.input, expected: proxy({}) }, { ...f.input, bytes: proxy(exact) },
    { ...f.input, expected: { identity: proxy({}), bytes: exact } },
    Object.assign(Object.create({}), f.input), { ...f.input, extra: true }, { ...f.input, [Symbol()]: 1 }];
  for (const input of inputs) failure(() => model(f).writer.write(input), "not-published", "input");
  assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(f.directory), []);
});

localTest("only bounded ordinary Buffer carriers accepted; shared/detached/subclass inputs rejected", t => {
  const f = fixture(t);
  class Derived extends Buffer {} // Construct via prototype below; do not invoke deprecated ctor.
  const derived = Buffer.from(exact); Object.setPrototypeOf(derived, Derived.prototype);
  const detachedBacking = new ArrayBuffer(4), detached = Buffer.from(detachedBacking);
  structuredClone(detachedBacking, { transfer: [detachedBacking] });
  for (const bytes of ["text", new Uint8Array(exact), derived, detached,
    Buffer.from(new SharedArrayBuffer(4)), Buffer.alloc(MAX_BYTES + 1)]) {
    failure(() => model(f).writer.write({ ...f.input, bytes }), "not-published", "input");
  }
  if (typeof ArrayBuffer.prototype.resize === "function") {
    failure(() => model(f).writer.write({ ...f.input, bytes: Buffer.from(new ArrayBuffer(4, { maxByteLength: 8 })) }), "not-published", "input");
  }
  let calls = 0;
  const shadow = Buffer.from(exact);
  for (const key of ["buffer", "byteOffset", "length", "constructor"]) Object.defineProperty(shadow, key, { get() { calls++; throw Error("shadow"); } });
  const m = model(f, { acquire() { f.input.bytes.fill(0); } });
  m.writer.write({ ...f.input, bytes: shadow });
  assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.target), exact);
});

localTest("snapshots candidate, binding, old and new bytes before trusted adapter callbacks", t => {
  const f = fixture(t); oldTarget(f);
  const m = model(f, { acquire() {
    f.input.bytes.fill(9); f.input.expected.bytes.fill(9); f.input.binding.projectId = "changed";
    f.input.candidateVersion = "9.9.9";
  } });
  const receipt = m.writer.write(f.input);
  assert.equal(receipt.candidateVersion, "1.16.0"); assert.equal(receipt.binding.projectId, "project-a");
  assert.deepEqual(fs.readFileSync(f.target), exact);
});

for (const name of ["../escape", "/absolute", "a/b", "a\\b", "a%2fb", "a:stream", "a\0b", ".", "..", "x.", "x ", "CON", "nul.txt", "é", "a\n"]) {
  localTest(`unsafe target spelling refused: ${JSON.stringify(name)}`, t => {
    const f = fixture(t); failure(() => model(f).writer.write({ ...f.input, name }), "not-published", "input");
    assert.deepEqual(fs.readdirSync(f.directory), []);
  });
}
localTest("noncanonical, relative, URL, UNC and ambiguous directory spellings refused before acquire", t => {
  const f = fixture(t), m = model(f);
  for (const directory of ["relative", "file:///x", "//server/x", "/", f.directory + "/", f.directory + "/../other", f.directory + "//x", f.directory + "/bad%20path", f.directory + "/a\\b"]) {
    failure(() => m.writer.write({ ...f.input, directory }), "not-published", "input");
  }
  assert.equal(m.state.acquires, 0);
});
localTest("untrusted metadata and generation assertions cannot select paths or bypass the platform", t => {
  const f = fixture(t), m = model(f);
  for (const change of [{ artifactDigest: "a" }, { upgradeId: "../id" }, { candidateVersion: () => "1" },
    { binding: { ...f.input.binding, ownerGeneration: 0 } }, { binding: { ...f.input.binding, publicationGeneration: 1.5 } },
    { expected: { identity: { dev: "1", ino: "0" }, bytes: exact } },
    { expected: { identity: { dev: 1, ino: "1" }, bytes: exact } }]) {
    failure(() => m.writer.write({ ...f.input, ...change }), "not-published", "input");
  }
  assert.equal(m.state.acquires, 0);
});

localTest("symlink directory and ancestor are rejected without touching their target", t => {
  const f = fixture(t), real = path.join(f.directory, "real"), alias = path.join(f.directory, "alias");
  fs.mkdirSync(real); fs.mkdirSync(path.join(real, "child")); fs.symlinkSync(real, alias);
  for (const directory of [alias, path.join(alias, "child")]) {
    failure(() => model(f).writer.write({ ...f.input, directory }), "not-published", "directory-bind");
  }
  assert.deepEqual(fs.readdirSync(real), ["child"]);
});
for (const kind of ["symlink", "hardlink", "directory", "fifo"]) {
  localTest(`unsafe existing ${kind} target is refused and preserved`, t => {
    const f = fixture(t), victim = path.join(f.directory, "victim"); fs.writeFileSync(victim, "victim");
    if (kind === "symlink") fs.symlinkSync(victim, f.target);
    if (kind === "hardlink") fs.linkSync(victim, f.target);
    if (kind === "directory") fs.mkdirSync(f.target);
    if (kind === "fifo") {
      const mkfifo = spawnSync("mkfifo", [f.target]); assert.equal(mkfifo.status, 0);
    }
    f.input.expected = { identity: statId(f.target), bytes: Buffer.from("victim") };
    const before = statId(f.target);
    failure(() => model(f).writer.write(f.input), "not-published", "target-precondition");
    assert.deepEqual(statId(f.target), before); assert.equal(fs.readFileSync(victim, "utf8"), "victim");
  });
}
localTest("same bytes with wrong inode, and correct inode with wrong bytes, both fail", t => {
  const f = fixture(t); oldTarget(f);
  const other = path.join(f.directory, "other"); fs.writeFileSync(other, f.input.expected.bytes);
  for (const expected of [{ identity: statId(other), bytes: f.input.expected.bytes },
    { identity: f.input.expected.identity, bytes: Buffer.from("bad") }]) {
    failure(() => model(f).writer.write({ ...f.input, expected }), "not-published", "target-precondition");
    untouched(f);
  }
});

localTest("exclusive temporary collision leaves another writer's file untouched, without retry", t => {
  const f = fixture(t), m = model(f); let collision, opens = 0;
  patched({ openSync: original => (name, flags, mode) => {
    if (flags & fs.constants.O_EXCL) {
      opens++; collision = name; fs.writeFileSync(name, "other-writer");
      assert.equal(path.dirname(name), f.directory); assert.ok(flags & fs.constants.O_NOFOLLOW);
    }
    return original(name, flags, mode);
  } }, () => failure(() => m.writer.write(f.input), "not-published", "temporary-open"));
  assert.equal(opens, 1); assert.equal(m.state.publishes, 0);
  assert.equal(fs.readFileSync(collision, "utf8"), "other-writer"); untouched(f);
});

for (const result of [0, -1, NaN, undefined, exact.length + 1]) {
  localTest(`invalid/zero short write ${String(result)} refuses publication`, t => {
    const f = fixture(t); oldTarget(f); const m = model(f);
    const error = patched({ writeSync: () => () => result }, () => failure(() => m.writer.write(f.input), "not-published", "write"));
    assert.equal(error.cause.code, "SHORT_WRITE"); assert.equal(m.state.publishes, 0); untouched(f);
    assert.equal(fs.existsSync(error.temporaryPath), true);
  });
}
for (const stage of ["write", "file-fsync", "file-close", "directory-fsync", "directory-close"]) {
  localTest(`injected ${stage} failure retains original error and correct publication uncertainty`, t => {
    const f = fixture(t); oldTarget(f); const m = model(f), primary = Error(stage);
    const after = stage.startsWith("directory-"); let injected = false;
    const key = stage === "write" ? "writeSync" : stage.endsWith("fsync") ? "fsyncSync" : "closeSync";
    patched({ [key]: original => (fd, ...args) => {
      const dir = fs.fstatSync(fd).isDirectory();
      // Old-target read handles close first; only fail temp close after fsync.
      const isTemp = !dir && fs.fstatSync(fd).size === exact.length;
      if (!injected && (after ? dir : isTemp || stage === "write" || stage === "file-fsync")) {
        injected = true;
        if (key === "closeSync") original(fd); // May have closed despite error.
        throw primary;
      }
      return original(fd, ...args);
    } }, () => failure(() => m.writer.write(f.input), after ? "outcome-unknown" : "not-published", stage, primary));
    assert.ok(injected);
    if (after) assert.deepEqual(fs.readFileSync(f.target), exact); else untouched(f);
  });
}

localTest("primary and multiple cleanup errors survive; close ownership is consumed exactly once", t => {
  const f = fixture(t), m = model(f), primary = Error("write"), cleanup = Error("close"), release = Error("release");
  const closes = new Map();
  const n = model(f, { release() { throw release; } });
  const error = patched({ writeSync: () => () => { throw primary; }, closeSync: original => fd => {
    closes.set(fd, (closes.get(fd) || 0) + 1); original(fd); throw cleanup;
  } }, () => failure(() => n.writer.write(f.input), "not-published", "write", primary));
  assert.deepEqual(error.cleanupErrors, [cleanup, cleanup, release]); assert.equal(error.cleanupError, cleanup);
  assert.deepEqual([...closes.values()], [1, 1]); assert.equal(n.state.releases, 1); assert.equal(m.state.publishes, 0);
  untouched(f);
});
localTest("close error after fd reuse never closes the replacement descriptor", t => {
  const f = fixture(t), m = model(f), primary = Error("close after reuse"); let reused;
  try {
    patched({ closeSync: original => fd => {
      if (reused === undefined && !fs.fstatSync(fd).isDirectory()) {
        original(fd); reused = fs.openSync(path.join(f.directory, "other"), "w+");
        assert.equal(reused, fd); throw primary;
      }
      return original(fd);
    } }, () => failure(() => m.writer.write(f.input), "not-published", "file-close", primary));
    assert.equal(fs.writeSync(reused, Buffer.from("still-open")), 10); untouched(f);
  } finally { if (reused !== undefined) fs.closeSync(reused); }
});

for (const renamed of [false, true]) {
  localTest(`publish throw (${renamed ? "after" : "before"} rename) is always unknown, never retries or rolls back`, t => {
    const f = fixture(t); oldTarget(f); const primary = Error("lost rename reply");
    const m = model(f, { publish(names) { if (renamed) fs.renameSync(names.temporaryPath, names.targetPath); throw primary; } });
    const error = failure(() => m.writer.write(f.input), "outcome-unknown", "rename", primary);
    assert.equal(m.state.publishes, 1);
    if (renamed) { assert.deepEqual(fs.readFileSync(f.target), exact); assert.equal(fs.existsSync(error.temporaryPath), false); }
    else { untouched(f); assert.equal(fs.existsSync(error.temporaryPath), true); }
  });
}
localTest("target appearing at atomic platform CAS is not overwritten; uncertainty is retained", t => {
  const f = fixture(t), m = model(f, { publish(names) {
    fs.writeFileSync(names.targetPath, "competitor", { flag: "wx" });
    throw Object.assign(Error("CAS refused"), { code: "EEXIST" });
  } });
  failure(() => m.writer.write(f.input), "outcome-unknown", "rename");
  assert.equal(fs.readFileSync(f.target, "utf8"), "competitor");
});

localTest("zero read, corruption, hardlink and temp replacement before rename are refused without deleting names", t => {
  const f = fixture(t); oldTarget(f);
  for (const mutation of ["zero-read", "corrupt", "hardlink", "replacement"]) {
    let temp, intruder;
    const error = patched({
      openSync: original => (name, flags, mode) => { const fd = original(name, flags, mode); if (flags & fs.constants.O_EXCL) temp = name; return fd; },
      fsyncSync: original => fd => {
        const result = original(fd);
        if (!fs.fstatSync(fd).isDirectory() && temp) {
          if (mutation === "corrupt") fs.writeSync(fd, Buffer.from("!"), 0, 1, 0);
          if (mutation === "hardlink") { intruder = temp + ".link"; fs.linkSync(temp, intruder); }
          if (mutation === "replacement") { fs.renameSync(temp, temp + ".owned"); fs.writeFileSync(temp, "intruder"); intruder = temp; }
        }
        return result;
      },
      readSync: original => (...args) => mutation === "zero-read" ? 0 : original(...args),
    }, () => failure(() => model(f).writer.write(f.input), "not-published"));
    assert.ok(error); untouched(f);
    if (temp) assert.equal(fs.existsSync(temp), true);
    if (intruder) assert.equal(fs.existsSync(intruder), true);
  }
});

localTest("changes after close and before rename invalidate directory and target preconditions", t => {
  const f = fixture(t); oldTarget(f); let changed = false;
  patched({ closeSync: original => fd => {
    const temp = !fs.fstatSync(fd).isDirectory() && fs.fstatSync(fd).size === exact.length;
    original(fd);
    if (temp && !changed) { changed = true; fs.writeFileSync(f.target, "new-owner"); }
  } }, () => failure(() => model(f).writer.write(f.input), "not-published", "prepublication-verify"));
  assert.equal(fs.readFileSync(f.target, "utf8"), "new-owner");
});
localTest("directory rename/substitution is detected before publication; neither tree is cleaned", t => {
  const f = fixture(t), dir = path.join(f.directory, "bound"), saved = path.join(f.directory, "saved");
  fs.mkdirSync(dir); f.input.directory = dir; let changed = false;
  patched({ closeSync: original => fd => {
    const temp = !fs.fstatSync(fd).isDirectory(); original(fd);
    if (temp && !changed) { changed = true; fs.renameSync(dir, saved); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "other"), "other"); }
  } }, () => failure(() => model(f).writer.write(f.input), "not-published", "prepublication-verify"));
  assert.equal(fs.readdirSync(saved).length, 1); assert.deepEqual(fs.readdirSync(dir), ["other"]);
});
for (const mutation of ["corrupt", "replace", "hardlink"]) {
  localTest(`post-rename ${mutation} verification failure is unknown and preserves target`, t => {
    const f = fixture(t);
    const m = model(f, { publish(names) {
      fs.renameSync(names.temporaryPath, names.targetPath);
      if (mutation === "corrupt") fs.writeFileSync(names.targetPath, Buffer.alloc(exact.length, 8));
      if (mutation === "replace") { fs.renameSync(names.targetPath, names.targetPath + ".original"); fs.writeFileSync(names.targetPath, exact); }
      if (mutation === "hardlink") fs.linkSync(names.targetPath, names.targetPath + ".link");
    } });
    failure(() => m.writer.write(f.input), "outcome-unknown", "published-verify");
    assert.equal(fs.existsSync(f.target), true); assert.equal(m.state.publishes, 1);
  });
}
localTest("lease failure before publication refuses; release failure after publication is unknown", t => {
  const f = fixture(t), invalid = model(f, { assertHeld() { return false; } });
  failure(() => invalid.writer.write(f.input), "not-published", "platform");
  assert.equal(invalid.state.publishes, 0); assert.equal(invalid.state.releases, 1);
  const primary = Error("release failed"), m = model(f, { release() { throw primary; } });
  failure(() => m.writer.write(f.input), "outcome-unknown", "release", primary);
  assert.equal(m.state.releases, 1); assert.deepEqual(fs.readFileSync(f.target), exact);
});
localTest("malformed lease releases acquired resources once and retains release failure", t => {
  const f = fixture(t);
  let releases = 0;
  const cleanup = Error("release failed");
  const writer = createWriter({ acquire() { return { release() { releases++; throw cleanup; } }; } });
  const error = failure(() => writer.write(f.input), "not-published", "platform");
  assert.equal(releases, 1);
  assert.equal(error.cleanupError, cleanup);
  assert.equal(fs.existsSync(f.target), false);
});
localTest("same writer rejects trusted callback reentry; attempts use independent random IDs", t => {
  const f = fixture(t); let m;
  m = model(f, { acquire() { failure(() => m.writer.write(f.input), "not-published", "input"); } });
  const a = m.writer.write(f.input);
  const b = model(f).writer.write({ ...f.input, name: "another" });
  assert.match(a.operationId, /^[a-f0-9]{48}$/); assert.notEqual(a.operationId, b.operationId);
});
localTest("history/latest are separate axes: latest failure keeps successful history and stale generation refuses", t => {
  const f = fixture(t), history = { ...f.input, name: "upgrade-a.finalization-pending.json" };
  const receipt = model(f).writer.write(history);
  const latest = { ...f.input, name: "latest.json" }, primary = Error("latest fsync");
  patched({ fsyncSync: original => fd => {
    if (!fs.fstatSync(fd).isDirectory()) throw primary; return original(fd);
  } }, () => failure(() => model(f).writer.write(latest), "not-published", "file-fsync", primary));
  assert.equal(isReceipt(receipt), true); assert.deepEqual(fs.readFileSync(path.join(f.directory, history.name)), exact);
  const stale = model(f, { acquire(context) {
    // Test-model CAS rejection, not real controller authorization.
    if (context.binding.publicationGeneration !== 3) throw Error("stale generation");
  } });
  failure(() => stale.writer.write(latest), "not-published", "platform");
  assert.equal(stale.state.publishes, 0); assert.equal(fs.existsSync(path.join(f.directory, latest.name)), false);
});

for (const renamed of [false, true]) {
  localTest(`real child exits at publish boundary ${renamed ? "after" : "before"} rename; no receipt or rollback`, t => {
    const f = fixture(t); oldTarget(f);
    const modulePath = require.resolve("../../lib/coordination/permit-upgrade-strict-writer");
    const script = `
      const fs = require('node:fs');
      const { createPermitUpgradeStrictWriter } = require(process.argv[1]);
      const r = JSON.parse(process.argv[2]);
      r.bytes = Buffer.from(r.bytes.data); r.expected.bytes = Buffer.from(r.expected.bytes.data);
      const writer = createPermitUpgradeStrictWriter({ acquire() { return {
        assertHeld() { return true; }, release() {},
        publish(names) {
          if (process.argv[3] === 'yes') fs.renameSync(names.temporaryPath, names.targetPath);
          process.exit(73);
        }
      }; } });
      writer.write(r);
      process.stdout.write('unexpected receipt');
    `;
    const child = spawnSync(process.execPath, ["-e", script, modulePath, JSON.stringify(f.input), renamed ? "yes" : "no"], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.error, undefined); assert.equal(child.status, 73); assert.equal(child.stdout, "");
    if (renamed) {
      assert.deepEqual(fs.readFileSync(f.target), exact);
      assert.deepEqual(fs.readdirSync(f.directory), [f.input.name]);
    } else {
      untouched(f);
      const names = fs.readdirSync(f.directory).filter(n => n !== f.input.name);
      assert.equal(names.length, 1); assert.deepEqual(fs.readFileSync(path.join(f.directory, names[0])), exact);
    }
    // Restart has no controller eligibility/old-owner fence. File observations
    // alone must not re-enable the default writer, even if old stamp survived.
    failure(() => createWriter().write(f.input), "not-published", "platform");
  });
}

localTest("lease lost at prepublication verification prevents publish; non-sync platform replies cannot succeed", t => {
  const f = fixture(t); let checks = 0;
  const m = model(f, { assertHeld() { return ++checks < 3; } });
  failure(() => m.writer.write(f.input), "not-published", "prepublication-verify");
  assert.equal(m.state.publishes, 0); untouched(f);
  let touched = 0;
  const n = model(f, { publish(names) {
    fs.renameSync(names.temporaryPath, names.targetPath);
    return Object.defineProperty({}, "then", { get() { touched++; throw Error("must not observe then"); } });
  } });
  const error = failure(() => n.writer.write(f.input), "outcome-unknown", "rename");
  assert.equal(error.cause.code, "INVALID_PLATFORM_RESULT"); assert.equal(touched, 0);
  assert.deepEqual(fs.readFileSync(f.target), exact);
});

localTest("non-synchronous release cannot produce a completion receipt or be retried", t => {
  const f = fixture(t); let touched = 0;
  const m = model(f, { release() {
    return Object.defineProperty({}, "then", { get() { touched++; throw Error("unobserved then"); } });
  } });
  const error = failure(() => m.writer.write(f.input), "outcome-unknown", "release");
  assert.equal(error.cause.code, "INVALID_PLATFORM_RESULT"); assert.equal(touched, 0);
  assert.equal(m.state.releases, 1); assert.deepEqual(fs.readFileSync(f.target), exact);
});
