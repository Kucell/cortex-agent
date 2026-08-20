"use strict";

/**
 * lib/mcp/ping.js — MCP server health check (P-002 MS-003).
 *
 * Spawns the stdio MCP server as a subprocess, sends a `tools/list` JSON-RPC
 * request, and expects a result frame within the timeout. Used by
 * `cortex-agent mcp ping [--timeout 5s]` and by the P-002 daemon-detection
 * probe. Zero npm deps (node:child_process / node:path / node:stream).
 */

const path = require("node:path");
const { spawn } = require("node:child_process");

/** "5s" / "3000" / "1500ms" → milliseconds (default 5000). */
function parseTimeout(value) {
  if (value === undefined || value === null || value === "") return 5000;
  const match = /^(\d+)\s*(ms|s)?$/.exec(String(value).trim());
  if (!match) return 5000;
  const n = Number(match[1]);
  const unit = match[2] || "ms";
  return unit === "s" ? n * 1000 : n;
}

/**
 * Spawn `bin/cli.js mcp serve` (cwd = opts.cwd) and verify it answers
 * `tools/list` before the timeout.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]        project root the server should serve
 * @param {number|string} [opts.timeout]  timeout (ms or "5s")
 * @param {string} [opts.token]      optional hex32 token (env passthrough)
 * @param {string} [opts.cli]        explicit CLI path (default repo bin/cli.js)
 * @returns {Promise<{ok: boolean, tools?: Array, serverInfo?: object,
 *                     latencyMs?: number, error?: string}>}
 */
function ping(opts) {
  opts = opts || {};
  const timeoutMs = parseTimeout(opts.timeout);
  const cli = opts.cli || path.resolve(__dirname, "..", "..", "bin", "cli.js");
  const cwd = opts.cwd || process.cwd();
  const env = Object.assign({}, process.env, {
    CORTEX_AGENT_PROJECT_ROOT: cwd,
  });
  if (opts.token) env.CORTEX_AGENT_MCP_TOKEN = opts.token;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cli, "mcp", "serve"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, error: `failed to spawn server: ${err.message}` });
      return;
    }

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch (_) {}
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms: no tools/list response`, stderr: stderr.trim() });
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch (_) {}
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (frame && frame.id === 1 && frame.result && Array.isArray(frame.result.tools)) {
          finish({
            ok: true,
            tools: frame.result.tools.map((t) => ({ name: t.name, description: t.description })),
            serverInfo: frame.result.serverInfo || null,
            latencyMs: Date.now() - startedAt,
          });
          return;
        }
        if (frame && frame.id === 1 && frame.error) {
          finish({ ok: false, error: `server returned error: ${frame.error.message || JSON.stringify(frame.error)}` });
          return;
        }
      }
    });

    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    child.on("error", (err) => {
      finish({ ok: false, error: `server process error: ${err.message}`, stderr: stderr.trim() });
    });

    child.on("exit", (code, signal) => {
      if (!settled) {
        finish({
          ok: false,
          error: `server exited before tools/list response (code=${code}, signal=${signal})`,
          stderr: stderr.trim(),
        });
      }
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
  });
}

module.exports = { ping, parseTimeout };
