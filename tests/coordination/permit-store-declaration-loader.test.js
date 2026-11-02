"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { LIMITS, parsePermitStoreDeclaration } = require("../../lib/coordination/permit-store-declaration");
const { loadPermitStoreDeclaration: load, PermitStoreDeclarationLoadError } = require("../../lib/coordination/permit-store-declaration-loader");
const supported = ["darwin", "linux"].includes(process.platform);
const localTest = (name, fn) => test(name, { skip: !supported }, fn);
const runtime = testRuntime();

function declaration() {
  return { format_version: 1, project_id: "project-a", revision: 7, stores: [{
    binding_id: "primary", backend: "protected-permit-store", mode: "ordinary",
    database_ref: { kind: "project-logical", uri: "runtime://coordination/permit/primary/state.sqlite" },
    anchor_binding_id: "anchor-a", deployment_binding_id: "service-a", expected_decision_id: "D-old",
    expected_store_id: "persisted-old", migration_policy: "automatic-when-proven",
  }] };
}
function fixture(t, { detached = false, missing = null } = {}) {
  fs.mkdirSync(runtime, { recursive: true });
  const base = fs.mkdtempSync(path.join(runtime, "permit-declaration-loader-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "worktree-a"); fs.mkdirSync(project);
  const agent = detached ? path.join(base, "detached-agent") : path.join(project, ".agent");
  const config = path.join(agent, "config"), file = path.join(config, "permit-stores.json");
  if (missing !== "binding") {
    fs.mkdirSync(agent);
    if (detached) fs.symlinkSync(agent, path.join(project, ".agent"));
    if (missing !== "config") {
      fs.mkdirSync(config);
      if (missing !== "file") fs.writeFileSync(file, JSON.stringify(declaration()));
    }
  }
  return { base, project, agent, config, file };
}
function patched(methods, action) {
  const old = {};
  for (const [key, wrapper] of Object.entries(methods)) { old[key] = fs[key]; fs[key] = wrapper(old[key]); }
  try { return action(); } finally { for (const [key, value] of Object.entries(old)) fs[key] = value; }
}
function refused(fn, code) {
  assert.throws(fn, error => {
    if (code) assert.equal(error.code, code);
    assert.match(error.code, /^ERR_PERMIT_DECLARATION_/);
    assert.equal(error.message, error.code);
    assert.equal(error.cause, undefined);
    assert.equal(error.path, undefined);
    assert.equal(error.details, undefined);
    return true;
  });
}

localTest("loads only the explicit declaration as a deeply immutable unproven observation", t => {
  const f = fixture(t), expected = parsePermitStoreDeclaration(fs.readFileSync(f.file), "project-a");
  const result = load(f.project, "project-a", 7);
  assert.equal(result.status, "loaded-unproven");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.path_binding, "path_binding_unproven");
  assert.equal(result.governance_mode, "embedded-local");
  assert.equal(result.agent_root, fs.realpathSync(f.agent));
  assert.equal(result.project_root, fs.realpathSync(f.project));
  assert.equal(result.missing_at, null);
  assert.deepEqual(result.declaration, expected);
  const st = fs.statSync(f.file, { bigint: true });
  assert.equal(result.file_identity.ino, String(st.ino));
  assert.equal(result.file_identity.size, String(st.size));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.file_identity), true);
  assert.equal(Object.isFrozen(result.declaration.snapshot.stores[0]), true);
  assert.throws(() => { result.status = "authorized"; }, TypeError);
});

for (const [missing, at] of [["binding", "governance-binding"], ["config", "config-directory"], ["file", "declaration-file"]]) {
  localTest(`missing ${missing} is absent-unproven, never not-configured or success`, t => {
    const f = fixture(t, { missing });
    // Legacy locations are intentionally ignored; not fallback candidates.
    fs.mkdirSync(path.join(f.project, ".agent-runtime"));
    fs.writeFileSync(path.join(f.project, "permit-stores.json"), JSON.stringify(declaration()));
    const result = load(f.project, "project-a");
    assert.equal(result.status, "absent-unproven"); assert.equal(result.missing_at, at);
    assert.equal(result.declaration, null); assert.equal(result.file_identity, null);
    assert.equal(result.executionAuthorized, false); assert.equal(result.path_binding, "path_binding_unproven");
    if (missing === "binding") assert.equal(fs.existsSync(path.join(f.project, ".agent")), false);
    else if (missing === "config") assert.equal(fs.existsSync(f.config), false);
    else assert.equal(fs.existsSync(f.file), false);
  });
}

