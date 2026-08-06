"use strict";

// ─── P-002 Phase 2: Extended Handoff Metadata ────────────────────────────────
//
// Validates that cross-host-handoff now carries 4 new fields describing
// cross-project routing context (origin_project / target_project /
// topology_ref / working_branch). All four are optional, fall back to
// null when absent, and never leak secrets via the redaction pipeline.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildContextPackage,
  handoff,
  extractCrossProjectMeta,
  isTainted,
} = require("../../lib/runtime-adapters/cross-host-handoff");

const NOW = "2026-08-06T00:00:00.000Z";

function sourceFixture(overrides) {
  return Object.assign({
    operation_id: "OP-src-1",
    host_profile_ref: "H-Codex",
    task_id: "T-cross-1",
    boundary_events: [],
    context_trajectory: { stages: [{ type: "selected", items: [] }] },
  }, overrides || {});
}

function requirementFixture() {
  return {
    schema_version: "1.0",
    requirement_id: "REQ-1",
    task_id: "T-cross-1",
    created_at: "2026-08-05T23:00:00.000Z",
    required_capabilities: ["session.boundary"],
    minimum_capability_levels: {},
    governance: { approved_decision_id: null, require_active_lease: false },
    preferred: {},
    ttl_at: "2026-08-06T01:00:00.000Z",
  };
}

function snapshotFixture(overrides) {
  return Object.assign({
    schema_version: "1.0",
    snapshot_id: "SNAP-A",
    host_profile_ref: "H-Pi",
    taken_at: "2026-08-05T23:55:00.000Z",
    capabilities: { "session.boundary": "native" },
    governance: { approved: true, decision_id: null },
    lease: { active: true, holder: "owner-A" },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  }, overrides || {});
}

// ─── 1: origin_project is present on context package and handoff ────────────

test("P-002 origin_project appears on context_package.cross_project and handoff.cross_project", () => {
  const src = sourceFixture({ origin_project: "SamHMI" });
  const pkg = buildContextPackage(src);
  assert.equal(pkg.cross_project.origin_project, "SamHMI");
  assert.equal(pkg.redacted_summary.origin_project, "SamHMI");

  const owner = () => ({ operation_attempt_id: "OP-new-1" });
  const result = handoff(src, requirementFixture(), [snapshotFixture()], owner, { now: NOW, ownerName: "ci-bot" });
  assert.equal(result.cross_project.origin_project, "SamHMI");
});

// ─── 2: target_project is present on context package and handoff ────────────

test("P-002 target_project appears on context_package.cross_project and handoff.cross_project", () => {
  const src = sourceFixture({ target_project: "cortex-agent" });
  const pkg = buildContextPackage(src);
  assert.equal(pkg.cross_project.target_project, "cortex-agent");
  assert.equal(pkg.redacted_summary.target_project, "cortex-agent");

  const owner = () => ({ operation_attempt_id: "OP-new-2" });
  const result = handoff(src, requirementFixture(), [snapshotFixture()], owner, { now: NOW, ownerName: "ci-bot" });
  assert.equal(result.cross_project.target_project, "cortex-agent");
});

// ─── 3: working_branch is present on context package and handoff ────────────

test("P-002 working_branch appears on context_package.cross_project and handoff.cross_project", () => {
  const src = sourceFixture({ working_branch: "feat/cross-project-event-bridge-phase2" });
  const pkg = buildContextPackage(src);
  assert.equal(pkg.cross_project.working_branch, "feat/cross-project-event-bridge-phase2");
  assert.equal(pkg.redacted_summary.working_branch, "feat/cross-project-event-bridge-phase2");

  const owner = () => ({ operation_attempt_id: "OP-new-3" });
  const result = handoff(src, requirementFixture(), [snapshotFixture()], owner, { now: NOW, ownerName: "ci-bot" });
  assert.equal(result.cross_project.working_branch, "feat/cross-project-event-bridge-phase2");
});

// ─── 4: missing new fields fall back to null (backward compat) ──────────────

