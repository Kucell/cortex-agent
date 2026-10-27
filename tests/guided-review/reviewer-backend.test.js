"use strict";

// ─── Reviewer Backend (Harness Phase 9 / P-001) ──────────────────────────────
//
// 为什么这套测试要跑真实后端而不是 mock：
//   后端的价值全在「它会不会把不合格的 finding 放行」。mock 掉校验层，测的
//   就只是 mock 自己。所以这里直接跑真实的 reviewer-backend.js，用真实的
//   schema 判定接受与拒绝。
//
// 为什么所有产物都写进 os.tmpdir()：
//   全量测试跑在 strict-hermetic 门禁下（.agent/rules/test-policy.md §3.4），
//   测试期间不允许往 .agent/ 写一个字节。
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const BACKEND = path.join(ROOT, ".agent", "skills", "agent-review-benchmark", "scripts", "reviewer-backend.js");

function temporary(prefix = "cortex-reviewer-backend-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeInput(directory, overrides = {}) {
  const input = {
    artifact_id: "GR-backend-contract",
    task_id: "T-H30",
    run_id: "R-backend-contract",
    session_id: "S-backend-contract",
    workspace_ids: ["WS-cortex-agent"],
    base_revision: "6b2c0f10",
    head_revision: "63e53de7",
    generated_at: "2026-10-22T00:00:00.000Z",
    changed_files: ["scripts/test-runner.cjs"],
    findings: [
      {
        group_id: "F-001",
        title: "子进程继承了 NODE_TEST_CONTEXT",
        intent: "让失败真实反映到退出码",
        files: ["scripts/test-runner.cjs"],
        summary: "node --test 失败也退出 0。",
        impact: "CI 绿灯但断言未执行。",
        risk: "high",
        category: "test",
        validation_refs: ["VC-01"],
        follow_ups: ["剥离该环境变量"],
      },
    ],
    ...overrides,
  };
  const file = path.join(directory, "review-input.json");
  fs.writeFileSync(file, `${JSON.stringify(input, null, 2)}\n`);
  return file;
}

function runBackend(args, directory) {
  const output = path.join(directory, "guided-review.json");
  const result = spawnSync(process.execPath, [BACKEND, ...args, "--output", output], {
    encoding: "utf8",
    cwd: directory,
  });
  const artifact = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : null;
  const diagnosticsFile = `${output}.diagnostics.json`;
  const diagnostics = fs.existsSync(diagnosticsFile) ? JSON.parse(fs.readFileSync(diagnosticsFile, "utf8")) : null;
  return { result, artifact, diagnostics, output };
}

test("builtin 后端接受合规 finding 并写出符合 schema 的 artifact", (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(directory, "scripts", "test-runner.cjs"), "// stub\n");

  const input = writeInput(directory);
  const run = runBackend(["--backend", "builtin", "--input", input], directory);

  assert.equal(run.result.status, 0, run.result.stderr);
  const report = JSON.parse(run.result.stdout.trim().split("\n").pop());
  assert.equal(report.ok, true);
  assert.equal(report.backend, "builtin");
  assert.equal(report.findings, 1);
  assert.equal(report.rejected, 0);

  assert.equal(run.artifact.type, "guided_review");
  assert.equal(run.artifact.artifact_id, "GR-backend-contract");
  assert.equal(run.artifact.groups.length, 1);
  assert.equal(run.artifact.groups[0].group_id, "F-001");
  assert.equal(run.artifact.summary.group_count, 1);
  assert.equal(run.artifact.summary.file_count, 1);
  assert.equal(run.artifact.summary.risk_counts.high, 1);
  assert.equal(run.artifact.summary.risk_counts.low, 0);
  assert.equal(run.artifact.summary.validation_ref_count, 1);
  assert.equal(run.artifact.summary.follow_up_count, 1);
});

