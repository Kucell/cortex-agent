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

function updateSession(action, extra = []) {
  if (!fs.existsSync(managementPath)) return;
  spawnSync(process.execPath, [
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
    stdio: "ignore",
  });
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

let last = generate();
let lastFingerprint = contentFingerprint(readOut());
const clients = new Set();

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

const refreshTimer = setInterval(() => {
  last = generate();
  updateSession("heartbeat", ["--phase", "running_command", "--activity", "Refreshing dashboard state"]);
  const nextFingerprint = contentFingerprint(readOut());
  if (nextFingerprint && nextFingerprint !== lastFingerprint) {
    lastFingerprint = nextFingerprint;
    broadcast({ type: "reload", generated_at: last.at, ok: last.ok });
  }
}, Math.max(1000, intervalMs));

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

function listen(port, attemptsLeft = 20) {
  server.once("error", (err) => {
    if (err && err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(JSON.stringify({
      ok: false,
      error: err && err.code ? err.code : "listen_failed",
      message: err && err.message ? err.message : String(err),
      requested_port: requestedPort,
      last_port: port,
    }, null, 2));
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const actualPort = server.address().port;
    const url = `http://127.0.0.1:${actualPort}`;
    updateSession("open", [
      "--role",
      "dashboard-manager",
      "--phase",
      "running_command",
      "--activity",
      "Serving live dashboard",
      "--payload-json",
      JSON.stringify({ server: { url, port: actualPort } }),
    ]);
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
  updateSession("close", ["--gate", "owner", "--activity", `Dashboard stopped by ${signal}`]);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

listen(requestedPort);
