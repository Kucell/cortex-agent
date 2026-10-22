"use strict";

// Upgrade path contract (T-TS-002 / MS-2, data upgrade).
//
// A project that predates the structured truth source is upgraded by
// `migrate-task-state`. The contract this suite locks:
//
//   1. the records the migration writes satisfy the project's own schema
//   2. the view it writes passes the project's own renderer check — the
//      project must not start its post-upgrade life with a red gate
//   3. a plan whose records would violate the schema writes NOTHING
//   4. legacy tables are read with the shipped rule, not a private copy
//   5. the project can audit its own records (doctor self-check)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const migrator = require(path.join(ROOT, "lib", "commands", "migrate-task-state.js"));
const TEMPLATE_AGENT = path.join(ROOT, "templates", "_shared", ".agent");

const LEGACY_MD = [
  "# 任务进度",
  "",
  "> **2026-01-02 收口 (第一次收口)**:",
  "> - T-HIST-001 已完成并合入",
  "",
  "## 🗺️ 路线图",
  "",
  "- [x] 阶段 1: 基础设施",
  "",
  "## 🔥 当前活跃任务",
  "",
  "| 任务 ID | 优先级 | 描述 | 进度 |",
  "| :--- | :--- | :--- | :--- |",
  "| T-LEG-001 | P0 | 解析器加固 | 100% |",
  "| T-LEG-002 | P1 | 迁移命令 | 40% |",
  "",
  "## ⏳ 未处理事项",
  "",
  "- [ ] 遗留：待确认口径",
  "",
].join("\n");

// A project that owns the shipped rule set: parser, renderer, schema and the
// schema's validator. This is what an upgraded project looks like.
function legacyProject({ schema } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-upgrade-contract-"));
  const agent = path.join(cwd, ".agent");
  fs.mkdirSync(path.join(agent, "plans"), { recursive: true });
  fs.mkdirSync(path.join(agent, "tasks", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(agent, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "tasks", "scripts", "task-state.js"),
    path.join(agent, "tasks", "scripts", "task-state.js"),
  );
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "tasks", "scripts", "render-progress.js"),
    path.join(agent, "tasks", "scripts", "render-progress.js"),
  );
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "scripts", "json-schema.js"),
    path.join(agent, "scripts", "json-schema.js"),
  );
  fs.writeFileSync(
    path.join(agent, "tasks", "task.schema.json"),
    schema || fs.readFileSync(path.join(TEMPLATE_AGENT, "tasks", "task.schema.json"), "utf8"),
    "utf8",
  );
  fs.writeFileSync(path.join(agent, "plans", "task-progress.md"), LEGACY_MD, "utf8");
  fs.writeFileSync(
    path.join(agent, "tasks", "index.json"),
    JSON.stringify({ tasks: [] }, null, 2),
    "utf8",
  );
  return cwd;
}

function recordFiles(cwd) {
  const tasksDir = path.join(cwd, ".agent", "tasks");
  return fs.readdirSync(tasksDir).filter((name) => /^T-.*\.json$/.test(name));
}

function rendererCheck(cwd) {
  return spawnSync(
    process.execPath,
    [path.join(cwd, ".agent", "tasks", "scripts", "render-progress.js"), "--check", "--project", cwd],
    { encoding: "utf8" },
  );
}

test("the records the migration writes satisfy the project's own schema", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const plan = migrator.planMigration({ projectRoot: cwd });
  assert.equal(plan.validation.ok, true, JSON.stringify(plan.validation.errors));

  const result = migrator.applyMigration(plan, { confirm: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  const { validateRecord } = require(path.join(cwd, ".agent", "scripts", "json-schema.js"));
  const schema = JSON.parse(
    fs.readFileSync(path.join(cwd, ".agent", "tasks", "task.schema.json"), "utf8"),
  );
  const files = recordFiles(cwd);
  assert.deepEqual(files.sort(), ["T-LEG-001.json", "T-LEG-002.json"]);
  for (const name of files) {
    const record = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "tasks", name), "utf8"));
    const validation = validateRecord(record, schema, "task.schema.json");
    assert.equal(validation.ok, true, `${name}: ${validation.errors.join("; ")}`);
  }
});

