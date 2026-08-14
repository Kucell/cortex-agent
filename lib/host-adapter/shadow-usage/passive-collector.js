"use strict";

// ─── shadow-usage passive collector (M-025/MS-003 Phase A) ─────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Zero-dependency passive collector that:
//   1. Accepts already-sanitized public usage envelopes from existing adapters.
//   2. Joins quality dimensions via allowlisted Task/Run IDs.
//   3. Reuses MS-001/MS-002 receipt contract and ledger writer.
//   4. Exposes focused Management API readiness queries.
//
// Design rules:
//   - Passive: never calls Host directly; accepts pre-sanitized envelopes.
//   - Deterministic: same input always produces same output.
//   - Closed-world: only allowlisted Task/Run IDs qualify for quality joins.
//   - Explicit exclusion: every excluded receipt carries a named reason.
//   - Zero new dependencies: only node:fs / node:path / node:crypto.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Reuse MS-001/MS-002 contracts
const {
  createHostReceipt,
  receiptIdFor,
  ShadowUsageError,
  TOKEN_FIELDS,
} = require("./index.js");

// Reuse MS-001/MS-002 ledger writer
const ledger = require("../../../templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js");

// ─── Default collector config for receipt creation ─────────────────────────────
// Accepts all valid token usage fields without aliases (for already-sanitized envelopes)
const DEFAULT_COLLECTOR_USAGE_FIELDS = new Set([
  ...TOKEN_FIELDS,
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "reasoning_output_tokens",
]);

const DEFAULT_COLLECTOR_TOP_FIELDS = new Set([
  ...DEFAULT_COLLECTOR_USAGE_FIELDS,
  "usage",
  "type",
  "model",
  "timestamp",
  "status",
]);

const DEFAULT_COLLECTOR_ALIASES = Object.freeze({
  input_tokens: Object.freeze(["input"]),
  output_tokens: Object.freeze(["output"]),
  cache_creation_input_tokens: Object.freeze(["cacheWrite", "cache_write_input_tokens"]),
  cache_read_input_tokens: Object.freeze(["cacheRead", "cached_input_tokens"]),
});

/**
 * Get or create a config for a specific host
 * @param {string} hostId
 * @param {CollectorConfig} collectorConfig
 * @returns {Object}
 */
function getHostConfig(hostId, collectorConfig) {
  // Use collector's hostId if no specific host
  const effectiveHostId = hostId || collectorConfig.hostId;
  return Object.freeze({
    hostId: effectiveHostId,
    sourceId: effectiveHostId,
    allowedTopFields: DEFAULT_COLLECTOR_TOP_FIELDS,
    allowedUsageFields: DEFAULT_COLLECTOR_USAGE_FIELDS,
    aliases: DEFAULT_COLLECTOR_ALIASES,
  });
}

// ─── Exclusion reason codes ───────────────────────────────────────────────────
const EXCLUSION_REASONS = Object.freeze({
  NO_QUALITY_ID: "no_quality_id",
  TASK_ID_NOT_ALLOWLISTED: "task_id_not_allowlisted",
  RUN_ID_NOT_ALLOWLISTED: "run_id_not_allowlisted",
  TEST_HOST: "test_host",
  TEST_ATTEMPT: "test_attempt",
  DUPLICATE_RECEIPT: "duplicate_receipt",
  LEDGER_WRITE_FAILED: "ledger_write_failed",
  INVALID_ENVELOPE: "invalid_envelope",
});

const TEST_HOST_PATTERNS = Object.freeze([
  /^test/i,
  /^mock/i,
  /^fake/i,
  /^dummy/i,
  /unit[-_]?test/i,
  /integration[-_]?test/i,
  /e2e[-_]?test/i,
]);

const TEST_ATTEMPT_PREFIXES = Object.freeze([
  "test-",
  "mock-",
  "fake-",
  "dummy-",
  "unit-test-",
  "integration-test-",
  "e2e-test-",
  "attempt-test-",
  "attempt-mock-",
]);

// ─── Quality dimension allowlist ───────────────────────────────────────────────
const DEFAULT_QUALITY_ALLOWLIST = Object.freeze(new Set());

/**
 * @typedef {Object} CollectorConfig
 * @property {string} [hostId="passive-collector"] - Collector host identifier
 * @property {Set<string>} [taskIdAllowlist] - Allowlisted task IDs for quality join
 * @property {Set<string>} [runIdAllowlist] - Allowlisted run IDs for quality join
 * @property {boolean} [requireEitherId=false] - Require at least one quality ID present
 */

