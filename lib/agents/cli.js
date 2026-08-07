"use strict";

// ─── Agent Registry CLI (M-002 MS-003) ────────────────────────────────────────
//
// `cortex-agent agent <discover|invoke>` — entry point for the Agent
// Registry subsystem (M-002 scope).
//
// Wired from `bin/cli.js` via subcommand dispatcher in the `case "agent":`
// block (per M-013.P0 / MS-002 pattern, with subcommand peek to avoid
// touching lib/commands.js):
//
//   if (args[1] in ["discover", "invoke"]) → agentRegistryCommand(ctx) (this)
//   else                                   → agent(ctx) (lib/commands.js, M-008)
//
// Exit codes:
//   - 0: success
//   - 2: usage error (missing arg, bad flag)
//   - 3: invoke failed (capability mismatch, agent not invocable, etc.)
//
// Subcommand surface:
//
//   agent discover [query] [--capability <cap>] [--role <r>] [--status <s>]
//                    [--adapter-type <t>] [--limit 10]
//                    [--project <path>] [--output json|human]
//
//   agent invoke <agent_id> <task_description>
//                  [--capability <c> ...] [--input <file>]
//                  [--timeout 300] [--run-id <id>]
//                  [--project <path>] [--output json|human]

const fs = require("node:fs");
const path = require("node:path");
const { discover } = require("./discover");
const { invoke } = require("./invoke");

// M-008 forward: `agent report` / `agent launch` are owned by Coordination
// runtime (lib/commands.js). Direct require keeps the M-001 binding contract
// (`lib/commands.js` is unchanged) and lets the M-002 dispatcher print
// consistent M-002 / M-008 help for `agent --help` and unknown subcommands.
// The `agent` function from lib/commands.js is async.
const { agent: m008Agent } = require("../commands");
const {
  VALID_ROLES,
  VALID_STATUSES,
  VALID_ADAPTER_TYPES,
  isValidRole,
  isValidStatus,
  isValidAdapterType,
} = (() => {
  // Re-export predicates from registry for CLI validation
  return {
    VALID_ROLES: require("../registry/index").VALID_ROLES,
    VALID_STATUSES: require("../registry/index").VALID_STATUSES,
    VALID_ADAPTER_TYPES: require("../registry/index").VALID_ADAPTER_TYPES,
    isValidRole: (r) => require("../registry/index").VALID_ROLES.includes(r),
    isValidStatus: (s) => require("../registry/index").VALID_STATUSES.includes(s),
    isValidAdapterType: (t) => require("../registry/index").VALID_ADAPTER_TYPES.includes(t),
  };
})();

// ─── argv parsing ────────────────────────────────────────────────────────────

function parseArgs(args) {
  const out = {
    subcommand: null,
    projectRoot: null,
    outputFormat: "human",
    outputJson: false,
    showHelp: false,
    // discover-specific
    query: null,
    capability: null,
    role: null,
    status: null,
    adapterType: null,
    limit: 10,
    // invoke-specific
    agentId: null,
    taskDescription: null,
    requiredCapabilities: [],
    inputFile: null,
    timeout: 300,
    runId: null,
  };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.showHelp = true;
      continue;
    }
    if (arg === "--json") {
      out.outputJson = true;
      out.outputFormat = "json";
      continue;
    }
    if (arg === "--output") {
      const v = args[i + 1];
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--output=")) {
      const v = arg.slice("--output=".length);
      if (v === "json" || v === "human") {
        out.outputFormat = v;
        out.outputJson = v === "json";
      }
      continue;
    }
    if (arg === "--project") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.projectRoot = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--project=")) {
      out.projectRoot = arg.slice("--project=".length);
      continue;
    }
    if (arg === "--capability") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out._capabilityFlag = v;
        i++;
      } else {
        out._capabilityFlag = "";
      }
      continue;
    }
    if (arg && arg.startsWith("--capability=")) {
      out._capabilityFlag = arg.slice("--capability=".length);
      continue;
    }
    if (arg === "--role") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out._roleFlag = v;
        i++;
      } else {
        out._roleFlag = "";
      }
      continue;
    }
    if (arg && arg.startsWith("--role=")) {
      out._roleFlag = arg.slice("--role=".length);
      continue;
    }
    if (arg === "--status") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out._statusFlag = v;
        i++;
      } else {
        out._statusFlag = "";
      }
      continue;
    }
    if (arg && arg.startsWith("--status=")) {
      out._statusFlag = arg.slice("--status=".length);
      continue;
    }
    if (arg === "--adapter-type") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out._adapterFlag = v;
        i++;
      } else {
        out._adapterFlag = "";
      }
      continue;
    }
    if (arg && arg.startsWith("--adapter-type=")) {
      out._adapterFlag = arg.slice("--adapter-type=".length);
      continue;
    }
    if (arg === "--limit") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        out.limit = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) out.limit = n;
      continue;
    }
    if (arg === "--input") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.inputFile = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--input=")) {
      out.inputFile = arg.slice("--input=".length);
      continue;
    }
    if (arg === "--timeout") {
      const v = args[i + 1];
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) {
        out.timeout = n;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--timeout=")) {
      const n = Number(arg.slice("--timeout=".length));
      if (Number.isFinite(n) && n > 0) out.timeout = n;
      continue;
    }
    if (arg === "--run-id") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) {
        out.runId = v;
        i++;
      }
      continue;
    }
    if (arg && arg.startsWith("--run-id=")) {
      out.runId = arg.slice("--run-id=".length);
      continue;
    }
    if (arg && arg.startsWith("--")) {
      // Unknown flag: ignore (FAE-001 permissive surface)
      continue;
    }
    positional.push(arg);
  }
  out.subcommand = positional[0] || null;
  // For discover: query = all remaining positional args joined by space
  // For invoke: positional[1] = agentId, positional[2..] joined = taskDescription
  out._positional = positional;
  return out;
}

