"use strict";

// ─── verify — lint + check + ffprobe 质量门 (P-005 MS-005) ───────────────────
//
// 渲染完成后,用 ffprobe 校验产出文件满足 preset 质量矩阵(时长 / 分辨率 /
// 帧率 / codec / alpha 通道)。overlay preset 必查 alpha。
//
// 质量门 (P-005 §4.7):
//   - duration  > 0 且与 brief 一致(±0.5s 由调用方对比 manifest)
//   - width×height == preset
//   - fps ≈ preset.fps
//   - codec 家族匹配(prores / h264 / vp9)
//   - alpha preset → 像素格式含 'a'(yuva420p / yuva444p10le)
//
// 零 npm 依赖:node:fs / node:path / node:child_process (spawn)。

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { getPreset } = require("./edit-presets");
const { compositionDirOf } = require("./render");
const { sandboxWarning } = require("./render");

const CODEC_FAMILIES = Object.freeze({
  prores_ks: ["prores"],
  h264: ["h264", "avc1"],
  vp9: ["vp9"],
});

const FFMPEG_INSTALL_GUIDANCE =
  "FFmpeg 未安装或不在 PATH — 请安装 FFmpeg 后重试:\n" +
  "  macOS:  brew install ffmpeg\n" +
  "  Linux:  apt install ffmpeg / dnf install ffmpeg\n" +
  "  Windows: winget install ffmpeg (本地渲染需 macOS Apple Silicon / Linux x64)";

/**
 * Normalize a rational-ish fps ("24000/1001", "24.0", 24) to a number.
 */
function normalizeFps(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number((Number(m[1]) / Number(m[2])).toFixed(3));
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `ffprobe -print_format json` output into a normalized info object.
 * Pure + testable.
 */
function parseFfprobeOutput(json) {
  const info = {
    duration: null,
    width: null,
    height: null,
    fps: null,
    codec: null,
    pixelFormat: null,
    hasAlpha: false,
  };
  if (!json || typeof json !== "object") return info;
  if (json.format && json.format.duration) {
    const d = Number(json.format.duration);
    if (Number.isFinite(d)) info.duration = d;
  }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((s) => s && s.codec_type === "video");
  if (video) {
    if (video.width) info.width = Number(video.width);
    if (video.height) info.height = Number(video.height);
    if (video.codec_name) info.codec = video.codec_name;
    if (video.pix_fmt) info.pixelFormat = video.pix_fmt || video.pixel_format;
    if (info.duration === null && video.duration) {
      const d = Number(video.duration);
      if (Number.isFinite(d)) info.duration = d;
    }
    const fps = video.r_frame_rate || video.avg_frame_rate || (video.fps != null ? video.fps : null);
    info.fps = normalizeFps(fps);
    info.hasAlpha = /^yuva/.test(info.pixelFormat || "");
  }
  return info;
}

function codecMatches(presetCodec, actualCodec) {
  const family = CODEC_FAMILIES[presetCodec] || [presetCodec];
  return family.some((f) => String(actualCodec || "").toLowerCase().startsWith(f));
}

/**
 * Validate a normalized ffprobe info object against a preset.
 * Returns { ok, checks, errors } — check entries describe what passed.
 * Pure + testable.
 */
function validateRender(info, preset) {
  const checks = [];
  const errors = [];
  const add = (name, pass, detail) => {
    (pass ? checks : errors).push(`${name}: ${detail}`);
    return pass;
  };
  add("duration", info.duration !== null && info.duration > 0, `duration=${info.duration}s`);
  if (preset.width && preset.height) {
    add(
      "resolution",
      info.width === preset.width && info.height === preset.height,
      `${info.width}x${info.height} (preset ${preset.width}x${preset.height})`,
    );
  }
  if (preset.fps) {
    const tolerance = 1;
    add(
      "fps",
      info.fps !== null && Math.abs(info.fps - preset.fps) <= tolerance,
      `fps=${info.fps} (preset ${preset.fps})`,
    );
  }
  add("codec", codecMatches(preset.codec, info.codec), `codec=${info.codec} (preset ${preset.codec})`);
  if (preset.pixel_format) {
    add(
      "pixel_format",
      (info.pixelFormat || "") === preset.pixel_format,
      `pix_fmt=${info.pixelFormat} (preset ${preset.pixel_format})`,
    );
  }
  if (preset.alpha) {
    // overlay preset 必查 alpha:像素格式须含 'a' 且解析器确认 yuva*。
    const alpha = info.hasAlpha && /^yuva/.test(info.pixelFormat || "");
    add("alpha", alpha, `pix_fmt=${info.pixelFormat} (alpha expected)`);
  }
  return { ok: errors.length === 0, checks, errors };
}

function spawnFfprobe(file, options) {
  const spawnFn = (options && options.spawnFn) || spawn;
  return spawnFn("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Run ffprobe on a file and resolve with parsed info.
 *   ffprobeFn — injectable (tests): fn(file, options) → child-like EventEmitter
 */
function runFfprobe(file, options) {
  const opts = options || {};
  const child = opts.ffprobeFn ? opts.ffprobeFn(file, opts) : spawnFfprobe(file, opts);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout &&
      child.stdout.on("data", (d) => {
        stdout += String(d);
      });
    child.stderr &&
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
    child.on("error", (err) => {
      resolve({
        ok: false,
        code: "FFPROBE_MISSING",
        message: `ffprobe 不可用: ${err.message}\n${FFMPEG_INSTALL_GUIDANCE}`,
      });
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          code: "FFPROBE_FAILED",
          message: `ffprobe exited ${code}: ${stderr.trim() || "unknown error"}`,
        });
        return;
      }
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch (_) {
        resolve({ ok: false, code: "FFPROBE_PARSE", message: `cannot parse ffprobe JSON: ${stdout.slice(0, 200)}` });
        return;
      }
      resolve({ ok: true, info: parseFfprobeOutput(json), raw: json });
    });
  });
}

