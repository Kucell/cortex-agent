"use strict";

/**
 * lib/event-bus/subagent-trace-bridge.js
 *
 * M-004 MS-002 / F-004 — subagent-trace 升级: 成功 / 失败 / 取消自动 emit
 * event-bus + 双写 subagent_fanout[] (BC 兼容).
 *
 * 设计:
 *   - 4 个公开方法: spawn / progress / complete / cancel
 *   - 每次调用先 publish event-bus (8 类 core event 之一)
 *   - 然后用 subprocess 调原 subagent-trace/scripts/index.js emit ... 把
 *     同一事件双写进 runs/<id>.json#subagent_fanout[] + #events[] (BC 旧路径)
 *   - 失败时: complete(..., status='failed') + notify-on-fail default true
 *     → 自动 inbox 父 run (跟旧行为一致, 但默认开)
 *   - 进度节流: progress 事件只在 percent - lastEmittedPercent >= 10 才发,
 *     lastEmittedPercent 维护在 in-memory Map (subagent_id → percent)
 *
 * BC 兼容:
 *   - 旧 node .agent/skills/subagent-trace/scripts/index.js emit ... 路径
 *     完全不动, 仍然 work. 旧 emit 走旧路径, event-bus 不收.
 *   - 新 bridge.* 调 event-bus + 旧 subagent-trace 双写. 旧路径不会因为
 *     本模块而被覆盖.
 *
 * 零依赖 — 只用 node:fs / node:path / node:child_process / node:crypto / node:os.
 *
 * References:
 *   - docs/architecture/framework-event-bus-design.md §3.2, §6
 *   - .agent/missions/M-004/handoffs/20260805-215200-ms-002-spec-done.md
 *   - templates/_shared/.agent/agent-protocols/subagent-fanout.md
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const os = require("node:os");

const { createEventBus } = require("./event-bus");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_SCRIPT = path.join(
  __dirname,
  "..",
  "..",
  "templates",
  "_shared",
  ".agent",
  "skills",
  "subagent-trace",
  "scripts",
  "index.js",
);

const PROGRESS_THROTTLE_PERCENT = 10;
const DEFAULT_BUS_ID = `${os.hostname().toLowerCase().slice(0, 12) || "unknown-host"}:global`;

// In-memory throttle state: subagent_id → last emitted percent
const _lastPercent = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _emitLegacy(args) {
  // Run the existing subagent-trace skill as a subprocess.
  // This is the BC path: it writes to runs/<id>.json#subagent_fanout[] and
  // #events[] exactly as before. We don't introspect the stdout (it is
  // structured JSON for `emit`); we only care about exit code.
  const argv = [SKILL_SCRIPT, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) {
    const err = new Error(`subagent-trace subprocess failed: ${result.error.message}`);
    err.cause = result.error;
    err.stderr = result.stderr;
    throw err;
  }
  if (result.status !== 0) {
    // The skill emits a JSON error envelope to stdout. We surface the
    // message but don't fail the bridge — the event-bus side already
    // succeeded. The caller (and tests) decide what to do.
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch (_) { /* not JSON */ }
    const err = new Error(
      `subagent-trace subprocess exited ${result.status}: ${
        parsed ? parsed.error || parsed.message || JSON.stringify(parsed) : (result.stderr || "").trim()
      }`,
    );
    err.exitStatus = result.status;
    err.parsed = parsed;
    err.stderr = result.stderr;
    return { ok: false, error: err };
  }
  return { ok: true };
}

function _buildLegacyArgs(eventName, opts) {
  // Build the --flag arg list to forward to the subagent-trace skill.
  const args = ["emit", "--event", eventName, "--gate", "agent"];
  if (opts.parent_run_id) args.push("--parent-run-id", opts.parent_run_id);
  if (opts.subagent_id) args.push("--subagent-id", opts.subagent_id);

  if (eventName === "subagent_spawned") {
    if (opts.role) args.push("--subagent-role", opts.role);
    if (opts.task_description) args.push("--task-description", opts.task_description);
    if (opts.tools_granted) args.push("--tools-granted", opts.tools_granted);
    if (opts.model) args.push("--model", opts.model);
    if (opts.expected_duration_minutes != null) {
      args.push("--expected-duration-minutes", String(opts.expected_duration_minutes));
    }
  } else if (eventName === "subagent_progress") {
    if (opts.percent != null) args.push("--percent", String(opts.percent));
    if (opts.current_step) args.push("--current-step", opts.current_step);
    if (opts.tool_calls_count != null) {
      args.push("--tool-calls-count", String(opts.tool_calls_count));
    }
  } else if (eventName === "subagent_completed") {
    if (opts.status) args.push("--status", opts.status);
    if (opts.output_summary) args.push("--output-summary", opts.output_summary);
    if (opts.output_artifact_refs) {
      args.push("--output-artifact-refs", opts.output_artifact_refs.join(","));
    }
    if (opts.duration_actual_seconds != null) {
      args.push("--duration-actual-seconds", String(opts.duration_actual_seconds));
    }
    if (opts.transcript_ref) args.push("--transcript-ref", opts.transcript_ref);
    // Default --notify-on-fail=true for failed status
    if (opts.status === "failed" && opts.notify_on_fail !== false) {
      args.push("--notify-on-fail");
    }
  } else if (eventName === "subagent_cancelled") {
    if (opts.reason) args.push("--reason", opts.reason);
  }
  return args;
}

