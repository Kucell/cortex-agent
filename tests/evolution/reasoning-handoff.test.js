"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  prepareReasoningHandoff, normalizeReasoningResponse,
} = require("../../lib/evolution/reasoning-handoff");

const NOW = "2026-10-16T04:00:00.000Z";
const AT = "2026-10-16T03:59:00.000Z";
const CAPABILITIES = [
  "runtime.discover", "runtime.health", "runtime.run.create",
  "runtime.run.status", "runtime.run.wait", "runtime.run.cancel",
];
function fixture() {
  return {
    expected_project_ref: "project:welding", expected_source_revision: "rev-001",
    now: NOW, host_observed_at: AT,
    budget: { max_output_tokens: 1000, timeout_ms: 10000 },
    bundle: {
      schema_version: "1", project_ref: "project:welding", source_revision: "rev-001",
      scope: "project", observations: [
        { kind: "test_result", evidence_ref: "test:one", observed_at: AT, redacted: true },
        { kind: "test_result", evidence_ref: "test:two", observed_at: AT, redacted: true },
      ],
    },
    candidate: {
      schema_version: "1", project_ref: "project:welding", source_revision: "rev-001",
      candidate_id: "EC-001", scope: "project", hypothesis: "Check a version mismatch",
      risk_tier: "medium", evidence_refs: ["test:one"],
    },
    endpoint: {
      schema_version: "1", endpoint_ref: "runtime-endpoint:fixture",
      host_ref: "host:fixture", runtime_ref: "runtime:fixture",
      location: "local", transport: "in-process", availability: "available",
      descriptor: {
        protocol: "cortex-runtime", protocol_version: "1.0",
        implementation: "test-fixture", capabilities: CAPABILITIES.slice(),
      },
      workspace_refs: [],
    },
  };
}
function response() {
  return {
    schema_version: "1", project_ref: "project:welding", source_revision: "rev-001",
    candidate_id: "EC-001", hypothesis: "Check the configured version first",
    risk_tier: "medium", evidence_refs: ["test:one"],
    proposed_checks: ["Inspect the current version"],
    limitations: ["A fixture observation does not prove the root cause"],
  };
}
const code = (expected) => (err) => err && err.code === expected;

