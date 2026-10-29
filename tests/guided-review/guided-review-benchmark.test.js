"use strict";

// ─── Guided Review Benchmark Dataset (Harness Phase 9 / P-001) ──────────────
//
// 这份数据集的价值全在「它会不会把什么都不做的候选判成满分」。所以这里跑三个
// 真实候选，而不是 mock：
//
//   reference — 走 builtin reviewer backend 的真实产物 → 10000 bp
//   noop     — 什么都不做 → 必须显著更低
//   lenient  — 把拿到的 finding 原样写出去、完全不校验 → 必须落在两者之间
//
// lenient 是关键：它证明 finding_absent 断言有牙齿。一个只会「找到多少算多少」
// 的后端能通过全部 finding_present，却必须被 absent 断言扣分——否则数据集只能
// 证明「实现没坏」，发现不了「实现开始乱报」。
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const RUNNER = path.join(ROOT, "scripts", "agent-review-benchmark-runner.cjs");
const DATASET = path.join(ROOT, "benchmarks", "guided-review", "cortex-agent-review", "dataset.json");

function run(candidate, extra = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-guided-review-test-"));
  const output = path.join(directory, "summary.json");
  const result = spawnSync(process.execPath, [
    RUNNER, "run",
    "--dataset", DATASET,
    "--candidate", candidate,
    "--output", output,
    ...extra,
  ], { encoding: "utf8" });
  const summary = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
  const diagnostics = fs.existsSync(`${output}.diagnostics.json`)
    ? JSON.parse(fs.readFileSync(`${output}.diagnostics.json`, "utf8"))
    : null;
  return { result, directory, output, summary, diagnostics };
}

function failedAssertions(diagnostics) {
  const failed = [];
  for (const item of diagnostics.cases) {
    for (const assertion of item.assertions) {
      if (!assertion.ok) failed.push(assertion);
    }
  }
  return failed;
}

test("reference 候选跑出满分", (t) => {
  const run1 = run("reference", ["--min-quality-bp", "10000"]);
  t.after(() => fs.rmSync(run1.directory, { recursive: true, force: true }));

  assert.equal(run1.result.status, 0, run1.result.stderr);
  const report = JSON.parse(run1.result.stdout.trim().split("\n").pop());
  assert.equal(report.ok, true);
  assert.equal(report.dataset_id, "cortex-agent-review");
  assert.equal(report.quality_basis_points, 10000);
  assert.ok(report.total_assertions >= 8, "数据集必须有足够断言才能有区分力");
  assert.deepEqual(failedAssertions(run1.diagnostics), []);
});

test("noop 候选显著低于参考实现", (t) => {
  const run1 = run("noop", ["--max-quality-bp", "5000"]);
  t.after(() => fs.rmSync(run1.directory, { recursive: true, force: true }));

  assert.equal(run1.result.status, 0, run1.result.stderr);
  const report = JSON.parse(run1.result.stdout.trim().split("\n").pop());
  assert.ok(
    report.quality_basis_points < 5000,
    `noop 应当显著低于 5000，实际 ${report.quality_basis_points}`
  );
  assert.ok(
    report.quality_basis_points < 10000,
    "noop 不得与 reference 同分，否则数据集没有区分力"
  );
});

test("lenient 候选（不校验的审查器）落在 noop 与 reference 之间", (t) => {
  const reference = run("reference");
  const noop = run("noop");
  const lenient = run("lenient");
  t.after(() => {
    for (const item of [reference, noop, lenient]) fs.rmSync(item.directory, { recursive: true, force: true });
  });

  const score = (item) => JSON.parse(item.result.stdout.trim().split("\n").pop()).quality_basis_points;
  assert.ok(score(lenient) > score(noop), `lenient(${score(lenient)}) 应当高于 noop(${score(noop)})`);
  assert.ok(score(lenient) < score(reference), `lenient(${score(lenient)}) 应当低于 reference(${score(reference)})`);
});

test("finding_absent 断言确实有牙齿：不校验的后端必须因此失分", (t) => {
  const lenient = run("lenient");
  t.after(() => fs.rmSync(lenient.directory, { recursive: true, force: true }));

  const failed = failedAssertions(lenient.diagnostics);
  const absentFailures = failed.filter((assertion) => assertion.kind === "finding_absent");
  assert.ok(
    absentFailures.length >= 3,
    `不校验的后端至少应当在 3 条 finding_absent 上失分，实际 ${absentFailures.length}`
  );

  // 它同样不得通过 schema 校验：风险等级写着 blocker 的 finding 不该出现在
  // artifact 里。
  assert.ok(
    failed.some((assertion) => assertion.kind === "artifact_schema_valid"),
    "不校验的后端产出的 artifact 不该通过 schema 校验"
  );
});

test("质量分越界时退出码为 1", (t) => {
  const below = run("noop", ["--min-quality-bp", "10000"]);
  t.after(() => fs.rmSync(below.directory, { recursive: true, force: true }));

  assert.equal(below.result.status, 1, below.result.stderr);
  const lines = below.result.stdout.trim().split("\n");
  assert.equal(lines.length, 2, `应当先打印结果行再打印错误行，实际：${below.result.stdout}`);
  assert.equal(JSON.parse(lines[0]).ok, true);
  const failure = JSON.parse(lines[1]);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "quality_below_threshold");
});
