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

const AGENT_REPORTER_SCHEMA_VERSION = "1.0";

// Agent-scoped event types: the subset of the coordination vocabulary that
// an agent is authorized to produce without coordinator mediation.
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
// the task transition TO? Falls back to the AGENT_TRANSITIONS map, or to the
// caller-provided currentState option.
function targetStateFor(task, eventType, options) {
  if (options && options.currentState) return options.currentState;
  if (eventType === "task.heartbeat") {
    // Heartbeat is a liveness event — no state change, so currentState
    // should match the actual task state.
    return task ? task.state : null;
  }
  const transition = AGENT_TRANSITIONS[eventType];
  if (transition && transition.to) return transition.to;
  return null;
}

function previousStateFor(task, eventType, options) {
  if (options && options.previousState !== undefined) return options.previousState;
  if (task && task.state) return task.state;
  return null;
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
    const correlationId = assertOptionalString(input.correlationId, "correlationId") || nextCorrelationId(taskId);
    const message = assertOptionalString(input.message, "message");
    const evidence = Array.isArray(input.evidence) ? input.evidence : [];
    const progress = input.progress || null;
    const notificationPolicy = input.notificationPolicy || "journal_only";

    // If we have a service, query current task state for transition context.
    let currentTask = null;
    let targetState = targetStateFor(null, eventType, input);
    let previousState = null;

    if (service && typeof service.getTask === "function") {
      try {
        currentTask = service.getTask(taskId);
      } catch (_) {
        currentTask = null;
      }
    }

    if (currentTask) {
      targetState = targetStateFor(currentTask, eventType, input);
      previousState = currentTask.state;
    } else {
      previousState = previousStateFor(null, eventType, input);
    }

    // If service is available, submit through the Coordination Application Service.
    if (service && typeof service.submit === "function") {
      try {
        const event = createEvent({
          projectId,
          taskId,
          correlationId,
          producer,
          targets: input.targets || [],
          eventType,
          previousState: previousState !== null ? previousState : null,
          currentState: targetState !== null ? targetState : STATES.EXECUTING,
          sequence: input.sequence || null,
          repository: input.repository || { repositoryId: projectId },
          progress,
          message,
          evidence,
          requestedAction: input.requestedAction || null,
          notification: { policy: notificationPolicy, dedupeKey: eventType },
        });

        const result = service.submit(event, {
          actorId,
          kind,
          sessionId,
          ...(input.workflowGate ? { workflowGate: input.workflowGate } : {}),
        });

        return {
          ok: true,
          event: result.event,
          task: result.task,
          appended: result.appended,
          duplicate: result.duplicate,
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

module.exports = {
  AGENT_REPORTER_SCHEMA_VERSION,
  AGENT_SCOPED_EVENT_TYPES,
  AGENT_SCOPED_EVENT_SET,
  AGENT_TRANSITIONS,
  AgentReporterError,
  createAgentReporter,
};