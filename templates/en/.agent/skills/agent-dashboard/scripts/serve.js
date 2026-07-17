#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const root = process.cwd();
const scriptPath = path.join(root, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
const managementPath = path.join(root, ".agent", "skills", "management-api", "scripts", "index.js");
const defaultOut = path.join(root, ".agent", "metrics", "agent-dashboard.html");
const maxPreviewBytes = 1024 * 1024;
const previewExtensions = new Set([".md", ".markdown", ".json", ".txt"]);
const rootPreviewFiles = new Set(["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
}

const requestedPort = Number(arg("--port", process.env.AGENT_DASHBOARD_PORT || "8787"));
const intervalMs = Number(arg("--interval-ms", "3000"));
const outPath = path.resolve(root, arg("--out", defaultOut));
const sessionId = arg("--session-id", `S-dashboard-${process.pid}`);
const agentId = arg("--agent-id", "dashboard-manager");
const writerTimeoutMs = 5000;
const shutdownTimeoutMs = 3000;
const defaultHeartbeatMs = 30000;
const heartbeatMs = Math.min(60000, Math.max(100, Number(process.env.AGENT_DASHBOARD_HEARTBEAT_MS) || defaultHeartbeatMs));

function updateSession(action, extra = []) {
  const result = spawnSync(process.execPath, [
    managementPath,
    "sessions",
    action,
    "--session-id",
    sessionId,
    "--agent-id",
    agentId,
    ...extra,
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: writerTimeoutMs,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function generate() {
  const result = spawnSync(process.execPath, [scriptPath, "--out", outPath], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: writerTimeoutMs,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr || (result.error ? result.error.message : ""),
    at: new Date().toISOString(),
  };
}

function readOut() {
  try { return fs.readFileSync(outPath, "utf8"); } catch { return ""; }
}

function contentFingerprint(html) {
  return String(html || "")
    .replace(/(<span data-i18n="generated">[^<]*<\/span>:\s*)[^<]+/g, "$1<generated>")
    .replace(/(<td data-volatile="heartbeat">)[^<]*(<\/td>)/g, "$1<heartbeat>$2")
    .replace(/("generated_at":\s*")[^"]+(")/g, "$1<generated>$2");
}

function isWithin(candidate, base) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function previewFormat(extension) {
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (extension === ".json") return "json";
  return "text";
}

function previewError(res, status, error) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ ok: false, error }));
}

function servePreview(req, res, requestUrl) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    previewError(res, 405, "method_not_allowed");
    return;
  }

  const requestedPath = requestUrl.searchParams.get("path");
  if (!requestedPath || requestedPath.includes("\0")) {
    previewError(res, 400, "invalid_path");
    return;
  }

  const portablePath = requestedPath.replace(/\\/g, "/");
  const segments = portablePath.split("/");
  if (path.posix.isAbsolute(portablePath) || /^[A-Za-z]:\//.test(portablePath) || segments.includes("..")) {
    previewError(res, 400, "invalid_path");
    return;
  }

  const normalizedPath = path.posix.normalize(portablePath).replace(/^\.\//, "");
  const isAgentPath = normalizedPath.startsWith(".agent/");
  const isDocsPath = normalizedPath.startsWith("docs/");
  if (!isAgentPath && !isDocsPath && !rootPreviewFiles.has(normalizedPath)) {
    previewError(res, 403, "path_not_allowed");
    return;
  }

  const extension = path.posix.extname(normalizedPath).toLowerCase();
  if (!previewExtensions.has(extension)) {
    previewError(res, 403, "extension_not_allowed");
    return;
  }

  const candidate = path.resolve(root, ...normalizedPath.split("/"));
  if (!isWithin(candidate, path.resolve(root))) {
    previewError(res, 400, "invalid_path");
    return;
  }

  let realCandidate;
  let stat;
  try {
    realCandidate = fs.realpathSync(candidate);
    stat = fs.statSync(realCandidate);
  } catch (error) {
    previewError(res, error && error.code === "ENOENT" ? 404 : 403, error && error.code === "ENOENT" ? "file_not_found" : "file_unavailable");
    return;
  }

  if (!stat.isFile()) {
    previewError(res, 403, "not_a_file");
    return;
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    previewError(res, 500, "project_root_unavailable");
    return;
  }

  let authorized = isWithin(realCandidate, realRoot);
  if (isAgentPath) {
    try {
      authorized = authorized || isWithin(realCandidate, fs.realpathSync(path.join(root, ".agent")));
    } catch {
      authorized = false;
    }
  }
  if (!authorized) {
    previewError(res, 403, "path_outside_allowed_roots");
    return;
  }

  if (stat.size > maxPreviewBytes) {
    previewError(res, 413, "file_too_large");
    return;
  }

  let content;
  try {
    content = fs.readFileSync(realCandidate, "utf8");
  } catch {
    previewError(res, 403, "file_unavailable");
    return;
  }
  if (Buffer.byteLength(content, "utf8") > maxPreviewBytes) {
    previewError(res, 413, "file_too_large");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({
    ok: true,
    path: normalizedPath,
    content,
    format: previewFormat(extension),
  }));
}

let last = { ok: false, stdout: "", stderr: "Dashboard is starting.", at: new Date().toISOString() };
let lastFingerprint = "";
const clients = new Set();
const sockets = new Set();
let refreshTimer = null;
let heartbeatTimer = null;
let initialHeartbeatTimer = null;
let sessionOpened = false;
let ready = false;
let shuttingDown = false;

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

function refresh() {
  last = generate();
  const nextFingerprint = contentFingerprint(readOut());
  if (nextFingerprint && nextFingerprint !== lastFingerprint) {
    lastFingerprint = nextFingerprint;
    broadcast({ type: "reload", generated_at: last.at, ok: last.ok });
  }
}

function withLiveReload(html) {
  const snippet = `<script>
(() => {
  const key = 'agent-dashboard-scroll';
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved && saved.path === location.pathname && saved.hash === location.hash) {
      requestAnimationFrame(() => scrollTo(saved.x || 0, saved.y || 0));
    }
  } catch (_) {}
  const source = new EventSource('/events');
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'reload') {
        sessionStorage.setItem(key, JSON.stringify({
          path: location.pathname,
          hash: location.hash,
          x: scrollX,
          y: scrollY
        }));
        location.reload();
      }
    } catch (_) {}
  };
})();
</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${snippet}</body>`) : `${html}${snippet}`;
}

const server = http.createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, "http://127.0.0.1");
  } catch {
    previewError(res, 400, "invalid_url");
    return;
  }

  if (requestUrl.pathname === "/api/preview") {
    servePreview(req, res, requestUrl);
    return;
  }

  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", generated_at: last.at, ok: last.ok })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.url === "/status.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(last, null, 2));
    return;
  }

  if (!fs.existsSync(outPath)) last = generate();
  const html = fs.existsSync(outPath)
    ? fs.readFileSync(outPath, "utf8")
    : `<pre>${last.stderr || "Dashboard has not been generated yet."}</pre>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(withLiveReload(html));
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

function structuredError(error, details = {}) {
  console.error(JSON.stringify({ ok: false, error, ...details }));
}

function validateStartup() {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    return { ok: false, error: "invalid_port", value: requestedPort };
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) {
    return { ok: false, error: "invalid_interval", value: intervalMs };
  }
  for (const [name, file] of [["generator", scriptPath], ["management_writer", managementPath]]) {
    try {
      if (!fs.statSync(file).isFile()) return { ok: false, error: "startup_dependency_missing", dependency: name, path: path.relative(root, file) };
    } catch {
      return { ok: false, error: "startup_dependency_missing", dependency: name, path: path.relative(root, file) };
    }
  }
  return { ok: true };
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function listenAvailable() {
  let port = requestedPort;
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    if (port > 65535) throw Object.assign(new Error("No valid port remains in the retry range."), { code: "port_exhausted", lastPort: port - 1 });
    try {
      return await listenOnce(port);
    } catch (error) {
      if (!error || error.code !== "EADDRINUSE") throw error;
      if (attempt === 20 || port === 65535) {
        throw Object.assign(new Error("No available dashboard port was found."), { code: "port_exhausted", lastPort: port });
      }
      port += 1;
    }
  }
  throw Object.assign(new Error("No available dashboard port was found."), { code: "port_exhausted", lastPort: port });
}

function closeHttpServer() {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      finish();
    }, shutdownTimeoutMs);
    server.close(finish);
    for (const client of clients) client.end();
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  });
}

async function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  if (refreshTimer) clearInterval(refreshTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (initialHeartbeatTimer) clearTimeout(initialHeartbeatTimer);

  let closeResult = { ok: true };
  if (sessionOpened) {
    closeResult = updateSession("close", ["--gate", "owner", "--activity", `Dashboard stopped by ${reason}`]);
    sessionOpened = false;
    if (!closeResult.ok) {
      structuredError("session_close_failed", { reason, message: closeResult.error || closeResult.stderr.trim() || `exit ${closeResult.status}` });
    }
  }
  await closeHttpServer();
  process.exitCode = closeResult.ok ? exitCode : 1;
}

function beginRuntimeTimers() {
  refreshTimer = setInterval(refresh, Math.max(1000, intervalMs));
  const heartbeat = () => {
    const result = updateSession("heartbeat", ["--phase", "running_command", "--activity", "Serving live dashboard"]);
    if (!result.ok) {
      structuredError("session_heartbeat_failed", { message: result.error || result.stderr.trim() || `exit ${result.status}` });
      shutdown("session_heartbeat_failed", 1);
    }
  };
  initialHeartbeatTimer = setTimeout(heartbeat, Math.min(1000, heartbeatMs));
  heartbeatTimer = setInterval(heartbeat, heartbeatMs);
}

async function start() {
  const validation = validateStartup();
  if (!validation.ok) {
    structuredError(validation.error, validation);
    process.exitCode = 1;
    return;
  }

  last = generate();
  if (!last.ok || !fs.existsSync(outPath) || !readOut()) {
    structuredError("initial_generation_failed", { message: String(last.stderr || "generator exited unsuccessfully").trim() });
    process.exitCode = 1;
    return;
  }
  if (shuttingDown) return;
  lastFingerprint = contentFingerprint(readOut());

  let actualPort;
  try {
    actualPort = await listenAvailable();
  } catch (error) {
    structuredError(error && error.code ? error.code : "listen_failed", {
      message: error && error.message ? error.message : String(error),
      requested_port: requestedPort,
      last_port: error && error.lastPort !== undefined ? error.lastPort : requestedPort,
    });
    process.exitCode = 1;
    return;
  }
  if (shuttingDown) {
    await closeHttpServer();
    return;
  }

  const url = `http://127.0.0.1:${actualPort}`;
  const opened = updateSession("open", [
    "--role", "dashboard-manager",
    "--phase", "running_command",
    "--activity", "Serving live dashboard",
    "--payload-json", JSON.stringify({ server: { url, port: actualPort } }),
  ]);
  if (!opened.ok) {
    structuredError("session_open_failed", { message: opened.error || opened.stderr.trim() || `exit ${opened.status}` });
    await closeHttpServer();
    process.exitCode = 1;
    return;
  }
  sessionOpened = true;
  ready = true;
  beginRuntimeTimers();
  server.on("error", (error) => {
    if (!ready || shuttingDown) return;
    structuredError("runtime_server_error", { message: error && error.message ? error.message : String(error) });
    shutdown("runtime_server_error", 1);
  });
  console.log(JSON.stringify({
    ok: true,
    url,
    requested_port: requestedPort,
    port: actualPort,
    port_shifted: actualPort !== requestedPort,
    output: path.relative(root, outPath),
    interval_ms: intervalMs,
    heartbeat_ms: heartbeatMs,
  }, null, 2));
}

process.once("SIGINT", () => shutdown("SIGINT", 130));
process.once("SIGTERM", () => shutdown("SIGTERM", 143));
process.once("SIGHUP", () => shutdown("SIGHUP", 129));

start().catch((error) => {
  structuredError("startup_failed", { message: error && error.message ? error.message : String(error) });
  shutdown("startup_failed", 1);
});
