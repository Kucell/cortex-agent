"use strict";

// ─── Topology Registry CLI (P-001 Phase A) ──────────────────────────────────
//
// Public surface:
//   cortex-agent topology list [--json]
//   cortex-agent topology show <project_id> [--json]
//   cortex-agent topology init <project_id>
//                            [--host-root <path>] [--branch <name>]
//                            [--force] [--json]
//   cortex-agent topology register <project_id> --host-root <path>
//                            [--branch <branch>] [--role <role>]
//                            [--capability <cap>] [--topology-ref <ref>]
//                            [--json]
//   cortex-agent topology deregister <project_id> [--json]
//   cortex-agent topology help
//
// Conventions:
//   • exit 0 = success
//   • exit 2 = invalid usage / arg boundary
//   • exit 3 = runtime failure
//   • --json toggles JSON output; default is human-readable
//
// This module reads/writes .agent/topology/projects.json only.
// Source: P-001 §3 CLI surface.

const topology = require("../topology");

const SUBCOMMANDS = ["list", "show", "init", "register", "deregister", "help"];

function usage() {
  return [
    "Usage:",
    "  cortex-agent topology list [--json]",
    "  cortex-agent topology show <project_id> [--json]",
    "  cortex-agent topology init <project_id> [--host-root <path>] [--branch <name>] [--force] [--json]",
    "  cortex-agent topology register <project_id> --host-root <path> [--branch <b>] [--role <r>] [--capability <c>] [--topology-ref <ref>] [--json]",
    "  cortex-agent topology deregister <project_id> [--json]",
    "  cortex-agent topology help",
    "",
    "Topology Registry: .agent/topology/projects.json",
    "Describes project identity, capabilities, and reachability.",
  ].join("\n");
}

function parseArgs(args) {
  const out = { positional: [], flags: {}, json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--host-root") { out.flags.hostRoot = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--host-root=")) out.flags.hostRoot = a.slice("--host-root=".length);
    else if (a === "--branch") { out.flags.branch = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--branch=")) out.flags.branch = a.slice("--branch=".length);
    else if (a === "--role") {
      if (!out.flags.roles) out.flags.roles = [];
      out.flags.roles.push(args[i + 1] || ""); i += 1;
    }
    else if (a.startsWith("--role=")) {
      if (!out.flags.roles) out.flags.roles = [];
      out.flags.roles.push(a.slice("--role=".length));
    }
    else if (a === "--capability") {
      if (!out.flags.capabilities) out.flags.capabilities = [];
      out.flags.capabilities.push(args[i + 1] || ""); i += 1;
    }
    else if (a.startsWith("--capability=")) {
      if (!out.flags.capabilities) out.flags.capabilities = [];
      out.flags.capabilities.push(a.slice("--capability=".length));
    }
    else if (a === "--topology-ref") { out.flags.topologyRef = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--topology-ref=")) out.flags.topologyRef = a.slice("--topology-ref=".length);
    else if (a === "--force") out.flags.force = true;
    else if (!a.startsWith("-")) out.positional.push(a);
  }
  return out;
}

function emit(json, data) {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(String(data) + "\n");
  }
}

function formatPeer(peer) {
  const parts = [`  ${peer.project_id}`];
  if (peer.host_root) parts.push(`    root: ${peer.host_root}`);
  if (peer.primary_branch) parts.push(`    branch: ${peer.primary_branch}`);
  if (peer.roles && peer.roles.length) parts.push(`    roles: ${peer.roles.join(", ")}`);
  if (peer.capabilities && peer.capabilities.length) parts.push(`    capabilities: ${peer.capabilities.join(", ")}`);
  if (peer.topology_ref) parts.push(`    topology_ref: ${peer.topology_ref}`);
  return parts.join("\n");
}

// ─── Subcommand handlers ────────────────────────────────────────────────────

function handleList(parsed, root) {
  const topo = topology.readTopology(root);
  if (parsed.json) {
    emit(true, topo);
    return 0;
  }
  const lines = [`Self: ${topo.self.project_id} (${topo.self.host_root})`];
  if (topo.peers.length === 0) {
    lines.push("Peers: (none registered)");
  } else {
    lines.push(`Peers (${topo.peers.length}):`);
    topo.peers.forEach((p) => lines.push(formatPeer(p)));
  }
  emit(false, lines.join("\n"));
  return 0;
}

