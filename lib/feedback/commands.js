"use strict";

// ─── P-001 Feedback Commands (F-005) ────────────────────────────────────────
//
// CLI implementations for `feedback log | status | ingest-event`.
// Per `.agent/plans/proposals/projects/feedback-pipeline/proposals/P-001-collection-proposal.md`
// §6 (CLI 契约) and §6.4 (退出码).
//
// Public API:
//   • runLog(argv, env)           → writes one event, returns exit code
//   • runStatus(argv, env)        → read-only summary, never writes
//   • runIngestEvent(argv, env)   → adapter-only event intake
//
// All commands return { exitCode, stdout?, stderr?, payload? }. The actual
// bin/cli.js routing just propagates these. The module never throws to the
// caller; every error path produces a structured payload + exit code.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  validateEvent,
  ALLOWED_KINDS,
  ALLOWED_SEVERITIES,
  ALLOWED_ADAPTERS,
  isTestContext,
} = require("./event-schema");
const { redactEventFields, summarizeForReceipt } = require("./redact");
const {
  inboxRootFor,
  appendEvent,
  readInbox,
  listEvents,
  summarize,
} = require("./inbox");
const {
  discoverConfig,
  ensureWriteSafe,
  applyCliOverrides,
  ConfigError,
} = require("./config");

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_ARGS = 3;
const EXIT_IO = 4;
const EXIT_DISABLED = 5;
const EXIT_INSECURE = 6;

// ─── argv helpers ──────────────────────────────────────────────────────────

function parseArgv(argv) {
  // Lightweight argv parser; we intentionally do NOT take flags we do not
  // understand so the contract §6.1/§6.2 fails closed for unknown args.
  const out = { _: [], opts: {}, json: false, project: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--project") {
      const v = argv[++i];
      out.project = v && !v.startsWith("--") ? v : null;
    } else if (arg && arg.startsWith("--project=")) out.project = arg.slice("--project=".length);
    else if (arg && arg.startsWith("--")) out.opts[arg.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? (i++, argv[i]) : true;
    else out._.push(arg);
  }
  return out;
}

function rejectUnknown(opts, allowed, commandName) {
  const unknown = Object.keys(opts).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return null;
  return {
    exitCode: EXIT_ARGS,
    stderr: `cortex-agent feedback ${commandName}: unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}`,
  };
}

// ─── Output formatting ─────────────────────────────────────────────────────

