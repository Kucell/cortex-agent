"use strict";

const { createEvent, STATES } = require("./contract");

const WRITE_ACTIONS = Object.freeze({
  create: "task.created",
  assign: "task.assigned",
  accept: "task.accepted",
  progress: "task.progress",
  heartbeat: "task.heartbeat",
  test: "task.testing",
  ready: "task.ready_for_review",
  complete: "task.completed",
  block: "task.blocked",
  fail: "task.failed",
  "request-input": "task.input_required",
  cancel: "task.cancel_requested",
  takeover: "task.takeover_requested",
});

// Rebinding a Task's ownership reference is not a plain write action: it
// reads the current lease, so it cannot be expressed as a fixed event type
// built from flags alone. It gets its own builder below.
const REBIND_ACTION = "rebind-ownership";
const AUTH_KINDS = new Set(["coordinator", "agent", "user", "service", "adapter"]);

function cliError(code, message, details = {}, exitCode = 2) {
  return { ok: false, error: { code, message, details }, exitCode };
}

function option(args, name) {
  const marker = `--${name}`;
  const inline = args.find((arg) => arg.startsWith(`${marker}=`));
  if (inline) return inline.slice(marker.length + 1);
  const index = args.indexOf(marker);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseJson(value, name) {
  if (!value) return cliError("INVALID_USAGE", `--${name} is required.`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return cliError("INVALID_USAGE", `--${name} must contain a JSON object.`);
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return cliError("INVALID_USAGE", `--${name} must contain valid JSON.`, { reason: error.message });
  }
}

function normalizeFailure(error) {
  const code = error && (error.key || error.code);
  return cliError(
    code || "COORDINATION_COMMAND_FAILED",
    error && error.message ? error.message : "Coordination command failed.",
    error && error.details ? error.details : {},
    3
  );
}

function parseAuthContext(value) {
  const parsed = parseJson(value, "auth-context-json");
  if (!parsed.ok) return parsed;
  const allowed = new Set(["actorId", "kind", "sessionId", "workflowGate"]);
  const unknown = Object.keys(parsed.value).filter((field) => !allowed.has(field));
  const required = ["actorId", "kind", "sessionId"];
  const missing = required.filter((field) =>
    typeof parsed.value[field] !== "string" || parsed.value[field].length === 0);
  if (unknown.length > 0 || missing.length > 0) {
    return cliError(
      "INVALID_AUTH_CONTEXT",
      "--auth-context-json must contain only actorId, kind, sessionId and optional workflowGate.",
      { fields: unknown.sort(), missing },
    );
  }
  if (!AUTH_KINDS.has(parsed.value.kind)) {
    return cliError(
      "INVALID_AUTH_CONTEXT",
      "auth context kind is not part of the coordination actor vocabulary.",
    );
  }
  if (parsed.value.workflowGate !== undefined
      && (typeof parsed.value.workflowGate !== "string"
        || parsed.value.workflowGate.length === 0)) {
    return cliError(
      "INVALID_AUTH_CONTEXT",
      "workflowGate must be a non-empty string when supplied.",
    );
  }
  return parsed;
}

const FIELD_ACTIONS = new Set(["create", "assign", "accept"]);
const FIELD_OPTIONS = new Set([
  "project", "json", "event-json", "auth-context-json", "task", "actor", "session",
  "project-id", "correlation-id", "repository-id", "assignee", "assignee-kind",
  "message", "notification-policy", "lease-id",
]);

function rejectUnknownFieldOptions(args) {
  const unknown = [];
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2).split("=", 1)[0];
    if (!FIELD_OPTIONS.has(name)) unknown.push(name);
  }
  return unknown;
}

