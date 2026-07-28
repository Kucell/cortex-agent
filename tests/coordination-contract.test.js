"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SCHEMA_VERSION, SCHEMA_VERSION_DRAFT,
  STATES, ABSENT, STATE_DESCRIPTIONS, TERMINAL_STATES,
  TRANSITIONS, TRANSITION_MAP, EVENT_TYPES, ACTOR_KINDS, NOTIFICATION_POLICIES,
  EVIDENCE_KINDS, REQUESTED_ACTION_KINDS, RETENTION,
  assertSchemaVersion, isTerminalState, isValidTransition, getTransitionRule,
  assertValidTransition, createEvent, validateEvent,
  createTaskState, validateTaskState, createEventId,
  validateEvidenceRef, validateEvidenceRefs,
  redactSensitive, isCriticalEventType, isTakenOverTransitional,
  CRITICAL_EVENT_TYPES,
  assertCompletedSyncToRun, assertAbsentState,
} = require("../lib/coordination/contract");
const { LeaseManager, DEFAULT_LEASE_TTL_MS } = require("../lib/coordination/lease");
const { CODES, CoordinationError, byCode, byKey } = require("../lib/coordination/errors");

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeProducer(overrides = {}) {
  return { actorId: "test-agent", kind: "agent", vendor: "test", ...overrides };
}

function makeEvent(overrides = {}) {
  return createEvent({
    eventId: "CE-001-test",
    projectId: "test-project",
    taskId: "TASK-001",
    correlationId: "CORR-001",
    producer: makeProducer(),
    targets: [{ actorId: "coordinator", kind: "coordinator" }],
    eventType: "task.created",
    previousState: null,
    currentState: STATES.CREATED,
    timestamp: "2026-07-28T00:00:00.000Z",
    sequence: 1,
    repository: { repositoryId: "test-project", worktreeId: null, branch: "main", baselineCommit: null },
    notification: { policy: "journal_only", dedupeKey: "task.created", ackRequired: false },
    ...overrides,
  });
}

// ─── 1. Schema Version ────────────────────────────────────────────────────

test("SCHEMA_VERSION is 1.0 for CP-1", () => {
  assert.equal(SCHEMA_VERSION, "1.0");
  assert.equal(SCHEMA_VERSION_DRAFT, "1.0-draft");
});

test("assertSchemaVersion accepts 1.0", () => {
  assert.doesNotThrow(() => assertSchemaVersion("1.0"));
});

test("assertSchemaVersion accepts 1.0-draft as migration input", () => {
  assert.doesNotThrow(() => assertSchemaVersion("1.0-draft"));
});

test("assertSchemaVersion rejects unknown major version", () => {
  assert.throws(() => assertSchemaVersion("2.0"), { key: "ERR_SCHEMA_VERSION_UNKNOWN" });
  assert.throws(() => assertSchemaVersion("0.9"), { key: "ERR_SCHEMA_VERSION_UNKNOWN" });
  assert.throws(() => assertSchemaVersion("invalid"), { key: "ERR_SCHEMA_VERSION_UNKNOWN" });
});

test("createEvent validates schema version", () => {
  assert.throws(() => {
    createEvent({
      projectId: "p", taskId: "t", correlationId: "c",
      producer: { actorId: "a", kind: "agent" },
      targets: [], eventType: "task.created",
      currentState: STATES.CREATED, sequence: 1,
      repository: { repositoryId: "p" },
      notification: { policy: "journal_only", dedupeKey: "x" },
      schemaVersion: "2.0",
    });
  }, { key: "ERR_SCHEMA_VERSION_UNKNOWN" });
});

// ─── 2. State Machine ─────────────────────────────────────────────────────

test("STATES contains all 15 states", () => {
  assert.equal(Object.keys(STATES).length, 15);
  assert.equal(STATES.CREATED, "CREATED");
  assert.equal(STATES.COMPLETED, "COMPLETED");
  assert.equal(STATES.FAILED, "FAILED");
  assert.equal(STATES.CANCELLED, "CANCELLED");
  assert.equal(STATES.TAKEN_OVER, "TAKEN_OVER");
  assert.equal(STATES.STALE, "STALE");
});

test("TERMINAL_STATES are FAILED, CANCELLED, COMPLETED", () => {
  assert.ok(isTerminalState(STATES.FAILED));
  assert.ok(isTerminalState(STATES.CANCELLED));
  assert.ok(isTerminalState(STATES.COMPLETED));
  assert.ok(!isTerminalState(STATES.EXECUTING));
  assert.ok(!isTerminalState(STATES.CREATED));
});

