"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const MANAGEMENT = path.join(ROOT, ".agent", "skills", "management-api", "scripts", "index.js");

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-communication-runtime-"));
  for (const dir of ["inbox", "decisions", "waitpoints", "runs", "queues", "sessions"]) {
    fs.mkdirSync(path.join(cwd, ".agent", dir), { recursive: true });
  }
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [MANAGEMENT, ...args], { cwd, encoding: "utf8" });
}

function payload(value) {
  return ["--payload-json", JSON.stringify(value)];
}

function requestDecision(cwd, id, resourceRef) {
  return run(cwd, [
    "decisions", "request",
    "--decision-id", id,
    "--gate", "mission",
    ...payload({
      type: "merge",
      requested_by: "coordinator",
      prompt: `Approve ${resourceRef}?`,
      options: ["approve", "reject", "revise"],
      gate: { action: "merge", resource_ref: resourceRef },
    }),
  ]);
}

function approveDecision(cwd, id) {
  return run(cwd, [
    "decisions", "resolve",
    "--decision-id", id,
    "--gate", "user",
    "--status", "approved",
    "--selected-option", "approve",
    "--resolved-by", "maintainer",
    "--rationale", "Validation evidence is complete.",
  ]);
}

test("communication schemas keep stable IDs, relations, and gate actions aligned", () => {
  const agentRoot = path.join(ROOT, ".agent");
  const schemas = [
    path.join(agentRoot, "inbox", "inbox-message.schema.json"),
    path.join(agentRoot, "inbox", "index.schema.json"),
    path.join(agentRoot, "decisions", "decision.schema.json"),
    path.join(agentRoot, "decisions", "index.schema.json"),
    path.join(agentRoot, "waitpoints", "waitpoint.schema.json"),
    path.join(agentRoot, "waitpoints", "index.schema.json"),
  ].map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  assert.equal(schemas.length, 6);

  const decision = schemas[2];
  const waitpoint = schemas[4];
  assert.equal(decision.properties.decision_id.pattern.startsWith("^D-"), true);
  assert.equal(waitpoint.properties.waitpoint_id.pattern.startsWith("^WP-"), true);
  assert.deepEqual(waitpoint.properties.gate.properties.action.enum, decision.properties.gate.properties.action.enum);
  assert.ok(decision.properties.gate.properties.action.enum.includes("architecture"));
  for (const schema of [decision, waitpoint]) {
    assert.ok(schema.required.includes("relations"));
    assert.equal(schema.properties.relations.additionalProperties, false);
  }
});

test("focused communication queries tolerate missing state", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  for (const resource of ["inbox", "decisions", "waitpoints"]) {
    const result = run(cwd, ["query", resource]);
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.deepEqual(response[resource], []);
    assert.equal(response.summary.total, 0);
  }
});

test("Decision resolution requires an explicit user gate and is terminal", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const denied = run(cwd, ["decisions", "request", "--decision-id", "D-denied"]);
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout).error, "workflow_gate_required");

  assert.equal(requestDecision(cwd, "D-merge", "branch:integration").status, 0);
  const spoofed = run(cwd, [
    "decisions", "resolve", "--decision-id", "D-merge", "--gate", "mission",
    "--status", "approved", "--resolved-by", "agent", "--rationale", "self approved",
  ]);
  assert.equal(spoofed.status, 2);
  assert.equal(JSON.parse(spoofed.stdout).error, "workflow_gate_required");

  assert.equal(approveDecision(cwd, "D-merge").status, 0);
  assert.equal(approveDecision(cwd, "D-merge").status, 1);

  const decision = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "decisions", "D-merge.json")));
  assert.equal(decision.status, "approved");
  assert.equal(decision.selected_option, "approve");
  assert.equal(decision.gate.resource_ref, "branch:integration");
  const index = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "decisions", "index.json")));
  assert.equal(index.decisions[0].status, "approved");
});

test("Decision supersede requires requester ownership and a compatible open replacement", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(requestDecision(cwd, "D-old", "architecture:proposal#old").status, 0);
  assert.equal(requestDecision(cwd, "D-new", "architecture:proposal#new").status, 0);

  const denied = run(cwd, [
    "decisions", "supersede", "--decision-id", "D-old", "--gate", "mission",
    "--superseded-by-decision-id", "D-new", "--superseded-by", "coordinator",
    "--rationale", "A new revision replaced the old one.",
  ]);
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout).error, "workflow_gate_required");

  const superseded = run(cwd, [
    "decisions", "supersede", "--decision-id", "D-old", "--gate", "requester",
    "--superseded-by-decision-id", "D-new", "--superseded-by", "coordinator",
    "--rationale", "A new revision replaced the old one.",
  ]);
  assert.equal(superseded.status, 0, superseded.stderr);
  const decision = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "decisions", "D-old.json")));
  assert.equal(decision.status, "superseded");
  assert.equal(decision.superseded_by_decision_id, "D-new");
  assert.equal(decision.resolved_by, "coordinator");
  assert.ok(decision.resolved_at);
});

