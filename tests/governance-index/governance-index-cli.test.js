"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gov-index-cli-"));
  fs.mkdirSync(path.join(root, ".agent", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "waitpoints"), { recursive: true });
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function decision(id, status = "approved") {
  const ts = "2026-09-28T05:00:00Z";
  return {
    schema_version: 1,
    decision_id: id,
    type: "architecture",
    status,
    requested_by: "test",
    prompt: "approve?",
    options: ["yes", "no"],
    selected_option: status === "open" ? null : "yes",
    resolved_by: status === "open" ? null : "user",
    resolved_at: status === "open" ? null : ts,
    rationale: "",
    gate: { action: "architecture", resource_ref: "mission:M-CLI" },
    relations: { task_ids: [], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] },
    created_at: ts,
    updated_at: ts,
  };
}

function waitpoint(id) {
  const ts = "2026-09-28T05:00:00Z";
  return {
    schema_version: 1,
    waitpoint_id: id,
    status: "released",
    owner_workflow: "/mission",
    reason: "wait",
    gate: { action: "architecture", resource_ref: "mission:M-CLI" },
    decision_id: "D-CLI",
    evidence_refs: ["decision:D-CLI"],
    release_note: "",
    released_by: "user",
    released_at: ts,
    expires_at: null,
    relations: { task_ids: [], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] },
    created_at: ts,
    updated_at: ts,
  };
}

function run(project, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--project", project], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, CORTEX_STATE_SYNC: "off", LANG: "en_US.UTF-8" },
  });
}

test("governance-index --help is zero-write", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readdirSync(path.join(root, ".agent", "decisions")).join("|");
  const result = run(root, ["governance-index", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /governance-index verify/);
  const after = fs.readdirSync(path.join(root, ".agent", "decisions")).join("|");
  assert.equal(after, before);
});

test("governance-index verify reports drift and writes nothing", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-CLI.json"), decision("D-CLI"));
  writeJson(path.join(root, ".agent/waitpoints/WP-CLI.json"), waitpoint("WP-CLI"));
  writeJson(path.join(root, ".agent/decisions/index.json"), { decisions: [] });
  writeJson(path.join(root, ".agent/waitpoints/index.json"), { waitpoints: [] });
  const beforeD = fs.readFileSync(path.join(root, ".agent/decisions/index.json"), "utf8");
  const beforeW = fs.readFileSync(path.join(root, ".agent/waitpoints/index.json"), "utf8");

  const result = run(root, ["governance-index", "verify"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.read_only, true);
  assert.equal(body.decisions.drift, true);
  assert.equal(body.waitpoints.drift, true);
  assert.equal(fs.readFileSync(path.join(root, ".agent/decisions/index.json"), "utf8"), beforeD);
  assert.equal(fs.readFileSync(path.join(root, ".agent/waitpoints/index.json"), "utf8"), beforeW);
});

test("governance-index rebuild fixes projection drift", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-CLI.json"), decision("D-CLI"));
  writeJson(path.join(root, ".agent/waitpoints/WP-CLI.json"), waitpoint("WP-CLI"));

  let result = run(root, ["governance-index", "rebuild"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  let body = JSON.parse(result.stdout);
  assert.deepEqual(body.changed_paths, [".agent/decisions/index.json", ".agent/waitpoints/index.json"]);

  result = run(root, ["governance-index", "verify"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
});

test("governance-index rebuild fails closed on legacy source", (t) => {
  const root = mkProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, ".agent/decisions/D-CLI.json"), decision("D-CLI", "pending"));
  const indexFile = path.join(root, ".agent/decisions/index.json");
  writeJson(indexFile, { decisions: [{ sentinel: true }] });
  const before = fs.readFileSync(indexFile, "utf8");

  const result = run(root, ["governance-index", "rebuild"]);
  assert.equal(result.status, 3);
  const body = JSON.parse(result.stdout);
  assert.equal(body.code, "GOVERNANCE_INDEX_SOURCE_INVALID");
  assert.equal(body.invalid_sources.length, 1);
  assert.equal(fs.readFileSync(indexFile, "utf8"), before);
});
