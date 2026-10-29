"use strict";

// dedup-refs.js — 引用级精确内容去重（提案 C1 / 消除 B4）
//
// 对候选引用正文（优先 l1，回退 l2 → l0）做精确 SHA-256 内容 hash。
// 相同 hash 的引用只注入一次（canonical block），其余处用
// 「(see #ref-<hash8>)」引用，消解 core-principles / core-principles-v2
// 这类重复注入，以及 agent-config L1 内嵌 core-principles 的冗余。
//
// 仅做「精确」hash 去重，不做模糊合并（避免误并不同内容，见提案 §7 风险表）。
//
// 用法：
//   node dedup-refs.js --index .agent/context-index.json [--dry-run] [--emit-canonical]
//   node dedup-refs.js --refs "uriA:pathA,uriB:pathB" [--dry-run]
//
// 输入（--index 模式）：context-index.json 的 resources 数组，每项含
//   { uri, ref_path, l0, l1, l2_tokens, ... }。去重键为 l1 正文（缺失则 l2/l0）。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function hashOf(text) {
  return crypto.createHash("sha256").update(text || "", "utf8").digest("hex");
}

function shortHash(hex) {
  return hex.slice(0, 8);
}

// 取去重所用正文：l1 优先，回退 l2（字符串）→ l0。
function contentKey(entry) {
  if (entry.l1 && String(entry.l1).trim()) return String(entry.l1);
  if (typeof entry.l2 === "string" && entry.l2.trim()) return entry.l2;
  if (entry.l0 && String(entry.l0).trim()) return String(entry.l0);
  return null;
}

// 对一组引用条目做去重。
// 返回 { canonical: [{hash, ref, uris, tokens}], refs: [{uri, hash8, canonical:boolean}] }
function dedup(entries) {
  const byHash = new Map();
  const refs = [];
  for (const e of entries) {
    const text = contentKey(e);
    if (text == null) {
      refs.push({ uri: e.uri, hash8: null, canonical: true, reason: "no-content" });
      continue;
    }
    const h = hashOf(text);
    const h8 = shortHash(h);
    if (!byHash.has(h)) {
      byHash.set(h, { hash: h, hash8: h8, uris: [], tokens: e.l1_tokens || e.l2_tokens || e.l0_tokens || 0 });
    }
    byHash.get(h).uris.push(e.uri);
    refs.push({ uri: e.uri, hash8: h8, canonical: byHash.get(h).uris.length === 1 });
  }
  const canonical = Array.from(byHash.values()).map((c) => ({
    hash: c.hash,
    ref: `#ref-${c.hash8}`,
    uris: c.uris,
    tokens: c.tokens,
    duplicated: c.uris.length > 1,
  }));
  return { canonical, refs };
}

function loadEntriesFromIndex(indexFile, options) {
  const abs = path.resolve(process.cwd(), indexFile);
  const data = JSON.parse(fs.readFileSync(abs, "utf8"));
  const resources = data.modules || data.resources || [];
  const filter = options && options.uriFilter;
  const list = filter ? resources.filter((r) => filter.includes(r.uri)) : resources;
  return list;
}

function loadEntriesFromRefs(refsArg) {
  return refsArg.split(",").map((pair) => {
    const [uri, refPath] = pair.split(":").map((s) => s.trim());
    let text = "";
    try { text = fs.readFileSync(path.resolve(process.cwd(), refPath), "utf8"); } catch (e) { text = ""; }
    return { uri, ref_path: refPath, l1: text };
  });
}

function emitCanonical(outFile, canonical) {
  const dir = path.dirname(outFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = { schema_version: "1.0", canonical };
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const item = process.argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = process.argv[i + 1];
    if (!next || next.startsWith("--")) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }

  let entries;
  if (args.index) entries = loadEntriesFromIndex(args.index, { uriFilter: args.uris ? args.uris.split(",") : null });
  else if (args.refs) entries = loadEntriesFromRefs(args.refs);
  else { console.error("Usage: dedup-refs.js --index <context-index.json> [--uris u1,u2] [--dry-run] [--emit-canonical]"); process.exit(1); }

  const result = dedup(entries);
  const duplicateGroups = result.canonical.filter((c) => c.duplicated);
  const savedTokens = duplicateGroups.reduce((sum, g) => sum + g.tokens * (g.uris.length - 1), 0);

  const report = {
    ok: true,
    total_refs: result.refs.length,
    canonical_blocks: result.canonical.length,
    duplicate_groups: duplicateGroups.length,
    estimated_saved_tokens: savedTokens,
    duplicates: duplicateGroups.map((g) => ({ ref: g.ref, uris: g.uris, tokens: g.tokens })),
    dry_run: Boolean(args["dry-run"]),
  };

  if (args["emit-canonical"] && !args["dry-run"]) {
    const out = args.out || path.join(process.cwd(), ".agent", "skills", "context-budget", "canonical-refs.json");
    emitCanonical(out, result.canonical);
    report.canonical_file = path.relative(process.cwd(), out);
  }

  if (args["dry-run"]) {
    // dry-run 仅输出统计，不写文件。
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(JSON.stringify(report, null, 2));
}

module.exports = { hashOf, shortHash, contentKey, dedup, loadEntriesFromIndex };

if (require.main === module) main();
