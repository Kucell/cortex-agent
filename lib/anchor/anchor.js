"use strict";

// ─── Cross-tool Anchor ────────────────────────────────────────────────────────
// The anchor is a short, versioned snippet that any AI coding tool (Claude Code,
// Codex, Cursor, Aider, Pi agent, …) can paste into its long-term memory. When
// the tool sees the `cortex-agent:anchor:v1` marker, it knows:
//
//   1. This project is governed by cortex-agent.
//   2. The real rules / workflows / skills live in ./AGENTS.md + ./.agent/.
//   3. It should prefer existing cortex-agent workflows over inventing new ones.
//
// The anchor is rendered from a stable template (ANCHOR_TEMPLATE below) and
// stamped with project + version metadata. The version suffix (`v1`) lets us
// evolve the format later without breaking older tools — a tool that doesn't
// recognise `v2` simply ignores the snippet and falls back to its default.
//
// Two output formats are supported:
//   - markdown (default): a single fenced block that can be appended verbatim
//     to CLAUDE.md / AGENTS.md / .pi/agent.md / any markdown-shaped memory.
//   - json: machine-readable metadata (project name, version, paths) for tools
//     that ingest structured memory (e.g. Pi agent settings).

const fs = require("fs");
const path = require("path");

const ANCHOR_VERSION = "v1";
const ANCHOR_BEGIN = `<!-- cortex-agent:anchor:${ANCHOR_VERSION} -->`;
const ANCHOR_END = "<!-- cortex-agent:anchor:end -->";
const PKG_VERSION = require("../../package.json").version;

const ANCHOR_TEMPLATE = `${ANCHOR_BEGIN}
This project is managed by [cortex-agent](https://github.com/Kucell/cortex-agent) v{VERSION}.

## What this means
- The project uses a \`.agent/\` directory (gitignored) as the single source of truth for AI agent rules, workflows, and skills.
- Entry point: \`./AGENTS.md\` — read it first and follow its load order.
- Rules / workflows / skills live in \`./.agent/\` (gitignored; not in version control).

## How to work with it
1. **First time in this project**: read \`./AGENTS.md\`, then load \`.agent/rules/\`, \`.agent/workflows/\`, and \`.agent/skills/\` in the order AGENTS.md specifies.
2. **Stable project knowledge** (architecture, proposals, roadmap) lives in \`./docs/\`. Do NOT put proposals or planning docs in \`.agent/\` — \`.agent/\` is gitignored runtime data.
3. **Use the existing cortex-agent CLI** when available: \`cortex-agent status\`, \`cortex-agent rules list\`, \`cortex-agent scan-project\`, \`cortex-agent dev\` (Dashboard). If unavailable, fall back to reading the rule / workflow files directly.
4. **If a workflow exists** for your task (e.g. arch-design, ship, handoff, mission, plan), use it — do not invent a new script.
5. **Cross-tool recognition**: this project exports a \`docs/cortex-agent/anchor.md\` (in version control) so any AI tool can pick it up. Re-run \`cortex-agent export-anchor\` to refresh.

## Memory discipline
- Memory (yours and cortex-agent's) is a hint, not live state. Always verify against the current file / code before acting.
- For project-specific config (build / test / MCP / architecture), project files (AGENTS.md, package.json, docs/) are the truth — NOT this snippet.
- For tool-specific behavior, follow the tool's own conventions: CLAUDE.md / AGENTS.md / .pi/settings — not this anchor.
${ANCHOR_END}`;

const ANCHOR_JSON_TEMPLATE = {
  schema: "cortex-agent.anchor",
  version: ANCHOR_VERSION,
  framework: "cortex-agent",
  framework_version: "{VERSION}",
  project: "{PROJECT_NAME}",
  entry_file: "AGENTS.md",
  agent_dir: ".agent/",
  public_anchor: "docs/cortex-agent/anchor.md",
  cli: "cortex-agent",
  cli_commands: ["status", "rules list", "scan-project", "export-anchor", "dev"],
  note: "Stable knowledge lives in ./docs/; .agent/ is gitignored runtime data. Do not write proposals to .agent/.",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectProjectName(projectDir) {
  // 1) package.json name field
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
    if (pkg && typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch (_) {}
  // 2) .git/config remote url basename
  try {
    const cfg = fs.readFileSync(path.join(projectDir, ".git", "config"), "utf8");
    const m = cfg.match(/url\s*=\s*[^\n]*\/([^\n/]+?)(?:\.git)?\s*$/m);
    if (m && m[1]) return m[1];
  } catch (_) {}
  // 3) directory basename
  return path.basename(projectDir) || "project";
}

function detectAgentDir(projectDir) {
  return fs.existsSync(path.join(projectDir, ".agent")) ? ".agent/" : null;
}

function detectEntryFile(projectDir) {
  return fs.existsSync(path.join(projectDir, "AGENTS.md")) ? "AGENTS.md" : null;
}

function detectPublicAnchor(projectDir) {
  const p = path.join(projectDir, "docs", "cortex-agent", "anchor.md");
  return fs.existsSync(p) ? "docs/cortex-agent/anchor.md" : null;
}

function buildContext({ projectDir, name }) {
  const dir = projectDir || process.cwd();
  return {
    projectDir: dir,
    projectName: name || detectProjectName(dir),
    version: PKG_VERSION,
    agentDir: detectAgentDir(dir),
    entryFile: detectEntryFile(dir),
    publicAnchor: detectPublicAnchor(dir),
  };
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderMarkdown(ctx) {
  // The template is fixed; we only stamp the framework version into it.
  // Project-specific context is conveyed through the existence hints in the
  // template (entry file / agent dir / public anchor) — we don't splice the
  // project name into the markdown because the snippet is meant to be reused
  // verbatim across every cortex-agent project the user works on.
  return ANCHOR_TEMPLATE.replace("{VERSION}", ctx.version);
}

function renderJson(ctx) {
  return JSON.stringify(
    {
      ...ANCHOR_JSON_TEMPLATE,
      framework_version: ctx.version,
      project: ctx.projectName,
      entry_file: ctx.entryFile || ANCHOR_JSON_TEMPLATE.entry_file,
      agent_dir: ctx.agentDir || ANCHOR_JSON_TEMPLATE.agent_dir,
      public_anchor: ctx.publicAnchor || ANCHOR_JSON_TEMPLATE.public_anchor,
    },
    null,
    2,
  ) + "\n";
}

function render(ctx, format) {
  switch (format) {
    case "json":
      return renderJson(ctx);
    case "markdown":
    case "md":
    default:
      return renderMarkdown(ctx);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the cross-tool anchor snippet.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - project root (defaults to cwd)
 * @param {string} [opts.name]       - override project name
 * @param {"markdown"|"json"} [opts.format="markdown"]
 * @returns {{ context: object, body: string, format: string }}
 */
function buildAnchor(opts = {}) {
  const ctx = buildContext(opts);
  const format = opts.format || "markdown";
  const body = render(ctx, format);
  return { context: ctx, body, format };
}

module.exports = {
  buildAnchor,
  buildContext,
  renderMarkdown,
  renderJson,
  ANCHOR_VERSION,
  ANCHOR_BEGIN,
  ANCHOR_END,
  PKG_VERSION,
};
