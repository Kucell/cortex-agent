"use strict";

/**
 * Thin CLI adapter for the Agent Coordination Notification Pump.
 *
 * This module is intentionally side-effect-free: it parses flags, validates
 * the public contract, and delegates to a host-injected harness. It MUST NOT
 * import the runtime journal, the consumer-cursor store, the application
 * service, or any concrete adapter module. The host process (lib/commands.js,
 * the Agent Dashboard, the team-pack runtime) is responsible for resolving
 * the project root, opening the journal, restoring the consumer cursor, and
 * selecting the adapter from the whitelist.
 *
 * Public contract (see lib/cli-contract.js `notification`):
 *   - `cortex-agent notification pump --project <path> --consumer <id> \
 *        --target <kind:actorId> --adapter <id> (--once | --watch | \
 *        --status | --stop)`
 *   - Required: --project, --consumer, --target, --adapter
 *   - Exactly one of --once | --watch | --status | --stop
 *   - Adapter whitelist: noop, claude-code, codex, webhook
 *   - Stable exit codes: 0 success, 1 invalid usage, 2 unsupported, 3 runtime
 *     failure, 4 capability unavailable
 *   - CLI does NOT accept event.command / event.executable from the surface.
 *
 * Result shape (passed back to the host):
 *   { ok: boolean,
 *     command: "notification.pump",
 *     action: "once" | "watch" | "status" | "stop",
 *     options: { project, consumer, target, adapter, intervalMs, maxAttempts,
 *                eventId? },
 *     exitCode: 0-4,
 *     error?: { code, message, details } }
 *
 * The host honours the result's exitCode and exit semantics. The adapter
 * itself never calls process.exit.
 */

const ADAPTER_WHITELIST = Object.freeze([
  "noop",
  "claude-code",
  "codex",
  "webhook",
]);
const ADAPTER_SET = new Set(ADAPTER_WHITELIST);

const ACTION_FLAGS = Object.freeze([
  "once",
  "watch",
  "status",
  "stop",
]);

const ACTOR_KINDS = Object.freeze([
  "coordinator",
  "agent",
  "user",
  "service",
  "adapter",
]);
const ACTOR_KIND_SET = new Set(ACTOR_KINDS);

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TARGET_PATTERN = /^([a-z]+):([A-Za-z0-9._:-]{1,128})$/;

const EXIT = Object.freeze({
  SUCCESS: 0,
  INVALID_USAGE: 1,
  UNSUPPORTED: 2,
  RUNTIME: 3,
  CAPABILITY: 4,
});

const ERR = Object.freeze({
  INVALID_USAGE: "INVALID_USAGE",
  UNSUPPORTED: "UNSUPPORTED_NOTIFICATION_COMMAND",
  RUNTIME: "NOTIFICATION_PUMP_FAILED",
  CAPABILITY: "NOTIFICATION_CAPABILITY_UNAVAILABLE",
});

function exitCodeLabel(code) {
  switch (code) {
    case EXIT.SUCCESS: return "success";
    case EXIT.INVALID_USAGE: return "invalid usage";
    case EXIT.UNSUPPORTED: return "unsupported";
    case EXIT.RUNTIME: return "runtime failure";
    case EXIT.CAPABILITY: return "capability unavailable";
    default: return "unknown";
  }
}

function buildResult(partial) {
  const result = {
    ok: partial.ok,
    command: "notification.pump",
    action: partial.action || null,
    options: partial.options || {},
    exitCode: partial.exitCode,
    error: partial.error || null,
  };
  if (partial.report !== undefined) result.report = partial.report;
  return result;
}

function fail(code, message, details = {}, exitCode) {
  const resolved = exitCode === undefined
    ? (code === ERR.UNSUPPORTED ? EXIT.UNSUPPORTED : EXIT.INVALID_USAGE)
    : exitCode;
  return buildResult({
    ok: false,
    exitCode: resolved,
    error: { code, message, details },
  });
}

