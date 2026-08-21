"use strict";

// ─── scaffold — `media scaffold` thin wrapper (P-005 MS-005) ─────────────────
//
// 脚手架起步,不 from scratch:把 `templates/_shared/.agent/motion/<starter>/`
// 的 composition 模板复制到 `<cwd>/.agent/motion/<motion-id>/`,并:
//   - 生成 brief.md + DESIGN.md(HARD-GATE 产物,可溯源到 design-system)
//   - 在 `.agent/motion/.gitignore` 隐藏 `.hyperframes-cache/`
//   - 锁定除 index.html 外的文件(meta.json / hyperframes.json / DESIGN.md /
//     brief.md 由系统生成,用户只编辑 index.html 一处 — P-005 §4.5 编辑最小面)
//
// 外部模板(不在本地 3 个 starter 内)走 `npx hyperframes scaffold` 委托
// (路径 B)。npx 不在 PATH 时优雅报错 + 指引。
//
// 零 npm 依赖:node:fs / node:path / node:child_process (spawn)。

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { writeMotionTokens, compileMotionTokens } = require("./style-tokens");

// 本地 starter 模板(唯一可离线、确定性脚手架来源)。
const LOCAL_STARTERS = Object.freeze(["kobe-lite", "saas-hero", "stat-counter"]);

const LOCKED_FILES = Object.freeze(["hyperframes.json", "meta.json", "DESIGN.md", "brief.md"]);

const GITIGNORE_CONTENT = Object.freeze(
  [
    "# P-005 / MS-005: hyperframes engine cache — never commit composition sources",
    "# (composition 源文件只留在 .hyperframes-cache/,输出只有 renders/*.mp4 落项目)",
    ".hyperframes-cache/",
    "",
  ].join("\n"),
);

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function findInPath(cmd, env) {
  const pathEnv = (env && env.PATH) || process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // try next dir
    }
  }
  return null;
}

function starterSourceDir(templateDir) {
  // Candidates (first existing wins): explicit motion dir → lang template
  // dir → the shared (_shared) template layer where starters live.
  const candidates = [];
  if (templateDir) {
    if (path.basename(templateDir) === "motion") candidates.push(templateDir);
    candidates.push(path.join(templateDir, ".agent", "motion"));
    candidates.push(path.join(templateDir, "..", "_shared", ".agent", "motion"));
  }
  candidates.push(path.join(__dirname, "..", "..", "templates", "_shared", ".agent", "motion"));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch (_) {
      // try next candidate
    }
  }
  return candidates[candidates.length - 1];
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.statSync(s).isDirectory()) {
      copyRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function ensureGitignore(motionDir) {
  fs.mkdirSync(motionDir, { recursive: true });
  const gitignore = path.join(motionDir, ".gitignore");
  const existing = (() => {
    try {
      return fs.readFileSync(gitignore, "utf8");
    } catch (_) {
      return "";
    }
  })();
  if (!existing.includes(".hyperframes-cache/")) {
    fs.writeFileSync(gitignore, existing + GITIGNORE_CONTENT, "utf8");
  }
  return gitignore;
}

function generateBrief(motionId, template, style) {
  return [
    `# Motion brief — ${motionId}`,
    "",
    "> P-005 / MS-005 生成的确定性 brief。编辑 `index.html` 一处即可调整效果;",
    "> 本文件由系统生成,改它不会影响渲染(只影响记录)。",
    "",
    "## 意图 (用户品牌语言描述)",
    "",
    "- 目标 motion id:`" + motionId + "`",
    "- 起始模板:`" + template + "`",
    "- 设计系统:" + (style ? "`" + style + "`(style tokens 见 .agent/motion/style-tokens/)" : "未指定(用 cascade 生效 DESIGN.md)"),
    "- 时长:由 `index.html` 根元素 `data-duration` 决定",
    "",
    "## 3 个情绪问题 (HARD-GATE,渲染前必须回答)",
    "",
    "1. 这支动效想让观众**感觉**什么?(克制 / 兴奋 / 信任 / 惊喜 …)",
    "2. 画面应该是**明亮 / 暗调 / 中间调**?",
    "3. 只允许出现**一个品牌色**,它是什么?",
    "",
    "回答后,把答案写进 `.agent/motion/" + motionId + "/DESIGN.md`,再跑 `motion style-tokens --motion-id " + motionId + "` 重新编译 tokens。",
    "",
  ].join("\n");
}

function generateDesignMd(motionId, style, tokens) {
  const palette = tokens ? tokens.palette : null;
  const lines = [
    `# ${motionId} — Motion DESIGN.md (最小可溯源)`,
    "",
    "> P-005 HARD-GATE 产物:调色板 / 字体必须可溯源到设计系统。",
    "> 只编辑 `index.html` 一处;本文件记录视觉意图,不改渲染。",
    "",
    "## Visual theme",
    "",
    "- 主题:" + (style ? "`" + style + "` 设计系统驱动" : "cascade 生效 DESIGN.md 驱动"),
    "- 渲染门控:snapshot proof 帧 → 用户确认才 render",
    "",
    "## Color roles",
    "",
    "| Role | Hex | Usage |",
    "| --- | --- | --- |",
  ];
  if (palette) {
    lines.push(`| Primary | \`${palette.primary}\` | 主强调 / 标题 |`);
    lines.push(`| Secondary | \`${palette.secondary}\` | 次级元素 |`);
    lines.push(`| Accent | \`${palette.accent}\` | 关键 CTA / 数据点 |`);
    lines.push(`| Background | \`${palette.bg}\` | 画布底色 |`);
  } else {
    lines.push("| Primary | `#ffb76b` | 主强调 / 标题 |");
    lines.push("| Secondary | `#7da4ff` | 次级元素 |");
    lines.push("| Accent | `#7da4ff` | 关键 CTA / 数据点 |");
    lines.push("| Background | `#0b0b0f` | 画布底色 |");
  }
  lines.push(
    "",
    "## Motion and interaction",
    "",
    "- Easing: `power2.out`(进入)/ `power2.in`(退出)",
    "- Duration: 200ms(fast)/ 400ms(base)/ 800ms(slow)",
    "- 入场用 `gsap.from()`,出场用 `gsap.to()`(Layout Before Animation 硬规则)",
    "- 最多 1-3 个 clip div;一个时间线 `window.__timelines[\"main\"]`",
    "",
    "## Anti-patterns",
    "",
    "- ❌ 不引入 DESIGN.md 未声明的视觉 token",
    "- ❌ 多于 3 种字体 / emoji 作为章节 header",
    "- ❌ 动效时长 > 800ms(除非 brief 明确要求)",
    "- ❌ 与品牌色冲突的默认色(#333 / #3b82f6 / Roboto)",
    "",
  );
  return lines.join("\n");
}

/**
 * Copy a local starter into `<motionDir>/<motionId>/` and lay down the
 * brief / DESIGN.md / .gitignore artifacts. Deterministic, offline, testable.
 *
 * options:
 *   motionId, template, style (design-system id)
 *   cwd, templateDir, motionDir (overrides for tests)
 * Returns { motionDir, compositionDir, files, gitignore }.
 */
function scaffoldComposition(options) {
  const cwd = options.cwd || process.cwd();
  const motionDir = options.motionDir || path.join(cwd, ".agent", "motion");
  const motionId = options.motionId;
  const template = options.template || "kobe-lite";

  if (!isSlug(motionId)) {
    throw new Error(`invalid --motion-id "${motionId}" — use lowercase letters, digits, dashes (≤64 chars)`);
  }
  if (!LOCAL_STARTERS.includes(template)) {
    throw new Error(
      `unknown template "${template}" — local starters: ${LOCAL_STARTERS.join(", ")}; external templates need npx hyperframes (see runHyperframesScaffold)`,
    );
  }

  const src = path.join(starterSourceDir(options.templateDir), template);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`starter template missing at ${src} — corrupted install`);
  }

  const compositionDir = path.join(motionDir, motionId);
  if (fs.existsSync(compositionDir)) {
    throw new Error(`composition already exists at ${compositionDir} — pick a different --motion-id`);
  }

  copyRecursive(src, compositionDir);
  ensureGitignore(motionDir);

  // style tokens: compile (and persist) from the requested design system.
  let tokens = null;
  if (options.style) {
    try {
      tokens = writeMotionTokens({
        cwd,
        motionDir,
        motionId,
        designSystemId: options.style,
      }).tokens;
    } catch (err) {
      tokens = null; // style unavailable → fall back to cascade/defaults, still scaffold
    }
  }

  // HARD-GATE 产物:brief + DESIGN.md(系统生成,锁定)。
  fs.writeFileSync(path.join(compositionDir, "brief.md"), generateBrief(motionId, template, options.style), "utf8");
  fs.writeFileSync(
    path.join(compositionDir, "DESIGN.md"),
    generateDesignMd(motionId, options.style, tokens),
    "utf8",
  );

  const files = fs.readdirSync(compositionDir);
  return { motionDir, compositionDir, files, gitignore: path.join(motionDir, ".gitignore"), tokens };
}

