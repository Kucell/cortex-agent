#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const root = process.cwd();
const scriptPath = path.join(root, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
const defaultOut = path.join(root, ".agent", "metrics", "agent-dashboard.html");

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
}

const requestedPort = Number(arg("--port", process.env.AGENT_DASHBOARD_PORT || "8787"));
const intervalMs = Number(arg("--interval-ms", "3000"));
const outPath = path.resolve(root, arg("--out", defaultOut));

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

let last = generate();
let lastMtime = fs.existsSync(outPath) ? fs.statSync(outPath).mtimeMs : 0;
const clients = new Set();

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

setInterval(() => {
  last = generate();
  const mtime = fs.existsSync(outPath) ? fs.statSync(outPath).mtimeMs : 0;
  if (mtime !== lastMtime) {
    lastMtime = mtime;
    broadcast({ type: "reload", generated_at: last.at, ok: last.ok });
  }
}, Math.max(1000, intervalMs));

function withLiveReload(html) {
  const snippet = `<script>
(() => {
  const source = new EventSource('/events');
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'reload') location.reload();
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
    console.log(JSON.stringify({
      ok: true,
      url: `http://127.0.0.1:${actualPort}`,
      requested_port: requestedPort,
      port: actualPort,
      port_shifted: actualPort !== requestedPort,
      output: path.relative(root, outPath),
      interval_ms: intervalMs,
    }, null, 2));
  });
}

listen(requestedPort);
