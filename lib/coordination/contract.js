"use strict";

// ─── Coordination Machine Contract (T-ACN-002) ─────────────────────────────
// Single-source bilingual (zh/en) contract for CP-1.
// Zero external dependencies — Node.js built-ins only.
// Schema version: 1.0 (CP-1). 1.0-draft is accepted only as explicit migration input.

const { CODES, CoordinationError } = require("./errors");
const { redact, scanContent } = require("../secret-scan");

// ─── Schema Version ────────────────────────────────────────────────────────

const SCHEMA_VERSION = "1.0";
const SCHEMA_VERSION_DRAFT = "1.0-draft";

function assertSchemaVersion(version) {
  if (version === SCHEMA_VERSION) return;
  if (version === SCHEMA_VERSION_DRAFT) return; // accepted as migration input only
  throw new CoordinationError("ERR_SCHEMA_VERSION_UNKNOWN", { details: { version } });
}

// ─── States (bilingual single source) ──────────────────────────────────────

const STATES = {
  CREATED:             "CREATED",
  ASSIGNED:            "ASSIGNED",
  ACCEPTED:            "ACCEPTED",
  EXECUTING:           "EXECUTING",
  TESTING:             "TESTING",
  READY_FOR_REVIEW:    "READY_FOR_REVIEW",
  WAITING_FOR_INPUT:   "WAITING_FOR_INPUT",
  BLOCKED:             "BLOCKED",
  FAILED:              "FAILED",
  CANCEL_REQUESTED:    "CANCEL_REQUESTED",
  CANCELLED:           "CANCELLED",
  TAKEOVER_REQUESTED:  "TAKEOVER_REQUESTED",
  TAKEN_OVER:          "TAKEN_OVER",
  STALE:               "STALE",
  COMPLETED:           "COMPLETED",
};

const ABSENT = null; // implicit state before first event; not a persistent state

const STATE_DESCRIPTIONS = {
  CREATED:             { zh: "已创建", en: "Created" },
  ASSIGNED:            { zh: "已分派", en: "Assigned" },
  ACCEPTED:            { zh: "已接受", en: "Accepted" },
  EXECUTING:           { zh: "执行中", en: "Executing" },
  TESTING:             { zh: "测试中", en: "Testing" },
  READY_FOR_REVIEW:    { zh: "待审查", en: "Ready for review" },
  WAITING_FOR_INPUT:   { zh: "等待输入", en: "Waiting for input" },
  BLOCKED:             { zh: "已阻塞", en: "Blocked" },
  FAILED:              { zh: "已失败", en: "Failed" },
  CANCEL_REQUESTED:    { zh: "取消请求中", en: "Cancel requested" },
  CANCELLED:           { zh: "已取消", en: "Cancelled" },
  TAKEOVER_REQUESTED:  { zh: "接管请求中", en: "Takeover requested" },
  TAKEN_OVER:          { zh: "已接管", en: "Taken over" },
  STALE:               { zh: "已过期", en: "Stale" },
  COMPLETED:           { zh: "已完成", en: "Completed" },
};

const TERMINAL_STATES = new Set([STATES.FAILED, STATES.CANCELLED, STATES.COMPLETED]);

function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

// ─── Transition Map ────────────────────────────────────────────────────────
// Map: from -> { to: EV_SET } where EV_SET contains the event types allowed.
// null key = ABSENT (implicit, before first event).
// Only task.created is allowed from ABSENT.

