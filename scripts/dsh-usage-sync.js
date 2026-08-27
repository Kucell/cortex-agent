#!/usr/bin/env node
"use strict";

// ─── dsh-usage-sync (M-025/MS-003 Phase B backfill — DSH host) ────────────────
// Zero-dependency streaming backfill that maps DeepSeek Harness (DSH) session
// events from `~/.dsh/sessions/<project-slug>/session-*/session.jsonl.zstd`
// into the project-local `token-attempt` ledger via the MS-001 receipt
// contract.
//
// Why this script exists:
//   - Phase B VC-016 needs ≥100 eligible non-test receipts per Host over 7
//     consecutive UTC days before any savings claim can be published.
//   - DSH is a third governed Host (alongside Codex and Pi) that emits
//     `assistant/chunk` events with `chunk.type === "usage"` carrying
//     `inputTokens` / `outputTokens` / `cacheReadTokens` numbers.
//   - The local ledger has no DSH entries; this script backfills them.
//
// Security boundary (per M-025 collection rules):
//   - DSH session.jsonl.zstd holds usage numbers and turn/step/session metadata.
//     It does NOT contain prompt text, response body, tool payload or private
//     absolute path inside the structured envelope. We map only the allowlisted
//     fields and let `submitTokenUsage` re-validate.
//   - `--dsh-home` defaults to `~/.dsh`. The script never reads anything else
//     from that directory tree.
//   - No model calls, no policy mutation, no commit/push/merge/release.
//
// Mapping rules:
//   host           ← "dsh"
//   attempt_id     ← `dsh-{session_id}-{turn}-{step}-{seq}`
//   model          ← session envelope or `<unknown>`
//   run_id         ← session_id (a DSH session = one user-shown task lifetime)
//   recorded_at    ← ISO from event.time (ms)
//   status         ← "host_reported" when chunk.usage is a populated object
//   usage.*        ← canonical MS-001 field names only
//
// Usage:
//   node scripts/dsh-usage-sync.js [--dry-run | --apply]
//   node scripts/dsh-usage-sync.js --dsh-home /custom/path --project-root /repo
//   node scripts/dsh-usage-sync.js --session-slug my-project --apply
//   node scripts/dsh-usage-sync.js --since 2026-08-01 --until 2026-08-19

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ledger = require("../templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js");
const receiptLib = require("../templates/_shared/.agent/skills/management-api/scripts/token-attempt-receipt.js");

const { createTokenAttemptReceipt, generateReceiptId, sanitizeHostPayload } = receiptLib;

// ─── Defaults & constants ───────────────────────────────────────────────────
const DEFAULT_DSH_HOME = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".dsh",
);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_LEDGER_DIR = path.join(DEFAULT_PROJECT_ROOT, ".agent", "token-attempts");
const DEFAULT_LIMIT = 0; // 0 = no limit
const DEFAULT_BATCH_SIZE = 100;

const HOST_LABEL = "dsh";
const SOURCE_LABEL = "dsh";

// ─── CLI parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    dshHome: DEFAULT_DSH_HOME,
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
    else if (arg === "--dsh-home") opts.dshHome = argv[++i];
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
    "Usage: dsh-usage-sync [options]",
    "",
    "Map DSH session.jsonl.zstd assistant/chunk usage events into the",
    "token-attempt ledger via the MS-001 receipt contract.",
    "Default mode is dry-run (counts + skips, no writes). Pass --apply to",
    "actually persist.",
    "",
    "Options:",
    "  --dsh-home PATH         DSH root (default: ~/.dsh)",
    "  --project-root DIR      Project root (default: cortex-agent repo)",
    "  --ledger-dir DIR        Override ledger directory",
    "  --session-slug SLUG     Restrict to one project slug (e.g. --Users-xueyq-myworks-cortex-agent--)",
    "  --dry-run               Validate only, never write (default)",
    "  --apply                 Persist receipts via MS-001 ledger writer",
    "  --limit N               Stop after writing N receipts (0 = unlimited)",
    "  --batch-size N          Reserved (default 100)",
    "  --since ISO             Only events with time >= since",
    "  --until ISO             Only events with time < until",
    "  --json PATH             Write run summary JSON to PATH",
    "  -h, --help              Show help",
    "",
  ].join("\n"));
}

