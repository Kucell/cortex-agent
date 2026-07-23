"use strict";

const path = require("path");

const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  CONFLICT: 1,
  INVALID_INPUT: 2,
  UNAVAILABLE: 3,
});

const DEFAULT_CONFIG = Object.freeze({
  schema_version: 1,
  enabled: false,
  mode: "active-workload",
  dashboard_root: null,
  requested_port: 8787,
  refresh_interval_ms: 3000,
  poll_interval_ms: 5000,
  idle_shutdown_ms: 900000,
  start_on: Object.freeze(["session_running", "run_running", "task_active"]),
  exclude_roles: Object.freeze(["dashboard-manager", "runtime-continuity"]),
  localhost_only: true,
});

const START_REASONS = Object.freeze([
  "session_running",
  "run_running",
  "task_active",
  "queue_running",
  "worktree_in_progress",
]);

const SUPERVISOR_STATES = Object.freeze([
  "disabled",
  "enabled_idle",
  "starting",
  "running",
  "idle_grace",
  "stopping",
  "degraded",
  "recovering",
  "stopped",
]);

const SUPERVISOR_EVENTS = Object.freeze([
  "policy_enabled",
  "policy_disabled",
  "active_workload_detected",
  "workload_became_idle",
  "idle_deadline_elapsed",
  "dashboard_started",
  "stop_requested",
  "dashboard_stopped",
  "health_mismatch_detected",
  "recovery_started",
  "recovery_succeeded_running",
  "recovery_succeeded_idle",
  "recovery_failed",
]);

const STATE_TRANSITIONS = Object.freeze({
  disabled: Object.freeze(["enabled_idle"]),
  enabled_idle: Object.freeze(["starting", "disabled", "stopped"]),
  starting: Object.freeze(["running", "degraded", "stopping"]),
  running: Object.freeze(["idle_grace", "degraded", "stopping"]),
  idle_grace: Object.freeze(["running", "stopping", "degraded"]),
  stopping: Object.freeze(["enabled_idle", "disabled", "stopped", "degraded"]),
  degraded: Object.freeze(["recovering", "stopping", "disabled"]),
  recovering: Object.freeze(["running", "enabled_idle", "degraded", "stopping"]),
  stopped: Object.freeze(["enabled_idle", "starting", "disabled"]),
});

const STATE_TRANSITION_EVENTS = Object.freeze({
  disabled: Object.freeze({ enabled_idle: "policy_enabled" }),
  enabled_idle: Object.freeze({ starting: "active_workload_detected", disabled: "policy_disabled", stopped: "stop_requested" }),
  starting: Object.freeze({ running: "dashboard_started", degraded: "health_mismatch_detected", stopping: "stop_requested" }),
  running: Object.freeze({ idle_grace: "workload_became_idle", degraded: "health_mismatch_detected", stopping: "stop_requested" }),
  idle_grace: Object.freeze({ running: "active_workload_detected", stopping: "idle_deadline_elapsed", degraded: "health_mismatch_detected" }),
  stopping: Object.freeze({ enabled_idle: "dashboard_stopped", disabled: "policy_disabled", stopped: "dashboard_stopped", degraded: "health_mismatch_detected" }),
  degraded: Object.freeze({ recovering: "recovery_started", stopping: "stop_requested", disabled: "policy_disabled" }),
  recovering: Object.freeze({ running: "recovery_succeeded_running", enabled_idle: "recovery_succeeded_idle", degraded: "recovery_failed", stopping: "stop_requested" }),
  stopped: Object.freeze({ enabled_idle: "policy_enabled", starting: "active_workload_detected", disabled: "policy_disabled" }),
});

const DIAGNOSTIC_CODES = Object.freeze({
  CONFIG_INVALID: "DASH_CONFIG_INVALID",
  MODE_UNSUPPORTED: "DASH_MODE_UNSUPPORTED",
  REMOTE_BIND_FORBIDDEN: "DASH_REMOTE_BIND_FORBIDDEN",
  PROJECT_INVALID: "DASH_PROJECT_INVALID",
  AGENT_ROOT_UNAVAILABLE: "DASH_AGENT_ROOT_UNAVAILABLE",
  OWNER_MISSING: "DASH_OWNER_MISSING",
  OWNER_AGENT_ROOT_MISMATCH: "DASH_OWNER_AGENT_ROOT_MISMATCH",
  WORKLOAD_INPUT_INVALID: "DASH_WORKLOAD_INPUT_INVALID",
  WORKLOAD_SOURCE_UNAVAILABLE: "DASH_WORKLOAD_SOURCE_UNAVAILABLE",
  SESSION_STALE_EXCLUDED: "DASH_SESSION_STALE_EXCLUDED",
  SELF_WORKLOAD_EXCLUDED: "DASH_SELF_WORKLOAD_EXCLUDED",
  NO_ACTIVE_WORKLOAD: "DASH_NO_ACTIVE_WORKLOAD",
  ACTIVE_WORKLOAD: "DASH_ACTIVE_WORKLOAD",
  STATE_INVALID: "DASH_STATE_INVALID",
  STATE_TRANSITION_CONFLICT: "DASH_STATE_TRANSITION_CONFLICT",
});