test("三类不合格 finding 分别按 schema / changeset / 文件存在性被拒，并给出原因码", (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(directory, "scripts", "test-runner.cjs"), "// stub\n");

  const base = {
    group_id: "F-002",
    title: "越界审查",
    intent: "越界审查",
    files: ["lib/commands/init.js"],
    summary: "该文件不在 changeset 内。",
    impact: "污染审查范围。",
    risk: "low",
    category: "quality",
    validation_refs: [],
    follow_ups: [],
  };

  const input = writeInput(directory, {
    changed_files: ["scripts/test-runner.cjs", "scripts/missing.js"],
    findings: [
      {
        group_id: "F-001",
        title: "合规 finding",
        intent: "合规",
        files: ["scripts/test-runner.cjs"],
        summary: "合规",
        impact: "合规",
        risk: "low",
        category: "quality",
        validation_refs: [],
        follow_ups: [],
      },
      { ...base, group_id: "F-002" },
      { ...base, group_id: "F-003", risk: "blocker" },
      // schema 校验排在文件检查之前，所以这条必须是 schema 合规、只是文件不存在，
      // 否则它会被先判成 schema_invalid，测不到文件存在性这一条。
      { ...base, group_id: "F-004", files: ["scripts/missing.js"], intent: "定位验证模板" },
      { ...base, group_id: "F-005", files: ["scripts/test-runner.cjs"], intent: "" },
    ],
  });

  const run = runBackend(["--backend", "builtin", "--input", input], directory);
  assert.equal(run.result.status, 0, run.result.stderr);

  const reasons = Object.fromEntries(run.diagnostics.rejected.map((item) => [item.group_id, item.reason]));
  assert.equal(reasons["F-002"], "file_not_in_changeset");
  assert.equal(reasons["F-003"], "schema_invalid");
  assert.equal(reasons["F-004"], "file_not_found");
  assert.equal(reasons["F-005"], "schema_invalid");

  // 一条不合格 finding 不能把其余合规 finding 一起拖下水。
  assert.equal(run.artifact.groups.length, 1);
  assert.equal(run.artifact.groups[0].group_id, "F-001");
  assert.equal(run.diagnostics.accepted_count, 1);
  assert.equal(run.diagnostics.rejected_count, 4);
});

test("全部 finding 被拒时不产出 artifact，退出码 2 并给出 no_acceptable_findings", (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const input = writeInput(directory, {
    changed_files: ["scripts/test-runner.cjs"],
    findings: [
      {
        group_id: "F-001",
        title: "越界",
        intent: "越界",
        files: ["lib/commands/init.js"],
        summary: "越界",
        impact: "越界",
        risk: "low",
        category: "quality",
        validation_refs: [],
        follow_ups: [],
      },
    ],
  });

  const run = runBackend(["--backend", "builtin", "--input", input], directory);
  assert.equal(run.result.status, 2, run.result.stdout);
  const failure = JSON.parse(run.result.stdout.trim());
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "no_acceptable_findings");
  assert.equal(run.artifact, null, "没有可接受 finding 时不得写出 artifact");
});

test("相同输入产出字节一致的 artifact", (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(directory, "scripts", "test-runner.cjs"), "// stub\n");

  const input = writeInput(directory);
  const first = runBackend(["--backend", "builtin", "--input", input], directory);
  const firstBytes = fs.readFileSync(first.output);
  const second = runBackend(["--backend", "builtin", "--input", input], directory);
  const secondBytes = fs.readFileSync(second.output);

  assert.equal(first.result.status, 0);
  assert.equal(second.result.status, 0);
  assert.deepEqual(firstBytes, secondBytes, "同样的输入必须产出同样的字节");
});

test("external backend 只提议 finding，契约校验仍然留在 core", (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(directory, "scripts", "test-runner.cjs"), "// stub\n");

  const adapter = path.join(directory, "adapter.cjs");
  fs.writeFileSync(
    adapter,
    `module.exports = {
  review(context) {
    return {
      findings: [
        { group_id: "F-001", title: "外部审查器提出的一条 finding", intent: "意图", files: ["scripts/test-runner.cjs"], summary: "摘要", impact: "影响", risk: "medium", category: "security", validation_refs: [], follow_ups: [] },
        { group_id: "F-002", title: "外部审查器提出的越界 finding", intent: "越界", files: ["lib/commands/init.js"], summary: "越界", impact: "越界", risk: "low", category: "quality", validation_refs: [], follow_ups: [] }
      ]
    };
  }
};
`
  );

  const input = writeInput(directory);
  const run = runBackend(["--backend", "external", "--adapter", adapter, "--input", input], directory);

  assert.equal(run.result.status, 0, run.result.stderr);
  assert.equal(run.artifact.groups.length, 1, "外部审查器提出的越界 finding 必须同样被拒");
  assert.equal(run.artifact.groups[0].group_id, "F-001");
  assert.equal(run.diagnostics.rejected.length, 1);
  assert.equal(run.diagnostics.rejected[0].reason, "file_not_in_changeset");
});

test("external backend 缺少 adapter 时退出码 2，并说明 adapter 契约", (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = writeInput(directory);
  const run = runBackend(["--backend", "external", "--input", input], directory);

  assert.equal(run.result.status, 2, run.result.stdout);
  const failure = JSON.parse(run.result.stdout.trim());
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "adapter_required");
});

test("未知 backend 与参数缺失都退出码 2", (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const unknown = runBackend(["--backend", "pr-agent", "--input", writeInput(directory)], directory);
  assert.equal(unknown.result.status, 2);

  const missing = spawnSync(process.execPath, [BACKEND, "--backend", "builtin"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  const failure = JSON.parse(missing.stdout.trim());
  assert.equal(failure.error, "input_required");
});