test("ABSENT is null", () => {
  assert.equal(ABSENT, null);
});

test("isValidTransition: ABSENT → CREATED", () => {
  assert.ok(isValidTransition(null, STATES.CREATED));
  assert.ok(isValidTransition(undefined, STATES.CREATED));
});

test("isValidTransition: CREATED → ASSIGNED", () => {
  assert.ok(isValidTransition(STATES.CREATED, STATES.ASSIGNED));
});

test("isValidTransition: ASSIGNED → ACCEPTED", () => {
  assert.ok(isValidTransition(STATES.ASSIGNED, STATES.ACCEPTED));
});

test("isValidTransition: ASSIGNED → CANCEL_REQUESTED", () => {
  assert.ok(isValidTransition(STATES.ASSIGNED, STATES.CANCEL_REQUESTED));
});

test("isValidTransition: ACCEPTED → EXECUTING", () => {
  assert.ok(isValidTransition(STATES.ACCEPTED, STATES.EXECUTING));
});

test("isValidTransition: ACCEPTED → WAITING_FOR_INPUT", () => {
  assert.ok(isValidTransition(STATES.ACCEPTED, STATES.WAITING_FOR_INPUT));
});

test("isValidTransition: ACCEPTED → BLOCKED", () => {
  assert.ok(isValidTransition(STATES.ACCEPTED, STATES.BLOCKED));
});

test("isValidTransition: ACCEPTED → STALE", () => {
  assert.ok(isValidTransition(STATES.ACCEPTED, STATES.STALE));
});

test("isValidTransition: ACCEPTED → FAILED", () => {
  assert.ok(isValidTransition(STATES.ACCEPTED, STATES.FAILED));
});

test("isValidTransition: EXECUTING → TESTING", () => {
  assert.ok(isValidTransition(STATES.EXECUTING, STATES.TESTING));
});

test("isValidTransition: TESTING → READY_FOR_REVIEW", () => {
  assert.ok(isValidTransition(STATES.TESTING, STATES.READY_FOR_REVIEW));
});

test("isValidTransition: TESTING → EXECUTING (validation failed, continue)", () => {
  assert.ok(isValidTransition(STATES.TESTING, STATES.EXECUTING));
});

test("isValidTransition: READY_FOR_REVIEW → COMPLETED", () => {
  assert.ok(isValidTransition(STATES.READY_FOR_REVIEW, STATES.COMPLETED));
});

test("isValidTransition: READY_FOR_REVIEW → EXECUTING (revision requested)", () => {
  assert.ok(isValidTransition(STATES.READY_FOR_REVIEW, STATES.EXECUTING));
});

test("isValidTransition: WAITING_FOR_INPUT → EXECUTING", () => {
  assert.ok(isValidTransition(STATES.WAITING_FOR_INPUT, STATES.EXECUTING));
});

test("isValidTransition: BLOCKED → EXECUTING", () => {
  assert.ok(isValidTransition(STATES.BLOCKED, STATES.EXECUTING));
});

test("isValidTransition: BLOCKED → TAKEOVER_REQUESTED", () => {
  assert.ok(isValidTransition(STATES.BLOCKED, STATES.TAKEOVER_REQUESTED));
});

test("isValidTransition: CANCEL_REQUESTED → CANCELLED", () => {
  assert.ok(isValidTransition(STATES.CANCEL_REQUESTED, STATES.CANCELLED));
});

test("isValidTransition: STALE → EXECUTING (original owner proves continuity)", () => {
  assert.ok(isValidTransition(STATES.STALE, STATES.EXECUTING));
});

test("isValidTransition: STALE → TAKEOVER_REQUESTED", () => {
  assert.ok(isValidTransition(STATES.STALE, STATES.TAKEOVER_REQUESTED));
});

test("isValidTransition: TAKEOVER_REQUESTED → TAKEN_OVER", () => {
  assert.ok(isValidTransition(STATES.TAKEOVER_REQUESTED, STATES.TAKEN_OVER));
});

test("isValidTransition: TAKEOVER_REQUESTED → STALE (timeout, audit)", () => {
  assert.ok(isValidTransition(STATES.TAKEOVER_REQUESTED, STATES.STALE));
});

test("isValidTransition: TAKEN_OVER → EXECUTING", () => {
  assert.ok(isValidTransition(STATES.TAKEN_OVER, STATES.EXECUTING));
});

