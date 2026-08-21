"use strict";

// ─── render — `media generate/wait` daemon dispatch + npx fallback (P-005) ──
//
// 渲染路径 (D-ODI-004, P-005 §4.6):
//   A. open-design daemon dispatch (默认,推荐) — daemon 无沙箱进程渲染,
//      Chrome 不被 macOS sandbox-exec 挂起:
//        spawn('open-design', ['media','generate','--motion-id',id,'--preset',preset])
//   B. `npx hyperframes render` 直跑(降级)— 无 daemon 时使用;若检测到
//      Claude Code sandbox-exec 环境 (process.env.CLAUDE_CODE === 'true'),
//      输出警告: "Claude Code sandbox-exec 会挂起 Chrome,建议在普通 shell 中运行"。
//
// 渲染是用户门控动作(approve gate):本模块不自动触发;CLI 层在用户确认后才调用。
//
// 零 npm 依赖:node:fs / node:path / node:crypto / node:child_process (spawn)。

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { getPreset, outputExtension } = require("./edit-presets");

const MANIFEST_VERSION = "od-render-manifest/v1";

const SANDBOX_WARNING =
  "⚠️ Claude Code sandbox-exec 会挂起 Chrome — 建议在普通 shell 中运行(或安装 open-design daemon 走路径 A)";

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function sha256File(file) {
  if (!isFile(file)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Pick the render path. Pure + testable.
 *   hasOpenDesign — `open-design` on PATH (daemon dispatch available)
 *   hasNpx        — `npx` on PATH
 * Returns "daemon" | "npx" | { error }.
 */
function selectRenderPath({ hasOpenDesign, hasNpx }) {
  if (hasOpenDesign) return "daemon";
  if (hasNpx) return "npx";
  return {
    error: {
      code: "NO_RENDERER",
      message:
        "既没有 open-design daemon 也没有 npx — 无法渲染。安装 open-design(推荐,确定性渲染)或 Node.js ≥ 18(含 npx)后重试。",
    },
  };
}

/**
 * Sandbox warning for path B. Returns the warning string when the caller runs
 * inside a Claude Code sandbox-exec shell, else null. Pure + testable.
 */
function sandboxWarning(env) {
  if (env && (env.CLAUDE_CODE === "true" || env.CLAUDE_CODE === "1")) return SANDBOX_WARNING;
  return null;
}

function compositionDirOf(cwd, motionId) {
  return path.join(cwd, ".agent", "motion", motionId);
}

/**
 * Translate an edit preset into hyperframes `render` CLI args.
 *
 * hyperframes render is a project-level command: cwd must be the composition
 * dir and the preset is expressed via --format / --resolution / -f, not a
 * motion-id/preset id. Container/format map:
 *   mov  → --format mov  (ProRes/alpha; MOV carries transparency)
 *   webm → --format webm (VP9 alpha)
 *   mp4  → --format mp4  (H.264)
 * Resolution map:
 *   1920x1080 → landscape · 3840x2160 → landscape-4k
 *   1080x1920 → portrait  · 2160x3840 → portrait-4k
 * Pure + testable. Returns `{ args }` — the output path is appended by the
 * caller so the "renders/<motionId>-<presetId>.<ext>" convention is kept.
 */
function hyperframesRenderArgs(preset) {
  const format = preset.container === "mov" ? "mov" : preset.container === "webm" ? "webm" : "mp4";
  // hyperframes 限制:--resolution 不能与 alpha 输出路径(mov/webm)组合 —
  // mov/webm 一律按 composition 原生分辨率渲染(我们的 1920x1080 模板已满足
  // 1080p 预设;4K 预设留给上游启用的放大或 mp4 容器)。
  const isAlphaPath = format === "mov" || format === "webm";
  const res =
    !isAlphaPath &&
    (preset.width === 1920 && preset.height === 1080
      ? "landscape"
      : preset.width === 3840 && preset.height === 2160
        ? "landscape-4k"
        : preset.width === 1080 && preset.height === 1920
          ? "portrait"
          : preset.width === 2160 && preset.height === 3840
            ? "portrait-4k"
            : null);
  const args = ["hyperframes", "render", "-c", ".", "--format", format, "-f", String(preset.fps), "--strict"];
  if (res) args.push("--resolution", res);
  return { args, format };
}

function expectedOutputPath(cwd, motionId, presetId, preset) {
  const ext = outputExtension(preset);
  return path.join(compositionDirOf(cwd, motionId), "renders", `${motionId}-${presetId}.${ext}`);
}

/**
 * Compute deterministic hashes for the render manifest (审计:这段 MP4 是哪版
 * 代码渲染的 — P-005 §4.4 render-manifest.json)。
 */
function compositionHashes(cwd, motionId) {
  const dir = compositionDirOf(cwd, motionId);
  const hash = (name) => sha256File(path.join(dir, name));
  return {
    hyperframesJsonSha256: hash("hyperframes.json"),
    indexHtmlSha256: hash("index.html"),
    metaJsonSha256: hash("meta.json"),
  };
}

/**
 * Write `renders/render-manifest.json` (od-render-manifest/v1) for a completed
 * render. Deterministic inputs → deterministic manifest.
 */
function writeRenderManifest({ cwd, motionId, presetId, engine, outputs, durationSec, frames }) {
  const preset = getPreset(presetId);
  const dir = compositionDirOf(cwd, motionId);
  const rendersDir = path.join(dir, "renders");
  fs.mkdirSync(rendersDir, { recursive: true });
  const manifest = {
    schemaVersion: MANIFEST_VERSION,
    motionId,
    preset: presetId,
    composition: compositionHashes(cwd, motionId),
    render: {
      fps: preset ? preset.fps : null,
      width: preset ? preset.width : null,
      height: preset ? preset.height : null,
      codec: preset ? preset.codec : null,
      pixelFormat: preset ? preset.pixel_format : null,
      alpha: preset ? preset.alpha : null,
      gpu: "hardware",
      durationSec: durationSec != null ? durationSec : null,
      frames: frames != null ? frames : null,
      seed: 42,
    },
    outputs: (outputs || []).map((o) => ({
      path: o.path,
      size: isFile(o.path) ? fs.statSync(o.path).size : null,
      sha256: sha256File(o.path),
    })),
    renderedAt: new Date().toISOString(),
    engine,
  };
  const out = path.join(rendersDir, "render-manifest.json");
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2), "utf8");
  return { path: out, manifest };
}

