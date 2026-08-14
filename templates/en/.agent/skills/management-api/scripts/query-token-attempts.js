"use strict";

// ─── query-token-attempts (L1 management-api — focused token-attempt query) ───
// ─────────────────────────────────────────────────────────────────────────────────
// Single-purpose functions that:
//   1. Provide focused queries over the token-attempt ledger.
//   2. Never scan or return receipt bodies.
//   3. Support filtering by task/run/status/host/model without full scan.
//   4. Return only metadata projections, not actual usage data.
//
// Design rules (per M-025/MS-001 VC-006):
//   - Focused queries filter by index, not full scan.
//   - Receipt bodies are never returned; only summaries.
//   - No aggregation of actual token counts in query results.
//   - Distinct from runs tokens aggregation (VC-005 backward compatibility).

const fs = require("fs");
const path = require("path");

const { LEDGER_DIR, LEDGER_INDEX } = require("./token-attempt-ledger.js");

// ─── Utility: resolve ledger directory ───────────────────────────────────────
function resolveLedgerDir(root) {
  return path.join(root, LEDGER_DIR);
}

// ─── Utility: read ledger index ───────────────────────────────────────────────
function readLedgerIndex(ledgerDir) {
  const indexPath = path.join(ledgerDir, LEDGER_INDEX);
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return { receipts: {}, entries: [], schema_version: "1.0" };
  }
}

// ─── Public API: query token attempts with focused projection ─────────────────
//
// Options:
//   - root: project root directory
//   - filters: { attempt_id, run_id, task_id, session_id, host, model, status, since, until }
//   - options: { limit, offset, order }
//
// Returns focused projection: receipts metadata without bodies.
function queryTokenAttempts(root, filters = {}, options = {}) {
  const ledgerDir = resolveLedgerDir(root);
  const { limit = 100, offset = 0, order = "desc" } = options;

  const index = readLedgerIndex(ledgerDir);
  const entries = index.entries || [];

  // Filter entries
  let filtered = entries;
  if (filters.attempt_id) {
    filtered = filtered.filter((e) => e.attempt_id === filters.attempt_id);
  }
  if (filters.run_id) {
    filtered = filtered.filter((e) => e.run_id === filters.run_id);
  }
  if (filters.task_id) {
    filtered = filtered.filter((e) => e.task_id === filters.task_id);
  }
  if (filters.session_id) {
    filtered = filtered.filter((e) => e.session_id === filters.session_id);
  }
  if (filters.host) {
    filtered = filtered.filter((e) => e.host === filters.host);
  }
  if (filters.model) {
    filtered = filtered.filter((e) => e.model === filters.model);
  }
  if (filters.status) {
    filtered = filtered.filter((e) => e.status === filters.status);
  }

  // Time range filter
  if (filters.since || filters.until) {
    filtered = filtered.filter((e) => {
      if (!e.recorded_at) return false;
      const recordedAt = new Date(e.recorded_at).getTime();
      if (Number.isNaN(recordedAt)) return false;
      if (filters.since) {
        const sinceTime = new Date(filters.since).getTime();
        if (!Number.isNaN(sinceTime) && recordedAt < sinceTime) return false;
      }
      if (filters.until) {
        const untilTime = new Date(filters.until).getTime();
        if (!Number.isNaN(untilTime) && recordedAt > untilTime) return false;
      }
      return true;
    });
  }

  // Sort by recorded_at
  filtered.sort((a, b) => {
    const timeA = new Date(a.recorded_at || 0).getTime();
    const timeB = new Date(b.recorded_at || 0).getTime();
    return order === "asc" ? timeA - timeB : timeB - timeA;
  });

  // Paginate
  const total = filtered.length;
  const paged = filtered.slice(offset, offset + limit);

  // Map to focused projection (receipt metadata only, no bodies)
  const receipts = paged.map((entry) => {
    const receipt = entry;
    return {
      receipt_id: receipt?.receipt_id || null,
      attempt_id: receipt?.attempt_id || null,
      run_id: receipt?.run_id || null,
      task_id: receipt?.task_id || null,
      session_id: receipt?.session_id || null,
      host: receipt?.host || "unknown",
      model: receipt?.model || null,
      status: receipt?.status || "unknown",
      measurement_source: receipt?.measurement_source || "unknown",
      recorded_at: receipt?.recorded_at || null,
      appended_at: receipt.appended_at || null,
    };
  });

  return {
    ok: true,
    query: "token-attempts",
    generated_at: new Date().toISOString(),
    filters: {
      ...(filters.attempt_id ? { attempt_id: filters.attempt_id } : {}),
      ...(filters.run_id ? { run_id: filters.run_id } : {}),
      ...(filters.task_id ? { task_id: filters.task_id } : {}),
      ...(filters.session_id ? { session_id: filters.session_id } : {}),
      ...(filters.host ? { host: filters.host } : {}),
      ...(filters.model ? { model: filters.model } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.since ? { since: filters.since } : {}),
      ...(filters.until ? { until: filters.until } : {}),
    },
    pagination: {
      limit,
      offset,
      total,
      has_more: offset + limit < total,
    },
    receipts,
    summary: {
      total_receipts: total,
      unique_attempts: new Set(filtered.map((e) => e.attempt_id)).size,
      unique_runs: new Set(filtered.map((e) => e.run_id).filter(Boolean)).size,
      unique_tasks: new Set(filtered.map((e) => e.task_id).filter(Boolean)).size,
      by_host: countBy(filtered, (e) => e.host),
      by_status: countBy(filtered, (e) => e.status),
    },
  };
}

