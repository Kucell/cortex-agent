"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { gitBlobSha } = require("../../lib/governance-migration");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governance-migrate-cli-"));
  fs.mkdirSync(path.join(root, ".agent", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "missions", "M-TEST"), { recursive: true });
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function decision(status) {
  return {
    schema_version: 1,
    decision_id: "D-CLI",
    type: "approval",
    status,
    requested_by: "test",
    prompt: "approve?",
    options: ["approve", "reject"],
    selected_option: null,
    resolved_by: null,
    resolved_at: null,
    rationale: "",
    gate: { action: "architecture", resource_ref: "mission:M-TEST" },
    relations: {
      task_ids: [], mission_ids: ["M-TEST"], run_ids: [], queue_ids: [],
      session_ids: [], artifact_refs: [], worktree_paths: [],
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--project", root], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", CORTEX_STATE_SYNC: "off" },
  });
}

test("governance-migrate help is zero-write", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readdirSync(path.join(root, ".agent", "decisions")).join("|");
  const result = run(root, ["governance-migrate", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /governance-migrate dry-run/);
  assert.equal(fs.readdirSync(path.join(root, ".agent", "decisions")).join("|"), before);
});

test("governance-migrate dry-run and apply preserve command-effect boundaries", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const decisionFile = path.join(root, ".agent", "decisions", "D-CLI.json");
  writeJson(decisionFile, decision("proposed"));
  const before = fs.readFileSync(decisionFile, "utf8");
  const planRel = ".agent/missions/M-TEST/legacy-migration-plan.json";
  writeJson(path.join(root, planRel), {
    schema_version: "1.0",
    mission_id: "M-TEST",
    entries: [{
      path: ".agent/decisions/D-CLI.json",
      classification: "mechanical",
      expected_blob_sha: gitBlobSha(before),
      operations: [{ op: "replace", field: "status", from: "proposed", to: "open" }],
    }],
  });

  let result = run(root, ["governance-migrate", "dry-run", "--plan", planRel]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  let body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.read_only, true);
  assert.equal(body.summary.mechanical_ready, 1);
  assert.equal(fs.readFileSync(decisionFile, "utf8"), before);

  result = run(root, ["governance-migrate", "apply", "--plan", planRel]);
  assert.equal(result.status, 4);
  body = JSON.parse(result.stdout);
  assert.equal(body.code, "MIGRATION_GATE_REQUIRED");
  assert.equal(fs.readFileSync(decisionFile, "utf8"), before);

  result = run(root, ["governance-migrate", "apply", "--plan", planRel, "--gate", "user"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.ok(body.changed_paths.includes(".agent/decisions/D-CLI.json"));
  assert.equal(JSON.parse(fs.readFileSync(decisionFile, "utf8")).status, "open");
});

test("governance-migrate rejects missing plan", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = run(root, ["governance-migrate", "dry-run"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--plan is required/);
});
