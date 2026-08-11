"use strict";

// ─── Cross-Project Event Bridge CLI (P-003 Phase 1) ─────────────────────────
//
// Public surface:
//   cortex-agent bridge sync                  # sync every subscription with
//                                              --source-root (or fail)
//   cortex-agent bridge sync --source <id> --source-root <path>
//                                            # sync a single source
//   cortex-agent bridge sync --topology-ref <peer>
//                                            # resolve source root from the
//                                              topology registry (P-001)
//   cortex-agent bridge inbox [--source <id>] [--since <iso-date>]
//                                            # list local inbox
//   cortex-agent bridge subscribe --source <id> [--group <name>]
//                                            --types <csv> [--filter <json>]
//                                            # append a subscription
//   cortex-agent bridge subscribe --topology-ref <peer> --types <csv>
//                                            # resolve --source from the
//                                              topology registry (P-001)
//   cortex-agent bridge subscriptions         # list current subscriptions
//   cortex-agent bridge unsubscribe --index <i>
//                                            # remove a subscription
//   cortex-agent bridge help                  # usage
//
// Conventions:
//   • exit 0 = success
//   • exit 2 = invalid usage / arg boundary
//   • exit 3 = runtime failure (sync/inbox read errors that are NOT
//              "source unreachable" — the latter is reported in the JSON
//              payload and exits 0 because sync is opportunistic)
//   • --json toggles JSON output; default is human-readable summary
//
// This module never spawns subprocesses, never reaches the network, and
// never modifies anything outside `.agent-runtime/cross-project/`. Sync
// reads the SOURCE project's outbox at
//   <sourceRoot>/.agent-runtime/cross-project/outbox/<source>/<event-id>.json
// (see bridge-sync.js for the outbox convention) and writes to the local
// inbox at
//   <targetRoot>/.agent-runtime/cross-project/inbox/<source>/<event-id>.json
//
// Source: P-003 §6 CLI 接口.

const fs = require("node:fs");
const path = require("node:path");

const inboxStore = require("../cross-project/inbox-store");
const subscriptions = require("../cross-project/subscriptions");
const bridgeSync = require("../cross-project/bridge-sync");
const topology = require("../topology");

const SUBCOMMANDS = ["sync", "inbox", "subscribe", "unsubscribe", "subscriptions", "help"];

function usage() {
  return [
    "Usage:",
    "  cortex-agent bridge sync [--source <id>] [--source-root <path>] [--topology-ref <peer>] [--auto] [--json]",
    "  cortex-agent bridge inbox [--source <id>] [--since <iso-date>] [--json]",
    "  cortex-agent bridge subscribe --source <id> [--group <name>] --types <csv> [--filter <json>] [--json]",
    "  cortex-agent bridge subscribe --topology-ref <peer> --types <csv> [--json]",
    "  cortex-agent bridge unsubscribe --index <i> [--json]",
    "  cortex-agent bridge subscriptions [--json]",
    "  cortex-agent bridge help",
    "",
    "Phase 1 consumer-only. Stores events at",
    "  <root>/.agent-runtime/cross-project/inbox/<source>/<event-id>.json",
    "and reads source outboxes at",
    "  <sourceRoot>/.agent-runtime/cross-project/outbox/<source>/<event-id>.json.",
  ].join("\n");
}

