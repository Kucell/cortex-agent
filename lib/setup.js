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
    if (fs.existsSync(dest)) return;
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

    if (fileName === "CLAUDE.md") {
      ensureClaudeEntryFile(ctx, { replaceExisting: true });
    }
  });

  if (!found) {
    console.log(isZh ? "未发现旧配置。" : "No legacy configurations found.");
  }
  return found;
}

function stripImportedHeader(content) {
  return content.replace(/^# Imported from CLAUDE\.md\s*\n\s*/i, "").trim();
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function firstHeading(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const match = content.match(/^#\s+(.+?)\s*$/m);
    return match ? match[1].trim() : null;
  } catch (_) {
    return null;
  }
}

function gitRemoteName(cwd) {
  try {
    const config = fs.readFileSync(path.join(cwd, ".git", "config"), "utf8");
    const match = config.match(/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)/);
    if (!match) return null;
    const url = match[1].trim();
    const name = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
    return name || null;
  } catch (_) {
    return null;
  }
}

function findProjectFiles(cwd, names, options = {}) {
  const maxDepth = options.maxDepth || 4;
  const ignored = new Set([".git", ".agent", "node_modules", "dist", "bin", "obj"]);
  const matches = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (names.some((name) => {
        if (name.startsWith("*")) return entry.name.endsWith(name.slice(1));
        if (name.endsWith("*")) return entry.name.startsWith(name.slice(0, -1));
        return entry.name === name;
      })) {
        matches.push(fullPath);
      }
    }
  }

  walk(cwd, 0);
  return matches;
}

function detectProjectProfile(cwd) {
  const packageFiles = findProjectFiles(cwd, ["package.json"]);
  const rootPkg = readJsonIfExists(path.join(cwd, "package.json"));
  const pkg = rootPkg || readJsonIfExists(packageFiles[0] || "");
  const cargo = findProjectFiles(cwd, ["Cargo.toml"]).length > 0;
  const pyproject = findProjectFiles(cwd, ["pyproject.toml"]).length > 0;
  const goMod = findProjectFiles(cwd, ["go.mod"]).length > 0;
  const dotnetProjects = findProjectFiles(cwd, ["*.sln", "*.csproj"]);
  const viteConfigs = findProjectFiles(cwd, ["vite.config.js", "vite.config.ts", "vite.config.mjs"]);
  const pnpm = fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) || fs.existsSync(path.join(cwd, "pnpm-workspace.yaml"));
  const yarn = fs.existsSync(path.join(cwd, "yarn.lock"));
  const npm = fs.existsSync(path.join(cwd, "package-lock.json"));
  const stacks = [];
  const packageManager = pnpm ? "pnpm" : yarn ? "yarn" : npm ? "npm" : pkg ? "npm" : null;

  if (pkg) {
    stacks.push("Node.js");
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.vue) stacks.push("Vue");
    if (deps.react) stacks.push("React");
    if (deps.vite) stacks.push("Vite");
    if (deps.electron) stacks.push("Electron");
    if (deps.typescript) stacks.push("TypeScript");
  }
  if (viteConfigs.length > 0 && !stacks.includes("Vite")) stacks.push("Vite");
  if (dotnetProjects.length > 0) stacks.push(".NET/C#");
  if (cargo) stacks.push("Rust");
  if (pyproject) stacks.push("Python");
  if (goMod) stacks.push("Go");

  const name =
    (rootPkg && rootPkg.name) ||
    firstHeading(path.join(cwd, "README.md")) ||
    gitRemoteName(cwd) ||
    path.basename(cwd);

  return {
    name,
    packageManager,
    stacks: [...new Set(stacks)],
    hasPackageJson: Boolean(pkg),
    hasClaudeImport: fs.existsSync(path.join(cwd, ".agent", "references", "project-context-from-claude.md")),
    hasContextIndex: fs.existsSync(path.join(cwd, ".agent", "context-index.json")),
  };
}

