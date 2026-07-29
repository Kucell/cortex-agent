#!/usr/bin/env node
/**
 * select — L0/L1/L2-aware context-budget selector.
 *
 * Replaces the v0 heuristic selector with a layered pipeline:
 *   1. Read context-index.json (modules may carry `l0` / `l1` fields)
 *   2. Score modules by keyword overlap against the task description
 *   3. For each candidate, compare L0 first; only promote to L1 if it matches
 *   4. Allocate budget in Tier 1 → Tier 2 → Tier 3 order
 *   5. Emit `context-manifest.json` AND a retrieval trajectory
 *      (compatible with `retrieval-trajectory/scripts/record.js`)
 *
 * Compatibility: if no module has L0/L1 fields, the selector falls back to the
 * v0 heuristic (score against full module.summary) — no breaking change.
 *
 * Usage:
 *   node select.js --task "implement OAuth login" --task-id T-DEMO-001
 *   node select.js --task "..." --task-id T-001 --llm-window 200000
 *
 * Output:
 *   JSON to stdout (manifest + trajectory).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  digestMetadata,
  validateContextTrajectory,
} = require("../../../../lib/runtime-adapters/context-trajectory");

const ROOT = process.cwd();
const INDEX_FILE = path.join(ROOT, ".agent", "context-index.json");
const MANIFEST_PATH = path.join(ROOT, ".agent", "plans", "context-manifest.json");
const TRAJECTORY_DIR = path.join(ROOT, ".agent", "runtime-evidence", "trajectory");
const CONTEXT_TRAJECTORY_DIR = path.join(ROOT, ".agent", "runtime-evidence", "context-trajectories");

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

function tokenize(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = text.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

function tokenizeBudget(text) {
  return text.length;
}

function readIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { _meta: {}, modules: [] };
  return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
}

/**
 * Score module against task description.
 * Returns: { score, matched, l0_hit, l1_hit, l2_hit }
 */
function scoreModule(mod, taskTokens, taskPathHints) {
  // L0 keyword match (use description-style summary, ~100 tokens)
  const l0Text = (mod.l0 || mod.summary || "").toLowerCase();
  const l1Text = (mod.l1 || mod.summary || "").toLowerCase();
  const kwText = (mod.keywords || []).join(" ").toLowerCase();

  let score = 0;
  const matched = new Set();
  const l0Hit = new Set();
  const l1Hit = new Set();

  for (const tk of taskTokens) {
    if (l0Text.includes(tk)) { score += 1; l0Hit.add(tk); matched.add(tk); }
    if (l1Text.includes(tk)) { score += 1; l1Hit.add(tk); matched.add(tk); }
    if (kwText.includes(tk)) { score += 0.5; matched.add(tk); }
  }
  score = Math.round(score * 10) / 10;

  // Path hint bonus: task mentions a path that matches module_path
  for (const p of taskPathHints) {
    if (mod.module_path && p.includes(mod.module_path)) { score += 5; }
  }
  return { score, matched: [...matched], l0_hit: [...l0Hit], l1_hit: [...l1Hit] };
}

function extractTaskTokens(task) {
  if (!task) return { tokens: [], paths: [] };
  const cjk = (task.match(/[\u4e00-\u9fff]+/g) || []);
  const words = (task.replace(/[\u4e00-\u9fff]/g, " ").toLowerCase().match(/[a-z0-9_\-/.]{2,}/g) || []);
  const all = [...cjk, ...words];
  // dedupe + filter noise
  const tokens = [...new Set(all.filter((t) => t.length >= 2 && !STOPWORDS.has(t)))].slice(0, 60);
  const paths = (task.match(/[a-zA-Z0-9_\-/.]+\.[a-z]{1,5}/g) || []);
  return { tokens, paths };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "have", "has",
  "你", "我们", "他们", "请", "一下", "需要", "应该", "这个", "那个", "然后",
]);

