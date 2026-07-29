#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const invocationRoot = fs.realpathSync(process.cwd());
const invocationAgentPath = path.join(invocationRoot, ".agent");
const agentRoot = fs.realpathSync(invocationAgentPath);
const supportRoot = path.join(agentRoot, "skills", "dashboard-supervisor", "scripts");
const supportScripts = ["contracts.js", "workload-classifier.js", "root-resolution.js"];
for (const supportScript of supportScripts) {
  const supportPath = path.join(supportRoot, supportScript);
  if (!fs.existsSync(supportPath)) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: "DASHBOARD_SUPERVISOR_UNAVAILABLE",
        message: "Target project is missing Dashboard Supervisor support files; run `cortex-agent update`.",
        details: { path: supportPath },
      },
    }, null, 2)}\n`);
    process.exit(3);
  }
}
const {
  DEFAULT_CONFIG,
  EXIT_CODES,
  validateConfig,
} = require(path.join(supportRoot, "contracts.js"));
const { classifyWorkloads } = require(path.join(supportRoot, "workload-classifier.js"));
const { resolveDashboardRoots } = require(path.join(supportRoot, "root-resolution.js"));
const configFile = path.join(agentRoot, "config", "dashboard-automation.json");
const runtimeRoot = path.join(agentRoot, "runtime-evidence", "dashboard-supervisor");
const stateFile = path.join(runtimeRoot, "state.json");
const lockDir = path.join(runtimeRoot, "lock");
const ownerFile = path.join(runtimeRoot, "owner.json");
const dashboardOwnerFile = path.join(runtimeRoot, "dashboard-owner.json");
const stopRequestFile = path.join(runtimeRoot, "stop-request.json");
const managementScript = path.join(agentRoot, "skills", "management-api", "scripts", "index.js");
const dashboardScript = path.join(agentRoot, "skills", "agent-dashboard", "scripts", "serve.js");

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(code, message, details = {}, exitCode = EXIT_CODES.UNAVAILABLE) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: { code, message, details },
  }, null, 2)}\n`);
  process.exitCode = exitCode;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function withLock(callback) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
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
      sleep(10);
    }
  }
  throw new Error("dashboard supervisor lock timeout");
}

function loadConfig() {
  const raw = readJson(configFile, DEFAULT_CONFIG);
  const config = { ...DEFAULT_CONFIG, ...raw };
  const validation = validateConfig(config);
  if (!validation.ok) {
    const error = new Error("dashboard-automation.json failed validation");
    error.code = "invalid_config";
    error.details = validation;
    throw error;
  }
  return config;
}

function defaultState(config = loadConfig()) {
  return {
    schema_version: 1,
    status: config.enabled ? "enabled_idle" : "disabled",
    agent_root: agentRoot,
    dashboard_root: config.dashboard_root || invocationRoot,
    supervisor_pid: null,
    dashboard_pid: null,
    url: null,
    started_at: null,
    last_heartbeat_at: null,
    last_active_at: null,
    idle_deadline_at: null,
    last_reason: null,
    last_error: null,
  };
}

function loadState(config = loadConfig()) {
  return { ...defaultState(config), ...(readJson(stateFile, {}) || {}) };
}

function writeState(patch, config = loadConfig()) {
  const state = { ...loadState(config), ...patch };
  atomicWrite(stateFile, state);
  return state;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function processCwd(pid) {
  if (process.platform === "linux") {
    try {
      return fs.realpathSync(`/proc/${pid}/cwd`);
    } catch (_) {
      return null;
    }
  }
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith("n"));
  if (!line) return null;
  try {
    return fs.realpathSync(line.slice(1));
  } catch (_) {
    return null;
  }
}

function processHasEnvironment(pid, name, value) {
  const expected = `${name}=${value}`;
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(expected);
    } catch (_) {
      return false;
    }
  }
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.split(/\s+/).includes(expected);
}