localTest("explicit empty stores still yields loaded-unproven, not a negative authority decision", t => {
  const f = fixture(t), value = declaration(); value.stores = []; fs.writeFileSync(f.file, JSON.stringify(value));
  const result = load(f.project, "project-a");
  assert.equal(result.status, "loaded-unproven"); assert.deepEqual(result.declaration.snapshot.stores, []);
  assert.equal(result.executionAuthorized, false);
});

localTest("detached .agent and two worktrees reuse the canonical governance root without cache", t => {
  const f = fixture(t, { detached: true }), b = path.join(f.base, "worktree-b"); fs.mkdirSync(b);
  fs.symlinkSync(f.agent, path.join(b, ".agent"));
  const first = load(f.project, "project-a"), second = load(b, "project-a");
  assert.equal(first.governance_mode, "detached-local"); assert.equal(second.agent_root, first.agent_root);
  assert.notEqual(first.project_root, second.project_root);
  assert.equal(first.declaration.digest, second.declaration.digest);
  refused(() => load(b, "project-b"), "ERR_PERMIT_DECLARATION_PROJECT");
  const changed = declaration(); changed.revision = 8; fs.writeFileSync(f.file, JSON.stringify(changed));
  assert.equal(load(b, "project-a").declaration.snapshot.revision, 8);
  assert.notEqual(first.declaration.digest, load(f.project, "project-a").declaration.digest);
});

localTest("explicit project aliases use existing resolver semantics; .agent checkout is not a project", t => {
  const f = fixture(t), alias = path.join(f.base, "project-alias"); fs.symlinkSync(f.project, alias);
  assert.equal(load(alias, "project-a").project_root, load(f.project, "project-a").project_root);
  refused(() => load(f.agent, "project-a"), "ERR_PERMIT_DECLARATION_READ");
  const aliasToAgent = path.join(f.base, "governance-alias"); fs.symlinkSync(f.agent, aliasToAgent);
  refused(() => load(aliasToAgent, "project-a"), "ERR_PERMIT_DECLARATION_READ");
});

for (const [name, contents, code] of [
  ["bad JSON", '{"private-value":"do-not-echo",', "ERR_PERMIT_DECLARATION_JSON"],
  ["escaped duplicate key", JSON.stringify(declaration()).replace('"revision":7', '"revision":7,"revis\\u0069on":7'), "ERR_PERMIT_DECLARATION_DUPLICATE_KEY"],
  ["invalid UTF8", Buffer.from([0xff, 0xfe]), "ERR_PERMIT_DECLARATION_UTF8"],
  ["deep structure", '['.repeat(12) + '0' + ']'.repeat(12), "ERR_PERMIT_DECLARATION_LIMIT"],
  ["prototype field", '{"__proto__":{"private-value":"do-not-echo"}}', "ERR_PERMIT_DECLARATION_SCHEMA"],
  ["empty file", "", "ERR_PERMIT_DECLARATION_JSON"],
]) {
  localTest(`${name} is rejected without exposing declaration contents`, t => {
    const f = fixture(t); fs.writeFileSync(f.file, contents);
    refused(() => load(f.project, "project-a"), code);
    try { load(f.project, "project-a"); } catch (error) { assert.equal(JSON.stringify(error).includes("do-not-echo"), false); }
  });
}

localTest("project/revision errors stay strict and do not resolve database references", t => {
  const f = fixture(t);
  refused(() => load(f.project, "project-b"), "ERR_PERMIT_DECLARATION_PROJECT");
  refused(() => load(f.project, "project-a", 8), "ERR_PERMIT_DECLARATION_REVISION");
  const value = declaration(); value.stores[0].database_ref = { kind: "machine-binding", binding_id: "missing-machine-binding" };
  fs.writeFileSync(f.file, JSON.stringify(value));
  assert.equal(load(f.project, "project-a").declaration.snapshot.stores[0].database_ref.binding_id, "missing-machine-binding");
});

