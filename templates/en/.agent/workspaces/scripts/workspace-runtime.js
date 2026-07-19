#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fail(error, details, code = 1) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, details })}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function payload(options) {
  if (!options["payload-json"]) fail("payload_required", "Pass --payload-json with an object.", 2);
  try {
    const value = JSON.parse(options["payload-json"]);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("object required");
    return value;
  } catch (error) {
    fail("invalid_payload", error.message, 2);
  }
}

function stateRoot(cwd) {
  return path.join(cwd, ".agent", "workspaces", "state");
}

function resourceDir(cwd, kind) {
  const directory = path.join(stateRoot(cwd), kind);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function recordPath(cwd, kind, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail("invalid_id", id, 2);
  return path.join(resourceDir(cwd, kind), `${id}.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function now() {
  return new Date().toISOString();
}

function requireFields(value, fields) {
  const missing = fields.filter((field) => value[field] === undefined || value[field] === null || value[field] === "");
  if (missing.length) fail("missing_fields", missing, 2);
}

function readRequired(file, error) {
  if (!fs.existsSync(file)) fail(error, file);
  return readJson(file);
}

function list(cwd, kind) {
  const directory = resourceDir(cwd, kind);
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(directory, name)));
}

function createWorkspace(cwd, input) {
  requireFields(input, ["workspace_id", "repository_id", "root", "worktree_path", "branch", "base_commit", "agent_id"]);
  const file = recordPath(cwd, "identities", input.workspace_id);
  if (fs.existsSync(file)) {
    const existing = readJson(file);
    if (existing.repository_id === input.repository_id && existing.worktree_path === input.worktree_path) return existing;
    fail("workspace_conflict", input.workspace_id);
  }
  const timestamp = now();
  const record = {
    workspace_id: input.workspace_id,
    repository_id: input.repository_id,
    task_id: input.task_id || null,
    mission_id: input.mission_id || null,
    root: input.root,
    worktree_path: input.worktree_path,
    branch: input.branch,
    base_branch: input.base_branch || null,
    base_commit: input.base_commit,
    head_commit: input.head_commit || null,
    owner: { agent_id: input.agent_id, session_id: input.session_id || null, run_id: input.run_id || null },
    status: "planned",
    hook_run_refs: [],
    resource_lease_refs: [],
    relations: { queue_item_ids: [], lock_scopes: [], artifact_refs: [], composite_workspace_id: null },
    failure: null,
    created_at: timestamp,
    updated_at: timestamp,
    closed_at: null
  };
  writeAtomic(file, record);
  return record;
}

const WORKSPACE_TRANSITIONS = {
  planned: ["preparing", "closed"],
  preparing: ["ready", "failed", "tearing_down"],
  ready: ["running", "tearing_down"],
  running: ["ready", "failed", "tearing_down"],
  failed: ["preparing", "tearing_down"],
  stale: ["preparing", "tearing_down"],
  tearing_down: ["closed", "failed"],
  closed: []
};

function transitionWorkspace(cwd, input) {
  requireFields(input, ["workspace_id", "agent_id", "status"]);
  const file = recordPath(cwd, "identities", input.workspace_id);
  const record = readRequired(file, "workspace_not_found");
  if (record.owner.agent_id !== input.agent_id) fail("owner_mismatch", input.agent_id, 2);
  if (!(WORKSPACE_TRANSITIONS[record.status] || []).includes(input.status)) fail("invalid_transition", `${record.status}->${input.status}`, 2);
  record.status = input.status;
  record.updated_at = now();
  if (input.failure) record.failure = input.failure;
  if (input.status === "closed") record.closed_at = record.updated_at;
  writeAtomic(file, record);
  return record;
}

function requestHook(cwd, input) {
  requireFields(input, ["hook_run_id", "workspace_id", "phase", "workflow", "agent_id", "authorization", "timeout_seconds"]);
  if (!input.redact_output) fail("redaction_required", "redact_output must be true", 2);
  if ((input.authorization === "user_decision" || input.external_side_effect) && !input.decision_id) fail("decision_required", input.hook_run_id, 2);
  const workspaceFile = recordPath(cwd, "identities", input.workspace_id);
  const workspace = readRequired(workspaceFile, "workspace_not_found");
  if (workspace.owner.agent_id !== input.agent_id) fail("owner_mismatch", input.agent_id, 2);
  const file = recordPath(cwd, "hooks", input.hook_run_id);
  if (fs.existsSync(file)) return readJson(file);
  const timestamp = now();
  const record = {
    hook_run_id: input.hook_run_id,
    workspace_id: input.workspace_id,
    phase: input.phase,
    status: "authorized",
    owner: { workflow: input.workflow, agent_id: input.agent_id, session_id: input.session_id || null, run_id: input.run_id || null },
    command_ref: input.command_ref || null,
    policy: {
      authorization: input.authorization,
      decision_id: input.decision_id || null,
      timeout_seconds: input.timeout_seconds,
      max_attempts: input.max_attempts || 1,
      redact_output: true,
      external_side_effect: Boolean(input.external_side_effect)
    },
    attempt: input.attempt || 1,
    idempotency_key: input.idempotency_key || null,
    started_at: null,
    finished_at: null,
    exit_code: null,
    failure_reason: null,
    compensation_hook_run_id: null,
    evidence_refs: [],
    created_at: timestamp,
    updated_at: timestamp
  };
  writeAtomic(file, record);
  workspace.hook_run_refs = Array.from(new Set([...workspace.hook_run_refs, input.hook_run_id]));
  workspace.updated_at = timestamp;
  writeAtomic(workspaceFile, workspace);
  return record;
}

const HOOK_TRANSITIONS = {
  authorized: ["running", "canceled"],
  running: ["succeeded", "failed", "timed_out", "canceled", "compensating"],
  failed: ["authorized", "compensating"],
  timed_out: ["authorized", "compensating"],
  compensating: ["compensated", "failed"],
  succeeded: [], canceled: [], compensated: []
};

function transitionHook(cwd, input) {
  requireFields(input, ["hook_run_id", "workflow", "agent_id", "status"]);
  const file = recordPath(cwd, "hooks", input.hook_run_id);
  const record = readRequired(file, "hook_not_found");
  if (record.owner.workflow !== input.workflow || record.owner.agent_id !== input.agent_id) fail("owner_mismatch", input.hook_run_id, 2);
  if (!(HOOK_TRANSITIONS[record.status] || []).includes(input.status)) fail("invalid_transition", `${record.status}->${input.status}`, 2);
  if (input.status === "authorized" && record.attempt >= record.policy.max_attempts) fail("attempt_limit", input.hook_run_id, 2);
  record.status = input.status;
  record.updated_at = now();
  if (input.status === "running") record.started_at = record.updated_at;
  if (input.status === "authorized") record.attempt += 1;
  if (["succeeded", "failed", "timed_out", "canceled", "compensated"].includes(input.status)) record.finished_at = record.updated_at;
  if (input.exit_code !== undefined) record.exit_code = input.exit_code;
  if (input.failure_reason) record.failure_reason = input.failure_reason;
  if (input.evidence_ref) record.evidence_refs = Array.from(new Set([...record.evidence_refs, input.evidence_ref]));
  if (input.compensation_hook_run_id) record.compensation_hook_run_id = input.compensation_hook_run_id;
  writeAtomic(file, record);
  return record;
}

function acquireLease(cwd, input) {
  requireFields(input, ["lease_id", "workspace_id", "resource_type", "resource_key", "agent_id", "strategy", "value"]);
  if (input.external_side_effect && !input.decision_id) fail("decision_required", input.lease_id, 2);
  const workspaceFile = recordPath(cwd, "identities", input.workspace_id);
  const workspace = readRequired(workspaceFile, "workspace_not_found");
  if (workspace.owner.agent_id !== input.agent_id) fail("owner_mismatch", input.agent_id, 2);
  const file = recordPath(cwd, "leases", input.lease_id);
  if (fs.existsSync(file)) return readJson(file);
  const conflict = list(cwd, "leases").find((lease) => lease.status === "held" && lease.resource_type === input.resource_type && lease.resource_key === input.resource_key);
  if (conflict) fail("resource_conflict", conflict.lease_id, 1);
  const timestamp = now();
  const record = {
    lease_id: input.lease_id,
    workspace_id: input.workspace_id,
    resource_type: input.resource_type,
    resource_key: input.resource_key,
    status: "held",
    owner: { agent_id: input.agent_id, session_id: input.session_id || null, run_id: input.run_id || null },
    allocation: { strategy: input.strategy, value: input.value, environment_key: input.environment_key || null, adapter_ref: input.adapter_ref || null },
    external_side_effect: Boolean(input.external_side_effect),
    decision_id: input.decision_id || null,
    acquired_at: timestamp,
    expires_at: input.expires_at || null,
    released_at: null,
    release_reason: null,
    conflicts_with: [],
    evidence_refs: input.evidence_ref ? [input.evidence_ref] : [],
    created_at: timestamp,
    updated_at: timestamp
  };
  writeAtomic(file, record);
  workspace.resource_lease_refs = Array.from(new Set([...workspace.resource_lease_refs, input.lease_id]));
  workspace.updated_at = timestamp;
  writeAtomic(workspaceFile, workspace);
  return record;
}

function releaseLease(cwd, input) {
  requireFields(input, ["lease_id", "agent_id", "reason"]);
  const file = recordPath(cwd, "leases", input.lease_id);
  const record = readRequired(file, "lease_not_found");
  if (record.owner.agent_id !== input.agent_id) fail("owner_mismatch", input.agent_id, 2);
  if (record.status === "released") return record;
  if (!["held", "stale", "failed"].includes(record.status)) fail("invalid_transition", `${record.status}->released`, 2);
  record.status = "released";
  record.released_at = now();
  record.updated_at = record.released_at;
  record.release_reason = input.reason;
  if (input.evidence_ref) record.evidence_refs = Array.from(new Set([...record.evidence_refs, input.evidence_ref]));
  writeAtomic(file, record);
  return record;
}

function sweepLeases(cwd, input) {
  const timestamp = Date.parse(input.at || now());
  const changed = [];
  for (const lease of list(cwd, "leases")) {
    if (lease.status !== "held" || !lease.expires_at || Date.parse(lease.expires_at) > timestamp) continue;
    lease.status = "stale";
    lease.updated_at = new Date(timestamp).toISOString();
    writeAtomic(recordPath(cwd, "leases", lease.lease_id), lease);
    changed.push(lease.lease_id);
  }
  return { marked_stale: changed, released: [] };
}

function unique(values, context) {
  if (new Set(values).size !== values.length) fail("duplicate_values", context, 2);
}

function createComposite(cwd, input) {
  requireFields(input, ["composite_workspace_id", "task_id", "branch_family", "agent_id", "members", "merge_order"]);
  if (!Array.isArray(input.members) || input.members.length < 2) fail("members_required", "At least two repositories are required.", 2);
  const repositoryIds = input.members.map((member) => member.repository_id);
  requireFields(Object.fromEntries(repositoryIds.map((id) => [id, id])), repositoryIds, "members");
  unique(repositoryIds, "repository_id");
  unique(input.merge_order, "merge_order");
  if ([...repositoryIds].sort().join("\n") !== [...input.merge_order].sort().join("\n")) fail("merge_order_mismatch", input.merge_order, 2);
  const members = input.members.map((member) => {
    requireFields(member, ["repository_id", "workspace_id", "branch", "base_commit"], "composite_member");
    const workspace = readRequired(recordPath(cwd, "identities", member.workspace_id), "workspace_not_found");
    if (workspace.repository_id !== member.repository_id || workspace.branch !== member.branch || workspace.base_commit !== member.base_commit) {
      fail("member_identity_mismatch", member.repository_id, 2);
    }
    return {
      repository_id: member.repository_id,
      workspace_id: member.workspace_id,
      branch: member.branch,
      base_commit: member.base_commit,
      head_commit: member.head_commit || null,
      status: "planned",
      validation_refs: []
    };
  }).sort((left, right) => left.repository_id.localeCompare(right.repository_id));
  const file = recordPath(cwd, "composites", input.composite_workspace_id);
  if (fs.existsSync(file)) return readJson(file);
  const timestamp = now();
  const record = {
    composite_workspace_id: input.composite_workspace_id,
    task_id: input.task_id,
    mission_id: input.mission_id || null,
    branch_family: input.branch_family,
    status: "planned",
    owner: { agent_id: input.agent_id, session_id: input.session_id || null, run_id: input.run_id || null },
    members,
    merge_order: [...input.merge_order],
    atomic_merge: false,
    recovery: { strategy: "ordered_checkpoints_with_compensation", failed_repository_id: null, next_repository_id: input.merge_order[0], checkpoint_refs: [], next_action: null },
    session_ids: stringsOrEmpty(input.session_ids),
    run_ids: stringsOrEmpty(input.run_ids),
    validation_refs: [],
    created_at: timestamp,
    updated_at: timestamp,
    closed_at: null
  };
  writeAtomic(file, record);
  for (const member of members) {
    const workspaceFile = recordPath(cwd, "identities", member.workspace_id);
    const workspace = readJson(workspaceFile);
    workspace.relations.composite_workspace_id = record.composite_workspace_id;
    workspace.updated_at = timestamp;
    writeAtomic(workspaceFile, workspace);
  }
  return record;
}

function stringsOrEmpty(values) {
  return Array.from(new Set(Array.isArray(values) ? values : [])).sort();
}

const MEMBER_TRANSITIONS = {
  planned: ["ready", "failed", "blocked"],
  ready: ["running", "failed", "blocked"],
  running: ["validated", "failed", "blocked"],
  validated: ["merge_ready", "failed", "blocked"],
  merge_ready: ["merged", "failed", "blocked"],
  merged: ["closed"],
  failed: ["ready", "blocked"],
  blocked: ["ready", "failed"],
  closed: []
};

function approvedRevisionDecision(cwd, record, member, input) {
  requireFields(input, ["decision_id"], "merge_decision");
  const decisionFile = path.join(cwd, ".agent", "decisions", `${input.decision_id}.json`);
  const decision = readRequired(decisionFile, "decision_not_found");
  const expected = `composite:${record.composite_workspace_id}:repo:${member.repository_id}:revision:${member.head_commit}`;
  if (decision.status !== "approved" || decision.selected_option !== "approve" || decision.gate?.action !== "merge" || decision.gate?.resource_ref !== expected) {
    fail("decision_gate_mismatch", { expected, actual: decision.gate?.resource_ref || null }, 2);
  }
  return path.relative(cwd, decisionFile);
}

function transitionCompositeMember(cwd, input) {
  requireFields(input, ["composite_workspace_id", "repository_id", "agent_id", "status"]);
  const file = recordPath(cwd, "composites", input.composite_workspace_id);
  const record = readRequired(file, "composite_not_found");
  if (record.owner.agent_id !== input.agent_id) fail("owner_mismatch", input.agent_id, 2);
  const member = record.members.find((item) => item.repository_id === input.repository_id);
  if (!member) fail("member_not_found", input.repository_id, 2);
  if (!(MEMBER_TRANSITIONS[member.status] || []).includes(input.status)) fail("invalid_transition", `${member.status}->${input.status}`, 2);
  if (input.head_commit) member.head_commit = input.head_commit;
  if (["merge_ready", "merged"].includes(input.status)) {
    if (!member.head_commit) fail("head_commit_required", member.repository_id, 2);
    member.validation_refs = stringsOrEmpty([...member.validation_refs, approvedRevisionDecision(cwd, record, member, input)]);
  }
  if (input.validation_ref) member.validation_refs = stringsOrEmpty([...member.validation_refs, input.validation_ref]);
  member.status = input.status;
  record.updated_at = now();
  if (["failed", "blocked"].includes(input.status)) {
    record.status = "blocked";
    record.recovery.failed_repository_id = member.repository_id;
    record.recovery.next_repository_id = member.repository_id;
    record.recovery.next_action = input.next_action || `recover ${member.repository_id}`;
  }
  if (input.status === "merged") {
    record.recovery.checkpoint_refs = stringsOrEmpty([...record.recovery.checkpoint_refs, input.validation_ref, ...member.validation_refs].filter(Boolean));
    const index = record.merge_order.indexOf(member.repository_id);
    record.recovery.failed_repository_id = null;
    record.recovery.next_repository_id = record.merge_order[index + 1] || null;
    record.recovery.next_action = record.recovery.next_repository_id ? `merge ${record.recovery.next_repository_id}` : "validate composite";
  }
  writeAtomic(file, record);
  return record;
}

const COMPOSITE_TRANSITIONS = {
  planned: ["preparing", "closed"],
  preparing: ["running", "blocked"],
  running: ["validating_members", "blocked", "recovering"],
  validating_members: ["merge_ready", "blocked", "recovering"],
  merge_ready: ["merging", "blocked"],
  merging: ["validating_composite", "blocked", "recovering"],
  validating_composite: ["completed", "blocked"],
  blocked: ["recovering", "closed"],
  recovering: ["running", "validating_members", "merging", "blocked"],
  completed: ["closed"],
  closed: []
};

function transitionComposite(cwd, input) {
  requireFields(input, ["composite_workspace_id", "agent_id", "status"]);
  const file = recordPath(cwd, "composites", input.composite_workspace_id);
  const record = readRequired(file, "composite_not_found");
  if (record.owner.agent_id !== input.agent_id) fail("owner_mismatch", input.agent_id, 2);
  if (!(COMPOSITE_TRANSITIONS[record.status] || []).includes(input.status)) fail("invalid_transition", `${record.status}->${input.status}`, 2);
  if (input.status === "completed" && !record.members.every((member) => member.status === "merged" || member.status === "closed")) fail("members_not_merged", record.composite_workspace_id, 2);
  record.status = input.status;
  record.updated_at = now();
  if (input.validation_ref) record.validation_refs = stringsOrEmpty([...record.validation_refs, input.validation_ref]);
  if (input.status === "closed") record.closed_at = record.updated_at;
  writeAtomic(file, record);
  return record;
}

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [resource, action] = positional;
  const cwd = process.cwd();
  const input = options["payload-json"] ? payload(options) : {};
  let result;
  if (resource === "workspace" && action === "create") result = createWorkspace(cwd, input);
  else if (resource === "workspace" && action === "transition") result = transitionWorkspace(cwd, input);
  else if (resource === "workspace" && action === "get") result = readRequired(recordPath(cwd, "identities", options.id), "workspace_not_found");
  else if (resource === "hook" && action === "request") result = requestHook(cwd, input);
  else if (resource === "hook" && action === "transition") result = transitionHook(cwd, input);
  else if (resource === "lease" && action === "acquire") result = acquireLease(cwd, input);
  else if (resource === "lease" && action === "release") result = releaseLease(cwd, input);
  else if (resource === "lease" && action === "sweep") result = sweepLeases(cwd, input);
  else if (resource === "lease" && action === "list") result = list(cwd, "leases");
  else if (resource === "composite" && action === "create") result = createComposite(cwd, input);
  else if (resource === "composite" && action === "member") result = transitionCompositeMember(cwd, input);
  else if (resource === "composite" && action === "transition") result = transitionComposite(cwd, input);
  else if (resource === "composite" && action === "get") result = readRequired(recordPath(cwd, "composites", options.id), "composite_not_found");
  else fail("unknown_command", positional.join(" "), 2);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main();
