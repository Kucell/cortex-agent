"use strict";

// Safety closure: built-in Node modules, runtime-layout-migration and report.
// upgrade/verify are evaluated with an exhaustive require allowlist and inert
// setup, management and subprocess dependencies. All writes stay in new temp
// fixtures; no network, subprocess, actual Host, or existing project is used.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const migration = require("../../lib/commands/update/runtime-layout-migration");
const reports = require("../../lib/commands/update/report");

const SCHEMA = ".agent/runtime/authorization.schema.json";
const CONTRACT = ".agent/contracts/runtime-state/authorization.schema.json";
const SOURCE = ".agent-runtime/coordination/tasks.json";
const TARGET = ".agent/runtime/coordination/tasks.json";
const MARKER = ".agent/runtime/layout.json";
const CANDIDATE = ".agent/runtime/layout.candidate.json";
const oldMarker = JSON.stringify({ layout_version: "1", activated_at: "2026-01-01T00:00:00.000Z",
  plan_id: "fixture-existing", source: "fixture" });

function fixture(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-upgrade-failure-"));
  try { return body(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function put(root, relative, bytes) {
  const target = path.join(root, relative);
  assert.ok(target.startsWith(root + path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
function read(root, relative) { return fs.readFileSync(path.join(root, relative), "utf8"); }
function snapshot(root, prefix = "") {
  const result = {};
  for (const name of fs.readdirSync(path.join(root, prefix)).sort()) {
    const relative = prefix ? prefix + "/" + name : name;
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) Object.assign(result, snapshot(root, relative));
    else if (stat.isSymbolicLink()) result[relative] = "link:" + fs.readlinkSync(file);
    else result[relative] = fs.readFileSync(file).toString("hex");
  }
  return result;
}
function patched(name, replace, body) {
  const original = fs[name];
  fs[name] = replace(original);
  try { return body(); } finally { fs[name] = original; }
}
function exclusive(flags) { return typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0; }
function fault() { return Object.assign(new Error("SYNTHETIC_FAILURE"), { code: "EIO" }); }
function failActivation(root, body, beforeThrow = () => {}) {
  let reached = false;
  const result = patched("linkSync", (original) => function (source, target) {
    if (target === path.join(root, MARKER)) {
      reached = true;
      beforeThrow();
      throw fault();
    }
    return original.apply(this, arguments);
  }, body);
  assert.equal(reached, true, "must reach the real marker publication boundary");
  return result;
}
function schemaFixture(root, targetBytes = '{"originalTarget":true}\n') {
  put(root, SCHEMA, '{"legacySource":true}\n');
  if (targetBytes !== null) put(root, CONTRACT, targetBytes);
  put(root, ".agent/user-rule.md", "fixture user rule\n");
}
function apply(root) {
  const ctx = { cwd: root };
  const plan = migration.buildMigrationPlan(ctx);
  return migration.applyMigration(ctx, plan);
}

describe("migration transaction failure preservation", { concurrency: 1 }, () => {
  it("preserves an old marker and candidate after an earlier portable conflict", () => fixture((root) => {
    schemaFixture(root);
    put(root, SOURCE, "legacy");
    put(root, TARGET, "newer");
    put(root, MARKER, oldMarker);
    put(root, CANDIDATE, "pre-existing candidate");
    const before = snapshot(root);
    const result = apply(root);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, true);
    assert.deepEqual(snapshot(root), before);
  }));

  for (const same of [false, true]) {
    it("restores schema source and preserves " + (same ? "same-digest target" : "conflicting target and old backup"),
      () => fixture((root) => {
        schemaFixture(root, same ? '{"legacySource":true}\n' : '{"originalTarget":true}\n');
        put(root, CONTRACT + ".bak.keep", "pre-existing backup");
        const targetInode = fs.statSync(path.join(root, CONTRACT)).ino;
        const before = snapshot(root);
        const result = failActivation(root, () => apply(root));
        assert.equal(result.ok, false);
        assert.equal(result.rollback.ok, true);
        assert.deepEqual(snapshot(root), before);
        if (same) assert.equal(fs.statSync(path.join(root, CONTRACT)).ino, targetInode);
      }));
  }

  it("compensates failure after backing up and removing the old schema target", () => fixture((root) => {
    schemaFixture(root);
    const before = snapshot(root);
    let reached = false;
    const result = patched("openSync", (original) => function (file, flags) {
      if (!reached && file === path.join(root, CONTRACT) && exclusive(flags)) {
        reached = true;
        throw fault();
      }
      return original.apply(this, arguments);
    }, () => apply(root));
    assert.equal(reached, true);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, true);
    assert.deepEqual(snapshot(root), before);
  }));

  it("compensates a partial schema target write without removing the source", () => fixture((root) => {
    schemaFixture(root);
    const before = snapshot(root);
    let targetFd;
    let writes = 0;
    const result = patched("openSync", (original) => function (file, flags) {
      const fd = original.apply(this, arguments);
      if (file === path.join(root, CONTRACT) && exclusive(flags) && targetFd === undefined) targetFd = fd;
      return fd;
    }, () => patched("writeSync", (original) => function (fd, buffer, offset, length, position) {
      if (fd === targetFd && writes < 2) {
        writes += 1;
        if (writes === 2) throw fault();
        return original.call(this, fd, buffer, offset, 1, position);
      }
      return original.apply(this, arguments);
    }, () => apply(root)));
    assert.equal(writes, 2);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, true);
    assert.deepEqual(snapshot(root), before);
  }));

  it("compensates failure to unlink the schema source", () => fixture((root) => {
    schemaFixture(root);
    const before = snapshot(root);
    let reached = false;
    const result = patched("unlinkSync", (original) => function (file) {
      if (!reached && file === path.join(root, SCHEMA)) { reached = true; throw fault(); }
      return original.apply(this, arguments);
    }, () => apply(root));
    assert.equal(reached, true);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, true);
    assert.deepEqual(snapshot(root), before);
  }));

  it("reports rollback failure while retaining source bytes in the migrated target and original target backup", () => fixture((root) => {
    schemaFixture(root);
    const source = read(root, SCHEMA);
    const target = read(root, CONTRACT);
    let reached = false;
    const result = patched("openSync", (original) => function (file, flags) {
      if (file === path.join(root, SCHEMA) && exclusive(flags)) { reached = true; throw fault(); }
      return original.apply(this, arguments);
    }, () => failActivation(root, () => apply(root)));
    assert.equal(reached, true);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, false);
    assert.ok(result.rollback.rollback_errors.length > 0);
    assert.equal(read(root, CONTRACT), source);
    const backups = fs.readdirSync(path.dirname(path.join(root, CONTRACT))).filter((name) => name.includes(".bak."));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(path.join(root, CONTRACT)), backups[0]), "utf8"), target);
  }));

  it("does not overwrite a marker created at the publication boundary", () => fixture((root) => {
    schemaFixture(root);
    const before = snapshot(root);
    let reached = false;
    const result = patched("linkSync", (original) => function (source, target) {
      if (target === path.join(root, MARKER)) { reached = true; put(root, MARKER, "concurrent marker"); }
      return original.apply(this, arguments);
    }, () => apply(root));
    assert.equal(reached, true);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, true);
    const after = snapshot(root);
    assert.equal(read(root, MARKER), "concurrent marker");
    delete after[MARKER];
    assert.deepEqual(after, before);
  }));

  for (const replace of [false, true]) {
    it("preserves an owned portable target " + (replace ? "replaced with identical bytes" : "modified in place") + " before rollback",
      () => fixture((root) => {
        put(root, SOURCE, "legacy");
        put(root, ".agent/user-rule.md", "rule");
        const result = failActivation(root, () => apply(root), () => {
          if (replace) {
            // Keep the original inode allocated so the replacement cannot reuse it.
            fs.renameSync(path.join(root, TARGET), path.join(root, "held-original"));
            put(root, TARGET, "legacy");
          } else put(root, TARGET, "concurrent modification");
        });
        assert.equal(result.ok, false);
        assert.equal(result.rollback.ok, false);
        assert.ok(result.rollback.rollback_errors.length > 0);
        assert.equal(read(root, TARGET), replace ? "legacy" : "concurrent modification");
        assert.equal(read(root, SOURCE), "legacy");
      }));
  }

  it("rejects rollback without the process-local ownership receipt", () => fixture((root) => {
    schemaFixture(root);
    const ctx = { cwd: root };
    const plan = migration.buildMigrationPlan(ctx);
    const result = migration.applyMigration(ctx, plan);
    assert.equal(result.ok, true);
    const before = snapshot(root);
    const rollback = migration.rollbackMigration(ctx, plan, [...result.actions_applied]);
    assert.equal(rollback.ok, false);
    assert.equal(rollback.error, "rollback_ownership_unknown");
    assert.deepEqual(snapshot(root), before);
  }));

  it("retains the exact existing valid marker while completing schema-only migration", () => fixture((root) => {
    schemaFixture(root);
    put(root, MARKER, oldMarker);
    const ino = fs.statSync(path.join(root, MARKER)).ino;
    const result = apply(root);
    assert.equal(result.ok, true);
    assert.equal(read(root, MARKER), oldMarker);
    assert.equal(fs.statSync(path.join(root, MARKER)).ino, ino);
    assert.equal(fs.existsSync(path.join(root, SCHEMA)), false);
  }));

  it("rejects a target parent symlink without writing through it", () => fixture((root) => {
    put(root, SOURCE, "legacy");
    fs.mkdirSync(path.join(root, ".agent/runtime"), { recursive: true });
    fs.mkdirSync(path.join(root, "isolated-outside-target"));
    fs.symlinkSync(path.join(root, "isolated-outside-target"), path.join(root, ".agent/runtime/coordination"), "dir");
    const before = snapshot(root);
    const result = apply(root);
    assert.equal(result.ok, false);
    assert.deepEqual(snapshot(root), before);
  }));

  it("rejects an externally hard-linked source", () => fixture((root) => {
    put(root, SOURCE, "legacy");
    put(root, ".agent/user-rule.md", "rule");
    fs.linkSync(path.join(root, SOURCE), path.join(root, "other-source-link"));
    const before = snapshot(root);
    assert.throws(() => migration.buildMigrationPlan({ cwd: root }),
      (error) => error.code === "unsafe_file");
    assert.deepEqual(snapshot(root), before);
  }));

  it("compensates a candidate unlink failure after successful marker publication", () => fixture((root) => {
    schemaFixture(root);
    const before = snapshot(root);
    let reached = false;
    const result = patched("unlinkSync", (original) => function (file) {
      if (!reached && file === path.join(root, CANDIDATE)) {
        reached = true;
        assert.equal(fs.existsSync(path.join(root, MARKER)), true);
        assert.equal(fs.statSync(file).nlink, 2);
        throw fault();
      }
      return original.apply(this, arguments);
    }, () => apply(root));
    assert.equal(reached, true);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, true);
    assert.deepEqual(snapshot(root), before);
  }));

  it("retains the original target backup if restoring its path fails", () => fixture((root) => {
    schemaFixture(root);
    const source = read(root, SCHEMA);
    const target = read(root, CONTRACT);
    let targetOpens = 0;
    const result = patched("openSync", (original) => function (file, flags) {
      if (file === path.join(root, CONTRACT) && exclusive(flags) && ++targetOpens === 2) throw fault();
      return original.apply(this, arguments);
    }, () => failActivation(root, () => apply(root)));
    assert.equal(targetOpens, 2);
    assert.equal(result.ok, false);
    assert.equal(result.rollback.ok, false);
    assert.equal(read(root, SCHEMA), source);
    assert.equal(fs.existsSync(path.join(root, CONTRACT)), false);
    const directory = path.dirname(path.join(root, CONTRACT));
    const backups = fs.readdirSync(directory).filter((name) => name.includes(".bak."));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, backups[0]), "utf8"), target);
  }));

  it("preserves a replacement target when source changes invalidate an earlier successful copy", () => fixture((root) => {
    put(root, SOURCE, "legacy");
    put(root, ".agent/user-rule.md", "rule");
    let reached = false;
    const result = patched("statSync", (original) => function (file) {
      if (!reached && file === path.join(root, ".agent/runtime")) {
        reached = true;
        put(root, SOURCE, "external source change");
        fs.renameSync(path.join(root, TARGET), path.join(root, "held-original"));
        put(root, TARGET, "legacy");
      }
      return original.apply(this, arguments);
    }, () => apply(root));
    assert.equal(reached, true);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].phase, "validation");
    assert.equal(result.rollback.ok, false);
    assert.equal(read(root, SOURCE), "external source change");
    assert.equal(read(root, TARGET), "legacy");
  }));

});

