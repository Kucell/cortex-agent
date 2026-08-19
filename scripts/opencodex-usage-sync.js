#!/usr/bin/env node
"use strict";

// ─── opencodex-usage-sync (M-025/MS-003 Phase B backfill) ─────────────────────
// Zero-dependency streaming backfill that maps the opencodex proxy's
// `usage.jsonl` records into the project-local `token-attempt` ledger via
// the MS-001 receipt contract.
//
// Why this script exists:
//   - Phase B VC-016 needs ≥100 eligible non-test receipts per Host over 7
//     consecutive UTC days before any savings claim can be published.
//   - The local ledger was empty (only synthetic test receipts) and the
//     passive collector does not call any Host, so the only organic source
//     is the opencodex proxy's request log.
//   - This script is a one-shot backfill helper. It is NOT a real-time
//     collector and must not be wired into the governed Host adapters.
//
// Security boundary (per M-025 collection rules):
//   - The proxy log contains usage numbers and provider / model / requestId
//     metadata. It does NOT contain prompt, response, transcript, source
//     body, credential or private Host path. We map only the allowlisted
//     fields into the envelope and let `submitTokenUsage` re-validate.
//   - `--source` defaults to the user's own opencodex proxy log under HOME.
//     The script never reads anything else from that directory.
//   - No model calls, no policy mutation, no commit/push/merge/release.
//
// Mapping rules:
//   host         ← envelope.provider         (e.g. "openai", "minimax-cn")
//   attempt_id   ← envelope.requestId
//   model        ← envelope.resolvedModel || envelope.requestedModel
//   run_id       ← envelope.conversationId
//   recorded_at  ← ISO from envelope.timestamp (ms)
//   status       ← "host_reported" when usageStatus === "reported" and
//                  usage is a populated object; otherwise the row is
//                  skipped (Phase B does not count non-reported rows).
//   usage.*      ← canonical MS-001 field names only.

const fs = require("node:fs");
const path = require("node:path");

const ledger = require("../templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js");
const receiptLib = require("../templates/_shared/.agent/skills/management-api/scripts/token-attempt-receipt.js");

const { createTokenAttemptReceipt, generateReceiptId, sanitizeHostPayload } = receiptLib;

// ─── Defaults & constants ───────────────────────────────────────────────────
const DEFAULT_SOURCE = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".opencodex",
  "usage.jsonl",
);

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LEDGER_DIR = path.join(DEFAULT_PROJECT_ROOT, ".agent", "token-attempts");
const DEFAULT_LIMIT = 0; // 0 = no limit
const DEFAULT_BATCH_SIZE = 100;

// Provider names that match the MS-002 governed Host taxonomy. The proxy
// label is preserved as the ledger `host` because each provider represents
// a distinct governed upstream.
const ALLOWED_HOSTS = new Set([
  "openai",
  "minimax-cn",
  "minimax",
  "deepseek",
  "kimi-code",
  "nvidia",
  "openstarry",
  "qianwenai",
  "combo",
  "volcengine",
  "unknown",
]);

// Field whitelist for the canonical MS-001 usage envelope. Anything else
// from the proxy log is dropped before reaching `submitTokenUsage`.
const TOKEN_FIELD_MAP = Object.freeze({
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cachedInputTokens: "cache_read_input_tokens",
  cacheReadInputTokens: "cache_read_input_tokens",
  cacheCreationInputTokens: "cache_creation_input_tokens",
});

// ─── CLI parsing (lightweight, no deps) ─────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    source: DEFAULT_SOURCE,
    projectRoot: DEFAULT_PROJECT_ROOT,
    ledgerDir: null,
    apply: false,
    dryRun: false,
    limit: DEFAULT_LIMIT,
    batchSize: DEFAULT_BATCH_SIZE,
    hostFilter: null,
    since: null,
    until: null,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--source") opts.source = argv[++i];
    else if (arg === "--project-root") opts.projectRoot = argv[++i];
    else if (arg === "--ledger-dir") opts.ledgerDir = argv[++i];
    else if (arg === "--limit") opts.limit = Number.parseInt(argv[++i], 10) || 0;
    else if (arg === "--batch-size") opts.batchSize = Number.parseInt(argv[++i], 10) || DEFAULT_BATCH_SIZE;
    else if (arg === "--host-filter") opts.hostFilter = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--until") opts.until = argv[++i];
    else if (arg === "--json") opts.json = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.apply && opts.dryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  if (opts.ledgerDir == null) {
    opts.ledgerDir = path.join(opts.projectRoot, ".agent", "token-attempts");
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    "Usage: opencodex-usage-sync [options]",
    "",
    "Map opencodex proxy usage.jsonl records into the token-attempt ledger.",
    "Default mode is dry-run (counts + skips, no writes). Pass --apply to",
    "actually persist via the MS-001 ledger writer.",
    "",
    "Options:",
    "  --source PATH         Path to usage.jsonl (default: ~/.opencodex/usage.jsonl)",
    "  --project-root DIR    Project root (default: cortex-agent repo root)",
    "  --ledger-dir DIR      Override ledger directory",
    "  --dry-run             Validate only, never write (default)",
    "  --apply               Persist receipts via MS-001 ledger writer",
    "  --limit N             Stop after writing N receipts (0 = unlimited)",
    "  --batch-size N        Reserved for future batch lock; no-op (default 100)",
    "  --host-filter LIST    Comma-separated provider filter (e.g. openai,minimax-cn)",
    "  --since ISO           Only records with timestamp >= since",
    "  --until ISO           Only records with timestamp < until",
    "  --json PATH           Optional: write the run summary JSON to PATH",
    "  -h, --help            Show this help",
    "",
  ].join("\n"));
}

