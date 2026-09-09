#!/usr/bin/env node
"use strict";

// Unified knowledge/experience recall with an optional metadata-only relevance precheck.
// The precheck never reads document bodies: it consumes a generated metadata index only.

const fs = require("fs");
const path = require("path");
const kr = require("./knowledge-recall.js");
const er = require("../../experience-recall/scripts/index.js");
const trajectory = require("../../retrieval-trajectory/scripts/record.js");

const DEFAULT_LIMIT = 8;
const METADATA_RELATIVE_PATH = path.join(".agent", "metrics", "recall-metadata.json");
const INTENT_WEIGHTS = {
  auto: { knowledge: 1.0, experience: 1.0 },
  lexical: { knowledge: 1.0, experience: 0.4 },
  lesson: { knowledge: 0.5, experience: 1.0 },
};
const LINK_LAMBDA = 0.15;

function parseArgs(argv) {
  const args = { root: process.cwd(), intent: "auto", limit: DEFAULT_LIMIT, query: "", tags: [], files: [], check: false, metadataFile: "", taskId: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--query" && argv[i + 1]) args.query = argv[++i];
    else if (argv[i] === "--intent" && argv[i + 1]) args.intent = argv[++i];
    else if (argv[i] === "--tags" && argv[i + 1]) args.tags = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--files" && argv[i + 1]) args.files = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--limit" && argv[i + 1]) args.limit = parseInt(argv[++i], 10) || DEFAULT_LIMIT;
    else if (argv[i] === "--root" && argv[i + 1]) args.root = argv[++i];
    else if (argv[i] === "--check") args.check = true;
    else if (argv[i] === "--build-metadata-index") args.buildMetadataIndex = true;
    else if (argv[i] === "--metadata-file" && argv[i + 1]) args.metadataFile = argv[++i];
    else if (argv[i] === "--task-id" && argv[i + 1]) args.taskId = argv[++i];
  }
  return args;
}

function resolveIntent(args) {
  if (args.intent && args.intent !== "auto") return args.intent;
  const lessonHint = /踩坑|曾经|类似|教训|回归|lesson|pitfall|regress|before|previously/i;
  if (args.tags.length || args.files.length || lessonHint.test(args.query)) return "lesson";
  return "lexical";
}

function normalizeId(id) { return String(id).replace(/\.(md|json)$/i, "").toLowerCase(); }
function tokenize(value) { return String(value || "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean); }

function frontmatterMetadata(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split("\n")) {
    const found = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (found) fields[found[1]] = found[2].replace(/^['"]|['"]$/g, "");
  }
  return fields;
}

function collectMetadataFiles(root, relative = "") {
  const absolute = path.join(root, ".agent", relative);
  if (!fs.existsSync(absolute)) return [];
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  const ignored = new Set(["metrics", "runtime-evidence", "runtime-continuity", "archive", "archives"]);
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) files.push(...collectMetadataFiles(root, child));
    } else if (entry.isFile() && /\.(md|json)$/i.test(entry.name)) files.push(child);
  }
  return files;
}

function buildMetadataIndex(root) {
  const prefixes = ["memory", "experiences", "references", "decisions"];
  const documents = [];
  for (const prefix of prefixes) {
    for (const sourcePath of collectMetadataFiles(root, prefix)) {
      const absolute = path.join(root, ".agent", sourcePath);
      const base = path.basename(sourcePath).replace(/\.(md|json)$/i, "");
      let metadata = {};
      try {
        if (sourcePath.endsWith(".md")) metadata = frontmatterMetadata(fs.readFileSync(absolute, "utf8").slice(0, 16_384));
        else { const value = JSON.parse(fs.readFileSync(absolute, "utf8")); metadata = { title: value.title || value.summary || value.decision_id, tags: Array.isArray(value.tags) ? value.tags.join(",") : "", projects: Array.isArray(value.projects) ? value.projects.join(",") : "", updated_at: value.updated_at || value.created_at }; }
      } catch { continue; }
      documents.push({ doc_id: metadata.id || metadata.decision_id || base, title: metadata.title || base, tags: String(metadata.tags || "").split(",").map((x) => x.trim()).filter(Boolean), source_path: sourcePath, project_ids: String(metadata.projects || metadata.project_ids || "").split(",").map((x) => x.trim()).filter(Boolean), updated_at: metadata.updated_at || new Date(fs.statSync(absolute).mtimeMs).toISOString() });
    }
  }
  const file = path.join(root, METADATA_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ documents }, null, 2) + "\n");
  return { metadata_file: file, documents: documents.length };
}

function loadBacklinkCounts(root) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(root, ".agent", "metrics", "wikilink-index.json"), "utf8"));
    const counts = {}; let max = 0;
    for (const [tgt, srcs] of Object.entries(idx.backward || {})) { counts[tgt] = srcs.length; if (srcs.length > max) max = srcs.length; }
    return { counts, max };
  } catch { return { counts: {}, max: 0 }; }
}

function normalizeMetadataIndex(raw) {
  const docs = Array.isArray(raw) ? raw : raw && raw.documents;
  if (!Array.isArray(docs) || docs.length === 0) return null;
  const normalized = [];
  const allowedKeys = new Set(["doc_id", "title", "tags", "source_path", "project_ids", "updated_at"]);
  for (const doc of docs) {
    if (!doc || typeof doc !== "object" || Object.keys(doc).some((key) => !allowedKeys.has(key)) || typeof doc.doc_id !== "string" || typeof doc.title !== "string" || typeof doc.source_path !== "string" || !Array.isArray(doc.tags) || !Array.isArray(doc.project_ids) || Number.isNaN(Date.parse(doc.updated_at))) return null;
    normalized.push({ doc_id: doc.doc_id, title: doc.title, tags: doc.tags.filter((x) => typeof x === "string"), source_path: doc.source_path, project_ids: doc.project_ids.filter((x) => typeof x === "string"), updated_at: doc.updated_at });
  }
  return normalized;
}

