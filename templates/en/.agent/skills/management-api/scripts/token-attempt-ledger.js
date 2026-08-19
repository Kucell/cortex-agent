"use strict";

// ─── token-attempt-ledger (L1 management-api — append-only/idempotent ledger) ─
// ─────────────────────────────────────────────────────────────────────────────────
// Single-purpose pure functions that:
//   1. Manage an append-only ledger of token-attempt receipts.
//   2. Ensure idempotency via composite key (attempt_id + receipt_id).
//   3. Handle missing, partial, dirty, oversized, and out-of-order receipts.
//   4. Never modify existing entries; only append new ones.
//
// Design rules (per M-025/MS-001):
//   - Ledger is append-only: existing entries are never modified.
//   - Idempotency: duplicate (attempt_id, receipt_id) pairs are detected and ignored.
//   - Missing receipt: missing fields default to unknown/unavailable.
//   - Partial receipt: partial data is accepted with explicit unknown fields.
//   - Dirty receipt: dirty data is normalized via token-attempt-receipt.js.
//   - Oversized receipt: oversized receipts are rejected.
//   - Out-of-order receipt: out-of-order receipts are rejected with deterministic error.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  createTokenAttemptReceipt,
  validateReceiptContract,
  validateReceiptSecurity,
  validateReceiptSize,
  sanitizeHostPayload,
  isOutOfOrderReceipt,
  generateReceiptId,
  USAGE_STATUS,
} = require("./token-attempt-receipt.js");

// ─── Ledger storage path ───────────────────────────────────────────────────────
const LEDGER_DIR = ".agent/token-attempts";
const LEDGER_INDEX = "ledger-index.json";
const RECEIPTS_DIR = "receipts";
const LEDGER_LOCK = ".ledger-write.lock";
const RECOVERY_LOCK = ".ledger-recovery.lock";
const RECOVERY_LOG = "recovery-events.jsonl";
const LOCK_RETRIES = 200;
const LOCK_RETRY_MS = 10;

// ─── Ledger entry shape ───────────────────────────────────────────────────────
function createLedgerEntry(receipt, metadata = {}) {
  return {
    receipt,
    metadata: {
      ...metadata,
      appended_at: new Date().toISOString(),
      ledger_version: "1.0",
    },
  };
}

// ─── Public API: compute idempotency key ──────────────────────────────────────
function computeIdempotencyKey(receipt) {
  if (!receipt) throw new Error("Receipt is required for idempotency key");
  const attempt_id = receipt.attempt_id || "";
  const receipt_id = receipt.receipt_id || "";
  return `${attempt_id}::${receipt_id}`;
}

function receiptFile(ledgerDir, receipt) {
  const digest = crypto.createHash("sha256")
    .update(computeIdempotencyKey(receipt))
    .digest("hex");
  return path.join(ledgerDir, RECEIPTS_DIR, `${digest}.json`);
}

// ─── Public API: check if receipt already exists in index ─────────────────────
function receiptExists(ledgerDir, receipt) {
  return fs.existsSync(receiptFile(ledgerDir, receipt));
}

function equivalentReceiptBody(left, right) {
  if (!left || !right) return false;
  const { recorded_at: leftRecordedAt, ...leftBody } = left;
  const { recorded_at: rightRecordedAt, ...rightBody } = right;
  return JSON.stringify(leftBody) === JSON.stringify(rightBody);
}

function readLedgerIndex(indexPath) {
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { receipts: {}, entries: [], schema_version: "1.0" };
    }
    throw new Error(`token_attempt_ledger_index_invalid: ${error.message}`);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function releaseOwnedLock(lockPath, ownerRaw) {
  try {
    if (fs.readFileSync(lockPath, "utf8") === ownerRaw) fs.unlinkSync(lockPath);
  } catch {
    // Missing or replaced lock is not ours to remove.
  }
}

