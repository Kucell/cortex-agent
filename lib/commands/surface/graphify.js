"use strict";

// ─── graphify — Graphify Context / Preflight CLI (T-GWG-001 / P-001 §4.3) ─────
//
// Implements the Cortex Graphify CLI surface:
//   cortex-agent graphify context  [--project <path>] [--json]
//   cortex-agent graphify update   [--project <path>] [--reason <text>]
//   cortex-agent graphify preflight [--project <path>] [--query <text>] [--json]
//   cortex-agent graphify doctor   [--project <path>] [--fix]
//   cortex-agent graphify receipt  [--project <path>] [--task <task-id>] [--json]
//   cortex-agent graphify help
//
// `context` is the canonical preflight. `preflight` is a query-shaped alias
// that adds branch-delta + freshness blocking for query/path/explain flows.
// `update` invokes the Graphify CLI in a worktree-safe manner and writes a
// freshness receipt on success. `doctor` reports plugin state without
// mutation; `--fix` triggers idempotent hook repair. `receipt` reads the
// most recent freshness receipt for evidence inspection.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const graphifyLib = require("../../graphify");
const graphifySetup = require("../../setup/graphify-hook");

const readUnwiredMarker = graphifySetup.readUnwiredMarker;
const clearUnwiredMarker = graphifySetup.clearUnwiredMarker;
const installGraphifyRuntime = graphifySetup.installGraphifyRuntime;
const readRuntimeStatus = graphifySetup.readRuntimeStatus;
const densityLib = graphifyLib.density;

function helpText() {
  return [
    "Usage:",
    "  cortex-agent graphify <subcommand> [options]",
    "",
    "Subcommands:",
    "  context    Print the resolved Graphify context (mode, sourceHead, age, fallbackReason).",
    "  preflight  Query-shaped preflight that fail-closes on stale / incompatible graphs.",
    "  update     Run `graphify update .` and write a freshness receipt on success.",
    "  doctor     Report plugin state (cli / config / graph / hooks) with optional --fix.",
    "  receipt    Read the most recent freshness receipt.",
    "  help       Show this message.",
    "",
    "Options:",
    "  --project <path>      target project root (default: cwd)",
    "  --json                emit structured JSON instead of human output",
    "  --query <text>        query string (preflight only)",
    "  --task <task-id>      task identifier for receipts (default: global)",
    "  --reason <text>       human-readable reason recorded with update",
    "  --fix                 idempotent hook repair (doctor only)",
    "  --allow-update-failed allow the preflight to proceed when the graph is stale",
    "",
    "All subcommands are read-only except `update` and `doctor --fix`.",
    "When the project has not opted into Graphify, every subcommand reports",
    "`not_applicable` and exits 0 without touching the filesystem beyond a",
    "single stat() call.",
  ].join("\n");
}

function flagValue(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function projectRoot(args, fallback) {
  const v = flagValue(args, "--project");
  return v ? path.resolve(fallback || process.cwd(), v) : (fallback || process.cwd());
}

function emit(args, payload) {
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    humanOutput(payload);
  }
}

