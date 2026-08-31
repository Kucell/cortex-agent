"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const handoffProtocol = require("../../.agent/handoffs/scripts/handoff-protocol.js");

// A complete bare handoff payload (existing CLI flow shape).
const BARE = {
  handoff_id: "handoff-001",
  mode: "AGENT_RESUME",
  from: { agent_id: "agent-a@host-1", model: "claude-opus-4.5" },
  to: {
    agent_id: "agent-b@host-2",
    model: "claude-opus-4.5",
    role: "executor",
    model_pref: ["claude-opus-4.5", "gpt-5.6"],
    required_capabilities: ["code-review"]
  },
  task_id: "T-FBP-001",
  task_progress: {
    current_step: "draft-plan",
    completed_steps: ["scan", "design"],
    in_progress: "draft",
    remaining_steps: ["review", "publish"]
  },
  artifacts: {
    completed: ["plan.md"],
    context_snapshot_ref: ".agent/artifacts/handoff-001/snapshot.json",
    markdown_ref: ".agent/artifacts/handoff-001/handoff.md"
  },
  next_action: "verify migration",
  constraints: ["no destructive changes"],
  verification: {
    commands_run: [
      { command: "node --test tests/x.test.js", exit_code: 0 }
    ],
    commands_needed: ["node --test tests/y.test.js"],
    known_failures: []
  },
  produced_at: "2026-08-31T00:00:00Z"
};

// An envelope wrapper (artifact-bus kind=handoff).
const ENVELOPE = {
  artifact_id: "art-handoff-001",
  artifact_type: "handoff_envelope",
  kind: "handoff",
  captured_at: "2026-08-31T00:00:00Z",
  payload: BARE
};

test("extractHandoffPayload returns bare payload unchanged", () => {
  const out = handoffProtocol.extractHandoffPayload(BARE);
  assert.deepEqual(out, BARE);
});

test("extractHandoffPayload unwraps envelope into inner payload", () => {
  const out = handoffProtocol.extractHandoffPayload(ENVELOPE);
  assert.deepEqual(out, BARE);
});

test("extractHandoffPayload returns null/undefined unchanged", () => {
  assert.equal(handoffProtocol.extractHandoffPayload(null), null);
  assert.equal(handoffProtocol.extractHandoffPayload(undefined), undefined);
});

test("extractHandoffPayload returns non-object primitives unchanged", () => {
  assert.equal(handoffProtocol.extractHandoffPayload("string"), "string");
  assert.equal(handoffProtocol.extractHandoffPayload(42), 42);
  assert.equal(handoffProtocol.extractHandoffPayload(true), true);
});

test("extractHandoffPayload returns envelope without payload unchanged", () => {
  const noPayload = { artifact_id: "art-x", other: "stuff" };
  const out = handoffProtocol.extractHandoffPayload(noPayload);
  assert.deepEqual(out, noPayload);
});

test("extractHandoffPayload returns envelope with non-object payload unchanged", () => {
  const bad = { artifact_id: "art-x", payload: "string-not-object" };
  const out = handoffProtocol.extractHandoffPayload(bad);
  assert.deepEqual(out, bad);
});

test("validatePayload accepts complete bare payload (no issues)", () => {
  const issues = handoffProtocol.validatePayload(BARE);
  assert.deepEqual(issues, []);
});

test("validatePayload accepts envelope (auto-unwrap)", () => {
  const issues = handoffProtocol.validatePayload(ENVELOPE);
  assert.deepEqual(issues, []);
});

test("validatePayload rejects missing required top-level field", () => {
  const incomplete = { ...BARE };
  delete incomplete.task_id;
  const issues = handoffProtocol.validatePayload(incomplete);
  assert.ok(issues.includes("task_id"));
});

test("validatePayload rejects invalid mode", () => {
  const bad = { ...BARE, mode: "INVALID_MODE" };
  const issues = handoffProtocol.validatePayload(bad);
  assert.ok(issues.some((i) => i.startsWith("mode")));
});

test("validatePayload rejects envelope with defects after unwrap", () => {
  const incompleteBare = { ...BARE };
  delete incompleteBare.task_id;
  const envelopeWithDefects = { ...ENVELOPE, payload: incompleteBare };
  const issues = handoffProtocol.validatePayload(envelopeWithDefects);
  assert.ok(issues.includes("task_id"));
});

test("validatePayload rejects empty from.agent_id", () => {
  const bad = { ...BARE, from: { ...BARE.from, agent_id: "" } };
  const issues = handoffProtocol.validatePayload(bad);
  assert.ok(issues.includes("from.agent_id"));
});

test("validatePayload rejects empty next_action", () => {
  const bad = { ...BARE, next_action: "" };
  const issues = handoffProtocol.validatePayload(bad);
  assert.ok(issues.includes("next_action"));
});

test("validatePayload rejects task_progress that is not an object", () => {
  const bad = { ...BARE, task_progress: "string-not-object" };
  const issues = handoffProtocol.validatePayload(bad);
  assert.ok(issues.includes("task_progress"));
});

test("validatePayload rejects verification.commands_run[0] missing exit_code", () => {
  const bad = JSON.parse(JSON.stringify(BARE));
  bad.verification.commands_run = [{ command: "node --test" }];
  const issues = handoffProtocol.validatePayload(bad);
  assert.ok(issues.some((i) => i.includes("commands_run[0].exit_code")));
});
