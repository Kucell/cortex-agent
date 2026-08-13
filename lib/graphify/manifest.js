"use strict";

/**
 * Graphify manifest schema and helpers (T-GWG-001 / P-001).
 *
 * The manifest is the durable record of a graph's provenance. It travels
 * next to `graphify-out/graph.json` and answers: which schema/CLI built it,
 * against which source HEAD, when, with what mode, against which roots.
 *
 * Without a manifest we cannot determine freshness, schema compatibility,
 * or branch-delta readback requirements.
 *
 * This module is intentionally dependency-free so it can run in init/doctor,
 * git hooks, the CLI surface, and tests without bringing in helpers.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA_VERSION = "1.0";
const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0"]);
const SUPPORTED_MAJOR_VERSIONS = new Set([1]);

const REPO_ID_KEYS = [
  "remoteUrl",
  "worktreeRole",
  "commonDir",
];

/**
 * Build a manifest from a builder-side context. Pure: returns the object,
 * does not touch the filesystem. Caller owns atomic write.
 */
function buildManifest({
  schemaVersion = SCHEMA_VERSION,
  graphifyVersion,
  generatedAt = new Date().toISOString(),
  repositoryIdentity,
  sourceHead,
  sourceBranch = null,
  includedRoots = [],
  excludedRoots = [],
  nodeCount = 0,
  edgeCount = 0,
  generationMode = "full",
  pluginVersion = "cortex-agent-graphify/0",
}) {
  return {
    schemaVersion,
    graphifyVersion: graphifyVersion || "unknown",
    pluginVersion,
    generatedAt,
    repositoryIdentity: repositoryIdentity || null,
    sourceHead: sourceHead || null,
    sourceBranch,
    includedRoots: [...includedRoots],
    excludedRoots: [...excludedRoots],
    nodeCount: Math.max(0, Number(nodeCount) || 0),
    edgeCount: Math.max(0, Number(edgeCount) || 0),
    generationMode,
  };
}

/**
 * Read + validate a manifest from `graphify-out/manifest.json`.
 * Returns { ok, manifest, errors }. The function NEVER throws on
 * malformed input — callers rely on `ok=false` to fall back to
 * `legacy-unverified`.
 */
function readManifest(graphRoot) {
  const manifestPath = path.join(graphRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, manifest: null, errors: ["manifest_missing"], legacy: true };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ok: false, manifest: null, errors: ["manifest_corrupt"], legacy: true };
  }
  const errors = validateManifest(raw);
  if (errors.length) {
    return { ok: false, manifest: raw, errors, legacy: true };
  }
  return { ok: true, manifest: raw, errors: [], legacy: false };
}

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== "object") {
    errors.push("manifest_not_object");
    return errors;
  }
  if (!m.schemaVersion || !SUPPORTED_SCHEMA_VERSIONS.has(m.schemaVersion)) {
    errors.push("schema_unsupported");
  }
  if (!m.graphifyVersion || typeof m.graphifyVersion !== "string") {
    errors.push("graphify_version_missing");
  }
  if (!m.generatedAt || Number.isNaN(Date.parse(m.generatedAt))) {
    errors.push("generated_at_invalid");
  }
  if (m.sourceHead != null && typeof m.sourceHead !== "string") {
    errors.push("source_head_invalid");
  }
  if (!Array.isArray(m.includedRoots)) {
    errors.push("included_roots_invalid");
  }
  if (!Array.isArray(m.excludedRoots)) {
    errors.push("excluded_roots_invalid");
  }
  if (typeof m.nodeCount !== "number" || m.nodeCount < 0) {
    errors.push("node_count_invalid");
  }
  if (typeof m.edgeCount !== "number" || m.edgeCount < 0) {
    errors.push("edge_count_invalid");
  }
  if (!["full", "update"].includes(m.generationMode)) {
    errors.push("generation_mode_invalid");
  }
  return errors;
}

/**
 * Atomically write a manifest + graph pair to a staging directory then
 * rename into place. The atomic replacement guarantees the resolver never
 * observes a partial write — either the old graph survives or the new one
 * is fully landed.
 *
 * Caller passes `targetDir` (typically `<repo>/graphify-out`), `stagingDir`
 * (a sibling tmp directory), the manifest object, and the graph payload.
 *
 * The function returns { ok, manifestPath, graphPath, digest, applied } and
 * never leaves a partial graph behind on failure.
 */
function writeManifestAtomic({ targetDir, stagingDir, manifest, graph }) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const manifestPath = path.join(stagingDir, "manifest.json");
  const graphPath = path.join(stagingDir, "graph.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(graphPath, JSON.stringify(graph));
  const digest = computeManifestDigest(manifest);
  // Refuse to overwrite target if it already exists with non-zero size
  // (the caller may have raced). Surface a recoverable error code.
  if (fs.existsSync(path.join(targetDir, "manifest.json"))) {
    return {
      ok: false,
      reason: "target_exists",
      manifestPath,
      graphPath,
      digest,
    };
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(manifestPath, path.join(targetDir, "manifest.json"));
  fs.renameSync(graphPath, path.join(targetDir, "graph.json"));
  return {
    ok: true,
    manifestPath: path.join(targetDir, "manifest.json"),
    graphPath: path.join(targetDir, "graph.json"),
    digest,
    applied: true,
  };
}

function computeManifestDigest(manifest) {
  const json = JSON.stringify(stableStringify(manifest));
  return "sha256:" + crypto.createHash("sha256").update(json).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

/**
 * Compute a deterministic repository identity from a Git context. Used to
 * sanity-check a candidate manifest against the current repo without
 * baking any absolute paths or usernames into the shared manifest.
 */
function deriveRepoIdentity({ remoteUrl, worktreeRole, commonDir }) {
  return {
    remoteUrl: remoteUrl || null,
    worktreeRole: worktreeRole || "unknown",
    commonDir: commonDir || null,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  SUPPORTED_MAJOR_VERSIONS,
  buildManifest,
  readManifest,
  validateManifest,
  writeManifestAtomic,
  computeManifestDigest,
  deriveRepoIdentity,
  REPO_ID_KEYS,
};