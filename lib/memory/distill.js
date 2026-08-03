"use strict";

// ─── Memory Distill (M-002 MS-002) ────────────────────────────────────────────
//
// `/memory distill` — extract structured memory records from raw session or
// conversation state. Has write side effects; **rollback required on failure**
// (D-002-4 拍板: `rollback-draft-and-notify`).
//
// Workflow contract (templates/general/.agent/workflows/memory-distill.md):
//   - state_machine: [pending, running, done]
//   - failure_recovery: rollback-draft-and-notify  (删 draft + 写 error.json + inbox)
//   - depends_on: memory-curator sub-agent, .agent/memory/ + .agent/sessions/ or
//                 .agent/conversations/
//   - produces: .agent/memory/{episodic,semantic,procedural}/<id>.md,
//               .agent/runs/<run_id>/{result,error,draft}.json
//
// MS-002 范围说明(明确边界,避免 scope creep):
//   - **实现**:file 落盘 + schema 字段填充 + draft 生命周期 + 失败回滚
//   - **不实现**:LLM 抽取(MS-004 接 memory-curator sub-agent;本任务用
//                 `extractCandidates()` 暴露 mock 入口,接 caller 提供的
//                 pre-extracted 列表)
//   - **不实现**:`procedural` 写操作(推到 v1.12,RFC §12 #6 拍板)
//
// Why mock LLM extraction in MS-002:
//   - 抽取逻辑需要 sub-agent + LLM,scope 比 MS-002 大
//   - MS-002 验证:CLI 可执行、schema 落盘、回滚机制工作
//   - MS-004 端到端测试矩阵接 memory-curator sub-agent,完成 LLM 抽取闭环

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeMemory, deleteMemory, listAllMemories } = require("./store");
const { TYPES, WRITABLE_TYPES, DEFAULT_EXPIRY_DAYS, isValidType, isWritableType } = require("./types");

// ─── ID generation ────────────────────────────────────────────────────────────

