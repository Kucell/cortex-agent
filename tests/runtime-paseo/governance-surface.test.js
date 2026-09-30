"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  createPaseoGovernanceSurface,
} = require(path.join(ROOT, "packages", "runtime-paseo", "src", "governance-surface.js"));
const ext = require(path.join(ROOT, "packages", "extension-sdk", "src"));

function clientFixture() {
  const calls = [];
  return {
    calls,
    project: {
      resolve() {
        calls.push(["project.resolve"]);
        return { project_ref: "project:cortex-agent", project_id: "cortex-agent", root: "/private" };
      },
    },
    tasks: {
      get(taskId) {
        calls.push(["tasks.get", taskId]);
        return { task_id: taskId, status: "executing", title: "must-not-surface" };
      },
    },
    runs: {
      list() {
        calls.push(["runs.list"]);
        return [
          { run_id: "R-1", task_id: "T-1", status: "running", private_prompt: "hidden" },
          { run_id: "R-2", task_id: "T-2", status: "completed" },
        ];
      },
    },
    decisions: {
      list() {
        calls.push(["decisions.list"]);
        return [
          { decision_id: "D-1", status: "open", prompt: "secret rationale" },
          { decision_id: "D-2", status: "approved" },
        ];
      },
    },
    waitpoints: {
      list() {
        calls.push(["waitpoints.list"]);
        return [
          { waitpoint_id: "WP-1", status: "pending", reason: "private detail" },
        ];
      },
    },
    management: {
      query(name) {
        calls.push(["management.query", name]);
        if (name === "readiness") return { verdict: "ready", details: { secret: true } };
        if (name === "governed-attempt-progress") return [{ id: 1 }, { id: 2 }];
        const error = new Error("unsupported");
        error.code = "UNSUPPORTED_PROJECTION";
        throw error;
      },
    },
  };
}

test("Paseo governance surface is read-only and emits bounded governance summaries", async () => {
  const client = clientFixture();
  const surface = createPaseoGovernanceSurface(client);
  const snapshot = await surface.snapshot({
    mission_id: "M-040",
    milestone_id: "MS-011",
    task_id: "T-1",
    now: "2026-09-29T08:00:00.000Z",
  });

  assert.equal(snapshot.project.project_ref, "project:cortex-agent");
  assert.equal(snapshot.mission.mission_id, "M-040");
  assert.equal(snapshot.mission.task.status, "executing");
  assert.equal(snapshot.gates.decisions.pending, 1);
  assert.equal(snapshot.gates.waitpoints.pending, 1);
  assert.equal(snapshot.execution.runs.active, 1);
  assert.equal(snapshot.verification.readiness.available, true);
  assert.equal(snapshot.verification.readiness.summary.verdict, "ready");
  assert.equal(snapshot.knowledge.health.available, false);
  assert.equal(snapshot.mutation.supported, false);

  const serialized = JSON.stringify(snapshot);
  for (const secret of ["must-not-surface", "secret rationale", "private detail", "\"secret\":true", "/private"]) {
    assert.equal(serialized.includes(secret), false, `must omit ${secret}`);
  }
});

test("Paseo governance surface extension manifest requests no privileged permissions", () => {
  const raw = JSON.parse(fs.readFileSync(
    path.join(ROOT, "packages", "runtime-paseo", "extension.manifest.json"),
    "utf8",
  ));
  const normalized = ext.normalizeExtensionManifest(raw, ext.normalizePermissions);
  assert.equal(normalized.type, "ui-surface");
  assert.deepEqual(normalized.capabilities.required, ["management.query"]);
  assert.deepEqual(ext.flattenPermissionRequests(normalized.permissions), []);
});
