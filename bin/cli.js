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
  exportAnchor,
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
  bridge,
  topology,
  automation,
  localPublishValidate,
  skillBrowse,
} = require("../lib/commands");

// M-013 P0 C2: Governed manual dispatch CLI surface.
// `dispatch <subcommand>` lives in lib/dispatch-cli.js and routes
// `dry-run` → lib/dispatch-plan.resolveDispatchPlan (0 mutation),
// `execute` / unknown / no-subcommand → lib/automation-stubs (Phase 0 stub).
// `daemon` and `trigger` keep their current phaseZeroAutomation binding.
const { dispatchCommand } = require("../lib/dispatch/cli.js");

// M-002 MS-002: Memory subsystem CLI surface.
// `memory <subcommand>` lives in lib/memory/cli.js and routes
// `recall`   → lib/memory/recall.js (read-only, 0 mutation)
// `distill`  → lib/memory/distill.js (writes to .agent/memory/ with rollback on failure)
// Wired via direct require (per FAE-001 / M-013.P0 pattern — keeps lib/commands.js untouched).
const { memoryCommand } = require("../lib/memory");

// M-002 MS-003: Agent Registry CLI surface (static capability registry).
// `agent <subcommand>` is split between M-002 (this) and M-008 (lib/commands.js):
//   - `discover` / `invoke`  → M-002 scope (lib/agents/cli.js, this file)
//   - `report`  / `launch`   → M-008 scope (lib/commands.js, untouched)
//   - bare `agent`           → M-008 scope (legacy bridge to host-event-bridge)
// Subcommand peek in the `case "agent":` block below keeps lib/commands.js unchanged.
const { agentRegistryCommand } = require("../lib/agents");

// M-003 MS-001: Adapter framework + dispatch-execute CLI surface.
// `agent adapter <list|health>` and `agent dispatch-execute <id> <task>` are
// M-003 scope. The M-002 dispatcher (above) does not handle these, so the
// `case "agent":` block peeks at args[1] and routes to the M-003 dispatcher
// when it sees "adapter" or "dispatch-execute". Strictly additive: M-002
// subcommand behavior is unchanged.
const { agentM003Command } = require("../lib/agents/m003-cli");

// T-OD-001 MS-003: Open Design integration CLI surface.
// `design <list|install|upgrade|remove|show|resolved|refresh-catalog>` is
// owned by lib/design/cli.js (mirrors dispatch-cli.js pattern). Strictly
// additive: no changes to lib/commands.js; the new subcommand is added
// to the case dispatch below and registered in lib/cli-contract.js.
const { designCommand } = require("../lib/design/cli");

// M-016 MS-002: Branch Management CLI surface.
// `branch <create|list|show|sync|ready|merge|cleanup>` is owned by
// lib/commands/branch.js. Strictly additive: no changes to lib/commands.js;
// the new subcommand is added to the case dispatch below.
const { branchCommand } = require("../lib/commands/branch");

// Explicit user-gated PR merge facade. The implementation delegates to the
// existing vcs-pr runtime so credential isolation and audit events stay owned
// by one canonical surface.
const { prCommand } = require("../lib/commands/pr");

// M-004 MS-002: Framework Event Bus CLI surface.
// `event-bus <publish|subscribe|list-events|history>` is owned by
// lib/event-bus/cli.js. The 4 subcommands map to the bridge / bus
// core API; --help / --json exit cleanly without touching
// lib/commands.js (M-001 binding contract preserved).
const { eventBusCommand } = require("../lib/event-bus/cli");