function parseArgs(args) {
  const out = {
    positional: [],
    flags: {},
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--auto") out.flags.auto = true;
    else if (a === "--source") { out.flags.source = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--source=")) out.flags.source = a.slice("--source=".length);
    else if (a === "--source-root") { out.flags.sourceRoot = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--source-root=")) out.flags.sourceRoot = a.slice("--source-root=".length);
    else if (a === "--since") { out.flags.since = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--since=")) out.flags.since = a.slice("--since=".length);
    else if (a === "--group") { out.flags.group = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--group=")) out.flags.group = a.slice("--group=".length);
    else if (a === "--types") { out.flags.types = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--types=")) out.flags.types = a.slice("--types=".length);
    else if (a === "--filter") { out.flags.filter = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--filter=")) out.flags.filter = a.slice("--filter=".length);
    else if (a === "--index") { out.flags.index = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--index=")) out.flags.index = a.slice("--index=".length);
    else if (a === "--topology-ref") { out.flags.topologyRef = args[i + 1] || ""; i += 1; }
    else if (a.startsWith("--topology-ref=")) out.flags.topologyRef = a.slice("--topology-ref=".length);
    else if (a && a.startsWith("--")) { out.flags[a.slice(2)] = true; }
    else out.positional.push(a);
  }
  return out;
}

function resolveTargetRoot(ctx) {
  if (ctx.options && ctx.options.project) return path.resolve(ctx.cwd, ctx.options.project);
  return path.resolve(ctx.cwd, ".");
}

// Resolve --topology-ref <peer> against the P-001 topology registry. Returns
// the peer object (with host_root) or null; callers report INVALID_USAGE.
function resolveTopologyPeer(targetRoot, ref) {
  if (!ref) return null;
  const current = topology.readTopology(targetRoot);
  return topology.resolveTopologyRef(current, ref);
}

function invalidUsage(message, parsed) {
  if (parsed && parsed.json) {
    console.log(JSON.stringify({ ok: false, command: "bridge", error: { code: "INVALID_USAGE", message } }, null, 2));
  } else {
    console.error(`bridge: ${message}`);
    console.log(usage());
  }
  process.exitCode = 2;
}

function runtimeError(message, details, parsed) {
  if (parsed && parsed.json) {
    console.log(JSON.stringify({ ok: false, command: "bridge", error: { code: "BRIDGE_RUNTIME", message, details } }, null, 2));
  } else {
    console.error(`bridge: ${message}`);
    if (details) console.error(JSON.stringify(details, null, 2));
  }
  process.exitCode = 3;
}

function bridgeSyncHandler(ctx, parsed) {
  const targetRoot = resolveTargetRoot(ctx);
  let sourceRoot = parsed.flags.sourceRoot;
  let source = parsed.flags.source;
  let resolvedPeer = null;
  if (!sourceRoot && parsed.flags.topologyRef) {
    resolvedPeer = resolveTopologyPeer(targetRoot, parsed.flags.topologyRef);
    if (!resolvedPeer) {
      invalidUsage(`--topology-ref "${parsed.flags.topologyRef}" not found in topology registry (.agent/topology/projects.json)`, parsed);
      return;
    }
    sourceRoot = resolvedPeer.host_root;
    if (!source) source = resolvedPeer.project_id;
  }
  if (!sourceRoot) {
    invalidUsage("--source-root <path> or --topology-ref <peer> is required for `bridge sync` (Phase 1 does not auto-discover source projects)", parsed);
    return;
  }
  const results = [];
  if (source) {
    const result = bridgeSync.syncForProject(targetRoot, { sourceProjectId: source, sourceRoot });
    results.push(result);
  } else {
    const run = bridgeSync.syncAll(targetRoot, { sourceRoot });
    for (const entry of run.sources) results.push(entry.result);
  }
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, command: "bridge", action: "sync", results }, null, 2));
  } else {
    for (const r of results) {
      if (!r.reachable) {
        console.log(`bridge sync: source=${r.source_project_id} status=unreachable errors=${r.errors.length}`);
        continue;
      }
      console.log(
        `bridge sync: source=${r.source_project_id} scanned=${r.scanned} matched=${r.matched} written=${r.written} skipped=${r.skipped} cursor=${r.cursor ? r.cursor.last_bridge_event_id || "<new>" : "<none>"}`,
      );
      for (const err of r.errors) {
        console.error(`  ! ${err.code}: ${err.message}${err.bridge_event_id ? ` (event=${err.bridge_event_id})` : ""}`);
      }
    }
  }
  // Sync is opportunistic: source-unreachable is reported in the result and
  // does NOT bump the exit code (P-003 §9.6). Other errors do.
  const hasRuntimeError = results.some((r) => r.ok === false && r.reachable);
  if (hasRuntimeError) {
    process.exitCode = 3;
  }
}

function bridgeInboxHandler(ctx, parsed) {
  const targetRoot = resolveTargetRoot(ctx);
  const since = parsed.flags.since || undefined;
  if (since && Number.isNaN(Date.parse(since))) {
    invalidUsage(`--since is not a valid ISO 8601 date: ${JSON.stringify(since)}`, parsed);
    return;
  }
  const source = parsed.flags.source || undefined;
  let events;
  try {
    events = inboxStore.listInbox(targetRoot, { source, since });
  } catch (error) {
    runtimeError(error.message, { code: error.code }, parsed);
    return;
  }
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      command: "bridge",
      action: "inbox",
      filter: { source: source || null, since: since || null },
      count: events.length,
      events: events.map(stripInternal),
    }, null, 2));
  } else {
    if (events.length === 0) {
      console.log(`bridge inbox: empty (target=${targetRoot} source=${source || "<any>"} since=${since || "<none>"})`);
      return;
    }
    console.log(`bridge inbox: ${events.length} event(s) (target=${targetRoot} source=${source || "<any>"} since=${since || "<none>"})`);
    for (const ev of events) {
      if (ev.__skipped) {
        console.log(`  - [skipped] source=${ev.source_project_id} count=${ev.skipped} (corrupt or invalid)`);
        continue;
      }
      console.log(
        `  - ${ev.bridge_event_id} source=${ev.source_project_id} type=${ev.event_type}` +
          (ev.correlation_group ? ` group=${ev.correlation_group}` : "") +
          ` propagated_at=${ev.propagated_at}`,
      );
    }
  }
}

