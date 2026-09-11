"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  preflight,
  loadPlan,
  computeReport,
  detectConflicts,
  diffInventory,
  PreflightError,
} = require("../../../lib/commands/management/agent-orchestration-preflight");

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m036-preflight-"));
}

function writePlan(dir, plan) {
  const p = path.join(dir, "plan.json");
  fs.writeFileSync(p, JSON.stringify(plan));
  return p;
}

function makePlan(overrides) {
  const base = {
    schemaVersion: "1.0",
    taskId: "T-M036-002-001",
    entry: "start-task",
    ownedFiles: ["lib/commands/management/agent-orchestration-preflight.js"],
    resources: ["code-review", "codex-adapter"],
    dependencies: ["codex-adapter", "user-decision"],
    hostRequirement: {
      capabilities: ["code-review"],
      degradedAllowed: false,
    },
    gates: {
      decision: "decisions.request",
      waitpoint: "WP-M036",
    },
    result: "would_proceed",
    blockers: [],
  };
  return Object.assign(base, overrides || {});
}

function baselineInventory(dir) {
  return {
    namespace: dir + "/.agent",
    taskCount: 0, leaseCount: 0, runCount: 0,
    queueCount: 0, sessionCount: 0, operationCount: 0,
    childPids: [],
  };
}

test("VC-036-005: preflight reports entry, gates, host capability gaps and next action without creating runtime state", async () => {
  const dir = mkTmpDir();
  try {
    const planPath = writePlan(dir, makePlan());
    const bl = baselineInventory(dir);
    const report = await preflight({
      planPath: planPath,
      projectRoot: dir,
      deps: { resolveLayout: function() { return { namespace: dir + "/.agent" }; }, beforeInventory: bl, afterInventory: bl },
    });
    assert.equal(report.schemaVersion, "1.0");
    assert.equal(report.entry, "start-task");
    assert.equal(report.result, "would_proceed");
    assert.ok(report.nextAction);
    assert.equal(report.nextAction.kind, "execute");
    assert.ok(Array.isArray(report.blockers) && report.blockers.length === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("VC-036-005: missing capability surfaces ERR_HOST_CAPABILITY_GAP with owner + next action", () => {
  const plan = makePlan({
    resources: ["unrelated"],
    dependencies: ["unrelated"],
    hostRequirement: { capabilities: ["nonexistent-capability"], degradedAllowed: false },
  });
  const blockers = detectConflicts(plan);
  const codes = blockers.map(function(b) { return b.code; });
  assert.ok(codes.indexOf("ERR_HOST_CAPABILITY_GAP") !== -1);
  const cap = blockers.find(function(b) { return b.code === "ERR_HOST_CAPABILITY_GAP"; });
  assert.ok(cap.owner);
  assert.ok(cap.nextAction && cap.nextAction.length > 0);
});

test("VC-036-006: diffInventory detects taskCount drift", () => {
  const before = baselineInventory("/x");
  const after = Object.assign({}, before, { taskCount: 1 });
  const diffs = diffInventory(before, after);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, "taskCount");
});

test("VC-036-006: diffInventory detects child process creation", () => {
  const before = baselineInventory("/x");
  const after = Object.assign({}, before, { childPids: [9999] });
  const diffs = diffInventory(before, after);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, "childPids");
  assert.ok(diffs[0].newPids.indexOf(9999) !== -1);
});

test("VC-036-006: preflight throws ERR_RUNTIME_DRIFT_DETECTED when after-inventory adds a task", async () => {
  const dir = mkTmpDir();
  try {
    const planPath = writePlan(dir, makePlan());
    const before = baselineInventory(dir);
    const after = Object.assign({}, before, { taskCount: 1 });
    await assert.rejects(
      preflight({
        planPath: planPath,
        projectRoot: dir,
        deps: { resolveLayout: function() { return { namespace: dir + "/.agent" }; }, beforeInventory: before, afterInventory: after },
      }),
      function(err) {
        assert.ok(err instanceof PreflightError);
        assert.equal(err.code, "ERR_RUNTIME_DRIFT_DETECTED");
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("VC-036-007: every blocker identifies owner + actionable next action", () => {
  const plan = makePlan({ gates: { decision: "x", waitpoint: "" } });
  const report = computeReport(plan, "/tmp");
  assert.equal(report.result, "blocked");
  assert.ok(report.blockers.length > 0);
  for (const b of report.blockers) {
    assert.ok(b.code && b.code.length > 0, "blocker.code required");
    assert.ok(b.owner && b.owner.length > 0, "blocker.owner required");
    assert.ok(b.nextAction && b.nextAction.length > 0, "blocker.nextAction required");
  }
});

test("VC-036-008: preflight is idempotent (3 invocations produce identical inventory snapshots)", async () => {
  const dir = mkTmpDir();
  try {
    const planPath = writePlan(dir, makePlan());
    const bl = baselineInventory(dir);
    let prev;
    for (let i = 0; i < 3; i++) {
      const report = await preflight({
        planPath: planPath,
        projectRoot: dir,
        deps: { resolveLayout: function() { return { namespace: dir + "/.agent" }; }, beforeInventory: bl, afterInventory: bl },
      });
      assert.equal(report.runtimeInventorySnapshot.taskCount, 0);
      assert.equal(report.runtimeInventorySnapshot.operationCount, 0);
      assert.deepEqual(report.runtimeInventorySnapshot.childPids, []);
      if (prev) assert.deepEqual(report, prev, "report must be identical between invocations");
      prev = report;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlan: rejects missing file", () => {
  assert.throws(function() { loadPlan("/nonexistent/plan.json"); }, function(err) {
    return err instanceof PreflightError && err.code === "ERR_PLAN_FILE_MISSING";
  });
});

test("loadPlan: rejects malformed JSON", () => {
  const dir = mkTmpDir();
  try {
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(p, "{ not json");
    assert.throws(function() { loadPlan(p); }, function(err) {
      return err instanceof PreflightError && err.code === "ERR_PLAN_INVALID_JSON";
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlan: rejects schema-invalid plan (missing required fields)", () => {
  const dir = mkTmpDir();
  try {
    const p = writePlan(dir, { schemaVersion: "1.0" });
    assert.throws(function() { loadPlan(p); }, function(err) {
      return err instanceof PreflightError && err.code === "ERR_PLAN_SCHEMA_INVALID";
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
