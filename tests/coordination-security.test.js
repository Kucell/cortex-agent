"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createEvent, validateEvent, STATES } = require("../lib/coordination/contract");

function safeEvent(overrides = {}) {
  return createEvent({
    eventId: "CE-security",
    projectId: "project",
    taskId: "TASK-security",
    correlationId: "CORR-security",
    producer: { actorId: "agent", kind: "agent" },
    targets: [],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    sequence: 1,
    repository: { repositoryId: "repo" },
    notification: { policy: "journal_only", dedupeKey: "security" },
    ...overrides,
  });
}

test("rejects credentials without returning the secret", () => {
  const token = `ghp_${"a".repeat(30)}`;
  const event = safeEvent({ message: `credential=${token}` });
  assert.throws(() => validateEvent(event), (error) => {
    assert.equal(error.key, "ERR_INVALID_EVENT");
    assert.equal(error.details.reason, "sensitive_data_rejected");
    assert.ok(error.details.rules.includes("github_pat"));
    assert.equal(JSON.stringify(error.details).includes(token), false);
    return true;
  });
});

test("rejects personal absolute paths and infrastructure addresses", () => {
  assert.throws(() => validateEvent(safeEvent({
    progress: { summary: "output at /Users/alice/private/report.txt" },
  })), { key: "ERR_INVALID_EVENT" });
  assert.throws(() => validateEvent(safeEvent({
    message: "connect to 10.0.0.12",
  })), { key: "ERR_INVALID_EVENT" });
  assert.throws(() => validateEvent(safeEvent({
    message: "socket /tmp/private-agent.sock",
  })), { key: "ERR_INVALID_EVENT" });
});

test("allows stable IDs and repository-relative evidence", () => {
  const event = safeEvent({
    message: "validation complete",
    evidence: [{ kind: "artifact", ref: "reports/test-result.json" }],
  });
  assert.doesNotThrow(() => validateEvent(event));
});

test("rejects unknown fields even when they try to hide credentials", () => {
  const event = safeEvent();
  event.unrecognized = { api_key: "super-secret-value" };
  assert.throws(() => validateEvent(event), (error) => {
    assert.equal(error.key, "ERR_INVALID_EVENT");
    assert.equal(error.details.reason, "unknown fields");
    assert.deepEqual(error.details.fields, ["unrecognized"]);
    return true;
  });
});

test("rejects traversal in repository-relative evidence", () => {
  assert.throws(() => safeEvent({
    evidence: [{ kind: "artifact", ref: "safe/../../etc/passwd" }],
  }), {
    key: "ERR_EVIDENCE_REF_INVALID",
  });
});
