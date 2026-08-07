"use strict";

// ─── Cross-host Handoff tests (MS-010 / P-004 / VC-010) ────────────────────
//
// VC-010-01: A host switch uses a redacted standard context package, fencing
// token, checkpoint, and a new Operation attempt.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildContextPackage,
  handoff,
  redactValue,
  isTainted,
  CrossHostHandoffError,
} = require("../../lib/runtime-adapters/cross-host-handoff.js");

const NOW = "2026-07-28T12:00:00.000Z";

function sourceFixture(overrides) {
  return Object.assign({
    operation_id: "OP-src-1",
    host_profile_ref: "H-Codex",
    task_id: "T-1",
    prompt: "SECRET-PROMPT-do-not-leak",
    tool_args: "rm -rf /tmp/everything",
    stdout: "lots of private stdout",
    boundary_events: [],
    context_trajectory: { stages: [{ type: "selected", items: [] }] },
  }, overrides || {});
}

function requirementFixture() {
  return {
    schema_version: "1.0",
    requirement_id: "REQ-1",
    task_id: "T-1",
    created_at: "2026-07-28T11:00:00.000Z",
    required_capabilities: ["session.boundary"],
    minimum_capability_levels: {},
    governance: { approved_decision_id: null, require_active_lease: false },
    preferred: {},
    ttl_at: "2026-07-28T13:00:00.000Z",
  };
}

function snapshotFixture(overrides) {
  return Object.assign({
    schema_version: "1.0",
    snapshot_id: "SNAP-A",
    host_profile_ref: "H-Pi",
    taken_at: "2026-07-28T11:55:00.000Z",
    capabilities: { "session.boundary": "native" },
    governance: { approved: true, decision_id: null },
    lease: { active: true, holder: "owner-A" },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  }, overrides || {});
}

test("VC-010-01 handoff emits a redacted context package, fencing token, checkpoint, and new operation attempt", () => {
  const ownerCalls = [];
  const owner = (req) => { ownerCalls.push(req); return { operation_attempt_id: "OP-new-1" }; };
  const result = handoff(sourceFixture(), requirementFixture(), [snapshotFixture()], owner, { now: NOW, ownerName: "ci-bot" });
  assert.ok(result.context_package.package_id.startsWith("CTXP-"));
  assert.equal(result.context_package.source_host_profile_ref, "H-Codex");
  assert.equal(result.context_package.redacted_summary.prompt, "[REDACTED]");
  assert.equal(result.context_package.redacted_summary.tool_args, "[REDACTED]");
  assert.equal(result.context_package.redacted_summary.stdout, "[REDACTED]");
  assert.equal(result.context_package.fencing_token.startsWith("FT-"), true);
  assert.ok(result.context_package.checkpoint.checkpoint_id.startsWith("CHK-"));
  assert.ok(typeof result.context_package.checkpoint.revision === "string");
  assert.equal(result.context_package.checkpoint.operation_id, "OP-src-1");
  assert.equal(result.new_operation_attempt_id, "OP-new-1");
  assert.equal(result.target_host_profile_ref, "H-Pi");
  assert.equal(ownerCalls.length, 1);
  // Source operation_id is recorded but a NEW attempt is created.
  assert.notEqual(result.new_operation_attempt_id, result.source_operation_id);
});

test("VC-010-01 context package never carries prompts, tool args, or secrets", () => {
  const pkg = buildContextPackage(sourceFixture({
    api_key: "sk-ant-secret-1234567890abcdef",
    password: "p@ssw0rd",
    nested: { token: "ghp_aaaaaaaaaaaaaaaaaaaa", safe: "ok" },
    completion: "private completion",
    boundary_events: [],
  }));
  const json = JSON.stringify(pkg);
  assert.equal(json.includes("SECRET-PROMPT"), false);
  assert.equal(json.includes("rm -rf"), false);
  assert.equal(json.includes("sk-ant-secret"), false);
  assert.equal(json.includes("ghp_"), false);
  assert.equal(json.includes("p@ssw0rd"), false);
  assert.equal(json.includes("private completion"), false);
});