test("P-002 missing new fields fall back to null on both context_package and handoff", () => {
  const src = sourceFixture(); // no cross-project fields
  const pkg = buildContextPackage(src);
  assert.deepEqual(pkg.cross_project, {
    origin_project: null,
    target_project: null,
    topology_ref: null,
    working_branch: null,
  });
  // Same nulls propagate to redacted_summary.
  assert.equal(pkg.redacted_summary.origin_project, null);
  assert.equal(pkg.redacted_summary.target_project, null);
  assert.equal(pkg.redacted_summary.topology_ref, null);
  assert.equal(pkg.redacted_summary.working_branch, null);

  const owner = () => ({ operation_attempt_id: "OP-new-4" });
  const result = handoff(src, requirementFixture(), [snapshotFixture()], owner, { now: NOW, ownerName: "ci-bot" });
  assert.deepEqual(result.cross_project, {
    origin_project: null,
    target_project: null,
    topology_ref: null,
    working_branch: null,
  });
});

// ─── 5: full cross-project handoff schema (4 fields provided) ───────────────

test("P-002 full cross-project handoff carries all 4 fields with correct values end-to-end", () => {
  const src = sourceFixture({
    origin_project: "SamHMI",
    target_project: "cortex-agent",
    topology_ref: "SamHMI@feat/windows-app-bindings",
    working_branch: "feat/cross-project-event-bridge-phase2",
  });

  // buildContextPackage alone:
  const pkg = buildContextPackage(src);
  assert.equal(pkg.cross_project.origin_project, "SamHMI");
  assert.equal(pkg.cross_project.target_project, "cortex-agent");
  assert.equal(pkg.cross_project.topology_ref, "SamHMI@feat/windows-app-bindings");
  assert.equal(pkg.cross_project.working_branch, "feat/cross-project-event-bridge-phase2");

  // End-to-end handoff():
  const owner = () => ({ operation_attempt_id: "OP-new-full" });
  const result = handoff(src, requirementFixture(), [snapshotFixture()], owner, { now: NOW, ownerName: "ci-bot" });
  assert.equal(result.cross_project.origin_project, "SamHMI");
  assert.equal(result.cross_project.target_project, "cortex-agent");
  assert.equal(result.cross_project.topology_ref, "SamHMI@feat/windows-app-bindings");
  assert.equal(result.cross_project.working_branch, "feat/cross-project-event-bridge-phase2");

  // Frozen shape: consumers can't mutate the meta.
  assert.equal(Object.isFrozen(result.cross_project), true);

  // Cross_project block survives deepFreeze of context_package.
  assert.equal(Object.isFrozen(pkg.cross_project), true);
});

// ─── 6 (bonus): extractCrossProjectMeta exported, no auto-detect ─────────────

test("P-002 extractCrossProjectMeta is exported and returns the 4-field shape", () => {
  assert.equal(typeof extractCrossProjectMeta, "function");

  // No source → all null.
  assert.deepEqual(extractCrossProjectMeta({}), {
    origin_project: null,
    target_project: null,
    topology_ref: null,
    working_branch: null,
  });

  // Non-string values coerce to null (defensive).
  assert.deepEqual(extractCrossProjectMeta({
    origin_project: 42,
    target_project: true,
    topology_ref: null,
    working_branch: "",
  }), {
    origin_project: null,
    target_project: null,
    topology_ref: null,
    working_branch: null,
  });

  // Real values pass through.
  const meta = extractCrossProjectMeta({
    origin_project: "hmi-platform",
    target_project: "cortex-agent",
    topology_ref: "hmi-platform@feat/catalog-bump",
    working_branch: "feat/catalog-bump",
  });
  assert.equal(meta.origin_project, "hmi-platform");
  assert.equal(meta.target_project, "cortex-agent");
  assert.equal(meta.topology_ref, "hmi-platform@feat/catalog-bump");
  assert.equal(meta.working_branch, "feat/catalog-bump");
});

// ─── 7 (bonus): taint guard — cross-project fields still pass redaction ─────

test("P-002 cross-project fields pass through the taint check (no secrets leak)", () => {
  // Even with a malicious-looking topology_ref, redaction+taint pipeline
  // should not flag the new fields as tainted.
  const src = sourceFixture({
    origin_project: "SamHMI",
    target_project: "cortex-agent",
    topology_ref: "SamHMI@feat/safe-branch",
    working_branch: "feat/safe-branch",
  });
  const pkg = buildContextPackage(src);
  assert.equal(isTainted(pkg.redacted_summary.origin_project), false);
  assert.equal(isTainted(pkg.redacted_summary.target_project), false);
  assert.equal(isTainted(pkg.redacted_summary.topology_ref), false);
  assert.equal(isTainted(pkg.redacted_summary.working_branch), false);
});
