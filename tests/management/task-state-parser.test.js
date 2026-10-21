"use strict";

// MS-1 (task-state-truth-source): parser hardening contract.
// - multiple active-tasks sections: last section with task rows wins
// - heading present but no task table: malformed, NO whole-file fallback
// - fallback (no heading): blockquote/code-fence lines are not task lists

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_PARSER = path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js");
const LIVE_PARSER = path.join(ROOT, ".agent", "tasks", "scripts", "task-state.js");
const { parseTaskProgress } = require(TEMPLATE_PARSER);

test("multiple active sections: the last section with task rows wins", () => {
  const md = [
    "# Task progress",
    "",
    "## Active Tasks",
    "",
    "| Task ID | Priority | Task | Progress | Plan |",
    "| --- | --- | --- | --- | --- |",
    "| T-OLD-001 | P1 | stale table | 10% | - |",
    "",
    "## Active Tasks",
    "",
    "| Task ID | Priority | Task | Progress | Plan |",
    "| --- | --- | --- | --- | --- |",
    "| T-NEW-001 | P0 | fresh table | 40% | - |",
    "",
    "## Roadmap",
  ].join("\n");
  const tasks = parseTaskProgress(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "T-NEW-001");
  assert.equal(tasks.malformed, undefined);
});

test("malformed active section returns empty with diagnostics and never falls back", () => {
  const md = [
    "# Task progress",
    "",
    "> **2026-01-01 closeout**: T-HIST-001 finished and merged",
    "",
    "## 当前活跃任务",
    "",
    "### M-013 milestone snapshot",
    "",
    "| SP | 描述 | 负责人 | Commit | 状态 | 进度 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| SP-001 | Freeze schema | owner | abc | PASS | 44/44 |",
    "",
    "T-STRAY-001 is mentioned in prose below the table.",
  ].join("\n");
  const tasks = parseTaskProgress(md);
  assert.equal(tasks.length, 0);
  assert.equal(tasks.malformed, true);
  assert.equal(tasks.diagnostics, "active_tasks_section_malformed");
  assert.equal(JSON.stringify(tasks), "[]");
});

test("fallback ignores blockquotes and fenced code blocks", () => {
  const md = [
    "# Task progress",
    "",
    "> T-QUOTED-001 done in a history closeout block",
    "```",
    "- [ ] T-FENCED-001 example inside a code fence",
    "```",
    "- [ ] T-REAL-001 actual list item 进行中",
  ].join("\n");
  const tasks = parseTaskProgress(md);
  assert.deepEqual(tasks.map((t) => t.id), ["T-REAL-001"]);
  assert.equal(tasks[0].status, "active");
});

test("legacy list-only project (no heading) keeps fallback behavior", () => {
  const md = [
    "# Tasks",
    "",
    "- [x] T-LEGACY-001 finished work 完成",
    "- [ ] T-LEGACY-002 pending work",
  ].join("\n");
  const tasks = parseTaskProgress(md);
  assert.deepEqual(tasks.map((t) => t.id), ["T-LEGACY-001", "T-LEGACY-002"]);
  assert.equal(tasks[0].status, "done");
  assert.equal(tasks[1].status, "open");
});

test("management/dashboard fixture regression: validation state stays separate from blocking", () => {
  const md = [
    "# Task progress",
    "",
    "## Active Tasks",
    "",
    "| Task ID | Priority | Task | Progress | Plan |",
    "| --- | --- | --- | --- | --- |",
    "| M-005 | P1 | Observability | 94% | Runtime evidence PARTIAL; release evidence remains NOT_RUN |",
    "| T-004 | P1 | Target benchmark | 65% | Two target environments remain NOT_RUN |",
    "| T-009 | P0 | Explicit blocker | 20% | Status: blocked |",
  ].join("\n");
  const tasks = new Map(parseTaskProgress(md).map((t) => [t.id, t]));
  assert.equal(tasks.get("M-005").status, "active");
  assert.equal(tasks.get("M-005").validation_status, "NOT_RUN");
  assert.equal(tasks.get("T-004").status, "active");
  assert.equal(tasks.get("T-004").validation_status, "NOT_RUN");
  assert.equal(tasks.get("T-009").status, "blocked");
});