test("the view the migration writes passes the project's own renderer check", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const plan = migrator.planMigration({ projectRoot: cwd });
  const result = migrator.applyMigration(plan, { confirm: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  // The gate a project runs every day must be green right after the upgrade.
  const check = rendererCheck(cwd);
  assert.equal(check.status, 0, `renderer check failed:\n${check.stdout}\n${check.stderr}`);
});

test("a plan whose records violate the schema writes nothing", (t) => {
  // A schema the migrated records cannot satisfy: the record has no reviewer.
  const strictSchema = JSON.parse(
    fs.readFileSync(path.join(TEMPLATE_AGENT, "tasks", "task.schema.json"), "utf8"),
  );
  strictSchema.required = [...(strictSchema.required || []), "reviewer"];
  const cwd = legacyProject({ schema: JSON.stringify(strictSchema, null, 2) });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const before = fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8");
  const plan = migrator.planMigration({ projectRoot: cwd });
  assert.equal(plan.validation.ok, false);

  const result = migrator.applyMigration(plan, { confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "ERR_RECORDS_NOT_COMPLIANT");

  // Nothing was written: no record, no archive, no index change, no view change.
  assert.deepEqual(recordFiles(cwd), []);
  assert.equal(
    fs.existsSync(path.join(cwd, ".agent", "plans", "task-progress-archive")),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8"),
    before,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "tasks", "index.json"), "utf8")),
    { tasks: [] },
  );
});

test("legacy tables are read with the shipped rule, not a private copy", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const shipped = require(path.join(cwd, ".agent", "tasks", "scripts", "task-state.js"));
  assert.deepEqual(
    migrator.parseTaskTables(LEGACY_MD),
    shipped.parseTaskTables(LEGACY_MD),
  );

  // The migrator must not carry its own table parser: the rule lives in the
  // shipped module, so a project and the tool that upgrades it cannot drift.
  const source = fs.readFileSync(
    path.join(ROOT, "lib", "commands", "migrate-task-state.js"),
    "utf8",
  );
  assert.ok(!/const HEADER_ALIASES/.test(source), "the migrator must not restate the header aliases");
  assert.ok(!/function classifyHeader\(/.test(source), "the migrator must not restate header classification");
});

test("the project can audit its own records", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const plan = migrator.planMigration({ projectRoot: cwd });
  assert.equal(migrator.applyMigration(plan, { confirm: true }).ok, true);

  const audit = migrator.auditTaskRecords(cwd);
  assert.equal(audit.skipped, false);
  assert.equal(audit.checked, 2);
  assert.deepEqual(audit.invalid, []);
  // The migrated records still carry the placeholder acceptance criteria:
  // the upgrade keeps them visible instead of pretending they are refined.
  assert.deepEqual(audit.placeholder.sort(), ["T-LEG-001", "T-LEG-002"]);
});

test("a record that violates the schema is reported, not silently accepted", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const plan = migrator.planMigration({ projectRoot: cwd });
  assert.equal(migrator.applyMigration(plan, { confirm: true }).ok, true);

  // Break one record on purpose: the audit must see it.
  const broken = path.join(cwd, ".agent", "tasks", "T-LEG-001.json");
  const record = JSON.parse(fs.readFileSync(broken, "utf8"));
  record.status = "not-a-status";
  fs.writeFileSync(broken, JSON.stringify(record, null, 2), "utf8");

  const audit = migrator.auditTaskRecords(cwd);
  assert.equal(audit.checked, 2);
  assert.equal(audit.invalid.length, 1);
  assert.equal(audit.invalid[0].task_id, "T-LEG-001");
});

test("the plan preview shows whether the records would satisfy the schema", (t) => {
  const { spawnSync } = require("node:child_process");
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const out = spawnSync(
    process.execPath,
    [path.join(ROOT, "bin", "cli.js"), "migrate-task-state", "plan", "--project", cwd],
    { encoding: "utf8" },
  );
  const payload = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
  assert.equal(payload.action, "migrate-task-state plan");
  assert.deepEqual(payload.planned_tasks.sort(), ["T-LEG-001", "T-LEG-002"]);
  // The read-only preview carries the compliance verdict: `apply` refuses to
  // write records that do not satisfy the schema, so the plan must say so
  // before the user commits to it.
  assert.ok(payload.validation, "the plan must report the schema verdict");
  assert.equal(payload.validation.ok, true);
});

// ─── The reminder: an unmigrated project must be told, and must not be
// rendered over ───────────────────────────────────────────────────────────────

