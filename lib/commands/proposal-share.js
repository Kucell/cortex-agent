"use strict";

// ─── proposal-share — CLI wrapper ─────────────────────────────────────────────
//
// Thin wrapper around .agent/scripts/proposal-share.js (the engine / source of
// truth). The engine lives in the *project's* .agent/, so it is resolved from
// ctx.cwd (the project root), not from the CLI install dir.
//
//   cortex-agent proposal-share export --slug <slug>
//   cortex-agent proposal-share import --package <tar.gz> --root-map 'repo=/p'
//   cortex-agent proposal-share verify --package <tar.gz>
//
// Authoritative workflow: .agent/workflows/proposal-share.md

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HELP_EN = `Usage: cortex-agent proposal-share <export|import|verify> [options]

Export / import portable proposal packages (proposals + missions + topology +
dual-repo peer volumes) for sharing proposal directories across developers and
repositories. The engine is .agent/scripts/proposal-share.js in the project.

Subcommands:
  export --slug <slug> [--root <dir>] [--out <dir>]
         [--peers <root,...>] [--no-peers] [--missions <M-xxx,...>]
         [--all-missions] [--handoff <file>] [--with-topology]
  import --package <tar.gz> [--root <dir>] [--root-map 'repo=/abs/path,...']
         [--dry-run] [--force] [--skip-missions] [--skip-topology] [--keep-tmp]
  verify --package <tar.gz> [--root <dir>]

Examples:
  cortex-agent proposal-share export --slug mobile-device-variable-cards --root .
  cortex-agent proposal-share import --package proposal-share-xxx.tar.gz --root .
  cortex-agent proposal-share verify --package proposal-share-xxx.tar.gz

Workflow: .agent/workflows/proposal-share.md
`;

const HELP_ZH = `用法: cortex-agent proposal-share <export|import|verify> [options]

导出 / 导入可移植提案包（proposals + missions + topology + 双仓 peer 卷），
支持跨开发者、跨仓库共享提案目录。引擎为项目内 .agent/scripts/proposal-share.js。

子命令:
  export --slug <slug> [--root <dir>] [--out <dir>]
         [--peers <root,...>] [--no-peers] [--missions <M-xxx,...>]
         [--all-missions] [--handoff <file>] [--with-topology]
  import --package <tar.gz> [--root <dir>] [--root-map 'repo=/abs/path,...']
         [--dry-run] [--force] [--skip-missions] [--skip-topology] [--keep-tmp]
  verify --package <tar.gz> [--root <dir>]

示例:
  cortex-agent proposal-share export --slug mobile-device-variable-cards --root .
  cortex-agent proposal-share import --package proposal-share-xxx.tar.gz --root .
  cortex-agent proposal-share verify --package proposal-share-xxx.tar.gz

工作流: .agent/workflows/proposal-share.md
`;

function proposalShare(ctx) {
  const { args, lang } = ctx;

  // Local help: short-circuit --help / -h here.
  if (args.includes("--help") || args.includes("-h") || args.length <= 1) {
    console.log(lang === "zh" ? HELP_ZH : HELP_EN);
    return 0;
  }

  // The engine is project-local (.agent/scripts/proposal-share.js).
  const projectRoot = (ctx && ctx.cwd) || process.cwd();
  const scriptPath = path.resolve(projectRoot, ".agent", "scripts", "proposal-share.js");

  const r = spawnSync(process.execPath, [scriptPath, ...args.slice(1)], {
    stdio: "inherit",
    cwd: projectRoot,
  });
  if (r.error) {
    console.error(`❌ Failed to spawn ${scriptPath}: ${r.error.message}`);
    return 1;
  }
  return typeof r.status === "number" ? r.status : 1;
}

module.exports = { proposalShare, HELP_EN, HELP_ZH };