function loadMetadataIndex(args) {
  const file = args.metadataFile || path.join(args.root, METADATA_RELATIVE_PATH);
  try {
    const docs = normalizeMetadataIndex(JSON.parse(fs.readFileSync(file, "utf8")));
    return docs ? { ok: true, file, docs } : { ok: false, file, reason: "invalid_or_empty_metadata" };
  } catch (error) {
    return { ok: false, file, reason: error && error.code === "ENOENT" ? "metadata_not_found" : "metadata_unreadable" };
  }
}

function checkRecall(args) {
  const index = loadMetadataIndex(args);
  if (!index.ok) return { mode: "check", status: "CHECK_UNAVAILABLE", reason: index.reason, metadata_file: index.file, results: [] };
  const queryTokens = tokenize(args.query);
  if (!queryTokens.length) return { mode: "check", status: "CHECK_UNAVAILABLE", reason: "empty_query", metadata_file: index.file, results: [] };
  const results = index.docs.map((doc) => {
    const fields = tokenize([doc.title, doc.source_path, ...doc.tags, ...doc.project_ids].join(" "));
    const matched = queryTokens.filter((token) => fields.includes(token));
    return { doc_id: doc.doc_id, title: doc.title, source_path: doc.source_path, tags: doc.tags, project_ids: doc.project_ids, updated_at: doc.updated_at, matched_terms: matched, score: Number((matched.length / queryTokens.length).toFixed(4)) };
  }).filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score || a.doc_id.localeCompare(b.doc_id)).slice(0, args.limit);
  return { mode: "check", status: results.length ? "RELEVANT" : "NOT_RELEVANT", metadata_file: index.file, total_candidates: index.docs.length, results };
}

function recordCheckTrajectory(args, result) {
  if (!args.taskId) return;
  try {
    trajectory.recordStep({ root: args.root, taskId: args.taskId, action: "scan", candidates: result.total_candidates || 0, reason: "metadata_only" });
    trajectory.recordStep({ root: args.root, taskId: args.taskId, action: "score", scored: result.results.length, top_score: result.results[0] ? result.results[0].score : 0, reason: "metadata_check:" + result.status });
  } catch { /* trajectory evidence is best effort and never changes check truthfulness */ }
}

function recall(args) {
  const intent = resolveIntent(args); const weights = INTENT_WEIGHTS[intent] || INTENT_WEIGHTS.auto; const merged = new Map();
  const upsert = (id, store, sourceName, sourceScore, weight, extra) => {
    const key = normalizeId(id); const weighted = sourceScore * weight; const existing = merged.get(key);
    if (!existing) merged.set(key, { id, store, score: weighted, source_recallers: [sourceName], signals: { [sourceName]: Number(sourceScore.toFixed(4)) }, ...extra });
    else { existing.score = Math.max(existing.score, weighted); if (!existing.source_recallers.includes(sourceName)) existing.source_recallers.push(sourceName); existing.signals[sourceName] = Number(sourceScore.toFixed(4)); }
  };
  const krRes = kr.recall({ root: args.root, stores: ["memory", "experiences", "references", "decisions"], query: args.query, limit: args.limit * 2 });
  for (const r of krRes.results || []) upsert(r.id, r.store, "knowledge", r.score, weights.knowledge, { path: r.path });
  const erRes = er.recallExperiences(args.root, { tags: args.tags, files: args.files, query: args.query });
  for (const e of erRes.scored || []) upsert(e.id, "experiences", "experience", e.relevance, weights.experience, { path: e.path, key_lesson: e.key_lesson, severity: e.severity });
  const { counts, max } = loadBacklinkCounts(args.root);
  if (max > 0) for (const rec of merged.values()) { const c = counts[normalizeId(rec.id)] || 0; if (c > 0) { rec.score += LINK_LAMBDA * (c / max); rec.signals.linkCentrality = Number((c / max).toFixed(3)); } }
  const results = [...merged.values()].map((r) => ({ ...r, score: Number(r.score.toFixed(4)) })).sort((a, b) => b.score - a.score).slice(0, args.limit);
  return { query: args.query, intent, sources: ["knowledge", "experience"], total_candidates: merged.size, results, warnings: erRes.warnings || [] };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.buildMetadataIndex) {
    console.log(JSON.stringify(buildMetadataIndex(args.root), null, 2));
  } else {
    if (!args.query && !args.tags.length && !args.files.length) { console.error("Usage: node recall.js --query \"...\" [--check] [--metadata-file FILE] [--task-id ID] [--intent auto|lexical|lesson] [--tags a,b] [--files x] [--limit N] | --build-metadata-index"); process.exit(2); }
    const result = args.check ? checkRecall(args) : recall(args);
    if (args.check) recordCheckTrajectory(args, result);
    const dir = path.join(args.root, ".agent", "metrics");
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, args.check ? "recall-check-result.json" : "recall-result.json"), JSON.stringify(result, null, 2) + "\n"); } catch { /* best effort */ }
    console.log(JSON.stringify(result, null, 2));
  }
}

module.exports = { recall, checkRecall, buildMetadataIndex, loadMetadataIndex, normalizeMetadataIndex, resolveIntent, normalizeId, parseArgs, tokenize };
