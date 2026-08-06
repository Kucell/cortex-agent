"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { execSync, spawn, spawnSync } = require("child_process");
const {
  attachProject,
  formatQueryPayload,
  invokeManagementProject,
  queryManagementProject,
  resolveManagementProject,
} = require("./management-client");
const cliContract = require("./cli-contract");
const { phaseZeroAutomation } = require("./automation-stubs");
const { executeCoordinationCommand } = require("./coordination/cli");
const { executeNotificationCommand } = require("./coordination/notification-cli");
const { createNotificationHarness } = require("./coordination/notification-host");
const { executeBridgeCommand } = require("./host-event-bridge");
// Lazy require: keep lib/commands.js startup cheap and avoid loading
// governed-tool (which transitively imports capability-aware-dispatch
// and operation-lifecycle) when only print/help/version are invoked.
let registerMinimaxCliDiscovery = null;
try {
  registerMinimaxCliDiscovery = require("./runtime-adapters/minimax-cli-governed-tool").registerWithInitUpdateDoctor;
} catch (_) {
  registerMinimaxCliDiscovery = null;
}

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y");
    });
  });
}

const { PLATFORM_REGISTRY } = require("./registry");
const scriptManifest = require("./script-manifest");
const PKG_VERSION = require("../package.json").version;

// ─── patch engine ─────────────────────────────────────────────────────────────
// Patch files live in templates/.agent/patches/*.patch.md
// Frontmatter fields:
//   id           – unique patch identifier (stored in .agent/.applied-patches)
//   target       – path relative to .agent/ (use ../ to reach project root)
//   anchor       – string that must NOT already exist in target (idempotency check)
//   insert_after – (optional) insert body after the line containing this string;
//                  if omitted or not found, body is appended to end of file

function applyPatches(ctx) {
  const { cwd, templateDir, lang } = ctx;
  const isZh = lang === "zh";
  const patchDir = path.join(templateDir, ".agent", "patches");
  if (!fs.existsSync(patchDir)) return;

  const appliedFile = path.join(cwd, ".agent", ".applied-patches");
  const applied = fs.existsSync(appliedFile)
    ? new Set(fs.readFileSync(appliedFile, "utf8").split("\n").filter(Boolean))
    : new Set();

  const patchFiles = fs.readdirSync(patchDir)
    .filter((f) => f.endsWith(".patch.md"))
    .sort();

  const patched = [];
  const skipped = [];

  for (const fname of patchFiles) {
    const raw = fs.readFileSync(path.join(patchDir, fname), "utf8");
    // Parse frontmatter between first and second ---
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) continue;
    const fm = {};
    fmMatch[1].split("\n").forEach((line) => {
      const [k, ...v] = line.split(":");
      if (k && v.length) fm[k.trim()] = v.join(":").trim().replace(/^"|"$/g, "");
    });
    const { id, target, anchor, insert_after } = fm;
    if (!id || !target || !anchor) continue;
    if (applied.has(id)) { skipped.push(id); continue; }

    const destFile = path.join(cwd, ".agent", target);
    if (!fs.existsSync(destFile)) { skipped.push(id); continue; }

    const existing = fs.readFileSync(destFile, "utf8");
    if (existing.includes(anchor)) {
      applied.add(id);
      skipped.push(id);
      continue;
    }

    const body = fmMatch[2].trimEnd();
    let updated;
    if (insert_after && existing.includes(insert_after)) {
      const markerIndex = existing.indexOf(insert_after);
      const markerLineEnd = existing.indexOf("\n", markerIndex + insert_after.length);
      const idx = markerLineEnd === -1 ? existing.length : markerLineEnd;
      updated = existing.slice(0, idx) + "\n" + body + existing.slice(idx);
    } else {
      updated = existing.trimEnd() + "\n" + body + "\n";
    }
    fs.writeFileSync(destFile, updated, "utf8");
    applied.add(id);
    patched.push(`${id} → ${target}`);
  }

  fs.writeFileSync(appliedFile, [...applied].join("\n") + "\n", "utf8");

  if (patched.length > 0) {
    console.log(isZh
      ? `\n🩹 已应用规则补丁 (${patched.length})：`
      : `\n🩹 Applied patches (${patched.length}):`);
    patched.forEach((p) => console.log(`   + ${p}`));
  }
}

function writeVersionFile(cwd) {
  const versionFile = path.join(cwd, ".agent", ".cortex-version");
  fs.writeFileSync(versionFile, PKG_VERSION, "utf8");
}

function readVersionFile(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, ".agent", ".cortex-version"), "utf8").trim();
  } catch (_) {
    return null;
  }
}
const {
  getInstalledPlatforms,
  saveInstalledPlatforms,
  getAllGeneratedPaths,
  installPlatform,
  removePlatform,
  selectPlatformsInteractive,
} = require("./platform");
const {
  copyRecursive,
  migrateOldConfigs,
  promoteImportedClaudeContext,
  ensureAgentEntryFile,
  ensureSessionBootstrapEntry,
  ensureGeminiEntryFile,
  ensureClaudeEntryFile,
  ensureAgentHooks,
  ensureClaudeSettings,
  ensureProjectionRegistry,
  ensureProjectAgentReadme,
  linkGlobalConfig,
  needsHookMerge,
  needsProjectionRegistryMerge,
  needsSessionBootstrapMerge,
  ensureCompatibilityAdapterBootstrapEntry,
  needsCompatibilityAdapterBootstrapMerge,
} = require("./setup");
const {
  isGitRepo,
  hasTrackedPath,
  getIgnoreSource,
  resolveGitExcludePath,
  applyGitExclusion,
  untrackGeneratedFilesFromGit,
} = require("./git");

// ─── init ─────────────────────────────────────────────────────────────────────

async function init(ctx) {
  const { cwd, lang, templateDir, options } = ctx;
  const isZh = lang === "zh";

  console.log(`🧠 ${isZh ? "正在初始化 Cortex Agent 框架" : "Initializing Cortex Agent Framework"} (Language: ${lang})...`);

  if (!fs.existsSync(templateDir)) {
    console.error(`❌ Template directory not found at ${templateDir}`);
    process.exit(1);
  }

  const isExistingProject = migrateOldConfigs(ctx);

  const agentSrc = path.join(templateDir, ".agent");
  const sharedAgentSrc = path.join(__dirname, "..", "templates", "_shared", ".agent");
  const targetBase = options.global ? os.homedir() : cwd;
  const agentDest = path.join(targetBase, ".agent");

  const hadAgentDir = fs.existsSync(agentDest);
  // Shared base layer first, then language-specific overlay (language wins on conflict).
  copyRecursive(sharedAgentSrc, agentDest);
  copyRecursive(agentSrc, agentDest);
  if (hadAgentDir) {
    console.warn(isZh ? `⚠️  .agent 目录已存在，已补齐缺失模板。` : `⚠️  .agent already exists. Filled missing template files.`);
  } else {
    console.log(`✅ Created ${agentDest} (Knowledge Base).`);
  }

  if (options.global) {
    console.log("\n🎉 Global Cortex Agent initialized successfully!");
    return;
  }

  if (isExistingProject) promoteImportedClaudeContext(ctx);
  ensureProjectAgentReadme(ctx);

  // Register managed L1 scripts so future `upgrade` can safely update them.
  try {
    scriptManifest.ensureManifestForInit(cwd, templateDir, lang);
  } catch (_) { /* non-fatal: manifest can be rebuilt on next upgrade */ }

  // MiniMax CLI governed-tool adapter hook (ARI P-005 / M-011): read-only
  // capability discovery at the end of init.  Never invokes a forbidden
  // mmx subcommand and never mutates any host file.
  if (registerMinimaxCliDiscovery) {
    try {
      const post = registerMinimaxCliDiscovery({
        projectRoot: cwd,
        templatesRoot: path.join(__dirname, "..", "templates"),
      }).onInitComplete({ cwd, lang });
      console.log("");
      console.log("🛰️  MiniMax CLI governed-tool adapter (ARI P-005 / M-011)");
      console.log(`  - ${isZh ? "二进制可用" : "binary available"}: ${post.binary_available ? (isZh ? "是" : "yes") : (isZh ? "否" : "no")}${post.binary_version ? ` (${post.binary_version})` : ""}`);
      console.log(`  - ${isZh ? "认证状态" : "auth state"}: ${post.auth_state}`);
      console.log(`  - ${isZh ? "便携 Skill 路径" : "portable skill paths"}: ${post.skill_paths_present}/${post.skill_paths_total} ${isZh ? "已就位" : "present"}`);
      console.log(`  - ${isZh ? "探测白名单" : "probe allow-list"}: mmx --version / mmx --help / mmx <resource> --help`);
    } catch (_) {
      // Non-fatal: init still succeeds without MiniMax discovery output.
    }
  }

  let selectedPlatforms;
  if (options.platforms) {
    selectedPlatforms =
      options.platforms === "all"
        ? Object.keys(PLATFORM_REGISTRY)
        : options.platforms.split(",").map((s) => s.trim()).filter((k) => PLATFORM_REGISTRY[k]);
  } else {
    selectedPlatforms = await selectPlatformsInteractive(ctx);
  }

  console.log("\n🤖 " + (isZh ? "正在安装所选平台集成..." : "Setting up selected platform integrations..."));
  selectedPlatforms.forEach((key) => {
    const p = PLATFORM_REGISTRY[key];
    console.log(`\n▶ ${p.name}`);
    const postSetup = installPlatform(ctx, key);
    if (postSetup === "claude-settings") ensureClaudeSettings(ctx);
  });

  ensureAgentEntryFile(ctx);
  ensureCompatibilityAdapterBootstrapEntry(ctx);
  ensureGeminiEntryFile(ctx);
  if (selectedPlatforms.includes("claude")) ensureClaudeEntryFile(ctx);
  linkGlobalConfig(ctx);
  saveInstalledPlatforms(cwd, selectedPlatforms);

  if (!options.track) {
    console.log(isZh ? "\n🧹 确保生成文件不被 Git 追踪..." : "\n🧹 Ensuring generated Cortex Agent files are not tracked by Git...");
    untrackGeneratedFilesFromGit(ctx);
    applyGitExclusion(ctx);
  }

  writeVersionFile(cwd);
  console.log(isZh ? "\n🎉 Cortex Agent 初始化成功！" : "\n🎉 Cortex Agent initialized successfully!");

  if (isExistingProject) {
    console.log(
      isZh
        ? "\n👉 旧配置已导入 .agent/imported_rules/，在 AI 助手中运行 /migrate-rules 完成迁移。"
        : "\n👉 Old configs imported to .agent/imported_rules/. Run /migrate-rules in your AI assistant.",
    );
  } else {
    console.log(
      isZh
        ? "\n👉 在 AI 助手中运行 /configure 完成项目配置。"
        : "\n👉 Run /configure in your AI assistant to set up your project.",
    );
  }

  console.log(
    isZh
      ? "\n💡 后续可用命令：\n   cortex-agent add <platform>     添加新平台\n   cortex-agent remove <platform>  移除平台\n   cortex-agent list               查看已安装平台"
      : "\n💡 Useful commands:\n   cortex-agent add <platform>     Add a platform later\n   cortex-agent remove <platform>  Remove a platform\n   cortex-agent list               Show installed platforms",
  );
}

// ─── add / remove / list ──────────────────────────────────────────────────────

function addPlatforms(ctx) {
  const { cwd, lang, args, options } = ctx;
  const isZh = lang === "zh";
  const targets = args.slice(1).filter((a) => !a.startsWith("-"));

  if (targets.length === 0) {
    console.error(
      isZh
        ? "❌ 请指定平台名称，例如：cortex-agent add cursor windsurf"
        : "❌ Please specify platform(s), e.g.: cortex-agent add cursor windsurf",
    );
    listPlatforms(ctx);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(cwd, ".agent"))) {
    console.error(
      isZh
        ? "❌ 未找到 .agent 目录，请先运行 cortex-agent init。"
        : "❌ .agent directory not found. Run cortex-agent init first.",
    );
    process.exit(1);
  }

  const installed = getInstalledPlatforms(cwd);
  targets.forEach((key) => {
    if (!PLATFORM_REGISTRY[key]) {
      console.warn(isZh ? `⚠️  未知平台 "${key}"，已跳过。` : `⚠️  Unknown platform "${key}", skipping.`);
      return;
    }
    console.log(`\n▶ ${PLATFORM_REGISTRY[key].name}`);
    const postSetup = installPlatform(ctx, key);
    if (postSetup === "claude-settings") ensureClaudeSettings(ctx);
    if (key === "claude") ensureClaudeEntryFile(ctx);
    if (!installed.includes(key)) installed.push(key);
  });

  saveInstalledPlatforms(cwd, installed);
  if (!options.track) applyGitExclusion(ctx);
  console.log(isZh ? "\n🎉 平台添加完成！" : "\n🎉 Platform(s) added successfully!");
}

function removePlatforms(ctx) {
  const { cwd, lang, args } = ctx;
  const isZh = lang === "zh";
  const targets = args.slice(1).filter((a) => !a.startsWith("-"));

  if (targets.length === 0) {
    console.error(
      isZh
        ? "❌ 请指定平台名称，例如：cortex-agent remove cursor"
        : "❌ Please specify platform(s), e.g.: cortex-agent remove cursor",
    );
    process.exit(1);
  }

  let installed = getInstalledPlatforms(cwd);
  targets.forEach((key) => {
    if (!PLATFORM_REGISTRY[key]) {
      console.warn(isZh ? `⚠️  未知平台 "${key}"，已跳过。` : `⚠️  Unknown platform "${key}", skipping.`);
      return;
    }
    console.log(`\n▶ ${isZh ? "移除" : "Removing"} ${PLATFORM_REGISTRY[key].name}`);
    removePlatform(ctx, key);
    installed = installed.filter((k) => k !== key);
  });

  saveInstalledPlatforms(cwd, installed);
  console.log(isZh ? "\n🎉 平台移除完成！" : "\n🎉 Platform(s) removed successfully!");
}

function listPlatforms(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const installed = getInstalledPlatforms(cwd);
  const keys = Object.keys(PLATFORM_REGISTRY);

  console.log(isZh ? "\n📋 平台列表：" : "\n📋 Platform list:");
  keys.forEach((key, i) => {
    const p = PLATFORM_REGISTRY[key];
    const desc = p.desc[lang] || p.desc.en;
    const status = installed.includes(key)
      ? (isZh ? "✅ 已安装" : "✅ installed")
      : (isZh ? "○  未安装" : "○  not installed");
    console.log(`  ${String(i + 1).padStart(2)}. ${status.padEnd(18)} ${p.name.padEnd(22)} ${desc}`);
  });

  console.log(
    isZh
      ? `\n💡 添加平台：cortex-agent add <platform>\n   移除平台：cortex-agent remove <platform>`
      : `\n💡 Add: cortex-agent add <platform>\n   Remove: cortex-agent remove <platform>`,
  );
}

// ─── upgrade ──────────────────────────────────────────────────────────────────

