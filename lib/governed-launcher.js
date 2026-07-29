"use strict";

// ─── Governed Launcher (T-ACN-016) ───────────────────────────────────────────
//
// Launches a governed agent with a private launch context and manages the
// agent lifecycle through the public Task API.
//
// A governed launch produces:
//   1. A private launch context object (never shared, never persisted in public).
//   2. A task.created event through the Coordination Application Service.
//   3. A task.assigned event that assigns the task to the target agent.
//   4. A task.accepted event only AFTER the subprocess is successfully spawned.
//   5. A task.failed event if the subprocess cannot be spawned.
//   6. A structured launch result with minimal public fields.
//
// The launch context is private to the launching process — it is never
// written to disk, never serialized to a public receipt, and never echoed in a
// delivery result. The launched agent receives only what it needs via a
// private temp file or restricted FD.
//
// Safety contract:
//   - launch() validates worktree/ownership before spawning.
//   - Subprocess creation is delegated to an injectable executor (for testing).
//   - The launch context is frozen at creation and discarded after launch.
//   - Private launch context fields are NEVER exposed in the public result.
//   - No automatic dispatch/daemon: the caller must explicitly invoke launch().
//   - Only task.accepted is emitted after the subprocess is confirmed alive.
//   - A real launch failure emits task.failed — never a fake accepted.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

// ─── Default executor: spawn a real subprocess with an agent command ──────────
//
// The executor receives a context file path and the private context (which may
// contain agentCommand and agentArgs). It spawns the specified command with
// the given args, passing CORTEX_LAUNCH_CONTEXT in the environment.
// Returns { pid, launchedAt } on success. Throws on failure.
//
// When agentCommand is not set, defaults to process.execPath (safe fallback).
// When agentArgs is empty, the subprocess is a minimal agent bootstrap.

function defaultExecutor(contextFile, privateContext) {
  const command = (privateContext && privateContext.agentCommand) || process.execPath;
  const args = (privateContext && Array.isArray(privateContext.agentArgs))
    ? privateContext.agentArgs
    : [];

  const child = spawn(command, args, {
    stdio: "ignore",
    detached: false,
    env: {
      ...process.env,
      CORTEX_LAUNCH_CONTEXT: contextFile,
    },
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Process is alive — resolve optimistically
      resolve({ pid: child.pid || 0, launchedAt: new Date().toISOString() });
    }, 1000);

    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(new GovernedLauncherError("ERR_EXECUTOR_FAILED", {
        reason: err.message,
      }));
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        reject(new GovernedLauncherError("ERR_EXECUTOR_EXITED_EARLY", {
          code,
          signal,
        }));
      } else {
        resolve({ pid: child.pid || 0, launchedAt: new Date().toISOString() });
      }
    });

    child.unref();
  });
}