/**
 * Verify a rendered file against a preset.
 *   file        — absolute path to the render output
 *   presetId    — preset id (default: infer from filename `<id>-<preset>.<ext>`)
 *   ffprobeFn   — injectable
 * Returns { ok, file, info, checks, errors, message }.
 */
async function verifyRender({ motionId, preset, file, cwd, ffprobeFn }) {
  const cwdPath = cwd || process.cwd();
  let target = file;
  if (!target) {
    const dir = path.join(compositionDirOf(cwdPath, motionId), "renders");
    const candidates = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const video = candidates.filter((f) => /\.(mp4|mov|webm)$/i.test(f));
    target = video.length ? path.join(dir, video[0]) : null;
  }
  if (!target || !fs.existsSync(target)) {
    return {
      ok: false,
      code: "NO_RENDER_OUTPUT",
      message: `no render output found for motion "${motionId}" — run \`cortex-agent motion render\` first`,
    };
  }
  let presetObj = null;
  if (preset) {
    presetObj = getPreset(preset);
    if (!presetObj) return { ok: false, code: "UNKNOWN_PRESET", message: `unknown --preset "${preset}"` };
  } else {
    const m = path.basename(target).match(/-([a-z0-9-]+)\.(mp4|mov|webm)$/i);
    if (m) presetObj = getPreset(m[1]);
  }
  if (!presetObj) {
    return {
      ok: false,
      code: "NO_PRESET",
      message: `cannot infer preset from ${path.basename(target)} — pass --preset explicitly`,
    };
  }
  const probe = await runFfprobe(target, { ffprobeFn });
  if (!probe.ok) return probe;
  const verdict = validateRender(probe.info, presetObj);
  return {
    ok: verdict.ok,
    file: target,
    info: probe.info,
    checks: verdict.checks,
    errors: verdict.errors,
    message: verdict.ok
      ? `✓ ${path.basename(target)} passes ${verdict.checks.length} quality checks (${presetObj.description})`
      : `✗ ${path.basename(target)} failed quality gate:\n  - ${verdict.errors.join("\n  - ")}`,
  };
}

module.exports = {
  CODEC_FAMILIES,
  FFMPEG_INSTALL_GUIDANCE,
  parseFfprobeOutput,
  normalizeFps,
  codecMatches,
  validateRender,
  runFfprobe,
  verifyRender,
  runCompositionCheck,
  selectLintTool,
  _internal: {
    spawnFfprobe,
  },
};

// ─── lint / check — composition 静态校验 (可在 shell 直接跑, P-005 §4.6) ───

const LINT_MODES = Object.freeze(["lint", "check"]);

/**
 * Pick the lint/check runner:
 *   "npx" — `npx hyperframes lint|check --motion-id <id>` (shell-safe)
 *   error — npx missing → graceful guidance
 * Pure + testable.
 */
function selectLintTool({ hasNpx }) {
  if (hasNpx) return { tool: "npx", args: ["hyperframes"] };
  return {
    error: {
      code: "NO_NPX",
      message: "npx 不在 PATH — 无法运行 hyperframes lint/check。安装 Node.js ≥ 18 后重试。",
    },
  };
}

/**
 * Run `npx hyperframes lint|check --motion-id <id>` for a composition.
 *   mode   — "lint" | "check"
 *   detect — { hasNpx } overrides (tests)
 *   spawnFn — injectable (tests)
 *   wait   — false returns { ok, child } without waiting
 * Returns { ok, message?, child? }.
 */
function runCompositionCheck(options) {
  const cwd = options.cwd || process.cwd();
  const mode = options.mode;
  if (!LINT_MODES.includes(mode)) {
    return { ok: false, code: "BAD_MODE", message: `mode must be lint|check, got "${mode}"` };
  }
  const compDir = compositionDirOf(cwd, options.motionId);
  if (!fs.existsSync(path.join(compDir, "index.html"))) {
    return {
      ok: false,
      code: "NO_COMPOSITION",
      message: `composition not found at ${compDir} — run \`cortex-agent motion scaffold\` first`,
    };
  }
  const detect = options.detect || {};
  const hasNpx = detect.hasNpx !== undefined ? detect.hasNpx : findInPath("npx", options.env) !== null;
  const tool = selectLintTool({ hasNpx });
  if (tool.error) return tool.error;

  const warn = sandboxWarning(options.env);
  if (warn) console.warn(warn);

  const args = [...tool.args, mode, "--motion-id", options.motionId];
  const spawnFn = options.spawnFn || spawn;
  const child = spawnFn("npx", args, {
    cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "inherit",
  });
  const entry = {
    ok: true,
    mode,
    message: `running hyperframes ${mode} for ${options.motionId}`,
    child,
  };
  if (options.wait === false) return entry;
  return new Promise((resolve) => {
    child.on("error", (err) => {
      resolve({ ok: false, code: "SPAWN_ERROR", message: `failed to spawn npx: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(entry);
      else resolve({ ok: false, code: "HYPERFRAMES_FAILED", message: `hyperframes ${mode} exited ${code}` });
    });
  });
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
      // try next
    }
  }
  return null;
}
