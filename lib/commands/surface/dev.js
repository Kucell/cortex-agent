"use strict";

// ─── dev — local Agent Dashboard dev server wrapper ───────────────────────────
//
// Originally lived in lib/commands.js (line 2455–2574). Forks the local agent
// dashboard under .agent/skills/agent-dashboard/scripts/serve.js and forwards
// stdout/stderr with bounded teardown. Extracted so callers can require this
// surface in isolation.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function devUsageError(message) {
  console.error(`cortex-agent dev: ${message}`);
  console.error("Usage: cortex-agent dev [--port N] [--interval-ms N] [--session-id ID]");
  process.exitCode = 2;
}

function parseDevOptions(args) {
  const values = { port: 8787, intervalMs: 3000, sessionId: null };
  const definitions = {
    "--port": { key: "port", min: 1, max: 65535 },
    "--interval-ms": { key: "intervalMs", min: 1000, max: 3600000 },
    "--session-id": { key: "sessionId" },
  };

  for (let index = 1; index < args.length; index += 1) {
    const raw = args[index];
    const equalAt = raw.indexOf("=");
    const name = equalAt === -1 ? raw : raw.slice(0, equalAt);
    const definition = definitions[name];
    if (!definition) return { error: `unknown option: ${raw}` };
    const value = equalAt === -1 ? args[++index] : raw.slice(equalAt + 1);
    if (value === undefined || value === "" || (equalAt === -1 && value.startsWith("--"))) {
      return { error: `${name} requires a value` };
    }
    if (definition.key === "sessionId") {
      if (!/^[A-Za-z0-9_.:-]+$/.test(value)) {
        return { error: "--session-id contains unsupported characters" };
      }
      values.sessionId = value;
      continue;
    }
    if (!/^\d+$/.test(value)) return { error: `${name} must be an integer` };
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < definition.min || number > definition.max) {
      return { error: `${name} must be between ${definition.min} and ${definition.max}` };
    }
    values[definition.key] = number;
  }
  return { values };
}

async function dev(ctx) {
  const agentDir = path.join(ctx.cwd, ".agent");
  const serverScript = path.join(agentDir, "skills", "agent-dashboard", "scripts", "serve.js");
  if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
    devUsageError("missing .agent directory; run cortex-agent init first");
    return;
  }
  if (!fs.existsSync(serverScript) || !fs.statSync(serverScript).isFile()) {
    devUsageError("missing .agent/skills/agent-dashboard/scripts/serve.js; upgrade the project first");
    return;
  }
  const parsed = parseDevOptions(ctx.args);
  if (parsed.error) {
    devUsageError(parsed.error);
    return;
  }
  const childArgs = [serverScript, "--port", String(parsed.values.port), "--interval-ms", String(parsed.values.intervalMs)];
  if (parsed.values.sessionId) childArgs.push("--session-id", parsed.values.sessionId);

  await new Promise((resolve) => {
    // Under `tests/*.test.js` combined run, stdio: "inherit" can deadlock the test
    // runner on child cleanup because the test runner pipes share the parent's stdio.
    // Mirror stdout/stderr ourselves while keeping the child decoupled, then enforce
    // a tight teardown deadline so the wrapper never wedges the test suite.
    const child = spawn(process.execPath, childArgs, { cwd: ctx.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    if (child.stdout) child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    let forwardedSignal = null;
    let forceTimer = null;
    let settled = false;
    const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
    const forward = (signal) => {
      if (forwardedSignal || child.exitCode !== null || child.signalCode !== null) return;
      forwardedSignal = signal;
      child.kill(signal);
      // Tighten the SIGKILL deadline so test runs aren't blocked by children holding
      // sockets. Tests rely on `cortex-agent dev` returning control within a few
      // seconds of SIGTERM; production users see the same prompt shutdown.
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1500);
      forceTimer.unref();
    };
    const finish = () => {
      if (settled) return false;
      settled = true;
      resolve();
      return true;
    };
    const onSighup = () => forward("SIGHUP");
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    process.once("SIGHUP", onSighup);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const cleanup = () => {
      if (forceTimer) clearTimeout(forceTimer);
      process.removeListener("SIGHUP", onSighup);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      cleanup();
      console.error(`cortex-agent dev: failed to start dashboard: ${error.message}`);
      process.exitCode = 1;
      finish();
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (forwardedSignal) {
        process.exitCode = signalExitCodes[forwardedSignal] || 1;
      } else if (signal || code !== 0) {
        console.error(`cortex-agent dev: dashboard stopped${signal ? ` by ${signal}` : ` with exit code ${code}`}`);
        process.exitCode = typeof code === "number" && code !== 0 ? code : 1;
      }
      finish();
    });
  });
}

module.exports = {
  devUsageError,
  parseDevOptions,
  dev,
};