// ─── Utility: count occurrences by key ────────────────────────────────────────
function countBy(array, keyFn) {
  const counts = {};
  for (const item of array) {
    const key = keyFn(item);
    if (key) {
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

// ─── Public API: get token-attempt statistics ────────────────────────────────
function queryTokenAttemptStats(root, filters = {}) {
  const ledgerDir = resolveLedgerDir(root);
  const index = readLedgerIndex(ledgerDir);
  const entries = index.entries || [];

  // Apply filters
  let filtered = entries;
  if (filters.attempt_id) {
    filtered = filtered.filter((e) => e.attempt_id === filters.attempt_id);
  }
  if (filters.run_id) {
    filtered = filtered.filter((e) => e.run_id === filters.run_id);
  }
  if (filters.task_id) {
    filtered = filtered.filter((e) => e.task_id === filters.task_id);
  }
  if (filters.session_id) {
    filtered = filtered.filter((e) => e.session_id === filters.session_id);
  }
  if (filters.host) {
    filtered = filtered.filter((e) => e.host === filters.host);
  }
  if (filters.model) {
    filtered = filtered.filter((e) => e.model === filters.model);
  }
  if (filters.status) {
    filtered = filtered.filter((e) => e.status === filters.status);
  }
  if (filters.since || filters.until) {
    filtered = filtered.filter((e) => {
      const recordedAt = new Date(e.recorded_at || "").getTime();
      if (Number.isNaN(recordedAt)) return false;
      const since = filters.since ? new Date(filters.since).getTime() : null;
      const until = filters.until ? new Date(filters.until).getTime() : null;
      if (since !== null && !Number.isNaN(since) && recordedAt < since) return false;
      if (until !== null && !Number.isNaN(until) && recordedAt > until) return false;
      return true;
    });
  }

  // Aggregate
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  for (const entry of filtered) {
    if (entry.status !== "host_reported") continue;
    const usage = entry.usage;
    if (!usage) continue;
    if (Number.isSafeInteger(usage.host_reported_input_tokens)) {
      totals.input_tokens += usage.host_reported_input_tokens;
    }
    if (Number.isSafeInteger(usage.host_reported_output_tokens)) {
      totals.output_tokens += usage.host_reported_output_tokens;
    }
    if (Number.isSafeInteger(usage.host_reported_cache_creation_input_tokens)) {
      totals.cache_creation_input_tokens += usage.host_reported_cache_creation_input_tokens;
    }
    if (Number.isSafeInteger(usage.host_reported_cache_read_input_tokens)) {
      totals.cache_read_input_tokens += usage.host_reported_cache_read_input_tokens;
    }
  }

  return {
    ok: true,
    query: "token-attempt-stats",
    generated_at: new Date().toISOString(),
    filters,
    stats: {
      receipt_count: filtered.length,
      measured_receipt_count: filtered.filter((entry) => entry.status === "host_reported").length,
      partial_receipt_count: filtered.filter((entry) => entry.status === "host_reported"
        && Object.entries(entry.usage || {}).some(([field, value]) => field.startsWith("host_reported_")
          && value === "unknown")).length,
      unknown_receipt_count: filtered.filter((entry) => ["unknown", "unavailable"].includes(entry.status)).length,
      unique_attempts: new Set(filtered.map((e) => e.attempt_id)).size,
      by_host: countBy(filtered, (e) => e.host),
      by_status: countBy(filtered, (e) => e.status),
      by_model: countBy(filtered, (e) => e.model),
    },
    totals,
    totals_status: "host_reported",
  };
}

// ─── Public API: list distinct values for a field ─────────────────────────────
function queryDistinctField(root, field) {
  const ledgerDir = resolveLedgerDir(root);
  const index = readLedgerIndex(ledgerDir);
  const entries = index.entries || [];

  const validFields = ["attempt_id", "run_id", "task_id", "session_id", "host", "model", "status"];
  if (!validFields.includes(field)) {
    return { ok: false, error: "invalid_field", reason: `Field must be one of: ${validFields.join(", ")}` };
  }

  const values = new Set();
  for (const entry of entries) {
    const value = entry[field];
    if (value) {
      values.add(value);
    }
  }

  return {
    ok: true,
    query: "token-attempt-distinct",
    field,
    values: Array.from(values).sort(),
    count: values.size,
  };
}

// ─── Public API: check if ledger has receipts ─────────────────────────────────
function hasReceipts(root) {
  const ledgerDir = resolveLedgerDir(root);
  const index = readLedgerIndex(ledgerDir);
  return (index.entries || []).length > 0;
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  resolveLedgerDir,
  queryTokenAttempts,
  queryTokenAttemptStats,
  queryDistinctField,
  hasReceipts,
};