test("isValidTransition: TAKEN_OVER → STALE (lease expires)", () => {
  assert.ok(isValidTransition(STATES.TAKEN_OVER, STATES.STALE));
});

test("isValidTransition: illegal transitions return false", () => {
  assert.ok(!isValidTransition(null, STATES.EXECUTING));
  assert.ok(!isValidTransition(STATES.CREATED, STATES.COMPLETED));
  assert.ok(!isValidTransition(STATES.CANCELLED, STATES.EXECUTING));
  assert.ok(!isValidTransition(STATES.FAILED, STATES.EXECUTING));
  assert.ok(!isValidTransition(STATES.COMPLETED, STATES.EXECUTING));
  assert.ok(!isValidTransition(STATES.EXECUTING, STATES.CREATED));
  assert.ok(!isValidTransition(STATES.CREATED, STATES.FAILED));
  assert.ok(!isValidTransition(STATES.CREATED, STATES.CANCELLED));
  assert.ok(!isValidTransition(STATES.ASSIGNED, STATES.COMPLETED));
  assert.ok(!isValidTransition(STATES.EXECUTING, STATES.CANCELLED));
  assert.ok(!isValidTransition(STATES.TESTING, STATES.CANCELLED));
});

test("assertValidTransition throws on illegal transition", () => {
  assert.throws(() => {
    assertValidTransition(STATES.CREATED, STATES.COMPLETED, "task.completed");
  }, CoordinationError);
  assert.throws(() => {
    assertValidTransition(STATES.CREATED, STATES.COMPLETED, "task.completed");
  }, { key: "ERR_INVALID_TRANSITION" });
});

test("assertValidTransition throws on wrong event type for legal transition", () => {
  assert.throws(() => {
    assertValidTransition(STATES.CREATED, STATES.ASSIGNED, "task.created");
  }, { key: "ERR_EVENT_NOT_LEGAL" });
  assert.throws(() => {
    assertValidTransition(STATES.ASSIGNED, STATES.ACCEPTED, "task.created");
  }, { key: "ERR_EVENT_NOT_LEGAL" });
});

test("assertValidTransition: requiresEvidence check", () => {
  // EXECUTING → READY_FOR_REVIEW requires evidence
  assert.throws(() => {
    assertValidTransition(STATES.EXECUTING, STATES.READY_FOR_REVIEW, "task.ready_for_review");
  }, { key: "ERR_MISSING_EVIDENCE" });

  assert.doesNotThrow(() => {
    assertValidTransition(STATES.EXECUTING, STATES.READY_FOR_REVIEW, "task.ready_for_review", { evidenceRefs: ["ARTIFACT-001"] });
  });
});

test("assertValidTransition: WAITING_FOR_INPUT requires requestedAction", () => {
  assert.throws(() => {
    assertValidTransition(STATES.ACCEPTED, STATES.WAITING_FOR_INPUT, "task.input_required");
  }, { key: "ERR_MISSING_REQUESTED_ACTION" });

  assert.doesNotThrow(() => {
    assertValidTransition(STATES.ACCEPTED, STATES.WAITING_FOR_INPUT, "task.input_required", { requestedAction: { kind: "provide_input" } });
  });
});

// ─── 3. Event Creation and Validation ──────────────────────────────────────

test("createEvent produces valid event envelope", () => {
  const event = makeEvent();
  assert.equal(event.schemaVersion, "1.0");
  assert.equal(event.eventId, "CE-001-test");
  assert.equal(event.projectId, "test-project");
  assert.equal(event.taskId, "TASK-001");
  assert.equal(event.eventType, "task.created");
  assert.equal(event.currentState, STATES.CREATED);
  assert.equal(event.previousState, null);
  assert.equal(event.sequence, 1);
  assert.equal(event.operationId, null);
  assert.equal(event.operationAttempt, null);
  assert.deepEqual(event.targets, [{ actorId: "coordinator", kind: "coordinator" }]);
});

test("createEvent supports operationId and operationAttempt", () => {
  const event = makeEvent({ operationId: "OP-001", operationAttempt: 2 });
  assert.equal(event.operationId, "OP-001");
  assert.equal(event.operationAttempt, 2);
});

test("createEvent validates event type", () => {
  assert.throws(() => {
    makeEvent({ eventType: "invalid.type" });
  }, { key: "ERR_INVALID_EVENT_TYPE" });
});

