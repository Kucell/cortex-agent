"use strict";

// ─── doctor: task-records self-check (upgrade path) ──────────────────────────
//
// An upgraded project must be able to check its own truth source: the
// doctor validates every `.agent/tasks/*.json` against the schema that ships
// with the project.
//
// These cases live in their own file on purpose: `commands/doctor.test.js`
// already runs close to the runner's per-file budget, and the doctor call is
// the expensive part, not the assertions.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { doctor } = require("../../lib/commands/doctor");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_AGENT = path.join(ROOT, "templates", "_shared", ".agent");

function projectWithTaskRecords(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-doctor-task-records-"));
  const tasks = path.join(root, ".agent", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "tasks", "task.schema.json"),
    path.join(tasks, "task.schema.json"),
  );
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "scripts", "json-schema.js"),
    path.join(root, ".agent", "scripts", "json-schema.js"),
  );
  for (const [id, record] of Object.entries(records)) {
    fs.writeFileSync(path.join(tasks, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  }
  return root;
}

function validRecord(task_id) {
  return {
    task_id,
    title: "自查记录",
    description: "doctor 自查用的合规记录",
    status: "active",
    stage: "plan",
    priority: "P0",
    owner: "cortex-agent",
    collaborators: [],
    acceptance_criteria: ["记录能被 schema 接受"],
    dependencies: [],
    subtasks: [],
    source_refs: [".agent/plans/task-progress.md"],
    validation_commands: [],
    required_artifacts: [],
    gates: [],
    artifacts: [],
    created_at: "2026-10-22T00:00:00.000Z",
    updated_at: "2026-10-22T00:00:00.000Z",
  };
}

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

async function runDoctor(root, options = {}) {
  const ctx = {
    cwd: root,
    lang: "en",
    templateDir: path.join(root, "no-such-template"),
    options,
  };
  const { restore: restoreOut } = captureStdout();
  let out = "";
  try {
    await doctor(ctx);
  } finally {
    out = restoreOut();
  }
  return out;
}

test("doctor: task-records section reports a record that violates the schema", async (t) => {
  const root = projectWithTaskRecords({
    "T-OK-001": validRecord("T-OK-001"),
    "T-BAD-001": { ...validRecord("T-BAD-001"), status: "not-a-status" },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const out = await runDoctor(root);
  assert.match(out, /\[task-records\]/);
  assert.match(out, /T-BAD-001/);
  assert.match(out, /not in enum|violate task\.schema\.json/);
});

test("doctor: task-records section says ok when every record satisfies the schema", async (t) => {
  const root = projectWithTaskRecords({ "T-OK-001": validRecord("T-OK-001") });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const out = await runDoctor(root);
  assert.match(out, /\[task-records\]/);
  assert.match(out, /status: ok \(1 record\(s\)\)/);
});

test("doctor: --json envelope carries the task_records self-check", async (t) => {
  const root = projectWithTaskRecords({
    "T-OK-001": validRecord("T-OK-001"),
    "T-BAD-001": { ...validRecord("T-BAD-001"), status: "not-a-status" },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const out = await runDoctor(root, { json: true });
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  assert.ok(parsed.task_records, "task_records field is required");
  assert.equal(parsed.task_records.checked, 2);
  assert.equal(parsed.task_records.invalid, 1);
  assert.equal(parsed.task_records.ok, false);
});
