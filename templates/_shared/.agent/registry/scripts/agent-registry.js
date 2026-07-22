#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const registryPath = path.join(root, ".agent", "registry", "agents.json");
const VALID_STATUSES = new Set(["running", "paused", "completed", "failed", "handed_off"]);
const ACTIVE_STATUSES = new Set(["running", "paused"]);

function now() {
  return new Date().toISOString();
}

function usage() {
  console.log(`Usage:
  node .agent/registry/scripts/agent-registry.js check-in --agent-id <id> --role <role> --model <model> --task-id <task> [--mission-id <mission>] [--session-id <id>] [--owned-files a,b] [--pending-artifacts a,b]
  node .agent/registry/scripts/agent-registry.js heartbeat --agent-id <id>
  node .agent/registry/scripts/agent-registry.js check-out --agent-id <id> --status completed|paused|failed|handed_off
  node .agent/registry/scripts/agent-registry.js list-active [--task-id <task>]
  node .agent/registry/scripts/agent-registry.js get-conflicts --task-id <task> [--owned-files a,b] [--agent-id <id>]
  node .agent/registry/scripts/agent-registry.js mark-stale [--ttl-seconds 300]
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureRegistryDir() {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
}

function initialRegistry() {
  return {
    version: 1,
    updated_at: null,
    agents: [],
    event_log: [],
  };
}

function readRegistry() {
  ensureRegistryDir();
  if (!fs.existsSync(registryPath)) return initialRegistry();
  const content = fs.readFileSync(registryPath, "utf8");
  if (!content.trim()) return initialRegistry();
  const registry = JSON.parse(content);
  registry.version = registry.version || 1;
  registry.agents = Array.isArray(registry.agents) ? registry.agents : [];
  registry.event_log = Array.isArray(registry.event_log) ? registry.event_log : [];
  return registry;
}

function writeRegistry(registry) {
  ensureRegistryDir();
  registry.updated_at = now();
  const tmpPath = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmpPath, registryPath);
}

function eventId() {
  return `E-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function appendEvent(registry, type, agentId, taskId, details) {
  registry.event_log.push({
    event_id: eventId(),
    type,
    agent_id: agentId || null,
    task_id: taskId || null,
    timestamp: now(),
    details: details || {},
  });
}

function fail(message, details) {
  console.error(JSON.stringify({
    ok: false,
    error: message,
    details: details || {},
  }, null, 2));
  process.exit(1);
}

function print(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function requireArg(args, key) {
  if (!args[key]) fail(`Missing required --${key}`);
  return args[key];
}

function findAgent(registry, agentId) {
  return registry.agents.find((agent) => agent.agent_id === agentId);
}

function checkIn(args) {
  const registry = readRegistry();
  const timestamp = now();
  const agentId = requireArg(args, "agent-id");
  const taskId = requireArg(args, "task-id");
  const sessionId = args["session-id"] || `session-${timestamp}`;
  const nextAgent = {
    agent_id: agentId,
    role: requireArg(args, "role"),
    model: requireArg(args, "model"),
    task_id: taskId,
    mission_id: args["mission-id"] || null,
    session_id: sessionId,
    started_at: timestamp,
    last_heartbeat: timestamp,
    status: "running",
    owned_files: splitList(args["owned-files"]),
    pending_artifacts: splitList(args["pending-artifacts"]),
  };

  const existingIndex = registry.agents.findIndex((agent) => agent.agent_id === agentId);
  if (existingIndex === -1) {
    registry.agents.push(nextAgent);
  } else {
    const existing = registry.agents[existingIndex];
    registry.agents[existingIndex] = {
      ...existing,
      ...nextAgent,
      started_at: existing.started_at || timestamp,
    };
  }

  appendEvent(registry, "check_in", agentId, taskId, { role: nextAgent.role, model: nextAgent.model });
  writeRegistry(registry);
  print({ ok: true, action: "check_in", agent: nextAgent });
}

function heartbeat(args) {
  const registry = readRegistry();
  const agentId = requireArg(args, "agent-id");
  const agent = findAgent(registry, agentId);
  if (!agent) fail("Agent not found", { agent_id: agentId });
  agent.last_heartbeat = now();
  appendEvent(registry, "heartbeat", agentId, agent.task_id, { status: agent.status });
  writeRegistry(registry);
  print({ ok: true, action: "heartbeat", agent });
}

function checkOut(args) {
  const registry = readRegistry();
  const agentId = requireArg(args, "agent-id");
  const status = requireArg(args, "status");
  if (!VALID_STATUSES.has(status)) fail("Invalid status", { status, valid: Array.from(VALID_STATUSES) });
  const agent = findAgent(registry, agentId);
  if (!agent) fail("Agent not found", { agent_id: agentId });
  agent.status = status;
  agent.last_heartbeat = now();
  appendEvent(registry, "check_out", agentId, agent.task_id, { status });
  writeRegistry(registry);
  print({ ok: true, action: "check_out", agent });
}

function listActive(args) {
  const registry = readRegistry();
  const taskId = args["task-id"];
  const agents = registry.agents.filter((agent) => {
    if (!ACTIVE_STATUSES.has(agent.status)) return false;
    if (taskId && agent.task_id !== taskId) return false;
    return true;
  });
  print({ ok: true, action: "list_active", agents });
}

function getConflicts(args) {
  const registry = readRegistry();
  const taskId = requireArg(args, "task-id");
  const currentAgentId = args["agent-id"] || null;
  const requestedFiles = new Set(splitList(args["owned-files"]));
  const activeAgents = registry.agents.filter((agent) => ACTIVE_STATUSES.has(agent.status));
  const sameTask = activeAgents.filter((agent) => agent.task_id === taskId && agent.agent_id !== currentAgentId);
  const fileConflicts = [];

  if (requestedFiles.size > 0) {
    for (const agent of activeAgents) {
      if (agent.agent_id === currentAgentId) continue;
      const overlaps = (agent.owned_files || []).filter((file) => requestedFiles.has(file));
      if (overlaps.length > 0) {
        fileConflicts.push({ agent_id: agent.agent_id, task_id: agent.task_id, files: overlaps });
      }
    }
  }

  const conflicts = { same_task: sameTask, files: fileConflicts };
  if (sameTask.length > 0 || fileConflicts.length > 0) {
    appendEvent(registry, "conflict_detected", currentAgentId, taskId, conflicts);
    writeRegistry(registry);
  }

  print({
    ok: true,
    action: "get_conflicts",
    has_conflicts: sameTask.length > 0 || fileConflicts.length > 0,
    conflicts,
  });
}

function markStale(args) {
  const registry = readRegistry();
  const ttlSeconds = Number(args["ttl-seconds"] || 300);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) fail("Invalid --ttl-seconds", { ttl_seconds: args["ttl-seconds"] });
  const cutoff = Date.now() - ttlSeconds * 1000;
  const stale = [];

  for (const agent of registry.agents) {
    if (!ACTIVE_STATUSES.has(agent.status)) continue;
    const heartbeatAt = Date.parse(agent.last_heartbeat);
    if (!Number.isFinite(heartbeatAt) || heartbeatAt < cutoff) {
      agent.status = "failed";
      stale.push(agent);
      appendEvent(registry, "stale_marked", agent.agent_id, agent.task_id, { ttl_seconds: ttlSeconds });
    }
  }

  if (stale.length > 0) writeRegistry(registry);
  print({ ok: true, action: "mark_stale", stale });
}

function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  try {
    if (command === "check-in") return checkIn(args);
    if (command === "heartbeat") return heartbeat(args);
    if (command === "check-out") return checkOut(args);
    if (command === "list-active") return listActive(args);
    if (command === "get-conflicts") return getConflicts(args);
    if (command === "mark-stale") return markStale(args);
    usage();
    process.exit(command ? 1 : 0);
  } catch (error) {
    fail(error.message, { stack: error.stack });
  }
}

main();
