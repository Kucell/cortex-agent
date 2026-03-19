"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { LEGACY_CONFIG_FILES } = require("./registry");

// ─── File helpers ─────────────────────────────────────────────────────────────

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (fs.statSync(src).isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach((child) =>
      copyRecursive(path.join(src, child), path.join(dest, child)),
    );
  } else {
    fs.copyFileSync(src, dest);
  }
}

// ─── Migration ────────────────────────────────────────────────────────────────

function migrateOldConfigs(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";

  console.log(
    isZh
      ? "🔍 检测现有 AI 助手配置..."
      : "🔍 Checking for existing AI assistant configurations...",
  );

  let found = false;
  const importedDir = path.join(cwd, ".agent", "imported_rules");

  LEGACY_CONFIG_FILES.forEach((fileName) => {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) return;

    if (!found) {
      console.log(
        isZh
          ? "发现旧配置，正在迁移到 .agent/imported_rules/"
          : "Legacy configurations found. Migrating them to .agent/imported_rules/",
      );
      found = true;
      if (!fs.existsSync(importedDir)) fs.mkdirSync(importedDir, { recursive: true });
    }

    const dest = path.join(importedDir, `imported_from_${path.basename(fileName)}.md`);
    fs.writeFileSync(dest, `# Imported from ${fileName}\n\n${fs.readFileSync(filePath, "utf8")}`);
    console.log(`  - Migrated ${fileName}`);
  });

  if (!found) {
    console.log(isZh ? "未发现旧配置。" : "No legacy configurations found.");
  }
  return found;
}

// ─── Entry files ──────────────────────────────────────────────────────────────

function ensureAgentEntryFile(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const agentsPath = path.join(cwd, "AGENTS.md");

  if (fs.existsSync(agentsPath)) {
    console.log(isZh ? "ℹ️  AGENTS.md 已存在，跳过。" : "ℹ️  AGENTS.md already exists. Skipping.");
    return;
  }

  const content = [
    "# Cortex Agent Entry",
    "",
    "This project uses `.agent/` as the single source of truth for agent rules,",
    "workflows, and skills.",
    "",
    "Please load and follow these first:",
    "",
    "1. `.agent/rules/core-principles.md`",
    "2. `.agent/rules/code-standards.md`",
    "3. `.agent/workflows/`",
    "",
    "If there is any conflict, `.agent/` content takes precedence.",
    "",
  ].join("\n");

  fs.writeFileSync(agentsPath, content, "utf8");
  console.log(isZh ? "✅ 已添加 AGENTS.md。" : "✅ Added AGENTS.md for editor/agent discovery.");
}

function ensureGeminiEntryFile(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const geminiPath = path.join(cwd, "GEMINI.md");

  if (fs.existsSync(geminiPath)) {
    console.log(isZh ? "ℹ️  GEMINI.md 已存在，跳过。" : "ℹ️  GEMINI.md already exists. Skipping.");
    return;
  }

  const content = [
    "# Antigravity Entry",
    "",
    "Use `AGENTS.md` as the shared instruction baseline for this project.",
    "Project knowledge source remains `.agent/`.",
    "",
    "Load and follow in order:",
    "",
    "1. `AGENTS.md`",
    "2. `.agent/rules/core-principles.md`",
    "3. `.agent/rules/code-standards.md`",
    "4. `.agent/workflows/`",
    "",
    "When there is a conflict, prefer this file for Antigravity-specific behavior,",
    "otherwise follow `AGENTS.md`.",
    "",
  ].join("\n");

  fs.writeFileSync(geminiPath, content, "utf8");
  console.log(isZh ? "✅ 已添加 GEMINI.md。" : "✅ Added GEMINI.md for Antigravity compatibility.");
}

function ensureClaudeSettings(ctx) {
  const { cwd, templateDir } = ctx;
  const settingsPath = path.join(cwd, ".claude", "settings.json");
  const hooksTemplatePath = path.join(templateDir, ".agent", "hooks", "hooks.json");
  if (!fs.existsSync(hooksTemplatePath)) return;

  const incomingHooks = JSON.parse(fs.readFileSync(hooksTemplatePath, "utf8")).hooks || {};
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { settings = {}; }
  }

  if (!settings.hooks) {
    settings.hooks = incomingHooks;
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    console.log("✅ Created .claude/settings.json with hook configuration.");
    return;
  }

  let added = false;
  Object.entries(incomingHooks).forEach(([event, rules]) => {
    if (!settings.hooks[event]) { settings.hooks[event] = rules; added = true; }
  });
  if (added) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    console.log("✅ Updated .claude/settings.json with new hook events.");
  } else {
    console.log("ℹ️  .claude/settings.json already has hook configuration.");
  }
}

function linkGlobalConfig(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const globalAgentPath = path.join(os.homedir(), ".agent");
  if (!fs.existsSync(globalAgentPath)) return;

  console.log(isZh ? "\n🌍 检测到全局 ~/.agent 配置..." : "\n🌍 Detecting global configuration at ~/.agent...");

  const globalLinkInAgent = path.join(cwd, ".agent", "global");
  if (!fs.existsSync(globalLinkInAgent)) {
    try {
      fs.symlinkSync(globalAgentPath, globalLinkInAgent);
      console.log("✅ Linked .agent/global -> ~/.agent");
    } catch (err) {
      console.warn(`⚠️  Failed to create global link: ${err.message}`);
    }
  }

  const globalLinks = [
    { target: globalAgentPath + "/rules", link: ".cursor/global-rules" },
    { target: globalAgentPath + "/workflows", link: ".cursor/global-commands" },
    { target: globalAgentPath + "/workflows", link: ".claude/global-commands" },
  ];

  globalLinks.forEach(({ target, link }) => {
    const linkPath = path.join(cwd, link);
    const linkDir = path.dirname(linkPath);
    if (!fs.existsSync(linkDir)) fs.mkdirSync(linkDir, { recursive: true });
    if (!fs.existsSync(linkPath)) {
      try {
        fs.symlinkSync(target, linkPath);
        console.log(`✅ Linked ${link} -> ${target} (Global)`);
      } catch (err) {
        console.warn(`⚠️  Failed to link global ${link}: ${err.message}`);
      }
    }
  });
}

module.exports = {
  copyRecursive,
  migrateOldConfigs,
  ensureAgentEntryFile,
  ensureGeminiEntryFile,
  ensureClaudeSettings,
  linkGlobalConfig,
};
