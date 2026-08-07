"use strict";

// ─── update verification helpers (T-FOLLOW-002 v2) ────────────────────────────
//
// Originally lived in lib/commands.js (lines 456-646). Eight helpers that
// collect semantic-merge candidates and run post-update verification
// (json parse, runtime-continuity resume-bundle, management-api queries).
//
// Cross-module deps:
//   - resolveManagementProject + queryManagementProject  → ../../management-client
//   - setup needsXxxMerge helpers                        → ../../setup
//   - printManagementPayload                             → ../management/api-helpers
//   - updateReportJson / updateProjectDescriptor         → ./report (late require)
//
// The late require to ./report breaks the report ↔ verify cycle: report.js
// needs collectSemanticMergeCandidates (this file) inside
// buildDryRunUpdateReport, and verify.js needs updateReportJson /
// updateProjectDescriptor inside runUpdateVerification /
// printUpdateVerification. By delaying the require until the function is
// called, the module-load graph stays acyclic regardless of which file
// `lib/commands.js` requires first.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveManagementProject, queryManagementProject } = require("../../management/client.js");
const {
  needsSessionBootstrapMerge,
  needsCompatibilityAdapterBootstrapMerge,
  needsHookMerge,
  needsProjectionRegistryMerge,
} = require("../../setup");
const { printManagementPayload } = require("../management/api-helpers");

function collectSemanticMergeCandidates(ctx) {
  const candidates = [];
  const agentsPath = path.join(ctx.cwd, "AGENTS.md");
  if (needsSessionBootstrapMerge(ctx, agentsPath)) {
    candidates.push({
      path: "AGENTS.md",
      layer: "L2",
      action: fs.existsSync(agentsPath) ? "merge" : "add",
      reason: fs.existsSync(agentsPath) ? "entry_runtime_bootstrap_stale" : "entry_file_missing",
      risk: fs.existsSync(agentsPath) ? "medium" : "low",
    });
  }
  if (ctx.command === "update" && needsCompatibilityAdapterBootstrapMerge(ctx, agentsPath)) {
    candidates.push({
      path: "AGENTS.md",
      layer: "L2",
      action: fs.existsSync(agentsPath) ? "merge" : "add",
      reason: "entry_compatibility_adapter_bootstrap_stale",
      risk: "medium",
    });
  }
  for (const rel of [".agent/hooks/hooks.json", ".claude/settings.json"]) {
    if (needsHookMerge(ctx, rel)) {
      candidates.push({
        path: rel,
        layer: "L2",
        action: fs.existsSync(path.join(ctx.cwd, rel)) ? "merge" : "add",
        reason: "hook_runtime_continuity_stale",
        risk: "medium",
      });
    }
  }
  if (needsProjectionRegistryMerge(ctx)) {
    candidates.push({
      path: ".agent/skills/management-api/scripts/projection-registry.json",
      layer: "L2",
      action: "merge",
      reason: "projection_registry_stale",
      risk: "medium",
    });
  }
  return candidates;
}

function verificationCheck(name, status, command, details = {}) {
  return {
    name,
    status,
    command,
    exit_code: status === "passed" || status === "skipped" ? 0 : 1,
    ...details,
  };
}

function parseJsonCheck(filePath) {
  if (!fs.existsSync(filePath)) {
    return verificationCheck(`parse ${path.relative(process.cwd(), filePath)}`, "skipped", `node -e JSON.parse(${filePath})`, {
      message: "file_missing",
    });
  }
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
    return verificationCheck(`parse ${path.relative(process.cwd(), filePath)}`, "passed", `parse ${filePath}`);
  } catch (error) {
    return verificationCheck(`parse ${path.relative(process.cwd(), filePath)}`, "failed", `parse ${filePath}`, {
      message: error.message,
    });
  }
}

function runNodeJsonCheck(cwd, args, name) {
  const command = `node ${args.join(" ")}`;
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return verificationCheck(name, "failed", command, { message: result.error.message, exit_code: 1 });
  }
  try {
    const payload = JSON.parse(result.stdout);
    if (result.status === 0 && payload && payload.ok === true) {
      return verificationCheck(name, "passed", command, { exit_code: 0 });
    }
    return verificationCheck(name, "failed", command, {
      exit_code: result.status || 1,
      message: payload && (payload.message || payload.error) ? String(payload.message || payload.error) : "command_failed",
    });
  } catch (error) {
    return verificationCheck(name, "failed", command, {
      exit_code: result.status || 1,
      message: `invalid_json: ${error.message}`,
      stderr: String(result.stderr || "").trim(),
    });
  }
}

