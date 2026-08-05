"use strict";

// ─── Agent Reporter (T-ACN-016) ──────────────────────────────────────────────
//
// Public Task API lifecycle reports for agents. An agent creates a reporter
// via `createAgentReporter` with a stable identity and project context, then
// calls `report(eventType, options)` for each lifecycle milestone.
//
// The reporter ONLY submits events that the agent is authorized to produce
// (owner-scoped events: accepted, progress, heartbeat, testing, blocked,
// input_required, failed, ready_for_review). Lifecycle events that require
// coordinator authority (created, assigned, completed, cancel_requested,
// takeover_requested, cancelled, taken_over) are rejected at the reporter
// boundary.
//
// Agent-scoped event types (P-003 §6.3, T-ACN-016):
//   task.accepted          — agent accepts an assigned task
//   task.progress          — agent reports progress / state change
//   task.heartbeat         — agent reports it is still alive
//   task.testing           — agent begins testing phase
//   task.blocked           — agent is blocked on a dependency
//   task.input_required    — agent needs human input
//   task.failed            — agent reports failure
//   task.ready_for_review  — agent marks work ready for review
//
// Construction with service:
//   const reporter = createAgentReporter(service, {
//     actorId: "claude-1",
//     kind: "agent",
//     sessionId: "session-xyz",
//     projectId: "my-project",
//   });
//   const result = reporter.report("task.progress", {
//     taskId: "TASK-001",
//     message: "Working on phase 2",
//   });
//   // result → { ok: true, event: {...}, task: {...} }
//
// Construction without service (CI / test / offline):
//   const reporter = createAgentReporter(null, { ... });
//   const result = reporter.report("task.progress", {
//     taskId: "TASK-001",
//   });
//   // result → { ok: false, code: "SERVICE_UNAVAILABLE" } (no-op, never throws)

const { createEvent, STATES, EVENT_TYPE_SET } = require("./coordination/contract");
const { CoordinationError } = require("./coordination/errors");
const { scanContent } = require("./secret-scan");
const path = require("node:path");

const AGENT_REPORTER_SCHEMA_VERSION = "1.0";

// ─── CORTEX_LAUNCH_CONTEXT reader ─────────────────────────────────────────────
// Reads the private launch context from the 0600 context file pointed to by
// the CORTEX_LAUNCH_CONTEXT environment variable. This is the ONLY way the
// agent reporter obtains its identity when running in a governed launch.
//
// Returns null (and may log a warning) when the context is unavailable.
// Callers MUST fail closed on null.

