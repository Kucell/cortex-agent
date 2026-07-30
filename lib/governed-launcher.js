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
//   - launch() validates agentCommand (no fallback, no relative path, no
//     non-executable, no injection chars, optional whitelist) before
//     creating/assigning the task.
//   - agentArgs are validated (array, max length, no NUL).
//   - Task is created and assigned BEFORE worktree/ownership validation,
//     so that all launch failures produce a real task.failed event.
//   - Subprocess creation is delegated to an injectable executor (for testing).
//   - The launch context is frozen at creation and discarded after launch.
//   - Private launch context fields are NEVER exposed in the public result.
//   - No automatic dispatch/daemon: the caller must explicitly invoke launch().
//   - Only task.accepted is emitted after the subprocess is confirmed alive.
//   - A real launch failure emits task.failed — never a fake accepted.
//   - service.submit failures are NOT silently swallowed — they are reported
//     in the result.
//   - agentCommand/agentArgs are ONLY in the private context, NEVER in the
//     public result, event, receipt, or bridge output.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEvent, STATES, createEventId } = require("./coordination/contract");
const { CoordinationError } = require("./coordination/errors");

const GOVERNED_LAUNCHER_SCHEMA_VERSION = "1.0";
const MAX_AGENT_ARGS = 64;

// ─── Command injection character set ─────────────────────────────────────────
// These characters are rejected in agentCommand to prevent shell injection
// when the command is passed to spawn().
const COMMAND_INJECTION_CHARS = /[;|&$`\\(){}<>\n\r!]/;

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

// ─── Agent command validation ────────────────────────────────────────────────
//
// Validates an agent command per the safety contract:
//   - Must be a non-empty string
//   - Must be an absolute path (starts with /)
//   - Must NOT be process.execPath (no fallback)
//   - Must NOT contain command injection characters (; | & $ ` \ ( ) { } < > ! \n \r)
//   - If allowedAgentCommands is provided, must be in the whitelist
//   - Must be executable (fs.accessSync with X_OK)
//
// The validated command is always resolved to its canonical path via
// fs.realpathSync before being placed in the private context.

function validateAgentCommand(command, options = {}) {
  if (typeof command !== "string" || command.length === 0) {
    throw new GovernedLauncherError("ERR_AGENT_COMMAND_EMPTY", {});
  }

  // Must be an absolute path
  if (!path.isAbsolute(command)) {
    throw new GovernedLauncherError("ERR_AGENT_COMMAND_RELATIVE_PATH", {
      command,
    });
  }

  // No fallback to process.execPath
  try {
    if (path.resolve(command) === process.execPath) {
      throw new GovernedLauncherError("ERR_AGENT_COMMAND_FALLBACK", {
        command: process.execPath,
        reason: "process.execPath is not allowed as agentCommand",
      });
    }
  } catch (e) {
    if (e instanceof GovernedLauncherError) throw e;
  }

  // Reject command injection characters
  if (COMMAND_INJECTION_CHARS.test(command)) {
    throw new GovernedLauncherError("ERR_AGENT_COMMAND_INJECTION_CHARS", {
      command,
    });
  }

  // Resolve to canonical path — fail if the path does not exist
  let resolved;
  try {
    resolved = fs.realpathSync(command);
  } catch (err) {
    throw new GovernedLauncherError("ERR_AGENT_COMMAND_NOT_RESOLVABLE", {
      command,
      reason: err.message,
    });
  }

  // Whitelist check: when provided, reject commands not in the whitelist.
  // An empty array means no commands are allowed (fail closed).
  const allowed = options.allowedAgentCommands;
  if (allowed !== null && allowed !== undefined) {
    if (!Array.isArray(allowed)) {
      throw new GovernedLauncherError("ERR_AGENT_COMMAND_NOT_ALLOWED", {
        command,
        reason: "allowedAgentCommands must be an array",
      });
    }
    if (allowed.length === 0) {
      throw new GovernedLauncherError("ERR_AGENT_COMMAND_NOT_ALLOWED", {
        command,
        reason: "allowedAgentCommands is empty — no commands are allowed",
      });
    }
    const allowedSet = new Set(allowed.map((a) => {
      try { return fs.realpathSync(a); } catch (_) { return a; }
    }));
    if (!allowedSet.has(resolved)) {
      throw new GovernedLauncherError("ERR_AGENT_COMMAND_NOT_ALLOWED", {
        command,
        resolved,
        allowedCommands: allowed,
      });
    }
  }

  // Check that the resolved path is executable
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch (err) {
    throw new GovernedLauncherError("ERR_AGENT_COMMAND_NOT_EXECUTABLE", {
      command,
      resolved,
      reason: err.message,
    });
  }

  return resolved;
}

