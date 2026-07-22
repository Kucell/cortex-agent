"use strict";

// ─── subagent-trace (L1 subagent-fanout-trace — receiver CLI) ──────────────
// Phase 2 of the subagent-fanout-trace proposal.  Hosts (Claude Code /
// Cursor / Codex) push sub-agent lifecycle events through `emit`; this
// CLI appends them to `runs/<active>.json#subagent_fanout[]` (one entry
// per sub-agent) AND to `runs/<active>.json#events[]` (Phase 1 audit-
// trail stream).  Read-side: `list` and `tree` reconstruct the fan-out
// tree for the dashboard or a future agent.
//
// Source of truth: ../scripts/match-trigger.js for the trigger keyword
// table; templates/{zh,en}/.agent/agent-protocols/subagent-fanout.md
// for the event schema.  Do NOT redefine those here.
//
// Effects on .agent/ state:
//   - emit / progress / completed / cancelled events go to
//     runs/<active>.json#events[] AND runs/<active>.json#subagent_fanout[]
//   - on subagent_completed status=failed, optionally writes an inbox
//     message to the parent run (--notify-on-fail flag, default false)

const fs = require("fs");
const path = require("path");

const AGENT_ROOT = path.join(process.cwd(), ".agent");
const RUNS_DIR = path.join(AGENT_ROOT, "runs");

const EVENTS = new Set([
  "subagent_spawned",
  "subagent_progress",
  "subagent_completed",
  "subagent_cancelled",
]);
const STATUSES = new Set(["success", "partial", "failed"]);
const GATES_AGENT = new Set(["agent", "user", "mission"]);