const DIAGNOSTIC_EXIT_CODES = Object.freeze({
  [DIAGNOSTIC_CODES.CONFIG_INVALID]: EXIT_CODES.INVALID_INPUT,
  [DIAGNOSTIC_CODES.MODE_UNSUPPORTED]: EXIT_CODES.INVALID_INPUT,
  [DIAGNOSTIC_CODES.REMOTE_BIND_FORBIDDEN]: EXIT_CODES.INVALID_INPUT,
  [DIAGNOSTIC_CODES.PROJECT_INVALID]: EXIT_CODES.INVALID_INPUT,
  [DIAGNOSTIC_CODES.AGENT_ROOT_UNAVAILABLE]: EXIT_CODES.UNAVAILABLE,
  [DIAGNOSTIC_CODES.OWNER_MISSING]: EXIT_CODES.CONFLICT,
  [DIAGNOSTIC_CODES.OWNER_AGENT_ROOT_MISMATCH]: EXIT_CODES.CONFLICT,
  [DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID]: EXIT_CODES.SUCCESS,
  [DIAGNOSTIC_CODES.WORKLOAD_SOURCE_UNAVAILABLE]: EXIT_CODES.UNAVAILABLE,
  [DIAGNOSTIC_CODES.SESSION_STALE_EXCLUDED]: EXIT_CODES.SUCCESS,
  [DIAGNOSTIC_CODES.SELF_WORKLOAD_EXCLUDED]: EXIT_CODES.SUCCESS,
  [DIAGNOSTIC_CODES.NO_ACTIVE_WORKLOAD]: EXIT_CODES.SUCCESS,
  [DIAGNOSTIC_CODES.ACTIVE_WORKLOAD]: EXIT_CODES.SUCCESS,
  [DIAGNOSTIC_CODES.STATE_INVALID]: EXIT_CODES.UNAVAILABLE,
  [DIAGNOSTIC_CODES.STATE_TRANSITION_CONFLICT]: EXIT_CODES.CONFLICT,
});

const CONFIG_FIELDS = Object.freeze(Object.keys(DEFAULT_CONFIG));
const STATE_FIELDS = Object.freeze([
  "schema_version",
  "status",
  "agent_root",
  "dashboard_root",
  "supervisor_pid",
  "dashboard_pid",
  "url",
  "started_at",
  "last_heartbeat_at",
  "last_active_at",
  "idle_deadline_at",
  "last_reason",
  "last_error",
]);

function diagnostic(code, severity, message, details = {}) {
  return { code, severity, message, details };
}

function diagnosticExitCode(entry) {
  if (!entry || typeof entry !== "object") return EXIT_CODES.UNAVAILABLE;
  if (entry.code === DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID && entry.severity === "error") {
    return EXIT_CODES.UNAVAILABLE;
  }
  return DIAGNOSTIC_EXIT_CODES[entry.code] ?? EXIT_CODES.UNAVAILABLE;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isUniqueStringArray(value, allowed = null) {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.length > 0 && (!allowed || allowed.includes(item)))
    && new Set(value).size === value.length;
}

function isAbsoluteDirectoryShape(value) {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value);
}

