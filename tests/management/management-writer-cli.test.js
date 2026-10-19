"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const FILES = ["index.js", "normalize-token-usage.js", "projection-registry.json", "query-activity.js", "query-dispatch-state.js"];

function createProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-writer-cli-"));
  const scripts = path.join(project, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", file), path.join(scripts, file));
  const taskScripts = path.join(project, ".agent", "tasks", "scripts");
  fs.mkdirSync(taskScripts, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"), path.join(taskScripts, "task-state.js"));
  for (const dir of ["runs", "queues", "sessions", "decisions", "inbox", "waitpoints"]) fs.mkdirSync(path.join(project, ".agent", dir), { recursive: true });
  return project;
}

function run(cwd, project, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--project", project], { cwd, encoding: "utf8", env: { ...process.env, LANG: "en_US.UTF-8" } });
}

test("explicit writer actions preserve project scope and owner lifecycle exits", (t) => {
  const project = createProject();
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-writer-caller-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  t.after(() => fs.rmSync(caller, { recursive: true, force: true }));

  let result = run(caller, project, ["sessions", "open", "--session-id", "S-1", "--agent-id", "owner", "--role", "worker"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).project.root, fs.realpathSync(project));

  result = run(caller, project, ["sessions", "heartbeat", "--session-id", "S-1", "--agent-id", "other"]);
  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).error.code, "SESSION_OWNER_MISMATCH");

  result = run(caller, project, ["sessions", "close", "--session-id", "S-1", "--agent-id", "owner", "--gate", "owner"]);
  assert.equal(result.status, 0, result.stderr);
  result = run(caller, project, ["sessions", "heartbeat", "--session-id", "S-1", "--agent-id", "owner"]);
  assert.equal(result.status, 5);
  assert.equal(JSON.parse(result.stdout).error.code, "SESSION_CLOSED");
});

test("writer gates and atomic failures use stable exit classes", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  let result = run(project, project, ["queues", "upsert", "--queue-id", "Q-1", "--name", "Queue"]);
  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).error.code, "WORKFLOW_GATE_REQUIRED");

  fs.rmSync(path.join(project, ".agent", "runs"), { recursive: true, force: true });
  fs.writeFileSync(path.join(project, ".agent", "runs"), "not-a-directory", "utf8");
  result = run(project, project, ["runs", "checkpoint", "--run-id", "R-1", "--status", "running"]);
  assert.equal(result.status, 5, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "ATOMIC_WRITE_FAILED");
});