function withLedgerLock(ledgerDir, callback) {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const lockPath = path.join(ledgerDir, LEDGER_LOCK);
  const ownerRaw = JSON.stringify({
    pid: process.pid,
    token: crypto.randomBytes(16).toString("hex"),
    acquired_at: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, ownerRaw, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        return callback();
      } finally {
        releaseOwnedLock(lockPath, ownerRaw);
      }
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      // Never infer that a lock is stale and unlink it here. A prior observer
      // can otherwise delete a new owner's lock between inspection and unlink,
      // admitting concurrent index writers. Bounded wait + fail-closed keeps
      // the ledger safe; stale-lock recovery requires an explicit owner flow.
      sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("token_attempt_ledger_lock_timeout");
}

function recoverLedgerLock(ledgerDir, options = {}) {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const lockPath = path.join(ledgerDir, LEDGER_LOCK);
  const recoveryPath = path.join(ledgerDir, RECOVERY_LOCK);
  const recoveryOwner = JSON.stringify({
    pid: process.pid,
    token: crypto.randomBytes(16).toString("hex"),
    acquired_at: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(recoveryPath, recoveryOwner, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return { ok: false, error: "ledger_recovery_busy", reason: "Another recovery owns the recovery lock" };
    }
    return { ok: false, error: "ledger_recovery_failed", reason: error.message };
  }

  try {
    let observedRaw;
    try {
      observedRaw = fs.readFileSync(lockPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, recovered: false, reason: "lock_not_found" };
      return { ok: false, error: "ledger_recovery_failed", reason: error.message };
    }
    let ownerPid;
    try {
      ownerPid = JSON.parse(observedRaw).pid;
    } catch {
      ownerPid = Number.parseInt(observedRaw.trim(), 10);
    }
    if (isProcessAlive(ownerPid)) {
      return { ok: false, error: "ledger_lock_active", reason: "Ledger lock owner is still active" };
    }
    if (fs.readFileSync(lockPath, "utf8") !== observedRaw) {
      return { ok: false, error: "ledger_lock_changed", reason: "Ledger lock owner changed during recovery" };
    }
    const recoveryId = `TLR-${crypto.randomBytes(12).toString("hex")}`;
    const auditPath = path.join(ledgerDir, RECOVERY_LOG);
    const intent = {
      event: "ledger_lock_recovery_intent",
      recovery_id: recoveryId,
      recorded_at: new Date().toISOString(),
      previous_owner_pid: Number.isInteger(ownerPid) ? ownerPid : null,
      recovered_by: options.recoveredBy || "explicit",
      recovered_by_pid: process.pid,
    };
    fs.appendFileSync(auditPath, `${JSON.stringify(intent)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.unlinkSync(lockPath);
    const event = {
      event: "ledger_lock_recovered",
      recovery_id: recoveryId,
      recovered_at: new Date().toISOString(),
      previous_owner_pid: intent.previous_owner_pid,
      recovered_by: intent.recovered_by,
      recovered_by_pid: process.pid,
    };
    try {
      fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      return { ok: true, recovered: true, audit_status: "completed", event };
    } catch (error) {
      return {
        ok: true,
        recovered: true,
        audit_status: "intent_only",
        warning: `ledger_recovery_completion_audit_failed: ${error.message}`,
        event: intent,
      };
    }
  } catch (error) {
    return { ok: false, error: "ledger_recovery_failed", reason: error.message };
  } finally {
    releaseOwnedLock(recoveryPath, recoveryOwner);
  }
}

// ─── Public API: append receipt to ledger ────────────────────────────────────
//
// Options:
//   - ledgerDir: directory for ledger storage
//   - receipt: token-attempt receipt object
//   - options: { allowOutOfOrder: boolean, maxSizeBytes: number }
//
// Returns:
//   - { ok: true, entry, isDuplicate: boolean } on success
//   - { ok: false, error: string, reason: string } on failure
function appendReceipt(ledgerDir, receipt, options = {}) {
  const {
    allowOutOfOrder = false,
    maxSizeBytes = 65536,
  } = options;

  // Step 1: Validate receipt shape
  if (!receipt || typeof receipt !== "object") {
    return { ok: false, error: "invalid_receipt", reason: "Receipt must be an object" };
  }

  // Step 2: Validate size before inspecting individual fields.
  const sizeCheck = validateReceiptSize(receipt, maxSizeBytes);
  if (!sizeCheck.valid) {
    return { ok: false, error: "oversized_receipt", reason: sizeCheck.reason };
  }

  // Step 3: Validate security (blocked fields, credentials, private paths).
  const securityCheck = validateReceiptSecurity(receipt);
  if (!securityCheck.valid) {
    return { ok: false, error: "security_violation", reason: securityCheck.reason };
  }

  // Step 4: Validate the versioned contract before persistence.
  const contractCheck = validateReceiptContract(receipt);
  if (!contractCheck.valid) {
    return { ok: false, error: "invalid_receipt", reason: contractCheck.reason };
  }

  try {
    return withLedgerLock(ledgerDir, () => {
      const indexPath = path.join(ledgerDir, LEDGER_INDEX);
      const index = readLedgerIndex(indexPath);
      index.receipts = index.receipts || {};
      index.entries = index.entries || [];

      const key = computeIdempotencyKey(receipt);
      const immutableFile = receiptFile(ledgerDir, receipt);
      if (index.receipts[key] !== undefined) {
        if (!fs.existsSync(immutableFile)) {
          return { ok: false, error: "ledger_corrupt", reason: "Indexed receipt body is missing" };
        }
        const persisted = JSON.parse(fs.readFileSync(immutableFile, "utf8"));
        if (!equivalentReceiptBody(persisted.receipt, receipt)) {
          return {
            ok: false,
            error: "idempotency_conflict",
            reason: "Immutable receipt body does not match replay payload",
          };
        }
        return { ok: false, error: "duplicate_receipt", reason: "Receipt already exists", isDuplicate: true };
      }
      if (!allowOutOfOrder && isOutOfOrderReceipt(receipt, index.entries)) {
        return { ok: false, error: "out_of_order_receipt", reason: "Receipt timestamp is older than existing entry" };
      }

      const entry = createLedgerEntry(receipt);
      fs.mkdirSync(path.dirname(immutableFile), { recursive: true });
      if (fs.existsSync(immutableFile)) {
        const persisted = JSON.parse(fs.readFileSync(immutableFile, "utf8"));
        if (!equivalentReceiptBody(persisted.receipt, receipt)) {
          return {
            ok: false,
            error: "idempotency_conflict",
            reason: "Immutable receipt body does not match replay payload",
          };
        }
      } else {
        fs.writeFileSync(immutableFile, `${JSON.stringify(entry, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }

      const summary = {
        receipt_id: receipt.receipt_id,
        attempt_id: receipt.attempt_id,
        run_id: receipt.run_id || null,
        task_id: receipt.task_id || null,
        session_id: receipt.session_id || null,
        host: receipt.host || "unknown",
        model: receipt.model || null,
        status: receipt.status,
        measurement_source: receipt.measurement_source,
        recorded_at: receipt.recorded_at,
        appended_at: entry.metadata.appended_at,
        usage: receipt.usage,
      };
      index.receipts[key] = summary;
      index.entries.push(summary);
      index.updated_at = new Date().toISOString();

      const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
        fs.renameSync(tempPath, indexPath);
      } finally {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        }
      }
      return { ok: true, entry, isDuplicate: false };
    });
  } catch (error) {
    return { ok: false, error: "ledger_write_failed", reason: error.message };
  }
}

