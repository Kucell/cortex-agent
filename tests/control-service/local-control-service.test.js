"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  createLocalControlService,
} = require(path.join(ROOT, "lib", "control-service", "local.js"));

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m040-control-"));
  for (const sub of ["runs", "queues", "sessions", "decisions", "waitpoints", "locks"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function endpoint() {
  return {
    endpoint_ref: "runtime-endpoint:local:native:codex",
    host_ref: "host:local",
    runtime_ref: "runtime:native:codex",
    location: "local",
    transport: "stdio",
    availability: "available",
    descriptor: {
      protocol: "cortex-runtime",
      protocol_version: "1.0",
      implementation: "native-adapter:codex",
      capabilities: ["runtime.run.create"],
    },
    workspace_refs: [],
  };
}

function hostRequirement(now) {
  return {
    schema_version: "1.0",
    requirement_id: "HOST-CONTROL-1",
    task_id: "T-CONTROL",
    created_at: now,
    required_capabilities: ["session.boundary", "tool.before.block"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: {
      approved_decision_id: null,
      require_active_lease: false,
    },
    preferred: {},
    ttl_at: new Date(new Date(now).getTime() + 60_000).toISOString(),
  };
}

function snapshot(now) {
  return {
    schema_version: "1.0",
    snapshot_id: "SNAP-CONTROL",
    host_profile_ref: "H-codex",
    taken_at: now,
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
    },
    governance: { approved: true, decision_id: null },
    lease: { active: true, holder: "owner" },
    reliability: { value: 1, source: "explicit-workflow", quality: "high" },
    cost: { value: 0, source: "explicit-workflow", quality: "high" },
    latency: { value: 1, source: "explicit-workflow", quality: "high" },
  };
}

test("local Control Service composes existing dispatch plan and runtime router without owning state", async () => {
  const root = mkProject();
  const now = "2026-09-29T04:30:00.000Z";
  let dispatchCalls = 0;
  try {
    const service = createLocalControlService({
      clock: () => now,
      authorize() {
        return { authorized: false, reason: "approval_required" };
      },
      dispatch() {
        dispatchCalls += 1;
        return { ok: true };
      },
    });

    const result = await service.execute({
      project_root: root,
      task_id: "T-CONTROL",
      idempotency_key: "T-CONTROL:1",
      now,
      runtime_requirement: {
        requirement_id: "RUNTIME-CONTROL-1",
        required_capabilities: ["runtime.run.create"],
      },
      endpoints: [endpoint()],
      host_requirement: hostRequirement(now),
      bindings: [{
        endpoint_ref: "runtime-endpoint:local:native:codex",
        snapshot: snapshot(now),
      }],
    });

    assert.equal(result.status, "awaiting_authorization");
    assert.equal(result.selection.endpoint_ref, "runtime-endpoint:local:native:codex");
    assert.equal(result.plan.mutation_evidence.mutated_count, 0);
    assert.equal(dispatchCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
