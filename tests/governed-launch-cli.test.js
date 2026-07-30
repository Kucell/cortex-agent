"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CoordinationApplicationService } = require("../lib/coordination/application-service");
const { createEvent, STATES } = require("../lib/coordination/contract");
const { executeGovernedLaunch } = require("../lib/governed-launch-cli");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-cli-"));
  const service = CoordinationApplicationService.open(path.join(root, ".agent-runtime", "coordination"), { journal: { lock: false } });
  const taskId = "TASK-CP11";
  const projectId = "cp11-project";
  service.submit(createEvent({ projectId, taskId, correlationId: "CP11", producer: { actorId: "coordinator", kind: "coordinator", sessionId: "coord" }, targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED, repository: { repositoryId: projectId } }), { actorId: "coordinator", kind: "coordinator", sessionId: "coord" });
  service.submit(createEvent({ projectId, taskId, correlationId: "CP11", producer: { actorId: "coordinator", kind: "coordinator", sessionId: "coord" }, targets: [{ actorId: "claude-1", kind: "agent" }], eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED, repository: { repositoryId: projectId } }), { actorId: "coordinator", kind: "coordinator", sessionId: "coord" });
  const lease = service.acquireOwnership(`task:${taskId}`, "claude-1", { actorId: "session-1" });
  return { root, service, taskId, lease };
}

function args(ctx) {
  return ["--task-id", ctx.taskId, "--agent-id", "claude-1", "--session-id", "session-1", "--lease-id", ctx.lease.leaseId, "--fencing-token", String(ctx.lease.fencingToken), "--command", "/bin/echo", "--allow-command", "/bin/echo", "--worktree", ctx.root];
}

function close(ctx) { ctx.service.close(); fs.rmSync(ctx.root, { recursive: true, force: true }); }

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("governed launch requires an assigned task and matching active fenced lease", async () => {
  const ctx = setup();
  try {
    let privateContext;
    const result = await executeGovernedLaunch(args(ctx), { service: ctx.service, projectRoot: ctx.root, executor: async (_contextFile, context) => {
      privateContext = context;
      return { pid: 42, launchedAt: "2026-07-30T00:00:00.000Z" };
    } });
    assert.equal(result.ok, true);
    assert.equal(result.spawnStatus, "accepted");
    assert.deepEqual(privateContext.agentArgs, []);
    assert.equal(ctx.service.getTask(ctx.taskId).state, STATES.ACCEPTED);
    assert.deepEqual(ctx.service.getTask(ctx.taskId).ownership, [{ leaseId: ctx.lease.leaseId, scope: `task:${ctx.taskId}`, owner: "claude-1", fencingToken: ctx.lease.fencingToken, expiresAt: ctx.lease.expiresAt }]);
  } finally { close(ctx); }
});

test("governed launch stays failed and journals task.failed when subprocess start fails", async () => {
  const ctx = setup();
  try {
    const result = await executeGovernedLaunch(args(ctx), { service: ctx.service, projectRoot: ctx.root, executor: async () => { throw new Error("spawn failed"); } });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_LAUNCH_FAILED");
    assert.equal(ctx.service.getTask(ctx.taskId).state, STATES.FAILED);
    assert.deepEqual(ctx.service.listEvents({ taskId: ctx.taskId }).map((event) => event.eventType), ["task.created", "task.assigned", "task.failed"]);
  } finally { close(ctx); }
});

test("governed launch fails closed without explicit matching allow-command or lease", async () => {
  const ctx = setup();
  try {
    const missingAllow = args(ctx).filter((value, index, values) => value !== "--allow-command" && values[index - 1] !== "--allow-command");
    const rejected = await executeGovernedLaunch(missingAllow, { service: ctx.service, projectRoot: ctx.root });
    assert.equal(rejected.code, "INVALID_USAGE");
    const badLease = args(ctx); badLease[badLease.indexOf("--fencing-token") + 1] = "99";
    const fenced = await executeGovernedLaunch(badLease, { service: ctx.service, projectRoot: ctx.root });
    assert.equal(fenced.code, "ERR_LEASE_CONFLICT");
    assert.equal(ctx.service.listEvents({ taskId: ctx.taskId }).length, 2);
  } finally { close(ctx); }
});

test("governed launch passes explicit safe args privately without journaling them", async () => {
  const ctx = setup();
  const output = path.join(ctx.root, "agent-args.txt");
  const executable = path.join(ctx.root, "capture-args.sh");
  const privatePrompt = "PRIVATE_ONE_SHOT_PROMPT_MUST_NOT_LEAK";
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CORTEX_TEST_ARGS_OUTPUT\"\nsleep 2\n", { mode: 0o755 });
  const previousOutput = process.env.CORTEX_TEST_ARGS_OUTPUT;
  process.env.CORTEX_TEST_ARGS_OUTPUT = output;
  try {
    const launchArgs = args(ctx);
    launchArgs[launchArgs.indexOf("--command") + 1] = executable;
    launchArgs[launchArgs.indexOf("--allow-command") + 1] = executable;
    launchArgs.push("--agent-arg", "--print", "--agent-arg", privatePrompt);
    const result = await executeGovernedLaunch(launchArgs, { service: ctx.service, projectRoot: ctx.root });
    assert.equal(result.ok, true);
    await wait(1100);
    assert.deepEqual(fs.readFileSync(output, "utf8").trim().split("\n"), ["--print", privatePrompt]);
    assert.equal(JSON.stringify(result).includes(privatePrompt), false);
    assert.equal(JSON.stringify(ctx.service.listEvents({ taskId: ctx.taskId })).includes(privatePrompt), false);
  } finally {
    if (previousOutput === undefined) delete process.env.CORTEX_TEST_ARGS_OUTPUT;
    else process.env.CORTEX_TEST_ARGS_OUTPUT = previousOutput;
    close(ctx);
  }
});

test("governed launch rejects unsafe or oversized explicit args without public leakage", async () => {
  const ctx = setup();
  const privatePrompt = "PRIVATE_UNSAFE_PROMPT_MUST_NOT_LEAK";
  try {
    const nul = await executeGovernedLaunch([...args(ctx), "--agent-arg", `${privatePrompt}\0`], { service: ctx.service, projectRoot: ctx.root });
    assert.equal(nul.ok, false);
    assert.equal(nul.code, "ERR_AGENT_ARGS_NUL");
    assert.equal(JSON.stringify(nul).includes(privatePrompt), false);
    const oversized = await executeGovernedLaunch([...args(ctx), "--agent-arg", "x".repeat(4097)], { service: ctx.service, projectRoot: ctx.root });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.code, "ERR_AGENT_ARG_TOO_LONG");
    const tooMany = await executeGovernedLaunch([...args(ctx), ...Array.from({ length: 65 }, () => "--agent-arg=value")], { service: ctx.service, projectRoot: ctx.root });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.code, "ERR_AGENT_ARGS_TOO_MANY");
    assert.equal(ctx.service.listEvents({ taskId: ctx.taskId }).length, 2);
  } finally { close(ctx); }
});