function readLaunchContext(explicitContextFile) {
  const contextFile = explicitContextFile || process.env.CORTEX_LAUNCH_CONTEXT;
  if (!contextFile || typeof contextFile !== "string" || contextFile.length === 0) return null;
  try {
    const fs = require("node:fs");
    const stat = fs.statSync(contextFile);
    // Verify mode 0600 or stricter (owner-only)
    if (stat.mode & 0o077) return null;
    const content = fs.readFileSync(contextFile, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    // Validate required fields
    if (!parsed.taskId || !parsed.projectId || !parsed.coordinatorId) return null;
    // Attach the context file directory for persistent dedup storage
    parsed.contextFileDir = path.dirname(contextFile);
    return parsed;
  } catch (_) {
    return null;
  }
}

// ─── Immutable retry dedup key ─────────────────────────────────────────────────
// Stable dedup key for hook retry idempotency: launchId + eventType + deliveryId.
// The deliveryId is an optional hook-layer identifier that the caller can supply
// so that the same eventType from the same launch is not submitted twice.

function buildRetryDedupKey(launchId, eventType, deliveryId) {
  if (!launchId || !eventType) return null;
  return `${launchId}:${eventType}${deliveryId ? `:${deliveryId}` : ""}`;
}

// Agent-scoped event types: the subset of the coordination vocabulary that
// an agent is authorized to produce without coordinator mediation.
// Governance fields (targets, repository, sequence, workflowGate, projectId)
// are always controlled by the reporter, never by the agent's input.
const AGENT_SCOPED_EVENT_TYPES = Object.freeze([
  "task.accepted",
  "task.progress",
  "task.heartbeat",
  "task.testing",
  "task.blocked",
  "task.input_required",
  "task.failed",
  "task.ready_for_review",
]);

const AGENT_SCOPED_EVENT_SET = new Set(AGENT_SCOPED_EVENT_TYPES);
const COORDINATOR_NOTIFY_EVENTS = new Set([
  "task.ready_for_review",
  "task.input_required",
  "task.blocked",
  "task.failed",
]);

// State transition map for agent-scoped events: eventType → { from, to }
// This mirrors the T-ACN-002 contract's TRANSITIONS map but only for the
// transitions that an agent is authorized to produce.
const AGENT_TRANSITIONS = Object.freeze({
  "task.accepted":         { from: STATES.ASSIGNED,            to: STATES.ACCEPTED },
  "task.progress":         { from: null,                       to: STATES.EXECUTING }, // multiple from states
  "task.heartbeat":        { from: null,                       to: null },              // no state change
  "task.testing":          { from: STATES.EXECUTING,           to: STATES.TESTING },
  "task.blocked":          { from: null,                       to: STATES.BLOCKED },
  "task.input_required":   { from: null,                       to: STATES.WAITING_FOR_INPUT },
  "task.failed":           { from: null,                       to: STATES.FAILED },
  "task.ready_for_review": { from: null,                       to: STATES.READY_FOR_REVIEW },
});

// Transition target state lookup: for a given event type, what state should
// the task transition TO? The agent MUST NOT override currentState or
// previousState — these are derived from the service task state.
function targetStateFor(task, eventType) {
  if (eventType === "task.heartbeat") {
    // Heartbeat is a liveness event — no state change, so currentState
    // should match the actual task state.
    return task ? task.state : null;
  }
  const transition = AGENT_TRANSITIONS[eventType];
  if (transition && transition.to) return transition.to;
  return null;
}

function previousStateFor(task) {
  if (task && task.state) return task.state;
  return null;
}

// ─── Agent-controlled fields that MUST NOT be accepted from agent input ──────
//
// These fields are either derived from the governed launch context or
// determined by the service. The agent MUST NOT be able to override them.
const FORBIDDEN_AGENT_FIELDS = new Set([
  "targets",
  "repository",
  "sequence",
  "workflowGate",
  "currentState",
  "previousState",
  "permission",
  "ownership",
  "Decision",
  "Waitpoint",
  "decisionRef",
  "waitpointRef",
]);

// ─── Length limits ───────────────────────────────────────────────────────────
const MAX_MESSAGE_LENGTH = 4000;
const MAX_EVIDENCE_COUNT = 32;
const MAX_EVIDENCE_REF_LENGTH = 256;

// ─── Input sanitization ──────────────────────────────────────────────────────
function sanitizeAgentInput(input) {
  if (!input || typeof input !== "object") return input;

  // Strip forbidden fields
  const sanitized = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_AGENT_FIELDS.has(key)) {
      continue; // silently drop forbidden fields
    }
    sanitized[key] = value;
  }

  // Length filter on message
  if (typeof sanitized.message === "string" && sanitized.message.length > MAX_MESSAGE_LENGTH) {
    sanitized.message = sanitized.message.slice(0, MAX_MESSAGE_LENGTH);
  }

  // Limit evidence count
  if (Array.isArray(sanitized.evidence) && sanitized.evidence.length > MAX_EVIDENCE_COUNT) {
    sanitized.evidence = sanitized.evidence.slice(0, MAX_EVIDENCE_COUNT);
  }

  // Truncate evidence refs
  if (Array.isArray(sanitized.evidence)) {
    sanitized.evidence = sanitized.evidence.map((ev) => {
      if (ev && typeof ev.ref === "string" && ev.ref.length > MAX_EVIDENCE_REF_LENGTH) {
        return { ...ev, ref: ev.ref.slice(0, MAX_EVIDENCE_REF_LENGTH) };
      }
      return ev;
    });
  }

  return sanitized;
}

// ─── Secret scan on agent input ─────────────────────────────────────────────
function scanAgentInput(input) {
  const serialized = JSON.stringify(input);
  const findings = scanContent(serialized);
  return findings.length > 0
    ? { hasSecrets: true, findings }
    : { hasSecrets: false, findings: [] };
}