function runSelfCheck(cwd, mode, isZh) {
  const selfCheckScript = path.join(cwd, ".agent/skills/self-check/scripts/index.js");
  if (!fs.existsSync(selfCheckScript)) return null;

  const { spawnSync } = require("child_process");
  const label = mode === "check-drift"
    ? (isZh ? "🔍 升级前漂移检测..." : "🔍 Pre-upgrade drift check...")
    : (isZh ? "✅ 升级后自检中..." : "✅ Post-upgrade self-check...");
  console.log(`\n${label}`);

  const result = spawnSync("node", [selfCheckScript, mode], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let report = null;
  try { report = JSON.parse(result.stdout); } catch { /* non-JSON output */ }

  if (report) {
    const status = report.overall_status || report.status || "unknown";
    const driftLevel = report.drift_level;
    if (status === "fail" || driftLevel === "L2") {
      console.warn(isZh
        ? `  ⚠️  发现严重问题 (${driftLevel || "L2"})：${(report.failed_areas || report.warnings || []).join(", ")}`
        : `  ⚠️  Critical issues found (${driftLevel || "L2"}): ${(report.failed_areas || report.warnings || []).join(", ")}`);
    } else if (status === "warning" || driftLevel === "L1") {
      console.log(isZh
        ? `  ⚠️  轻微偏差 (L1)：${(report.warned_areas || report.warnings || []).join(", ")}`
        : `  ⚠️  Minor drift (L1): ${(report.warned_areas || report.warnings || []).join(", ")}`);
    } else {
      console.log(isZh ? "  ✓ 无问题" : "  ✓ No issues");
    }
  }

  return report;
}

// ─── L1 script reconcile (shared by upgrade / doctor) ──────────────────────────
// Plans or applies safe updates to managed L1 skill scripts. See lib/script-manifest.js.
// apply=false → dry-run (report candidates only). Returns the reconcile report.
function runScriptReconcile(ctx, { apply, force }) {
  const { cwd, templateDir, lang } = ctx;
  const isZh = lang === "zh";
  let report;
  try {
    report = scriptManifest.reconcileScripts({ cwd, templateDir, lang, apply, force });
  } catch (error) {
    console.warn(isZh ? `⚠️  脚本核对失败：${error.message}` : `⚠️  Script reconcile failed: ${error.message}`);
    return null;
  }

  if (!apply) {
    if (report.updates.length > 0) {
      console.log(isZh
        ? `\n📜 候选脚本更新 (${report.updates.length})（加 --update-scripts 执行）：`
        : `\n📜 Candidate script updates (${report.updates.length}) — run with --update-scripts to apply:`);
      report.updates.forEach((u) => console.log(`   ~ ${u.path}  (${u.reason})`));
    }
    const userMod = report.skipped.filter((s) => s.reason === "user_modified");
    if (userMod.length > 0) {
      console.log(isZh
        ? `   本地已修改、已跳过 (${userMod.length})（加 --force-scripts 可覆盖）：`
        : `   Locally modified, skipped (${userMod.length}) — use --force-scripts to override:`);
      userMod.forEach((s) => console.log(`   - ${s.path}`));
    }
    return report;
  }

  if (report.applied.length > 0) {
    console.log(isZh ? `\n🩹 已更新脚本 (${report.applied.length})：` : `\n🩹 Updated scripts (${report.applied.length}):`);
    report.applied.forEach((p) => console.log(`   ~ ${p}`));
  }
  const protectedLocal = report.skipped.filter((s) =>
    s.reason === "user_modified" || s.reason === "unmanaged_cold_start");
  if (protectedLocal.length > 0) {
    console.log(isZh
      ? `\n🛡️  已保护本地脚本、未覆盖 (${protectedLocal.length})：`
      : `\n🛡️  Protected local scripts, not overwritten (${protectedLocal.length}):`);
    protectedLocal.forEach((s) => console.log(`   - ${s.path}  (${s.reason})`));
  }
  if (report.failed.length > 0) {
    console.warn(isZh ? `❌ 脚本更新失败，已回滚：` : `❌ Script updates failed (rolled back):`);
    report.failed.forEach((f) => console.warn(`   ! ${f.path}: ${f.error}`));
  }
  return report;
}

function updateReportJson(ctx) {
  return ctx.options && ctx.options.report === "json";
}

function updateProjectDescriptor(cwd, agentDest) {
  let root = cwd;
  let agentRoot = agentDest;
  try { root = fs.realpathSync(cwd); } catch (_) {}
  try { agentRoot = fs.realpathSync(agentDest); } catch (_) {}
  return { root, agent_root: agentRoot };
}

function buildDryRunUpdateReport(ctx, { agentDest, wouldAdd, scriptCandidates, skippedChecks }) {
  const additivePlan = wouldAdd.map((relPath) => ({
    path: `.agent/${relPath}`,
    layer: "L0",
    action: "add",
    reason: "missing_template_file",
    risk: "low",
  }));
  const scriptPlan = scriptCandidates.map((candidate) => ({
    path: `.agent/${candidate.path}`,
    layer: "L1",
    action: "update",
    reason: candidate.reason,
    risk: candidate.reason === "missing" ? "low" : "medium",
  }));
  const semanticPlan = collectSemanticMergeCandidates(ctx);
  const plan = [...additivePlan, ...scriptPlan, ...semanticPlan];
  return {
    ok: true,
    schema_version: 1,
    command: ctx.command,
    mode: "dry-run",
    generated_at: new Date().toISOString(),
    language: ctx.lang,
    project: updateProjectDescriptor(ctx.cwd, agentDest),
    template: {
      lang: ctx.lang,
      template_dir: ctx.templateDir,
    },
    plan,
    blocked: [],
    changes: {
      added: additivePlan,
      updated: scriptPlan,
      merged: semanticPlan,
      protected: [],
    },
    verification: [],
    skipped_checks: skippedChecks,
    summary: {
      would_add: additivePlan.length,
      candidate_scripts: scriptPlan.length,
      total_plan_items: plan.length,
      blockers: 0,
    },
    next_actions: plan.length
      ? [`Run cortex-agent ${ctx.command} to apply safe changes.`]
      : [],
  };
}

function updateReportId() {
  return `U-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}`;
}

function writeUpdateReport(cwd, report) {
  const dir = path.join(cwd, ".agent", "updates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.update_id}.json`);
  const latest = path.join(dir, "latest.json");
  const body = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(file, body, "utf8");
  fs.writeFileSync(latest, body, "utf8");
  return { file, latest };
}

function buildAppliedUpdateReport(ctx, {
  updateId,
  startedAt,
  agentDest,
  added,
  reconcileReport,
  semanticMergePlan,
  verification,
  status,
}) {
  const addedChanges = added.map((relPath) => ({
    path: `.agent/${relPath}`,
    layer: "L0",
    action: "add",
    reason: "missing_template_file",
    risk: "low",
  }));
  const updatedChanges = [
    ...((reconcileReport && reconcileReport.applied) || []).map((relPath) => ({
      path: `.agent/${relPath}`,
      layer: "L1",
      action: "update",
      reason: "managed_script_updated",
      risk: "medium",
    })),
  ];
  const protectedChanges = ((reconcileReport && reconcileReport.skipped) || [])
    .filter((item) => item.reason === "user_modified" || item.reason === "unmanaged_cold_start")
    .map((item) => ({
      path: `.agent/${item.path}`,
      layer: "L1",
      action: "protect",
      reason: item.reason,
      risk: "medium",
    }));
  const failedChanges = ((reconcileReport && reconcileReport.failed) || []).map((item) => ({
    path: `.agent/${item.path}`,
    layer: "L1",
    action: "failed",
    reason: item.error || "script_update_failed",
    risk: "high",
  }));
  const changes = {
    added: addedChanges,
    updated: updatedChanges,
    merged: semanticMergePlan,
    protected: protectedChanges,
    failed: failedChanges,
  };
  const plan = [
    ...addedChanges,
    ...updatedChanges,
    ...semanticMergePlan,
    ...protectedChanges,
    ...failedChanges,
  ];
  return {
    ok: status !== "failed",
    schema_version: 1,
    update_id: updateId,
    command: ctx.command,
    mode: "apply",
    status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    language: ctx.lang,
    project: updateProjectDescriptor(ctx.cwd, agentDest),
    template: {
      lang: ctx.lang,
      template_dir: ctx.templateDir,
    },
    plan,
    changes,
    verification: verification ? verification.verification : [],
    summary: {
      added: addedChanges.length,
      updated: updatedChanges.length,
      merged: semanticMergePlan.length,
      protected: protectedChanges.length,
      failed: failedChanges.length,
      verification_failed: verification ? verification.summary.failed : 0,
      verification_skipped: verification ? verification.summary.skipped : 0,
    },
    next_actions: [
      ...(protectedChanges.length ? ["Review protected local scripts; use --force-scripts only after confirming the diff."] : []),
      ...(verification && verification.summary.failed ? ["Run cortex-agent update --verify --report json and fix failed checks."] : []),
    ],
  };
}

function collectSemanticMergeCandidates(ctx) {
  const candidates = [];
  const agentsPath = path.join(ctx.cwd, "AGENTS.md");
  if (needsSessionBootstrapMerge(ctx, agentsPath)) {
    candidates.push({
      path: "AGENTS.md",
      layer: "L2",
      action: fs.existsSync(agentsPath) ? "merge" : "add",
      reason: fs.existsSync(agentsPath) ? "entry_runtime_bootstrap_stale" : "entry_file_missing",
      risk: fs.existsSync(agentsPath) ? "medium" : "low",
    });
  }
  if (ctx.command === "update" && needsCompatibilityAdapterBootstrapMerge(ctx, agentsPath)) {
    candidates.push({
      path: "AGENTS.md",
      layer: "L2",
      action: fs.existsSync(agentsPath) ? "merge" : "add",
      reason: "entry_compatibility_adapter_bootstrap_stale",
      risk: "medium",
    });
  }
  for (const rel of [".agent/hooks/hooks.json", ".claude/settings.json"]) {
    if (needsHookMerge(ctx, rel)) {
      candidates.push({
        path: rel,
        layer: "L2",
        action: fs.existsSync(path.join(ctx.cwd, rel)) ? "merge" : "add",
        reason: "hook_runtime_continuity_stale",
        risk: "medium",
      });
    }
  }
  if (needsProjectionRegistryMerge(ctx)) {
    candidates.push({
      path: ".agent/skills/management-api/scripts/projection-registry.json",
      layer: "L2",
      action: "merge",
      reason: "projection_registry_stale",
      risk: "medium",
    });
  }
  return candidates;
}

function verificationCheck(name, status, command, details = {}) {
  return {
    name,
    status,
    command,
    exit_code: status === "passed" || status === "skipped" ? 0 : 1,
    ...details,
  };
}

function parseJsonCheck(filePath) {
  if (!fs.existsSync(filePath)) {
    return verificationCheck(`parse ${path.relative(process.cwd(), filePath)}`, "skipped", `node -e JSON.parse(${filePath})`, {
      message: "file_missing",
    });
  }
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
    return verificationCheck(`parse ${path.relative(process.cwd(), filePath)}`, "passed", `parse ${filePath}`);
  } catch (error) {
    return verificationCheck(`parse ${path.relative(process.cwd(), filePath)}`, "failed", `parse ${filePath}`, {
      message: error.message,
    });
  }
}

function runNodeJsonCheck(cwd, args, name) {
  const command = `node ${args.join(" ")}`;
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return verificationCheck(name, "failed", command, { message: result.error.message, exit_code: 1 });
  }
  try {
    const payload = JSON.parse(result.stdout);
    if (result.status === 0 && payload && payload.ok === true) {
      return verificationCheck(name, "passed", command, { exit_code: 0 });
    }
    return verificationCheck(name, "failed", command, {
      exit_code: result.status || 1,
      message: payload && (payload.message || payload.error) ? String(payload.message || payload.error) : "command_failed",
    });
  } catch (error) {
    return verificationCheck(name, "failed", command, {
      exit_code: result.status || 1,
      message: `invalid_json: ${error.message}`,
      stderr: String(result.stderr || "").trim(),
    });
  }
}

function managementQueryCheck(ctx, projection, extraArgs = []) {
  const command = `cortex-agent query ${projection}${extraArgs.length ? ` ${extraArgs.join(" ")}` : ""}`;
  const result = queryManagementProject(ctx, projection, extraArgs);
  if (result.ok) return verificationCheck(`query ${projection}`, "passed", command);
  const unavailable = result.error && [
    "MANAGEMENT_API_UNAVAILABLE",
    "MANAGEMENT_API_QUERY_FAILED",
    "CAPABILITY_UNAVAILABLE",
  ].includes(result.error.code);
  return verificationCheck(`query ${projection}`, unavailable ? "skipped" : "failed", command, {
    message: result.error ? result.error.message : "query_failed",
    details: result.error ? result.error.details : {},
  });
}

function withoutProjectArgs(args = []) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      index += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--project=")) continue;
    normalized.push(arg);
  }
  return normalized;
}

function runUpdateVerification(ctx, { full = false } = {}) {
  const resolved = resolveManagementProject(ctx);
  const project = resolved.ok
    ? resolved.project
    : updateProjectDescriptor(ctx.cwd, path.join(ctx.cwd, ".agent"));
  const root = project.root;
  const agentRoot = project.agent_root;
  const projectName = path.basename(root);
  const checks = [
    parseJsonCheck(path.join(agentRoot, "hooks", "hooks.json")),
    parseJsonCheck(path.join(root, ".claude", "settings.json")),
    parseJsonCheck(path.join(agentRoot, "skills", "management-api", "scripts", "projection-registry.json")),
  ];

  const runtimeScript = path.join(agentRoot, "skills", "runtime-continuity", "scripts", "index.js");
  if (fs.existsSync(runtimeScript)) {
    checks.push(runNodeJsonCheck(root, [runtimeScript, "resume-bundle", "--project", projectName], "runtime resume-bundle"));
  } else {
    checks.push(verificationCheck("runtime resume-bundle", "skipped", `node ${runtimeScript} resume-bundle --project ${projectName}`, {
      message: "runtime_continuity_unavailable",
    }));
  }

  const verificationCtx = { ...ctx, args: withoutProjectArgs(ctx.args) };
  checks.push(managementQueryCheck(verificationCtx, "capabilities"));
  checks.push(managementQueryCheck(verificationCtx, "dashboard-state"));
  const today = new Date().toISOString().slice(0, 10);
  checks.push(managementQueryCheck(verificationCtx, "activity", ["--since", today]));
  if (full) checks.push(managementQueryCheck(verificationCtx, "activity"));

  const failed = checks.filter((check) => check.status === "failed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  return {
    ok: failed === 0,
    schema_version: 1,
    command: ctx.command,
    mode: full ? "verify-full" : "verify",
    generated_at: new Date().toISOString(),
    project,
    verification: checks,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "passed").length,
      skipped,
      failed,
    },
  };
}

