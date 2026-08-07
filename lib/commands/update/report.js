"use strict";

// ─── update report builders (T-FOLLOW-002 v2) ─────────────────────────────────
//
// Originally lived in lib/commands.js (lines 288-455). These six helpers
// produce the dry-run and applied update reports written under
// `.agent/updates/`. The verification entry points live in ./verify.js and
// are reached through a late `require` from `buildDryRunUpdateReport` to
// keep the cross-module dependency unidirectional at module load time.

const fs = require("node:fs");
const path = require("node:path");

function updateReportJson(ctx) {
  return ctx.options && ctx.options.report === "json";
}

function updateProjectDescriptor(cwd, agentDest) {
  let root = cwd;
  let agentRoot = agentDest;
  try { root = fs.realpathSync(cwd); } catch (_) {}
  try { agentRoot = fs.realpathSync(agentDest); } catch (_) {}
  return { root, agent_root: agentRoot };
}

function buildDryRunUpdateReport(ctx, { agentDest, wouldAdd, scriptCandidates, skippedChecks }) {
  const additivePlan = wouldAdd.map((relPath) => ({
    path: `.agent/${relPath}`,
    layer: "L0",
    action: "add",
    reason: "missing_template_file",
    risk: "low",
  }));
  const scriptPlan = scriptCandidates.map((candidate) => ({
    path: `.agent/${candidate.path}`,
    layer: "L1",
    action: "update",
    reason: candidate.reason,
    risk: candidate.reason === "missing" ? "low" : "medium",
  }));
  // Late require: collectSemanticMergeCandidates lives in ./verify.js to keep
  // candidate-collect + verification helpers co-located. The require is
  // delayed so the module-load graph stays acyclic (verify.js → report.js
  // is the dominant edge; report.js → verify.js happens only at call time).
  const { collectSemanticMergeCandidates } = require("./verify");
  const semanticPlan = collectSemanticMergeCandidates(ctx);
  const plan = [...additivePlan, ...scriptPlan, ...semanticPlan];
  return {
    ok: true,
    schema_version: 1,
    command: ctx.command,
    mode: "dry-run",
    generated_at: new Date().toISOString(),
    language: ctx.lang,
    project: updateProjectDescriptor(ctx.cwd, agentDest),
    template: {
      lang: ctx.lang,
      template_dir: ctx.templateDir,
    },
    plan,
    blocked: [],
    changes: {
      added: additivePlan,
      updated: scriptPlan,
      merged: semanticPlan,
      protected: [],
    },
    verification: [],
    skipped_checks: skippedChecks,
    summary: {
      would_add: additivePlan.length,
      candidate_scripts: scriptPlan.length,
      total_plan_items: plan.length,
      blockers: 0,
    },
    next_actions: plan.length
      ? [`Run cortex-agent ${ctx.command} to apply safe changes.`]
      : [],
  };
}

function updateReportId() {
  return `U-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}`;
}

function writeUpdateReport(cwd, report) {
  const dir = path.join(cwd, ".agent", "updates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.update_id}.json`);
  const latest = path.join(dir, "latest.json");
  const body = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(file, body, "utf8");
  fs.writeFileSync(latest, body, "utf8");
  return { file, latest };
}

function buildAppliedUpdateReport(ctx, {
  updateId,
  startedAt,
  agentDest,
  added,
  reconcileReport,
  semanticMergePlan,
  verification,
  status,
}) {
  const addedChanges = added.map((relPath) => ({
    path: `.agent/${relPath}`,
    layer: "L0",
    action: "add",
    reason: "missing_template_file",
    risk: "low",
  }));
  const updatedChanges = [
    ...((reconcileReport && reconcileReport.applied) || []).map((relPath) => ({
      path: `.agent/${relPath}`,
      layer: "L1",
      action: "update",
      reason: "managed_script_updated",
      risk: "medium",
    })),
  ];
  const protectedChanges = ((reconcileReport && reconcileReport.skipped) || [])
    .filter((item) => item.reason === "user_modified" || item.reason === "unmanaged_cold_start")
    .map((item) => ({
      path: `.agent/${item.path}`,
      layer: "L1",
      action: "protect",
      reason: item.reason,
      risk: "medium",
    }));
  const failedChanges = ((reconcileReport && reconcileReport.failed) || []).map((item) => ({
    path: `.agent/${item.path}`,
    layer: "L1",
    action: "failed",
    reason: item.error || "script_update_failed",
    risk: "high",
  }));
  const changes = {
    added: addedChanges,
    updated: updatedChanges,
    merged: semanticMergePlan,
    protected: protectedChanges,
    failed: failedChanges,
  };
  const plan = [
    ...addedChanges,
    ...updatedChanges,
    ...semanticMergePlan,
    ...protectedChanges,
    ...failedChanges,
  ];
  return {
    ok: status !== "failed",
    schema_version: 1,
    update_id: updateId,
    command: ctx.command,
    mode: "apply",
    status,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    language: ctx.lang,
    project: updateProjectDescriptor(ctx.cwd, agentDest),
    template: {
      lang: ctx.lang,
      template_dir: ctx.templateDir,
    },
    plan,
    changes,
    verification: verification ? verification.verification : [],
    summary: {
      added: addedChanges.length,
      updated: updatedChanges.length,
      merged: semanticMergePlan.length,
      protected: protectedChanges.length,
      failed: failedChanges.length,
      verification_failed: verification ? verification.summary.failed : 0,
      verification_skipped: verification ? verification.summary.skipped : 0,
    },
    next_actions: [
      ...(protectedChanges.length ? ["Review protected local scripts; use --force-scripts only after confirming the diff."] : []),
      ...(verification && verification.summary.failed ? ["Run cortex-agent update --verify --report json and fix failed checks."] : []),
    ],
  };
}

module.exports = {
  updateReportJson,
  updateProjectDescriptor,
  buildDryRunUpdateReport,
  updateReportId,
  writeUpdateReport,
  buildAppliedUpdateReport,
};