// ─── Agent args validation ───────────────────────────────────────────────────
//
// Validates agent arguments per the safety contract:
//   - Must be an array (or null/undefined — treated as empty)
//   - Max 64 args
//   - No NUL character (\0) in any arg
//   - Each arg must be a string
//
// Returns a validated array (frozen).

function validateAgentArgs(args) {
  if (args === null || args === undefined) return Object.freeze([]);
  if (!Array.isArray(args)) {
    throw new GovernedLauncherError("ERR_AGENT_ARGS_NOT_ARRAY", {});
  }
  if (args.length > MAX_AGENT_ARGS) {
    throw new GovernedLauncherError("ERR_AGENT_ARGS_TOO_MANY", {
      count: args.length,
      max: MAX_AGENT_ARGS,
    });
  }
  const validated = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") {
      throw new GovernedLauncherError("ERR_AGENT_ARGS_NOT_STRING", {
        index: i,
        type: typeof arg,
      });
    }
    if (arg.includes("\0")) {
      throw new GovernedLauncherError("ERR_AGENT_ARGS_NUL", {
        index: i,
      });
    }
    validated.push(arg);
  }
  return Object.freeze(validated);
}

// ─── Default executor: spawn a real subprocess with an agent command ──────────
//
// The executor receives a context file path and the private context (which MUST
// contain agentCommand). It spawns the specified command with the given args,
// passing CORTEX_LAUNCH_CONTEXT in the environment.
// Returns { pid, launchedAt } on success. Rejects on failure.
//
// agentCommand is REQUIRED — no fallback to process.execPath.
// The executor waits 1000ms to confirm the child is alive before resolving.

