"use strict";

// ─── P-001A Topology Init Tests ──────────────────────────────────────────────
// Covers: lib/topology/index.js initSelf + lib/commands/topology.js init subcommand
// Source: P-001A §4 验收 — 单元测试覆盖

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const topology = require("../../lib/topology");
const { topologyCommand } = require("../../lib/commands/topology");

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "topology-init-test-"));
}

function cleanDir(dir) {
  // Best-effort: rm -rf may silently fail on broken symlinks; rely on `force`.
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Capture stdout/stderr/exitCode while running topologyCommand. Returns
// { exitCode, stdout, stderr } with console + exitCode restored after.
function runTopology(ctxArgs, cwd) {
  const stdout = [];
  const stderr = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  // topologyCommand writes via process.stdout.write / emit; intercept both.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...a) => stdout.push(a.join(" "));
  console.error = (...a) => stderr.push(a.join(" "));
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  process.exitCode = 0;
  try {
    topologyCommand({ args: ctxArgs, cwd });
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("P-001A initSelf (lib/topology)", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanDir(tmpDir); });

  test("initSelf creates projects.json with self set and peers empty", () => {
    const result = topology.initSelf(tmpDir, { project_id: "alpha" });
    assert.equal(result.ok, true);
    assert.equal(result.self.project_id, "alpha");
    assert.equal(result.self.host_root, tmpDir);
    assert.equal(result.self.primary_branch, "main");
    assert.equal(result.peers_kept, 0);

    const onDisk = JSON.parse(fs.readFileSync(
      path.join(tmpDir, ".agent", "topology", "projects.json"), "utf8"));
    assert.equal(onDisk.schema_version, "1.0");
    assert.equal(onDisk.self.project_id, "alpha");
    assert.deepEqual(onDisk.peers, []);
  });

  test("initSelf rejects conflicting existing self without --force", () => {
    topology.initSelf(tmpDir, { project_id: "alpha" });
    const result = topology.initSelf(tmpDir, { project_id: "beta" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("; "), /alpha/);
    assert.match(result.errors.join("; "), /force/i);
  });

  test("initSelf with --force overwrites self but preserves peers", () => {
    topology.initSelf(tmpDir, { project_id: "alpha" });
    topology.registerPeer(tmpDir, {
      project_id: "gamma", host_root: "/tmp/gamma",
    });
    const result = topology.initSelf(tmpDir, {
      project_id: "alpha-v2", force: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.self.project_id, "alpha-v2");
    assert.equal(result.peers_kept, 1);

    const onDisk = topology.readTopology(tmpDir);
    assert.equal(onDisk.self.project_id, "alpha-v2");
    assert.equal(onDisk.peers.length, 1);
    assert.equal(onDisk.peers[0].project_id, "gamma");
  });

  test("initSelf idempotent on same project_id is a no-op refresh", () => {
    topology.initSelf(tmpDir, { project_id: "alpha" });
    topology.registerPeer(tmpDir, {
      project_id: "gamma", host_root: "/tmp/gamma",
    });
    // Re-init with same id, no force — should succeed (not error) and keep peers
    const result = topology.initSelf(tmpDir, { project_id: "alpha" });
    assert.equal(result.ok, true);
    assert.equal(result.self.project_id, "alpha");
    assert.equal(result.peers_kept, 1);
  });

  test("initSelf uses explicit --host-root and --branch", () => {
    const result = topology.initSelf(tmpDir, {
      project_id: "alpha",
      host_root: "/custom/host/path",
      branch: "develop",
    });
    assert.equal(result.ok, true);
    assert.equal(result.self.host_root, "/custom/host/path");
    assert.equal(result.self.primary_branch, "develop");
  });

  test("initSelf rejects missing project_id", () => {
    const result = topology.initSelf(tmpDir, {});
    assert.equal(result.ok, false);
    assert.match(result.errors.join("; "), /project_id/);
  });
});

describe("P-001A topology init CLI", () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanDir(tmpDir); });

  test("topology init <id> writes registry and exits 0", () => {
    const run = runTopology(["topology", "init", "alpha"], tmpDir);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /Initialized self "alpha"/);

    const onDisk = topology.readTopology(tmpDir);
    assert.equal(onDisk.self.project_id, "alpha");
  });

  test("topology init <id> --json returns JSON envelope", () => {
    const run = runTopology(["topology", "init", "alpha", "--json"], tmpDir);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.self.project_id, "alpha");
    assert.equal(payload.peers_kept, 0);
  });

  test("topology init rejects conflicting id without --force (exit 2)", () => {
    runTopology(["topology", "init", "alpha"], tmpDir);
    const run = runTopology(["topology", "init", "beta", "--json"], tmpDir);
    assert.equal(run.exitCode, 2);
    const payload = JSON.parse(run.stdout);
    assert.match(payload.error, /alpha/);
  });

  test("topology init <id> --force overwrites existing identity", () => {
    runTopology(["topology", "init", "alpha"], tmpDir);
    const run = runTopology(["topology", "init", "alpha-v2", "--force"], tmpDir);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(topology.readTopology(tmpDir).self.project_id, "alpha-v2");
  });

  test("topology help lists init subcommand", () => {
    const run = runTopology(["topology", "help"], tmpDir);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /topology init <project_id>/);
  });
});
