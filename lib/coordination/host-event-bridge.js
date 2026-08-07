"use strict";

// ─── Generic Host Event Bridge (T-ACN-016) ───────────────────────────────────
//
// Bridges lifecycle events from a generic host to the Coordination Application
// Service. The bridge operates under a governed launch context — it reads the
// agent identity (actorId, taskId, projectId, sessionId) from the private
// CORTEX_LAUNCH_CONTEXT file. Without a valid context, the bridge fails closed.
//
// The bridge exposes a single restricted CLI surface:
//   cortex-agent agent report --event-type <type> [--message <text>]
//     [--evidence-ref <ref>] [--notification-policy <policy>]
//
// The CLI does NOT accept governance parameters (actor-id, project-id, task-id,
// kind, session-id, correlation-id, event-json). All unknown options are
// rejected. The action is restricted to agent-scoped lifecycle event types.
//
// Safety contract:
//   1. Only agent-scoped event types are accepted.
//   2. Governance fields are read from CORTEX_LAUNCH_CONTEXT, never from CLI.
//   3. Unknown CLI options are rejected (not silently dropped).
//   4. The bridge never writes to disk, spawns processes, or makes network
//      calls. All side effects are delegated to the Coordination Application
//      Service.
//   5. No automatic dispatch/daemon: the bridge is purely reactive.
//   6. Fail closed: no valid governed context = bridge error.
//   7. Raw JSON event envelopes (--event-json) are NEVER accepted.

const { createEvent, STATES } = require("./contract");
const { createAgentReporterFromContext, createAgentReporter, AGENT_SCOPED_EVENT_TYPES } = require("../agents/reporter");

const HOST_EVENT_BRIDGE_SCHEMA_VERSION = "1.0";

// ─── Restricted field allowlist ─────────────────────────────────────────────
//
// Only these fields may be forwarded from the CLI to the reporter.
// Governance fields (actor-id, project-id, task-id, kind, session-id,
// correlation-id) are read from CORTEX_LAUNCH_CONTEXT, NEVER from the CLI.
// --event-json is NOT supported.
// All unknown options are rejected.

const RESTRICTED_OPTIONS = new Set([
  "event-type",
  "action",
  "message",
  "evidence-ref",
  "notification-policy",
  "delivery-id",
]);

// ─── Bridge CLI ──────────────────────────────────────────────────────────────
//
// Parses the `cortex-agent agent report` CLI arguments and submits the report
// through the Coordination Application Service.
//
// CLI grammar:
//   cortex-agent agent report --event-type <type> [--message <text>]
//     [--evidence-ref <ref>] [--notification-policy <policy>]
//
// The actor identity is read from CORTEX_LAUNCH_CONTEXT, not from CLI args.
// All unknown options are rejected with INVALID_USAGE.

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

function findUnknownOptions(args) {
  const unknown = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    // Skip positional args (resource, action)
    if (arg === "agent" || arg === "report") continue;
    const name = arg.includes("=") ? arg.slice(2, arg.indexOf("=")) : arg.slice(2);
    if (name === "event-json") {
      return { rejected: true, name: "event-json" };
    }
    if (!RESTRICTED_OPTIONS.has(name)) {
      unknown.push(name);
    }
  }
  return { rejected: false, unknown };
}

function parseBridgeArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const resource = args[0];
  const action = args[1];

  if (resource !== "agent" || action !== "report") {
    return bridgesError("INVALID_USAGE", "Usage: cortex-agent agent report --event-type <type> [--message <text>] [options]");
  }

  // Reject --event-json before any parsing
  const unknownCheck = findUnknownOptions(args);
  if (unknownCheck.rejected) {
    return bridgesError(
      "EVENT_JSON_REJECTED",
      "--event-json is not supported. The bridge only accepts restricted, enumerated fields.",
    );
  }

  // Reject unknown options instead of silently ignoring them
  if (unknownCheck.unknown.length > 0) {
    return bridgesError(
      "UNKNOWN_OPTIONS_REJECTED",
      `Unknown options: ${unknownCheck.unknown.join(", ")}. The bridge only accepts: ${[...RESTRICTED_OPTIONS].join(", ")}`,
    );
  }

  const eventType = option(args, "event-type") || option(args, "action");
  const message = option(args, "message");
  const evidenceRef = option(args, "evidence-ref");
  const notificationPolicy = option(args, "notification-policy");
  const deliveryId = option(args, "delivery-id");

  if (!eventType) {
    return bridgesError("INVALID_USAGE", "--event-type or --action is required.");
  }

  if (!AGENT_SCOPED_EVENT_TYPES.includes(eventType)) {
    return bridgesError(
      "EVENT_TYPE_NOT_AGENT_SCOPED",
      `Event type must be one of: ${AGENT_SCOPED_EVENT_TYPES.join(", ")}. Received: ${eventType}`,
    );
  }

  // Build restricted report input — only enumerated fields, no arbitrary JSON
  const reportInput = {};

  if (message) reportInput.message = message;
  if (notificationPolicy) reportInput.notificationPolicy = notificationPolicy;
  if (evidenceRef) {
    reportInput.evidence = [{ kind: "artifact", ref: evidenceRef }];
  }
  if (deliveryId) reportInput.deliveryId = deliveryId;

  return bridgesOk({
    eventType,
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
    // Create reporter from governed launch context — fail closed if missing
    const reporter = createAgentReporterFromContext(service);

    const result = reporter.report(parsed.eventType, {
      ...parsed.reportInput,
    });

    return {
      ok: result.ok,
      command: "agent.report",
      eventType: parsed.eventType,
      taskId: reporter.contextTaskId,
      ...(result.ok
        ? { event: result.event, task: result.task, appended: result.appended, receipt: result.receipt }
        : { error: { code: result.code, message: result.message } }),
    };
  } catch (error) {
    const code = (error && error.code) || "BRIDGE_FAILED";
    const message = error && error.message ? error.message : "Host Event Bridge execution failed.";
    return bridgesError(code, message, 3);
  }
}

module.exports = {
  HOST_EVENT_BRIDGE_SCHEMA_VERSION,
  option,
  parseBridgeArgs,
  executeBridgeCommand,
};