function readOption(args, name) {
  const marker = `--${name}`;
  const inline = args.find((arg) => typeof arg === "string" && arg.startsWith(`${marker}=`));
  if (inline !== undefined) return inline.slice(marker.length + 1);
  const index = args.indexOf(marker);
  if (index < 0) return undefined;
  const next = args[index + 1];
  if (typeof next !== "string" || next.startsWith("--")) return "";
  return next;
}

function detectAction(args) {
  const found = [];
  for (const flag of ACTION_FLAGS) {
    if (args.includes(`--${flag}`)) found.push(flag);
  }
  if (found.length === 0) {
    return fail(
      ERR.INVALID_USAGE,
      "Exactly one of --once, --watch, --status, --stop is required.",
      { required: ACTION_FLAGS.map((f) => `--${f}`) },
      EXIT.INVALID_USAGE,
    );
  }
  if (found.length > 1) {
    return fail(
      ERR.INVALID_USAGE,
      "Only one of --once, --watch, --status, --stop may be set.",
      { conflicting: found },
      EXIT.INVALID_USAGE,
    );
  }
  return { action: found[0] };
}

function parseTarget(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail(ERR.INVALID_USAGE, "--target is required.", {}, EXIT.INVALID_USAGE);
  }
  const match = TARGET_PATTERN.exec(raw);
  if (!match) {
    return fail(
      ERR.INVALID_USAGE,
      "--target must match <kind>:<actorId> with kind ∈ {coordinator, agent, user, service, adapter}.",
      { value: raw },
      EXIT.INVALID_USAGE,
    );
  }
  const kind = match[1];
  const actorId = match[2];
  if (!ACTOR_KIND_SET.has(kind)) {
    return fail(
      ERR.INVALID_USAGE,
      `--target kind '${kind}' is not part of the coordination actor vocabulary (coordinator, agent, user, service, adapter).`,
      { allowed: ACTOR_KINDS },
      EXIT.INVALID_USAGE,
    );
  }
  if (!SAFE_ID.test(actorId)) {
    return fail(
      ERR.INVALID_USAGE,
      "--target actorId contains unsupported characters.",
      { actorId },
      EXIT.INVALID_USAGE,
    );
  }
  return { target: { kind, actorId, raw } };
}

function parseConsumer(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail(ERR.INVALID_USAGE, "--consumer is required.", {}, EXIT.INVALID_USAGE);
  }
  if (!SAFE_ID.test(raw)) {
    return fail(
      ERR.INVALID_USAGE,
      "--consumer contains unsupported characters.",
      { consumer: raw },
      EXIT.INVALID_USAGE,
    );
  }
  return { consumer: raw };
}

function parseAdapter(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail(ERR.INVALID_USAGE, "--adapter is required.", {}, EXIT.INVALID_USAGE);
  }
  if (!ADAPTER_SET.has(raw)) {
    return fail(
      ERR.INVALID_USAGE,
      `--adapter '${raw}' is not in the whitelist.`,
      { whitelist: ADAPTER_WHITELIST },
      EXIT.INVALID_USAGE,
    );
  }
  return { adapter: raw };
}

function parseProject(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return fail(ERR.INVALID_USAGE, "--project is required.", {}, EXIT.INVALID_USAGE);
  }
  return { project: raw };
}

function parseIntegerOption(raw, name, min, max) {
  if (raw === undefined) return { value: undefined };
  if (typeof raw !== "string" || raw.length === 0 || !/^\d+$/.test(raw)) {
    return fail(
      ERR.INVALID_USAGE,
      `--${name} must be an integer between ${min} and ${max}.`,
      { value: raw },
      EXIT.INVALID_USAGE,
    );
  }
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    return fail(
      ERR.INVALID_USAGE,
      `--${name} must be between ${min} and ${max}.`,
      { value: raw },
      EXIT.INVALID_USAGE,
    );
  }
  return { value: number };
}