function stripInternal(obj) {
  const { _path, _source_project_id, __skipped, ...rest } = obj;
  return rest;
}

function bridgeSubscribeHandler(ctx, parsed) {
  const targetRoot = resolveTargetRoot(ctx);
  let source = parsed.flags.source;
  let resolvedPeer = null;
  if (parsed.flags.topologyRef) {
    resolvedPeer = resolveTopologyPeer(targetRoot, parsed.flags.topologyRef);
    if (!resolvedPeer) {
      invalidUsage(`--topology-ref "${parsed.flags.topologyRef}" not found in topology registry (.agent/topology/projects.json)`, parsed);
      return;
    }
    if (source && source !== resolvedPeer.project_id) {
      invalidUsage(`--source "${source}" conflicts with topology peer "${resolvedPeer.project_id}"`, parsed);
      return;
    }
    source = resolvedPeer.project_id;
  }
  if (!source) {
    invalidUsage("--source <id> or --topology-ref <peer> is required for `bridge subscribe`", parsed);
    return;
  }
  const typesRaw = parsed.flags.types || "";
  const types = subscriptions.normalizeEventTypes(typesRaw.split(","));
  if (types.length === 0) {
    invalidUsage("--types <csv> is required and must contain at least one event type", parsed);
    return;
  }
  let filter;
  if (parsed.flags.filter) {
    try {
      filter = JSON.parse(parsed.flags.filter);
    } catch (cause) {
      invalidUsage(`--filter is not valid JSON: ${cause.message}`, parsed);
      return;
    }
    if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
      invalidUsage("--filter must be a JSON object", parsed);
      return;
    }
  }
  const sub = {
    source_project_id: source,
    event_types: types,
  };
  if (parsed.flags.group) sub.correlation_group = parsed.flags.group;
  if (filter) sub.filter = filter;

  let result;
  try {
    result = subscriptions.addSubscription(targetRoot, sub);
  } catch (error) {
    if (error.code === "BRIDGE_SUBSCRIPTION_INVALID" || error.code === "BRIDGE_SUBSCRIPTIONS_INVALID") {
      invalidUsage(error.message, parsed);
      return;
    }
    runtimeError(error.message, { code: error.code }, parsed);
    return;
  }
  const entry = result.subscriptions[result.index];
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      command: "bridge",
      action: "subscribe",
      index: result.index,
      subscription: entry,
      topology: resolvedPeer ? { topology_ref: parsed.flags.topologyRef, host_root: resolvedPeer.host_root } : null,
    }, null, 2));
  } else {
    console.log(`bridge subscribe: index=${result.index} source=${entry.source_project_id} types=${entry.event_types.join(",")}` +
      (entry.correlation_group ? ` group=${entry.correlation_group}` : "") +
      (entry.filter ? ` filter=${JSON.stringify(entry.filter)}` : "") +
      (resolvedPeer ? ` topology_ref=${parsed.flags.topologyRef} host_root=${resolvedPeer.host_root}` : ""));
  }
}