// T-FOLLOW-002 v2: `.agent/` state sync CLI surface.
// `state-sync [--dry-run|--add|--commit|--push]` lives in
// lib/state-sync.js. It scans the 9 state-class directories
// (decisions/ waitpoints/ tasks/ missions/ plans/ dispatch/ workflows/
// skills/ branches/registry.json) inside the inner .agent/ git repo
// and stages/commits/pushes them so project-management state stays
// in lock-step across machines. Strictly additive: no changes to
// lib/commands.js; the new subcommand is added to the case dispatch below.
//
// `installStateGithooks` and `fireAndForgetSync` are the auto-mode entry
// points wired into the case dispatch below (init / upgrade / update /
// decisions / inbox / waitpoints / task / event). They live here in
// bin/cli.js (not lib/commands.js) so M-001 shadow-init's invariant
// "lib/commands.js has 0 changes vs base f8a1d38" stays intact.
const { stateSync, installStateGithooks, fireAndForgetSync } = require("../lib/state-sync/index.js");
const { shouldAutoSyncCoordination } = require("../lib/commands/management/coordination.js");

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
  // MS-002: `cortex-agent init --mode general` — picks the shared data-layer
  // profile instead of the code-project knowledge base. Pure addition: the
  // default `init` path (no --mode) is untouched.
  if (arg === "--mode" || arg === "-m") {
    const value = args[i + 1];
    options.mode = value && !value.startsWith("--") ? value : "";
  } else if (arg && arg.startsWith("--mode=")) {
    options.mode = arg.slice("--mode=".length);
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

// MS-002: `cortex-agent init --mode general` lays down the shared .agent/
// data layer (inbox, decisions, runs, sessions, missions, handoffs,
// conversations, memory, agents, tasks, waitpoints) from templates/_base/
// without going through the language-specific code knowledge base. Lives
// here, not in lib/commands.js, so the existing init() function and all
// its side effects (migrateOldConfigs, selectPlatformsInteractive,
// scriptManifest.ensureManifestForInit, etc.) stay untouched.
//
// MS-004 extension: also copy `templates/general/.agent/` (workflows /
// skills / sub-agents / domains / prompts / config) to `<baseDest>/general/`
// so the general-mode project gets the full 7-subdir template layer in
// addition to the data layer. Pure addition — no changes to _base/ or
// to the existing init() function.
async function initModeGeneral() {
  const { copyRecursive } = require("../lib/setup/index.js");
  const { writeVersionFile } = require("../lib/commands/patches.js");
  const { writePublicAnchor } = require("../lib/commands/anchor.js");
  const { applyGitExclusion } = require("../lib/platform/index.js");
  const baseSrc = path.join(__dirname, "..", "templates", "_base", ".agent");
  if (!fs.existsSync(baseSrc)) {
    console.error(
      "❌ templates/_base/.agent not found. Run MS-001 first to land the shared base layer, then retry `cortex-agent init --mode general`.",
    );
    process.exit(1);
  }
  const baseDest = path.join(cwd, ".agent");
  copyRecursive(baseSrc, baseDest);
  console.log(
    `✅ general mode init: copied shared data layer to ${baseDest}`,
  );

  // Seed AGENTS.md at project root from the general-mode template. Only
  // writes when the file does not already exist — a user-provided AGENTS.md
  // is authoritative and must never be clobbered. AGENTS.md is the documented
  // entry file for general-mode projects (see mode-infer.js rule 1).
  const agentsMdPath = path.join(cwd, "AGENTS.md");
  if (fs.existsSync(agentsMdPath)) {
    console.log("ℹ️  AGENTS.md detected; general mode is the right profile for this project.");
  } else {
    const agentsMdSrc = path.join(__dirname, "..", "templates", "general", "AGENTS.md");
    if (fs.existsSync(agentsMdSrc)) {
      fs.writeFileSync(agentsMdPath, fs.readFileSync(agentsMdSrc, "utf8"), "utf8");
      console.log(`✅ general mode init: seeded ${agentsMdPath} (edit it to match your project).`);
    } else {
      console.warn(
        "⚠️  templates/general/AGENTS.md not found; please create AGENTS.md at project root manually.",
      );
    }
  }

  // MS-004: copy the general template layer (workflows + skills + sub-agents +
  // domains + prompts + config) into `<baseDest>/general/`. This sits next to
  // the data layer copied above and is the runtime surface for the 4 general
  // workflows (memory-recall, memory-distill, agent-discover, agent-invoke).
  const generalSrc = path.join(__dirname, "..", "templates", "general", ".agent");
  if (fs.existsSync(generalSrc)) {
    const generalDest = path.join(baseDest, "general");
    copyRecursive(generalSrc, generalDest);
    console.log(
      `✅ general mode init: copied template layer to ${generalDest}`,
    );
  } else {
    console.warn(
      "⚠️  templates/general/.agent not found; skipped template layer copy (general workflow contracts unavailable).",
    );
  }

  // Stamp the framework version so `cortex-agent doctor` recognises this as a
  // managed project. Mirrors what `init()` does for code mode.
  writeVersionFile(cwd);

  // Write the cross-tool recognition anchor (docs/cortex-agent/anchor.md) so
  // any AI tool (Claude Code, Codex, Cursor, …) can identify this project as
  // cortex-agent-managed. Same helper `init()` uses for code mode.
  const anchorWritten = writePublicAnchor(cwd, false);
  if (anchorWritten) {
    console.log("🌐 Cross-tool anchor written to: docs/cortex-agent/anchor.md (version-controlled)");
  }

  // Keep generated files out of Git unless the user explicitly opts in with
  // `--track`. Reuses the platform helper that updates .git/info/exclude.
  try {
    applyGitExclusion({ cwd, options: {} });
  } catch (_) {
    // best-effort: never fail general-mode init because of git exclusion
  }

  console.log("\n🎉 Cortex Agent (general mode) initialized successfully!");
  console.log(
    "\n👉 Next steps:\n" +
      "   - Edit AGENTS.md to describe your project context.\n" +
      "   - Run `cortex-agent doctor` to verify setup health.\n" +
      "   - Explore `.agent/general/workflows/` for /memory recall, /agent discover, etc.",
  );
}

(async () => {
  // MS-003: auto mode inference — when the user omits `--mode` entirely,
  // ask `lib/mode-infer` which profile fits the cwd and inject the result
  // into `options.mode`. The MS-002 dispatch (the `if (... --mode general)`
  // block below) already keys off `options.mode === "general"`, so by
  // setting `options.mode` here we let the existing code pick the right
  // path with no further wiring:
  //
  //   inferred === 'general'  -> falls into the MS-002 block, initModeGeneral
  //   inferred === 'code'     -> falls through to switch / case "init", default init
  //
  // Pure addition. Sits ABOVE the MS-002 block; the MS-002 block and every
  // line below stay byte-identical. `lib/commands.js` is also untouched —
  // the inferred code path is the same default init() MS-001 ships.
  if (command === "init") {
    const { isInferModeEnabled, inferMode } = require("../lib/coordination/mode-infer");
    if (isInferModeEnabled({ options, args })) {
      const inferred = inferMode(cwd);
      options.mode = inferred;
    }
  }

  // MS-002: route `init --mode general` *before* the default `case "init"`
  // dispatch so the existing init() never runs when the user explicitly
  // asks for the general profile. The default `init` path (no --mode)
  // continues to call lib/commands.js init() exactly as before.
  if (
    command === "init" &&
    (options.mode === "general" ||
      args.includes("--mode") ||
      args.includes("-m"))
  ) {
    if (options.mode && options.mode !== "general") {
      console.error(
        `❌ Unsupported --mode value: ${options.mode}. Only 'general' is implemented in MS-002. Omit --mode to use the default code-project init.`,
      );
      process.exit(2);
    }
    await initModeGeneral();
    installStateGithooks({ cwd, lang });
    return;
  }
  switch (command) {
    case "init":        await init(ctx); installStateGithooks({ cwd, lang }); break;
    case "add":         await addPlatforms(ctx); break;
    case "remove":      await removePlatforms(ctx); break;
    case "list":        listPlatforms(ctx); break;
    case "export-anchor": exportAnchor(ctx); break;
    case "upgrade":
      if (l1Ctx.options.team) {
        console.error("❌ `upgrade --team` is rejected: `upgrade` is additive-only and never touches Team Pack. Use `update --team` for Team Pack sync. See .agent/plans/proposals/projects/team-agent-pack/proposals/P-002-team-pack-cli-lifecycle-proposal.md §4.");
        process.exitCode = 3;
        break;
      }
      await upgrade(l1Ctx);
      // Respect --dry-run: state-githooks installer copies templates to disk,
      // which would violate the zero-write contract. Skip when dryRun is set.
      if (!l1Ctx.options.dryRun) installStateGithooks({ cwd, lang });
      break;
    case "update":
      l1Ctx.options.updateScripts = true;
      if (l1Ctx.options.team) {
        l1Ctx.options.teamPhase = "L1-then-L2";
      }
      await upgrade(l1Ctx);
      // Respect --dry-run: state-githooks installer copies templates to disk,
      // which would violate the zero-write contract. Skip when dryRun is set.
      if (!l1Ctx.options.dryRun) installStateGithooks({ cwd, lang });
      break;
    case "track":       trackAgent(ctx); break;
    case "untrack":     untrackAgent(ctx); break;
    case "link-global": linkGlobal(ctx); break;
    // doctor must use l1Ctx so that --project <path> is resolved into cwd
    // before readVersionFile(cwd) / isGitRepo(cwd) / .agent discovery run.
    // Without this, `cortex-agent doctor --project <other>` silently
    // reports the *current* directory's .agent, masking drift between
    // the global CLI version and the target project's template version
    // (regression introduced when doctor.js moved into lib/commands/).
    case "doctor":      await doctor(l1Ctx); break;
    case "reconcile":   minimaxCliReconcile(ctx); break;
    case "bridge":      bridge(l1Ctx); break;
    case "topology":    topology(l1Ctx); break;
    case "automation":  automation(l1Ctx); break;
    case "local-publish-validate": localPublishValidate(ctx); break;
    case "skill":        skillBrowse(ctx); break;
    case "runs":        runs(ctx); break;
    case "queues":      queues(ctx); break;
    case "sessions":    sessions(ctx); break;
    case "session":     runSession(args); break;
    case "decisions":   decisions(ctx); fireAndForgetSync(l1Ctx).catch(() => {}); break;
    case "inbox":       inbox(ctx); fireAndForgetSync(l1Ctx).catch(() => {}); break;
    case "waitpoints":  waitpoints(ctx); fireAndForgetSync(l1Ctx).catch(() => {}); break;
    case "task":
    case "event": {
      const result = coordination(ctx);
      if (shouldAutoSyncCoordination(ctx.args, result)) {
        fireAndForgetSync(l1Ctx).catch(() => {});
      }
      break;
    }
    case "lease":       lease(ctx); break;
    case "notification": await notification(ctx); break;
    case "mcp":         await mcp(ctx); break;
    case "query":       managementQuery(ctx); break;
    case "memory":      memoryCommand(ctx); break;
    case "dispatch":    await dispatchCommand(ctx); break;
    case "daemon":
    case "trigger":     phaseZeroAutomation(ctx); break;
    case "dashboard":   dashboard(ctx); break;
    case "team":        await teamPack(ctx); break;
    case "secrets":     secrets(l1Ctx); break;
    case "agent": {
      // Subcommand peek: M-002 MS-003 owns discover/invoke; M-008 owns
      // report/launch (forwarded via lib/commands.js). M-003 MS-001 owns
      // adapter <list|health> and dispatch-execute. M-013 SP-006 owns
      // supervise <status|steer|abort>. Routing is strictly additive —
      // the M-002 dispatcher body is unchanged.
      const sub = args[1];
      if (sub === "adapter" || sub === "dispatch-execute") {
        agentM003Command(ctx);
      } else if (sub === "supervise") {
        // M-013 SP-006: supervise <status|steer|abort> entry point.
        // Delegates to lib/cli/agent-supervise.js for the pure envelope,
        // then prints the JSON or plain-text envelope to stdout.
        const { cliDispatch: agentSuperviseDispatch } = require("../lib/cli/agent-supervise");
        const superviseArgs = args.slice(2);
        const result = agentSuperviseDispatch(superviseArgs, null);
        if (args.includes("--json")) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else if (result.ok) {
          // For status, the supervisor returns a structured projection; the
          // caller is expected to pass a real reducer-derived state via
          // --json in production use cases. For steer/abort, the envelope
          // includes action + reason + idempotencyKey + nonce.
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
          process.exitCode = result.error && result.error.code === "INVALID_ACTION" ? 2 : 1;
        }
      } else {
        // M-002 dispatcher is the SOLE entry point for `agent` (per D-002-3).
        // Internally it routes:
        //   discover / invoke → lib/agents/ (M-002 static capability registry)
        //   report  / launch  → lib/commands.js agent() (M-008 coordination runtime)
        //   bare / --help / unknown → M-002 friendly help/error
        // This way `agent --help` always shows M-002 docs, and unknown subcommands
        // get a clear "valid: discover, invoke (M-002) | report, launch (M-008)" hint.
        // lib/commands.js stays untouched (M-001 binding contract).
        agentRegistryCommand(ctx);
      }
      break;
    }
    case "hook":        hook(ctx); break;
    case "design":      await designCommand(ctx); break;
    case "branch":      branchCommand(ctx); break;
    case "pr":          prCommand(ctx); break;
    case "event-bus":   eventBusCommand(ctx); break;
    case "state-sync":  await stateSync(l1Ctx); break;
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