function parsePumpOptions(args) {
  const project = parseProject(readOption(args, "project"));
  if (project.error) return project;
  const consumer = parseConsumer(readOption(args, "consumer"));
  if (consumer.error) return consumer;
  const target = parseTarget(readOption(args, "target"));
  if (target.error) return target;
  const adapter = parseAdapter(readOption(args, "adapter"));
  if (adapter.error) return adapter;

  const intervalMs = parseIntegerOption(
    readOption(args, "interval-ms"),
    "interval-ms",
    1000,
    3600000,
  );
  if (intervalMs.error) return intervalMs;
  const maxAttempts = parseIntegerOption(
    readOption(args, "max-attempts"),
    "max-attempts",
    1,
    50,
  );
  if (maxAttempts.error) return maxAttempts;

  const eventId = readOption(args, "event");

  const options = {
    project: project.project,
    consumer: consumer.consumer,
    target: target.target,
    adapter: adapter.adapter,
    intervalMs: intervalMs.value, // undefined => host uses default
    maxAttempts: maxAttempts.value, // undefined => host uses default
    eventId: typeof eventId === "string" && eventId.length > 0 ? eventId : undefined,
  };
  return { options };
}

/**
 * Parse the notification CLI args. Returns a structured result that the host
 * uses (no side effects, no process.exit). The CLI surface intentionally
 * never accepts `event.command` or `event.executable`; the adapter host
 * injects those via the harness.
 */
function parseNotificationArgs(args) {
  if (!Array.isArray(args)) {
    return fail(ERR.INVALID_USAGE, "Args must be an array.", {}, EXIT.INVALID_USAGE);
  }
  const resource = args[0];
  const action = args[1];
  if (resource === undefined) {
    return fail(
      ERR.UNSUPPORTED,
      "Missing notification subcommand. Supported: pump.",
      { allowed: ["pump"] },
      EXIT.UNSUPPORTED,
    );
  }
  if (resource !== "notification") {
    return fail(
      ERR.INVALID_USAGE,
      "parseNotificationArgs expects the first arg to be 'notification'.",
      { resource },
      EXIT.INVALID_USAGE,
    );
  }
  if (action !== "pump") {
    return fail(
      ERR.UNSUPPORTED,
      `Unsupported notification subcommand '${action}'. Supported: pump.`,
      { allowed: ["pump"] },
      EXIT.UNSUPPORTED,
    );
  }

  const detected = detectAction(args);
  if (detected.error) return detected;
  const parsed = parsePumpOptions(args);
  if (parsed.error) return parsed;

  return buildResult({
    ok: true,
    action: detected.action,
    options: parsed.options,
    exitCode: EXIT.SUCCESS,
  });
}

/**
 * Static descriptor for the public surface that the host can introspect
 * without re-parsing flags. Used by `cortex-agent help notification --json`.
 */
function describeNotificationContract() {
  return {
    command: "notification",
    action: "pump",
    required_flags: ["--project", "--consumer", "--target", "--adapter"],
    action_flags: ACTION_FLAGS.slice(),
    action_exclusivity: "exactly_one",
    adapter_whitelist: ADAPTER_WHITELIST.slice(),
    target_format: "<kind>:<actorId>",
    target_kind_vocabulary: ACTOR_KINDS.slice(),
    consumer_id_pattern: SAFE_ID.source,
    event_surface_limits: [
      "event.command is NOT accepted from the CLI surface.",
      "event.executable is NOT accepted from the CLI surface.",
      "Adapter hosts inject these fields, not the CLI.",
    ],
    options: {
      "--interval-ms": { min: 1000, max: 3600000, default: 1000 },
      "--max-attempts": { min: 1, max: 50, default: 5 },
    },
    exit_codes: {
      0: "success",
      1: "invalid usage",
      2: "unsupported",
      3: "runtime failure",
      4: "capability unavailable",
    },
  };
}

/**
 * Execute the parsed request via an injected harness. The harness is the
 * boundary into the runtime: it owns the journal, cursor, and adapter module.
 * The CLI layer never calls the runtime NotificationPump directly — that's the
 * host's job.
 *
 * Harness shape:
 *   {
 *     resolvePump(options): { pump, stop?, getStatus? } | Promise<...>,
 *     notify?(event: { stage: 'start'|'tick'|'stop'|'error', payload }): void,
 *   }
 *
 * The harness MUST be supplied by the host. Calls without a harness fail
 * closed with CAPABILITY_UNAVAILABLE.
 */