function handleShow(parsed, root) {
  const projectId = parsed.positional[0];
  if (!projectId) {
    emit(parsed.json, { error: "project_id is required" });
    return 2;
  }
  const topo = topology.readTopology(root);
  const peer = topology.findPeer(topo, projectId);
  if (!peer) {
    emit(parsed.json, { error: `peer "${projectId}" not found` });
    return 2;
  }
  if (parsed.json) {
    emit(true, peer);
  } else {
    emit(false, formatPeer(peer).trim());
  }
  return 0;
}

function handleInit(parsed, root) {
  const projectId = parsed.positional[0];
  if (!projectId) {
    emit(parsed.json, { error: "project_id is required" });
    return 2;
  }
  const opts = { project_id: projectId, force: !!parsed.flags.force };
  if (parsed.flags.hostRoot) opts.host_root = parsed.flags.hostRoot;
  if (parsed.flags.branch) opts.branch = parsed.flags.branch;
  const result = topology.initSelf(root, opts);
  if (!result.ok) {
    emit(parsed.json, { error: (result.errors || ["init failed"]).join("; ") });
    return 2;
  }
  if (parsed.json) {
    emit(true, { ok: true, self: result.self, peers_kept: result.peers_kept });
  } else {
    emit(false, `✅ Initialized self "${result.self.project_id}" at ${result.self.host_root} (branch=${result.self.primary_branch}, peers_kept=${result.peers_kept})`);
  }
  return 0;
}

function handleRegister(parsed, root) {
  const projectId = parsed.positional[0];
  if (!projectId) {
    emit(parsed.json, { error: "project_id is required" });
    return 2;
  }
  if (!parsed.flags.hostRoot) {
    emit(parsed.json, { error: "--host-root is required" });
    return 2;
  }
  const peer = {
    project_id: projectId,
    host_root: parsed.flags.hostRoot,
  };
  if (parsed.flags.branch) peer.primary_branch = parsed.flags.branch;
  if (parsed.flags.roles && parsed.flags.roles.length) peer.roles = parsed.flags.roles;
  if (parsed.flags.capabilities && parsed.flags.capabilities.length) peer.capabilities = parsed.flags.capabilities;
  if (parsed.flags.topologyRef) peer.topology_ref = parsed.flags.topologyRef;

  const result = topology.registerPeer(root, peer);
  if (!result.ok) {
    emit(parsed.json, { error: result.errors.join("; ") });
    return 2;
  }
  if (parsed.json) {
    emit(true, { ok: true, registered: peer });
  } else {
    emit(false, `✅ Registered peer "${projectId}" at ${parsed.flags.hostRoot}`);
  }
  return 0;
}

function handleDeregister(parsed, root) {
  const projectId = parsed.positional[0];
  if (!projectId) {
    emit(parsed.json, { error: "project_id is required" });
    return 2;
  }
  const result = topology.deregisterPeer(root, projectId);
  if (!result.ok) {
    emit(parsed.json, { error: result.errors.join("; ") });
    return 2;
  }
  if (parsed.json) {
    emit(true, { ok: true, removed: result.removed });
  } else {
    emit(false, `✅ Deregistered peer "${projectId}"`);
  }
  return 0;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

function topologyCommand(ctx) {
  const root = ctx.cwd || process.cwd();
  const args = Array.isArray(ctx.args) ? ctx.args.slice(1) : [];
  const parsed = parseArgs(args);

  if (parsed.help || parsed.positional.length === 0) {
    if (ctx.args && ctx.args.includes("--json")) {
      process.stdout.write(JSON.stringify({ ok: true, command: "topology", help: usage() }, null, 2) + "\n");
    } else {
      process.stdout.write(usage() + "\n");
    }
    return;
  }

  const subcommand = parsed.positional[0];
  if (!SUBCOMMANDS.includes(subcommand)) {
    if (parsed.json) {
      emit(true, { error: `Unknown subcommand: ${subcommand}` });
    } else {
      emit(false, `Unknown subcommand: ${subcommand}`);
      emit(false, usage());
    }
    process.exitCode = 2;
    return;
  }

  // Shift positional args so subcommand handlers see project_id at [0]
  parsed.positional = parsed.positional.slice(1);

  switch (subcommand) {
    case "list": process.exitCode = handleList(parsed, root); break;
    case "show": process.exitCode = handleShow(parsed, root); break;
    case "init": process.exitCode = handleInit(parsed, root); break;
    case "register": process.exitCode = handleRegister(parsed, root); break;
    case "deregister": process.exitCode = handleDeregister(parsed, root); break;
    case "help": emit(false, usage()); break;
    default: process.exitCode = 2;
  }
}

module.exports = { topologyCommand, SUBCOMMANDS, usage };
