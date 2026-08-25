#!/usr/bin/env node
"use strict";

// ─── pi-usage-sync (M-025/MS-003 Phase B backfill — Pi agent host) ───────────
// Zero-dependency streaming backfill that maps Pi's session transcripts
// (`~/.pi/agent/sessions/<slug>/<session>.jsonl`) into the project-local
// `token-attempt` ledger via the MS-001 receipt contract.
//
// Why this script exists:
//   - Phase B VC-016 needs ≥100 eligible non-test receipts per Host over 7
//     consecutive UTC days before any savings claim can be published.
//   - Pi's runtime does NOT expose a `~/.openpi/usage.jsonl` (unlike Codex's
//     opencodex proxy). The only organic usage source is Pi's own session
//     transcript: `type:"message"` rows carry a public `usage` object with
//     input / output / cacheRead / cacheWrite token counts.
//   - This script is a one-shot backfill helper. It is NOT a real-time
//     collector and must not be wired into the governed Host adapters.
//
// Security boundary (per M-025 collection rules):
//   - Pi session transcripts contain prompts, responses, tool payloads and
//     other private content. THIS SCRIPT NEVER READS THOSE FIELDS. It scans
//     only the `type:"message"` rows and extracts ONLY the public usage
//     numbers + model + provider + timestamp. The envelope handed to the
//     ledger contains no prompt/response/tool content.
//   - `--pi-home` defaults to the user's own `~/.pi` directory. The script
//     never reads anything else from that directory.
//   - No model calls, no policy mutation, no commit/push/merge/release.
//
// Mapping rules:
//   host         ← "pi-json"            (fixed agent-host dimension, mirrors dsh)
//   attempt_id   ← "pi-" + sessionId + "-" + eventId
//   model        ← row.model || "unknown"
//   provider     ← row.provider (kept as run-level metadata only, not host)
//   recorded_at  ← row.timestamp (ISO-8601)
//   status       ← "host_reported"
//   usage.*      ← alias map: input→input_tokens, output→output_tokens,
//                  cacheWrite→cache_creation_input_tokens,
//                  cacheRead→cache_read_input_tokens
//
// Idempotency: attempt_id is derived deterministically from session id +
// event id, so re-running the backfill over the same transcripts produces
// duplicate receipts that `appendReceiptBatch` collapses.

const fs = require("node:fs");
const path = require("node:path");

const ledger = require("../templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js");
const receiptLib = require("../templates/_shared/.agent/skills/management-api/scripts/token-attempt-receipt.js");

const { createTokenAttemptReceipt, generateReceiptId, sanitizeHostPayload } = receiptLib;

// ─── Defaults & constants ───────────────────────────────────────────────────
const DEFAULT_PI_HOME = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".pi",
);

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LEDGER_DIR = path.join(DEFAULT_PROJECT_ROOT, ".agent", "token-attempts");
const DEFAULT_LIMIT = 0; // 0 = no limit
const DEFAULT_BATCH_SIZE = 100;

const AGENT_HOST = "pi-json";

// Alias map: Pi session `usage` field → canonical MS-001 field.
const USAGE_ALIASES = Object.freeze({
  input: "input_tokens",
  output: "output_tokens",
  cacheRead: "cache_read_input_tokens",
  cacheWrite: "cache_creation_input_tokens",
});

