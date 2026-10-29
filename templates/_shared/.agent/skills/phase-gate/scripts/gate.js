#!/usr/bin/env node
"use strict";

// ─── phase-gate mechanical gate runner ──────────────────────────────────────
//
// Turns the /ship state machine's phase transitions from advisory prose into
// executable checks with an exit code.
//
// Why this exists:
//   The gates in .agent/workflows/ship.md used to be Markdown-only — the agent
//   was told "✅ Linter 检查通过" but nothing verified it. Worse, the one
//   command ship.md named (`.agent/hooks/pre-commit-check.sh`) is a Claude
//   Code PostToolUse hook: it reads its target path from a JSON payload on
//   stdin. Run standalone — exactly how ship.md invoked it — it exits 0 for
//   every input, so the LINT phase could never fail. This runner feeds the
//   hook the payload shape it actually expects and aggregates the result.
//
// Usage:
//   node .agent/skills/phase-gate/scripts/gate.js --from LINT --to REVIEW [--task T-001]
//   node .agent/skills/phase-gate/scripts/gate.js --from LINT --to REVIEW --json
//   node .agent/skills/phase-gate/scripts/gate.js --lint-only --task T-001
//
// Exit codes:
//   0  PASS   — every required check satisfied
//   1  BLOCK  — at least one required check failed
//   2  USAGE  — bad invocation / unknown transition
//
// Zero dependency: only Node built-ins.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// ─── constants ───────────────────────────────────────────────────────────────

const PHASES = Object.freeze([
  "START",
  "PLAN",
  "EXECUTE",
  "LINT",
  "REVIEW",
  "COMMIT",
  "DONE",
  "CONTEXT_CLEANUP",
  "ENTROPY_SCAN",
  "KNOWLEDGE_LINT",
  "DOC_GARDENING",
  "PUBLISH_DOCS",
  "SELF_CHECK",
  "CLEAN",
]);

const MAX_LINT_FILES = 200;

// ─── small helpers ───────────────────────────────────────────────────────────

