"use strict";

// ─── local-publish-validate — local pack + install + target upgrade ──────────
//
// Thin CLI wrapper around bin/local-publish-validate.cjs.
// The script is the source of truth; this module:
//   - Parses CLI options and forwards them to the script
//   - Forwards exit code & inherits stdio so the user sees script output
//   - Falls back to a localized help text if no args / --help
//
// NEVER publishes to npm. Always goes through `volta install <pkg>@file:<tgz>`
// for a fully local validation cycle.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Note: bin/ → lib/commands/ is two levels up.
const SCRIPT_PATH = path.join(__dirname, "..", "..", "bin", "local-publish-validate.cjs");

const HELP_EN = `Usage: cortex-agent local-publish-validate [options]

Local pack + local install + optional target upgrade. NEVER publishes to npm.

Options:
  -t, --target <path>     Target project to upgrade after install
      --bump <type>       Bump version: rc | patch | minor | major
      --skip-tests        Skip running test suite
      --skip-commit       Skip git commit + tag
      --dry-run           Print actions without executing
      --force             Override dirty working tree check
  -v, --verbose           Verbose output
  -h, --help              Show this help

Examples:
  cortex-agent local-publish-validate --target ../SamHMI --bump rc
  cortex-agent local-publish-validate --target ../SamHMI --skip-tests
  cortex-agent local-publish-validate --dry-run

Workflow: .agent/workflows/local-publish-validate.md
Script:   bin/local-publish-validate.cjs
`;

const HELP_ZH = `用法:cortex-agent local-publish-validate [options]

本地发包 + 本地安装 + 可选目标项目升级。永远不 publish 到 npm。

选项:
  -t, --target <path>     装完后自动升级的目标项目
      --bump <type>       bump 版本:rc | patch | minor | major
      --skip-tests        跳过测试
      --skip-commit       跳过 git commit + tag
      --dry-run           只打印动作不执行
      --force             覆盖 dirty working tree 阻断
  -v, --verbose           详细输出
  -h, --help              显示此帮助

示例:
  cortex-agent local-publish-validate --target ../SamHMI --bump rc
  cortex-agent local-publish-validate --target ../SamHMI --skip-tests
  cortex-agent local-publish-validate --dry-run

工作流:.agent/workflows/local-publish-validate.md
脚本:  bin/local-publish-validate.cjs
`;

/**
 * Build the child-process argv from the CLI args (drop the leading "local-publish-validate" subcommand token).
 */
function buildScriptArgs(args) {
  // `args` is the full argv; args[0] is "local-publish-validate", the rest are user-provided options.
  return args.slice(1);
}

function localPublishValidate(ctx) {
  const { args, lang } = ctx;

  // Local help: short-circuit --help / -h here (don't spawn the script just to print help).
  if (args.includes("--help") || args.includes("-h") || args.length <= 1) {
    console.log(lang === "zh" ? HELP_ZH : HELP_EN);
    return 0;
  }

  const scriptArgs = buildScriptArgs(args);

  // Inherit stdio so the user sees the script's progress.
  // If the script exits non-zero, we forward the same exit code.
  const r = spawnSync(process.execPath, [SCRIPT_PATH, ...scriptArgs], {
    stdio: "inherit",
  });
  if (r.error) {
    console.error(`❌ Failed to spawn ${SCRIPT_PATH}: ${r.error.message}`);
    return 1;
  }
  return typeof r.status === "number" ? r.status : 1;
}

module.exports = { localPublishValidate, HELP_EN, HELP_ZH };
