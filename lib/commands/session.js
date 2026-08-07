"use strict";

// ─── session (P-001) — Runtime Continuity v2 facade ───────────────────────────
//
// Originally lived in bin/cli.js (lines 219-311). Moved to lib/commands/session.js
// in T-FOLLOW-002 v2 so all `cortex-agent <subcommand>` dispatch logic lives
// under lib/commands/ and bin/cli.js becomes a thin re-export shell.
//
// Thin facade that delegates every `cortex-agent session <subcommand>` call to
// the canonical Runtime Continuity v2 script at
//   templates/_shared/.agent/skills/runtime-continuity/scripts/index.js
// (per architecture-design.md §2 — "模板驱动, CLI 只负责复制和链接, 不硬编码
// 业务内容").  The script is the same one bound to
//   .agent/skills/runtime-continuity/scripts/index.js
// inside an installed project (created by `cortex-agent upgrade`).
//
// The 10 subcommands (assess / log / checkpoint / archive / restore /
// resume-bundle / status / warm / host-switch / list-contexts) are documented
// in templates/{zh,en}/.agent/skills/runtime-continuity/SKILL.md and re-listed
// here for first-line discoverability.
//
// `__dirname` adjustment: the new file lives at lib/commands/session.js
// (one level deeper than the original bin/cli.js, and one level shallower
// than the previous `..` walked from bin/), so the templates root path
// `path.join(__dirname, "..", "templates", ...)` becomes
// `path.join(__dirname, "..", "..", "templates", ...)` to keep the
// resolved path identical to the original.

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const SESSION_SUBCOMMANDS = [
  { name: "assess",        desc: "估算任务时长并拆分为 ≤3h 阶段, 评估超时风险" },
  { name: "log",           desc: "追加 transferable work log 到 .agent/runtime-continuity/events/" },
  { name: "checkpoint",    desc: "阶段边界事件, 比 log 更强的结构化标记" },
  { name: "archive",       desc: "写 Markdown 存档 + 结构化 JSON snapshot" },
  { name: "restore",       desc: "加载最新存档 (--list 列历史 / --auto 输出全文)" },
  { name: "resume-bundle", desc: "汇总 latest archive + handoffs + runs + sessions + git state (新 agent 入口)" },
  { name: "status",        desc: "距最近 archive 时间 + stale_recommendation" },
  { name: "warm",          desc: "输出 5 小时计时窗口提示 (--auto 由 SessionStart 独占)" },
  { name: "host-switch",   desc: "跨 host 迁移总线 (Phase 2 RFC §6.4.1 基础设施)" },
  { name: "list-contexts", desc: "跨项目 aggregation, read-only" },
];
const SESSION_SUBCOMMAND_SET = new Set(SESSION_SUBCOMMANDS.map((entry) => entry.name));

function printSessionHelp() {
  console.log("Usage: cortex-agent session <subcommand> [options]");
  console.log("");
  console.log("Subcommands (10):");
  for (const entry of SESSION_SUBCOMMANDS) {
    console.log(`  ${entry.name.padEnd(16)} ${entry.desc}`);
  }
  console.log("");
  console.log("Examples:");
  console.log("  cortex-agent session assess --task-description 'implementing X' --gate user");
  console.log("  cortex-agent session archive --project <name> --gate user");
  console.log("  cortex-agent session restore --project <name> --auto");
  console.log("  cortex-agent session host-switch --project <name> --from-host claude-code --to-host codex --reason '...' --gate user");
  console.log("");
  console.log("All subcommands delegate to:");
  console.log("  templates/_shared/.agent/skills/runtime-continuity/scripts/index.js");
  console.log("Authoritative protocol: .agent/sub-agents/session-manager.md");
}

function runSession(args) {
  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h") {
    printSessionHelp();
    return;
  }
  if (!SESSION_SUBCOMMAND_SET.has(sub)) {
    console.error(`Unknown session subcommand: ${sub}`);
    console.error(`Run \`cortex-agent session --help\` to see the 10 available subcommands.`);
    process.exitCode = 2;
    return;
  }
  // Resolve the canonical script.  _shared/ is the architecture-design §2
  // truth-source; .agent/skills/runtime-continuity/scripts/index.js inside
  // installed projects is the symlink/copy that upgrade() lays down.
  const skillScript = path.join(
    __dirname,
    "..",
    "..",
    "templates",
    "_shared",
    ".agent",
    "skills",
    "runtime-continuity",
    "scripts",
    "index.js"
  );
  if (!fs.existsSync(skillScript)) {
    console.error(`runtime-continuity script not found at ${skillScript}`);
    console.error("This indicates a corrupted cortex-agent install. Reinstall or run `cortex-agent doctor`.");
    process.exitCode = 3;
    return;
  }
  const subArgs = args.slice(2);
  const child = spawn(process.execPath, [skillScript, sub, ...subArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  child.on("exit", (code) => {
    process.exit(code == null ? 0 : code);
  });
  child.on("error", (err) => {
    console.error(`Failed to spawn runtime-continuity: ${err.message}`);
    process.exitCode = 4;
  });
}

module.exports = {
  runSession,
  printSessionHelp,
  SESSION_SUBCOMMANDS,
  SESSION_SUBCOMMAND_SET,
};