function isTemplateAgentReadme(content) {
  return /^# Cortex Agent Template \(\.agent\)/.test(content.trim());
}

function isGeneratedProjectAgentReadme(content) {
  return content.includes("<!-- generated-by: cortex-agent project-readme -->") ||
    /# .+ Agent (工作区|Workspace)[\s\S]+(不是通用模板目录|not the generic template directory)/.test(content);
}

function buildProjectAgentReadme(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const profile = detectProjectProfile(cwd);
  const stackText = profile.stacks.length ? profile.stacks.join(", ") : (isZh ? "待 /configure 或 /scan-project 补充" : "To be filled by /configure or /scan-project");
  const packageText = profile.packageManager || (isZh ? "未检测到" : "Not detected");
  const contextLines = [
    "- `.agent/rules/`",
    "- `.agent/workflows/`",
    "- `.agent/skills/`",
    "- `.agent/plans/`",
    "- `.agent/references/`",
  ];
  if (profile.hasClaudeImport) contextLines.push("- `.agent/references/project-context-from-claude.md`");
  if (profile.hasContextIndex) contextLines.push("- `.agent/context-index.json`");

  if (isZh) {
    return [
      "<!-- generated-by: cortex-agent project-readme -->",
      `# ${profile.name} Agent 工作区`,
      "",
      "这个目录是当前项目的 Cortex Agent 知识与协作工作区，不是通用模板目录。",
      "",
      "## 项目概览",
      "",
      `- 项目：${profile.name}`,
      `- 项目根目录：\`${cwd}\``,
      `- 技术栈：${stackText}`,
      `- 包管理器：${packageText}`,
      `- 生成日期：${currentDate()}`,
      "",
      "## 信息来源",
      "",
      ...contextLines,
      "",
      "项目事实、架构决策、任务状态和协作记录应沉淀在上述 `.agent/` 文件中；不要把只适用于 cortex-agent 模板仓库的说明直接当成项目事实。",
      "",
      "## 建议入口",
      "",
      "- `/configure`：补齐项目语言、技术栈、架构边界和团队规则。",
      "- `/scan-project`：扫描现有代码并生成模块索引与参考资料。",
      "- `/briefing`：读取当前任务、风险、worktree 和下一步建议。",
      "- `/agent-dashboard --serve`：启动本地协作看板。",
      "",
      "## Git 说明",
      "",
      "- `.agent/metrics/agent-dashboard.html` 是本地运行态输出，不应提交。",
      "- 实战项目使用自己的 Git 身份与远端配置；不要继承 cortex-agent 仓库的提交身份。",
      "",
    ].join("\n");
  }

  return [
    "<!-- generated-by: cortex-agent project-readme -->",
    `# ${profile.name} Agent Workspace`,
    "",
    "This directory is the Cortex Agent knowledge and collaboration workspace for the current project. It is not the generic template directory.",
    "",
    "## Project Overview",
    "",
    `- Project: ${profile.name}`,
    `- Project root: \`${cwd}\``,
    `- Stack: ${stackText}`,
    `- Package manager: ${packageText}`,
    `- Generated: ${currentDate()}`,
    "",
    "## Sources Of Truth",
    "",
    ...contextLines,
    "",
    "Project facts, architecture decisions, task state, and collaboration records should be maintained in the `.agent/` files above. Do not treat cortex-agent template repository notes as project facts.",
    "",
    "## Suggested Entry Points",
    "",
    "- `/configure`: fill in language, stack, architecture boundaries, and team rules.",
    "- `/scan-project`: scan existing code and generate module references.",
    "- `/briefing`: read current tasks, risks, worktrees, and next actions.",
    "- `/agent-dashboard --serve`: start the local collaboration dashboard.",
    "",
    "## Git Notes",
    "",
    "- `.agent/metrics/agent-dashboard.html` is local runtime output and should not be committed.",
    "- Application projects should use their own Git identity and remotes; do not inherit the cortex-agent repository identity.",
    "",
  ].join("\n");
}

