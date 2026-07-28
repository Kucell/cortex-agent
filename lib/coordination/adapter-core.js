"use strict";

const path = require("node:path");

// ─── Existing vendor-specific adapter core ────────────────────────────────────
// Below block is the legacy adapter-core (descriptor model, safe-id/text
// validators). It remains exported unchanged so claude-adapter, codex-adapter,
// application-service and coordination-adapters.test keep working.
//
// ─── Host Wakeup Adapter (vendor-neutral) additions ──────────────────────────
// Vendor-neutral Host Wakeup contract layered ON TOP of the legacy descriptors.
// New API: createHostAdapter, handshake, buildStructuredContext, threadWakeup,
// registerRecoveryConsumer, healthSnapshot, ackResult, deferredNoHost,
// checkDenyRules. All state machine + allowlist + deny-rule logic lives here.

const REPORTING_MODES = Object.freeze({
  HOOK: "hook",
  EXPLICIT_CLI: "explicit_cli",
});

const DELIVERY_RESULTS = Object.freeze({
  DELIVERED: "delivered",
  DEFERRED: "deferred",
  SKIPPED: "skipped",
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_PATTERN = /(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]/i;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'`])\/(?:Users|home|var|tmp|private|opt|etc)\//;
const WINDOWS_ABSOLUTE_PATH = /(^|[\s"'`])[A-Za-z]:[\\/]/;
const IPV4_ADDRESS = /(^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}([^0-9]|$)/;

function assertSafeId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a stable identifier`);
  }
  return value;
}

function assertSafeText(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  if (SECRET_PATTERN.test(value) || POSIX_ABSOLUTE_PATH.test(value)
      || WINDOWS_ABSOLUTE_PATH.test(value) || IPV4_ADDRESS.test(value)) {
    throw new TypeError(`${field} contains private runtime data`);
  }
  return value;
}

function assertRepoRelative(value, field) {
  assertSafeText(value, field);
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".."
      || normalized.startsWith("../")) {
    throw new TypeError(`${field} must be repository-relative`);
  }
  return normalized;
}

function normalizeStringList(values, field, validator = assertSafeText) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${field} must be an array`);
  }
  return Object.freeze(values.map((value, index) =>
    validator(value, `${field}[${index}]`)));
}

function createAdapterDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("adapter descriptor must be an object");
  }
  const capabilities = {};
  for (const [name, enabled] of Object.entries(input.capabilities || {})) {
    assertSafeId(name, "capability");
    if (typeof enabled !== "boolean") {
      throw new TypeError(`capability ${name} must be boolean`);
    }
    capabilities[name] = enabled;
  }
  return Object.freeze({
    adapterId: assertSafeId(input.adapterId, "adapterId"),
    vendor: assertSafeId(input.vendor, "vendor"),
    capabilities: Object.freeze(capabilities),
  });
}

function hasCapability(descriptor, capability) {
  return descriptor.capabilities[capability] === true;
}

function sanitizeEvidenceRefs(evidenceRefs = []) {
  if (!Array.isArray(evidenceRefs)) {
    throw new TypeError("evidenceRefs must be an array");
  }
  return Object.freeze(evidenceRefs.map((ref, index) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new TypeError(`evidenceRefs[${index}] must be an object`);
    }
    return Object.freeze({
      kind: assertSafeId(ref.kind, `evidenceRefs[${index}].kind`),
      ref: assertSafeText(ref.ref, `evidenceRefs[${index}].ref`),
    });
  }));
}

// ─── Host Wakeup Adapter implementation ──────────────────────────────────────
// Pure logic. No fs / child_process / network. Every input that crosses the
// host <-> cortex boundary goes through checkDenyRules first.

const PHASES = Object.freeze([
  "pending",
  "deferred",
  "running",
  "ack_pending",
  "completed",
  "failed",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(["running", "deferred", "failed", "ack_pending"]),
  deferred: new Set(["pending", "failed"]),
  running: new Set(["ack_pending", "failed"]),
  ack_pending: new Set(["completed", "failed"]),
  completed: new Set(),
  failed: new Set(),
});

const REGISTERED_ADAPTER_IDS = Object.freeze([
  "codex.local",
  "codex.dev",
  "claude-code.local",
  "claude-code.dev",
  "cursor.local",
  "cursor.dev",
  "windsurf.local",
  "windsurf.dev",
  "cline.local",
  "amazon-q.local",
  "generic.prod",
]);