// ─── CLI parsing (lightweight, no deps) ─────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    piHome: DEFAULT_PI_HOME,
    projectRoot: DEFAULT_PROJECT_ROOT,
    ledgerDir: null,
    apply: false,
    dryRun: false,
    limit: DEFAULT_LIMIT,
    batchSize: DEFAULT_BATCH_SIZE,
    sessionSlug: null,
    since: null,
    until: null,
    json: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--pi-home") opts.piHome = argv[++i];
    else if (arg === "--project-root") opts.projectRoot = argv[++i];
    else if (arg === "--ledger-dir") opts.ledgerDir = argv[++i];
    else if (arg === "--limit") opts.limit = Number.parseInt(argv[++i], 10) || 0;
    else if (arg === "--batch-size") opts.batchSize = Number.parseInt(argv[++i], 10) || DEFAULT_BATCH_SIZE;
    else if (arg === "--session-slug") opts.sessionSlug = argv[++i];
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
    "Usage: pi-usage-sync [options]",
    "",
    "Map Pi session transcript usage rows into the token-attempt ledger.",
    "Default mode is dry-run (counts + skips, no writes). Pass --apply to",
    "actually persist via the MS-001 ledger writer.",
    "",
    "Options:",
    "  --pi-home PATH        Pi home dir (default: ~/.pi)",
    "  --session-slug SLUG   Only process one slug dir under sessions/",
    "  --project-root DIR    Project root (default: cortex-agent repo root)",
    "  --ledger-dir DIR      Override ledger directory",
    "  --dry-run             Validate only, never write (default)",
    "  --apply               Persist receipts via MS-001 ledger writer",
    "  --limit N             Stop after writing N receipts (0 = unlimited)",
    "  --batch-size N        Reserved for future batch lock; no-op (default 100)",
    "  --since ISO           Only rows with timestamp >= since",
    "  --until ISO           Only rows with timestamp < until",
    "  --json PATH           Optional: write the run summary JSON to PATH",
    "  -h, --help            Show this help",
    "",
  ].join("\n"));
}