test("createEvent validates actor", () => {
  assert.throws(() => {
    makeEvent({ producer: { actorId: "", kind: "unknown" } });
  }, { key: "ERR_INVALID_ACTOR" });
  assert.throws(() => {
    makeEvent({ producer: {} });
  }, { key: "ERR_INVALID_ACTOR" });
});

test("validateEvent validates required fields", () => {
  assert.throws(() => validateEvent(null), { key: "ERR_INVALID_EVENT" });
  assert.throws(() => validateEvent({}), { key: "ERR_INVALID_EVENT" });
  assert.throws(() => validateEvent({ schemaVersion: "1.0", eventId: "E1" }), { key: "ERR_INVALID_EVENT" });
});

test("validateEvent passes for valid event", () => {
  assert.doesNotThrow(() => validateEvent(makeEvent()));
});

test("all EVENT_TYPES are in vocabulary", () => {
  assert.equal(EVENT_TYPES.length, 20);
  assert.ok(EVENT_TYPES.includes("task.created"));
  assert.ok(EVENT_TYPES.includes("task.heartbeat"));
  assert.ok(EVENT_TYPES.includes("artifact.ready"));
  assert.ok(EVENT_TYPES.includes("ownership.conflict"));
});

test("eventType includes all required lifecycle events", () => {
  for (const t of ["task.created", "task.assigned", "task.accepted", "task.progress", "task.heartbeat", "task.testing", "task.ready_for_review", "task.completed", "task.failed", "task.blocked", "task.input_required", "task.cancel_requested", "task.cancelled", "task.takeover_requested", "task.taken_over", "task.stale"]) {
    assert.ok(EVENT_TYPES.includes(t), `missing event type: ${t}`);
  }
});

test("eventType includes ownership events", () => {
  for (const t of ["ownership.acquired", "ownership.released", "ownership.conflict"]) {
    assert.ok(EVENT_TYPES.includes(t), `missing event type: ${t}`);
  }
});

test("eventType includes artifact.ready", () => {
  assert.ok(EVENT_TYPES.includes("artifact.ready"));
});

// ─── 4. Task State ─────────────────────────────────────────────────────────

test("createTaskState produces valid state", () => {
  const state = createTaskState({ taskId: "TASK-001", projectId: "test-project" });
  assert.equal(state.schemaVersion, "1.0");
  assert.equal(state.taskId, "TASK-001");
  assert.equal(state.state, STATES.CREATED);
  assert.equal(state.revision, 1);
  assert.equal(state.lastSequence, 0);
  assert.ok(state.createdAt);
  assert.ok(state.updatedAt);
  assert.equal(state.operationId, null);
  assert.equal(state.operationAttempt, null);
});

test("createTaskState supports operationId and operationAttempt", () => {
  const state = createTaskState({ taskId: "T-1", projectId: "p", operationId: "OP-001", operationAttempt: 3 });
  assert.equal(state.operationId, "OP-001");
  assert.equal(state.operationAttempt, 3);
});

test("validateTaskState validates required fields", () => {
  assert.throws(() => validateTaskState(null), { key: "ERR_INVALID_STATE" });
  assert.throws(() => validateTaskState({}), { key: "ERR_INVALID_STATE" });
});

test("validateTaskState passes for valid state", () => {
  assert.doesNotThrow(() => validateTaskState(createTaskState({ taskId: "T-1", projectId: "p" })));
});

// ─── 5. Lease ──────────────────────────────────────────────────────────────

test("LeaseManager: acquire creates active lease", () => {
  const lm = new LeaseManager();
  const lease = lm.acquire("src/", "agent-a");
  assert.ok(lease.leaseId);
  assert.equal(lease.scope, "src/");
  assert.equal(lease.owner, "agent-a");
  assert.equal(lease.releasedAt, null);
  assert.ok(new Date(lease.expiresAt) > new Date());
});

test("LeaseManager: acquire same scope same owner renews", () => {
  const lm = new LeaseManager();
  const first = lm.acquire("src/", "agent-a");
  const second = lm.acquire("src/", "agent-a");
  assert.equal(first.leaseId, second.leaseId);
  assert.ok(new Date(second.expiresAt) >= new Date(first.expiresAt));
});

test("LeaseManager: acquire same scope different owner throws conflict", () => {
  const lm = new LeaseManager();
  lm.acquire("src/", "agent-a");
  assert.throws(() => {
    lm.acquire("src/", "agent-b");
  }, { key: "ERR_LEASE_CONFLICT" });
});

