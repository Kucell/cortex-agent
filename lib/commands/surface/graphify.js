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
  if (payload.not_applicable) {
    lines.push("graphify: not_applicable (project has no Graphify plugin directory)");
    lines.push(`  requested_root: ${payload.requestedRoot}`);
    lines.push(`  policy: ${payload.policy}`);
    lines.push(`  reason: ${payload.candidate.reason}`);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  if (payload.policy === "off") {
    lines.push("graphify: policy=off");
    lines.push(`  requested_root: ${payload.requestedRoot}`);
    lines.push("  Graphify integration is explicitly disabled for this project.");
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  lines.push(`graphify: ${payload.available ? "available" : "stale"}`);
  lines.push(`  policy: ${payload.policy}`);
  lines.push(`  mode: ${payload.mode || "(none)"}`);
  lines.push(`  candidate: ${payload.candidate.kind}${payload.candidate.reason ? " (" + payload.candidate.reason + ")" : ""}`);
  if (payload.graphRoot) lines.push(`  graph_root: ${payload.graphRoot}`);
  if (payload.generatedAt) lines.push(`  generated_at: ${payload.generatedAt}`);
  if (payload.graphAgeDays !== null && payload.graphAgeDays !== undefined) {
    lines.push(`  graph_age_days: ${payload.graphAgeDays}`);
  }
  if (payload.sourceHead) lines.push(`  source_head: ${payload.sourceHead}`);
  if (payload.currentHead) lines.push(`  current_head: ${payload.currentHead}`);
  if (payload.manifestDigest) lines.push(`  manifest_digest: ${payload.manifestDigest}`);
  if (payload.schemaVersion) lines.push(`  schema_version: ${payload.schemaVersion}`);
  if (payload.generationMode) lines.push(`  generation_mode: ${payload.generationMode}`);
  if (payload.branchDeltaRequired) lines.push("  branch_delta_required: yes");
  if (payload.staleReasons && payload.staleReasons.length) {
    lines.push(`  stale_reasons: ${payload.staleReasons.join(", ")}`);
  }
  if (payload.fallbackReason) lines.push(`  fallback_reason: ${payload.fallbackReason}`);
  if (payload.rejected && payload.rejected.length) {
    lines.push(`  rejected_candidates:`);
    for (const r of payload.rejected) {
      lines.push(`    - ${r.path}: ${r.reason}`);
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
  const actions = [];
  let fixReport = null;
  if (fix) {
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
  helpText,
};