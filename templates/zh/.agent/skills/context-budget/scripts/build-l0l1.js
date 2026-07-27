#!/usr/bin/env node
/**
 * build-l0l1 — Generate L0 abstract + L1 overview for `.agent/` artifacts.
 *
 * L0/L1 layered loading is inspired by OpenViking's context-database model:
 * every context entry is summarized into ~100 tokens (L0) and ~2k tokens (L1)
 * so retrieval can pre-filter without loading full content (L2).
 *
 * cortex-agent v1 implementation is **deterministic** — it produces L0/L1
 * from existing frontmatter, headings, and the first paragraph. No LLM call.
 * This keeps the build a zero-cost, on-commit step.
 *
 * Usage:
 *   node build-l0l1.js --file .agent/rules/core-principles.md
 *   node build-l0l1.js --all                            # scan all .agent/ md/json
 *   node build-l0l1.js --all --write                    # write .abstract.md + .overview.md
 *   node build-l0l1.js --all --write --inject-index     # also update context-index.json
 *
 * Output:
 *   JSON to stdout describing L0/L1 candidates + disk-write results.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const AGENT_ROOT = path.join(ROOT, ".agent");
const INDEX_FILE = path.join(AGENT_ROOT, "context-index.json");

const DEFAULT_SCOPES = ["rules", "workflows", "skills", "references", "decisions", "experiences", "resources/external"];
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "scripts", "fixtures"]);
const TARGET_EXT = new Set([".md", ".json"]);

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

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fm: {}, body: text };
  const out = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val;
  }
  return { fm: out, body: text.slice(match[0].length) };
}

function tokenize(text) {
  // Cheap token estimate: 1 token ≈ 4 chars (latin) or 1.5 chars (CJK).
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = text.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

function truncate(text, maxTokens) {
  const budget = maxTokens * 4; // approximate
  if (text.length <= budget) return text;
  return text.slice(0, budget).replace(/\s+\S*$/, "") + "…";
}

function headings(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, title: m[2].replace(/`/g, "").trim() });
  }
  return out;
}

function firstParagraphs(text, maxParagraphs) {
  const paragraphs = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (buf.trim()) {
        paragraphs.push(buf.trim());
        buf = "";
        if (paragraphs.length >= maxParagraphs) break;
      }
    } else if (line.startsWith("#")) {
      if (buf.trim()) {
        paragraphs.push(buf.trim());
        buf = "";
      }
      if (paragraphs.length >= maxParagraphs) break;
    } else {
      buf += line + "\n";
    }
  }
  if (buf.trim() && paragraphs.length < maxParagraphs) paragraphs.push(buf.trim());
  return paragraphs;
}

/**
 * Build L0 abstract. Target: <100 tokens.
 * Strategy: description frontmatter > first 40-50 words of body + section list.
 */
function buildL0(text, fm) {
  if (fm.description) return truncate(fm.description, 100);
  const first = firstParagraphs(text, 1)[0] || "";
  return truncate(first, 100);
}

/**
 * Build L1 overview. Target: <2000 tokens.
 * Strategy: first 2 paragraphs + heading outline + key entity names.
 */
function buildL1(text, fm) {
  const parts = [];
  if (fm.description) parts.push(fm.description + "\n");
  const sums = firstParagraphs(text, 2);
  if (sums.length) parts.push(sums.join("\n\n"));
  const hs = headings(text);
  if (hs.length) {
    parts.push("\n## 章节结构");
    for (const h of hs.slice(0, 12)) {
      parts.push(`- ${"#".repeat(h.level)} ${h.title}`);
    }
  }
  return truncate(parts.join("\n"), 2000);
}

function build(filePath) {
  const rel = path.relative(ROOT, filePath);
  const text = readText(filePath);
  const { fm, body } = parseFrontmatter(text);
  const l0 = buildL0(body, fm);
  const l1 = buildL1(body, fm);
  return {
    file: rel,
    l0_tokens: tokenize(l0),
    l1_tokens: tokenize(l1),
    l2_tokens: tokenize(text),
    l0: l0,
    l1: l1,
    fm: { name: fm.name || null, description: fm.description || null },
  };
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  function* inner(dir, depth) {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* inner(full, depth + 1);
      else if (TARGET_EXT.has(path.extname(entry.name))) yield full;
    }
  }
  yield* inner(target, 0);
}

function collectAll() {
  const found = [];
  for (const scope of DEFAULT_SCOPES) {
    const dir = path.join(AGENT_ROOT, scope);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) found.push(f);
  }
  return found;
}

function injectIntoIndex(entries) {
  if (!fs.existsSync(INDEX_FILE)) return { ok: false, reason: "context-index.json not found" };
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  const byPath = new Map();
  for (const m of index.modules || []) byPath.set(m.ref_path || m.path || m.module_path, m);
  let updated = 0;
  for (const e of entries) {
    // Try to match by ref_path / path / module_path containing the file basename
    const base = path.basename(e.file, path.extname(e.file));
    for (const [key, mod] of byPath.entries()) {
      if (!key) continue;
      if (key === e.file || key.endsWith(base + ".md") || (mod.module_path && e.file.includes(mod.module_path))) {
        mod.l0 = e.l0;
        mod.l1 = e.l1;
        mod.l0_tokens = e.l0_tokens;
        mod.l1_tokens = e.l1_tokens;
        mod.l2_tokens = e.l2_tokens;
        updated++;
      }
    }
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n");
  return { ok: true, updated };
}

function main() {
  const args = parseArgs();
  let targets = [];
  if (args.file) {
    targets = [path.isAbsolute(args.file) ? args.file : path.join(ROOT, args.file)];
  } else if (args.all) {
    targets = collectAll();
  } else {
    console.log(JSON.stringify({ ok: false, error: "specify --file or --all" }, null, 2));
    return;
  }
  const entries = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    entries.push(build(t));
  }
  const writes = [];
  if (args.write) {
    for (const e of entries) {
      const dir = path.dirname(path.join(ROOT, e.file));
      const abstractPath = path.join(dir, ".abstract.md");
      const overviewPath = path.join(dir, ".overview.md");
      try {
        fs.writeFileSync(abstractPath, `# L0 abstract — ${e.file}\n\n${e.l0}\n`);
        fs.writeFileSync(overviewPath, `# L1 overview — ${e.file}\n\n${e.l1}\n`);
        writes.push({ file: e.file, abstract: true, overview: true });
      } catch (err) {
        writes.push({ file: e.file, error: err.message });
      }
    }
  }
  let indexUpdate = null;
  if (args["inject-index"]) {
    indexUpdate = injectIntoIndex(entries);
  }
  console.log(JSON.stringify({
    ok: true,
    count: entries.length,
    total_l0_tokens: entries.reduce((s, e) => s + e.l0_tokens, 0),
    total_l1_tokens: entries.reduce((s, e) => s + e.l1_tokens, 0),
    total_l2_tokens: entries.reduce((s, e) => s + e.l2_tokens, 0),
    writes: writes.length || undefined,
    index_update: indexUpdate,
    entries: args.all ? undefined : entries,
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { build, buildL0, buildL1, tokenize };