function isolated(relative, dependencies, root) {
  const filename = path.join(__dirname, "../../", relative);
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const fakeProcess = { exitCode: undefined, execPath: process.execPath, cwd: () => root,
    exit: () => { throw new Error("unexpected process.exit"); } };
  const load = (name) => {
    if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error("unapproved dependency: " + name);
    return dependencies[name];
  };
  const wrapper = vm.runInNewContext(
    "(function(require,module,exports,__dirname,__filename,process,console,Buffer){" + source + "\n})",
    {}, { filename });
  wrapper(load, module, module.exports, path.join(root, "virtual/lib/commands"), filename,
    fakeProcess, { log() {}, warn() {}, error() {} }, Buffer);
  return { exports: module.exports, process: fakeProcess };
}

function upgradeHarness(root, overrides) {
  const trace = [];
  const payloads = [];
  const call = (name, result) => () => { trace.push(name); return result; };
  const setup = new Proxy({}, { get: (_, name) => call(String(name)) });
  const inert = new Proxy({}, { get: (_, name) => call(String(name)) });
  const check = (name, status, command, details) => ({ name, status, command, ...details });
  const dependencies = {
    "node:fs": fs, "node:path": path,
    "node:child_process": { spawnSync() { throw new Error("subprocess forbidden"); } },
    "./update/report": reports,
    "./update/verify": {
      collectSemanticMergeCandidates: () => [],
      verificationCheck: check,
      runUpdateVerification: call("runUpdateVerification", { ok: true, verification: [], summary: { failed: 0 } }),
    },
    "./update/runtime-layout-migration": { ...migration, ...overrides },
    "../team-pack/index": inert,
    "./management/api-helpers": { printManagementPayload: (value) => payloads.push(value) },
    "../script/manifest": { reconcileScripts: () => ({ updates: [], applied: [], failed: [], skipped: [] }) },
    "../registry/index": { PLATFORM_REGISTRY: {} },
    "./patches": { applyPatches: call("applyPatches"), writeVersionFile: call("writeVersionFile") },
    "./migrate-legacy-memory": { detectLegacyFiles: call("detectLegacyFiles", { found: 0 }) },
    "../memory-validate": { validateMemory: call("validateMemory", { issues: [] }) },
    "../platform/index": { getInstalledPlatforms: call("getInstalledPlatforms", []) },
    "../git/index": inert,
    "../setup/index": setup,
    "../runtime-adapters/minimax-cli-governed-tool": {},
  };
  return { ...isolated("lib/commands/upgrade.js", dependencies, root), trace, payloads };
}

