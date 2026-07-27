"use strict";

const {
  DEFAULT_CONFIG,
  DIAGNOSTIC_CODES,
  diagnostic,
  parseRfc3339,
} = require("./contracts.js");

const DEFAULT_SESSION_STALE_AFTER_MS = 300000;
const HARD_EXCLUDED_IDENTITIES = Object.freeze([
  "dashboard-manager",
  "dashboard-supervisor",
  "runtime-continuity",
]);

function recordId(record, fallback) {
  return String(record.task_id || record.run_id || record.session_id || record.queue_id || record.worktree_id || record.workspace_id || record.id || fallback);
}

function item(source, id, code, status) {
  const result = { source, id, code };
  if (status !== undefined) result.status = status;
  return result;
}

function invalidRecord(source, id) {
  return diagnostic(DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID, "warning", `Invalid ${source} workload record.`, { source, id });
}

function excludedIdentity(record, options) {
  const identities = [record.role, record.agent_id, record.kind, record.owner_role]
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase());
  const excluded = new Set([
    ...HARD_EXCLUDED_IDENTITIES,
    ...(Array.isArray(options.excludeRoles) ? options.excludeRoles : []).map((value) => String(value).toLowerCase()),
    ...(Array.isArray(options.excludeAgentIds) ? options.excludeAgentIds : []).map((value) => String(value).toLowerCase()),
  ]);
  return identities.some((identity) => excluded.has(identity) || identity.startsWith("dashboard-supervisor"));
}

function isReadOnlyWorkload(record) {
  return record.read_only === true
    || record.workload_type === "read_only_query"
    || record.operation === "query"
    || ["management-query", "mcp-query", "dashboard-query"].includes(record.kind);
}

function inactiveResult() {
  return { active: false, reason: null, excluded: null, diagnostics: [] };
}

function classifyTask(record, options = {}) {
  const id = recordId(record || {}, "unknown");
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ...inactiveResult(), diagnostics: [invalidRecord("task", id)] };
  }
  const active = record.status === "active" && record.stage !== "done";
  return active
    ? { active: true, reason: item("task", id, "task_active", record.status), excluded: null, diagnostics: [] }
    : inactiveResult();
}

function classifyRun(record, options = {}) {
  const id = recordId(record || {}, "unknown");
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ...inactiveResult(), diagnostics: [invalidRecord("run", id)] };
  }
  if (excludedIdentity(record, options) || isReadOnlyWorkload(record)) {
    return {
      active: false,
      reason: null,
      excluded: item("run", id, isReadOnlyWorkload(record) ? "read_only_run_excluded" : "self_run_excluded", record.status),
      diagnostics: [diagnostic(DIAGNOSTIC_CODES.SELF_WORKLOAD_EXCLUDED, "info", "Self-owned or read-only run was excluded.", { source: "run", id })],
    };
  }
  return record.status === "running"
    ? { active: true, reason: item("run", id, "run_running", record.status), excluded: null, diagnostics: [] }
    : inactiveResult();
}

function parseNow(now) {
  if (typeof now === "number") return Number.isFinite(now) ? now : null;
  return parseRfc3339(now);
}

function classifySession(record, options = {}) {
  const id = recordId(record || {}, "unknown");
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ...inactiveResult(), diagnostics: [invalidRecord("session", id)] };
  }
  if (excludedIdentity(record, options) || isReadOnlyWorkload(record)) {
    return {
      active: false,
      reason: null,
      excluded: item("session", id, isReadOnlyWorkload(record) ? "read_only_session_excluded" : "self_session_excluded", record.status),
      diagnostics: [diagnostic(DIAGNOSTIC_CODES.SELF_WORKLOAD_EXCLUDED, "info", "Self-owned or read-only session was excluded.", { source: "session", id })],
    };
  }
  if (record.status === "stale") {
    return {
      active: false,
      reason: null,
      excluded: item("session", id, "session_stale_excluded", record.status),
      diagnostics: [diagnostic(DIAGNOSTIC_CODES.SESSION_STALE_EXCLUDED, "warning", "Stale session was excluded.", { source: "session", id })],
    };
  }
  if (!["running", "paused"].includes(record.status)) return inactiveResult();
  const now = parseNow(options.now);
  const heartbeat = Date.parse(record.last_heartbeat_at || "");
  if (now === null || !Number.isFinite(heartbeat)) {
    return { ...inactiveResult(), diagnostics: [invalidRecord("session", id)] };
  }
  const staleAfter = Number.isFinite(options.sessionStaleAfterMs)
    ? options.sessionStaleAfterMs
    : DEFAULT_SESSION_STALE_AFTER_MS;
  if (now - heartbeat > staleAfter) {
    return {
      active: false,
      reason: null,
      excluded: item("session", id, "session_stale_excluded", record.status),
      diagnostics: [diagnostic(DIAGNOSTIC_CODES.SESSION_STALE_EXCLUDED, "warning", "Stale session was excluded.", { source: "session", id })],
    };
  }
  if (record.status === "paused") return inactiveResult();
  return { active: true, reason: item("session", id, "session_running", record.status), excluded: null, diagnostics: [] };
}

