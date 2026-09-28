"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildGovernanceIndexes,
  verifyGovernanceIndexes,
  rebuildGovernanceIndexes,
} = require("../../lib/governance-index");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gov-index-"));
  for (const dir of ["decisions", "waitpoints"]) {
    fs.mkdirSync(path.join(root, ".agent", dir), { recursive: true });
  }
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function decision(id, updatedAt, overrides = {}) {
  return {
    schema_version: 1,
    decision_id: id,
    type: "architecture",
    status: "approved",
    requested_by: "test",
    prompt: "approve?",
    options: ["yes", "no"],
    selected_option: "yes",
    resolved_by: "user",
    resolved_at: updatedAt,
    rationale: "ok",
    gate: { action: "architecture", resource_ref: "mission:M-X" },
    relations: { task_ids: [], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] },
    created_at: updatedAt,
    updated_at: updatedAt,
    ...overrides,
  };
}

function waitpoint(id, updatedAt, overrides = {}) {
  return {
    schema_version: 1,
    waitpoint_id: id,
    status: "released",
    owner_workflow: "/mission",
    reason: "wait",
    gate: { action: "architecture", resource_ref: "mission:M-X" },
    decision_id: "D-1",
    evidence_refs: ["decision:D-1"],
    release_note: "ok",
    released_by: "user",
    released_at: updatedAt,
    expires_at: null,
    relations: { task_ids: [], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] },
    created_at: updatedAt,
    updated_at: updatedAt,
    ...overrides,
  };
}

test("buildGovernanceIndexes projects deterministic stable indexes", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-1.json"), decision("D-1", "2026-09-28T01:00:00Z"));
  writeJson(path.join(root, ".agent/decisions/D-2.json"), decision("D-2", "2026-09-28T02:00:00Z"));
  writeJson(path.join(root, ".agent/waitpoints/WP-1.json"), waitpoint("WP-1", "2026-09-28T03:00:00Z"));

  const built = buildGovernanceIndexes(root);
  assert.equal(built.ok, true);
  assert.deepEqual(built.decisions.index.decisions.map((x) => x.decision_id), ["D-2", "D-1"]);
  assert.equal(built.decisions.index.decisions[0].path, ".agent/decisions/D-2.json");
  assert.equal(built.waitpoints.index.waitpoints[0].gate_action, "architecture");
  assert.equal(built.waitpoints.index.waitpoints[0].resource_ref, "mission:M-X");
});

test("verify is read-only and reports drift", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-1.json"), decision("D-1", "2026-09-28T01:00:00Z"));
  writeJson(path.join(root, ".agent/waitpoints/WP-1.json"), waitpoint("WP-1", "2026-09-28T01:00:00Z"));
  writeJson(path.join(root, ".agent/decisions/index.json"), { decisions: [] });
  writeJson(path.join(root, ".agent/waitpoints/index.json"), { waitpoints: [] });

  const beforeDecision = fs.readFileSync(path.join(root, ".agent/decisions/index.json"), "utf8");
  const beforeWaitpoint = fs.readFileSync(path.join(root, ".agent/waitpoints/index.json"), "utf8");
  const result = verifyGovernanceIndexes(root);
  assert.equal(result.ok, false);
  assert.equal(result.read_only, true);
  assert.equal(result.decisions.drift, true);
  assert.equal(result.waitpoints.drift, true);
  assert.equal(fs.readFileSync(path.join(root, ".agent/decisions/index.json"), "utf8"), beforeDecision);
  assert.equal(fs.readFileSync(path.join(root, ".agent/waitpoints/index.json"), "utf8"), beforeWaitpoint);
});

test("rebuild writes only deterministic index projections", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-1.json"), decision("D-1", "2026-09-28T01:00:00Z"));
  writeJson(path.join(root, ".agent/waitpoints/WP-1.json"), waitpoint("WP-1", "2026-09-28T01:00:00Z"));
  fs.writeFileSync(path.join(root, ".agent/README.md"), "sentinel\n");

  const result = rebuildGovernanceIndexes(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed_paths, [".agent/decisions/index.json", ".agent/waitpoints/index.json"]);
  assert.equal(fs.readFileSync(path.join(root, ".agent/README.md"), "utf8"), "sentinel\n");

  const verified = verifyGovernanceIndexes(root);
  assert.equal(verified.ok, true);
});

test("rebuild fails closed on malformed or legacy source and does not rewrite indexes", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-legacy.json"), decision("D-legacy", "2026-09-28T01:00:00Z", {
    status: "pending",
  }));
  writeJson(path.join(root, ".agent/waitpoints/WP-1.json"), waitpoint("WP-1", "2026-09-28T01:00:00Z"));
  const decisionIndex = path.join(root, ".agent/decisions/index.json");
  const waitpointIndex = path.join(root, ".agent/waitpoints/index.json");
  writeJson(decisionIndex, { decisions: [{ legacy: true }] });
  writeJson(waitpointIndex, { waitpoints: [{ legacy: true }] });
  const beforeD = fs.readFileSync(decisionIndex, "utf8");
  const beforeW = fs.readFileSync(waitpointIndex, "utf8");

  const result = rebuildGovernanceIndexes(root);
  assert.equal(result.ok, false);
  assert.equal(result.code, "GOVERNANCE_INDEX_SOURCE_INVALID");
  assert.equal(result.invalid_sources.length, 1);
  assert.ok(result.invalid_sources[0].errors.includes("status_invalid"));
  assert.equal(fs.readFileSync(decisionIndex, "utf8"), beforeD);
  assert.equal(fs.readFileSync(waitpointIndex, "utf8"), beforeW);
});

test("invalid JSON source is reported and not guessed", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".agent/decisions/D-bad.json"), "{broken", "utf8");
  const built = buildGovernanceIndexes(root);
  assert.equal(built.ok, false);
  assert.deepEqual(built.decisions.invalid_sources[0].errors, ["invalid_json"]);
});