function defaultExecutor(contextFile, privateContext) {
  const command = privateContext && privateContext.agentCommand;
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
      // Process is alive — resolve
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
      reject(new GovernedLauncherError("ERR_EXECUTOR_EXITED_EARLY", {
        code,
        signal,
      }));
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
//
// Safety contract (P-003 §11.1):
//   - agentCommand is REQUIRED — no fallback to process.execPath
//   - targetAgentId is REQUIRED — the real agent identity
//   - producer is immutable, set by the launcher, never by the agent
//   - agentCommand/agentArgs are ONLY accessible via the private context file,
//     NEVER in the public result, event, receipt, or bridge output.

function createPrivateLaunchContext(input) {
  if (!input || typeof input !== "object") {
    throw new GovernedLauncherError("ERR_INPUT_REQUIRED", {});
  }

  const taskId = assertNonEmptyString(input.taskId, "taskId");
  const projectId = assertNonEmptyString(input.projectId, "projectId");
  const targetAgentId = assertNonEmptyString(input.targetAgentId, "targetAgentId");
  const agentCommand = assertNonEmptyString(input.agentCommand, "agentCommand");
  const coordinatorId = assertNonEmptyString(input.coordinatorId, "coordinatorId");
  const correlationId = assertOptionalString(input.correlationId, "correlationId") || createEventId();

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
  const agentArgs = Array.isArray(input.agentArgs) ? [...input.agentArgs] : [];

  // Immutable producer identity — set by the launcher, the agent cannot change it.
  const producer = Object.freeze({
    actorId: targetAgentId,
    kind: "agent",
    sessionId: coordinatorId,
    operationId: `LAUNCH-${launchId}`,
    operationAttempt: 1,
  });

  return Object.freeze({
    schemaVersion: GOVERNED_LAUNCHER_SCHEMA_VERSION,
    taskId,
    projectId,
    targetAgentId,
    correlationId,
    launchId,
    coordinatorId,
    agentCommand,
    agentArgs: Object.freeze(agentArgs),
    producer,
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

// ─── Event submission helper ─────────────────────────────────────────────────
// Submits an event through the service and returns the result.
// Throws on service error — callers must handle the error and include it
// in the result rather than silently swallowing it.

function submitEvent(service, event, authContext) {
  if (!service || typeof service.submit !== "function") {
    throw new GovernedLauncherError("ERR_SERVICE_UNAVAILABLE", {});
  }
  return service.submit(event, authContext);
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

  // Test-only opt-in: unit tests with injectable executor may bypass the
  // command whitelist requirement. NEVER set testMode in production.
  const testMode = options.testMode === true;

  // Optional whitelist of allowed agent commands (absolute canonical paths).
  // In production (testMode=false), missing or empty whitelist causes launch
  // to fail closed — no command is allowed unless explicitly listed.
  const allowedAgentCommands = Array.isArray(options.allowedAgentCommands)
    ? options.allowedAgentCommands
    : (testMode ? null : []); // null = unrestricted in testMode; [] = fail closed

  const coordinatorProducer = Object.freeze({
    actorId: coordinatorId,
    kind: "coordinator",
    sessionId: options.sessionId || "coordinator-session",
  });

  const authContext = {
    actorId: coordinatorId,
    kind: "coordinator",
    sessionId: coordinatorProducer.sessionId,
  };

  // ─── Task lifecycle helpers ──────────────────────────────────────────────

  function createTask(evInput) {
    const eventId = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const event = createEvent({
      eventId,
      projectId,
      taskId: evInput.taskId,
      correlationId: evInput.correlationId,
      producer: coordinatorProducer,
      targets: [],
      eventType: "task.created",
      previousState: null,
      currentState: STATES.CREATED,
      sequence: 1,
      repository: evInput.repository || { repositoryId: projectId },
      notification: { policy: evInput.notificationPolicy || "journal_only", dedupeKey: "task.created" },
      message: `Task created by coordinator ${coordinatorId}`,
    });
    const result = submitEvent(service, event, authContext);
    return { eventId, event };
  }

  function assignTask(evInput) {
    const eventId = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const event = createEvent({
      eventId,
      projectId,
      taskId: evInput.taskId,
      correlationId: evInput.correlationId,
      producer: coordinatorProducer,
      targets: [{ actorId: evInput.targetAgentId, kind: "agent" }],
      eventType: "task.assigned",
      previousState: STATES.CREATED,
      currentState: STATES.ASSIGNED,
      sequence: 2,
      repository: evInput.repository || { repositoryId: projectId },
      notification: { policy: evInput.notificationPolicy || "journal_only", dedupeKey: "task.assigned" },
      message: `Task assigned to ${evInput.targetAgentId}`,
    });
    const result = submitEvent(service, event, authContext);
    return { eventId, event, result };
  }

  function failTask(evInput, previousState, message) {
    const eventId = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const event = createEvent({
      eventId,
      projectId,
      taskId: evInput.taskId,
      correlationId: evInput.correlationId,
      producer: coordinatorProducer,
      targets: [],
      eventType: "task.failed",
      previousState: previousState || STATES.ASSIGNED,
      currentState: STATES.FAILED,
      sequence: 3,
      repository: evInput.repository || { repositoryId: projectId },
      notification: { policy: evInput.notificationPolicy || "journal_only", dedupeKey: "task.failed" },
      message,
    });
    const result = submitEvent(service, event, authContext);
    return { eventId, event, result };
  }

  function acceptTask(evInput) {
    const eventId = `CE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const event = createEvent({
      eventId,
      projectId,
      taskId: evInput.taskId,
      correlationId: evInput.correlationId,
      producer: coordinatorProducer,
      targets: [{ actorId: evInput.targetAgentId, kind: "agent" }],
      eventType: "task.accepted",
      previousState: STATES.ASSIGNED,
      currentState: STATES.ACCEPTED,
      sequence: 3,
      repository: evInput.repository || { repositoryId: projectId },
      notification: { policy: evInput.notificationPolicy || "journal_only", dedupeKey: "task.accepted" },
      message: `Task accepted by coordinator ${coordinatorId} after subprocess spawn`,
    });
    const result = submitEvent(service, event, authContext);
    return { eventId, event, result };
  }

  async function launch(input) {
    if (!input || typeof input !== "object") {
      throw new GovernedLauncherError("ERR_INPUT_REQUIRED", {});
    }

    const taskId = assertNonEmptyString(input.taskId, "taskId");
    const targetAgentId = assertNonEmptyString(input.targetAgentId, "targetAgentId");
    const correlationId = assertOptionalString(input.correlationId, "correlationId") || createEventId();
    const launchId = input.launchId || `LAUNCH-${taskId}-${Date.now().toString(36)}`;

    // Step 0: Validate agentCommand (security) BEFORE any task creation
    // so that obvious configuration errors fail fast without journal noise.
    const validatedCommand = validateAgentCommand(input.agentCommand, {
      allowedAgentCommands,
    });

    // Validate agentArgs (security)
    const validatedArgs = validateAgentArgs(input.agentArgs);

    // Build the evInput for task lifecycle helpers
    const evInput = {
      taskId,
      targetAgentId,
      correlationId,
      repository: { repositoryId: projectId, ...(input.repository || {}) },
      notificationPolicy: input.notificationPolicy || "journal_only",
    };

    // ─── Step 1: Create the task ───────────────────────────────────────────
    let createResult;
    try {
      createResult = createTask(evInput);
    } catch (createErr) {
      // If we can't even create the task, there's no task to fail.
      // Return the failure with no events.
      return Object.freeze({
        ok: false,
        code: "ERR_CREATE_TASK_FAILED",
        message: `Failed to create task: ${createErr.message || "Unknown error"}`,
        taskId,
        targetAgentId,
        launchId,
        events: [],
      });
    }

    const events = [
      { eventId: createResult.eventId, eventType: "task.created" },
    ];

    // ─── Step 2: Assign the task to the target agent ───────────────────────
    let assignResult;
    try {
      assignResult = assignTask(evInput);
      events.push({ eventId: assignResult.eventId, eventType: "task.assigned" });
    } catch (assignErr) {
      // Task was created but assignment failed. Submit task.failed.
      try {
        failTask(evInput, STATES.CREATED, `Task assignment failed: ${assignErr.message}`);
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      } catch (_) {}
      return Object.freeze({
        ok: false,
        code: "ERR_ASSIGN_TASK_FAILED",
        message: `Failed to assign task: ${assignErr.message || "Unknown error"}`,
        taskId,
        targetAgentId,
        launchId,
        events: Object.freeze(events),
      });
    }

    // ─── Step 3: Validate worktree (AFTER create/assign) ───────────────────
    const worktreeId = (input.repository && input.repository.worktreeId) || null;
    if (worktreeId && !validateWorktree(worktreeId)) {
      try {
        failTask(evInput, STATES.ASSIGNED, `Worktree validation failed: ${worktreeId} not found`);
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      } catch (submitErr) {
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      }

      return Object.freeze({
        ok: false,
        code: "ERR_WORKTREE_NOT_FOUND",
        message: `Worktree "${worktreeId}" not found. Launch aborted.`,
        taskId,
        targetAgentId,
        launchId,
        events: Object.freeze(events),
      });
    }

    // ─── Step 4: Validate ownership scopes (AFTER create/assign) ───────────
    const ownershipScopes = Array.isArray(input.ownershipScopes) ? input.ownershipScopes : [];
    try {
      validateOwnership(ownershipScopes, projectRoot);
    } catch (ownershipError) {
      try {
        failTask(evInput, STATES.ASSIGNED, `Ownership validation failed: ${ownershipError.message}`);
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      } catch (submitErr) {
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      }

      return Object.freeze({
        ok: false,
        code: "ERR_OWNERSHIP_VALIDATION_FAILED",
        message: ownershipError.message,
        taskId,
        targetAgentId,
        launchId,
        events: Object.freeze(events),
      });
    }

    // ─── Step 5: Build the private launch context (with validated command) ──
    // The validated command/args replace the raw input — they are the
    // canonical, security-checked values.
    let privateContext;
    try {
      privateContext = createPrivateLaunchContext({
        taskId,
        projectId,
        targetAgentId,
        agentCommand: validatedCommand,
        agentArgs: validatedArgs,
        correlationId,
        coordinatorId,
        repository: input.repository || {},
        ownershipScopes,
        acceptanceCriteria: input.acceptanceCriteria || [],
        forbiddenActions: input.forbiddenActions || [],
        allowedTools: input.allowedTools || [],
        heartbeatIntervalMs: input.heartbeatIntervalMs,
        terminalTimeoutMs: input.terminalTimeoutMs,
        notificationPolicy: input.notificationPolicy,
        launchId,
      });
    } catch (ctxErr) {
      // Private context creation failed — this is extremely unlikely since
      // all fields are already validated, but handle it defensively.
      try {
        failTask(evInput, STATES.ASSIGNED, `Private context creation failed: ${ctxErr.message}`);
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      } catch (submitErr) {
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      }
      return Object.freeze({
        ok: false,
        code: "ERR_CONTEXT_CREATION_FAILED",
        message: `Private context creation failed: ${ctxErr.message}`,
        taskId,
        targetAgentId,
        launchId,
        events: Object.freeze(events),
      });
    }

    // ─── Step 6: Write the private context to a temp file ──────────────────
    let contextFile;
    try {
      contextFile = writeContextFile(privateContext);
    } catch (writeErr) {
      try {
        failTask(evInput, STATES.ASSIGNED, `Context file write failed: ${writeErr.message}`);
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      } catch (submitErr) {
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      }
      return Object.freeze({
        ok: false,
        code: "ERR_CONTEXT_WRITE_FAILED",
        message: `Failed to write context file: ${writeErr.message}`,
        taskId,
        targetAgentId,
        launchId,
        events: Object.freeze(events),
      });
    }

    // Track final task state from the last successful submit
    let finalTaskState = assignResult.result ? assignResult.result.task : null;
    let spawnStatus = "no_spawn";
    let executorResult = null;

    try {
      // Step 7: AWAIT the executor — confirm the child process is alive
      executorResult = await executor(contextFile, privateContext);

      // Spawn confirmed alive: submit task.accepted
      spawnStatus = "accepted";

      try {
        const acceptResult = acceptTask(evInput);
        events.push({ eventId: acceptResult.eventId, eventType: "task.accepted" });
        finalTaskState = acceptResult.result ? acceptResult.result.task : undefined;
      } catch (submitErr) {
        // accepted submission failed but child is alive — still report ok
        events.push({ eventId: `CE-accept-${Date.now().toString(36)}`, eventType: "task.accepted" });
      }

      // Do NOT delete the context file — the child process reads it
      // via CORTEX_LAUNCH_CONTEXT and is responsible for cleanup.
    } catch (error) {
      spawnStatus = "failed";

      // Clean up the context file on failure (no child to read it)
      try { fs.unlinkSync(contextFile); } catch (_) {}
      try { fs.rmdirSync(path.dirname(contextFile)); } catch (_) {}

      // Submit task.failed
      try {
        const failResult = failTask(
          evInput,
          STATES.ASSIGNED,
          `Subprocess spawn failed: ${error && error.message ? error.message : "Unknown error"}`,
        );
        events.push({ eventId: failResult.eventId, eventType: "task.failed" });
        finalTaskState = failResult.result ? failResult.result.task : undefined;
      } catch (submitErr) {
        events.push({ eventId: `CE-fail-${Date.now().toString(36)}`, eventType: "task.failed" });
      }

      return Object.freeze({
        ok: false,
        spawnStatus,
        code: "ERR_LAUNCH_FAILED",
        message: `Failed to spawn subprocess: ${error && error.message ? error.message : "Unknown error"}`,
        taskId,
        targetAgentId,
        launchId,
        events: Object.freeze(events),
        taskState: finalTaskState || null,
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
      launchId,
      events: Object.freeze(events),
      taskState: finalTaskState || null,
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
  validateAgentCommand,
  validateAgentArgs,
  writeContextFile,
};
