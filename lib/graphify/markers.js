"use strict";

/**
 * Graphify freshness markers (T-GWG-001 / P-001 §4.6).
 *
 * When a Git hook observes a semantic-only change (documentation,
 * proposals, rules, images, etc.) the AST-level graph is left untouched.
 * To keep the resolver honest we MUST write a durable stale marker next
 * to the graph so subsequent queries can fail closed instead of
 * silently trusting the topology.
 *
 * The marker is JSON, written atomically next to `graph.json`. It is
 * always ignored by .gitignore so the marker never enters the source
 * tree as a regular product file.
 *
 * A marker carries:
 *   - schemaVersion
 *   - recordedAt (ISO timestamp)
 *   - kind: "semantic" | "incremental" | "force_rebuild_required" | "update_failed"
 *   - reason (human-readable)
 *   - changedPaths (relative paths observed in the semantic diff)
 *   - sourceHead (HEAD at the time the marker was written)
 *   - branch (branch at the time the marker was written, may be null)
 */

const fs = require("node:fs");
const path = require("node:path");

const MARKER_FILENAME = ".graphify-stale.json";
const MARKER_SCHEMA_VERSION = "1.0";

const KIND = Object.freeze({
  SEMANTIC: "semantic",
  INCREMENTAL: "incremental",
  FORCE_REBUILD: "force_rebuild_required",
  UPDATE_FAILED: "update_failed",
});

/**
 * Write a freshness marker into a graph directory. Atomic via rename.
 * Returns { ok, path } or { ok: false, reason }.
 */
function writeMarker({ graphDir, kind, reason, changedPaths = [], sourceHead = null, branch = null, now = null }) {
  if (!graphDir) return { ok: false, reason: "graph_dir_required" };
  if (!KIND[kind.toUpperCase ? kind.toUpperCase() : kind] && !Object.values(KIND).includes(kind)) {
    return { ok: false, reason: "invalid_kind" };
  }
  const markerPath = path.join(graphDir, MARKER_FILENAME);
  const tmpPath = markerPath + ".tmp";
  const payload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    recordedAt: now || new Date().toISOString(),
    kind,
    reason: reason || null,
    changedPaths: [...changedPaths].sort(),
    sourceHead,
    branch,
  };
  try {
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpPath, markerPath);
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "write_failed" };
  }
  return { ok: true, path: markerPath };
}

/**
 * Read a freshness marker. Returns { ok, marker, errors } — never throws.
 */
function readMarker(graphDir) {
  const markerPath = path.join(graphDir || "", MARKER_FILENAME);
  if (!graphDir || !fs.existsSync(markerPath)) {
    return { ok: false, marker: null, reason: "marker_missing" };
  }
  try {
    const text = fs.readFileSync(markerPath, "utf8");
    const data = JSON.parse(text);
    if (!data || data.schemaVersion !== MARKER_SCHEMA_VERSION) {
      return { ok: false, marker: data, reason: "schema_mismatch" };
    }
    return { ok: true, marker: data };
  } catch (err) {
    return { ok: false, marker: null, reason: "marker_corrupt" };
  }
}

/**
 * Clear any freshness marker. Used after a successful update or by
 * `doctor --fix` when the operator confirms a rebuild. Atomic and safe
 * to call repeatedly.
 */
function clearMarker(graphDir) {
  const markerPath = path.join(graphDir || "", MARKER_FILENAME);
  if (!fs.existsSync(markerPath)) return { ok: true, cleared: false };
  try {
    fs.unlinkSync(markerPath);
    return { ok: true, cleared: true };
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
  }
}

/**
 * Classify a set of changed paths into "code" vs "semantic" per the
 * Graphify contract. Code changes flow to `graphify update`; semantic
 * changes trigger a stale marker.
 *
 * The classification is intentionally coarse and language-agnostic:
 *   - code-like extensions → code change
 *   - documentation / proposal / rule / image → semantic change
 *   - everything else → default semantic (safe default; we never
 *     auto-update on ambiguous changes).
 *
 * The hook can inspect this output to decide whether to (a) silently
 * trigger `graphify update .` or (b) write a stale marker.
 */
function classifyChanges(changedPaths = []) {
  const CODE_EXT = new Set([
    ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".cs",
    ".scala", ".php", ".lua", ".sh", ".bash", ".zsh",
    ".sql", ".r", ".jl", ".dart",
  ]);
  const SEMANTIC_DIR = new Set([
    "docs", "doc",
    ".agent/skills", ".agent/rules", ".agent/proposals",
    ".agent/workflows",
    "proposals", "plans",
  ]);
  const SEMANTIC_NAME = new Set([
    "readme.md", "agents.md", "changelog.md", "license",
    "license.md", "contributing.md", "code_of_conduct.md",
    "graphify-integration-proposal.md",
  ]);
  const SEMANTIC_EXT = new Set([
    ".md", ".markdown", ".rst", ".adoc", ".txt",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".pdf", ".drawio", ".dot",
  ]);
  const code = [];
  const semantic = [];
  const unknown = [];
  for (const raw of changedPaths) {
    const p = String(raw || "").replace(/\\/g, "/");
    if (!p) continue;
    const lower = p.toLowerCase();
    const ext = path.extname(lower);
    const base = path.basename(lower);
    if (CODE_EXT.has(ext)) {
      code.push(p);
      continue;
    }
    if (SEMANTIC_NAME.has(base) || SEMANTIC_EXT.has(ext)) {
      semantic.push(p);
      continue;
    }
    const parts = p.split("/");
    if (parts.some((seg) => SEMANTIC_DIR.has(seg))) {
      semantic.push(p);
      continue;
    }
    unknown.push(p);
  }
  // Safe default: treat unknown as semantic so the hook writes a marker.
  for (const p of unknown) semantic.push(p);
  return { code, semantic };
}

module.exports = {
  MARKER_FILENAME,
  MARKER_SCHEMA_VERSION,
  KIND,
  writeMarker,
  readMarker,
  clearMarker,
  classifyChanges,
};