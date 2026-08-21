"use strict";

// ─── snapshot — proof 帧 contact-sheet (P-005 MS-005) ────────────────────────
//
// 渲染门控的 proof 环节:lint/check 通过后,产出一张 contact-sheet
// (PNG 九宫格 proof 帧)给用户人工确认(approve gate —— 用户看过 proof 帧
// 说"渲染"才进入 render)。依赖 headless Chrome,通过 `screenshot-auto`
// 命令(或 `npx hyperframes snapshot`)调用。
//
// 产物:`<cwd>/.agent/motion/<id>/snapshots/contact-sheet.png`
//
// 零 npm 依赖:node:fs / node:path / node:child_process (spawn)。

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { compositionDirOf } = require("./render");

const SNAPSHOT_FILENAME = "contact-sheet.png";

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

/**
 * Choose the snapshot command:
 *   "screenshot-auto" (PATH) → headless Chrome screenshot wrapper
 *   "npx hyperframes snapshot" (npx present) → hyperframes proof frames
 *   null → graceful error + install guidance
 * Pure + testable.
 */
function selectSnapshotTool({ hasScreenshotAuto, hasNpx }) {
  if (hasScreenshotAuto) return { tool: "screenshot-auto", args: [] };
  if (hasNpx) return { tool: "npx", args: ["hyperframes", "snapshot"] };
  return {
    error: {
      code: "NO_SNAPSHOT_TOOL",
      message:
        "缺少 screenshot-auto(或 npx hyperframes)— 无法产出 proof 帧。\n" +
        "安装指引:确保 headless Chrome 可用,并安装 screenshot-auto / hyperframes。",
    },
  };
}

/**
 * Capture proof frames into `<compDir>/snapshots/contact-sheet.png`.
 *   detect — { hasScreenshotAuto, hasNpx } overrides (tests)
 *   spawnFn — injectable (tests)
 *   wait — false to return the child without waiting (preview-like flow)
 * Returns { ok, path?, message?, child? }.
 */
function captureSnapshot(options) {
  const cwd = options.cwd || process.cwd();
  const motionId = options.motionId;
  const compDir = compositionDirOf(cwd, motionId);
  if (!motionId || !fs.existsSync(path.join(compDir, "index.html"))) {
    return {
      ok: false,
      code: "NO_COMPOSITION",
      message: `composition not found at ${compDir} — run \`cortex-agent motion scaffold\` first`,
    };
  }

  const detect = options.detect || {};
  const hasScreenshotAuto =
    detect.hasScreenshotAuto !== undefined
      ? detect.hasScreenshotAuto
      : findInPath("screenshot-auto", options.env) !== null;
  const hasNpx = detect.hasNpx !== undefined ? detect.hasNpx : findInPath("npx", options.env) !== null;
  const tool = selectSnapshotTool({ hasScreenshotAuto, hasNpx });
  if (tool.error) return tool.error;

  const snapshotsDir = path.join(compDir, "snapshots");
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const out = path.join(snapshotsDir, SNAPSHOT_FILENAME);

  const args = [...tool.args, "--composition-dir", compDir, "--output", out];
  const spawnFn = options.spawnFn || spawn;
  const child = spawnFn(tool.tool, args, {
    cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "inherit",
  });

  const entry = {
    ok: true,
    tool: tool.tool,
    path: out,
    message: `snapshot proof → ${path.relative(cwd, out) || out} (${tool.tool})`,
    child,
  };
  if (options.wait === false) return entry;

  return new Promise((resolve) => {
    child.on("error", (err) => {
      resolve({ ok: false, code: "SPAWN_ERROR", message: `failed to spawn ${tool.tool}: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (code === 0) resolve(entry);
      else
        resolve({
          ok: false,
          code: "SNAPSHOT_FAILED",
          message: `${tool.tool} exited with code ${code} — check headless Chrome`,
        });
    });
  });
}

module.exports = {
  SNAPSHOT_FILENAME,
  captureSnapshot,
  selectSnapshotTool,
  _internal: {
    findInPath,
  },
};
