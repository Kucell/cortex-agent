"use strict";

// ─── P-001 × P-003 Integration: bridge CLI resolves topology_ref ───────────
// Covers: lib/commands/bridge.js --topology-ref integration with lib/topology
// Source: P-001 §4 验收 — 集成测试: `cortex-agent bridge subscribe
//         --topology-ref <peer>` 能解析 topology_ref 到具体 host_root

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const topology = require("../../lib/topology");
const subscriptions = require("../../lib/cross-project/subscriptions");
const { bridgeCommand } = require("../../lib/commands/bridge");

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-topology-int-"));
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Run bridgeCommand capturing stdout/stderr, then restore console and
// exitCode. Returns { exitCode, stdout, stderr }.
function runBridge(ctxArgs, cwd) {
  const stdout = [];
  const stderr = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a) => stdout.push(a.join(" "));
  console.error = (...a) => stderr.push(a.join(" "));
  process.exitCode = 0;
  try {
    bridgeCommand({ args: ctxArgs, cwd });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

const samHmi = {
  project_id: "SamHMI",
  host_root: "/Users/workspace/code/HMI/SamHMI",
  primary_branch: "main",
  roles: ["desktop", "consumer"],
  capabilities: ["bridge-consumer"],
  topology_ref: "SamHMI@main",
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("P-001 bridge --topology-ref integration", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  test("bridge subscribe --topology-ref resolves topology_ref to host_root", () => {
    const reg = topology.registerPeer(tmpDir, samHmi);
    assert.equal(reg.ok, true);

    const run = runBridge(
      ["bridge", "subscribe", "--topology-ref", "SamHMI@main", "--types", "task.state_changed", "--json"],
      tmpDir,
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.subscription.source_project_id, "SamHMI");
    assert.equal(payload.topology.topology_ref, "SamHMI@main");
    assert.equal(payload.topology.host_root, samHmi.host_root);

    // Subscription persisted with resolved source_project_id
    const current = subscriptions.readSubscriptions(tmpDir);
    assert.equal(current.subscriptions.length, 1);
    assert.equal(current.subscriptions[0].source_project_id, "SamHMI");
  });

  test("bridge subscribe --topology-ref accepts plain project_id", () => {
    topology.registerPeer(tmpDir, samHmi);
    const run = runBridge(
      ["bridge", "subscribe", "--topology-ref", "SamHMI", "--types", "decision.resolved", "--json"],
      tmpDir,
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.subscription.source_project_id, "SamHMI");
  });

  test("bridge subscribe --topology-ref rejects unknown peer with exit 2", () => {
    const run = runBridge(
      ["bridge", "subscribe", "--topology-ref", "NoSuchPeer@main", "--types", "task.state_changed", "--json"],
      tmpDir,
    );
    assert.equal(run.exitCode, 2);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "INVALID_USAGE");
    assert.match(payload.error.message, /NoSuchPeer@main/);
  });

  test("bridge subscribe rejects conflicting --source vs --topology-ref", () => {
    topology.registerPeer(tmpDir, samHmi);
    const run = runBridge(
      ["bridge", "subscribe", "--source", "OtherProj", "--topology-ref", "SamHMI@main", "--types", "task.state_changed", "--json"],
      tmpDir,
    );
    assert.equal(run.exitCode, 2);
    const payload = JSON.parse(run.stdout);
    assert.match(payload.error.message, /conflicts/);
  });

  test("bridge sync --topology-ref resolves source root from registry", () => {
    // Register peer whose host_root does not exist, then subscribe to it so
    // sync actually resolves the outbox path. Missing outbox => unreachable,
    // reported in the payload with exit 0 (P-003 §9.6).
    topology.registerPeer(tmpDir, samHmi);
    subscriptions.addSubscription(tmpDir, {
      source_project_id: "SamHMI",
      event_types: ["task.state_changed"],
    });
    const run = runBridge(
      ["bridge", "sync", "--topology-ref", "SamHMI@main", "--json"],
      tmpDir,
    );
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].source_project_id, "SamHMI");
    assert.equal(payload.results[0].reachable, false);
  });

  test("bridge sync --topology-ref rejects unknown peer with exit 2", () => {
    const run = runBridge(
      ["bridge", "sync", "--topology-ref", "Ghost@main", "--json"],
      tmpDir,
    );
    assert.equal(run.exitCode, 2);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.error.code, "INVALID_USAGE");
  });
});
