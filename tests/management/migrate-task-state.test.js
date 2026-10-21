"use strict";

// T-TS-002 / MS-2: migrate-task-state contract.
// - detect is read-only and reports the legacy shape
// - apply without --confirm refuses to mutate
// - apply snapshots the original, writes records, archives, rebuilds the index
// - a second apply is a no-op (idempotency)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const migrator = require(path.join(ROOT, "lib", "commands", "migrate-task-state.js"));

function legacyProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-migrate-task-state-"));
  const agent = path.join(cwd, ".agent");
  fs.mkdirSync(path.join(agent, "plans"), { recursive: true });
  fs.mkdirSync(path.join(agent, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(agent, "plans", "task-progress.md"), [
    "# 任务进度",
    "",
    "> **2026-01-02 收口 (第一次收口)**:",
    "> - T-HIST-001 已完成并合入",
    "",
    "> **2026-01-03 收口 (第二次收口)**:",
    "> - T-HIST-002 已完成并合入",
    "",
    "## 🗺️ 路线图",
    "",
    "- [x] 阶段 1: 基础设施",
    "- [ ] 阶段 2: 真源归一",
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
    "## 🔌 断点续接",
    "",
    "- [x] 阶段 1: 已完成（commit: abc1234）",
    "- [ ] 阶段 2: 进行中",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(agent, "tasks", "index.json"), JSON.stringify({ tasks: [] }, null, 2), "utf8");
  return cwd;
}

test("detect reports the legacy shape without mutating", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8");
  const r = migrator.detectTaskState({ projectRoot: cwd });
  assert.equal(r.ok, true);
  assert.equal(r.needsMigration, true);
  assert.deepEqual(r.tableTaskIds.sort(), ["T-LEG-001", "T-LEG-002"]);
  assert.equal(r.missingFromIndex.length, 0);
  assert.equal(
    fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8"),
    before,
  );
});

test("detect reports missing task-progress.md instead of throwing", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-migrate-empty-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const r = migrator.detectTaskState({ projectRoot: cwd });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "missing_task_progress");
  assert.equal(r.needsMigration, false);
});

test("apply without confirm refuses to mutate", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plan = migrator.planMigration({ projectRoot: cwd });
  const result = migrator.applyMigration(plan, { confirm: false });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "ERR_CONFIRM_REQUIRED");
  assert.equal(fs.existsSync(path.join(cwd, ".agent", "tasks", "T-LEG-001.json")), false);
});

test("apply writes records, archives, index and view; a second run is a no-op", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plan = migrator.planMigration({ projectRoot: cwd });
  assert.equal(plan.planned.length, 2);
  assert.equal(plan.archives.length, 2);

  const result = migrator.applyMigration(plan, { confirm: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  // structured records
  const done = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "tasks", "T-LEG-001.json"), "utf8"));
  assert.equal(done.task_id, "T-LEG-001");
  assert.equal(done.status, "completed");
  assert.equal(done.stage, "done");
  assert.equal(done.priority, "P0");
  assert.equal(done.title, "解析器加固");
  const running = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "tasks", "T-LEG-002.json"), "utf8"));
  assert.equal(running.status, "active");
  assert.equal(running.stage, "plan");

  // snapshot of the original file
  const snapshotDir = path.join(cwd, ".agent", "plans", "task-progress-archive", "_snapshots");
  const snapshots = fs.readdirSync(snapshotDir);
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0], /^task-progress-.*\.md\.bak$/);
  const snapshot = fs.readFileSync(path.join(snapshotDir, snapshots[0]), "utf8");
  assert.match(snapshot, /T-LEG-001/);

  // archives carry frontmatter and the closeout history
  const archiveDir = path.join(cwd, ".agent", "plans", "task-progress-archive");
  const archiveFile = path.join(archiveDir, "2026-01-02.md");
  assert.equal(fs.existsSync(archiveFile), true);
  const archive = fs.readFileSync(archiveFile, "utf8");
  assert.match(archive, /^---\n/);
  assert.match(archive, /kind: task-progress-archive/);
  assert.match(archive, /date_range: \[2026-01-02, 2026-01-02\]/);
  assert.match(archive, /T-HIST-001/);
  const secondArchive = fs.readFileSync(path.join(archiveDir, "2026-01-03.md"), "utf8");
  assert.match(secondArchive, /T-HIST-002/);

  // index rebuilt from disk
  const index = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "tasks", "index.json"), "utf8"));
  assert.deepEqual(index.tasks.map((t) => t.task_id).sort(), ["T-LEG-001", "T-LEG-002"]);

  // view regenerated with manual sections preserved
  const view = fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8");
  assert.match(view, /generated:task-progress v1/);
  assert.match(view, /\| T-LEG-002 \| P1 \| 迁移命令 \|/);
  assert.match(view, /阶段 1: 基础设施/);
  assert.match(view, /遗留：待确认口径/);
  assert.match(view, /阶段 2: 进行中/);
  assert.ok(!/T-HIST-001/.test(view), "history must not stay in the live view");

  // idempotency: a second apply changes nothing
  const before = fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8");
  const second = migrator.planMigration({ projectRoot: cwd });
  assert.equal(second.alreadyMigrated, true);
  const secondResult = migrator.applyMigration(second, { confirm: true });
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.applied, 0);
  assert.equal(
    fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8"),
    before,
  );
});