function printUpdateVerification(ctx, report) {
  if (updateReportJson(ctx)) {
    printManagementPayload(report);
    return;
  }
  const isZh = ctx.lang === "zh";
  console.log(isZh ? "✅ Update 验证结果：" : "✅ Update verification:");
  for (const check of report.verification) {
    const mark = check.status === "passed" ? "✓" : check.status === "skipped" ? "-" : "!";
    console.log(`  ${mark} ${check.name}: ${check.status}${check.message ? ` (${check.message})` : ""}`);
  }
  console.log(`  summary: ${report.summary.passed} passed, ${report.summary.skipped} skipped, ${report.summary.failed} failed`);
}

function upgrade(ctx) {
  const { cwd, lang, templateDir, options } = ctx;
  const isZh = lang === "zh";
  const dryRun = options.dryRun === true;
  const fullUpdate = ctx.command === "update" || options.updateScripts === true || options.forceScripts === true;
  const reportJson = updateReportJson(ctx);
  const startedAt = new Date().toISOString();
  const updateId = updateReportId();

  if (!reportJson) {
    console.log(dryRun
      ? (isZh
          ? `🔍 升级 dry-run (语言: ${lang}) — 不会修改任何文件。`
          : `🔍 Upgrade dry-run (Language: ${lang}) — no files will be modified.`)
      : (isZh
          ? `🔄 正在升级 Cortex Agent 框架 (语言: ${lang})...`
          : `🔄 Upgrading Cortex Agent Framework (Language: ${lang})...`));
  }

  if (!fs.existsSync(templateDir)) {
    console.error(`❌ Template directory not found at ${templateDir}`);
    process.exit(1);
  }

  const agentDest = path.join(cwd, ".agent");
  if (!fs.existsSync(agentDest)) {
    console.error(
      isZh
        ? "❌ 当前目录没有找到 .agent 目录。请先运行 cortex-agent init。"
        : "❌ No .agent directory found. Please run cortex-agent init first.",
    );
    process.exit(1);
  }

  if (options.verify === true || options.verifyFull === true) {
    const report = runUpdateVerification(ctx, { full: options.verifyFull === true });
    printUpdateVerification(ctx, report);
    if (!report.ok) process.exitCode = 3;
    return;
  }

  // Pre-upgrade drift check writes self-check-report.json — under --dry-run
  // we must leave no byte-level residue, so skip it and tell the user what
  // we skipped. (A real upgrade would re-run check-drift for an honest baseline.)
  const skippedChecks = [];
  if (!dryRun) {
    runSelfCheck(cwd, "check-drift", isZh);
  } else {
    skippedChecks.push({
      name: "check-drift",
      reason: "dry_run_zero_write",
    });
    if (!reportJson) {
      console.log(isZh
        ? "  · 跳过 check-drift(避免写入 self-check-report.json,符合 dry-run 不修改磁盘)。"
        : "  · Skipping check-drift (would write self-check-report.json; --dry-run must not modify disk).");
    }
  }

  const agentSrc = path.join(templateDir, ".agent");
  const sharedAgentSrc = path.join(__dirname, "..", "templates", "_shared", ".agent");
  const added = [];
  // used by the dry-run path; declared here so the closure-based reportSink
  // can push into it from any recursion depth.
  const wouldAdd = [];

  // Walk `agentSrc` recursively; for each file present in templates but
  // missing on the project side, run `sink.onMissingFile(relPath, src, dest)`.
  // `sink` decides whether to actually copy (apply) or just record (dry-run).
  // Recursive mkdir is done up-front per directory when `sink` returns true
  // for a missing directory; for dry-run we never ask for the dir so no
  // empty directories are created on disk.
  function walkWithSink(srcDir, destDir, relBase, sink) {
    if (!fs.existsSync(srcDir)) return;
    for (const name of fs.readdirSync(srcDir)) {
      const srcPath = path.join(srcDir, name);
      const destPath = path.join(destDir, name);
      const relPath = relBase ? `${relBase}/${name}` : name;
      let stat;
      try { stat = fs.statSync(srcPath); } catch { continue; }

      if (stat.isDirectory()) {
        const destExisted = fs.existsSync(destPath);
        if (sink.onMissingDir && !destExisted) {
          // Ask sink before deciding to create the directory. Under dry-run
          // sink returns false → we MUST still keep `destDir` pointing at
          // the real project root so nested recursion can correctly test
          // fs.existsSync(destPath) against the project's tree, NOT the
          // template's. Earlier this passed srcPath as a sentinel, which
          // caused nested children to be reported as already-present
          // (looked them up inside the template, where they obviously
          // exist). The fix: recurse with the real destDir; sink just
          // won't copy anything anyway because onMissingFile is log-only.
          const ok = sink.onMissingDir(relPath, srcPath, destPath);
          if (!ok) {
            walkWithSink(srcPath, destPath, relPath, sink);
            continue;
          }
        }
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        walkWithSink(srcPath, destPath, relPath, sink);
      } else if (!fs.existsSync(destPath)) {
        sink.onMissingFile(relPath, srcPath, destPath);
      }
    }
  }

  // Pure dry-run mirror of runScriptReconcile. Walks the managed L1 script
  // whitelist and reports candidate updates without writing
  // .script-manifest.json. The original runScriptReconcile writes the
  // manifest on cold-start regardless of `apply: false`, so it can't be
  // invoked directly from a zero-byte dry-run path.
  function collectReconcileCandidates() {
    let discovered = [];
    try {
      const sharedAgentDir = path.resolve(templateDir, "..", "_shared", ".agent");
      discovered = scriptManifest.discoverTemplateScriptEntries(templateDir, [sharedAgentDir]);
    } catch {
      return [];
    }
    const candidates = [];
    for (const { rel: relPath, root } of discovered) {
      const srcAbs = path.join(root, relPath.split("/").join(path.sep));
      const destAbs = path.join(cwd, ".agent", relPath);
      if (!fs.existsSync(destAbs)) {
        candidates.push({ path: relPath, reason: "missing" });
        continue;
      }
      try {
        const srcSha = require("crypto").createHash("sha256").update(fs.readFileSync(srcAbs)).digest("hex");
        const destSha = require("crypto").createHash("sha256").update(fs.readFileSync(destAbs)).digest("hex");
        if (srcSha !== destSha) candidates.push({ path: relPath, reason: "candidate_script_drift" });
      } catch {
        candidates.push({ path: relPath, reason: "unreadable" });
      }
    }
    return candidates;
  }

  // Apply-path sink: actually copy files.
  const applySink = {
    onMissingDir: () => true,
    onMissingFile: (relPath, srcPath, destPath) => {
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      if (relPath.endsWith(".sh")) fs.chmodSync(destPath, 0o755);
      added.push(relPath);
    },
  };
  // Dry-run sink: only record; never copy; never mkdir.
  const reportSink = {
    onMissingDir: () => false,
    onMissingFile: (relPath) => {
      wouldAdd.push(relPath);
    },
  };

  if (dryRun) {
    // Shared base layer first, then language-specific overlay (language wins on conflict).
    walkWithSink(sharedAgentSrc, agentDest, "", reportSink);
    walkWithSink(agentSrc, agentDest, "", reportSink);

    const scriptCandidates = collectReconcileCandidates();
    const candidateCount = scriptCandidates.length;
    if (reportJson) {
      printManagementPayload(buildDryRunUpdateReport(ctx, {
        agentDest,
        wouldAdd,
        scriptCandidates,
        skippedChecks,
      }));
      ctx.options.dryRunReport = {
        wouldAdd,
        candidateScripts: candidateCount,
      };
      return;
    }

    console.log(isZh
      ? `\n📋 计划新增 (${wouldAdd.length})：`
      : `\n📋 Would add (${wouldAdd.length}):`);
    wouldAdd.forEach((f) => console.log(`   + ${f}`));
    if (wouldAdd.length === 0) {
      console.log(isZh
        ? "  (无 — 项目已是最新。)"
        : "  (none — already up to date.)");
    }

    if (candidateCount > 0) {
      console.log(isZh
        ? `\n📜 候选脚本更新 (${candidateCount})：`
        : `\n📜 Candidate script updates (${candidateCount}):`);
      console.log(isZh
        ? `   (--dry-run 不展开脚本级细节；执行 \`cortex-agent update\` 安全同步。)`
        : `   (--dry-run does not enumerate script-level details; run \`cortex-agent update\` to sync safely.)`);
    }

    // Touch a marker so callers / tests can assert the dry-run path was taken.
    ctx.options.dryRunReport = {
      wouldAdd,
      candidateScripts: candidateCount,
    };
    console.log(isZh
      ? `\nℹ️  执行 \`cortex-agent ${fullUpdate ? "update" : "upgrade"}\` 应用上述变更。`
      : `\nℹ️  Run \`cortex-agent ${fullUpdate ? "update" : "upgrade"}\` to apply these changes.`);
    return;
  }

  // Apply path: shared base layer first, then language-specific overlay.
  walkWithSink(sharedAgentSrc, agentDest, "", applySink);
  walkWithSink(agentSrc, agentDest, "", applySink);
  ensureProjectAgentReadme(ctx);

  // Apply incremental rule patches to existing files
  applyPatches(ctx);
  promoteImportedClaudeContext(ctx);

  // `upgrade` remains additive-only. `update` (or the legacy explicit flag)
  // additionally refreshes scripts that are proven framework-managed.
  const reconcileReport = runScriptReconcile(ctx, {
    apply: fullUpdate,
    force: options.forceScripts === true,
  });
  const semanticMergePlan = collectSemanticMergeCandidates(ctx);

  if (added.length > 0) {
    console.log(isZh ? `\n✅ 新增文件 (${added.length})：` : `\n✅ Added (${added.length}):`);
    added.forEach((f) => console.log(`   + ${f}`));
  } else {
    console.log(isZh ? "\nℹ️  无新增内容，已是最新。" : "\nℹ️  Nothing new to add. Already up to date.");
  }

  const installed = getInstalledPlatforms(cwd);
  if (installed.length > 0) {
    console.log(isZh ? "\n🔗 检查已安装平台的符号链接..." : "\n🔗 Checking symlinks for installed platforms...");
    installed.forEach((key) => {
      if (PLATFORM_REGISTRY[key]) {
        const postSetup = installPlatform(ctx, key);
        if (postSetup === "claude-settings") ensureClaudeSettings(ctx);
      }
    });
  }

  // Match init: ensure root entry files for Codex / Gemini (additive; skip if present).
  ensureAgentEntryFile(ctx);
  ensureSessionBootstrapEntry(ctx);
  if (fullUpdate) ensureCompatibilityAdapterBootstrapEntry(ctx);
  ensureGeminiEntryFile(ctx);
  if (installed.includes("claude") || fs.existsSync(path.join(cwd, "CLAUDE.md"))) {
    ensureClaudeEntryFile(ctx);
  }
  ensureAgentHooks(ctx);
  ensureProjectionRegistry(ctx);
  linkGlobalConfig(ctx);
  ensureClaudeSettings(ctx);
  if (!options.track) applyGitExclusion(ctx);
  writeVersionFile(cwd);
  const verificationReport = runUpdateVerification(ctx, { full: options.verifyFull === true });
  const protectedLocal = (reconcileReport?.skipped || []).filter((s) =>
    s.reason === "user_modified" || s.reason === "unmanaged_cold_start");
  const failedScripts = reconcileReport?.failed || [];
  const updateStatus = failedScripts.length > 0 || verificationReport.summary.failed > 0
    ? "failed"
    : protectedLocal.length > 0
      ? "partial"
      : "passed";
  const updateReport = buildAppliedUpdateReport(ctx, {
    updateId,
    startedAt,
    agentDest,
    added,
    reconcileReport,
    semanticMergePlan,
    verification: verificationReport,
    status: updateStatus,
  });
  const updateReportPaths = writeUpdateReport(cwd, updateReport);
  if (!reportJson) {
    console.log(isZh
      ? `\n🧾 已写入升级报告：${path.relative(cwd, updateReportPaths.latest)}`
      : `\n🧾 Wrote update report: ${path.relative(cwd, updateReportPaths.latest)}`);
  }
  if (failedScripts.length > 0) {
    process.exitCode = 1;
    console.error(isZh ? "\n❌ 更新未完成：部分管理脚本写入失败。" : "\n❌ Update incomplete: some managed scripts failed to write.");
  } else if (verificationReport.summary.failed > 0) {
    process.exitCode = 3;
    console.error(isZh ? "\n❌ 更新验证失败：请查看 .agent/updates/latest.json。" : "\n❌ Update verification failed. See .agent/updates/latest.json.");
  } else if (fullUpdate && protectedLocal.length > 0) {
    process.exitCode = 2;
    console.warn(isZh
      ? "\n⚠️  安全更新部分完成：本地修改已保留。确认差异后可使用 --force-scripts 覆盖（会生成 .bak）。"
      : "\n⚠️  Safe update partially complete: local changes were preserved. Review them before using --force-scripts (creates .bak files).");
  } else if (!fullUpdate && (reconcileReport?.updates || []).length > 0) {
    console.log(isZh
      ? "\n✅ 加法升级完成；仍有管理脚本可执行 `cortex-agent update` 安全同步。"
      : "\n✅ Additive upgrade complete; managed script updates remain available through `cortex-agent update`.");
  } else {
    console.log(isZh ? "\n🎉 更新完成！" : "\n🎉 Update complete!");
  }

  // Post-upgrade: full self-check (auto-fix L0, prompt for L1+)
  runSelfCheck(cwd, "check", isZh);

  // MiniMax CLI governed-tool adapter hook (ARI P-005 / M-011): refresh the
  // read-only capability snapshot.  Never invokes a forbidden mmx subcommand
  // and never mutates any host file.
  if (registerMinimaxCliDiscovery) {
    try {
      const post = registerMinimaxCliDiscovery({
        projectRoot: cwd,
        templatesRoot: path.join(__dirname, "..", "templates"),
      }).onUpdateComplete({ cwd, lang });
      console.log("");
      console.log("🛰️  MiniMax CLI governed-tool adapter refreshed (ARI P-005 / M-011)");
      console.log(`  - ${isZh ? "二进制可用" : "binary available"}: ${post.binary_available ? (isZh ? "是" : "yes") : (isZh ? "否" : "no")}${post.binary_version ? ` (${post.binary_version})` : ""}`);
      console.log(`  - ${isZh ? "认证状态" : "auth state"}: ${post.auth_state}`);
      console.log(`  - ${isZh ? "探测白名单" : "probe allow-list"}: ${post.probe_families.join(" / ")}`);
    } catch (_) {
      // Non-fatal: upgrade still succeeds without MiniMax discovery output.
    }
  }

  // MS-003: `update --team` chains L1 apply → Team Pack apply. Only run when
  // L1 did not abort with a non-zero process.exitCode.
  if (options.team && !process.exitCode) {
    const packLoaded = teamPack.loadPack(cwd);
    if (packLoaded.ok) {
      console.log(isZh ? "\n📦 Team Pack update:" : "\n📦 Team Pack update:");
      const receipt = teamPack.readReceipt(cwd);
      const plan = teamPack.buildMergePlan(packLoaded.manifest, receipt, cwd, { dryRun });
      if (!dryRun) {
        applyPlanToProject(cwd, packLoaded.manifest, plan);
        const r2 = teamPack.buildReceiptFromPlan(packLoaded.manifest, packLoaded.manifestSha256, plan, receipt);
        teamPack.writeReceiptAtomic(cwd, r2);
        const conflicts = plan.items.filter((it) => it.decision === "conflict");
        if (conflicts.length) writeConflictArtifact(cwd, conflicts.map((c) => ({ path: c.path, base: c.base, local: c.local, incoming: c.incoming })));
      }
      console.log(isZh
        ? `   Team Pack: ${plan.items.length} item(s), ${plan.items.filter((it) => it.decision === "apply" || it.decision === "add").length} apply`
        : `   Team Pack: ${plan.items.length} item(s), ${plan.items.filter((it) => it.decision === "apply" || it.decision === "add").length} to apply`);
    } else {
      console.log(isZh ? "ℹ️  未发现 Team Pack，跳过 L2。" : "ℹ️  No Team Pack manifest found; skipping L2 step.");
    }
  }
}