function isOwnedSupervisor(state, config) {
  if (!isPidAlive(state.supervisor_pid)) return false;
  if (state.agent_root !== agentRoot || state.dashboard_root !== config.dashboard_root) return false;
  const owner = readJson(ownerFile);
  if (!owner
    || owner.pid !== state.supervisor_pid
    || owner.agent_root !== agentRoot
    || owner.dashboard_root !== config.dashboard_root
    || typeof owner.token !== "string"
    || owner.token.length < 16) {
    return false;
  }
  const heartbeat = Date.parse(state.last_heartbeat_at || "");
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > Math.max(10000, config.poll_interval_ms * 3)) {
    return false;
  }
  const command = processCommand(state.supervisor_pid);
  return command.includes(__filename)
    && command.includes("__daemon")
    && processCwd(state.supervisor_pid) === config.dashboard_root;
}

function isOwnedDashboard(owner, config) {
  if (!owner || !isPidAlive(owner.pid)) return false;
  if (owner.agent_root !== agentRoot || owner.dashboard_root !== config.dashboard_root) return false;
  if (typeof owner.supervisor_token !== "string" || owner.supervisor_token.length < 16) return false;
  const command = processCommand(owner.pid);
  return command.includes(dashboardScript)
    && processCwd(owner.pid) === config.dashboard_root
    && processHasEnvironment(owner.pid, "CORTEX_DASHBOARD_OWNER_TOKEN", owner.supervisor_token);
}

function resolveRoots(config, operation) {
  const resolved = resolveDashboardRoots({
    project: invocationRoot,
    configuredDashboardRoot: config.dashboard_root,
    operation,
  });
  if (!resolved.ok) {
    const error = new Error(resolved.diagnostics[0].message);
    error.code = resolved.diagnostics[0].code;
    error.exitCode = resolved.exit_code;
    error.details = resolved.diagnostics[0].details;
    throw error;
  }
  return resolved;
}

function spawnDaemon(config) {
  return withLock(() => {
    const current = loadState(config);
    if (isOwnedSupervisor(current, config)) return current;
    const owner = resolveRoots(config, "ensure");
    const token = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const child = spawn(process.execPath, [__filename, "__daemon"], {
      cwd: owner.dashboard_root,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CORTEX_DASHBOARD_SUPERVISOR_TOKEN: token,
      },
    });
    atomicWrite(ownerFile, {
      schema_version: 1,
      pid: child.pid,
      token,
      agent_root: agentRoot,
      dashboard_root: owner.dashboard_root,
      started_at: now(),
    });
    child.unref();
    return writeState({
      status: current.dashboard_pid ? "recovering" : "enabled_idle",
      dashboard_root: owner.dashboard_root,
      supervisor_pid: child.pid,
      started_at: now(),
      last_heartbeat_at: now(),
      idle_deadline_at: null,
      last_reason: "supervisor_started",
      last_error: null,
    }, config);
  });
}

function stopSupervisor(config, ifIdle, finalStatus) {
  if (ifIdle && config.enabled) {
    const roots = resolveRoots(config, "ensure");
    const workloads = queryWorkloads(roots.dashboard_root);
    if (workloads.active) {
      return { ok: false, refused: true, ...loadState(config), active_reasons: workloads.reasons };
    }
  }
  return withLock(() => {
    const current = loadState(config);
    if (isOwnedSupervisor(current, config)) {
      if (ifIdle) {
        atomicWrite(stopRequestFile, {
          schema_version: 1,
          if_idle: true,
          requested_at: now(),
          final_status: finalStatus,
        });
        process.kill(current.supervisor_pid, "SIGUSR1");
        return { ...current, ok: true, stopping: true, recheck: "daemon" };
      }
      process.kill(current.supervisor_pid, "SIGTERM");
      return { ...current, ok: true, stopping: true };
    }
    return {
      ok: true,
      ...writeState({
        status: finalStatus,
        supervisor_pid: null,
        dashboard_pid: null,
        url: null,
        idle_deadline_at: null,
        last_reason: "stop_requested",
      }, config),
    };
  });
}

