#!/usr/bin/env node
"use strict";

// ─── link-rename (L1 knowledge-retrieval) ─────────────────────────────────────
// Rename-tracking for [[wikilinks]]: when a note is renamed/moved, rewrite every
// [[oldName]] reference across .agent/**/*.md to [[newName]], preserving |alias
// and #anchor. This upgrades knowledge-lint from "detect dead links" to
// "auto-repair dead links" — mirroring Obsidian's automatic backlink update.
//
// Zero dependency. Safe: only edits inside [[...]] whose target matches oldName;
// never touches other prose. Idempotent: no references → no-op.
//
// Usage:
//   node link-rename.js --from "Old Name" --to "New Name" [--dry-run] [--root DIR]
//   (accepts note names OR paths like folder/old.md — basename is used)

const fs = require("fs");
const path = require("path");
const wl = require("./wikilink-index.js");

function parseArgs(argv) {
  const args = { root: process.cwd(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && argv[i + 1]) args.from = argv[++i];
    else if (argv[i] === "--to" && argv[i + 1]) args.to = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--root" && argv[i + 1]) args.root = argv[++i];
  }
  return args;
}

// Display form of the new target: basename without .md (keeps original casing).
function displayName(raw) {
  let t = String(raw).trim().split("/").pop();
  return t.replace(/\.md$/i, "");
}

// Rewrite a single [[...]] token if its normalized target === fromSlug.
// Preserves the alias (|...) and anchor (#...) segments; swaps only the target.
function rewriteToken(inner, fromSlug, newDisplay) {
  let target = inner;
  let alias = "";
  let anchor = "";
  const pipe = target.indexOf("|");
  if (pipe !== -1) { alias = target.slice(pipe); target = target.slice(0, pipe); }
  const hash = target.indexOf("#");
  if (hash !== -1) { anchor = target.slice(hash); target = target.slice(0, hash); }
  if (wl.normalizeTarget(target) !== fromSlug) return null; // not a match
  return `${newDisplay}${anchor}${alias}`;
}

function rewriteText(text, fromSlug, newDisplay) {
  let count = 0;
  const out = text.replace(/(!?)\[\[([^\]]+)\]\]/g, (full, bang, inner) => {
    const rebuilt = rewriteToken(inner, fromSlug, newDisplay);
    if (rebuilt === null) return full;
    count++;
    return `${bang}[[${rebuilt}]]`;
  });
  return { text: out, count };
}

function renameLinks({ root, from, to, dryRun }) {
  const fromSlug = wl.normalizeTarget(from);
  const newDisplay = displayName(to);
  const files = wl.collectMarkdown(root);
  const changes = [];
  let totalRefs = 0;

  for (const abs of files) {
    let text;
    try { text = fs.readFileSync(abs, "utf8"); } catch { continue; }
    const { text: updated, count } = rewriteText(text, fromSlug, newDisplay);
    if (count === 0) continue;
    totalRefs += count;
    changes.push({ file: path.relative(root, abs), rewrites: count });
    if (!dryRun) {
      try { fs.writeFileSync(abs, updated, "utf8"); }
      catch (e) { changes[changes.length - 1].error = e.message; }
    }
  }

  return {
    from,
    to,
    from_slug: fromSlug,
    new_display: newDisplay,
    dry_run: dryRun,
    files_changed: changes.length,
    total_rewrites: totalRefs,
    changes,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    console.error("Usage: node link-rename.js --from \"Old Name\" --to \"New Name\" [--dry-run]");
    process.exit(2);
  }
  const result = renameLinks(args);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

module.exports = { rewriteToken, rewriteText, renameLinks, displayName };