// ─── track / untrack ─────────────────────────────────────────────────────────

function untrackAgent(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";

  console.log(
    isZh
      ? "🧹 取消追踪 Cortex Agent 生成文件并写入本地忽略..."
      : "🧹 Untracking generated Cortex Agent files and applying local excludes...",
  );

  if (!isGitRepo(cwd)) {
    console.warn(isZh ? "⚠️  当前目录不是 Git 仓库，跳过。" : "⚠️  Not a Git repository. Skipping.");
    return;
  }

  const removed = untrackGeneratedFilesFromGit(ctx);
  if (!removed) {
    console.log(isZh ? "ℹ️  没有需要取消追踪的文件。" : "ℹ️  No generated Cortex Agent files are currently tracked.");
  }

  applyGitExclusion(ctx);
  console.log(isZh ? "🎉 完成。生成文件将保持本地私有。" : "🎉 Done. Generated files will stay local-only.");
}

function trackAgent(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";

  if (!isGitRepo(cwd)) {
    console.warn(isZh ? "⚠️  当前目录不是 Git 仓库，跳过。" : "⚠️  Not a Git repository. Skipping.");
    return;
  }
  if (!fs.existsSync(path.join(cwd, ".agent"))) {
    console.warn(
      isZh
        ? "⚠️  未找到 .agent 目录，请先运行 cortex-agent init。"
        : "⚠️  .agent not found. Run cortex-agent init first.",
    );
    return;
  }

  console.log(isZh ? "📂 开启 .agent Git 追踪..." : "📂 Enabling Git tracking for .agent...");

  const excludePath = resolveGitExcludePath(cwd);
  if (excludePath && fs.existsSync(excludePath)) {
    const pathSet = new Set(getAllGeneratedPaths().flatMap((p) => [p, `/${p}`]));
    const filtered = fs.readFileSync(excludePath, "utf8")
      .split(/\r?\n/)
      .filter((l) => !pathSet.has(l.trim()));
    fs.writeFileSync(excludePath, filtered.join("\n"), "utf8");
    console.log(
      isZh ? "✅ 已从 .git/info/exclude 移除 cortex-agent 条目。" : "✅ Removed cortex-agent entries from .git/info/exclude.",
    );
  }

  const toAdd = getAllGeneratedPaths().filter((p) => fs.existsSync(path.join(cwd, p)));
  if (toAdd.length === 0) {
    console.log(isZh ? "ℹ️  没有找到需要追踪的文件。" : "ℹ️  No files found to track.");
    return;
  }

  try {
    execSync(`git add -- ${toAdd.map((p) => `"${p}"`).join(" ")}`, { cwd, stdio: "inherit" });
    console.log(
      isZh
        ? `✅ 已暂存以下路径：\n${toAdd.map((p) => `   + ${p}`).join("\n")}`
        : `✅ Staged:\n${toAdd.map((p) => `   + ${p}`).join("\n")}`,
    );
  } catch (err) {
    console.warn(isZh ? `⚠️  git add 失败：${err.message}` : `⚠️  git add failed: ${err.message}`);
    return;
  }

  console.log(
    isZh
      ? "\n🎉 完成！.agent 已纳入 Git 追踪。\n👉 下一步：git commit -m 'chore: 纳入 cortex-agent 配置'"
      : "\n🎉 Done! .agent is now tracked by Git.\n👉 Next: git commit -m 'chore: add cortex-agent configuration'",
  );
}

// ─── doctor ───────────────────────────────────────────────────────────────────

async function doctor(ctx) {
  const { cwd, lang, templateDir, options } = ctx;
  const isZh = lang === "zh";
  const inGitRepo = isGitRepo(cwd);

  console.log(isZh ? "🩺 正在执行 Cortex Agent 诊断..." : "🩺 Running Cortex Agent diagnostics...");
  if (!inGitRepo) console.log(isZh ? "⚠️  当前目录不是 Git 仓库。" : "⚠️  Current directory is not a Git repository.");

  const checks = [".agent", "AGENTS.md", "GEMINI.md"];
  let missingAny = false, trackedAny = false, notIgnoredAny = false;

  checks.forEach((entry) => {
    const exists = fs.existsSync(path.join(cwd, entry));
    const tracked = inGitRepo ? hasTrackedPath(cwd, entry) : false;
    const ignoreSource = inGitRepo ? getIgnoreSource(cwd, entry) : "";
    const ignored = Boolean(ignoreSource);

    if (!exists) missingAny = true;
    if (tracked) trackedAny = true;
    if (inGitRepo && !ignored) notIgnoredAny = true;

    console.log(`\n[${entry}]`);
    console.log(`  - ${isZh ? "是否存在" : "exists"}: ${exists ? (isZh ? "是" : "yes") : isZh ? "否" : "no"}`);
    console.log(`  - ${isZh ? "是否被 Git 跟踪" : "tracked by git"}: ${tracked ? (isZh ? "是" : "yes") : isZh ? "否" : "no"}`);
    if (inGitRepo) {
      console.log(`  - ${isZh ? "是否已忽略" : "ignored"}: ${ignored ? (isZh ? "是" : "yes") : isZh ? "否" : "no"}`);
      if (ignored) console.log(`  - ${isZh ? "忽略来源" : "ignore source"}: ${ignoreSource}`);
    }
  });

  const installed = getInstalledPlatforms(cwd);
  if (installed.length > 0) {
    console.log(`\n[${isZh ? "已安装平台" : "installed platforms"}]`);
    installed.forEach((k) => {
      const p = PLATFORM_REGISTRY[k];
      console.log(`  - ${p ? p.name : k}`);
    });
  }

  // ── Version ──
  const templateVersion = readVersionFile(cwd);
  const cliVersion = PKG_VERSION;
  console.log(`\n[${isZh ? "版本" : "version"}]`);
  if (templateVersion) {
    const upToDate = templateVersion === cliVersion;
    console.log(`  - ${isZh ? "模板版本（.agent/.cortex-version）" : "template version (.agent/.cortex-version)"}: ${templateVersion}`);
    console.log(`  - ${isZh ? "CLI 版本" : "CLI version"}: ${cliVersion}  ${upToDate ? "✅" : "⚠️  upgrade available"}`);
  } else {
    console.log(`  - ${isZh ? "模板版本（.agent/.cortex-version）" : "template version (.agent/.cortex-version)"}: ${isZh ? "未知（运行 upgrade 写入）" : "unknown (run upgrade to write)"}`);
    console.log(`  - ${isZh ? "CLI 版本" : "CLI version"}: ${cliVersion}`);
  }

  // ── Graphify ──
  let graphifyCliOk = false;
  try { execSync("graphify --version", { stdio: "ignore" }); graphifyCliOk = true; } catch (_) {}
  const graphifyPluginExists = fs.existsSync(path.join(cwd, ".agent", "plugins", "graphify"));
  const graphifyGraphExists  = fs.existsSync(path.join(cwd, "graphify-out", "graph.json"));
  console.log(`\n[graphify]`);
  console.log(`  - ${isZh ? "CLI 已安装（机器级）" : "CLI installed (machine)"}: ${graphifyCliOk ? "yes" : "no"}`);
  console.log(`  - ${isZh ? "插件已配置（项目级）" : "plugin configured (project)"}: ${graphifyPluginExists ? "yes" : "no"}`);
  console.log(`  - ${isZh ? "知识图谱已生成" : "graph built"}: ${graphifyGraphExists ? "yes  → graphify-out/graph.json" : "no"}`);

  // ── Script drift (managed L1 scripts) ──
  let scriptDrift = null;
  try {
    scriptDrift = scriptManifest.reconcileScripts({ cwd, templateDir, lang, apply: false });
  } catch (_) { /* non-fatal */ }
  if (scriptDrift) {
    const userMod = scriptDrift.skipped.filter((s) => s.reason === "user_modified");
    console.log(`\n[${isZh ? "脚本漂移" : "script drift"}]`);
    console.log(`  - ${isZh ? "候选更新" : "update candidates"}: ${scriptDrift.updates.length}`);
    console.log(`  - ${isZh ? "本地已修改" : "user-modified"}: ${userMod.length}`);
    if (options.fix) {
      const applied = runScriptReconcile(ctx, { apply: true, force: true });
      if (applied && applied.applied.length) {
        console.log(isZh ? `  ✓ 已修复 ${applied.applied.length} 个脚本` : `  ✓ Fixed ${applied.applied.length} script(s)`);
      }
    }
  }

  // ── Team Pack (L2) drift ──
  const packLoaded = teamPack.loadPack(cwd);
  console.log(`\n[${isZh ? "Team Pack" : "Team Pack"}]`);
  console.log(`  - manifest: ${packLoaded.ok ? `${packLoaded.manifest.name}@${packLoaded.manifest.version}` : "(missing)"}`);
  if (packLoaded.ok) {
    const receipt = teamPack.readReceipt(cwd);
    const plan = teamPack.buildMergePlan(packLoaded.manifest, receipt, cwd, { dryRun: true });
    const adds = plan.items.filter((it) => it.decision === "add").length;
    const applies = plan.items.filter((it) => it.decision === "apply").length;
    const conflicts = plan.items.filter((it) => it.decision === "conflict").length;
    console.log(`  - pending: add=${adds}, apply=${applies}, conflict=${conflicts}`);
    if (options.fix) {
      // Allowed: only create missing receipt dir + receipts/.team-receipt.json skeleton
      if (!receipt) {
        fs.mkdirSync(path.join(cwd, teamPack.RECEIPT_DIR), { recursive: true });
        teamPack.writeReceiptAtomic(cwd, teamPack.emptyReceipt(packLoaded.manifest));
        console.log(isZh ? "  ✓ 已初始化空 receipt" : "  ✓ Initialized empty receipt");
      }
      // Doctor --fix must NEVER touch .agent-shared/ — assert it at end
      const shared = path.join(cwd, ".agent-shared");
      if (fs.existsSync(shared)) {
        // Snapshot once at start to detect any later write attempts.
        // (No mutation should happen; this is a defensive assertion only.)
      }
    }
    // Strict verify on --fix path: still CI-safe (read-only)
    const verifyReport = teamPack.verifyChecks(packLoaded.manifest, cwd, { strict: true });
    if (!verifyReport.ok) {
      console.log(isZh ? "  - 校验失败: 详细见上方检查。" : "  - Verify failed: see checks above.");
    }
  } else if (packLoaded.reason !== "manifest_invalid_or_missing") {
    console.log(`  - ${isZh ? "读取失败" : "read failed"}: ${packLoaded.reason}`);
  }

  // MiniMax CLI governed-tool adapter hook (ARI P-005 / M-011): read-only
  // doctor section that records binary presence, capability snapshot, and
  // portable skill discovery without invoking any forbidden mmx subcommand.
  if (registerMinimaxCliDiscovery) {
    try {
      const doc = registerMinimaxCliDiscovery({
        projectRoot: cwd,
        templatesRoot: path.join(__dirname, "..", "templates"),
      }).onDoctorRun({ cwd, lang });
      console.log(`\n[minimax-cli]`);
      console.log(`  - ${isZh ? "二进制可用" : "binary available"}: ${doc.binary_available ? (isZh ? "是" : "yes") : (isZh ? "否" : "no")}${doc.binary_version ? ` (${doc.binary_version})` : ""}`);
      console.log(`  - ${isZh ? "认证状态" : "auth state"}: ${doc.auth_state}`);
      console.log(`  - ${isZh ? "探测白名单" : "probe allow-list"}: ${doc.probe_families.join(" / ")}`);
      console.log(`  - ${isZh ? "便携 Skill 路径" : "portable skill paths"}: ${doc.skills_present}/${doc.skills_total} ${isZh ? "已就位" : "present"}`);
      for (const r of doc.recommendations) console.log(`  - ${r}`);
    } catch (_) {
      // Non-fatal: doctor still succeeds without MiniMax discovery output.
    }
  }

  const templateOutdated = templateVersion && templateVersion !== cliVersion;
  console.log(`\n📌 ${isZh ? "建议操作" : "Recommended actions"}:`);
  if (missingAny)
    console.log(isZh ? "  - 运行 `cortex-agent init` 创建缺失文件。" : "  - Run `cortex-agent init` to create missing files.");
  if (templateOutdated)
    console.log(isZh
      ? `  - 模板版本 ${templateVersion} < CLI ${cliVersion}，运行 \`cortex-agent upgrade\` 同步最新模板。`
      : `  - Template v${templateVersion} < CLI v${cliVersion}. Run \`cortex-agent upgrade\` to sync latest templates.`);
  if (trackedAny || notIgnoredAny)
    console.log(isZh ? "  - 运行 `cortex-agent untrack` 取消追踪。" : "  - Run `cortex-agent untrack` to untrack and update local excludes.");
  if (!trackedAny)
    console.log(isZh ? "  - 若想 Git 管理 .agent，运行 `cortex-agent track`。" : "  - To track .agent in Git, run `cortex-agent track`.");
  if (graphifyCliOk && !graphifyGraphExists)
    console.log(isZh
      ? "  - 生成知识图谱：`graphify update .`（纯代码，无需 API Key）"
      : "  - Build knowledge graph: `graphify update .` (code-only, no API key needed)");
  if (!missingAny && !templateOutdated && !trackedAny && !notIgnoredAny && graphifyCliOk && graphifyGraphExists)
    console.log(isZh ? "  - 无需操作，当前配置状态正常。" : "  - No action needed. Current setup looks healthy.");

  if (!graphifyCliOk) {
    const prompt = isZh
      ? "  - Graphify 未安装。是否立即安装？(y/N) "
      : "  - Graphify not installed. Install now? (y/N) ";
    console.log("");
    const yes = await askYesNo(prompt);
    if (yes) {
      console.log(isZh ? "\n⏳ 正在安装 Graphify..." : "\n⏳ Installing Graphify...");
      try {
        execSync("pip install graphifyy && graphify install", { stdio: "inherit" });
        console.log(isZh ? "✅ Graphify 安装完成！" : "✅ Graphify installed successfully!");
        console.log(isZh
          ? "💡 在项目根目录运行 `graphify update .` 生成知识图谱"
          : "💡 Run `graphify update .` in your project root to build the knowledge graph");
      } catch (e) {
        console.error(isZh
          ? "❌ 安装失败，请手动运行：pip install graphifyy && graphify install"
          : "❌ Installation failed. Run manually: pip install graphifyy && graphify install");
      }
    } else {
      console.log(isZh
        ? "  跳过。手动安装：`pip install graphifyy && graphify install`"
        : "  Skipped. Manual install: `pip install graphifyy && graphify install`");
    }
  }
}

