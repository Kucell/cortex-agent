"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DAEMON_SCHEMA_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 2000;

function runtimeRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), ".agent-runtime", "control-service");
}

function statePath(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "daemon-state.json");
}

function ownerPath(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "daemon-owner.json");
}

function lockPath(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "lifecycle.lock");
}

function now() {
  return new Date().toISOString();
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function defaultState(projectRoot) {
  return {
    schema_version: DAEMON_SCHEMA_VERSION,
    enabled: false,
    status: "disabled",
    agent_root: path.join(path.resolve(projectRoot), ".agent"),
    pid: null,
    poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
    started_at: null,
    last_heartbeat_at: null,
    stopped_at: null,
    last_trigger_id: null,
    last_dispatch_run_id: null,
    last_error: null,
  };
}

function readState(projectRoot) {
  return {
    ...defaultState(projectRoot),
    ...(readJson(statePath(projectRoot), {}) || {}),
  };
}

function writeState(projectRoot, patch) {
  const state = {
    ...readState(projectRoot),
    ...patch,
    schema_version: DAEMON_SCHEMA_VERSION,
  };
  atomicWrite(statePath(projectRoot), state);
  return state;
}

function readOwner(projectRoot) {
  return readJson(ownerPath(projectRoot), null);
}

function writeOwner(projectRoot, owner) {
  atomicWrite(ownerPath(projectRoot), owner);
  return owner;
}

function clearOwner(projectRoot) {
  fs.rmSync(ownerPath(projectRoot), { force: true });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function acquireLifecycleLock(projectRoot, fn) {
  const dir = lockPath(projectRoot);
  fs.mkdirSync(runtimeRoot(projectRoot), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      atomicWrite(path.join(dir, "owner.json"), {
        pid: process.pid,
        acquired_at: now(),
      });
      try {
        return fn();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const lockOwner = readJson(path.join(dir, "owner.json"), null);
      if (lockOwner && isPidAlive(lockOwner.pid)) {
        const busy = new Error("daemon lifecycle lock is held by a live process");
        busy.code = "ERR_DAEMON_LIFECYCLE_BUSY";
        busy.details = { pid: lockOwner.pid };
        throw busy;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const error = new Error("unable to acquire daemon lifecycle lock");
  error.code = "ERR_DAEMON_LIFECYCLE_LOCK";
  throw error;
}

module.exports = {
  DAEMON_SCHEMA_VERSION,
  DEFAULT_POLL_INTERVAL_MS,
  runtimeRoot,
  statePath,
  ownerPath,
  lockPath,
  now,
  atomicWrite,
  readJson,
  defaultState,
  readState,
  writeState,
  readOwner,
  writeOwner,
  clearOwner,
  isPidAlive,
  acquireLifecycleLock,
};