test("Waitpoint release consumes only a matching approved Decision", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(requestDecision(cwd, "D-wrong", "branch:other").status, 0);
  assert.equal(approveDecision(cwd, "D-wrong").status, 0);
  assert.equal(requestDecision(cwd, "D-right", "branch:integration").status, 0);

  const created = run(cwd, [
    "waitpoints", "create",
    "--waitpoint-id", "WP-merge",
    "--gate", "mission",
    "--owner-workflow", "/checkpoint-merge",
    "--reason", "Merge approval required",
    "--action", "merge",
    "--resource-ref", "branch:integration",
    "--decision-id", "D-right",
  ]);
  assert.equal(created.status, 0, created.stderr);

  const wrong = run(cwd, [
    "waitpoints", "release",
    "--waitpoint-id", "WP-merge",
    "--gate", "owner",
    "--owner-workflow", "/checkpoint-merge",
    "--decision-id", "D-wrong",
    "--released-by", "coordinator",
  ]);
  assert.equal(wrong.status, 1);
  assert.equal(JSON.parse(wrong.stdout).error, "decision_gate_mismatch");

  const unresolved = run(cwd, [
    "waitpoints", "release",
    "--waitpoint-id", "WP-merge",
    "--gate", "owner",
    "--owner-workflow", "/checkpoint-merge",
    "--decision-id", "D-right",
    "--released-by", "coordinator",
  ]);
  assert.equal(unresolved.status, 1);
  assert.equal(JSON.parse(unresolved.stdout).error, "decision_not_approved");

  assert.equal(approveDecision(cwd, "D-right").status, 0);
  const released = run(cwd, [
    "waitpoints", "release",
    "--waitpoint-id", "WP-merge",
    "--gate", "owner",
    "--owner-workflow", "/checkpoint-merge",
    "--decision-id", "D-right",
    "--released-by", "coordinator",
  ]);
  assert.equal(released.status, 0, released.stderr);
  const waitpoint = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "waitpoints", "WP-merge.json")));
  assert.equal(waitpoint.status, "released");
  assert.ok(waitpoint.evidence_refs.includes(".agent/decisions/D-right.json"));

  assert.equal(run(cwd, [
    "waitpoints", "create", "--waitpoint-id", "WP-cancel", "--gate", "mission",
    "--owner-workflow", "/mission", "--reason", "Risk review required",
    "--action", "external_side_effect", "--resource-ref", "service:staging",
  ]).status, 0);
  assert.equal(run(cwd, [
    "waitpoints", "cancel", "--waitpoint-id", "WP-cancel", "--gate", "owner",
    "--owner-workflow", "/mission", "--reason", "The external action was removed from scope.",
  ]).status, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "waitpoints", "WP-cancel.json"))).status,
    "canceled",
  );
});

test("Waitpoint dates are validated and expired records fail closed", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const invalid = run(cwd, [
    "waitpoints", "create", "--waitpoint-id", "WP-invalid-date", "--gate", "mission",
    "--owner-workflow", "/mission", "--reason", "Approval required",
    "--action", "merge", "--resource-ref", "branch:integration",
    "--expires-at", "definitely-not-a-date",
  ]);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error, "invalid_date_time");

  assert.equal(requestDecision(cwd, "D-expired", "branch:integration").status, 0);
  assert.equal(approveDecision(cwd, "D-expired").status, 0);
  assert.equal(run(cwd, [
    "waitpoints", "create", "--waitpoint-id", "WP-expired", "--gate", "mission",
    "--owner-workflow", "/mission", "--reason", "Approval required",
    "--action", "merge", "--resource-ref", "branch:integration",
    "--decision-id", "D-expired", "--expires-at", "2020-01-01T00:00:00Z",
  ]).status, 0);

  const released = run(cwd, [
    "waitpoints", "release", "--waitpoint-id", "WP-expired", "--gate", "owner",
    "--owner-workflow", "/mission", "--decision-id", "D-expired",
    "--released-by", "coordinator",
  ]);
  assert.equal(released.status, 1);
  assert.equal(JSON.parse(released.stdout).error, "waitpoint_expired");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "waitpoints", "WP-expired.json"))).status,
    "blocked",
  );
});

test("Inbox lifecycle enforces recipient ownership", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const sent = run(cwd, [
    "inbox", "send", "--message-id", "IM-review", "--gate", "workflow",
    "--sender-id", "coordinator", "--recipient-ids", "reviewer", "--subject", "Review ready",
  ]);
  assert.equal(sent.status, 0, sent.stderr);

  const wrong = run(cwd, [
    "inbox", "transition", "--message-id", "IM-review", "--gate", "recipient",
    "--actor-id", "other", "--status", "acknowledged",
  ]);
  assert.equal(wrong.status, 1);

  assert.equal(run(cwd, [
    "inbox", "transition", "--message-id", "IM-review", "--gate", "recipient",
    "--actor-id", "reviewer", "--status", "acknowledged",
  ]).status, 0);
  const message = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "inbox", "IM-review.json")));
  assert.equal(message.status, "acknowledged");
  assert.ok(message.acknowledged_at);
});

test("dashboard-state reports approval waits before active work", (t) => {
  const cwd = project();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal(requestDecision(cwd, "D-open", "branch:integration").status, 0);

  const result = run(cwd, ["query", "dashboard-state"]);
  assert.equal(result.status, 0, result.stderr);
  const dashboard = JSON.parse(result.stdout);
  assert.equal(dashboard.summary.open_decisions, 1);
  assert.equal(dashboard.derived.state, "waiting_approval");
});
