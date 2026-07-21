"use strict";

// Coverage for the L1 knowledge-retrieval scripts:
//   wikilink-index.js / knowledge-recall.js / link-rename.js
// Scripts live in .agent/skills/knowledge-retrieval/scripts/ (main repo working
// instance; also mirrored to templates/{zh,en}).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPTS = path.resolve(__dirname, "../.agent/skills/knowledge-retrieval/scripts");
const wl = require(path.join(SCRIPTS, "wikilink-index.js"));
const kr = require(path.join(SCRIPTS, "knowledge-recall.js"));
const lr = require(path.join(SCRIPTS, "link-rename.js"));

function makeVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-kr-"));
}

function writeNote(root, rel, body) {
  const abs = path.join(root, ".agent", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

// ─── wikilink-index ────────────────────────────────────────────────────────────

test("normalizeTarget strips alias, anchor, extension, path, lowercases", () => {
  assert.equal(wl.normalizeTarget("My Note"), "my note");
  assert.equal(wl.normalizeTarget("My Note|Alias"), "my note");
  assert.equal(wl.normalizeTarget("My Note#Heading"), "my note");
  assert.equal(wl.normalizeTarget("folder/My Note.md"), "my note");
  assert.equal(wl.normalizeTarget("Note#^block-id"), "note");
});

test("extractLinks finds all wikilink forms including embeds", () => {
  const text = "See [[Alpha]] and [[Beta|B]] and ![[Gamma]] and [[Delta#H]].";
  assert.deepEqual(wl.extractLinks(text).sort(), ["alpha", "beta", "delta", "gamma"]);
});

test("buildIndex produces forward + backward + unresolved", () => {
  const root = makeVault();
  writeNote(root, "notes/a.md", "links to [[B]] and [[C]]\n");
  writeNote(root, "notes/b.md", "# B\nno links\n");
  // C does not exist → unresolved
  const idx = wl.buildIndex(root);
  assert.deepEqual(idx.forward.a.sort(), ["b", "c"]);
  assert.deepEqual(idx.backward.b, ["a"]);
  assert.ok(idx.unresolved.some((u) => u.target === "c"));
});

test("backlinksOf returns who links to a note", () => {
  const root = makeVault();
  writeNote(root, "x.md", "[[Target]]\n");
  writeNote(root, "y.md", "also [[Target]]\n");
  writeNote(root, "target.md", "# Target\n");
  const idx = wl.buildIndex(root);
  assert.deepEqual(wl.backlinksOf(idx, "Target").sort(), ["x", "y"]);
});

test("buildIndex excludes metrics/archive runtime dirs", () => {
  const root = makeVault();
  writeNote(root, "real.md", "[[Target]]\n");
  writeNote(root, "metrics/noise.md", "[[ShouldBeIgnored]]\n");
  writeNote(root, "archive/old.md", "[[AlsoIgnored]]\n");
  const idx = wl.buildIndex(root);
  assert.ok(idx.forward.real);
  assert.ok(!idx.forward.noise);
  assert.ok(!idx.forward.old);
});

// ─── knowledge-recall ────────────────────────────────────────────────────────

test("tokenize lowercases and splits on non-word", () => {
  assert.deepEqual(kr.tokenize("Hello, World! foo-bar"), ["hello", "world", "foo", "bar"]);
});

test("recall ranks the most relevant doc first (BM25)", () => {
  const root = makeVault();
  writeNote(root, "memory/project/pnpm.md", "always use pnpm not npm for install\n");
  writeNote(root, "memory/project/other.md", "unrelated content about deployment\n");
  writeNote(root, "references/guide.md", "# Guide\ngeneric documentation\n");
  const res = kr.recall({ root, stores: ["memory", "references"], query: "pnpm install", limit: 5 });
  assert.ok(res.results.length >= 1);
  assert.equal(res.results[0].id, "pnpm.md");
  assert.ok(res.results[0].signals.bm25 > 0);
});

test("recall spans multiple stores", () => {
  const root = makeVault();
  writeNote(root, "memory/project/m.md", "webpack config bundling\n");
  writeNote(root, "experiences/EXP-001.md", "webpack build failure lesson\n");
  const res = kr.recall({ root, stores: ["memory", "experiences"], query: "webpack", limit: 5 });
  const stores = new Set(res.results.map((r) => r.store));
  assert.ok(stores.has("memory"));
  assert.ok(stores.has("experiences"));
});

test("recall reads tags from frontmatter and decisions json summary", () => {
  const root = makeVault();
  writeNote(root, "decisions/D-001.json", JSON.stringify({ decision_id: "D-001", summary: "approve caching layer", tags: ["cache"] }));
  const res = kr.recall({ root, stores: ["decisions"], query: "caching", limit: 5 });
  assert.equal(res.results[0].id, "D-001.json");
});

// ─── link-rename ───────────────────────────────────────────────────────────────

test("rewriteText swaps target, preserves alias and anchor", () => {
  const r1 = lr.rewriteText("see [[Old Name]] here", "old name", "New Name");
  assert.equal(r1.text, "see [[New Name]] here");
  assert.equal(r1.count, 1);

  const r2 = lr.rewriteText("[[Old Name|Display]] and [[Old Name#Sec]]", "old name", "New Name");
  assert.equal(r2.text, "[[New Name|Display]] and [[New Name#Sec]]");
  assert.equal(r2.count, 2);
});

test("rewriteText leaves non-matching links untouched", () => {
  const r = lr.rewriteText("[[Other]] and normal [[old name]] text", "unrelated", "X");
  assert.equal(r.count, 0);
  assert.ok(r.text.includes("[[Other]]"));
});

test("renameLinks dry-run reports without writing", () => {
  const root = makeVault();
  writeNote(root, "a.md", "ref [[Old]]\n");
  const res = lr.renameLinks({ root, from: "Old", to: "New", dryRun: true });
  assert.equal(res.total_rewrites, 1);
  assert.equal(res.files_changed, 1);
  assert.equal(fs.readFileSync(path.join(root, ".agent/a.md"), "utf8"), "ref [[Old]]\n"); // unchanged
});

test("renameLinks applies rewrite across all referrers", () => {
  const root = makeVault();
  writeNote(root, "a.md", "[[Old]]\n");
  writeNote(root, "b.md", "also [[Old|alias]]\n");
  const res = lr.renameLinks({ root, from: "Old", to: "New", dryRun: false });
  assert.equal(res.files_changed, 2);
  assert.equal(fs.readFileSync(path.join(root, ".agent/a.md"), "utf8"), "[[New]]\n");
  assert.equal(fs.readFileSync(path.join(root, ".agent/b.md"), "utf8"), "also [[New|alias]]\n");
});

test("renameLinks is a no-op when no references exist", () => {
  const root = makeVault();
  writeNote(root, "a.md", "no links here\n");
  const res = lr.renameLinks({ root, from: "Ghost", to: "New", dryRun: false });
  assert.equal(res.total_rewrites, 0);
  assert.equal(res.files_changed, 0);
});