localTest("size is rejected before allocation/read; exact limit and partial reads work with bounded requests", t => {
  const f = fixture(t), raw = JSON.stringify(declaration());
  fs.writeFileSync(f.file, raw.padEnd(LIMITS.bytes + 1, " "));
  patched({ readSync: () => () => assert.fail("oversize file read") }, () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_LIMIT"));
  fs.writeFileSync(f.file, raw.padEnd(LIMITS.bytes, " "));
  let total = 0, calls = 0;
  patched({ readSync: old => (fd, buffer, offset, length, position) => {
    assert.ok(buffer.length <= LIMITS.bytes + 1); assert.ok(length <= 8192);
    const count = old(fd, buffer, offset, Math.min(length, 113), position); total += count; calls++; return count;
  } }, () => assert.equal(load(f.project, "project-a").status, "loaded-unproven"));
  assert.equal(total, LIMITS.bytes); assert.ok(calls > 2);
});

for (const kind of ["file-symlink", "dangling-file-symlink", "file-hardlink", "directory-at-file", "config-symlink", "file-at-config", "dangling-agent-symlink", "file-at-agent"]) {
  localTest(`unsafe type/link ${kind} is refused`, t => {
    const f = fixture(t), outside = path.join(f.base, "other");
    if (kind === "file-symlink" || kind === "file-hardlink") {
      fs.renameSync(f.file, outside);
      if (kind === "file-symlink") fs.symlinkSync(outside, f.file);
      else fs.linkSync(outside, f.file);
    } else if (kind === "dangling-file-symlink") { fs.unlinkSync(f.file); fs.symlinkSync(outside, f.file); }
    else if (kind === "directory-at-file") { fs.unlinkSync(f.file); fs.mkdirSync(f.file); }
    else if (kind === "config-symlink") { fs.renameSync(f.config, outside); fs.symlinkSync(outside, f.config); }
    else if (kind === "file-at-config") { fs.rmSync(f.config, { recursive: true }); fs.writeFileSync(f.config, "x"); }
    else { fs.rmSync(f.agent, { recursive: true }); if (kind === "file-at-agent") fs.writeFileSync(f.agent, "x"); else fs.symlinkSync(outside, f.agent); }
    refused(() => load(f.project, "project-a"));
  });
}

localTest("FIFO is rejected before open and cannot block the reader", t => {
  const f = fixture(t); fs.unlinkSync(f.file);
  const child = spawnSync("mkfifo", [f.file], { encoding: "utf8", timeout: 3000 });
  assert.equal(child.status, 0, child.stderr);
  patched({ openSync: old => (name, ...args) => {
    assert.notEqual(name, f.file, "must inspect type before opening FIFO"); return old(name, ...args);
  } }, () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_UNSAFE_FILE"));
});

for (const kind of ["file-replaced-at-open", "file-replaced-after-read", "file-mutated-after-read", "file-grows", "file-truncates", "config-replaced", "agent-binding-replaced", "hardlink-added", "file-unlinked"]) {
  localTest(`observed change ${kind} fails closed with all descriptors closed once`, t => {
    const f = fixture(t, { detached: kind === "agent-binding-replaced" }), opened = new Set(), closed = new Set();
    let targetFd, changed = false;
    const replacement = path.join(f.base, "replacement"); fs.writeFileSync(replacement, JSON.stringify(declaration()));
    patched({
      openSync: old => (name, ...args) => {
        if (kind === "file-replaced-at-open" && name === f.file) { fs.renameSync(replacement, f.file); changed = true; }
        const fd = old(name, ...args); opened.add(fd); if (name === f.file) targetFd = fd; return fd;
      },
      readSync: old => (fd, ...args) => {
        const count = old(fd, ...args);
        if (fd === targetFd && !changed) {
          changed = true;
          if (kind === "file-replaced-after-read") fs.renameSync(replacement, f.file);
          else if (kind === "file-mutated-after-read") fs.writeFileSync(f.file, JSON.stringify(declaration()).replace('"revision":7', '"revision":8'));
          else if (kind === "file-grows") fs.appendFileSync(f.file, " ");
          else if (kind === "file-truncates") fs.truncateSync(f.file, 0);
          else if (kind === "config-replaced") { fs.renameSync(f.config, path.join(f.base, "old-config")); fs.mkdirSync(f.config); fs.copyFileSync(replacement, f.file); }
          else if (kind === "agent-binding-replaced") { const other = path.join(f.base, "other-agent"); fs.mkdirSync(other); fs.unlinkSync(path.join(f.project, ".agent")); fs.symlinkSync(other, path.join(f.project, ".agent")); }
          else if (kind === "hardlink-added") fs.linkSync(f.file, path.join(f.base, "hardlink"));
          else if (kind === "file-unlinked") fs.unlinkSync(f.file);
        }
        return count;
      },
      closeSync: old => fd => { assert.equal(closed.has(fd), false); closed.add(fd); return old(fd); },
    }, () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_SOURCE_CHANGED"));
    assert.equal(changed, true); assert.deepEqual(closed, opened);
  });
}

localTest("EOF probe rejects growth even when original stat checks could appear unchanged", t => {
  const f = fixture(t); let probes = 0;
  patched({ readSync: old => (fd, buffer, offset, length, position) => {
    if (length === 1) { probes++; buffer[offset] = 32; return 1; } // Fixed syscall-result fault, no exported callback.
    return old(fd, buffer, offset, length, position);
  } }, () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_SOURCE_CHANGED"));
  assert.equal(probes, 1);
});

for (const stage of ["open", "post-read"]) {
  localTest(`descriptor/path identity mismatch at ${stage} is rejected`, t => {
    const f = fixture(t); let fd, reads = 0, hit = 0;
    patched({
      openSync: old => (name, ...args) => { const opened = old(name, ...args); if (name === f.file) fd = opened; return opened; },
      readSync: old => (...args) => { reads++; return old(...args); },
      fstatSync: old => (number, ...args) => {
        const value = old(number, ...args);
        if (number === fd && (stage === "open" || reads > 0)) { value.ino += 1n; hit++; }
        return value;
      },
    }, () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_SOURCE_CHANGED"));
    assert.equal(hit, 1); assert.equal(reads > 0, stage === "post-read");
  });
}

localTest("unavailable inode identity is rejected rather than claimed bound", t => {
  const f = fixture(t); let hit = 0;
  patched({ lstatSync: old => (name, ...args) => { const value = old(name, ...args); if (name === f.file) { value.ino = 0n; hit++; } return value; } },
    () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_IDENTITY_UNPROVEN"));
  assert.ok(hit > 0);
});

localTest("file and directory close failures retain both errors and never retry either fd", t => {
  const f = fixture(t), counts = new Map(), failures = [];
  patched({ closeSync: old => fd => {
    counts.set(fd, (counts.get(fd) || 0) + 1); old(fd);
    if (failures.length < 2) { failures.push(fd); throw Error("released then failed"); }
  } }, () => {
    assert.throws(() => load(f.project, "project-a"), error => {
      assert.equal(error.code, "ERR_PERMIT_DECLARATION_CLOSE");
      assert.equal(error.cleanupError.code, "ERR_PERMIT_DECLARATION_CLOSE");
      return true;
    });
  });
  assert.equal(failures.length, 2); for (const count of counts.values()) assert.equal(count, 1);
});

localTest("a file appearing during an absent observation is rejected", t => {
  const f = fixture(t, { missing: "file" }); let checks = 0;
  patched({ lstatSync: old => (name, ...args) => {
    if (name === f.file && ++checks === 2) fs.writeFileSync(f.file, JSON.stringify(declaration()));
    return old(name, ...args);
  } }, () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_SOURCE_CHANGED"));
  assert.equal(checks, 2);
});

localTest("read/open denial is never treated as absence and native error data is not exposed", t => {
  const f = fixture(t);
  for (const method of ["lstatSync", "openSync", "readSync", "fstatSync"]) {
    patched({ [method]: () => () => { const e = new Error("private-do-not-echo"); e.code = "EACCES"; e.path = f.file; throw e; } },
      () => refused(() => load(f.project, "project-a"), "ERR_PERMIT_DECLARATION_READ"));
  }
});

for (const when of ["before-close", "after-close"]) {
  localTest(`${when} failure: close is attempted once, primary and cleanup errors retained`, t => {
    const f = fixture(t), counts = new Map(), realClose = fs.closeSync, leaked = [];
    for (const badJson of [false, true]) {
      if (badJson) fs.writeFileSync(f.file, "{");
      let first = true, observed;
      try {
        patched({ closeSync: old => fd => {
          counts.set(fd, (counts.get(fd) || 0) + 1);
          if (first) {
            first = false;
            if (when === "after-close") old(fd); else leaked.push(fd);
            throw new Error("private-close-path");
          }
          return old(fd);
        } }, () => {
          try { load(f.project, "project-a"); assert.fail("must not report success"); }
          catch (error) { observed = error; }
        });
        assert.equal(observed.code, badJson ? "ERR_PERMIT_DECLARATION_JSON" : "ERR_PERMIT_DECLARATION_CLOSE");
        assert.equal(observed.message, observed.code);
        if (badJson) assert.equal(observed.cleanupError.code, "ERR_PERMIT_DECLARATION_CLOSE");
        for (const count of counts.values()) assert.equal(count, 1);
      } finally {
        // Test alone cleans the intentionally leaked descriptor. The loader
        // cannot know whether close-before-throw actually released a resource.
        for (const fd of leaked.splice(0)) realClose(fd);
        counts.clear();
      }
    }
  });
}

localTest("loader makes no write, directory scan, DB, key, binding or business-store access", t => {
  const f = fixture(t), allowed = new Set([fs.realpathSync(f.project), fs.realpathSync(f.agent), f.config, f.file]);
  const methods = {};
  for (const name of ["writeFileSync", "appendFileSync", "writeSync", "mkdirSync", "renameSync", "unlinkSync", "chmodSync", "fsyncSync", "readdirSync", "readFileSync"])
    methods[name] = () => () => assert.fail("forbidden filesystem operation: " + name);
  const flags = [];
  methods.openSync = old => (name, value, ...args) => {
    assert.equal(allowed.has(name), true, "unexpected open"); flags.push(value);
    assert.equal(value & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
    assert.ok(value & fs.constants.O_NOFOLLOW); assert.ok(value & fs.constants.O_NONBLOCK);
    return old(name, value, ...args);
  };
  patched(methods, () => assert.equal(load(f.project, "project-a").status, "loaded-unproven"));
  assert.equal(flags.length, 4);
});

test("primitive input validation never invokes coercion, Proxy traps or getters", () => {
  let calls = 0; const trap = () => { calls++; throw Error("input invoked"); };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  for (const input of [undefined, null, "", "a\0b", "a".repeat(4097), {}, proxy])
    refused(() => load(input, "project-a"), "ERR_PERMIT_DECLARATION_LOAD_INPUT");
  refused(() => load("unused", proxy), "ERR_PERMIT_DECLARATION_LOAD_INPUT");
  refused(() => load("unused", "project-a", proxy), "ERR_PERMIT_DECLARATION_LOAD_INPUT");
  assert.equal(calls, 0);
});

test("unsupported platform/flags refuse before even root resolution, without silent fallback", () => {
  const filename = require.resolve("../../lib/coordination/permit-store-declaration-loader"), source = fs.readFileSync(filename, "utf8");
  const localRequire = createRequire(filename);
  for (const variant of ["win32", "missing-nofollow"]) {
    const module = { exports: {} }; let calls = 0;
    vm.runInNewContext(source, { module, exports: module.exports, Buffer,
      process: { platform: variant === "win32" ? "win32" : "linux" },
      require: name => {
        if (name === "node:fs") return new Proxy({ constants: variant === "missing-nofollow" ? { ...fs.constants, O_NOFOLLOW: undefined } : fs.constants }, {
          get: (target, key) => { if (key === "constants") return target.constants; calls++; throw Error("filesystem accessed"); },
        });
        if (name === "../governance/root") return { resolveGovernanceRoot: () => { calls++; throw Error("resolver accessed"); } };
        return localRequire(name);
      },
    }, { filename });
    refused(() => module.exports.loadPermitStoreDeclaration("unused", "project-a"), "ERR_PERMIT_DECLARATION_READER_UNSUPPORTED");
    assert.equal(calls, 0);
  }
});

test("module import does not access filesystem, HOME, process execution or business dependencies", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const Module = require('node:module'), fs = require('node:fs'), original = Module._load;
    const deniedFs = new Proxy({}, { get: (_, key) => {
      if (key === 'constants') return fs.constants;
      throw Error('IO at import');
    }});
    Module._load = function(name, ...rest) {
      if (/sqlite|protected-permit|protected-anchor|child_process|^node:(?:net|tls|http|https)$/.test(name)) throw Error('forbidden dependency');
      if (name === 'node:fs') return deniedFs;
      return original.call(this, name, ...rest);
    };
    const api = require(process.argv[1]);
    if (Object.keys(api).sort().join(',') !== 'PermitStoreDeclarationLoadError,loadPermitStoreDeclaration') throw Error('unexpected API');
  `, require.resolve("../../lib/coordination/permit-store-declaration-loader")], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});
