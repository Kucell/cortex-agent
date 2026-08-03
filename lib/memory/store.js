"use strict";

// ─── Memory Store (M-002 MS-002) ──────────────────────────────────────────────
//
// Pure-Node file IO for `.agent/memory/{episodic,semantic,procedural}/<id>.json`.
// Each file is one memory entry that conforms to `templates/_base/.agent/memory/memory.schema.json`.
//
// Why a store layer (vs direct fs calls in recall/distill):
//   1. Single owner of path layout — if we later move to a JSONL index or
//      sqlite, only this file changes.
//   2. Centralizes atomic write (write to .tmp, then rename) and
//      read-with-defaults behavior.
//   3. Keeps `recall.js` and `distill.js` pure logic (testable without FS).
//
// Boundaries (per FAE-001 / M-001 binding contract):
//   - In scope: read / write / list / delete one memory file
//   - Out of scope: validation (handled by `lib/memory/validate.js` when present;
//     for MS-002 we trust the caller to provide schema-valid entries), query
//     logic (recall.js), LLM extraction (distill.js).

const fs = require("node:fs");
const path = require("node:path");
const { TYPES, ALL_TYPES, isValidType } = require("./types");

const DEFAULT_TYPE_DIRS = Object.freeze({
  [TYPES.EPISODIC]: "episodic",
  [TYPES.SEMANTIC]: "semantic",
  [TYPES.PROCEDURAL]: "procedural",
});

function memoryDir(projectRoot, type) {
  if (!isValidType(type)) {
    const err = new Error(
      `memoryDir: invalid type "${type}". Valid: ${ALL_TYPES.join(", ")}.`
    );
    err.code = "ERR_INVALID_MEMORY_TYPE";
    throw err;
  }
  return path.join(projectRoot, ".agent", "memory", DEFAULT_TYPE_DIRS[type]);
}

function memoryFilePath(projectRoot, type, memoryId) {
  if (!memoryId || typeof memoryId !== "string") {
    const err = new Error("memoryFilePath: memory_id required");
    err.code = "ERR_MEMORY_ID_REQUIRED";
    throw err;
  }
  return path.join(memoryDir(projectRoot, type), `${memoryId}.json`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readMemory(projectRoot, type, memoryId) {
  const file = memoryFilePath(projectRoot, type, memoryId);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error(
      `readMemory: failed to parse ${file}: ${error.message}`
    );
    err.code = "ERR_MEMORY_PARSE";
    err.cause = error;
    err.path = file;
    throw err;
  }
}

function writeMemory(projectRoot, type, entry) {
  if (!entry || typeof entry !== "object") {
    const err = new Error("writeMemory: entry object required");
    err.code = "ERR_MEMORY_ENTRY_INVALID";
    throw err;
  }
  if (!entry.memory_id) {
    const err = new Error("writeMemory: entry.memory_id required");
    err.code = "ERR_MEMORY_ID_REQUIRED";
    throw err;
  }
  if (entry.type !== type) {
    const err = new Error(
      `writeMemory: entry.type "${entry.type}" does not match dir type "${type}"`
    );
    err.code = "ERR_MEMORY_TYPE_MISMATCH";
    throw err;
  }
  const dir = memoryDir(projectRoot, type);
  ensureDir(dir);
  const file = memoryFilePath(projectRoot, type, entry.memory_id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function deleteMemory(projectRoot, type, memoryId) {
  const file = memoryFilePath(projectRoot, type, memoryId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function listMemoryIds(projectRoot, type) {
  const dir = memoryDir(projectRoot, type);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

function listMemories(projectRoot, type) {
  const ids = listMemoryIds(projectRoot, type);
  const out = [];
  for (const id of ids) {
    const entry = readMemory(projectRoot, type, id);
    if (entry) out.push(entry);
  }
  return out;
}

function listAllMemories(projectRoot, types = ALL_TYPES) {
  const out = [];
  for (const t of types) {
    for (const entry of listMemories(projectRoot, t)) {
      out.push(entry);
    }
  }
  return out;
}

module.exports = {
  memoryDir,
  memoryFilePath,
  readMemory,
  writeMemory,
  deleteMemory,
  listMemoryIds,
  listMemories,
  listAllMemories,
};