async function executeNotificationCommand(args, harness = {}) {
  const parsed = parseNotificationArgs(args);
  if (!parsed.ok) return parsed;

  if (typeof harness.resolvePump !== "function") {
    return fail(
      ERR.CAPABILITY,
      "Notification harness is not configured; the host must inject resolvePump.",
      {},
      EXIT.CAPABILITY,
    );
  }

  try {
    const resolved = await harness.resolvePump({
      action: parsed.action,
      options: parsed.options,
    });
    if (!resolved || typeof resolved.pump !== "object" || resolved.pump === null) {
      return fail(
        ERR.CAPABILITY,
        "Harness did not return a usable pump instance.",
        { action: parsed.action },
        EXIT.CAPABILITY,
      );
    }
    const { pump, stop, getStatus } = resolved;
    const notify = typeof harness.notify === "function"
      ? (event) => {
        try { harness.notify(event); } catch (_) { /* swallow host notify errors */ }
      }
      : () => {};

    if (parsed.action === "once") {
      if (typeof pump.runOnce !== "function") {
        return fail(ERR.CAPABILITY, "Pump adapter does not support runOnce.", {}, EXIT.CAPABILITY);
      }
      const report = await pump.runOnce();
      notify({ stage: "stop", payload: { action: "once", report } });
      return buildResult({
        ok: true,
        action: "once",
        options: parsed.options,
        exitCode: EXIT.SUCCESS,
        report,
      });
    }
    if (parsed.action === "status") {
      if (typeof getStatus !== "function") {
        return fail(ERR.CAPABILITY, "Pump adapter does not support status.", {}, EXIT.CAPABILITY);
      }
      const status = await getStatus();
      return buildResult({
        ok: true,
        action: "status",
        options: parsed.options,
        exitCode: EXIT.SUCCESS,
        report: status,
      });
    }
    if (parsed.action === "stop") {
      if (typeof stop !== "function") {
        return fail(ERR.CAPABILITY, "Pump adapter does not support stop.", {}, EXIT.CAPABILITY);
      }
      await stop();
      return buildResult({
        ok: true,
        action: "stop",
        options: parsed.options,
        exitCode: EXIT.SUCCESS,
      });
    }
    if (parsed.action === "watch") {
      if (typeof pump.watch === "function") {
        notify({ stage: "start", payload: { mode: "fs-watch-with-backoff" } });
        await pump.watch();
        notify({ stage: "stop", payload: { action: "watch" } });
        return buildResult({
          ok: true,
          action: "watch",
          options: parsed.options,
          exitCode: EXIT.SUCCESS,
        });
      }
      return fail(
        ERR.CAPABILITY,
        "Production watch requires a runtime with fs events and internal backoff.",
        {},
        EXIT.CAPABILITY,
      );
    }
    return fail(
      ERR.UNSUPPORTED,
      `Unknown action '${parsed.action}'.`,
      { action: parsed.action },
      EXIT.UNSUPPORTED,
    );
  } catch (error) {
    const key = error && (error.code || error.key);
    return fail(
      ERR.RUNTIME,
      error && error.message ? error.message : "Notification pump failed.",
      { originalCode: key || null },
      EXIT.RUNTIME,
    );
  }
}

module.exports = {
  // Constants
  ADAPTER_WHITELIST,
  ACTION_FLAGS,
  ACTOR_KINDS,
  EXIT,
  ERR,
  // Pure helpers
  parseNotificationArgs,
  parsePumpOptions,
  detectAction,
  parseTarget,
  parseConsumer,
  parseAdapter,
  parseProject,
  parseIntegerOption,
  describeNotificationContract,
  exitCodeLabel,
  // Host entry point
  executeNotificationCommand,
};
