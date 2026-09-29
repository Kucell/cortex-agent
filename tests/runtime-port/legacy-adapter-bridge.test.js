"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  createLegacyAdapterRuntimePort,
} = require(path.join(ROOT, "lib", "runtime-port", "legacy-adapter-bridge.js"));

function fakeAdapter() {
  const calls = [];
  let reportCount = 0;
  return {
    calls,
    discover() {
      return {
        adapter_type: "fake",
        version: "0.1.0",
        capabilities: ["text_generation"],
      };
    },
    async health() {
      calls.push(["health"]);
      return { status: "ok", ready: true };
    },
    async invoke(payload, options) {
      calls.push(["invoke", payload, options]);
      return {
        runId: "R-FAKE-1",
        status: "ok",
        result: { answer: 42 },
        error: null,
        latency_ms: 7,
      };
    },
    async cancel(runId, options) {
      calls.push(["cancel", runId, options]);
      return { runId, cancelled: true, error: null };
    },
    async report(runId, options) {
      calls.push(["report", runId, options]);
      reportCount += 1;
      if (reportCount < 2) {
        return { runId, status: "not_found", result: null, error: null };
      }
      return { runId, status: "ok", result: { answer: 42 }, error: null };
    },
  };
}

test("legacy adapter bridge declares only capabilities it can actually provide", () => {
  const port = createLegacyAdapterRuntimePort(fakeAdapter());
  assert.equal(port.descriptor.implementation, "native-adapter:fake");
  assert.ok(port.descriptor.capabilities.includes("runtime.run.create"));
  assert.ok(port.descriptor.capabilities.includes("runtime.run.wait"));
  assert.equal(port.descriptor.capabilities.includes("runtime.run.send"), false);
  assert.equal(port.descriptor.capabilities.includes("runtime.timeline.read"), false);
  assert.equal(port.descriptor.capabilities.includes("runtime.run.archive"), false);
});

test("legacy invoke maps to createRun and preserves a canonical RunRef", async () => {
  const adapter = fakeAdapter();
  const port = createLegacyAdapterRuntimePort(adapter);
  const result = await port.createRun({ task: "test" }, { projectRoot: "/tmp/project" });
  assert.equal(result.run_ref, "run:R-FAKE-1");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.result, { answer: 42 });
  assert.equal(adapter.calls[0][0], "invoke");
});

test("legacy cancel and status delegate without inventing vendor state", async () => {
  const adapter = fakeAdapter();
  const port = createLegacyAdapterRuntimePort(adapter);
  const cancel = await port.cancel("run:R-FAKE-1", { reason: "test" });
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.run_ref, "run:R-FAKE-1");

  const status = await port.getStatus("run:R-FAKE-1");
  assert.equal(status.status, "pending");
  assert.equal(status.run_ref, "run:R-FAKE-1");
});

test("legacy wait polls report until terminal state", async () => {
  const adapter = fakeAdapter();
  const port = createLegacyAdapterRuntimePort(adapter);
  const result = await port.wait("run:R-FAKE-1", { timeout_ms: 100, interval_ms: 1 });
  assert.equal(result.status, "completed");
  assert.equal(result.result.answer, 42);
  assert.equal(result.evidence.result_present, true);
});

test("legacy bridge fails closed for unsupported send/timeline/archive", () => {
  const port = createLegacyAdapterRuntimePort(fakeAdapter());
  for (const call of [
    () => port.send("run:R-1", { message: "x" }),
    () => port.getTimeline("run:R-1"),
    () => port.archive("run:R-1"),
  ]) {
    assert.throws(call, (error) => error.code === "ERR_RUNTIME_CAPABILITY_UNSUPPORTED");
  }
});

test("legacy bridge does not expose a second raw run id beside canonical run_ref", async () => {
  const port = createLegacyAdapterRuntimePort(fakeAdapter());
  const created = await port.createRun({ task: "test" });
  assert.equal(Object.prototype.hasOwnProperty.call(created, "run_id"), false);
  const status = await port.getStatus(created.run_ref);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "run_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "report"), false);
});

test("observer-only legacy adapters do not gain invoke/cancel capabilities from method presence", () => {
  const adapter = fakeAdapter();
  const originalDiscover = adapter.discover;
  adapter.discover = () => ({
    ...originalDiscover(),
    observer: true,
    invoke_supported: false,
    cancel_supported: false,
  });

  const port = createLegacyAdapterRuntimePort(adapter);
  assert.equal(port.descriptor.capabilities.includes("runtime.run.create"), false);
  assert.equal(port.descriptor.capabilities.includes("runtime.run.cancel"), false);
  assert.throws(
    () => port.createRun({ task: "forbidden" }),
    (error) => error.code === "ERR_RUNTIME_CAPABILITY_UNSUPPORTED",
  );
  assert.throws(
    () => port.cancel("run:R-1"),
    (error) => error.code === "ERR_RUNTIME_CAPABILITY_UNSUPPORTED",
  );
});
