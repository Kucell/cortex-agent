#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const artifactsRoot = path.join(root, ".agent", "artifacts");
const VALID_KINDS = new Set(["plan", "execution", "review", "handoff", "validation", "state", "note"]);
const VALID_STATUSES = new Set(["active", "paused", "completed", "failed", "handed_off"]);

function usage() {
  console.log(`Usage:
  node .agent/artifacts/scripts/artifact-bus.js append --task-id <task> --agent-id <agent> --kind plan|execution|review|handoff|validation|state|note [--mission-id <mission>] [--summary <text>] [--payload-json <json>] [--payload-file <path>] [--refs a,b] [--status active] [--next-action <text>]
  node .agent/artifacts/scripts/artifact-bus.js list --task-id <task>
  node .agent/artifacts/scripts/artifact-bus.js read --task-id <task> --seq <n>
  node .agent/artifacts/scripts/artifact-bus.js read --task-id <task> --artifact <file>
  node .agent/artifacts/scripts/artifact-bus.js state --task-id <task>
  node .agent/artifacts/scripts/artifact-bus.js validate --task-id <task>
`);
}

function now() {
  return new Date().toISOString();
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
  console.error(JSON.stringify({
    ok: false,
    error: message,
    details: details || {},
  }, null, 2));
  process.exit(1);
}

