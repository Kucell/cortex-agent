"use strict";

// ─── Agent Discover (M-002 MS-003) ────────────────────────────────────────────
//
// `agent discover` — read-only search over `.agent/agents/<agent_id>.json`.
//
// Workflow contract (templates/general/.agent/workflows/agent-discover.md):
//   - state_machine: [pending, running, done]
//   - failure_recovery: log-and-notify (read-only, no rollback)
//   - depends_on: .agent/agents/ directory exists
//   - produces: .agent/runs/<run_id>/{result,error}.json
//
// Algorithm (deterministic, no LLM in MS-003):
//   1. Load all agent entries from disk.
//   2. Apply hard filters (role / status / capability / adapter-type).
//   3. If query provided, soft-filter by substring match across id/role/
//      model/capabilities/owned_files.
//   4. Score by: query-match count + capability-match count + recency
//      (last_heartbeat). Stable tie-break by agent_id (alphabetical).
//   5. Sort desc, take top-K.
//
// Why no LLM re-ranking in MS-003:
//   - corpus is tiny (typically <50 agents per project)
//   - zero-dep constraint
//   - LLM re-ranking can land in v1.12 (after M-003 mission lands 5 external
//     adapters)
//
// Out of scope:
//   - Cross-project agent search (deferred to FAE-002 / v2.0)
//   - M-008 coordination runtime registry (different file path, different
//     schema, different lifecycle — M-008 is owned by Coordination LeaseManager)


const { findAgents } = require("./registry");

const { findAgents } = require("../agents/registry");


const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

function recencyBonus(entry, now = Date.now()) {
  const last = entry.last_heartbeat ? Date.parse(entry.last_heartbeat) : null;
  if (!last || Number.isNaN(last)) return 0;
  const ageDays = (now - last) / (1000 * 60 * 60 * 24);
  if (ageDays < 0 || ageDays > 30) return 0;
  return 0.1 * (1 - ageDays / 30);
}

function scoreEntry(entry, queryTokens) {
  let score = 0;
  const haystack = [
    entry.agent_id,
    entry.role,
    entry.model,
    ...(Array.isArray(entry.capabilities) ? entry.capabilities : []),
    ...(Array.isArray(entry.owned_files) ? entry.owned_files : []),
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  const haystackTokens = new Set();
  for (const h of haystack) for (const t of tokenize(h)) haystackTokens.add(t);

  for (const qt of queryTokens) {
    if (haystackTokens.has(qt)) score += 0.4;
  }

  // Capability exact match (each declared capability that overlaps with query tokens)
  const caps = Array.isArray(entry.capabilities) ? entry.capabilities : [];
  for (const c of caps) {
    for (const t of tokenize(c)) {
      if (queryTokens.includes(t)) score += 0.3;
    }
  }

  // Tiny bonus for freshness
  score += recencyBonus(entry);
  return score;
}

function discover({
  projectRoot,
  query = "",
  capability = null,
  role = null,
  status = null,
  adapterType = null,
  limit = DEFAULT_LIMIT,
  now = Date.now(),
} = {}) {
  if (!projectRoot) {
    const err = new Error("discover: projectRoot required");
    err.code = "ERR_PROJECT_ROOT_REQUIRED";
    throw err;
  }
  const safeLimit = Math.max(
    MIN_LIMIT,
    Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT),
  );
  const queryTokens = tokenize(query);

  // Pass query to findAgents for substring filter; only hard filters (role/status/
  // capability/adapterType) are applied there. Scoring happens below.
  const candidates = findAgents(projectRoot, {
    capability,
    role,
    status,
    adapterType,
    query: query || undefined,
  });

  const scored = [];
  for (const entry of candidates) {
    const score = queryTokens.length === 0
      ? recencyBonus(entry, now)  // no query → recency only (stable, alphabetical tiebreak)
      : scoreEntry(entry, queryTokens);
    scored.push({ entry, score });
  }

  // Stable sort: by score desc, then by agent_id asc
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.agent_id.localeCompare(b.entry.agent_id);
  });

  const top = scored.slice(0, safeLimit).map((c) => ({
    agent_id: c.entry.agent_id,
    role: c.entry.role,
    model: c.entry.model,
    status: c.entry.status,
    capabilities: c.entry.capabilities || [],
    external: c.entry.external || null,
    score: Number(c.score.toFixed(4)),
    last_heartbeat: c.entry.last_heartbeat,
  }));

  return {
    query,
    capability,
    role,
    status,
    adapter_type: adapterType,
    limit: safeLimit,
    scanned: candidates.length,
    matched: scored.length,
    returned: top.length,
    agents: top,
  };
}

module.exports = {
  discover,
  _tokenize: tokenize,
  _scoreEntry: scoreEntry,
  _recencyBonus: recencyBonus,
};
