"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DECISION_TYPES = new Set(["approval", "architecture", "merge", "release", "risk"]);
const DECISION_STATUSES = new Set(["open", "approved", "rejected", "revision_requested", "canceled", "superseded"]);
const WAITPOINT_STATUSES = new Set(["pending", "blocked", "released", "canceled", "expired"]);
const GATE_ACTIONS = new Set(["architecture", "merge", "release", "destructive", "credential", "external_side_effect"]);

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function isDateTime(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isDecisionId(value) {
  return typeof value === "string" && /^D-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isWaitpointId(value) {
  return typeof value === "string" && /^WP-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isWorkflow(value) {
  return typeof value === "string" && /^\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

function validateGate(gate, errors) {
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
    errors.push("gate_missing");
    return;
  }
  if (!GATE_ACTIONS.has(gate.action)) errors.push("gate_action_invalid");
  if (typeof gate.resource_ref !== "string" || gate.resource_ref.length === 0) errors.push("resource_ref_invalid");
}

function projectDecision(data, fileName) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["record_not_object"] };
  }
  if (!isDecisionId(data.decision_id)) errors.push("decision_id_invalid");
  if (data.decision_id && fileName !== `${data.decision_id}.json`) errors.push("filename_id_mismatch");
  if (!DECISION_TYPES.has(data.type)) errors.push("type_invalid");
  if (!DECISION_STATUSES.has(data.status)) errors.push("status_invalid");
  validateGate(data.gate, errors);
  if (!isDateTime(data.updated_at)) errors.push("updated_at_invalid");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    entry: {
      decision_id: data.decision_id,
      path: `.agent/decisions/${fileName}`,
      type: data.type,
      status: data.status,
      gate_action: data.gate.action,
      resource_ref: data.gate.resource_ref,
      updated_at: data.updated_at,
    },
  };
}

function projectWaitpoint(data, fileName) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["record_not_object"] };
  }
  if (!isWaitpointId(data.waitpoint_id)) errors.push("waitpoint_id_invalid");
  if (data.waitpoint_id && fileName !== `${data.waitpoint_id}.json`) errors.push("filename_id_mismatch");
  if (!WAITPOINT_STATUSES.has(data.status)) errors.push("status_invalid");
  if (!isWorkflow(data.owner_workflow)) errors.push("owner_workflow_invalid");
  validateGate(data.gate, errors);
  if (data.decision_id !== null && data.decision_id !== undefined && !isDecisionId(data.decision_id)) {
    errors.push("decision_id_invalid");
  }
  if (!isDateTime(data.updated_at)) errors.push("updated_at_invalid");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    entry: {
      waitpoint_id: data.waitpoint_id,
      path: `.agent/waitpoints/${fileName}`,
      status: data.status,
      owner_workflow: data.owner_workflow,
      gate_action: data.gate.action,
      resource_ref: data.gate.resource_ref,
      decision_id: data.decision_id === undefined ? null : data.decision_id,
      updated_at: data.updated_at,
    },
  };
}

