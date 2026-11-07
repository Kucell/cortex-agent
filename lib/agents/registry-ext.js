"use strict";

// ─── Additive Agent Registry Reader (P-006 / M-029 follow-up) ─────────────────
//
// Background
// ----------
// M-002's `lib/agents/registry.js` is frozen and its `validateEntry()` calls
// the strict `VALID_ADAPTER_TYPES` list
// (`claude-code | cortex | codex | codey | pi | custom`). The additive
// extension file `registry-adapter-types.js` only exposes a *union* validator;
// it never reaches `validateEntry()`. Consequence (verified 2026-11-07 on
// `dsh 0.2.1-rc.5`):
//
//   .agent/agents/<id>.json with external.adapter_type = "dsh"
//     → readAgent() → validateEntry() → ERR_INVALID_ADAPTER_TYPE
//     → dispatch-execute surfaces ERR_AGENT_PARSE and never spawns.
//
// `VALID_ADAPTER_TYPES_EXT` now carries `minimax` / `dsh` / `cursor`, so the
// canonical reader must learn the same union. To keep `registry.js`
// zero-modify (M-002 hard constraint + the reverse assertion in
// `tests/agent/agent-adapter-dsh.test.js`), this module layers the additive
// behaviour on top instead of editing the frozen table:
//
//   1. Try the canonical `validateEntry()` first. Canonical entries take the
//      exact M-002 path — zero behavioural change.
//   2. If and only if it fails with `ERR_INVALID_ADAPTER_TYPE`, re-run
//      `validateEntry()` with the adapter_type replaced by an in-list
//      placeholder (`custom`) so every *other* field is still validated
//      exactly as M-002 would, then validate the real adapter_type against
//      the M-002 ∪ EXT union.
//
// Any other validation error (schema version / role / status / model / ...)
// propagates untouched, so the additive path cannot smuggle in a malformed
// entry.
//
// Hard constraints:
//   - Zero npm deps (`node:fs` / `node:path` + sibling modules only).
//   - `lib/agents/registry.js` stays byte-identical.
//   - Unknown adapter types still fail closed with `ERR_INVALID_ADAPTER_TYPE`.

const fs = require("node:fs");

const {
  agentFilePath,
  listAgentIds,
  validateEntry,
} = require("./registry");
const {
  isKnownAdapterType,
  validateAdapterTypeExt,
  VALID_ADAPTER_TYPES_ALL,
} = require("./registry-adapter-types");

// `custom` is the one M-002 in-list value that carries no vendor semantics, so
// substituting it lets validateEntry() check every remaining field without
// changing the outcome for the real adapter_type.
const EXT_PLACEHOLDER = "custom";

function parseAgentFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error(
      `readAgentExt: failed to parse ${file}: ${error.message}`,
    );
    err.code = "ERR_AGENT_PARSE";
    err.path = file;
    err.cause = error;
    throw err;
  }
}

function validateEntryExt(entry) {
  try {
    validateEntry(entry);
    return entry;
  } catch (err) {
    if (err.code !== "ERR_INVALID_ADAPTER_TYPE") throw err;
    const adapterType = entry.external && entry.external.adapter_type;
    validateAdapterTypeExt(adapterType);
    // Re-validate every non-adapter_type field through the canonical path.
    validateEntry({
      ...entry,
      external: { ...entry.external, adapter_type: EXT_PLACEHOLDER },
    });
    return entry;
  }
}

// Tolerant counterpart of registry.readAgent(): same file layout, same
// not-found contract (`null`), same parse-error code, plus EXT adapter types.
function readAgentExt(projectRoot, agentId) {
  const file = agentFilePath(projectRoot, agentId);
  if (!fs.existsSync(file)) return null;
  return validateEntryExt(parseAgentFile(file));
}

// Tolerant counterpart of registry.listAgents(): canonical entries are
// returned unchanged; non-entry files (schema / README / sample) are skipped
// exactly as the frozen implementation does.
function listAgentsExt(projectRoot) {
  const ids = listAgentIds(projectRoot);
  const out = [];
  for (const id of ids) {
    try {
      const entry = readAgentExt(projectRoot, id);
      if (entry) out.push(entry);
    } catch (_) {
      // Skip non-entry files (agent.schema.json / README.md / sample.json).
    }
  }
  return out;
}

// Tolerant counterpart of registry.findAgents(). The filter semantics mirror
// M-002 §discover exactly (role / status / capability / adapterType / model /
// project / query substring) so callers can swap one for the other.
function findAgentsExt(projectRoot, filter = {}) {
  const all = listAgentsExt(projectRoot);
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
    if (filter.model && entry.model !== filter.model) return false;
    if (filter.project) {
      const projects = Array.isArray(entry.projects) ? entry.projects : [];
      if (!projects.includes(filter.project)) return false;
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

// Split an adapter-qualified agent id (`dsh:Worker-A`) into
// `{ adapterPrefix, agentId }`. Anything that is not a known adapter prefix is
// treated as part of the agent id so canonical ids containing `:` keep working.
function splitAdapterQualifiedId(rawAgentId) {
  if (typeof rawAgentId !== "string") {
    return { adapterPrefix: null, agentId: rawAgentId };
  }
  const idx = rawAgentId.indexOf(":");
  if (idx <= 0) return { adapterPrefix: null, agentId: rawAgentId };
  const prefix = rawAgentId.slice(0, idx);
  const rest = rawAgentId.slice(idx + 1);
  if (!rest || !isKnownAdapterType(prefix)) {
    return { adapterPrefix: null, agentId: rawAgentId };
  }
  return { adapterPrefix: prefix, agentId: rest };
}

module.exports = {
  EXT_PLACEHOLDER,
  VALID_ADAPTER_TYPES_ALL,
  parseAgentFile,
  validateEntryExt,
  readAgentExt,
  listAgentsExt,
  findAgentsExt,
  splitAdapterQualifiedId,
};
