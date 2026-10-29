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

test("doctor --fix reports the schema verdict before the migration runs", async (t) => {
  const { spawnSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-doctor-fix-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // A legacy project whose records cannot satisfy the shipped schema.
  const tasks = path.join(root, ".agent", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "tasks", "task.schema.json"),
    path.join(tasks, "task.schema.json"),
  );
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "scripts", "json-schema.js"),
    path.join(root, ".agent", "scripts", "json-schema.js"),
  );
  const strict = JSON.parse(fs.readFileSync(path.join(tasks, "task.schema.json"), "utf8"));
  strict.required = [...strict.required, "reviewer"];
  fs.writeFileSync(path.join(tasks, "task.schema.json"), JSON.stringify(strict, null, 2), "utf8");
  fs.writeFileSync(
    path.join(root, ".agent", "plans", "task-progress.md"),
    [
      "## 🔥 当前活跃任务",
      "",
      "| 任务 ID | 优先级 | 描述 | 进度 |",
      "| :--- | :--- | :--- | :--- |",
      "| T-LEG-001 | P0 | 旧版任务 | 40% |",
      "",
    ].join("\n"),
    "utf8",
  );

  const out = spawnSync(
    process.execPath,
    [path.join(ROOT, "bin", "cli.js"), "doctor", "--fix", "--project", root],
    { encoding: "utf8", input: "" },
  );
  assert.match(out.stdout, /schema check: failed/);
  assert.match(out.stdout, /the migration will abort/);
  // Nothing was written: the plan is not compliant, so no record exists.
  assert.equal(fs.existsSync(path.join(tasks, "T-LEG-001.json")), false);
});

test("doctor --json tells a machine consumer that the project is not migrated", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-doctor-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".agent", "plans"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "plans", "task-progress.md"),
    [
      "# 任务进度",
      "",
      "## 🔥 当前活跃任务",
      "",
      "| 任务 ID | 优先级 | 描述 | 进度 |",
      "| :--- | :--- | :--- | :--- |",
      "| T-LEG-001 | P0 | 旧版任务 | 30% |",
      "",
    ].join("\n"),
    "utf8",
  );

  const out = await runDoctor(root, { json: true });
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  assert.ok(parsed.task_state_integrity, "task_state_integrity field is required");
  assert.equal(parsed.task_state_integrity.needs_migration, true);
  assert.equal(parsed.task_state_integrity.ok, false);
  assert.match(parsed.task_state_integrity.remedy, /migrate-task-state apply --confirm/);
});

test("doctor --json reports a migrated project as migrated", async (t) => {
  const root = projectWithTaskRecords({ "T-OK-001": validRecord("T-OK-001") });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".agent", "plans"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "tasks", "index.json"),
    JSON.stringify({ tasks: [{ task_id: "T-OK-001" }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, ".agent", "plans", "task-progress.md"),
    [
      "# 任务进度",
      "",
      "<!-- generated:task-progress v1; source=.agent/tasks,index.json; 请勿手改生成区 -->",
      "",
      "## 🔥 当前活跃任务",
      "",
      "| 任务 ID | 优先级 | 任务说明 | 进度 |",
      "| :--- | :--- | :--- | :--- |",
      "| T-OK-001 | P0 | 合规记录 | 10% |",
      "",
    ].join("\n"),
    "utf8",
  );

  const out = await runDoctor(root, { json: true });
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  assert.equal(parsed.task_state_integrity.needs_migration, false);
  assert.equal(parsed.task_state_integrity.ok, true);
});
