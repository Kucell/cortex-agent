"use strict";

class ControlServiceError extends Error {
  constructor(code, details = {}) {
    super(`[control-service:${code}] ${JSON.stringify(details)}`);
    this.name = "ControlServiceError";
    this.code = code;
    this.details = details;
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new ControlServiceError("ERR_CONTROL_DEPENDENCY_REQUIRED", { dependency: name });
  }
  return value;
}

function validateRequest(input, { execution = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ControlServiceError("ERR_CONTROL_REQUEST_INVALID", {});
  }
  if (typeof input.task_id !== "string" || !input.task_id.trim()) {
    throw new ControlServiceError("ERR_CONTROL_TASK_REQUIRED", {});
  }
  if (execution && (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim())) {
    throw new ControlServiceError("ERR_CONTROL_IDEMPOTENCY_REQUIRED", {});
  }
  return input;
}

function createControlService(dependencies = {}) {
  const resolvePlan = requireFunction(dependencies.resolvePlan, "resolvePlan");
  const route = requireFunction(dependencies.route, "route");
  const authorize = requireFunction(dependencies.authorize, "authorize");
  const dispatch = requireFunction(dependencies.dispatch, "dispatch");

  function inspect(input) {
    const request = validateRequest(input);
    const plan = resolvePlan(request);

    if (!plan || plan.would_proceed !== true) {
      return Object.freeze({
        status: "blocked",
        reason: "dispatch_plan_blocked",
        task_id: request.task_id,
        plan: plan || null,
        routing: null,
        selection: null,
        authorization: Object.freeze({ authorized: false, checked: false }),
      });
    }

    const routing = route(request);
    if (!routing || !routing.selection) {
      return Object.freeze({
        status: "blocked",
        reason: "no_runtime_selection",
        task_id: request.task_id,
        plan,
        routing: routing || null,
        selection: null,
        authorization: Object.freeze({ authorized: false, checked: false }),
      });
    }

    return Object.freeze({
      status: "ready",
      reason: null,
      task_id: request.task_id,
      plan,
      routing,
      selection: routing.selection,
      authorization: Object.freeze({ authorized: false, checked: false }),
    });
  }

  async function execute(input) {
    const request = validateRequest(input, { execution: true });
    const inspection = inspect(request);
    if (inspection.status !== "ready") return inspection;

    const auth = await authorize(Object.freeze({
      task_id: request.task_id,
      idempotency_key: request.idempotency_key,
      selection: inspection.selection,
      plan: inspection.plan,
      workflow_gate: request.workflow_gate || null,
    }));

    if (!auth || auth.authorized !== true) {
      return Object.freeze({
        ...inspection,
        status: "awaiting_authorization",
        reason: auth && auth.reason ? auth.reason : "authorization_required",
        authorization: Object.freeze({
          authorized: false,
          checked: true,
          authorization_ref: null,
        }),
      });
    }

    if (typeof auth.authorization_ref !== "string" || !auth.authorization_ref.trim()) {
      throw new ControlServiceError("ERR_CONTROL_AUTHORIZATION_REF_REQUIRED", {
        task_id: request.task_id,
      });
    }

    const result = await dispatch(Object.freeze({
      task_id: request.task_id,
      idempotency_key: request.idempotency_key,
      selection: inspection.selection,
      authorization_ref: auth.authorization_ref,
      workflow_gate: request.workflow_gate || null,
      plan: inspection.plan,
    }));

    return Object.freeze({
      ...inspection,
      status: "dispatched",
      reason: null,
      authorization: Object.freeze({
        authorized: true,
        checked: true,
        authorization_ref: auth.authorization_ref,
      }),
      dispatch_result: result,
    });
  }

  return Object.freeze({ inspect, execute });
}

module.exports = {
  ControlServiceError,
  createControlService,
  validateRequest,
};
