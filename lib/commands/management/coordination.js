"use strict";

// ─── coordination — `cortex-agent task …` / `cortex-agent event ack` CLI ──────
//
// Originally lived inline in lib/commands.js (lines 2001–2099). Extracted so
// the read/write service-injection and ack-handling logic can be unit-tested
// without bringing in the rest of the command surface.
//
// The body is a strict copy of the original; only the require paths change.
// `lib/coordination/{application-service,authorization-policy,consumer-cursor,
// notification-policy}` are loaded lazily inside the function body so that
// the lighter query path (the `!isWrite` branch) doesn't pay the cost.

const fs = require("node:fs");
const path = require("node:path");
const { queryManagementProject } = require("../../management/client.js");
const { executeCoordinationCommand } = require("../../coordination/cli");
const { printManagementPayload } = require("./api-helpers");
const { resolveRuntimePaths } = require("../../runtime-layout");

function isCoordinationWriteRequest(args) {
  if (!Array.isArray(args) || args.includes("--help") || args.includes("-h")) return false;
  const [resource, action] = args;
  return (resource === "task" && !new Set(["status", "list", "watch"]).has(action))
    || (resource === "event" && action === "ack");
}

function shouldAutoSyncCoordination(args, result) {
  return Boolean(result && result.ok && isCoordinationWriteRequest(args));
}

function coordinationUsage(resource) {
  if (resource === "event") {
    return "Usage: cortex-agent event <list|ack> [options]";
  }
  return "Usage: cortex-agent task <create|assign|accept|progress|heartbeat|test|ready|complete|block|request-input|cancel|takeover|status|list|watch> [options]";
}

// M-035 MS-001: Per-action contract for task create.
function taskCreateContract() {
  return [
    "Usage: cortex-agent task create --project <path> --event-json '<json>'",
    "",
    "Required:",
    "  --project <path>     Project root directory (default: cwd).",
    "  --event-json '<json>'  Coordination event JSON (task.created).",
    "",
    "Event schema (task.created):",
    "  {",
    "    \"eventId\": \"string\",",
    "    \"projectId\": \"string\",",
    "    \"taskId\": \"string\",",
    "    \"correlationId\": \"string\",",
    "    \"producer\": { \"actorId\": \"string\", \"kind\": \"coordinator|agent|system\" },",
    "    \"targets\": [],",
    "    \"eventType\": \"task.created\",",
    "    \"previousState\": null,",
    "    \"currentState\": \"CREATED\",",
    "    \"timestamp\": \"ISO-8601\",",
    "    \"repository\": { \"repositoryId\": \"string\" },",
    "    \"notification\": { \"policy\": \"journal_only|notify_parent\", \"dedupeKey\": \"string\" }",
    "  }",
    "",
    "Options:",
    "  --json               Output machine-readable JSON.",
    "",
    "Examples:",
    "  cortex-agent task create --project . --event-json '{\"eventId\":\"CE-1\",...}'",
  ].join("\n");
}

function coordination(ctx, dependencies = {}) {
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  let service = dependencies.service;
  let ownedService = false;
  const action = ctx.args[1];
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) {
    const result = { ok: true, command: `${ctx.args[0]}.help`, usage: coordinationUsage(ctx.args[0]) };
    if (action === "create") {
      const contract = taskCreateContract();
      result.action = action;
      result.contract = contract;
      result.usage = contract;
    }
    printManagementPayload(result);
    return result;
  }
  const isWrite = isCoordinationWriteRequest(ctx.args);
  if (!service && isWrite) {
    try {
      const { CoordinationApplicationService } = require("../../coordination/application-service");
      const {
        loadAuthorizationPolicy,
      } = require("../../coordination/authorization-policy");
      const paths = resolveRuntimePaths(projectRoot);
      // Task events and ownership leases must resolve to the same runtime
      // namespace during the legacy-layout compatibility window.  Writing
      // task state directly to `coordination.new` would split a task from
      // its lease when `.agent-runtime/coordination` already exists and the
      // new layout has not been activated.
      const { resolveWritePath } = require("../../runtime-layout");
      const coordinationRoot = resolveWritePath(
        paths.coordination.new,
        paths.coordination.legacy,
        projectRoot,
      ).path;
      fs.mkdirSync(coordinationRoot, { recursive: true });
      const runtimeIgnore = path.join(coordinationRoot, ".gitignore");
      if (!fs.existsSync(runtimeIgnore)) {
        fs.writeFileSync(runtimeIgnore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
      }
      service = CoordinationApplicationService.open(
        coordinationRoot,
        { authorization: loadAuthorizationPolicy(projectRoot) }
      );
      ownedService = true;
    } catch (_) {
      service = null;
    }
  }
  let acknowledgements = dependencies.acknowledgements;
  if (!acknowledgements && isWrite && ctx.args[0] === "event" && action === "ack") {
    const { ConsumerCursorStore } = require("../../coordination/consumer-cursor");
    const { deliveryKey } = require("../../coordination/notification-policy");
    acknowledgements = {
      ack({ eventId, consumerId }) {
        const event = service.listEvents().find((candidate) => candidate.eventId === eventId);
        if (!event) {
          const error = new Error("Event not found for ACK");
          error.key = "ERR_ACK_NOT_FOUND";
          throw error;
        }
        const target = (event.targets || []).find((candidate) =>
          candidate.actorId === consumerId) || (event.targets || [])[0];
        if (!target) {
          const error = new Error("Event has no acknowledgement target");
          error.key = "ERR_ACK_NOT_FOUND";
          throw error;
        }
        const cursor = new ConsumerCursorStore(
          path.join(resolveRuntimePaths(projectRoot).coordination.new, "consumers"),
          consumerId
        );
        const key = deliveryKey(eventId, consumerId, target);
        const update = cursor.acknowledge(key, { eventId, target });
        return { eventId, consumerId, deliveryKey: key, acknowledged: update.result };
      },
    };
  }
  if (!service && !isWrite) {
    const query = (projection, queryArgs = []) => {
      const result = queryManagementProject(ctx, projection, queryArgs);
      if (!result.ok) {
        const error = new Error(result.error.message);
        error.key = result.error.code;
        error.details = result.error.details;
        throw error;
      }
      return result.payload;
    };
    service = {
      getTask(taskId) {
        const payload = query("coordination-tasks", ["--task", taskId]);
        return Array.isArray(payload.tasks) ? payload.tasks[0] || null : null;
      },
      listTasks() {
        const payload = query("coordination-tasks");
        return Array.isArray(payload.tasks) ? payload.tasks : [];
      },
      listEvents(filter) {
        const queryArgs = [];
        if (filter.taskId) queryArgs.push("--task", filter.taskId);
        if (filter.eventType) queryArgs.push("--event-type", filter.eventType);
        if (filter.producerId) queryArgs.push("--producer", filter.producerId);
        const payload = query("coordination-events", queryArgs);
        return Array.isArray(payload.events) ? payload.events : [];
      },
    };
  }
  try {
    const result = executeCoordinationCommand(ctx.args, {
      service,
      acknowledgements,
    });
    printManagementPayload(result);
    if (!result.ok) process.exitCode = result.exitCode || 3;
    return result;
  } finally {
    if (ownedService && service && typeof service.close === "function") service.close();
  }
}

module.exports = {
  coordination,
  isCoordinationWriteRequest,
  shouldAutoSyncCoordination,
};