// ─── DSH session walker ─────────────────────────────────────────────────────
function listSessionDirs(dshHome, sessionSlug) {
  if (!fs.existsSync(dshHome)) return [];
  const sessionsRoot = path.join(dshHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];
  const out = [];
  const slugs = sessionSlug
    ? [sessionSlug]
    : fs.readdirSync(sessionsRoot).filter((name) => name.startsWith("--") && name.endsWith("--"));
  for (const slug of slugs) {
    const slugDir = path.join(sessionsRoot, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(slugDir)) {
      if (!entry.startsWith("session-")) continue;
      const sessionDir = path.join(slugDir, entry);
      const jsonlPath = path.join(sessionDir, "session.jsonl.zstd");
      if (fs.existsSync(jsonlPath)) {
        out.push({ slug, sessionId: entry.replace(/^session-/, ""), jsonlPath });
      }
    }
  }
  return out;
}

function readZstdLinesAsync(jsonlPath) {
  // DSH writes session.jsonl.zstd as a concatenated sequence of independently
  // compressed Zstandard frames (one per header / event batch). Node's
  // built-in `createZstdDecompress` stream only reads the FIRST frame and
  // silently drops the rest, which makes `events_mapped` stay at 0 on real
  // sessions. To stay zero-dependency and avoid importing DSH internals, we
  // mirror the structural scanner used by
  // `dsh-session-persistence-jsonl/lib/index.js` (see scanZstdFrames around
  // lines 491-581 there): locate each complete frame in the raw bytes, then
  // decompress them one-by-one with the synchronous Node built-in API.
  //
  // A trailing partial frame (write-in-progress) is reported as `tornStart`
  // by the scanner; we skip it and keep the complete earlier frames, exactly
  // the same recovery semantics the upstream scanner enforces.
  return new Promise((resolve) => {
    fs.readFile(jsonlPath, (err, buffer) => {
      if (err) {
        resolve({ lines: [], error: err.message });
        return;
      }
      let scan;
      try {
        scan = scanZstdFrames(buffer);
      } catch (scanErr) {
        resolve({ lines: [], error: scanErr.message });
        return;
      }
      const lines = [];
      let bufferStr = "";
      for (const frame of scan.frames) {
        const slice = buffer.subarray(frame.start, frame.end);
        let plain;
        try {
          plain = zlib.zstdDecompressSync(slice);
        } catch (decompErr) {
          resolve({ lines: [], error: decompErr.message });
          return;
        }
        bufferStr += plain.toString("utf8");
        let nl = bufferStr.indexOf("\n");
        while (nl !== -1) {
          lines.push(bufferStr.slice(0, nl));
          bufferStr = bufferStr.slice(nl + 1);
          nl = bufferStr.indexOf("\n");
        }
      }
      if (bufferStr.length > 0) lines.push(bufferStr);
      resolve({ lines, error: null });
    });
  });
}

// ─── Zstandard frame scanner (mirror of dsh-session-persistence-jsonl) ──────
// Structurally scans a Zstandard container for independently-compressed frame
// boundaries WITHOUT touching the compressed blocks. Only the frame header
// (magic + descriptor + window/logical sizes), the block headers, and the
// optional checksum field are read. A trailing partial frame (torn write)
// is reported via `tornStart` so callers can drop it and keep complete frames.
const ZSTD_MAGIC = 0xFD2FB528;

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

