"use strict";

// ─── Memory Store Tests (M-002 MS-002) ────────────────────────────────────────
//
// Coverage: lib/memory/store.js — file IO layer. .agent/memory/{type}/<id>.json
// round-trip, atomic write, list, delete, type-mismatch guard.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  memoryDir,
  memoryFilePath,
  readMemory,
  writeMemory,
  deleteMemory,
  listMemoryIds,
  listMemories,
  listAllMemories,
} = require("../../lib/memory/store");
const { TYPES } = require("../../lib/memory/types");

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m002-store-"));
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

test("memory-store: memoryDir returns .agent/memory/{type}", () => {
  const root = "/tmp/proj";
  assert.equal(memoryDir(root, TYPES.EPISODIC), path.join(root, ".agent", "memory", "episodic"));
  assert.equal(memoryDir(root, TYPES.SEMANTIC), path.join(root, ".agent", "memory", "semantic"));
  assert.equal(memoryDir(root, TYPES.PROCEDURAL), path.join(root, ".agent", "memory", "procedural"));
});

test("memory-store: memoryDir throws on invalid type", () => {
  assert.throws(() => memoryDir("/tmp/proj", "bogus"), (err) => err.code === "ERR_INVALID_MEMORY_TYPE");
});

test("memory-store: writeMemory + readMemory round-trip preserves fields", () => {
  const root = mkProject();
  try {
    const entry = {
      schema_version: 1,
      memory_id: "MEM-test-001",
      type: "episodic",
      title: "test",
      content: "hello world",
      tags: ["test"],
      scope: "project",
      pinned: false,
      confidence: 0.8,
      created_at: "2026-08-02T00:00:00.000Z",
      updated_at: null,
    };
    const file = writeMemory(root, "episodic", entry);
    assert.ok(fs.existsSync(file));
    const back = readMemory(root, "episodic", "MEM-test-001");
    assert.deepEqual(back, entry);
  } finally { rmProject(root); }
});

test("memory-store: writeMemory creates directory if missing", () => {
  const root = mkProject();
  try {
    const entry = { memory_id: "MEM-x", type: "semantic", content: "x", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    const dir = memoryDir(root, "semantic");
    assert.equal(fs.existsSync(dir), false);
    writeMemory(root, "semantic", entry);
    assert.equal(fs.existsSync(dir), true);
  } finally { rmProject(root); }
});

test("memory-store: writeMemory rejects type mismatch", () => {
  const root = mkProject();
  try {
    const entry = { memory_id: "MEM-x", type: "episodic", content: "x", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    assert.throws(
      () => writeMemory(root, "semantic", entry),
      (err) => err.code === "ERR_MEMORY_TYPE_MISMATCH",
    );
  } finally { rmProject(root); }
});

test("memory-store: writeMemory rejects entry without memory_id", () => {
  const root = mkProject();
  try {
    const entry = { type: "episodic", content: "x", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    assert.throws(
      () => writeMemory(root, "episodic", entry),
      (err) => err.code === "ERR_MEMORY_ID_REQUIRED",
    );
  } finally { rmProject(root); }
});

test("memory-store: readMemory returns null for missing file", () => {
  const root = mkProject();
  try {
    assert.equal(readMemory(root, "episodic", "MEM-missing"), null);
  } finally { rmProject(root); }
});

test("memory-store: deleteMemory returns true on success, false on miss", () => {
  const root = mkProject();
  try {
    const entry = { memory_id: "MEM-del-1", type: "episodic", content: "x", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    writeMemory(root, "episodic", entry);
    assert.equal(deleteMemory(root, "episodic", "MEM-del-1"), true);
    assert.equal(deleteMemory(root, "episodic", "MEM-del-1"), false);
  } finally { rmProject(root); }
});

test("memory-store: listMemoryIds returns sorted ids without .json extension", () => {
  const root = mkProject();
  try {
    const e1 = { memory_id: "MEM-z", type: "episodic", content: "z", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    const e2 = { memory_id: "MEM-a", type: "episodic", content: "a", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" };
    writeMemory(root, "episodic", e1);
    writeMemory(root, "episodic", e2);
    assert.deepEqual(listMemoryIds(root, "episodic"), ["MEM-a", "MEM-z"]);
  } finally { rmProject(root); }
});

test("memory-store: listMemoryIds on empty/missing dir returns []", () => {
  const root = mkProject();
  try {
    assert.deepEqual(listMemoryIds(root, "episodic"), []);
    assert.deepEqual(listMemoryIds(root, "semantic"), []);
  } finally { rmProject(root); }
});

test("memory-store: listAllMemories returns entries across requested types", () => {
  const root = mkProject();
  try {
    writeMemory(root, "episodic", { memory_id: "MEM-e-1", type: "episodic", content: "e", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" });
    writeMemory(root, "semantic", { memory_id: "MEM-s-1", type: "semantic", content: "s", schema_version: 1, created_at: "2026-08-02T00:00:00.000Z" });
    const all = listAllMemories(root);
    assert.equal(all.length, 2);
    const justEpisodic = listAllMemories(root, ["episodic"]);
    assert.equal(justEpisodic.length, 1);
    assert.equal(justEpisodic[0].type, "episodic");
  } finally { rmProject(root); }
});

test("memory-store: memoryFilePath throws on missing memory_id", () => {
  assert.throws(
    () => memoryFilePath("/tmp", "episodic", ""),
    (err) => err.code === "ERR_MEMORY_ID_REQUIRED",
  );
});

test("memory-store: readMemory throws on malformed JSON", () => {
  const root = mkProject();
  try {
    const dir = memoryDir(root, "episodic");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MEM-bad.json"), "{not valid json");
    assert.throws(
      () => readMemory(root, "episodic", "MEM-bad"),
      (err) => err.code === "ERR_MEMORY_PARSE",
    );
  } finally { rmProject(root); }
});