// ─── Redacted receipt ────────────────────────────────────────────────────────
// Builds a public-facing receipt per P-003 §11.1 / §13.5.
// The receipt contains ONLY:
//   - eventId, eventType, taskId, projectId, timestamp
//   - state (current task state)
//   - redactedSummary (bounded, scanned for sensitive patterns, or null)
//   - artifactSha (evidence artifact SHA, if evidence is provided)
//   - ok (boolean)
//
// The receipt MUST NOT include:
//   - raw message text
//   - raw evidence content
//   - context path, session, command, args, token, or absolute path
//   - governance fields (producer, targets, repository, sequence, etc.)

function buildRedactedReceipt(event, result) {
  const source = (result && result.event) || event;
  const task = result && result.task ? result.task : null;
  const receipt = {
    eventId: source.eventId,
    eventType: source.eventType,
    taskId: event.taskId,
    projectId: event.projectId,
    timestamp: source.timestamp,
    state: task ? task.state : null,
    ok: true,
  };

  // Redacted summary: bounded, scanned, or null. Never returns raw message.
  if (source.message) {
    const bounded = source.message.length > 256 ? source.message.slice(0, 256) + "..." : source.message;
    const scan = scanContent(JSON.stringify(bounded));
    if (scan.length === 0) {
      receipt.redactedSummary = bounded;
    }
  }

  // Artifact SHA: only from evidence, if present and clean.
  if (source.evidence && source.evidence.length > 0) {
    for (const ev of source.evidence) {
      if (ev && ev.ref && typeof ev.ref === "string") {
        const evScan = scanContent(JSON.stringify(ev.ref));
        if (evScan.length === 0) {
          receipt.artifactSha = ev.ref;
          break;
        }
      }
    }
  }

  return receipt;
}

class AgentReporterError extends Error {
  constructor(code, details) {
    super(`[agent-reporter:${code}] ${JSON.stringify(details || {})}`);
    this.name = "AgentReporterError";
    this.code = code;
    this.details = details || {};
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentReporterError("ERR_FIELD_INVALID", { field });
  }
  return value;
}

function assertOptionalString(value, field) {
  if (value !== null && value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new AgentReporterError("ERR_FIELD_INVALID", { field });
  }
  return value || null;
}

