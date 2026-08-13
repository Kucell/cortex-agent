"use strict";

// ─── project — track / untrack / link-global ──────────────────────────────────
//
// Originally lived in lib/commands.js (T-FOLLOW-002 v2 module-split). Body is
// kept byte-identical to the original; only the imports change so the helpers
// (isGitRepo, resolveGitExcludePath, applyGitExclusion, untrackGeneratedFilesFromGit,
// getAllGeneratedPaths, linkGlobalConfig) come from their canonical home
// modules.

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const {
  isGitRepo,
  resolveGitExcludePath,
  applyGitExclusion,
  untrackGeneratedFilesFromGit,
} = require("../git/index");
const { getAllGeneratedPaths, saveInstalledPlatforms } = require("../platform/index");
const { linkGlobalConfig } = require("../setup/index");
const {
  RUNTIME_GITIGNORE_BODY,
  RUNTIME_GITIGNORE_MODE,
  RUNTIME_TRACKED_GITIGNORE_BODY,
} = require("../cross-project/runtime-root");

// `.agent-runtime/.gitignore` is seeded with a hard-ignore payload (`*` +
// `!.gitignore`) on cold start (T-RUNTIME-IGNORE-001). Tracking the dir
// requires lifting it; untracking restores it. Hand-managed contents are
// never touched.
function runtimeIgnorePathFor(cwd) {
  return path.join(cwd, ".agent-runtime", ".gitignore");
}

function liftRuntimeHardIgnore(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const ignorePath = runtimeIgnorePathFor(cwd);
  if (!fs.existsSync(ignorePath)) return;
  if (fs.readFileSync(ignorePath, "utf8") !== RUNTIME_GITIGNORE_BODY) return;
  fs.writeFileSync(ignorePath, RUNTIME_TRACKED_GITIGNORE_BODY, {
    encoding: "utf8",
    mode: RUNTIME_GITIGNORE_MODE,
  });
  console.log(
    isZh
      ? "✅ 已解除 .agent-runtime/.gitignore 的冷启动硬忽略。"
      : "✅ Lifted the cold-start hard-ignore in .agent-runtime/.gitignore.",
  );
}

function restoreRuntimeHardIgnore(ctx) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const ignorePath = runtimeIgnorePathFor(cwd);
  if (!fs.existsSync(ignorePath)) return;
  if (fs.readFileSync(ignorePath, "utf8") !== RUNTIME_TRACKED_GITIGNORE_BODY) return;
  fs.writeFileSync(ignorePath, RUNTIME_GITIGNORE_BODY, {
    encoding: "utf8",
    mode: RUNTIME_GITIGNORE_MODE,
  });
  console.log(
    isZh
      ? "✅ 已恢复 .agent-runtime/.gitignore 的冷启动硬忽略。"
      : "✅ Restored the cold-start hard-ignore in .agent-runtime/.gitignore.",
  );
}

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

  restoreRuntimeHardIgnore(ctx);
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

  console.log(isZh ? "📂 开启 .agent / .agent-runtime Git 追踪..." : "📂 Enabling Git tracking for .agent / .agent-runtime...");

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

  liftRuntimeHardIgnore(ctx);

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
      ? "\n🎉 完成！.agent / .agent-runtime 已纳入 Git 追踪。\n👉 下一步：git commit -m 'chore: 纳入 cortex-agent 配置'"
      : "\n🎉 Done! .agent / .agent-runtime are now tracked by Git.\n👉 Next: git commit -m 'chore: add cortex-agent configuration'",
  );
}

function linkGlobal(ctx) {
  linkGlobalConfig(ctx);
}

module.exports = {
  untrackAgent,
  trackAgent,
  linkGlobal,
};