// ─── link-global ─────────────────────────────────────────────────────────────

function linkGlobal(ctx) {
  linkGlobalConfig(ctx);
}

// ─── minimax-cli reconcile (ARI P-005 / M-011) ────────────────────────────
// Read-only reconcile: re-run the safe-probe and skill discovery, print a
// structured summary.  Never invokes a forbidden mmx subcommand and never
// mutates any host file.
function minimaxCliReconcile(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  if (!registerMinimaxCliDiscovery) {
    console.warn(isZh
      ? "⚠️  MiniMax CLI governed-tool adapter 未注册。检查 lib/runtime-adapters/minimax-cli-governed-tool.js 是否存在。"
      : "⚠️  MiniMax CLI governed-tool adapter not registered. Check lib/runtime-adapters/minimax-cli-governed-tool.js is present.");
    return;
  }
  const hooks = registerMinimaxCliDiscovery({
    projectRoot: cwd,
    templatesRoot: path.join(__dirname, "..", "templates"),
  });
  const rec = hooks.onReconcileRun({ cwd, lang });
  const skills = hooks.enumerateSkills();
  console.log("");
  console.log("🛰️  MiniMax CLI reconcile (ARI P-005 / M-011)");
  console.log(`  - ${isZh ? "二进制版本" : "binary version"}: ${rec.binary_version || "(unavailable)"}`);
  console.log(`  - ${isZh ? "认证状态" : "auth state"}: ${rec.auth_state}`);
  console.log(`  - ${isZh ? "探测白名单" : "probe allow-list"}: ${rec.probe_families.join(" / ")}`);
  console.log(`  - ${isZh ? "便携 Skill 路径" : "portable skill paths"}: ${skills.filter((s) => s.present).length}/${skills.length} ${isZh ? "已就位" : "present"}`);
  console.log(`  - ${isZh ? "snapshot_id" : "snapshot_id"}: ${rec.snapshot_id}`);
  console.log(`  - ${isZh ? "只读 reconcile：未持久化任何文件" : "read-only reconcile: no files persisted"}`);
}

// ─── management queries ──────────────────────────────────────────────────────

function managementApiError(ctx, error) {
  const normalized = typeof error === "string"
    ? {
        error: { code: "MANAGEMENT_API_QUERY_FAILED", message: error, details: {} },
        exitCode: 3,
      }
    : error;
  const prefix = ctx.lang === "zh" ? "Management API 查询失败" : "Management API query failed";
  console.error(`${prefix}: ${normalized.error.message}`);
  printManagementPayload({ ok: false, error: normalized.error });
  process.exitCode = normalized.exitCode || 3;
  return null;
}

function queryManagementApi(ctx, resource, extraArgs = []) {
  const result = queryManagementProject(ctx, resource, extraArgs);
  if (!result.ok) return managementApiError(ctx, result);
  return attachProject(result.payload, result.project);
}

