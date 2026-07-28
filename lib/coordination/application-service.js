"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { Journal } = require("./journal");
const { CoordinationError } = require("./errors");
const { STATES, validateEvent } = require("./contract");
const { reduce, replay } = require("./state");
const {
  readSnapshot,
  writeSnapshot,
  recoverSnapshot,
} = require("./snapshot");
const { LeaseManager } = require("./lease");
const { readLeaseState, writeLeaseState } = require("./lease-store");

function assertActorAuthorized(state, event, context = {}) {
  const actorId = event.producer.actorId;
  const kind = event.producer.kind;
  const authenticated = context.authContext;
  if (authenticated) {
    const allowedAuthFields = new Set([
      "actorId", "kind", "sessionId", "workflowGate",
    ]);
    const unknown = Object.keys(authenticated)
      .filter((field) => !allowedAuthFields.has(field));
    if (unknown.length > 0) {
      throw new CoordinationError("ERR_ACTOR_MISMATCH", {
        details: { reason: "auth context contains unsupported fields" },
      });
    }
    if (authenticated.actorId !== actorId || authenticated.kind !== kind) {
      throw new CoordinationError("ERR_ACTOR_MISMATCH", {
        details: { reason: "authenticated actor does not match event producer" },
      });
    }
    if (typeof authenticated.sessionId !== "string"
        || authenticated.sessionId.length === 0
        || (event.producer.sessionId
          && event.producer.sessionId !== authenticated.sessionId)) {
      throw new CoordinationError("ERR_ACTOR_MISMATCH", {
        details: { reason: "authenticated session does not match event producer" },
      });
    }
  }
  const coordinatorOnly = new Set([
    "task.created",
    "task.assigned",
    "task.completed",
    "task.cancel_requested",
    "task.takeover_requested",
  ]);
  const gatedCoordinatorEvents = new Set([
    "task.completed",
    "task.cancel_requested",
    "task.takeover_requested",
  ]);
  if (coordinatorOnly.has(event.eventType) && kind !== "coordinator") {
    throw new CoordinationError("ERR_ACTOR_MISMATCH", {
      details: { eventType: event.eventType, actorId, requiredKind: "coordinator" },
    });
  }
  if (gatedCoordinatorEvents.has(event.eventType)
      && (!authenticated || typeof authenticated.workflowGate !== "string"
        || !context.workflowGates.has(authenticated.workflowGate))) {
    throw new CoordinationError("ERR_ACTOR_MISMATCH", {
      details: {
        eventType: event.eventType,
        reason: "allowlisted workflowGate authorization required",
      },
    });
  }
  if (!state || !state.assignee) return;
  const ownerEvents = new Set([
    "task.accepted",
    "task.progress",
    "task.heartbeat",
    "task.testing",
    "task.ready_for_review",
    "task.blocked",
    "task.input_required",
    "task.failed",
    "task.cancelled",
    "artifact.ready",
    "ownership.acquired",
    "ownership.released",
  ]);
  if (ownerEvents.has(event.eventType) && actorId !== state.assignee) {
    throw new CoordinationError("ERR_ACTOR_MISMATCH", {
      details: { eventType: event.eventType, actorId, assignee: state.assignee },
    });
  }
  const ownership = Array.isArray(state.ownership) ? state.ownership : [];
  if (ownerEvents.has(event.eventType) && ownership.length > 0) {
    if (!authenticated || !authenticated.sessionId) {
      throw new CoordinationError("ERR_ACTOR_MISMATCH", {
        details: {
          eventType: event.eventType,
          reason: "authenticated owner session required",
        },
      });
    }
    if (event.producer.sessionId !== authenticated.sessionId) {
      throw new CoordinationError("ERR_ACTOR_MISMATCH", {
        details: {
          eventType: event.eventType,
          reason: "event producer must carry the authenticated owner session",
        },
      });
    }
    if (!context.leases) {
      throw new CoordinationError("ERR_LEASE_CONFLICT", {
        details: { reason: "durable lease manager unavailable" },
      });
    }
    for (const reference of ownership) {
      if (!reference || typeof reference !== "object" || !reference.leaseId
          || !Number.isInteger(reference.fencingToken)) {
        throw new CoordinationError("ERR_LEASE_CONFLICT", {
          details: { reason: "ownership reference missing leaseId or fencingToken" },
        });
      }
      const lease = context.leases.getLease(reference.leaseId);
      if (!lease || lease.owner !== actorId || !context.leases.isActive(lease)
          || lease.fencingToken !== reference.fencingToken
          || lease.actorId !== authenticated.sessionId
          || context.leases.getFencingToken(lease.scope) !== reference.fencingToken) {
        throw new CoordinationError("ERR_LEASE_CONFLICT", {
          details: {
            reason: "ownership lease is absent, expired, superseded, or mismatched",
            leaseId: reference.leaseId,
          },
        });
      }
    }
  }
}

