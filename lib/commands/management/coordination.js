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

function coordination(ctx, dependencies = {}) {
  const projectRoot = path.resolve(ctx.cwd, (ctx.options && ctx.options.project) || ".");
  let service = dependencies.service;
  let ownedService = false;
  const action = ctx.args[1];
  const isWrite = (ctx.args[0] === "task"
    && !new Set(["status", "list", "watch"]).has(action))
    || (ctx.args[0] === "event" && action === "ack");
  if (!service && isWrite) {
    try {
      const { CoordinationApplicationService } = require("../../coordination/application-service");
      const {
        loadAuthorizationPolicy,
      } = require("../../coordination/authorization-policy");
      const runtimeRoot = path.join(projectRoot, ".agent-runtime");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const runtimeIgnore = path.join(runtimeRoot, ".gitignore");
      if (!fs.existsSync(runtimeIgnore)) {
        fs.writeFileSync(runtimeIgnore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
      }
      service = CoordinationApplicationService.open(
        path.join(runtimeRoot, "coordination"),
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
          path.join(projectRoot, ".agent-runtime", "coordination", "consumers"),
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
  } finally {
    if (ownedService && service && typeof service.close === "function") service.close();
  }
}

module.exports = {
  coordination,
};