function upgradeContext(root, dryRun = false) {
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });
  return { cwd: root, lang: "en", command: "update", templateDir: path.join(root, "templates"),
    options: { report: "json", dryRun, team: true } };
}

describe("upgrade fail-closed propagation", { concurrency: 1 }, () => {
  for (const dryRun of [true, false]) {
    it("reports planner errors as failed in " + (dryRun ? "zero-write dry-run" : "apply"), () => fixture((root) => {
      const ctx = upgradeContext(root, dryRun);
      const before = snapshot(root);
      const harness = upgradeHarness(root, { buildMigrationPlan() { throw fault(); } });
      harness.exports.upgrade(ctx);
      assert.equal(harness.process.exitCode, 1);
      assert.equal(harness.payloads.length, 1);
      assert.equal(harness.payloads[0].ok, false);
      assert.equal(harness.payloads[0].status, "failed");
      assert.equal(harness.payloads[0].blocked[0].phase, "planning");
      assert.equal(harness.payloads[0].blocked[0].code, "EIO");
      assert.deepEqual(harness.trace, []);
      if (dryRun) assert.deepEqual(snapshot(root), before);
      else assert.equal(JSON.parse(read(root, ".agent/updates/latest.json")).ok, false);
    }));
  }

  for (const throws of [false, true]) {
    it("stops setup, version, verification and team work after migration " + (throws ? "throws" : "returns failed"), () => fixture((root) => {
      const ctx = upgradeContext(root);
      const harness = upgradeHarness(root, {
        buildMigrationPlan: () => ({ plan_id: "fixture", is_noop: false, has_legacy: true, actions: [] }),
        applyMigration() {
          if (throws) throw fault();
          return { ok: false, errors: [{ phase: "candidate_write", error: "SYNTHETIC_FAILURE", code: "EIO" }],
            rollback: { ok: true, rolled_back: [] }, actions_applied: [] };
        },
      });
      harness.exports.upgrade(ctx);
      assert.equal(harness.process.exitCode, 1);
      assert.equal(harness.payloads[0].ok, false);
      assert.equal(harness.payloads[0].blocked[0].code, "EIO");
      for (const name of ["getInstalledPlatforms", "ensureAgentHooks", "writeVersionFile", "runUpdateVerification",
        "detectLegacyFiles", "validateMemory", "loadPack"]) assert.equal(harness.trace.includes(name), false, name);
      assert.equal(JSON.parse(read(root, ".agent/updates/latest.json")).status, "failed");
    }));
  }

  it("includes runtime-layout failure in ordinary update verification", () => fixture((root) => {
    put(root, MARKER, '{"layout_version":"1"}');
    const dependencies = {
      "node:fs": fs, "node:path": path,
      "node:child_process": { spawnSync() { throw new Error("subprocess forbidden"); } },
      "../../management/client.js": {
        resolveManagementProject: () => ({ ok: true, project: { root, agent_root: path.join(root, ".agent") } }),
        queryManagementProject: () => ({ ok: true }),
      },
      "../../setup": {},
      "../management/api-helpers": {},
      "../../runtime-layout": { detectLegacyRuntime: () => false },
      "./runtime-layout-migration": migration,
      "./report": reports,
    };
    const harness = isolated("lib/commands/update/verify.js", dependencies, root);
    const report = harness.exports.runUpdateVerification({ cwd: root, command: "update", args: [] });
    assert.equal(report.ok, false);
    assert.ok(report.summary.failed > 0);
    assert.ok(report.verification.some((check) => check.name.startsWith("layout marker") && check.status === "failed"));
  }));
});