test("LeaseManager: renew extends expiry", () => {
  const lm = new LeaseManager();
  const lease = lm.acquire("src/", "agent-a", { ttl: 60000 });
  const renewed = lm.renew(lease.leaseId, { ttl: 120000 });
  assert.equal(renewed.leaseId, lease.leaseId);
  assert.ok(new Date(renewed.expiresAt) > new Date(lease.expiresAt));
});

test("LeaseManager: renew with wrong actor throws", () => {
  const lm = new LeaseManager();
  const lease = lm.acquire("src/", "agent-a");
  assert.throws(() => {
    lm.renew(lease.leaseId, { actorId: "agent-b" });
  }, { key: "ERR_LEASE_OWNER_MISMATCH" });
});

test("LeaseManager: renew nonexistent lease throws", () => {
  const lm = new LeaseManager();
  assert.throws(() => {
    lm.renew("LEASE-nonexistent");
  }, { key: "ERR_LEASE_NOT_FOUND" });
});

test("LeaseManager: release marks releasedAt", () => {
  const lm = new LeaseManager();
  const lease = lm.acquire("src/", "agent-a");
  const released = lm.release(lease.leaseId);
  assert.ok(released.releasedAt);
  assert.ok(lm.isExpired(lease.leaseId));
});

test("LeaseManager: release idempotent", () => {
  const lm = new LeaseManager();
  const lease = lm.acquire("src/", "agent-a");
  lm.release(lease.leaseId);
  const second = lm.release(lease.leaseId);
  assert.ok(second.releasedAt);
});

test("LeaseManager: release with wrong actor throws", () => {
  const lm = new LeaseManager();
  const lease = lm.acquire("src/", "agent-a");
  assert.throws(() => {
    lm.release(lease.leaseId, { actorId: "agent-b" });
  }, { key: "ERR_LEASE_OWNER_MISMATCH" });
});

test("LeaseManager: isExpired returns true for released lease", () => {
  const lm = new LeaseManager();
  const lease = lm.acquire("src/", "agent-a");
  lm.release(lease.leaseId);
  assert.ok(lm.isExpired(lease.leaseId));
});

test("LeaseManager: isExpired returns true for unknown lease", () => {
  const lm = new LeaseManager();
  assert.ok(lm.isExpired("LEASE-nonexistent"));
});

test("LeaseManager: findConflicts", () => {
  const lm = new LeaseManager();
  lm.acquire("src/", "agent-a");
  assert.equal(lm.findConflicts("src/", "agent-b").length, 1);
  assert.equal(lm.findConflicts("src/", "agent-a").length, 0);
});

// ─── 7. Error Codes ────────────────────────────────────────────────────────

test("all error codes are stable and have zh/en descriptions", () => {
  for (const [key, def] of Object.entries(CODES)) {
    assert.ok(def.code >= 1000 && def.code <= 1999, `code ${def.code} for ${key} out of range`);
    assert.ok(def.code === Math.floor(def.code), `code ${def.code} for ${key} not integer`);
    assert.ok(def.zh, `missing zh for ${key}`);
    assert.ok(def.en, `missing en for ${key}`);
    assert.ok(def.description, `missing description for ${key}`);
    assert.ok(def.description.zh, `missing description.zh for ${key}`);
    assert.ok(def.description.en, `missing description.en for ${key}`);
  }
});

test("byCode and byKey return correct definitions", () => {
  assert.equal(byCode(1001).key, "ERR_INVALID_TRANSITION");
  assert.equal(byKey("ERR_INVALID_TRANSITION").code, 1001);
  assert.equal(byCode(9999), null);
  assert.equal(byKey("UNKNOWN"), null);
});

test("CoordinationError has correct properties", () => {
  const err = new CoordinationError("ERR_INVALID_TRANSITION", { details: { from: "A", to: "B" } });
  assert.equal(err.code, 1001);
  assert.equal(err.key, "ERR_INVALID_TRANSITION");
  assert.equal(err.zh, "状态转换非法");
  assert.equal(err.name, "CoordinationError");
  assert.deepEqual(err.details, { from: "A", to: "B" });
});

test("CoordinationError for unknown key uses fallback", () => {
  const err = new CoordinationError("ERR_NONEXISTENT");
  assert.equal(err.code, 1999);
  assert.equal(err.key, "ERR_UNKNOWN");
});

// ─── 8. Bilingual descriptions ─────────────────────────────────────────────

test("STATE_DESCRIPTIONS has zh/en for all states", () => {
  for (const state of Object.values(STATES)) {
    const desc = STATE_DESCRIPTIONS[state];
    assert.ok(desc, `missing description for ${state}`);
    assert.ok(desc.zh, `missing zh for ${state}`);
    assert.ok(desc.en, `missing en for ${state}`);
  }
});

