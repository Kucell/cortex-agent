"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const { getAllGeneratedPaths } = require("./platform");

// ─── Low-level git queries ────────────────────────────────────────────────────

function hasTrackedPath(cwd, entry) {
  try {
    execSync(`git ls-files --error-unmatch -- "${entry}"`, { cwd, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function getIgnoreSource(cwd, entry) {
  try {
    return execSync(`git check-ignore -v -- "${entry}"`, { cwd, encoding: "utf8" }).trim();
  } catch { return ""; }
}

function isGitRepo(cwd) {
  return fs.existsSync(path.join(cwd, ".git"));
}

// ─── Exclusion helpers ────────────────────────────────────────────────────────

function applyGitExclusion(ctx, customPaths) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const genPaths = customPaths || getAllGeneratedPaths();
  const excludePath = path.join(cwd, ".git", "info", "exclude");

  if (!isGitRepo(cwd)) return;

  const excludeDir = path.dirname(excludePath);
  if (!fs.existsSync(excludeDir)) fs.mkdirSync(excludeDir, { recursive: true });

  console.log(
    isZh
      ? "\n🙈 将生成文件写入本地 Git 忽略列表..."
      : "\n🙈 Adding generated files to local Git exclude (.git/info/exclude)...",
  );

  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const lines = current.split(/\r?\n/);
  let updated = current;
  let addedAny = false;

  genPaths.forEach((p) => {
    if (!lines.includes(p)) {
      if (updated && !updated.endsWith("\n")) updated += "\n";
      updated += p + "\n";
      addedAny = true;
      console.log(`  - Added ${p}`);
    }
  });

  if (addedAny) {
    fs.writeFileSync(excludePath, updated);
    console.log(isZh ? "✅ 本地 Git 忽略已更新。" : "✅ Local Git exclusion updated.");
  } else {
    console.log(isZh ? "ℹ️  无需更新。" : "ℹ️ All paths already in exclude list.");
  }
}

function untrackGeneratedFilesFromGit(ctx, customPaths) {
  const { cwd } = ctx;
  const genPaths = customPaths || getAllGeneratedPaths();

  if (!isGitRepo(cwd)) return false;

  let removedAny = false;
  genPaths.forEach((entry) => {
    try {
      execSync(`git rm -r --cached --ignore-unmatch -- "${entry}"`, { cwd, stdio: "ignore" });
      const staged = execSync(`git diff --cached --name-only -- "${entry}"`, {
        cwd, encoding: "utf8",
      }).trim();
      if (staged) { removedAny = true; console.log(`  - Untracked ${entry}`); }
    } catch (err) {
      console.warn(`⚠️  Failed to untrack ${entry}: ${err.message}`);
    }
  });
  return removedAny;
}

module.exports = {
  hasTrackedPath,
  getIgnoreSource,
  isGitRepo,
  applyGitExclusion,
  untrackGeneratedFilesFromGit,
};