const STRUCTURED_CONTEXT_FIELDS = Object.freeze([
  "threadId",
  "summary",
  "references",
  "constraints",
  "priority",
]);

const RESULT_STATUSES = Object.freeze(["completed", "failed"]);

// Deny rules: each entry detects a class of sensitive payload that must NEVER
// reach a host. Reason never echoes the rejected value back (side-channel safe).
const DENY_RULES = Object.freeze([
  {
    id: "token",
    description: "API / personal access / OAuth tokens",
    regex: /(?:ghp_|gho_|ghs_|ghr_|sk-ant-api|sk-proj-|sk-[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/,
  },
  {
    id: "terminal",
    description: "terminal / shell output transcript",
    regex: /(?:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]*\$|\$\s+[^\n]{1,200}\n|#\s+[A-Za-z0-9._/-]+:[0-9]+\b)/,
  },
  {
    id: "pid",
    description: "numeric PID",
    regex: /\b(?:pid|process[_-]?id)\s*[=:]\s*\d{1,7}\b/i,
  },
  {
    id: "socket",
    description: "unix socket / named pipe path",
    regex: /\.(?:sock|np)$|^\/var\/run\//,
  },
  {
    id: "executable",
    description: "executable / binary reference",
    regex: /(?:^|[\s`'"])(?:\/(?:usr|bin|sbin|opt)\/[A-Za-z0-9._-]+|\b(?:nohup|sudo)\s+[A-Za-z0-9._/-]+)/,
  },
  {
    id: "command",
    description: "shell command-like pattern",
    regex: /\b(?:rm|chmod|chown|mkfs|dd|kill(?:all)?|curl|wget)\b\s+(?:-{1,2}[A-Za-z]+\s+)*\S+/,
  },
  {
    id: "prompt",
    description: "prompt injection marker",
    regex: /\b(?:ignore (?:all )?(?:previous|prior|above) instructions|reveal (?:the )?system prompt|disregard (?:the )?(?:system|developer) (?:prompt|messages?))\b/i,
  },
  {
    id: "ip",
    description: "literal IP address (IPv4 / IPv6)",
    // IPv4: dotted quad. IPv6: at least 3 hex: groups AND either :: shorthand OR 4+ groups.
    regex: /(?:\b(?:\d{1,3}\.){3}\d{1,3}\b)|(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){3,})/,
  },
  {
    id: "absPath",
    description: "absolute filesystem path",
    regex: /(?:^|[\s"'`(])(?:\/(?:Users|home|var|tmp|private|opt|etc)\/|(?:[A-Za-z]:[\\/])|\\\\\?\\)/,
  },
]);

function createHostAdapter(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("invalid adapter descriptor: must be a non-array object");
  }
  const { adapterId, capabilities } = input;
  if (typeof adapterId !== "string" || adapterId.length === 0) {
    throw new TypeError("invalid adapter descriptor: adapterId must be a non-empty string");
  }
  if (!REGISTERED_ADAPTER_IDS.includes(adapterId)) {
    throw new Error(`adapter id not registered: ${adapterId}`);
  }
  if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== "string" || c.length === 0)) {
    throw new TypeError("invalid adapter descriptor: capabilities must be an array of non-empty strings");
  }
  // adapter object itself is NOT frozen — the runtime state (handshakeOk,
  // tasks, recoveryConsumers) must be writable across the handshake / wakeup /
  // ack lifecycle. Public fields are exposed read-only via Object.defineProperty.
  const adapter = {
    adapterId,
    schemaVersion: "1.0",
    capabilities: Object.freeze([...capabilities]),
    recoveryConsumers: Object.freeze([]),
    tasks: new Map(),
    handshakeOk: false,
    autoApprove: false,
    sideEffects: false,
  };
  Object.defineProperty(adapter, "adapterId", { value: adapterId, writable: false, enumerable: true });
  Object.defineProperty(adapter, "schemaVersion", { value: "1.0", writable: false, enumerable: true });
  Object.defineProperty(adapter, "capabilities", { value: adapter.capabilities, writable: false, enumerable: true });
  return adapter;
}

function handshake(adapter, { required } = {}) {
  if (!adapter || !adapter.adapterId) throw new Error("handshake requires a registered adapter");
  const requiredCaps = required || adapter.capabilities;
  const missing = requiredCaps.filter((c) => !adapter.capabilities.includes(c));
  const ok = missing.length === 0;
  if (ok) adapter.handshakeOk = true;
  return Object.freeze({
    ok,
    adapterId: adapter.adapterId,
    schemaVersion: adapter.schemaVersion,
    missingCapabilities: Object.freeze([...missing]),
  });
}

