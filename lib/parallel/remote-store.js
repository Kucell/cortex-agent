"use strict";

const { normalizeExecutionWorkspaceIdentity } = require("../../packages/project-sdk/src/governance.js");

const QUEUE_PREFIX = "queues";
const LOCK_PREFIX = "locks/parallel";
const DECISION_PREFIX = "decisions";
const WAITPOINT_PREFIX = "waitpoints";

function parallelError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function id(value, where) {
  if (typeof value !== "string" || !value.trim() || /[\r\n/]/.test(value)) {
    throw parallelError("ERR_REMOTE_PARALLEL_ID_INVALID", "Invalid remote parallel identifier.", { where });
  }
  return value.trim();
}

function normalizeOwnedFiles(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("/") || normalized.includes("../")) {
      throw parallelError("ERR_REMOTE_PARALLEL_OWNED_FILE_INVALID", "owned_files must be project-relative.", { value });
    }
    out.push(normalized);
  }
  return [...new Set(out)].sort();
}

function staticPrefix(pattern) {
  const idx = pattern.search(/[?*[]/);
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

function ownedFilesOverlap(left, right) {
  const a = normalizeOwnedFiles(left);
  const b = normalizeOwnedFiles(right);
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      const xp = staticPrefix(x);
      const yp = staticPrefix(y);
      if (xp && yp && (xp.startsWith(yp) || yp.startsWith(xp))) return true;
    }
  }
  return false;
}

function queueKey(queueId) {
  return QUEUE_PREFIX + "/" + id(queueId, "queue_id") + ".json";
}

function lockKey(scope) {
  const encoded = Buffer.from(id(scope, "scope")).toString("base64url");
  return LOCK_PREFIX + "/" + encoded + ".json";
}

function decisionKey(decisionId) {
  return DECISION_PREFIX + "/" + id(decisionId, "decision_id") + ".json";
}

function waitpointKey(waitpointId) {
  return WAITPOINT_PREFIX + "/" + id(waitpointId, "waitpoint_id") + ".json";
}

class RemoteParallelStore {
  constructor(store) {
    if (!store || typeof store.readJson !== "function" || typeof store.writeJson !== "function") {
      throw parallelError("ERR_REMOTE_PARALLEL_STORE_REQUIRED", "GovernanceStore readJson/writeJson required.");
    }
    this.store = store;
  }

  readQueue(queueId) {
    return this.store.readJson(queueKey(queueId), { required: false });
  }

  createQueue(input, options = {}) {
    if (options.workflow_gate !== "parallel") {
      throw parallelError("ERR_REMOTE_PARALLEL_GATE_REQUIRED", "Queue mutation requires workflow_gate=parallel.");
    }
    const queueId = id(input.queue_id, "queue_id");
    const value = {
      queue_id: queueId,
      name: input.name || queueId,
      status: "active",
      concurrency_limit: Number.isInteger(input.concurrency_limit) && input.concurrency_limit > 0
        ? input.concurrency_limit
        : 1,
      updated_by_gate: "parallel",
      updated_at: input.updated_at || null,
      items: [],
    };
    return this.store.writeJson(queueKey(queueId), value, {
      expected_revision: null,
      message: "parallel: create queue " + queueId,
    });
  }

  upsertQueueItem(queueId, item, options = {}) {
    if (options.workflow_gate !== "parallel") {
      throw parallelError("ERR_REMOTE_PARALLEL_GATE_REQUIRED", "Queue mutation requires workflow_gate=parallel.");
    }
    const current = this.readQueue(queueId);
    if (!current.exists) throw parallelError("ERR_REMOTE_PARALLEL_QUEUE_NOT_FOUND", "Queue not found.", { queue_id: queueId });
    const taskId = id(item.task_id, "task_id");
    const next = { ...current.value, items: [...(current.value.items || [])] };
    const index = next.items.findIndex((entry) => entry.task_id === taskId);
    const normalizedWorkspace = item.workspace
      ? normalizeExecutionWorkspaceIdentity(item.workspace)
      : null;
    const payload = {
      ...(index >= 0 ? next.items[index] : {}),
      task_id: taskId,
      state: item.state || "queued",
      phase: item.phase || null,
      activity: item.activity || null,
      agent_id: item.agent_id || null,
      run_id: item.run_id || null,
      session_id: item.session_id || (normalizedWorkspace && normalizedWorkspace.session_id) || null,
      workspace: normalizedWorkspace,
      owned_files: normalizeOwnedFiles(item.owned_files),
      updated_at: item.updated_at || null,
    };
    if (index >= 0) next.items[index] = payload;
    else next.items.push(payload);
    next.updated_by_gate = "parallel";
    next.updated_at = item.updated_at || null;
    return this.store.writeJson(queueKey(queueId), next, {
      expected_revision: options.expected_revision || current.revision,
      message: "parallel: update queue " + queueId + " task " + taskId,
    });
  }