function commandStatus(config) {
  const state = loadState(config);
  const supervisorAlive = isPidAlive(state.supervisor_pid);
  const dashboardAlive = isPidAlive(state.dashboard_pid);
  return {
    ok: true,
    ...state,
    supervisor_alive: supervisorAlive,
    dashboard_alive: dashboardAlive,
    invocation_root: invocationRoot,
  };
}

function commandEnsure(config) {
  if (!config.enabled) {
    return {
      ok: true,
      enabled: false,
      action: "none",
      reason: "supervisor_disabled",
    };
  }
  return { ok: true, ...spawnDaemon(config) };
}

function commandAutoStatus(config) {
  return {
    ok: true,
    enabled: config.enabled,
    config_path: configFile,
    state: commandStatus(config),
  };
}

function commandAutoEnable(config) {
  const roots = resolveRoots(config, "enable");
  const next = {
    ...config,
    enabled: true,
    dashboard_root: roots.dashboard_root,
  };
  atomicWrite(configFile, next);
  const state = spawnDaemon(next);
  return {
    ok: true,
    enabled: true,
    transitioned_at: now(),
    trigger_source: "manual_auto_enable",
    state,
  };
}

function commandAutoDisable(config) {
  const next = { ...config, enabled: false };
  atomicWrite(configFile, next);
  const state = stopSupervisor(next, false, "disabled");
  return {
    ok: true,
    enabled: false,
    transitioned_at: now(),
    trigger_source: "manual_auto_disable",
    state,
  };
}

