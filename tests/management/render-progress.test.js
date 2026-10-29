"use strict";

// T-TS-003 / MS-3: view renderer contract.
// - the generated view is derived from the structured records
// - manual regions survive a render round trip
// - foreign marker blocks are preserved
// - `--check` reports drift and exits non-zero

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const LIVE_RENDERER = path.join(ROOT, ".agent", "tasks", "scripts", "render-progress.js");
const TEMPLATE_RENDERER = path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "render-progress.js");
// The live copy only exists in a checkout that materialises the governance
// repository. CI checks out the framework repository alone, so the template
// copy is the one under test there.
const LIVE_AVAILABLE = fs.existsSync(LIVE_RENDERER);
const RENDERER = LIVE_AVAILABLE ? LIVE_RENDERER : TEMPLATE_RENDERER;
const { renderView, extractManualRegion, extractForeignMarkers, STAGE_PROGRESS } = require(RENDERER);

const TASK = {
  task_id: "T-REN-001",
  title: "渲染任务",
  status: "active",
  stage: "implement",
  priority: "P0",
  source_refs: [".agent/plans/render.md"],
};

const DONE_TASK = {
  task_id: "T-REN-002",
  title: "已完成任务",
  status: "completed",
  stage: "done",
  priority: "P1",
  source_refs: [".agent/plans/done.md"],
};

test("the renderer derives the active table from the structured records", () => {
  const view = renderView({
    source: "",
    tasks: [TASK, DONE_TASK],
    missions: [],
    archives: [],
    now: "2026-10-21T00:00:00.000Z",
  });
  assert.match(view, /generated:task-progress v1/);
  assert.match(view, /\| T-REN-001 \| P0 \| 渲染任务 \| 55% \| .agent\/plans\/render\.md \|/);
  // A completed task is not an active task.
  assert.ok(!/T-REN-002/.test(view));
  // One of two tasks is done -> 50%.
  assert.match(view, /总体进度\*\*: 50%/);
});

test("manual regions survive a render round trip", () => {
  const source = [
    "# 任务进度",
    "",
    "## 🗺️ 路线图",
    "<!-- manual:roadmap:start -->",
    "- [x] 阶段 1: 基础设施",
    "<!-- manual:roadmap:end -->",
    "",
    "## ⏳ 未处理事项",
    "<!-- manual:backlog:start -->",
    "- [ ] 遗留：待确认口径",
    "<!-- manual:backlog:end -->",
    "",
    "## 🔌 断点续接",
    "<!-- manual:resume:start -->",
    "- [x] 阶段 1: 已完成（commit: abc1234）",
    "<!-- manual:resume:end -->",
    "",
  ].join("\n");
  const view = renderView({ source, tasks: [TASK], missions: [], archives: [], now: "2026-10-21T00:00:00.000Z" });
  assert.match(view, /阶段 1: 基础设施/);
  assert.match(view, /遗留：待确认口径/);
  assert.match(view, /阶段 1: 已完成（commit: abc1234）/);

  // A second render of the produced view must be a fixed point: the
  // renderer must not consume its own output.
  const again = renderView({ source: view, tasks: [TASK], missions: [], archives: [], now: "2026-10-21T00:00:00.000Z" });
  assert.equal(again, view);
});

test("a legacy view without markers still keeps its manual sections", () => {
  const source = [
    "# 任务进度",
    "",
    "## 🗺️ 路线图",
    "",
    "- 旧版路线图条目",
    "",
    "## 🔥 当前活跃任务",
    "",
    "| 任务 ID | 优先级 | 描述 | 进度 |",
    "| :--- | :--- | :--- | :--- |",
    "| T-OLD-001 | P1 | 旧版任务 | 30% |",
    "",
  ].join("\n");
  const view = renderView({ source, tasks: [TASK], missions: [], archives: [], now: "2026-10-21T00:00:00.000Z" });
  assert.match(view, /旧版路线图条目/);
});

test("foreign marker blocks are preserved verbatim", () => {
  const source = [
    "# 任务进度",
    "",
    "<!-- progress-reconcile:drift -->",
    "drift payload",
    "<!-- /progress-reconcile:drift -->",
    "",
  ].join("\n");
  const view = renderView({ source, tasks: [TASK], missions: [], archives: [], now: "2026-10-21T00:00:00.000Z" });
  assert.match(view, /<!-- progress-reconcile:drift -->/);
  assert.match(view, /drift payload/);
  assert.match(view, /<!-- \/progress-reconcile:drift -->/);
});

test("extractForeignMarkers ignores the regions the renderer owns", () => {
  const source = [
    "<!-- generated:active-tasks:start -->",
    "x",
    "<!-- generated:active-tasks:end -->",
    "<!-- manual:roadmap:start -->",
    "y",
    "<!-- manual:roadmap:end -->",
  ].join("\n");
  assert.deepEqual(extractForeignMarkers(source), []);
});

