#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const REQUIRED_TOP_LEVEL = [
  "handoff_id",
  "mode",
  "from",
  "to",
  "task_id",
  "task_progress",
  "artifacts",
  "next_action",
  "constraints",
  "verification",
  "produced_at",
];

function usage() {
  console.log(`Usage:
  node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file <handoff.json>
  node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file <handoff.json> --markdown-path <handoff.md> --agent-id <agent>
  node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function fail(message, details) {
  console.error(JSON.stringify({ ok: false, error: message, details: details || {} }, null, 2));
  process.exit(1);
}

function print(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function requireArg(args, key) {
  if (!args[key]) fail(`Missing required --${key}`);
  return args[key];
}

function resolvePath(filePath) {
  return path.resolve(root, filePath);
}

function relativeToRoot(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function readPayload(args) {
  const payloadPath = resolvePath(requireArg(args, "payload-file"));
  if (!fs.existsSync(payloadPath)) fail("Payload file not found", { path: relativeToRoot(payloadPath) });
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  } catch (error) {
    fail("Payload file is not valid JSON", { path: relativeToRoot(payloadPath), error: error.message });
  }
  return { payload, payloadPath };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function requireString(issues, object, key, prefix) {
  if (typeof object[key] !== "string" || object[key].trim() === "") issues.push(`${prefix}.${key}`);
}

function requireArray(issues, object, key, prefix) {
  if (!Array.isArray(object[key])) issues.push(`${prefix}.${key}`);
}

function validatePayload(payload) {
  const issues = [];
  for (const key of REQUIRED_TOP_LEVEL) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") issues.push(key);
  }

  if (!["HUMAN_RESUME", "AGENT_RESUME"].includes(payload.mode)) issues.push("mode:invalid");

  if (!isObject(payload.from)) {
    issues.push("from");
  } else {
    requireString(issues, payload.from, "agent_id", "from");
    requireString(issues, payload.from, "model", "from");
  }

  if (!isObject(payload.to)) {
    issues.push("to");
  } else {
    requireString(issues, payload.to, "role", "to");
    requireArray(issues, payload.to, "model_pref", "to");
    requireArray(issues, payload.to, "required_capabilities", "to");
  }

  if (!isObject(payload.task_progress)) {
    issues.push("task_progress");
  } else {
    requireString(issues, payload.task_progress, "current_step", "task_progress");
    requireArray(issues, payload.task_progress, "completed_steps", "task_progress");
    requireString(issues, payload.task_progress, "in_progress", "task_progress");
    requireArray(issues, payload.task_progress, "remaining_steps", "task_progress");
  }

  if (!isObject(payload.artifacts)) {
    issues.push("artifacts");
  } else {
    requireArray(issues, payload.artifacts, "completed", "artifacts");
    requireString(issues, payload.artifacts, "context_snapshot_ref", "artifacts");
    requireString(issues, payload.artifacts, "markdown_ref", "artifacts");
  }

  if (!Array.isArray(payload.constraints)) issues.push("constraints");

  if (!isObject(payload.verification)) {
    issues.push("verification");
  } else {
    requireArray(issues, payload.verification, "commands_run", "verification");
    requireArray(issues, payload.verification, "commands_needed", "verification");
    requireArray(issues, payload.verification, "known_failures", "verification");
    if (Array.isArray(payload.verification.commands_run)) {
      payload.verification.commands_run.forEach((command, index) => {
        if (!isObject(command)) {
          issues.push(`verification.commands_run[${index}]`);
          return;
        }
        if (typeof command.command !== "string") issues.push(`verification.commands_run[${index}].command`);
        if (command.exit_code !== null && !Number.isInteger(command.exit_code)) issues.push(`verification.commands_run[${index}].exit_code`);
      });
    }
  }

  if (payload.graphify_context !== undefined && payload.graphify_context !== null && !isObject(payload.graphify_context)) {
    issues.push("graphify_context");
  }

  if (payload.context_budget_hint !== undefined && payload.context_budget_hint !== null && (!Number.isInteger(payload.context_budget_hint) || payload.context_budget_hint < 0)) {
    issues.push("context_budget_hint");
  }

  if (Number.isNaN(Date.parse(payload.produced_at))) issues.push("produced_at:invalid-date");
  return issues;
}

function validate(args) {
  const { payload, payloadPath } = readPayload(args);
  const issues = validatePayload(payload);
  print({
    ok: issues.length === 0,
    action: "validate",
    path: relativeToRoot(payloadPath),
    issues,
  });
  if (issues.length > 0) process.exit(1);
}

function publish(args) {
  const { payload, payloadPath } = readPayload(args);
  const issues = validatePayload(payload);
  if (issues.length > 0) fail("Invalid handoff payload", { path: relativeToRoot(payloadPath), issues });

  const markdownPath = resolvePath(requireArg(args, "markdown-path"));
  if (!fs.existsSync(markdownPath)) fail("Markdown handoff not found", { path: relativeToRoot(markdownPath) });

  const artifactBus = path.join(root, ".agent", "artifacts", "scripts", "artifact-bus.js");
  if (!fs.existsSync(artifactBus)) fail("Artifact Bus script not found", { path: relativeToRoot(artifactBus) });

  const refs = [
    relativeToRoot(markdownPath),
    relativeToRoot(payloadPath),
    payload.artifacts.context_snapshot_ref,
    ...(Array.isArray(payload.artifacts.artifact_refs) ? payload.artifacts.artifact_refs : []),
  ].filter(Boolean).join(",");

  const command = [
    artifactBus,
    "append",
    "--task-id", payload.task_id,
    "--agent-id", requireArg(args, "agent-id"),
    "--kind", "handoff",
    "--payload-file", relativeToRoot(payloadPath),
    "--summary", args.summary || payload.next_action,
    "--refs", refs,
    "--status", "handed_off",
    "--next-action", payload.next_action,
  ];

  if (payload.mission_id) command.push("--mission-id", payload.mission_id);

  const result = spawnSync(process.execPath, command, {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    fail("Artifact Bus publish failed", {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  let artifactResult;
  try {
    artifactResult = JSON.parse(result.stdout);
  } catch (error) {
    fail("Artifact Bus returned invalid JSON", { stdout: result.stdout, error: error.message });
  }

  print({
    ok: true,
    action: "publish",
    handoff_id: payload.handoff_id,
    markdown_path: relativeToRoot(markdownPath),
    payload_path: relativeToRoot(payloadPath),
    artifact_path: artifactResult.artifact_path,
    state_path: artifactResult.state_path,
  });
}

function resumePrompt(args) {
  const { payload, payloadPath } = readPayload(args);
  const issues = validatePayload(payload);
  if (issues.length > 0) fail("Invalid handoff payload", { path: relativeToRoot(payloadPath), issues });
  print({
    ok: true,
    action: "resume_prompt",
    mode: payload.mode,
    task_id: payload.task_id,
    mission_id: payload.mission_id || null,
    read_first: [
      "AGENTS.md",
      ".agent/rules/core-principles.md",
      ".agent/rules/code-standards.md",
      payload.artifacts.markdown_ref,
      payload.artifacts.context_snapshot_ref,
    ].filter(Boolean),
    next_action: payload.next_action,
    current_step: payload.task_progress.current_step,
    remaining_steps: payload.task_progress.remaining_steps,
    required_capabilities: payload.to.required_capabilities,
    commands_needed: payload.verification.commands_needed,
    constraints: payload.constraints,
    graphify_context: payload.graphify_context || null,
  });
}

function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "validate") return validate(args);
  if (command === "publish") return publish(args);
  if (command === "resume-prompt") return resumePrompt(args);
  usage();
  process.exit(command ? 1 : 0);
}

main();
