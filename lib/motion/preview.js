"use strict";

// ─── preview — browser live reload (P-005 MS-005) ────────────────────────────
//
// `cortex-agent motion preview --motion-id <id> [--port 4173]` 在
// `<cwd>/.agent/motion/<id>/` 起 `python3 -m http.server`(默认端口 4173),
// 输出浏览器 URL。HTML 里保留 GSAP + 预览控制器,改 `index.html` 后刷新即
// live reload(迭代循环 G3)。
//
// 零 npm 依赖:node:fs / node:path / node:child_process (spawn)。

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { compositionDirOf } = require("./render");

const DEFAULT_PORT = 4173;

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * Start `python3 -m http.server <port> --directory <compositionDir>`.
 *   spawnFn  — injectable (tests)
 *   port     — default 4173
 * Returns { ok, url, port, child, message } (ok=false when python3 missing).
 */
function startPreview(options) {
  const cwd = options.cwd || process.cwd();
  const motionId = options.motionId;
  const port = options.port || DEFAULT_PORT;
  const compDir = compositionDirOf(cwd, motionId);

  if (!motionId || !isDirectory(compDir)) {
    return {
      ok: false,
      code: "NO_COMPOSITION",
      message: `composition not found at ${compDir} — run \`cortex-agent motion scaffold\` first`,
    };
  }

  const spawnFn = options.spawnFn || spawn;
  let child;
  try {
    child = spawnFn("python3", ["-m", "http.server", String(port), "--directory", compDir], {
      stdio: options.stdio || "inherit",
    });
  } catch (err) {
    return { ok: false, code: "SPAWN_ERROR", message: `failed to spawn python3: ${err.message}` };
  }

  const url = `http://localhost:${port}/`;
  const message = `preview live at ${url} (Ctrl-C to stop) — edit index.html and refresh`;
  if (options.wait !== false) {
    child.on("error", (err) => {
      if (options.onError) options.onError(err);
    });
  }
  return { ok: true, url, port, child, message, compositionDir: compDir };
}

function stopPreview(entry) {
  if (!entry || !entry.child) return false;
  try {
    entry.child.kill("SIGTERM");
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  DEFAULT_PORT,
  startPreview,
  stopPreview,
  _internal: {
    isDirectory,
  },
};