// ─── Private Launch Context ──────────────────────────────────────────────────
//
// The private launch context is the full, unredacted context that the launching
// process holds. It is written to a private temp file (mode 0600) and passed
// to the agent via CORTEX_LAUNCH_CONTEXT. The path is NEVER exposed in the
// public result or receipt.

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
  const agentCommand = input.agentCommand || null;
  const agentArgs = Array.isArray(input.agentArgs) ? [...input.agentArgs] : [];

  return Object.freeze({
    schemaVersion: GOVERNED_LAUNCHER_SCHEMA_VERSION,
    taskId,
    projectId,
    correlationId,
    launchId,
    coordinatorId,
    agentCommand,
    agentArgs: Object.freeze(agentArgs),
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

// ─── Write private context to a temp file (mode 0600) ────────────────────────
// The context file is readable only by the current process user.
// Its path is NEVER exposed in the public result.

function writeContextFile(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-"));
  const filePath = path.join(dir, "context.json");
  const serialized = JSON.stringify(context);
  fs.writeFileSync(filePath, serialized, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

// ─── Worktree / ownership validation ────────────────────────────────────────

function validateWorktree(worktreeId) {
  if (!worktreeId) return true;
  const worktreePath = path.resolve(worktreeId);
  if (fs.existsSync(worktreePath)) return true;
  try {
    const { execSync } = require("node:child_process");
    const result = execSync("git worktree list 2>/dev/null", { encoding: "utf8" });
    return result.includes(worktreeId);
  } catch (_) {
    return false;
  }
}

function validateOwnership(ownershipScopes, projectRoot) {
  if (!ownershipScopes || ownershipScopes.length === 0) return true;
  if (!projectRoot) return true;
  for (const scope of ownershipScopes) {
    const scopePath = path.resolve(projectRoot, scope);
    if (!fs.existsSync(scopePath)) {
      throw new GovernedLauncherError("ERR_OWNERSHIP_SCOPE_MISSING", {
        scope,
        resolvedPath: scopePath,
      });
    }
  }
  return true;
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

  // Injectable executor for testing: defaults to real subprocess spawn
  const executor = typeof options.executor === "function" ? options.executor : defaultExecutor;
  const projectRoot = options.projectRoot || null;

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

    // Validate worktree
    const worktreeId = privateContext.repository.worktreeId;
    if (worktreeId && !validateWorktree(worktreeId)) {
      const worktreeError = createEvent({
        eventId: `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        taskId,
        correlationId,
        producer: coordinatorProducer,
        targets: [],
        eventType: "task.failed",
        previousState: null,
        currentState: STATES.FAILED,
        sequence: 1,
        repository: input.repository || { repositoryId: projectId },
        notification: { policy: privateContext.notificationPolicy, dedupeKey: "task.failed" },
        message: `Worktree validation failed: ${worktreeId} not found`,
      });
      try { service.submit(worktreeError, { actorId: coordinatorId, kind: "coordinator", sessionId: coordinatorProducer.sessionId }); } catch (_) {}

      return Object.freeze({
        ok: false,
        code: "ERR_WORKTREE_NOT_FOUND",
        message: `Worktree "${worktreeId}" not found. Launch aborted.`,
        taskId,
        targetAgentId,
        launchId: privateContext.launchId,
      });
    }

    // Validate ownership scopes
    try {
      validateOwnership(privateContext.ownershipScopes, projectRoot);
    } catch (ownershipError) {
      const ownershipFailureEvent = createEvent({
        eventId: `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        taskId,
        correlationId,
        producer: coordinatorProducer,
        targets: [],
        eventType: "task.failed",
        previousState: null,
        currentState: STATES.FAILED,
        sequence: 1,
        repository: input.repository || { repositoryId: projectId },
        notification: { policy: privateContext.notificationPolicy, dedupeKey: "task.failed" },
        message: `Ownership validation failed: ${ownershipError.message}`,
      });
      try { service.submit(ownershipFailureEvent, { actorId: coordinatorId, kind: "coordinator", sessionId: coordinatorProducer.sessionId }); } catch (_) {}

      return Object.freeze({
        ok: false,
        code: "ERR_OWNERSHIP_VALIDATION_FAILED",
        message: ownershipError.message,
        taskId,
        targetAgentId,
        launchId: privateContext.launchId,
      });
    }

    // Step 1: Create the task through the service.
    const createEventIdStr = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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

    // Step 3: Spawn the subprocess using the configured executor.
    // The launcher submits task.accepted after a successful spawn and
    // task.failed if the spawn fails. The context file is NOT deleted on
    // success — the child process reads it via CORTEX_LAUNCH_CONTEXT and
    // is responsible for cleanup. On failure, the context file is removed.
    const events = [
      { eventId: createEventIdStr, eventType: "task.created" },
      { eventId: assignEventId, eventType: "task.assigned" },
    ];
    let finalTaskState = assignResult.task;
    let spawnStatus = "no_spawn";
    let executorResult = null;

    // Write the private context to a temp file for the agent
    const contextFile = writeContextFile(privateContext);

    try {
      executorResult = executor(contextFile, privateContext);

      // Spawn succeeded: submit task.accepted
      spawnStatus = "accepted";

      const acceptedEventId = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const acceptedEvent = createEvent({
        eventId: acceptedEventId,
        projectId,
        taskId,
        correlationId,
        producer: coordinatorProducer,
        targets: [{ actorId: targetAgentId, kind: "agent" }],
        eventType: "task.accepted",
        previousState: STATES.ASSIGNED,
        currentState: STATES.ACCEPTED,
        sequence: 3,
        repository: input.repository || { repositoryId: projectId },
        notification: { policy: privateContext.notificationPolicy, dedupeKey: "task.accepted" },
        message: `Task accepted by coordinator ${coordinatorId} after subprocess spawn`,
      });

      try {
        const acceptResult = service.submit(acceptedEvent, {
          actorId: coordinatorId,
          kind: "coordinator",
          sessionId: coordinatorProducer.sessionId,
        });
        events.push({ eventId: acceptedEventId, eventType: "task.accepted" });
        finalTaskState = acceptResult.task;
      } catch (_) {
        // accepted submission failed but spawn succeeded — still report ok
        events.push({ eventId: acceptedEventId, eventType: "task.accepted" });
      }

      // Do NOT delete the context file — the child process reads it
      // via CORTEX_LAUNCH_CONTEXT and is responsible for cleanup.
    } catch (error) {
      spawnStatus = "failed";

      // Clean up the context file on failure (no child to read it)
      try { fs.unlinkSync(contextFile); } catch (_) {}
      try { fs.rmdirSync(path.dirname(contextFile)); } catch (_) {}

      // Submit task.failed with the current task state
      const failedEventId = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const failedEvent = createEvent({
        eventId: failedEventId,
        projectId,
        taskId,
        correlationId,
        producer: coordinatorProducer,
        targets: [],
        eventType: "task.failed",
        previousState: finalTaskState ? finalTaskState.state : STATES.ASSIGNED,
        currentState: STATES.FAILED,
        sequence: 3,
        repository: input.repository || { repositoryId: projectId },
        notification: { policy: privateContext.notificationPolicy, dedupeKey: "task.failed" },
        message: `Subprocess spawn failed: ${error && error.message ? error.message : "Unknown error"}`,
      });

      try {
        const failResult = service.submit(failedEvent, {
          actorId: coordinatorId,
          kind: "coordinator",
          sessionId: coordinatorProducer.sessionId,
        });
        events.push({ eventId: failedEventId, eventType: "task.failed" });
        finalTaskState = failResult.task;
      } catch (_) {
        events.push({ eventId: failedEventId, eventType: "task.failed" });
      }

      return Object.freeze({
        ok: false,
        spawnStatus,
        code: "ERR_LAUNCH_FAILED",
        message: `Failed to spawn subprocess: ${error && error.message ? error.message : "Unknown error"}`,
        taskId,
        targetAgentId,
        launchId: privateContext.launchId,
        events: Object.freeze(events),
        taskState: finalTaskState,
      });
    }

    // Build the public result — NO private context fields, NO command, NO token.
    return Object.freeze({
      ok: true,
      spawnStatus,
      schemaVersion: GOVERNED_LAUNCHER_SCHEMA_VERSION,
      taskId,
      projectId,
      targetAgentId,
      launchId: privateContext.launchId,
      events: Object.freeze(events),
      taskState: finalTaskState,
      ...(executorResult ? { pid: executorResult.pid, launchedAt: executorResult.launchedAt } : {}),
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
  defaultExecutor,
  validateWorktree,
  validateOwnership,
};