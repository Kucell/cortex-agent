"use strict";

// ─── Branch Registry I/O (M-016 MS-001 / F-001) ──────────────────────────────
//
// Owns .agent/branches/registry.json — schema + atomic read/write.
// Atomic write: tmp file + rename (no partial files on crash).
// Corrupt recovery: backup the corrupt blob to registry.json.corrupt-<ts>.bak,
// then OVERWRITE the registry with a fresh empty schema (so the next read sees
// a valid file). Caller can surface the backup path
// (recovered: true, backup: <path>) for audit.

const fs = require("node:fs");
const path = require("node:path");
const { validate: validateBranchName } = require("./naming");

const SCHEMA_VERSION = 1;
const VALID_STATUSES = Object.freeze(["active", "merge_ready", "merged", "archived"]);
const VALID_TYPES = Object.freeze(["feat", "fix", "release", "hotfix", "chore"]);

function defaultRegistry() {
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    branches: {},
  };
}

function defaultBranchEntry(input) {
  const now = new Date().toISOString();
  return {
    name: input.name,
    type: input.type,
    base_branch: input.base_branch || "main",
    base_commit: input.base_commit || null,
    created_at: input.created_at || now,
    proposal_ref: input.proposal_ref || null,
    mission_id: input.mission_id || null,
    task_id: input.task_id || null,
    status: input.status || "active",
    last_sync: input.last_sync || null,
    commits_ahead: typeof input.commits_ahead === "number" ? input.commits_ahead : 0,
    worktree_path: input.worktree_path || null,
    purpose: input.purpose || null,
    merged_commit: input.merged_commit || null,
    shipped: Array.isArray(input.shipped) ? input.shipped : [],
  };
}

function registryPath(cwd) {
  return path.join(cwd, ".agent", "branches", "registry.json");
}