describe("migration scan failures are not successful plans", { concurrency: 1 }, () => {
  const cases = [
    { name: "legacy root readdir", method: "readdirSync", relative: ".agent-runtime", code: "EACCES", schema: false },
    { name: "nested portable readdir", method: "readdirSync", relative: ".agent-runtime/coordination/nested", code: "EACCES", schema: false },
    { name: "portable lstat", method: "lstatSync", relative: ".agent-runtime/coordination/nested/state.json", code: "EIO", schema: false },
    { name: "portable byte read", method: "readFileSync", relative: ".agent-runtime/coordination/nested/state.json", code: "EIO", schema: false },
    { name: "schema lstat", method: "lstatSync", relative: SCHEMA, code: "EACCES", schema: true },
    { name: "schema byte read", method: "readFileSync", relative: SCHEMA, code: "EIO", schema: true },
  ];
  for (const scenario of cases) {
    it("propagates " + scenario.code + " from " + scenario.name + " without writing", () => fixture((root) => {
      if (scenario.schema) schemaFixture(root);
      else {
        put(root, ".agent-runtime/coordination/nested/state.json", "fixture portable state");
        put(root, ".agent/user-rule.md", "rule");
      }
      const before = snapshot(root);
      const target = path.join(root, scenario.relative);
      let reached = false;
      patched(scenario.method, (original) => function (file) {
        if (file === target || (scenario.method === "readFileSync" && typeof file === "number")) {
          reached = true;
          throw Object.assign(new Error("SYNTHETIC_SCAN_" + scenario.code), { code: scenario.code });
        }
        return original.apply(this, arguments);
      }, () => assert.throws(
        () => migration.buildMigrationPlan({ cwd: root }, { dryRun: true }),
        (error) => error.code === scenario.code,
      ));
      assert.equal(reached, true);
      assert.deepEqual(snapshot(root), before);
      assert.equal(fs.existsSync(path.join(root, MARKER)), false);
    }));
  }

  for (const kind of ["symlink", "directory"]) {
    it("rejects a known schema path that is a " + kind, () => fixture((root) => {
      fs.mkdirSync(path.dirname(path.join(root, SCHEMA)), { recursive: true });
      if (kind === "symlink") {
        put(root, "inside-source.json", "fixture source");
        fs.symlinkSync(path.join(root, "inside-source.json"), path.join(root, SCHEMA));
      } else fs.mkdirSync(path.join(root, SCHEMA));
      const before = snapshot(root);
      assert.throws(() => migration.buildMigrationPlan({ cwd: root }),
        (error) => error.code === (kind === "symlink" ? "symlink_path" : "unsafe_file"));
      assert.deepEqual(snapshot(root), before);
    }));
  }

  it("propagates a real recursive scan error through the zero-write upgrade report", () => fixture((root) => {
    const ctx = upgradeContext(root, true);
    const nested = ".agent-runtime/coordination/nested";
    put(root, nested + "/state.json", "fixture portable state");
    const before = snapshot(root);
    const harness = upgradeHarness(root, {});
    let reached = false;
    patched("readdirSync", (original) => function (directory) {
      if (directory === path.join(root, nested)) {
        reached = true;
        throw Object.assign(new Error("SYNTHETIC_SCAN_EACCES"), { code: "EACCES" });
      }
      return original.apply(this, arguments);
    }, () => harness.exports.upgrade(ctx));
    assert.equal(reached, true);
    assert.equal(harness.process.exitCode, 1);
    assert.equal(harness.payloads.length, 1);
    assert.equal(harness.payloads[0].ok, false);
    assert.equal(harness.payloads[0].blocked[0].phase, "planning");
    assert.equal(harness.payloads[0].blocked[0].code, "EACCES");
    assert.deepEqual(harness.trace, []);
    assert.deepEqual(snapshot(root), before);
  }));
});

