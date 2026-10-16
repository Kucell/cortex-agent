"use strict";

// Wiring tests use fake sink and fake process adapter. No files or children.
const test = require("node:test");
const assert = require("node:assert/strict");

function loadWiring(t, behavior = {}) {
  const sinkPath = require.resolve("../../lib/runtime-state/strict-fixture-sink");
  const processPath = require.resolve("../../lib/runtime-port/strict-fixture-process");
  const wiringPath = require.resolve("../../lib/runtime-port/strict-fixture");
  require(sinkPath); require(processPath);
  const originalSink = require.cache[sinkPath].exports;
  const originalProcess = require.cache[processPath].exports;
  const oldWiring = require.cache[wiringPath];
  const calls = [], records = [];
  const sink = {
    limits: { maxTaskMs: 1000, maxTotalMs: 5000 },
    onStart() {}, beforeSpawn() {}, onProposal() {}, onStop() {},
    inspect: () => ({ quarantined: false, revoked: false, runs: records }),
    cancel(ref) { calls.push(["sink.cancel", ref]); if (behavior.cancelFails) { const e = new Error(); e.code = "ERR_TEST_CANCEL"; throw e; } },
    revoke() { calls.push(["sink.revoke"]); if (behavior.revokeFails) { const e = new Error(); e.code = "ERR_TEST_REVOKE"; throw e; } return { revoked: true }; },
    close() { calls.push(["sink.close"]); },
  };
  const descriptor = { protocol: "cortex-runtime", protocol_version: "1.0", implementation: "mock",
    capabilities: ["runtime.discover", "runtime.health", "runtime.run.create", "runtime.run.status", "runtime.run.wait", "runtime.run.cancel"] };
  const port = {
    descriptor, discoverRuntime: () => ({ fixture_only: true }), health: () => ({ ready: true }),
    createRun(input) { calls.push(["process.create", input.task_id]); records.push({ run_ref: "run:mock", task_id: input.task_id, status: "running" }); return { run_ref: "run:mock" }; },
    getStatus: () => ({ status: "running" }), wait: async () => ({ status: "UNKNOWN" }),
    cancel(ref) { calls.push(["process.cancel", ref]); return { run_ref: ref, status: "stopping" }; },
  };
  require.cache[sinkPath].exports = { openStrictFixtureSink(options) { calls.push(["sink.open", options]); return sink; } };
  require.cache[processPath].exports = { createStrictFixtureProcessRuntime(options) {
    calls.push(["process.open", options]);
    return { port, close: async () => { calls.push(["process.close"]); return {
      all_workers_exited: behavior.unknown !== true, process_tree_verified: false, quarantined: behavior.unknown === true }; } };
  } };
  delete require.cache[wiringPath];
  const module_ = require(wiringPath);
  t.after(() => {
    require.cache[sinkPath].exports = originalSink;
    require.cache[processPath].exports = originalProcess;
    delete require.cache[wiringPath];
    if (oldWiring) require.cache[wiringPath] = oldWiring;
  });
  return { ...module_, calls, records, sink };
}
test("default wiring does not open a canonical sink", async (t) => {
  const f = loadWiring(t), runtime = f.createStrictFixtureRuntime();
  assert.equal(f.calls.some(([name]) => name === "sink.open"), false);
  assert.deepEqual(f.calls, [["process.open", undefined]]);
  await runtime.close();
});
test("enabled wiring captures only instance-owned sink callbacks and limits", (t) => {
  const f = loadWiring(t);
  f.createStrictFixtureRuntime({ enabled: true, fixtureOnly: true, projectRoot: "/synthetic/mock", cancelGraceMs: 123 });
  const config = f.calls.find(([name]) => name === "process.open")[1];
  assert.equal(config.onStart, f.sink.onStart);
  assert.equal(config.onBeforeSpawn, f.sink.beforeSpawn);
  assert.equal(config.onBeforeSend, f.sink.beforeSpawn);
  assert.equal(config.onProposal, f.sink.onProposal);
  assert.equal(config.onStop, f.sink.onStop);
  assert.equal(config.maxTaskMs, 1000); assert.equal(config.maxTotalMs, 5000);
});
test("cancel closes durable sink admission before process cancellation", (t) => {
  const f = loadWiring(t), runtime = f.createStrictFixtureRuntime({ enabled: true, fixtureOnly: true, projectRoot: "/synthetic/mock" });
  runtime.port.createRun({ task_id: "T-FIXTURE-1" }); f.calls.length = 0;
  runtime.port.cancel("run:mock");
  assert.deepEqual(f.calls, [["sink.cancel", "run:mock"], ["process.cancel", "run:mock"]]);
});
test("failed durable cancellation still stops process and prevents new runs", (t) => {
  const f = loadWiring(t, { cancelFails: true }), runtime = f.createStrictFixtureRuntime({ enabled: true, fixtureOnly: true, projectRoot: "/synthetic/mock" });
  runtime.port.createRun({ task_id: "T-FIXTURE-1" });
  assert.equal(runtime.port.cancel("run:mock").quarantined, true);
  assert.equal(f.calls.at(-1)[0], "process.cancel");
  assert.throws(() => runtime.port.createRun({ task_id: "T-FIXTURE-2" }), { code: "ERR_FIXTURE_STOPPED" });
});
test("failed revoke still requests stop, reports failure and denies new runs", (t) => {
  const f = loadWiring(t, { revokeFails: true }), runtime = f.createStrictFixtureRuntime({ enabled: true, fixtureOnly: true, projectRoot: "/synthetic/mock" });
  runtime.port.createRun({ task_id: "T-FIXTURE-1" });
  assert.throws(runtime.revoke, { code: "ERR_TEST_REVOKE" });
  assert.equal(f.calls.at(-1)[0], "process.cancel");
  assert.equal(runtime.port.health().ready, false);
});
test("UNKNOWN close keeps sink lock for review and never asserts tree exit", async (t) => {
  const f = loadWiring(t, { unknown: true }), runtime = f.createStrictFixtureRuntime({ enabled: true, fixtureOnly: true, projectRoot: "/synthetic/mock" });
  runtime.port.createRun({ task_id: "T-FIXTURE-1" });
  const result = await runtime.close();
  assert.equal(result.recovery_required, true);
  assert.equal(result.process_tree_verified, false);
  assert.equal(f.calls.some(([name]) => name === "sink.close"), false);
});
test("clean cooperative worker stop releases the sink only after process close", async (t) => {
  const f = loadWiring(t), runtime = f.createStrictFixtureRuntime({ enabled: true, fixtureOnly: true, projectRoot: "/synthetic/mock" });
  runtime.port.createRun({ task_id: "T-FIXTURE-1" }); f.calls.length = 0;
  const first = runtime.close(), second = runtime.close();
  assert.equal(first, second);
  assert.equal((await first).recovery_required, false);
  assert.deepEqual(f.calls.map(([name]) => name), ["sink.cancel", "process.cancel", "process.close", "sink.close"]);
});
