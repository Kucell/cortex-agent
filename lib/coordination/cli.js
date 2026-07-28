"use strict";

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
  "request-input": "task.input_required",
  cancel: "task.cancel_requested",
  takeover: "task.takeover_requested",
});

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
      const parsed = parseJson(option(args, "event-json"), "event-json");
      if (!parsed.ok) return parsed;
      if (parsed.value.eventType !== WRITE_ACTIONS[action]) {
        return cliError("EVENT_TYPE_MISMATCH", `${action} requires eventType ${WRITE_ACTIONS[action]}.`, {
          expected: WRITE_ACTIONS[action],
          actual: parsed.value.eventType || null,
        });
      }
      return { ok: true, command: `task.${action}`, result: service.submit(parsed.value) };
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