function ensureProjectAgentReadme(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const readmePath = path.join(cwd, ".agent", "README.md");
  const existing = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8") : "";
  if (existing && !isTemplateAgentReadme(existing) && !isGeneratedProjectAgentReadme(existing)) {
    console.log(isZh ? "ℹ️  .agent/README.md 已是项目自定义内容，跳过。" : "ℹ️  .agent/README.md is already project-specific. Skipping.");
    return false;
  }

  fs.writeFileSync(readmePath, buildProjectAgentReadme(ctx), "utf8");
  console.log(isZh ? "✅ 已生成项目版 .agent/README.md。" : "✅ Generated project-specific .agent/README.md.");
  return true;
}

function estimateTokens(content) {
  return Math.max(200, Math.ceil(content.length / 4));
}

function readContextIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return {
      _meta: {
        description: "Project module context index",
        generated_by: "cortex-agent-init",
        last_updated: null,
        last_commit: null,
        estimated_context_tokens: 0,
        total_modules: 0,
      },
      modules: [],
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (!Array.isArray(parsed.modules)) parsed.modules = [];
    if (!parsed._meta) parsed._meta = {};
    return parsed;
  } catch {
    return {
      _meta: {
        description: "Project module context index",
        generated_by: "cortex-agent-init",
        last_updated: null,
        last_commit: null,
        estimated_context_tokens: 0,
        total_modules: 0,
      },
      modules: [],
    };
  }
}

