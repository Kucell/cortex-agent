"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const {
  DEFAULT_POLL_INTERVAL_MS,
  acquireLifecycleLock,
  now,
  readOwner,
  readState,
  writeOwner,
  writeState,
  clearOwner,
  isPidAlive,
} = require("./daemon-state.js");

const HOST_PATH = path.join(__dirname, "daemon-host.js");

function sleep(ms) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
}

function processCommand(pid) {
  if (!isPidAlive(pid)) return "";
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function isOwnedLiveDaemon(projectRoot) {
  const state = readState(projectRoot);
  const owner = readOwner(projectRoot);
  const live = Boolean(
    owner
    && state.pid === owner.pid
    && isPidAlive(owner.pid)
    && processCommand(owner.pid).includes("daemon-host.js")
    && processCommand(owner.pid).includes("__run"),
  );
  return { state, owner, live };
}

function startDaemon(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const pollInterval = Number.isInteger(options.poll_interval_ms)
    ? Math.max(1000, options.poll_interval_ms)
    : DEFAULT_POLL_INTERVAL_MS;

  return acquireLifecycleLock(root, () => {
    const current = isOwnedLiveDaemon(root);
    if (current.live) {
      return {
        ok: true,
        started: false,
        idempotent: true,
        state: current.state,
      };
    }

    if (current.owner || (current.state.enabled && current.state.pid)) {
      clearOwner(root);
      writeState(root, {
        enabled: false,
        status: "degraded",
        pid: null,
        stopped_at: now(),
        last_error: {
          code: "STALE_DAEMON_OWNER_RECOVERED",
          message: "stale daemon owner/process state was recovered before start",
          at: now(),
        },
      });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const child = spawn(
      process.execPath,
      [HOST_PATH, "__run", root, String(pollInterval)],
      {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CORTEX_CONTROL_DAEMON_TOKEN: token,
        },
      },
    );

    writeOwner(root, {
      schema_version: 1,
      pid: child.pid,
      token,
      project_root: root,
      started_at: now(),
    });
    writeState(root, {
      enabled: true,
      status: "starting",
      pid: child.pid,
      poll_interval_ms: pollInterval,
      started_at: now(),
      last_heartbeat_at: null,
      stopped_at: null,
      last_error: null,
    });
    child.unref();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      sleep(50);
      const state = readState(root);
      if (state.status === "running" && state.pid === child.pid) {
        return {
          ok: true,
          started: true,
          idempotent: false,
          state,
        };
      }
      if (state.status === "degraded") {
        return {
          ok: false,
          started: false,
          idempotent: false,
          state,
        };
      }
    }

    return {
      ok: false,
      started: true,
      idempotent: false,
      state: readState(root),
      error: {
        code: "ERR_DAEMON_START_TIMEOUT",
        message: "daemon child did not become running before timeout",
      },
    };
  });
}

function statusDaemon(projectRoot) {
  const root = path.resolve(projectRoot);
  const current = isOwnedLiveDaemon(root);
  const stale = Boolean(
    current.state.enabled
    && ["starting", "running", "stopping"].includes(current.state.status)
    && !current.live,
  );

  return {
    ok: true,
    read_only: true,
    live: current.live,
    stale_owner: stale,
    state: current.state,
  };
}

function stopDaemon(projectRoot) {
  const root = path.resolve(projectRoot);
  return acquireLifecycleLock(root, () => {
    const current = isOwnedLiveDaemon(root);
    if (!current.live) {
      clearOwner(root);
      const state = writeState(root, {
        enabled: false,
        status: "stopped",
        pid: null,
        stopped_at: now(),
      });
      return {
        ok: true,
        stopped: false,
        idempotent: true,
        state,
      };
    }

    writeState(root, {
      enabled: true,
      status: "stopping",
      last_heartbeat_at: now(),
    });
    process.kill(current.owner.pid, "SIGTERM");

    for (let attempt = 0; attempt < 60; attempt += 1) {
      sleep(50);
      if (!isPidAlive(current.owner.pid)) break;
      const state = readState(root);
      if (state.status === "stopped" && state.pid === null) break;
    }

    const remaining = isOwnedLiveDaemon(root);
    if (remaining.live) {
      return {
        ok: false,
        stopped: false,
        idempotent: false,
        state: remaining.state,
        error: {
          code: "ERR_DAEMON_STOP_TIMEOUT",
          message: "daemon did not stop before timeout",
        },
      };
    }

    clearOwner(root);
    const state = writeState(root, {
      enabled: false,
      status: "stopped",
      pid: null,
      stopped_at: readState(root).stopped_at || now(),
    });
    return {
      ok: true,
      stopped: true,
      idempotent: false,
      state,
    };
  });
}

module.exports = {
  HOST_PATH,
  processCommand,
  isOwnedLiveDaemon,
  startDaemon,
  statusDaemon,
  stopDaemon,
};