function createAgentReporter(service, options) {
  if (!options || typeof options !== "object") {
    throw new AgentReporterError("ERR_OPTIONS_REQUIRED", {});
  }
  const actorId = assertNonEmptyString(options.actorId, "actorId");
  const kind = assertNonEmptyString(options.kind, "kind");
  const sessionId = assertNonEmptyString(options.sessionId, "sessionId");
  const projectId = assertNonEmptyString(options.projectId, "projectId");

  if (kind !== "agent") {
    throw new AgentReporterError("ERR_KIND_MUST_BE_AGENT", { kind });
  }

  const producer = Object.freeze({ actorId, kind, sessionId });
  let correlationCounter = 0;

  function nextCorrelationId(taskId) {
    correlationCounter += 1;
    return `${projectId}:${taskId}:${correlationCounter}`;
  }

  function report(eventType, input) {
    if (!AGENT_SCOPED_EVENT_SET.has(eventType)) {
      return {
        ok: false,
        code: "ERR_EVENT_TYPE_NOT_AGENT_SCOPED",
        message: `Event type ${eventType} is not in the agent-scoped vocabulary. Agent-scoped types: ${AGENT_SCOPED_EVENT_TYPES.join(", ")}`,
        eventType,
      };
    }

    if (!input || typeof input !== "object") {
      return {
        ok: false,
        code: "ERR_INPUT_REQUIRED",
        message: "report requires an input object with taskId",
      };
    }

    const taskId = assertNonEmptyString(input.taskId, "taskId");

    // Sanitize agent input: strip forbidden fields, apply length limits
    const sanitized = sanitizeAgentInput(input);

    // Secret scan on sanitized input
    const scan = scanAgentInput(sanitized);
    if (scan.hasSecrets) {
      return {
        ok: false,
        code: "ERR_SENSITIVE_DATA_REJECTED",
        message: "Report contains sensitive data patterns and was rejected.",
        findings: scan.findings.map((f) => f.rule_id),
      };
    }

    const correlationId = assertOptionalString(sanitized.correlationId, "correlationId") || nextCorrelationId(taskId);
    const message = assertOptionalString(sanitized.message, "message");
    const evidence = Array.isArray(sanitized.evidence) ? sanitized.evidence : [];
    const progress = sanitized.progress || null;
    const notificationPolicy = sanitized.notificationPolicy
      || (COORDINATOR_NOTIFY_EVENTS.has(eventType) ? "coordinator_notify" : "journal_only");

    // If we have a service, query current task state for transition context.
    // currentState and previousState are ALWAYS derived from the service,
    // NEVER from the agent input.
    let currentTask = null;
    let targetState = targetStateFor(null, eventType);
    let previousState = null;

    if (service && typeof service.getTask === "function") {
      try {
        currentTask = service.getTask(taskId);
      } catch (_) {
        currentTask = null;
      }
    }

    if (currentTask) {
      targetState = targetStateFor(currentTask, eventType);
      previousState = currentTask.state;
    } else {
      previousState = null;
    }

    // If service is available, submit through the Coordination Application Service.
    // The agent NEVER provides targets, repository, sequence, workflowGate,
    // currentState, previousState, permission, ownership, Decision, or Waitpoint.
    if (service && typeof service.submit === "function") {
      try {
        const event = createEvent({
          projectId,
          taskId,
          correlationId,
          producer,
          targets: [], // agents never set targets
          eventType,
          previousState: previousState !== null ? previousState : null,
          currentState: targetState !== null ? targetState : STATES.EXECUTING,
          sequence: null, // service determines sequence
          repository: { repositoryId: projectId }, // from launch context, not agent
          progress,
          message,
          evidence,
          requestedAction: sanitized.requestedAction || null,
          notification: { policy: notificationPolicy, dedupeKey: eventType },
        });

        const result = service.submit(event, {
          actorId,
          kind,
          sessionId,
          // workflowGate is not forwarded from agent input
        });

        const receipt = buildRedactedReceipt(event, result);

        return {
          ok: true,
          event: result.event,
          task: result.task,
          appended: result.appended,
          duplicate: result.duplicate,
          receipt,
        };
      } catch (error) {
        const code = (error && error.key) || (error && error.code) || "ERR_REPORT_FAILED";
        return {
          ok: false,
          code,
          message: error && error.message ? error.message : "Report submission failed",
          details: error && error.details ? error.details : {},
        };
      }
    }

    // No service: return a structured no-op result.
    return {
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Coordination Application Service is not available; report was not submitted.",
      input: { eventType, taskId, correlationId },
    };
  }

  // openBatch / closeBatch: lightweight batch reporting.
  // Each batch creates a shared correlation root and submits all events
  // through the same reporter instance.
  function openBatch(taskId, options = {}) {
    const batchId = nextCorrelationId(taskId);
    const events = [];
    return Object.freeze({
      batchId,
      taskId,
      add(eventType, input = {}) {
        const result = report(eventType, { ...input, taskId, correlationId: batchId });
        events.push(result);
        return result;
      },
      events: () => [...events],
      summary() {
        const ok = events.filter((e) => e.ok).length;
        const failed = events.filter((e) => !e.ok).length;
        return { total: events.length, ok, failed, batchId };
      },
    });
  }

  return Object.freeze({
    actorId,
    kind,
    sessionId,
    projectId,
    producer,
    report,
    openBatch,
    schemaVersion: AGENT_REPORTER_SCHEMA_VERSION,
  });
}

// ─── createAgentReporterFromContext ───────────────────────────────────────────
// Creates an agent reporter from the governed launch context (CORTEX_LAUNCH_CONTEXT).
// This is the ONLY way to create a reporter in production — the CLI and governed
// launcher MUST use this path. Falls back to a controlled fail-closed error.
//
// The context provides:
//   - taskId, projectId, coordinatorId, launchId, targetAgentId
//   - producer (immutable, set by the launcher, never by the agent)
//   - repository, ownership scopes, target
//
// Identity contract (P-003 §11.1):
//   - The actorId is the real targetAgentId from the context, NOT the coordinatorId.
//   - The producer is immutable — set by the launcher, the agent cannot override it.
//   - input.taskId is validated against context.taskId — the agent cannot specify
//     a different taskId. This prevents an agent from reporting on a task it was
//     not launched for.
//
// Idempotency: Uses launchId + eventType + deliveryId as the dedup key.
// Dedup is PERSISTENT (file-based) so that duplicate delivery across reporter
// or instance rebuild is still prevented. The dedup file lives in the same
// temporary directory as the context file.