// ─── Per-row mapping ───────────────────────────────────────────────────────
function pickUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const out = {};
  for (const [from, to] of Object.entries(USAGE_ALIASES)) {
    if (Object.prototype.hasOwnProperty.call(usage, from)) {
      const value = usage[from];
      if (Number.isFinite(value)) {
        out[to] = Math.max(0, Math.trunc(value));
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function safeId(value, max = 128) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > max) value = value.slice(0, max);
  return value.replace(/[^A-Za-z0-9._:@-]/g, "_");
}

function mapRow(raw, sessionId, opts) {
  // Only `type:"message"` rows carry usage; usage may live at top level
  // (older Pi formats) or nested under `message.usage` (0.84.x).
  if (!raw || raw.type !== "message") return { skip: true, reason: "not_message_row" };
  const usageSource = (raw.usage && typeof raw.usage === "object")
    ? raw.usage
    : (raw.message && raw.message.usage && typeof raw.message.usage === "object")
      ? raw.message.usage
      : null;
  if (!usageSource) return { skip: true, reason: "no_usage" };

  const eventId = safeId(raw.id);
  const session = safeId(sessionId);
  if (!eventId || !session) return { skip: true, reason: "missing_id" };

  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
  if (!timestamp) return { skip: true, reason: "missing_timestamp" };
  const recordedAtIso = new Date(timestamp).toISOString();
  if (!Number.isFinite(new Date(timestamp).getTime())) {
    return { skip: true, reason: "invalid_timestamp" };
  }

  // Time window filter
  if (opts.since && recordedAtIso < opts.since) {
    return { skip: true, reason: "before_since" };
  }
  if (opts.until && recordedAtIso >= opts.until) {
    return { skip: true, reason: "after_until" };
  }

  const usage = pickUsage(usageSource);
  if (!usage) return { skip: true, reason: "empty_usage" };

  const model = (typeof raw.model === "string" && raw.model)
    ? raw.model
    : (raw.message && typeof raw.message.model === "string" && raw.message.model)
      ? raw.message.model
      : "unknown";
  const provider = (typeof raw.provider === "string" && raw.provider)
    ? raw.provider
    : (raw.message && typeof raw.message.provider === "string" && raw.message.provider)
      ? raw.message.provider
      : null;

  return {
    skip: false,
    envelope: {
      host: AGENT_HOST,
      attempt_id: `pi-${session}-${eventId}`,
      model,
      run_id: provider ? `provider:${provider}` : null,
      usage,
      recorded_at: recordedAtIso,
      status: "host_reported",
    },
  };
}

// ─── Submission wrapper (preserves original recorded_at) ────────────────────
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

// ─── Session discovery ─────────────────────────────────────────────────────
function listSessionFiles(piHome, sessionSlug) {
  const sessionsDir = path.join(piHome, "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];
  const slugs = sessionSlug
    ? [sessionSlug]
    : fs.readdirSync(sessionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
  const files = [];
  for (const slug of slugs) {
    const slugDir = path.join(sessionsDir, slug);
    if (!fs.existsSync(slugDir) || !fs.statSync(slugDir).isDirectory()) continue;
    for (const name of fs.readdirSync(slugDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(slugDir, name);
      try {
        if (fs.statSync(full).isFile()) files.push({ slug, path: full });
      } catch (_) { /* ignore */ }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  const summary = {
    ok: true,
    mode: opts.apply ? "apply" : "dry-run",
    pi_home: opts.piHome,
    project_root: opts.projectRoot,
    ledger_dir: opts.ledgerDir,
    started_at: new Date().toISOString(),
    counters: {
      sessions_scanned: 0,
      files_scanned: 0,
      rows_parsed: 0,
      rows_skipped: 0,
      skipped_by_reason: {},
      submitted: 0,
      duplicates: 0,
      submit_errors: 0,
      written: 0,
      parse_errors: 0,
    },
    by_slug: {},
    by_usage_status: {},
    finished_at: null,
    duration_ms: null,
  };

  const files = listSessionFiles(opts.piHome, opts.sessionSlug);
  if (files.length === 0) {
    summary.ok = false;
    summary.error = "no_pi_sessions_found";
    summary.finished_at = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  summary.counters.sessions_scanned = new Set(files.map((f) => f.slug)).size;
  summary.counters.files_scanned = files.length;

  let batch = [];
  function flushBatch() {
    if (batch.length === 0) return;
    const submitResult = submitBatch(opts.ledgerDir, batch);
    if (submitResult.ok) {
      summary.counters.submitted += submitResult.written + submitResult.duplicates;
      summary.counters.written += submitResult.written;
      summary.counters.duplicates += submitResult.duplicates;
      summary.counters.submit_errors += submitResult.errors || 0;
      for (const buildErr of submitResult.build_errors || []) {
        summary.counters.submit_errors += 1;
        summary.counters.skipped_by_reason.build_error =
          (summary.counters.skipped_by_reason.build_error || 0) + 1;
      }
    } else {
      for (const buildErr of (submitResult.build_errors || [])) {
        summary.counters.submit_errors += 1;
        summary.counters.skipped_by_reason.build_error =
          (summary.counters.skipped_by_reason.build_error || 0) + 1;
      }
    }
    batch = [];
  }

  outer:
  for (const { slug, path: filePath } of files) {
    if (opts.limit && summary.counters.written >= opts.limit) break;
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      summary.counters.skipped_by_reason.unreadable_file =
        (summary.counters.skipped_by_reason.unreadable_file || 0) + 1;
      continue;
    }
    const sessionId = path.basename(filePath, ".jsonl").replace(/^[0-9T-Z-]+_/, "").slice(0, 40) || slug;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      summary.counters.rows_parsed += 1;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (_) {
        summary.counters.parse_errors += 1;
        summary.counters.skipped_by_reason.parse_error =
          (summary.counters.skipped_by_reason.parse_error || 0) + 1;
        continue;
      }
      const result = mapRow(raw, sessionId, opts);
      if (result.skip) {
        summary.counters.rows_skipped += 1;
        summary.counters.skipped_by_reason[result.reason] =
          (summary.counters.skipped_by_reason[result.reason] || 0) + 1;
        continue;
      }
      summary.by_slug[slug] = (summary.by_slug[slug] || 0) + 1;
      summary.by_usage_status[result.envelope.status] =
        (summary.by_usage_status[result.envelope.status] || 0) + 1;
      if (opts.apply) {
        batch.push(result.envelope);
        const remaining = opts.limit ? Math.max(0, opts.limit - summary.counters.written) : Infinity;
        if (batch.length >= opts.batchSize || batch.length >= remaining) {
          flushBatch();
          if (opts.limit && summary.counters.written >= opts.limit) break outer;
        }
      } else {
        summary.counters.submitted += 1;
      }
    }
  }
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