for (const location of ["local", "remote"]) {
  test(location + " endpoint preparation remains a proposal without a Run", () => {
    const input = fixture();
    input.endpoint.location = location;
    input.endpoint.transport = location === "local" ? "in-process" : "http";
    const before = structuredClone(input);
    const result = prepareReasoningHandoff(input);
    assert.equal(result.status, "HANDOFF_PREPARED");
    assert.equal(result.run_ref, null);
    assert.equal(result.execution_authorized, false);
    assert.deepEqual(result.allowed_effects, []);
    assert.deepEqual(result.handoff.allowed_effects, []);
    assert.ok(result.handoff.required_capabilities.includes("runtime.run.cancel"));
    assert.equal(result.handoff.mode, "analysis_only");
    assert.deepEqual(input, before);
    assert.ok(Object.isFrozen(result.handoff));
  });
}
test("no Host produces a resumable DEFERRED receipt without a phantom Run", () => {
  const input = fixture(); input.endpoint = null;
  const result = prepareReasoningHandoff(input);
  assert.equal(result.status, "DEFERRED");
  assert.equal(result.handoff, null);
  assert.equal(result.run_ref, null);
  assert.equal(result.execution_authorized, false);
});
test("unknown and unavailable Host observations remain deferred", () => {
  for (const availability of ["unknown", "unavailable"]) {
    const input = fixture(); input.endpoint.availability = availability;
    assert.equal(prepareReasoningHandoff(input).status, "DEFERRED");
  }
});
test("missing cancellation capability cannot prepare a bounded handoff", () => {
  const input = fixture();
  input.endpoint.descriptor.capabilities = CAPABILITIES.filter((x) => x !== "runtime.run.cancel");
  assert.deepEqual(prepareReasoningHandoff(input).reason_codes, ["host_capability_missing"]);
});
test("incompatible RuntimePort protocol does not become prepared", () => {
  const input = fixture(); input.endpoint.descriptor.protocol_version = "2.0";
  assert.deepEqual(prepareReasoningHandoff(input).reason_codes, ["host_protocol_incompatible"]);
});
test("stale or future Host observation cannot borrow freshness from evidence", () => {
  for (const at of ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]) {
    const input = fixture(); input.host_observed_at = at;
    assert.deepEqual(prepareReasoningHandoff(input).reason_codes, ["host_observation_stale"]);
  }
});
test("stale or future evidence is rejected before any handoff", () => {
  for (const at of ["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]) {
    const input = fixture(); input.bundle.observations[0].observed_at = at;
    assert.throws(() => prepareReasoningHandoff(input), code("ERR_REASONING_STALE_EVIDENCE"));
  }
});
test("expected project and current source revision are exact, not model assertions", () => {
  const input = fixture(); input.expected_source_revision = "rev-002";
  assert.throws(() => prepareReasoningHandoff(input), code("ERR_REASONING_CURRENT_SCOPE_MISMATCH"));
  input.expected_source_revision = "rev-001"; input.expected_project_ref = "project:other";
  assert.throws(() => prepareReasoningHandoff(input), code("ERR_REASONING_CURRENT_SCOPE_MISMATCH"));
});
test("framework promotion is not authorized by a consent reference", () => {
  const input = fixture();
  input.bundle.scope = input.candidate.scope = "framework_candidate";
  input.bundle.promotion_consent = {
    consent_ref: "decision:D-001", purpose: "generic_summary", source_revision: "rev-001",
  };
  assert.throws(() => prepareReasoningHandoff(input),
    code("ERR_REASONING_PROMOTION_REQUIRES_SEPARATE_WORKFLOW"));
  assert.throws(() => normalizeReasoningResponse(response(), input),
    code("ERR_REASONING_PROMOTION_REQUIRES_SEPARATE_WORKFLOW"));
});
test("runaway budgets and unredacted evidence fail closed", () => {
  const input = fixture(); input.budget.max_output_tokens = 999999;
  assert.throws(() => prepareReasoningHandoff(input), code("ERR_EVOLUTION_BUDGET"));
  const raw = fixture(); raw.bundle.observations[0].redacted = false;
  assert.throws(() => prepareReasoningHandoff(raw), code("ERR_EVOLUTION_UNREDACTED"));
});
test("model output cannot supply permissions, consent, or completed-run claims", () => {
  for (const field of ["execution_authorized", "allowed_effects", "promotion_consent", "run_ref", "verification_status"]) {
    assert.throws(() => normalizeReasoningResponse({ ...response(), [field]: true }, fixture()),
      code("ERR_REASONING_RESPONSE_FIELD"));
  }
});
test("model output cannot change scope or lower the original risk", () => {
  assert.throws(() => normalizeReasoningResponse({ ...response(), project_ref: "project:other" }, fixture()),
    code("ERR_REASONING_RESPONSE_SCOPE"));
  const context = fixture(); context.candidate.risk_tier = "high";
  assert.throws(() => normalizeReasoningResponse(response(), context),
    code("ERR_REASONING_RESPONSE_RISK_DOWNGRADE"));
});
test("response evidence stays inside this candidate, not merely inside the project bundle", () => {
  assert.throws(() => normalizeReasoningResponse({ ...response(), evidence_refs: ["test:two"] }, fixture()),
    code("ERR_REASONING_RESPONSE_EVIDENCE_SCOPE"));
});
test("valid response is immutable proposal text and does not execute proposed checks", () => {
  const input = response(), before = structuredClone(input);
  const result = normalizeReasoningResponse(input, fixture());
  assert.equal(result.status, "PROPOSAL_ONLY");
  assert.equal(result.execution_authorized, false);
  assert.deepEqual(result.allowed_effects, []);
  assert.ok(Object.isFrozen(result.proposed_checks));
  assert.deepEqual(input, before);
  assert.throws(() => normalizeReasoningResponse({ ...input, limitations: [] }, fixture()),
    code("ERR_REASONING_RESPONSE_LIMITATIONS"));
});
