"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { PLATFORM_REGISTRY, DEFAULT_PLATFORMS, BASE_PATHS, PLATFORMS_STATE_FILE } = require("./registry");

// ─── State ───────────────────────────────────────────────────────────────────

function getInstalledPlatforms(cwd) {
  const stateFile = path.join(cwd, PLATFORMS_STATE_FILE);
  if (fs.existsSync(stateFile)) {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return [];
    }
  }
  // Fallback: detect by checking which cleanup paths exist on disk
  return Object.keys(PLATFORM_REGISTRY).filter((key) =>
    PLATFORM_REGISTRY[key].cleanupPaths.some((cp) =>
      fs.existsSync(path.join(cwd, cp)),
    ),
  );
}

function saveInstalledPlatforms(cwd, keys) {
  const stateFile = path.join(cwd, PLATFORMS_STATE_FILE);
  const dir = path.dirname(stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(keys, null, 2), "utf8");
}

function getAllGeneratedPaths() {
  const all = new Set(BASE_PATHS);
  Object.values(PLATFORM_REGISTRY).forEach((p) =>
    p.cleanupPaths.forEach((cp) => all.add(cp)),
  );
  return [...all];
}

// ─── Install / Remove ────────────────────────────────────────────────────────

/** lstatSync-based existence check that also detects broken symlinks */
function pathExists(cwd, relPath) {
  try {
    fs.lstatSync(path.join(cwd, relPath));
    return true;
  } catch {
    return false;
  }
}

function installPlatform(ctx, key) {
  const { cwd, lang, templateDir } = ctx;
  const isZh = lang === "zh";
  const p = PLATFORM_REGISTRY[key];
  if (!p) {
    console.warn(`⚠️  ${isZh ? "未知平台" : "Unknown platform"}: ${key}`);
    return false;
  }

  p.files.forEach(({ src, dest }) => {
    const srcPath = path.join(templateDir, "integrations", src);
    const destPath = path.join(cwd, dest);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    if (fs.existsSync(destPath)) {
      console.log(`  ℹ️  ${dest} ${isZh ? "已存在，跳过" : "already exists. Skipping."}`);
    } else if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ✅ ${isZh ? "已添加" : "Added"} ${dest}`);
    } else {
      console.log(`  ℹ️  ${isZh ? "模板文件不存在，跳过" : "Template not found. Skipping."} ${dest}`);
    }
  });

  p.links.forEach(({ target, link }) => {
    const linkPath = path.join(cwd, link);
    const linkDir = path.dirname(linkPath);
    if (!fs.existsSync(linkDir)) fs.mkdirSync(linkDir, { recursive: true });

    if (pathExists(cwd, link)) {
      console.log(`  ℹ️  ${link} ${isZh ? "已存在，跳过" : "already exists. Skipping."}`);
    } else {
      try {
        fs.symlinkSync(target, linkPath);
        console.log(`  ✅ Linked ${link} -> ${target}`);
      } catch (err) {
        console.warn(`  ⚠️  ${isZh ? "链接失败" : "Failed to link"} ${link}: ${err.message}`);
      }
    }
  });

  // Special post-setup handled by caller to avoid circular deps
  return p.postSetup || null;
}

function removePlatform(ctx, key) {
  const { cwd, lang } = ctx;
  const isZh = lang === "zh";
  const p = PLATFORM_REGISTRY[key];
  if (!p) {
    console.warn(`⚠️  ${isZh ? "未知平台" : "Unknown platform"}: ${key}`);
    return;
  }

  p.links.forEach(({ link }) => {
    const linkPath = path.join(cwd, link);
    try {
      fs.lstatSync(linkPath);
      fs.rmSync(linkPath, { recursive: true, force: true });
      console.log(`  🗑  ${isZh ? "已删除符号链接" : "Removed"} ${link}`);
    } catch {
      // doesn't exist, skip
    }
  });

  p.files.forEach(({ dest }) => {
    const destPath = path.join(cwd, dest);
    if (fs.existsSync(destPath)) {
      fs.rmSync(destPath, { recursive: true, force: true });
      console.log(`  🗑  ${isZh ? "已删除" : "Removed"} ${dest}`);
    }
  });

  p.cleanupPaths.forEach((cp) => {
    const cpPath = path.join(cwd, cp);
    try {
      const stat = fs.lstatSync(cpPath);
      if (stat.isDirectory() && fs.readdirSync(cpPath).length === 0) {
        fs.rmdirSync(cpPath);
        console.log(`  🗑  ${isZh ? "已删除空目录" : "Removed empty dir"} ${cp}`);
      }
    } catch {
      // skip
    }
  });
}

// ─── Interactive selection ────────────────────────────────────────────────────

function askQuestion(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function selectPlatformsInteractive(ctx) {
  const { lang } = ctx;
  const isZh = lang === "zh";
  const keys = Object.keys(PLATFORM_REGISTRY);

  console.log(
    "\n" + (isZh ? "📦 可用平台（★ = 默认选中）：" : "📦 Available platforms (★ = selected by default):"),
  );
  keys.forEach((key, i) => {
    const p = PLATFORM_REGISTRY[key];
    const mark = DEFAULT_PLATFORMS.includes(key) ? " ★" : "  ";
    const desc = p.desc[lang] || p.desc.en;
    console.log(`  ${String(i + 1).padStart(2)}.${mark}${p.name.padEnd(22)} ${desc}`);
  });

  const defaultNums = DEFAULT_PLATFORMS.map((k) => keys.indexOf(k) + 1).join(",");
  const prompt = isZh
    ? `\n输入编号（逗号分隔），"all" 安装全部，直接回车使用默认 [${defaultNums}]：`
    : `\nEnter numbers (comma-separated), "all" for all, or Enter for defaults [${defaultNums}]: `;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await askQuestion(rl, prompt);
  rl.close();

  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return [...DEFAULT_PLATFORMS];
  if (trimmed === "all") return [...keys];

  const selected = trimmed
    .split(",")
    .map((s) => keys[parseInt(s.trim(), 10) - 1])
    .filter(Boolean);

  if (selected.length === 0) {
    console.log(isZh ? "⚠️  无有效选择，使用默认值。" : "⚠️  No valid selection, using defaults.");
    return [...DEFAULT_PLATFORMS];
  }
  return selected;
}

module.exports = {
  getInstalledPlatforms,
  saveInstalledPlatforms,
  getAllGeneratedPaths,
  installPlatform,
  removePlatform,
  selectPlatformsInteractive,
};