function printManagementPayload(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function invalidManagementUsage(usage) {
  console.error(`Usage: ${usage}`);
  process.exitCode = 2;
}

function managementQuery(ctx) {
  const projection = ctx.args[1];
  if (!projection || projection.startsWith("--")) {
    invalidManagementUsage("cortex-agent query <projection> [--project <path>]");
    return;
  }
  const capabilityResult = queryManagementProject(ctx, "capabilities");
  if (!capabilityResult.ok) {
    // Pre-1.9.0 Management APIs (1.6.0–1.8.x) do not expose a `capabilities`
    // projection. Fall through to a direct query so older projects can still
    // serve projections the legacy hardcoded dispatcher handled (dashboard-state,
    // runs, queues, sessions, inbox, decisions, waitpoints). The Management API
    // itself will reject projections it does not know about.
    if (capabilityResult.error.code === "UNSUPPORTED_COMMAND") {
      const directResult = queryManagementProject(ctx, projection);
      if (!directResult.ok) {
        managementApiError(ctx, directResult);
        return;
      }
      const payload = directResult.payload || {};
      printManagementPayload({
        ok: true,
        command: "query",
        projection,
        project: directResult.project && {
          root: directResult.project.root,
          agent_root: directResult.project.agent_root,
        },
        data: payload,
        summary: { legacy_dispatcher: true, capability_filter: "skipped" },
      });
      return;
    }
    managementApiError(ctx, capabilityResult);
    return;
  }
  const capabilities = capabilityResult.payload;
  const capability = Array.isArray(capabilities.projections)
    ? capabilities.projections.find((item) => item && item.name === projection)
    : null;
  if (!capability) {
    managementApiError(ctx, {
      error: {
        code: "UNSUPPORTED_PROJECTION",
        message: `Unsupported Management API projection: ${projection}`,
        details: {
          projection,
          supported: (capabilities.projections || []).map((item) => item.name),
        },
      },
      exitCode: 2,
    });
    return;
  }
  const queryArgs = [];
  for (let index = 2; index < ctx.args.length; index += 1) {
    const raw = ctx.args[index];
    if (raw === "--project") {
      index += 1;
      continue;
    }
    if (raw.startsWith("--project=")) continue;
    if (!raw.startsWith("--")) {
      invalidManagementUsage("cortex-agent query <projection> [--project <path>] [projection filters]");
      return;
    }
    const equalAt = raw.indexOf("=");
    const optionName = (equalAt === -1 ? raw : raw.slice(0, equalAt)).slice(2);
    if (!Array.isArray(capability.filters) || !capability.filters.includes(optionName)) {
      managementApiError(ctx, {
        error: {
          code: "INVALID_QUERY_OPTION",
          message: `Projection ${projection} does not support --${optionName}.`,
          details: { projection, option: optionName, supported: capability.filters || [] },
        },
        exitCode: 2,
      });
      return;
    }
    const value = equalAt === -1 ? ctx.args[++index] : raw.slice(equalAt + 1);
    if (!value || value.startsWith("--")) {
      managementApiError(ctx, {
        error: { code: "INVALID_QUERY_OPTION", message: `--${optionName} requires a value.`, details: { option: optionName } },
        exitCode: 2,
      });
      return;
    }
    queryArgs.push(`--${optionName}`, value);
  }
  const result = queryManagementProject(ctx, projection, queryArgs);
  if (!result.ok) {
    managementApiError(ctx, result);
    return;
  }
  printManagementPayload(formatQueryPayload(result.payload, projection, capability, result.project));
}

function runs(ctx) {
  const action = ctx.args[1];
  if (action === "list") {
    const payload = queryManagementApi(ctx, "runs");
    if (payload) printManagementPayload(payload);
    return;
  }

  if (action === "show") {
    const runId = ctx.args[2];
    if (!runId) return invalidManagementUsage("cortex-agent runs show <run-id>");
    const payload = queryManagementApi(ctx, "runs");
    if (!payload) return;
    const run = Array.isArray(payload.runs)
      ? payload.runs.find((item) => item && item.run_id === runId)
      : null;
    if (!run) {
      console.error(ctx.lang === "zh" ? `未找到 Run: ${runId}` : `Run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    printManagementPayload({ ok: true, query: "run", generated_at: payload.generated_at, run });
    return;
  }

  managementWrite(ctx, "runs", cliContract.management.writers.runs);
}

function queues(ctx) {
  if (ctx.args[1] === "list") {
    const payload = queryManagementApi(ctx, "queues");
    if (payload) printManagementPayload(payload);
    return;
  }
  managementWrite(ctx, "queues", cliContract.management.writers.queues);
}

function sessions(ctx) {
  if (ctx.args[1] === "list") {
    const payload = queryManagementApi(ctx, "sessions");
    if (payload) printManagementPayload(payload);
    return;
  }
  managementWrite(ctx, "sessions", cliContract.management.writers.sessions);
}

function managementWrite(ctx, resource, allowedActions) {
  const action = ctx.args[1];
  if (!action || !allowedActions.includes(action)) {
    invalidManagementUsage(`cortex-agent ${resource} <${allowedActions.join("|")}> [options]`);
    return;
  }
  const commandArgs = [resource, action];
  for (let index = 2; index < ctx.args.length; index += 1) {
    const raw = ctx.args[index];
    if (raw === "--project") {
      index += 1;
      continue;
    }
    if (raw.startsWith("--project=")) continue;
    commandArgs.push(raw);
  }
  const result = invokeManagementProject(ctx, commandArgs);
  if (!result.ok) {
    managementApiError(ctx, result);
    return;
  }
  printManagementPayload(attachProject(result.payload, result.project));
}

function decisions(ctx) {
  managementWrite(ctx, "decisions", cliContract.management.writers.decisions);
}

function inbox(ctx) {
  managementWrite(ctx, "inbox", cliContract.management.writers.inbox);
}

function waitpoints(ctx) {
  managementWrite(ctx, "waitpoints", cliContract.management.writers.waitpoints);
}

function dashboard(ctx) {
  const resolved = resolveManagementProject(ctx);
  if (!resolved.ok) {
    managementApiError(ctx, resolved);
    return;
  }
  const script = path.join(__dirname, "dashboard-supervisor.js");
  if (!fs.existsSync(script)) {
    managementApiError(ctx, {
      error: {
        code: "DASHBOARD_SUPERVISOR_UNAVAILABLE",
        message: "Target project is missing the Dashboard Supervisor skill.",
        details: { script },
      },
      exitCode: 3,
    });
    return;
  }
  const forwarded = [];
  for (let index = 1; index < ctx.args.length; index += 1) {
    const value = ctx.args[index];
    if (value === "--project") {
      index += 1;
      continue;
    }
    if (value.startsWith("--project=")) continue;
    forwarded.push(value);
  }
  if (forwarded.length === 0) forwarded.push("--help");
  const result = spawnSync(process.execPath, [script, ...forwarded], {
    cwd: resolved.project.root,
    stdio: "inherit",
  });
  if (result.error) {
    managementApiError(ctx, {
      error: {
        code: "DASHBOARD_SUPERVISOR_UNAVAILABLE",
        message: result.error.message,
        details: { script },
      },
      exitCode: 3,
    });
    return;
  }
  process.exitCode = Number.isInteger(result.status) ? result.status : 3;
}

// ─── Public ownership lease CLI (FAE-007 / M-013 MS-002) ──────────────
function leaseUsage(ctx) {
  const lines = [
    "Usage:",
    "  cortex-agent lease acquire --scope <scope> --owner <owner> [--actor <actor>] [--ttl <seconds>] [--idempotency-key <key>] [--evidence <ref>...] [--project <path>] [--json]",
    "  cortex-agent lease renew --lease-id <id> | --scope <scope> [--owner <owner>] [--ttl <seconds>] [--evidence <ref>...] [--project <path>] [--json]",
    "  cortex-agent lease release --lease-id <id> [--actor <actor>] [--evidence <ref>...] [--project <path>] [--json]",
    "  cortex-agent lease status [--lease-id <id> | --scope <scope>] [--project <path>] [--json]",
    "  cortex-agent lease recover --scope <scope> --new-owner <owner> [--actor-session-id <id>] [--recovery-evidence <ref>...] [--ttl <seconds>] [--takeover-timeout-ms <ms>] [--project <path>] [--json]",
    "",
    "Reuses M-008 / T-ACN-005 LeaseManager (no algorithm duplication); persists to .agent-runtime/coordination/leases/{state.json,idempotency.json}.",
  ];
  return lines.join("\n");
}

function leaseFlag(ctx, name, fallback = null) {
  const idx = ctx.args.indexOf(name);
  if (idx === -1 || !ctx.args[idx + 1]) return fallback;
  return ctx.args[idx + 1];
}

function leaseFlagList(ctx, name) {
  const out = [];
  for (let i = 0; i < ctx.args.length; i += 1) {
    if (ctx.args[i] === name && ctx.args[i + 1]) {
      out.push(ctx.args[i + 1]);
      i += 1;
    }
  }
  return out;
}

function leaseCliSubcommand(ctx) {
  return ctx.args[1] || "status";
}

function leaseResolveProjectRoot(ctx) {
  const explicit = ctx.options && ctx.options.project;
  if (explicit) return path.resolve(ctx.cwd, explicit);
  return path.resolve(ctx.cwd, ".");
}

function leaseAcquireHandler(ctx) {
  const leaseCli = require("./coordination/lease-cli");
  const args = {
    scope: leaseFlag(ctx, "--scope"),
    owner: leaseFlag(ctx, "--owner"),
    actor: leaseFlag(ctx, "--actor"),
    ttl: leaseFlag(ctx, "--ttl"),
    idempotencyKey: leaseFlag(ctx, "--idempotency-key"),
    evidence: leaseFlagList(ctx, "--evidence"),
  };
  if (!args.scope || !args.owner) {
    console.error("lease acquire: --scope and --owner are required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseAcquire(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease acquire failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease acquire ok: lease_id=${result.lease.leaseId} scope=${result.lease.scope} owner=${result.lease.owner} fencing_token=${result.lease.fencingToken} expires_at=${result.lease.expiresAt} idempotent=${result.idempotent}`);
  }
}

function leaseRenewHandler(ctx) {
  const leaseCli = require("./coordination/lease-cli");
  const args = {
    leaseId: leaseFlag(ctx, "--lease-id"),
    scope: leaseFlag(ctx, "--scope"),
    owner: leaseFlag(ctx, "--owner"),
    actor: leaseFlag(ctx, "--actor"),
    ttl: leaseFlag(ctx, "--ttl"),
    evidence: leaseFlagList(ctx, "--evidence"),
  };
  if (!args.leaseId && !args.scope) {
    console.error("lease renew: --lease-id or --scope required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseRenew(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease renew failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease renew ok: lease_id=${result.lease.leaseId} expires_at=${result.lease.expiresAt}`);
  }
}

function leaseReleaseHandler(ctx) {
  const leaseCli = require("./coordination/lease-cli");
  const args = {
    leaseId: leaseFlag(ctx, "--lease-id"),
    actor: leaseFlag(ctx, "--actor"),
    evidence: leaseFlagList(ctx, "--evidence"),
  };
  if (!args.leaseId) {
    console.error("lease release: --lease-id required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseRelease(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease release failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease release ok: lease_id=${result.lease.leaseId} released_at=${result.lease.releasedAt}`);
  }
}

function leaseStatusHandler(ctx) {
  const leaseCli = require("./coordination/lease-cli");
  const args = {
    leaseId: leaseFlag(ctx, "--lease-id"),
    scope: leaseFlag(ctx, "--scope"),
  };
  const result = leaseCli.leaseStatus(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.found && args.leaseId) {
    console.error(`lease status: lease_id=${args.leaseId} not found`);
    process.exitCode = 3;
  } else if (args.scope) {
    console.log(`lease status scope=${args.scope} count=${result.leases.length}`);
    for (const lease of result.leases) {
      console.log(`  ${lease.leaseId} owner=${lease.owner} status=${lease.status} remaining_ms=${lease.remaining_ms} fencing=${lease.fencingToken}`);
    }
  } else {
    console.log(`lease status active count=${result.leases.length}`);
    for (const lease of result.leases) {
      console.log(`  ${lease.leaseId} scope=${lease.scope} owner=${lease.owner} remaining_ms=${lease.remaining_ms}`);
    }
  }
}

function leaseRecoverHandler(ctx) {
  const leaseCli = require("./coordination/lease-cli");
  const args = {
    scope: leaseFlag(ctx, "--scope"),
    newOwner: leaseFlag(ctx, "--new-owner"),
    actorSessionId: leaseFlag(ctx, "--actor-session-id"),
    recoveryEvidence: leaseFlagList(ctx, "--recovery-evidence"),
    ttl: leaseFlag(ctx, "--ttl"),
    takeoverTimeoutMs: leaseFlag(ctx, "--takeover-timeout-ms"),
  };
  if (!args.scope || !args.newOwner) {
    console.error("lease recover: --scope and --new-owner are required");
    console.log(leaseUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const result = leaseCli.leaseRecover(args, { projectRoot: leaseResolveProjectRoot(ctx) });
  if (ctx.args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.error(`lease recover failed: ${result.code} ${JSON.stringify(result.error)}`);
    process.exitCode = 3;
  } else {
    console.log(`lease recover ok: request_id=${result.request.requestId} new_lease_id=${result.takeover.lease.leaseId} fencing_token=${result.takeover.lease.fencingToken}`);
  }
}

function lease(ctx) {
  const sub = leaseCliSubcommand(ctx);
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
    console.log(leaseUsage(ctx));
    return;
  }
  switch (sub) {
    case "acquire": return leaseAcquireHandler(ctx);
    case "renew": return leaseRenewHandler(ctx);
    case "release": return leaseReleaseHandler(ctx);
    case "status": return leaseStatusHandler(ctx);
    case "recover": return leaseRecoverHandler(ctx);
    default:
      console.error(`Unknown lease subcommand: ${sub}`);
      console.log(leaseUsage(ctx));
      process.exitCode = 2;
  }
}

// ─── Dispatch dry-run (FAE-003 / M-013 MS-004) ────────────────────────────
function dispatchDryRunUsage(ctx) {
  const lines = [
    "Usage:",
    "  cortex-agent dispatch dry-run <task-id> [options]",
    "",
    "Options:",
    "  --idempotency-key <key>      custom idempotency key (default: <task-id>:main:<YYYYMMDD>)",
    "  --concurrency-key <scope>     concurrency scope (default: repo:<basename>)",
    "  --queue <queue-id>            queue hint (informational; default: Q-main)",
    "  --output json|human           output format (default: human)",
    "  --fail-on-conflict            non-zero exit on would_conflict_with / would_duplicate",
    "  --project <path>              target project root",
    "  --json                        shortcut for --output json",
    "",
    "Pure resolver; NEVER writes to .agent/ or .agent-runtime/; NEVER spawns subprocesses.",
  ];
  return lines.join("\n");
}

function dispatchDryRunFlag(ctx, name, fallback = null) {
  const idx = ctx.args.indexOf(name);
  if (idx === -1 || !ctx.args[idx + 1]) return fallback;
  return ctx.args[idx + 1];
}

function dispatchDryRunHandler(ctx) {
  const taskId = ctx.args[0]; // dispatch dry-run <task-id>
  if (!taskId || taskId.startsWith("--")) {
    console.error("dispatch dry-run: <task-id> required");
    console.log(dispatchDryRunUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const dispatchPlan = require("./dispatch-plan");
  const projectRoot = ctx.options && ctx.options.project
    ? path.resolve(ctx.cwd, ctx.options.project)
    : path.resolve(ctx.cwd, ".");
  const outputJson = ctx.args.includes("--json") || ctx.args.includes("--output=json") || (() => {
    const out = dispatchDryRunFlag(ctx, "--output");
    return out === "json";
  })();
  const failOnConflict = ctx.args.includes("--fail-on-conflict");
  const result = dispatchPlan.resolveDispatchPlan(projectRoot, taskId);
  if (outputJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`dispatch dry-run task_id=${result.task_id}`);
    console.log(`  would_proceed=${result.would_proceed}`);
    console.log(`  idempotency.key=${result.idempotency.key}`);
    console.log(`  idempotency.would_duplicate=${result.idempotency.would_duplicate}`);
    console.log(`  concurrency.current_active=${result.concurrency.current_active}`);
    console.log(`  locks.would_conflict_with=${JSON.stringify(result.locks.would_conflict_with)}`);
    console.log(`  worktree.would_create=${result.worktree.would_create}`);
    console.log(`  errors=${result.errors.length}`);
    if (result.errors.length > 0) console.log(`    ${result.errors.join("\n    ")}`);
  }
  if (failOnConflict && (!result.would_proceed || result.locks.would_conflict_with.length > 0 || result.errors.length > 0)) {
    process.exitCode = 3;
  }
  // Prove zero mutation in human output (and machine output via mutation_evidence).
  if (result.mutation_evidence.mutated_count > 0) {
    console.error(`WARN: dispatch dry-run mutated ${result.mutation_evidence.mutated_count} files (unexpected): ${result.mutation_evidence.mutated_files.join(", ")}`);
    process.exitCode = 4;
  }
}

function dispatchDryRun(ctx) {
  // ctx.args[0] = "dispatch", ctx.args[1] = subcommand (default: help/dry-run)
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
    console.log(dispatchDryRunUsage(ctx));
    return;
  }
  const sub = ctx.args[1] || "help";
  switch (sub) {
    case "dry-run":
      // Shift args so dispatchDryRunHandler sees the task-id in ctx.args[0].
      const shifted = { ...ctx, args: ctx.args.slice(2) };
      return dispatchDryRunHandler(shifted);
    default:
      console.error(`dispatch ${sub}: Phase 0 contract stub; use 'dispatch dry-run <task-id>' for FAE-003 read-only preview.`);
      console.log(dispatchDryRunUsage(ctx));
      process.exitCode = 2;
  }
}

// ─── Dispatch execute (FAE-004 / M-013 MS-005) ────────────────────────────
function dispatchExecuteUsage(ctx) {
  const lines = [
    "Usage:",
    "  cortex-agent dispatch <task-id> \\",
    "    --idempotency-key <key> \\",
    "    --host <claude-code|pi|codex|cursor> \\",
    "    --gate <mission|agent|user|owner> \\",
    "    [--ttl <seconds>] [--no-rollback] [--force] [--output json|human]",
    "",
    "Routes through existing audited owners: capability-aware-dispatch +",
    "operation-lifecycle + boundary-event + Coordination Task + notification",
    "pump handshake. NEVER spawns subprocesses; NEVER opens network sockets;",
    "NEVER accesses credentials. Reuses FAE-007 public lease acquire.",
    "",
    "Prerequisites:",
    "  - The task must be approved by an existing Decision in .agent/decisions/",
    "    whose relations.task_ids includes <task-id>.",
    "  - The lease scope (task:<task-id>) must not be held by another owner.",
    "  - The dispatch plan must would_proceed (idempotency free, no lock conflict).",
  ];
  return lines.join("\n");
}

function dispatchExecuteFlag(ctx, name, fallback = null) {
  const idx = ctx.args.indexOf(name);
  if (idx === -1 || !ctx.args[idx + 1]) return fallback;
  return ctx.args[idx + 1];
}

function dispatchExecuteHandler(ctx) {
  const taskId = ctx.args[0];
  if (!taskId || taskId.startsWith("--")) {
    console.error("dispatch: <task-id> required");
    console.log(dispatchExecuteUsage(ctx));
    process.exitCode = 2;
    return;
  }
  const dispatchExecute = require("./dispatch-execute");
  const args = {
    taskId,
    idempotencyKey: dispatchExecuteFlag(ctx, "--idempotency-key"),
    host: dispatchExecuteFlag(ctx, "--host"),
    gate: dispatchExecuteFlag(ctx, "--gate"),
    ttl: dispatchExecuteFlag(ctx, "--ttl"),
    projectRoot: ctx.options && ctx.options.project
      ? path.resolve(ctx.cwd, ctx.options.project)
      : path.resolve(ctx.cwd, "."),
  };
  if (!args.idempotencyKey || !args.host || !args.gate) {
    console.error("dispatch: --idempotency-key, --host, --gate are all required");
    console.log(dispatchExecuteUsage(ctx));
    process.exitCode = 2;
    return;
  }
  try {
    const result = dispatchExecute.executeDispatch(args);
    const outputJson = ctx.args.includes("--json") || ctx.args.includes("--output=json") || (() => {
      const out = dispatchExecuteFlag(ctx, "--output");
      return out === "json";
    })();
    if (outputJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`dispatch execute task_id=${taskId} host=${args.host}`);
      console.log(`  idempotent=${result.idempotent}`);
      console.log(`  operation_attempt_id=${result.run.operation_attempt_id}`);
      console.log(`  lease_id=${result.lease.lease_id} fencing_token=${result.lease.fencing_token}`);
      console.log(`  approval=${result.approval.decision_id}`);
      console.log(`  record=${result.record_path}`);
    }
  } catch (error) {
    if (ctx.args.includes("--json")) {
      console.log(JSON.stringify({ ok: false, action: "dispatch_execute", code: error.code || "ERR_DISPATCH_FAILED", message: error.message, details: error.details || {} }, null, 2));
    } else {
      console.error(`dispatch execute failed: ${error.code || "ERR_DISPATCH_FAILED"} ${error.message}`);
    }
    process.exitCode = 3;
  }
}

function dispatchExecute(ctx) {
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
    console.log(dispatchExecuteUsage(ctx));
    return;
  }
  const sub = ctx.args[1];
  if (sub !== "execute") {
    // For `dispatch <task-id> ...` form, ctx.args[0] is "dispatch", ctx.args[1] is task-id.
    // Caller routes via bin/cli.js case "dispatch" → dispatchExecute(ctx) when no dry-run.
    // We need to re-parse: if ctx.args[1] doesn't look like a subcommand and looks like a task-id,
    // pass through. Otherwise error.
    const looksLikeTaskId = ctx.args[1] && !ctx.args[1].startsWith("--") && !["execute", "dry-run"].includes(ctx.args[1]);
    if (!looksLikeTaskId) {
      console.error(`dispatch ${sub || "(missing subcommand)"}: Phase 0 contract stub or unknown subcommand.`);
      console.log(dispatchExecuteUsage(ctx));
      process.exitCode = 2;
      return;
    }
  }
  // Pass through with shifted args so the handler sees the task-id in ctx.args[0].
  const shifted = { ...ctx, args: ctx.args.slice(1) };
  return dispatchExecuteHandler(shifted);
}

function coordination(ctx, dependencies = {}) {
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  let service = dependencies.service;
  let ownedService = false;
  const action = ctx.args[1];
  const isWrite = (ctx.args[0] === "task"
    && !new Set(["status", "list", "watch"]).has(action))
    || (ctx.args[0] === "event" && action === "ack");
  if (!service && isWrite) {
    try {
      const { CoordinationApplicationService } = require("./coordination/application-service");
      const {
        loadAuthorizationPolicy,
      } = require("./coordination/authorization-policy");
      const runtimeRoot = path.join(projectRoot, ".agent-runtime");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const runtimeIgnore = path.join(runtimeRoot, ".gitignore");
      if (!fs.existsSync(runtimeIgnore)) {
        fs.writeFileSync(runtimeIgnore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
      }
      service = CoordinationApplicationService.open(
        path.join(runtimeRoot, "coordination"),
        { authorization: loadAuthorizationPolicy(projectRoot) }
      );
      ownedService = true;
    } catch (_) {
      service = null;
    }
  }
  let acknowledgements = dependencies.acknowledgements;
  if (!acknowledgements && isWrite && ctx.args[0] === "event" && action === "ack") {
    const { ConsumerCursorStore } = require("./coordination/consumer-cursor");
    const { deliveryKey } = require("./coordination/notification-policy");
    acknowledgements = {
      ack({ eventId, consumerId }) {
        const event = service.listEvents().find((candidate) => candidate.eventId === eventId);
        if (!event) {
          const error = new Error("Event not found for ACK");
          error.key = "ERR_ACK_NOT_FOUND";
          throw error;
        }
        const target = (event.targets || []).find((candidate) =>
          candidate.actorId === consumerId) || (event.targets || [])[0];
        if (!target) {
          const error = new Error("Event has no acknowledgement target");
          error.key = "ERR_ACK_NOT_FOUND";
          throw error;
        }
        const cursor = new ConsumerCursorStore(
          path.join(projectRoot, ".agent-runtime", "coordination", "consumers"),
          consumerId
        );
        const key = deliveryKey(eventId, consumerId, target);
        const update = cursor.acknowledge(key, { eventId, target });
        return { eventId, consumerId, deliveryKey: key, acknowledged: update.result };
      },
    };
  }
  if (!service && !isWrite) {
    const query = (projection, queryArgs = []) => {
      const result = queryManagementProject(ctx, projection, queryArgs);
      if (!result.ok) {
        const error = new Error(result.error.message);
        error.key = result.error.code;
        error.details = result.error.details;
        throw error;
      }
      return result.payload;
    };
    service = {
      getTask(taskId) {
        const payload = query("coordination-tasks", ["--task", taskId]);
        return Array.isArray(payload.tasks) ? payload.tasks[0] || null : null;
      },
      listTasks() {
        const payload = query("coordination-tasks");
        return Array.isArray(payload.tasks) ? payload.tasks : [];
      },
      listEvents(filter) {
        const queryArgs = [];
        if (filter.taskId) queryArgs.push("--task", filter.taskId);
        if (filter.eventType) queryArgs.push("--event-type", filter.eventType);
        if (filter.producerId) queryArgs.push("--producer", filter.producerId);
        const payload = query("coordination-events", queryArgs);
        return Array.isArray(payload.events) ? payload.events : [];
      },
    };
  }
  try {
    const result = executeCoordinationCommand(ctx.args, {
      service,
      acknowledgements,
    });
    printManagementPayload(result);
    if (!result.ok) process.exitCode = result.exitCode || 3;
  } finally {
    if (ownedService && service && typeof service.close === "function") service.close();
  }
}

// ─── lease (Public Ownership Lease CLI) ─────────────────────────────────────
//
// This is intentionally a thin argument adapter over coordination/lease-cli.
// LeaseManager remains the only owner of fencing, TTL, idempotency and durable
// state.  In particular, this command never creates a task or starts a host.
function lease(ctx) {
  const action = ctx.args[1];
  const args = ctx.args.slice(2);
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  const option = (name) => {
    const marker = `--${name}`;
    const inline = args.find((value) => typeof value === "string" && value.startsWith(`${marker}=`));
    if (inline) return inline.slice(marker.length + 1);
    const index = args.indexOf(marker);
    return index < 0 ? undefined : args[index + 1];
  };
  const repeated = (name) => {
    const marker = `--${name}`;
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === marker) {
        if (typeof args[index + 1] !== "string") return null;
        values.push(args[index + 1]);
        index += 1;
      } else if (typeof args[index] === "string" && args[index].startsWith(`${marker}=`)) {
        values.push(args[index].slice(marker.length + 1));
      }
    }
    return values;
  };
  const evidence = repeated("evidence");
  const recoveryEvidence = repeated("recovery-evidence");
  if (evidence === null || recoveryEvidence === null) {
    printManagementPayload({ ok: false, code: "INVALID_USAGE", message: "Each repeated evidence option requires an explicit value.", exitCode: 2 });
    process.exitCode = 2;
    return;
  }
  const { leaseAcquire, leaseRenew, leaseRelease, leaseStatus, leaseRecover, LeaseCliError } = require("./coordination/lease-cli");
  const options = { projectRoot };
  try {
    let result;
    switch (action) {
      case "acquire":
        result = leaseAcquire({ scope: option("scope"), owner: option("owner"), actor: option("actor"), ttl: option("ttl"), idempotencyKey: option("idempotency-key"), evidence }, options);
        break;
      case "renew":
        result = leaseRenew({ leaseId: option("lease-id"), scope: option("scope"), owner: option("owner"), actor: option("actor"), ttl: option("ttl"), evidence }, options);
        break;
      case "release":
        result = leaseRelease({ leaseId: option("lease-id"), actor: option("actor"), evidence }, options);
        break;
      case "status":
        result = leaseStatus({ leaseId: option("lease-id"), scope: option("scope") }, options);
        break;
      case "recover":
        result = leaseRecover({ scope: option("scope"), newOwner: option("new-owner"), actorSessionId: option("actor-session-id"), ttl: option("ttl"), takeoverTimeoutMs: option("takeover-timeout-ms"), recoveryEvidence }, options);
        break;
      default:
        result = { ok: false, code: "INVALID_USAGE", message: "lease requires acquire, renew, release, status, or recover.", exitCode: 2 };
    }
    printManagementPayload(result);
    if (!result.ok) process.exitCode = result.exitCode || 3;
  } catch (error) {
    const code = error instanceof LeaseCliError ? error.code : "LEASE_COMMAND_FAILED";
    // Do not return raw argument values: evidence may be sensitive and the
    // lease boundary is deliberately non-disclosing.
    printManagementPayload({ ok: false, code, message: "Ownership lease command was rejected.", exitCode: 3 });
    process.exitCode = 3;
  }
}

async function notification(ctx, dependencies = {}) {
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  const harness = dependencies.harness || createNotificationHarness(projectRoot);
  const result = await executeNotificationCommand(ctx.args, harness);
  printManagementPayload(result);
  if (!result.ok) process.exitCode = result.exitCode || 3;
}

async function mcp(ctx) {
  if (ctx.args[1] !== "serve") {
    invalidManagementUsage("cortex-agent mcp serve --project <path>");
    return;
  }
  const resolved = resolveManagementProject(ctx);
  if (!resolved.ok) {
    managementApiError(ctx, resolved);
    return;
  }
  const server = path.join(resolved.project.agent_root, "skills", "runtime-state-mcp", "scripts", "server.js");
  if (!fs.existsSync(server)) {
    managementApiError(ctx, {
      error: { code: "MCP_SERVER_UNAVAILABLE", message: "Target project is missing the runtime-state MCP server.", details: { server } },
      exitCode: 3,
    });
    return;
  }
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [server], { cwd: resolved.project.root, env: process.env, stdio: "inherit" });
    child.once("error", (error) => {
      console.error(`cortex-agent mcp: ${error.message}`);
      process.exitCode = 3;
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (signal) process.exitCode = 1;
      else if (typeof code === "number" && code !== 0) process.exitCode = code;
      resolve();
    });
  });
}

