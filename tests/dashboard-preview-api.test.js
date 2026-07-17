"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
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

function waitForPort(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for dashboard server: ${output}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/"port":\s*(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Dashboard server exited with ${code}: ${output}`));
    });
  });
}

function request(port, pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("dashboard preview API reads only authorized project documents", async (t) => {
  const serverSource = fs.readFileSync(SERVER, "utf8");
  assert.match(serverSource, /data-volatile="heartbeat"/);
  assert.match(serverSource, /<heartbeat>/);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dashboard-preview-project-"));
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dashboard-preview-agent-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(agentRoot, { recursive: true, force: true }));

  write(path.join(projectRoot, "docs", "proposal.md"), "# Proposal\n\nPreview me.\n");
  write(path.join(projectRoot, "README.md"), "# Project\n");
  write(path.join(projectRoot, "src", "private.md"), "not authorized\n");
  write(path.join(projectRoot, "docs", "script.js"), "not authorized\n");
  write(path.join(projectRoot, "docs", "large.txt"), "x".repeat(1024 * 1024 + 1));
  fs.mkdirSync(path.join(projectRoot, "docs", "folder.md"));
  write(path.join(agentRoot, "references", "state.json"), "{\"status\":\"ready\"}\n");
  write(path.join(agentRoot, "outside.md"), "outside allowed docs root\n");
  write(path.join(agentRoot, "metrics", "agent-dashboard.html"), "<html><body>Dashboard</body></html>");
  write(path.join(agentRoot, "skills", "agent-dashboard", "scripts", "generate.js"), [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const path = require('path');",
    "const index = process.argv.indexOf('--out');",
    "const out = index === -1 ? '.agent/metrics/agent-dashboard.html' : process.argv[index + 1];",
    "fs.mkdirSync(path.dirname(out), { recursive: true });",
    "if (!fs.existsSync(out)) fs.writeFileSync(out, '<html><body>Dashboard</body></html>');",
  ].join("\n"));
  write(path.join(agentRoot, "skills", "management-api", "scripts", "index.js"), "process.stdout.write(JSON.stringify({ ok: true }));\n");
  fs.symlinkSync(agentRoot, path.join(projectRoot, ".agent"), "dir");
  fs.symlinkSync(path.join(agentRoot, "outside.md"), path.join(projectRoot, "docs", "outside.md"));

  const child = spawn(process.execPath, [SERVER, "--port", "0", "--interval-ms", "60000"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const port = await waitForPort(child);

  const markdown = await request(port, "/api/preview?path=docs%2Fproposal.md");
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(markdown.body), {
    ok: true,
    path: "docs/proposal.md",
    content: "# Proposal\n\nPreview me.\n",
    format: "markdown",
  });

  const json = await request(port, "/api/preview?path=.agent%2Freferences%2Fstate.json");
  assert.equal(json.status, 200);
  assert.deepEqual(JSON.parse(json.body), {
    ok: true,
    path: ".agent/references/state.json",
    content: "{\"status\":\"ready\"}\n",
    format: "json",
  });

  const traversal = await request(port, "/api/preview?path=docs%2F..%2Fsrc%2Fprivate.md");
  assert.equal(traversal.status, 400);
  assert.equal(JSON.parse(traversal.body).error, "invalid_path");

  const unauthorized = await request(port, "/api/preview?path=src%2Fprivate.md");
  assert.equal(unauthorized.status, 403);
  assert.equal(JSON.parse(unauthorized.body).error, "path_not_allowed");

  const absolute = await request(port, `/api/preview?path=${encodeURIComponent(path.join(projectRoot, "README.md"))}`);
  assert.equal(absolute.status, 400);
  assert.equal(JSON.parse(absolute.body).error, "invalid_path");

  const escapedSymlink = await request(port, "/api/preview?path=docs%2Foutside.md");
  assert.equal(escapedSymlink.status, 403);
  assert.equal(JSON.parse(escapedSymlink.body).error, "path_outside_allowed_roots");

  const missing = await request(port, "/api/preview?path=docs%2Fmissing.md");
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error, "file_not_found");

  const extension = await request(port, "/api/preview?path=docs%2Fscript.js");
  assert.equal(extension.status, 403);
  assert.equal(JSON.parse(extension.body).error, "extension_not_allowed");

  const directory = await request(port, "/api/preview?path=docs%2Ffolder.md");
  assert.equal(directory.status, 403);
  assert.equal(JSON.parse(directory.body).error, "not_a_file");

  const tooLarge = await request(port, "/api/preview?path=docs%2Flarge.txt");
  assert.equal(tooLarge.status, 413);
  assert.equal(JSON.parse(tooLarge.body).error, "file_too_large");

  const wrongMethod = await request(port, "/api/preview?path=README.md", "POST");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  assert.equal(wrongMethod.headers["cache-control"], "no-store");

  const status = await request(port, "/status.json");
  assert.equal(status.status, 200);
  assert.equal(typeof JSON.parse(status.body).ok, "boolean");
});