test("the archive index lists every archived segment", () => {
  const view = renderView({
    source: "",
    tasks: [],
    missions: [],
    archives: [
      { fileName: "2026-01-02.md", dateRange: ["2026-01-02", "2026-01-02"], items: 3 },
      { fileName: "2026-01-05--2026-01-09.md", dateRange: ["2026-01-05", "2026-01-09"], items: 7 },
    ],
    now: "2026-10-21T00:00:00.000Z",
  });
  assert.match(view, /\[2026-01-02--2026-01-02\]\(task-progress-archive\/2026-01-02\.md\)（3 条收口）/);
  assert.match(view, /\[2026-01-05--2026-01-09\]\(task-progress-archive\/2026-01-05--2026-01-09\.md\)（7 条收口）/);
});

test("the stage-to-progress mapping is the shared contract", () => {
  assert.equal(STAGE_PROGRESS.draft, 0);
  assert.equal(STAGE_PROGRESS.spec, 15);
  assert.equal(STAGE_PROGRESS.plan, 30);
  assert.equal(STAGE_PROGRESS.implement, 55);
  assert.equal(STAGE_PROGRESS.validate, 75);
  assert.equal(STAGE_PROGRESS.review, 90);
  assert.equal(STAGE_PROGRESS.done, 100);
});

test("the template and live renderer copies stay byte-identical", {
  skip: LIVE_AVAILABLE ? false : "live .agent copy is not part of this checkout",
}, () => {
  assert.equal(
    fs.readFileSync(LIVE_RENDERER, "utf8"),
    fs.readFileSync(TEMPLATE_RENDERER, "utf8"),
  );
});

test("render-progress --check exits non-zero when the view drifted", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-render-check-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".agent", "plans"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".agent", "tasks", "T-REN-001.json"),
    JSON.stringify(TASK, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(cwd, ".agent", "plans", "task-progress.md"), "# 任务进度\n", "utf8");

  const { spawnSync } = require("node:child_process");
  const result = spawnSync("node", [RENDERER, "--check", "--project", cwd], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);

  // After a render the check passes.
  const write = spawnSync("node", [RENDERER, "--project", cwd], { encoding: "utf8" });
  assert.equal(write.status, 0, write.stdout + write.stderr);
  const after = spawnSync("node", [RENDERER, "--check", "--project", cwd], { encoding: "utf8" });
  assert.equal(after.status, 0, after.stdout + after.stderr);
});

// The render timestamp records when the view was produced, not what it says.
// A gate that compared it would expire every midnight: the truth source
// unchanged, the view still faithful, and yet the date line no longer
// matching — a red gate with nothing to fix.
test("render-progress --check ignores the render timestamp but still catches drift", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-render-timestamp-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".agent", "plans"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".agent", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".agent", "tasks", "T-REN-001.json"),
    JSON.stringify(TASK, null, 2),
    "utf8",
  );

  const { spawnSync } = require("node:child_process");
  const write = spawnSync("node", [RENDERER, "--project", cwd], { encoding: "utf8" });
  assert.equal(write.status, 0, write.stdout + write.stderr);

  // A view rendered on a later day: only the timestamp line differs.
  const viewFile = path.join(cwd, ".agent", "plans", "task-progress.md");
  const rendered = fs.readFileSync(viewFile, "utf8");
  fs.writeFileSync(
    viewFile,
    rendered.replace(/^> \*\*最后更新时间\*\*: .*$/m, "> **最后更新时间**: 2030-12-31"),
    "utf8",
  );

  const check = spawnSync("node", [RENDERER, "--check", "--project", cwd], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);

  // Changing the record still drifts: the gate ignores the timestamp, not
  // the projection.
  fs.writeFileSync(
    path.join(cwd, ".agent", "tasks", "T-REN-001.json"),
    JSON.stringify({ ...TASK, stage: "done" }, null, 2),
    "utf8",
  );
  const drifted = spawnSync("node", [RENDERER, "--check", "--project", cwd], { encoding: "utf8" });
  assert.equal(drifted.status, 1, drifted.stdout + drifted.stderr);
});

// A checkout that does not carry the governance records cannot be judged.
// The gate must report "nothing to assert" instead of "the view drifted",
// otherwise every checkout without the records fails the build.
test("render-progress --check skips when the truth source is absent", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-render-nosource-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const { spawnSync } = require("node:child_process");
  const result = spawnSync("node", [RENDERER, "--check", "--project", cwd, "--json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.drifted, false);
  assert.equal(report.skipped, true);
});