const TRANSITIONS = {
  // ABSENT → CREATED
  "null->CREATED": { from: null, to: STATES.CREATED, events: ["task.created"] },
  // CREATED → ASSIGNED
  "CREATED->ASSIGNED": { from: STATES.CREATED, to: STATES.ASSIGNED, events: ["task.assigned"] },
  // ASSIGNED → ACCEPTED
  "ASSIGNED->ACCEPTED": { from: STATES.ASSIGNED, to: STATES.ACCEPTED, events: ["task.accepted", "ownership.acquired"] },
  // ASSIGNED → CANCEL_REQUESTED
  "ASSIGNED->CANCEL_REQUESTED": { from: STATES.ASSIGNED, to: STATES.CANCEL_REQUESTED, events: ["task.cancel_requested"] },
  // ACCEPTED → EXECUTING
  "ACCEPTED->EXECUTING": { from: STATES.ACCEPTED, to: STATES.EXECUTING, events: ["task.progress"] },
  // ACCEPTED → WAITING_FOR_INPUT
  "ACCEPTED->WAITING_FOR_INPUT": { from: STATES.ACCEPTED, to: STATES.WAITING_FOR_INPUT, events: ["task.input_required"] },
  // ACCEPTED → BLOCKED
  "ACCEPTED->BLOCKED": { from: STATES.ACCEPTED, to: STATES.BLOCKED, events: ["task.blocked"] },
  // ACCEPTED → STALE
  "ACCEPTED->STALE": { from: STATES.ACCEPTED, to: STATES.STALE, events: ["task.stale"] },
  // ACCEPTED → FAILED
  "ACCEPTED->FAILED": { from: STATES.ACCEPTED, to: STATES.FAILED, events: ["task.failed"] },
  // ACCEPTED → CANCEL_REQUESTED
  "ACCEPTED->CANCEL_REQUESTED": { from: STATES.ACCEPTED, to: STATES.CANCEL_REQUESTED, events: ["task.cancel_requested"] },
  // EXECUTING → TESTING
  "EXECUTING->TESTING": { from: STATES.EXECUTING, to: STATES.TESTING, events: ["task.testing"] },
  // EXECUTING → WAITING_FOR_INPUT
  "EXECUTING->WAITING_FOR_INPUT": { from: STATES.EXECUTING, to: STATES.WAITING_FOR_INPUT, events: ["task.input_required"] },
  // EXECUTING → BLOCKED
  "EXECUTING->BLOCKED": { from: STATES.EXECUTING, to: STATES.BLOCKED, events: ["task.blocked"] },
  // EXECUTING → STALE
  "EXECUTING->STALE": { from: STATES.EXECUTING, to: STATES.STALE, events: ["task.stale"] },
  // EXECUTING → FAILED
  "EXECUTING->FAILED": { from: STATES.EXECUTING, to: STATES.FAILED, events: ["task.failed"] },
  // EXECUTING → CANCEL_REQUESTED
  "EXECUTING->CANCEL_REQUESTED": { from: STATES.EXECUTING, to: STATES.CANCEL_REQUESTED, events: ["task.cancel_requested"] },
  // EXECUTING → READY_FOR_REVIEW (via progress with evidence)
  "EXECUTING->READY_FOR_REVIEW": { from: STATES.EXECUTING, to: STATES.READY_FOR_REVIEW, events: ["task.ready_for_review", "artifact.ready"], requiresEvidence: true },
  // TESTING → EXECUTING (validation failed, continue)
  "TESTING->EXECUTING": { from: STATES.TESTING, to: STATES.EXECUTING, events: ["task.progress"] },
  // TESTING → READY_FOR_REVIEW
  "TESTING->READY_FOR_REVIEW": { from: STATES.TESTING, to: STATES.READY_FOR_REVIEW, events: ["task.ready_for_review", "artifact.ready"], requiresEvidence: true },
  // TESTING → WAITING_FOR_INPUT
  "TESTING->WAITING_FOR_INPUT": { from: STATES.TESTING, to: STATES.WAITING_FOR_INPUT, events: ["task.input_required"] },
  // TESTING → BLOCKED
  "TESTING->BLOCKED": { from: STATES.TESTING, to: STATES.BLOCKED, events: ["task.blocked"] },
  // TESTING → STALE
  "TESTING->STALE": { from: STATES.TESTING, to: STATES.STALE, events: ["task.stale"] },
  // TESTING → FAILED
  "TESTING->FAILED": { from: STATES.TESTING, to: STATES.FAILED, events: ["task.failed"] },
  // TESTING → CANCEL_REQUESTED
  "TESTING->CANCEL_REQUESTED": { from: STATES.TESTING, to: STATES.CANCEL_REQUESTED, events: ["task.cancel_requested"] },
  // READY_FOR_REVIEW → EXECUTING (revision requested)
  "READY_FOR_REVIEW->EXECUTING": { from: STATES.READY_FOR_REVIEW, to: STATES.EXECUTING, events: ["task.progress"] },
  // READY_FOR_REVIEW → COMPLETED
  "READY_FOR_REVIEW->COMPLETED": { from: STATES.READY_FOR_REVIEW, to: STATES.COMPLETED, events: ["task.completed"] },
  // WAITING_FOR_INPUT → EXECUTING (input resolved)
  "WAITING_FOR_INPUT->EXECUTING": { from: STATES.WAITING_FOR_INPUT, to: STATES.EXECUTING, events: ["task.progress"] },
  // WAITING_FOR_INPUT → FAILED
  "WAITING_FOR_INPUT->FAILED": { from: STATES.WAITING_FOR_INPUT, to: STATES.FAILED, events: ["task.failed"] },
  // BLOCKED → EXECUTING (blocker resolved)
  "BLOCKED->EXECUTING": { from: STATES.BLOCKED, to: STATES.EXECUTING, events: ["task.progress"] },
  // BLOCKED → STALE
  "BLOCKED->STALE": { from: STATES.BLOCKED, to: STATES.STALE, events: ["task.stale"] },
  // BLOCKED → FAILED
  "BLOCKED->FAILED": { from: STATES.BLOCKED, to: STATES.FAILED, events: ["task.failed"] },
  // BLOCKED → TAKEOVER_REQUESTED
  "BLOCKED->TAKEOVER_REQUESTED": { from: STATES.BLOCKED, to: STATES.TAKEOVER_REQUESTED, events: ["task.takeover_requested"] },
  // CANCEL_REQUESTED → CANCELLED
  "CANCEL_REQUESTED->CANCELLED": { from: STATES.CANCEL_REQUESTED, to: STATES.CANCELLED, events: ["task.cancelled", "ownership.released"] },
  // STALE → EXECUTING (original owner proves continuity)
  "STALE->EXECUTING": { from: STATES.STALE, to: STATES.EXECUTING, events: ["task.progress"] },
  // STALE → TAKEOVER_REQUESTED
  "STALE->TAKEOVER_REQUESTED": { from: STATES.STALE, to: STATES.TAKEOVER_REQUESTED, events: ["task.takeover_requested"] },
  // TAKEOVER_REQUESTED → TAKEN_OVER
  "TAKEOVER_REQUESTED->TAKEN_OVER": { from: STATES.TAKEOVER_REQUESTED, to: STATES.TAKEN_OVER, events: ["task.taken_over", "ownership.acquired"] },
  // TAKEOVER_REQUESTED → STALE (timeout, with audit)
  "TAKEOVER_REQUESTED->STALE": { from: STATES.TAKEOVER_REQUESTED, to: STATES.STALE, events: ["task.stale"] },
  // TAKEN_OVER → EXECUTING
  "TAKEN_OVER->EXECUTING": { from: STATES.TAKEN_OVER, to: STATES.EXECUTING, events: ["task.progress"] },
  // TAKEN_OVER → STALE (lease expires, transitional)
  "TAKEN_OVER->STALE": { from: STATES.TAKEN_OVER, to: STATES.STALE, events: ["task.stale"] },
};