test("zh heading parses via the table path", () => {
  const md = [
    "# 任务进度",
    "",
    "## 🔥 当前活跃任务",
    "",
    "| 任务 ID | 优先级 | 任务说明 | 进度 | 关联计划 |",
    "| :--- | :--- | :--- | :--- | :--- |",
    "| T-ZH-001 | P0 | 解析器加固 | 55% | [.agent/plans/x.md] |",
  ].join("\n");
  const tasks = parseTaskProgress(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "T-ZH-001");
  assert.equal(tasks[0].progress, "55%");
});

test("template and live parser copies stay byte-identical", () => {
  assert.equal(
    fs.readFileSync(TEMPLATE_PARSER, "utf8"),
    fs.readFileSync(LIVE_PARSER, "utf8"),
  );
});

test("current project task-progress.md parses to a real table, not phantoms", () => {
  const live = fs.readFileSync(path.join(ROOT, ".agent", "plans", "task-progress.md"), "utf8");
  const tasks = parseTaskProgress(live);
  assert.ok(tasks.length > 0, "expected table-path tasks");
  assert.equal(tasks.malformed, undefined);
  assert.ok(tasks.every((t) => /^(?:T|M)-[A-Za-z0-9-]+$/.test(t.id)));
  assert.ok(tasks.length < 40, `expected the real table, got ${tasks.length} rows`);
});

// ─── MS-3: structured truth source projection ───────────────────────────────

test("table columns are mapped by header meaning, not position", () => {
  const md = [
    "## 当前活跃任务",
    "",
    "| 任务 ID | 优先级 | Milestone | 描述 | 进度 |",
    "| :--- | :--- | :--- | :--- | :--- |",
    "| T-FIVE-001 | P1 | MS-002 | 五列布局 | 60% |",
  ].join("\n");
  const tasks = parseTaskProgress(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "五列布局");
  assert.equal(tasks[0].progress, "60%");
  // The table declares no plan column: reading it positionally would
  // report the progress as the plan.
  assert.equal(tasks[0].plan, "");
});

test("a declared plan column is read from the header, not from index 4", () => {
  const md = [
    "## 当前活跃任务",
    "",
    "| 任务 ID | 优先级 | 描述 | 进度 | 关联计划 |",
    "| :--- | :--- | :--- | :--- | :--- |",
    "| T-FIVE-002 | P0 | 五列带计划 | 80% | .agent/plans/x.md |",
  ].join("\n");
  const tasks = parseTaskProgress(md);
  assert.equal(tasks[0].title, "五列带计划");
  assert.equal(tasks[0].progress, "80%");
  assert.equal(tasks[0].plan, ".agent/plans/x.md");
});

