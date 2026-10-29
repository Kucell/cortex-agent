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
        suppliedWorkflowGate: authenticated && typeof authenticated.workflowGate === "string"
          ? authenticated.workflowGate
          : null,
        // The allow-list is server-side state, so a caller cannot invent a
        // gate that authorizes it. Naming the available ones turns the
        // refusal into something actionable: a gate has to be one of these,
        // and this is where to find out which.
        availableWorkflowGates: [...context.workflowGates].sort(),
        hint: "Pass a workflowGate from availableWorkflowGates via --auth-context-json, "
          + "or run `cortex-agent task gates --project <path>` to list them.",
      },
    });
  }
  if (!state || !state.assignee) return;
  // Narrow exception: only the coordinator who created the task may submit
  // task.failed while the task is still in ASSIGNED state (before the agent
  // has accepted). This covers governed launch failures where the subprocess
  // cannot be spawned and the agent never accepted.
  // Any other coordinator attempting to fail the task is rejected.
  if (event.eventType === "task.failed" && state.state === "ASSIGNED") {
    if (state.createdBy && actorId !== state.createdBy) {
      throw new CoordinationError("ERR_ACTOR_MISMATCH", {
        details: {
          eventType: event.eventType,
          actorId,
          requiredCreator: state.createdBy,
          reason: "only the task creator may fail an assigned task before agent acceptance",
        },
      });
    }
    return; // creator may fail a task before agent acceptance
  }
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
    "ownership.rebound",
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
    // A rebind carries the *new* reference. It is checked against the fresh
    // lease, not against the stale one it replaces — that stale reference is
    // precisely what the caller is trying to move off. The replacement is
    // constrained below so that a rebind can only move forward within one
    // owner's own scope: never onto another owner's lease, never onto a
    // different scope, and never backwards to an older fencing token.
    //
    // The scope is the *anchor* of the rebind. It is looked up in the task's
    // existing ownership list, so a rebind can only ever refresh a scope the
    // task already holds. Without that anchor a rebind would be a way to
    // drop one scope and acquire another one with an unrelated lease — the
    // task would shed a scope it was still bound by, and the fencing order
    // of the scope being acquired would never be compared with the scope
    // being released.
    const rebound = event.eventType === "ownership.rebound";
    const references = rebound
      ? (Array.isArray(event.fileOwnership) ? event.fileOwnership : [])
      : ownership;
    if (rebound && references.length === 0) {
      throw new CoordinationError("ERR_LEASE_CONFLICT", {
        details: { reason: "ownership.rebound requires a replacement reference" },
      });
    }
    for (const reference of references) {
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
      // The reference metadata must describe the lease it points at. A
      // caller that hand-crafts an event could otherwise name a real leaseId
      // and its real fencing token while claiming a different scope or a
      // different owner — the checks above would pass, and the forged
      // metadata would land in the snapshot as the task's own truth.
      if (lease.scope !== reference.scope || lease.owner !== reference.owner) {
        throw new CoordinationError("ERR_LEASE_CONFLICT", {
          details: {
            reason: "ownership reference metadata does not match the lease it names",
            leaseId: reference.leaseId,
          },
        });
      }
      if (rebound) {
        // The new lease must belong to the same owner, over the same scope,
        // and carry a strictly newer fencing token than the reference it
        // replaces. Without these, a rebind would be a way to seize another
        // owner's scope or to rewind the fencing order.
        const previous = ownership.find(
          (entry) => entry && entry.scope === reference.scope,
        );
        // The scope must already be held by the task. A rebind refreshes a
        // reference; it does not establish a new one. Without an existing
        // reference for this scope there is nothing to rebind, and the
        // fencing-token comparison below has no baseline to compare with.
        if (!previous) {
          throw new CoordinationError("ERR_LEASE_CONFLICT", {
            details: {
              reason: "rebound requires an existing ownership reference for the scope",
              scope: reference.scope,
            },
          });
        }
        if (previous && previous.owner !== reference.owner) {
          throw new CoordinationError("ERR_LEASE_OWNER_MISMATCH", {
            details: {
              reason: "rebound cannot change the owner of a scope",
              scope: reference.scope,
            },
          });
        }
        if (previous && reference.fencingToken <= previous.fencingToken) {
          throw new CoordinationError("ERR_LEASE_CONFLICT", {
            details: {
              reason: "rebound requires a strictly newer fencing token",
              scope: reference.scope,
              fencingToken: reference.fencingToken,
              previousFencingToken: previous.fencingToken,
            },
          });
        }
        // The new lease must be a continuation of the one it replaces: same
        // owner, same scope. The owner and the scope are already checked
        // above, so what is left is the lineage — is this lease the successor
        // of the reference the task still holds, or an unrelated lease that
        // merely happens to carry the same owner and scope?
        //
        // Without this, a task could rebind onto a lease the owner acquired
        // for an entirely different line of work over the same scope, and
        // the audit trail would show a rebind with no history connecting the
        // two. A lease persisted by an older runtime carries no chain, so the
        // lineage cannot be walked for it — that case is accepted rather than
        // rejected, because refusing it would break the recovery path for
        // every task whose lease predates the chain field.
        if (previous && previous.leaseId && reference.leaseId
            && typeof context.leases.assessContinuitySuccessor === "function") {
          const continuity = context.leases.assessContinuitySuccessor(
            reference.leaseId,
            previous.leaseId,
          );
          if (!continuity.ok) {
            throw new CoordinationError("ERR_LEASE_CONFLICT", {
              details: {
                reason: "rebound requires the new lease to continue the replaced one",
                scope: reference.scope,
                leaseId: reference.leaseId,
                previousLeaseId: previous.leaseId,
                continuityReason: continuity.reason,
              },
            });
          }
        }
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
