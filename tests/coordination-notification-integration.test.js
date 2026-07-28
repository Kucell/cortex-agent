"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const BASE_FLAGS = [
  "--consumer", "integration-consumer",
  "--target", "coordinator:root",
  "--adapter", "noop",
];

function invoke(project, action) {
  return spawnSync(
    process.execPath,
    [CLI, "notification", "pump", "--project", project, ...BASE_FLAGS, action],
    { cwd: ROOT, encoding: "utf8" },
  );
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for notification lifecycle state");
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("notification watch did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("public CLI runs a persistent watch and supports status plus idempotent stop", async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-notification-e2e-"));
  const child = spawn(
    process.execPath,
    [
      CLI,
      "notification",
      "pump",
      "--project", project,
      ...BASE_FLAGS,
      "--watch",
      "--interval-ms", "1000",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    fs.rmSync(project, { recursive: true, force: true });
  });

  const running = await waitFor(() => {
    const result = invoke(project, "--status");
    if (result.status !== 0) return null;
    const payload = JSON.parse(result.stdout);
    return payload.report.instanceActive === true && payload.report.state === "running"
      ? payload
      : null;
  });
  assert.equal(running.report.cursor.pending, 0);

  // The explicit watch must remain alive while the journal is idle.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  const stopped = invoke(project, "--stop");
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).action, "stop");
  const exit = await waitForExit(child);
  assert.equal(exit.code, 0, `${stderr}\n${stdout}`);

  const status = invoke(project, "--status");
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.report.instanceActive, false);
  assert.equal(payload.report.state, "stopped");

  const repeated = invoke(project, "--stop");
  assert.equal(repeated.status, 0, repeated.stderr);
});
