"use strict";

// ─── init + initModeGeneral — bootstrap a project with cortex-agent ──────────
//
// Originally lived in lib/commands.js. The body is kept byte-identical to
// the original; only the imports change so that the moved-out helpers
// (applyPatches, writeVersionFile, askYesNo) come from the new sibling
// modules under lib/commands/.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
const {
  isGitRepo,
  hasTrackedPath,
  getIgnoreSource,
} = require("../git/index");
const {
  PLATFORM_REGISTRY,
} = require("../registry/index");
const scriptManifest = require("../script/manifest");
const {
  selectPlatformsInteractive,
  installPlatform,
  saveInstalledPlatforms,
  untrackGeneratedFilesFromGit,
  applyGitExclusion,
} = require("../platform/index");
const { applyPatches, writeVersionFile } = require("./patches");
const { writePublicAnchor } = require("../anchor/anchor");
// initModeGeneral uses askYesNo internally; init does not, but we import it
// here for the initModeGeneral function defined below.
const { askYesNo } = require("./prompt");

const PKG_VERSION = require("../../package.json").version;

// Lazy require: keep lib/commands.js startup cheap and avoid loading
// governed-tool (which transitively imports capability-aware-dispatch
// and operation-lifecycle) when only print/help/version are invoked.
let registerMinimaxCliDiscovery = null;
try {
  registerMinimaxCliDiscovery = require("../runtime-adapters/minimax-cli-governed-tool").registerWithInitUpdateDoctor;
} catch (_) {
  registerMinimaxCliDiscovery = null;
}

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
  const sharedAgentSrc = path.join(__dirname, "..", "..", "templates", "_shared", ".agent");
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
        templatesRoot: path.join(__dirname, "..", "..", "templates"),
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

  // Cross-tool anchor: write a versioned, version-controlled snippet to
  // docs/cortex-agent/anchor.md so any AI tool (Claude Code, Codex, Cursor,
  // Aider, Pi agent, …) can recognise this project as cortex-agent-managed
  // and read the load order from AGENTS.md. The .agent/ directory itself is
  // gitignored, so without this public anchor other tools only see the bare
  // AGENTS.md and miss the framework's governance contracts.
  const anchorWritten = writePublicAnchor(cwd, options.global);
  if (anchorWritten && !options.global) {
    console.log(
      isZh
        ? "\n🌐 跨工具识别锚点已写入：docs/cortex-agent/anchor.md（已纳入版本控制）"
        : "\n🌐 Cross-tool anchor written to: docs/cortex-agent/anchor.md (version-controlled)",
    );
    console.log(
      isZh
        ? "   将其复制到其他 AI 工具的长期记忆：\n     cortex-agent export-anchor         # 输出 Markdown 片段\n     cortex-agent export-anchor --json  # 输出 JSON 元数据\n   粘贴到：\n     - Claude Code  → CLAUDE.md\n     - Codex/Cursor → AGENTS.md\n     - Pi agent     → .pi/agent.md 或系统提示"
        : "   Copy it to other AI tools' long-term memory:\n     cortex-agent export-anchor         # markdown snippet\n     cortex-agent export-anchor --json  # machine-readable JSON\n   Paste into:\n     - Claude Code  → CLAUDE.md\n     - Codex/Cursor → AGENTS.md\n     - Pi agent     → .pi/agent.md or system prompt",
    );
  }

  console.log(
    isZh
      ? "\n💡 后续可用命令：\n   cortex-agent add <platform>     添加新平台\n   cortex-agent remove <platform>  移除平台\n   cortex-agent list               查看已安装平台"
      : "\n💡 Useful commands:\n   cortex-agent add <platform>     Add a platform later\n   cortex-agent remove <platform>  Remove a platform\n   cortex-agent list               Show installed platforms",
  );

  // T-FOLLOW-002 v2: lay down .githooks/ + (best-effort) wire core.hooksPath
  // so the 9-class state pre-commit reminder is active after `cortex-agent init`.
  // Idempotent: re-running init is a no-op for the hooks copy.
  // NOTE: this was previously wired from bin/cli.js but moving it here keeps
  // it inside the init lifecycle (and survives shadow-init's additivity
  // check because lib/commands.js becomes the thin re-export shell).
  // The actual implementation lives in lib/state-sync.js.
  try {
    const { installStateGithooks } = require("../state-sync/index");
    const hookRes = installStateGithooks({ cwd, lang });
    if (hookRes.ok) {
      if (hookRes.installed) {
        console.log(
          isZh
            ? "\n🪝 已安装 .githooks/ 提醒(9 类 state 忘 add 时自动提示)"
            : "\n🪝 Installed .githooks/ reminder (surfaces forgotten `git add` on 9 state classes)",
        );
      }
      if (hookRes.hooksConfigured) {
        console.log(
          isZh
            ? "   core.hooksPath 已指向 .githooks/"
            : "   core.hooksPath now points at .githooks/",
        );
      } else if (hookRes.installed) {
        console.log(
          isZh
            ? `   ℹ️  ${hookRes.reason || ".agent/ 非 git repo,稍后 git init 后再手动配"}`
            : `   ℹ️  ${hookRes.reason || ".agent/ is not a git repo; configure hooksPath after `git init`"}`,
        );
      }
    } else {
      console.warn(
        isZh
          ? `⚠️  无法自动装 .githooks/ :${hookRes.reason}`
          : `⚠️  Could not auto-install .githooks/: ${hookRes.reason}`,
      );
    }
  } catch (_) {
    // best-effort: never fail init because of state-sync bootstrap
  }
}

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
  const baseSrc = path.join(__dirname, "..", "..", "templates", "_base", ".agent");
  if (!fs.existsSync(baseSrc)) {
    console.error(
      "❌ templates/_base/.agent not found. Run MS-001 first to land the shared base layer, then retry `cortex-agent init --mode general`.",
    );
    process.exit(1);
  }
  const baseDest = path.join(process.cwd(), ".agent");
  copyRecursive(baseSrc, baseDest);
  console.log(
    `✅ general mode init: copied shared data layer to ${baseDest}`,
  );
  if (fs.existsSync(path.join(process.cwd(), "AGENTS.md"))) {
    console.log("ℹ️  AGENTS.md detected; general mode is the right profile for this project.");
  }

  // MS-004: copy the general template layer (workflows + skills + sub-agents +
  // domains + prompts + config) into `<baseDest>/general/`. This sits next to
  // the data layer copied above and is the runtime surface for the 4 general
  // workflows (memory-recall, memory-distill, agent-discover, agent-invoke).
  const generalSrc = path.join(__dirname, "..", "..", "templates", "general", ".agent");
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
}

module.exports = {
  init,
  initModeGeneral,
};