function sourceFiles(agentRoot, dir, prefix) {
  const base = path.join(agentRoot, dir);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function sortEntries(entries, idField) {
  return [...entries].sort((a, b) => {
    const byTime = String(b.updated_at).localeCompare(String(a.updated_at));
    if (byTime !== 0) return byTime;
    return String(a[idField]).localeCompare(String(b[idField]));
  });
}

function buildKind(agentRoot, options) {
  const entries = [];
  const invalid = [];
  for (const fileName of sourceFiles(agentRoot, options.dir, options.prefix)) {
    const file = path.join(agentRoot, options.dir, fileName);
    const parsed = readJson(file);
    if (!parsed.ok) {
      invalid.push({
        path: `.agent/${options.dir}/${fileName}`,
        errors: ["invalid_json"],
        detail: parsed.error,
      });
      continue;
    }
    const projected = options.project(parsed.value, fileName);
    if (!projected.ok) {
      invalid.push({
        path: `.agent/${options.dir}/${fileName}`,
        errors: projected.errors,
      });
      continue;
    }
    entries.push(projected.entry);
  }
  return {
    index: { [options.key]: sortEntries(entries, options.idField) },
    invalid_sources: invalid,
  };
}

function buildGovernanceIndexes(projectRoot) {
  const root = path.resolve(projectRoot || ".");
  const agentRoot = path.join(root, ".agent");
  const decisions = buildKind(agentRoot, {
    dir: "decisions",
    prefix: "D-",
    key: "decisions",
    idField: "decision_id",
    project: projectDecision,
  });
  const waitpoints = buildKind(agentRoot, {
    dir: "waitpoints",
    prefix: "WP-",
    key: "waitpoints",
    idField: "waitpoint_id",
    project: projectWaitpoint,
  });
  return {
    ok: decisions.invalid_sources.length === 0 && waitpoints.invalid_sources.length === 0,
    project_root: root,
    agent_root: agentRoot,
    decisions,
    waitpoints,
  };
}

function compareIndex(file, expected) {
  if (!fs.existsSync(file)) {
    return { drift: true, reason: "missing", actual: null };
  }
  const parsed = readJson(file);
  if (!parsed.ok) return { drift: true, reason: "invalid_json", actual: null, error: parsed.error };
  const expectedText = stableJson(expected);
  const actualText = stableJson(parsed.value);
  return {
    drift: actualText !== expectedText,
    reason: actualText !== expectedText ? "content_mismatch" : null,
    actual: parsed.value,
  };
}

function verifyGovernanceIndexes(projectRoot) {
  const built = buildGovernanceIndexes(projectRoot);
  const decisionsFile = path.join(built.agent_root, "decisions", "index.json");
  const waitpointsFile = path.join(built.agent_root, "waitpoints", "index.json");
  const decisionCheck = compareIndex(decisionsFile, built.decisions.index);
  const waitpointCheck = compareIndex(waitpointsFile, built.waitpoints.index);
  const drift = decisionCheck.drift || waitpointCheck.drift;
  return {
    ok: built.ok && !drift,
    read_only: true,
    project_root: built.project_root,
    invalid_sources: [
      ...built.decisions.invalid_sources,
      ...built.waitpoints.invalid_sources,
    ],
    decisions: {
      expected_count: built.decisions.index.decisions.length,
      invalid_count: built.decisions.invalid_sources.length,
      drift: decisionCheck.drift,
      reason: decisionCheck.reason,
    },
    waitpoints: {
      expected_count: built.waitpoints.index.waitpoints.length,
      invalid_count: built.waitpoints.invalid_sources.length,
      drift: waitpointCheck.drift,
      reason: waitpointCheck.reason,
    },
  };
}

function writeTemp(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  return temp;
}

function restoreFile(file, previous) {
  if (previous === null) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  const temp = writeTemp(file, previous);
  fs.renameSync(temp, file);
}

function rebuildGovernanceIndexes(projectRoot) {
  const built = buildGovernanceIndexes(projectRoot);
  const invalidSources = [
    ...built.decisions.invalid_sources,
    ...built.waitpoints.invalid_sources,
  ];
  if (invalidSources.length > 0) {
    return {
      ok: false,
      code: "GOVERNANCE_INDEX_SOURCE_INVALID",
      project_root: built.project_root,
      invalid_sources: invalidSources,
      changed_paths: [],
    };
  }

  const decisionsFile = path.join(built.agent_root, "decisions", "index.json");
  const waitpointsFile = path.join(built.agent_root, "waitpoints", "index.json");
  const previousDecision = fs.existsSync(decisionsFile) ? fs.readFileSync(decisionsFile, "utf8") : null;
  const previousWaitpoint = fs.existsSync(waitpointsFile) ? fs.readFileSync(waitpointsFile, "utf8") : null;
  const decisionTemp = writeTemp(decisionsFile, stableJson(built.decisions.index));
  const waitpointTemp = writeTemp(waitpointsFile, stableJson(built.waitpoints.index));
  let decisionReplaced = false;
  let waitpointReplaced = false;
  try {
    fs.renameSync(decisionTemp, decisionsFile);
    decisionReplaced = true;
    fs.renameSync(waitpointTemp, waitpointsFile);
    waitpointReplaced = true;
  } catch (error) {
    let rollbackError = null;
    try {
      if (decisionReplaced) restoreFile(decisionsFile, previousDecision);
      if (waitpointReplaced) restoreFile(waitpointsFile, previousWaitpoint);
    } catch (rollback) {
      rollbackError = rollback.message;
    }
    return {
      ok: false,
      code: "GOVERNANCE_INDEX_WRITE_FAILED",
      project_root: built.project_root,
      error: error.message,
      rollback_error: rollbackError,
      changed_paths: [],
    };
  } finally {
    if (fs.existsSync(decisionTemp)) fs.unlinkSync(decisionTemp);
    if (fs.existsSync(waitpointTemp)) fs.unlinkSync(waitpointTemp);
  }
  return {
    ok: true,
    project_root: built.project_root,
    changed_paths: [
      ".agent/decisions/index.json",
      ".agent/waitpoints/index.json",
    ],
    changed_resources: [
      "projection:decisions-index",
      "projection:waitpoints-index",
    ],
    decisions: { count: built.decisions.index.decisions.length },
    waitpoints: { count: built.waitpoints.index.waitpoints.length },
  };
}

module.exports = {
  DECISION_TYPES,
  DECISION_STATUSES,
  WAITPOINT_STATUSES,
  GATE_ACTIONS,
  stableJson,
  projectDecision,
  projectWaitpoint,
  buildGovernanceIndexes,
  verifyGovernanceIndexes,
  rebuildGovernanceIndexes,
};
