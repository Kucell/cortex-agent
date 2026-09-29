"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const { createCortexClient } = require(path.join(ROOT, "packages", "sdk", "src", "index.js"));

test("SDK maps canonical methods to existing Management projections", async () => {
  const calls = [];
  const client = createCortexClient({
    transport: {
      async query(projection, filters = {}) {
        calls.push({ projection, filters });
        return { projection, filters };
      },
      async getTopology() {
        return { self: { project_id: "cortex-agent" }, peers: [] };
      },
    },
  });

  await client.tasks.get("T-1");
  await client.runs.list();
  await client.runs.get("R-1");
  await client.decisions.list();
  await client.waitpoints.list();
  await client.coordination.tasks.get("T-2");
  const topology = await client.topology.get();

  assert.deepEqual(calls, [
    { projection: "task-state", filters: { task: "T-1" } },
    { projection: "runs", filters: {} },
    { projection: "run-state", filters: { run: "R-1" } },
    { projection: "decisions", filters: {} },
    { projection: "waitpoints", filters: {} },
    { projection: "coordination-tasks", filters: { task: "T-2" } },
  ]);
  assert.equal(topology.self.project_id, "cortex-agent");
});

test("SDK fails closed without a query transport", () => {
  assert.throws(() => createCortexClient(), (error) => error.code === "ERR_SDK_TRANSPORT_REQUIRED");
});

test("SDK supports synchronous local transports without forcing async CLI conversion", () => {
  const client = createCortexClient({
    transport: {
      query(projection, filters = {}) {
        return { projection, filters };
      },
    },
  });
  const result = client.tasks.get("T-SYNC");
  assert.equal(typeof result.then, "undefined");
  assert.deepEqual(result, { projection: "task-state", filters: { task: "T-SYNC" } });
});

test("management namespace exposes raw projection compatibility through the SDK", () => {
  const calls = [];
  const client = createCortexClient({
    transport: {
      query(projection, filters = {}) {
        calls.push({ projection, filters });
        return { ok: true, projection };
      },
    },
  });
  assert.equal(client.management.capabilities().projection, "capabilities");
  assert.equal(client.management.query("runs").projection, "runs");
  assert.deepEqual(calls, [
    { projection: "capabilities", filters: {} },
    { projection: "runs", filters: {} },
  ]);
});

test("SDK capability negotiation uses the local descriptor and fails closed on missing requirements", () => {
  const client = createCortexClient({
    transport: {
      query() { return {}; },
      discoverCapabilities() {
        return {
          protocol: "cortex",
          protocol_version: "1.2",
          implementation: "local-test",
          capabilities: ["runs.read", "tasks.read"],
        };
      },
    },
  });

  const negotiated = client.capabilities.negotiate({
    protocol: "cortex",
    protocol_version: "1.1",
    implementation: "remote-test",
    capabilities: ["runs.read", "decisions.read"],
  }, {
    required_capabilities: ["runs.read"],
  });

  assert.equal(negotiated.negotiated_version, "1.1");
  assert.deepEqual(negotiated.capabilities, ["runs.read"]);

  assert.throws(
    () => client.capabilities.negotiate({
      protocol: "cortex",
      protocol_version: "1.1",
      implementation: "remote-test",
      capabilities: ["decisions.read"],
    }, {
      required_capabilities: ["runs.read"],
    }),
    (error) => error.code === "ERR_REQUIRED_CAPABILITY_MISSING",
  );
});
