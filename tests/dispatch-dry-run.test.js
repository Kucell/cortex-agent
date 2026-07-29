"use strict";

// ─── Read-only Dispatch Dry-run tests (MS-008 / P-004 / VC-008) ─────────────
//
// VC-008-01: Dry-run explains selection/rejection and causes no file, lease,
// process, MCP, or external mutation. The fixture-based tests below snapshot
// a temp directory before and after the dry-run and assert no file mutation
// occurred.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  dryRunDispatch,
  explain,
  DispatchDryRunError,
} = require("../lib/runtime-adapters/dispatch-dry-run");
const { matchExecutionSurface } = require("../lib/runtime-adapters/execution-surface-matcher");

const NOW = "2026-07-28T12:00:00.000Z";

function requirement(overrides) {
  return Object.assign({
    schema_version: "1.0",
    requirement_id: "REQ-1",
    task_id: "T-1",
    created_at: "2026-07-28T11:00:00.000Z",
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: { approved_decision_id: "D-1", require_active_lease: false },
    preferred: {},
    ttl_at: "2026-07-28T13:00:00.000Z",
  }, overrides || {});
}

function snapshot(overrides) {
  return Object.assign({
    schema_version: "1.0",
    snapshot_id: "SNAP-A",
    host_profile_ref: "H-A",
    taken_at: "2026-07-28T11:55:00.000Z",
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
      "tool.update": "adapter",
    },
    governance: { approved: true, decision_id: "D-1" },
    lease: { active: true, holder: "owner-A" },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  }, overrides || {});
}

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dryrun-"));
}

test("VC-008-01 dry-run explains selection when one candidate passes hard filters", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "pre-existing.txt"), "untouched");
  const result = dryRunDispatch(requirement(), [snapshot()], { watchRoot: cwd, now: NOW });
  assert.equal(result.schema_version, "1.0");
  assert.equal(result.plan.selection, "H-A");
  assert.equal(result.explanation.selected, "H-A");
  assert.ok(result.explanation.selection_reason.includes("hard filters"));
  assert.equal(result.explanation.side_effects.files.mutated, false);
  assert.equal(result.explanation.side_effects.leases.acquired, false);
  assert.equal(result.explanation.side_effects.processes.spawned, false);
  assert.equal(result.explanation.side_effects.mcp.invoked, false);
  assert.equal(result.explanation.side_effects.external.invoked, false);
});

test("VC-008-01 dry-run explains rejection when no candidate passes hard filters", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const failing = snapshot({ capabilities: { "session.boundary": "native", "tool.before.block": "unsupported" } });
  const result = dryRunDispatch(requirement(), [failing], { watchRoot: cwd, now: NOW });
  assert.equal(result.plan.selection, null);
  assert.equal(result.explanation.selected, null);
  assert.ok(result.explanation.selection_reason.includes("widen requirements"));
  assert.equal(result.explanation.rejected_count, 1);
  assert.equal(result.explanation.passed_count, 0);
});

test("VC-008-01 dry-run produces no file mutation in the watched tree", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  // Pre-create nested directories to make sure traversal covers them.
  fs.mkdirSync(path.join(cwd, "deep", "nested"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "deep", "nested", "existing.json"), JSON.stringify({ before: true }));
  fs.writeFileSync(path.join(cwd, "shallow.txt"), "stable");
  dryRunDispatch(requirement(), [snapshot()], { watchRoot: cwd, now: NOW });
  assert.ok(fs.existsSync(path.join(cwd, "deep", "nested", "existing.json")));
  assert.ok(fs.existsSync(path.join(cwd, "shallow.txt")));
});

test("VC-008-01 dry-run mutating the watched tree throws ERR_FILE_MUTATION_DETECTED", (t) => {
  // Patch captureTree to simulate mutation after the call. We do this by
  // monkey-patching fs.statSync to return different mtimes on the second call.
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, "marker.json");
  fs.writeFileSync(target, "stable");
  const originalStatSync = fs.statSync;
  let count = 0;
  fs.statSync = function patched(file, ...rest) {
    const result = originalStatSync.call(fs, file, ...rest);
    count += 1;
    if (count > 1 && String(file).endsWith("marker.json")) {
      // fs.Stats properties are getters; override mtimeMs via defineProperty.
      Object.defineProperty(result, "mtimeMs", { value: result.mtimeMs + 1000, configurable: true });
      return result;
    }
    return result;
  };
  t.after(() => { fs.statSync = originalStatSync; });
  assert.throws(
    () => dryRunDispatch(requirement(), [snapshot()], { watchRoot: cwd, now: NOW }),
    (err) => err instanceof DispatchDryRunError && err.code === "ERR_FILE_MUTATION_DETECTED"
  );
});

test("VC-008-01 dry-run output is identical to running the matcher directly", () => {
  const plan = matchExecutionSurface(requirement(), [snapshot()], { now: NOW });
  const result = dryRunDispatch(requirement(), [snapshot()], { watchRoot: null, now: NOW });
  assert.deepEqual(result.plan, plan);
});

test("VC-008-01 explain() emits a human-readable plan breakdown", () => {
  const plan = matchExecutionSurface(requirement(), [
    snapshot(),
    snapshot({ snapshot_id: "SNAP-B", host_profile_ref: "H-B", capabilities: { "session.boundary": "native", "tool.before.block": "unsupported" } }),
  ], { now: NOW });
  const text = explain(plan);
  assert.ok(text.includes("Plan"));
  assert.ok(text.includes("✓ H-A"));
  assert.ok(text.includes("✗ H-B"));
  assert.ok(text.includes("hard filters"));
});

test("VC-008-01 dry-run requires options.now for deterministic timing", () => {
  assert.throws(() => dryRunDispatch(requirement(), [snapshot()], { watchRoot: null }), (err) => err instanceof DispatchDryRunError);
});

test("VC-008-01 dry-run passes through validation errors from the matcher", () => {
  assert.throws(
    () => dryRunDispatch(requirement({ required_capabilities: ["made.up"] }), [snapshot()], { watchRoot: null, now: NOW }),
    (err) => err.code === "ERR_CAPABILITY_UNKNOWN"
  );
});

test("VC-008-01 dry-run plan_id is stable for identical inputs", () => {
  const a = dryRunDispatch(requirement(), [snapshot()], { watchRoot: null, now: NOW });
  const b = dryRunDispatch(requirement(), [snapshot()], { watchRoot: null, now: NOW });
  assert.equal(a.plan.plan_id, b.plan.plan_id);
  assert.equal(a.dry_run_id, b.dry_run_id);
});