// ─── Per-row mapping ───────────────────────────────────────────────────────
function pickUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const out = {};
  for (const [from, to] of Object.entries(TOKEN_FIELD_MAP)) {
    if (Object.prototype.hasOwnProperty.call(usage, from)) {
      const value = usage[from];
      if (Number.isFinite(value)) {
        out[to] = Math.max(0, Math.trunc(value));
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function msToIso(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function mapRow(raw, opts) {
  // raw is the parsed JSON object from usage.jsonl
  const requestId = typeof raw.requestId === "string" ? raw.requestId : "";
  const timestamp = Number.isFinite(raw.timestamp) ? raw.timestamp : NaN;
  const provider = typeof raw.provider === "string" && raw.provider ? raw.provider : "unknown";
  const resolvedModel = typeof raw.resolvedModel === "string" && raw.resolvedModel
    ? raw.resolvedModel
    : (typeof raw.requestedModel === "string" ? raw.requestedModel : null);
  const conversationId = typeof raw.conversationId === "string" && raw.conversationId
    ? raw.conversationId
    : null;
  const usageStatus = typeof raw.usageStatus === "string" ? raw.usageStatus : "unknown";

  // Skip reasons → return { skip: true, ... } so the caller can count them.
  if (!requestId) return { skip: true, reason: "missing_request_id" };
  if (!Number.isFinite(timestamp)) return { skip: true, reason: "missing_timestamp", requestId };

  const recordedAtIso = msToIso(timestamp);
  if (!recordedAtIso) return { skip: true, reason: "invalid_timestamp", requestId };

  // Time window filter
  if (opts.since && recordedAtIso < opts.since) {
    return { skip: true, reason: "before_since", requestId };
  }
  if (opts.until && recordedAtIso >= opts.until) {
    return { skip: true, reason: "after_until", requestId };
  }

  // Host filter
  if (opts.hostFilter && !opts.hostFilter.includes(provider)) {
    return { skip: true, reason: "host_filtered", requestId, provider };
  }

  if (!ALLOWED_HOSTS.has(provider)) {
    return { skip: true, reason: "unknown_provider", requestId, provider };
  }

  if (usageStatus !== "reported") {
    return { skip: true, reason: "usage_unreported", requestId, provider };
  }

  const usage = pickUsage(raw.usage);
  if (!usage) {
    return { skip: true, reason: "empty_usage", requestId, provider };
  }

  return {
    skip: false,
    envelope: {
      host: provider,
      attempt_id: requestId,
      model: resolvedModel,
      run_id: conversationId,
      usage,
      recorded_at: recordedAtIso,
      status: "host_reported",
    },
  };
}

// ─── Submission wrapper (preserves original recorded_at) ────────────────────
// `ledger.submitTokenUsage` always stamps `recorded_at = now`, which is
// correct for live ingestion but destroys the proxy's original timestamp
// during backfill. We bypass it for the apply path and build receipts
// directly via `createTokenAttemptReceipt` so that:
//   1. The receipt carries the proxy's original UTC timestamp
//   2. Idempotency, security, and contract checks still run (appendReceiptBatch)
//   3. Out-of-order is tolerated (backfill is not strictly chronological)
//
// The wrapper accepts an array of envelopes and submits them as a single
// batch — one lock acquisition, one index rewrite — via `appendReceiptBatch`.
function buildReceipt(envelope) {
  const receiptId = generateReceiptId(envelope.attempt_id, envelope.host);
  const sanitized = sanitizeHostPayload(envelope.usage);
  return createTokenAttemptReceipt({
    attempt_id: envelope.attempt_id,
    receipt_id: receiptId,
    run_id: envelope.run_id || null,
    host: envelope.host,
    model: envelope.model || null,
    status: envelope.status || "host_reported",
    raw_usage: sanitized,
    recorded_at: envelope.recorded_at,
  });
}

function submitBatch(ledgerDir, envelopes) {
  if (envelopes.length === 0) return { ok: true, written: 0, duplicates: 0, errors: 0 };
  const receipts = [];
  const buildErrors = [];
  for (let i = 0; i < envelopes.length; i += 1) {
    try {
      receipts.push(buildReceipt(envelopes[i]));
    } catch (error) {
      buildErrors.push({ index: i, error: error.message });
    }
  }
  if (receipts.length === 0) {
    return { ok: false, build_errors: buildErrors };
  }
  const result = ledger.appendReceiptBatch(ledgerDir, receipts, { allowOutOfOrder: true });
  return { ...result, build_errors: buildErrors };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  const summary = {
    ok: true,
    mode: opts.apply ? "apply" : "dry-run",
    source: opts.source,
    project_root: opts.projectRoot,
    ledger_dir: opts.ledgerDir,
    started_at: new Date().toISOString(),
    counters: {
      parsed: 0,
      skipped: 0,
      skipped_by_reason: {},
      submitted: 0,
      duplicates: 0,
      submit_errors: 0,
      written: 0,
      processed_lines: 0,
      parse_errors: 0,
    },
    by_provider: {},
    by_status: {},
    finished_at: null,
    duration_ms: null,
  };

  if (!fs.existsSync(opts.source)) {
    summary.ok = false;
    summary.error = "source_not_found";
    summary.finished_at = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const stream = fs.createReadStream(opts.source, { encoding: "utf8" });
  let buffer = "";
  let batch = [];
  function processLine(line) {
    summary.counters.processed_lines += 1;
    if (!line) return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      summary.counters.parse_errors += 1;
      summary.counters.skipped_by_reason.parse_error =
        (summary.counters.skipped_by_reason.parse_error || 0) + 1;
      return;
    }
    summary.counters.parsed += 1;
    const result = mapRow(raw, opts);
    if (result.skip) {
      summary.counters.skipped += 1;
      summary.counters.skipped_by_reason[result.reason] =
        (summary.counters.skipped_by_reason[result.reason] || 0) + 1;
      return;
    }
    summary.by_provider[result.envelope.host] = (summary.by_provider[result.envelope.host] || 0) + 1;
    if (opts.apply) {
      batch.push(result.envelope);
      // Flush when the batch fills up OR when the per-run --limit would be
      // satisfied by the next flush. The latter matters when --limit < batchSize.
      const remaining = opts.limit ? Math.max(0, opts.limit - summary.counters.written) : Infinity;
      if (batch.length >= opts.batchSize || batch.length >= remaining) {
        return flushBatch();
      }
    } else {
      summary.counters.submitted += 1; // would-have-been-submitted counter
    }
  }
  function flushBatch() {
    if (batch.length === 0) return null;
    const submitResult = submitBatch(opts.ledgerDir, batch);
    if (submitResult.ok) {
      summary.counters.submitted += submitResult.written + submitResult.duplicates;
      summary.counters.written += submitResult.written;
      summary.counters.duplicates += submitResult.duplicates;
      summary.counters.submit_errors += submitResult.errors || 0;
      for (const buildErr of submitResult.build_errors || []) {
        summary.counters.submit_errors += 1;
        summary.counters.skipped_by_reason[`build_error`] =
          (summary.counters.skipped_by_reason[`build_error`] || 0) + 1;
      }
    } else {
      // Build errors dominated — record each.
      for (const buildErr of (submitResult.build_errors || [])) {
        summary.counters.submit_errors += 1;
        summary.counters.skipped_by_reason[`build_error`] =
          (summary.counters.skipped_by_reason[`build_error`] || 0) + 1;
      }
    }
    batch = [];
    return submitResult;
  }
  stream.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      processLine(line);
      if (opts.limit && summary.counters.written >= opts.limit) {
        stream.destroy();
        return;
      }
      nl = buffer.indexOf("\n");
    }
  });

  await new Promise((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", reject);
  });

  // Handle final line without trailing newline
  processLine(buffer.trim());
  // Flush any remaining envelopes
  flushBatch();

  summary.finished_at = new Date().toISOString();
  summary.duration_ms = new Date(summary.finished_at).getTime() - new Date(summary.started_at).getTime();

  if (opts.json) {
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: "sync_failed", reason: error.message })}\n`);
  process.exitCode = 1;
});