function _makeBus(opts) {
  return createEventBus({
    busId: opts.busId || DEFAULT_BUS_ID,
    dataDir: opts.dataDir,
    fsync: opts.fsync !== false,
  });
}

function _producerCtx(opts) {
  return {
    producer: {
      producer_id: opts.subagent_id || "bridge",
      producer_kind: "sub_agent",
      session_id: opts.session_id || null,
    },
    missionId: opts.mission_id || "global",
    subagentId: opts.subagent_id || "host",
    parentRunId: opts.parent_run_id || "global",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * bridge.spawn — record a sub-agent as spawned.
 *
 * @param {object} opts - { parent_run_id, subagent_id, role, task_description,
 *                          tools_granted?, model?, expected_duration_minutes?,
 *                          mission_id?, session_id?, busId?, dataDir? }
 * @returns {{ ok: boolean, event_id: string, bus_result: object, legacy: object }}
 */
function spawn(opts) {
  if (!opts || !opts.subagent_id) {
    throw new Error("bridge.spawn: opts.subagent_id is required");
  }
  if (!opts.role) {
    throw new Error("bridge.spawn: opts.role is required");
  }
  if (!opts.task_description) {
    throw new Error("bridge.spawn: opts.task_description is required");
  }
  if (!opts.parent_run_id) {
    throw new Error("bridge.spawn: opts.parent_run_id is required (or pass null + dataDir)");
  }

  const bus = _makeBus(opts);
  const payload = {
    subagent_role: opts.role,
    task_description: opts.task_description,
  };
  if (opts.tools_granted) payload.tools_granted = opts.tools_granted;
  if (opts.model) payload.model = opts.model;
  if (opts.expected_duration_minutes != null) {
    payload.expected_duration_minutes = opts.expected_duration_minutes;
  }

  const busResult = bus.publish(
    { event_name: "subagent_spawned", payload },
    _producerCtx(opts),
  );

  // Reset throttle for this sub-agent
  _lastPercent.set(opts.subagent_id, 0);

  // BC: also write to runs/<id>.json via the existing skill
  const legacy = _emitLegacy(_buildLegacyArgs("subagent_spawned", opts));

  bus.close();

  return {
    ok: true,
    event_id: busResult.event_id,
    bus_result: busResult,
    legacy,
  };
}

/**
 * bridge.progress — record a sub-agent progress heartbeat.
 * Throttled: emits only if percent advanced >= 10% since last emit.
 *
 * @param {object} opts - { parent_run_id, subagent_id, percent, current_step?,
 *                          tool_calls_count?, mission_id?, session_id?, busId?,
 *                          dataDir?, force?: boolean }
 * @returns {object} { emitted, event_id?, bus_result?, legacy?, reason? }
 */
function progress(opts) {
  if (!opts || !opts.subagent_id) {
    throw new Error("bridge.progress: opts.subagent_id is required");
  }
  if (opts.percent == null) {
    throw new Error("bridge.progress: opts.percent is required");
  }
  const percent = Number(opts.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("bridge.progress: opts.percent must be a number 0-100");
  }

  const last = _lastPercent.get(opts.subagent_id);
  if (!opts.force && last != null && Math.abs(percent - last) < PROGRESS_THROTTLE_PERCENT) {
    return {
      emitted: false,
      reason: `throttled (last=${last}%, current=${percent}%, threshold=${PROGRESS_THROTTLE_PERCENT}%)`,
    };
  }

  const bus = _makeBus(opts);
  const payload = { percent };
  if (opts.current_step) payload.current_step = opts.current_step;
  if (opts.tool_calls_count != null) payload.tool_calls_count = opts.tool_calls_count;

  const busResult = bus.publish(
    { event_name: "subagent_progress", payload },
    _producerCtx(opts),
  );

  _lastPercent.set(opts.subagent_id, percent);

  const legacy = _emitLegacy(_buildLegacyArgs("subagent_progress", opts));

  bus.close();

  return {
    emitted: true,
    event_id: busResult.event_id,
    bus_result: busResult,
    legacy,
  };
}

/**
 * bridge.complete — record a sub-agent as completed (success / partial / failed).
 *
 * Mapping:
 *   status=success | partial → eb:subagent_completed
 *   status=failed            → eb:subagent_failed
 *
 * @param {object} opts - { parent_run_id, subagent_id, status, output_summary,
 *                          output_artifact_refs?, duration_actual_seconds?,
 *                          error_code?, error_message?, transcript_ref?,
 *                          mission_id?, session_id?, busId?, dataDir?,
 *                          notify_on_fail?: boolean (default true for failed) }
 * @returns {{ ok, event_name, event_id, bus_result, legacy }}
 */
function complete(opts) {
  if (!opts || !opts.subagent_id) {
    throw new Error("bridge.complete: opts.subagent_id is required");
  }
  if (!opts.status) {
    throw new Error("bridge.complete: opts.status is required (success|partial|failed)");
  }
  if (!["success", "partial", "failed"].includes(opts.status)) {
    throw new Error(`bridge.complete: opts.status must be success|partial|failed, got ${opts.status}`);
  }
  if (!opts.parent_run_id) {
    throw new Error("bridge.complete: opts.parent_run_id is required (or pass null + dataDir)");
  }

  const bus = _makeBus(opts);
  let eventName, payload;

  if (opts.status === "failed") {
    eventName = "subagent_failed";
    payload = {
      status: "failed",
      error_code: opts.error_code || "ERR_UNKNOWN",
      error_message: opts.error_message || opts.output_summary || "no error message provided",
    };
    if (opts.retry_count != null) payload.retry_count = opts.retry_count;
    if (opts.last_tool_failure) payload.last_tool_failure = opts.last_tool_failure;
    if (opts.output_partial_summary) {
      payload.output_partial_summary = opts.output_partial_summary;
    } else if (opts.output_summary) {
      payload.output_partial_summary = opts.output_summary;
    }
  } else {
    eventName = "subagent_completed";
    payload = {
      status: opts.status, // success | partial
      output_summary: opts.output_summary || "completed",
    };
    if (opts.output_artifact_refs) payload.output_artifact_refs = opts.output_artifact_refs;
    if (opts.duration_actual_seconds != null) {
      payload.duration_actual_seconds = opts.duration_actual_seconds;
    }
    if (opts.transcript_ref) payload.transcript_ref = opts.transcript_ref;
  }

  const busResult = bus.publish(
    { event_name: eventName, payload },
    _producerCtx(opts),
  );

  // Clear throttle for this sub-agent
  _lastPercent.delete(opts.subagent_id);

  // BC: also write to runs/<id>.json via the existing skill
  const legacy = _emitLegacy(_buildLegacyArgs("subagent_completed", opts));

  bus.close();

  return {
    ok: true,
    event_name: eventName,
    event_id: busResult.event_id,
    bus_result: busResult,
    legacy,
  };
}

/**
 * bridge.cancel — record a sub-agent as cancelled.
 *
 * @param {object} opts - { parent_run_id, subagent_id, reason, cancelled_by?,
 *                          mission_id?, session_id?, busId?, dataDir? }
 * @returns {{ ok, event_id, bus_result, legacy }}
 */
function cancel(opts) {
  if (!opts || !opts.subagent_id) {
    throw new Error("bridge.cancel: opts.subagent_id is required");
  }
  if (!opts.reason) {
    throw new Error("bridge.cancel: opts.reason is required");
  }
  if (!opts.parent_run_id) {
    throw new Error("bridge.cancel: opts.parent_run_id is required (or pass null + dataDir)");
  }

  const bus = _makeBus(opts);
  const payload = { reason: opts.reason };
  if (opts.cancelled_by) payload.cancelled_by = opts.cancelled_by;

  const busResult = bus.publish(
    { event_name: "subagent_cancelled", payload },
    _producerCtx(opts),
  );

  _lastPercent.delete(opts.subagent_id);

  const legacy = _emitLegacy(_buildLegacyArgs("subagent_cancelled", opts));

  bus.close();

  return {
    ok: true,
    event_id: busResult.event_id,
    bus_result: busResult,
    legacy,
  };
}

// ---------------------------------------------------------------------------
// Testing helpers (exported for tests, not part of the public API)
// ---------------------------------------------------------------------------

function _resetThrottleForTests() {
  _lastPercent.clear();
}

function _getThrottleForTests() {
  return new Map(_lastPercent);
}

module.exports = {
  spawn,
  progress,
  complete,
  cancel,
  // constants (for tests)
  PROGRESS_THROTTLE_PERCENT,
  DEFAULT_BUS_ID,
  SKILL_SCRIPT,
  // testing helpers
  _resetThrottleForTests,
  _getThrottleForTests,
};
