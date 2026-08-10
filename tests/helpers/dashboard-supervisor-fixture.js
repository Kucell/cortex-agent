"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SUPERVISOR = path.join(ROOT, "lib", "dashboard", "supervisor.js");

function randomPort() {
  return 30000 + Math.floor(Math.random() * 20000);
}

function writeExecutable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, { encoding: "utf8", mode: 0o755 });
}

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-supervisor-"));
  const agentRoot = path.join(root, ".agent");
  fs.mkdirSync(path.join(agentRoot, "config"), { recursive: true });
  fs.cpSync(
    path.join(ROOT, "templates", "_shared", ".agent", "skills", "dashboard-supervisor"),
    path.join(agentRoot, "skills", "dashboard-supervisor"),
    { recursive: true },
  );
  fs.writeFileSync(path.join(agentRoot, "config", "dashboard-automation.json"), `${JSON.stringify({
    schema_version: 1,
    enabled: false,
    mode: "active-workload",
    dashboard_root: null,
    requested_port: options.port || randomPort(),
    refresh_interval_ms: 1000,
    poll_interval_ms: 1000,
    idle_shutdown_ms: options.idleShutdownMs ?? 200,
    start_on: ["session_running", "run_running", "task_active"],
    exclude_roles: ["dashboard-manager", "runtime-continuity"],
    localhost_only: true,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(agentRoot, "test-workloads.json"), `${JSON.stringify({
    tasks: [],
    runs: [],
    sessions: [],
    queues: [],
    worktrees: [],
  }, null, 2)}\n`);
  writeExecutable(
    path.join(agentRoot, "skills", "management-api", "scripts", "index.js"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const payload = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".agent", "test-workloads.json"), "utf8"));
process.stdout.write(JSON.stringify({ ok: true, query: "dashboard-state", ...payload }));
`,
  );
  writeExecutable(
    path.join(agentRoot, "skills", "agent-dashboard", "scripts", "serve.js"),
    `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
const index = args.indexOf("--port");
const port = Number(index >= 0 ? args[index + 1] : 8787);
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ ok: true, url: "http://127.0.0.1:" + port, port }));
});
function stop() { server.close(() => process.exit(0)); }
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
`,
  );
  return { root, agentRoot };
}

function callSupervisor(root, args) {
  const result = spawnSync(process.execPath, [SUPERVISOR, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    payload: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function setWorkloads(fixture, workloads) {
  fs.writeFileSync(
    path.join(fixture.agentRoot, "test-workloads.json"),
    `${JSON.stringify({
      tasks: [],
      runs: [],
      sessions: [],
      queues: [],
      worktrees: [],
      ...workloads,
    }, null, 2)}\n`,
  );
}

function readState(fixture) {
  return JSON.parse(fs.readFileSync(
    path.join(fixture.agentRoot, "runtime-evidence", "dashboard-supervisor", "state.json"),
    "utf8",
  ));
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function probe(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function cleanupFixture(fixture) {
  try {
    callSupervisor(fixture.root, ["auto", "disable"]);
  } catch (_) {
    // Best-effort cleanup for failed assertions.
  }
  try {
    await waitFor(() => {
      try {
        return !readState(fixture).supervisor_pid;
      } catch (_) {
        return true;
      }
    }, 3000);
  } catch (_) {
    try {
      const state = readState(fixture);
      if (state.supervisor_pid) process.kill(state.supervisor_pid, "SIGKILL");
      if (state.dashboard_pid) process.kill(state.dashboard_pid, "SIGKILL");
    } catch (_) {
      // Nothing left to stop.
    }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

module.exports = {
  SUPERVISOR,
  callSupervisor,
  cleanupFixture,
  createFixture,
  probe,
  readState,
  setWorkloads,
  waitFor,
};
