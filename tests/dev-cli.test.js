"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function createProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dev-cli-"));
  for (const relative of [
    ".agent/skills/agent-dashboard/scripts/serve.js",
    ".agent/skills/agent-dashboard/scripts/generate.js",
    ".agent/skills/agent-dashboard/vendor/markdown-it.min.js",
    ".agent/skills/management-api/scripts/index.js",
    ".agent/skills/management-api/scripts/normalize-token-usage.js",
    ".agent/skills/management-api/scripts/projection-registry.json",
  ]) {
    const target = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  for (const directory of ["metrics", "sessions", "runs", "queues", "inbox", "decisions", "waitpoints"]) {
    fs.mkdirSync(path.join(cwd, ".agent", directory), { recursive: true });
  }
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, LANG: "en_US.UTF-8" } });
}

function waitFor(check, timeoutMs = 8000, label = "cortex-agent dev") {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = check();
        if (value) return resolve(value);
      } catch (_) {}
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

test("dev validates project and numeric options", (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dev-empty-"));
  const cwd = createProject();
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.match(run(empty, ["dev"]).stderr, /missing \.agent directory/);
  for (const [args, message] of [
    [["dev", "--port", "abc"], /--port must be an integer/],
    [["dev", "--port", "0"], /--port must be between 1 and 65535/],
    [["dev", "--port", "65536"], /--port must be between 1 and 65535/],
    [["dev", "--interval-ms", "999"], /--interval-ms must be between 1000 and 3600000/],
  ]) {
    const result = run(cwd, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, message);
  }
});

test("dev shifts ports, heartbeats, closes, and leaves scripts reusable", async (t) => {
  const cwd = createProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const blocker = http.createServer((_req, res) => res.end("occupied"));
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const sessionId = "S-dev-cli-test";
  const sessionFile = path.join(cwd, ".agent", "sessions", `${sessionId}.json`);
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [CLI, "dev", "--port", String(port), "--interval-ms", "1000", "--session-id", sessionId], {
    cwd,
    env: { ...process.env, LANG: "en_US.UTF-8", AGENT_DASHBOARD_HEARTBEAT_MS: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  let running;
  try {
    running = await waitFor(() => {
      if (!fs.existsSync(sessionFile)) return null;
      const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      return session.status === "running" ? session : null;
    });
  } catch (error) {
    throw new Error(`${error.message}; child=${child.exitCode}/${child.signalCode}; stdout=${stdout}; stderr=${stderr}`);
  }
  assert.equal(running.agent_id, "dashboard-manager");
  assert.ok(running.server.port > port, `expected a fallback port above occupied ${port}`);
  const dashboardUrl = new RegExp(`http://127\\.0\\.0\\.1:${running.server.port}`);
  await waitFor(() => dashboardUrl.test(stdout), 8000, "dashboard URL");
  const firstHeartbeat = running.last_heartbeat_at;
  await waitFor(() => JSON.parse(fs.readFileSync(sessionFile, "utf8")).last_heartbeat_at !== firstHeartbeat, 8000, "session heartbeat");

  child.kill("SIGTERM");
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 143, signal: null }, stderr);
  const closed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(closed.status, "closed");
  assert.equal(closed.updated_by_gate, "owner");

  const generate = path.join(cwd, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
  assert.equal(spawnSync(process.execPath, [generate], { cwd, encoding: "utf8" }).status, 0);
  const management = path.join(cwd, ".agent", "skills", "management-api", "scripts", "index.js");
  const query = spawnSync(process.execPath, [management, "query", "sessions"], { cwd, encoding: "utf8" });
  assert.equal(query.status, 0, query.stderr);
  assert.equal(JSON.parse(query.stdout).sessions.find((item) => item.session_id === sessionId).status, "closed");
});

test("help lists dev and generic management query options", () => {
  const result = run(ROOT, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /dev \[options\]\s+Start the live project dashboard/);
  assert.match(result.stdout, /query <projection>\s+Query a project Management API and output JSON/);
  assert.match(result.stdout, /--project <path>\s+Target an explicit project/);
});
