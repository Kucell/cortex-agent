#!/usr/bin/env node
"use strict";

/**
 * dashboard-supervisor entry script.
 *
 * Manual supervisor command surface:
 *   node supervisor.js status              # report current supervisor state
 *   node supervisor.js ensure              # start dashboard if not running
 *   node supervisor.js stop [--if-idle]    # stop dashboard (only when idle)
 *   node supervisor.js --help              # usage
 *
 * State file: .agent/runtime-evidence/dashboard-supervisor/state.json
 * Lock file:  .agent/runtime-evidence/dashboard-supervisor/lock
 *
 * The supervisor is default-disabled. Each command writes only when
 * the caller explicitly requested a state transition; status / help
 * never write. Concurrency is serialized via the lock directory.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_CONFIG,
  DIAGNOSTIC_CODES,
  EXIT_CODES,
  diagnostic,
  diagnosticExitCode,
  parseRfc3339,
  validateConfig,
} = require("./contracts.js");

const root = process.cwd();
const agentRoot = path.join(root, ".agent");
const evidenceRoot = path.join(agentRoot, "runtime-evidence", "dashboard-supervisor");
const stateFile = path.join(evidenceRoot, "state.json");
const lockDir = path.join(evidenceRoot, "lock");
const configFile = path.join(agentRoot, "config", "dashboard-automation.json");

const VALID_STATES = new Set(["stopped", "starting", "running", "stopping", "idle", "degraded"]);
const DEFAULT_DASHBOARD_PORT = 8787;
const HTTP_PROBE_TIMEOUT_MS = 500;

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(code, message, details = {}) {
  const diag = diagnostic(code, "error", message, details);
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message, details, diagnostics: [diag] } }, null, 2)}\n`);
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function ensureEvidenceDir() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
}

function loadConfig() {
  const raw = readJson(configFile);
  if (!raw) {
    return { ok: true, value: { ...DEFAULT_CONFIG, dashboard_root: agentRoot } };
  }
  const validation = validateConfig(raw);
  if (!validation.ok) {
    return { ok: false, error: validation };
  }
  return { ok: true, value: { ...DEFAULT_CONFIG, ...raw, dashboard_root: agentRoot } };
}

function commandRootFingerprint() {
  // Cheap stable identifier per (cwd, dashboard_root, executable).
  // Used to detect stale locks inherited from a deleted worktree.
  const cmdline = `${root}::${agentRoot}::${process.execPath}`;
  let hash = 5381;
  for (let i = 0; i < cmdline.length; i += 1) {
    hash = ((hash << 5) + hash + cmdline.charCodeAt(i)) >>> 0;
  }
  return `CMD-${hash.toString(16).padStart(8, "0")}`;
}

function loadState() {
  return readJson(stateFile, {
    schema_version: 1,
    state: "stopped",
    dashboard: null,
    updated_at: new Date().toISOString(),
    start_token: null,
    command_root: commandRootFingerprint(),
  });
}

function writeState(next) {
  const merged = { ...loadState(), ...next, updated_at: new Date().toISOString() };
  atomicWrite(stateFile, merged);
  return merged;
}

function withLock(callback) {
  ensureEvidenceDir();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      try {
        return callback();
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Busy wait: 10ms backoff, max 2s total.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  throw new Error("dashboard supervisor lock timeout");
}

function probeDashboard(port) {
  // A live dashboard answers HTTP on its localhost port. A missing
  // server raises ECONNREFUSED; treat that as "not running".
  try {
    const net = require("node:net");
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let resolved = false;
      const finish = (ok) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(HTTP_PROBE_TIMEOUT_MS);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, "127.0.0.1");
    });
  } catch (error) {
    return false;
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function commandStatus() {
  return withLock(() => {
    const state = loadState();
    return { ok: true, ...state };
  });
}

function commandEnsure() {
  return withLock(() => {
    const current = loadState();
    // Single-instance guard: if we already have a live PID, do nothing.
    if (current.dashboard && isPidAlive(current.dashboard.pid)) {
      return { ok: true, ...current };
    }
    // Preserve any pre-recorded start_token + command_root to keep the
    // identity stable across ensure restarts within the same window.
    const token = current.start_token || `T-${Date.now().toString(36)}`;
    const next = writeState({
      state: "starting",
      dashboard: {
        pid: process.pid,
        port: DEFAULT_DASHBOARD_PORT,
        started_at: new Date().toISOString(),
        reason: "manual_supervisor_ensure",
      },
      start_token: token,
      command_root: commandRootFingerprint(),
    });
    return { ok: true, ...next };
  });
}

function commandStop({ ifIdle }) {
  return withLock(() => {
    const current = loadState();
    if (current.state === "stopped") return { ok: true, ...current };
    if (ifIdle && current.state !== "idle") {
      const diag = diagnostic(
        DIAGNOSTIC_CODES.WORKLOAD_INPUT_INVALID,
        "warning",
        "Dashboard is not idle; refusing to stop.",
        { state: current.state },
      );
      return {
        ok: false,
        refused: true,
        ...current,
        diagnostics: [diag],
      };
    }
    const next = writeState({ state: "stopped", dashboard: null, start_token: null });
    return { ok: true, ...next };
  });
}

function commandHelp() {
  return {
    ok: true,
    usage: "node supervisor.js status | ensure | stop [--if-idle] | --help",
    states: Array.from(VALID_STATES),
  };
}

function main() {
  const args = process.argv.slice(2);
  const helpRequested = args.includes("--help") || args.includes("-h");
  if (helpRequested) {
    output(commandHelp());
    return;
  }
  const [command] = args;
  const config = loadConfig();
  if (!config.ok) {
    fail("invalid_config", "dashboard-automation.json failed validation", config.error);
    process.exit(diagnosticExitCode(config.error.diagnostics?.[0]?.code) || EXIT_CODES.INVALID_INPUT);
    return;
  }
  if (!config.value.enabled && command !== "status") {
    fail("supervisor_disabled", "Dashboard supervisor is default-disabled; run `auto enable` first.",
      { config_enabled: config.value.enabled });
    process.exit(EXIT_CODES.UNAVAILABLE);
    return;
  }
  try {
    let payload;
    if (command === "status") {
      payload = commandStatus();
    } else if (command === "ensure") {
      payload = commandEnsure();
    } else if (command === "stop") {
      payload = commandStop({ ifIdle: args.includes("--if-idle") });
    } else {
      fail("unsupported_command", "Use status, ensure, stop [--if-idle], or --help.", { command });
      process.exit(EXIT_CODES.INVALID_INPUT);
      return;
    }
    output(payload);
    // Exit codes: refused stop -> 1, ensure -> 0, status -> 0.
    if (payload.refused) process.exit(EXIT_CODES.CONFLICT);
  } catch (error) {
    fail("supervisor_failed", error.message, { stack: error.stack });
    process.exit(EXIT_CODES.UNAVAILABLE);
  }
}

main();