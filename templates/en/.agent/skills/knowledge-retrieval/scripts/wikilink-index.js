#!/usr/bin/env node
"use strict";

// ─── wikilink-index (L1 knowledge-retrieval) ──────────────────────────────────
// Scan .agent/**/*.md, parse [[wikilink]] references, and build a bidirectional
// link index. Provides the reverse-lookup primitive ("who links to X?") that
// graphify (forward code topology only) does not offer — mirroring Obsidian
// CLI's `obsidian backlinks file=X`.
//
// Zero dependency: fs + path only. Pure, rebuildable derived artifact.
//
// Usage:
//   node wikilink-index.js                       # build index → metrics/wikilink-index.json
//   node wikilink-index.js --backlinks <note>    # print who links to <note>
//   node wikilink-index.js --root <dir>          # override scan root (for tests)
//   node wikilink-index.js --json                # print full index as JSON

const fs = require("fs");
const path = require("path");

// Directories under .agent/ that hold runtime products, not authored knowledge.
const EXCLUDED_DIRS = new Set(["metrics", "archive", "node_modules", ".git", "runs", "sessions", "queues"]);

// Match [[Target]], [[Target|Alias]], [[Target#Heading]], [[Target#^block]], ![[embed]].
const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;

function parseArgs(argv) {
  const args = { root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--backlinks" && argv[i + 1]) { args.backlinks = argv[++i]; }
    else if (argv[i] === "--root" && argv[i + 1]) { args.root = argv[++i]; }
    else if (argv[i] === "--json") { args.json = true; }
  }
  return args;
}

// Normalize a wikilink target or note name to a comparable slug:
// strip embed !, drop #heading / #^block anchor, drop |alias, lowercase, trim.
function normalizeTarget(raw) {
  let t = String(raw).trim();
  const pipe = t.indexOf("|");
  if (pipe !== -1) t = t.slice(0, pipe);      // drop alias
  const hash = t.indexOf("#");
  if (hash !== -1) t = t.slice(0, hash);       // drop anchor
  t = t.trim();
  // If it's a path, take the basename without extension.
  t = t.split("/").pop();
  t = t.replace(/\.md$/i, "");
  return t.toLowerCase().trim();
}

// Slug for a file on disk: basename without .md, lowercased.
function fileSlug(absPath) {
  return path.basename(absPath).replace(/\.md$/i, "").toLowerCase();
}

function collectMarkdown(root) {
  const agentDir = path.join(root, ".agent");
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(agentDir);
  return files;
}

function extractLinks(text) {
  const targets = [];
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const slug = normalizeTarget(m[1]);
    if (slug) targets.push(slug);
  }
  return targets;
}

function buildIndex(root) {
  const files = collectMarkdown(root);
  const knownSlugs = new Set(files.map(fileSlug));
  const forward = {};
  const backward = {};
  const unresolved = [];

  for (const abs of files) {
    const src = fileSlug(abs);
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const targets = [...new Set(extractLinks(text))].filter((t) => t !== src);
    if (!targets.length) continue;
    forward[src] = targets;
    for (const tgt of targets) {
      (backward[tgt] = backward[tgt] || []).push(src);
      if (!knownSlugs.has(tgt)) unresolved.push({ from: src, target: tgt });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    scanned_files: files.length,
    forward,
    backward,
    unresolved,
  };
}

function writeIndex(root, index) {
  const dir = path.join(root, ".agent", "metrics");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wikilink-index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function backlinksOf(index, note) {
  const slug = normalizeTarget(note);
  return index.backward[slug] || [];
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const index = buildIndex(args.root);

  if (args.backlinks) {
    const hits = backlinksOf(index, args.backlinks);
    console.log(JSON.stringify({ note: args.backlinks, backlinks: hits, count: hits.length }, null, 2));
    process.exit(0);
  }

  writeIndex(args.root, index);
  if (args.json) {
    console.log(JSON.stringify(index, null, 2));
  } else {
    console.log(JSON.stringify({
      generated_at: index.generated_at,
      scanned_files: index.scanned_files,
      linked_notes: Object.keys(index.forward).length,
      backlink_targets: Object.keys(index.backward).length,
      unresolved: index.unresolved.length,
    }, null, 2));
  }
}

module.exports = { normalizeTarget, fileSlug, extractLinks, buildIndex, backlinksOf, collectMarkdown };