function parseRfc3339(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return null;
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNullableDateTime(value) {
  return value === null || parseRfc3339(value) !== null;
}

function validateConfig(config) {
  const diagnostics = [];
  if (!hasExactFields(config, CONFIG_FIELDS)) {
    diagnostics.push(diagnostic(DIAGNOSTIC_CODES.CONFIG_INVALID, "error", "Dashboard automation policy fields are invalid."));
    return { ok: false, exit_code: EXIT_CODES.INVALID_INPUT, diagnostics };
  }
  if (config.mode !== "active-workload") {
    diagnostics.push(diagnostic(DIAGNOSTIC_CODES.MODE_UNSUPPORTED, "error", "Dashboard automation mode is unsupported.", { mode: config.mode }));
  }
  if (config.localhost_only !== true) {
    diagnostics.push(diagnostic(DIAGNOSTIC_CODES.REMOTE_BIND_FORBIDDEN, "error", "Dashboard automation must bind to localhost only."));
  }
  const valid = config.schema_version === 1
    && typeof config.enabled === "boolean"
    && (config.dashboard_root === null || isAbsoluteDirectoryShape(config.dashboard_root))
    && Number.isInteger(config.requested_port) && config.requested_port >= 1 && config.requested_port <= 65535
    && Number.isInteger(config.refresh_interval_ms) && config.refresh_interval_ms >= 500
    && Number.isInteger(config.poll_interval_ms) && config.poll_interval_ms >= 1000
    && Number.isInteger(config.idle_shutdown_ms) && config.idle_shutdown_ms >= 0
    && isUniqueStringArray(config.start_on, START_REASONS)
    && isUniqueStringArray(config.exclude_roles);
  if (!valid && diagnostics.length === 0) {
    diagnostics.push(diagnostic(DIAGNOSTIC_CODES.CONFIG_INVALID, "error", "Dashboard automation policy values are invalid."));
  }
  return { ok: diagnostics.length === 0, exit_code: diagnostics.length === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.INVALID_INPUT, diagnostics };
}

function validLocalUrl(value) {
  if (value === null) return true;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch (_) {
    return false;
  }
}

function validLastError(value) {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const allowed = ["code", "message", "at", "details"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  return typeof value.code === "string" && value.code.length > 0
    && typeof value.message === "string" && value.message.length > 0
    && isNullableDateTime(value.at) && value.at !== null
    && (value.details === undefined || isObject(value.details));
}

function validateSupervisorState(state) {
  let valid = hasExactFields(state, STATE_FIELDS)
    && state.schema_version === 1
    && SUPERVISOR_STATES.includes(state.status)
    && isAbsoluteDirectoryShape(state.agent_root)
    && isAbsoluteDirectoryShape(state.dashboard_root)
    && (state.supervisor_pid === null || (Number.isInteger(state.supervisor_pid) && state.supervisor_pid > 0))
    && (state.dashboard_pid === null || (Number.isInteger(state.dashboard_pid) && state.dashboard_pid > 0))
    && validLocalUrl(state.url)
    && ["started_at", "last_heartbeat_at", "last_active_at", "idle_deadline_at"].every((field) => isNullableDateTime(state[field]))
    && (state.last_reason === null || (typeof state.last_reason === "string" && state.last_reason.length > 0))
    && validLastError(state.last_error);
  if (valid && state.status === "running") {
    valid = state.supervisor_pid !== null && state.dashboard_pid !== null && state.url !== null;
  }
  if (valid && state.status === "idle_grace") {
    valid = state.idle_deadline_at !== null
      && (state.last_active_at === null || Date.parse(state.last_active_at) <= Date.parse(state.idle_deadline_at));
  }
  if (valid && ["disabled", "stopped"].includes(state.status)) {
    valid = state.supervisor_pid === null && state.dashboard_pid === null && state.url === null;
  }
  const diagnostics = valid
    ? []
    : [diagnostic(DIAGNOSTIC_CODES.STATE_INVALID, "error", "Dashboard supervisor runtime state is invalid.")];
  return { ok: valid, exit_code: valid ? EXIT_CODES.SUCCESS : EXIT_CODES.UNAVAILABLE, diagnostics };
}

function validateTransition(from, to, event) {
  const valid = SUPERVISOR_STATES.includes(from)
    && SUPERVISOR_STATES.includes(to)
    && SUPERVISOR_EVENTS.includes(event)
    && STATE_TRANSITIONS[from].includes(to)
    && STATE_TRANSITION_EVENTS[from][to] === event;
  const diagnostics = valid
    ? []
    : [diagnostic(DIAGNOSTIC_CODES.STATE_TRANSITION_CONFLICT, "error", "Dashboard supervisor state transition is not allowed.", { from, to, event })];
  return { ok: valid, exit_code: valid ? EXIT_CODES.SUCCESS : EXIT_CODES.CONFLICT, diagnostics };
}

module.exports = {
  DEFAULT_CONFIG,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_EXIT_CODES,
  EXIT_CODES,
  START_REASONS,
  STATE_TRANSITION_EVENTS,
  STATE_TRANSITIONS,
  SUPERVISOR_EVENTS,
  SUPERVISOR_STATES,
  diagnostic,
  diagnosticExitCode,
  parseRfc3339,
  validateConfig,
  validateSupervisorState,
  validateTransition,
};
