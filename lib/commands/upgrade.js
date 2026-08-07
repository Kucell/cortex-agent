"use strict";

// ─── upgrade + runSelfCheck + runScriptReconcile (T-FOLLOW-002 v2) ────────────
//
// Originally lived in lib/commands.js. The three functions below are kept
// byte-identical to the original bodies; only the imports change so that the
// moved-out helpers (applyPatches, writeVersionFile) and the still-residing
// report/verification helpers (updateReportJson, runUpdateVerification, etc.)
// resolve to the right modules.
//
// `__dirname` adjustments: the new file lives at lib/commands/upgrade.js
// (one level deeper than the original lib/commands.js), so every
// `path.join(__dirname, "..", "templates", ...)` becomes
// `path.join(__dirname, "..", "..", "templates", ...)`. This keeps the
// resolved template root identical to the original.

const fs = require("node:fs");
const path = require("node:path");
const { execSync, spawnSync } = require("node:child_process");

// T-FOLLOW-002 v2: 16 helpers that the upgrade body used to reach through
// `lib/commands.js`'s own module.exports are now first-class modules under
// lib/commands/. Pull them from their final homes so this file is the only
// place that needs to know about the migration.
const {
  updateReportJson,
  updateProjectDescriptor,
  buildDryRunUpdateReport,
  updateReportId,
  writeUpdateReport,
  buildAppliedUpdateReport,
} = require("./update/report");
const {
  collectSemanticMergeCandidates,
  runUpdateVerification,
  printUpdateVerification,
  verificationCheck,
  parseJsonCheck,
  runNodeJsonCheck,
  managementQueryCheck,
  withoutProjectArgs,
} = require("./update/verify");
const { applyPlanToProject, writeConflictArtifact } = require("../team-pack/index");
const { printManagementPayload } = require("./management/api-helpers");

const scriptManifest = require("../script/manifest");
const { PLATFORM_REGISTRY } = require("../registry/index");
const teamPack = require("../team-pack/index");
const { applyPatches, writeVersionFile } = require("./patches");
const {
  getInstalledPlatforms,
  installPlatform,
  selectPlatformsInteractive,
} = require("../platform/index");
const {
  isGitRepo,
  hasTrackedPath,
  getIgnoreSource,
  applyGitExclusion,
  untrackGeneratedFilesFromGit,
} = require("../git/index");
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
} = require("../setup/index");

// Lazy require: keep lib/commands.js startup cheap and avoid loading
// governed-tool (which transitively imports capability-aware-dispatch
// and operation-lifecycle) when only print/help/version are invoked.
let registerMinimaxCliDiscovery = null;
try {
  registerMinimaxCliDiscovery = require("../runtime-adapters/minimax-cli-governed-tool").registerWithInitUpdateDoctor;
} catch (_) {
  registerMinimaxCliDiscovery = null;
}

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
  const sharedAgentSrc = path.join(__dirname, "..", "..", "templates", "_shared", ".agent");
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
        templatesRoot: path.join(__dirname, "..", "..", "templates"),
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

module.exports = {
  runSelfCheck,
  runScriptReconcile,
  upgrade,
};
