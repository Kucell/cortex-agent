"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, ".agent", "skills", "agent-dashboard", "scripts", "serve.js");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dashboard-lifecycle-"));
  const server = path.join(cwd, ".agent", "skills", "agent-dashboard", "scripts", "serve.js");
  fs.mkdirSync(path.dirname(server), { recursive: true });
  fs.copyFileSync(SERVER, server);
  write(path.join(cwd, ".agent", "skills", "agent-dashboard", "scripts", "generate.js"), [
    "const fs = require('fs');",
    "const path = require('path');",
    "if (process.env.GENERATOR_FAIL === '1') process.exit(7);",
    "const index = process.argv.indexOf('--out');",
    "const out = process.argv[index + 1];",
    "fs.mkdirSync(path.dirname(out), { recursive: true });",
    "fs.writeFileSync(out, '<html><body>ready</body></html>');",
  ].join("\n"));
  write(path.join(cwd, ".agent", "skills", "management-api", "scripts", "index.js"), [
    "const fs = require('fs');",
    "const path = require('path');",
    "const action = process.argv[3];",
    "fs.mkdirSync(path.join(process.cwd(), '.agent', 'metrics'), { recursive: true });",
    "fs.appendFileSync(path.join(process.cwd(), '.agent', 'metrics', 'writer.log'), action + '\\n');",
    "if (process.env.WRITER_FAIL_ACTION === action) process.exit(9);",
    "if (process.env.WRITER_HANG_ACTION === action) setInterval(() => {}, 1000);",
    "else process.stdout.write(JSON.stringify({ ok: true, action }));",
  ].join("\n"));
  return cwd;
}

function launch(cwd, args = [], env = {}) {
  const child = spawn(process.execPath, [path.join(cwd, ".agent", "skills", "agent-dashboard", "scripts", "serve.js"), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }) };
}

function waitForExit(running, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      running.child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for exit: ${JSON.stringify(running.output())}`));
    }, timeoutMs);
    running.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ...running.output() });
    });
    running.child.once("error", reject);
  });
}

function waitForReady(running, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const match = running.output().stdout.match(/"port":\s*(\d+)/);
      if (match) return resolve(Number(match[1]));
      if (running.child.exitCode !== null) return reject(new Error(`Server exited before ready: ${JSON.stringify(running.output())}`));
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ready: ${JSON.stringify(running.output())}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitFor(check, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("Timed out waiting for condition"));
      setTimeout(poll, 25);
    };
    poll();
  });
}

test("reports dependency, generation, and Session open failures before ready", async (t) => {
  const missing = createProject();
  fs.rmSync(path.join(missing, ".agent", "skills", "management-api", "scripts", "index.js"));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  let result = await waitForExit(launch(missing, ["--port", "0"]));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"error":"startup_dependency_missing"/);
  assert.doesNotMatch(result.stdout, /"ok": true/);

  const generation = createProject();
  t.after(() => fs.rmSync(generation, { recursive: true, force: true }));
  result = await waitForExit(launch(generation, ["--port", "0"], { GENERATOR_FAIL: "1" }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"error":"initial_generation_failed"/);
  assert.doesNotMatch(result.stdout, /"url"/);

  const writer = createProject();
  t.after(() => fs.rmSync(writer, { recursive: true, force: true }));
  result = await waitForExit(launch(writer, ["--port", "0"], { WRITER_FAIL_ACTION: "open" }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"error":"session_open_failed"/);
  assert.doesNotMatch(result.stdout, /"url"/);
});

test("writer timeout is bounded and never reports ready", async (t) => {
  const cwd = createProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const started = Date.now();
  const result = await waitForExit(launch(cwd, ["--port", "0"], { WRITER_HANG_ACTION: "open" }), 7000);
  assert.equal(result.code, 1);
  assert.ok(Date.now() - started < 6500);
  assert.match(result.stderr, /"error":"session_open_failed"/);
  assert.doesNotMatch(result.stdout, /"url"/);
});

test("uses an independent heartbeat and closes once on SIGHUP with an open socket", async (t) => {
  const cwd = createProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const running = launch(cwd, ["--port", "0", "--interval-ms", "60000"], { AGENT_DASHBOARD_HEARTBEAT_MS: "100" });
  t.after(() => { if (running.child.exitCode === null) running.child.kill("SIGKILL"); });
  const port = await waitForReady(running);
  const socket = net.connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const log = path.join(cwd, ".agent", "metrics", "writer.log");
  await waitFor(() => fs.readFileSync(log, "utf8").includes("heartbeat"));

  const started = Date.now();
  running.child.kill("SIGHUP");
  const result = await waitForExit(running, 5000);
  assert.equal(result.code, 129, result.stderr);
  assert.ok(Date.now() - started < 4500, "shutdown must have a finite keep-alive deadline");
  const actions = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(actions[0], "open");
  assert.ok(actions.includes("heartbeat"));
  assert.equal(actions.filter((action) => action === "close").length, 1);
});

test("SIGINT, SIGTERM, and SIGHUP each close the Session exactly once", async (t) => {
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    const cwd = createProject();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const running = launch(cwd, ["--port", "0"]);
    await waitForReady(running);
    running.child.kill(signal);
    const result = await waitForExit(running);
    assert.equal(result.code, exitCode, `${signal}: ${result.stderr}`);
    const actions = fs.readFileSync(path.join(cwd, ".agent", "metrics", "writer.log"), "utf8").trim().split("\n");
    assert.equal(actions.filter((action) => action === "close").length, 1, signal);
  }
});

test("returns structured port_exhausted at the upper port boundary", async (t) => {
  const blocker = http.createServer((_req, res) => res.end("occupied"));
  try {
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(65535, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error && error.code === "EADDRINUSE") return t.skip("port 65535 is already occupied by another process");
    throw error;
  }
  t.after(() => blocker.close());
  const cwd = createProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await waitForExit(launch(cwd, ["--port", "65535"]));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"error":"port_exhausted"/);
  assert.match(result.stderr, /"last_port":65535/);
});

test("canonical and bilingual template servers are byte-identical", () => {
  const canonical = fs.readFileSync(SERVER);
  for (const locale of ["en", "zh"]) {
    const template = fs.readFileSync(path.join(ROOT, "templates", locale, ".agent", "skills", "agent-dashboard", "scripts", "serve.js"));
    assert.deepEqual(template, canonical);
  }
});
