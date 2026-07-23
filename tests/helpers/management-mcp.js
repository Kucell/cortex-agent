"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const CLI = path.join(ROOT, "bin", "cli.js");

function copy(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function createProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-project-"));
  const management = path.join(project, ".agent", "skills", "management-api", "scripts");
  for (const file of ["index.js", "normalize-token-usage.js", "projection-registry.json", "query-activity.js"]) {
    copy(path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", file), path.join(management, file));
  }
  copy(
    path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
    path.join(project, ".agent", "tasks", "scripts", "task-state.js"),
  );
  const mcp = path.join(project, ".agent", "skills", "runtime-state-mcp", "scripts");
  for (const file of ["server.js", "server-core.js"]) {
    copy(path.join(ROOT, "templates", "_shared", ".agent", "skills", "runtime-state-mcp", "scripts", file), path.join(mcp, file));
  }
  for (const dir of ["runs", "queues", "sessions", "inbox", "decisions", "waitpoints", "tasks", "handoffs", "artifacts"]) {
    fs.mkdirSync(path.join(project, ".agent", dir), { recursive: true });
  }
  fs.writeFileSync(path.join(project, ".agent", "runs", "R-1.json"), `${JSON.stringify({ run_id: "R-1", kind: "implement", status: "running", started_at: "2026-07-23T00:00:00.000Z", events: [] })}\n`);
  return project;
}

function invoke(project, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "mcp", "serve", "--project", project], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      resolve({ code, responses, stdout, stderr });
    });
    child.stdin.end(requests.map((request) => `${JSON.stringify(request)}\n`).join(""));
  });
}

function direct(project, projection, filters = []) {
  const script = path.join(project, ".agent", "skills", "management-api", "scripts", "index.js");
  const result = spawnSync(process.execPath, [script, "query", projection, ...filters], { cwd: project, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

module.exports = { ROOT, createProject, direct, invoke };
