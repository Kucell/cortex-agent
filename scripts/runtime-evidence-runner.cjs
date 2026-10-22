#!/usr/bin/env node
"use strict";

// ─── Runtime Evidence Runner (Harness Phase 9 / P-002) ──────────────────────
//
// 为什么要有这个脚本：
//   Phase 8 定义了「应用可理解性」三件套的证据契约（`verification-summary.json`
//   等），但生产端一直是空的 —— 没有任何东西能把 `results.api.status` 从
//   "not_run" 变成 "pass" / "fail"，契约只能靠人手写。本脚本就是那个生产端：
//   跑一个真实数据集，把机械断言的结果翻译成契约规定的字段集合。
//
// 为什么复用 agent-review-benchmark-runner 而不是重写一套评分器：
//   两个 runner 需要的断言语义完全相同（同样的 kind、同样的 workspace 物化、
//   同样的 basis-point 计分）。评分器只有一份，两条链路才不会给出互相矛盾的
//   数字；本脚本只负责「输出契约」的转换层。
//
// 三条硬约束：
//   1. stdout 恰好一行 JSON。CI 门禁按行解析，混入多余输出就会误判。
//   2. 退出码语义：0 = 达标；1 = 质量分越界（低于下限或高于上限）；
//      2 = 参数或数据集非法。
//   3. 质量分越界时，那行成功 JSON 必须已经打印 —— 否则调用方只看到一个没有
//      上下文的失败，拿不到实际分数，也就没法判断是回归还是阈值设错了。
//
// 用法：
//   node scripts/runtime-evidence-runner.cjs run \
//     --dataset benchmarks/runtime-evidence/<id>/dataset.json \
//     --candidate reference \
//     --output .agent/metrics/verification-summary.json \
//     [--min-quality-bp 10000] [--max-quality-bp 5000] \
//     [--now 2026-01-01T00:00:00.000Z]
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  findSkillScript,
  parseArgs,
  runBenchmark,
} = require("./agent-review-benchmark-runner.cjs");

// 写进产物里的触发方标识：下游看到这份 summary 时要知道是谁生成的，
// 免得把它误当成某个测试自己编出来的数。
// 仓库健康度由 generate-summary.js 拥有，runner 不产出也不覆盖。
const HEALTH_FIELDS = [
  "components",
  "repo_health_status",
  "repo_health_score",
  "actions_needed",
  "next_check_recommended",
];

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const TRIGGERED_BY = "runtime-evidence-runner";

