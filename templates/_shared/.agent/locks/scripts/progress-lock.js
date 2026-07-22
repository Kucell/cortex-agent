#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const locksRoot = path.join(root, ".agent", "locks");
const eventsPath = path.join(locksRoot, "lock-events.json");

function usage() {
  console.log(`Usage:
  node .agent/locks/scripts/progress-lock.js acquire --scope <scope> --agent-id <agent> [--task-id <task>] [--mission-id <mission>] [--ttl-seconds 300] [--metadata-json <json>]
  node .agent/locks/scripts/progress-lock.js renew --scope <scope> --agent-id <agent> [--ttl-seconds 300]
  node .agent/locks/scripts/progress-lock.js release --scope <scope> --agent-id <agent>
  node .agent/locks/scripts/progress-lock.js list-held [--agent-id <agent>]
  node .agent/locks/scripts/progress-lock.js inspect --scope <scope>
  node .agent/locks/scripts/progress-lock.js sweep-expired
`);
}

function now() {
  return new Date().toISOString();
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

function ensureLocksRoot() {
  fs.mkdirSync(locksRoot, { recursive: true });
}

function ttl(args) {
  const value = Number(args["ttl-seconds"] || 300);
  if (!Number.isFinite(value) || value <= 0) fail("Invalid --ttl-seconds", { value: args["ttl-seconds"] });
  return Math.floor(value);
}

function expiresAt(ttlSeconds) {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function encodeScope(scope) {
  return Buffer.from(scope).toString("base64url");
}

function lockPath(scope) {
  return path.join(locksRoot, `${encodeScope(scope)}.lock.json`);
}

function relativeToRoot(targetPath) {
  return path.relative(root, targetPath).split(path.sep).join("/");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function initialEvents() {
  return { version: 1, updated_at: null, events: [] };
}

function readEvents() {
  ensureLocksRoot();
  if (!fs.existsSync(eventsPath)) return initialEvents();
  const content = fs.readFileSync(eventsPath, "utf8");
  if (!content.trim()) return initialEvents();
  const events = JSON.parse(content);
  events.version = events.version || 1;
  events.events = Array.isArray(events.events) ? events.events : [];
  return events;
}

function appendEvent(type, scope, agentId, details) {
  const events = readEvents();
  events.updated_at = now();
  events.events.push({
    event_id: `LE-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type,
    scope,
    agent_id: agentId || null,
    timestamp: now(),
    details: details || {},
  });
  writeJsonAtomic(eventsPath, events);
}

function readLock(scope) {
  const filePath = lockPath(scope);
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function isExpired(lock) {
  const expires = Date.parse(lock.expires_at);
  return !Number.isFinite(expires) || expires <= Date.now();
}

function parseMetadata(args) {
  if (!args["metadata-json"]) return {};
  return JSON.parse(args["metadata-json"]);
}

function createLock(args) {
  const scope = requireArg(args, "scope");
  const agentId = requireArg(args, "agent-id");
  const ttlSeconds = ttl(args);
  const timestamp = now();
  return {
    scope,
    held_by: agentId,
    task_id: args["task-id"] || null,
    mission_id: args["mission-id"] || null,
    acquired_at: timestamp,
    renewed_at: null,
    expires_at: expiresAt(ttlSeconds),
    ttl_seconds: ttlSeconds,
    metadata: parseMetadata(args),
  };
}

function acquire(args) {
  ensureLocksRoot();
  const scope = requireArg(args, "scope");
  const filePath = lockPath(scope);
  const lock = createLock(args);

  try {
    const fd = fs.openSync(filePath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
    fs.closeSync(fd);
    appendEvent("acquire", scope, lock.held_by, { path: relativeToRoot(filePath) });
    return print({ ok: true, action: "acquire", acquired: true, lock, path: relativeToRoot(filePath) });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = readLock(scope);
  if (existing && isExpired(existing)) {
    fs.unlinkSync(filePath);
    appendEvent("expired_removed", scope, lock.held_by, { previous_held_by: existing.held_by });
    const fd = fs.openSync(filePath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
    fs.closeSync(fd);
    appendEvent("acquire", scope, lock.held_by, { path: relativeToRoot(filePath), preempted: true });
    return print({ ok: true, action: "acquire", acquired: true, preempted: true, previous_lock: existing, lock, path: relativeToRoot(filePath) });
  }

  appendEvent("acquire_blocked", scope, lock.held_by, { held_by: existing ? existing.held_by : null });
  print({ ok: true, action: "acquire", acquired: false, blocked_by: existing, path: relativeToRoot(filePath) });
}

function renew(args) {
  const scope = requireArg(args, "scope");
  const agentId = requireArg(args, "agent-id");
  const filePath = lockPath(scope);
  const lock = readLock(scope);
  if (!lock) fail("Lock not found", { scope });
  if (lock.held_by !== agentId && !isExpired(lock)) fail("Lock held by another agent", { scope, held_by: lock.held_by });
  const ttlSeconds = ttl(args);
  lock.held_by = agentId;
  lock.renewed_at = now();
  lock.expires_at = expiresAt(ttlSeconds);
  lock.ttl_seconds = ttlSeconds;
  writeJsonAtomic(filePath, lock);
  appendEvent("renew", scope, agentId, { expires_at: lock.expires_at });
  print({ ok: true, action: "renew", lock, path: relativeToRoot(filePath) });
}

function release(args) {
  const scope = requireArg(args, "scope");
  const agentId = requireArg(args, "agent-id");
  const filePath = lockPath(scope);
  const lock = readLock(scope);
  if (!lock) return print({ ok: true, action: "release", released: false, reason: "not_found", scope });
  if (lock.held_by !== agentId && !isExpired(lock)) fail("Lock held by another agent", { scope, held_by: lock.held_by });
  fs.unlinkSync(filePath);
  appendEvent("release", scope, agentId, { previous_held_by: lock.held_by });
  print({ ok: true, action: "release", released: true, lock });
}

function lockFiles() {
  ensureLocksRoot();
  return fs.readdirSync(locksRoot)
    .filter((file) => file.endsWith(".lock.json"))
    .sort();
}

function listHeld(args) {
  const agentId = args["agent-id"] || null;
  const locks = [];
  for (const file of lockFiles()) {
    const filePath = path.join(locksRoot, file);
    const lock = readJson(filePath);
    if (agentId && lock.held_by !== agentId) continue;
    locks.push({ ...lock, expired: isExpired(lock), path: relativeToRoot(filePath) });
  }
  print({ ok: true, action: "list_held", locks });
}

function inspect(args) {
  const scope = requireArg(args, "scope");
  const filePath = lockPath(scope);
  const lock = readLock(scope);
  if (!lock) return print({ ok: true, action: "inspect", exists: false, scope, path: relativeToRoot(filePath) });
  print({ ok: true, action: "inspect", exists: true, expired: isExpired(lock), lock, path: relativeToRoot(filePath) });
}

function sweepExpired() {
  const swept = [];
  for (const file of lockFiles()) {
    const filePath = path.join(locksRoot, file);
    const lock = readJson(filePath);
    if (!isExpired(lock)) continue;
    fs.unlinkSync(filePath);
    appendEvent("expired_removed", lock.scope, null, { previous_held_by: lock.held_by });
    swept.push(lock);
  }
  print({ ok: true, action: "sweep_expired", swept });
}

function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  try {
    if (command === "acquire") return acquire(args);
    if (command === "renew") return renew(args);
    if (command === "release") return release(args);
    if (command === "list-held") return listHeld(args);
    if (command === "inspect") return inspect(args);
    if (command === "sweep-expired") return sweepExpired(args);
    usage();
    process.exit(command ? 1 : 0);
  } catch (error) {
    fail(error.message, { stack: error.stack });
  }
}

main();
