"use strict";

/**
 * lib/commands/mcp.js — `cortex-agent mcp` CLI dispatcher (P-002 MS-003).
 *
 * Subcommands (P-002 §4.2):
 *   serve [--token <hex32>] [--loopback-only]      start the stdio MCP server
 *   install <agent> [--token <hex32>] [--dry-run]  write agent config
 *   ping [--timeout 5s]                            health-check the server
 *   list [--json]                                  list configured agents
 *   uninstall <agent>                              remove the agent config entry
 *
 * Backward compatibility: `mcp serve --project <path>` keeps the M-001
 * Management API (runtime-state) MCP contract — the legacy surface
 * (lib/commands/surface/mcp.js) is preserved and routed here. Bare
 * `mcp serve` (no --project) starts the P-002 design-asset MCP server.
 *
 * Zero npm deps. Mirrors lib/design/cli.js dispatcher shape.
 */

const installLib = require("../mcp/install");
const pingLib = require("../mcp/ping");
const serverLib = require("../mcp/server");

// ─── argv parsing ────────────────────────────────────────────────────────────

function parseMcpArgs(args) {
  const out = {
    subcommand: null,
    agent: null,
    token: null,
    timeout: null,
    project: null,
    dryRun: false,
    print: false,
    loopbackOnly: false,
    force: false,
    json: false,
    showHelp: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { out.showHelp = true; continue; }
    if (arg === "--json") { out.json = true; continue; }
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (arg === "--print") { out.print = true; continue; }
    if (arg === "--loopback-only") { out.loopbackOnly = true; continue; }
    if (arg === "--force") { out.force = true; continue; }
    if (arg === "--token") { out.token = args[++i]; continue; }
    if (arg && arg.startsWith("--token=")) { out.token = arg.slice("--token=".length); continue; }
    if (arg === "--timeout") { out.timeout = args[++i]; continue; }
    if (arg && arg.startsWith("--timeout=")) { out.timeout = arg.slice("--timeout=".length); continue; }
    if (arg === "--project") { out.project = args[++i]; continue; }
    if (arg && arg.startsWith("--project=")) { out.project = arg.slice("--project=".length); continue; }
    if (arg && arg.startsWith("--")) continue; // permissive unknown flags
    if (!out.subcommand) out.subcommand = arg;
    else if (!out.agent) out.agent = arg;
  }
  return out;
}

// ─── help ────────────────────────────────────────────────────────────────────

