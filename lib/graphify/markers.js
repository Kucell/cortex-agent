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
const crypto = require("node:crypto");

const MARKER_FILENAME = ".graphify-stale.json";
const MARKER_SCHEMA_VERSION = "1.0";

const KIND = Object.freeze({
  SEMANTIC: "semantic",
  INCREMENTAL: "incremental",
  FORCE_REBUILD: "force_rebuild_required",
  UPDATE_FAILED: "update_failed",
});

// The kinds a SUCCESSFUL INCREMENTAL UPDATE may clear.
//
// A SEMANTIC marker says "the semantic corpus is stale". An incremental
// update rebuilds the CODE corpus only -- it never regenerates the global
// `contains` / doc-reference edges of a fully built graph -- so it does
// not answer that reminder. A FORCE_REBUILD marker says "a full rebuild
// is required", and an incremental update is not one.
//
// Only the kinds that describe the incremental path itself are resolved by
// a successful incremental update. Clearing the others would drop a
// reminder that nothing has answered, and the reminder is the only
// persistent trace of the change it describes.
const CLEARABLE_BY_INCREMENTAL = Object.freeze([
  KIND.INCREMENTAL,
  KIND.UPDATE_FAILED,
]);

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
  // The temp name is UNIQUE. Two writers that share a temp name publish
  // each other's half-written file: the first one renames the temp file
  // away, and the second one's rename then fails with ENOENT -- the marker
  // it wrote is lost, and the write is reported as a failure.
  const tmpPath = markerPath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  const payload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    // The ID of THIS marker. Every write produces a new one, so two
    // generations of the marker are always distinguishable -- even when a
    // writer rewrote the file in place instead of replacing it.
    markerId: crypto.randomBytes(12).toString("hex"),
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
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (err) {
    return { ok: false, marker: null, reason: "marker_missing" };
  }
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, marker: null, reason: "marker_corrupt" };
  }
  if (!data || data.schemaVersion !== MARKER_SCHEMA_VERSION) {
    return { ok: false, marker: data, reason: "schema_mismatch", identity: markerIdentity(raw) };
  }
  // The identity tells two generations of the marker apart: a marker that a
  // concurrent writer replaced is a DIFFERENT marker, so a compare-and-
  // clear can tell whether the marker it read is still the one on disk.
  return { ok: true, marker: data, identity: markerIdentity(raw), raw };
}

/**
 * The identity of a marker: the hash of its CONTENT.
 *
 * The inode, the modification time and the size cannot tell two versions
 * of a marker apart: a writer that rewrites the file IN PLACE within the
 * same millisecond, with the same length, produces the very same triple.
 * The content hash cannot -- every write produces a different content.
 */
function markerIdentity(raw) {
  if (typeof raw !== "string") return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Clear any freshness marker, unconditionally. Used by the explicit
 * operator path (`graphify update`). Atomic and safe to call repeatedly.
 */
function clearMarker(graphDir) {
  const markerPath = path.join(graphDir || "", MARKER_FILENAME);
  if (!fs.existsSync(markerPath)) return { ok: true, cleared: false };
  try {
    fs.unlinkSync(markerPath);
    return { ok: true, cleared: true };
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, cleared: false };
    return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
  }
}

/**
 * Clear the marker ONLY when it is still the very same marker that was read
 * AND its kind is one this caller may clear.
 *
 * Two problems are solved here.
 *
 * 1. The check and the removal must not be separated by a window in which
 *    the file can change. A marker that a concurrent consumer wrote in the
 *    meantime describes a DIFFERENT change -- a deferred semantic change,
 *    for instance -- and an unconditional clear would delete that reminder
 *    for good: the request it belongs to has already been confirmed, so
 *    nothing would ever publish it again.
 *
 *    So the file is MOVED ASIDE first, with an atomic rename. The rename
 *    takes whatever is at the path at that instant, and the content that
 *    was moved away is compared with the content that was read. A marker
 *    that a concurrent writer replaced is therefore detected and put back:
 *    the removal is never a removal BY PATH, so a stale judgement can never
 *    delete a marker it did not read.
 *
 * 2. A marker of a kind this caller may not clear is left alone. A
 *    successful incremental update does not rebuild the semantic corpus,
 *    so it does not answer a SEMANTIC reminder.
 *
 * Returns { ok, cleared, reason? }.
 */
function clearMarkerIfUnchanged(graphDir, identity, { kinds = null } = {}) {
  if (!identity) return { ok: true, cleared: false, reason: "no_marker" };
  const current = readMarker(graphDir);
  if (!current.ok || !current.marker) {
    return { ok: true, cleared: false, reason: current.reason || "marker_missing" };
  }
  if (!current.identity || current.identity !== identity) {
    return { ok: true, cleared: false, reason: "marker_changed" };
  }
  if (Array.isArray(kinds) && !kinds.includes(current.marker.kind)) {
    return { ok: true, cleared: false, reason: "kind_not_clearable" };
  }
  const markerPath = path.join(graphDir, MARKER_FILENAME);
  // The move aside is ATOMIC: there is no instant at which the marker is
  // "about to be removed".
  const tmpPath = markerPath + ".cleared-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  try {
    fs.renameSync(markerPath, tmpPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, cleared: false, reason: "marker_missing" };
    return { ok: false, reason: err && err.code ? err.code : "rename_failed" };
  }
  // The moved file is the marker that was at the path at the moment of the
  // rename. It is the marker that was read only when its content is the
  // same -- otherwise a concurrent writer replaced it in the meantime.
  let moved = null;
  try {
    moved = fs.readFileSync(tmpPath, "utf8");
  } catch (_) {
    moved = null;
  }
  if (moved !== null && markerIdentity(moved) === identity) {
    // It is the marker that was read: the reminder is answered.
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
    return { ok: true, cleared: true };
  }
  // It is NOT the marker that was read: a concurrent writer published a
  // new one, which must survive. It is put back when the path is free;
  // when a NEWER marker already occupies the path, that newer marker
  // supersedes it and the moved one is dropped -- a stale reminder must
  // never overwrite a newer one.
  try {
    if (!fs.existsSync(markerPath)) {
      fs.renameSync(tmpPath, markerPath);
    } else {
      fs.unlinkSync(tmpPath);
    }
  } catch (_) { /* best-effort */ }
  return { ok: true, cleared: false, reason: "marker_changed" };
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
  CLEARABLE_BY_INCREMENTAL,
  writeMarker,
  readMarker,
  clearMarker,
  clearMarkerIfUnchanged,
  classifyChanges,
};
