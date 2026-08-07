"use strict";

// ─── Memory Distill Tests (M-002 MS-002) ──────────────────────────────────────
//
// Coverage: lib/memory/distill.js — entry construction, draft lifecycle,
// commit + rollback on failure, run journal artifacts. LLM extraction is
// caller-supplied (candidates array) per MS-002 boundary.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { distill, buildEntry, generateMemoryId, listSourceRecords, writeDraft, cleanupDrafts, commitDrafts, writeRunArtifact, defaultExpiryDate } = require("../../lib/memory/distill");
const { readMemory, listMemoryIds } = require("../../lib/memory/store");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m002-distill-"));
  for (const sub of ["runs", "sessions", "conversations"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

test("memory-distill: generateMemoryId has MEM- prefix and matches schema regex", () => {
  const id = generateMemoryId("episodic");
  assert.match(id, /^MEM-episodic-[a-f0-9]{8}$/);
});

test("memory-distill: defaultExpiryDate returns ISO date 90d out for episodic", () => {
  const now = Date.parse("2026-08-02T00:00:00.000Z");
  const exp = defaultExpiryDate("episodic", now);
  assert.equal(exp, "2026-10-31");
});

test("memory-distill: defaultExpiryDate returns null for semantic (stable)", () => {
  const exp = defaultExpiryDate("semantic", Date.now());
  assert.equal(exp, null);
});

test("memory-distill: buildEntry fills required schema fields", () => {
  const entry = buildEntry({
    type: "episodic",
    content: "user did X",
    title: "X happened",
    tags: ["tag-a"],
    now: Date.parse("2026-08-02T00:00:00.000Z"),
  });
  assert.equal(entry.schema_version, 1);
  assert.match(entry.memory_id, /^MEM-episodic-[a-f0-9]{8}$/);
  assert.equal(entry.type, "episodic");
  assert.equal(entry.title, "X happened");
  assert.equal(entry.content, "user did X");
  assert.deepEqual(entry.tags, ["tag-a"]);
  assert.equal(entry.confidence, 0.8);
  assert.equal(entry.pinned, false);
  assert.equal(entry.scope, "project");
  assert.equal(entry.expires_at, "2026-10-31");
  assert.equal(entry.source_conversation_id, null);
  assert.equal(entry.source_decision_id, null);
  assert.equal(entry.source_run_id, null);
  assert.equal(entry.created_at, "2026-08-02T00:00:00.000Z");
  assert.equal(entry.updated_at, null);
});

test("memory-distill: buildEntry rejects procedural type (deferred to v1.12)", () => {
  assert.throws(
    () => buildEntry({ type: "procedural", content: "x" }),
    (err) => err.code === "ERR_TYPE_NOT_WRITABLE",
  );
});

test("memory-distill: buildEntry rejects content > 4000 chars", () => {
  assert.throws(
    () => buildEntry({ type: "episodic", content: "x".repeat(4001) }),
    (err) => err.code === "ERR_CONTENT_TOO_LONG",
  );
});

test("memory-distill: buildEntry rejects missing content", () => {
  assert.throws(
    () => buildEntry({ type: "episodic" }),
    (err) => err.code === "ERR_CONTENT_REQUIRED",
  );
});

test("memory-distill: buildEntry honours pinned (no expiry)", () => {
  const entry = buildEntry({ type: "episodic", content: "x", pinned: true });
  assert.equal(entry.pinned, true);
  assert.equal(entry.expires_at, null);
});

test("memory-distill: buildEntry clamps confidence to [0, 1]", () => {
  const lo = buildEntry({ type: "episodic", content: "x", confidence: -0.5 });
  const hi = buildEntry({ type: "episodic", content: "x", confidence: 1.5 });
  assert.equal(lo.confidence, 0);
  assert.equal(hi.confidence, 1);
});

test("memory-distill: buildEntry tags capped at 10", () => {
  const entry = buildEntry({
    type: "episodic",
    content: "x",
    tags: Array.from({ length: 15 }, (_, i) => `tag-${i}`),
  });
  assert.equal(entry.tags.length, 10);
});

test("memory-distill: writeDraft + cleanupDrafts round-trip", () => {
  const root = mkProject();
  try {
    const entry = { memory_id: "MEM-d-1", type: "episodic", content: "x", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    const file = writeDraft(root, "R-test-1", entry);
    assert.ok(fs.existsSync(file));
    cleanupDrafts(root, "R-test-1", ["MEM-d-1"]);
    assert.equal(fs.existsSync(file), false);
  } finally { rmProject(root); }
});

test("memory-distill: commitDrafts writes to .agent/memory/{type} and removes drafts", () => {
  const root = mkProject();
  try {
    const e1 = { memory_id: "MEM-c-1", type: "semantic", content: "x", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    const e2 = { memory_id: "MEM-c-2", type: "episodic", content: "y", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    writeDraft(root, "R-test", e1);
    writeDraft(root, "R-test", e2);
    const written = commitDrafts(root, "R-test", [e1, e2]);
    assert.equal(written.length, 2);
    assert.equal(listMemoryIds(root, "semantic").includes("MEM-c-1"), true);
    assert.equal(listMemoryIds(root, "episodic").includes("MEM-c-2"), true);
    assert.equal(fs.existsSync(path.join(root, ".agent/runs/R-test/drafts")), false);
  } finally { rmProject(root); }
});

test("memory-distill: writeRunArtifact writes JSON to .agent/runs/<run_id>/", () => {
  const root = mkProject();
  try {
    const file = writeRunArtifact(root, "R-x", "result.json", { ok: true, n: 1 });
    assert.ok(fs.existsSync(file));
    const back = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(back, { ok: true, n: 1 });
  } finally { rmProject(root); }
});

test("memory-distill: listSourceRecords reads .agent/sessions/ and filters by since", () => {
  const root = mkProject();
  try {
    fs.writeFileSync(
      path.join(root, ".agent/sessions/S-1.json"),
      JSON.stringify({ created_at: "2026-08-01T00:00:00.000Z", note: "old" }),
    );
    fs.writeFileSync(
      path.join(root, ".agent/sessions/S-2.json"),
      JSON.stringify({ created_at: "2026-08-02T00:00:00.000Z", note: "new" }),
    );
    const all = listSourceRecords(root, "sessions", null);
    assert.equal(all.length, 2);
    const recent = listSourceRecords(root, "sessions", "2026-08-02T00:00:00.000Z");
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, "S-2");
  } finally { rmProject(root); }
});

test("memory-distill: end-to-end with candidates writes entries + result.json", () => {
  const root = mkProject();
  try {
    fs.writeFileSync(
      path.join(root, ".agent/sessions/S-test.json"),
      JSON.stringify({ created_at: "2026-08-02T00:00:00.000Z" }),
    );
    const result = distill({
      projectRoot: root,
      runId: "R-e2e-1",
      candidates: [
        { type: "episodic", content: "user toggled mode", tags: ["toggle"] },
        { type: "semantic", content: "Eric prefers concrete recommendations", tags: ["style"], confidence: 0.95 },
      ],
      source: "sessions",
    });
    assert.equal(result.error, null);
    assert.equal(result.written.length, 2);
    assert.equal(result.scanned, 1);
    assert.equal(listMemoryIds(root, "episodic").length, 1);
    assert.equal(listMemoryIds(root, "semantic").length, 1);
    assert.ok(fs.existsSync(path.join(root, ".agent/runs/R-e2e-1/result.json")));
  } finally { rmProject(root); }
});

test("memory-distill: empty candidates writes result.json with note and no entries", () => {
  const root = mkProject();
  try {
    const result = distill({
      projectRoot: root,
      runId: "R-empty",
      candidates: [],
    });
    assert.equal(result.written.length, 0);
    assert.equal(result.error, null);
    assert.ok(fs.existsSync(path.join(root, ".agent/runs/R-empty/result.json")));
  } finally { rmProject(root); }
});

test("memory-distill: validation failure cleans up partial drafts + writes error.json", () => {
  const root = mkProject();
  try {
    const result = distill({
      projectRoot: root,
      runId: "R-bad",
      candidates: [
        { type: "episodic", content: "good" },
        { type: "episodic", content: "x".repeat(5000) },  // too long
      ],
    });
    assert.ok(result.error);
    assert.equal(result.error.code, "ERR_CONTENT_TOO_LONG");
    assert.equal(result.written.length, 0);
    assert.ok(fs.existsSync(path.join(root, ".agent/runs/R-bad/error.json")));
    const errArtifact = JSON.parse(fs.readFileSync(path.join(root, ".agent/runs/R-bad/error.json"), "utf8"));
    assert.equal(errArtifact.error.code, "ERR_CONTENT_TOO_LONG");
  } finally { rmProject(root); }
});

test("memory-distill: missing projectRoot throws", () => {
  assert.throws(
    () => distill({ runId: "R-x", candidates: [] }),
    (err) => err.code === "ERR_PROJECT_ROOT_REQUIRED",
  );
});

test("memory-distill: missing runId throws", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => distill({ projectRoot: root, candidates: [] }),
      (err) => err.code === "ERR_RUN_ID_REQUIRED",
    );
  } finally { rmProject(root); }
});