// MEM- prefix, 8 hex chars from md5 of (type + timestamp + random).
// Collision-resistant for any realistic corpus size.
function generateMemoryId(type, now = Date.now()) {
  const seed = `${type}-${now}-${crypto.randomBytes(6).toString("hex")}`;
  const hash = crypto.createHash("md5").update(seed).digest("hex").slice(0, 8);
  return `MEM-${type}-${hash}`;
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

function defaultExpiryDate(type, now = Date.now()) {
  const days = DEFAULT_EXPIRY_DAYS[type];
  if (days == null) return null;
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ─── Draft lifecycle ──────────────────────────────────────────────────────────

// Each distill run writes drafts to .agent/runs/<run_id>/drafts/<memory_id>.json
// before commit; on commit, drafts are deleted and final entries land in
// .agent/memory/{type}/<memory_id>.json. On failure, drafts are removed and
// error.json is written.

function draftDir(projectRoot, runId) {
  return path.join(projectRoot, ".agent", "runs", runId, "drafts");
}

function writeDraft(projectRoot, runId, entry) {
  const dir = draftDir(projectRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${entry.memory_id}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return file;
}

function cleanupDrafts(projectRoot, runId, memoryIds) {
  const dir = draftDir(projectRoot, runId);
  if (!fs.existsSync(dir)) return [];
  const removed = [];
  for (const id of memoryIds) {
    const f = path.join(dir, `${id}.json`);
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      removed.push(f);
    }
  }
  // Best-effort: remove empty drafts dir
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (_) { /* ignore */ }
  return removed;
}

function commitDrafts(projectRoot, runId, entries) {
  const written = [];
  try {
    for (const entry of entries) {
      const file = writeMemory(projectRoot, entry.type, entry);
      written.push({ memory_id: entry.memory_id, type: entry.type, file });
    }
  } catch (error) {
    // Rollback: delete any entries we already wrote + clean drafts
    for (const w of written) {
      try { deleteMemory(projectRoot, w.type, w.memory_id); } catch (_) { /* ignore */ }
    }
    cleanupDrafts(projectRoot, runId, entries.map((e) => e.memory_id));
    const err = new Error(`commitDrafts: failed at ${written.length}/${entries.length}: ${error.message}`);
    err.code = "ERR_DISTILL_COMMIT_FAILED";
    err.cause = error;
    throw err;
  }
  cleanupDrafts(projectRoot, runId, entries.map((e) => e.memory_id));
  return written;
}

// ─── Run journal helpers ──────────────────────────────────────────────────────

function runDir(projectRoot, runId) {
  return path.join(projectRoot, ".agent", "runs", runId);
}

function writeRunArtifact(projectRoot, runId, name, payload) {
  const dir = runDir(projectRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

// ─── Source enumeration ───────────────────────────────────────────────────────

function listSourceRecords(projectRoot, source, since) {
  // Returns a flat list of {id, type, body, ts} from `.agent/{source}/`.
  // For v1.11.0 we only need a minimal interface — the actual semantic
  // extraction is the caller's responsibility.
  const dir = path.join(projectRoot, ".agent", source);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  const out = [];
  const sinceMs = since ? Date.parse(since) : null;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (_) { continue; }
    const id = name.replace(/\.json$/, "");
    const ts = parsed.created_at || parsed.timestamp || parsed.updated_at || null;
    const tsMs = ts ? Date.parse(ts) : null;
    if (sinceMs != null && tsMs != null && tsMs < sinceMs) continue;
    out.push({
      id,
      type: source === "sessions" ? "session" : "conversation",
      body: typeof parsed === "string" ? parsed : JSON.stringify(parsed),
      ts,
    });
  }
  return out;
}

// ─── Entry construction ──────────────────────────────────────────────────────

function buildEntry({ type, content, title, tags, source, sourceRecordId, scope, confidence, pinned, now }) {
  if (!isWritableType(type)) {
    const err = new Error(
      `buildEntry: type "${type}" not writable in MS-002 (procedural deferred to v1.12)`
    );
    err.code = "ERR_TYPE_NOT_WRITABLE";
    throw err;
  }
  if (!content || typeof content !== "string") {
    const err = new Error("buildEntry: content required");
    err.code = "ERR_CONTENT_REQUIRED";
    throw err;
  }
  if (content.length > 4000) {
    const err = new Error("buildEntry: content exceeds 4000 chars");
    err.code = "ERR_CONTENT_TOO_LONG";
    throw err;
  }
  const t = now ?? Date.now();
  const memory_id = generateMemoryId(type, t);
  return {
    schema_version: 1,
    memory_id,
    type,
    title: title || (content.length <= 80 ? content : content.slice(0, 77) + "..."),
    content,
    tags: Array.isArray(tags) ? tags.filter((x) => typeof x === "string").slice(0, 10) : [],
    source_conversation_id:
      source === "conversations" && sourceRecordId ? `C-${sourceRecordId}` : null,
    source_decision_id: null,
    source_run_id: null,
    scope: scope || "project",
    expires_at: pinned ? null : defaultExpiryDate(type, t),
    pinned: !!pinned,
    confidence: confidence != null ? Math.max(0, Math.min(1, confidence)) : 0.8,
    created_at: isoNow(t),
    updated_at: null,
  };
}

// ─── Top-level distill entry point ────────────────────────────────────────────

// `candidates` shape (caller-supplied, post-LLM extraction):
//   [{ type, content, title?, tags?, scope?, confidence?, pinned? }, ...]
//
// Returns: { run_id, written, skipped, error }
function distill({
  projectRoot,
  runId,
  candidates = [],
  source = "sessions",
  since = null,
  now = Date.now(),
} = {}) {
  if (!projectRoot) {
    const err = new Error("distill: projectRoot required");
    err.code = "ERR_PROJECT_ROOT_REQUIRED";
    throw err;
  }
  if (!runId) {
    const err = new Error("distill: runId required (caller generates)");
    err.code = "ERR_RUN_ID_REQUIRED";
    throw err;
  }

  const result = {
    run_id: runId,
    source,
    since,
    scanned: 0,
    written: [],
    skipped: [],
    error: null,
  };

  // Pre-check: at least one source record exists (else we silently no-op).
  const sourceRecords = listSourceRecords(projectRoot, source, since);
  result.scanned = sourceRecords.length;

  if (candidates.length === 0) {
    result.note = "no candidates supplied (LLM extraction deferred to MS-004)";
    writeRunArtifact(projectRoot, runId, "result.json", result);
    return result;
  }

  // Stage 1: build entries + write drafts
  const entries = [];
  const draftFiles = [];
  try {
    for (const c of candidates) {
      const entry = buildEntry({ ...c, source, now });
      const f = writeDraft(projectRoot, runId, entry);
      draftFiles.push(f);
      entries.push(entry);
    }
  } catch (error) {
    // Validation failed before all drafts written — clean up
    cleanupDrafts(projectRoot, runId, entries.map((e) => e.memory_id));
    result.error = { code: error.code || "ERR_DISTILL_VALIDATION", message: error.message };
    writeRunArtifact(projectRoot, runId, "error.json", result);
    return result;
  }

  // Stage 2: commit (with rollback on failure)
  try {
    const written = commitDrafts(projectRoot, runId, entries);
    result.written = written.map((w) => ({ memory_id: w.memory_id, type: w.type }));
  } catch (error) {
    result.error = { code: error.code || "ERR_DISTILL_COMMIT", message: error.message };
    writeRunArtifact(projectRoot, runId, "error.json", result);
    return result;
  }

  writeRunArtifact(projectRoot, runId, "result.json", result);
  return result;
}

module.exports = {
  distill,
  // exposed for tests + future memory-curator sub-agent wiring (MS-004)
  generateMemoryId,
  buildEntry,
  listSourceRecords,
  writeDraft,
  cleanupDrafts,
  commitDrafts,
  writeRunArtifact,
  defaultExpiryDate,
};
