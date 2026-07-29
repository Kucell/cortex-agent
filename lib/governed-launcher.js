"use strict";

// ─── Governed Launcher (T-ACN-016) ───────────────────────────────────────────
//
// Launches a governed agent with a private launch context and manages the
// agent lifecycle through the public Task API.
//
// A governed launch produces:
//   1. A private launch context object (never shared, never persisted).
//   2. A task.created event through the Coordination Application Service.
//   3. A task.assigned event that assigns the task to the target agent.
//   4. A structured launch result with the task identity and context.
//
// The launch context is private to the launching process — it is never
// written to disk, never serialized to a receipt, and never echoed in a
// delivery result. The launched agent receives only what it needs via the
// reporter pattern.
//
// Safety contract:
//   - launch() never writes to disk, spawns processes, or makes network calls.
//   - All side effects are delegated to the caller-provided `service` (the
//     CoordinationApplicationService).
//   - The launch context is frozen at creation and discarded after launch.
//   - Private launch context fields are NEVER exposed to the agent.
//   - No automatic dispatch/daemon: the caller must explicitly invoke launch().

const { createEvent, STATES, createEventId } = require("./coordination/contract");
const { CoordinationError } = require("./coordination/errors");

const GOVERNED_LAUNCHER_SCHEMA_VERSION = "1.0";

class GovernedLauncherError extends Error {
  constructor(code, details) {
    super(`[governed-launcher:${code}] ${JSON.stringify(details || {})}`);
    this.name = "GovernedLauncherError";
    this.code = code;
    this.details = details || {};
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new GovernedLauncherError("ERR_FIELD_INVALID", { field });
  }
  return value;
}

function assertOptionalString(value, field) {
  if (value !== null && value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new GovernedLauncherError("ERR_FIELD_INVALID", { field });
  }
  return value || null;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GovernedLauncherError("ERR_FIELD_INVALID", { field, reason: "must be a plain object" });
  }
  return value;
}

function assertOptionalPlainObject(value, field) {
  if (value === null || value === undefined) return null;
  return assertPlainObject(value, field);
}

// ─── Private Launch Context ──────────────────────────────────────────────────
//
// The private launch context is the full, unredacted context that the launching
// process holds. It is NEVER passed to the agent, never persisted to a receipt,
// and never exposed via the CLI. The agent receives only a slimmed-down version
// via the Agent Reporter.
//
// Fields:
//   taskId         — stable task identifier
//   projectId      — project this task belongs to
//   correlationId  — correlation identifier for event grouping
//   repository     — repository context (id, branch, worktree)
//   ownershipScopes — filesystem paths or module scopes the agent owns
//   acceptanceCriteria — criteria for task completion
//   forbiddenActions — actions the agent must not perform
//   allowedTools    — tool whitelist for the agent
//   heartbeatIntervalMs — interval between heartbeat reports
//   terminalTimeoutMs — timeout before the task is considered stale
//   notificationPolicy — notification policy for this task
//   coordinatorId   — identity of the coordinating entity
//   launchedAt      — ISO timestamp of launch
//   launchId        — unique launch identifier

function createPrivateLaunchContext(input) {
  if (!input || typeof input !== "object") {
    throw new GovernedLauncherError("ERR_INPUT_REQUIRED", {});
  }

  const taskId = assertNonEmptyString(input.taskId, "taskId");
  const projectId = assertNonEmptyString(input.projectId, "projectId");
  const correlationId = assertOptionalString(input.correlationId, "correlationId") || createEventId();
  const coordinatorId = assertNonEmptyString(input.coordinatorId, "coordinatorId");

  const repository = input.repository || {};
  const ownershipScopes = Array.isArray(input.ownershipScopes) ? [...input.ownershipScopes] : [];
  const acceptanceCriteria = Array.isArray(input.acceptanceCriteria) ? [...input.acceptanceCriteria] : [];
  const forbiddenActions = Array.isArray(input.forbiddenActions) ? [...input.forbiddenActions] : [];
  const allowedTools = Array.isArray(input.allowedTools) ? [...input.allowedTools] : [];

  const heartbeatIntervalMs = Number.isSafeInteger(input.heartbeatIntervalMs) && input.heartbeatIntervalMs > 0
    ? input.heartbeatIntervalMs
    : 30000;
  const terminalTimeoutMs = Number.isSafeInteger(input.terminalTimeoutMs) && input.terminalTimeoutMs > 0
    ? input.terminalTimeoutMs
    : 300000;
  const notificationPolicy = input.notificationPolicy || "journal_only";
  const launchedAt = input.launchedAt || new Date().toISOString();
  const launchId = input.launchId || `LAUNCH-${taskId}-${Date.now().toString(36)}`;

  return Object.freeze({
    schemaVersion: GOVERNED_LAUNCHER_SCHEMA_VERSION,
    taskId,
    projectId,
    correlationId,
    launchId,
    coordinatorId,
    repository: Object.freeze({
      repositoryId: repository.repositoryId || projectId,
      worktreeId: repository.worktreeId || null,
      branch: repository.branch || null,
      baselineCommit: repository.baselineCommit || null,
    }),
    ownershipScopes: Object.freeze(ownershipScopes),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    forbiddenActions: Object.freeze(forbiddenActions),
    allowedTools: Object.freeze(allowedTools),
    heartbeatIntervalMs,
    terminalTimeoutMs,
    notificationPolicy,
    launchedAt,
  });
}