function backupCorrupt(target, raw) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${target}.corrupt-${stamp}.bak`;
  try {
    fs.writeFileSync(backup, raw, { encoding: "utf8", mode: 0o600 });
    return backup;
  } catch {
    return null;
  }
}

function readRegistry(cwd, options = {}) {
  const target = registryPath(cwd);
  if (!fs.existsSync(target)) {
    if (options.createIfMissing === false) {
      return { ok: false, error: "registry_missing", path: target };
    }
    return { ok: true, registry: defaultRegistry(), created: true, path: target };
  }

  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (err) {
    return { ok: false, error: "registry_read_failed", detail: err.message, path: target };
  }

  let parsed;
  let parseError = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    parseError = err;
  }

  if (parseError) {
    if (options.recover === false) {
      return { ok: false, error: "registry_corrupt", detail: parseError.message, path: target };
    }
    const backup = backupCorrupt(target, raw);
    const fresh = defaultRegistry();
    // Atomically overwrite the corrupt file with a valid empty schema so the
    // next read sees a clean registry. writeRegistry uses tmp + rename.
    writeRegistry(cwd, fresh);
    return {
      ok: true,
      registry: fresh,
      recovered: true,
      backup,
      path: target,
      error: "registry_corrupt_recovered",
    };
  }

  if (!parsed || typeof parsed !== "object" || !parsed.branches || typeof parsed.branches !== "object") {
    if (options.recover === false) {
      return { ok: false, error: "registry_shape_invalid", path: target };
    }
    const backup = backupCorrupt(target, raw);
    const fresh = defaultRegistry();
    writeRegistry(cwd, fresh);
    return {
      ok: true,
      registry: fresh,
      recovered: true,
      backup,
      path: target,
      error: "registry_shape_invalid_recovered",
    };
  }

  return { ok: true, registry: parsed, recovered: false, path: target };
}

function writeRegistry(cwd, registry, options = {}) {
  const target = registryPath(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    ...registry,
    schema_version: SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* swallow */ }
    if (options.rethrow) throw err;
    return { ok: false, error: "registry_write_failed", detail: err.message, path: target };
  }
}

function listBranches(cwd, filter = {}) {
  const r = readRegistry(cwd);
  if (!r.ok) return r;
  let entries = Object.values(r.registry.branches || {});
  if (filter.type) entries = entries.filter((e) => e.type === filter.type);
  if (filter.status) entries = entries.filter((e) => e.status === filter.status);
  if (filter.missionId) entries = entries.filter((e) => e.mission_id === filter.missionId);
  return { ok: true, entries, registry: r.registry };
}

function getBranch(cwd, name) {
  const r = readRegistry(cwd);
  if (!r.ok) return r;
  const entry = r.registry.branches[name];
  if (!entry) return { ok: false, error: "branch_not_found", name };
  return { ok: true, entry };
}

function upsertBranch(cwd, entry) {
  if (!entry || typeof entry !== "object") {
    return { ok: false, error: "entry_required" };
  }
  const valid = validateBranchName(entry.name);
  if (!valid.ok) {
    return { ok: false, error: "invalid_branch_name", detail: valid, name: entry.name };
  }
  if (!VALID_TYPES.includes(entry.type)) {
    return { ok: false, error: "invalid_branch_type", allowed: VALID_TYPES, got: entry.type };
  }
  if (entry.status && !VALID_STATUSES.includes(entry.status)) {
    return { ok: false, error: "invalid_branch_status", allowed: VALID_STATUSES, got: entry.status };
  }

  const r = readRegistry(cwd);
  if (!r.ok) return r;

  const existing = r.registry.branches[entry.name];
  const merged = existing
    ? { ...existing, ...defaultBranchEntry(entry), name: entry.name, created_at: existing.created_at }
    : defaultBranchEntry(entry);
  r.registry.branches[entry.name] = merged;

  const w = writeRegistry(cwd, r.registry);
  if (!w.ok) return w;
  return { ok: true, entry: merged, created: !existing };
}

function updateBranch(cwd, name, patch) {
  if (!patch || typeof patch !== "object") {
    return { ok: false, error: "patch_required" };
  }
  const r = readRegistry(cwd);
  if (!r.ok) return r;
  const existing = r.registry.branches[name];
  if (!existing) return { ok: false, error: "branch_not_found", name };

  const merged = { ...existing, ...patch, name, type: existing.type, created_at: existing.created_at };
  const valid = validateBranchName(merged.name);
  if (!valid.ok) {
    return { ok: false, error: "invalid_branch_name", detail: valid, name: merged.name };
  }
  if (!VALID_TYPES.includes(merged.type)) {
    return { ok: false, error: "invalid_branch_type", allowed: VALID_TYPES, got: merged.type };
  }
  if (merged.status && !VALID_STATUSES.includes(merged.status)) {
    return { ok: false, error: "invalid_branch_status", allowed: VALID_STATUSES, got: merged.status };
  }
  r.registry.branches[name] = merged;

  const w = writeRegistry(cwd, r.registry);
  if (!w.ok) return w;
  return { ok: true, entry: merged };
}

function removeBranch(cwd, name, options = {}) {
  const r = readRegistry(cwd);
  if (!r.ok) return r;
  const existing = r.registry.branches[name];
  if (!existing) return { ok: false, error: "branch_not_found", name };

  if (options.hard !== true) {
    r.registry.branches[name] = { ...existing, status: "archived" };
    const w = writeRegistry(cwd, r.registry);
    if (!w.ok) return w;
    return { ok: true, entry: r.registry.branches[name], archived: true };
  }

  delete r.registry.branches[name];
  const w = writeRegistry(cwd, r.registry);
  if (!w.ok) return w;
  return { ok: true, removed: true };
}

module.exports = {
  SCHEMA_VERSION,
  VALID_STATUSES,
  VALID_TYPES,
  defaultRegistry,
  defaultBranchEntry,
  registryPath,
  backupCorrupt,
  readRegistry,
  writeRegistry,
  listBranches,
  getBranch,
  upsertBranch,
  updateBranch,
  removeBranch,
};