describe("ordinary verification scan failure reporting", { concurrency: 1 }, () => {
  for (const scenario of [
    { name: "schema lstat", method: "lstatSync", code: "EACCES" },
    { name: "schema byte read", method: "readFileSync", code: "EIO" },
  ]) {
    it("returns a failed report for " + scenario.code + " from " + scenario.name, () => fixture((root) => {
      schemaFixture(root);
      const before = snapshot(root);
      const dependencies = {
        "node:fs": fs, "node:path": path,
        "node:child_process": { spawnSync() { throw new Error("subprocess forbidden"); } },
        "../../management/client.js": {
          resolveManagementProject: () => ({ ok: true, project: { root, agent_root: path.join(root, ".agent") } }),
          queryManagementProject: () => ({ ok: true }),
        },
        "../../setup": {},
        "../management/api-helpers": {},
        "../../runtime-layout": { detectLegacyRuntime: () => false },
        "./runtime-layout-migration": migration,
        "./report": reports,
      };
      const harness = isolated("lib/commands/update/verify.js", dependencies, root);
      let reached = false;
      const report = patched(scenario.method, (original) => function (file) {
        if (file === path.join(root, SCHEMA) || (scenario.method === "readFileSync" && typeof file === "number")) {
          reached = true;
          throw Object.assign(new Error("SYNTHETIC_VERIFY_" + scenario.code), { code: scenario.code });
        }
        return original.apply(this, arguments);
      }, () => harness.exports.runUpdateVerification({ cwd: root, command: "update", args: [] }));
      assert.equal(reached, true);
      assert.equal(report.ok, false);
      assert.equal(report.summary.failed, 1);
      const check = report.verification.find((item) => item.name === "runtime layout scan");
      assert.equal(check.status, "failed");
      assert.equal(check.exit_code, 1);
      assert.equal(check.code, scenario.code);
      assert.equal(check.message, "SYNTHETIC_VERIFY_" + scenario.code);
      assert.deepEqual(snapshot(root), before);
    }));
  }
});