// ─── Governed Launcher ───────────────────────────────────────────────────────

function createGovernedLauncher(service, options) {
  if (!options || typeof options !== "object") {
    throw new GovernedLauncherError("ERR_OPTIONS_REQUIRED", {});
  }
  const coordinatorId = assertNonEmptyString(options.coordinatorId, "coordinatorId");
  const projectId = assertNonEmptyString(options.projectId, "projectId");

  if (!service || typeof service.submit !== "function") {
    throw new GovernedLauncherError("ERR_SERVICE_REQUIRED", {});
  }

  const coordinatorProducer = Object.freeze({
    actorId: coordinatorId,
    kind: "coordinator",
    sessionId: options.sessionId || "coordinator-session",
  });

  function launch(input) {
    if (!input || typeof input !== "object") {
      throw new GovernedLauncherError("ERR_INPUT_REQUIRED", {});
    }

    const taskId = assertNonEmptyString(input.taskId, "taskId");
    const targetAgentId = assertNonEmptyString(input.targetAgentId, "targetAgentId");
    const correlationId = assertOptionalString(input.correlationId, "correlationId") || createEventId();

    // Build the private launch context (never shared with the agent).
    const privateContext = createPrivateLaunchContext({
      taskId,
      projectId,
      correlationId,
      coordinatorId,
      repository: input.repository || {},
      ownershipScopes: input.ownershipScopes || [],
      acceptanceCriteria: input.acceptanceCriteria || [],
      forbiddenActions: input.forbiddenActions || [],
      allowedTools: input.allowedTools || [],
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      terminalTimeoutMs: input.terminalTimeoutMs,
      notificationPolicy: input.notificationPolicy,
      launchId: input.launchId,
    });

    // Publish the agent-public launch context (slimmed-down, no private fields).
    const publicContext = Object.freeze({
      taskId: privateContext.taskId,
      projectId: privateContext.projectId,
      correlationId: privateContext.correlationId,
      launchId: privateContext.launchId,
      repository: privateContext.repository,
      ownershipScopes: privateContext.ownershipScopes,
      acceptanceCriteria: privateContext.acceptanceCriteria,
      forbiddenActions: privateContext.forbiddenActions,
      allowedTools: privateContext.allowedTools,
      heartbeatIntervalMs: privateContext.heartbeatIntervalMs,
      notificationPolicy: privateContext.notificationPolicy,
      coordinatorId: privateContext.coordinatorId,
    });

    // Step 1: Create the task through the service.
    const createEventIdStr = input.createEventId || `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const createdEvent = createEvent({
      eventId: createEventIdStr,
      projectId,
      taskId,
      correlationId,
      producer: coordinatorProducer,
      targets: [],
      eventType: "task.created",
      previousState: null,
      currentState: STATES.CREATED,
      sequence: 1,
      repository: input.repository || { repositoryId: projectId },
      notification: { policy: privateContext.notificationPolicy, dedupeKey: "task.created" },
      message: `Task created by coordinator ${coordinatorId}`,
    });

    const createResult = service.submit(createdEvent, {
      actorId: coordinatorId,
      kind: "coordinator",
      sessionId: coordinatorProducer.sessionId,
    });

    // Step 2: Assign the task to the target agent.
    const assignEventId = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const assignedEvent = createEvent({
      eventId: assignEventId,
      projectId,
      taskId,
      correlationId,
      producer: coordinatorProducer,
      targets: [{ actorId: targetAgentId, kind: "agent" }],
      eventType: "task.assigned",
      previousState: STATES.CREATED,
      currentState: STATES.ASSIGNED,
      sequence: 2,
      repository: input.repository || { repositoryId: projectId },
      notification: { policy: privateContext.notificationPolicy, dedupeKey: "task.assigned" },
      message: `Task assigned to ${targetAgentId}`,
    });

    const assignResult = service.submit(assignedEvent, {
      actorId: coordinatorId,
      kind: "coordinator",
      sessionId: coordinatorProducer.sessionId,
    });

    return Object.freeze({
      ok: true,
      schemaVersion: GOVERNED_LAUNCHER_SCHEMA_VERSION,
      taskId,
      projectId,
      targetAgentId,
      launchId: privateContext.launchId,
      privateContext,
      publicContext,
      events: Object.freeze([
        { eventId: createEventIdStr, eventType: "task.created" },
        { eventId: assignEventId, eventType: "task.assigned" },
      ]),
      taskState: assignResult.task,
    });
  }

  return Object.freeze({
    coordinatorId,
    projectId,
    producer: coordinatorProducer,
    launch,
    schemaVersion: GOVERNED_LAUNCHER_SCHEMA_VERSION,
  });
}

module.exports = {
  GOVERNED_LAUNCHER_SCHEMA_VERSION,
  GovernedLauncherError,
  createGovernedLauncher,
  createPrivateLaunchContext,
};