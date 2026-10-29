#!/usr/bin/env node
/**
 * minimal-context — P-002 minimal context projection.
 *
 * Adds a light entry point on top of the existing select.js pipeline:
 *   - `minimal`   : route summary only (paths, symbols, line refs, reason codes)
 *   - `standard`  : minimal + selected L1 overviews within the token budget
 *   - `deep`      : standard + full L2 details within the token budget
 *
 * The token budget bounds the *response*, not graph depth. When the budget is
 * exhausted the response carries `truncated: true`, an omitted count and a
 * `next_query` hint instead of silently dropping items.
 *
 * Usage:
 *   node minimal-context.js --task "..." --changed-files "a.js,b.ts" \
 *     --token-budget 300 --level minimal|standard|deep
 *
 * Output (JSON to stdout):
 *   { ok, level, revision, estimated_tokens, truncated, omitted,
 *     reason_codes, fallback_used, items: [...] }
 */

"use strict";

const fs = require("fs");
const path = require("path");

const { scoreModule, extractTaskTokens, pick, buildManifest } = require("./select");

const ROOT = process.cwd();
const INDEX_FILE = path.join(ROOT, ".agent", "context-index.json");
const REVISION = "1.0";

const LEVELS = new Set(["minimal", "standard", "deep"]);

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function readIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { _meta: {}, modules: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return { _meta: {}, modules: [] };
  }
}

function tokenize(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = text.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

function reasonCodeFor(mod, matchedCount) {
  if (matchedCount === 0) return "keyword_miss";
  if (mod.l0) return "l0_match";
  if (mod.l1) return "l1_match";
  return "summary_match";
}

/**
 * Build a minimal|standard|deep projection within a token budget.
 * Returns { level, estimated_tokens, truncated, omitted, items, fallback_used }
 */
function projectMinimalContext(index, task, changedFiles, tokenBudget, level) {
  const modules = Array.isArray(index.modules) ? index.modules : [];
  const { tokens: taskTokens, paths: taskPathHints } = extractTaskTokens(task || "");
  const pathHints = String(changedFiles || "").split(",").map((s) => s.trim()).filter(Boolean);

  const scored = modules
    .map((mod) => ({ mod, result: scoreModule(mod, taskTokens, pathHints) }))
    .sort((a, b) => b.result.score - a.result.score);

  const items = [];
  let used = 0;
  let omitted = 0;
  const fallbackUsed = modules.length === 0;

  for (const { mod, result } of scored) {
    if (result.score <= 0) {
      omitted += 1;
      continue;
    }

    let snippet;
    if (level === "minimal") {
      snippet = `${mod.module_path || mod.module_name || "?"}:${mod.l0_tokens || "?"}t`;
    } else if (level === "standard") {
      snippet = mod.l1 || mod.summary || mod.l0 || "";
    } else {
      snippet = mod.l2 || mod.summary || mod.l1 || "";
    }

    const cost = Math.max(1, tokenize(snippet));
    if (used + cost > tokenBudget) {
      omitted += 1;
      continue;
    }

    used += cost;
    items.push({
      uri: `cortex://references/${mod.module_name || mod.module_path || "unknown"}`,
      path: mod.module_path || null,
      module: mod.module_name || null,
      score: result.score,
      reason_code: reasonCodeFor(mod, result.matched.length),
      estimated_tokens: cost,
      level,
    });
  }

  return {
    level,
    estimated_tokens: used,
    truncated: omitted > 0,
    omitted,
    items,
    fallback_used: fallbackUsed,
  };
}

function main() {
  const args = parseArgs();
  const task = args.task || "";
  const changedFiles = args["changed-files"] || "";
  const tokenBudget = Number(args["token-budget"] || 300);
  const level = args.level || "minimal";

  if (!LEVELS.has(level)) {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_level", reason: `level must be one of: ${[...LEVELS].join(", ")}` }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }

  const index = readIndex();
  const projection = projectMinimalContext(index, task, changedFiles, tokenBudget, level);

  process.stdout.write(JSON.stringify({
    ok: true,
    command: "minimal-context",
    revision: REVISION,
    ...projection,
    next_query: projection.truncated
      ? `minimal-context --level ${level === "minimal" ? "standard" : "deep"} --token-budget ${tokenBudget * 2}`
      : null,
  }, null, 2) + "\n");
}

if (require.main === module) {
  main();
}

module.exports = { projectMinimalContext, REVISION, LEVELS };