class CoordinationApplicationService {
  constructor(runtimeDir, options = {}) {
    if (!runtimeDir || typeof runtimeDir !== "string") {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { reason: "runtimeDir required" },
      });
    }
    this.runtimeDir = path.resolve(runtimeDir);
    this.tasksDir = path.join(this.runtimeDir, "tasks");
    this.journalDir = path.join(this.runtimeDir, "journal");
    this.leasesDir = path.join(this.runtimeDir, "leases");
    fs.mkdirSync(this.tasksDir, { recursive: true });
    this.journal = Journal.open(this.journalDir, options.journal || {});
    this.leases = options.leases || readLeaseState(this.leasesDir, { clock: options.clock });
    const workflowGates = options.authorization
      && options.authorization.workflowGates;
    if (workflowGates !== undefined && !Array.isArray(workflowGates)) {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { reason: "authorization.workflowGates must be an array" },
      });
    }
    if ((workflowGates || []).some((gate) =>
      typeof gate !== "string" || gate.length === 0)) {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: {
          reason: "authorization.workflowGates must contain non-empty strings",
        },
      });
    }
    this.workflowGates = new Set(workflowGates || []);
    this.closed = false;
  }

  static open(runtimeDir, options = {}) {
    return new CoordinationApplicationService(runtimeDir, options);
  }

  close() {
    if (this.closed) return;
    this.journal.close();
    this.closed = true;
  }

  _eventsForTask(taskId) {
    return this.journal.readAll({ taskId });
  }

  _loadReconciled(taskId) {
    const events = this._eventsForTask(taskId);
    const snapshot = readSnapshot(this.tasksDir, taskId);
    if (events.length === 0) {
      if (snapshot.status === "corrupted") {
        throw new CoordinationError("ERR_INVALID_STATE", {
          details: { reason: "snapshot corrupted and journal is empty", taskId },
        });
      }
      return snapshot.status === "ok" ? snapshot.taskState : null;
    }

    const rebuilt = replay(events).state;
    if (snapshot.status !== "ok"
        || snapshot.taskState.lastEventId !== rebuilt.lastEventId
        || snapshot.taskState.revision !== rebuilt.revision) {
      return recoverSnapshot(this.tasksDir, taskId, events).taskState;
    }
    return snapshot.taskState;
  }

  getTask(taskId) {
    return this._loadReconciled(taskId);
  }

  listTasks() {
    const ids = new Set();
    for (const event of this.journal.readAll()) ids.add(event.taskId);
    return [...ids].sort().map((taskId) => this._loadReconciled(taskId));
  }

  listEvents(filter = {}) {
    return this.journal.readAll(filter);
  }

  _mutateLease(method, args) {
    const result = this.leases[method](...args);
    writeLeaseState(this.leasesDir, this.leases);
    return result;
  }

  acquireOwnership(scope, owner, options = {}) {
    return this._mutateLease("acquire", [scope, owner, options]);
  }

  renewOwnership(leaseId, options = {}) {
    return this._mutateLease("renew", [leaseId, options]);
  }

  releaseOwnership(leaseId, options = {}) {
    return this._mutateLease("release", [leaseId, options]);
  }

  markOwnershipStale(leaseId, options = {}) {
    return this._mutateLease("markStale", [leaseId, options]);
  }

  requestOwnershipTakeover(scope, requester, options = {}) {
    return this._mutateLease("requestTakeover", [scope, requester, options]);
  }

  completeOwnershipTakeover(requestId, options = {}) {
    return this._mutateLease("completeTakeover", [requestId, options]);
  }

  expireOwnershipTakeover(requestId, options = {}) {
    return this._mutateLease("expireTakeover", [requestId, options]);
  }

  submit(inputEvent, authContext = null) {
    if (this.closed) {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { reason: "application_service_closed" },
      });
    }
    if (!inputEvent || typeof inputEvent !== "object") {
      throw new CoordinationError("ERR_INVALID_EVENT");
    }

    const existing = inputEvent.eventId && this.journal.getEvent(inputEvent.eventId);
    if (existing) {
      return {
        event: existing,
        task: this._loadReconciled(existing.taskId),
        appended: false,
        duplicate: true,
      };
    }

    const event = { ...inputEvent };
    if (event.sequence == null) {
      event.sequence = this.journal.getLastSequence(
        event.taskId,
        event.producer && event.producer.actorId
      ) + 1;
    }
    validateEvent(event);

    const current = this._loadReconciled(event.taskId);
    assertActorAuthorized(current, event, {
      authContext,
      leases: this.leases,
      workflowGates: this.workflowGates,
    });
    const reduced = reduce(current, event);

    const appended = this.journal.append(event);
    try {
      writeSnapshot(this.tasksDir, reduced.state, {
        expectedRevision: current ? current.revision : 0,
        now: event.timestamp,
      });
    } catch (error) {
      // The journal is authoritative. A later read replays and repairs the
      // projection; surface the write failure so callers do not assume success.
      error.journalCommitted = true;
      error.eventId = event.eventId;
      throw error;
    }

    return {
      event: appended.event,
      task: reduced.state,
      appended: true,
      duplicate: false,
    };
  }
}

module.exports = {
  CoordinationApplicationService,
  assertActorAuthorized,
  STATES,
};