/**
 * @typedef {Object} PublicEnvelope
 * @property {string} attempt_id - Unique attempt identifier
 * @property {string|undefined} task_id - Task identifier (optional)
 * @property {string|undefined} run_id - Run identifier (optional)
 * @property {string} host - Source host identifier
 * @property {string|undefined} model - Model identifier (optional)
 * @property {Object} raw_usage - Already-sanitized token usage
 * @property {string} [receipt_id] - Optional pre-computed receipt ID
 * @property {string} [delivery_id] - Delivery sequence ID
 * @property {string} [recorded_at] - ISO timestamp
 */

/**
 * @typedef {Object} CollectedReceipt
 * @property {Object} receipt - Token-attempt receipt
 * @property {string} quality_join - Quality join decision (joined|skipped)
 * @property {string|null} task_id - Joined task ID or null
 * @property {string|null} run_id - Joined run ID or null
 * @property {string|null} exclusion_reason - Reason for exclusion or null
 */

/**
 * @typedef {Object} ReadinessQuery
 * @property {string} [host] - Filter by host
 * @property {string} [model] - Filter by model
 * @property {string} [since] - ISO timestamp start (inclusive)
 * @property {string} [until] - ISO timestamp end (inclusive)
 * @property {boolean} [excludeTests=true] - Exclude test receipts
 */

/**
 * @typedef {Object} EligibilityStats
 * @property {number} eligible_count - Number of eligible receipts
 * @property {number} excluded_count - Number of excluded receipts
 * @property {Object.<string, number>} by_exclusion_reason - Count by exclusion reason
 * @property {Object.<string, Object.<string, number>>} by_host_day_model - Breakdown
 */

class PassiveCollector {
  /**
   * @param {CollectorConfig} [options={}]
   */
  constructor(options = {}) {
    /** @type {CollectorConfig} */
    this.config = Object.freeze({
      hostId: options.hostId || "passive-collector",
      taskIdAllowlist: options.taskIdAllowlist || DEFAULT_QUALITY_ALLOWLIST,
      runIdAllowlist: options.runIdAllowlist || DEFAULT_QUALITY_ALLOWLIST,
      requireEitherId: options.requireEitherId || false,
    });
    /** @type {string|null} */
    this._lastError = null;

    // Freeze the instance
    Object.freeze(this);
  }

  /**
   * Check if a task ID is in the allowlist (or allowlist is empty/unrestricted)
   * @param {string|null|undefined} taskId
   * @returns {boolean}
   */
  isTaskIdAllowlisted(taskId) {
    if (!taskId) return false;
    const { taskIdAllowlist } = this.config;
    if (!taskIdAllowlist || taskIdAllowlist.size === 0) return true;
    return taskIdAllowlist.has(taskId);
  }

  /**
   * Check if a run ID is in the allowlist (or allowlist is empty/unrestricted)
   * @param {string|null|undefined} runId
   * @returns {boolean}
   */
  isRunIdAllowlisted(runId) {
    if (!runId) return false;
    const { runIdAllowlist } = this.config;
    if (!runIdAllowlist || runIdAllowlist.size === 0) return true;
    return runIdAllowlist.has(runId);
  }

  /**
   * Check if the host appears to be a test host
   * @param {string} host
   * @returns {boolean}
   */
  isTestHost(host) {
    if (!host || typeof host !== "string") return false;
    return TEST_HOST_PATTERNS.some((pattern) => pattern.test(host));
  }

  /**
   * Check if the attempt ID appears to be a test attempt
   * @param {string} attemptId
   * @returns {boolean}
   */
  isTestAttempt(attemptId) {
    if (!attemptId || typeof attemptId !== "string") return false;
    return TEST_ATTEMPT_PREFIXES.some((prefix) => attemptId.startsWith(prefix));
  }

  /**
   * Determine exclusion reason for a public envelope
   * @param {PublicEnvelope} envelope
   * @returns {string|null} Exclusion reason or null if eligible
   */
  getExclusionReason(envelope) {
    if (!envelope || typeof envelope !== "object") {
      return EXCLUSION_REASONS.INVALID_ENVELOPE;
    }

    const { attempt_id, task_id, run_id, host } = envelope;

    // Check attempt_id presence
    if (!attempt_id || typeof attempt_id !== "string" || attempt_id.length === 0) {
      return EXCLUSION_REASONS.INVALID_ENVELOPE;
    }

    // Check for test host
    if (host && this.isTestHost(host)) {
      return EXCLUSION_REASONS.TEST_HOST;
    }

    // Check for test attempt
    if (this.isTestAttempt(attempt_id)) {
      return EXCLUSION_REASONS.TEST_ATTEMPT;
    }

    // Check quality ID presence
    const hasTaskId = Boolean(task_id && typeof task_id === "string" && task_id.length > 0);
    const hasRunId = Boolean(run_id && typeof run_id === "string" && run_id.length > 0);

    if (!hasTaskId && !hasRunId) {
      if (this.config.requireEitherId) {
        return EXCLUSION_REASONS.NO_QUALITY_ID;
      }
      // Not excluded if requireEitherId is false and no IDs present
      return null;
    }

    // Check allowlist membership
    if (hasTaskId && !this.isTaskIdAllowlisted(task_id)) {
      return EXCLUSION_REASONS.TASK_ID_NOT_ALLOWLISTED;
    }

    if (hasRunId && !this.isRunIdAllowlisted(run_id)) {
      return EXCLUSION_REASONS.RUN_ID_NOT_ALLOWLISTED;
    }

    return null;
  }