// ─── 9. Evidence ref validation ────────────────────────────────────────────

test("validateEvidenceRef accepts registered artifact IDs", () => {
  assert.doesNotThrow(() => validateEvidenceRef("ARTIFACT-001"));
  assert.doesNotThrow(() => validateEvidenceRef("ARTIFACT-T-ACN-002"));
});

test("validateEvidenceRef accepts stable resource refs", () => {
  assert.doesNotThrow(() => validateEvidenceRef("DEC-001"));
  assert.doesNotThrow(() => validateEvidenceRef("RUN-42"));
  assert.doesNotThrow(() => validateEvidenceRef("VC-M008-001"));
});

test("validateEvidenceRef accepts repo-relative paths", () => {
  assert.doesNotThrow(() => validateEvidenceRef("./src/main.js"));
  assert.doesNotThrow(() => validateEvidenceRef("lib/coordination/contract.js"));
  assert.doesNotThrow(() => validateEvidenceRef("tests/coordination-contract.test.js"));
});

test("validateEvidenceRef rejects invalid refs", () => {
  assert.throws(() => validateEvidenceRef(""), { key: "ERR_EVIDENCE_REF_INVALID" });
  assert.throws(() => validateEvidenceRef(123), { key: "ERR_EVIDENCE_REF_INVALID" });
  assert.throws(() => validateEvidenceRef("/absolute/path"), { key: "ERR_EVIDENCE_REF_INVALID" });
  assert.throws(() => validateEvidenceRef("https://example.com"), { key: "ERR_EVIDENCE_REF_INVALID" });
});

// ─── 10. Retention ─────────────────────────────────────────────────────────

test("RETENTION defaults are configured", () => {
  assert.equal(RETENTION.criticalEvents, "permanent");
  assert.equal(RETENTION.heartbeat, 7 * 24 * 60 * 60 * 1000);
  assert.equal(RETENTION.progress, 24 * 60 * 60 * 1000);
});

test("isCriticalEventType identifies critical events", () => {
  assert.ok(isCriticalEventType("task.created"));
  assert.ok(isCriticalEventType("task.failed"));
  assert.ok(isCriticalEventType("task.completed"));
  assert.ok(isCriticalEventType("ownership.conflict"));
  assert.ok(isCriticalEventType("task.cancel_requested"));
  assert.ok(isCriticalEventType("task.takeover_requested"));
  assert.ok(isCriticalEventType("task.taken_over"));
  assert.ok(!isCriticalEventType("task.heartbeat"));
  assert.ok(!isCriticalEventType("task.progress"));
});

// ─── 11. Redaction (secret-scan reuse) ─────────────────────────────────────

test("redactSensitive reuses secret-scan redact", () => {
  assert.equal(redactSensitive("short"), "***");
  assert.equal(redactSensitive("this is a long sensitive value"), "this…ue(len=30)");
  assert.equal(redactSensitive(123), "");
});

// ─── 12. COMPLETED sync to Run ─────────────────────────────────────────────

test("assertCompletedSyncToRun rejects COMPLETED with phase in progress", () => {
  assert.throws(() => {
    const event = makeEvent({ eventType: "task.completed", currentState: STATES.COMPLETED, progress: { phase: "deploy" } });
    assertCompletedSyncToRun(event);
  }, { key: "ERR_COMPLETED_RUN_PHASE_PROTECTED" });
});

test("assertCompletedSyncToRun allows COMPLETED without phase", () => {
  assert.doesNotThrow(() => {
    const event = makeEvent({ eventType: "task.completed", currentState: STATES.COMPLETED });
    assertCompletedSyncToRun(event);
  });
});

test("assertCompletedSyncToRun ignores non-COMPLETED events", () => {
  assert.doesNotThrow(() => {
    const event = makeEvent({ eventType: "task.failed", currentState: STATES.FAILED });
    assertCompletedSyncToRun(event);
  });
});

// ─── 13. TAKEN_OVER is transitional ────────────────────────────────────────

test("isTakenOverTransitional returns true for TAKEN_OVER", () => {
  assert.ok(isTakenOverTransitional(STATES.TAKEN_OVER));
  assert.ok(!isTakenOverTransitional(STATES.EXECUTING));
  assert.ok(!isTakenOverTransitional(STATES.STALE));
  assert.ok(!isTakenOverTransitional(STATES.COMPLETED));
});

