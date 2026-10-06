"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CLASSIFICATIONS = new Set(["mechanical", "decision-required", "retain-legacy"]);
const OPERATIONS = new Set(["replace", "copy_linked_decision_gate"]);

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function gitBlobSha(text) {
  const body = Buffer.from(text, "utf8");
  const header = Buffer.from(`blob ${body.length}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(body).digest("hex");
}

function readJsonFile(file) {
  try {
    return { ok: true, text: fs.readFileSync(file, "utf8"), value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function projectRootPath(projectRoot) {
  return path.resolve(projectRoot || ".");
}

function resolveAgentPath(projectRoot, rel) {
  if (typeof rel !== "string" || !rel.startsWith(".agent/")) {
    throw new Error("MIGRATION_PATH_INVALID: path must start with .agent/");
  }
  const root = projectRootPath(projectRoot);
  const abs = path.resolve(root, rel);
  const agentRoot = path.resolve(root, ".agent");
  if (!(abs === agentRoot || abs.startsWith(agentRoot + path.sep))) {
    throw new Error("MIGRATION_PATH_INVALID: path escapes .agent");
  }
  return abs;
}

function resolvePlanPath(projectRoot, planPath) {
  if (typeof planPath !== "string" || planPath.length === 0) {
    throw new Error("MIGRATION_PLAN_REQUIRED");
  }
  const root = projectRootPath(projectRoot);
  const abs = path.resolve(root, planPath);
  const agentRoot = path.resolve(root, ".agent");
  if (!(abs === agentRoot || abs.startsWith(agentRoot + path.sep))) {
    throw new Error("MIGRATION_PLAN_INVALID: plan must live under .agent");
  }
  return abs;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("MIGRATION_PLAN_INVALID: root");
  if (plan.schema_version !== "1.0") throw new Error("MIGRATION_PLAN_INVALID: schema_version");
  if (typeof plan.mission_id !== "string" || !/^M-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(plan.mission_id)) {
    throw new Error("MIGRATION_PLAN_INVALID: mission_id");
  }
  if (!Array.isArray(plan.entries) || plan.entries.length === 0) throw new Error("MIGRATION_PLAN_INVALID: entries");
  const paths = new Set();
  for (const entry of plan.entries) {
    if (!entry || typeof entry !== "object") throw new Error("MIGRATION_PLAN_INVALID: entry");
    if (typeof entry.path !== "string" || !entry.path.startsWith(".agent/")) throw new Error("MIGRATION_PLAN_INVALID: entry.path");
    if (paths.has(entry.path)) throw new Error(`MIGRATION_PLAN_INVALID: duplicate path ${entry.path}`);
    paths.add(entry.path);
    if (!CLASSIFICATIONS.has(entry.classification)) throw new Error(`MIGRATION_PLAN_INVALID: classification ${entry.classification}`);
    if (typeof entry.expected_blob_sha !== "string" || !/^[0-9a-f]{40}$/.test(entry.expected_blob_sha)) {
      throw new Error(`MIGRATION_PLAN_INVALID: expected_blob_sha ${entry.path}`);
    }
    if (entry.classification === "mechanical") {
      if (!Array.isArray(entry.operations) || entry.operations.length === 0) {
        throw new Error(`MIGRATION_PLAN_INVALID: operations required for ${entry.path}`);
      }
      for (const op of entry.operations) {
        if (!op || typeof op !== "object" || !OPERATIONS.has(op.op)) {
          throw new Error(`MIGRATION_PLAN_INVALID: operation for ${entry.path}`);
        }
        if (op.op === "replace" && (
          typeof op.field !== "string"
          || !Object.prototype.hasOwnProperty.call(op, "from")
          || !Object.prototype.hasOwnProperty.call(op, "to")
        )) {
          throw new Error(`MIGRATION_PLAN_INVALID: replace operation for ${entry.path}`);
        }
      }
    }
  }
  return true;
}

function loadPlan(projectRoot, planPath) {
  const file = resolvePlanPath(projectRoot, planPath);
  const parsed = readJsonFile(file);
  if (!parsed.ok) throw new Error(`MIGRATION_PLAN_READ_FAILED: ${parsed.error}`);
  validatePlan(parsed.value);
  return { file, plan: parsed.value };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function valueEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function linkedDecision(projectRoot, record) {
  const id = record && record.decision_id;
  if (typeof id !== "string" || !/^D-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("MIGRATION_LINKED_DECISION_INVALID");
  }
  const file = resolveAgentPath(projectRoot, `.agent/decisions/${id}.json`);
  const parsed = readJsonFile(file);
  if (!parsed.ok) throw new Error(`MIGRATION_LINKED_DECISION_MISSING: ${id}`);
  const gate = parsed.value && parsed.value.gate;
  if (!gate || typeof gate !== "object" || typeof gate.action !== "string" || typeof gate.resource_ref !== "string") {
    throw new Error(`MIGRATION_LINKED_DECISION_GATE_INVALID: ${id}`);
  }
  return { id, file, gate: clone(gate) };
}

function validateDecisionStatus(record) {
  if (!record || typeof record !== "object") return;
  if (record.status === "open") {
    for (const key of ["selected_option", "resolved_by", "resolved_at"]) {
      if (record[key] !== null && record[key] !== undefined) {
        throw new Error(`MIGRATION_STATUS_INVARIANT: open requires ${key}=null`);
      }
    }
  }
  if (record.status === "approved") {
    if (typeof record.selected_option !== "string" || record.selected_option.length === 0) {
      throw new Error("MIGRATION_STATUS_INVARIANT: approved requires selected_option");
    }
    if (typeof record.resolved_by !== "string" || record.resolved_by.length === 0) {
      throw new Error("MIGRATION_STATUS_INVARIANT: approved requires resolved_by");
    }
    if (typeof record.resolved_at !== "string" || !Number.isFinite(Date.parse(record.resolved_at))) {
      throw new Error("MIGRATION_STATUS_INVARIANT: approved requires resolved_at");
    }
  }
}

function transformMechanical(projectRoot, entry, record) {
  const next = clone(record);
  const evidence = [];
  for (const operation of entry.operations) {
    if (operation.op === "replace") {
      if (!Object.prototype.hasOwnProperty.call(next, operation.field)) {
        throw new Error(`MIGRATION_REPLACE_MISSING_FIELD: ${operation.field}`);
      }
      if (!valueEqual(next[operation.field], operation.from)) {
        throw new Error(`MIGRATION_REPLACE_PRECONDITION: ${operation.field}`);
      }
      next[operation.field] = clone(operation.to);
      evidence.push({ op: "replace", field: operation.field, from: operation.from, to: operation.to });
      continue;
    }
    if (operation.op === "copy_linked_decision_gate") {
      const linked = linkedDecision(projectRoot, next);
      if (typeof next.resource_ref === "string" && next.resource_ref.length > 0 && next.resource_ref !== linked.gate.resource_ref) {
        throw new Error("MIGRATION_GATE_RESOURCE_MISMATCH");
      }
      next.gate = linked.gate;
      evidence.push({ op: "copy_linked_decision_gate", decision_id: linked.id, gate: linked.gate });
      continue;
    }
  }
  if (entry.path.startsWith(".agent/decisions/")) validateDecisionStatus(next);
  return { next, evidence };
}

function backupRelativePath(plan, entry) {
  const base = path.basename(entry.path);
  return `.agent/missions/${plan.mission_id}/evidence/migration-backups/${base}.before.json`;
}

function inspectGovernanceMigration(projectRoot, planPath) {
  const root = projectRootPath(projectRoot);
  const { file: planFile, plan } = loadPlan(root, planPath);
  const entries = [];
  let mechanicalReady = 0;
  let blocked = 0;
  for (const entry of plan.entries) {
    const abs = resolveAgentPath(root, entry.path);
    if (!fs.existsSync(abs)) {
      entries.push({ path: entry.path, classification: entry.classification, status: "missing", errors: ["source_missing"] });
      blocked += 1;
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    const beforeSha = gitBlobSha(text);
    if (beforeSha !== entry.expected_blob_sha) {
      entries.push({
        path: entry.path,
        classification: entry.classification,
        status: "drift",
        expected_blob_sha: entry.expected_blob_sha,
        actual_blob_sha: beforeSha,
        errors: ["source_drift"],
      });
      blocked += 1;
      continue;
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch (error) {
      entries.push({ path: entry.path, classification: entry.classification, status: "invalid-json", errors: [error.message] });
      blocked += 1;
      continue;
    }
    if (entry.classification !== "mechanical") {
      entries.push({
        path: entry.path,
        classification: entry.classification,
        status: "blocked-by-classification",
        blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
        rationale: entry.rationale || "",
      });
      blocked += 1;
      continue;
    }
    try {
      const transformed = transformMechanical(root, entry, record);
      const afterText = stableJson(transformed.next);
      const afterSha = gitBlobSha(afterText);
      entries.push({
        path: entry.path,
        classification: entry.classification,
        status: afterSha === beforeSha ? "no-op" : "ready",
        before_blob_sha: beforeSha,
        after_blob_sha: afterSha,
        backup_path: backupRelativePath(plan, entry),
        operations: transformed.evidence,
      });
      mechanicalReady += 1;
    } catch (error) {
      entries.push({
        path: entry.path,
        classification: entry.classification,
        status: "blocked",
        before_blob_sha: beforeSha,
        errors: [error.message],
      });
      blocked += 1;
    }
  }
  return {
    ok: blocked === 0 || entries.every((entry) => entry.classification !== "mechanical" || ["ready", "no-op"].includes(entry.status)),
    read_only: true,
    project_root: root,
    plan_path: path.relative(root, planFile).replace(/\\/g, "/"),
    mission_id: plan.mission_id,
    summary: {
      total: entries.length,
      mechanical: entries.filter((x) => x.classification === "mechanical").length,
      mechanical_ready: mechanicalReady,
      decision_required: entries.filter((x) => x.classification === "decision-required").length,
      retain_legacy: entries.filter((x) => x.classification === "retain-legacy").length,
      blocked,
    },
    entries,
  };
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function applyGovernanceMigration(projectRoot, planPath, options = {}) {
  if (options.gate !== "user") {
    return { ok: false, code: "MIGRATION_GATE_REQUIRED", changed_paths: [], changed_resources: [] };
  }
  const root = projectRootPath(projectRoot);
  const { plan } = loadPlan(root, planPath);
  const inspection = inspectGovernanceMigration(root, planPath);
  const mechanicalEntries = inspection.entries.filter((entry) => entry.classification === "mechanical");
  const unsafe = mechanicalEntries.filter((entry) => !["ready", "no-op"].includes(entry.status));
  if (unsafe.length > 0) {
    return {
      ok: false,
      code: "MIGRATION_PRECONDITION_FAILED",
      changed_paths: [],
      changed_resources: [],
      blocked: unsafe,
    };
  }

  const prepared = [];
  for (const planEntry of plan.entries.filter((entry) => entry.classification === "mechanical")) {
    const abs = resolveAgentPath(root, planEntry.path);
    const beforeText = fs.readFileSync(abs, "utf8");
    const beforeSha = gitBlobSha(beforeText);
    if (beforeSha !== planEntry.expected_blob_sha) {
      return { ok: false, code: "MIGRATION_SOURCE_DRIFT", changed_paths: [], changed_resources: [], path: planEntry.path };
    }
    const record = JSON.parse(beforeText);
    const transformed = transformMechanical(root, planEntry, record);
    const afterText = stableJson(transformed.next);
    prepared.push({
      entry: planEntry,
      abs,
      beforeText,
      afterText,
      backupRel: backupRelativePath(plan, planEntry),
      backupAbs: resolveAgentPath(root, backupRelativePath(plan, planEntry)),
    });
  }

  const changedPaths = [];
  const changedResources = [];
  const writtenRecords = [];
  try {
    for (const item of prepared) {
      if (fs.existsSync(item.backupAbs)) {
        const existing = fs.readFileSync(item.backupAbs, "utf8");
        if (existing !== item.beforeText) throw new Error(`MIGRATION_BACKUP_CONFLICT: ${item.backupRel}`);
      } else {
        atomicWrite(item.backupAbs, item.beforeText);
        changedPaths.push(item.backupRel);
      }
      if (item.afterText !== item.beforeText) {
        atomicWrite(item.abs, item.afterText);
        writtenRecords.push(item);
        changedPaths.push(item.entry.path);
        changedResources.push(`governance:${item.entry.path}`);
      }
    }
  } catch (error) {
    let rollbackError = null;
    try {
      for (const item of writtenRecords.reverse()) atomicWrite(item.abs, item.beforeText);
    } catch (rollback) {
      rollbackError = rollback.message;
    }
    return {
      ok: false,
      code: "MIGRATION_WRITE_FAILED",
      error: error.message,
      rollback_error: rollbackError,
      changed_paths: changedPaths,
      changed_resources: changedResources,
    };
  }

  return {
    ok: true,
    project_root: root,
    mission_id: plan.mission_id,
    applied: prepared.length,
    changed_paths: [...new Set(changedPaths)],
    changed_resources: [...new Set(changedResources)],
    blocked_entries: inspection.entries.filter((entry) => entry.classification !== "mechanical"),
  };
}

module.exports = {
  CLASSIFICATIONS,
  OPERATIONS,
  stableJson,
  gitBlobSha,
  validatePlan,
  loadPlan,
  inspectGovernanceMigration,
  applyGovernanceMigration,
  transformMechanical,
};