// Build forward lookup: from → { to → rule }
const TRANSITION_MAP = {};
for (const [key, rule] of Object.entries(TRANSITIONS)) {
  const fromKey = rule.from === null ? "__ABSENT__" : rule.from;
  if (!TRANSITION_MAP[fromKey]) TRANSITION_MAP[fromKey] = {};
  TRANSITION_MAP[fromKey][rule.to] = rule;
}

function isValidTransition(from, to) {
  const fromKey = from === null || from === undefined ? "__ABSENT__" : from;
  const map = TRANSITION_MAP[fromKey];
  if (!map) return false;
  return map[to] !== undefined;
}

function getTransitionRule(from, to) {
  const fromKey = from === null || from === undefined ? "__ABSENT__" : from;
  const map = TRANSITION_MAP[fromKey];
  if (!map) return null;
  return map[to] || null;
}

function assertValidTransition(from, to, eventType, opts = {}) {
  const rule = getTransitionRule(from, to);
  if (!rule) {
    throw new CoordinationError("ERR_INVALID_TRANSITION", {
      details: { from, to, eventType },
    });
  }
  if (eventType && !rule.events.includes(eventType)) {
    throw new CoordinationError("ERR_EVENT_NOT_LEGAL", {
      details: { from, to, eventType, allowedEvents: rule.events },
    });
  }
  if (rule.requiresEvidence && !opts.evidenceRefs) {
    throw new CoordinationError("ERR_MISSING_EVIDENCE", {
      details: { from, to, eventType },
    });
  }
  if (to === STATES.WAITING_FOR_INPUT && !opts.requestedAction) {
    throw new CoordinationError("ERR_MISSING_REQUESTED_ACTION", {
      details: { from, to },
    });
  }
}

