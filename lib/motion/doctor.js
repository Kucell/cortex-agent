"use strict";

// ─── doctor — Chrome + FFmpeg + hyperframes + daemon 检测 (P-005 MS-005) ─────
//
// `cortex-agent motion doctor` 检测第 5 平面全部外部依赖,缺失时优雅报错 +
// 安装指引(VC-1 / VC-11)。检测项:
//   - node        — process.versions.node ≥ 18
//   - chrome      — google-chrome / chromium / chrome on PATH + macOS app path
//   - ffmpeg      — `ffmpeg` on PATH + `ffmpeg -version` 可运行
//   - hyperframes — `npx --no-install hyperframes --version` 可运行
//   - openDesign  — `open-design` on PATH(daemon dispatch 路径 A)
//   - platform    — darwin-x64 / darwin-arm64 / linux-x64(可本地渲染)
//                   其它(win32 等)→ warning(走 Docker / daemon)
//
// 输出 JSON: { ok, deps: { node, chrome, ffmpeg, hyperframes, openDesign },
//             platform, warnings: [] }
// 零 npm 依赖:node:fs / node:path / node:child_process (spawn)。

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const NODE_MIN_VERSION = 18;

function findInPath(cmd, env) {
  const pathEnv = (env && env.PATH) || process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // try next
    }
  }
  return null;
}

// macOS / Linux common Chrome locations (PATH check first, then known paths).
function detectChrome(env, findFn, knownPaths) {
  const envObj = env || process.env;
  const which = findFn || findInPath;
  for (const cmd of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "headless_shell"]) {
    const p = which(cmd, envObj);
    if (p) return { ok: true, path: p };
  }
  const candidates = knownPaths || [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return { ok: true, path: c };
    } catch (_) {
      // next candidate
    }
  }
  return { ok: false, path: null, hint: "install Google Chrome / Chromium (headless)" };
}

function detectNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  const ok = Number.isFinite(major) && major >= NODE_MIN_VERSION;
  return { ok, version, required: `>= ${NODE_MIN_VERSION}` };
}

function platformInfo() {
  const os = require("node:os");
  const platform = os.platform();
  const arch = os.arch();
  const id = `${platform}-${arch}`;
  const supported = ["darwin-arm64", "darwin-x64", "linux-x64"].includes(id);
  return { id, supported, warnings: supported ? [] : [`platform ${id} 不支持本地渲染 — 请走 open-design Docker / daemon (P-005 N4)`] };
}

function runCommand(cmd, args, options) {
  const opts = options || {};
  const spawnFn = opts.spawnFn || spawn;
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout || 10000,
    });
    let stdout = "";
    child.stdout &&
      child.stdout.on("data", (d) => {
        stdout += String(d);
      });
    child.on("error", () => {
      resolve({ ok: false, error: `${cmd} not runnable` });
    });
    child.on("exit", (code) => {
      resolve({ ok: code === 0, stdout: stdout.trim() });
    });
  });
}

/**
 * Run the full dependency doctor.
 *   which  — injectable fn(cmd, env) → path|null (tests)
 *   run    — injectable fn(cmd, args, opts) → Promise<{ok, stdout}> (tests)
 *   env    — env override (tests)
 * Returns { ok, deps, platform, warnings }.
 */
async function runDoctor(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const which = opts.which || findInPath;
  const run = opts.run || runCommand;

  const deps = {};

  // node
  deps.node = detectNode();

  // chrome
  const chrome = opts.chromeDetect ? opts.chromeDetect(env) : detectChrome(env);
  deps.chrome = chrome;

  // ffmpeg
  const ffmpegPath = which("ffmpeg", env);
  if (!ffmpegPath) {
    deps.ffmpeg = { ok: false, path: null, hint: "install FFmpeg — macOS: brew install ffmpeg; Linux: apt/dnf install ffmpeg" };
  } else {
    const v = await run("ffmpeg", ["-version"], { env });
    deps.ffmpeg = { ok: v.ok, path: ffmpegPath, version: v.ok ? firstLine(v.stdout) : null };
  }

  // hyperframes (npx --no-install: 不触发网络安装,只探测本机缓存)
  const npxPath = which("npx", env);
  if (!npxPath) {
    deps.hyperframes = { ok: false, path: null, hint: "install Node.js ≥ 18 (npx 随附) — 或先 npm install -g hyperframes" };
  } else {
    const h = await run("npx", ["--no-install", "hyperframes", "--version"], { env });
    deps.hyperframes = { ok: h.ok, path: npxPath, version: h.ok ? firstLine(h.stdout) : null };
  }

  // open-design daemon (路径 A)
  const odPath = which("open-design", env);
  deps.openDesign = odPath ? { ok: true, path: odPath } : { ok: false, path: null, hint: "install open-design daemon for path-A dispatch (recommended)" };

  const platform = platformInfo();
  const warnings = [...platform.warnings];

  // CLAUDE_CODE sandbox warning
  if (env.CLAUDE_CODE === "true" || env.CLAUDE_CODE === "1") {
    warnings.push("Claude Code sandbox-exec 会挂起 Chrome — 渲染请走 open-design daemon 或普通 shell (P-005 §4.6)");
  }

  // hyperframes / daemon 至少要有一个
  const hasRenderer = deps.hyperframes.ok || deps.openDesign.ok;
  if (!hasRenderer) {
    warnings.push("既没有 hyperframes 也没有 open-design daemon — 无法渲染 (P-005 R1/R4)");
  }

  const ok = deps.node.ok && deps.chrome.ok && deps.ffmpeg.ok && hasRenderer;
  return { ok, deps, platform, warnings };
}

function firstLine(text) {
  const s = String(text || "").trim();
  return s.split("\n")[0] || null;
}

module.exports = {
  NODE_MIN_VERSION,
  runDoctor,
  detectNode,
  detectChrome,
  platformInfo,
  firstLine,
  _internal: {
    findInPath,
    runCommand,
  },
};
