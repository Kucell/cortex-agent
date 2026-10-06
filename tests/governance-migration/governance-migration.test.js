"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  gitBlobSha,
  inspectGovernanceMigration,
  applyGovernanceMigration,
} = require("../../lib/governance-migration");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governance-migrate-"));
  fs.mkdirSync(path.join(root, ".agent", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "waitpoints"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "missions", "M-TEST"), { recursive: true });
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function decision(id, overrides = {}) {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    schema_version: 1,
    decision_id: id,
    type: "approval",
    status: "approved",
    requested_by: "test",
    prompt: "approve?",
    options: ["approve", "reject"],
    selected_option: "approve",
    resolved_by: "user",
    resolved_at: ts,
    rationale: "ok",
    gate: { action: "architecture", resource_ref: "mission:M-TEST" },
    relations: {
      task_ids: [], mission_ids: ["M-TEST"], run_ids: [], queue_ids: [],
      session_ids: [], artifact_refs: [], worktree_paths: [],
    },
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

function waitpoint(id, decisionId, overrides = {}) {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    schema_version: 1,
    waitpoint_id: id,
    status: "released",
    owner_workflow: "/mission",
    reason: "wait",
    decision_id: decisionId,
    evidence_refs: ["decision:" + decisionId],
    release_note: "ok",
    released_by: "user",
    released_at: ts,
    expires_at: null,
    relations: {
      task_ids: [], mission_ids: ["M-TEST"], run_ids: [], queue_ids: [],
      session_ids: [], artifact_refs: [], worktree_paths: [],
    },
    created_at: ts,
    updated_at: ts,
    ...overrides,
  };
}

function addPlan(root, entries) {
  const planPath = ".agent/missions/M-TEST/legacy-migration-plan.json";
  writeJson(path.join(root, planPath), {
    schema_version: "1.0",
    mission_id: "M-TEST",
    entries,
  });
  return planPath;
}

test("dry-run is zero-write and previews mechanical status migration", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".agent", "decisions", "D-OPEN.json");
  writeJson(file, decision("D-OPEN", {
    status: "proposed",
    selected_option: null,
    resolved_by: null,
    resolved_at: null,
  }));
  const before = fs.readFileSync(file, "utf8");
  const plan = addPlan(root, [{
    path: ".agent/decisions/D-OPEN.json",
    classification: "mechanical",
    expected_blob_sha: gitBlobSha(before),
    operations: [{ op: "replace", field: "status", from: "proposed", to: "open" }],
  }]);

  const result = inspectGovernanceMigration(root, plan);
  assert.equal(result.ok, true);
  assert.equal(result.read_only, true);
  assert.equal(result.summary.mechanical_ready, 1);
  assert.equal(result.entries[0].status, "ready");
  assert.notEqual(result.entries[0].before_blob_sha, result.entries[0].after_blob_sha);
  assert.equal(fs.readFileSync(file, "utf8"), before, "dry-run must not modify source");
  assert.equal(fs.existsSync(path.join(root, ".agent/missions/M-TEST/evidence/migration-backups/D-OPEN.json.before.json")), false);
});

test("apply requires explicit user gate", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".agent", "decisions", "D-OPEN.json");
  writeJson(file, decision("D-OPEN", {
    status: "proposed",
    selected_option: null,
    resolved_by: null,
    resolved_at: null,
  }));
  const before = fs.readFileSync(file, "utf8");
  const plan = addPlan(root, [{
    path: ".agent/decisions/D-OPEN.json",
    classification: "mechanical",
    expected_blob_sha: gitBlobSha(before),
    operations: [{ op: "replace", field: "status", from: "proposed", to: "open" }],
  }]);

  const result = applyGovernanceMigration(root, plan, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "MIGRATION_GATE_REQUIRED");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("apply writes exact source + immutable before backup", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".agent", "decisions", "D-OPEN.json");
  writeJson(file, decision("D-OPEN", {
    status: "proposed",
    selected_option: null,
    resolved_by: null,
    resolved_at: null,
  }));
  const before = fs.readFileSync(file, "utf8");
  const plan = addPlan(root, [{
    path: ".agent/decisions/D-OPEN.json",
    classification: "mechanical",
    expected_blob_sha: gitBlobSha(before),
    operations: [{ op: "replace", field: "status", from: "proposed", to: "open" }],
  }]);

  const result = applyGovernanceMigration(root, plan, { gate: "user" });
  assert.equal(result.ok, true);
  assert.ok(result.changed_paths.includes(".agent/decisions/D-OPEN.json"));
  const backupRel = ".agent/missions/M-TEST/evidence/migration-backups/D-OPEN.json.before.json";
  assert.ok(result.changed_paths.includes(backupRel));
  assert.equal(fs.readFileSync(path.join(root, backupRel), "utf8"), before);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "open");
});