function pick(scored, budget, trajectory) {
  const tiers = { tier1: [], tier2: [], tier3_summaries: [] };
  let remaining = budget;
  const used = { tier1: 0, tier2: 0, tier3_summaries: 0 };

  // Sort by score desc, then by token asc (smaller modules first when tied)
  const sorted = scored
    .filter((s) => s.score > 0 || s.module_name === "task-progress")
    .sort((a, b) => b.score - a.score || a.tokens - b.tokens);

  for (const s of sorted) {
    const tokens = s.tokens;
    if (s.score >= 7) {
      if (tokens <= remaining) {
        tiers.tier1.push(s);
        used.tier1 += tokens;
        remaining -= tokens;
        trajectory.push({ step: 3, action: "promote", tier: "tier1", uri: `cortex://references/${s.module_path || s.module_name}`, tokens, reason: `score=${s.score} >= 7` });
      }
    } else if (s.score >= 4) {
      if (tokens <= remaining) {
        tiers.tier2.push(s);
        used.tier2 += tokens;
        remaining -= tokens;
        trajectory.push({ step: 3, action: "promote", tier: "tier2", uri: `cortex://references/${s.module_path || s.module_name}`, tokens, reason: `score=${s.score} 4-6` });
      }
    } else if (s.score > 0) {
      const l0 = Math.min(80, s.l0_tokens || 100);
      if (l0 <= remaining) {
        tiers.tier3_summaries.push(s.module_name);
        used.tier3_summaries += l0;
        remaining -= l0;
        trajectory.push({ step: 3, action: "l0_only", tier: "tier3", uri: `cortex://references/${s.module_path || s.module_name}`, tokens: l0, reason: `score=${s.score} 1-3, L0 only` });
      }
    }
  }
  return { tiers, used, remaining };
}

