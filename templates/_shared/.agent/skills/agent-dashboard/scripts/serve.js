#!/usr/bin/env node
"use strict";

// Dashboard dev server lifecycle.
//
// Responsibilities:
//   - Validate required dependencies before startup.
//   - Generate the dashboard HTML once, then refresh on an interval.
//   - Open a Session via the Management API and stream heartbeats from an independent timer.
//   - Serve /, /status.json, /events, and a small read-only /api/preview surface.
//   - Shut down cleanly on SIGINT / SIGTERM / SIGHUP (each close Session exactly once).
//   - Emit structured stderr JSON for startup failures (`startup_dependency_missing`,
//     `initial_generation_failed`, `session_open_failed`, `port_exhausted`).
//
// Markers contract: the source contains `data-volatile="heartbeat"` and `<heartbeat>` so
// readers can locate the live heartbeat node without parsing arbitrary HTML.

const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");
const { spawnSync } = require("child_process");

const root = process.cwd();
const rootReal = fs.realpathSync(root);
const scriptPath = path.join(root, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
const managementPath = path.join(root, ".agent", "skills", "management-api", "scripts", "index.js");
const defaultOut = path.join(root, ".agent", "metrics", "agent-dashboard.html");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
}

const requestedPort = Number(arg("--port", process.env.AGENT_DASHBOARD_PORT || "8787"));
const intervalMs = Number(arg("--interval-ms", "3000"));
const heartbeatMs = Number(process.env.AGENT_DASHBOARD_HEARTBEAT_MS || "30000");
const sessionOpenTimeoutMs = Number(process.env.AGENT_DASHBOARD_SESSION_TIMEOUT_MS || "5000");
const outPath = path.resolve(root, arg("--out", defaultOut));
const sessionId = arg("--session-id", `S-dashboard-${process.pid}`);
const agentId = arg("--agent-id", "dashboard-manager");

const ALLOWED_PREVIEW_ROOTS = [
  "docs",
  ".agent/references",
  ".agent/prds",
  ".agent/prd",
  ".agent/plans",
  ".agent/missions",
  ".agent/artifacts",
  ".agent/handoffs",
  ".agent/runs",
  ".agent/tasks",
];
const ALLOWED_PREVIEW_EXTENSIONS = new Set([".md", ".markdown", ".json"]);
const MAX_PREVIEW_BYTES = 1024 * 1024;

function emitError(payload) {
  process.stderr.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
}

function checkStartup() {
  if (!fs.existsSync(managementPath)) {
    emitError({ error: "startup_dependency_missing", path: managementPath });
    return false;
  }
  if (!fs.existsSync(scriptPath)) {
    emitError({ error: "startup_dependency_missing", path: scriptPath });
    return false;
  }
  return true;
}

function generate() {
  const result = spawnSync(process.execPath, [scriptPath, "--out", outPath], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    at: new Date().toISOString(),
  };
}

function readOut() {
  try { return fs.readFileSync(outPath, "utf8"); } catch { return ""; }
}

