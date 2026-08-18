"use strict";

// ─── Memory Recall (M-002 MS-002) ─────────────────────────────────────────────
//
// `/memory recall <query>` — read-only search over `.agent/memory/{type}/<id>.json`.
//
// Workflow contract (templates/general/.agent/workflows/memory-recall.md):
//   - state_machine: [pending, running, done]
//   - failure_recovery: log-and-notify  (read-only, no rollback needed)
//   - depends_on: memory-curator skill available, .agent/memory/ exists
//   - produces: .agent/runs/<run_id>/{result,error}.json
//
// Algorithm (deterministic, no LLM in MS-002):
//   1. Load all memories of requested types from disk.
//   2. Drop expired (expires_at < now) and not-pinned.
//   3. For each candidate, score = tag-match * tag_weight + content-keyword * keyword_weight
//                              + recency_bonus + confidence * confidence_weight
//   4. Filter by min-confidence.
//   5. Sort desc, take top-K.
//   6. Return list + meta (counts, query, filters).
//
// Why not use full-text search:
//   - v1.11.0 is L1 capability: tag+keyword+recency is enough for the
//     small per-project memory corpus (<10k entries typical).
//   - Avoids adding fuse.js / minisearch / lunr (zero-dep hard constraint).
//   - FTS upgrade can land in v1.12 alongside procedural memory.
//
// Out of scope (deferred):
//   - Cross-project memory (handled by `scope=global` filter only)
//   - LLM re-ranking (MS-004 in `M-002`, or v1.12)
//   - Persistent recall index (defer until corpus > 1k entries)

const { listAllMemories } = require("./store");
const { ALL_TYPES, isValidType, ALL_SCOPES, isValidScope, resolveScope } = require("./types");

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_MIN_CONFIDENCE = 0.0;

const TAG_WEIGHT = 0.5;          // each tag match contributes 0.5
const CONTENT_WEIGHT = 0.3;       // each keyword hit in content contributes 0.3
const TITLE_WEIGHT = 0.4;         // each keyword hit in title contributes 0.4
const RECENCY_BONUS = 0.1;        // up to 0.1 for entries <30d old
const CONFIDENCE_WEIGHT = 0.2;    // confidence * 0.2

function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff_]+/)
    .filter((t) => t.length > 0);
}

function isExpired(entry, now = Date.now()) {
  if (entry.pinned) return false;
  if (!entry.expires_at) return false;
  const exp = Date.parse(entry.expires_at);
  if (Number.isNaN(exp)) return false;
  return exp < now;
}

function recencyBonus(entry, now = Date.now()) {
  const created = Date.parse(entry.created_at);
  if (Number.isNaN(created)) return 0;
  const ageDays = (now - created) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 0;
  if (ageDays > 30) return 0;
  return RECENCY_BONUS * (1 - ageDays / 30);
}

function scoreEntry(entry, queryTokens, tagSet) {
  if (queryTokens.length === 0) {
    // No query → fall back to confidence + recency only.
    return entry.confidence * CONFIDENCE_WEIGHT + recencyBonus(entry);
  }

  let score = 0;
  const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
  // Tokenize each tag (e.g. "decision-style" → ["decision", "style"]) so multi-
  // word tags contribute to multi-token queries like "decision".
  const tagTokenSet = new Set();
  for (const t of entryTags) {
    for (const tok of tokenize(t)) tagTokenSet.add(tok);
  }
  for (const qt of queryTokens) {
    if (tagTokenSet.has(qt)) score += TAG_WEIGHT;
  }
  const titleTokens = new Set(tokenize(entry.title));
  const contentTokens = tokenize(entry.content);
  const contentSet = new Set(contentTokens);
  for (const qt of queryTokens) {
    if (titleTokens.has(qt)) score += TITLE_WEIGHT;
    if (contentSet.has(qt)) score += CONTENT_WEIGHT;
  }
  score += entry.confidence * CONFIDENCE_WEIGHT;
  score += recencyBonus(entry);
  return score;
}

function recall({
  projectRoot,
  query = "",
  limit = DEFAULT_LIMIT,
  types = ALL_TYPES,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  includeExpired = false,
  scope = null,            // P-007 §3.1: filter by scope; null = all scopes
  now = Date.now(),
} = {}) {
  if (!projectRoot) {
    const err = new Error("recall: projectRoot required");
    err.code = "ERR_PROJECT_ROOT_REQUIRED";
    throw err;
  }
  if (!Array.isArray(types) || types.length === 0) {
    const err = new Error("recall: types must be a non-empty array");
    err.code = "ERR_INVALID_TYPES";
    throw err;
  }
  for (const t of types) {
    if (!isValidType(t)) {
      const err = new Error(`recall: invalid type "${t}"`);
      err.code = "ERR_INVALID_MEMORY_TYPE";
      throw err;
    }
  }
  if (scope != null && !isValidScope(scope)) {
    const err = new Error(`recall: invalid scope "${scope}". Valid: ${ALL_SCOPES.join(", ")}.`);
    err.code = "ERR_INVALID_MEMORY_SCOPE";
    throw err;
  }
  const safeLimit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  const safeMinConf = Math.max(0, Math.min(1, Number(minConfidence) || 0));

  const queryTokens = tokenize(query);
  const tagSet = new Set(queryTokens);  // overlap between query and tags is intentional

  const all = listAllMemories(projectRoot, types);
  const candidates = [];
  let expiredCount = 0;
  let lowConfidenceCount = 0;
  let scopeFilteredCount = 0;

  for (const entry of all) {
    if (scope != null) {
      const entryScope = resolveScope(entry);
      if (entryScope !== scope) {
        scopeFilteredCount++;
        continue;
      }
    }
    if (isExpired(entry, now)) {
      if (!includeExpired) {
        expiredCount++;
        continue;
      }
    }
    if ((entry.confidence ?? 0) < safeMinConf) {
      lowConfidenceCount++;
      continue;
    }
    const score = scoreEntry(entry, queryTokens, tagSet);
    candidates.push({ entry, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, safeLimit).map((c) => ({
    memory_id: c.entry.memory_id,
    type: c.entry.type,
    title: c.entry.title,
    content: c.entry.content,
    tags: c.entry.tags,
    confidence: c.entry.confidence,
    score: Number(c.score.toFixed(4)),
    created_at: c.entry.created_at,
  }));

  return {
    query,
    types,
    min_confidence: safeMinConf,
    limit: safeLimit,
    scope: scope,
    scanned: all.length,
    matched: candidates.length,
    returned: top.length,
    expired_skipped: expiredCount,
    low_confidence_skipped: lowConfidenceCount,
    scope_filtered_skipped: scopeFilteredCount,
    memories: top,
  };
}

module.exports = {
  recall,
  // exposed for tests
  _tokenize: tokenize,
  _isExpired: isExpired,
  _scoreEntry: scoreEntry,
  _resolveScope: resolveScope,
};
