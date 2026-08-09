"use strict";

// ─── M-003 CLI Dispatcher (M-003 MS-001) ──────────────────────────────────────
//
// Routes the 2 new subcommands `agent adapter <list|health>` and
// `agent dispatch-execute` that the M-002 dispatcher (lib/agents/cli.js)
// does not handle. The `bin/cli.js` `case "agent":` block peeks at the
// first positional arg and routes to either M-002 or M-003 (this file).
//
//   agent <discover|invoke|report|launch>  → M-002 / M-008 (lib/agents/cli.js)
//   agent adapter <list|health>            → M-003 (this file)
//   agent dispatch-execute <id> <task>     → M-003 (this file)
//
// Strictly additive: this file does NOT touch lib/agents/cli.js. The M-002
// `agent invoke` continues to produce a plan-only result (D-003-7: that IS
// the "--plan-only" mode, backward-compat with M-002 5/5). The new
// `agent dispatch-execute` is the real-dispatch path (D-003-3 default).
//
// Exit codes (consistent with M-002):
//   0  success
//   2  usage error (missing arg, bad flag)
//   3  invoke / dispatch failed
//   4  health check reported "down" / "degraded"

const fs = require("node:fs");
const path = require("node:path");

const adapters = require("./adapters");
const {
  dispatchExecute,
  dispatchExecuteProtocol,
  PROTOCOLS,
} = require("./dispatch-execute");
const { readAgent } = require("./registry");
// §6.2 fix (per VC-M-003-MS-004-dispatch.json): additive extension of
// VALID_ADAPTER_TYPES to include MS-003 minimax. The new module re-exports
// the M-002 list + the MS-003+ add list as a frozen union. We import it for
// surface-API parity and future use; the additive types are already accepted
// at the dispatch layer (the M-002 `writeAgent` validator stays strict per
// the §6.2-Eric-8-04-18:20 拍板).
const { validateAdapterTypeExt } = require("./registry-adapter-types");

// ─── argv parsing ────────────────────────────────────────────────────────────

function parseArgs(args) {
  const out = {
    subcommand: null,
    action: null,            // for "agent adapter <list|health>": "list" or "health"
    adapterId: null,         // for "agent adapter health <id>"
    projectRoot: null,
    outputFormat: "human",
    outputJson: false,
    showHelp: false,
    // dispatch-execute
    agentId: null,
    taskDescription: null,
    inputFile: null,
    timeout: 300,
    runId: null,
    requiredCapabilities: [],
    // M-003 MS-004: 3-protocol dispatch (http / cli / file). When `protocol`
    // is null, fall through to the M-003 MS-001 per-adapter `invoke()` path.
    protocol: null,        // "http" | "cli" | "file" | null (= M-001 path)
    url: null,             // HTTP
    bin: null,             // CLI
    args: [],              // CLI
    configPath: null,      // file
    outputPath: null,      // file
  };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { out.showHelp = true; continue; }
    if (arg === "--json") { out.outputJson = true; out.outputFormat = "json"; continue; }
    if (arg === "--output") {
      const v = args[i + 1];
      if (v === "json" || v === "human") { out.outputFormat = v; out.outputJson = v === "json"; i++; }
      continue;
    }
    if (arg && arg.startsWith("--output=")) {
      const v = arg.slice("--output=".length);
      if (v === "json" || v === "human") { out.outputFormat = v; out.outputJson = v === "json"; }
      continue;
    }
    if (arg === "--project") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.projectRoot = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--project=")) { out.projectRoot = arg.slice("--project=".length); continue; }
    if (arg === "--capability") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out._capabilityFlag = v; i++; }
      else { out._capabilityFlag = ""; }
      continue;
    }
    if (arg && arg.startsWith("--capability=")) { out._capabilityFlag = arg.slice("--capability=".length); continue; }
    if (arg === "--input") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.inputFile = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--input=")) { out.inputFile = arg.slice("--input=".length); continue; }
    if (arg === "--timeout") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) { out.timeout = n; i++; }
      continue;
    }
    if (arg && arg.startsWith("--timeout=")) {
      const n = Number(arg.slice("--timeout=".length));
      if (Number.isFinite(n) && n > 0) out.timeout = n;
      continue;
    }
    if (arg === "--run-id") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.runId = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--run-id=")) { out.runId = arg.slice("--run-id=".length); continue; }
    // M-003 MS-004: 3-protocol dispatch flags
    if (arg === "--protocol") {
      const v = args[i + 1];
      if (v === "http" || v === "cli" || v === "file") { out.protocol = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--protocol=")) {
      const v = arg.slice("--protocol=".length);
      if (v === "http" || v === "cli" || v === "file") out.protocol = v;
      continue;
    }
    if (arg === "--url") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.url = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--url=")) { out.url = arg.slice("--url=".length); continue; }
    if (arg === "--bin") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.bin = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--bin=")) { out.bin = arg.slice("--bin=".length); continue; }
    if (arg === "--arg") {
      const v = args[i + 1];
      if (v) { out.args.push(v); i++; }
      continue;
    }
    if (arg === "--config-path") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.configPath = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--config-path=")) { out.configPath = arg.slice("--config-path=".length); continue; }
    if (arg === "--output-path") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.outputPath = v; i++; }
      continue;
    }
    if (arg && arg.startsWith("--output-path=")) { out.outputPath = arg.slice("--output-path=".length); continue; }
    if (arg && arg.startsWith("--")) { continue; } // unknown flag: ignore (FAE-001 permissive)
    positional.push(arg);
  }
  out.subcommand = positional[0] || null;
  out.action = positional[1] || null;
  // adapter health: positional[2] = adapter id
  // dispatch-execute: positional[1] = agentId, positional[2..] joined = task
  if (out.subcommand === "adapter" && out.action === "health") {
    out.adapterId = positional[2] || null;
  } else if (out.subcommand === "dispatch-execute") {
    out.agentId = positional[1] || null;
    out.taskDescription = positional.slice(2).join(" ") || null;
  }
  out._positional = positional;
  return out;
}

