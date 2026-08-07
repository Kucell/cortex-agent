"use strict";

// ─── platform — add / remove / list platform integrations ─────────────────────
//
// Originally lived in lib/commands.js (T-FOLLOW-002 v2 module-split). Body is
// kept byte-identical to the original; only the imports change so the helpers
// (installPlatform, removePlatform, getInstalledPlatforms, applyGitExclusion,
// ensureClaudeSettings, ensureClaudeEntryFile, PLATFORM_REGISTRY) come from
// their canonical home modules.

const fs = require("node:fs");
const path = require("node:path");

const { PLATFORM_REGISTRY } = require("../registry");
const {
  getInstalledPlatforms,
  saveInstalledPlatforms,
  installPlatform,
  removePlatform,
} = require("../platform");
const { applyGitExclusion } = require("../git");
const { ensureClaudeSettings, ensureClaudeEntryFile } = require("../setup");

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

module.exports = {
  addPlatforms,
  removePlatforms,
  listPlatforms,
};
