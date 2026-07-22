#!/usr/bin/env node
"use strict";

// ─── knowledge-recall (L1 knowledge-retrieval) ────────────────────────────────
// Cross-store hybrid lexical retrieval over the .agent/ knowledge bases.
// Generalizes experience-recall (experiences-only Jaccard) into a BM25 + keyword
// + link-centrality + tag scorer spanning memory / experiences / references /
// decisions — mirroring Obsidian CLI `obsidian search query=...` but over every
// store at once. Zero dependency (fs/path only); no embeddings on the core path.
//
// Usage:
//   node knowledge-recall.js --query "…" [--stores memory,experiences] [--limit 5] [--root DIR]

const fs = require("fs");
const path = require("path");

const STORE_DIRS = {
  memory: { dir: ["memory"], ext: ".md" },
  experiences: { dir: ["experiences"], ext: ".md" },
  references: { dir: ["references"], ext: ".md" },
  decisions: { dir: ["decisions"], ext: ".json" },
};
const DEFAULT_STORES = ["memory", "experiences", "references", "decisions"];
const WEIGHTS = { bm25: 0.5, kw: 0.2, link: 0.15, tag: 0.15 };
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const MIN_SCORE = 0.01;
const MAX_RESULTS = 5;

function parseArgs(argv) {
  const args = { root: process.cwd(), stores: DEFAULT_STORES, limit: MAX_RESULTS, query: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--query" && argv[i + 1]) args.query = argv[++i];
    else if (argv[i] === "--stores" && argv[i + 1]) args.stores = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--limit" && argv[i + 1]) args.limit = parseInt(argv[++i], 10) || MAX_RESULTS;
    else if (argv[i] === "--root" && argv[i + 1]) args.root = argv[++i];
  }
  return args;
}

function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9一-龥]+/gi) || [];
}

function walkFiles(dir, ext) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "_archive") continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && abs.endsWith(ext)) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

// Extract searchable text + tags from a store document.
function loadDoc(abs, store) {
  let raw;
  try { raw = fs.readFileSync(abs, "utf8"); } catch { return null; }
  let text = raw;
  let tags = [];

  if (abs.endsWith(".json")) {
    // decisions/*.json — index summary-ish fields, not the whole blob.
    try {
      const j = JSON.parse(raw);
      text = [j.summary, j.rationale, j.gate_action, j.type, j.decision_id, j.resource_ref]
        .filter(Boolean).join(" ");
      tags = Array.isArray(j.tags) ? j.tags : [];
    } catch { return null; }
  } else {
    // markdown — pull frontmatter tags if present.
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const tagLine = fm[1].match(/tags:\s*\[([^\]]*)\]/) || fm[1].match(/tags:\s*(.+)/);
      if (tagLine) tags = tagLine[1].split(/[,\s]+/).map((t) => t.replace(/['"]/g, "").trim()).filter(Boolean);
    }
  }
  return {
    id: path.basename(abs),
    store,
    path: abs,
    text,
    tags,
    tokens: tokenize(text),
  };
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const uni = new Set([...sa, ...sb]).size;
  return uni ? inter / uni : 0;
}

function keywordCoverage(queryTokens, docTokens) {
  if (!queryTokens.length) return 0;
  const set = new Set(docTokens);
  const hit = queryTokens.filter((q) => set.has(q)).length;
  return hit / queryTokens.length;
}

// Build BM25 stats across the corpus, then score each doc for the query.
function bm25Scores(queryTokens, docs) {
  const N = docs.length;
  const df = {};
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df[t] = (df[t] || 0) + 1;
  }
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / (N || 1);
  const idf = (t) => Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));

  return docs.map((d) => {
    const tf = {};
    for (const t of d.tokens) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const q of new Set(queryTokens)) {
      const f = tf[q] || 0;
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (d.tokens.length / (avgLen || 1)));
      score += idf(q) * ((f * (BM25_K1 + 1)) / denom);
    }
    return score;
  });
}

function normalize(arr) {
  const max = Math.max(0, ...arr);
  return max > 0 ? arr.map((x) => x / max) : arr.map(() => 0);
}

function loadBacklinkCounts(root) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(root, ".agent", "metrics", "wikilink-index.json"), "utf8"));
    const counts = {};
    for (const [tgt, srcs] of Object.entries(idx.backward || {})) counts[tgt] = srcs.length;
    return counts;
  } catch { return {}; }
}

function recall({ root, stores, query, limit }) {
  const queryTokens = tokenize(query);
  const queryTags = queryTokens; // tags matched against query terms
  const docs = [];
  for (const store of stores) {
    const cfg = STORE_DIRS[store];
    if (!cfg) continue;
    const base = path.join(root, ".agent", ...cfg.dir);
    for (const abs of walkFiles(base, cfg.ext)) {
      const doc = loadDoc(abs, store);
      if (doc && doc.tokens.length) docs.push(doc);
    }
  }
  if (!docs.length) return { query, results: [], total_docs: 0 };

  const backlinkCounts = loadBacklinkCounts(root);
  const rawBm25 = bm25Scores(queryTokens, docs);
  const bm25 = normalize(rawBm25);
  const rawLink = docs.map((d) => backlinkCounts[d.id.replace(/\.md$/i, "").toLowerCase()] || 0);
  const link = normalize(rawLink);

  const scored = docs.map((d, i) => {
    const kw = keywordCoverage(queryTokens, d.tokens);
    const tag = jaccard(queryTags, d.tags);
    const score = WEIGHTS.bm25 * bm25[i] + WEIGHTS.kw * kw + WEIGHTS.link * link[i] + WEIGHTS.tag * tag;
    return { id: d.id, store: d.store, path: path.relative(root, d.path), score: Number(score.toFixed(4)), signals: { bm25: Number(bm25[i].toFixed(3)), kw: Number(kw.toFixed(3)), link: Number(link[i].toFixed(3)), tag: Number(tag.toFixed(3)) } };
  }).filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { query, total_docs: docs.length, results: scored };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error("Usage: node knowledge-recall.js --query \"...\" [--stores a,b] [--limit N]");
    process.exit(2);
  }
  const result = recall(args);
  const dir = path.join(args.root, ".agent", "metrics");
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "knowledge-recall-result.json"), `${JSON.stringify(result, null, 2)}\n`); } catch { /* best effort */ }
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { tokenize, bm25Scores, keywordCoverage, jaccard, recall, loadDoc };
