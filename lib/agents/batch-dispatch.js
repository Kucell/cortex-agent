"use strict";

// ─── Batch Dispatch (M-034 follow-up / DSH multi-session scheduling) ─────────
//
// `cortex-agent agent dispatch-batch --tasks <file.json>` runs a *set* of
// agent tasks through the ordinary per-adapter `invoke()` path and reports one
// aggregate outcome.
//
// Why this exists
// ---------------
// `dispatch-execute` is one task, one agent, one run. The DSH headless host
// can hold a *resumable* session (`dsh --profile headless --json --session-id
// <id> -` restores the conversation), which makes "run N tasks across N DSH
// sessions" a real capability rather than a claim. This module is the small,
// honest driver for that: it fans out over the existing adapter registry, it
// does not spawn processes itself, and it never reports a task as settled
// unless the adapter said so.
//
// Boundaries (deliberate)
// -----------------------
//   - In scope: task-file parsing, agent/adapter resolution, bounded parallel
//     fan-out, per-item run journals, an aggregate summary artifact.
//   - Out of scope: spawning subprocesses directly (the adapter owns that),
//     daemon mode, automatic dispatch, lease acquisition, notifications,
//     credential resolution.
//
// Concurrency
// -----------
// Default is 1 (sequential). Parallelism is opt-in through `--concurrency`:
// several DSH workers editing the same working tree can collide, so the
// driver never widens that blast radius on its own. Run parallel tasks in
// separate worktrees.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const adapters = require("./adapters");
const { readAgentExt, splitAdapterQualifiedId } = require("./registry-ext");

const MAX_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_BATCH_TIMEOUT = 300;
const TEXT_EXCERPT = 2000;

class BatchDispatchError extends Error {
  constructor(code, message, details = {}) {
    super(`[dispatch-batch:${code}] ${message}`);
    this.name = "BatchDispatchError";
    this.code = code;
    this.details = details;
  }
}

// ─── task file ───────────────────────────────────────────────────────────────

// Accepts either a bare array of task objects or `{ "tasks": [...] }`.
function parseTasksPayload(raw, sourceLabel) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new BatchDispatchError(
      "ERR_BATCH_TASK_FILE_PARSE",
      `tasks file is not valid JSON: ${err.message}`,
      { source: sourceLabel },
    );
  }
  const list = Array.isArray(payload) ? payload : (payload && payload.tasks);
  if (!Array.isArray(list)) {
    throw new BatchDispatchError(
      "ERR_BATCH_TASK_FILE_SHAPE",
      "tasks file must be a JSON array or an object with a `tasks` array",
      { source: sourceLabel },
    );
  }
  if (list.length === 0) {
    throw new BatchDispatchError(
      "ERR_BATCH_NO_TASKS",
      "tasks file contains no tasks",
      { source: sourceLabel },
    );
  }
  const labels = new Set();
  return list.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BatchDispatchError(
        "ERR_BATCH_TASK_SHAPE",
        `task #${index} must be an object`,
        { source: sourceLabel, index },
      );
    }
    const agentId = typeof item.agent_id === "string" ? item.agent_id.trim() : "";
    if (!agentId) {
      throw new BatchDispatchError(
        "ERR_BATCH_TASK_AGENT_MISSING",
        `task #${index} is missing agent_id`,
        { source: sourceLabel, index },
      );
    }
    const task = typeof item.task === "string" ? item.task : "";
    const hasInput = item.input !== undefined && item.input !== null;
    if (!task.trim() && !hasInput) {
      throw new BatchDispatchError(
        "ERR_BATCH_TASK_TEXT_MISSING",
        `task #${index} needs a non-empty "task" (or an "input" payload)`,
        { source: sourceLabel, index },
      );
    }
    const label = typeof item.label === "string" && item.label.trim()
      ? item.label.trim()
      : `task-${String(index + 1).padStart(2, "0")}`;
    if (labels.has(label)) {
      throw new BatchDispatchError(
        "ERR_BATCH_DUPLICATE_LABEL",
        `duplicate task label "${label}"`,
        { source: sourceLabel, index, label },
      );
    }
    labels.add(label);
    const timeout = Number(item.timeout);
    return {
      label,
      agent_id: agentId,
      task,
      input: hasInput ? item.input : null,
      session_id: typeof item.session_id === "string" && item.session_id.trim()
        ? item.session_id.trim()
        : null,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
    };
  });
}

function loadTasksFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new BatchDispatchError(
      "ERR_BATCH_TASK_FILE_MISSING",
      `tasks file not found: ${abs}`,
      { path: abs },
    );
  }
  return parseTasksPayload(fs.readFileSync(abs, "utf8"), abs);
}

// ─── target resolution ───────────────────────────────────────────────────────

// Resolve one task's agent entry + adapter. Mirrors the dispatch-execute
// resolution rules (adapter-qualified id, prefix check, registered adapter).
function resolveTarget(projectRoot, qualifiedId) {
  const qualified = splitAdapterQualifiedId(qualifiedId);
  const agentId = qualified.agentId;
  let entry;
  try {
    entry = readAgentExt(projectRoot, agentId);
  } catch (err) {
    throw new BatchDispatchError(
      err.code || "ERR_AGENT_READ",
      err.message,
      { agent_id: agentId },
    );
  }
  if (!entry) {
    throw new BatchDispatchError(
      "ERR_AGENT_NOT_FOUND",
      `agent "${agentId}" not in .agent/agents/`,
      { agent_id: agentId },
    );
  }
  if (!entry.external || !entry.external.adapter_type) {
    throw new BatchDispatchError(
      "ERR_NO_ADAPTER",
      `agent "${agentId}" has no external.adapter_type; dispatch-batch only works on external agents`,
      { agent_id: agentId },
    );
  }
  const adapterType = entry.external.adapter_type;
  if (qualified.adapterPrefix && qualified.adapterPrefix !== adapterType) {
    throw new BatchDispatchError(
      "ERR_ADAPTER_PREFIX_MISMATCH",
      `agent "${agentId}" uses adapter_type "${adapterType}", not "${qualified.adapterPrefix}"`,
      { agent_id: agentId, adapter_type: adapterType },
    );
  }
  const adapter = adapters.get(adapterType);
  if (!adapter) {
    throw new BatchDispatchError(
      "ERR_ADAPTER_NOT_REGISTERED",
      `no adapter registered for adapter_type "${adapterType}". Known: ${adapters.list().join(", ") || "(none)"}`,
      { agent_id: agentId, adapter_type: adapterType },
    );
  }
  return { agentId, entry, adapterType, adapter };
}

// ─── execution ───────────────────────────────────────────────────────────────