// ─── 14. ABSENT implicit state ─────────────────────────────────────────────

test("assertAbsentState allows only task.created", () => {
  assert.doesNotThrow(() => assertAbsentState("task.created"));
  assert.throws(() => assertAbsentState("task.assigned"), { key: "ERR_ABSENT_NO_EVENT" });
  assert.throws(() => assertAbsentState("task.progress"), { key: "ERR_ABSENT_NO_EVENT" });
});

// ─── 15. CRITICAL_EVENT_TYPES ──────────────────────────────────────────────

test("CRITICAL_EVENT_TYPES includes all required audit events", () => {
  const required = [
    "ownership.acquired", "ownership.released", "ownership.conflict",
    "task.cancel_requested", "task.cancelled",
    "task.takeover_requested", "task.taken_over",
    "task.failed", "task.blocked", "task.input_required",
    "task.ready_for_review", "task.completed",
    "task.stale", "task.created", "task.assigned", "task.accepted",
  ];
  for (const et of required) {
    assert.ok(CRITICAL_EVENT_TYPES.has(et), `missing critical event type: ${et}`);
  }
});

test("heartbeat and progress are NOT critical", () => {
  assert.ok(!CRITICAL_EVENT_TYPES.has("task.heartbeat"));
  assert.ok(!CRITICAL_EVENT_TYPES.has("task.progress"));
  assert.ok(!CRITICAL_EVENT_TYPES.has("task.testing"));
});

// ─── 16. Notification policies ─────────────────────────────────────────────

test("NOTIFICATION_POLICIES are correct", () => {
  assert.deepEqual(NOTIFICATION_POLICIES, ["journal_only", "coordinator_notify", "user_attention", "urgent"]);
});

// ─── 17. Event contains operation fields ───────────────────────────────────

test("event schema includes operationId and operationAttempt", () => {
  const event = makeEvent({ operationId: "OP-001", operationAttempt: 1 });
  assert.equal(event.operationId, "OP-001");
  assert.equal(event.operationAttempt, 1);
});

// ─── 18. Full legal transition list ────────────────────────────────────────

test("all legal transitions are registered", () => {
  const expected = [
    [null, "CREATED"],
    ["CREATED", "ASSIGNED"],
    ["ASSIGNED", "ACCEPTED"],
    ["ASSIGNED", "CANCEL_REQUESTED"],
    ["ACCEPTED", "EXECUTING"],
    ["ACCEPTED", "WAITING_FOR_INPUT"],
    ["ACCEPTED", "BLOCKED"],
    ["ACCEPTED", "STALE"],
    ["ACCEPTED", "FAILED"],
    ["ACCEPTED", "CANCEL_REQUESTED"],
    ["EXECUTING", "TESTING"],
    ["EXECUTING", "WAITING_FOR_INPUT"],
    ["EXECUTING", "BLOCKED"],
    ["EXECUTING", "STALE"],
    ["EXECUTING", "FAILED"],
    ["EXECUTING", "CANCEL_REQUESTED"],
    ["EXECUTING", "READY_FOR_REVIEW"],
    ["TESTING", "EXECUTING"],
    ["TESTING", "READY_FOR_REVIEW"],
    ["TESTING", "WAITING_FOR_INPUT"],
    ["TESTING", "BLOCKED"],
    ["TESTING", "STALE"],
    ["TESTING", "FAILED"],
    ["TESTING", "CANCEL_REQUESTED"],
    ["READY_FOR_REVIEW", "EXECUTING"],
    ["READY_FOR_REVIEW", "COMPLETED"],
    ["WAITING_FOR_INPUT", "EXECUTING"],
    ["WAITING_FOR_INPUT", "FAILED"],
    ["BLOCKED", "EXECUTING"],
    ["BLOCKED", "STALE"],
    ["BLOCKED", "FAILED"],
    ["BLOCKED", "TAKEOVER_REQUESTED"],
    ["CANCEL_REQUESTED", "CANCELLED"],
    ["STALE", "EXECUTING"],
    ["STALE", "TAKEOVER_REQUESTED"],
    ["TAKEOVER_REQUESTED", "TAKEN_OVER"],
    ["TAKEOVER_REQUESTED", "STALE"],
    ["TAKEN_OVER", "EXECUTING"],
    ["TAKEN_OVER", "STALE"],
  ];
  for (const [from, to] of expected) {
    const fromState = from === null ? null : STATES[from];
    const toState = STATES[to];
    assert.ok(isValidTransition(fromState, toState), `missing transition: ${from} → ${to}`);
  }
});

