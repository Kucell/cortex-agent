"use strict";

// Public, one-shot entry point for an already assigned task.  It deliberately
// does not create tasks, acquire leases, or choose a command: those are human
// approved actions performed before this boundary.
const fs = require("node:fs");
const path = require("node:path");
const { createEvent, STATES } = require("./coordination/contract");
const { createPrivateLaunchContext, defaultExecutor, validateAgentCommand, validateAgentArgs, writeContextFile } = require("./governed-launcher");

function flag(args, name) {
  const marker = `--${name}`;
  const inline = args.find((value) => value.startsWith(`${marker}=`));
  if (inline) return inline.slice(marker.length + 1);
  const index = args.indexOf(marker);
  return index < 0 ? undefined : args[index + 1];
}

function repeatedFlag(args, name) {
  const marker = `--${name}`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === marker) {
      const next = args[index + 1];
      if (typeof next !== "string") return null;
      values.push(next);
      index += 1;
    } else if (typeof value === "string" && value.startsWith(`${marker}=`)) {
      values.push(value.slice(marker.length + 1));
    }
  }
  return values;
}

function fail(code, message, exitCode = 2) { return { ok: false, code, message, exitCode }; }

async function executeGovernedLaunch(args, dependencies = {}) {
  const projectRoot = path.resolve(dependencies.projectRoot || process.cwd());
  const service = dependencies.service;
  if (!service) return fail("COORDINATION_SERVICE_UNAVAILABLE", "Coordination Application Service is not configured.", 3);
  const taskId = flag(args, "task-id");
  const targetAgentId = flag(args, "agent-id");
  const sessionId = flag(args, "session-id");
  const leaseId = flag(args, "lease-id");
  const token = Number(flag(args, "fencing-token"));
  const command = flag(args, "command");
  const allowCommand = flag(args, "allow-command");
  const explicitAgentArgs = repeatedFlag(args, "agent-arg");
  const worktree = flag(args, "worktree") || projectRoot;
  const timeoutRaw = flag(args, "terminal-timeout-ms");
  const terminalTimeoutMs = timeoutRaw === undefined ? 300000 : Number(timeoutRaw);
  if (![taskId, targetAgentId, sessionId, leaseId, command, allowCommand].every((v) => typeof v === "string" && v.length > 0)
      || !Number.isInteger(token)) return fail("INVALID_USAGE", "launch requires --task-id --agent-id --session-id --lease-id --fencing-token --command and --allow-command.");
  if (explicitAgentArgs === null) return fail("INVALID_USAGE", "Each --agent-arg requires an explicit string value.");
  if (!Number.isInteger(terminalTimeoutMs) || terminalTimeoutMs < 1000 || terminalTimeoutMs > 3600000) return fail("INVALID_USAGE", "--terminal-timeout-ms must be between 1000 and 3600000.");
  if (!path.isAbsolute(worktree) || path.resolve(worktree) !== projectRoot || !fs.existsSync(worktree)) return fail("ERR_WORKTREE_REQUIRED", "--worktree must be the existing explicit project worktree.");
  const agentRoot = path.join(worktree, ".agent");
  try {
    const canonicalAgentRoot = fs.realpathSync(agentRoot);
    if (!fs.statSync(canonicalAgentRoot).isDirectory()) {
      return fail("AGENT_ROOT_INVALID", "The target worktree .agent must resolve to a directory.", 3);
    }
  } catch (_) {
    return fail("AGENT_ROOT_INVALID", "The target worktree requires a physical or valid symlink .agent directory.", 3);
  }
  if (!service.leases) return fail("ERR_LEASE_CONFLICT", "Durable ownership lease manager is unavailable.", 3);
  const task = service.getTask(taskId);
  if (!task || task.state !== STATES.ASSIGNED || task.assignee !== targetAgentId) return fail("ERR_TASK_NOT_APPROVED", "Task must already be assigned to the requested agent.", 3);
  const lease = service.leases.getLease(leaseId);
  if (!lease || !service.leases.isActive(lease) || lease.scope !== `task:${taskId}` || lease.owner !== targetAgentId
      || lease.actorId !== sessionId || lease.fencingToken !== token || service.leases.getFencingToken(lease.scope) !== token) {
    return fail("ERR_LEASE_CONFLICT", "An active matching task ownership lease is required.", 3);
  }
  let validatedCommand;
  let validatedArgs;
  try {
    // The command must be repeated in the explicit allowlist; no implicit host default.
    validatedCommand = validateAgentCommand(command, { allowedAgentCommands: [allowCommand] });
    // Args are opt-in only: omitting --agent-arg passes an empty list, never
    // a host-specific default or an implicit prompt.
    validatedArgs = validateAgentArgs(explicitAgentArgs);
  } catch (error) { return fail(error.code || "ERR_COMMAND_REJECTED", "Command or agent arguments were rejected.", 3); }
  const context = createPrivateLaunchContext({
    taskId, projectId: task.projectId, targetAgentId, coordinatorId: task.createdBy,
    sessionId,
    leaseId,
    fencingToken: token,
    agentCommand: validatedCommand, agentArgs: validatedArgs,
    repository: { repositoryId: task.projectId, worktreeId: worktree },
    ownershipScopes: [`task:${taskId}`], forbiddenActions: ["push", "merge", "credential_access"],
    terminalTimeoutMs,
  });
  let contextFile;
  try { contextFile = writeContextFile(context); } catch (_) { return fail("ERR_CONTEXT_WRITE_FAILED", "Private launch context could not be created.", 3); }
  const executor = dependencies.executor || defaultExecutor;
  const producer = { actorId: targetAgentId, kind: "agent", sessionId };
  const auth = { actorId: targetAgentId, kind: "agent", sessionId };
  let subprocessStarted = false;
  try {
    const launched = await executor(contextFile, context);
    subprocessStarted = true;
    const accepted = createEvent({ projectId: task.projectId, taskId, correlationId: task.correlationId,
      producer, targets: [], eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED,
      // The absolute worktree is private launch context only; coordination
      // events intentionally never journal local filesystem paths.
      repository: { repositoryId: task.projectId },
      fileOwnership: [{ leaseId, scope: lease.scope, owner: targetAgentId, fencingToken: token, expiresAt: lease.expiresAt }], message: "Task accepted after governed subprocess start" });
    const submitted = service.submit(accepted, auth);
    // The acceptance marker is also the monitor's permission to open the
    // coordination journal. Release the CLI-owned writer before publishing
    // that marker so a fast child exit cannot race the launcher lock.
    if (typeof dependencies.releaseService === "function") {
      dependencies.releaseService();
    }
    fs.writeFileSync(path.join(path.dirname(contextFile), ".accepted"), "accepted\n", {
      mode: 0o600,
      flag: "wx",
    });
    return {
      ok: true,
      taskId,
      targetAgentId,
      // Keep the 1.x field for compatibility while exposing the precise phase.
      spawnStatus: "accepted",
      launchPhase: "task_accepted",
      pid: launched.pid,
      launchedAt: launched.launchedAt,
      taskState: submitted.task,
    };
  } catch (error) {
    // A started process must never be rewritten as a synthetic spawn failure.
    // Its context remains available for the host to report recovery/progress.
    if (subprocessStarted) {
      return fail("ERR_ACCEPTANCE_RECORD_FAILED", "Subprocess started but acceptance could not be recorded.", 3);
    }
    try {
      const created = service.listEvents({ taskId }).find((event) => event.eventType === "task.created");
      const failureProducer = created && created.producer && created.producer.actorId === task.createdBy
        ? created.producer
        : producer;
      const failed = createEvent({ projectId: task.projectId, taskId, correlationId: task.correlationId,
        producer: failureProducer, targets: [], eventType: "task.failed", previousState: STATES.ASSIGNED, currentState: STATES.FAILED,
        repository: { repositoryId: task.projectId }, message: "Governed subprocess failed to start" });
      service.submit(failed, { actorId: failureProducer.actorId, kind: failureProducer.kind, sessionId: failureProducer.sessionId });
    } catch (_) { /* the launch remains failed even if the journal is unavailable */ }
    try { fs.unlinkSync(contextFile); fs.rmdirSync(path.dirname(contextFile)); } catch (_) {}
    return fail("ERR_LAUNCH_FAILED", "Governed subprocess failed to start.", 3);
  }
}

module.exports = { executeGovernedLaunch };
