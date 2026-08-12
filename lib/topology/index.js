"use strict";

// ─── Project Topology Registry (P-001 Phase A) ─────────────────────────────
//
// Persistent registry at .agent/topology/projects.json describing cortex-agent
// and its peer projects' identity, capabilities, and reachability.
//
// The registry does NOT assume a fixed number of projects. Business dependency
// DAGs belong to Composite Workspace instances; the Topology Registry only
// resolves stable project_id / topology_ref.
//
// Public API:
//   • topologyPath(root)          → absolute path to projects.json
//   • readTopology(root)          → { self, peers[] } (empty peers if missing)
//   • writeTopology(root, data)   → { ok, topology } (atomic write)
//   • initSelf(root, opts)        → { ok, self, peers_kept } (P-001A)
//   • registerPeer(root, peer)    → { ok, topology } (append; validates)
//   • deregisterPeer(root, id)    → { ok, removed, topology }
//   • findPeer(topology, id)      → peer object or null
//   • resolveTopologyRef(topology, ref) → peer or null
//   • validateTopology(data)      → { ok, errors[] }
//   • validatePeer(peer)          → { ok, errors[] }
//
// Source: P-001 §2 注册表 schema, §3 CLI surface; P-001A §2 init 契约.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = "1.0";

// ─── Path helpers ───────────────────────────────────────────────────────────

function topologyDir(root) {
  return path.join(path.resolve(root), ".agent", "topology");
}

