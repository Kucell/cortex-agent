"use strict";

/**
 * Graphify freshness receipt (T-GWG-001 / P-001 §4.6 + §5 `/ship`).
 *
 * The receipt is the durable artifact `/ship` writes to prove a project
 * is fit to ship. It binds together:
 *   - source HEAD (commit sha)
 *   - manifest digest (sha256 of the canonicalized manifest)
 *   - generation mode (full | update)
 *   - result (fresh | stale | skipped | blocked | failed)
 *   - timestamp
 *   - policy mode + reason code (why the verdict)
 *
 * Receipts live under `.agent/artifacts/graphify/<task-id>/receipt.json`
 * or `.agent/artifacts/graphify/global/receipt.json` for ship-wide
 * evidence. They are written via the standard artifact-bus pipeline so
 * other Cortex subsystems can correlate.
 *
 * The receipt is also the source of truth for the freshness gate.
 * `query`/`path`/`explain` read the same `manifest.digest` from the
 * resolver output and refuse to trust a graph whose receipt is missing
 * or whose result is not `fresh`.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const RECEIPT_SCHEMA_VERSION = "1.0";

const RESULT = Object.freeze({
  FRESH: "fresh",
  STALE: "stale",
  SKIPPED: "skipped",
  BLOCKED: "blocked",
  FAILED: "failed",
});

const RECEIPT_KIND = Object.freeze({
  SHIP: "ship",
  UPDATE: "update",
  DOCTOR: "doctor",
  QUERY: "query",
});

/**
 * Build a receipt payload. Pure: caller owns persistence.
 *
 * Required:
 *   - sourceHead
 *   - manifestDigest (or null when manifest missing / not applicable)
 *   - generationMode (one of "full" | "update" | "skipped")
 *   - result (one of RESULT)
 * Optional context (all best-effort):
 *   - taskId, kind, policy, mode, reasons, branch, worktreeRole,
 *     pluginVersion, now (deterministic timestamp)
 */
function buildReceipt({
  sourceHead,
  manifestDigest,
  generationMode,
  result,
  taskId = null,
  kind = RECEIPT_KIND.SHIP,
  policy = null,
  mode = null,
  reasons = [],
  branch = null,
  worktreeRole = null,
  pluginVersion = "cortex-agent-graphify/0",
  now = null,
}) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId: crypto.randomUUID ? crypto.randomUUID() : null,
    recordedAt: now || new Date().toISOString(),
    kind,
    taskId,
    sourceHead: sourceHead || null,
    manifestDigest: manifestDigest || null,
    generationMode,
    result,
    policy: policy || null,
    mode: mode || null,
    reasons: [...reasons],
    branch: branch || null,
    worktreeRole: worktreeRole || null,
    pluginVersion,
  };
}

/**
 * Atomic write: stages to `<file>.tmp` then renames. Returns the absolute
 * path written.
 */
function writeReceiptAtomic(filePath, receipt) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * Compute the conventional receipt path for a project + task. The path
 * is anchored inside `.agent/artifacts/graphify/...` which lives next to
 * the other run-state dirs (artifact-bus, runs, etc.).
 */
function resolveReceiptPath({ projectRoot, taskId = "global" }) {
  return path.join(projectRoot, ".agent", "artifacts", "graphify", taskId, "receipt.json");
}

/**
 * Read the most recent receipt. Returns { ok, receipt, reason } — never
 * throws on missing files.
 */
function readReceipt(receiptPath) {
  if (!receiptPath || !fs.existsSync(receiptPath)) {
    return { ok: false, receipt: null, reason: "missing" };
  }
  try {
    const data = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (!data || data.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
      return { ok: false, receipt: data, reason: "schema_mismatch" };
    }
    return { ok: true, receipt: data };
  } catch (err) {
    return { ok: false, receipt: null, reason: "corrupt" };
  }
}

/**
 * Determine the freshness verdict for a resolver output. Returns one of
 * RESULT. Pure function — never mutates state. The caller decides whether
 * to persist the verdict as a receipt.
 *
 * Rules (in order):
 *   1. `not_applicable` → SKIPPED with `not_applicable` reason.
 *   2. `policy === off` → SKIPPED with `policy_off` reason.
 *   3. `available === true && staleReasons === []` → FRESH.
 *   4. `available === false && reason is recoverable` → STALE.
 *   5. `incompatible | corrupt | update_failed` → BLOCKED.
 *
 * The function is forgiving: when the resolver reported `available:false`
 * with `fallbackReason` set, callers can choose to mark STALE rather
 * than BLOCKED. By default we BLOCK only the truly unrecoverable codes.
 */
function verdictFor(resolverOutput) {
  if (!resolverOutput) return { result: RESULT.FAILED, reasons: ["no_resolver_output"] };
  if (resolverOutput.not_applicable) {
    return { result: RESULT.SKIPPED, reasons: ["not_applicable"] };
  }
  if (resolverOutput.policy === "off") {
    return { result: RESULT.SKIPPED, reasons: ["policy_off"] };
  }
  if (resolverOutput.available && (!resolverOutput.staleReasons || resolverOutput.staleReasons.length === 0)) {
    return { result: RESULT.FRESH, reasons: [] };
  }
  const reasons = (resolverOutput.staleReasons || []).slice();
  const fallback = resolverOutput.fallbackReason;
  const hardBlock = reasons.some((r) =>
    r === "schema_incompatible" || r === "graph_corrupt" || r === "manifest_invalid",
  );
  if (hardBlock) return { result: RESULT.BLOCKED, reasons };
  if (fallback) reasons.push(fallback);
  return { result: resolverOutput.available ? RESULT.FRESH : RESULT.STALE, reasons };
}

module.exports = {
  RECEIPT_SCHEMA_VERSION,
  RESULT,
  RECEIPT_KIND,
  buildReceipt,
  writeReceiptAtomic,
  resolveReceiptPath,
  readReceipt,
  verdictFor,
};