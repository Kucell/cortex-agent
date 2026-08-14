#!/usr/bin/env node
"use strict";

// ─── prompt-inject (P-006 template-side injection) ────────────────────────────
// Zero-dependency prompt assembly for general mode: picks the core/domain
// prompt layers according to the requested injection target, then appends
// project memory (top-N) and the latest conversation summary when present.
//
// Layer semantics (P-006 §3.1):
//   core   -> always-on minimal set (identity, mode, principles, routing)
//   domain -> on-demand layer (long references, detailed guidance)
//   all    -> both layers (legacy single-prompt equivalent)
//
// Usage:
//   node .../prompt-inject/scripts/inject.js --lang zh|en --layer core|domain|all \
//     [--memory-top-n 5] [--include-summary true|false]
//
// Reads:
//   - <project>/.agent/prompts/system-prompt-{core|domain}.{md|zh.md}
//   - <project>/.agent/memory/{episodic,semantic}/MEM-*.json (top-N by mtime)
//   - <project>/.agent/conversations/<latest>/summary.md (optional)

const fs = require("node:fs");
const path = require("node:path");

function projectRoot() {
  const explicit = process.env.CORTEX_PROJECT_ROOT;
  if (explicit && path.isAbsolute(explicit)) return explicit;
  return process.cwd();
}

function option(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1] !== undefined) return process.argv[idx + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function readLayer(root, layer, lang) {
  const suffix = lang === "zh" ? ".zh.md" : ".md";
  const candidates = [
    path.join(root, ".agent", "general", "prompts", `system-prompt-${layer}${suffix}`),
    path.join(root, ".agent", "general", "prompts", `system-prompt-${layer}.md`),
    path.join(root, ".agent", "prompts", `system-prompt-${layer}${suffix}`),
    path.join(root, ".agent", "prompts", `system-prompt-${layer}.md`),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  }
  return null;
}

function latestMemoryEntries(root, topN) {
  const out = [];
  for (const type of ["episodic", "semantic"]) {
    const dir = path.join(root, ".agent", "memory", type);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    files.sort((a, b) => {
      const ta = fs.statSync(path.join(dir, a)).mtimeMs;
      const tb = fs.statSync(path.join(dir, b)).mtimeMs;
      return tb - ta;
    });
    for (const name of files.slice(0, topN)) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        out.push(`- [${type}] ${entry.title || entry.memory_id || name}: ${entry.content || ""}`);
      } catch {
        // skip unreadable memory files; never fail injection on them
      }
    }
  }
  return out;
}

function latestConversationSummary(root) {
  const conversationsDir = path.join(root, ".agent", "conversations");
  let ids = [];
  try {
    ids = fs.readdirSync(conversationsDir).filter((name) => /^C-/.test(name));
  } catch {
    return null;
  }
  ids.sort().reverse();
  for (const id of ids) {
    const summary = path.join(conversationsDir, id, "summary.md");
    if (fs.existsSync(summary)) return fs.readFileSync(summary, "utf8");
  }
  return null;
}

function main() {
  const lang = option("--lang", "en");
  const layer = option("--layer", "core");
  const memoryTopN = Number(option("--memory-top-n", "5"));
  const includeSummary = option("--include-summary", "true") !== "false";
  const root = projectRoot();

  if (!["core", "domain", "all"].includes(layer)) {
    process.stderr.write(`invalid --layer: ${layer} (expected core|domain|all)\n`);
    process.exitCode = 2;
    return;
  }

  const parts = [];
  if (layer === "core" || layer === "all") {
    const core = readLayer(root, "core", lang);
    if (!core) {
      process.stderr.write("core layer not found; run cortex-agent update to install prompt templates\n");
      process.exitCode = 2;
      return;
    }
    parts.push(core);
  }
  if (layer === "domain" || layer === "all") {
    const domain = readLayer(root, "domain", lang);
    if (domain) parts.push(domain);
  }

  const memories = latestMemoryEntries(root, memoryTopN);
  if (memories.length > 0) {
    parts.push(`## Project memory (top ${memories.length})\n\n${memories.join("\n")}`);
  }

  if (includeSummary) {
    const summary = latestConversationSummary(root);
    if (summary) parts.push(`## Latest conversation summary\n\n${summary}`);
  }

  process.stdout.write(parts.join("\n\n---\n\n") + "\n");
}

main();