test("decisions request help and writer accept the documented gate-action and options contract", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const help = spawnSync(process.execPath, [CLI, "help", "--json"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
  });
  assert.equal(help.status, 0, help.stderr);
  const usage = JSON.parse(help.stdout).contract.management.writer_usage["decisions request"];
  assert.match(usage, /--gate-action <action>/);
  assert.match(usage, /--options <json-array>/);
  assert.match(usage, /--action <action> legacy alias/);
  assert.match(usage, /--mission-id <id>/);
  assert.match(usage, /--artifact-ref <ref>/);

  let result = run(project, project, [
    "decisions", "request", "--decision-id", "D-GATE-ACTION", "--gate", "mission",
    "--type", "architecture", "--requested-by", "coordinator", "--prompt", "Approve?",
    "--gate-action", "architecture", "--resource-ref", "proposal:test", "--options", '["approve","reject"]',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision.gate.action, "architecture");

  result = run(project, project, [
    "decisions", "request", "--decision-id", "D-GATE-ACTION-PRIORITY", "--gate", "mission",
    "--type", "architecture", "--requested-by", "coordinator", "--prompt", "Approve?",
    "--gate-action", "architecture", "--action", "merge", "--resource-ref", "proposal:priority", "--options", '["approve","reject"]',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision.gate.action, "architecture");

  result = run(project, project, [
    "decisions", "request", "--decision-id", "D-LEGACY-ACTION", "--gate", "mission",
    "--type", "architecture", "--requested-by", "coordinator", "--prompt", "Approve?",
    "--action", "architecture", "--resource-ref", "proposal:legacy", "--options", '["approve","reject"]',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision.gate.action, "architecture");
});

test("decisions request accepts user gate and persists repeatable relations", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const help = run(project, project, ["decisions", "request", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /mission \| agent \| user/);

  const result = run(project, project, [
    "decisions", "request", "--decision-id", "D-RELATIONS", "--gate", "user",
    "--gate-action", "architecture", "--type", "approval", "--requested-by", "tester",
    "--prompt", "Approve?", "--resource-ref", "mission:M-053@sha256:example",
    "--options", '["approve","reject"]',
    "--mission-id", "M-053", "--mission-id", "M-053",
    "--artifact-ref", "mission:M-053@sha256:example", "--artifact-ref", "source:branch@sha:path@sha256:example",
    "--worktree-path", "/tmp/m053-worktree", "--task-id", "T-1",
    "--run-id", "R-1", "--queue-id", "Q-1", "--session-id", "S-1",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout).decision;
  assert.equal(decision.workflow_gate, "user");
  assert.deepEqual(decision.relations.mission_ids, ["M-053"]);
  assert.deepEqual(decision.relations.artifact_refs, ["mission:M-053@sha256:example", "source:branch@sha:path@sha256:example"]);
  assert.deepEqual(decision.relations.worktree_paths, ["/tmp/m053-worktree"]);
  assert.deepEqual(decision.relations.task_ids, ["T-1"]);
  assert.deepEqual(decision.relations.run_ids, ["R-1"]);
  assert.deepEqual(decision.relations.queue_ids, ["Q-1"]);
  assert.deepEqual(decision.relations.session_ids, ["S-1"]);
  const saved = JSON.parse(fs.readFileSync(path.join(project, ".agent", "decisions", "D-RELATIONS.json"), "utf8"));
  assert.deepEqual(saved.relations, decision.relations);
  const activity = run(project, project, ["query", "activity"]);
  assert.equal(activity.status, 0, activity.stderr);
  const projected = JSON.parse(activity.stdout).data.activity.find((item) => item.resource_id === "D-RELATIONS");
  assert.equal(projected.relations.mission_id, "M-053");
});

test("decisions request rejects a relation flag without a value before writing", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const result = run(project, project, [
    "decisions", "request", "--decision-id", "D-MISSING-RELATION", "--gate", "mission",
    "--gate-action", "architecture", "--type", "approval", "--requested-by", "tester",
    "--prompt", "Approve?", "--resource-ref", "mission:M-053@sha256:example",
    "--options", '["approve","reject"]', "--mission-id", "--artifact-ref", "artifact:example",
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_DECISION_RELATIONS");
  assert.equal(fs.existsSync(path.join(project, ".agent", "decisions", "D-MISSING-RELATION.json")), false);
});


test("waitpoint writer rejects non-schema owner workflow and writes schema-complete index entries", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  let result = run(project, project, [
    "waitpoints", "create",
    "--waitpoint-id", "WP-OWNER-BAD",
    "--gate", "mission",
    "--owner-workflow", "test",
    "--reason", "schema guard",
    "--action", "architecture",
    "--resource-ref", "mission:M-TEST",
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_WAITPOINT_OWNER");

  result = run(project, project, [
    "waitpoints", "create",
    "--waitpoint-id", "WP-OWNER-GOOD",
    "--gate", "mission",
    "--owner-workflow", "/test",
    "--reason", "schema guard",
    "--action", "architecture",
    "--resource-ref", "mission:M-TEST",
  ]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const index = JSON.parse(fs.readFileSync(path.join(project, ".agent", "waitpoints", "index.json"), "utf8"));
  const entry = index.waitpoints.find((item) => item.waitpoint_id === "WP-OWNER-GOOD");
  assert.ok(entry);
  assert.equal(entry.owner_workflow, "/test");
  assert.equal(entry.gate_action, "architecture");
  assert.equal(entry.resource_ref, "mission:M-TEST");
  assert.equal(entry.decision_id, null);
});