function buildManifest(args, scored, picked, index) {
  const meta = index._meta || {};
  const totalWindow = parseInt(args["llm-window"] || "128000", 10);
  const totalBudget = Math.floor(totalWindow * 0.4);
  const fixed = 3000 + 5000; // system + rules
  const available = Math.max(0, totalBudget - fixed);
  const used = picked.used.tier1 + picked.used.tier2 + picked.used.tier3_summaries;
  return {
    task_id: args["task-id"] || "ad-hoc",
    generated_at: new Date().toISOString(),
    budget: {
      total_window: totalWindow,
      total_available: totalBudget,
      fixed_overhead: fixed,
      available,
      used,
      utilization: (used / available).toFixed(4) + "%",
      within_limit: used <= available,
    },
    selected: {
      tier1: picked.tiers.tier1.map((s) => ({
        module: s.module_name,
        tokens: s.tokens,
        score: s.score,
        path: s.ref_path,
        uri: `cortex://references/${s.module_path || s.module_name}`,
      })),
      tier2: picked.tiers.tier2.map((s) => ({
        module: s.module_name,
        tokens: s.tokens,
        score: s.score,
        path: s.ref_path,
        uri: `cortex://references/${s.module_path || s.module_name}`,
      })),
      tier3_summaries: picked.tiers.tier3_summaries,
    },
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeTrajectory(taskId, trajectory, meta) {
  ensureDir(TRAJECTORY_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(TRAJECTORY_DIR, `${taskId || "ad-hoc"}_${ts}.jsonl`);
  const lines = [
    { event: "header", task_id: taskId || "ad-hoc", started_at: new Date().toISOString(), ...meta },
    ...trajectory.map((s, idx) => ({ event: "step", idx, ...s, ts: new Date().toISOString() })),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function contextItem(module, tier) {
  const rawPath = String(module.module_path || module.module_name || "unknown");
  const safePath = rawPath.split("/").filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => encodeURIComponent(segment)).join("/") || "unknown";
  const item = {
    uri: `cortex://references/${safePath}`,
  };
  if (tier) item.tier = tier;
  if (module.matched && module.matched.length) item.reason_codes = ["selector-match"];
  if (Number.isSafeInteger(module.tokens) && tier) item.estimated_tokens = module.tokens;
  return item;
}

function writeContextTrajectory(args, scored, picked, manifest) {
  ensureDir(CONTEXT_TRAJECTORY_DIR);
  const createdAt = new Date().toISOString();
  const selectedItems = [
    ...picked.tiers.tier1.map((item) => contextItem(item, "L2")),
    ...picked.tiers.tier2.map((item) => contextItem(item, "L2")),
    ...scored.filter((item) => picked.tiers.tier3_summaries.includes(item.module_name))
      .map((item) => ({ ...contextItem(item, "L0"), estimated_tokens: Math.min(80, item.l0_tokens || 100) })),
  ];
  const discoveredItems = scored.slice(0, 256).map((item) => contextItem(item));
  const trajectory = validateContextTrajectory({
    schema_version: "2.0",
    trajectory_id: `CTX-${args["task-id"] || "ad-hoc"}-${Date.now()}`,
    task_id: args["task-id"] || "ad-hoc",
    created_at: createdAt,
    stages: [
      { type: "discovered", status: "confirmed", source: "context-index", digest: digestMetadata(discoveredItems), items: discoveredItems },
      { type: "selected", status: "confirmed", source: "selector", digest: digestMetadata(selectedItems), items: selectedItems },
      { type: "rendered", status: "unavailable", source: "not-exposed", items: [] },
      { type: "confirmed-consumed", status: "unavailable", source: "not-exposed", items: [] },
    ],
    usage: {
      estimated_selected_tokens: manifest.budget.used,
      host_reported_input_tokens: "unknown",
      host_reported_cache_tokens: "unknown",
      measurement_source: "unavailable",
    },
    outcome_refs: [],
  });
  const file = path.join(CONTEXT_TRAJECTORY_DIR, `${args["task-id"] || "ad-hoc"}_${createdAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, `${JSON.stringify(trajectory, null, 2)}\n`);
  return file;
}

function main() {
  const args = parseArgs();
  const task = args.task || "";
  const index = readIndex();
  const { tokens, paths } = extractTaskTokens(task);

  const trajectory = [
    { step: 1, action: "scan", candidates: (index.modules || []).length, scanned_pool: "context-index.json" },
    { step: 2, action: "tokenize", task_tokens: tokens.length, path_hints: paths.length },
  ];

  const scored = (index.modules || []).map((m) => {
    const { score, matched, l0_hit, l1_hit } = scoreModule(m, tokens, paths);
    const l0t = m.l0_tokens || 100;
    const l1t = m.l1_tokens || 500;
    const l2t = m.estimated_tokens || m.l2_tokens || 1000;
    return {
      module_name: m.module || m.id || "unknown",
      module_path: m.module_path || null,
      ref_path: m.ref_path || null,
      has_l0: !!m.l0,
      has_l1: !!m.l1,
      l0_tokens: l0t,
      l1_tokens: l1t,
      l2_tokens: l2t,
      tokens: l2t,
      score,
      matched,
      l0_hit,
      l1_hit,
    };
  });

  trajectory.push({ step: 3, action: "score", scored: scored.length, top_score: Math.max(0, ...scored.map((s) => s.score)) });

  const totalWindow = parseInt(args["llm-window"] || "128000", 10);
  const totalBudget = Math.floor(totalWindow * 0.4);
  const fixed = 3000 + 5000;
  const available = Math.max(0, totalBudget - fixed);
  const picked = pick(scored, available, trajectory);

  const manifest = buildManifest(args, scored, picked, index);
  ensureDir(path.dirname(MANIFEST_PATH));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const trajFile = writeTrajectory(args["task-id"], trajectory, {
    scoring_strategy: "l0+l1+keyword",
    l0_l1_available: scored.filter((s) => s.has_l0 || s.has_l1).length,
  });
  const contextTrajectoryFile = writeContextTrajectory(args, scored, picked, manifest);

  console.log(JSON.stringify({
    ok: true,
    manifest_path: MANIFEST_PATH,
    trajectory_path: trajFile,
    context_trajectory_path: contextTrajectoryFile,
    budget: manifest.budget,
    tier1_count: picked.tiers.tier1.length,
    tier2_count: picked.tiers.tier2.length,
    tier3_count: picked.tiers.tier3_summaries.length,
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { scoreModule, extractTaskTokens, pick, buildManifest };