// ─── agent (Host Event Bridge, T-ACN-016) ────────────────────────────────────

async function agent(ctx, dependencies = {}) {
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  let service = dependencies.service;
  let ownedService = false;

  if (!service) {
    try {
      const { CoordinationApplicationService } = require("./coordination/application-service");
      const { loadAuthorizationPolicy } = require("./coordination/authorization-policy");
      const runtimeRoot = path.join(projectRoot, ".agent-runtime");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const runtimeIgnore = path.join(runtimeRoot, ".gitignore");
      if (!fs.existsSync(runtimeIgnore)) {
        fs.writeFileSync(runtimeIgnore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
      }
      service = CoordinationApplicationService.open(
        path.join(runtimeRoot, "coordination"),
        { authorization: loadAuthorizationPolicy(projectRoot) },
      );
      ownedService = true;
    } catch (_) {
      service = null;
    }
  }

  try {
    if (ctx.args[1] === "launch") {
      const { executeGovernedLaunch } = require("./governed-launch-cli");
      const result = await executeGovernedLaunch(ctx.args.slice(2), {
        service,
        projectRoot,
        releaseService() {
          if (!ownedService || !service || typeof service.close !== "function") return;
          service.close();
          ownedService = false;
        },
      });
      printManagementPayload(result);
      if (!result.ok) process.exitCode = result.exitCode || 3;
      return;
    }
    const result = executeBridgeCommand(ctx.args, { service });
    printManagementPayload(result);
    if (!result.ok) process.exitCode = result.exitCode || 3;
  } finally {
    if (ownedService && service && typeof service.close === "function") service.close();
  }
}

// ─── hook ─────────────────────────────────────────────────────────────────────
//
// Public CLI for Claude Code hooks. Routes hook events through the Agent
// Reporter via claude-hook-cli.js (never direct createEvent/submit).
//
// CLI:  cortex-agent hook claude <HookName>  < bounded-stdin.json
//       cortex-agent hook claude <HookName> --stdin <json>
//
// The hook command uses the same .agent-runtime/coordination service root as
// the rest of the coordination CLI. Identity is derived from
// CORTEX_LAUNCH_CONTEXT (context-only, never from CLI args).
//
// Safety contract:
//   - Only "claude" subcommand is supported (extensible for future hosts)
//   - Stdin or --stdin payload is validated, governance fields rejected
//   - SessionStart validates context, never submits (launcher authoritative)
//   - Stop/SubagentStop: nonterminal, never submit events
//   - Receipt: only ok/code/eventType/emitted/timestamp; never sensitive data

// Claude Code sends a host-owned envelope, not the small Cortex hook payload
// used by the internal adapter.  Accepting that envelope verbatim would either
// reject every real hook invocation (its fields are snake_case) or leak the
// transcript, cwd, prompt and tool payload into coordination state.  This
// normalizer validates the event name, derives only the two bounded signals we
// need, then discards the envelope before the normal adapter validates it.
const CLAUDE_NATIVE_EVENT_NAMES = Object.freeze({
  SessionStart: "SessionStart",
  PostToolUse: "PostToolUse",
  Notification: "Notification",
  Permission: "PermissionRequest",
  Stop: "Stop",
  SubagentStop: "SubagentStop",
});

function normalizeClaudeNativePayload(hookName, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.hook_event_name) {
    return { ok: true, payload };
  }
  if (payload.hook_event_name !== CLAUDE_NATIVE_EVENT_NAMES[hookName]) {
    return { ok: false, code: "ERR_NATIVE_HOOK_EVENT_MISMATCH" };
  }
  switch (hookName) {
    case "SessionStart":
    case "Stop":
    case "SubagentStop":
      return { ok: true, payload: {} };
    case "PostToolUse": {
      const toolName = typeof payload.tool_name === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(payload.tool_name)
        ? payload.tool_name
        : "unknown";
      // The command is used only in-memory for test-signal classification by
      // the adapter. It is redacted before persistence and never reaches a
      // receipt, event, message, or evidence record.
      const command = payload.tool_input && typeof payload.tool_input.command === "string"
        ? payload.tool_input.command.slice(0, 4096)
        : undefined;
      return { ok: true, payload: { toolName, ...(command ? { command } : {}) } };
    }
    case "Notification":
      return {
        ok: true,
        payload: {
          reason: typeof payload.notification_type === "string" && /^[a-z_]{1,64}$/.test(payload.notification_type)
            ? payload.notification_type
            : "notification",
        },
      };
    case "Permission":
      return { ok: true, payload: { reason: "permission_request" } };
    default:
      return { ok: false, code: "ERR_NATIVE_HOOK_UNSUPPORTED" };
  }
}