// ─── formatters ──────────────────────────────────────────────────────────────

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHumanDiscover(result) {
  const lines = [];
  lines.push(`agent discover query="${result.query || ""}"`);
  if (result.capability) lines.push(`  capability=${result.capability}`);
  if (result.role) lines.push(`  role=${result.role}`);
  if (result.status) lines.push(`  status=${result.status}`);
  if (result.adapter_type) lines.push(`  adapter_type=${result.adapter_type}`);
  lines.push(`scanned=${result.scanned} matched=${result.matched} returned=${result.returned}`);
  lines.push("");
  for (const a of result.agents) {
    lines.push(`- ${a.agent_id} (${a.role}, ${a.model}, ${a.status}, score=${a.score})`);
    if (a.capabilities && a.capabilities.length > 0) {
      lines.push(`    capabilities: ${a.capabilities.join(", ")}`);
    }
    if (a.external) {
      lines.push(`    external: ${a.external.adapter_type}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHumanInvoke(result) {
  const lines = [];
  lines.push(`agent invoke run_id=${result.run_id} agent_id=${result.agent_id}`);
  if (result.error) {
    lines.push(`ERROR: ${result.error.code} — ${result.error.message}`);
    if (result.error.missing) {
      lines.push(`  missing_capabilities: ${result.error.missing.join(", ")}`);
    }
  } else if (result.status === "planned") {
    lines.push(`status=planned (MS-003 ships plan only; real execution in M-003 mission)`);
    if (result.plan) {
      lines.push(`plan.kind=${result.plan.kind}`);
      if (result.plan.entry_point) {
        lines.push(`plan.entry_point.type=${result.plan.entry_point.type}`);
        if (result.plan.entry_point.adapter_type) {
          lines.push(`plan.entry_point.adapter_type=${result.plan.entry_point.adapter_type}`);
        }
      }
      lines.push(`plan.protocol=${result.plan.protocol}`);
      lines.push(`plan.timeout=${result.plan.timeout}`);
    }
  } else {
    lines.push(`status=${result.status || "unknown"}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHelp() {
  const help = `Usage:
  cortex-agent agent discover [query] [options]
  cortex-agent agent invoke <agent_id> <task_description> [options]

Discover options:
  --capability <cap>         Filter by single capability
  --role <r>                 Filter by role (${VALID_ROLES.join("|")})
  --status <s>               Filter by status (${VALID_STATUSES.join("|")})
  --adapter-type <t>         Filter by external adapter type (${VALID_ADAPTER_TYPES.join("|")})
  --limit <n>                Max results (1-100, default 10)
  --project <path>           Target project root (default: cwd)
  --output json|human        Output format (default: human)
  --json                     Shortcut for --output json

Invoke options:
  --capability <c>           Required capability (can be repeated to require multiple)
  --input <file>             Read task input payload from file
  --timeout <seconds>        Invocation timeout (default 300)
  --run-id <id>              Explicit run id (default: auto-gen)
  --project <path>           Target project root (default: cwd)
  --output json|human        Output format (default: human)
  --json                     Shortcut for --output json

Exit codes:
  0  success
  2  usage error (missing arg, bad flag)
  3  invoke failed (agent not found, capability mismatch, status not invocable)

Subcommand routing (per FAE-001 / M-013.P0 / MS-002 pattern):
  - \`agent discover|invoke\`  → M-002 scope (this CLI, Agent Registry static)
  - \`agent report|launch\`    → M-008 scope (lib/commands.js, Coordination runtime)
  - \`agent\` (no subcommand)  → M-008 scope (legacy bridge to host-event-bridge)

Examples:
  cortex-agent agent discover --capability schema_design
  cortex-agent agent discover "Worker-A" --status completed --limit 5
  cortex-agent agent invoke Worker-A-MS001 "review my recent PR" \\
    --capability code_review --input ./task.json
`;
  process.stdout.write(help);
}

// ─── subcommand: discover ───────────────────────────────────────────────────

function runDiscover(parsed, lang) {
  const root = parsed.projectRoot ? path.resolve(parsed.projectRoot) : process.cwd();
  const query = (parsed._positional.slice(1).join(" ")) || "";

  // Validate optional flags
  if (parsed._roleFlag !== undefined && !isValidRole(parsed._roleFlag)) {
    const usage = lang === "zh"
      ? `错误: --role 必须是 ${VALID_ROLES.join("|")} 之一`
      : `Error: --role must be one of ${VALID_ROLES.join("|")}`;
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed._statusFlag !== undefined && !isValidStatus(parsed._statusFlag)) {
    const usage = lang === "zh"
      ? `错误: --status 必须是 ${VALID_STATUSES.join("|")} 之一`
      : `Error: --status must be one of ${VALID_STATUSES.join("|")}`;
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed._adapterFlag !== undefined && !isValidAdapterType(parsed._adapterFlag)) {
    const usage = lang === "zh"
      ? `错误: --adapter-type 必须是 ${VALID_ADAPTER_TYPES.join("|")} 之一`
      : `Error: --adapter-type must be one of ${VALID_ADAPTER_TYPES.join("|")}`;
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = discover({
      projectRoot: root,
      query,
      capability: parsed._capabilityFlag !== undefined ? parsed._capabilityFlag : null,
      role: parsed._roleFlag !== undefined ? parsed._roleFlag : null,
      status: parsed._statusFlag !== undefined ? parsed._statusFlag : null,
      adapterType: parsed._adapterFlag !== undefined ? parsed._adapterFlag : null,
      limit: parsed.limit,
    });
  } catch (error) {
    process.stderr.write(`agent discover error: ${error.message}\n`);
    process.exitCode = 3;
    return;
  }

  if (parsed.outputJson) {
    printJson(result);
  } else {
    printHumanDiscover(result);
  }
  process.exitCode = 0;
}

// ─── subcommand: invoke ─────────────────────────────────────────────────────

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

function runInvoke(parsed, lang) {
  const positional = parsed._positional;
  if (positional.length < 3) {
    const usage = lang === "zh"
      ? "用法: agent invoke <agent_id> <task_description> [...]\n错误: <agent_id> 和 <task_description> 必填"
      : "Usage: agent invoke <agent_id> <task_description> [...]\nError: <agent_id> and <task_description> required";
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }
  const agentId = positional[1];
  const taskDescription = positional.slice(2).join(" ");
  const root = parsed.projectRoot ? path.resolve(parsed.projectRoot) : process.cwd();

  const requiredCapabilities = parsed._capabilityFlag !== undefined && parsed._capabilityFlag !== ""
    ? parsed._capabilityFlag.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  let input = null;
  try {
    input = loadInput(parsed.inputFile);
  } catch (error) {
    process.stderr.write(`agent invoke error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const result = invoke({
    projectRoot: root,
    runId: parsed.runId,
    agentId,
    taskDescription,
    input,
    requiredCapabilities,
    timeout: parsed.timeout,
  });

  if (parsed.outputJson) {
    printJson(result);
  } else {
    printHumanInvoke(result);
  }
  // Exit code: 0 on plan success, 3 on error (per workflow contract rollback semantics)
  process.exitCode = result.error ? 3 : 0;
}

// ─── dispatcher entry point ──────────────────────────────────────────────────

function agentRegistryCommand(ctx) {
  // ctx.args starts with "agent" — strip it so parseArgs sees subcommand + args
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  const args = rawArgs[0] === "agent" ? rawArgs.slice(1) : rawArgs;
  const parsed = parseArgs(args);

  if (parsed.showHelp) {
    printHelp();
    process.exitCode = 0;
    return;
  }
  if (!parsed.subcommand) {
    process.stderr.write("Error: subcommand required (discover|invoke). For report|launch see M-008.\n");
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (parsed.subcommand === "discover") {
    return runDiscover(parsed, ctx.lang);
  }
  if (parsed.subcommand === "invoke") {
    return runInvoke(parsed, ctx.lang);
  }

  // M-008 forward: `agent report` / `agent launch` are owned by lib/commands.js
  // (coordination runtime, M-008 scope). We pass the full ctx through unchanged.
  if (parsed.subcommand === "report" || parsed.subcommand === "launch") {
    return m008Agent(ctx);
  }

  // Unknown subcommand — friendly error with M-002 / M-008 split
  process.stderr.write(
    `Error: unknown agent subcommand "${parsed.subcommand}". ` +
    `Valid: discover, invoke (M-002 Agent Registry) | report, launch (M-008 coordination runtime).\n`,
  );
  process.exitCode = 2;
}

module.exports = {
  agentRegistryCommand,
  parseArgs,
  // exposed for tests
  _runDiscover: runDiscover,
  _runInvoke: runInvoke,
};
