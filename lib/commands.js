"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const { PLATFORM_REGISTRY } = require("./registry");
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
  ensureAgentEntryFile,
  ensureGeminiEntryFile,
  ensureClaudeSettings,
  linkGlobalConfig,
} = require("./setup");
const {
  isGitRepo,
  hasTrackedPath,
  getIgnoreSource,
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
  const targetBase = options.global ? os.homedir() : cwd;
  const agentDest = path.join(targetBase, ".agent");

  if (!fs.existsSync(agentDest)) {
    copyRecursive(agentSrc, agentDest);
    console.log(`✅ Created ${agentDest} (Knowledge Base).`);
  } else {
    console.warn(isZh ? `⚠️  .agent 目录已存在，跳过。` : `⚠️  .agent already exists. Skipping.`);
  }

  if (options.global) {
    console.log("\n🎉 Global Cortex Agent initialized successfully!");
    return;
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
  ensureGeminiEntryFile(ctx);
  linkGlobalConfig(ctx);
  saveInstalledPlatforms(cwd, selectedPlatforms);

  if (!options.track) {
    console.log(isZh ? "\n🧹 确保生成文件不被 Git 追踪..." : "\n🧹 Ensuring generated Cortex Agent files are not tracked by Git...");
    untrackGeneratedFilesFromGit(ctx);
    applyGitExclusion(ctx);
  }

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

function upgrade(ctx) {
  const { cwd, lang, templateDir, options } = ctx;
  const isZh = lang === "zh";

  console.log(isZh
    ? `🔄 正在升级 Cortex Agent 框架 (语言: ${lang})...`
    : `🔄 Upgrading Cortex Agent Framework (Language: ${lang})...`);

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

  const agentSrc = path.join(templateDir, ".agent");
  const added = [];

  function walkAndAdd(srcDir, destDir, relBase) {
    if (!fs.existsSync(srcDir)) return;
    fs.readdirSync(srcDir).forEach((name) => {
      const srcPath = path.join(srcDir, name);
      const destPath = path.join(destDir, name);
      const relPath = relBase ? `${relBase}/${name}` : name;
      let stat;
      try { stat = fs.statSync(srcPath); } catch { return; }

      if (stat.isDirectory()) {
        if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
        walkAndAdd(srcPath, destPath, relPath);
      } else if (!fs.existsSync(destPath)) {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        if (relPath.endsWith(".sh")) fs.chmodSync(destPath, 0o755);
        added.push(relPath);
      }
    });
  }

  walkAndAdd(agentSrc, agentDest, "");

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

  linkGlobalConfig(ctx);
  ensureClaudeSettings(ctx);
  if (!options.track) applyGitExclusion(ctx);
  console.log(isZh ? "\n🎉 升级完成！" : "\n🎉 Upgrade complete!");
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

  const excludePath = path.join(cwd, ".git", "info", "exclude");
  if (fs.existsSync(excludePath)) {
    const pathSet = new Set(getAllGeneratedPaths());
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

function doctor(ctx) {
  const { cwd, lang } = ctx;
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

  console.log(`\n📌 ${isZh ? "建议操作" : "Recommended actions"}:`);
  if (missingAny)
    console.log(isZh ? "  - 运行 `cortex-agent init` 创建缺失文件。" : "  - Run `cortex-agent init` to create missing files.");
  if (trackedAny || notIgnoredAny)
    console.log(isZh ? "  - 运行 `cortex-agent untrack` 取消追踪。" : "  - Run `cortex-agent untrack` to untrack and update local excludes.");
  if (!trackedAny)
    console.log(isZh ? "  - 若想 Git 管理 .agent，运行 `cortex-agent track`。" : "  - To track .agent in Git, run `cortex-agent track`.");
  if (!missingAny && !trackedAny && !notIgnoredAny)
    console.log(isZh ? "  - 无需操作，当前配置状态正常。" : "  - No action needed. Current setup looks healthy.");
}

// ─── link-global ─────────────────────────────────────────────────────────────

function linkGlobal(ctx) {
  linkGlobalConfig(ctx);
}

// ─── help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log("Usage: cortex-agent <command> [options]");
  console.log("\nCommands:");
  console.log("  init                    Initialize Cortex Agent (interactive platform selection)");
  console.log("  add <platform...>       Add platform integration(s) to existing project");
  console.log("  remove <platform...>    Remove platform integration(s)");
  console.log("  list                    Show available and installed platforms");
  console.log("  upgrade                 Add new files from template (additive only)");
  console.log("  track                   Enable Git tracking for .agent");
  console.log("  untrack                 Disable Git tracking for .agent");
  console.log("  link-global             Link global ~/.agent config");
  console.log("  doctor                  Check setup health");
  console.log("\nOptions:");
  console.log("  --lang, -l <en|zh>      Language (auto-detected by default)");
  console.log("  --global, -g            Initialize to global home directory (~/.agent)");
  console.log("  --track, -t             Keep generated files in Git (default: local exclude)");
  console.log("  --platforms, -p <list>  Comma-separated platform list or 'all' (skips interactive)");
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
  printHelp,
};
