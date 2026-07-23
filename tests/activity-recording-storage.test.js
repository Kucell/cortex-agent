"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const scriptSource = path.join(root, "templates", "_shared", ".agent", "skills", "activity-recording", "scripts", "index.js");

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-activity-"));
  const script = path.join(cwd, ".agent", "skills", "activity-recording", "scripts", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(scriptSource, script);
  return { cwd, script };
}

function run(context, args, env = {}) {
  return spawnSync(process.execPath, [context.script, ...args], {
    cwd: context.cwd,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

function event(overrides = {}) {
  return {
    schema_version: 1,
    activity_id: "ACT-test-001",
    activity_kind: "change",
    capture_mode: "reconciled",
    project_id: "fixture",
    task_id: null,
    mission_id: null,
    run_id: null,
    session_id: null,
    operation_id: null,
    workspace_id: null,
    source: "git",
    source_revision: "HEAD:abc123",
    observed_at: "2026-07-23T00:00:00.000Z",
    occurred_at: null,
    actor: { type: "system", id: "git-reconciler" },
    summary: "Observed staged changes",
    changed_path_refs: ["src/a.js"],
    evidence_refs: [],
    log_cursor_refs: [],
    completeness: "partial",
    confidence: "observed",
    availability: "available",
    dedupe_key: "git:abc123:staged",
    parent_activity_id: null,
    receipt_ref: null,
    ...overrides
  };
}

test("activity events are atomic, immutable, idempotent, and indexed", () => {
  const context = project();
  assert.strictEqual(run(context, ["init"]).status, 0);

  const payload = JSON.stringify(event());
  const first = run(context, ["event", "append", "--payload-json", payload]);
  assert.strictEqual(first.status, 0, first.stderr);
  assert.strictEqual(JSON.parse(first.stdout).idempotent, false);

  const second = run(context, ["event", "append", "--payload-json", payload]);
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(JSON.parse(second.stdout).idempotent, true);

  const conflict = run(context, ["event", "append", "--payload-json", JSON.stringify(event({ summary: "Changed content" }))]);
  assert.strictEqual(conflict.status, 1);
  assert.match(conflict.stderr, /immutable/);

  const index = JSON.parse(fs.readFileSync(path.join(context.cwd, ".agent", "activities", "index.json"), "utf8"));
  assert.strictEqual(index.events.length, 1);
  assert.strictEqual(index.events[0].activity_id, "ACT-test-001");
});

test("a failed index update preserves the immutable fact and rebuild recovers it", () => {
  const context = project();
  assert.strictEqual(run(context, ["init"]).status, 0);

  const failed = run(context, ["event", "append", "--payload-json", JSON.stringify(event())], { CORTEX_ACTIVITY_FAIL_INDEX: "1" });
  assert.strictEqual(failed.status, 1);
  assert.ok(fs.existsSync(path.join(context.cwd, ".agent", "activities", "events", "ACT-test-001.json")));

  const rebuilt = run(context, ["rebuild-index"]);
  assert.strictEqual(rebuilt.status, 0, rebuilt.stderr);
  assert.strictEqual(JSON.parse(rebuilt.stdout).index.events.length, 1);
});

test("dedupe keys cannot point at two activity identities", () => {
  const context = project();
  assert.strictEqual(run(context, ["init"]).status, 0);
  assert.strictEqual(run(context, ["event", "append", "--payload-json", JSON.stringify(event())]).status, 0);

  const duplicate = run(context, ["event", "append", "--payload-json", JSON.stringify(event({ activity_id: "ACT-test-002" }))]);
  assert.strictEqual(duplicate.status, 1);
  assert.match(duplicate.stderr, /dedupe_key/);
});

test("receipt dedupe keys cannot point at two receipt identities", () => {
  const context = project();
  assert.strictEqual(run(context, ["init"]).status, 0);
  const receipt = {
    schema_version: 1,
    receipt_id: "AR-capture-001",
    receipt_kind: "capture",
    source: "workflow",
    source_revision: "run:1",
    capture_mode: "workflow_required",
    observed_at: "2026-07-23T00:00:00.000Z",
    activity_refs: [],
    gaps: [],
    evidence_refs: [],
    availability: "available",
    redaction: { status: "passed", ruleset: "default" },
    dedupe_key: "workflow:run:1",
    commit_identity: null,
    intent_receipt_ref: null
  };
  assert.strictEqual(run(context, ["receipt", "append", "--payload-json", JSON.stringify(receipt)]).status, 0);
  const duplicate = run(context, ["receipt", "append", "--payload-json", JSON.stringify({ ...receipt, receipt_id: "AR-capture-002" })]);
  assert.strictEqual(duplicate.status, 1);
  assert.match(duplicate.stderr, /dedupe_key/);
});

test("rebuild-index recovers from a corrupt derived index", () => {
  const context = project();
  assert.strictEqual(run(context, ["init"]).status, 0);
  assert.strictEqual(run(context, ["event", "append", "--payload-json", JSON.stringify(event())]).status, 0);
  fs.writeFileSync(path.join(context.cwd, ".agent", "activities", "index.json"), "{broken", "utf8");
  const rebuilt = run(context, ["rebuild-index"]);
  assert.strictEqual(rebuilt.status, 0, rebuilt.stderr);
  assert.strictEqual(JSON.parse(rebuilt.stdout).index.events.length, 1);
});

test("available commit results require a real identity and intent reference", () => {
  const context = project();
  assert.strictEqual(run(context, ["init"]).status, 0);
  const receipt = {
    schema_version: 1,
    receipt_id: "AR-commit-001",
    receipt_kind: "commit_result",
    source: "git",
    source_revision: "staged-tree:abc",
    capture_mode: "workflow_required",
    observed_at: "2026-07-23T00:00:00.000Z",
    activity_refs: [],
    gaps: [],
    evidence_refs: [],
    availability: "available",
    redaction: { status: "passed", ruleset: "default" },
    dedupe_key: "git:commit-result:abc",
    commit_identity: null,
    intent_receipt_ref: null
  };
  const result = run(context, ["receipt", "append", "--payload-json", JSON.stringify(receipt)]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /commit_identity/);
  assert.ok(!fs.existsSync(path.join(context.cwd, ".agent", "activities", "receipts", "AR-commit-001.json")));
});