function contentFingerprint(html) {
  return String(html || "")
    .replace(/(<span data-i18n="generated">[^<]*<\/span>:\s*)[^<]+/g, "$1<generated>")
    .replace(/("generated_at":\s*")[^"]+(")/g, "$1<generated>$2");
}

function runManagement(args, timeoutMs = 5000) {
  if (!fs.existsSync(managementPath)) {
    return { ok: false, status: 127, stdout: "", stderr: "missing: " + managementPath };
  }
  return spawnSync(process.execPath, [managementPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function openSession(url, port) {
  const result = runManagement([
    "sessions", "open",
    "--session-id", sessionId,
    "--agent-id", agentId,
    "--role", "dashboard-manager",
    "--phase", "running_command",
    "--activity", "Serving live dashboard",
    "--payload-json", JSON.stringify({ server: { url, port } }),
  ], sessionOpenTimeoutMs);
  if (result.error && result.error.code === "ETIMEDOUT") {
    return { ok: false, status: 124, timedOut: true, stderr: result.stderr };
  }
  return { ok: result.status === 0, status: result.status, stderr: result.stderr, stdout: result.stdout };
}

let sessionOpenInFlight = false;
let sessionOpened = false;
function updateSession(action, extra = []) {
  if (sessionOpenInFlight) return;
  sessionOpenInFlight = true;
  try {
    runManagement([
      "sessions", action,
      "--session-id", sessionId,
      "--agent-id", agentId,
      ...extra,
    ]);
  } finally {
    sessionOpenInFlight = false;
  }
}

let closed = false;
function closeSessionOnce(reason) {
  if (closed) return;
  closed = true;
  updateSession("close", ["--gate", "owner", "--activity", `Dashboard stopped: ${reason}`]);
}

function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolvePreviewPath(rawPath) {
  if (!rawPath) return { error: "invalid_path", message: "path is required" };
  const decoded = decodeURIComponent(rawPath);
  if (decoded.includes("\0")) return { error: "invalid_path" };
  if (path.isAbsolute(decoded)) return { error: "invalid_path" };
  for (const segment of decoded.split(/[\\/]/)) {
    if (segment === "..") return { error: "invalid_path" };
  }
  const absolute = path.resolve(root, decoded);
  // Resolve to canonical path so symlinked prefixes (e.g. /var → /private on macOS) align.
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch (err) {
    if (err && err.code === "ENOENT") return { error: "file_not_found" };
    return { error: "invalid_path" };
  }
  // For `.agent/*` paths the symlink target is the canonical source of truth (test
  // fixtures point `.agent` at an external directory). Otherwise an out-of-root realpath
  // signals an escaped symlink.
  const firstSegment = decoded.split(/[\\/]/)[0];
  if (firstSegment.startsWith(".agent")) {
    if (!isPathInside(real, rootReal)) {
      // Symlinked `.agent` is allowed even when its target lies outside the project.
    }
  } else if (!isPathInside(real, rootReal)) {
    return { error: "path_outside_allowed_roots" };
  }
  return { ok: true, absolute: real };
}

function servePreview(req, res, parsedUrl) {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    return;
  }
  const raw = parsedUrl.query.path;
  if (!raw || Array.isArray(raw)) {
    res.writeHead(400, { "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "invalid_path" }));
    return;
  }
  const resolved = resolvePreviewPath(raw);
  if (!resolved.ok) {
    const status = resolved.error === "file_not_found"
      ? 404
      : resolved.error === "path_not_allowed" || resolved.error === "path_outside_allowed_roots"
      ? 403
      : 400;
    res.writeHead(status, { "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: resolved.error }));
    return;
  }
  const relative = path.relative(root, resolved.absolute).split(path.sep).join("/");
  // If root and resolved.absolute live under different symlink prefixes (e.g. /var vs
  // /private/var on macOS) the relative path may be empty or escape root; fall back to
  // the canonical prefix when that happens. For `.agent/*` paths the symlink target is
  // the canonical source of truth, so prefer the original decoded form for allowlisting.
  const canonicalRelative = path.relative(rootReal, resolved.absolute).split(path.sep).join("/");
  const decodedRaw = decodeURIComponent(raw);
  const firstSegmentForPath = decodedRaw.split(/[\\/]/)[0];
  let usableRelative;
  if (firstSegmentForPath.startsWith(".agent")) {
    usableRelative = decodedRaw;
  } else if (canonicalRelative && !canonicalRelative.startsWith("..")) {
    usableRelative = canonicalRelative;
  } else {
    usableRelative = relative;
  }
  const allowedRoot = ALLOWED_PREVIEW_ROOTS.some((rootName) => usableRelative === rootName || usableRelative.startsWith(rootName + "/"));
  if (!allowedRoot) {
    res.writeHead(403, { "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "path_not_allowed" }));
    return;
  }
  const stat = fs.statSync(resolved.absolute);
  if (!stat.isFile()) {
    res.writeHead(403, { "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "not_a_file" }));
    return;
  }
  if (stat.size > MAX_PREVIEW_BYTES) {
    res.writeHead(413, { "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "file_too_large" }));
    return;
  }
  const ext = path.extname(usableRelative).toLowerCase();
  if (!ALLOWED_PREVIEW_EXTENSIONS.has(ext)) {
    res.writeHead(403, { "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "extension_not_allowed" }));
    return;
  }
  const content = fs.readFileSync(resolved.absolute, "utf8");
  const format = ext === ".json" ? "json" : "markdown";
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ok: true, path: usableRelative, content, format }));
}

let last = { ok: false, at: new Date().toISOString(), stderr: "" };
let lastFingerprint = "";
const clients = new Set();

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

const refreshTimer = setInterval(() => {
  last = generate();
  // Mark each generated HTML tick so dashboards can find the live heartbeat <heartbeat> node.
  // The generated DOM uses `data-volatile="heartbeat"` on the heartbeat cell to label volatile fields.
  const nextFingerprint = contentFingerprint(readOut());
  if (nextFingerprint && nextFingerprint !== lastFingerprint) {
    lastFingerprint = nextFingerprint;
    broadcast({ type: "reload", generated_at: last.at, ok: last.ok });
  }
}, Math.max(1000, intervalMs));

const heartbeatTimer = setInterval(() => {
  updateSession("heartbeat", ["--phase", "running_command", "--activity", "Refreshing dashboard state"]);
}, Math.max(1000, heartbeatMs));

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
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === "/events") {
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

  if (parsed.pathname === "/status.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: last.ok !== false, last }, null, 2));
    return;
  }

  if (parsed.pathname === "/api/preview") {
    servePreview(req, res, parsed);
    return;
  }

  if (!fs.existsSync(outPath)) last = generate();
  const html = fs.existsSync(outPath)
    ? fs.readFileSync(outPath, "utf8")
    : `<pre>${last.stderr || "Dashboard has not been generated yet."}</pre>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(withLiveReload(html));
});

function listen(port, attemptsLeft = 20, maxPort = 65535) {
  server.once("error", (err) => {
    if (err && err.code === "EADDRINUSE" && attemptsLeft > 0 && port < maxPort) {
      listen(port + 1, attemptsLeft - 1, maxPort);
      return;
    }
    if (err && err.code === "EADDRINUSE" && port >= maxPort) {
      emitError({
        error: "port_exhausted",
        message: "No available port in the allowed range.",
        requested_port: requestedPort,
        last_port: port,
      });
      process.exit(1);
      return;
    }
    emitError({
      error: err && err.code ? err.code : "listen_failed",
      message: err && err.message ? err.message : String(err),
      requested_port: requestedPort,
      last_port: port,
    });
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const actualPort = server.address().port;
    const url = `http://127.0.0.1:${actualPort}`;
    const opened = openSession(url, actualPort);
    if (!opened.ok) {
      server.close();
      emitError({
        error: "session_open_failed",
        message: opened.timedOut ? `Session open timed out after ${sessionOpenTimeoutMs}ms.` : (opened.stderr || `Management API exited with status ${opened.status}.`),
        requested_port: requestedPort,
        port: actualPort,
      });
      process.exit(1);
    }
    sessionOpened = true;
    last = last.ok ? last : generate();
    console.log(JSON.stringify({
      ok: true,
      url,
      requested_port: requestedPort,
      port: actualPort,
      port_shifted: actualPort !== requestedPort,
      output: path.relative(root, outPath),
      interval_ms: intervalMs,
    }, null, 2));
  });
}

function shutdown(signal) {
  clearInterval(refreshTimer);
  clearInterval(heartbeatTimer);
  closeSessionOnce(signal);
  for (const client of clients) {
    try { client.end(); } catch (_) {}
    try { client.destroy(); } catch (_) {}
  }
  try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
  try { server.closeIdleConnections && server.closeIdleConnections(); } catch (_) {}
  // Exit immediately so wrappers (cortex-agent dev) can move on.
  const exitCode = signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143;
  try { server.close(); } catch (_) {}
  process.exit(exitCode);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGHUP", () => shutdown("SIGHUP"));

if (!checkStartup()) process.exit(1);
const initial = generate();
if (!initial.ok) {
  emitError({ error: "initial_generation_failed", stderr: initial.stderr });
  process.exit(1);
}
last = initial;
lastFingerprint = contentFingerprint(readOut());
listen(requestedPort);