// ─── Event Types (vocabulary) ──────────────────────────────────────────────

const EVENT_TYPES = [
  "task.created",
  "task.assigned",
  "task.accepted",
  "task.progress",
  "task.heartbeat",
  "task.testing",
  "task.ready_for_review",
  "task.completed",
  "task.failed",
  "task.blocked",
  "task.input_required",
  "task.cancel_requested",
  "task.cancelled",
  "task.takeover_requested",
  "task.taken_over",
  "task.stale",
  "ownership.acquired",
  "ownership.released",
  "ownership.conflict",
  "artifact.ready",
];

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

// ─── Actor kinds ───────────────────────────────────────────────────────────

const ACTOR_KINDS = ["coordinator", "agent", "user", "service", "adapter"];

// ─── Notification policies ─────────────────────────────────────────────────

const NOTIFICATION_POLICIES = ["journal_only", "coordinator_notify", "user_attention", "urgent"];

// ─── Evidence kinds ────────────────────────────────────────────────────────

const EVIDENCE_KINDS = ["artifact", "validation", "run", "operation", "log_cursor"];

// ─── Requested action kinds ────────────────────────────────────────────────

const REQUESTED_ACTION_KINDS = ["provide_input", "review", "approve", "stop", "release_ownership", "takeover"];

// ─── Retention defaults ────────────────────────────────────────────────────

const RETENTION = {
  criticalEvents: "permanent",      // ownership conflict/acquire/release, cancel/takeover, failed/blocked/input_required, ready/completed, recovery
  heartbeat: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  progress: 24 * 60 * 60 * 1000,    // 24h after terminal state in ms
};

const CRITICAL_EVENT_TYPES = new Set([
  "task.created",
  "task.assigned",
  "task.accepted",
  "task.ready_for_review",
  "task.completed",
  "task.failed",
  "task.blocked",
  "task.input_required",
  "task.cancel_requested",
  "task.cancelled",
  "task.takeover_requested",
  "task.taken_over",
  "task.stale",
  "ownership.acquired",
  "ownership.released",
  "ownership.conflict",
]);

function isCriticalEventType(eventType) {
  return CRITICAL_EVENT_TYPES.has(eventType);
}

// ─── Event helpers ─────────────────────────────────────────────────────────

function createEventId() {
  // Simple random ID for CP-1. Format: CE-<timestamp>-<random>
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `CE-${ts}-${rand}`;
}