  /**
   * Check if a public envelope is eligible for collection
   * @param {PublicEnvelope} envelope
   * @returns {boolean}
   */
  isEligible(envelope) {
    return this.getExclusionReason(envelope) === null;
  }

  /**
   * Collect a single public envelope
   * @param {PublicEnvelope} envelope
   * @returns {CollectedReceipt}
   */
  collect(envelope) {
    const exclusionReason = this.getExclusionReason(envelope);

    /** @type {CollectedReceipt} */
    const result = {
      receipt: null,
      quality_join: "skipped",
      task_id: envelope.task_id || null,
      run_id: envelope.run_id || null,
      exclusion_reason: exclusionReason,
    };

    if (exclusionReason !== null) {
      // Not eligible; return result without receipt
      return result;
    }

    // Eligible: create receipt using existing contract
    try {
      const receipt = this._createReceipt(envelope);
      result.receipt = receipt;
      result.quality_join = "joined";
      return result;
    } catch (error) {
      result.exclusion_reason = EXCLUSION_REASONS.LEDGER_WRITE_FAILED;
      this._lastError = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  /**
   * Create a receipt from a public envelope
   * @param {PublicEnvelope} envelope
   * @returns {Object}
   * @private
   */
  _createReceipt(envelope) {
    const { attempt_id, task_id, run_id, host, model, raw_usage, receipt_id, delivery_id, recorded_at, session_id } = envelope;

    // Use host config that accepts all valid token usage fields
    const hostConfig = getHostConfig(host, this.config);
    return createHostReceipt(hostConfig, {
      attempt_id,
      task_id,
      run_id,
      session_id,
      model,
      receipt_id,
      delivery_id,
      recorded_at,
      raw_usage,
    });
  }

  /**
   * Append a collected receipt to the ledger
   * @param {string} ledgerDir
   * @param {Object} receipt
   * @returns {{ok: boolean, isDuplicate?: boolean, error?: string}}
   */
  appendToLedger(ledgerDir, receipt) {
    if (!receipt) {
      return { ok: false, error: "receipt_required" };
    }
    try {
      return ledger.appendReceipt(ledgerDir, receipt);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Collect and persist a public envelope
   * @param {string} ledgerDir
   * @param {PublicEnvelope} envelope
   * @returns {{ok: boolean, collected: CollectedReceipt, ledger?: Object, error?: string}}
   */
  collectAndPersist(ledgerDir, envelope) {
    const collected = this.collect(envelope);

    if (!collected.receipt) {
      return {
        ok: false,
        collected,
        error: collected.exclusion_reason,
      };
    }

    const ledgerResult = this.appendToLedger(ledgerDir, collected.receipt);

    // Duplicates are successful: the receipt is already in the ledger
    if (ledgerResult.isDuplicate === true) {
      return {
        ok: true,
        collected,
        ledger: ledgerResult,
      };
    }

    // Actual errors
    if (!ledgerResult.ok) {
      return {
        ok: false,
        collected,
        error: ledgerResult.error,
      };
    }

    return {
      ok: true,
      collected,
      ledger: ledgerResult,
    };
  }

  /**
   * Query eligible non-test receipt counts by Host/day/model
   * @param {string} ledgerDir
   * @param {ReadinessQuery} query
   * @returns {EligibilityStats}
   */
  queryReadiness(ledgerDir, query = {}) {
    const { host, model, since, until, excludeTests = true } = query;

    // Get all receipts from ledger
    let receipts = ledger.queryReceipts(ledgerDir, { host, model, since, until });

    // Apply exclusion filters
    const stats = {
      eligible_count: 0,
      excluded_count: 0,
      by_exclusion_reason: {},
      by_host_day_model: {},
    };

    for (const receipt of receipts) {
      const receiptHost = receipt.host || "unknown";
      const receiptModel = receipt.model || "unknown";
      const dateKey = this._dateKey(receipt.recorded_at);

      // Check if this receipt would be excluded
      const exclusionReason = this._getExclusionReasonForLedgerReceipt(receipt, excludeTests);

      const dimensionKey = `${receiptHost}::${dateKey}::${receiptModel}`;

      if (exclusionReason) {
        stats.excluded_count += 1;
        stats.by_exclusion_reason[exclusionReason] = (stats.by_exclusion_reason[exclusionReason] || 0) + 1;
        // Still track in by_host_day_model for visibility
        if (!stats.by_host_day_model[dimensionKey]) {
          stats.by_host_day_model[dimensionKey] = { eligible: 0, excluded: 0, reason: {} };
        }
        stats.by_host_day_model[dimensionKey].excluded += 1;
        stats.by_host_day_model[dimensionKey].reason[exclusionReason] =
          (stats.by_host_day_model[dimensionKey].reason[exclusionReason] || 0) + 1;
      } else {
        stats.eligible_count += 1;
        if (!stats.by_host_day_model[dimensionKey]) {
          stats.by_host_day_model[dimensionKey] = { eligible: 0, excluded: 0, reason: {} };
        }
        stats.by_host_day_model[dimensionKey].eligible += 1;
      }
    }

    return Object.freeze(stats);
  }

  /**
   * Get exclusion reason for a ledger receipt (reconstructed from stored data)
   * @param {Object} receipt
   * @param {boolean} excludeTests
   * @returns {string|null}
   * @private
   */
  _getExclusionReasonForLedgerReceipt(receipt, excludeTests) {
    const attemptId = receipt.attempt_id || "";
    const host = receipt.host || "";
    const taskId = receipt.task_id;
    const runId = receipt.run_id;

    if (excludeTests) {
      if (this.isTestHost(host)) {
        return EXCLUSION_REASONS.TEST_HOST;
      }
      if (this.isTestAttempt(attemptId)) {
        return EXCLUSION_REASONS.TEST_ATTEMPT;
      }
    }

    const hasTaskId = Boolean(taskId && typeof taskId === "string" && taskId.length > 0);
    const hasRunId = Boolean(runId && typeof runId === "string" && runId.length > 0);

    if (!hasTaskId && !hasRunId) {
      if (this.config.requireEitherId) {
        return EXCLUSION_REASONS.NO_QUALITY_ID;
      }
      return null;
    }

    if (hasTaskId && !this.isTaskIdAllowlisted(taskId)) {
      return EXCLUSION_REASONS.TASK_ID_NOT_ALLOWLISTED;
    }

    if (hasRunId && !this.isRunIdAllowlisted(runId)) {
      return EXCLUSION_REASONS.RUN_ID_NOT_ALLOWLISTED;
    }

    return null;
  }

  /**
   * Extract date key (YYYY-MM-DD) from ISO timestamp
   * @param {string} recordedAt
   * @returns {string}
   * @private
   */
  _dateKey(recordedAt) {
    if (!recordedAt) return "unknown";
    try {
      const date = new Date(recordedAt);
      if (Number.isNaN(date.getTime())) return "unknown";
      return date.toISOString().slice(0, 10);
    } catch {
      return "unknown";
    }
  }

  /**
   * Get last error message
   * @returns {string|null}
   */
  getLastError() {
    return this._lastError;
  }

  /**
   * Get collector config
   * @returns {CollectorConfig}
   */
  getConfig() {
    return this.config;
  }
}

/**
 * Create a passive collector instance
 * @param {CollectorConfig} [options]
 * @returns {PassiveCollector}
 */
function createPassiveCollector(options) {
  return new PassiveCollector(options);
}

// Freeze the PassiveCollector prototype (class-level immutability)
Object.freeze(PassiveCollector.prototype);
Object.freeze(PassiveCollector);

/**
 * Get exclusion reason display name
 * @param {string} reasonCode
 * @returns {string}
 */
function exclusionReasonLabel(reasonCode) {
  const labels = {
    [EXCLUSION_REASONS.NO_QUALITY_ID]: "No quality identifier (task_id or run_id) present",
    [EXCLUSION_REASONS.TASK_ID_NOT_ALLOWLISTED]: "Task ID not in quality allowlist",
    [EXCLUSION_REASONS.RUN_ID_NOT_ALLOWLISTED]: "Run ID not in quality allowlist",
    [EXCLUSION_REASONS.TEST_HOST]: "Test host detected",
    [EXCLUSION_REASONS.TEST_ATTEMPT]: "Test attempt detected",
    [EXCLUSION_REASONS.DUPLICATE_RECEIPT]: "Duplicate receipt (idempotency check)",
    [EXCLUSION_REASONS.LEDGER_WRITE_FAILED]: "Ledger write operation failed",
    [EXCLUSION_REASONS.INVALID_ENVELOPE]: "Invalid envelope format",
  };
  return labels[reasonCode] || `Unknown reason: ${reasonCode}`;
}

/**
 * List all known exclusion reasons
 * @returns {string[]}
 */
function listExclusionReasons() {
  return Object.values(EXCLUSION_REASONS);
}

module.exports = {
  EXCLUSION_REASONS,
  PassiveCollector,
  createPassiveCollector,
  exclusionReasonLabel,
  listExclusionReasons,
  TEST_HOST_PATTERNS,
  TEST_ATTEMPT_PREFIXES,
};