test("table columns are mapped by header meaning, not position", () => {
  const md = [
    "| 任务 ID | 优先级 | Milestone | 描述 | 进度 |",
    "| :--- | :--- | :--- | :--- | :--- |",
    "| T-FIVE-001 | P1 | MS-002 | 五列布局 | 60% |",
  ].join("\n");
  const tables = migrator.parseTaskTables(md);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows.length, 1);
  const record = migrator.buildTaskRecord({
    id: "T-FIVE-001",
    priority: "P1",
    description: "五列布局",
    progressText: "60%",
    planRef: "",
    sourceRef: ".agent/plans/task-progress.md",
    timestamp: "2026-10-21T00:00:00.000Z",
  });
  assert.equal(record.title, "五列布局");
  assert.equal(record.stage, "implement");
  assert.equal(record.status, "active");
});

test("history blocks are grouped by date and counted as closeout events", () => {
  const md = [
    "> **2026-01-02 收口 (A)**:",
    "> - one",
    "> **2026-01-02 收口 (B)**:",
    "> - two",
    "> **2026-01-05 收口 (C)**:",
    "> - three",
  ].join("\n");
  const blocks = migrator.splitHistoryBlocks(md);
  assert.equal(blocks.length, 3);
  const groups = migrator.groupHistoryBlocks(blocks);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].start, "2026-01-02");
  assert.equal(groups[0].end, "2026-01-02");
  assert.equal(groups[0].blocks.length, 2);
  assert.equal(groups[1].start, "2026-01-05");
});

// ─── T-TS-002 / MS-2: upgrade auto-repair (opt-in) ──────────────────────────

test("auto-repair config defaults to off and rejects malformed input", (t) => {
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  // No config file at all -> off.
  assert.equal(migrator.autoRepairEnabled(cwd), false);
  assert.deepEqual(migrator.readAutoRepairConfig(cwd), { taskState: false });

  // Malformed JSON -> off, never throws.
  const configDir = path.join(cwd, ".agent", "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "auto-repair.json"), "{ not json", "utf8");
  assert.equal(migrator.autoRepairEnabled(cwd), false);

  // Explicit false -> off.
  fs.writeFileSync(
    path.join(configDir, "auto-repair.json"),
    JSON.stringify({ task_state: false }),
    "utf8",
  );
  assert.equal(migrator.autoRepairEnabled(cwd), false);

  // Explicit true -> on.
  fs.writeFileSync(
    path.join(configDir, "auto-repair.json"),
    JSON.stringify({ task_state: true }),
    "utf8",
  );
  assert.equal(migrator.autoRepairEnabled(cwd), true);
  assert.equal(migrator.readAutoRepairConfig(cwd).taskState, true);
});

test("upgrade auto-repair stays read-only without opt-in and migrates with it", (t) => {
  const { runTaskStateAutoRepair } = require(path.join(ROOT, "lib", "commands", "upgrade.js"));

  // --- case 1: no opt-in -> warning only, nothing written ---------------
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8");
  const warn = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warn.push(args.join(" ")); };
  let readOnly;
  try {
    readOnly = runTaskStateAutoRepair({ cwd, lang: "zh" }, { allowApply: true });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(readOnly.applied, false);
  assert.equal(readOnly.written, undefined);
  assert.equal(fs.existsSync(path.join(cwd, ".agent", "tasks", "T-LEG-001.json")), false);
  assert.equal(
    fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8"),
    before,
  );
  assert.match(warn.join("\n"), /旧版任务状态布局/);

  // --- case 2: opt-in -> migration runs ---------------------------------
  const configDir = path.join(cwd, ".agent", "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "auto-repair.json"),
    JSON.stringify({ task_state: true }),
    "utf8",
  );
  const log = [];
  const origLog = console.log;
  console.log = (...args) => { log.push(args.join(" ")); };
  let repaired;
  try {
    repaired = runTaskStateAutoRepair({ cwd, lang: "zh" }, { allowApply: true });
  } finally {
    console.log = origLog;
  }
  assert.equal(repaired.applied, true);
  assert.ok(repaired.written.length > 0);
  assert.equal(fs.existsSync(path.join(cwd, ".agent", "tasks", "T-LEG-001.json")), true);
  const view = fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8");
  assert.match(view, /generated:task-progress v1/);
  assert.ok(!/T-HIST-001/.test(view), "history must be archived, not kept in the live view");
});

test("upgrade auto-repair honors allowApply=false (dry-run never mutates)", (t) => {
  const { runTaskStateAutoRepair } = require(path.join(ROOT, "lib", "commands", "upgrade.js"));
  const cwd = legacyProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const configDir = path.join(cwd, ".agent", "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "auto-repair.json"),
    JSON.stringify({ task_state: true }),
    "utf8",
  );
  const before = fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8");
  const origWarn = console.warn;
  console.warn = () => {};
  let res;
  try {
    res = runTaskStateAutoRepair({ cwd, lang: "en" }, { allowApply: false });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(res.applied, false);
  assert.equal(fs.existsSync(path.join(cwd, ".agent", "tasks", "T-LEG-001.json")), false);
  assert.equal(
    fs.readFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "utf8"),
    before,
  );
});
