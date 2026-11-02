"use strict";

const { testRuntime } = require("../helpers/runtime-sandbox");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { writeVersionFile, readVersionFile } = require("../../lib/commands/patches");
const { version } = require("../../package.json");
const repo = path.resolve(__dirname, "../..");
const runtime = testRuntime();

function fixture(t) {
  fs.mkdirSync(runtime, { recursive: true });
  const root = fs.mkdtempSync(path.join(runtime, "upgrade-version-stamp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".agent"));
  fs.writeFileSync(path.join(root, ".agent", ".cortex-version"), "1.15.7\n");
  fs.writeFileSync(path.join(root, ".agent", "user-rule.md"), "preserve user content\n");
  fs.mkdirSync(path.join(root, "templates", "en", ".agent"), { recursive: true });
  fs.writeFileSync(path.join(root, "templates", "en", ".agent", "added.md"), "new template\n");
  return root;
}
function stamp(root) { return path.join(root, ".agent", ".cortex-version"); }
function patched(methods, action) {
  const originals = {};
  for (const [key, wrap] of Object.entries(methods)) { originals[key] = fs[key]; fs[key] = wrap(originals[key]); }
  try { return action(); } finally { for (const [key, value] of Object.entries(originals)) fs[key] = value; }
}
function fault(code = "EIO") { return Object.assign(new Error("fixture-private-error"), { code }); }

// Child executes the real stamp helper, upgrade control flow and report IO.
// Unrelated setup/provider/management is explicitly inert. The VM relocates
// __dirname to the fixture so the repository shared templates are not copied.
// No controller/gate/DB integration or global user config is exercised.
function runChild(root, scenario, reportMode, command) {
  const logs = [], errors = [], trace = [], hit = [], closed = new Map(), fds = new Set();
  const reports = require("../../lib/commands/update/report");
  const realClose = fs.closeSync;
  const filename = path.join(repo, "lib/commands/upgrade.js");
  const source = fs.readFileSync(filename, "utf8");
  const noop = () => {};
  const inert = new Proxy({}, { get: (_, key) => () => { trace.push(String(key)); } });
  const dependencies = {
    "node:fs": fs, "node:path": path,
    "node:child_process": { spawnSync() { throw Error("unexpected subprocess"); } },
    "./update/report": reports,
    "./update/verify": {
      collectSemanticMergeCandidates: () => [],
      runUpdateVerification: () => ({ ok: scenario !== "verification-failed", verification: [], summary: { failed: scenario === "verification-failed" ? 1 : 0, skipped: 0 } }),
    },
    "./update/runtime-layout-migration": {
      buildMigrationPlan: () => ({ is_noop: true, has_legacy: false }),
      buildMigrationReport: () => ({ migration: { is_noop: true } }),
    },
    "../team-pack/index": { loadPack: () => { trace.push("team"); return { ok: false }; } },
    "./management/api-helpers": { printManagementPayload: noop },
    "../script/manifest": { reconcileScripts: () => ({ updates: [], applied: [], failed: [], skipped: scenario === "partial" ? [{ path: "local.js", reason: "user_modified" }] : [] }) },
    "../registry/index": { PLATFORM_REGISTRY: {} },
    "./patches": { ...require("../../lib/commands/patches"), writeVersionFile: (...args) => {
      if (scenario === "helper-before") { hit.push("helper-before"); throw fault(); }
      if (scenario === "missing-result") { hit.push("missing-result"); return undefined; }
      const result = writeVersionFile(...args);
      if (scenario === "helper-after") { hit.push("helper-after"); throw fault(); }
      return result;
    } },
    "./migrate-legacy-memory": { detectLegacyFiles: () => ({ found: 0 }) },
    "../memory-validate": { validateMemory: () => ({ issues: [] }) },
    "../platform/index": { getInstalledPlatforms: () => [] },
    "../git/index": inert, "../setup/index": inert,
    "../runtime-adapters/minimax-cli-governed-tool": { registerWithInitUpdateDoctor: () => ({
      onUpdateComplete: () => { trace.push("post-adapter"); return { binary_available: false, auth_state: "fixture", probe_families: [] }; },
    }) },
  };
  const module = { exports: {} };
  const wrapper = vm.runInThisContext("(function(require,module,exports,__dirname,process,console){" + source + "\n})", { filename });
  wrapper(name => {
    if (!Object.hasOwn(dependencies, name)) throw Error("unapproved dependency: " + name);
    return dependencies[name];
  }, module, module.exports, path.join(root, "virtual/lib/commands"), process, {
    log: (...args) => logs.push(args.join(" ")), warn: (...args) => logs.push(args.join(" ")), error: (...args) => errors.push(args.join(" ")),
  });
  const target = stamp(root);
  let targetFd, delivered = false;
  const inject = phase => { hit.push(phase); throw fault(phase === "mkdir" ? "EACCES" : "EIO"); };
  let thrown;
  try {
    patched({
      mkdirSync: old => (file, ...args) => {
        if (scenario === "mkdir" && file === path.dirname(target) && fs.existsSync(path.join(root, ".agent", "added.md"))) inject("mkdir");
        return old(file, ...args);
      },
      openSync: old => (file, ...args) => {
        if (file === target) {
          if (scenario === "open-before") inject("open-before");
          targetFd = old(file, ...args); fds.add(targetFd);
          if (scenario === "open-after") inject("open-after");
          return targetFd;
        }
        return old(file, ...args);
      },
      writeSync: old => (fd, buffer, offset, length, position) => {
        if (fd !== targetFd) return old(fd, buffer, offset, length, position);
        if (["write-before", "write-and-close", "write-and-report"].includes(scenario)) inject("write-before");
        if (scenario === "zero-write") { hit.push("zero-write"); return 0; }
        if (scenario === "short-write") { hit.push("short-write"); return old(fd, buffer, offset, Math.min(length, 2), position); }
        const count = old(fd, buffer, offset, length, position);
        if (scenario === "write-after") inject("write-after");
        return count;
      },
      closeSync: old => fd => {
        if (fd === targetFd && fds.has(fd)) {
          closed.set(fd, (closed.get(fd) || 0) + 1);
          if (scenario === "close-before" || scenario === "write-and-close") inject("close-before");
          const value = old(fd); fds.delete(fd);
          if (scenario === "close-after") inject("close-after");
          return value;
        }
        return old(fd);
      },
      writeFileSync: old => (file, ...args) => {
        if (["report-error", "write-and-report"].includes(scenario) && String(file).includes(path.join(".agent", "updates"))) inject("report");
        return old(file, ...args);
      },
    }, () => {
      module.exports.upgrade({ cwd: root, templateDir: path.join(root, "templates", "en"), command, lang: "en", options: { track: true, team: true, report: reportMode } });
      delivered = true;
    });
  } catch (error) {
    thrown = { code: error.code, message: error.message, exitCodeBeforeCatch: process.exitCode || 0 };
    process.exitCode = 1;
  }
  finally { for (const fd of fds) realClose(fd); }
  process.stdout.write(JSON.stringify({ logs, errors, trace, hit, closed: [...closed.values()], delivered, thrown, exitCode: process.exitCode || 0 }));
}

if (process.argv[2] === "--stamp-child") {
  runChild(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
} else {
  function child(root, scenario, report = "text", command = "update") {
    const result = spawnSync(process.execPath, [__filename, "--stamp-child", root, scenario, report, command], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.signal, null, result.stderr);
    assert.ok(result.stdout, result.stderr);
    return { ...JSON.parse(result.stdout), status: result.status, stderr: result.stderr };
  }
  function latest(root) { return JSON.parse(fs.readFileSync(path.join(root, ".agent", "updates", "latest.json"))); }

  test("upgrade checked result writes complete version; repeated calls and init legacy stay compatible", t => {
    const root = fixture(t);
    assert.deepEqual(writeVersionFile(root, { mode: "upgrade" }), { ok: true, outcome: "written", version });
    assert.equal(readVersionFile(root), version);
    assert.equal(writeVersionFile(root), undefined);
    assert.deepEqual(writeVersionFile(root, { mode: "upgrade" }), { ok: true, outcome: "written", version });
    const blocker = path.join(root, "not-a-directory"); fs.writeFileSync(blocker, "preserve");
    assert.equal(writeVersionFile(blocker), undefined);
    const failed = writeVersionFile(blocker, { mode: "upgrade" });
    assert.equal(failed.ok, false); assert.equal(failed.outcome, "not-attempted"); assert.equal(failed.phase, "mkdir");
    assert.equal(fs.readFileSync(blocker, "utf8"), "preserve");
  });

  test("real POSIX permissions reject stamp open without changing old bytes", { skip: process.platform === "win32" || process.getuid?.() === 0 }, t => {
    const root = fixture(t); fs.chmodSync(stamp(root), 0o400);
    try {
      const result = writeVersionFile(root, { mode: "upgrade" });
      assert.equal(result.ok, false); assert.equal(result.code, "EACCES");
      assert.equal(result.phase, "open"); assert.equal(result.outcome, "unknown");
      assert.equal(fs.readFileSync(stamp(root), "utf8"), "1.15.7\n");
      assert.equal(writeVersionFile(root), undefined);
    } finally { fs.chmodSync(stamp(root), 0o600); }
  });

  for (const scenario of ["none", "short-write"]) {
    test(`real upgrade ${scenario}: no permit configuration required, passed report and repeatable stamp`, t => {
      const root = fixture(t);
      for (let round = 0; round < 2; round++) {
        const result = child(root, scenario);
        assert.equal(result.status, 0, result.stderr); assert.equal(result.thrown, undefined);
        assert.equal(result.delivered, true); assert.ok(result.logs.some(line => line.includes("Update complete!")));
        assert.equal(result.trace.includes("team"), true);
        assert.equal(result.trace.includes("post-adapter"), true);
        const report = latest(root); assert.equal(report.ok, true); assert.equal(report.status, "passed");
        assert.deepEqual(report.version_stamp, { ok: true, outcome: "written", version });
        assert.equal(fs.readFileSync(stamp(root), "utf8"), version + "\n");
        if (scenario === "short-write") assert.ok(result.hit.length > 1);
      }
      assert.equal(fs.existsSync(path.join(root, ".agent", "config", "permit-stores.json")), false);
    });
  }

  for (const command of ["upgrade", "update"]) for (const reportMode of ["text", "json"]) {
    for (const scenario of ["mkdir", "open-before", "open-after", "write-before", "write-after", "zero-write", "close-before", "close-after", "write-and-close"]) {
      test(`${command} ${reportMode} ${scenario}: failed report/nonzero, no success or downstream team work`, t => {
        const root = fixture(t), result = child(root, scenario, reportMode, command);
        assert.equal(result.status, 1, result.stderr); assert.equal(result.exitCode, 1);
        assert.equal(result.thrown, undefined); assert.equal(result.delivered, true); assert.ok(result.hit.length > 0);
        assert.equal(result.logs.some(line => /Update complete!|Additive upgrade complete/.test(line)), false);
        assert.ok(result.errors.some(line => line.includes("version stamp write failed")));
        assert.equal(result.trace.includes("team"), false);
        assert.equal(fs.readFileSync(path.join(root, ".agent", "user-rule.md"), "utf8"), "preserve user content\n");
        assert.equal(fs.readFileSync(path.join(root, ".agent", "added.md"), "utf8"), "new template\n");
        const report = latest(root); assert.equal(report.status, "failed"); assert.equal(report.ok, false);
        assert.equal(report.summary.failed, 1);
        assert.ok(report.changes.failed.some(item => item.path === ".agent/.cortex-version"));
        assert.equal(report.version_stamp.ok, false);
        assert.equal(report.version_stamp.outcome, scenario === "mkdir" ? "not-attempted" : "unknown");
        assert.equal(JSON.stringify(report).includes("fixture-private-error"), false);
        assert.ok(report.next_actions.some(line => line.includes("may have changed")));
        for (const count of result.closed) assert.equal(count, 1);
        const bytes = fs.readFileSync(stamp(root), "utf8");
        if (["mkdir", "open-before"].includes(scenario)) assert.equal(bytes, "1.15.7\n");
        else if (["write-after", "close-before", "close-after"].includes(scenario)) assert.equal(bytes, version + "\n");
        else assert.equal(bytes, "");
        if (scenario === "write-and-close") {
          assert.equal(report.version_stamp.phase, "write");
          assert.equal(report.version_stamp.cleanupError.code, "EIO");
        }
      });
    }
  }

  test("verification failure/partial update never attempts stamp", t => {
    for (const scenario of ["verification-failed", "partial"]) {
      const root = fixture(t), result = child(root, scenario);
      assert.equal(result.status, scenario === "partial" ? 2 : 3);
      assert.equal(latest(root).version_stamp, undefined);
      assert.equal(result.trace.includes("post-adapter"), false);
      assert.equal(fs.readFileSync(stamp(root), "utf8"), "1.15.7\n");
      assert.deepEqual(result.closed, []);
    }
  });

  test("additive upgrade retains its existing tail behavior for protected scripts", t => {
    const root = fixture(t), result = child(root, "partial", "text", "upgrade");
    assert.equal(result.status, 0);
    assert.equal(latest(root).status, "partial");
    assert.equal(result.trace.includes("post-adapter"), true);
    assert.equal(fs.readFileSync(stamp(root), "utf8"), "1.15.7\n");
  });

  for (const scenario of ["helper-before", "helper-after", "missing-result"]) {
    test(`${scenario} cannot bypass the checked result or turn unknown into passed`, t => {
      const root = fixture(t), result = child(root, scenario);
      assert.equal(result.status, 1); assert.equal(result.thrown, undefined); assert.equal(result.hit.length, 1);
      assert.equal(latest(root).status, "failed"); assert.equal(latest(root).summary.failed, 1);
      assert.equal(latest(root).version_stamp.outcome, "unknown");
      assert.equal(fs.readFileSync(stamp(root), "utf8"), scenario === "helper-after" ? version + "\n" : "1.15.7\n");
      assert.equal(result.logs.some(line => /Update complete!|Additive upgrade complete/.test(line)), false);
    });
  }

  test("report error after successful stamp preserves actual stamp but never prints command success", t => {
    const root = fixture(t), result = child(root, "report-error");
    assert.equal(result.delivered, false); assert.equal(result.thrown.code, "EIO");
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(stamp(root), "utf8"), version + "\n");
    assert.equal(result.logs.some(line => line.includes("Update complete!")), false);
    assert.equal(result.trace.includes("team"), false);
  });

  test("stamp plus report error is already nonzero before report failure escapes", t => {
    const root = fixture(t), result = child(root, "write-and-report");
    assert.equal(result.status, 1); assert.equal(result.delivered, false);
    assert.equal(result.thrown.exitCodeBeforeCatch, 1);
    assert.equal(fs.existsSync(path.join(root, ".agent", "updates", "latest.json")), false);
    assert.equal(result.logs.some(line => /Update complete!|Additive upgrade complete/.test(line)), false);
    assert.equal(fs.readFileSync(stamp(root), "utf8"), "");
    assert.equal(fs.readFileSync(path.join(root, ".agent", "added.md"), "utf8"), "new template\n");
  });
}
