"use strict";

// ─── Agent Registry (M-002 MS-003) ────────────────────────────────────────────
//
// Pure-Node file IO for `.agent/agents/<agent_id>.json` — one file per agent
// entry, conforming to `templates/_base/.agent/agents/agent.schema.json`
// (M-001 publish).
//
// Boundary per D-002-3 (Eric 拍板 2026-08-01):
//   - **Agent Registry (M-002 scope)**: 静态能力注册 + 跨 agent 切换入口
//   - **Coordination Registry (M-008 scope)**: 运行时实例 + lease
//
// This module is the M-002 side. We do NOT touch M-008 coordination runtime
// (lib/coordination/consumer-registry.js, host-capabilities.js). Boundary is
// enforced by *path*: this module only writes `.agent/agents/`, never
// `.agent-runtime/coordination/`.
//
// Why per-file JSON (not a single registry.yaml like the workflow contract
// mentions):
//   1. Matches existing lib/memory/ pattern (M-002 MS-002 — 1 file per entry)
//   2. Zero-dep (no YAML lib; consistent with v1.10+ JSON direction)
//   3. Atomic write is trivial (write .tmp + rename, per file)
//   4. Workflow contract `agent-discover.md` says "registry.yaml" but the
//      schema + sample are JSON — a YAML aggregator can be auto-generated
//      from these files in a follow-up (deferred to v1.12 if needed).
//
// Note: For v1.11.0 we don't auto-aggregate to YAML; discovery reads the
// directory directly. This is a deliberate simplification (see commit msg).

const fs = require("node:fs");
const path = require("node:path");

const VALID_ROLES = Object.freeze([
  "implementer",
  "coordinator",
  "reviewer",
  "researcher",
  "documenter",
  "memory-curator",
  "conversation-curator",
  "user",
  "external",
]);

const VALID_STATUSES = Object.freeze([
  "running",
  "paused",
  "completed",
  "failed",
  "handed_off",
  "stale",
  "expired",
]);

const VALID_ADAPTER_TYPES = Object.freeze([
  "claude-code",
  "cortex",
  "codex",
  "codey",
  "pi",
  "custom",
]);

function agentsDir(projectRoot) {
  return path.join(projectRoot, ".agent", "agents");
}

function agentFilePath(projectRoot, agentId) {
  if (!agentId || typeof agentId !== "string") {
    const err = new Error("agentFilePath: agent_id required");
    err.code = "ERR_AGENT_ID_REQUIRED";
    throw err;
  }
  return path.join(agentsDir(projectRoot), `${agentId}.json`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─── validation ──────────────────────────────────────────────────────────────

function validateRole(role) {
  if (!VALID_ROLES.includes(role)) {
    const err = new Error(
      `validateRole: invalid role "${role}". Valid: ${VALID_ROLES.join(", ")}.`
    );
    err.code = "ERR_INVALID_ROLE";
    throw err;
  }
}

function validateStatus(status) {
  if (!VALID_STATUSES.includes(status)) {
    const err = new Error(
      `validateStatus: invalid status "${status}". Valid: ${VALID_STATUSES.join(", ")}.`
    );
    err.code = "ERR_INVALID_STATUS";
    throw err;
  }
}

function validateAdapterType(t) {
  if (!VALID_ADAPTER_TYPES.includes(t)) {
    const err = new Error(
      `validateAdapterType: invalid adapter_type "${t}". Valid: ${VALID_ADAPTER_TYPES.join(", ")}.`
    );
    err.code = "ERR_INVALID_ADAPTER_TYPE";
    throw err;
  }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    const err = new Error("validateEntry: entry object required");
    err.code = "ERR_AGENT_ENTRY_INVALID";
    throw err;
  }
  if (entry.schema_version !== 1) {
    const err = new Error(
      `validateEntry: schema_version must be 1, got ${entry.schema_version}`
    );
    err.code = "ERR_INVALID_SCHEMA_VERSION";
    throw err;
  }
  if (!entry.agent_id || typeof entry.agent_id !== "string") {
    const err = new Error("validateEntry: agent_id required");
    err.code = "ERR_AGENT_ID_REQUIRED";
    throw err;
  }
  validateRole(entry.role);
  if (!entry.model || typeof entry.model !== "string") {
    const err = new Error("validateEntry: model required");
    err.code = "ERR_AGENT_MODEL_REQUIRED";
    throw err;
  }
  if (!entry.started_at) {
    const err = new Error("validateEntry: started_at required");
    err.code = "ERR_AGENT_STARTED_AT_REQUIRED";
    throw err;
  }
  validateStatus(entry.status);
  if (entry.capabilities && !Array.isArray(entry.capabilities)) {
    const err = new Error("validateEntry: capabilities must be an array");
    err.code = "ERR_AGENT_CAPABILITIES_INVALID";
    throw err;
  }
  if (entry.external && entry.external.adapter_type) {
    validateAdapterType(entry.external.adapter_type);
  }
}

// ─── IO ──────────────────────────────────────────────────────────────────────

function readAgent(projectRoot, agentId) {
  const file = agentFilePath(projectRoot, agentId);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  try {
    const entry = JSON.parse(raw);
    validateEntry(entry);
    return entry;
  } catch (error) {
    const err = new Error(
      `readAgent: failed to parse ${file}: ${error.message}`
    );
    err.code = "ERR_AGENT_PARSE";
    err.cause = error;
    err.path = file;
    throw err;
  }
}

function writeAgent(projectRoot, entry) {
  validateEntry(entry);
  const dir = agentsDir(projectRoot);
  ensureDir(dir);
  const file = agentFilePath(projectRoot, entry.agent_id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function deleteAgent(projectRoot, agentId) {
  const file = agentFilePath(projectRoot, agentId);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function listAgentIds(projectRoot) {
  const dir = agentsDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

function listAgents(projectRoot) {
  const ids = listAgentIds(projectRoot);
  const out = [];
  for (const id of ids) {
    try {
      const entry = readAgent(projectRoot, id);
      if (entry) out.push(entry);
    } catch (_) {
      // Skip non-entry files (e.g. agent.schema.json, README.md, sample.json)
      // that M-001 ships in templates/_base/.agent/agents/. Mixed-content
      // directories are expected in real init'd projects.
    }
  }
  return out;
}

// ─── filter / search ─────────────────────────────────────────────────────────

function findAgents(projectRoot, filter = {}) {
  const all = listAgents(projectRoot);
  return all.filter((entry) => {
    if (filter.role && entry.role !== filter.role) return false;
    if (filter.status && entry.status !== filter.status) return false;
    if (filter.capability) {
      const caps = Array.isArray(entry.capabilities) ? entry.capabilities : [];
      if (!caps.includes(filter.capability)) return false;
    }
    if (filter.adapterType) {
      const ext = entry.external;
      if (!ext || ext.adapter_type !== filter.adapterType) return false;
    }
    if (filter.query) {
      const q = String(filter.query).toLowerCase();
      const haystack = [
        entry.agent_id,
        entry.role,
        entry.model,
        ...(Array.isArray(entry.capabilities) ? entry.capabilities : []),
        ...(Array.isArray(entry.owned_files) ? entry.owned_files : []),
      ]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase())
        .join(" ");
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

module.exports = {
  VALID_ROLES,
  VALID_STATUSES,
  VALID_ADAPTER_TYPES,
  agentsDir,
  agentFilePath,
  readAgent,
  writeAgent,
  deleteAgent,
  listAgentIds,
  listAgents,
  findAgents,
  validateEntry,
  validateRole,
  validateStatus,
  validateAdapterType,
};