function printHelp() {
  const lines = [
    "Usage: cortex-agent mcp <subcommand> [options]",
    "",
    "P-002 MCP bridge: expose .agent/ design / prototype / prd / template /",
    "plugin / skill assets as MCP tools for any MCP-compatible coding agent.",
    "",
    "Subcommands:",
    "  serve [--token <hex32>] [--loopback-only]",
    "    Start the stdio MCP server (11 tools, read-only except design/install).",
    "    Legacy: `mcp serve --project <path>` keeps the Management API MCP server.",
    "  install <agent> [--token <hex32>] [--dry-run] [--print]",
    "    Write the cortex-agent MCP server config into <agent>'s config file.",
    "  ping [--timeout 5s]",
    "    Spawn the server and verify it answers tools/list.",
    "  list [--json]",
    "    List known agents and whether cortex-agent is configured.",
    "  uninstall <agent>",
    "    Remove the cortex-agent MCP entry from <agent>'s config file.",
    "",
    "Options:",
    "  --token <hex32>   MCP token (exactly 32 hex bytes; auto-generated if omitted)",
    "  --dry-run         Report the config snippet without writing",
    "  --print           Print the JSON config snippet",
    "  --timeout <5s>    ping: response timeout (ms or s)",
    "  --loopback-only   serve: bind hint for Phase 5 HTTP (stdio is loopback by default)",
    "  --json            Machine-readable output",
    "  --help, -h        Show this help",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// ─── subcommands ─────────────────────────────────────────────────────────────

async function serveCommand(ctx, parsed) {
  // Legacy Management API MCP (M-001): `mcp serve --project <path>`.
  if (parsed.project) {
    const { mcp: legacyMcp } = require("./surface/mcp");
    return legacyMcp(ctx);
  }
  // P-002 design-asset MCP server on stdio.
  if (parsed.token) {
    const tokenError = installLib.validateToken(parsed.token);
    if (tokenError) {
      process.stderr.write(`mcp serve: ${tokenError.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.env.CORTEX_AGENT_MCP_TOKEN = parsed.token;
  }
  await serverLib.startServer(serverLib.defaultDeps({}));
}

function installCommand(ctx, parsed) {
  if (!parsed.agent) {
    process.stderr.write("mcp install: <agent> required\n");
    process.stderr.write("Usage: cortex-agent mcp install <agent> [--token <hex32>] [--dry-run] [--print]\n");
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = installLib.install(parsed.agent, {
      token: parsed.token || undefined,
      dryRun: parsed.dryRun,
      cwd: (ctx && ctx.cwd) || process.cwd(),
    });
  } catch (err) {
    process.stderr.write(`mcp install: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (!result.ok) {
    if (result.warning) process.stderr.write(`⚠ ${result.warning}\n`);
    process.stderr.write(`mcp install: ${result.message || result.code}\n`);
    process.exitCode = 2;
    return;
  }
  if (result.warning) process.stderr.write(`⚠ ${result.warning}\n`);
  if (parsed.print || parsed.json) {
    process.stdout.write(JSON.stringify(result.snippet, null, 2) + "\n");
  } else {
    process.stdout.write(`✅ cortex-agent MCP server ${parsed.dryRun ? "would be installed" : "installed"} for ${result.agent} → ${result.path}\n`);
  }
  if (!parsed.dryRun && result.token) {
    process.stderr.write(`token: ${result.token} (shown once)\n`);
  }
}

async function pingCommand(ctx, parsed) {
  const result = await pingLib.ping({
    cwd: (ctx && ctx.cwd) || process.cwd(),
    timeout: parsed.timeout || 5000,
    token: parsed.token || undefined,
  });
  if (result.ok) {
    process.stdout.write(`✅ MCP server OK (${result.latencyMs}ms) — ${result.tools.length} tools\n`);
    for (const tool of result.tools) process.stdout.write(`  ${tool.name}\n`);
    process.exitCode = 0;
  } else {
    process.stderr.write(`❌ MCP ping failed: ${result.error}\n`);
    process.exitCode = 1;
  }
}

function listCommand(ctx, parsed) {
  const result = installLib.listInstalled({});
  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(`Known agents (${result.installed.length}):\n`);
  for (const item of result.installed) {
    process.stdout.write(`  ${item.agent.padEnd(16)} ${item.configured ? "configured" : "not configured"}  ${item.path}\n`);
  }
}

function uninstallCommand(ctx, parsed) {
  if (!parsed.agent) {
    process.stderr.write("mcp uninstall: <agent> required\n");
    process.exitCode = 2;
    return;
  }
  const result = installLib.uninstall(parsed.agent, {});
  if (!result.ok) {
    if (result.message) process.stderr.write(`mcp uninstall: ${result.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    result.removed
      ? `Removed cortex-agent from ${result.agent} config (${result.path})\n`
      : `No cortex-agent entry in ${result.agent} config (${result.path})\n`,
  );
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

async function mcpCommand(ctx) {
  ctx = ctx || {};
  const rawArgs = Array.isArray(ctx.args) ? ctx.args : [];
  const args = rawArgs[0] === "mcp" ? rawArgs.slice(1) : rawArgs;
  const parsed = parseMcpArgs(args);

  if (parsed.showHelp) {
    printHelp();
    return;
  }
  switch (parsed.subcommand) {
    case undefined:
      printHelp();
      break;
    case "serve":
      await serveCommand(ctx, parsed);
      break;
    case "install":
      installCommand(ctx, parsed);
      break;
    case "ping":
      await pingCommand(ctx, parsed);
      break;
    case "list":
      listCommand(ctx, parsed);
      break;
    case "uninstall":
      uninstallCommand(ctx, parsed);
      break;
    default:
      process.stderr.write(`mcp: unknown subcommand: ${parsed.subcommand}\n`);
      printHelp();
      process.exitCode = 2;
      break;
  }
}

module.exports = {
  mcpCommand,
  parseMcpArgs,
  printHelp,
  serveCommand,
  installCommand,
  pingCommand,
  listCommand,
  uninstallCommand,
};
