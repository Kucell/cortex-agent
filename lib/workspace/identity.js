"use strict";

const {
  normalizeExecutionWorkspaceIdentity,
  GovernanceContractError,
} = require("../../packages/project-sdk/src/governance.js");

const RUNTIME_WORKSPACE_STATUSES = Object.freeze([
  "planned",
  "preparing",
  "ready",
  "running",
  "failed",
  "stale",
  "tearing_down",
  "closed",
]);

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOwner(input = {}) {
  if (!plain(input)) {
    throw new GovernanceContractError("ERR_WORKSPACE_OWNER_INVALID");
  }
  const agentId = optionalString(input.agent_id);
  if (!agentId) {
    throw new GovernanceContractError("ERR_WORKSPACE_OWNER_REQUIRED", { field: "agent_id" });
  }
  return Object.freeze({
    agent_id: agentId,
    session_id: optionalString(input.session_id),
    run_id: optionalString(input.run_id),
  });
}

function normalizeRelations(input = {}) {
  if (!plain(input)) {
    throw new GovernanceContractError("ERR_WORKSPACE_RELATIONS_INVALID");
  }
  const list = (value) => Object.freeze(
    [...new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [])].sort(),
  );
  return Object.freeze({
    queue_item_ids: list(input.queue_item_ids),
    lock_scopes: list(input.lock_scopes),
    artifact_refs: list(input.artifact_refs),
    composite_workspace_id: optionalString(input.composite_workspace_id),
  });
}

function normalizeRuntimeWorkspaceIdentity(input) {
  if (!plain(input)) {
    throw new GovernanceContractError("ERR_RUNTIME_WORKSPACE_INVALID");
  }

  const identity = normalizeExecutionWorkspaceIdentity({
    kind: input.kind,
    workspace_id: input.workspace_id,
    repository_id: input.repository_id,
    branch: input.branch,
    base_revision: input.base_revision,
    head_revision: input.head_revision,
    change_request: input.change_request,
    worktree_path: input.worktree_path,
    task_id: input.task_id,
    mission_id: input.mission_id,
    session_id: input.session_id || (input.owner && input.owner.session_id),
  });

  const status = optionalString(input.status) || "planned";
  if (!RUNTIME_WORKSPACE_STATUSES.includes(status)) {
    throw new GovernanceContractError("ERR_RUNTIME_WORKSPACE_STATUS", { status });
  }

  return Object.freeze({
    identity,
    owner: normalizeOwner(input.owner || { agent_id: input.agent_id, session_id: input.session_id, run_id: input.run_id }),
    relations: normalizeRelations(input.relations),
    status,
    failure: input.failure || null,
    created_at: optionalString(input.created_at),
    updated_at: optionalString(input.updated_at),
    closed_at: optionalString(input.closed_at),
  });
}

function fromLegacyWorkspaceRecord(record) {
  if (!plain(record)) {
    throw new GovernanceContractError("ERR_LEGACY_WORKSPACE_INVALID");
  }
  return normalizeRuntimeWorkspaceIdentity({
    kind: "local-worktree",
    workspace_id: record.workspace_id,
    repository_id: record.repository_id,
    branch: record.branch,
    base_revision: record.base_commit,
    head_revision: record.head_commit,
    worktree_path: record.worktree_path,
    task_id: record.task_id,
    mission_id: record.mission_id,
    session_id: record.owner && record.owner.session_id,
    owner: record.owner,
    relations: record.relations,
    status: record.status,
    failure: record.failure,
    created_at: record.created_at,
    updated_at: record.updated_at,
    closed_at: record.closed_at,
  });
}

function createRemoteWorkspaceIdentity(input) {
  return normalizeRuntimeWorkspaceIdentity({
    ...input,
    kind: input.kind || "git-remote",
    worktree_path: null,
  });
}

function requireLocalWorkspace(runtimeWorkspace) {
  const normalized = runtimeWorkspace && runtimeWorkspace.identity
    ? runtimeWorkspace
    : normalizeRuntimeWorkspaceIdentity(runtimeWorkspace);

  if (normalized.identity.kind !== "local-worktree") {
    throw new GovernanceContractError("ERR_LOCAL_WORKSPACE_REQUIRED", {
      workspace_id: normalized.identity.workspace_id,
      kind: normalized.identity.kind,
    });
  }
  return normalized;
}

function remoteReconciliationFacts(runtimeWorkspace) {
  const normalized = runtimeWorkspace && runtimeWorkspace.identity
    ? runtimeWorkspace
    : normalizeRuntimeWorkspaceIdentity(runtimeWorkspace);

  if (normalized.identity.kind === "local-worktree") {
    throw new GovernanceContractError("ERR_REMOTE_WORKSPACE_REQUIRED", {
      workspace_id: normalized.identity.workspace_id,
      kind: normalized.identity.kind,
    });
  }

  return Object.freeze({
    workspace_id: normalized.identity.workspace_id,
    kind: normalized.identity.kind,
    repository_id: normalized.identity.repository_id,
    branch: normalized.identity.branch,
    base_revision: normalized.identity.base_revision,
    head_revision: normalized.identity.head_revision,
    change_request: normalized.identity.change_request,
    task_id: normalized.identity.task_id,
    mission_id: normalized.identity.mission_id,
    session_id: normalized.identity.session_id,
    agent_id: normalized.owner.agent_id,
    run_id: normalized.owner.run_id,
  });
}

module.exports = {
  RUNTIME_WORKSPACE_STATUSES,
  normalizeRuntimeWorkspaceIdentity,
  fromLegacyWorkspaceRecord,
  createRemoteWorkspaceIdentity,
  requireLocalWorkspace,
  remoteReconciliationFacts,
};