// ─── DSH usage event → MS-001 envelope ──────────────────────────────────────
// DSH session lines look like:
//   {"type":"session","id":"session-54f616ea-...","cwd":"..."}
//   {"type":"assistant/chunk","seq":28,"time":1787105752987,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":12266,"outputTokens":100,"cacheReadTokens":128}}}}
// The sessionId is only on the leading `type:"session"` line; assistant/chunk
// events do not carry it at the top level. We pass it through from the
// directory walker so the per-event mapping stays pure.
function mapEvent(raw, opts, sessionId) {
  if (!raw || typeof raw !== "object") return { skip: true, reason: "non_object_event" };
  if (raw.type !== "assistant/chunk") return { skip: true, reason: "non_usage_event" };
  const chunk = raw.data && raw.data.chunk;
  if (!chunk || chunk.type !== "usage") return { skip: true, reason: "non_usage_chunk" };
  const usage = chunk.usage;
  if (!usage || typeof usage !== "object") return { skip: true, reason: "empty_usage" };

  const turn = Number.isSafeInteger(raw.data.turn) ? raw.data.turn : 0;
  const step = Number.isSafeInteger(raw.data.step) ? raw.data.step : 0;
  const seq = Number.isSafeInteger(raw.seq) ? raw.seq : 0;
  const time = Number.isSafeInteger(raw.time) ? raw.time : NaN;

  if (!sessionId) return { skip: true, reason: "missing_session_id" };
  if (!Number.isFinite(time)) return { skip: true, reason: "missing_time", sessionId };

  const recordedAtIso = new Date(time).toISOString();
  if (opts.since && recordedAtIso < opts.since) {
    return { skip: true, reason: "before_since", sessionId, time: recordedAtIso };
  }
  if (opts.until && recordedAtIso >= opts.until) {
    return { skip: true, reason: "after_until", sessionId, time: recordedAtIso };
  }

  // Canonical mapping.
  const canonical = {};
  if (Number.isFinite(usage.inputTokens)) canonical.input_tokens = Math.max(0, Math.trunc(usage.inputTokens));
  if (Number.isFinite(usage.outputTokens)) canonical.output_tokens = Math.max(0, Math.trunc(usage.outputTokens));
  if (Number.isFinite(usage.cacheReadTokens)) canonical.cache_read_input_tokens = Math.max(0, Math.trunc(usage.cacheReadTokens));
  if (Number.isFinite(usage.cacheWriteTokens)) canonical.cache_creation_input_tokens = Math.max(0, Math.trunc(usage.cacheWriteTokens));

  if (Object.keys(canonical).length === 0) {
    return { skip: true, reason: "empty_canonical", sessionId, time: recordedAtIso };
  }

  const attemptId = `dsh-${sessionId}-${turn}-${step}-${seq}`;
  const model = typeof chunk.model === "string" ? chunk.model : null;

  return {
    skip: false,
    envelope: {
      host: HOST_LABEL,
      attempt_id: attemptId,
      model,
      run_id: sessionId,
      usage: canonical,
      recorded_at: recordedAtIso,
      status: "host_reported",
    },
  };
}

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
  if (receipts.length === 0) return { ok: false, build_errors: buildErrors };
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
    dsh_home: opts.dshHome,
    project_root: opts.projectRoot,
    ledger_dir: opts.ledgerDir,
    started_at: new Date().toISOString(),
    counters: {
      sessions_scanned: 0,
      events_parsed: 0,
      events_mapped: 0,
      events_skipped: 0,
      skipped_by_reason: {},
      written: 0,
      duplicates: 0,
      submit_errors: 0,
      zstd_errors: 0,
    },
    by_slug: {},
    finished_at: null,
    duration_ms: null,
  };

  if (!fs.existsSync(opts.dshHome)) {
    summary.ok = false;
    summary.error = "dsh_home_not_found";
    summary.finished_at = new Date().toISOString();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const sessions = listSessionDirs(opts.dshHome, opts.sessionSlug);
  summary.counters.sessions_scanned = sessions.length;

  let batch = [];
  function flushBatch() {
    if (batch.length === 0) return null;
    const submitResult = submitBatch(opts.ledgerDir, batch);
    summary.counters.written += submitResult.written || 0;
    summary.counters.duplicates += submitResult.duplicates || 0;
    summary.counters.submit_errors += submitResult.errors || 0;
    for (const buildErr of (submitResult.build_errors || [])) {
      summary.counters.submit_errors += 1;
      summary.counters.skipped_by_reason.build_error =
        (summary.counters.skipped_by_reason.build_error || 0) + 1;
    }
    batch = [];
    return submitResult;
  }

  for (const session of sessions) {
    summary.by_slug[session.slug] = summary.by_slug[session.slug] || { mapped: 0, skipped: 0 };
    const { lines, error } = await readZstdLinesAsync(session.jsonlPath);
    if (error) {
      summary.counters.zstd_errors += 1;
      summary.counters.skipped_by_reason.zstd_error =
        (summary.counters.skipped_by_reason.zstd_error || 0) + 1;
      continue;
    }
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        summary.counters.skipped_by_reason.parse_error =
          (summary.counters.skipped_by_reason.parse_error || 0) + 1;
        continue;
      }
      summary.counters.events_parsed += 1;
      const result = mapEvent(raw, opts, session.sessionId);
      if (result.skip) {
        summary.counters.events_skipped += 1;
        summary.counters.skipped_by_reason[result.reason] =
          (summary.counters.skipped_by_reason[result.reason] || 0) + 1;
        summary.by_slug[session.slug].skipped += 1;
        continue;
      }
      summary.counters.events_mapped += 1;
      summary.by_slug[session.slug].mapped += 1;
      if (opts.apply) {
        batch.push(result.envelope);
        const remaining = opts.limit ? Math.max(0, opts.limit - summary.counters.written) : Infinity;
        if (batch.length >= opts.batchSize || batch.length >= remaining) {
          flushBatch();
          if (opts.limit && summary.counters.written >= opts.limit) break;
        }
      }
      if (opts.limit && summary.counters.written >= opts.limit) break;
    }
    if (opts.limit && summary.counters.written >= opts.limit) break;
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