// ─── Public API: append a batch of receipts to the ledger ───────────────────
//
// Batch variant of `appendReceipt`. Validates every receipt upfront, then
// acquires the ledger lock ONCE and rewrites the index ONCE. This collapses
// the per-receipt index load + temp-write + rename into a single round trip,
// which is the difference between minutes and seconds for a 20k-row backfill.
//
// Behaviour (per receipt):
//   - new         → written to receipts/<hash>.json + appended to index
//   - duplicate   → skipped, returns isDuplicate=true
//   - corrupt     → skipped, returns ledger_corrupt
//   - conflict    → skipped, returns idempotency_conflict
//   - out-of-order → skipped unless allowOutOfOrder=true
//
// Returns:
//   { ok: true, results: [...], written, duplicates, errors, total }
//   { ok: false, error, reason, index } on pre-flight validation failure
function appendReceiptBatch(ledgerDir, receipts, options = {}) {
  const {
    allowOutOfOrder = false,
    maxSizeBytes = 65536,
  } = options;

  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { ok: false, error: "invalid_batch", reason: "Receipts must be a non-empty array" };
  }

  // Step 1: Pre-validate every receipt (size, security, contract).
  // We abort the whole batch on the first failure so partial writes can't
  // produce a half-applied state that the caller has to reconcile.
  const validated = [];
  for (let i = 0; i < receipts.length; i += 1) {
    const receipt = receipts[i];
    if (!receipt || typeof receipt !== "object") {
      return { ok: false, error: "invalid_receipt", reason: "Receipt must be an object", index: i };
    }
    const sizeCheck = validateReceiptSize(receipt, maxSizeBytes);
    if (!sizeCheck.valid) {
      return { ok: false, error: "oversized_receipt", reason: sizeCheck.reason, index: i };
    }
    const securityCheck = validateReceiptSecurity(receipt);
    if (!securityCheck.valid) {
      return { ok: false, error: "security_violation", reason: securityCheck.reason, index: i };
    }
    const contractCheck = validateReceiptContract(receipt);
    if (!contractCheck.valid) {
      return { ok: false, error: "invalid_receipt", reason: contractCheck.reason, index: i };
    }
    validated.push({ index: i, receipt });
  }

  // Step 2: Acquire lock once, read index once, write index once.
  try {
    return withLedgerLock(ledgerDir, () => {
      const indexPath = path.join(ledgerDir, LEDGER_INDEX);
      const index = readLedgerIndex(indexPath);
      index.receipts = index.receipts || {};
      index.entries = index.entries || [];

      const results = [];
      let writtenCount = 0;
      let duplicateCount = 0;
      let errorCount = 0;
      let indexChanged = false;

      for (const item of validated) {
        const { index: receiptIndex, receipt } = item;
        const key = computeIdempotencyKey(receipt);
        const immutableFile = receiptFile(ledgerDir, receipt);

        if (index.receipts[key] !== undefined) {
          if (!fs.existsSync(immutableFile)) {
            results.push({ ok: false, error: "ledger_corrupt", reason: "Indexed receipt body is missing", index: receiptIndex, isDuplicate: false });
            errorCount += 1;
            continue;
          }
          const persisted = JSON.parse(fs.readFileSync(immutableFile, "utf8"));
          if (!equivalentReceiptBody(persisted.receipt, receipt)) {
            results.push({ ok: false, error: "idempotency_conflict", reason: "Immutable receipt body does not match replay payload", index: receiptIndex, isDuplicate: false });
            errorCount += 1;
            continue;
          }
          results.push({ ok: false, error: "duplicate_receipt", reason: "Receipt already exists", index: receiptIndex, isDuplicate: true });
          duplicateCount += 1;
          continue;
        }

        if (!allowOutOfOrder && isOutOfOrderReceipt(receipt, index.entries)) {
          results.push({ ok: false, error: "out_of_order_receipt", reason: "Receipt timestamp is older than existing entry", index: receiptIndex, isDuplicate: false });
          errorCount += 1;
          continue;
        }

        const entry = createLedgerEntry(receipt);
        fs.mkdirSync(path.dirname(immutableFile), { recursive: true });
        if (fs.existsSync(immutableFile)) {
          const persisted = JSON.parse(fs.readFileSync(immutableFile, "utf8"));
          if (!equivalentReceiptBody(persisted.receipt, receipt)) {
            results.push({ ok: false, error: "idempotency_conflict", reason: "Immutable receipt body does not match replay payload", index: receiptIndex, isDuplicate: false });
            errorCount += 1;
            continue;
          }
        } else {
          fs.writeFileSync(immutableFile, `${JSON.stringify(entry, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        }

        const summary = {
          receipt_id: receipt.receipt_id,
          attempt_id: receipt.attempt_id,
          run_id: receipt.run_id || null,
          task_id: receipt.task_id || null,
          session_id: receipt.session_id || null,
          host: receipt.host || "unknown",
          model: receipt.model || null,
          status: receipt.status,
          measurement_source: receipt.measurement_source,
          recorded_at: receipt.recorded_at,
          appended_at: entry.metadata.appended_at,
          usage: receipt.usage,
        };
        index.receipts[key] = summary;
        index.entries.push(summary);
        indexChanged = true;
        writtenCount += 1;
        results.push({ ok: true, entry, isDuplicate: false, index: receiptIndex });
      }

      if (indexChanged) {
        index.updated_at = new Date().toISOString();
        const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          fs.writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
          fs.renameSync(tempPath, indexPath);
        } finally {
          if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
          }
        }
      }

      return {
        ok: true,
        total: receipts.length,
        written: writtenCount,
        duplicates: duplicateCount,
        errors: errorCount,
        results,
      };
    });
  } catch (error) {
    return { ok: false, error: "ledger_write_failed", reason: error.message };
  }
}

// ─── Public API: process raw host payload into receipt and append ─────────────
//
// This is the main entry point for host adapters to submit token usage.
//
// Options:
//   - ledgerDir: directory for ledger storage
//   - attempt_id: attempt identifier
//   - host: source host name
//   - raw_usage: raw usage object from host
//   - options: { status, model, run_id, task_id, session_id, status_reason, allowOutOfOrder }
function submitTokenUsage(ledgerDir, attempt_id, host, raw_usage, options = {}) {
  const {
    status = USAGE_STATUS.HOST_REPORTED,
    model = null,
    run_id = null,
    task_id = null,
    session_id = null,
    status_reason = null,
    allowOutOfOrder = false,
    maxSizeBytes = 65536,
  } = options;

  // Step 1: Sanitize host payload (strip unknown fields)
  const sanitized = sanitizeHostPayload(raw_usage);

  // Step 2: Generate receipt_id for idempotency
  const receipt_id = options.receipt_id || generateReceiptId(attempt_id, host);

  // Step 3: Create normalized receipt
  let receipt;
  try {
    receipt = createTokenAttemptReceipt({
      attempt_id,
      receipt_id,
      run_id,
      task_id,
      session_id,
      host,
      model,
      status,
      raw_usage: sanitized,
      status_reason,
    });
  } catch (error) {
    return { ok: false, error: "receipt_creation_failed", reason: error.message };
  }

  // Step 4: Append to ledger
  return appendReceipt(ledgerDir, receipt, { allowOutOfOrder, maxSizeBytes });
}

// ─── Public API: read receipts by filter ─────────────────────────────────────
//
// Options:
//   - ledgerDir: directory for ledger storage
//   - filters: { attempt_id, run_id, task_id, session_id, host, model, status, since, until }
//
// Returns: array of ledger entries (not receipt bodies, just metadata + filters)
function queryReceipts(ledgerDir, filters = {}) {
  const indexPath = path.join(ledgerDir, LEDGER_INDEX);
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entries = index.entries || [];

    return entries.filter((entry) => {
      const receipt = entry;

      // Apply filters
      if (filters.attempt_id && receipt.attempt_id !== filters.attempt_id) return false;
      if (filters.run_id && receipt.run_id !== filters.run_id) return false;
      if (filters.task_id && receipt.task_id !== filters.task_id) return false;
      if (filters.session_id && receipt.session_id !== filters.session_id) return false;
      if (filters.host && receipt.host !== filters.host) return false;
      if (filters.model && receipt.model !== filters.model) return false;
      if (filters.status && receipt.status !== filters.status) return false;

      // Time range filter
      if (filters.since || filters.until) {
        const recordedAt = new Date(receipt.recorded_at).getTime();
        if (Number.isNaN(recordedAt)) return false;
        if (filters.since) {
          const sinceTime = new Date(filters.since).getTime();
          if (!Number.isNaN(sinceTime) && recordedAt < sinceTime) return false;
        }
        if (filters.until) {
          const untilTime = new Date(filters.until).getTime();
          if (!Number.isNaN(untilTime) && recordedAt > untilTime) return false;
        }
      }

      return true;
    }).map((entry) => {
      // Return focused projection: receipt metadata without body
      const receipt = entry;
      return {
        receipt_id: receipt.receipt_id,
        attempt_id: receipt.attempt_id,
        run_id: receipt.run_id || null,
        task_id: receipt.task_id || null,
        session_id: receipt.session_id || null,
        host: receipt.host,
        model: receipt.model || null,
        status: receipt.status,
        measurement_source: receipt.measurement_source,
        recorded_at: receipt.recorded_at,
        appended_at: receipt.appended_at,
        usage_summary: {
          input_tokens: receipt.usage?.input_tokens,
          output_tokens: receipt.usage?.output_tokens,
          cache_creation_input_tokens: receipt.usage?.cache_creation_input_tokens,
          cache_read_input_tokens: receipt.usage?.cache_read_input_tokens,
        },
      };
    });
  } catch {
    return [];
  }
}

// ─── Public API: get ledger statistics ───────────────────────────────────────
function getLedgerStats(ledgerDir) {
  const indexPath = path.join(ledgerDir, LEDGER_INDEX);
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const entries = index.entries || [];

    const stats = {
      total_receipts: entries.length,
      unique_attempts: new Set(entries.map((e) => e.attempt_id).filter(Boolean)).size,
      by_host: {},
      by_status: {},
      by_model: {},
      updated_at: index.updated_at,
    };

    for (const entry of entries) {
      const receipt = entry;

      // By host
      stats.by_host[receipt.host] = (stats.by_host[receipt.host] || 0) + 1;

      // By status
      stats.by_status[receipt.status] = (stats.by_status[receipt.status] || 0) + 1;

      // By model
      if (receipt.model) {
        stats.by_model[receipt.model] = (stats.by_model[receipt.model] || 0) + 1;
      }
    }

    return stats;
  } catch {
    return {
      total_receipts: 0,
      unique_attempts: 0,
      by_host: {},
      by_status: {},
      by_model: {},
      updated_at: null,
    };
  }
}

// ─── Public API: aggregate token usage across receipts ───────────────────────
function aggregateTokenUsage(ledgerDir, filters = {}) {
  const entries = queryReceipts(ledgerDir, filters);

  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    samples: 0,
    receipt_count: entries.length,
  };

  for (const entry of entries) {
    const summary = entry.usage_summary;
    if (!summary) continue;
    totals.input_tokens += summary.input_tokens || 0;
    totals.output_tokens += summary.output_tokens || 0;
    totals.cache_creation_input_tokens += summary.cache_creation_input_tokens || 0;
    totals.cache_read_input_tokens += summary.cache_read_input_tokens || 0;
    totals.samples += 1;
  }

  return totals;
}

// ─── Public API: clear ledger (for testing only) ──────────────────────────────
function clearLedger(ledgerDir) {
  const indexPath = path.join(ledgerDir, LEDGER_INDEX);
  try {
    fs.unlinkSync(indexPath);
  } catch {
    // Ignore if doesn't exist
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  LEDGER_DIR,
  LEDGER_INDEX,
  RECEIPTS_DIR,
  LEDGER_LOCK,
  RECOVERY_LOCK,
  RECOVERY_LOG,
  createLedgerEntry,
  computeIdempotencyKey,
  receiptExists,
  equivalentReceiptBody,
  readLedgerIndex,
  recoverLedgerLock,
  appendReceipt,
  appendReceiptBatch,
  submitTokenUsage,
  queryReceipts,
  getLedgerStats,
  aggregateTokenUsage,
  clearLedger,
  generateReceiptId,
};
