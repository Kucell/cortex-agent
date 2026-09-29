"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  createControlService,
} = require(path.join(ROOT, "lib", "control-service", "service.js"));

function readyRouting() {
  return {
    selection: {
      endpoint_ref: "runtime-endpoint:local:native:codex",
      host_ref: "host:local",
      runtime_ref: "runtime:native:codex",
      host_profile_ref: "H-codex",
    },
  };
}

test("blocked dispatch plan short-circuits routing and all mutation owners", async () => {
  const calls = [];
  const service = createControlService({
    resolvePlan() {
      calls.push("plan");
      return { would_proceed: false, errors: ["locked"] };
    },
    route() { calls.push("route"); return readyRouting(); },
    authorize() { calls.push("authorize"); return { authorized: true, authorization_ref: "decision:D-1" }; },
    dispatch() { calls.push("dispatch"); return {}; },
  });

  const result = await service.execute({ task_id: "T-1", idempotency_key: "K-1" });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "dispatch_plan_blocked");
  assert.deepEqual(calls, ["plan"]);
});

test("no runtime selection short-circuits authorization and dispatch", async () => {
  const calls = [];
  const service = createControlService({
    resolvePlan() { calls.push("plan"); return { would_proceed: true }; },
    route() { calls.push("route"); return { selection: null }; },
    authorize() { calls.push("authorize"); return { authorized: true, authorization_ref: "decision:D-1" }; },
    dispatch() { calls.push("dispatch"); return {}; },
  });

  const result = await service.execute({ task_id: "T-1", idempotency_key: "K-1" });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "no_runtime_selection");
  assert.deepEqual(calls, ["plan", "route"]);
});

test("authorization denial never reaches dispatcher", async () => {
  const calls = [];
  const service = createControlService({
    resolvePlan() { return { would_proceed: true }; },
    route() { return readyRouting(); },
    authorize(input) {
      calls.push(["authorize", input]);
      return { authorized: false, reason: "decision_open" };
    },
    dispatch() { calls.push(["dispatch"]); return {}; },
  });

  const result = await service.execute({
    task_id: "T-1",
    idempotency_key: "K-1",
    workflow_gate: "mission",
  });
  assert.equal(result.status, "awaiting_authorization");
  assert.equal(result.reason, "decision_open");
  assert.equal(result.authorization.authorized, false);
  assert.equal(calls.length, 1);
});

test("authorized execution requires an evidence reference", async () => {
  const service = createControlService({
    resolvePlan() { return { would_proceed: true }; },
    route() { return readyRouting(); },
    authorize() { return { authorized: true }; },
    dispatch() { throw new Error("must not dispatch"); },
  });

  await assert.rejects(
    () => service.execute({ task_id: "T-1", idempotency_key: "K-1" }),
    (error) => error.code === "ERR_CONTROL_AUTHORIZATION_REF_REQUIRED",
  );
});

test("authorized request delegates exactly once with selected endpoint and authorization ref", async () => {
  const dispatched = [];
  const service = createControlService({
    resolvePlan() { return { would_proceed: true, plan_id: "P-1" }; },
    route() { return readyRouting(); },
    authorize() {
      return {
        authorized: true,
        authorization_ref: "decision:D-1",
      };
    },
    dispatch(input) {
      dispatched.push(input);
      return { ok: true, run_ref: "run:R-1" };
    },
  });

  const result = await service.execute({
    task_id: "T-1",
    idempotency_key: "K-1",
    workflow_gate: "mission",
  });

  assert.equal(result.status, "dispatched");
  assert.equal(result.authorization.authorization_ref, "decision:D-1");
  assert.equal(result.dispatch_result.run_ref, "run:R-1");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].selection.endpoint_ref, "runtime-endpoint:local:native:codex");
  assert.equal(dispatched[0].authorization_ref, "decision:D-1");
  assert.equal(dispatched[0].idempotency_key, "K-1");
});

test("inspect is read/coordination-only and never calls authorization or dispatch", () => {
  let authorizeCalls = 0;
  let dispatchCalls = 0;
  const service = createControlService({
    resolvePlan() { return { would_proceed: true }; },
    route() { return readyRouting(); },
    authorize() { authorizeCalls += 1; return { authorized: true, authorization_ref: "D-1" }; },
    dispatch() { dispatchCalls += 1; return {}; },
  });

  const result = service.inspect({ task_id: "T-1" });
  assert.equal(result.status, "ready");
  assert.equal(result.authorization.checked, false);
  assert.equal(authorizeCalls, 0);
  assert.equal(dispatchCalls, 0);
});
