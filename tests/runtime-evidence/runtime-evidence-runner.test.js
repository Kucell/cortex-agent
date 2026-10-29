"use strict";

// ─── Runtime Evidence Runner (Harness Phase 9 / P-002) ──────────────────────
//
// 为什么这套测试要跑真实数据集：
//   这个 runner 的价值全在「它会不会撒谎」——把一个什么都没做的候选判成
//   pass，就是最严重的失败模式。所以测试不 mock 任何一层，直接跑真实的
//   event-bus 数据集，验证参考实现满分、空实现显著更低。
//
// 为什么所有产物都写进 os.tmpdir()：
//   全量测试跑在 strict-hermetic 门禁下（.agent/rules/test-policy.md §3.4），
//   测试期间不允许往 .agent/ 写一个字节。数据集自己的 workspace 由引擎在
//   临时目录里物化，--output 再指向另一个临时目录，仓库工作区全程零写入。
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const RUNNER = path.join(ROOT, "scripts", "runtime-evidence-runner.cjs");
const DATASET = path.join(ROOT, "benchmarks", "runtime-evidence", "event-bus", "dataset.json");

function run(candidate, extra = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-runtime-evidence-test-"));
  const output = path.join(directory, "verification-summary.json");
  const result = spawnSync(process.execPath, [
    RUNNER, "run",
    "--dataset", DATASET,
    "--candidate", candidate,
    "--output", output,
    ...extra,
  ], { encoding: "utf8" });
  const summary = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
  return { result, directory, output, summary };
}

function lines(text) {
  return String(text || "").split("\n").filter((line) => line.trim().length > 0);
}

test("reference 数据集跑出满分 pass，并写出契约规定的 summary 形状", (t) => {
  const run1 = run("reference", ["--min-quality-bp", "10000"]);
  t.after(() => fs.rmSync(run1.directory, { recursive: true, force: true }));

  assert.equal(run1.result.status, 0, run1.result.stderr);

  const stdout = lines(run1.result.stdout);
  assert.equal(stdout.length, 1, `stdout 应当恰好一行 JSON，实际：${run1.result.stdout}`);
  const report = JSON.parse(stdout[0]);
  assert.equal(report.ok, true);
  assert.equal(report.dataset_id, "runtime-evidence-event-bus");
  assert.equal(report.candidate_id, "reference");
  assert.equal(report.quality_basis_points, 10000);
  assert.equal(report.overall_status, "pass");
  assert.equal(report.output, path.join(run1.directory, "verification-summary.json"));

  const summary = run1.summary;
  assert.ok(summary, "summary 文件应当被写出");
  assert.equal(summary.triggered_by, "runtime-evidence-runner");
  assert.equal(summary.overall_status, "pass");
  assert.equal(summary.quality_basis_points, 10000);
  assert.equal(summary.dataset_id, "runtime-evidence-event-bus");
  assert.equal(summary.candidate_id, "reference");
  assert.match(summary.generated_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  // 覆盖度取值集合是契约的一部分：UI / trace 层这份数据集没碰，必须明说跳过。
  assert.equal(summary.coverage.ui, "skipped");
  assert.equal(summary.coverage.api, "full");
  assert.equal(summary.coverage.trace, "skipped");

  assert.deepEqual(summary.results.ui, { status: "not_run", paths_checked: 0, screenshot_paths: [] });
  assert.equal(summary.results.trace.status, "skipped");
  assert.equal(summary.results.trace.reason, "runtime-evidence 数据集不覆盖 trace 层");
  assert.deepEqual(summary.warnings, []);
  assert.deepEqual(summary.blockers, []);

  // results.api.status 必须与 overall_status 一致，否则「总体通过」和「API 层
  // 实际没验过」可以同时出现在同一份产物里。
  assert.equal(summary.results.api.status, summary.overall_status);
  assert.equal(summary.results.api.status, "pass");
  assert.equal(summary.results.api.cases_checked, 1);
  assert.equal(summary.results.api.passed_assertions, summary.results.api.endpoints_checked);
  assert.equal(summary.results.api.total_assertions, summary.results.api.passed_assertions);
});

test("noop 数据集显著低于参考实现，blockers 逐条列出失败的断言", (t) => {
  const run1 = run("noop", ["--max-quality-bp", "5000"]);
  t.after(() => fs.rmSync(run1.directory, { recursive: true, force: true }));

  assert.equal(run1.result.status, 0, run1.result.stderr);

  const report = JSON.parse(lines(run1.result.stdout)[0]);
  assert.equal(report.ok, true);
  assert.ok(report.quality_basis_points < 5000, `noop 应当显著低于 5000，实际 ${report.quality_basis_points}`);
  assert.ok(["fail", "partial"].includes(report.overall_status), report.overall_status);

  const summary = run1.summary;
  assert.equal(summary.quality_basis_points, report.quality_basis_points);
  assert.equal(summary.results.api.status, summary.overall_status);
  assert.equal(summary.coverage.api, "minimal");
  assert.ok(summary.blockers.length > 0, "noop 必须留下阻塞项，否则数据集没有区分力");
  for (const blocker of summary.blockers) {
    assert.deepEqual(Object.keys(blocker).sort(), ["assertion_id", "case_id", "kind"]);
    assert.equal(blocker.case_id, "event-bus-publish-then-list");
    assert.equal(typeof blocker.assertion_id, "string");
    assert.equal(typeof blocker.kind, "string");
  }
  // 阻塞项数量必须和「没过的断言数」对得上，否则这份产物会低估问题。
  assert.equal(summary.blockers.length, summary.results.api.total_assertions - summary.results.api.passed_assertions);
});

test("质量分低于下限时退出码为 1，并且成功那行 JSON 已经打印", (t) => {
  const run1 = run("noop", ["--min-quality-bp", "10000"]);
  t.after(() => fs.rmSync(run1.directory, { recursive: true, force: true }));

  assert.equal(run1.result.status, 1, run1.result.stderr);

  const stdout = lines(run1.result.stdout);
  assert.equal(stdout.length, 2, `应当先打印结果行再打印错误行，实际：${run1.result.stdout}`);
  const report = JSON.parse(stdout[0]);
  assert.equal(report.ok, true);
  assert.ok(report.quality_basis_points < 10000);
  const failure = JSON.parse(stdout[1]);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "quality_below_threshold");
});

test("参数缺失时退出码为 2，并打印一行可解析的错误 JSON", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-runtime-evidence-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [RUNNER, "run", "--candidate", "reference"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  const stdout = lines(result.stdout);
  assert.equal(stdout.length, 1, result.stdout);
  const failure = JSON.parse(stdout[0]);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "dataset_required");
});
