"use strict";

// ─── local-publish-validate — local pack + install + target upgrade ──────────
//
// Thin CLI wrapper around bin/local-publish-validate.cjs.
// The script is the source of truth; this module:
//   - Parses CLI options and forwards them to the script
//   - Forwards exit code & inherits stdio so the user sees script output
//   - Falls back to a localized help text if no args / --help
//
// This tool never directly publishes to npm. Default mode uses volta file:.
// --stage-only omits direct install/target CLI/bump/commit/tag operations.
// Build/test and npm lifecycle scripts are trusted execution code and may have
// side effects. No process-tree immutability or production use is certified.
// Pack hooks are disabled; prepack/prepare-generated assets need separate review.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Note: bin/ → lib/commands/ is two levels up.
const SCRIPT_PATH = path.join(__dirname, "..", "..", "bin", "local-publish-validate.cjs");

const HELP_EN = `Usage: cortex-agent local-publish-validate [options]

Local pack + local install + optional target upgrade. NEVER publishes to npm via direct tool calls.

Options:
      --stage-only        Build/test/pack; no direct tool install, target CLI, source bump/commit/tag
                          Unique cwd/.agent/runtime/local-publish-validate directory + full SHA-256
                          Currently unsupported: detached-local / unauthenticated .agent symlinks
                          Link targets are not authenticated by this tool; such links are refused
                          Target project not validated; non-production, no production authorization
                          Conflicts: --target, --bump, --skip-tests, --force
                          Build/test and npm lifecycle scripts are trusted code; side effects are possible
                          No claim of process-tree or source/target immutability
                          Pack uses --ignore-scripts; prepack/prepare assets need prior build/review
                          Not verified equivalent to a complete release package
  -t, --target <path>     Target project to upgrade after install
      --bump <type>       Bump version: rc | patch | minor | major
      --skip-tests        Skip running test suite
      --skip-commit       Skip git commit + tag
      --dry-run           Print actions without executing; stage directory/bindings unverified, real run may refuse
      --force             Override dirty working tree check
  -v, --verbose           Verbose output
  -h, --help              Show this help

Examples:
  cortex-agent local-publish-validate --target ../your-project --bump rc
  cortex-agent local-publish-validate --target ../your-project --skip-tests
  cortex-agent local-publish-validate --dry-run
  cortex-agent local-publish-validate --stage-only

Workflow: .agent/workflows/local-publish-validate.md
Script:   bin/local-publish-validate.cjs
`;

const HELP_ZH = `用法:cortex-agent local-publish-validate [options]

本地发包 + 本地安装 + 可选目标项目升级。工具自身不 publish 到 npm。

选项:
      --stage-only        工具自身仅构建/测试/pack，不直接安装/运行目标 CLI/源仓 bump/commit/tag
                          cwd/.agent/runtime/local-publish-validate 唯一目录及完整 SHA-256
                          当前不支持 detached-local / 未认证的 .agent 符号链接；未认证链接目标，保持拒绝
                          未验证目标项目，非生产授权；拒绝 --target/--bump/--skip-tests/--force
                          构建/测试/npm lifecycle 是可能产生副作用的受信代码，不保证进程树或源/目标不变
                          pack 用 --ignore-scripts；prepack/prepare 产物须提前构建核验，不等同完整发布包
  -t, --target <path>     装完后自动升级的目标项目
      --bump <type>       bump 版本:rc | patch | minor | major
      --skip-tests        跳过测试
      --skip-commit       跳过 git commit + tag
      --dry-run           只打印动作不执行；stage 目录/绑定未验证，实际运行可能拒绝
      --force             覆盖 dirty working tree 阻断
  -v, --verbose           详细输出
  -h, --help              显示此帮助

示例:
  cortex-agent local-publish-validate --target ../your-project --bump rc
  cortex-agent local-publish-validate --target ../your-project --skip-tests
  cortex-agent local-publish-validate --dry-run
  cortex-agent local-publish-validate --stage-only

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