function buildStructuredContext(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("structuredContext must be a non-array object");
  }
  for (const key of Object.keys(input)) {
    if (!STRUCTURED_CONTEXT_FIELDS.includes(key)) {
      throw new Error(`structuredContext field '${key}' not in allowlist`);
    }
  }
  if (typeof input.threadId !== "string" || input.threadId.length === 0) {
    throw new TypeError("structuredContext.threadId must be a non-empty string");
  }
  if (typeof input.summary !== "string" || input.summary.length === 0) {
    throw new TypeError("structuredContext.summary must be a non-empty string");
  }
  if (input.references !== undefined && !Array.isArray(input.references)) {
    throw new TypeError("structuredContext.references must be an array when present");
  }
  if (input.constraints !== undefined && !Array.isArray(input.constraints)) {
    throw new TypeError("structuredContext.constraints must be an array when present");
  }
  const deny = checkDenyRules(input);
  if (!deny.ok) throw new Error(`structuredContext blocked by deny rule '${deny.ruleId}': ${deny.reason}`);
  return Object.freeze({
    threadId: input.threadId,
    summary: input.summary,
    references: input.references ? Object.freeze([...input.references]) : Object.freeze([]),
    constraints: input.constraints ? Object.freeze([...input.constraints]) : Object.freeze([]),
    priority: input.priority || "normal",
  });
}

function threadWakeup(adapter, payload) {
  if (!adapter || !adapter.handshakeOk) {
    throw new Error("threadWakeup requires a successful handshake");
  }
  if (!adapter.capabilities.includes("thread.wakeup")) {
    throw new Error("missing capability: thread.wakeup");
  }
  if (!payload || typeof payload !== "object") {
    throw new TypeError("wakeup payload must be an object");
  }
  if (!payload.context || typeof payload.context !== "object") {
    throw new TypeError("wakeup payload.context must be a structured context");
  }
  const deny = checkDenyRules(payload.context);
  if (!deny.ok) throw new Error(`wakeup blocked by deny rule '${deny.ruleId}'`);
  const taskId = generateHostAdapterTaskId();
  // autoApprove & side effects are fixed at false regardless of caller intent
  const wakeup = Object.freeze({
    taskId,
    threadId: payload.context.threadId,
    context: payload.context,
    state: "pending",
    autoApprove: false,
    sideEffects: false,
    deferredReason: null,
  });
  adapter.tasks.set(taskId, { state: "pending", history: [{ at: Date.now(), event: "wakeup" }] });
  return wakeup;
}

function registerRecoveryConsumer(adapter, input) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  if (!adapter.capabilities.includes("consumer.recovery")) {
    throw new Error("missing capability: consumer.recovery");
  }
  if (!input || typeof input.consumerId !== "string" || input.consumerId.length === 0) {
    throw new TypeError("recovery consumer requires a non-empty consumerId");
  }
  // idempotent: re-registering the same consumerId returns the same record
  const exists = adapter.recoveryConsumers.find((c) => c.consumerId === input.consumerId);
  if (exists) return Object.freeze({ ...exists });
  const record = Object.freeze({
    consumerId: input.consumerId,
    registeredAt: Date.now(),
  });
  // recoveryConsumers was frozen empty; we mutate the underlying array via push,
  // but we re-freeze a new array to keep immutability discipline.
  const next = [...adapter.recoveryConsumers, record];
  Object.defineProperty(adapter, "recoveryConsumers", {
    value: Object.freeze(next),
    writable: false,
    configurable: true,
    enumerable: true,
  });
  return record;
}

function healthSnapshot(adapter, input) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  if (!adapter.capabilities.includes("health.snapshot")) {
    throw new Error("missing capability: health.snapshot");
  }
  if (!input || typeof input.state !== "string") {
    throw new TypeError("healthSnapshot requires input.state");
  }
  const safe = ["ready", "busy", "degraded", "offline"];
  if (!safe.includes(input.state)) {
    throw new TypeError(`healthSnapshot.state must be one of ${safe.join(",")}`);
  }
  return Object.freeze({
    adapterId: adapter.adapterId,
    schemaVersion: adapter.schemaVersion,
    state: input.state,
    capabilities: adapter.capabilities,
    pendingTasks: Array.from(adapter.tasks.values()).filter((t) => t.state === "pending" || t.state === "deferred").length,
    note: input.note && typeof input.note === "string" ? input.note : null,
  });
}