test("copy_linked_decision_gate requires matching legacy resource_ref", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-GATE.json"), decision("D-GATE", {
    gate: { action: "external_side_effect", resource_ref: "release:test" },
  }));
  const wpFile = path.join(root, ".agent/waitpoints/WP-GATE.json");
  writeJson(wpFile, waitpoint("WP-GATE", "D-GATE", {
    resource_ref: "release:test",
  }));
  const before = fs.readFileSync(wpFile, "utf8");
  const plan = addPlan(root, [{
    path: ".agent/waitpoints/WP-GATE.json",
    classification: "mechanical",
    expected_blob_sha: gitBlobSha(before),
    operations: [{ op: "copy_linked_decision_gate" }],
  }]);

  const preview = inspectGovernanceMigration(root, plan);
  assert.equal(preview.entries[0].status, "ready");
  const result = applyGovernanceMigration(root, plan, { gate: "user" });
  assert.equal(result.ok, true);
  const migrated = JSON.parse(fs.readFileSync(wpFile, "utf8"));
  assert.deepEqual(migrated.gate, { action: "external_side_effect", resource_ref: "release:test" });
});

test("source SHA drift blocks apply", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".agent", "decisions", "D-OPEN.json");
  writeJson(file, decision("D-OPEN", {
    status: "proposed",
    selected_option: null,
    resolved_by: null,
    resolved_at: null,
  }));
  const before = fs.readFileSync(file, "utf8");
  const plan = addPlan(root, [{
    path: ".agent/decisions/D-OPEN.json",
    classification: "mechanical",
    expected_blob_sha: gitBlobSha(before),
    operations: [{ op: "replace", field: "status", from: "proposed", to: "open" }],
  }]);
  fs.appendFileSync(file, "\n");

  const preview = inspectGovernanceMigration(root, plan);
  assert.equal(preview.entries[0].status, "drift");
  const result = applyGovernanceMigration(root, plan, { gate: "user" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MIGRATION_PRECONDITION_FAILED");
});

test("decision-required and retain-legacy remain read-only blockers", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dFile = path.join(root, ".agent", "decisions", "D-LEGACY.json");
  const wFile = path.join(root, ".agent", "waitpoints", "WP-LEGACY.json");
  writeJson(dFile, decision("D-LEGACY", { type: "review" }));
  writeJson(wFile, waitpoint("WP-LEGACY", "D-LEGACY", { gate: { action: "review", resource_ref: "pilot:test" } }));
  const plan = addPlan(root, [
    {
      path: ".agent/decisions/D-LEGACY.json",
      classification: "decision-required",
      expected_blob_sha: gitBlobSha(fs.readFileSync(dFile, "utf8")),
      blockers: ["legacy_type:review"],
    },
    {
      path: ".agent/waitpoints/WP-LEGACY.json",
      classification: "retain-legacy",
      expected_blob_sha: gitBlobSha(fs.readFileSync(wFile, "utf8")),
      blockers: ["legacy_gate_action:review"],
    },
  ]);

  const preview = inspectGovernanceMigration(root, plan);
  assert.equal(preview.ok, true);
  assert.equal(preview.summary.decision_required, 1);
  assert.equal(preview.summary.retain_legacy, 1);
  assert.equal(preview.entries[0].status, "blocked-by-classification");
  assert.equal(preview.entries[1].status, "blocked-by-classification");

  const result = applyGovernanceMigration(root, plan, { gate: "user" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.changed_paths, []);
});