function humanOutput(payload) {
  const lines = [];
  // The doctor payload nests the resolver result under `context`; the other
  // subcommands put the same fields at the top level. Resolve both so the
  // human-readable rendering never depends on which shape arrived.
  const context = payload.context || payload;
  if (payload.not_applicable) {
    lines.push("graphify: not_applicable (project has no Graphify plugin directory)");
    lines.push(`  requested_root: ${payload.requestedRoot}`);
    lines.push(`  policy: ${payload.policy}`);
    lines.push(`  reason: ${payload.candidate.reason}`);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  if (context.policy === "off") {
    lines.push("graphify: policy=off");
    lines.push(`  requested_root: ${payload.requestedRoot}`);
    lines.push("  Graphify integration is explicitly disabled for this project.");
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  lines.push(`graphify: ${context.available ? "available" : "stale"}`);
  lines.push(`  policy: ${context.policy}`);
  lines.push(`  mode: ${context.mode || "(none)"}`);
  // `candidate` is part of the resolver contract, but the doctor payload
  // carries the resolver result under `context` and never promotes it to
  // the top level. Reading `payload.candidate` unconditionally therefore
  // threw `TypeError: Cannot read properties of undefined (reading 'kind')`
  // and made the whole diagnostic path unusable (issue #152).
  const candidate = payload.candidate || (payload.context && payload.context.candidate) || null;
  if (candidate) {
    lines.push(`  candidate: ${candidate.kind}${candidate.reason ? " (" + candidate.reason + ")" : ""}`);
  }
  if (context.graphRoot) lines.push(`  graph_root: ${context.graphRoot}`);
  if (context.generatedAt) lines.push(`  generated_at: ${context.generatedAt}`);
  if (context.graphAgeDays !== null && context.graphAgeDays !== undefined) {
    lines.push(`  graph_age_days: ${context.graphAgeDays}`);
  }
  if (context.sourceHead) lines.push(`  source_head: ${context.sourceHead}`);
  if (context.currentHead) lines.push(`  current_head: ${context.currentHead}`);
  if (context.manifestDigest) lines.push(`  manifest_digest: ${context.manifestDigest}`);
  if (context.schemaVersion) lines.push(`  schema_version: ${context.schemaVersion}`);
  if (context.generationMode) lines.push(`  generation_mode: ${context.generationMode}`);
  if (context.branchDeltaRequired) lines.push("  branch_delta_required: yes");
  if (context.staleReasons && context.staleReasons.length) {
    lines.push(`  stale_reasons: ${context.staleReasons.join(", ")}`);
  }
  if (context.fallbackReason) lines.push(`  fallback_reason: ${context.fallbackReason}`);
  if (context.rejected && context.rejected.length) {
    lines.push(`  rejected_candidates:`);
    for (const r of context.rejected) {
      lines.push(`    - ${r.path}: ${r.reason}`);
    }
  }
  // Issue #152: surface an inert hook explicitly. Without this line the
  // doctor output looks identical to a healthy project while the knowledge
  // graph silently stops updating.
  if (payload.hookUnwired) {
    lines.push(`  hook: NOT WIRED (${payload.hookUnwired.reason})`);
    if (payload.hookUnwired.recordedAt) lines.push(`  hook_unwired_at: ${payload.hookUnwired.recordedAt}`);
    if (payload.hookUnwired.remedy) lines.push(`  remedy: ${payload.hookUnwired.remedy}`);
  } else if (payload.hookWired === true) {
    lines.push("  hook: wired");
  } else if (payload.hookWired === false) {
    const rt = payload.hookRuntime || {};
    const absent = (rt.missing || []).concat(rt.differing || []);
    lines.push("  hook: NOT WIRED (shared implementation missing or outdated)");
    if (absent.length) lines.push(`  hook_runtime_outdated: ${absent.join(", ")}`);
    lines.push("  remedy: Run `cortex-agent update` or `cortex-agent graphify doctor --fix` in this project.");
  }
  // Edge-density guard state (issue #154). The operator needs to see
  // whether the guard is active at all: a project without a recorded
  // baseline has no threshold to compare against, and a project whose
  // ratio is currently below the threshold is degrading.
  if (payload.density) {
    const d = payload.density;
    if (d.baseline !== null && d.baseline !== undefined) {
      const ratio = typeof d.ratio === "number" ? d.ratio.toFixed(3) : "n/a";
      const threshold = typeof d.threshold === "number" ? d.threshold.toFixed(3) : "n/a";
      lines.push(`  edge_density: ratio=${ratio} threshold=${threshold} baseline=${Number(d.baseline).toFixed(3)} (${d.baselineSource})`);
      if (d.reason) lines.push(`  edge_density_reason: ${d.reason}`);
    } else {
      lines.push("  edge_density: inactive (no baseline recorded; a full build records one)");
    }
    if (d.rebuildInProgress) {
      lines.push("  edge_density_rebuild: in progress");
    }
    if (d.lastRebuildAt) {
      lines.push(`  edge_density_last_rebuild: ${d.lastRebuildAt}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function ctxCommand(ctx) {
  const args = (ctx && ctx.args) || [];
  const root = projectRoot(args, ctx && ctx.cwd);
  const out = graphifyLib.resolver.resolveContext({ projectRoot: root });
  emit(args, out);
  if (!out.available && !out.not_applicable && out.policy !== "off") {
    process.exitCode = 0; // context is informational; non-zero reserved for preflight/query
  }
}

function preflightCommand(ctx) {
  const args = (ctx && ctx.args) || [];
  const root = projectRoot(args, ctx && ctx.cwd);
  const query = flagValue(args, "--query");
  const allowFailed = args.includes("--allow-update-failed");
  const out = graphifyLib.resolver.resolveContext({ projectRoot: root });
  const verdict = graphifyLib.receipt.verdictFor(out);
  const payload = {
    query: query || null,
    not_applicable: out.not_applicable,
    available: out.available,
    policy: out.policy,
    mode: out.mode,
    candidate: out.candidate,
    branchDeltaRequired: out.branchDeltaRequired,
    staleReasons: out.staleReasons,
    fallbackReason: out.fallbackReason,
    manifestDigest: out.manifestDigest,
    sourceHead: out.sourceHead,
    currentHead: out.currentHead,
    graphRoot: out.graphRoot,
    verdict,
    pass: verdict.result === graphifyLib.receipt.RESULT.FRESH ||
          verdict.result === graphifyLib.receipt.RESULT.SKIPPED ||
          (allowFailed && verdict.result === graphifyLib.receipt.RESULT.STALE),
  };
  emit(args, payload);
  if (!payload.pass) {
    process.exitCode = 3;
  }
}

function updateCommand(ctx) {
  const args = (ctx && ctx.args) || [];
  const root = projectRoot(args, ctx && ctx.cwd);
  const reason = flagValue(args, "--reason") || "manual_update";
  const taskId = flagValue(args, "--task") || "global";
  const state = graphifyLib.hook.detectPluginState(root);
  if (!state.cli) {
    const payload = {
      ok: false,
      reason: "graphify_cli_missing",
      projectRoot: root,
      remedy: "pip install graphifyy && graphify install",
    };
    emit(args, payload);
    process.exitCode = 4;
    return;
  }
  if (!state.pluginConfig) {
    const payload = {
      ok: false,
      reason: "plugin_not_configured",
      projectRoot: root,
      remedy: "Run `cortex-agent init` or `cortex-agent doctor --fix`.",
    };
    emit(args, payload);
    process.exitCode = 4;
    return;
  }
  let stdout = "";
  let stderr = "";
  let status = 0;
  // The managed update takes the SAME rebuild lock the post-commit hook
  // and the full rebuild take. Without it the managed update can publish a
  // graph between the full build's write and its baseline stamp, and the
  // stamp would record the DEGRADED ratio as the new "full" baseline.
  // The `_meta` baseline is migrated into the durable sidecar BEFORE the
  // update runs. `graphify update .` rewrites graph.json and drops every key
  // the CLI does not own -- `_meta` included -- so a project that carried
  // the consumer-side convention would lose its baseline on the very first
  // update, and the density guard would never fire again. The post-commit
  // hook migrates too, but this path can be the first one to run.
  densityLib.migrateMetaBaseline(root);
  const lock = densityLib.acquireRebuildLock(root);
  if (!lock) {
    const busy = {
      ok: false,
      reason: "rebuild_in_progress",
      projectRoot: root,
      remedy: "A Graphify rebuild is already running; retry once it has finished.",
    };
    emit(args, busy);
    process.exitCode = 4;
    return;
  }
  try {
    try {
      stdout = execFileSync("graphify", ["update", "."], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch (err) {
      status = err && err.status ? err.status : 1;
      stderr = (err && err.stderr ? err.stderr.toString() : "") || (err && err.message) || "";
    }
  } finally {
    lock.release();
    // Drain any request that was deferred while this run held the lock.
    densityLib.startPendingDrain({ projectRoot: root });
  }
  const ok = status === 0;
  // Resolve context after the update to capture the new manifest digest.
  const resolved = ok ? graphifyLib.resolver.resolveContext({ projectRoot: root }) : null;
  const receiptPath = graphifyLib.receipt.resolveReceiptPath({ projectRoot: root, taskId });
  const built = graphifyLib.receipt.buildReceipt({
    sourceHead: resolved ? resolved.sourceHead : null,
    manifestDigest: resolved ? resolved.manifestDigest : null,
    generationMode: "update",
    result: ok ? graphifyLib.receipt.RESULT.FRESH : graphifyLib.receipt.RESULT.FAILED,
    taskId,
    kind: graphifyLib.receipt.RECEIPT_KIND.UPDATE,
    policy: resolved ? resolved.policy : null,
    mode: resolved ? resolved.mode : null,
    reasons: ok ? [] : [`update_failed:${status}`, reason].filter(Boolean),
    branch: resolved ? resolved.branch : null,
  });
  if (ok) {
    graphifyLib.receipt.writeReceiptAtomic(receiptPath, built);
    // Successful update clears any stale marker.
    graphifyLib.markers.clearMarker(path.join(root, "graphify-out"));
  }
  const payload = {
    ok,
    reason,
    taskId,
    receiptPath,
    sourceHead: built.sourceHead,
    manifestDigest: built.manifestDigest,
    generationMode: built.generationMode,
    result: built.result,
    exitStatus: status,
    stderr: stderr ? stderr.trim() : null,
    stdoutTail: stdout ? stdout.split(/\r?\n/).slice(-3).join("\n") : null,
  };
  emit(args, payload);
  if (!ok) process.exitCode = 3;
}

function doctorCommand(ctx) {
  const args = (ctx && ctx.args) || [];
  const root = projectRoot(args, ctx && ctx.cwd);
  const fix = args.includes("--fix");
  const state = graphifyLib.hook.detectPluginState(root);
  const ctxResult = graphifyLib.resolver.resolveContext({ projectRoot: root });
  // Issue #152: the post-commit hook is present but inert when the shared
  // implementation could not be resolved. The wrapper records that in a
  // marker; without reading it the doctor would report a healthy hook and
  // the knowledge graph would keep going stale unnoticed.
  let unwired = readUnwiredMarker(root);
  // The plugin directory existing is what proves the project opted in —
  // pluginConfig additionally requires config.yml, which an older or
  // partially-installed project may still be missing.
  const pluginInstalled = fs.existsSync(path.join(root, ".agent", "plugins", "graphify"));
  // The marker is evidence of FAILURE, never proof of health: a hook that
  // never ran, or whose marker was deleted, must not read as wired. So the
  // wiring state is decided by the runtime actually being resolvable.
  let runtimeStatus = pluginInstalled ? readRuntimeStatus(root) : null;
  const actions = [];
  let fixReport = null;
  if (fix) {
    // The repair triggers on the wiring state, not on the marker: a project
    // whose shared implementation is missing is inert whether or not a
    // marker was ever written (an old wrapper never wrote one).
    if (pluginInstalled && runtimeStatus && !runtimeStatus.inSync) {
      const runtime = installGraphifyRuntime(root);
      if (runtime.ok) {
        clearUnwiredMarker(root);
        // Re-read: the repair cleared the marker, so the report must show
        // the post-repair state rather than the state we found.
        unwired = readUnwiredMarker(root);
        runtimeStatus = readRuntimeStatus(root);
        actions.push(`runtime:${runtime.action}`);
      } else {
        actions.push(`runtime:failed(${runtime.reason || "unknown"})`);
      }
    } else if (unwired.recorded) {
      // The runtime is in place but the marker survived — the wrapper has
      // not run since. Clear it so the doctor stops reporting a condition
      // that no longer holds.
      clearUnwiredMarker(root);
      unwired = readUnwiredMarker(root);
    }
    if (state.cli && state.pluginConfig && !state.graphBuilt) {
      actions.push("needs_graph_initial_build");
    }
    if (state.pluginConfig && !state.hooksInstalled) {
      const r = graphifyLib.hook.installHook({ projectRoot: root });
      actions.push(`hook:${r.action}`);
    } else if (state.pluginConfig) {
      actions.push("hook:unchanged");
    }
    if (state.cli && !state.pluginConfig) {
      actions.push("plugin_missing_run_init");
    }
    fixReport = { applied: actions };
  }
  const payload = {
    projectRoot: root,
    state,
    context: ctxResult,
    actions,
    fixApplied: fix ? actions : null,
    fresh: ctxResult.available,
    staleReasons: ctxResult.staleReasons,
    // `hookWired` is true when the plugin is installed and the shared
    // implementation was resolvable, false when the plugin is installed
    // but the implementation is missing, and null when the project has no
    // Graphify plugin at all (nothing to wire).
    hookWired: pluginInstalled
      ? Boolean(runtimeStatus && runtimeStatus.inSync && !unwired.recorded)
      : null,
    hookRuntime: runtimeStatus,
    hookUnwired: unwired.recorded
      ? {
        reason: (unwired.marker && unwired.marker.reason) || unwired.reason || "unknown",
        recordedAt: (unwired.marker && unwired.marker.recordedAt) || null,
        remedy: (unwired.marker && unwired.marker.remedy) || null,
      }
      : null,
    // The edge-density guard's current state (issue #154). Read-only: the
    // doctor reports it, it never starts a rebuild.
    density: readDensityState(root),
  };
  emit(args, payload);
}

function receiptCommand(ctx) {
  const args = (ctx && ctx.args) || [];
  const root = projectRoot(args, ctx && ctx.cwd);
  const taskId = flagValue(args, "--task") || "global";
  const receiptPath = graphifyLib.receipt.resolveReceiptPath({ projectRoot: root, taskId });
  const r = graphifyLib.receipt.readReceipt(receiptPath);
  const payload = {
    receiptPath,
    exists: r.ok,
    receipt: r.receipt,
    reason: r.ok ? null : r.reason,
  };
  emit(args, payload);
}

/**
 * Read the edge-density guard's state without triggering anything.
 * Returns null when the project has no Graphify plugin at all.
 */
function readDensityState(root) {
  try {
    if (!fs.existsSync(path.join(root, ".agent", "plugins", "graphify"))) return null;
    const config = densityLib.readThresholdConfig(root);
    const counts = densityLib.readGraphCounts(root);
    const baseline = densityLib.resolveBaseline(root, config, counts);
    const decision = densityLib.evaluateDensity({
      projectRoot: root,
      config,
      counts,
      baseline,
    });
    return {
      ratio: decision.ratio,
      threshold: decision.threshold,
      baseline: decision.baseline,
      baselineSource: decision.baselineSource,
      reason: decision.reason,
      nodes: counts.nodes,
      edges: counts.edges,
      minNodesForCheck: config.min_nodes_for_check,
      ratioDropThreshold: config.ratio_drop_threshold,
      rebuildInProgress: fs.existsSync(densityLib.rebuildLockPath(root)),
      lastRebuildAt: densityLib.readLastRebuildTime(root)
        ? new Date(densityLib.readLastRebuildTime(root)).toISOString()
        : null,
    };
  } catch (_) {
    return null;
  }
}

function graphify(ctx) {
  const args = (ctx && ctx.args) || [];
  // The CLI dispatcher passes `ctx.args` with the subcommand token first.
  // Strip the leading "graphify" if present (caller might pass either
  // ["context", ...] from bin/cli.js after a top-level case match, or
  // ["graphify", "context", ...] from the underlying surface call).
  let sub;
  if (args[0] === "graphify") {
    sub = args[1];
  } else {
    sub = args[0];
  }
  const subArgs = args[0] === "graphify" ? args.slice(2) : args.slice(1);
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(helpText() + "\n");
    return;
  }
  const subCtx = Object.assign({}, ctx, { args: subArgs });
  switch (sub) {
    case "context":
      return ctxCommand(subCtx);
    case "preflight":
      return preflightCommand(subCtx);
    case "update":
      return updateCommand(subCtx);
    case "doctor":
      return doctorCommand(subCtx);
    case "receipt":
      return receiptCommand(subCtx);
    default:
      process.stderr.write(`graphify: unknown subcommand '${sub}'\n\n`);
      process.stdout.write(helpText() + "\n");
      process.exitCode = 2;
  }
}

module.exports = {
  graphify,
  // exported for unit tests:
  ctxCommand,
  preflightCommand,
  updateCommand,
  doctorCommand,
  receiptCommand,
  readDensityState,
  helpText,
};