function ackResult(adapter, input) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  if (!input || typeof input.taskId !== "string" || input.taskId.length === 0) {
    throw new TypeError("ack requires a taskId");
  }
  if (!RESULT_STATUSES.includes(input.status)) {
    throw new TypeError(`invalid status: ${input.status}`);
  }
  const task = adapter.tasks.get(input.taskId);
  if (!task) throw new Error(`unknown task: ${input.taskId}`);
  if (task.state !== "ack_pending") {
    throw new Error(`not ack-eligible: state=${task.state}`);
  }
  // transition ack_pending -> completed | failed
  transition(adapter, input.taskId, { to: input.status });
  return Object.freeze({ ok: true, taskId: input.taskId, status: input.status });
}

function deferredNoHost(adapter, taskId, { reason } = {}) {
  if (!adapter || !adapter.handshakeOk) throw new Error("handshake required");
  const task = adapter.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  transition(adapter, taskId, { to: "deferred" });
  // Also record the reason on the wakeup-shaped result. Caller stores it
  // separately if they want to surface it; we never put reason in shared state.
  return Object.freeze({
    taskId,
    state: "deferred",
    reason: typeof reason === "string" ? reason : "no-host",
  });
}

function transition(adapter, taskId, { from, to }) {
  const task = adapter.tasks.get(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (from && task.state !== from) {
    throw new Error(`transition mismatch: expected from=${from}, actual=${task.state}`);
  }
  const allowed = ALLOWED_TRANSITIONS[task.state] || new Set();
  if (!allowed.has(to)) {
    throw new Error(`illegal transition: ${task.state} -> ${to}`);
  }
  task.state = to;
  task.history.push({ from: task.state, to, at: Date.now() });
  return { taskId, state: to };
}

function getState(adapter, taskId) {
  const t = adapter.tasks.get(taskId);
  return t ? t.state : null;
}

function hasTask(adapter, taskId) {
  return Boolean(adapter && adapter.tasks && adapter.tasks.has(taskId));
}

function recordTask(adapter, taskId, payload) {
  if (!adapter.tasks) throw new Error("adapter not initialized");
  adapter.tasks.set(taskId, { ...payload, history: [{ at: Date.now(), event: "created" }] });
  return adapter.tasks.get(taskId);
}

// Walk an arbitrary payload tree and reject if any DENY_RULE matches.
function checkDenyRules(obj) {
  const seen = new WeakSet();
  function walk(value, path) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
      for (const rule of DENY_RULES) {
        if (rule.regex.test(value)) {
          return { ok: false, ruleId: rule.id, reason: `${rule.description} detected at ${path}` };
        }
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const hit = walk(value[i], `${path}[${i}]`);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value)) {
      const hit = walk(child, `${path}.${key}`);
      if (hit) return hit;
    }
    return null;
  }
  const hit = walk(obj, "$");
  if (hit) return { ok: false, ruleId: hit.ruleId, reason: hit.reason };
  return { ok: true };
}

let _hostTaskCounter = 0;
function generateHostAdapterTaskId() {
  _hostTaskCounter += 1;
  // Monotonic within process; deterministic enough for tests.
  return `HA-${process.pid || 0}-${_hostTaskCounter.toString(36)}`;
}

// Sentinel block to mark end of Host Wakeup additions

// ─── module.exports (placed at end to avoid TDZ on new consts) ────────────────
module.exports = {
  // Legacy vendor-specific exports (unchanged)
  DELIVERY_RESULTS,
  REPORTING_MODES,
  assertRepoRelative,
  assertSafeId,
  assertSafeText,
  createAdapterDescriptor,
  hasCapability,
  normalizeStringList,
  sanitizeEvidenceRefs,
  // Host Wakeup Adapter (vendor-neutral) additions
  REGISTERED_ADAPTER_IDS,
  STRUCTURED_CONTEXT_FIELDS,
  RESULT_STATUSES,
  PHASES,
  ALLOWED_TRANSITIONS,
  DENY_RULES,
  createHostAdapter,
  handshake,
  buildStructuredContext,
  threadWakeup,
  registerRecoveryConsumer,
  healthSnapshot,
  ackResult,
  deferredNoHost,
  checkDenyRules,
  transition,
  getState,
  hasTask,
  recordTask,
};