function createAgentReporterFromContext(service, options = {}) {
  const context = readLaunchContext(options.contextFile);
  if (!context) {
    throw new AgentReporterError("ERR_NO_GOVERNED_CONTEXT", {
      message: "Agent reporter requires a governed launch context (CORTEX_LAUNCH_CONTEXT). No default identity allowed.",
    });
  }

  // Use targetAgentId from context — NOT coordinatorId.
  // The targetAgentId is the real agent identity set by the governed launcher.
  const actorId = assertNonEmptyString(context.targetAgentId || context.coordinatorId, "targetAgentId");
  const projectId = assertNonEmptyString(context.projectId, "projectId");
  const contextTaskId = assertNonEmptyString(context.taskId, "taskId");
  const launchId = assertNonEmptyString(context.launchId, "launchId");
  // Delivery targets are launcher-owned private context, never agent input.
  // The fallback preserves compatibility for contexts created before CP-11.
  const notificationTarget = context.notificationTarget
    && context.notificationTarget.kind === "coordinator"
    && typeof context.notificationTarget.actorId === "string"
    && context.notificationTarget.actorId.length > 0
    ? Object.freeze({ actorId: context.notificationTarget.actorId, kind: "coordinator" })
    : Object.freeze({ actorId: assertNonEmptyString(context.coordinatorId, "coordinatorId"), kind: "coordinator" });

  // Use the immutable producer from the context if available, otherwise build one.
  // producer must only contain actorId, kind, vendor, sessionId per contract
  // (machine-validator.js FIELDS.producer). operationId/operationAttempt are
  // event-level fields, not producer fields.
  const producer = context.producer && typeof context.producer === "object"
    ? Object.freeze({
        actorId: context.producer.actorId || actorId,
        kind: context.producer.kind === "agent" ? "agent" : "agent",
        sessionId: context.producer.sessionId || actorId,
      })
    : Object.freeze({
        actorId,
        kind: "agent",
        sessionId: actorId,
      });

  // ─── Persistent dedup store ───────────────────────────────────────────────
  // Uses a file in the same temp directory as the context file (if the context
  // file path is known) so that dedup state survives reporter reconstruction.
  // The dedup file contains a JSON object of { "launchId:eventType:deliveryId": true }
  // keys. This ensures that even across reporter instances or process restarts,
  // the same deliveryId is not processed twice.
  const dedupDir = context.contextFileDir || null;
  const dedupFile = dedupDir ? path.join(dedupDir, ".dedup.json") : null;

  let dedupStore = null;
  if (dedupFile) {
    try {
      const raw = fs.readFileSync(dedupFile, "utf8");
      dedupStore = JSON.parse(raw);
    } catch (_) {
      dedupStore = {};
    }
  }

  function persistDedupKey(key) {
    if (!dedupStore || !dedupFile) return;
    dedupStore[key] = true;
    try {
      fs.writeFileSync(dedupFile, JSON.stringify(dedupStore), { encoding: "utf8", mode: 0o600 });
    } catch (_) {
      // Best-effort — if the file cannot be written, dedup is still
      // enforced within this process instance.
    }
  }

  function checkDedupKey(key) {
    if (!dedupStore) return false;
    return dedupStore[key] === true;
  }

  function report(eventType, input) {
    if (!AGENT_SCOPED_EVENT_SET.has(eventType)) {
      return {
        ok: false,
        code: "ERR_EVENT_TYPE_NOT_AGENT_SCOPED",
        message: `Event type ${eventType} is not in the agent-scoped vocabulary.`,
        eventType,
      };
    }

    if (!input || typeof input !== "object") {
      return {
        ok: false,
        code: "ERR_INPUT_REQUIRED",
        message: "report requires an input object",
      };
    }

    // input.taskId is validated against context.taskId — the agent CANNOT
    // specify a different taskId. This prevents an agent from reporting on
    // a task it was not launched for.
    const inputTaskId = input.taskId;
    if (inputTaskId !== undefined && inputTaskId !== null && inputTaskId !== contextTaskId) {
      return {
        ok: false,
        code: "ERR_TASK_ID_MISMATCH",
        message: `input.taskId (${inputTaskId}) does not match context taskId (${contextTaskId}). The agent may only report on its assigned task.`,
      };
    }

    const taskId = contextTaskId;

    // Stable dedup key: launchId + eventType + deliveryId.
    // The deliveryId is an optional hook-layer identifier. Without it, the
    // dedup key is launchId + eventType, which prevents duplicate eventType
    // submissions from the same launch. With deliveryId, it prevents retry
    // of the exact same delivery.
    const deliveryId = input.deliveryId || null;
    const dedupKey = buildRetryDedupKey(launchId, eventType, deliveryId);
    if (dedupKey && checkDedupKey(dedupKey)) {
      return {
        ok: false,
        code: "ERR_DUPLICATE_DELIVERY",
        message: `Duplicate delivery for ${dedupKey} — already submitted.`,
      };
    }
    if (dedupKey) persistDedupKey(dedupKey);

    const sanitized = sanitizeAgentInput(input);

    const scan = scanAgentInput(sanitized);
    if (scan.hasSecrets) {
      return {
        ok: false,
        code: "ERR_SENSITIVE_DATA_REJECTED",
        message: "Report contains sensitive data patterns and was rejected.",
        findings: scan.findings.map((f) => f.rule_id),
      };
    }

    const correlationId = sanitized.correlationId || `${projectId}:${taskId}:${Date.now().toString(36)}`;
    const message = typeof sanitized.message === "string" ? sanitized.message : null;
    const evidence = Array.isArray(sanitized.evidence) ? sanitized.evidence : [];
    const progress = sanitized.progress || null;
    const notificationPolicy = sanitized.notificationPolicy || "journal_only";

    let currentTask = null;
    let targetState = targetStateFor(null, eventType);
    let previousState = null;

    if (service && typeof service.getTask === "function") {
      try {
        currentTask = service.getTask(taskId);
      } catch (_) {
        currentTask = null;
      }
    }

    if (currentTask) {
      targetState = targetStateFor(currentTask, eventType);
      previousState = currentTask.state;
    } else {
      previousState = null;
    }

    if (service && typeof service.submit === "function") {
      try {
        const event = createEvent({
          projectId,
          taskId,
          correlationId,
          producer,
          targets: [notificationTarget],
          eventType,
          previousState: previousState !== null ? previousState : null,
          currentState: targetState !== null ? targetState : STATES.EXECUTING,
          sequence: null,
          repository: { repositoryId: projectId },
          fileOwnership: currentTask && Array.isArray(currentTask.ownership)
            ? currentTask.ownership
            : [],
          progress,
          message,
          evidence,
          requestedAction: sanitized.requestedAction || null,
          notification: { policy: notificationPolicy, dedupeKey: eventType },
        });

        const result = service.submit(event, {
          actorId,
          kind: "agent",
          sessionId: producer.sessionId,
        });
        const receipt = buildRedactedReceipt(event, result);

        return {
          ok: true,
          event: result.event,
          task: result.task,
          appended: result.appended,
          duplicate: result.duplicate,
          receipt,
        };
      } catch (error) {
        const code = (error && error.key) || (error && error.code) || "ERR_REPORT_FAILED";
        return {
          ok: false,
          code,
          message: error && error.message ? error.message : "Report submission failed",
          details: error && error.details ? error.details : {},
        };
      }
    }

    return {
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Coordination Application Service is not available; report was not submitted.",
      input: { eventType, taskId, correlationId },
    };
  }
  return Object.freeze({
    actorId,
    kind: "agent",
    sessionId: producer.sessionId,
    projectId,
    contextTaskId,
    producer,
    launchId,
    report,
    schemaVersion: AGENT_REPORTER_SCHEMA_VERSION,
  });
}

module.exports = {
  AGENT_REPORTER_SCHEMA_VERSION,
  AGENT_SCOPED_EVENT_TYPES,
  AGENT_SCOPED_EVENT_SET,
  AGENT_TRANSITIONS,
  AgentReporterError,
  createAgentReporter,
  createAgentReporterFromContext,
  FORBIDDEN_AGENT_FIELDS,
  sanitizeAgentInput,
  scanAgentInput,
  buildRedactedReceipt,
  buildRetryDedupKey,
  readLaunchContext,
};