function flag(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(error, message, code = 2) {
  emit({ ok: false, error, message });
  process.exit(code);
}

function requireGate(allowed) {
  const argv = process.argv.slice(2);
  const gate = flag("--gate", argv);
  // Accept both Array and Set to avoid a runtime type mismatch when callers
  // pass module-level Set constants (GATES_AGENT etc.).
  const ok = Array.isArray(allowed) ? allowed.includes(gate) : allowed && allowed.has ? allowed.has(gate) : false;
  if (!ok) {
    const list = Array.isArray(allowed) ? allowed : (allowed ? [...allowed] : []);
    fail("workflow_gate_required", `--gate must be one of: ${list.join(", ")}`);
  }
  return gate;
}

// ─── run discovery (reuses audit-trail Phase 1 helper shape) ───────────────
function findRun(runId) {
  if (runId) {
    const file = path.join(RUNS_DIR, `${runId}.json`);
    if (!fs.existsSync(file)) return null;
    try { return { runId, file, body: JSON.parse(fs.readFileSync(file, "utf8")) }; }
    catch { return null; }
  }
  if (!fs.existsSync(RUNS_DIR)) return null;
  const files = fs.readdirSync(RUNS_DIR)
    .filter((n) => n.endsWith(".json") && !["README.md", "index.json"].includes(n) && !n.endsWith(".schema.json"));
  const enriched = files.map((name) => {
    const file = path.join(RUNS_DIR, name);
    try { return { name, mtime: fs.statSync(file).mtimeMs, body: JSON.parse(fs.readFileSync(file, "utf8")), file }; }
    catch { return null; }
  }).filter(Boolean);
  enriched.sort((a, b) => b.mtime - a.mtime);
  for (const f of enriched) {
    if (f.body && (f.body.status === "running" || f.body.status === "queued")) {
      return { runId: f.name.replace(/\.json$/, ""), file: f.file, body: f.body };
    }
  }
  return enriched[0]
    ? { runId: enriched[0].name.replace(/\.json$/, ""), file: enriched[0].file, body: enriched[0].body }
    : null;
}

function ensureFanoutArray(runBody) {
  if (!Array.isArray(runBody.subagent_fanout)) runBody.subagent_fanout = [];
}

function findFanoutEntry(runBody, subagentId) {
  ensureFanoutArray(runBody);
  return runBody.subagent_fanout.find((e) => e && e.subagent_id === subagentId);
}

function appendRunFile(file, body) {
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", "utf8");
}

// ─── emit (write one lifecycle event) ──────────────────────────────────────
function cmdEmit(argv) {
  requireGate(GATES_AGENT);
  const ev = flag("--event", argv);
  if (!ev) fail("missing_event", "--event is required (subagent_spawned | subagent_progress | subagent_completed | subagent_cancelled).");
  if (!EVENTS.has(ev)) {
    fail("unknown_event", `--event must be one of: ${[...EVENTS].join(", ")}.`);
  }

  const run = findRun(flag("--parent-run-id", argv) || flag("--run-id", argv));
  if (!run) fail("no_active_run", "no parent run found; pass --parent-run-id or run session-triage first.");

  const subagentId = flag("--subagent-id", argv);
  if (!subagentId) fail("missing_subagent_id", "--subagent-id is required for any subagent_* event.");

  const now = new Date().toISOString();
  const event = { type: ev, at: now };
  if (ev === "subagent_spawned") {
    const role = flag("--subagent-role", argv);
    if (!role) fail("missing_subagent_role", "--subagent-role required for subagent_spawned.");
    event.parent_run_id = run.runId;
    event.subagent_id = subagentId;
    event.subagent_role = role;
    for (const k of ["task_description", "expected_duration_minutes", "tools_granted", "model"]) {
      const v = flag(`--${k.replace(/_/g, "-")}`, argv);
      if (v != null) event[k] = v;
    }
  } else if (ev === "subagent_progress") {
    event.subagent_id = subagentId;
    for (const k of ["percent", "current_step", "tool_calls_count"]) {
      const v = flag(`--${k.replace(/_/g, "-")}`, argv);
      if (v != null) event[k] = v;
    }
  } else if (ev === "subagent_completed") {
    const status = flag("--status", argv);
    if (!status) fail("missing_status", "--status required (success | partial | failed).");
    if (!STATUSES.has(status)) fail("invalid_status", `--status must be one of: ${[...STATUSES].join(", ")}.`);
    event.subagent_id = subagentId;
    event.status = status;
    for (const k of ["output_summary", "duration_actual_seconds", "transcript_ref"]) {
      const v = flag(`--${k.replace(/_/g, "-")}`, argv);
      if (v != null) event[k] = v;
    }
    const artifacts = flag("--output-artifact-refs", argv);
    if (artifacts) event.output_artifact_refs = artifacts.split(",").map((s) => s.trim()).filter(Boolean);
    const toolFailures = flag("--tool-failures-count", argv);
    if (toolFailures) event.tool_failures_count = Number(toolFailures);
  } else if (ev === "subagent_cancelled") {
    const reason = flag("--reason", argv);
    if (!reason) fail("missing_reason", "--reason required for subagent_cancelled.");
    event.subagent_id = subagentId;
    event.reason = reason;
  }

  // ── double-write: events[] + subagent_fanout[] ──
  // events[] — audit-trail flat stream
  if (!Array.isArray(run.body.events)) run.body.events = [];
  run.body.events = [...run.body.events, { ...event }].slice(-200);
  run.body.last_event = run.body.events[run.body.events.length - 1];

  // subagent_fanout[] — per-sub-agent array entry
  ensureFanoutArray(run.body);
  if (ev === "subagent_spawned") {
    run.body.subagent_fanout.push({
      subagent_id: subagentId,
      role: event.subagent_role,
      status: "running",
      spawned_at: event.at,
      last_event_at: event.at,
      events: [{ type: ev, at: event.at }],
    });
  } else {
    const entry = findFanoutEntry(run.body, subagentId);
    if (entry) {
      entry.events = Array.isArray(entry.events) ? entry.events : [];
      entry.events.push({ type: ev, at: event.at });
      entry.last_event_at = event.at;
      if (ev === "subagent_completed") entry.final_status = event.status;
      if (ev === "subagent_cancelled") entry.cancellation_reason = event.reason;
      if (ev === "subagent_progress") {
        entry.progress = entry.progress || [];
        entry.progress.push({ at: event.at, percent: event.percent != null ? Number(event.percent) : undefined, current_step: event.current_step, tool_calls_count: event.tool_calls_count != null ? Number(event.tool_calls_count) : undefined });
      }
    } else {
      // No prior spawned entry — synthesize a placeholder so events are
      // still recorded.  Useful when host pushes progress before
      // emitting spawned.
      run.body.subagent_fanout.push({
        subagent_id: subagentId,
        role: "(unknown — spawned event was not emitted)",
        status: ev === "subagent_completed" ? status : "running",
        spawned_at: event.at,
        last_event_at: event.at,
        events: [{ type: ev, at: event.at }],
      });
    }
  }
  run.body.updated_at = now;
  appendRunFile(run.file, run.body);

  // Optional inbox notification on failure
  if (ev === "subagent_completed" && event.status === "failed" && argv.includes("--notify-on-fail")) {
    const inboxDir = path.join(AGENT_ROOT, "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const inboxFile = path.join(inboxDir, `IM-${stamp}-fanout-fail.json`);
    fs.writeFileSync(inboxFile, JSON.stringify({
      schema_version: 1,
      message_id: `IM-${stamp}-fanout-fail`,
      type: "alert",
      status: "unread",
      sender_id: "subagent-trace",
      recipient_ids: [run.runId],
      subject: `subagent ${subagentId} failed`,
      body: event.output_summary || `subagent ${subagentId} (role=${event.subagent_role || "?"}) failed at ${event.at}.`,
      relations: { task_ids: [], mission_ids: [], run_ids: [run.runId], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] },
      created_at: event.at,
      updated_at: event.at,
    }, null, 2));
    return emit({ ok: true, action: "emit", event, run_id: run.runId, inbox_notified: inboxFile });
  }

  emit({ ok: true, action: "emit", event, run_id: run.runId });
}

// ─── list (read fanout array) ───────────────────────────────────────────
function cmdList(argv) {
  const run = findRun(flag("--parent-run-id", argv) || flag("--run-id", argv));
  if (!run) fail("no_run", "no run found.");
  ensureFanoutArray(run.body);
  const subagents = run.body.subagent_fanout.map((e) => ({
    subagent_id: e.subagent_id,
    role: e.role,
    status: e.final_status || e.status || "running",
    spawned_at: e.spawned_at,
    last_event_at: e.last_event_at,
    event_count: Array.isArray(e.events) ? e.events.length : 0,
  }));
  emit({ ok: true, action: "list", run_id: run.runId, count: subagents.length, subagents });
}

// ─── tree (render nested tree with status) ──────────────────────────────
function cmdTree(argv) {
  const run = findRun(flag("--parent-run-id", argv) || flag("--run-id", argv));
  if (!run) fail("no_run", "no run found.");
  ensureFanoutArray(run.body);
  // For Phase 2 we have a flat list (no nested sub-sub-agents yet).
  // Render as 2-level tree: parent run → list of children.
  const children = run.body.subagent_fanout.map((e) => ({
    subagent_id: e.subagent_id,
    role: e.role,
    status: e.final_status || e.status || "running",
    spawned_at: e.spawned_at,
    last_event_at: e.last_event_at,
    children: [],
  }));
  const tree = {
    run_id: run.runId,
    status: run.body.status || "unknown",
    phase: run.body.phase || null,
    started_at: run.body.started_at || null,
    children,
  };
  emit({ ok: true, action: "tree", tree });
}

// ─── dispatch ────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const [command] = argv;
  if (command === "emit") return cmdEmit(argv);
  if (command === "list") return cmdList(argv);
  if (command === "tree") return cmdTree(argv);
  fail("unknown_command", "Usage: subagent-trace {emit|list|tree} [--gate agent] ...");
}

if (require.main === module) main();
module.exports = { findRun, cmdEmit, cmdList, cmdTree, EVENTS, STATUSES };
