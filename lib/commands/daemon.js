"use strict";

const {
  startDaemon,
  statusDaemon,
  stopDaemon,
} = require("../control-service/daemon-lifecycle.js");
const {
  createDaemonHealthProducer,
} = require("../control-service/daemon-health.js");
const protocol = require("../../packages/protocol/src/index.js");

function parse(args) {
  const values = Array.isArray(args) ? args.slice(1) : [];
  const out = {
    action: null,
    json: false,
    help: false,
    poll_interval_ms: undefined,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") out.json = true;
    else if (value === "--help" || value === "-h") out.help = true;
    else if (value === "--poll-interval-ms") {
      out.poll_interval_ms = Number(values[++index]);
    } else if (typeof value === "string" && value.startsWith("--poll-interval-ms=")) {
      out.poll_interval_ms = Number(value.slice("--poll-interval-ms=".length));
    } else if (!value.startsWith("-") && !out.action) {
      out.action = value;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  cortex-agent daemon start [--poll-interval-ms <n>] [--json]",
    "  cortex-agent daemon status [--json]",
    "  cortex-agent daemon stop [--json]",
    "",
    "Control Service daemon is opt-in and default-disabled.",
    "Daemon lifecycle state is local runtime state under .agent-runtime/control-service/.",
    "Starting the daemon does not authorize or invent dispatch work.",
  ].join("\n");
}

function print(value, json, io = process) {
  if (json) {
    io.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }

  const state = value && value.state ? value.state : null;
  if (!state) {
    io.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }
  io.stdout.write(`Control daemon: ${state.status}\n`);
  io.stdout.write(`  enabled: ${state.enabled}\n`);
  io.stdout.write(`  pid: ${state.pid == null ? "-" : state.pid}\n`);
  if (value.live !== undefined) io.stdout.write(`  live: ${value.live}\n`);
  if (value.stale_owner !== undefined) io.stdout.write(`  stale_owner: ${value.stale_owner}\n`);
}

async function daemonCommand(ctx, dependencies = {}) {
  const parsed = parse(ctx.args);
  const io = dependencies.io || process;
  const start = dependencies.start || startDaemon;
  const status = dependencies.status || statusDaemon;
  const stop = dependencies.stop || stopDaemon;
  const createHealth = dependencies.createHealth || createDaemonHealthProducer;

  if (parsed.help || !parsed.action) {
    io.stdout.write(usage() + "\n");
    return { ok: true, mutated: false, help: true };
  }

  if (!["start", "status", "stop"].includes(parsed.action)) {
    io.stderr.write(`daemon: unknown action: ${parsed.action}\n`);
    io.stderr.write(usage() + "\n");
    process.exitCode = 2;
    return { ok: false, mutated: false, code: "INVALID_USAGE" };
  }

  if (parsed.poll_interval_ms !== undefined
    && (!Number.isInteger(parsed.poll_interval_ms) || parsed.poll_interval_ms < 1000)) {
    io.stderr.write("daemon: --poll-interval-ms must be an integer >= 1000\n");
    process.exitCode = 2;
    return { ok: false, mutated: false, code: "INVALID_POLL_INTERVAL" };
  }

  try {
    if (parsed.action === "start") {
      const result = start(ctx.cwd, {
        poll_interval_ms: parsed.poll_interval_ms,
      });
      print(result, parsed.json, io);
      if (!result.ok) process.exitCode = 3;
      return { ok: result.ok, mutated: Boolean(result.started), result };
    }

    if (parsed.action === "stop") {
      const result = stop(ctx.cwd);
      print(result, parsed.json, io);
      if (!result.ok) process.exitCode = 3;
      return { ok: result.ok, mutated: Boolean(result.stopped), result };
    }

    const result = status(ctx.cwd);
    const producer = createHealth(ctx.cwd, {
      request_source_configured: true,
    });
    const components = await producer.produce();
    const health = protocol.normalizePlatformHealth({
      generated_at: new Date().toISOString(),
      components,
    });
    const payload = {
      ...result,
      platform_health: health,
    };
    print(payload, parsed.json, io);
    return { ok: true, mutated: false, read: true, result: payload };
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        code: error.code || "ERR_DAEMON",
        message: error.message,
        details: error.details || {},
      },
    };
    if (parsed.json) io.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else io.stderr.write(`daemon: ${payload.error.code}: ${payload.error.message}\n`);
    process.exitCode = 3;
    return { ok: false, mutated: false, code: payload.error.code };
  }
}

module.exports = {
  daemonCommand,
  parse,
  usage,
  print,
};