function classifyQueue(record) {
  const id = recordId(record || {}, "unknown");
  if (!record || typeof record !== "object" || Array.isArray(record) || !Array.isArray(record.items)) {
    return { ...inactiveResult(), diagnostics: [invalidRecord("queue", id)] };
  }
  return record.items.some((queueItem) => queueItem && queueItem.state === "running")
    ? { active: true, reason: item("queue", id, "queue_running", "running"), excluded: null, diagnostics: [] }
    : inactiveResult();
}

function classifyWorktree(record) {
  const id = recordId(record || {}, "unknown");
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ...inactiveResult(), diagnostics: [invalidRecord("worktree", id)] };
  }
  const runtimeState = record.runtime_state || record.state;
  if (runtimeState === "handoff_required") {
    return { active: true, reason: item("worktree", id, "worktree_handoff_required", runtimeState), excluded: null, diagnostics: [] };
  }
  if (record.status === "running" || runtimeState === "in_progress") {
    return { active: true, reason: item("worktree", id, "worktree_in_progress", runtimeState || record.status), excluded: null, diagnostics: [] };
  }
  return inactiveResult();
}

function stableSort(values) {
  return values.sort((left, right) => {
    const leftKey = `${left.source || left.details?.source || ""}\u0000${left.id || left.details?.id || ""}\u0000${left.code || ""}`;
    const rightKey = `${right.source || right.details?.source || ""}\u0000${right.id || right.details?.id || ""}\u0000${right.code || ""}`;
    return leftKey.localeCompare(rightKey);
  });
}

function classifyWorkloads(projections = {}, options = {}) {
  const now = parseNow(options.now);
  if (now === null) {
    return {
      active: false,
      trigger_active: false,
      state: "indeterminate",
      reasons: [],
      trigger_reasons: [],
      excluded: [],
      diagnostics: [diagnostic(DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID, "error", "A valid explicit now value is required.", { field: "now" })],
    };
  }
  if (!projections || typeof projections !== "object" || Array.isArray(projections)) {
    return {
      active: false,
      trigger_active: false,
      state: "indeterminate",
      reasons: [],
      trigger_reasons: [],
      excluded: [],
      diagnostics: [diagnostic(DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID, "error", "Workload projections must be an object.", { source: "projections" })],
    };
  }
  const startOn = new Set(Array.isArray(options.startOn) ? options.startOn : DEFAULT_CONFIG.start_on);
  const sourceDefinitions = [
    ["tasks", "task", classifyTask],
    ["runs", "run", classifyRun],
    ["sessions", "session", classifySession],
    ["queues", "queue", classifyQueue],
    ["worktrees", "worktree", classifyWorktree],
  ];
  const reasons = [];
  const triggerReasons = [];
  const excluded = [];
  const diagnostics = [];
  let sourceInvalid = false;
  for (const [field, source, classifier] of sourceDefinitions) {
    const records = projections[field] === undefined ? [] : projections[field];
    if (!Array.isArray(records)) {
      sourceInvalid = true;
      diagnostics.push(diagnostic(DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID, "error", `Workload projection ${field} must be an array.`, { source }));
      continue;
    }
    for (const record of records) {
      const result = classifier(record, {
        ...options,
        now,
        sessionStaleAfterMs: options.sessionStaleAfterMs ?? DEFAULT_SESSION_STALE_AFTER_MS,
      });
      if (result.reason) {
        reasons.push(result.reason);
        const gateCode = result.reason.code === "worktree_handoff_required" ? "worktree_in_progress" : result.reason.code;
        if (startOn.has(gateCode)) triggerReasons.push(result.reason);
      }
      if (result.excluded) excluded.push(result.excluded);
      diagnostics.push(...result.diagnostics);
    }
  }
  stableSort(reasons);
  stableSort(triggerReasons);
  stableSort(excluded);
  const active = reasons.length > 0;
  diagnostics.push(diagnostic(
    active ? DIAGNOSTIC_CODES.ACTIVE_WORKLOAD : DIAGNOSTIC_CODES.NO_ACTIVE_WORKLOAD,
    "info",
    active ? "Active workload was detected." : "No active workload was detected.",
    { reason_count: reasons.length },
  ));
  stableSort(diagnostics);
  return {
    active,
    trigger_active: triggerReasons.length > 0,
    state: active ? "active" : sourceInvalid ? "indeterminate" : "idle",
    reasons,
    trigger_reasons: triggerReasons,
    excluded,
    diagnostics,
  };
}

module.exports = {
  DEFAULT_SESSION_STALE_AFTER_MS,
  classifyQueue,
  classifyRun,
  classifySession,
  classifyTask,
  classifyWorkloads,
  classifyWorktree,
};