function jsonLine(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function toHumanSummary(rows, opts = {}) {
  if (rows.length === 0) {
    return "Feedback inbox is empty.\n";
  }
  const limit = typeof opts.limit === "number" ? opts.limit : rows.length;
  const lines = [];
  lines.push(`Feedback inbox (showing ${Math.min(limit, rows.length)} of ${rows.length}):`);
  for (const row of rows.slice(0, limit)) {
    lines.push(`  [${row.event.occurred_at}] ${row.event.kind}/${row.event.severity} ${row.event.title}  (${row.event.fingerprint.slice(0, 16)}…)`);
    if (row.event.summary) lines.push(`      ${row.event.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

// ─── runLog ────────────────────────────────────────────────────────────────

const LOG_ALLOWED = new Set(["title", "kind", "severity", "project-slug", "summary", "diagnostic-code", "tags", "occurred-at", "run-ref"]);

function resolveProjectRoot(argv, env = process.env) {
  // Priority: argv --project > CORTEX_AGENT_FEEDBACK_PROJECT_ROOT env > process.cwd()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        return path.resolve(process.cwd(), value);
      }
    } else if (typeof arg === "string" && arg.startsWith("--project=")) {
      return path.resolve(process.cwd(), arg.slice("--project=".length));
    }
  }
  if (env && env.CORTEX_AGENT_FEEDBACK_PROJECT_ROOT) {
    return path.resolve(env.CORTEX_AGENT_FEEDBACK_PROJECT_ROOT);
  }
  return process.cwd();
}

function runLog(argv, env = process.env) {
  const parsed = parseArgv(argv);
  if (parsed.help) return { exitCode: EXIT_OK, stdout: usageFor("log") };
  const unknown = rejectUnknown(parsed.opts, LOG_ALLOWED, "log");
  if (unknown) return unknown;
  const opts = parsed.opts;
  if (!opts["title"]) {
    return { exitCode: EXIT_ARGS, stderr: "cortex-agent feedback log: --title is required" };
  }
  if (!opts.kind || !ALLOWED_KINDS.includes(opts.kind)) {
    return {
      exitCode: EXIT_ARGS,
      stderr: `cortex-agent feedback log: --kind must be one of ${ALLOWED_KINDS.join(", ")}`,
    };
  }
  if (!opts.severity || !ALLOWED_SEVERITIES.includes(opts.severity)) {
    return {
      exitCode: EXIT_ARGS,
      stderr: `cortex-agent feedback log: --severity must be one of ${ALLOWED_SEVERITIES.join(", ")}`,
    };
  }
  if (!opts["project-slug"]) {
    return { exitCode: EXIT_ARGS, stderr: "cortex-agent feedback log: --project-slug is required" };
  }
  let projectRoot = resolveProjectRoot(argv, env);
  let configResult;
  try {
    configResult = discoverConfig({ root: projectRoot, env });
  } catch (error) {
    if (error instanceof ConfigError) {
      return { exitCode: EXIT_INSECURE, stderr: `cortex-agent feedback log: ${error.message}`, code: error.code };
    }
    return { exitCode: EXIT_IO, stderr: `cortex-agent feedback log: config error: ${error.message}` };
  }
  const config = applyCliOverrides(configResult.config, {});
  if (config.enabled !== true) {
    return {
      exitCode: EXIT_DISABLED,
      stderr: "cortex-agent feedback log: feedback is disabled (set feedback.enabled=true in config to enable)",
      payload: { ok: false, code: "FEEDBACK_DISABLED" },
    };
  }
  const safe = ensureWriteSafe(config);
  if (!safe.ok) {
    return {
      exitCode: EXIT_INSECURE,
      stderr: `cortex-agent feedback log: write path is unsafe (${safe.reason})`,
      payload: { ok: false, code: "FEEDBACK_UNSAFE" },
    };
  }
  const now = new Date().toISOString();
  const event = {
    schema_version: 1,
    event_id: `fev_${crypto.randomUUID()}`,
    occurred_at: opts["occurred-at"] || now,
    kind: opts.kind,
    severity: opts.severity,
    title: String(opts.title),
    source: {
      adapter: "manual",
      project_slug: String(opts["project-slug"]),
    },
    fingerprint: "pending",
  };
  if (opts.summary) event.summary = String(opts.summary);
  if (opts["diagnostic-code"]) event.diagnostic_code = String(opts["diagnostic-code"]);
  if (opts.run_ref) event.source.run_ref = String(opts["run-ref"]);
  if (opts.tags) {
    event.tags = String(opts.tags)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const redaction = redactEventFields(event);
  const validation = validateEvent(redaction.event, { adapterEnabled: true });
  if (!validation.ok) {
    return {
      exitCode: EXIT_ARGS,
      stderr: `cortex-agent feedback log: schema error: ${validation.errors.join("; ")}`,
      payload: { ok: false, errors: validation.errors },
    };
  }
  const inboxRoot = inboxRootFor(projectRoot);
  try {
    fs.mkdirSync(inboxRoot, { recursive: true, mode: 0o700 });
  } catch (_) { /* best-effort */ }
  const result = appendEvent({
    inboxRoot,
    event: validation.event,
    redact: false, // already redacted above
    byteLimit: config.storage && config.storage.max_event_bytes,
    dayCapacity: config.storage && config.storage.max_events_per_day,
  });
  if (!result.ok) {
    if (result.code === "OVER_LIMIT") {
      return {
        exitCode: EXIT_ARGS,
        stderr: `cortex-agent feedback log: payload exceeds ${result.limit} bytes (got ${result.bytes})`,
        payload: { ok: false, code: result.code, bytes: result.bytes, limit: result.limit },
      };
    }
    if (result.code === "DAY_CAPACITY_REACHED") {
      return {
        exitCode: EXIT_IO,
        stderr: `cortex-agent feedback log: day capacity reached (${result.existing}/${result.capacity})`,
        payload: { ok: false, code: result.code, day: result.day },
      };
    }
    return {
      exitCode: EXIT_IO,
      stderr: `cortex-agent feedback log: write failed (${result.code})`,
      payload: { ok: false, code: result.code },
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: jsonLine({
      ok: true,
      event_id: result.event_id,
      fingerprint: result.fingerprint,
      path: result.relative_path,
      bytes: result.bytes,
      redaction: summarizeForReceipt(redaction.applied),
    }),
    payload: { ok: true, event_id: result.event_id, fingerprint: result.fingerprint },
  };
}

// ─── runStatus ────────────────────────────────────────────────────────────

const STATUS_ALLOWED = new Set(["since", "kind", "severity", "limit", "json"]);

function runStatus(argv, env = process.env) {
  const parsed = parseArgv(argv);
  if (parsed.help) return { exitCode: EXIT_OK, stdout: usageFor("status") };
  const unknown = rejectUnknown(parsed.opts, STATUS_ALLOWED, "status");
  if (unknown) return unknown;
  // `json` lives as both a flag and as a key under opts depending on parse;
  // treat its presence as json output. The flag form (--json) is parsed by
  // parseArgv already; the opts key is for the rare `--json true` form.
  const wantJson = parsed.json || parsed.opts.json === true || parsed.opts.json === "true";
  let projectRoot = resolveProjectRoot(argv, env);
  let configResult;
  try {
    configResult = discoverConfig({ root: projectRoot, env });
  } catch (error) {
    if (error instanceof ConfigError) {
      return { exitCode: EXIT_INSECURE, stderr: `cortex-agent feedback status: ${error.message}`, code: error.code };
    }
    return { exitCode: EXIT_IO, stderr: `cortex-agent feedback status: config error: ${error.message}` };
  }
  const config = configResult.config;
  const inboxRoot = inboxRootFor(projectRoot);
  const opts = parsed.opts;
  let rows;
  try {
    rows = listEvents({
      inboxRoot,
      kind: opts.kind,
      severity: opts.severity,
      since: opts.since,
    });
  } catch (error) {
    return {
      exitCode: EXIT_IO,
      stderr: `cortex-agent feedback status: read failed (${error.code || error.message})`,
      payload: { ok: false, code: "READ_ERROR" },
    };
  }
  const summary = summarize({ inboxRoot });
  const limit = typeof opts.limit === "string" ? parseInt(opts.limit, 10) : (typeof opts.limit === "number" ? opts.limit : undefined);
  const limited = typeof limit === "number" && Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  const payload = {
    ok: true,
    enabled: config.enabled === true,
    inboxRoot,
    summary,
    rows: limited.map((row) => ({ ...row.event, _path: row.path })),
    diagnostics: summary.diagnostics,
  };
  // status must distinguish "valid empty" from "I/O error". The listEvents
  // call above never throws on ENOENT — empty means empty.
  if (wantJson) {
    return { exitCode: EXIT_OK, stdout: jsonLine(payload) };
  }
  return {
    exitCode: EXIT_OK,
    stdout: toHumanSummary(limited, { limit }),
    payload,
  };
}

// ─── runIngestEvent ────────────────────────────────────────────────────────

const INGEST_ALLOWED = new Set(["adapter", "event-json", "event-json-file"]);

function runIngestEvent(argv, env = process.env) {
  const parsed = parseArgv(argv);
  if (parsed.help) return { exitCode: EXIT_OK, stdout: usageFor("ingest-event") };
  const unknown = rejectUnknown(parsed.opts, INGEST_ALLOWED, "ingest-event");
  if (unknown) return unknown;
  const opts = parsed.opts;
  if (!opts.adapter) {
    return { exitCode: EXIT_ARGS, stderr: "cortex-agent feedback ingest-event: --adapter is required" };
  }
  if (!ALLOWED_ADAPTERS.includes(opts.adapter)) {
    return {
      exitCode: EXIT_ARGS,
      stderr: `cortex-agent feedback ingest-event: --adapter must be one of ${ALLOWED_ADAPTERS.join(", ")}`,
    };
  }
  if (opts.adapter === "test-fixture" && !isTestContext(env)) {
    return {
      exitCode: EXIT_ARGS,
      stderr: "cortex-agent feedback ingest-event: test-fixture adapter only allowed in CORTEX_AGENT_FEEDBACK_TEST_CONTEXT=1",
    };
  }
  let rawJson;
  if (opts["event-json"]) {
    rawJson = String(opts["event-json"]);
  } else if (opts["event-json-file"]) {
    try {
      rawJson = fs.readFileSync(opts["event-json-file"], "utf8");
    } catch (error) {
      return {
        exitCode: EXIT_IO,
        stderr: `cortex-agent feedback ingest-event: cannot read --event-json-file: ${error.message}`,
      };
    }
  } else {
    return {
      exitCode: EXIT_ARGS,
      stderr: "cortex-agent feedback ingest-event: --event-json or --event-json-file is required",
    };
  }
  let parsedEvent;
  try {
    parsedEvent = JSON.parse(rawJson);
  } catch (error) {
    return {
      exitCode: EXIT_ARGS,
      stderr: `cortex-agent feedback ingest-event: --event-json is not valid JSON: ${error.message}`,
    };
  }
  let projectRoot = resolveProjectRoot(argv, env);
  let configResult;
  try {
    configResult = discoverConfig({ root: projectRoot, env });
  } catch (error) {
    if (error instanceof ConfigError) {
      return { exitCode: EXIT_INSECURE, stderr: `cortex-agent feedback ingest-event: ${error.message}`, code: error.code };
    }
    return { exitCode: EXIT_IO, stderr: `cortex-agent feedback ingest-event: config error: ${error.message}` };
  }
  const config = applyCliOverrides(configResult.config, {});
  if (config.enabled !== true) {
    return {
      exitCode: EXIT_DISABLED,
      stderr: "cortex-agent feedback ingest-event: feedback is disabled",
      payload: { ok: false, code: "FEEDBACK_DISABLED" },
    };
  }
  // Force the adapter to the one we declared. Reject events whose source
  // declares a different adapter than the CLI flag — that prevents
  // smuggling.
  if (!parsedEvent.source || typeof parsedEvent.source !== "object") {
    return {
      exitCode: EXIT_ARGS,
      stderr: "cortex-agent feedback ingest-event: event must declare source",
    };
  }
  if (parsedEvent.source.adapter !== opts.adapter) {
    return {
      exitCode: EXIT_ARGS,
      stderr: `cortex-agent feedback ingest-event: source.adapter "${parsedEvent.source.adapter}" does not match --adapter "${opts.adapter}"`,
    };
  }
  const adapterEnabledMap = new Map([
    ["cortex_diagnostic", config.adapters && config.adapters.cortex_diagnostic === true],
    ["evolution_observation", config.adapters && config.adapters.evolution_observation === true],
  ]);
  const redaction = redactEventFields(parsedEvent);
  const validation = validateEvent(redaction.event, {
    adapterEnabled: true,
    adapterEnabledMap,
  });
  if (!validation.ok) {
    return {
      exitCode: EXIT_ARGS,
      stderr: `cortex-agent feedback ingest-event: schema error: ${validation.errors.join("; ")}`,
      payload: { ok: false, errors: validation.errors },
    };
  }
  const inboxRoot = inboxRootFor(projectRoot);
  try {
    fs.mkdirSync(inboxRoot, { recursive: true, mode: 0o700 });
  } catch (_) { /* best-effort */ }
  const result = appendEvent({
    inboxRoot,
    event: validation.event,
    redact: false,
    byteLimit: config.storage && config.storage.max_event_bytes,
    dayCapacity: config.storage && config.storage.max_events_per_day,
  });
  if (!result.ok) {
    if (result.code === "OVER_LIMIT") {
      return {
        exitCode: EXIT_ARGS,
        stderr: `cortex-agent feedback ingest-event: payload exceeds ${result.limit} bytes (got ${result.bytes})`,
        payload: { ok: false, code: result.code, bytes: result.bytes, limit: result.limit },
      };
    }
    if (result.code === "DAY_CAPACITY_REACHED") {
      return {
        exitCode: EXIT_IO,
        stderr: `cortex-agent feedback ingest-event: day capacity reached (${result.existing}/${result.capacity})`,
        payload: { ok: false, code: result.code, day: result.day },
      };
    }
    return {
      exitCode: EXIT_IO,
      stderr: `cortex-agent feedback ingest-event: write failed (${result.code})`,
      payload: { ok: false, code: result.code },
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: jsonLine({
      ok: true,
      event_id: result.event_id,
      fingerprint: result.fingerprint,
      path: result.relative_path,
      bytes: result.bytes,
      redaction: summarizeForReceipt(redaction.applied),
    }),
    payload: { ok: true, event_id: result.event_id, fingerprint: result.fingerprint },
  };
}

// ─── usage text ────────────────────────────────────────────────────────────

function usageFor(subcommand) {
  switch (subcommand) {
    case "log":
      return [
        "Usage: cortex-agent feedback log [options]",
        "",
        "Options:",
        "  --title <text>           Required. Short title of the event.",
        "  --kind <kind>            Required. One of blocker | observation | question | feature-request.",
        "  --severity <severity>    Required. One of low | medium | high | critical.",
        "  --project-slug <slug>    Required. Local project slug (no absolute path).",
        "  --summary <text>         Optional longer summary.",
        "  --diagnostic-code <code> Optional structured diagnostic code.",
        "  --tags <a,b,c>           Optional comma-separated tags.",
        "  --occurred-at <iso>      Optional ISO 8601 timestamp (default: now).",
        "  --run-ref <ref>          Optional opaque local reference.",
        "  --project <path>         Optional project root override.",
        "  --json                   Emit machine-readable JSON.",
        "  --help                   Show this help.",
      ].join("\n") + "\n";
    case "status":
      return [
        "Usage: cortex-agent feedback status [options]",
        "",
        "Read-only summary of the local feedback inbox.",
        "",
        "Options:",
        "  --since <spec>           Limit to events after the given window (e.g. 7d, 24h).",
        "  --kind <kind>            Filter by kind.",
        "  --severity <sev>         Filter by severity.",
        "  --limit <n>              Cap the number of rows in human output.",
        "  --project <path>         Optional project root override.",
        "  --json                   Emit machine-readable JSON.",
        "  --help                   Show this help.",
      ].join("\n") + "\n";
    case "ingest-event":
      return [
        "Usage: cortex-agent feedback ingest-event [options]",
        "",
        "Adapter-only intake. Accepts only registered adapters and a whitelist-validated JSON payload.",
        "",
        "Options:",
        "  --adapter <name>         Required. Registered adapter (cortex-diagnostic, evolution-observation, test-fixture).",
        "  --event-json <json>      Required (one of). Inline JSON event payload.",
        "  --event-json-file <path>  Required (one of). Path to JSON event payload file.",
        "  --project <path>         Optional project root override.",
        "  --json                   Emit machine-readable JSON.",
        "  --help                   Show this help.",
      ].join("\n") + "\n";
    default:
      return [
        "Usage: cortex-agent feedback <log|status|ingest-event> [options]",
        "",
        "Subcommands:",
        "  log            Explicit, manual feedback event (--title, --kind, --severity, --project-slug).",
        "  status         Read-only summary of the local feedback inbox.",
        "  ingest-event   Adapter-only intake of a whitelist-validated JSON event.",
      ].join("\n") + "\n";
  }
}

// ─── dispatch ──────────────────────────────────────────────────────────────

function runFeedback(argv, env = process.env) {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    return { exitCode: EXIT_OK, stdout: usageFor("") };
  }
  switch (sub) {
    case "log": return runLog(argv.slice(1), env);
    case "status": return runStatus(argv.slice(1), env);
    case "ingest-event": return runIngestEvent(argv.slice(1), env);
    default:
      return {
        exitCode: EXIT_USAGE,
        stderr: `cortex-agent feedback: unknown subcommand "${sub}". Run \`cortex-agent feedback --help\`.`,
      };
  }
}

module.exports = {
  runFeedback,
  runLog,
  runStatus,
  runIngestEvent,
  parseArgv,
  toHumanSummary,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_ARGS,
  EXIT_IO,
  EXIT_DISABLED,
  EXIT_INSECURE,
};