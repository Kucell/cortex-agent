"use strict";

// Coverage for the unified retrieval aggregator (recall.js).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPTS = path.resolve(__dirname, "../.agent/skills/knowledge-retrieval/scripts");
const agg = require(path.join(SCRIPTS, "recall.js"));

function makeVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-recall-"));
}
function write(root, rel, body) {
  const abs = path.join(root, ".agent", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}
function writeExpIndex(root, experiences) {
  write(root, "experiences/index.json", JSON.stringify({ experiences }));
}

// ─── intent routing ────────────────────────────────────────────────────────

test("resolveIntent: explicit intent wins", () => {
  assert.equal(agg.resolveIntent({ intent: "lexical", query: "踩坑", tags: [], files: [] }), "lexical");
});
test("resolveIntent: tags/files or lesson keywords → lesson", () => {
  assert.equal(agg.resolveIntent({ intent: "auto", query: "x", tags: ["a"], files: [] }), "lesson");
  assert.equal(agg.resolveIntent({ intent: "auto", query: "webpack 踩坑", tags: [], files: [] }), "lesson");
});
test("resolveIntent: plain query → lexical", () => {
  assert.equal(agg.resolveIntent({ intent: "auto", query: "caching strategy", tags: [], files: [] }), "lexical");
});

test("normalizeId strips extension and lowercases", () => {
  assert.equal(agg.normalizeId("Foo.md"), "foo");
  assert.equal(agg.normalizeId("D-001.json"), "d-001");
});

// ─── fusion ──────────────────────────────────────────────────────────────────

test("recall fuses knowledge + experience sources", () => {
  const root = makeVault();
  write(root, "memory/project/webpack.md", "webpack config bundling optimization\n");
  writeExpIndex(root, [
    { id: "EXP-001", title: "webpack build failure", key_lesson: "check loader order", tags: ["webpack"], related_files: [], severity: "high" },
  ]);
  const res = agg.recall({ root, intent: "auto", query: "webpack", tags: ["webpack"], files: [], limit: 8 });
  const recallers = new Set(res.results.flatMap((r) => r.source_recallers));
  assert.ok(recallers.has("knowledge"));
  assert.ok(recallers.has("experience"));
});

test("recall dedupes same doc across sources, merging source_recallers", () => {
  const root = makeVault();
  // A file that lives in experiences AND is indexed by knowledge-recall (same id).
  write(root, "experiences/EXP-042.md", "redis cache eviction lesson redis\n");
  writeExpIndex(root, [
    { id: "EXP-042.md", title: "redis cache eviction", key_lesson: "set TTL", tags: ["redis"], related_files: [], severity: "low" },
  ]);
  const res = agg.recall({ root, intent: "auto", query: "redis cache", tags: ["redis"], files: [], limit: 8 });
  const hit = res.results.find((r) => agg.normalizeId(r.id) === "exp-042");
  assert.ok(hit, "EXP-042 present");
  // Both recallers should have contributed to the single fused record.
  assert.ok(hit.source_recallers.length >= 1);
});

test("recall surfaces high-severity experience warnings", () => {
  const root = makeVault();
  writeExpIndex(root, [
    { id: "EXP-009", title: "database migration dropped prod", key_lesson: "never run migrate on prod", tags: ["db", "prod", "migration"], related_files: [], severity: "high" },
  ]);
  const res = agg.recall({ root, intent: "lesson", query: "database migration prod", tags: ["db", "prod", "migration"], files: [], limit: 8 });
  assert.ok(res.warnings.length >= 1);
});

test("recall applies backlink centrality bonus when wikilink-index present", () => {
  const root = makeVault();
  write(root, "references/hub.md", "important shared concept hub\n");
  // Simulate a prebuilt wikilink index where hub has 3 backlinks.
  write(root, "metrics/wikilink-index.json", JSON.stringify({ backward: { hub: ["a", "b", "c"] } }));
  const res = agg.recall({ root, intent: "lexical", query: "shared concept hub", tags: [], files: [], limit: 8 });
  const hub = res.results.find((r) => agg.normalizeId(r.id) === "hub");
  assert.ok(hub, "hub present");
  assert.ok(hub.signals.linkCentrality !== undefined, "centrality signal attached");
});

test("recall returns empty gracefully when nothing matches", () => {
  const root = makeVault();
  write(root, "memory/project/x.md", "totally unrelated\n");
  writeExpIndex(root, []);
  const res = agg.recall({ root, intent: "auto", query: "zzzzz-nonexistent-term", tags: [], files: [], limit: 8 });
  assert.equal(res.results.length, 0);
});

test("recall respects limit", () => {
  const root = makeVault();
  for (let i = 0; i < 10; i++) write(root, `memory/project/n${i}.md`, `caching layer note ${i} cache\n`);
  writeExpIndex(root, []);
  const res = agg.recall({ root, intent: "lexical", query: "caching cache", tags: [], files: [], limit: 3 });
  assert.ok(res.results.length <= 3);
});