function legacyViewProject(rows = [
  "| T-LEG-001 | P0 | 旧版任务一 | 30% |",
  "| T-LEG-002 | P1 | 旧版任务二 | 60% |",
]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-legacy-view-"));
  const agent = path.join(cwd, ".agent");
  fs.mkdirSync(path.join(agent, "plans"), { recursive: true });
  fs.mkdirSync(path.join(agent, "tasks", "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "tasks", "scripts", "task-state.js"),
    path.join(agent, "tasks", "scripts", "task-state.js"),
  );
  fs.copyFileSync(
    path.join(TEMPLATE_AGENT, "tasks", "scripts", "render-progress.js"),
    path.join(agent, "tasks", "scripts", "render-progress.js"),
  );
  fs.writeFileSync(
    path.join(agent, "plans", "task-progress.md"),
    [
      "# 任务进度",
      "",
      "## 🔥 当前活跃任务",
      "",
      "| 任务 ID | 优先级 | 描述 | 进度 |",
      "| :--- | :--- | :--- | :--- |",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  );
  return cwd;
}

test("--check reminds an unmigrated project instead of silently skipping", (t) => {
  const cwd = legacyViewProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const check = rendererCheck(cwd);
  // A reminder, not a failure: the gate must not turn a project's first
  // framework upgrade into a red build.
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stderr + check.stdout, /未迁移|not migrated/);
  assert.match(check.stderr + check.stdout, /migrate-task-state apply --confirm/);
});

test("--check --json reports which rows have no record behind them", (t) => {
  const cwd = legacyViewProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const out = spawnSync(
    process.execPath,
    [path.join(cwd, ".agent", "tasks", "scripts", "render-progress.js"), "--check", "--json", "--project", cwd],
    { encoding: "utf8" },
  );
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.not_migrated, true);
  assert.deepEqual(payload.unmigrated_task_ids.sort(), ["T-LEG-001", "T-LEG-002"]);
});

test("rendering refuses to overwrite an unmigrated view", (t) => {
  const cwd = legacyViewProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const progressFile = path.join(cwd, ".agent", "plans", "task-progress.md");
  const before = fs.readFileSync(progressFile, "utf8");

  const out = spawnSync(
    process.execPath,
    [path.join(cwd, ".agent", "tasks", "scripts", "render-progress.js"), "--project", cwd],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 1);
  assert.match(out.stderr, /拒绝写入|refused/);
  // The rows are still there: a projection must never delete task state.
  assert.equal(fs.readFileSync(progressFile, "utf8"), before);
});

test("the migration does not turn mission rows into task records", (t) => {
  const cwd = legacyViewProject([
    "| T-LEG-001 | P0 | 旧版任务一 | 30% |",
    "| M-ODI-001 | P0 | 旧版 mission 行 | 60% |",
  ]);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const plan = migrator.planMigration({ projectRoot: cwd });
  assert.deepEqual(plan.planned.map((r) => r.task_id), ["T-LEG-001"]);
  assert.deepEqual(
    plan.skipped.filter((s) => s.reason === "mission_namespace").map((s) => s.id),
    ["M-ODI-001"],
  );

  const result = migrator.applyMigration(plan, { confirm: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // No mission id landed in the task namespace.
  assert.equal(fs.existsSync(path.join(cwd, ".agent", "tasks", "M-ODI-001.json")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".agent", "tasks", "T-LEG-001.json")), true);
});

test("a mission row with a mission record is not reported as a missing task record", (t) => {
  const cwd = legacyViewProject([
    "| T-LEG-001 | P0 | 旧版任务一 | 30% |",
    "| M-ODI-001 | P0 | 旧版 mission 行 | 60% |",
  ]);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const missionDir = path.join(cwd, ".agent", "missions", "M-ODI-001");
  fs.mkdirSync(missionDir, { recursive: true });
  fs.writeFileSync(
    path.join(missionDir, "mission.json"),
    JSON.stringify({ mission_id: "M-ODI-001", status: "active" }, null, 2),
    "utf8",
  );

  const detection = migrator.detectTaskState({ projectRoot: cwd });
  const missing = detection.findings.find((f) => f.kind === "task_rows_without_record");
  assert.deepEqual((missing && missing.ids) || [], ["T-LEG-001"]);
  assert.equal(
    detection.findings.some((f) => f.kind === "mission_rows_without_record"),
    false,
  );
});
