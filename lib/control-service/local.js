"use strict";

const { resolveDispatchPlan } = require("../dispatch/plan.js");
const { routeRuntimeEndpoints } = require("../runtime-port/capability-router.js");
const { createControlService } = require("./service.js");

function createLocalControlService(options = {}) {
  if (typeof options.authorize !== "function") {
    const error = new Error("createLocalControlService requires an authorize owner");
    error.code = "ERR_CONTROL_AUTHORIZE_OWNER_REQUIRED";
    throw error;
  }
  if (typeof options.dispatch !== "function") {
    const error = new Error("createLocalControlService requires a dispatch owner");
    error.code = "ERR_CONTROL_DISPATCH_OWNER_REQUIRED";
    throw error;
  }

  const clock = typeof options.clock === "function"
    ? options.clock
    : () => new Date().toISOString();

  return createControlService({
    resolvePlan(request) {
      return resolveDispatchPlan(
        request.project_root || process.cwd(),
        request.task_id,
        { now: request.now || clock() },
      );
    },

    route(request) {
      return routeRuntimeEndpoints({
        runtime_requirement: request.runtime_requirement,
        endpoints: request.endpoints || [],
        host_requirement: request.host_requirement,
        bindings: request.bindings || [],
      }, {
        now: request.now || clock(),
      });
    },

    authorize: options.authorize,
    dispatch: options.dispatch,
  });
}

module.exports = {
  createLocalControlService,
};