function newBatchId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  return `B-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeStatus(rawStatus) {
  if (rawStatus === "ok") return "ok";
  if (rawStatus === "blocked") return "blocked";
  if (rawStatus === "timeout") return "timeout";
  return "failed";
}

// Normalize the adapter result envelope. Adapters differ: the DSH adapter
// returns `run_id` / `result.session_id`, the base adapters return `runId`.
function summarizeItem(item, runId, adapterResult) {
  const result = adapterResult || {};
  const inner = result.result && typeof result.result === "object" ? result.result : {};
  const status = normalizeStatus(result.status);
  const summary = {
    label: item.label,
    agent_id: item.agent_id,
    run_id: result.run_id || result.runId || runId,
    adapter_type: result.adapter_type || null,
    status,
    // `session_id` is what the adapter *observed*. `requested_session_id` is
    // what the task file asked for. They are reported separately so a
    // requested id can never masquerade as a verified resume.
    session_id: inner.session_id || result.session_id || null,
    requested_session_id: item.session_id || null,
    latency_ms: typeof result.latency_ms === "number" ? result.latency_ms : 0,
    text_bytes: typeof inner.text === "string" ? Buffer.byteLength(inner.text, "utf8") : 0,
    text_excerpt: typeof inner.text === "string" ? inner.text.slice(0, TEXT_EXCERPT) : "",
    error: result.error || null,
  };
  return summary;
}

// Run one task through its adapter. Resolution failures are recorded as a
// failed item (they are per-task facts, not batch aborts).
async function runItem(projectRoot, item, index, batchId, defaultTimeout) {
  const runId = `R-${batchId}-${String(index + 1).padStart(2, "0")}`;
  const started = Date.now();
  let target;
  try {
    target = resolveTarget(projectRoot, item.agent_id);
  } catch (err) {
    return {
      label: item.label,
      agent_id: item.agent_id,
      run_id: runId,
      adapter_type: null,
      status: "failed",
      session_id: null,
      requested_session_id: item.session_id || null,
      latency_ms: Date.now() - started,
      text_bytes: 0,
      text_excerpt: "",
      error: { code: err.code || "ERR_BATCH_RESOLVE", message: err.message },
    };
  }
  let adapterResult;
  try {
    adapterResult = await target.adapter.invoke(
      { task: item.task, input: item.input },
      {
        runId,
        projectRoot,
        agentId: target.agentId,
        configRef: target.entry.external.config_ref || null,
        credentialRef: target.entry.external.credential_ref || null,
        timeout: item.timeout || defaultTimeout,
        sessionId: item.session_id,
        verifyTransport: true,
      },
    );
  } catch (err) {
    adapterResult = {
      status: "failed",
      error: { code: err.code || "ERR_DISPATCH_INVOKE", message: err.message },
      latency_ms: Date.now() - started,
    };
  }
  const summary = summarizeItem(item, runId, adapterResult);
  summary.adapter_type = summary.adapter_type || target.adapterType;
  return summary;
}

// Bounded parallel fan-out. `concurrency` workers pull from a shared queue.
async function runWithConcurrency(tasks, limit, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await worker(tasks[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Run a batch of agent tasks.
 *
 * @param {object} options
 * @param {string} options.projectRoot    Project root (holds .agent/agents/).
 * @param {Array}  [options.tasks]        Parsed task items (see parseTasksPayload).
 * @param {string} [options.tasksFile]    Path to a JSON task file.
 * @param {number} [options.concurrency]  Parallel workers (default 1, max 16).
 * @param {number} [options.timeout]      Default per-task timeout in seconds.
 * @param {string} [options.batchId]      Explicit batch id (else generated).
 * @returns {Promise<object>} aggregate summary
 */
async function dispatchBatch(options = {}) {
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();
  const tasks = options.tasks || (options.tasksFile ? loadTasksFile(options.tasksFile) : null);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new BatchDispatchError(
      "ERR_BATCH_NO_TASKS",
      "dispatchBatch requires a non-empty task list (options.tasks or options.tasksFile)",
    );
  }
  const concurrency = Math.max(1, Math.min(
    MAX_CONCURRENCY,
    Number(options.concurrency) || DEFAULT_CONCURRENCY,
  ));
  const defaultTimeout = Number(options.timeout) > 0 ? Number(options.timeout) : DEFAULT_BATCH_TIMEOUT;
  const batchId = options.batchId || newBatchId();
  const startedAt = new Date().toISOString();
  const start = Date.now();

  const items = await runWithConcurrency(tasks, concurrency, (item, index) => (
    runItem(projectRoot, item, index, batchId, defaultTimeout)
  ));

  const counts = { total: items.length, ok: 0, blocked: 0, timeout: 0, failed: 0 };
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
    else counts.failed += 1;
  }
  const status = counts.failed === 0 && counts.timeout === 0
    ? (counts.blocked === 0 ? "ok" : "partial")
    : "failed";

  const summary = {
    schema: "dispatch-batch/v1",
    batch_id: batchId,
    status,
    counts,
    concurrency,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    latency_ms: Date.now() - start,
    items,
  };

  // Aggregate artifact, written next to the per-item dispatch journals.
  try {
    const { writeDispatchArtifact } = require("./adapters/base");
    writeDispatchArtifact(projectRoot, batchId, "batch.json", summary);
  } catch (_) {
    // The summary is still returned to the caller; a journal write failure
    // must not turn a completed run into a failed one.
  }
  return summary;
}

module.exports = {
  BatchDispatchError,
  dispatchBatch,
  parseTasksPayload,
  loadTasksFile,
  resolveTarget,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_BATCH_TIMEOUT,
};