// ─── formatters ─────────────────────────────────────────────────────────────

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHumanAdapterList(result) {
  const lines = [];
  lines.push(`agent adapter list (registered=${result.count})`);
  lines.push("");
  for (const a of result.adapters) {
    const cap = (a.capabilities || []).join(", ");
    lines.push(`- ${a.adapter_type} v${a.version || "?"}`);
    lines.push(`    protocol: ${a.protocol || "n/a"}`);
    lines.push(`    transport: ${a.transport || "n/a"}`);
    lines.push(`    capabilities: ${cap || "(none)"}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHumanAdapterHealth(result) {
  const lines = [];
  lines.push(`agent adapter health adapter_id=${result.adapter_id}`);
  lines.push(`  status=${result.status} ready=${result.ready} latency_ms=${result.latency_ms}`);
  if (result.error) lines.push(`  error: ${result.error}`);
  if (result.details && Object.keys(result.details).length > 0) {
    lines.push(`  details: ${JSON.stringify(result.details)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHumanDispatch(result) {
  const lines = [];
  lines.push(`agent dispatch-execute run_id=${result.runId} agent_id=${result.agent_id} adapter_type=${result.adapter_type}`);
  lines.push(`  status=${result.status} attempts=${result.attempts || 1} latency_ms=${result.latency_ms}`);
  if (result.error) {
    lines.push(`  error: ${result.error.code} — ${result.error.message}`);
  }
  if (result.result) {
    const preview = JSON.stringify(result.result).slice(0, 200);
    lines.push(`  result: ${preview}${preview.length === 200 ? "..." : ""}`);
  }
  if (result.dispatcher) {
    lines.push(`  dispatcher: ${result.dispatcher}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHelp() {
  const help = `Usage:
  cortex-agent agent adapter list [options]
  cortex-agent agent adapter health <adapter_id> [options]
  cortex-agent agent dispatch-execute <agent_id> <task_description> [options]

Adapter options (list / health):
  --project <path>           Target project root (default: cwd)
  --output json|human        Output format (default: human)
  --json                     Shortcut for --output json

Dispatch-execute options (real dispatch, M-003 default per D-003-3):
  --input <file>             Read task input payload from file (JSON or string)
  --timeout <seconds>        Per-attempt timeout (default 300)
  --run-id <id>              Explicit run id (default: auto-gen)
  --capability <c>           Required capability (can be repeated; subset of declared)
  --project <path>           Target project root (default: cwd)
  --output json|human        Output format (default: human)
  --json                     Shortcut for --output json

M-003 MS-004: 3-protocol dispatch (optional — default = M-001 adapter.invoke path):
  --protocol http|cli|file   Use the unified transport layer (HTTP / CLI / file).
                              When set, bypasses the per-adapter invoke() and goes
                              through lib/agents/dispatch-execute.js#dispatchExecuteProtocol.
  --url <url>                HTTP target URL (with --protocol http)
  --bin <path>               CLI binary path or name (with --protocol cli)
  --arg <arg>                CLI argument (repeatable; with --protocol cli)
  --config-path <file>       File protocol input config (with --protocol file)
  --output-path <file>       File protocol output path (with --protocol file)

Exit codes:
  0  success
  2  usage error (missing arg, bad flag)
  3  dispatch / invoke failed
  4  health check reported 'down' or 'degraded'

Subcommand routing (per FAE-001 / M-013.P0 / MS-002 pattern, additive to M-002):
  - agent <discover|invoke|report|launch>  → M-002 / M-008 (lib/agents/cli.js)
  - agent adapter <list|health>            → M-003 (this file, D-003-4)
  - agent dispatch-execute <id> <task>     → M-003 (this file, D-003-3 + D-003-7)
  - agent dispatch-execute ... --protocol  → M-003 MS-004 (this file, 3-protocol path)

Examples:
  cortex-agent agent adapter list
  cortex-agent agent adapter health claude-code --output json
  cortex-agent agent dispatch-execute Worker-A-MS001 "review the schema" --output json
  cortex-agent agent dispatch-execute Claude-1 "summarize" --input ./task.json --timeout 60
  cortex-agent agent dispatch-execute Worker-A "review" --protocol http --url http://localhost:8080/invoke
  cortex-agent agent dispatch-execute Worker-A "review" --protocol cli  --bin /path/to/fake.sh
  cortex-agent agent dispatch-execute Worker-A "review" --protocol file --config-path ./cfg.json --output-path ./out.json
`;
  process.stdout.write(help);
}

// ─── handlers ──────────────────────────────────────────────────────────────

function runAdapterList(parsed, lang) {
  const all = adapters.instances();
  const items = all.map(({ type, instance }) => {
    let meta = {};
    try { meta = instance.discover() || {}; } catch (err) {
      meta = { error: err.message };
    }
    return {
      adapter_type: type,
      ...meta,
    };
  });
  const result = { count: items.length, adapters: items };
  if (parsed.outputJson) printJson(result);
  else printHumanAdapterList(result);
  process.exitCode = 0;
}

async function runAdapterHealth(parsed, lang) {
  if (!parsed.adapterId) {
    const msg = lang === "zh"
      ? "错误: agent adapter health <id> 需要 adapter id"
      : "Error: agent adapter health <id> requires an adapter id";
    process.stderr.write(`${msg}\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  const adapter = adapters.get(parsed.adapterId);
  if (!adapter) {
    const result = {
      adapter_id: parsed.adapterId,
      status: "down",
      ready: false,
      latency_ms: 0,
      error: `no adapter registered for adapter_type "${parsed.adapterId}". Known: ${adapters.list().join(", ") || "(none)"}`,
      details: { known_adapters: adapters.list() },
    };
    if (parsed.outputJson) printJson(result);
    else printHumanAdapterHealth(result);
    process.exitCode = 4;
    return;
  }
  let healthResult;
  try {
    healthResult = await adapter.health();
  } catch (err) {
    healthResult = {
      status: "down",
      ready: false,
      latency_ms: 0,
      error: err.message,
      details: {},
    };
  }
  const wrapped = {
    adapter_id: parsed.adapterId,
    ...healthResult,
  };
  if (parsed.outputJson) printJson(wrapped);
  else printHumanAdapterHealth(wrapped);
  process.exitCode = healthResult.status === "ok" ? 0 : 4;
}

function loadInput(filePath) {
  if (!filePath) return null;
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    const err = new Error(`--input file not found: ${abs}`);
    err.code = "ERR_INPUT_FILE_NOT_FOUND";
    throw err;
  }
  return fs.readFileSync(abs, "utf8");
}

async function runDispatchExecute(parsed, lang) {
  if (!parsed.agentId || !parsed.taskDescription) {
    const msg = lang === "zh"
      ? "用法: agent dispatch-execute <agent_id> <task_description> [...]\n错误: <agent_id> 和 <task_description> 必填"
      : "Usage: agent dispatch-execute <agent_id> <task_description> [...]\nError: <agent_id> and <task_description> required";
    process.stderr.write(`${msg}\n`);
    process.exitCode = 2;
    return;
  }
  const projectRoot = parsed.projectRoot ? path.resolve(parsed.projectRoot) : process.cwd();
  let input = null;
  try {
    input = loadInput(parsed.inputFile);
  } catch (err) {
    process.stderr.write(`agent dispatch-execute error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  // Resolve the agent entry to figure out which adapter to use.
  let entry;
  try {
    entry = readAgent(projectRoot, parsed.agentId);
  } catch (err) {
    const result = {
      runId: parsed.runId,
      agent_id: parsed.agentId,
      adapter_type: null,
      status: "failed",
      result: null,
      error: { code: err.code || "ERR_AGENT_READ", message: err.message },
      latency_ms: 0,
      dispatcher: "m003-cli",
    };
    if (parsed.outputJson) printJson(result);
    else printHumanDispatch(result);
    process.exitCode = 3;
    return;
  }
  if (!entry) {
    const result = {
      runId: parsed.runId,
      agent_id: parsed.agentId,
      adapter_type: null,
      status: "failed",
      error: { code: "ERR_AGENT_NOT_FOUND", message: `agent "${parsed.agentId}" not in .agent/agents/` },
      latency_ms: 0,
      dispatcher: "m003-cli",
    };
    if (parsed.outputJson) printJson(result);
    else printHumanDispatch(result);
    process.exitCode = 3;
    return;
  }
  if (!entry.external || !entry.external.adapter_type) {
    const result = {
      runId: parsed.runId,
      agent_id: parsed.agentId,
      adapter_type: null,
      status: "failed",
      error: { code: "ERR_NO_ADAPTER", message: `agent "${parsed.agentId}" has no external.adapter_type; dispatch-execute only works on external agents` },
      latency_ms: 0,
      dispatcher: "m003-cli",
    };
    if (parsed.outputJson) printJson(result);
    else printHumanDispatch(result);
    process.exitCode = 3;
    return;
  }
  const adapterType = entry.external.adapter_type;
  const adapter = adapters.get(adapterType);
  if (!adapter) {
    const result = {
      runId: parsed.runId,
      agent_id: parsed.agentId,
      adapter_type: adapterType,
      status: "failed",
      error: { code: "ERR_ADAPTER_NOT_REGISTERED", message: `no adapter registered for adapter_type "${adapterType}". Known: ${adapters.list().join(", ") || "(none)"}` },
      latency_ms: 0,
      dispatcher: "m003-cli",
    };
    if (parsed.outputJson) printJson(result);
    else printHumanDispatch(result);
    process.exitCode = 3;
    return;
  }

  // Capability subset check (mirrors M-002 lib/agents/invoke.js behaviour)
  const requiredCapabilities = parsed._capabilityFlag !== undefined && parsed._capabilityFlag !== ""
    ? parsed._capabilityFlag.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  if (requiredCapabilities.length > 0) {
    const declared = Array.isArray(entry.capabilities) ? entry.capabilities : [];
    const missing = requiredCapabilities.filter((c) => !declared.includes(c));
    if (missing.length > 0) {
      const result = {
        runId: parsed.runId,
        agent_id: parsed.agentId,
        adapter_type: adapterType,
        status: "failed",
        error: {
          code: "ERR_CAPABILITY_MISMATCH",
          message: `agent "${parsed.agentId}" missing capabilities: ${missing.join(", ")}`,
          required: requiredCapabilities,
          declared,
          missing,
        },
        latency_ms: 0,
        dispatcher: "m003-cli",
      };
      if (parsed.outputJson) printJson(result);
      else printHumanDispatch(result);
      process.exitCode = 3;
      return;
    }
  }

  // M-003 MS-004: 3-protocol dispatch path. When --protocol is set, bypass
  // the per-adapter `invoke()` and route through the unified transport
  // layer in lib/agents/dispatch-execute.js#dispatchExecuteProtocol.
  if (parsed.protocol) {
    return runDispatchExecuteProtocol(parsed, entry, adapterType, projectRoot, input);
  }

  // Invoke the adapter with the real dispatch path.
  const start = Date.now();
  let adapterResult;
  try {
    adapterResult = await adapter.invoke(
      { task: parsed.taskDescription, input },
      {
        runId: parsed.runId,
        projectRoot,
        agentId: parsed.agentId,
        configRef: entry.external.config_ref || null,
        credentialRef: entry.external.credential_ref || null,
        timeout: parsed.timeout,
      },
    );
  } catch (err) {
    adapterResult = {
      runId: parsed.runId,
      status: "failed",
      result: null,
      error: { code: err.code || "ERR_DISPATCH_INVOKE", message: err.message },
      latency_ms: Date.now() - start,
    };
  }
  const wrapped = {
    ...adapterResult,
    agent_id: parsed.agentId,
    adapter_type: adapterType,
    dispatcher: "m003-cli (adapter.invoke)",
  };
  if (parsed.outputJson) printJson(wrapped);
  else printHumanDispatch(wrapped);
  process.exitCode = adapterResult.status === "ok" ? 0 : 3;
}

// ─── M-003 MS-004: 3-protocol dispatch path (http / cli / file) ─────────────
//
// Triggered when `parsed.protocol` is set. Bypasses the per-adapter
// `adapter.invoke()` and uses `dispatchExecuteProtocol` (the unified
// transport layer) instead. Protocol-specific config (url, bin, args,
// configPath, outputPath) comes from CLI flags + agent entry fields.
//
// The §6.2 fix (additive minimax + future M-003+ adapter types) is applied
// here via `validateAdapterTypeExt` — the agent entry's adapter_type is
// checked against the M-002 + MS-003+ union. If it's neither, we surface
// ERR_INVALID_ADAPTER_TYPE (same code as M-002's strict validator).
async function runDispatchExecuteProtocol(parsed, entry, adapterType, projectRoot, input) {
  // §6.2 fix: accept additive adapter types (M-003 minimax + future M-003+).
  // M-002's strict validator would throw "minimax is not in the list"; the
  // additive file's union includes it. This is a non-breaking change because
  // previously unknown types would have failed downstream anyway (no
  // adapter registered for them).
  try {
    validateAdapterTypeExt(adapterType);
  } catch (err) {
    const result = {
      runId: parsed.runId,
      agent_id: parsed.agentId,
      adapter_type: adapterType,
      status: "failed",
      error: { code: err.code || "ERR_INVALID_ADAPTER_TYPE", message: err.message },
      latency_ms: 0,
      dispatcher: `m003-cli (protocol.${parsed.protocol})`,
    };
    if (parsed.outputJson) printJson(result);
    else printHumanDispatch(result);
    process.exitCode = 3;
    return;
  }

  // Build protocol-specific config. Defaults are derived from the agent
  // entry's adapter_type so the user can run with minimal flags.
  const protocolOpts = {
    protocol: parsed.protocol,
    projectRoot,
    runId: parsed.runId,
    agentType: adapterType,
    configRef: entry.external.config_ref,
    credentialRef: entry.external.credential_ref,
    timeout: parsed.timeout,
    payload: { task: parsed.taskDescription, input },
  };
  if (parsed.protocol === PROTOCOLS.HTTP) {
    protocolOpts.url = parsed.url || `http://localhost/${adapterType}/invoke`;
    protocolOpts.method = "POST";
    protocolOpts.headers = { "Content-Type": "application/json" };
  } else if (parsed.protocol === PROTOCOLS.CLI) {
    protocolOpts.bin = parsed.bin || adapterType;
    protocolOpts.args = parsed.args || [];
    protocolOpts.shell = true;
  } else if (parsed.protocol === PROTOCOLS.FILE) {
    if (!parsed.configPath || !parsed.outputPath) {
      const result = {
        runId: parsed.runId,
        agent_id: parsed.agentId,
        adapter_type: adapterType,
        status: "failed",
        error: {
          code: "ERR_FILE_PROTOCOL",
          message: "--protocol file requires both --config-path and --output-path",
        },
        latency_ms: 0,
        dispatcher: `m003-cli (protocol.${parsed.protocol})`,
      };
      if (parsed.outputJson) printJson(result);
      else printHumanDispatch(result);
      process.exitCode = 2;
      return;
    }
    protocolOpts.configPath = path.resolve(parsed.configPath);
    protocolOpts.outputPath = path.resolve(parsed.outputPath);
  } else {
    const result = {
      runId: parsed.runId,
      agent_id: parsed.agentId,
      adapter_type: adapterType,
      status: "failed",
      error: {
        code: "ERR_DISPATCH_PROTOCOL_INVALID",
        message: `unknown protocol "${parsed.protocol}". Valid: ${Object.values(PROTOCOLS).join(", ")}`,
      },
      latency_ms: 0,
      dispatcher: `m003-cli (protocol.${parsed.protocol})`,
    };
    if (parsed.outputJson) printJson(result);
    else printHumanDispatch(result);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = await dispatchExecuteProtocol(protocolOpts);
  } catch (err) {
    result = {
      runId: parsed.runId,
      status: "failed",
      protocol: parsed.protocol,
      result: null,
      error: { code: err.code || "ERR_DISPATCH_PROTOCOL_INVALID", message: err.message },
      latency_ms: 0,
    };
  }
  const wrapped = {
    ...result,
    agent_id: parsed.agentId,
    adapter_type: adapterType,
    dispatcher: `m003-cli (protocol.${parsed.protocol})`,
  };
  if (parsed.outputJson) printJson(wrapped);
  else printHumanDispatch(wrapped);
  process.exitCode = result.status === "ok" ? 0 : 3;
}

// ─── public entry point ─────────────────────────────────────────────────────

function agentM003Command(ctx) {
  // ctx.args starts with "agent" — strip it so parseArgs sees the M-003
  // subcommand in positional[0].
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  const args = rawArgs[0] === "agent" ? rawArgs.slice(1) : rawArgs;
  const parsed = parseArgs(args);
  const lang = (ctx && ctx.lang) || "en";

  if (parsed.showHelp) {
    printHelp();
    process.exitCode = 0;
    return;
  }
  if (!parsed.subcommand) {
    process.stderr.write("Error: subcommand required (adapter | dispatch-execute).\n");
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (parsed.subcommand === "adapter") {
    if (!parsed.action || parsed.action === "list" || parsed.action === "--help" || parsed.action === "-h") {
      if (parsed.action === "--help" || parsed.action === "-h") {
        printHelp();
        process.exitCode = 0;
        return;
      }
      return runAdapterList(parsed, lang);
    }
    if (parsed.action === "health") {
      return runAdapterHealth(parsed, lang);
    }
    process.stderr.write(
      `Error: unknown agent adapter subcommand "${parsed.action}". Valid: list, health.\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (parsed.subcommand === "dispatch-execute") {
    return runDispatchExecute(parsed, lang);
  }
  process.stderr.write(
    `Error: unknown M-003 subcommand "${parsed.subcommand}". Valid: adapter, dispatch-execute.\n` +
    `For agent discover|invoke|report|launch, see M-002 (cortex-agent agent --help).\n`,
  );
  process.exitCode = 2;
}

module.exports = {
  agentM003Command,
  parseArgs,
  // exposed for tests
  _runAdapterList: runAdapterList,
  _runAdapterHealth: runAdapterHealth,
  _runDispatchExecute: runDispatchExecute,
};