function fileExists(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function dirExists(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function readJson(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || "").trim();
}

function hasCommand(cmd) {
  const res = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return res.status === 0 && Boolean((res.stdout || "").trim());
}

// ─── context ─────────────────────────────────────────────────────────────────

function buildContext(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const taskId = options.task || null;
  return {
    cwd,
    taskId,
    options,
    taskDir: taskId ? path.join(cwd, ".agent", "tasks") : null,
    planDir: taskId ? path.join(cwd, ".agent", "plans", taskId) : null,
    artifactDir: taskId ? path.join(cwd, ".agent", "artifacts", taskId) : null,
  };
}

// ─── lint runner ─────────────────────────────────────────────────────────────
//
// The single source of truth for "what counts as a lint violation" stays in
// .agent/hooks/pre-commit-check.sh. This function only knows how to feed it
// correctly and how to aggregate per-file results.
//
// The hook parses its target path out of a Claude Code tool-call payload:
//   {"tool_input":{"file_path":"<abs or rel path>"}}
// Feeding it that shape is the whole fix — standalone invocation always
// passed because the payload was absent.

const HOOK_CANDIDATES = Object.freeze([
  path.join(".agent", "hooks", "pre-commit-check.sh"),
  path.join(".claude", "hooks", "pre-commit-check.sh"),
]);

function resolveHookScript(cwd) {
  for (const rel of HOOK_CANDIDATES) {
    const abs = path.join(cwd, rel);
    if (fileExists(abs)) return abs;
  }
  return null;
}

function resolveChangedFiles(cwd) {
  const staged = git(cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACM"]);
  if (staged) return staged.split("\n").filter(Boolean);

  const unstaged = git(cwd, ["diff", "--name-only", "--diff-filter=ACM", "HEAD"]);
  if (unstaged) return unstaged.split("\n").filter(Boolean);

  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked) return untracked.split("\n").filter(Boolean);

  return [];
}

function runLint(ctx) {
  const hook = resolveHookScript(ctx.cwd);

  if (!hook) {
    return {
      ran: false,
      reason: "hook_script_missing",
      detail: "未找到 pre-commit-check.sh（.agent/hooks/ 或 .claude/hooks/），lint 门禁降级为空转。",
      files: [],
      violations: [],
    };
  }

  // The hook extracts the file path with jq. Without jq it silently finds no
  // path and exits 0 for every file — a fail-open gate. Detect it here so the
  // gate reports "cannot decide" instead of a false PASS.
  if (!hasCommand("jq")) {
    return {
      ran: false,
      reason: "jq_missing",
      detail:
        "pre-commit-check.sh 依赖 jq 解析 stdin payload；jq 缺失时该脚本会对所有文件静默放行，" +
        "门禁无法判定。",
      files: [],
      violations: [],
    };
  }

  const all = resolveChangedFiles(ctx.cwd);
  if (all.length === 0) {
    return {
      ran: true,
      reason: "no_changed_files",
      detail: "工作区没有变更文件，lint 门禁无对象可检。",
      files: [],
      violations: [],
    };
  }

  const truncated = all.length > MAX_LINT_FILES;
  const files = truncated ? all.slice(0, MAX_LINT_FILES) : all;
  const violations = [];

  for (const rel of files) {
    const abs = path.join(ctx.cwd, rel);
    if (!fileExists(abs)) continue;
    const payload = JSON.stringify({ tool_input: { file_path: rel } });
    const res = spawnSync("bash", [hook], {
      cwd: ctx.cwd,
      input: payload,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      const output = `${res.stdout || ""}${res.stderr || ""}`.trim();
      violations.push({ file: rel, exit_code: res.status, output });
    }
  }

  return {
    ran: true,
    reason: truncated ? "truncated" : "ok",
    detail: truncated
      ? `变更文件 ${all.length} 个，仅检查前 ${MAX_LINT_FILES} 个。`
      : `已检查 ${files.length} 个变更文件。`,
    files,
    violations,
  };
}

// ─── review verdict resolution ───────────────────────────────────────────────

function resolveReviewVerdict(ctx) {
  if (ctx.reviewVerdictCache !== undefined) return ctx.reviewVerdictCache;

  let resolved;
  if (ctx.options.reviewVerdict) {
    const abs = path.isAbsolute(ctx.options.reviewVerdict)
      ? ctx.options.reviewVerdict
      : path.join(ctx.cwd, ctx.options.reviewVerdict);
    resolved = fileExists(abs) ? { path: abs, data: readJson(abs) } : { path: abs, data: null };
  } else if (ctx.taskId) {
    const candidates = [
      path.join(ctx.cwd, ".agent", "plans", ctx.taskId, "review_verdict.json"),
      path.join(ctx.cwd, ".agent", "artifacts", ctx.taskId, "review_verdict.json"),
      path.join(ctx.cwd, ".agent", "artifacts", ctx.taskId, "review.json"),
    ];
    resolved = { path: null, data: null };
    for (const abs of candidates) {
      if (fileExists(abs)) {
        resolved = { path: abs, data: readJson(abs) };
        break;
      }
    }
  } else {
    resolved = { path: null, data: null };
  }

  ctx.reviewVerdictCache = resolved;
  return resolved;
}

// ─── checks ──────────────────────────────────────────────────────────────────
//
// Each check returns { status, detail }:
//   PASS  — requirement satisfied
//   FAIL  — requirement violated (required severity blocks the transition)
//   WARN  — advisory finding; does not block
//   SKIP  — check could not run (missing optional dependency)

const ok = (detail) => ({ status: "PASS", detail });
const fail = (detail) => ({ status: "FAIL", detail });
const warn = (detail) => ({ status: "WARN", detail });
const skip = (detail) => ({ status: "SKIP", detail });

function lintVerdict(lint) {
  if (!lint || !lint.ran) {
    const reason = lint ? lint.reason : "unknown";
    const detail = lint
      ? lint.detail
      : "lint 未执行。";
    return {
      status: "FAIL",
      detail: `${detail}（原因：${reason}）`,
    };
  }
  if (lint.violations.length === 0) {
    return { status: "PASS", detail: `${lint.detail} 无违规。` };
  }
  const lines = lint.violations
    .slice(0, 10)
    .map((v) => `${v.file} (exit ${v.exit_code})`)
    .join("; ");
  const extra = lint.violations.length > 10 ? ` 等 ${lint.violations.length} 处` : "";
  return {
    status: "FAIL",
    detail: `lint 违规：${lines}${extra}`,
  };
}

function lintCheck(ctx, state) {
  return lintVerdict(state.lint);
}

const TRANSITIONS = {
  "START->PLAN": [
    {
      id: "architecture_rules_present",
      severity: "required",
      run: (ctx) =>
        fileExists(path.join(ctx.cwd, ".agent", "rules", "architecture-design.md"))
          ? ok(".agent/rules/architecture-design.md 存在。")
          : fail("缺少 .agent/rules/architecture-design.md，无法确认架构约束。"),
    },
    {
      id: "task_description_present",
      severity: "required",
      run: (ctx) => {
        if (!ctx.taskId) return warn("未提供 --task，跳过任务存在性检查。");
        const taskFile = path.join(ctx.taskDir, `${ctx.taskId}.json`);
        if (fileExists(taskFile)) return ok(`任务真源 ${taskFile} 存在。`);
        const mission = path.join(ctx.cwd, ".agent", "missions", ctx.taskId, "mission.json");
        if (fileExists(mission)) return ok(`Mission 真源 ${mission} 存在。`);
        return fail(`未找到任务真源：${taskFile} 或 ${mission}。`);
      },
    },
  ],

  "PLAN->EXECUTE": [
    {
      id: "plan_present",
      severity: "required",
      run: (ctx) => {
        const explicit = ctx.options.plan;
        if (explicit) {
          const abs = path.isAbsolute(explicit) ? explicit : path.join(ctx.cwd, explicit);
          return fileExists(abs) ? ok(`计划文件 ${explicit} 存在。`) : fail(`计划文件不存在：${explicit}。`);
        }
        if (!ctx.taskId) return warn("未提供 --task 或 --plan，跳过计划存在性检查。");
        const candidates = [
          path.join(ctx.planDir, "plan.md"),
          path.join(ctx.planDir, "plan.json"),
          path.join(ctx.artifactDir, "plan.json"),
        ];
        for (const abs of candidates) {
          if (fileExists(abs)) return ok(`计划文件 ${abs} 存在。`);
        }
        return fail(`未找到 ${ctx.taskId} 的计划文件（plan.md / plan.json）。`);
      },
    },
    {
      id: "architecture_audit",
      severity: "advisory",
      run: (ctx) => {
        const explicit = ctx.options.architectureAudit;
        if (!explicit) {
          return skip("未提供 --architecture-audit，跳过架构预审核验（需人工/Agent 确认）。");
        }
        const abs = path.isAbsolute(explicit) ? explicit : path.join(ctx.cwd, explicit);
        const data = readJson(abs);
        if (!data) return fail(`架构预审产物不可读或不是合法 JSON：${explicit}。`);
        const blocked = data.blocked === true || (Array.isArray(data.violations) && data.violations.length > 0);
        return blocked
          ? fail(`架构预审报告存在阻断项：${explicit}。`)
          : ok(`架构预审通过：${explicit}。`);
      },
    },
  ],

  "EXECUTE->LINT": [
    {
      id: "worktree_has_changes",
      severity: "required",
      run: (ctx) => {
        const status = git(ctx.cwd, ["status", "--porcelain"]);
        if (status === null) return skip("不在 Git 仓库中，跳过工作区检查。");
        return status
          ? ok(`工作区有 ${status.split("\n").length} 项变更。`)
          : fail("工作区没有任何变更，无法进入 LINT 阶段。");
      },
    },
    {
      id: "lint_clean",
      severity: "required",
      run: (ctx, state) => lintCheck(ctx, state),
    },
  ],

  "LINT->REVIEW": [
    {
      id: "lint_clean",
      severity: "required",
      run: (ctx, state) => lintCheck(ctx, state),
    },
    {
      id: "no_secret_violations",
      severity: "required",
      run: (ctx, state) => {
        // The hook's secret scan is part of lint; this check confirms the lint
        // result actually carried a security verdict rather than being skipped.
        if (!state.lint || !state.lint.ran) {
          return fail("lint 未执行，无法确认密钥扫描结果。");
        }
        const secretHits = state.lint.violations.filter((v) => /安全|Security|secret/i.test(v.output || ""));
        return secretHits.length === 0
          ? ok("未发现硬编码密钥命中。")
          : fail(`发现疑似硬编码密钥：${secretHits.map((v) => v.file).join(", ")}。`);
      },
    },
  ],

  "REVIEW->COMMIT": [
    {
      id: "review_verdict_present",
      severity: "required",
      run: (ctx) => {
        const verdict = resolveReviewVerdict(ctx);
        if (!verdict.path) {
          return fail(
            `未找到 review verdict JSON（--review-verdict 或 .agent/plans/<task>/review_verdict.json）。`
          );
        }
        if (!verdict.data) return fail(`review verdict 不可读或不是合法 JSON：${verdict.path}。`);
        return ok(`review verdict 存在：${verdict.path}。`);
      },
    },
    {
      id: "review_verdict_pass",
      severity: "required",
      run: (ctx) => {
        const verdict = resolveReviewVerdict(ctx);
        if (!verdict.data) return fail("review verdict 缺失或不可读。");
        return verdict.data.verdict === "PASS"
          ? ok("review verdict = PASS。")
          : fail(`review verdict = ${verdict.data.verdict || "(缺失)"}，不是 PASS。`);
      },
    },
    {
      id: "no_blocking_issues",
      severity: "required",
      run: (ctx) => {
        const verdict = resolveReviewVerdict(ctx);
        if (!verdict.data) return fail("review verdict 缺失或不可读。");
        const blocking = Array.isArray(verdict.data.blocking_issues)
          ? verdict.data.blocking_issues
          : [];
        return blocking.length === 0
          ? ok("blocking_issues 为空。")
          : fail(`存在 ${blocking.length} 个阻断项：${blocking.slice(0, 5).join("; ")}`);
      },
    },
  ],

  "COMMIT->DONE": [
    {
      id: "commit_created",
      severity: "required",
      run: (ctx) => {
        const head = git(ctx.cwd, ["log", "-1", "--pretty=%H%n%s"]);
        if (head === null) return skip("不在 Git 仓库中，跳过提交检查。");
        const [sha, subject] = head.split("\n");
        return sha ? ok(`HEAD 提交 ${sha.slice(0, 8)} ${subject || ""}`.trim()) : fail("读取 HEAD 提交失败。");
      },
    },
    {
      id: "task_progress_updated",
      severity: "advisory",
      run: (ctx) => {
        if (!ctx.taskId) return warn("未提供 --task，跳过 task-progress 检查。");
        const progress = path.join(ctx.cwd, ".agent", "plans", "task-progress.md");
        if (!fileExists(progress)) return warn(`未找到 ${progress}。`);
        const text = fs.readFileSync(progress, "utf8");
        return text.includes(ctx.taskId)
          ? ok(`task-progress.md 记录了 ${ctx.taskId}。`)
          : warn(`task-progress.md 中未出现 ${ctx.taskId}。`);
      },
    },
  ],

  "DONE->CONTEXT_CLEANUP": [
    {
      id: "task_artifact_present",
      severity: "advisory",
      run: (ctx) => {
        if (!ctx.taskId) return warn("未提供 --task，跳过产物检查。");
        const dirs = [ctx.planDir, ctx.artifactDir].filter(Boolean);
        const found = dirs.some((d) => dirExists(d));
        return found
          ? ok(`找到 ${ctx.taskId} 的产物目录。`)
          : warn(`未找到 ${ctx.taskId} 的产物目录，可跳过归档。`);
      },
    },
  ],

  "CONTEXT_CLEANUP->ENTROPY_SCAN": [
    {
      id: "cleanup_marker",
      severity: "advisory",
      run: (ctx) => {
        if (!ctx.taskId) return warn("未提供 --task，跳过清理标记检查。");
        const marker = path.join(ctx.cwd, ".agent", "archive", ctx.taskId, "cleanup.marker");
        return fileExists(marker)
          ? ok(`清理标记存在：${marker}。`)
          : warn(`未找到清理标记 ${marker}。`);
      },
    },
  ],

  "ENTROPY_SCAN->KNOWLEDGE_LINT": [
    {
      id: "entropy_report",
      severity: "advisory",
      run: (ctx) => {
        const abs = path.join(ctx.cwd, ".agent", "entropy-report.json");
        return fileExists(abs) ? ok(`熵扫描报告存在：${abs}。`) : warn(`未找到 ${abs}。`);
      },
    },
  ],

  "KNOWLEDGE_LINT->DOC_GARDENING": [
    {
      id: "knowledge_health",
      severity: "advisory",
      run: (ctx) => {
        const abs = path.join(ctx.cwd, ".agent", "metrics", "knowledge-health.json");
        return fileExists(abs) ? ok(`知识健康度产物存在：${abs}。`) : warn(`未找到 ${abs}。`);
      },
    },
  ],

  "DOC_GARDENING->PUBLISH_DOCS": [
    {
      id: "doc_gardening_report",
      severity: "advisory",
      run: (ctx) => {
        const abs = path.join(ctx.cwd, ".agent", "metrics", "doc-gardening-report.json");
        return fileExists(abs) ? ok(`文档整理报告存在：${abs}。`) : warn(`未找到 ${abs}。`);
      },
    },
  ],

  "PUBLISH_DOCS->SELF_CHECK": [
    {
      id: "published_doc",
      severity: "advisory",
      run: (ctx) => {
        const explicit = ctx.options.publishedDoc;
        if (!explicit) return skip("未提供 --published-doc，跳过已发布文档核验。");
        const abs = path.isAbsolute(explicit) ? explicit : path.join(ctx.cwd, explicit);
        return fileExists(abs) ? ok(`已发布文档存在：${explicit}。`) : fail(`已发布文档不存在：${explicit}。`);
      },
    },
  ],

  "SELF_CHECK->CLEAN": [
    {
      id: "self_check_report",
      severity: "advisory",
      run: (ctx) => {
        const abs = path.join(ctx.cwd, ".agent", "metrics", "self-check-report.json");
        return fileExists(abs) ? ok(`自检报告存在：${abs}。`) : warn(`未找到 ${abs}。`);
      },
    },
    {
      // CLEAN 需要**验证证据**，不只是「没报错」。自检报告只证明治理状态
      // 健康，不证明应用行为符合预期——两者不能互相顶替。
      //
      // 判据（与 docs/reliability/verification-templates.md §7 一致）：
      //   fail    → 阻断，发布前必须先修掉失败的验证
      //   partial → 告警，存在未通过的断言
      //   not_run → 告警，明确写出「未执行验证」，不再静默通过
      id: "runtime_verification",
      severity: "required",
      run: (ctx) => {
        const abs = path.join(ctx.cwd, ".agent", "metrics", "verification-summary.json");
        const data = readJson(abs);
        if (!data) {
          return warn(`未找到 ${abs} —— 运行时验证未执行（not_run）。`);
        }
        const status = data.overall_status;
        if (status === "fail") {
          const blockers = Array.isArray(data.blockers) ? data.blockers : [];
          const detail = blockers
            .slice(0, 5)
            .map((b) => `${b.case_id}#${b.assertion_id}`)
            .join("；");
          return fail(`运行时验证失败（fail）：${detail || "详见 verification-summary.json"}。`);
        }
        if (status === "partial") {
          return warn("运行时验证部分通过（partial）—— 存在未通过的断言，详见 verification-summary.json。");
        }
        if (status === "pass") {
          return ok("运行时验证通过（pass）。");
        }
        return warn(`运行时验证状态为 ${status || "缺失"} —— 按未执行处理。`);
      },
    },
  ],
};

// ─── runner ──────────────────────────────────────────────────────────────────

function runTransition(ctx, from, to) {
  const key = `${from}->${to}`;
  const definitions = TRANSITIONS[key];
  if (!definitions) {
    return { error: `unknown_transition`, key };
  }

  const state = { lint: null };
  const checks = [];

  // The lint verdict must exist before the checks run — lint_clean reads it
  // from state. Reuse a pinned result when the caller supplies one, otherwise
  // compute it fresh so the gate never passes on a stale verdict.
  if (definitions.some((d) => d.id === "lint_clean")) {
    state.lint = loadLintResult(ctx) || runLint(ctx);
    writeLintResult(ctx, state.lint);
  }

  for (const def of definitions) {
    let result;
    try {
      result = def.run(ctx, state);
    } catch (err) {
      result = fail(`检查执行异常：${err && err.message ? err.message : String(err)}`);
    }
    checks.push({
      id: def.id,
      severity: def.severity,
      status: result.status,
      detail: result.detail,
    });
  }

  const blocking = checks.filter((c) => c.severity === "required" && c.status === "FAIL");
  const warnings = checks.filter((c) => c.status === "WARN" || c.status === "SKIP");

  return {
    error: null,
    key,
    from,
    to,
    checks,
    blocking_issues: blocking.map((c) => `${c.id}: ${c.detail}`),
    warnings: warnings.map((c) => `${c.id}: ${c.detail}`),
    verdict: blocking.length === 0 ? "PASS" : "FAIL",
    lint: state.lint,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    from: null,
    to: null,
    task: null,
    cwd: null,
    plan: null,
    reviewVerdict: null,
    architectureAudit: null,
    publishedDoc: null,
    lintResult: null,
    writeLintResult: null,
    lintOnly: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needsValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case "--from": options.from = needsValue(); break;
      case "--to": options.to = needsValue(); break;
      case "--task": options.task = needsValue(); break;
      case "--cwd": options.cwd = needsValue(); break;
      case "--plan": options.plan = needsValue(); break;
      case "--review-verdict": options.reviewVerdict = needsValue(); break;
      case "--architecture-audit": options.architectureAudit = needsValue(); break;
      case "--published-doc": options.publishedDoc = needsValue(); break;
      case "--lint-result": options.lintResult = needsValue(); break;
      case "--write-lint-result": options.writeLintResult = needsValue(); break;
      case "--lint-only": options.lintOnly = true; break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: gate.js --from <PHASE> --to <PHASE> [options]",
      "",
      "Phases:",
      `  ${PHASES.join(" → ")}`,
      "",
      "Options:",
      "  --from <PHASE>          transition source",
      "  --to <PHASE>            transition target",
      "  --task <id>             task / mission id for scoped checks",
      "  --cwd <path>            project root (default: cwd)",
      "  --plan <path>           explicit plan file path",
      "  --review-verdict <path> explicit review verdict JSON path",
      "  --architecture-audit <path>  architecture pre-audit report",
      "  --published-doc <path>  published doc reference",
      "  --lint-result <path>    reuse a previously written lint result",
      "  --write-lint-result <path>  write the lint result to this path",
      "  --lint-only             run only the lint check and exit",
      "  --json                  emit machine-readable JSON only",
      "  -h, --help              show this help",
      "",
      "Exit codes: 0 PASS · 1 BLOCK · 2 USAGE",
      "",
    ].join("\n")
  );
}

function writeLintResult(ctx, lint) {
  const target = ctx.options.writeLintResult;
  if (!target) return null;
  const abs = path.isAbsolute(target) ? target : path.join(ctx.cwd, target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    `${JSON.stringify(
      {
        type: "lint_result",
        generated_at: new Date().toISOString(),
        ran: lint.ran,
        reason: lint.reason,
        detail: lint.detail,
        files: lint.files,
        violations: lint.violations,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return abs;
}

function loadLintResult(ctx) {
  const target = ctx.options.lintResult;
  if (!target) return null;
  const abs = path.isAbsolute(target) ? target : path.join(ctx.cwd, target);
  const data = readJson(abs);
  if (!data || typeof data !== "object") return null;
  return {
    ran: data.ran === true,
    reason: data.reason || "cached",
    detail: data.detail || "复用既有 lint 结果。",
    files: Array.isArray(data.files) ? data.files : [],
    violations: Array.isArray(data.violations) ? data.violations : [],
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`❌ ${err.message}\n\n`);
    printHelp();
    return 2;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  const ctx = buildContext(options);

  // lint-only mode: run the lint check and report on it directly.
  if (options.lintOnly) {
    const lint = loadLintResult(ctx) || runLint(ctx);
    const written = writeLintResult(ctx, lint);
    const verdict = lintVerdict(lint);
    const payload = {
      type: "phase_gate_verdict",
      from: "LINT",
      to: "LINT",
      verdict: verdict.status === "PASS" ? "PASS" : "FAIL",
      checks: [
        {
          id: "lint_clean",
          severity: "required",
          status: verdict.status,
          detail: verdict.detail,
        },
      ],
      blocking_issues: verdict.status === "PASS" ? [] : [`lint_clean: ${verdict.detail}`],
      warnings: [],
      lint_result_path: written,
      generated_at: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload.verdict === "PASS" ? 0 : 1;
  }

  if (!options.from || !options.to) {
    process.stderr.write("❌ --from 与 --to 均为必填。\n\n");
    printHelp();
    return 2;
  }

  if (!PHASES.includes(options.from) || !PHASES.includes(options.to)) {
    process.stderr.write(`❌ 未知阶段：${options.from} → ${options.to}\n`);
    return 2;
  }

  const result = runTransition(ctx, options.from, options.to);
  if (result.error) {
    process.stderr.write(`❌ ${result.error}: ${result.key}\n`);
    return 2;
  }

  const payload = {
    type: "phase_gate_verdict",
    from: result.from,
    to: result.to,
    verdict: result.verdict,
    checks: result.checks,
    blocking_issues: result.blocking_issues,
    warnings: result.warnings,
    lint: result.lint
      ? {
          ran: result.lint.ran,
          reason: result.lint.reason,
          detail: result.lint.detail,
          files_checked: Array.isArray(result.lint.files) ? result.lint.files.length : 0,
          violations: Array.isArray(result.lint.violations) ? result.lint.violations.length : 0,
        }
      : null,
    generated_at: new Date().toISOString(),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const icon = result.verdict === "PASS" ? "✅" : "❌";
    const lines = [
      `${icon} ${result.key} → ${result.verdict}`,
      "",
      ...result.checks.map(
        (c) => `  [${c.status}] ${c.id}${c.severity === "advisory" ? " (advisory)" : ""}\n      ${c.detail}`
      ),
    ];
    if (result.blocking_issues.length) {
      lines.push("", `阻断项 (${result.blocking_issues.length}):`);
      for (const b of result.blocking_issues) lines.push(`  - ${b}`);
    }
    if (result.warnings.length) {
      lines.push("", `提示 (${result.warnings.length}):`);
      for (const w of result.warnings) lines.push(`  - ${w}`);
    }
    lines.push("", "JSON:", JSON.stringify(payload, null, 2));
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  return result.verdict === "PASS" ? 0 : 1;
}

module.exports = {
  PHASES,
  TRANSITIONS,
  resolveHookScript,
  resolveChangedFiles,
  runLint,
  resolveReviewVerdict,
  runTransition,
  buildContext,
  parseArgs,
  hasCommand,
  lintVerdict,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