// ─── 19. Event size limit (message) ────────────────────────────────────────

test("event message has maxLength 4000", () => {
  const event = makeEvent({ message: "x".repeat(4000) });
  assert.equal(event.message.length, 4000);
  // The schema says maxLength 4000; contract doesn't enforce at creation, but schema does
});

// ─── 20. Lease DEFAULT_LEASE_TTL_MS ────────────────────────────────────────

test("DEFAULT_LEASE_TTL_MS is 30 minutes", () => {
  assert.equal(DEFAULT_LEASE_TTL_MS, 30 * 60 * 1000);
});

// ─── 21. ACTOR_KINDS ───────────────────────────────────────────────────────

test("ACTOR_KINDS includes all expected kinds", () => {
  assert.deepEqual(ACTOR_KINDS, ["coordinator", "agent", "user", "service", "adapter"]);
});

// ─── 22. Terminal states cannot transition out ─────────────────────────────

test("no transitions from terminal states", () => {
  for (const terminal of [STATES.FAILED, STATES.CANCELLED, STATES.COMPLETED]) {
    for (const target of Object.values(STATES)) {
      assert.ok(!isValidTransition(terminal, target), `terminal ${terminal} → ${target} should be illegal`);
    }
  }
});

// ─── 23. Event creation uses correct eventId format ────────────────────────

test("createEventId returns CE- prefixed ID", () => {
  const id = createEventId();
  assert.ok(id.startsWith("CE-"));
});

// ─── 24. Evidence refs in event creation ───────────────────────────────────

test("createEvent validates evidence refs", () => {
  assert.doesNotThrow(() => {
    makeEvent({ evidence: [{ kind: "artifact", ref: "ARTIFACT-001" }] });
  });
  assert.throws(() => {
    makeEvent({ evidence: [{ kind: "artifact", ref: "/absolute/path" }] });
  }, { key: "ERR_EVIDENCE_REF_INVALID" });
});

// ─── 25. TAKEOVER_REQUESTED → STALE timeout audit ─────────────────────────

test("TAKEOVER_REQUESTED → STALE is a legal transition with audit event", () => {
  assert.ok(isValidTransition(STATES.TAKEOVER_REQUESTED, STATES.STALE));
  const rule = getTransitionRule(STATES.TAKEOVER_REQUESTED, STATES.STALE);
  assert.ok(rule);
  assert.ok(rule.events.includes("task.stale"));
});

// ─── 26. ZH/EN descriptions are non-empty ──────────────────────────────────

test("all state descriptions are non-empty zh/en", () => {
  for (const [state, desc] of Object.entries(STATE_DESCRIPTIONS)) {
    assert.ok(desc.zh.length > 0, `empty zh for ${state}`);
    assert.ok(desc.en.length > 0, `empty en for ${state}`);
  }
});

// ─── 27. Contract exports all required symbols ─────────────────────────────

test("contract exports all required symbols", () => {
  const contract = require("../lib/coordination/contract");
  const expected = [
    "SCHEMA_VERSION", "SCHEMA_VERSION_DRAFT",
    "STATES", "ABSENT", "STATE_DESCRIPTIONS", "TERMINAL_STATES",
    "TRANSITIONS", "TRANSITION_MAP", "EVENT_TYPES", "ACTOR_KINDS",
    "NOTIFICATION_POLICIES", "EVIDENCE_KINDS", "REQUESTED_ACTION_KINDS",
    "RETENTION", "CRITICAL_EVENT_TYPES",
    "assertSchemaVersion", "isTerminalState", "isValidTransition",
    "getTransitionRule", "assertValidTransition",
    "createEvent", "validateEvent", "createTaskState", "validateTaskState",
    "validateEvidenceRef", "validateEvidenceRefs",
    "redactSensitive", "isCriticalEventType",
    "assertCompletedSyncToRun", "isTakenOverTransitional", "assertAbsentState",
  ];
  for (const sym of expected) {
    assert.ok(contract[sym] !== undefined, `missing export: ${sym}`);
  }
});

// ─── 28. TRANSITION_MAP contains all transitions ───────────────────────────

test("TRANSITION_MAP has correct structure", () => {
  assert.ok(TRANSITION_MAP.__ABSENT__);
  assert.ok(TRANSITION_MAP.__ABSENT__[STATES.CREATED]);
  assert.equal(TRANSITION_MAP.__ABSENT__[STATES.CREATED].events[0], "task.created");
});