function requiredOption(args, name) {
  const value = option(args, name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildFieldEvent(action, args, service) {
  const unknown = rejectUnknownFieldOptions(args);
  if (unknown.length > 0) {
    return cliError("UNKNOWN_OPTIONS_REJECTED", `Unknown task ${action} options: ${unknown.join(", ")}.`, {
      allowed: [...FIELD_OPTIONS].sort(),
    });
  }
  const taskId = requiredOption(args, "task");
  const actorId = requiredOption(args, "actor");
  const sessionId = requiredOption(args, "session");
  if (!taskId || !actorId || !sessionId) {
    return cliError("INVALID_USAGE", `task ${action} requires --task, --actor, and --session.`);
  }
  const existing = action === "create" ? null : service.getTask(taskId);
  if (action !== "create" && !existing) {
    return cliError("TASK_NOT_FOUND", `Task ${taskId} does not exist.`, { taskId }, 3);
  }
  const projectId = action === "create"
    ? requiredOption(args, "project-id")
    : existing.projectId;
  const correlationId = action === "create"
    ? requiredOption(args, "correlation-id")
    : existing.correlationId;
  if (!projectId || !correlationId) {
    return cliError("INVALID_USAGE", "task create requires --project-id and --correlation-id.");
  }
  const assignee = action === "assign" ? requiredOption(args, "assignee") : null;
  if (action === "assign" && !assignee) {
    return cliError("INVALID_USAGE", "task assign requires --assignee.");
  }
  const eventType = WRITE_ACTIONS[action];
  const currentState = action === "create"
    ? STATES.CREATED
    : action === "assign" ? STATES.ASSIGNED : STATES.ACCEPTED;
  return {
    ok: true,
    value: createEvent({
      projectId,
      taskId,
      correlationId,
      producer: {
        actorId,
        kind: action === "accept" ? "agent" : "coordinator",
        sessionId,
      },
      targets: action === "assign" ? [{
        actorId: assignee,
        kind: option(args, "assignee-kind") || "agent",
      }] : [],
      eventType,
      previousState: action === "create" ? null : existing.state,
      currentState,
      repository: { repositoryId: option(args, "repository-id") || projectId },
      message: option(args, "message") || null,
      notification: {
        policy: option(args, "notification-policy") || "journal_only",
        dedupeKey: `${eventType}:${taskId}`,
      },
    }),
  };
}

// ─── Rebind an ownership reference to a fresher lease ───────────────────────
//
// A Task that paused for input can hold an ownership reference to a lease
// that has since expired. The owner acquires a new lease over the same
// scope, but the Task still points at the old one — and `task.progress`, the
// only event that resumes the Task, is refused because of it. This builder
// produces the `ownership.rebound` event that moves the reference onto the
// new lease.
//
// The event carries the new reference read from the durable lease state, so
// the caller cannot forge a fencing token: the application service re-checks
// every reference against the lease manager before accepting it.
function buildRebindEvent(action, args, service) {
  const unknown = rejectUnknownFieldOptions(args);
  if (unknown.length > 0) {
    return cliError("UNKNOWN_OPTIONS_REJECTED", `Unknown task ${action} options: ${unknown.join(", ")}.`, {
      allowed: [...FIELD_OPTIONS].sort(),
    });
  }
  const taskId = requiredOption(args, "task");
  const actorId = requiredOption(args, "actor");
  const sessionId = requiredOption(args, "session");
  const leaseId = requiredOption(args, "lease-id");
  if (!taskId || !actorId || !sessionId || !leaseId) {
    return cliError(
      "INVALID_USAGE",
      `task ${action} requires --task, --actor, --session, and --lease-id.`,
    );
  }
  // A task may hold several scopes at once, and each of them can expire
  // while the task waits for input. Rebinding one scope at a time would
  // leave the others expired, and the task could not resume until every one
  // of them had been rebound in turn. Several lease ids may therefore be
  // passed at once, comma-separated, to restore them together.
  const leaseIds = leaseId.split(",").map((value) => value.trim()).filter(Boolean);
  if (leaseIds.length === 0) {
    return cliError(
      "INVALID_USAGE",
      `task ${action} requires at least one lease id in --lease-id.`,
    );
  }
  const existing = service.getTask(taskId);
  if (!existing) {
    return cliError("TASK_NOT_FOUND", `Task ${taskId} does not exist.`, { taskId }, 3);
  }
  const leases = service.leases;
  if (!leases || typeof leases.getLease !== "function") {
    return cliError(
      "CAPABILITY_UNAVAILABLE",
      "The durable lease manager is not configured; the ownership reference cannot be rebound.",
      { read_only: false },
      3,
    );
  }
  const reboundLeases = [];
  for (const id of leaseIds) {
    const lease = leases.getLease(id);
    if (!lease) {
      return cliError("LEASE_NOT_FOUND", `Lease ${id} does not exist.`, { leaseId: id }, 3);
    }
    reboundLeases.push(lease);
  }
  return {
    ok: true,
    value: createEvent({
      projectId: existing.projectId,
      taskId,
      correlationId: existing.correlationId,
      producer: { actorId, kind: "agent", sessionId },
      targets: [],
      eventType: "ownership.rebound",
      previousState: existing.state,
      currentState: existing.state,
      repository: { repositoryId: option(args, "repository-id") || existing.projectId },
      fileOwnership: reboundLeases.map((lease) => ({
        leaseId: lease.leaseId,
        scope: lease.scope,
        owner: lease.owner,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      })),
      message: option(args, "message") || null,
      notification: {
        policy: option(args, "notification-policy") || "journal_only",
        dedupeKey: `ownership.rebound:${taskId}:${leaseIds.join(",")}`,
      },
    }),
  };
}

/**
 * Adapt public task/event CLI grammar to an injected Coordination Application
 * Service. State and actor rules remain exclusively owned by that service.
 */
function executeCoordinationCommand(argv, dependencies = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const resource = args[0];
  const action = args[1];
  const service = dependencies.service;
  const acknowledgements = dependencies.acknowledgements;
  if (!service) {
    return cliError(
      "COORDINATION_SERVICE_UNAVAILABLE",
      "Coordination Application Service is not configured.",
      {},
      3
    );
  }

  try {
    if (resource === "task" && action === "status") {
      const taskId = option(args, "task");
      if (!taskId) return cliError("INVALID_USAGE", "--task is required.");
      return { ok: true, command: "task.status", task: service.getTask(taskId) };
    }
    if (resource === "task" && action === "list") {
      return { ok: true, command: "task.list", tasks: service.listTasks() };
    }
    if (resource === "task" && action === "watch") {
      return cliError(
        "CAPABILITY_UNAVAILABLE",
        "task watch requires an opt-in notification adapter; use task status or event list.",
        { read_only: true },
        3
      );
    }
    if (resource === "task" && WRITE_ACTIONS[action]) {
      const parsed = option(args, "event-json")
        ? parseJson(option(args, "event-json"), "event-json")
        : FIELD_ACTIONS.has(action)
          ? buildFieldEvent(action, args, service)
          : parseJson(option(args, "event-json"), "event-json");
      if (!parsed.ok) return parsed;
      if (parsed.value.eventType !== WRITE_ACTIONS[action]) {
        return cliError("EVENT_TYPE_MISMATCH", `${action} requires eventType ${WRITE_ACTIONS[action]}.`, {
          expected: WRITE_ACTIONS[action],
          actual: parsed.value.eventType || null,
        });
      }
      let authContext = null;
      const authJson = option(args, "auth-context-json");
      if (authJson) {
        const parsedAuth = parseAuthContext(authJson);
        if (!parsedAuth.ok) return parsedAuth;
        authContext = parsedAuth.value;
      }
      return {
        ok: true,
        command: `task.${action}`,
        result: service.submit(parsed.value, authContext),
      };
    }
    if (resource === "task" && action === REBIND_ACTION) {
      const parsed = buildRebindEvent(action, args, service);
      if (!parsed.ok) return parsed;
      let authContext = null;
      const authJson = option(args, "auth-context-json");
      if (authJson) {
        const parsedAuth = parseAuthContext(authJson);
        if (!parsedAuth.ok) return parsedAuth;
        authContext = parsedAuth.value;
      }
      return {
        ok: true,
        command: `task.${action}`,
        result: service.submit(parsed.value, authContext),
      };
    }
    if (resource === "event" && action === "list") {
      const filter = {};
      const taskId = option(args, "task");
      const eventType = option(args, "event-type");
      const producerId = option(args, "producer");
      if (taskId) filter.taskId = taskId;
      if (eventType) filter.eventType = eventType;
      if (producerId) filter.producerId = producerId;
      return { ok: true, command: "event.list", events: service.listEvents(filter) };
    }
    if (resource === "event" && action === "ack") {
      if (!acknowledgements || typeof acknowledgements.ack !== "function") {
        return cliError("CAPABILITY_UNAVAILABLE", "Event ACK store is not configured.", {}, 3);
      }
      const eventId = option(args, "event");
      const consumerId = option(args, "consumer");
      if (!eventId || !consumerId) {
        return cliError("INVALID_USAGE", "--event and --consumer are required.");
      }
      return {
        ok: true,
        command: "event.ack",
        acknowledgement: acknowledgements.ack({ eventId, consumerId }),
      };
    }
    return cliError("INVALID_USAGE", "Unsupported coordination command.", { resource, action });
  } catch (error) {
    return normalizeFailure(error);
  }
}

module.exports = {
  WRITE_ACTIONS,
  executeCoordinationCommand,
};