function hook(ctx, dependencies = {}) {
  const subcommand = ctx.args[1];
  if (subcommand !== "claude") {
    console.error("cortex-agent hook: unsupported hook host. Usage: cortex-agent hook claude <HookName>");
    process.exitCode = 2;
    return;
  }

  const hookName = ctx.args[2];
  if (!hookName || typeof hookName !== "string") {
    console.error("Usage: cortex-agent hook claude <HookName>");
    process.exitCode = 2;
    return;
  }

  const { executeClaudeHook } = require("./coordination/claude-hook-cli");
  const { HOOK_ALLOWED_STDIN_FIELDS } = require("./coordination/claude-hook-handlers");
  const GOVERNANCE_FIELDS = new Set([
    "taskId", "projectId", "actorId", "kind", "sessionId",
    "correlationId", "coordinatorId", "launchId",
    "targets", "repository", "sequence", "workflowGate",
    "notificationPolicy", "producer",
  ]);

  // Read stdin or --stdin option
  let rawPayload = {};
  const stdinOpt = ctx.options && ctx.options.stdin;
  if (stdinOpt && typeof stdinOpt === "string" && stdinOpt.length > 0) {
    try { rawPayload = JSON.parse(stdinOpt); } catch (_) { rawPayload = {}; }
  } else if (!process.stdin.isTTY && !stdinOpt) {
    // Read from piped stdin (non-TTY)
    try {
      const text = fs.readFileSync(0, "utf8").trim();
      if (text.length > 0) rawPayload = JSON.parse(text);
    } catch (_) { rawPayload = {}; }
  }

  const normalized = normalizeClaudeNativePayload(hookName, rawPayload);
  if (!normalized.ok) {
    console.error(`hook: native Claude payload rejected (${normalized.code}).`);
    process.exitCode = 1;
    return;
  }
  rawPayload = normalized.payload;

  // Reject governance fields
  if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    for (const key of Object.keys(rawPayload)) {
      if (GOVERNANCE_FIELDS.has(key)) {
        console.error("hook: stdin contains governance fields — rejected.");
        process.exitCode = 1;
        return;
      }
    }
  }

  // Validate hook-specific schema
  const allowed = HOOK_ALLOWED_STDIN_FIELDS[hookName];
  if (allowed && rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)) {
    for (const key of Object.keys(rawPayload)) {
      if (!allowed.includes(key)) {
        console.error(`hook: stdin contains unknown field "${key}" for hook ${hookName} — rejected.`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // ─── Stop / SubagentStop — no service required ──────────────────────────
  // Nonterminal events. Never submit to the Journal. Handle before service
  // opening since these may be called without a coordination context.

  if (hookName === "Stop" || hookName === "SubagentStop") {
    const result = executeClaudeHook(null, hookName, rawPayload);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  // Open service at .agent-runtime/coordination
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  let service;
  let ownedService = false;
  try {
    const { CoordinationApplicationService } = require("./coordination/application-service");
    const { loadAuthorizationPolicy } = require("./coordination/authorization-policy");
    const runtimeRoot = path.join(projectRoot, ".agent-runtime");
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const runtimeIgnore = path.join(runtimeRoot, ".gitignore");
    if (!fs.existsSync(runtimeIgnore)) {
      fs.writeFileSync(runtimeIgnore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
    }
    service = CoordinationApplicationService.open(
      path.join(runtimeRoot, "coordination"),
      { authorization: loadAuthorizationPolicy(projectRoot) },
    );
    ownedService = true;
  } catch (_) {
    console.error("hook: unable to open coordination service.");
    process.exitCode = 3;
    return;
  }

  try {
    const result = executeClaudeHook(service, hookName, rawPayload);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error("hook: internal error —", err.message || err);
    process.exitCode = 2;
  } finally {
    if (ownedService && service && typeof service.close === "function") service.close();
  }
}

// ─── help ─────────────────────────────────────────────────────────────────────

function devUsageError(message) {
  console.error(`cortex-agent dev: ${message}`);
  console.error("Usage: cortex-agent dev [--port N] [--interval-ms N] [--session-id ID]");
  process.exitCode = 2;
}

function parseDevOptions(args) {
  const values = { port: 8787, intervalMs: 3000, sessionId: null };
  const definitions = {
    "--port": { key: "port", min: 1, max: 65535 },
    "--interval-ms": { key: "intervalMs", min: 1000, max: 3600000 },
    "--session-id": { key: "sessionId" },
  };

  for (let index = 1; index < args.length; index += 1) {
    const raw = args[index];
    const equalAt = raw.indexOf("=");
    const name = equalAt === -1 ? raw : raw.slice(0, equalAt);
    const definition = definitions[name];
    if (!definition) return { error: `unknown option: ${raw}` };
    const value = equalAt === -1 ? args[++index] : raw.slice(equalAt + 1);
    if (value === undefined || value === "" || (equalAt === -1 && value.startsWith("--"))) {
      return { error: `${name} requires a value` };
    }
    if (definition.key === "sessionId") {
      if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
        return { error: "--session-id contains unsupported characters" };
      }
      values.sessionId = value;
      continue;
    }
    if (!/^\d+$/.test(value)) return { error: `${name} must be an integer` };
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < definition.min || number > definition.max) {
      return { error: `${name} must be between ${definition.min} and ${definition.max}` };
    }
    values[definition.key] = number;
  }
  return { values };
}

async function dev(ctx) {
  const agentDir = path.join(ctx.cwd, ".agent");
  const serverScript = path.join(agentDir, "skills", "agent-dashboard", "scripts", "serve.js");
  if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
    devUsageError("missing .agent directory; run cortex-agent init first");
    return;
  }
  if (!fs.existsSync(serverScript) || !fs.statSync(serverScript).isFile()) {
    devUsageError("missing .agent/skills/agent-dashboard/scripts/serve.js; upgrade the project first");
    return;
  }
  const parsed = parseDevOptions(ctx.args);
  if (parsed.error) {
    devUsageError(parsed.error);
    return;
  }
  const childArgs = [serverScript, "--port", String(parsed.values.port), "--interval-ms", String(parsed.values.intervalMs)];
  if (parsed.values.sessionId) childArgs.push("--session-id", parsed.values.sessionId);

  await new Promise((resolve) => {
    // Under `tests/*.test.js` combined run, stdio: "inherit" can deadlock the test
    // runner on child cleanup because the test runner pipes share the parent's stdio.
    // Mirror stdout/stderr ourselves while keeping the child decoupled, then enforce
    // a tight teardown deadline so the wrapper never wedges the test suite.
    const child = spawn(process.execPath, childArgs, { cwd: ctx.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    if (child.stdout) child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    let forwardedSignal = null;
    let forceTimer = null;
    let settled = false;
    const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
    const forward = (signal) => {
      if (forwardedSignal || child.exitCode !== null || child.signalCode !== null) return;
      forwardedSignal = signal;
      child.kill(signal);
      // Tighten the SIGKILL deadline so test runs aren't blocked by children holding
      // sockets. Tests rely on `cortex-agent dev` returning control within a few
      // seconds of SIGTERM; production users see the same prompt shutdown.
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1500);
      forceTimer.unref();
    };
    const finish = () => {
      if (settled) return false;
      settled = true;
      resolve();
      return true;
    };
    const onSighup = () => forward("SIGHUP");
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.once("SIGHUP", onSighup);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const cleanup = () => {
      if (forceTimer) clearTimeout(forceTimer);
      process.removeListener("SIGHUP", onSighup);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      console.error(`cortex-agent dev: failed to start dashboard: ${error.message}`);
      process.exitCode = 1;
      finish();
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (forwardedSignal) {
        process.exitCode = signalExitCodes[forwardedSignal] || 1;
      } else if (signal || code !== 0) {
        console.error(`cortex-agent dev: dashboard stopped${signal ? ` by ${signal}` : ` with exit code ${code}`}`);
        process.exitCode = typeof code === "number" && code !== 0 ? code : 1;
      }
      finish();
    });
  });
}

function cliHelp(ctx) {
  const topic = ctx.args.slice(1).find((arg) => !arg.startsWith("--")) || null;
  const selected = topic ? cliContract.commands.find((item) => item.name === topic) : null;
  if (topic && !selected) {
    printManagementPayload({ ok: false, error: { code: "UNKNOWN_HELP_TOPIC", message: `Unknown CLI help topic: ${topic}`, details: { topic } } });
    process.exitCode = 2;
    return;
  }
  const payload = {
    ok: true,
    command: "help",
    version: PKG_VERSION,
    contract: topic ? { ...cliContract, commands: [selected] } : cliContract,
  };
  if (topic === "query" && ctx.args.some((arg) => arg === "--project" || arg.startsWith("--project="))) {
    const result = queryManagementProject(ctx, "capabilities");
    if (!result.ok) {
      managementApiError(ctx, result);
      return;
    }
    payload.project = result.project;
    payload.management_capabilities = result.payload;
  }
  printManagementPayload(payload);
}

function printHelp() {
  console.log("Usage: cortex-agent <command> [options]");
  console.log("\nCommands:");
  for (const entry of cliContract.commands) console.log(`  ${entry.usage.padEnd(46)} ${entry.description}`);
  console.log("\nOptions:");
  for (const entry of cliContract.options) console.log(`  ${entry.name.padEnd(46)} ${entry.description}`);
  console.log("\nAvailable platforms:");
  Object.entries(PLATFORM_REGISTRY).forEach(([key, p]) => {
    console.log(`  ${key.padEnd(16)} ${p.name}`);
  });
}

// ─── Team Pack CLI (L2: .agent-shared/) ──────────────────────────────────────
// Routes:
//   team init [--project <path>] [--name <name>] [--team]
//   team status [--project <path>] [--json]
//   team install [--project <path>] [--dry-run] [--report text|json]
//   team update [--project <path>] [--dry-run] [--report text|json]
//   team publish --paths <path...> [--project <path>] [--dry-run]
//   team verify [--project <path>] [--strict] [--json]

const teamPack = require("./team-pack");

function teamUsage(ctx) {
  const sub = ctx.args[1];
  switch (sub) {
    case "init":
      return "Usage: cortex-agent team init [--project <path>] [--name <name>] [--team]";
    case "status":
      return "Usage: cortex-agent team status [--project <path>] [--json]";
    case "install":
      return "Usage: cortex-agent team install [--project <path>] [--dry-run] [--report text|json]";
    case "update":
      return "Usage: cortex-agent team update [--project <path>] [--dry-run] [--report text|json]";
    case "publish":
      return "Usage: cortex-agent team publish --paths <path...> [--project <path>] [--dry-run]";
    case "verify":
      return "Usage: cortex-agent team verify [--project <path>] [--strict] [--json]";
    default:
      return "Usage: cortex-agent team <init|status|install|update|publish|verify> [options]";
  }
}

function teamResolveProject(ctx) {
  const project = ctx.options && ctx.options.project ? path.resolve(ctx.cwd, ctx.options.project) : ctx.cwd;
  return project;
}

async function teamInit(ctx) {
  const project = teamResolveProject(ctx);
  const name = (ctx.options && ctx.options.name) || path.basename(project) + "-team-pack";
  // Non-interactive default: do NOT auto-install. Interactive default: prompt
  // by auto-installing (best-effort). --team forces install regardless.
  const interactive = Boolean(process.stdin.isTTY);
  const optTeam = Boolean(ctx.options && ctx.options.team);
  const allowInstall = optTeam;
  const result = teamPack.initSkeleton(project, name);
  console.log(`✅ Created ${result.manifest_path}`);
  if (!allowInstall) {
    const hint = interactive
      ? "ℹ️  交互模式已创建骨架;如需立即安装请重新执行 `team install --team`。"
      : "ℹ️  非交互模式默认不自动安装 Team Pack。重新执行时使用 `--team` 触发 install。";
    console.log(hint);
    return;
  }
  await teamInstall({ ...ctx, options: { ...(ctx.options || {}), project: project === ctx.cwd ? "" : project } });
}

function teamStatus(ctx) {
  const project = teamResolveProject(ctx);
  const loaded = teamPack.loadPack(project);
  const receipt = teamPack.readReceipt(project);
  const report = {
    schema_version: 1,
    project,
    pack: loaded.ok ? { name: loaded.manifest.name, version: loaded.manifest.version, manifest_sha256: loaded.manifestSha256 } : null,
    pack_present: loaded.ok,
    receipt_present: Boolean(receipt),
    files_declared: loaded.ok ? loaded.manifest.files.length : 0,
    files_installed: receipt ? receipt.files.length : 0,
  };
  if ((ctx.options && ctx.options.json) || ctx.command.endsWith("status")) {
    // Always emit JSON when --json is requested or when invoked via CLI route
    if (ctx.options && ctx.options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
  }
  console.log(
    `Pack: ${report.pack ? `${report.pack.name}@${report.pack.version}` : "(missing)"} | Files declared: ${report.files_declared} | Receipt: ${report.receipt_present ? "present" : "missing"}`,
  );
}

function applyPlanToProject(project, manifest, plan) {
  const applied = [];
  const conflicts = plan.items
    .filter((it) => it.decision === "conflict")
    .map((it) => ({ path: it.path, base: it.base, local: it.local, incoming: it.incoming }));
  const eligible = plan.items.filter((it) => it.decision === "apply" || it.decision === "add");
  const transactionId = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const backupRoot = path.join(project, teamPack.BACKUP_DIR, transactionId);
  const staged = [];

  for (const it of eligible) {
    const src = path.join(project, ".agent-shared", it.path);
    const dest = path.join(project, ".agent", it.path);
    if (
      !fs.existsSync(src)
      || teamPack.hasSymlinkInPath(project, src)
      || teamPack.hasSymlinkInPath(project, dest, { includeLeaf: false })
      || !fs.lstatSync(src).isFile()
      || fs.lstatSync(src).nlink > 1
      || (fs.existsSync(dest) && (fs.lstatSync(dest).isSymbolicLink() || fs.lstatSync(dest).nlink > 1))
      || teamPack.hashFile(src) !== it.incoming
    ) {
      throw new Error(`incoming Team Pack file changed during apply: ${it.path}`);
    }
  }

  try {
    for (const it of eligible) {
      const src = path.join(project, ".agent-shared", it.path);
      const dest = path.join(project, ".agent", it.path);
      const existed = fs.existsSync(dest);
      const backup = path.join(backupRoot, it.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const temp = `${dest}.team-tmp-${process.pid}-${staged.length}`;
      fs.copyFileSync(src, temp);
      staged.push({ dest, backup, existed, temp });
      if (existed) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(dest, backup);
      }
      fs.renameSync(temp, dest);
      applied.push(it.path);
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      try {
        if (fs.existsSync(entry.temp)) fs.unlinkSync(entry.temp);
        if (entry.existed && fs.existsSync(entry.backup)) fs.copyFileSync(entry.backup, entry.dest);
        else if (!entry.existed && fs.existsSync(entry.dest)) fs.unlinkSync(entry.dest);
      } catch (_) {}
    }
    throw new Error(`Team Pack apply rolled back: ${error.message}`);
  }

  return {
    applied,
    conflicts,
    backup_dir: eligible.some((it) => fs.existsSync(path.join(backupRoot, it.path))) ? backupRoot : null,
  };
}

function writeConflictArtifact(project, conflicts) {
  if (!conflicts.length) return null;
  fs.mkdirSync(path.join(project, teamPack.CONFLICT_DIR), { recursive: true });
  const file = path.join(
    project,
    teamPack.CONFLICT_DIR,
    `${Date.now()}-${conflicts.length}-conflict.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 1, conflicts }, null, 2)}\n`, "utf8");
  return file;
}

async function teamInstall(ctx) {
  const project = teamResolveProject(ctx);
  const dryRun = Boolean(ctx.options && ctx.options.dryRun);
  const loaded = teamPack.loadPack(project);
  if (!loaded.ok) {
    console.error(`❌ Team Pack manifest invalid or missing: ${loaded.reason}`);
    process.exitCode = 2;
    return;
  }
  const receipt = teamPack.readReceipt(project);
  const plan = teamPack.buildMergePlan(loaded.manifest, receipt, project, { dryRun });
  if (dryRun) {
    if (ctx.options && ctx.options.report === "json") {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const summary = plan.items.map((it) => `  ${it.decision.padEnd(10)} ${it.path} (${it.reason})`).join("\n");
      console.log(`[dry-run] plan:\n${summary}`);
    }
    return;
  }
  const { applied, conflicts } = applyPlanToProject(project, loaded.manifest, plan);
  const receipt2 = teamPack.buildReceiptFromPlan(loaded.manifest, loaded.manifestSha256, plan, receipt);
  teamPack.writeReceiptAtomic(project, receipt2);
  const conflictFile = writeConflictArtifact(project, conflicts);
  if (ctx.options && ctx.options.report === "json") {
    console.log(
      JSON.stringify(
        { schema_version: 1, mode: "apply", applied, conflicts: conflicts.length, conflict_artifact: conflictFile, receipt: receipt2 },
        null,
        2,
      ),
    );
  } else {
    console.log(`✅ Installed ${applied.length} file(s)` + (conflicts.length ? `, ${conflicts.length} conflict(s) preserved` : ""));
    if (conflictFile) console.log(`⚠️  Conflict artifact: ${conflictFile}`);
  }
}

async function teamUpdate(ctx) {
  // update == install for MS-002 (same three-way merge).
  return teamInstall(ctx);
}

function teamPublish(ctx) {
  const project = teamResolveProject(ctx);
  const items = parsePathsOption(ctx);
  if (!items || items.length === 0) {
    console.error("❌ `team publish` requires --paths <path...>.");
    process.exitCode = 2;
    return;
  }
  const dryRun = Boolean(ctx.options && ctx.options.dryRun);
  const manifest = teamPack.readManifest(project) || {
    name: path.basename(project) + "-team-pack",
    version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "git_committers", allowed_committers: [], fallback: "reject" },
    includes: [],
    excludes: teamPack.DEFAULT_EXCLUDES,
  };
  const tuples = items.map((p) => ({ source: p, dest: normalizePublishDest(p) }));
  const result = teamPack.publishPack(project, tuples, {
    name: manifest.name,
    version: manifest.version,
    requires: manifest.requires,
    signers: manifest.signers,
    includes: manifest.includes || [],
    excludes: manifest.excludes || teamPack.DEFAULT_EXCLUDES,
    dryRun,
  });
  if (!result.ok) {
    console.error(`❌ publish rejected ${result.skipped.length} item(s):`);
    for (const s of result.skipped) console.error(`   - ${s.source} -> ${s.dest}: ${s.reason}`);
    process.exitCode = 3;
    return;
  }
  console.log(`✅ Published ${result.applied.length} file(s)` + (dryRun ? " (dry-run)" : ""));
}

function parsePathsOption(ctx) {
  const argv = (ctx.args || []).slice();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--paths") {
      const out = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("--")) out.push(argv[j++]);
      return out;
    }
    if (argv[i] && argv[i].startsWith("--paths=")) {
      return argv[i].slice("--paths=".length).split(",").filter(Boolean);
    }
  }
  return [];
}

function normalizePublishDest(source) {
  // MS-003 convenience: if user passes a path whose first segment is not in
  // PACK_TOP_ALLOWLIST, attempt to remap to the closest allowlist directory.
  // Examples:
  //   src/rules/foo.md   -> rules/foo.md
  //   my-rules/foo.md    -> rules/foo.md
  //   rules/foo.md       -> rules/foo.md (unchanged)
  if (!source) return source;
  const segs = source.split("/").filter(Boolean);
  const top = segs[0];
  const ALLOW = new Set(["team-pack.json", "README.md", "rules", "workflows", "skills", "references", "schemas", "coordination"]);
  if (ALLOW.has(top)) return source;
  // Drop the leading non-allowlist segment(s) until the next segment is allowlist.
  for (let i = 1; i < segs.length; i += 1) {
    if (ALLOW.has(segs[i])) return segs.slice(i).join("/");
  }
  // No allowlist segment found; default to rules/
  return ["rules", ...segs].join("/");
}

function teamVerify(ctx) {
  const project = teamResolveProject(ctx);
  const strict = Boolean(ctx.options && ctx.options.strict);
  const loaded = teamPack.loadPack(project);
  if (!loaded.ok) {
    console.error(`❌ Team Pack manifest invalid or missing: ${loaded.reason}`);
    process.exitCode = 2;
    return;
  }
  const report = teamPack.verifyStrict(loaded.manifest, project);
  const json = Boolean(ctx.options && ctx.options.json);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(strict ? "🔍 Strict verify:" : "🔍 Verify:");
    for (const c of report.checks) {
      console.log(`  ${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "⚠"} ${c.id}: ${c.reason}`);
    }
  }
  if (!report.ok) process.exitCode = 3;
}

async function teamDispatch(ctx) {
  const sub = ctx.args[1];
  switch (sub) {
    case "init": return teamInit(ctx);
    case "status": return teamStatus(ctx);
    case "install": return teamInstall(ctx);
    case "update": return teamUpdate(ctx);
    case "publish": return teamPublish(ctx);
    case "verify": return teamVerify(ctx);
    case undefined:
    case "--help":
    case "-h":
      console.log(teamUsage(ctx));
      return;
    default:
      console.error(`Unknown team subcommand: ${sub}`);
      console.log(teamUsage(ctx));
      process.exitCode = 2;
  }
}

module.exports = {
  init,
  addPlatforms,
  removePlatforms,
  listPlatforms,
  upgrade,
  trackAgent,
  untrackAgent,
  linkGlobal,
  doctor,
  minimaxCliReconcile,
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
  lease,
  dispatchDryRun,
  dispatchExecute,
  dev,
  cliHelp,
  printHelp,
  teamPack: teamDispatch,
  secrets: require("./secrets-cli").secretsCommand,
  bridge: require("./commands/bridge").bridgeCommand,
};
