#!/usr/bin/env node

"use strict";

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const {
  init,
  addPlatforms,
  removePlatforms,
  listPlatforms,
  upgrade,
  trackAgent,
  untrackAgent,
  linkGlobal,
  doctor,
  runs,
  queues,
  sessions,
  decisions,
  inbox,
  waitpoints,
  coordination,
  lease,
  notification,
  mcp,
  agent,
  hook,
  managementQuery,
  phaseZeroAutomation,
  dashboard,
  dev,
  cliHelp,
  printHelp,
  teamPack,
  secrets,
} = require("../lib/commands");

// ─── Context ──────────────────────────────────────────────────────────────────

const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-v") {
  const { version } = require("../package.json");
  console.log(version);
  process.exit(0);
}

const options = { track: false };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--lang" || arg === "-l") {
    options.lang = args[i + 1];
  } else if (arg && arg.startsWith("--lang=")) {
    options.lang = arg.split("=")[1];
  }
  if (arg === "--global" || arg === "-g") {
    options.global = true;
  }
  if (arg === "--track") {
    options.track = true;
  }
  if (arg === "--platforms" || arg === "-p") {
    options.platforms = args[i + 1];
  } else if (arg && arg.startsWith("--platforms=")) {
    options.platforms = arg.split("=")[1];
  }
  if (arg === "--update-scripts") {
    options.updateScripts = true;
  }
  if (arg === "--force-scripts") {
    options.forceScripts = true;
  }
  if (arg === "--fix") {
    options.fix = true;
  }
  if (arg === "--dry-run") {
    // For upgrade: report what would change; for subcommands that also honor
    // it (none today besides upgrade), the flag is read from ctx.options.dryRun.
    // Adding it here is a no-op cost when absent; honest reporting when present.
    options.dryRun = true;
  }
  if (arg === "--report") {
    options.report = args[i + 1] || "";
  } else if (arg && arg.startsWith("--report=")) {
    options.report = arg.slice("--report=".length);
  }
  if (arg === "--verify") {
    options.verify = true;
  }
  if (arg === "--verify-full") {
    options.verifyFull = true;
  }
  if (arg === "--project") {
    const value = args[i + 1];
    options.project = value && !value.startsWith("--") ? value : "";
  } else if (arg && arg.startsWith("--project=")) {
    options.project = arg.slice("--project=".length);
  }
  if (arg === "--team") {
    options.team = true;
  }
  if (arg === "--name") {
    const value = args[i + 1];
    options.name = value && !value.startsWith("--") ? value : "";
  } else if (arg && arg.startsWith("--name=")) {
    options.name = arg.slice("--name=".length);
  }
  if (arg === "--strict") {
    options.strict = true;
  }
  if (arg === "--stdin") {
    const value = args[i + 1];
    options.stdin = value && !value.startsWith("--") ? value : "";
  } else if (arg && arg.startsWith("--stdin=")) {
    options.stdin = arg.slice("--stdin=".length);
  }
}

function detectLangFromProject(dir) {
  try {
    const content = fs.readFileSync(path.join(dir, ".agent", "rules", "language.md"), "utf8");
    if (/中文|zh[-_]CN|首选语言.*中/i.test(content)) return "zh";
    if (/English|en[-_]US/i.test(content)) return "en";
  } catch (_) {}
  return null;
}

const defaultLang =
  process.env.LANG && process.env.LANG.startsWith("zh") ? "zh" : "en";
const languageProject = options.project ? path.resolve(cwd, options.project) : cwd;
const lang = options.lang || detectLangFromProject(languageProject) || defaultLang;
const templateDir = path.join(__dirname, "../templates", lang);

const ctx = { cwd, args, command, options, lang, templateDir };
const l1Ctx = options.project
  ? { ...ctx, cwd: languageProject, options: { ...options, project: "" } }
  : ctx;

// ─── session (P-001) ─────────────────────────────────────────────────────────
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

// ─── Dispatch ─────────────────────────────────────────────────────────────────

(async () => {
  switch (command) {
    case "init":        await init(ctx); break;
    case "add":         await addPlatforms(ctx); break;
    case "remove":      await removePlatforms(ctx); break;
    case "list":        listPlatforms(ctx); break;
    case "upgrade":
      if (l1Ctx.options.team) {
        console.error("❌ `upgrade --team` is rejected: `upgrade` is additive-only and never touches Team Pack. Use `update --team` for Team Pack sync. See .agent/plans/proposals/projects/team-agent-pack/proposals/P-002-team-pack-cli-lifecycle-proposal.md §4.");
        process.exitCode = 3;
        break;
      }
      await upgrade(l1Ctx); break;
    case "update":
      l1Ctx.options.updateScripts = true;
      if (l1Ctx.options.team) {
        l1Ctx.options.teamPhase = "L1-then-L2";
      }
      await upgrade(l1Ctx);
      break;
    case "track":       trackAgent(ctx); break;
    case "untrack":     untrackAgent(ctx); break;
    case "link-global": linkGlobal(ctx); break;
    case "doctor":      await doctor(ctx); break;
    case "runs":        runs(ctx); break;
    case "queues":      queues(ctx); break;
    case "sessions":    sessions(ctx); break;
    case "session":     runSession(args); break;
    case "decisions":   decisions(ctx); break;
    case "inbox":       inbox(ctx); break;
    case "waitpoints":  waitpoints(ctx); break;
    case "task":
    case "event":       coordination(ctx); break;
    case "lease":       lease(ctx); break;
    case "notification": await notification(ctx); break;
    case "mcp":         await mcp(ctx); break;
    case "query":       managementQuery(ctx); break;
    case "dispatch":
    case "daemon":
    case "trigger":     phaseZeroAutomation(ctx); break;
    case "dashboard":   dashboard(ctx); break;
    case "team":        await teamPack(ctx); break;
    case "secrets":     secrets(l1Ctx); break;
    case "agent":       agent(ctx); break;
    case "hook":        hook(ctx); break;
    case "help":        args.includes("--json") ? cliHelp(ctx) : printHelp(); break;
    case "dev":         await dev(ctx); break;
    case undefined:
    case "--help":
    case "-h":
      args.includes("--json") ? cliHelp(ctx) : printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 2;
      break;
  }
})();
