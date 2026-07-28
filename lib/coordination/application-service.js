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

function assertActorAuthorized(state, event) {
  const actorId = event.producer.actorId;
  const kind = event.producer.kind;
  const coordinatorOnly = new Set([
    "task.created",
    "task.assigned",
    "task.completed",
    "task.cancel_requested",
    "task.takeover_requested",
  ]);
  if (coordinatorOnly.has(event.eventType) && kind !== "coordinator") {
    throw new CoordinationError("ERR_ACTOR_MISMATCH", {
      details: { eventType: event.eventType, actorId, requiredKind: "coordinator" },
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
    fs.mkdirSync(this.tasksDir, { recursive: true });
    this.journal = Journal.open(this.journalDir, options.journal || {});
    this.leases = options.leases || new LeaseManager({ clock: options.clock });
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

  submit(inputEvent) {
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
    assertActorAuthorized(current, event);
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
