"use strict";

// Explicit opt-in wiring for the cooperative synthetic fixture only.
// It is not installed as a CLI, default RuntimePort, or AI Host.
// Synthetic records are test input, never proof of user permission to run it.
// A trusted upper workflow must still bind any separately approved invocation
// to its exact root/project UUID/job/run/code SHA/deadline. This module does
// not implement that one-shot admission gate; enabled is not authorization.
const { createRuntimePort } = require("../../packages/runtime-port/src/index.js");
const { createStrictFixtureProcessRuntime } = require("./strict-fixture-process");
const { openStrictFixtureSink } = require("../runtime-state/strict-fixture-sink");

function fail(code) { const e = new Error(code); e.code = code; throw e; }
function createStrictFixtureRuntime(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["enabled", "fixtureOnly", "projectRoot", "cancelGraceMs"].includes(key))) fail("ERR_FIXTURE_OPTIONS");
  if (options.enabled !== true) return createStrictFixtureProcessRuntime();
  if (options.fixtureOnly !== true) fail("ERR_FIXTURE_ONLY");
  const sink = openStrictFixtureSink({ enabled: true, fixtureOnly: true, projectRoot: options.projectRoot });
  let runtime;
  try {
    runtime = createStrictFixtureProcessRuntime({ enabled: true, fixtureOnly: true, cwd: options.projectRoot,
      ...sink.limits, cancelGraceMs: options.cancelGraceMs,
      onStart: sink.onStart, onBeforeSpawn: sink.beforeSpawn, onProposal: sink.onProposal, onStop: sink.onStop });
  } catch (error) { sink.close(); throw error; }
  let stopped = false, closing = null;
  function cancel(ref) {
    let failure;
    try { sink.cancel(ref); } catch (error) { failure = error; stopped = true; }
    // Even failed durable cancellation must immediately close the process gate.
    const result = runtime.port.cancel(ref);
    if (failure) return Object.freeze({ ...result, sink_error: failure.code || "ERR_FIXTURE_SINK", quarantined: true });
    return result;
  }
  function stopAll() {
    for (const run of sink.inspect().runs) {
      if (run.status === "running") cancel(run.run_ref);
    }
  }
  function revoke() {
    stopped = true;
    let result, failure;
    try { result = sink.revoke(); } catch (error) { failure = error; }
    finally { stopAll(); }
    if (failure) throw failure;
    return Object.freeze({ ...result, process_stop_requested: true });
  }
  function close() {
    if (closing) return closing;
    stopped = true;
    stopAll();
    closing = runtime.close().then((result) => {
      if (!result.all_workers_exited || result.quarantined) {
        // Keep the lifetime lock and evidence for explicit recovery review.
        return Object.freeze({ ...result, recovery_required: true });
      }
      try { sink.close(); }
      catch (error) { return Object.freeze({ ...result, recovery_required: true, sink_error: error.code || "ERR_FIXTURE_SINK" }); }
      return Object.freeze({ ...result, recovery_required: false });
    });
    return closing;
  }
  const port = createRuntimePort({ descriptor: runtime.port.descriptor, operations: {
    discoverRuntime: runtime.port.discoverRuntime,
    health: () => Object.freeze({ ...runtime.port.health(), ready: !stopped && !sink.inspect().quarantined && !sink.inspect().revoked && runtime.port.health().ready }),
    createRun: (input) => { if (stopped) fail("ERR_FIXTURE_STOPPED"); return runtime.port.createRun(input); },
    getStatus: runtime.port.getStatus, wait: runtime.port.wait, cancel,
  } });
  return Object.freeze({ port, revoke, inspect: sink.inspect, close });
}
module.exports = { createStrictFixtureRuntime };