// Exercise the real additive walker with inert hooks and only temporary files.
describe("upgrade locale selection", { concurrency: 1 }, () => {
  function prepare(root) {
    const ctx = upgradeContext(root, true);
    ctx.lang = "zh";
    ctx.command = "upgrade";
    ctx.options.team = false;
    put(root, "templates/.agent/workflows/conflict.md", "locale\n");
    put(root, "virtual/templates/_shared/.agent/workflows/conflict.md", "shared\n");
    put(root, "virtual/templates/_shared/.agent/workflows/shared-only.md", "shared only\n");
    return ctx;
  }
  function run(root, ctx) {
    const harness = upgradeHarness(root);
    harness.exports.upgrade(ctx);
    assert.notEqual(harness.process.exitCode, 1);
  }
  it("deduplicates shared/locale conflicts without preview writes", () => fixture((root) => {
    const ctx = prepare(root);
    const before = snapshot(root);
    run(root, ctx);
    assert.deepEqual(Array.from(ctx.options.dryRunReport.wouldAdd).sort(),
      ["workflows/conflict.md", "workflows/shared-only.md"]);
    assert.deepEqual(snapshot(root), before);
  }));
  it("applies the preview set once and selects locale content", () => fixture((root) => {
    const ctx = prepare(root);
    run(root, ctx);
    const planned = Array.from(ctx.options.dryRunReport.wouldAdd).sort();
    ctx.options.dryRun = false;
    run(root, ctx);
    assert.deepEqual(fs.readdirSync(path.join(root, ".agent/workflows")).map(x => "workflows/" + x).sort(), planned);
    assert.equal(read(root, ".agent/workflows/conflict.md"), "locale\n");
    assert.equal(read(root, ".agent/workflows/shared-only.md"), "shared only\n");
  }));
  it("has an empty additive plan after apply", () => fixture((root) => {
    const ctx = prepare(root);
    ctx.options.dryRun = false;
    run(root, ctx);
    const before = snapshot(root);
    ctx.options.dryRun = true;
    run(root, ctx);
    assert.deepEqual(Array.from(ctx.options.dryRunReport.wouldAdd), []);
    assert.deepEqual(snapshot(root), before);
  }));
  it("preserves local customizations against both template layers", () => fixture((root) => {
    const ctx = prepare(root);
    put(root, ".agent/workflows/conflict.md", "local customization\n");
    run(root, ctx);
    assert.equal(ctx.options.dryRunReport.wouldAdd.includes("workflows/conflict.md"), false);
    ctx.options.dryRun = false;
    run(root, ctx);
    assert.equal(read(root, ".agent/workflows/conflict.md"), "local customization\n");
  }));
});