function projectFixture({ taskProgress, tasks = [], missions = [] }) {
  const fs = require("node:fs");
  const os = require("node:os");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-truth-source-"));
  fs.mkdirSync(path.join(cwd, ".agent", "plans"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "missions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), taskProgress, "utf8");
  for (const record of tasks) {
    fs.writeFileSync(
      path.join(cwd, ".agent", "tasks", record.task_id + ".json"),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }
  for (const record of missions) {
    const dir = path.join(cwd, ".agent", "missions", record.mission_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mission.json"), JSON.stringify(record, null, 2), "utf8");
  }
  return cwd;
}

const STRUCTURED_TASK = {
  task_id: "T-STR-001",
  title: "结构化任务",
  status: "active",
  stage: "implement",
  priority: "P0",
  source_refs: [".agent/plans/structured.md"],
  gates: [
    { from_stage: "implement", to_stage: "validate", status: "blocked", required_artifacts: [], evidence_refs: [] },
  ],
};

test("structured records are the truth source for a generated view", (t) => {
  const { resolveTaskState } = require(TEMPLATE_PARSER);
  const cwd = projectFixture({
    taskProgress: [
      "# 任务进度",
      "",
      "<!-- generated:task-progress v1; source=.agent/tasks,index.json; 请勿手改生成区 -->",
      "",
      "## 🔥 当前活跃任务",
      "",
      "| T-STR-001 | P0 | 结构化任务 | 55% | x |",
      "",
    ].join("\n"),
    tasks: [STRUCTURED_TASK],
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const resolved = resolveTaskState({ projectRoot: cwd });
  assert.equal(resolved.source, "structured");
  assert.equal(resolved.tasks.length, 1);
  assert.equal(resolved.tasks[0].id, "T-STR-001");
  assert.equal(resolved.tasks[0].progress, "55%");
  assert.equal(resolved.tasks[0].status, "active");
  // The validate gate is blocked -> FAIL, never NOT_RUN.
  assert.equal(resolved.tasks[0].validation_status, "FAIL");
});

test("a legacy view keeps tasks that were never migrated", (t) => {
  const { resolveTaskState } = require(TEMPLATE_PARSER);
  const cwd = projectFixture({
    taskProgress: [
      "# Task progress",
      "",
      "## Active Tasks",
      "",
      "| Task ID | Priority | Task | Progress | Plan |",
      "| --- | --- | --- | --- | --- |",
      "| T-LEG-001 | P1 | 旧版任务 | 30% | - |",
      "",
    ].join("\n"),
    tasks: [STRUCTURED_TASK],
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const resolved = resolveTaskState({ projectRoot: cwd });
  assert.equal(resolved.source, "merged");
  const ids = resolved.tasks.map((task) => task.id).sort();
  // The unmigrated markdown task must not disappear just because some
  // structured records exist.
  assert.deepEqual(ids, ["T-LEG-001", "T-STR-001"]);
});

test("a structured record wins over a markdown row with the same id", (t) => {
  const { resolveTaskState } = require(TEMPLATE_PARSER);
  const cwd = projectFixture({
    taskProgress: [
      "# Task progress",
      "",
      "## Active Tasks",
      "",
      "| Task ID | Priority | Task | Progress | Plan |",
      "| --- | --- | --- | --- | --- |",
      "| T-STR-001 | P9 | stale markdown title | 10% | - |",
      "",
    ].join("\n"),
    tasks: [STRUCTURED_TASK],
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const resolved = resolveTaskState({ projectRoot: cwd });
  assert.equal(resolved.tasks.length, 1);
  assert.equal(resolved.tasks[0].title, "结构化任务");
  assert.equal(resolved.tasks[0].progress, "55%");
});

test("no structured records at all falls back to the markdown view", (t) => {
  const { resolveTaskState } = require(TEMPLATE_PARSER);
  const cwd = projectFixture({
    taskProgress: [
      "# Task progress",
      "",
      "## Active Tasks",
      "",
      "| Task ID | Priority | Task | Progress | Plan |",
      "| --- | --- | --- | --- | --- |",
      "| T-ONLY-001 | P1 | 唯一任务 | 20% | - |",
      "",
    ].join("\n"),
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const resolved = resolveTaskState({ projectRoot: cwd });
  assert.equal(resolved.source, "markdown");
  assert.equal(resolved.tasks.length, 1);
  assert.equal(resolved.tasks[0].id, "T-ONLY-001");
});

test("mission.json is projected into the same task shape", (t) => {
  const { resolveTaskState } = require(TEMPLATE_PARSER);
  const cwd = projectFixture({
    taskProgress: "# 任务进度\n\n<!-- generated:task-progress v1 -->\n",
    missions: [
      {
        mission_id: "M-900",
        title: "活跃 Mission",
        status: "active",
        stage: "validate",
        priority: "P0",
        progress: "75%",
        source_refs: [".agent/missions/M-900/mission-plan.md"],
        gates: [],
      },
    ],
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const resolved = resolveTaskState({ projectRoot: cwd });
  assert.equal(resolved.source, "structured");
  assert.equal(resolved.tasks.length, 1);
  assert.equal(resolved.tasks[0].id, "M-900");
  assert.equal(resolved.tasks[0].progress, "75%");
});

test("countActiveTasksStructured follows the merged view", (t) => {
  const { countActiveTasksStructured } = require(TEMPLATE_PARSER);
  const cwd = projectFixture({
    taskProgress: [
      "# Task progress",
      "",
      "## Active Tasks",
      "",
      "| Task ID | Priority | Task | Progress | Plan |",
      "| --- | --- | --- | --- | --- |",
      "| T-LEG-001 | P1 | 旧版任务 | 30% | - |",
      "",
    ].join("\n"),
    tasks: [STRUCTURED_TASK],
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  // Both the structured active task and the unmigrated markdown task count.
  assert.equal(countActiveTasksStructured({ projectRoot: cwd }), 2);
  assert.equal(countActiveTasksStructured({ projectRoot: path.join(ROOT, "tests") }), null);
});

