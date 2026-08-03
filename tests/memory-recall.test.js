"use strict";

// ─── Memory Recall Tests (M-002 MS-002) ───────────────────────────────────────
//
// Coverage: lib/memory/recall.js — query scoring, expired skip, low-confidence
// skip, type filtering, limit clamp. read-only — no .agent/memory/ writes here
// (use store.js via fixture seed).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeMemory } = require("../lib/memory/store");
const { recall, _tokenize, _isExpired, _scoreEntry } = require("../lib/memory/recall");

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m002-recall-"));
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seed(root, type, id, content, opts = {}) {
  writeMemory(root, type, {
    schema_version: 1,
    memory_id: id,
    type,
    title: opts.title || (content.length <= 80 ? content : content.slice(0, 77) + "..."),
    content,
    tags: opts.tags || [],
    scope: opts.scope || "project",
    pinned: !!opts.pinned,
    confidence: opts.confidence != null ? opts.confidence : 0.8,
    expires_at: opts.expiresAt || null,
    created_at: opts.createdAt || "2026-08-02T00:00:00.000Z",
    updated_at: null,
  });
}

test("memory-recall: tokenize splits on non-alphanumeric and lowercases", () => {
  assert.deepEqual(_tokenize("Hello World"), ["hello", "world"]);
  assert.deepEqual(_tokenize("FAE-001 dispatch"), ["fae", "001", "dispatch"]);
  assert.deepEqual(_tokenize(""), []);
  assert.deepEqual(_tokenize(null), []);
});

test("memory-recall: isExpired respects pinned", () => {
  const now = Date.parse("2026-08-02T00:00:00.000Z");
  const expired = { pinned: false, expires_at: "2026-07-01T00:00:00.000Z" };
  assert.equal(_isExpired(expired, now), true);
  const pinnedExpired = { pinned: true, expires_at: "2026-07-01T00:00:00.000Z" };
  assert.equal(_isExpired(pinnedExpired, now), false);
  const notExpired = { pinned: false, expires_at: "2027-01-01T00:00:00.000Z" };
  assert.equal(_isExpired(notExpired, now), false);
  const noExpiry = { pinned: false, expires_at: null };
  assert.equal(_isExpired(noExpiry, now), false);
});

test("memory-recall: returns empty when no memories exist", () => {
  const root = mkProject();
  try {
    const result = recall({ projectRoot: root, query: "anything" });
    assert.equal(result.scanned, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.returned, 0);
    assert.deepEqual(result.memories, []);
  } finally { rmProject(root); }
});

test("memory-recall: tag match ranks higher than content match", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-tag", "alpha", { tags: ["decision-style"] });
    seed(root, "semantic", "MEM-content", "alpha beta gamma", { tags: ["other"] });
    const result = recall({ projectRoot: root, query: "decision" });
    assert.equal(result.returned, 2);
    assert.equal(result.memories[0].memory_id, "MEM-tag");
  } finally { rmProject(root); }
});

test("memory-recall: filters by min-confidence", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-high", "important", { confidence: 0.9 });
    seed(root, "semantic", "MEM-low", "important", { confidence: 0.2 });
    const result = recall({ projectRoot: root, query: "important", minConfidence: 0.5 });
    assert.equal(result.returned, 1);
    assert.equal(result.memories[0].memory_id, "MEM-high");
    assert.equal(result.low_confidence_skipped, 1);
  } finally { rmProject(root); }
});

test("memory-recall: skips expired entries by default", () => {
  const root = mkProject();
  try {
    seed(root, "episodic", "MEM-old", "old event", { expiresAt: "2026-01-01T00:00:00.000Z" });
    seed(root, "episodic", "MEM-new", "old event");
    const result = recall({ projectRoot: root, query: "event" });
    assert.equal(result.returned, 1);
    assert.equal(result.memories[0].memory_id, "MEM-new");
    assert.equal(result.expired_skipped, 1);
  } finally { rmProject(root); }
});

test("memory-recall: --include-expired surfaces expired entries", () => {
  const root = mkProject();
  try {
    seed(root, "episodic", "MEM-old", "old event", { expiresAt: "2026-01-01T00:00:00.000Z" });
    const result = recall({ projectRoot: root, query: "event", includeExpired: true });
    assert.equal(result.returned, 1);
    assert.equal(result.expired_skipped, 0);
  } finally { rmProject(root); }
});

test("memory-recall: filters by type", () => {
  const root = mkProject();
  try {
    seed(root, "episodic", "MEM-ep", "ep");
    seed(root, "semantic", "MEM-sem", "sem");
    const result = recall({ projectRoot: root, query: "ep", types: ["episodic"] });
    assert.equal(result.returned, 1);
    assert.equal(result.memories[0].type, "episodic");
  } finally { rmProject(root); }
});

test("memory-recall: limit is clamped to [1, 50]", () => {
  const root = mkProject();
  try {
    for (let i = 0; i < 5; i++) seed(root, "semantic", `MEM-${i}`, "shared content");
    const r1 = recall({ projectRoot: root, query: "shared", limit: 100 });
    assert.equal(r1.returned, 5);
    const r2 = recall({ projectRoot: root, query: "shared", limit: 2 });
    assert.equal(r2.returned, 2);
  } finally { rmProject(root); }
});

test("memory-recall: throws on missing projectRoot", () => {
  assert.throws(
    () => recall({ query: "x" }),
    (err) => err.code === "ERR_PROJECT_ROOT_REQUIRED",
  );
});

test("memory-recall: throws on invalid type", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => recall({ projectRoot: root, query: "x", types: ["bogus"] }),
      (err) => err.code === "ERR_INVALID_MEMORY_TYPE",
    );
  } finally { rmProject(root); }
});

test("memory-recall: empty query falls back to confidence + recency ranking", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-lo", "x", { confidence: 0.5 });
    seed(root, "semantic", "MEM-hi", "x", { confidence: 0.95 });
    const result = recall({ projectRoot: root, query: "" });
    assert.equal(result.returned, 2);
    assert.equal(result.memories[0].memory_id, "MEM-hi");
  } finally { rmProject(root); }
});

test("memory-recall: recent entries get recency bonus", () => {
  const root = mkProject();
  try {
    const recent = new Date().toISOString();
    seed(root, "semantic", "MEM-recent", "shared", { confidence: 0.8, createdAt: recent });
    seed(root, "semantic", "MEM-old", "shared", { confidence: 0.8, createdAt: "2025-01-01T00:00:00.000Z" });
    const result = recall({ projectRoot: root, query: "shared" });
    assert.equal(result.returned, 2);
    assert.equal(result.memories[0].memory_id, "MEM-recent");
  } finally { rmProject(root); }
});

test("memory-recall: _scoreEntry returns confidence + recency for empty query", () => {
  const now = Date.parse("2026-08-02T00:00:00.000Z");
  const entry = { confidence: 1.0, tags: [], content: "", title: "", created_at: new Date(now).toISOString() };
  const score = _scoreEntry(entry, [], new Set());
  assert.ok(score > 0);
  assert.ok(score <= 1.2);
});