function managementQueryCheck(ctx, projection, extraArgs = []) {
  const command = `cortex-agent query ${projection}${extraArgs.length ? ` ${extraArgs.join(" ")}` : ""}`;
  const result = queryManagementProject(ctx, projection, extraArgs);
  if (result.ok) return verificationCheck(`query ${projection}`, "passed", command);
  const unavailable = result.error && [
    "MANAGEMENT_API_UNAVAILABLE",
    "MANAGEMENT_API_QUERY_FAILED",
    "CAPABILITY_UNAVAILABLE",
  ].includes(result.error.code);
  return verificationCheck(`query ${projection}`, unavailable ? "skipped" : "failed", command, {
    message: result.error ? result.error.message : "query_failed",
    details: result.error ? result.error.details : {},
  });
}

function withoutProjectArgs(args = []) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      index += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--project=")) continue;
    normalized.push(arg);
  }
  return normalized;
}

function runUpdateVerification(ctx, { full = false } = {}) {
  // Late require: updateProjectDescriptor lives in ./report. Delayed so the
  // report ↔ verify module-load graph stays acyclic.
  const { updateProjectDescriptor } = require("./report");
  const resolved = resolveManagementProject(ctx);
  const project = resolved.ok
    ? resolved.project
    : updateProjectDescriptor(ctx.cwd, path.join(ctx.cwd, ".agent"));
  const root = project.root;
  const agentRoot = project.agent_root;
  const projectName = path.basename(root);
  const checks = [
    parseJsonCheck(path.join(agentRoot, "hooks", "hooks.json")),
    parseJsonCheck(path.join(root, ".claude", "settings.json")),
    parseJsonCheck(path.join(agentRoot, "skills", "management-api", "scripts", "projection-registry.json")),
  ];

  const runtimeScript = path.join(agentRoot, "skills", "runtime-continuity", "scripts", "index.js");
  if (fs.existsSync(runtimeScript)) {
    checks.push(runNodeJsonCheck(root, [runtimeScript, "resume-bundle", "--project", projectName], "runtime resume-bundle"));
  } else {
    checks.push(verificationCheck("runtime resume-bundle", "skipped", `node ${runtimeScript} resume-bundle --project ${projectName}`, {
      message: "runtime_continuity_unavailable",
    }));
  }

  const verificationCtx = { ...ctx, args: withoutProjectArgs(ctx.args) };
  checks.push(managementQueryCheck(verificationCtx, "capabilities"));
  checks.push(managementQueryCheck(verificationCtx, "dashboard-state"));
  const today = new Date().toISOString().slice(0, 10);
  checks.push(managementQueryCheck(verificationCtx, "activity", ["--since", today]));
  if (full) checks.push(managementQueryCheck(verificationCtx, "activity"));

  const failed = checks.filter((check) => check.status === "failed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  return {
    ok: failed === 0,
    schema_version: 1,
    command: ctx.command,
    mode: full ? "verify-full" : "verify",
    generated_at: new Date().toISOString(),
    project,
    verification: checks,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "passed").length,
      skipped,
      failed,
    },
  };
}

function printUpdateVerification(ctx, report) {
  // Late require: updateReportJson lives in ./report. Delayed so the
  // report ↔ verify module-load graph stays acyclic.
  const { updateReportJson } = require("./report");
  if (updateReportJson(ctx)) {
    printManagementPayload(report);
    return;
  }
  const isZh = ctx.lang === "zh";
  console.log(isZh ? "✅ Update 验证结果：" : "✅ Update verification:");
  for (const check of report.verification) {
    const mark = check.status === "passed" ? "✓" : check.status === "skipped" ? "-" : "!";
    console.log(`  ${mark} ${check.name}: ${check.status}${check.message ? ` (${check.message})` : ""}`);
  }
  console.log(`  summary: ${report.summary.passed} passed, ${report.summary.skipped} skipped, ${report.summary.failed} failed`);
}

module.exports = {
  collectSemanticMergeCandidates,
  verificationCheck,
  parseJsonCheck,
  runNodeJsonCheck,
  managementQueryCheck,
  withoutProjectArgs,
  runUpdateVerification,
  printUpdateVerification,
};