test("VC-010-01 redactValue strips known taint patterns and field names", () => {
  assert.equal(redactValue({ token: "ghp_aaaaaaaaaaaaaaaaaaaa", safe: "ok" }).token, "[REDACTED]");
  assert.equal(redactValue({ token: "ghp_aaaaaaaaaaaaaaaaaaaa", safe: "ok" }).safe, "ok");
  assert.equal(redactValue("ak-test"), "ak-test");
  assert.equal(redactValue("AKIAIOSFODNN7EXAMPLE"), "[REDACTED]");
  assert.equal(redactValue([{ password: "x" }, "ok"])[0].password, "[REDACTED]");
});

test("VC-010-01 isTainted detects secrets in nested arrays and objects", () => {
  assert.equal(isTainted({ token: "ghp_aaaaaaaaaaaaaaaaaaaa" }), true);
  assert.equal(isTainted([{ password: "x" }]), true);
  assert.equal(isTainted("AKIAIOSFODNN7EXAMPLE"), true);
  assert.equal(isTainted({ safe: "value" }), false);
});

test("VC-010-01 boundary events are validated against the frozen envelope", () => {
  const event = {
    schema_version: "1.0",
    event_id: "RBE-test-1",
    type: "session.start",
    at: "2026-07-28T11:00:00.000Z",
    host: { adapter_id: "codex" },
    correlation: {},
    evidence_refs: [],
  };
  const pkg = buildContextPackage(sourceFixture({ boundary_events: [event] }));
  assert.equal(pkg.boundary_events.length, 1);
  assert.equal(pkg.boundary_events[0].type, "session.start");
});

test("VC-010-01 malformed boundary events reject the package with ERR_SOURCE_EVENT_INVALID", () => {
  const badEvent = { type: "session.start", at: "2026-07-28T11:00:00.000Z" };
  assert.throws(
    () => buildContextPackage(sourceFixture({ boundary_events: [badEvent] })),
    (err) => err instanceof CrossHostHandoffError && err.code === "ERR_SOURCE_EVENT_INVALID"
  );
});

test("VC-010-01 checkpoint revision reflects source operation + events", () => {
  const a = buildContextPackage(sourceFixture());
  const b = buildContextPackage(sourceFixture({ operation_id: "OP-other" }));
  assert.notEqual(a.checkpoint.revision, b.checkpoint.revision);
});

test("VC-010-01 handoff is idempotent across replays through the dispatch layer", () => {
  const ownerCalls = [];
  const owner = () => { ownerCalls.push("called"); return { operation_attempt_id: "OP-new-1" }; };
  const opts = { now: NOW, ownerName: "ci-bot", idempotencyState: new Map() };
  const first = handoff(sourceFixture(), requirementFixture(), [snapshotFixture()], owner, opts);
  const second = handoff(sourceFixture(), requirementFixture(), [snapshotFixture()], owner, opts);
  assert.equal(ownerCalls.length, 1);
  assert.equal(first.new_operation_attempt_id, second.new_operation_attempt_id);
});

test("VC-010-01 handoff requires source fields and options.now", () => {
  const owner = () => ({ operation_attempt_id: "OP-new-1" });
  assert.throws(() => handoff({}, requirementFixture(), [snapshotFixture()], owner, { now: NOW }), (err) => err.code === "ERR_SOURCE_OPERATION_REQUIRED");
  assert.throws(() => handoff(sourceFixture(), requirementFixture(), [snapshotFixture()], owner, {}), (err) => err.code === "ERR_OPTIONS_NOW_REQUIRED");
});

test("VC-010-01 handoff package is deeply frozen", () => {
  const pkg = buildContextPackage(sourceFixture());
  assert.equal(Object.isFrozen(pkg), true);
  assert.equal(Object.isFrozen(pkg.checkpoint), true);
});

test("VC-010-01 fencing token is unique per build call", () => {
  const pkgA = buildContextPackage(sourceFixture());
  const pkgB = buildContextPackage(sourceFixture());
  assert.notEqual(pkgA.fencing_token, pkgB.fencing_token);
});