"use strict";

// ─── anchor — cross-tool identity snippet ─────────────────────────────────────
//
// Originally lived in lib/commands.js. Provides two entry points:
//   - writePublicAnchor(targetBase, isGlobal): writes docs/cortex-agent/anchor.md
//     to a project root. Called by `init` and by `exportAnchor` (auto-bootstrap).
//   - exportAnchor(ctx): CLI surface for `cortex-agent export-anchor`.
//
// The anchor itself is built by lib/anchor.js (already a separate module).

const fs = require("node:fs");
const path = require("node:path");
const { buildAnchor } = require("../anchor/anchor");

function writePublicAnchor(targetBase, isGlobal) {
  // Global installs (~/.agent) don't write to docs/ — there's no project
  // root. The anchor only makes sense per-project.
  if (isGlobal) return false;
  try {
    const { body } = buildAnchor({ projectDir: targetBase });
    const anchorDir = path.join(targetBase, "docs", "cortex-agent");
    const anchorPath = path.join(anchorDir, "anchor.md");
    fs.mkdirSync(anchorDir, { recursive: true });
    fs.writeFileSync(anchorPath, body, "utf8");
    return true;
  } catch (err) {
    console.warn(
      `⚠️  Failed to write cross-tool anchor to docs/cortex-agent/anchor.md: ${err.message}`,
    );
    return false;
  }
}

function printExportAnchorHelp(isZh) {
  console.log(
    isZh
      ? `\n用法:cortex-agent export-anchor [--json] [--project <path>] [--name <name>]\n\n` +
        `输出跨工具识别锚点(<!-- cortex-agent:anchor:v1 -->),可粘贴到:\n` +
        `  - Claude Code  → CLAUDE.md\n` +
        `  - Codex/Cursor → AGENTS.md\n` +
        `  - Pi agent     → .pi/agent.md\n\n` +
        `默认格式:markdown(可直接粘贴)。--json 输出结构化元数据。\n`
      : `\nUsage: cortex-agent export-anchor [--json] [--project <path>] [--name <name>]\n\n` +
        `Prints the cross-tool identity anchor (<!-- cortex-agent:anchor:v1 -->) for paste into:\n` +
        `  - Claude Code  → CLAUDE.md\n` +
        `  - Codex/Cursor → AGENTS.md\n` +
        `  - Pi agent     → .pi/agent.md\n\n` +
        `Default: markdown (paste directly). --json for machine-readable metadata.\n`,
  );
}

function exportAnchor(ctx) {
  const { args, options, cwd } = ctx;
  const isZh = (ctx.lang || "en") === "zh";

  // Parse subcommand-style flags: cortex-agent export-anchor [--json] [--project <path>] [--name <name>]
  let format = "markdown";
  let projectDir = options.project ? path.resolve(cwd, options.project) : cwd;
  let name = options.name || null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "--format=json") format = "json";
    else if (a === "--markdown" || a === "--md" || a === "--format=markdown") format = "markdown";
    else if (a === "--format") {
      const v = args[i + 1];
      if (v === "json" || v === "markdown") format = v;
      i++;
    } else if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v === "json" || v === "markdown") format = v;
    } else if (a === "--project" && args[i + 1] && !args[i + 1].startsWith("--")) {
      projectDir = path.resolve(cwd, args[i + 1]);
      i++;
    } else if (a.startsWith("--project=")) {
      projectDir = path.resolve(cwd, a.slice("--project=".length));
    } else if (a === "--name" && args[i + 1] && !args[i + 1].startsWith("--")) {
      name = args[i + 1];
      i++;
    } else if (a.startsWith("--name=")) {
      name = a.slice("--name=".length);
    } else if (a === "--help" || a === "-h") {
      printExportAnchorHelp(isZh);
      return;
    }
  }

  if (!fs.existsSync(projectDir)) {
    console.error(
      isZh
        ? `❌ 项目目录不存在:${projectDir}`
        : `❌ Project directory does not exist: ${projectDir}`,
    );
    process.exitCode = 2;
    return;
  }

  // Auto-bootstrap: if the public anchor doesn't exist yet (e.g. the user
  // upgraded from a pre-anchor version), write it now so the snippet they
  // copy is consistent with the on-disk file.
  const publicAnchorPath = path.join(projectDir, "docs", "cortex-agent", "anchor.md");
  if (format === "markdown" && !fs.existsSync(publicAnchorPath)) {
    const written = writePublicAnchor(projectDir, false);
    if (written) {
      console.error(
        isZh
          ? `ℹ️  已自动生成 ${path.relative(projectDir, publicAnchorPath)}`
          : `ℹ️  Auto-generated ${path.relative(projectDir, publicAnchorPath)}`,
      );
    }
  }

  try {
    const { body, context } = buildAnchor({ projectDir, name, format });
    if (format === "json") {
      process.stdout.write(body);
    } else {
      process.stdout.write(body + "\n");
    }
    process.stderr.write(
      isZh
        ? `ℹ️  cortex-agent v${context.version} · 项目:${context.projectName}\n   粘贴到:CLAUDE.md / AGENTS.md / .pi/agent.md\n   重新生成:cortex-agent export-anchor\n`
        : `ℹ️  cortex-agent v${context.version} · project: ${context.projectName}\n   Paste into: CLAUDE.md / AGENTS.md / .pi/agent.md\n   Re-emit: cortex-agent export-anchor\n`,
    );
  } catch (err) {
    console.error(
      isZh
        ? `❌ 生成锚点失败:${err.message}`
        : `❌ Failed to render anchor: ${err.message}`,
    );
    process.exitCode = 3;
  }
}

module.exports = {
  writePublicAnchor,
  exportAnchor,
};