function createEvent({
  eventId,
  projectId,
  taskId,
  parentTaskId,
  correlationId,
  producer,
  targets,
  eventType,
  previousState,
  currentState,
  timestamp,
  sequence,
  repository,
  fileOwnership,
  progress,
  message,
  evidence,
  requestedAction,
  expiresAt,
  notification,
  operationId,
  operationAttempt,
  schemaVersion,
}) {
  const sv = schemaVersion || SCHEMA_VERSION;
  assertSchemaVersion(sv);

  if (!EVENT_TYPE_SET.has(eventType)) {
    throw new CoordinationError("ERR_INVALID_EVENT_TYPE", { details: { eventType } });
  }
  if (!producer || !producer.actorId || !ACTOR_KINDS.includes(producer.kind)) {
    throw new CoordinationError("ERR_INVALID_ACTOR", { details: { producer } });
  }
  if (previousState !== null && previousState !== undefined && !STATES[previousState] && previousState !== STATES[previousState]) {
    // previousState can be null (ABSENT) or a valid state
    if (!Object.values(STATES).includes(previousState)) {
      throw new CoordinationError("ERR_INVALID_STATE", { details: { previousState } });
    }
  }
  if (!Object.values(STATES).includes(currentState)) {
    throw new CoordinationError("ERR_INVALID_STATE", { details: { currentState } });
  }

  if (evidence) {
    for (const ev of evidence) {
      validateEvidenceRef(ev.ref);
    }
  }

  const event = {
    schemaVersion: sv,
    eventId: eventId || createEventId(),
    projectId,
    taskId,
    parentTaskId: parentTaskId || null,
    correlationId,
    producer,
    targets: targets || [],
    eventType,
    previousState: previousState !== undefined ? previousState : null,
    currentState,
    timestamp: timestamp || new Date().toISOString(),
    sequence,
    repository: repository || { repositoryId: projectId },
    fileOwnership: fileOwnership || [],
    progress: progress || null,
    message: message || null,
    evidence: evidence || [],
    requestedAction: requestedAction || null,
    expiresAt: expiresAt || null,
    notification: notification || { policy: "journal_only", dedupeKey: eventType },
    operationId: operationId || null,
    operationAttempt: operationAttempt != null ? operationAttempt : null,
  };

  return event;
}

function validateEvent(event) {
  if (!event || typeof event !== "object") {
    throw new CoordinationError("ERR_INVALID_EVENT", { details: { reason: "event must be an object" } });
  }
  const required = ["schemaVersion", "eventId", "projectId", "taskId", "correlationId", "producer", "targets", "eventType", "currentState", "timestamp", "sequence", "repository", "notification"];
  for (const field of required) {
    if (event[field] === undefined || event[field] === null) {
      throw new CoordinationError("ERR_INVALID_EVENT", { details: { reason: `missing required field: ${field}` } });
    }
  }
  assertSchemaVersion(event.schemaVersion);
  if (!EVENT_TYPE_SET.has(event.eventType)) {
    throw new CoordinationError("ERR_INVALID_EVENT_TYPE", { details: { eventType: event.eventType } });
  }
  if (!event.producer.actorId || !ACTOR_KINDS.includes(event.producer.kind)) {
    throw new CoordinationError("ERR_INVALID_ACTOR", { details: { producer: event.producer } });
  }
  if (event.notification && event.notification.ackRequired && !isCriticalEventType(event.eventType)) {
    // Only critical events may require ACK
  }
  if (event.evidence) {
    for (const ev of event.evidence) {
      validateEvidenceRef(ev.ref);
    }
  }
  assertEventSafe(event);
}

