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
} = require("./management-client");
const cliContract = require("./cli-contract");

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
  ensureGeminiEntryFile,
  ensureClaudeEntryFile,
  ensureClaudeSettings,
  ensureProjectAgentReadme,
  linkGlobalConfig,
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

function upgrade(ctx) {
  const { cwd, lang, templateDir, options } = ctx;
  const isZh = lang === "zh";
  const dryRun = options.dryRun === true;
  const fullUpdate = ctx.command === "update" || options.updateScripts === true || options.forceScripts === true;

  console.log(dryRun
    ? (isZh
        ? `🔍 升级 dry-run (语言: ${lang}) — 不会修改任何文件。`
        : `🔍 Upgrade dry-run (Language: ${lang}) — no files will be modified.`)
    : (isZh
        ? `🔄 正在升级 Cortex Agent 框架 (语言: ${lang})...`
        : `🔄 Upgrading Cortex Agent Framework (Language: ${lang})...`));

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

  // Pre-upgrade drift check writes self-check-report.json — under --dry-run
  // we must leave no byte-level residue, so skip it and tell the user what
  // we skipped. (A real upgrade would re-run check-drift for an honest baseline.)
  if (!dryRun) {
    runSelfCheck(cwd, "check-drift", isZh);
  } else {
    console.log(isZh
      ? "  · 跳过 check-drift(避免写入 self-check-report.json,符合 dry-run 不修改磁盘)。"
      : "  · Skipping check-drift (would write self-check-report.json; --dry-run must not modify disk).");
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
      return 0;
    }
    let count = 0;
    for (const { rel: relPath, root } of discovered) {
      const srcAbs = path.join(root, relPath.split("/").join(path.sep));
      const destAbs = path.join(cwd, ".agent", relPath);
      if (!fs.existsSync(destAbs)) { count += 1; continue; }
      try {
        const srcSha = require("crypto").createHash("sha256").update(fs.readFileSync(srcAbs)).digest("hex");
        const destSha = require("crypto").createHash("sha256").update(fs.readFileSync(destAbs)).digest("hex");
        if (srcSha !== destSha) count += 1;
      } catch { count += 1; }
    }
    return count;
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

    console.log(isZh
      ? `\n📋 计划新增 (${wouldAdd.length})：`
      : `\n📋 Would add (${wouldAdd.length}):`);
    wouldAdd.forEach((f) => console.log(`   + ${f}`));
    if (wouldAdd.length === 0) {
      console.log(isZh
        ? "  (无 — 项目已是最新。)"
        : "  (none — already up to date.)");
    }

    const candidateCount = collectReconcileCandidates();
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
  ensureGeminiEntryFile(ctx);
  if (installed.includes("claude") || fs.existsSync(path.join(cwd, "CLAUDE.md"))) {
    ensureClaudeEntryFile(ctx);
  }
  linkGlobalConfig(ctx);
  ensureClaudeSettings(ctx);
  if (!options.track) applyGitExclusion(ctx);
  writeVersionFile(cwd);
  const protectedLocal = (reconcileReport?.skipped || []).filter((s) =>
    s.reason === "user_modified" || s.reason === "unmanaged_cold_start");
  const failedScripts = reconcileReport?.failed || [];
  if (failedScripts.length > 0) {
    process.exitCode = 1;
    console.error(isZh ? "\n❌ 更新未完成：部分管理脚本写入失败。" : "\n❌ Update incomplete: some managed scripts failed to write.");
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
    if (capabilityResult.error.code === "UNSUPPORTED_COMMAND") {
      managementApiError(ctx, {
        error: {
          code: "CAPABILITY_UNAVAILABLE",
          message: "Target project Management API does not expose a projection registry.",
          details: { projection },
        },
        exitCode: 3,
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
  runs,
  queues,
  sessions,
  decisions,
  inbox,
  waitpoints,
  managementQuery,
  dev,
  cliHelp,
  printHelp,
};