function upsertContextIndexModule(ctx, moduleEntry) {
  const indexPath = path.join(ctx.cwd, ".agent", "context-index.json");
  const index = readContextIndex(indexPath);
  const existingIndex = index.modules.findIndex((entry) => entry.id === moduleEntry.id);

  if (existingIndex >= 0) {
    index.modules[existingIndex] = { ...index.modules[existingIndex], ...moduleEntry };
  } else {
    index.modules.push(moduleEntry);
  }

  index._meta.last_updated = moduleEntry.last_updated;
  index._meta.total_modules = index.modules.length;
  index._meta.estimated_context_tokens = index.modules.reduce(
    (sum, entry) => sum + (Number(entry.estimated_tokens) || 0),
    0,
  );
  if (!index._meta.generated_by || index._meta.generated_by === "scan-project") {
    index._meta.generated_by = "cortex-agent-init";
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
}

function promoteImportedClaudeContext(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const importedPath = path.join(cwd, ".agent", "imported_rules", "imported_from_CLAUDE.md.md");
  if (!fs.existsSync(importedPath)) return false;

  const original = stripImportedHeader(fs.readFileSync(importedPath, "utf8"));
  if (!original) return false;

  const referencesDir = path.join(cwd, ".agent", "references");
  if (!fs.existsSync(referencesDir)) fs.mkdirSync(referencesDir, { recursive: true });

  const referenceRelPath = ".agent/references/project-context-from-claude.md";
  const referencePath = path.join(cwd, referenceRelPath);
  const date = currentDate();
  const estimated = estimateTokens(original);
  const title = isZh ? "从 CLAUDE.md 导入的项目上下文" : "Project Context Imported from CLAUDE.md";
  const content = [
    "---",
    `title: ${title}`,
    "module: legacy-claude-md",
    `last_updated: ${date}`,
    "last_commit: null",
    `estimated_tokens: ${estimated}`,
    "keywords:",
    "  - CLAUDE.md",
    "  - legacy-context",
    "  - project-guidance",
    "dependencies:",
    "  - CLAUDE.md",
    "  - .agent/imported_rules/imported_from_CLAUDE.md.md",
    "---",
    "",
    `# ${title}`,
    "",
    isZh
      ? "以下内容从旧的根目录 `CLAUDE.md` 自动导入，用作 Cortex Agent 的正式项目上下文。后续可以逐步拆分到更细的 `.agent/references/` 文档或 `.agent/rules/tech-stack.md`。"
      : "The content below was automatically imported from the legacy root `CLAUDE.md` and registered as official Cortex Agent project context. It can later be split into more focused `.agent/references/` documents or `.agent/rules/tech-stack.md`.",
    "",
    "## Original CLAUDE.md Content",
    "",
    original,
    "",
  ].join("\n");

  if (!fs.existsSync(referencePath)) {
    fs.writeFileSync(referencePath, content, "utf8");
    console.log(
      isZh
        ? `✅ 已将旧 CLAUDE.md 项目信息纳入 ${referenceRelPath}`
        : `✅ Registered legacy CLAUDE.md project context at ${referenceRelPath}`,
    );
  } else {
    console.log(
      isZh
        ? `ℹ️  ${referenceRelPath} 已存在，保留现有内容。`
        : `ℹ️  ${referenceRelPath} already exists. Keeping existing content.`,
    );
  }

  upsertContextIndexModule(ctx, {
    id: "legacy-claude-md",
    title,
    path: referenceRelPath,
    last_updated: date,
    last_commit: null,
    estimated_tokens: estimated,
    keywords: ["CLAUDE.md", "legacy-context", "project-guidance"],
    dependencies: ["CLAUDE.md", ".agent/imported_rules/imported_from_CLAUDE.md.md"],
  });

  return true;
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
    "2. `.agent/rules/ai-behavior.md`",
    "3. `.agent/rules/code-standards.md`",
    "4. `.agent/workflows/`",
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

function getClaudeEntryContent(ctx) {
  const templatePath = path.join(ctx.templateDir, "integrations", "claude", "CLAUDE.md");
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf8");
  }

  return [
    "# Cortex Agent Entry for Claude Code",
    "",
    "This project uses `.agent/` as the single source of truth for agent rules,",
    "workflows, skills, and project knowledge.",
    "",
    "Please load and follow these first:",
    "",
    "1. `AGENTS.md`",
    "2. `.agent/rules/core-principles.md`",
    "3. `.agent/rules/ai-behavior.md`",
    "4. `.agent/rules/code-standards.md`",
    "5. `.agent/workflows/`",
    "",
    "Keep project-specific facts in `.agent/references/` and `.agent/rules/tech-stack.md`.",
    "If legacy content was imported, review `.agent/imported_rules/` and migrate useful parts.",
    "",
    "If there is any conflict, `.agent/` content takes precedence.",
    "",
  ].join("\n");
}

function isGeneratedClaudeSymlink(cwd, claudePath) {
  try {
    const stat = fs.lstatSync(claudePath);
    return stat.isSymbolicLink() && fs.readlinkSync(claudePath) === ".agent/rules/core-principles.md";
  } catch {
    return false;
  }
}

function ensureClaudeEntryFile(ctx, options = {}) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const claudePath = path.join(cwd, "CLAUDE.md");
  const shouldReplace =
    options.replaceExisting || isGeneratedClaudeSymlink(cwd, claudePath) || !fs.existsSync(claudePath);

  if (!shouldReplace) {
    console.log(isZh ? "ℹ️  CLAUDE.md 已存在，跳过。" : "ℹ️  CLAUDE.md already exists. Skipping.");
    return;
  }

  try {
    fs.rmSync(claudePath, { force: true });
    fs.writeFileSync(claudePath, getClaudeEntryContent(ctx), "utf8");
    console.log(isZh ? "✅ 已添加 CLAUDE.md 入口。" : "✅ Added CLAUDE.md entry file.");
  } catch (err) {
    console.warn(`⚠️  Failed to write CLAUDE.md: ${err.message}`);
  }
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
  promoteImportedClaudeContext,
  ensureAgentEntryFile,
  ensureGeminiEntryFile,
  ensureClaudeEntryFile,
  ensureClaudeSettings,
  ensureProjectAgentReadme,
  linkGlobalConfig,
};