function assertEventSafe(event) {
  const inspectable = {
    message: event.message,
    progress: event.progress,
    requestedAction: event.requestedAction,
    evidence: event.evidence,
    repository: event.repository,
    fileOwnership: event.fileOwnership,
  };
  const serialized = JSON.stringify(inspectable);
  const findings = scanContent(serialized);
  const infrastructurePatterns = [
    { id: "ipv4_address", regex: /(^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}([^0-9]|$)/ },
    { id: "local_socket_path", regex: /(?:^|["'\s])\/(?:tmp|var\/run)\/[^"'\s]+/ },
    { id: "windows_user_path", regex: /[A-Za-z]:\\Users\\[^\\\s]+/i },
  ];
  for (const pattern of infrastructurePatterns) {
    if (pattern.regex.test(serialized)) {
      findings.push({ rule_id: pattern.id });
    }
  }
  if (findings.length > 0) {
    throw new CoordinationError("ERR_INVALID_EVENT", {
      details: {
        reason: "sensitive_data_rejected",
        rules: [...new Set(findings.map((finding) => finding.rule_id))],
      },
    });
  }
}

// ─── Task state helpers ────────────────────────────────────────────────────

function createTaskState({
  taskId,
  projectId,
  parentTaskId,
  correlationId,
  state,
  assignee,
  ownership,
  requestedAction,
  evidenceRefs,
  pendingCriticalEvents,
  operationId,
  operationAttempt,
  producerSequences,
}) {
  const now = new Date().toISOString();
  const task = {
    schemaVersion: SCHEMA_VERSION,
    taskId,
    projectId,
    parentTaskId: parentTaskId || null,
    correlationId: correlationId || null,
    state: state || STATES.CREATED,
    revision: 1,
    lastSequence: 0,
    producerSequences: producerSequences || {},
    createdAt: now,
    updatedAt: now,
    heartbeatDueAt: null,
    assignee: assignee || null,
    ownership: ownership || [],
    requestedAction: requestedAction || null,
    evidenceRefs: evidenceRefs || [],
    pendingCriticalEvents: pendingCriticalEvents || [],
    operationId: operationId || null,
    operationAttempt: operationAttempt != null ? operationAttempt : null,
  };
  return task;
}

function validateTaskState(task) {
  if (!task || typeof task !== "object") {
    throw new CoordinationError("ERR_INVALID_STATE", { details: { reason: "task state must be an object" } });
  }
  const required = ["schemaVersion", "taskId", "projectId", "state", "revision", "lastSequence", "createdAt", "updatedAt"];
  for (const field of required) {
    if (task[field] === undefined || task[field] === null) {
      throw new CoordinationError("ERR_INVALID_STATE", { details: { reason: `missing required task state field: ${field}` } });
    }
  }
  assertSchemaVersion(task.schemaVersion);
  if (!Object.values(STATES).includes(task.state)) {
    throw new CoordinationError("ERR_INVALID_STATE", { details: { state: task.state } });
  }
  if (!task.producerSequences || typeof task.producerSequences !== "object"
      || Array.isArray(task.producerSequences)) {
    throw new CoordinationError("ERR_INVALID_STATE", {
      details: { reason: "producerSequences must be an object" },
    });
  }
  for (const [actorId, sequence] of Object.entries(task.producerSequences)) {
    if (!actorId || !Number.isInteger(sequence) || sequence < 0) {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { reason: "invalid producer sequence", actorId, sequence },
      });
    }
  }
}

// ─── Lease Manager ─────────────────────────────────────────────────────────

function createLeaseId() {
  return `LEASE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

class LeaseManager {
  constructor() {
    this._leases = new Map(); // leaseId → lease object
  }

  acquire(scope, owner, { ttl, actorId } = {}) {
    const ttlMs = ttl || DEFAULT_LEASE_TTL_MS;
    // Check for existing active lease on same scope
    for (const lease of this._leases.values()) {
      if (lease.scope === scope && !lease.releasedAt && new Date(lease.expiresAt) > new Date()) {
        if (lease.owner !== owner) {
          const err = new CoordinationError("ERR_LEASE_CONFLICT", {
            details: { scope, currentOwner: lease.owner, requestedOwner: owner },
          });
          err.lease = lease;
          throw err;
        }
        // Same owner — renew
        return this.renew(lease.leaseId, { ttl: ttlMs, actorId });
      }
    }

    const now = new Date();
    const lease = {
      leaseId: createLeaseId(),
      scope,
      owner,
      actorId: actorId || owner,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      releasedAt: null,
    };
    this._leases.set(lease.leaseId, lease);
    return { ...lease };
  }

  renew(leaseId, { ttl, actorId } = {}) {
    const lease = this._leases.get(leaseId);
    if (!lease) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { leaseId } });
    }
    if (lease.releasedAt) {
      throw new CoordinationError("ERR_LEASE_EXPIRED", { details: { leaseId, reason: "already released" } });
    }
    if (actorId && lease.actorId !== actorId) {
      throw new CoordinationError("ERR_LEASE_OWNER_MISMATCH", { details: { leaseId, currentOwner: lease.actorId, requestedOwner: actorId } });
    }
    const ttlMs = ttl || DEFAULT_LEASE_TTL_MS;
    lease.expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return { ...lease };
  }

  release(leaseId, { actorId } = {}) {
    const lease = this._leases.get(leaseId);
    if (!lease) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { leaseId } });
    }
    if (lease.releasedAt) {
      return { ...lease }; // idempotent
    }
    if (actorId && lease.actorId !== actorId) {
      throw new CoordinationError("ERR_LEASE_OWNER_MISMATCH", { details: { leaseId, currentOwner: lease.actorId, requestedOwner: actorId } });
    }
    lease.releasedAt = new Date().toISOString();
    return { ...lease };
  }

  isExpired(leaseOrId) {
    const lease = typeof leaseOrId === "string" ? this._leases.get(leaseOrId) : leaseOrId;
    if (!lease) return true;
    if (lease.releasedAt) return true;
    return new Date(lease.expiresAt) <= new Date();
  }

  getLease(leaseId) {
    const lease = this._leases.get(leaseId);
    if (!lease) return null;
    return { ...lease };
  }

  listActiveLeases() {
    const active = [];
    for (const lease of this._leases.values()) {
      if (!this.isExpired(lease)) {
        active.push({ ...lease });
      }
    }
    return active;
  }

  findConflicts(scope, owner) {
    const conflicts = [];
    for (const lease of this._leases.values()) {
      if (lease.scope === scope && lease.owner !== owner && !lease.releasedAt && new Date(lease.expiresAt) > new Date()) {
        conflicts.push({ ...lease });
      }
    }
    return conflicts;
  }
}

// ─── Consumer Cursor / ACK ─────────────────────────────────────────────────

class ConsumerCursor {
  constructor() {
    this._consumers = new Map(); // consumerId → { taskCursors: { taskId: { lastSequence, ackedEventIds: Set } } }
  }

  register(consumerId) {
    if (this._consumers.has(consumerId)) {
      return this._consumers.get(consumerId);
    }
    const cursor = { taskCursors: {} };
    this._consumers.set(consumerId, cursor);
    return cursor;
  }

  getConsumer(consumerId) {
    if (!this._consumers.has(consumerId)) {
      throw new CoordinationError("ERR_CONSUMER_NOT_FOUND", { details: { consumerId } });
    }
    return this._consumers.get(consumerId);
  }

  getCursor(consumerId, taskId) {
    const consumer = this.getConsumer(consumerId);
    if (!consumer.taskCursors[taskId]) {
      consumer.taskCursors[taskId] = { lastSequence: 0, ackedEventIds: new Set() };
    }
    return consumer.taskCursors[taskId];
  }

  ackEvent(consumerId, taskId, eventId, sequence) {
    const cursor = this.getCursor(consumerId, taskId);
    if (cursor.ackedEventIds.has(eventId)) {
      throw new CoordinationError("ERR_ACK_ALREADY", { details: { consumerId, taskId, eventId } });
    }
    cursor.ackedEventIds.add(eventId);
    if (sequence > cursor.lastSequence) {
      cursor.lastSequence = sequence;
    }
    return { consumerId, taskId, lastSequence: cursor.lastSequence, ackedCount: cursor.ackedEventIds.size };
  }

  isAcked(consumerId, taskId, eventId) {
    try {
      const cursor = this.getCursor(consumerId, taskId);
      return cursor.ackedEventIds.has(eventId);
    } catch {
      return false;
    }
  }

  getPendingCriticalEvents(consumerId, taskState) {
    const pending = [];
    const consumer = this._consumers.get(consumerId);
    if (!consumer) return taskState.pendingCriticalEvents || [];
    const cursor = consumer.taskCursors[taskState.taskId];
    if (!cursor) return taskState.pendingCriticalEvents || [];
    return (taskState.pendingCriticalEvents || []).filter(eid => !cursor.ackedEventIds.has(eid));
  }

  advanceSequence(consumerId, taskId, sequence) {
    const cursor = this.getCursor(consumerId, taskId);
    if (sequence > cursor.lastSequence) {
      cursor.lastSequence = sequence;
    }
    return { consumerId, taskId, lastSequence: cursor.lastSequence };
  }
}

// ─── Evidence ref validation ───────────────────────────────────────────────
// Rejects: URLs, absolute paths, empty strings, non-strings.
// Accepts: ARTIFACT-xxx, stable resource refs (e.g., DEC-001, RUN-001),
//          repo-relative paths (./foo, foo/bar).

const EVIDENCE_REF_PATTERNS = [
  /^ARTIFACT-[A-Za-z0-9._-]+$/,           // registered artifact ID
  /^[A-Z]+-[A-Z0-9]+-[A-Za-z0-9._-]+$/,  // stable resource ref (e.g., DEC-001, RUN-001, VC-001)
  /^\.\//,                                  // repo-relative path starting with ./
  /^[a-zA-Z0-9_-][a-zA-Z0-9_\/.-]*$/,     // repo-relative path (no leading dot, no protocol)
];

function looksLikeUrl(ref) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref);
}

function validateEvidenceRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new CoordinationError("ERR_EVIDENCE_REF_INVALID", { details: { ref } });
  }
  if (looksLikeUrl(ref)) {
    throw new CoordinationError("ERR_EVIDENCE_REF_INVALID", { details: { ref, reason: "URLs are not allowed" } });
  }
  if (ref.startsWith("/")) {
    throw new CoordinationError("ERR_EVIDENCE_REF_INVALID", { details: { ref, reason: "absolute paths are not allowed" } });
  }
  const valid = EVIDENCE_REF_PATTERNS.some(p => p.test(ref));
  if (!valid) {
    throw new CoordinationError("ERR_EVIDENCE_REF_INVALID", { details: { ref } });
  }
}

function validateEvidenceRefs(refs) {
  for (const ref of refs) {
    validateEvidenceRef(ref);
  }
}

// ─── Sensitive content redaction ───────────────────────────────────────────
// Reuses secret-scan's redact function for message/progress summary.

function redactSensitive(value) {
  return redact(value);
}

// ─── COMPLETED sync to Run contract ────────────────────────────────────────

function assertCompletedSyncToRun(event) {
  // COMPLETED event syncing to Run must only append event/evidence ref,
  // never overwrite Run.phase. This is a contract assertion, not runtime enforcement.
  if (event.eventType !== "task.completed") return;
  if (event.progress && event.progress.phase) {
    throw new CoordinationError("ERR_COMPLETED_RUN_PHASE_PROTECTED", {
      details: { eventId: event.eventId, phase: event.progress.phase },
    });
  }
}

// ─── TAKEN_OVER is transitional ────────────────────────────────────────────

function isTakenOverTransitional(state) {
  return state === STATES.TAKEN_OVER;
}

// ─── ABSENT implicit state check ───────────────────────────────────────────

function assertAbsentState(eventType) {
  if (eventType !== "task.created") {
    throw new CoordinationError("ERR_ABSENT_NO_EVENT", { details: { eventType } });
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  SCHEMA_VERSION,
  SCHEMA_VERSION_DRAFT,
  STATES,
  ABSENT,
  STATE_DESCRIPTIONS,
  TERMINAL_STATES,
  TRANSITIONS,
  TRANSITION_MAP,
  EVENT_TYPES,
  EVENT_TYPE_SET,
  ACTOR_KINDS,
  NOTIFICATION_POLICIES,
  EVIDENCE_KINDS,
  REQUESTED_ACTION_KINDS,
  RETENTION,
  CRITICAL_EVENT_TYPES,
  DEFAULT_LEASE_TTL_MS,

  // Schema version
  assertSchemaVersion,

  // State machine
  isTerminalState,
  isValidTransition,
  getTransitionRule,
  assertValidTransition,

  // Event helpers
  createEventId,
  createEvent,
  validateEvent,
  assertEventSafe,

  // Task state helpers
  createTaskState,
  validateTaskState,

  // Lease
  createLeaseId,
  LeaseManager,

  // Consumer cursor / ACK
  ConsumerCursor,

  // Evidence ref
  validateEvidenceRef,
  validateEvidenceRefs,

  // Redaction
  redactSensitive,

  // Retention
  isCriticalEventType,

  // Contract assertions
  assertCompletedSyncToRun,
  isTakenOverTransitional,
  assertAbsentState,
};
