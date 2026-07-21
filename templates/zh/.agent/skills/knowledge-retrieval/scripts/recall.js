#!/usr/bin/env node
"use strict";

// ─── recall (L1 knowledge-retrieval — unified aggregator) ─────────────────────
// A single entry point over the project's programmatic retrievers. It does NOT
// replace them (knowledge-recall / experience-recall stay independently usable);
// it routes by intent, calls the programmatic sources, augments ranking with the
// wikilink backlink signal, then fuses + reranks into one result set.
//
// Design constraints (see proposal §3.7):
//   - graphify query is NOT included as a result stream (LLM/instruction-based,
//     not programmatically callable). Its structural role is served by the
//     wikilink backlink centrality signal.
//   - Zero dependency: require() the sources in-process; no spawn, no service.
//   - Pure aggregation: never mutates source scoring internals.
//
// Usage:
//   node recall.js --query "..." [--intent auto|lexical|lesson] [--tags a,b] [--files x] [--limit N] [--root DIR]

const fs = require("fs");
const path = require("path");
const kr = require("./knowledge-recall.js");
const er = require("../../experience-recall/scripts/index.js");

const DEFAULT_LIMIT = 8;
// Source weights per intent. Applied to each source's own normalized score.
const INTENT_WEIGHTS = {
  auto:    { knowledge: 1.0, experience: 1.0 },
  lexical: { knowledge: 1.0, experience: 0.4 },
  lesson:  { knowledge: 0.5, experience: 1.0 },
};
const LINK_LAMBDA = 0.15; // weight of wikilink backlink centrality bonus

function parseArgs(argv) {
  const args = { root: process.cwd(), intent: "auto", limit: DEFAULT_LIMIT, query: "", tags: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--query" && argv[i + 1]) args.query = argv[++i];
    else if (argv[i] === "--intent" && argv[i + 1]) args.intent = argv[++i];
    else if (argv[i] === "--tags" && argv[i + 1]) args.tags = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--files" && argv[i + 1]) args.files = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--limit" && argv[i + 1]) args.limit = parseInt(argv[++i], 10) || DEFAULT_LIMIT;
    else if (argv[i] === "--root" && argv[i + 1]) args.root = argv[++i];
  }
  return args;
}

// Auto intent detection: presence of tags/files or lesson-ish keywords → lesson.
function resolveIntent(args) {
  if (args.intent && args.intent !== "auto") return args.intent;
  const lessonHint = /踩坑|曾经|类似|教训|回归|lesson|pitfall|regress|before|previously/i;
  if (args.tags.length || args.files.length || lessonHint.test(args.query)) return "lesson";
  return "lexical";
}

function normalizeId(id) {
  return String(id).replace(/\.(md|json)$/i, "").toLowerCase();
}

function loadBacklinkCounts(root) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(root, ".agent", "metrics", "wikilink-index.json"), "utf8"));
    const counts = {};
    let max = 0;
    for (const [tgt, srcs] of Object.entries(idx.backward || {})) { counts[tgt] = srcs.length; if (srcs.length > max) max = srcs.length; }
    return { counts, max };
  } catch { return { counts: {}, max: 0 }; }
}

function recall(args) {
  const intent = resolveIntent(args);
  const weights = INTENT_WEIGHTS[intent] || INTENT_WEIGHTS.auto;
  const merged = new Map(); // normalizedId → fused record

  const upsert = (id, store, sourceName, sourceScore, weight, extra) => {
    const key = normalizeId(id);
    const weighted = sourceScore * weight;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { id, store, score: weighted, source_recallers: [sourceName], signals: { [sourceName]: Number(sourceScore.toFixed(4)) }, ...extra });
    } else {
      existing.score = Math.max(existing.score, weighted); // fuse: take strongest weighted hit
      if (!existing.source_recallers.includes(sourceName)) existing.source_recallers.push(sourceName);
      existing.signals[sourceName] = Number(sourceScore.toFixed(4));
    }
  };

  // Source 1: knowledge-recall (cross-store BM25).
  const krRes = kr.recall({ root: args.root, stores: ["memory", "experiences", "references", "decisions"], query: args.query, limit: args.limit * 2 });
  for (const r of krRes.results || []) {
    upsert(r.id, r.store, "knowledge", r.score, weights.knowledge, { path: r.path });
  }

  // Source 2: experience-recall (experiences Jaccard+kw+files).
  const erRes = er.recallExperiences(args.root, { tags: args.tags, files: args.files, query: args.query });
  for (const e of erRes.scored || []) {
    upsert(e.id, "experiences", "experience", e.relevance, weights.experience, { path: e.path, key_lesson: e.key_lesson, severity: e.severity });
  }

  // Structural augmentation: wikilink backlink centrality bonus.
  const { counts, max } = loadBacklinkCounts(args.root);
  if (max > 0) {
    for (const rec of merged.values()) {
      const c = counts[normalizeId(rec.id)] || 0;
      if (c > 0) { rec.score += LINK_LAMBDA * (c / max); rec.signals.linkCentrality = Number((c / max).toFixed(3)); }
    }
  }

  const results = [...merged.values()]
    .map((r) => ({ ...r, score: Number(r.score.toFixed(4)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit);

  const warnings = erRes.warnings || [];
  return { query: args.query, intent, sources: ["knowledge", "experience"], total_candidates: merged.size, results, warnings };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query && !args.tags.length && !args.files.length) {
    console.error("Usage: node recall.js --query \"...\" [--intent auto|lexical|lesson] [--tags a,b] [--files x] [--limit N]");
    process.exit(2);
  }
  const result = recall(args);
  const dir = path.join(args.root, ".agent", "metrics");
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "recall-result.json"), `${JSON.stringify(result, null, 2)}\n`); } catch { /* best effort */ }
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { recall, resolveIntent, normalizeId, parseArgs };
