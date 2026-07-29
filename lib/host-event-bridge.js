"use strict";

// ─── Generic Host Event Bridge (T-ACN-016) ───────────────────────────────────
//
// Bridges lifecycle events from a generic host (any adapter that can execute
// `cortex-agent agent report`) to the Coordination Application Service.
//
// The bridge exposes a single restricted CLI surface:
//   cortex-agent agent report --event-type <type> --task-id <id> [options]
//
// The bridge is "generic" because it accepts events from any host adapter
// without requiring host-specific hook configuration. The host only needs to
// be able to run `cortex-agent agent report` with the correct arguments.
//
// Safety contract:
//   1. Only agent-scoped event types are accepted.
//   2. Event payloads are validated against the coordination schema.
//   3. The bridge never writes to disk, spawns processes, or makes network
//      calls. All side effects are delegated to the Coordination Application
//      Service.
//   4. No automatic dispatch/daemon: the bridge is purely reactive.
//   5. The bridge rejects events that contain executable or command payloads.

const { createEvent, STATES } = require("./coordination/contract");
const { createAgentReporter, AGENT_SCOPED_EVENT_TYPES } = require("./agent-reporter");

const HOST_EVENT_BRIDGE_SCHEMA_VERSION = "1.0";

// ─── Bridge CLI ──────────────────────────────────────────────────────────────
//
// Parses the `cortex-agent agent report` CLI arguments and submits the report
// through the Coordination Application Service.
//
// CLI grammar:
//   cortex-agent agent report --event-type <type> --task-id <id>
//     [--actor-id <id>] [--kind <kind>] [--session-id <id>]
//     [--project-id <id>] [--message <text>] [--correlation-id <id>]
//     [--notification-policy <policy>] [--event-json <json>]

function option(args, name) {
  const marker = `--${name}`;
  const inline = args.find((arg) => arg.startsWith(`${marker}=`));
  if (inline) return inline.slice(marker.length + 1);
  const index = args.indexOf(marker);
  return index >= 0 ? args[index + 1] : undefined;
}

function bridgesError(code, message, exitCode = 2) {
  return { ok: false, error: { code, message }, exitCode };
}

function bridgesOk(value) {
  return { ok: true, ...value };
}

function parseBridgeArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const resource = args[0];
  const action = args[1];

  if (resource !== "agent" || action !== "report") {
    return bridgesError("INVALID_USAGE", "Usage: cortex-agent agent report --event-type <type> --task-id <id> [options]");
  }

  const eventType = option(args, "event-type");
  const taskId = option(args, "task-id");
  const actorId = option(args, "actor-id");
  const kind = option(args, "kind");
  const sessionId = option(args, "session-id");
  const projectId = option(args, "project-id");
  const message = option(args, "message");
  const correlationId = option(args, "correlation-id");
  const notificationPolicy = option(args, "notification-policy");
  const eventJson = option(args, "event-json");

  if (!eventType || !taskId) {
    return bridgesError("INVALID_USAGE", "--event-type and --task-id are required.");
  }

  if (!AGENT_SCOPED_EVENT_TYPES.includes(eventType)) {
    return bridgesError(
      "EVENT_TYPE_NOT_AGENT_SCOPED",
      `Event type must be one of: ${AGENT_SCOPED_EVENT_TYPES.join(", ")}. Received: ${eventType}`,
    );
  }

  // Parse event-json if provided (for full event envelope).
  let parsedEvent = null;
  if (eventJson) {
    try {
      parsedEvent = JSON.parse(eventJson);
      if (!parsedEvent || typeof parsedEvent !== "object" || Array.isArray(parsedEvent)) {
        return bridgesError("INVALID_EVENT_JSON", "--event-json must contain a valid JSON object.");
      }
    } catch (error) {
      return bridgesError("INVALID_EVENT_JSON", `--event-json must contain valid JSON: ${error.message}`);
    }
  }

  const reportInput = {
    taskId,
    eventType,
    ...(parsedEvent || {}),
  };

  if (message) reportInput.message = message;
  if (correlationId) reportInput.correlationId = correlationId;
  if (notificationPolicy) reportInput.notificationPolicy = notificationPolicy;

  return bridgesOk({
    eventType,
    taskId,
    actorId: actorId || "bridge-agent",
    kind: kind || "agent",
    sessionId: sessionId || "bridge-session",
    projectId: projectId || "default",
    reportInput,
  });
}

function executeBridgeCommand(argv, dependencies = {}) {
  const parsed = parseBridgeArgs(argv);
  if (!parsed.ok) return parsed;

  const service = dependencies.service;
  if (!service) {
    return bridgesError("SERVICE_UNAVAILABLE", "Coordination Application Service is not configured.", 3);
  }

  try {
    const reporter = createAgentReporter(service, {
      actorId: parsed.actorId,
      kind: parsed.kind,
      sessionId: parsed.sessionId,
      projectId: parsed.projectId,
    });

    const result = reporter.report(parsed.eventType, {
      ...parsed.reportInput,
      taskId: parsed.taskId,
    });

    return {
      ok: result.ok,
      command: "agent.report",
      eventType: parsed.eventType,
      taskId: parsed.taskId,
      ...(result.ok
        ? { event: result.event, task: result.task, appended: result.appended }
        : { error: { code: result.code, message: result.message } }),
    };
  } catch (error) {
    return bridgesError("BRIDGE_FAILED", error && error.message ? error.message : "Host Event Bridge execution failed.", 3);
  }
}

module.exports = {
  HOST_EVENT_BRIDGE_SCHEMA_VERSION,
  option,
  parseBridgeArgs,
  executeBridgeCommand,
};