function fail(error, details, code = 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, details })}\n`);
  // 用 exitCode 而不是 process.exit()：stdout 接到管道时在 macOS 上是异步
  // 写的，process.exit() 会在缓冲区落盘前掐断进程，错误行会被截成半行 JSON。
  process.exitCode = code;
  return null;
}

// 把一次执行的结果翻译成契约规定的形状。抽成纯函数是为了让「形状」可以被
// 单测直接断言，而不必真的跑一遍数据集。
//
// 状态映射是契约里最硬的部分：分数满 = 覆盖完整 = pass；分数为零 = 完全没
// 验到东西 = fail；中间地带只能算 partial —— 把它说成 pass 就是把「验了一
// 部分」谎报成「全过了」。
function toVerificationSummary(input) {
  const {
    qualityBasisPoints,
    passedAssertions,
    totalAssertions,
    cases,
    datasetId,
    candidateId,
    generatedAt,
  } = input;

  const overallStatus = qualityBasisPoints === 10000
    ? "pass"
    : qualityBasisPoints === 0
      ? "fail"
      : "partial";

  // 阻塞项按 case_id 再按断言出现顺序排列：同一个 case 内保留原始断言顺序，
  // 读者才能对着数据集一眼看出「卡在哪一条」。
  const blockers = [];
  for (const item of [...cases].sort((left, right) => left.case_id.localeCompare(right.case_id))) {
    for (const detail of item.details || []) {
      if (detail.ok) continue;
      blockers.push({ case_id: item.case_id, assertion_id: detail.id, kind: detail.kind });
    }
  }

  return {
    generated_at: generatedAt,
    triggered_by: TRIGGERED_BY,
    overall_status: overallStatus,
    coverage: {
      ui: "skipped",
      api: overallStatus === "pass" ? "full" : "minimal",
      trace: "skipped",
    },
    results: {
      ui: { status: "not_run", paths_checked: 0, screenshot_paths: [] },
      api: {
        status: overallStatus,
        // 每条断言视为一次端点/行为检查，所以「查过多少端点」等于通过的
        // 断言条数，而不是数据集里写了多少条。
        endpoints_checked: passedAssertions,
        cases_checked: cases.length,
        passed_assertions: passedAssertions,
        total_assertions: totalAssertions,
        // 数据集不测错误率变化，但字段集必须与空壳一致——否则两个生产方
        // 写出的 results.api 结构会随谁最后写而漂移。
        error_rate_delta: null,
      },
      trace: { status: "skipped", reason: "runtime-evidence 数据集不覆盖 trace 层" },
    },
    blockers,
    warnings: [],
    quality_basis_points: qualityBasisPoints,
    dataset_id: datasetId,
    candidate_id: candidateId,
  };
}

// 本地先做一遍数据集校验。引擎内部的 fail() 直接 process.exit()，stdout 接到
// 管道时（macOS）可能被截断成半行 JSON，调用方连错误类型都读不出来。这里
// 先挡住最常见的非法数据集，错误行才完整可读。
function readDataset(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    return { ok: false, error: "invalid_dataset", details: error.message };
  }
  for (const field of ["dataset_id", "dataset_version", "cases"]) {
    if (!raw[field]) return { ok: false, error: "invalid_dataset", details: `missing ${field}` };
  }
  if (!Array.isArray(raw.cases) || !raw.cases.length) {
    return { ok: false, error: "invalid_dataset", details: "cases must be a non-empty array" };
  }
  return { ok: true, value: raw };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command !== "run") return fail("unknown_command", args.command || "<none>", 2);
  if (!args.dataset) return fail("dataset_required", "Pass --dataset <dataset.json>.", 2);
  if (!args.candidate) return fail("candidate_required", "Pass --candidate <id>.", 2);
  if (!args.output) return fail("output_required", "Pass --output <file>.", 2);

  const dataset = readDataset(args.dataset);
  if (!dataset.ok) return fail(dataset.error, dataset.details, 2);
  if (!findSkillScript()) {
    return fail("skill_missing", "agent-review-benchmark skill script not found", 2);
  }
  const missingCandidates = dataset.value.cases
    .filter((item) => !(item.candidates || {})[args.candidate])
    .map((item) => item.case_id);
  if (missingCandidates.length) {
    return fail("unknown_candidate", { candidate_id: args.candidate, case_ids: missingCandidates }, 2);
  }

  // 引擎自己也会往 --output 写一份基准摘要和诊断文件，但那份摘要不是本脚本
  // 的产物契约。给它一个临时落点，最终只写契约要求的那两个文件。
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-runtime-evidence-"));
  let result;
  try {
    result = runBenchmark({ ...args, output: path.join(scratch, "benchmark-summary.json") });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const candidate = result.summary.candidates[0];
  const qualityBasisPoints = candidate.quality_basis_points;
  const target = path.resolve(args.output);
  const summary = toVerificationSummary({
    qualityBasisPoints,
    passedAssertions: candidate.passed_assertions,
    totalAssertions: candidate.total_assertions,
    cases: result.executed,
    datasetId: result.summary.dataset_id,
    candidateId: candidate.candidate_id,
    generatedAt: args.now || new Date().toISOString(),
  });

  // 两个生产方写同一个文件：runner 只拥有验证侧，仓库健康度是
  // generate-summary.js 写的。覆盖会把对方的结论抹掉——所以两边都只写
  // 自己拥有的字段，谁最后写都不丢另一边的数据。
  const existing = readJsonIfExists(target);
  for (const field of HEALTH_FIELDS) {
    if (existing && existing[field] !== undefined) summary[field] = existing[field];
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`);
  // 逐断言明细单独成文件：契约里的 summary 要稳定可读，而排查「为什么这条
  // 没过」需要的是每条断言的原始判定过程。
  fs.writeFileSync(`${target}.diagnostics.json`, `${JSON.stringify({
    dataset_id: summary.dataset_id,
    candidate_id: summary.candidate_id,
    quality_basis_points: qualityBasisPoints,
    cases: result.executed.map((item) => ({
      case_id: item.case_id,
      weight: item.weight,
      passed_assertions: item.passed_assertions,
      total_assertions: item.total_assertions,
      duration_ms: item.duration_ms,
      exit_code: item.exit_code,
      assertions: item.details,
      stdout_tail: item.stdout_tail,
      stderr_tail: item.stderr_tail,
    })),
  }, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    dataset_id: summary.dataset_id,
    candidate_id: summary.candidate_id,
    quality_basis_points: qualityBasisPoints,
    passed_assertions: summary.results.api.passed_assertions,
    total_assertions: summary.results.api.total_assertions,
    overall_status: summary.overall_status,
    output: target,
  })}\n`);

  if (args["min-quality-bp"] !== undefined && qualityBasisPoints < Number(args["min-quality-bp"])) {
    return fail("quality_below_threshold", {
      quality_basis_points: qualityBasisPoints,
      required: Number(args["min-quality-bp"]),
    }, 1);
  }

  // 上限才是数据集「有区分力」的证据：一个什么都不做的候选必须显著低于参考
  // 实现。没有上限时，一份断言恒真的数据集面对坏掉的构建也会报满分。
  if (args["max-quality-bp"] !== undefined && qualityBasisPoints > Number(args["max-quality-bp"])) {
    return fail("quality_above_threshold", {
      quality_basis_points: qualityBasisPoints,
      required: Number(args["max-quality-bp"]),
    }, 1);
  }

  return summary;
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseArgs,
  readDataset,
  toVerificationSummary,
};