function queryWorkloads(ownerRoot) {
  if (!fs.existsSync(managementScript)) {
    throw new Error(`missing Management API: ${managementScript}`);
  }
  const result = spawnSync(process.execPath, [managementScript, "query", "dashboard-state"], {
    cwd: ownerRoot,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Management API exited with ${result.status}`);
  }
  const projection = JSON.parse(result.stdout);
  return classifyWorkloads(projection, {
    now: now(),
    startOn: loadConfig().start_on,
    excludeRoles: loadConfig().exclude_roles,
  });
}

function startDashboard(config, state, supervisorToken, onExit) {
  if (!fs.existsSync(dashboardScript)) {
    throw new Error(`missing Dashboard server: ${dashboardScript}`);
  }
  const child = spawn(process.execPath, [
    dashboardScript,
    "--port", String(config.requested_port),
    "--interval-ms", String(config.refresh_interval_ms),
  ], {
    cwd: config.dashboard_root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CORTEX_DASHBOARD_OWNER_TOKEN: supervisorToken,
    },
  });
  atomicWrite(dashboardOwnerFile, {
    schema_version: 1,
    pid: child.pid,
    supervisor_pid: process.pid,
    supervisor_token: supervisorToken,
    agent_root: agentRoot,
    dashboard_root: config.dashboard_root,
    started_at: now(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    try {
      const startup = JSON.parse(stdout);
      withLock(() => {
        if (readJson(ownerFile)?.token !== supervisorToken) return;
        writeState({
        status: "running",
        dashboard_pid: child.pid,
        url: startup.url,
        last_heartbeat_at: now(),
        idle_deadline_at: null,
        last_reason: "dashboard_started",
        last_error: null,
        }, config);
      });
    } catch (_) {
      // serve.js emits one pretty-printed JSON object after startup.
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  child.once("exit", (code, signal) => {
    onExit(child);
    const dashboardOwner = readJson(dashboardOwnerFile);
    if (dashboardOwner?.pid === child.pid) fs.rmSync(dashboardOwnerFile, { force: true });
    withLock(() => {
      if (readJson(ownerFile)?.token !== supervisorToken) return;
      writeState({
      status: config.enabled ? "enabled_idle" : "disabled",
      dashboard_pid: null,
      url: null,
      idle_deadline_at: null,
      last_reason: "dashboard_exited",
      last_error: code === 0 || signal === "SIGTERM" ? null : {
        code: "dashboard_exited",
        message: stderr || `Dashboard exited with code ${code}`,
        at: now(),
        details: { code, signal },
      },
      }, config);
    });
  });
  if (readJson(ownerFile)?.token === supervisorToken) {
    writeState({
      status: "starting",
      dashboard_pid: child.pid,
      url: null,
      last_heartbeat_at: now(),
      last_reason: state.last_reason || "active_workload_detected",
      last_error: null,
    }, config);
  }
  return child;
}

function runDaemon() {
  let config = loadConfig();
  const owner = resolveRoots(config, "ensure");
  const supervisorToken = process.env.CORTEX_DASHBOARD_SUPERVISOR_TOKEN;
  let dashboard = null;
  let stopping = false;

  function ownsDaemon() {
    const recorded = readJson(ownerFile);
    return typeof supervisorToken === "string"
      && recorded?.pid === process.pid
      && recorded?.token === supervisorToken
      && recorded?.agent_root === agentRoot
      && recorded?.dashboard_root === owner.dashboard_root;
  }

  function stopDashboard() {
    if (dashboard && isPidAlive(dashboard.pid)) dashboard.kill("SIGTERM");
    dashboard = null;
  }

  function exitAfterOwnershipLost() {
    if (stopping) return;
    stopping = true;
    stopDashboard();
    const recordedDashboard = readJson(dashboardOwnerFile);
    if (recordedDashboard?.supervisor_token === supervisorToken
      && isOwnedDashboard(recordedDashboard, config)) {
      process.kill(recordedDashboard.pid, "SIGTERM");
    }
    process.exit(0);
  }

  function writeDaemonState(patch) {
    if (!ownsDaemon()) return null;
    return writeState(patch, config);
  }

  function finish(reason) {
    if (stopping) return;
    if (!ownsDaemon()) {
      exitAfterOwnershipLost();
      return;
    }
    stopping = true;
    stopDashboard();
    const recordedDashboard = readJson(dashboardOwnerFile);
    if (recordedDashboard?.supervisor_token === supervisorToken
      && isOwnedDashboard(recordedDashboard, config)) {
      process.kill(recordedDashboard.pid, "SIGTERM");
    }
    const latest = loadConfig();
    withLock(() => writeDaemonState({
      status: latest.enabled ? "stopped" : "disabled",
      supervisor_pid: null,
      dashboard_pid: null,
      url: null,
      idle_deadline_at: null,
      last_heartbeat_at: now(),
      last_reason: reason,
    }, latest));
    fs.rmSync(stopRequestFile, { force: true });
    if (readJson(ownerFile)?.token === supervisorToken) fs.rmSync(ownerFile, { force: true });
    process.exit(0);
  }

  process.once("SIGINT", () => finish("SIGINT"));
  process.once("SIGTERM", () => finish("SIGTERM"));
  process.once("SIGHUP", () => finish("SIGHUP"));

  function recoverOrphanDashboard() {
    const recorded = readJson(dashboardOwnerFile);
    if (!recorded || recorded.supervisor_pid === process.pid) return;
    if (isPidAlive(recorded.supervisor_pid)) return;
    if (isOwnedDashboard(recorded, config)) {
      process.kill(recorded.pid, "SIGTERM");
      for (let attempt = 0; attempt < 100 && isPidAlive(recorded.pid); attempt += 1) sleep(20);
    }
    fs.rmSync(dashboardOwnerFile, { force: true });
  }

  function tick() {
    if (stopping) return;
    try {
      if (!ownsDaemon()) {
        exitAfterOwnershipLost();
        return;
      }
      config = loadConfig();
      if (!config.enabled) {
        finish("policy_disabled");
        return;
      }
      const workloads = queryWorkloads(owner.dashboard_root);
      if (!ownsDaemon()) {
        exitAfterOwnershipLost();
        return;
      }
      const stopRequest = readJson(stopRequestFile);
      if (stopRequest?.if_idle) {
        fs.rmSync(stopRequestFile, { force: true });
        if (!workloads.active) {
          finish("stop_if_idle");
          return;
        }
      }
      const current = loadState(config);
      const dashboardAlive = dashboard && isPidAlive(dashboard.pid);
      if (dashboardAlive && workloads.active) {
        writeDaemonState({
          status: "running",
          supervisor_pid: process.pid,
          dashboard_pid: dashboard.pid,
          last_heartbeat_at: now(),
          last_active_at: now(),
          idle_deadline_at: null,
          last_reason: workloads.reasons[0]?.code || "active_workload_detected",
        }, config);
      } else if (!dashboardAlive && workloads.trigger_active) {
        dashboard = startDashboard(config, {
          ...current,
          last_reason: workloads.trigger_reasons[0]?.code || "active_workload_detected",
        }, supervisorToken, (exited) => {
          if (dashboard === exited) dashboard = null;
        });
      } else if (dashboardAlive) {
        const deadline = current.idle_deadline_at
          || new Date(Date.now() + config.idle_shutdown_ms).toISOString();
        if (Date.now() >= Date.parse(deadline)) {
          stopDashboard();
          writeDaemonState({
            status: "enabled_idle",
            dashboard_pid: null,
            url: null,
            idle_deadline_at: null,
            last_heartbeat_at: now(),
            last_reason: "idle_deadline_elapsed",
          }, config);
        } else {
          writeDaemonState({
            status: "idle_grace",
            dashboard_pid: dashboard.pid,
            last_heartbeat_at: now(),
            idle_deadline_at: deadline,
            last_reason: "workload_became_idle",
          }, config);
        }
      } else {
        writeDaemonState({
          status: "enabled_idle",
          supervisor_pid: process.pid,
          dashboard_pid: null,
          url: null,
          idle_deadline_at: null,
          last_heartbeat_at: now(),
          last_reason: "no_active_workload",
        }, config);
      }
    } catch (error) {
      withLock(() => writeDaemonState({
        status: "degraded",
        supervisor_pid: process.pid,
        last_heartbeat_at: now(),
        last_reason: "supervisor_tick_failed",
        last_error: {
          code: error.code || "supervisor_tick_failed",
          message: error.message,
          at: now(),
          details: {},
        },
      }, config));
    }
  }

  if (!ownsDaemon()) process.exit(3);
  recoverOrphanDashboard();
  withLock(() => writeDaemonState({
    status: "enabled_idle",
    dashboard_root: owner.dashboard_root,
    supervisor_pid: process.pid,
    dashboard_pid: null,
    url: null,
    started_at: now(),
    last_heartbeat_at: now(),
    last_reason: "daemon_started",
    last_error: null,
  }, config));
  tick();
  process.on("SIGUSR1", tick);
  setInterval(tick, Math.max(1000, config.poll_interval_ms));
}

function commandHelp() {
  return {
    ok: true,
    usage: "cortex-agent dashboard status|ensure|stop [--if-idle]|auto status|enable|disable --project <path>",
    default_enabled: false,
    mcp_writer: false,
  };
}

function main() {
  const [command, subcommand] = process.argv.slice(2);
  if (command === "__daemon") {
    runDaemon();
    return;
  }
  if (!command || command === "--help" || command === "-h") {
    output(commandHelp());
    return;
  }
  try {
    const config = loadConfig();
    if (command === "status") {
      output(commandStatus(config));
    } else if (command === "ensure") {
      output(commandEnsure(config));
    } else if (command === "stop") {
      const result = stopSupervisor(config, process.argv.includes("--if-idle"), config.enabled ? "stopped" : "disabled");
      output(result);
      if (result.refused) process.exitCode = EXIT_CODES.CONFLICT;
    } else if (command === "auto" && subcommand === "status") {
      output(commandAutoStatus(config));
    } else if (command === "auto" && subcommand === "enable") {
      output(commandAutoEnable(config));
    } else if (command === "auto" && subcommand === "disable") {
      output(commandAutoDisable(config));
    } else {
      fail("unsupported_command", "Use status, ensure, stop [--if-idle], auto status|enable|disable, or --help.", {}, EXIT_CODES.INVALID_INPUT);
    }
  } catch (error) {
    fail(error.code || "supervisor_failed", error.message, error.details || {}, error.exitCode || EXIT_CODES.UNAVAILABLE);
  }
}

main();