function spawnChild(cmd, args, options) {
  const spawnFn = options.spawnFn || spawn;
  return spawnFn(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "inherit",
  });
}

function waitExit(child, cmdLabel) {
  return new Promise((resolve) => {
    child.on("error", (err) => {
      resolve({ ok: false, code: "SPAWN_ERROR", message: `failed to spawn ${cmdLabel}: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, code: 0 });
      else
        resolve({
          ok: false,
          code: "RENDER_FAILED",
          message: `${cmdLabel} exited with code ${code}`,
        });
    });
  });
}

/**
 * Render a motion composition to an edit-ready file. User-gated: callers
 * (CLI) must confirm with the user before invoking this.
 *
 * options:
 *   motionId, preset (preset id), cwd, env
 *   spawnFn   — injectable (tests)
 *   detect    — { hasOpenDesign, hasNpx } overrides (tests); default: PATH scan
 *   outputs   — post-render file list; default: expectedOutputPath if exists
 * Returns { ok, path?, engine?, manifest?, message? }.
 */
async function renderMotion(options) {
  const cwd = options.cwd || process.cwd();
  const presetId = options.preset;
  const preset = presetId ? getPreset(presetId) : null;
  if (!preset) {
    return { ok: false, code: "UNKNOWN_PRESET", message: `unknown --preset "${presetId}"` };
  }
  const compDir = compositionDirOf(cwd, options.motionId);
  if (!isFile(path.join(compDir, "index.html"))) {
    return {
      ok: false,
      code: "NO_COMPOSITION",
      message: `composition not found at ${compDir} — run \`cortex-agent motion scaffold\` first`,
    };
  }

  const detect = options.detect || {};
  const hasOpenDesign = detect.hasOpenDesign !== undefined ? detect.hasOpenDesign : findInPath("open-design", options.env) !== null;
  const hasNpx = detect.hasNpx !== undefined ? detect.hasNpx : findInPath("npx", options.env) !== null;
  const route = selectRenderPath({ hasOpenDesign, hasNpx });
  if (route.error) return route.error;

  let result;
  let engine;
  if (route === "daemon") {
    engine = "open-design-daemon";
    const child = spawnChild("open-design", ["media", "generate", "--motion-id", options.motionId, "--preset", presetId], options);
    result = await waitExit(child, "open-design media generate");
  } else {
    engine = "hyperframes-npx";
    const warn = sandboxWarning(options.env);
    if (warn) console.warn(warn);
    const { args } = hyperframesRenderArgs(preset);
    const out = expectedOutputPath(cwd, options.motionId, presetId, preset);
    const child = spawnChild("npx", [...args, "-o", out], { ...options, cwd: compDir });
    result = await waitExit(child, "npx hyperframes render");
  }
  if (!result.ok) return result;

  const outputs = options.outputs || [];
  const expected = expectedOutputPath(cwd, options.motionId, presetId, preset);
  if (isFile(expected)) outputs.push(expected);
  const manifestResult = writeRenderManifest({
    cwd,
    motionId: options.motionId,
    presetId,
    engine,
    outputs,
    durationSec: options.durationSec,
    frames: options.frames,
  });

  return {
    ok: true,
    engine,
    path: isFile(expected) ? expected : null,
    manifest: manifestResult.manifest,
    message: `rendered ${options.motionId} → ${path.relative(cwd, expected) || expected} (${engine})`,
  };
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

module.exports = {
  MANIFEST_VERSION,
  SANDBOX_WARNING,
  renderMotion,
  selectRenderPath,
  sandboxWarning,
  compositionHashes,
  writeRenderManifest,
  expectedOutputPath,
  compositionDirOf,
  _internal: {
    findInPath,
    sha256File,
    isFile,
    spawnChild,
    waitExit,
  },
};