function bridgeUnsubscribeHandler(ctx, parsed) {
  const targetRoot = resolveTargetRoot(ctx);
  const idxRaw = parsed.flags.index;
  if (idxRaw === undefined || idxRaw === "") {
    invalidUsage("--index <i> is required for `bridge unsubscribe`", parsed);
    return;
  }
  const idx = Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0) {
    invalidUsage(`--index must be a non-negative integer: ${JSON.stringify(idxRaw)}`, parsed);
    return;
  }
  let result;
  try {
    result = subscriptions.removeSubscription(targetRoot, idx);
  } catch (error) {
    if (error.code === "BRIDGE_SUBSCRIPTION_INDEX_OUT_OF_RANGE") {
      invalidUsage(error.message, parsed);
      return;
    }
    runtimeError(error.message, { code: error.code }, parsed);
    return;
  }
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      command: "bridge",
      action: "unsubscribe",
      index: idx,
      removed: result.removed,
      remaining: result.subscriptions.length,
    }, null, 2));
  } else {
    console.log(`bridge unsubscribe: removed index=${idx} remaining=${result.subscriptions.length}`);
  }
}

function bridgeSubscriptionsHandler(ctx, parsed) {
  const targetRoot = resolveTargetRoot(ctx);
  let current;
  try {
    current = subscriptions.readSubscriptions(targetRoot);
  } catch (error) {
    runtimeError(error.message, { code: error.code }, parsed);
    return;
  }
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      command: "bridge",
      action: "subscriptions",
      count: current.subscriptions.length,
      subscriptions: current.subscriptions,
    }, null, 2));
  } else {
    if (current.subscriptions.length === 0) {
      console.log(`bridge subscriptions: 0 entries (target=${targetRoot})`);
      return;
    }
    console.log(`bridge subscriptions: ${current.subscriptions.length} entries (target=${targetRoot})`);
    current.subscriptions.forEach((sub, idx) => {
      console.log(`  [${idx}] source=${sub.source_project_id}` +
        (sub.correlation_group ? ` group=${sub.correlation_group}` : "") +
        ` types=${sub.event_types.join("|")}` +
        (sub.filter ? ` filter=${JSON.stringify(sub.filter)}` : ""));
    });
  }
}

function bridgeCommand(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args.slice(1) : [];
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    if (ctx.args.includes("--json")) {
      console.log(JSON.stringify({ ok: true, command: "bridge", help: usage() }, null, 2));
      return;
    }
    console.log(usage());
    return;
  }
  if (!SUBCOMMANDS.includes(sub)) {
    invalidUsage(`unknown subcommand: ${sub}`, { json: ctx.args.includes("--json") });
    return;
  }
  const parsed = parseArgs(args.slice(1));
  switch (sub) {
    case "sync": return bridgeSyncHandler(ctx, parsed);
    case "inbox": return bridgeInboxHandler(ctx, parsed);
    case "subscribe": return bridgeSubscribeHandler(ctx, parsed);
    case "unsubscribe": return bridgeUnsubscribeHandler(ctx, parsed);
    case "subscriptions": return bridgeSubscriptionsHandler(ctx, parsed);
    default: invalidUsage(`unsupported subcommand: ${sub}`, parsed);
  }
}

module.exports = {
  bridgeCommand,
  // Exposed for tests
  parseArgs,
  usage,
};
