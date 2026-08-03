#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const { createEvent, STATES } = require("../lib/coordination/contract");
const { executeGovernedLaunch } = require("../lib/governed-launch-cli");
const { defaultExecutor } = require("../lib/governed-launcher");
const CLI = path.resolve(__dirname, "../bin/cli.js");

function resolveBinary(envName, fallback) {
  const explicit = process.env[envName];
  if (explicit && path.isAbsolute(explicit)) return explicit;
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, fallback);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* continue */ }
  }
  return null;
}

const HOSTS = {
  pi: {
    command: resolveBinary("PI_BINARY", "pi"),
    args: [
      "-p", "Use the bash tool to run sleep 2, then reply with exactly HOST_OK.",
      "--approve", "--offline", "--no-session",
      "--tools", "read,bash,edit,write,grep,find,ls",
    ],
  },
  claude: {
    command: resolveBinary("CLAUDE_BINARY", "claude"),
    args: [
      "-p", "Reply with exactly HOST_OK. Do not call tools.",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence", "--safe-mode", "--tools", "",
    ],
  },
};

function submitSetup(service, host) {
  const taskId = `T-REAL-${host.toUpperCase()}-${Date.now()}`;
  const projectId = "governed-real-host-validation";
  const coordinator = { actorId: "validation-coordinator", kind: "coordinator", sessionId: "validation-root" };
  const agentId = `${host}-real-host`;
  const sessionId = `session-${host}-real-host`;
  service.submit(createEvent({
    projectId, taskId, correlationId: `CORR-${taskId}`, producer: coordinator,
    targets: [], eventType: "task.created", previousState: null,
    currentState: STATES.CREATED, repository: { repositoryId: projectId },
  }), coordinator);
  service.submit(createEvent({
    projectId, taskId, correlationId: `CORR-${taskId}`, producer: coordinator,
    targets: [{ actorId: agentId, kind: "agent" }], eventType: "task.assigned",
    previousState: STATES.CREATED, currentState: STATES.ASSIGNED,
    repository: { repositoryId: projectId },
  }), coordinator);
  const lease = service.acquireOwnership(`task:${taskId}`, agentId, { actorId: sessionId, ttl: 60_000 });
  return { taskId, projectId, coordinator, agentId, sessionId, lease };
}

function handoffPrompt() {
  const progress = `node ${CLI} agent report --event-type task.progress --message real-host-validation`;
  const testing = `node ${CLI} agent report --event-type task.testing --message real-host-testing`;
  const ready = `node ${CLI} agent report --event-type task.ready_for_review --message real-host-ready --evidence-ref ARTIFACT-REAL-HOST`;
  return `Use the bash tool to run: ${progress} && ${testing} && ${ready}. Then reply with exactly HOST_OK.`;
}

function hostArgs(host, handoff) {
  if (host === "pi") {
    return [
      "-p", handoff ? handoffPrompt() : "Use the bash tool to run sleep 2, then reply with exactly HOST_OK.",
      "--approve", "--offline", "--no-session",
      "--tools", "read,bash,edit,write,grep,find,ls",
    ];
  }
  return [
    "-p", handoff ? handoffPrompt() : "Reply with exactly HOST_OK. Do not call tools.",
    "--permission-mode", "bypassPermissions", "--no-session-persistence",
    "--safe-mode", "--tools", handoff ? "Bash" : "",
  ];
}

function launchArgs(state, host, root, handoff) {
  const spec = HOSTS[host];
  const args = [
    "--task-id", state.taskId, "--agent-id", state.agentId,
    "--session-id", state.sessionId, "--lease-id", state.lease.leaseId,
    "--fencing-token", String(state.lease.fencingToken),
    "--command", spec.command, "--allow-command", spec.command,
    "--worktree", root, "--terminal-timeout-ms", "120000",
  ];
  for (const value of hostArgs(host, handoff)) args.push("--agent-arg", value);
  return args;
}

async function waitForReceipt(file, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("receipt timeout");
}

async function validateHost(host, handoff) {
  const spec = HOSTS[host];
  if (!spec || !fs.existsSync(spec.command)) return { host, skipped: true, reason: "binary_unavailable" };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cortex-real-${host}-`));
  fs.mkdirSync(path.join(root, ".agent"), { mode: 0o700 });
  const runtimeDir = path.join(root, ".agent-runtime", "coordination");
  let service = CoordinationApplicationService.open(runtimeDir);
  const state = submitSetup(service, host);
  let contextFile;
  const result = await executeGovernedLaunch(launchArgs(state, host, root, handoff), {
    service,
    projectRoot: root,
    executor(file, context) {
      contextFile = file;
      return defaultExecutor(file, context);
    },
    releaseService() {
      service.close();
    },
  });
  if (!result.ok) throw new Error(`${host} launch failed: ${result.code}`);
  const receiptFile = path.join(path.dirname(contextFile), "child-receipt.json");
  const receipt = await waitForReceipt(receiptFile);
  service = CoordinationApplicationService.open(runtimeDir);
  const task = service.getTask(state.taskId);
  const lease = service.leases.getLease(state.lease.leaseId);
  service.close();
  const privateDirMode = fs.statSync(path.dirname(contextFile)).mode & 0o777;
  const stderrMode = fs.statSync(path.join(path.dirname(contextFile), "stderr.log")).mode & 0o777;
  const publicReceipt = {
    host,
    launchPhase: result.launchPhase,
    taskState: task.state,
    receiptCode: receipt.code,
    receiptOutcome: receipt.outcome,
    leaseReleased: Boolean(lease && lease.releasedAt),
    privateDirMode: privateDirMode.toString(8),
    stderrMode: stderrMode.toString(8),
    stderrBytes: receipt.stderrBytes,
    stderrSha256Present: typeof receipt.stderrSha256 === "string",
    handoffRequested: handoff,
  };
  if (process.env.CORTEX_REAL_HOST_KEEP !== "1") {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(contextFile), { recursive: true, force: true });
  }
  return publicReceipt;
}

async function main() {
  const handoff = process.argv.includes("--handoff");
  const requested = process.argv.slice(2).filter((value) => value !== "--handoff");
  const hosts = requested.length > 0 ? requested : Object.keys(HOSTS);
  const results = [];
  for (const host of hosts) results.push(await validateHost(host, handoff));
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: "REAL_HOST_VALIDATION_FAILED", message: error.message })}\n`);
  process.exitCode = 1;
});