/**
 * Path B: delegate scaffold to `npx hyperframes scaffold`. Used for external
 * (non-local) templates. Graceful errors when npx is missing.
 */
function runHyperframesScaffold(options) {
  const cwd = options.cwd || process.cwd();
  const npxPath = findInPath("npx", options.env);
  if (!npxPath) {
    return {
      ok: false,
      code: "NPX_MISSING",
      message:
        "npx 不在 PATH — 无法调用 hyperframes scaffold。请先安装 Node.js ≥ 18(npx 随附),或使用本地 starter 模板 (kobe-lite / saas-hero / stat-counter)。",
    };
  }
  const args = ["hyperframes", "scaffold", options.motionId];
  if (options.template) args.push("--template", options.template);
  return spawnHyperframes(npxPath, args, { cwd, env: options.env, spawnFn: options.spawnFn, wait: options.wait !== false });
}

function spawnHyperframes(npxPath, args, options) {
  const cwd = options.cwd || process.cwd();
  const spawnFn = options.spawnFn || spawn;
  const child = spawnFn(npxPath, args, {
    cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.silent ? "ignore" : "inherit",
  });
  if (options.wait === false) {
    return { ok: true, child };
  }
  return new Promise((resolve) => {
    child.on("error", (err) => {
      resolve({ ok: false, code: "SPAWN_ERROR", message: `failed to spawn ${npxPath}: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true, code: 0 });
      } else {
        resolve({
          ok: false,
          code: "HYPERFRAMES_SCAFFOLD_FAILED",
          message: `npx hyperframes scaffold exited with code ${code}`,
        });
      }
    });
  });
}

module.exports = {
  LOCAL_STARTERS,
  LOCKED_FILES,
  GITIGNORE_CONTENT,
  scaffoldComposition,
  runHyperframesScaffold,
  spawnHyperframes,
  generateBrief,
  generateDesignMd,
  ensureGitignore,
  isSlug,
  _internal: {
    findInPath,
    starterSourceDir,
    copyRecursive,
  },
};