function topologyPath(root) {
  return path.join(topologyDir(root), "projects.json");
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validatePeer(peer) {
  const errors = [];
  if (!peer || typeof peer !== "object") {
    return { ok: false, errors: ["peer must be an object"] };
  }
  if (typeof peer.project_id !== "string" || !peer.project_id.trim()) {
    errors.push("project_id is required and must be a non-empty string");
  }
  if (typeof peer.host_root !== "string" || !peer.host_root.trim()) {
    errors.push("host_root is required and must be a non-empty string");
  }
  if (peer.primary_branch !== undefined && typeof peer.primary_branch !== "string") {
    errors.push("primary_branch must be a string if provided");
  }
  if (peer.roles !== undefined && !Array.isArray(peer.roles)) {
    errors.push("roles must be an array if provided");
  }
  if (peer.capabilities !== undefined && !Array.isArray(peer.capabilities)) {
    errors.push("capabilities must be an array if provided");
  }
  if (peer.topology_ref !== undefined && typeof peer.topology_ref !== "string") {
    errors.push("topology_ref must be a string if provided");
  }
  if (peer.bridge_subscriptions !== undefined && !Array.isArray(peer.bridge_subscriptions)) {
    errors.push("bridge_subscriptions must be an array if provided");
  }
  return { ok: errors.length === 0, errors };
}

function validateTopology(data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    return { ok: false, errors: ["topology must be an object"] };
  }
  if (data.schema_version !== undefined && data.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be "${SCHEMA_VERSION}"`);
  }
  if (!data.self || typeof data.self !== "object") {
    errors.push("self is required and must be an object");
  } else {
    if (typeof data.self.project_id !== "string" || !data.self.project_id.trim()) {
      errors.push("self.project_id is required");
    }
  }
  if (data.peers !== undefined && !Array.isArray(data.peers)) {
    errors.push("peers must be an array");
  } else if (Array.isArray(data.peers)) {
    data.peers.forEach((peer, i) => {
      const v = validatePeer(peer);
      if (!v.ok) {
        errors.push(`peers[${i}]: ${v.errors.join("; ")}`);
      }
    });
    // Check for duplicate project_id
    const ids = data.peers.map((p) => p.project_id).filter(Boolean);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      errors.push(`duplicate project_id: ${[...new Set(dupes)].join(", ")}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ─── Read ───────────────────────────────────────────────────────────────────

function readTopology(root) {
  const target = topologyPath(root);
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { self: { project_id: "cortex-agent", host_root: path.resolve(root), primary_branch: "main" }, peers: [] };
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { self: { project_id: "cortex-agent", host_root: path.resolve(root), primary_branch: "main" }, peers: [] };
  }
}

// ─── Write (atomic) ─────────────────────────────────────────────────────────

function writeTopology(root, data) {
  const validation = validateTopology(data);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const target = topologyPath(root);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const payload = { schema_version: SCHEMA_VERSION, ...data };
  const tmp = target + `.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
  return { ok: true, topology: payload };
}

// ─── Init Self Identity (P-001A) ─────────────────────────────────────────────

function detectGitBranch(root) {
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const branch = out.trim();
    return branch && branch !== "HEAD" ? branch : "";
  } catch {
    return "";
  }
}

function initSelf(root, options) {
  const opts = options || {};
  if (!opts.project_id || typeof opts.project_id !== "string" || !opts.project_id.trim()) {
    return { ok: false, errors: ["project_id is required"] };
  }
  const project_id = opts.project_id.trim();
  // Only treat the file as "already declared" if it actually exists.
  // readTopology() returns a sentinel self for missing files, which must
  // not be interpreted as an existing identity (otherwise a fresh project
  // can never overwrite the placeholder).
  let existingSelf = null;
  let current = { self: null, peers: [] };
  const target = topologyPath(root);
  if (fs.existsSync(target)) {
    try {
      current = JSON.parse(fs.readFileSync(target, "utf8"));
      if (current && current.self && typeof current.self.project_id === "string") {
        existingSelf = current.self.project_id;
      }
    } catch (error) {
      return { ok: false, errors: [`existing projects.json is not valid JSON: ${error.message}`] };
    }
  }
  if (existingSelf && existingSelf !== project_id && !opts.force) {
    return {
      ok: false,
      errors: [`self already declared as "${existingSelf}"; pass --force to overwrite`],
    };
  }
  const host_root = (opts.host_root && String(opts.host_root).trim())
    || (current && current.self && current.self.host_root)
    || path.resolve(root);
  const primary_branch = (opts.branch && String(opts.branch).trim())
    || (current && current.self && current.self.primary_branch)
    || detectGitBranch(path.resolve(root))
    || "main";
  const self = { project_id, host_root, primary_branch };
  const peers = Array.isArray(current.peers) ? current.peers : [];
  const result = writeTopology(root, { self, peers });
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, self, peers_kept: peers.length };
}

// ─── Register / Deregister ──────────────────────────────────────────────────

function registerPeer(root, peer) {
  const validation = validatePeer(peer);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const topology = readTopology(root);
  // Check for duplicate
  const existing = topology.peers.find((p) => p.project_id === peer.project_id);
  if (existing) {
    return { ok: false, errors: [`peer "${peer.project_id}" already registered`] };
  }
  topology.peers.push(peer);
  return writeTopology(root, topology);
}

function deregisterPeer(root, projectId) {
  const topology = readTopology(root);
  const index = topology.peers.findIndex((p) => p.project_id === projectId);
  if (index === -1) {
    return { ok: false, errors: [`peer "${projectId}" not found`] };
  }
  const removed = topology.peers.splice(index, 1)[0];
  const result = writeTopology(root, topology);
  if (!result.ok) return result;
  return { ok: true, removed, topology: result.topology };
}

// ─── Query ──────────────────────────────────────────────────────────────────

function findPeer(topology, projectId) {
  if (!topology || !Array.isArray(topology.peers)) return null;
  return topology.peers.find((p) => p.project_id === projectId) || null;
}

/**
 * Resolve a topology_ref like "SamHMI@main" to a peer object.
 * Falls back to exact project_id match if no @ is present.
 */
function resolveTopologyRef(topology, ref) {
  if (!ref || typeof ref !== "string") return null;
  const atIdx = ref.indexOf("@");
  const projectId = atIdx >= 0 ? ref.slice(0, atIdx) : ref;
  return findPeer(topology, projectId);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  topologyPath,
  readTopology,
  writeTopology,
  initSelf,
  registerPeer,
  deregisterPeer,
  findPeer,
  resolveTopologyRef,
  validateTopology,
  validatePeer,
};