  acquireLock(input, options = {}) {
    if (options.workflow_gate !== "parallel") {
      throw parallelError("ERR_REMOTE_PARALLEL_GATE_REQUIRED", "Lock mutation requires workflow_gate=parallel.");
    }
    const scope = id(input.scope, "scope");
    const existing = this.store.readJson(lockKey(scope), { required: false });
    if (existing.exists && existing.value && existing.value.released !== true) {
      throw parallelError("ERR_REMOTE_PARALLEL_LOCK_CONFLICT", "Logical progress lock already held.", {
        scope,
        held_by: existing.value.held_by,
      });
    }

    const allLocks = Array.isArray(options.active_locks) ? options.active_locks : [];
    const owned = normalizeOwnedFiles(input.owned_files);
    for (const lock of allLocks) {
      if (!lock || lock.released === true || lock.held_by === input.held_by) continue;
      if (ownedFilesOverlap(owned, lock.owned_files)) {
        throw parallelError("ERR_REMOTE_PARALLEL_OWNED_FILES_CONFLICT", "owned_files overlaps an active remote lock.", {
          scope,
          conflicting_scope: lock.scope || null,
          held_by: lock.held_by || null,
        });
      }
    }

    const workspace = normalizeExecutionWorkspaceIdentity(input.workspace);
    const value = {
      scope,
      held_by: id(input.held_by, "held_by"),
      task_id: input.task_id || null,
      mission_id: input.mission_id || null,
      session_id: input.session_id || workspace.session_id || null,
      workspace,
      owned_files: owned,
      acquired_at: input.acquired_at || null,
      released: false,
    };
    return this.store.writeJson(lockKey(scope), value, {
      expected_revision: existing.revision,
      message: "parallel: acquire lock " + scope,
    });
  }

  releaseLock(scope, actorId, options = {}) {
    if (options.workflow_gate !== "parallel") {
      throw parallelError("ERR_REMOTE_PARALLEL_GATE_REQUIRED", "Lock mutation requires workflow_gate=parallel.");
    }
    const current = this.store.readJson(lockKey(scope), { required: false });
    if (!current.exists) return { ok: true, released: false, revision: current.revision };
    if (current.value.held_by !== actorId) {
      throw parallelError("ERR_REMOTE_PARALLEL_LOCK_OWNER", "Only lock owner may release.", {
        scope,
        held_by: current.value.held_by,
        actor_id: actorId,
      });
    }
    return this.store.writeJson(lockKey(scope), {
      ...current.value,
      released: true,
      released_at: options.released_at || null,
    }, {
      expected_revision: options.expected_revision || current.revision,
      message: "parallel: release lock " + scope,
    });
  }

  readGates(input = {}) {
    const decisions = [];
    const waitpoints = [];
    for (const decisionId of Array.isArray(input.decision_ids) ? input.decision_ids : []) {
      const result = this.store.readJson(decisionKey(decisionId), { required: false });
      if (result.exists) decisions.push(result.value);
    }
    for (const waitpointId of Array.isArray(input.waitpoint_ids) ? input.waitpoint_ids : []) {
      const result = this.store.readJson(waitpointKey(waitpointId), { required: false });
      if (result.exists) waitpoints.push(result.value);
    }
    return { decisions, waitpoints };
  }

  assertDispatchAllowed(input = {}) {
    const { decisions, waitpoints } = this.readGates(input);
    const pendingDecision = decisions.find((item) => item && !["approved", "resolved"].includes(item.status));
    if (pendingDecision) {
      throw parallelError("ERR_REMOTE_PARALLEL_DECISION_BLOCKED", "Parallel dispatch blocked by Decision.", {
        decision_id: pendingDecision.decision_id || null,
      });
    }
    const activeWaitpoint = waitpoints.find((item) => item && !["released", "closed"].includes(item.status));
    if (activeWaitpoint) {
      throw parallelError("ERR_REMOTE_PARALLEL_WAITPOINT_BLOCKED", "Parallel dispatch blocked by Waitpoint.", {
        waitpoint_id: activeWaitpoint.waitpoint_id || null,
      });
    }
    return { ok: true, decisions, waitpoints };
  }
}

module.exports = {
  RemoteParallelStore,
  queueKey,
  lockKey,
  decisionKey,
  waitpointKey,
  normalizeOwnedFiles,
  ownedFilesOverlap,
};