function print(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function requireArg(args, key) {
  if (!args[key]) fail(`Missing required --${key}`);
  return args[key];
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function taskDir(taskId) {
  return path.join(artifactsRoot, taskId);
}

function relativeToRoot(targetPath) {
  return path.relative(root, targetPath).split(path.sep).join("/");
}

function ensureTaskDir(taskId) {
  fs.mkdirSync(taskDir(taskId), { recursive: true });
}

function artifactFiles(taskId) {
  const dir = taskDir(taskId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => /^\d{3}-[a-z0-9-]+\.json$/.test(file))
    .sort();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "artifact";
}

function nextSeq(taskId) {
  const files = artifactFiles(taskId);
  if (files.length === 0) return 1;
  const seqs = files.map((file) => Number(file.slice(0, 3))).filter(Number.isFinite);
  return Math.max(0, ...seqs) + 1;
}

function seqPrefix(seq) {
  return String(seq).padStart(3, "0");
}

function parsePayload(args) {
  if (args["payload-json"]) {
    return JSON.parse(args["payload-json"]);
  }

  if (args["payload-file"]) {
    const payloadPath = path.resolve(root, args["payload-file"]);
    return JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  }

  return {};
}

function readState(taskId) {
  const statePath = path.join(taskDir(taskId), "state.json");
  if (!fs.existsSync(statePath)) {
    return {
      task_id: taskId,
      mission_id: null,
      updated_at: now(),
      latest_seq: 0,
      latest_artifact: null,
      status: "active",
      next_action: "",
      artifacts: [],
    };
  }
  return readJson(statePath);
}

function updateState(taskId, artifact, args, artifactPath) {
  const state = readState(taskId);
  state.task_id = taskId;
  state.mission_id = artifact.mission_id || state.mission_id || null;
  state.updated_at = now();
  state.latest_seq = artifact.seq;
  state.latest_artifact = relativeToRoot(artifactPath);
  state.status = args.status || state.status || "active";
  state.next_action = args["next-action"] || state.next_action || "";
  state.artifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
  state.artifacts.push({
    seq: artifact.seq,
    kind: artifact.kind,
    path: relativeToRoot(artifactPath),
    summary: artifact.summary || "",
    produced_at: artifact.produced_at,
  });
  writeJsonAtomic(path.join(taskDir(taskId), "state.json"), state);
  return state;
}

function append(args) {
  const taskId = requireArg(args, "task-id");
  const agentId = requireArg(args, "agent-id");
  const kind = requireArg(args, "kind");
  if (!VALID_KINDS.has(kind)) fail("Invalid artifact kind", { kind, valid: Array.from(VALID_KINDS) });
  if (args.status && !VALID_STATUSES.has(args.status)) fail("Invalid state status", { status: args.status, valid: Array.from(VALID_STATUSES) });

  ensureTaskDir(taskId);
  const seq = nextSeq(taskId);
  const producedAt = now();
  const fileName = `${seqPrefix(seq)}-${slug(kind)}.json`;
  const artifactPath = path.join(taskDir(taskId), fileName);
  const artifact = {
    artifact_id: `${taskId}-${seqPrefix(seq)}-${slug(kind)}`,
    seq,
    task_id: taskId,
    mission_id: args["mission-id"] || null,
    agent_id: agentId,
    produced_at: producedAt,
    kind,
    summary: args.summary || "",
    refs: splitList(args.refs),
    payload: parsePayload(args),
  };

  writeJsonAtomic(artifactPath, artifact);
  const state = updateState(taskId, artifact, args, artifactPath);
  print({
    ok: true,
    action: "append",
    artifact_path: relativeToRoot(artifactPath),
    state_path: relativeToRoot(path.join(taskDir(taskId), "state.json")),
    artifact,
    state,
  });
}

function list(args) {
  const taskId = requireArg(args, "task-id");
  const artifacts = artifactFiles(taskId).map((file) => {
    const artifactPath = path.join(taskDir(taskId), file);
    const artifact = readJson(artifactPath);
    return {
      seq: artifact.seq,
      kind: artifact.kind,
      path: relativeToRoot(artifactPath),
      summary: artifact.summary || "",
      produced_at: artifact.produced_at,
    };
  });
  print({ ok: true, action: "list", task_id: taskId, artifacts });
}

function read(args) {
  const taskId = requireArg(args, "task-id");
  const artifactName = args.artifact || (args.seq ? artifactFiles(taskId).find((file) => Number(file.slice(0, 3)) === Number(args.seq)) : null);
  if (!artifactName) fail("Artifact not found", { task_id: taskId, seq: args.seq, artifact: args.artifact });
  const artifactPath = path.join(taskDir(taskId), path.basename(artifactName));
  if (!fs.existsSync(artifactPath)) fail("Artifact not found", { path: relativeToRoot(artifactPath) });
  print({ ok: true, action: "read", path: relativeToRoot(artifactPath), artifact: readJson(artifactPath) });
}

function state(args) {
  const taskId = requireArg(args, "task-id");
  const statePath = path.join(taskDir(taskId), "state.json");
  if (!fs.existsSync(statePath)) fail("State not found", { task_id: taskId });
  print({ ok: true, action: "state", path: relativeToRoot(statePath), state: readJson(statePath) });
}

function validateArtifactShape(artifact) {
  const missing = [];
  for (const key of ["artifact_id", "seq", "task_id", "agent_id", "produced_at", "kind", "payload"]) {
    if (artifact[key] === undefined || artifact[key] === null || artifact[key] === "") missing.push(key);
  }
  if (!VALID_KINDS.has(artifact.kind)) missing.push("kind:invalid");
  if (!Number.isInteger(artifact.seq) || artifact.seq < 1) missing.push("seq:invalid");
  if (typeof artifact.payload !== "object" || Array.isArray(artifact.payload)) missing.push("payload:invalid");
  return missing;
}

function validate(args) {
  const taskId = requireArg(args, "task-id");
  const issues = [];
  const files = artifactFiles(taskId);
  let expectedSeq = 1;

  for (const file of files) {
    const artifactPath = path.join(taskDir(taskId), file);
    let artifact;
    try {
      artifact = readJson(artifactPath);
    } catch (error) {
      issues.push({ path: relativeToRoot(artifactPath), issue: "invalid_json", detail: error.message });
      continue;
    }

    const missing = validateArtifactShape(artifact);
    if (missing.length > 0) issues.push({ path: relativeToRoot(artifactPath), issue: "invalid_shape", fields: missing });
    if (artifact.seq !== expectedSeq) issues.push({ path: relativeToRoot(artifactPath), issue: "sequence_gap", expected: expectedSeq, actual: artifact.seq });
    expectedSeq += 1;
  }

  const statePath = path.join(taskDir(taskId), "state.json");
  if (files.length > 0 && !fs.existsSync(statePath)) {
    issues.push({ path: relativeToRoot(statePath), issue: "missing_state" });
  }

  print({
    ok: issues.length === 0,
    action: "validate",
    task_id: taskId,
    artifact_count: files.length,
    issues,
  });

  if (issues.length > 0) process.exit(1);
}

function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  try {
    if (command === "append") return append(args);
    if (command === "list") return list(args);
    if (command === "read") return read(args);
    if (command === "state") return state(args);
    if (command === "validate") return validate(args);
    usage();
    process.exit(command ? 1 : 0);
  } catch (error) {
    fail(error.message, { stack: error.stack });
  }
}

main();
