"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { inventory, hash, fail } = require("./inventory");
const { validate } = require("./schema");
const { parse } = require("./json");
const template = path.resolve(__dirname, "../../templates");
const formats = {
  task: ["_shared/.agent/tasks/task.schema.json", "_base/.agent/tasks/task.schema.json"],
  mission: ["_base/.agent/missions/mission.schema.json"],
  decision: ["_shared/.agent/decisions/decision.schema.json", "_base/.agent/decisions/decision.schema.json"],
  waitpoint: ["_shared/.agent/waitpoints/waitpoint.schema.json", "_base/.agent/waitpoints/waitpoint.schema.json"],
};
// Schemas are release-owned, never loaded from the project being inspected.
const schemas = Object.fromEntries(Object.entries(formats).map(([kind, files]) => [kind, files.map(file => ({ file, value: JSON.parse(fs.readFileSync(path.join(template, file), "utf8")) }))]));
function identify(rel) {
  for (const kind of Object.keys(formats)) {
    const prefix = { task: "T-", mission: "M-", decision: "D-", waitpoint: "WP-" }[kind];
    const base = `.agent/${kind}s/`;
    if (!rel.startsWith(base)) continue;
    const rest = rel.slice(base.length);
    if (kind === "mission" && /^[^/]+\/mission\.json$/.test(rest)) return { kind, id: rest.split("/")[0] };
    if (!rest.includes("/") && (rest.startsWith(prefix) || (kind === "task" && rest.startsWith("M-"))) && rest.endsWith(".json")) return { kind, id: rest.slice(0, -5) };
  }
  return null;
}
function inspect(project) {
  const source = inventory(project), issues = [], records = [], ids = new Map(), indexes = [];
  const issue = (file, code) => issues.push({ path: file, code, disposition: "unresolved" });
  const marker = source.content.get(".agent/.cortex-version")?.toString("utf8").trim() || null;
  // Product marker is provenance, never sufficient evidence of data format.
  if (!["1.15.4", "1.15.6", "1.16.0"].includes(marker)) issue(".agent/.cortex-version", "UNSUPPORTED_PRODUCT_PROVENANCE");
  const missionIds = new Set();
  for (const row of source.entries) {
    const match = /^\.agent\/missions\/(M-[^/]+)(?:\.json)?$/.exec(row.path);
    if (match) missionIds.add(match[1].replace(/\.json$/, ""));
    if (row.type === "directory" && /^\.agent\/missions\/[^/]+$/.test(row.path) && !match) issue(row.path, "UNCLASSIFIED_MISSION_DIRECTORY");
    const identity = identify(row.path);
    if (row.type !== "file") continue;
    if (!identity) {
      if (/^\.agent\/(?:tasks|missions|decisions|waitpoints)\/.+\.json$/.test(row.path)) {
        const parts = row.path.split("/"), kind = parts[1].slice(0, -1), name = parts[2];
        let known = false;
        if (parts.length === 3 && (name === "sample.json" || name === `${kind}.schema.json` || name === "index.schema.json")) {
          known = ["_base", "_shared"].some(layer => {
            const trusted = path.join(template, layer, row.path);
            return fs.existsSync(trusted) && hash(fs.readFileSync(trusted)) === row.sha256;
          });
        } else if (parts.length === 3 && name === "index.json") {
          const trusted = path.join(template, "_shared", `.agent/${parts[1]}/index.schema.json`);
          if (fs.existsSync(trusted)) {
            try {
              const value = parse(source.content.get(row.path).toString("utf8"));
              known = validate(value, JSON.parse(fs.readFileSync(trusted, "utf8")));
              if (known) indexes.push({ path: row.path, kind, value });
            } catch { known = false; }
          }
        }
        if (!known) issue(row.path, "UNCLASSIFIED_RECORD");
      }
      continue;
    }
    let value;
    try { value = parse(source.content.get(row.path).toString("utf8")); }
    catch { issue(row.path, "INVALID_JSON"); continue; }
    const key = identity.kind + ":" + identity.id;
    if (ids.has(key)) issue(row.path, "DUPLICATE_ID");
    ids.set(key, row.path);
    const recognized = schemas[identity.kind].find(s => validate(value, s.value));
    if (!recognized || value[identity.kind + "_id"] !== identity.id) {
      issue(row.path, "UNKNOWN_OR_INVALID_DATA_FORMAT"); continue;
    }
    records.push({ ...identity, path: row.path, source_sha256: row.sha256, data_format: recognized.file, disposition: "preserve", value });
  }
  // A progress row is evidence of a reference, never an execution/approval state.
  const progress = source.content.get(".agent/plans/task-progress.md")?.toString("utf8") || "";
  for (const line of progress.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    for (const cell of line.split("|")) {
      const id = cell.trim();
      if (/^M-[A-Za-z0-9._-]+$/.test(id)) missionIds.add(id);
      if (/^T-[A-Za-z0-9._-]+$/.test(id) && !ids.has("task:" + id)) issue(".agent/plans/task-progress.md", "LEGACY_TASK_REQUIRES_FIELD_PROVENANCE:" + id);
    }
  }
  for (const id of [...missionIds].sort()) {
    if (!records.some(r => r.kind === "mission" && r.id === id)) issue(`.agent/missions/${id}`, "LEGACY_MISSION_REQUIRES_FIELD_PROVENANCE");
  }
  for (const record of records) {
    if (record.kind === "waitpoint" && record.value.decision_id) {
      const decision = records.find(r => r.kind === "decision" && r.id === record.value.decision_id);
      if (!decision) issue(record.path, "MISSING_DECISION_REFERENCE");
      else if (JSON.stringify(decision.value.gate) !== JSON.stringify(record.value.gate)) issue(record.path, "DECISION_GATE_MISMATCH");
    }
    function checkRef(v) {
      if (typeof v !== "string") { issue(record.path, "UNSUPPORTED_REFERENCE"); return; }
      // Only explicitly project-relative .agent paths have a known base in
      // phase one. Other relative/URI references require a reviewed adapter.
      if (!v.startsWith(".agent/") || v.split("/").includes("..")) issue(record.path, "UNSUPPORTED_REFERENCE");
      else if (!source.content.has(v)) issue(record.path, "MISSING_OR_UNSAFE_REFERENCE");
    }
    function references(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, v] of Object.entries(value)) {
        if ((key.endsWith("_ref") || key === "ref") && v !== null) checkRef(v);
        else if (key.endsWith("_refs") && Array.isArray(v)) v.forEach(checkRef);
        else if (v && typeof v === "object") references(v);
      }
    }
    references(record.value);
    if (record.kind === "task") {
      for (const id of [...(record.value.dependencies || []), ...(record.value.subtasks || [])]) {
        if (!records.some(r => r.kind === "task" && r.id === id)) issue(record.path, "MISSING_TASK_REFERENCE");
      }
    }
    if (record.kind === "mission") {
      const milestones = record.value.milestones || [], mids = milestones.map(m => m.milestone_id);
      if (new Set(mids).size !== mids.length) issue(record.path, "DUPLICATE_MILESTONE_ID");
      if (record.value.current_milestone_id && !mids.includes(record.value.current_milestone_id)) issue(record.path, "MISSING_CURRENT_MILESTONE");
      for (const m of milestones) for (const id of m.depends_on || []) if (!mids.includes(id)) issue(record.path, "MISSING_MILESTONE_DEPENDENCY");
    }
  }
  for (const index of indexes) {
    const rows = index.value[index.kind + "s"];
    for (const row of rows) {
      const record = records.find(r => r.kind === index.kind && r.id === row[index.kind + "_id"]);
      if (!record || record.path !== row.path) issue(index.path, "INDEX_RECORD_MISMATCH");
      else for (const [key, value] of Object.entries(row)) {
        if (key === "path") continue;
        const expected = key === "gate_action" ? record.value.gate?.action :
          key === "resource_ref" ? record.value.gate?.resource_ref : record.value[key];
        if (JSON.stringify(value) !== JSON.stringify(expected)) issue(index.path, "INDEX_RECORD_MISMATCH");
      }
    }
    if (new Set(rows.map(r => r[index.kind + "_id"])).size !== rows.length) issue(index.path, "DUPLICATE_INDEX_ID");
    for (const record of records.filter(r => r.kind === index.kind)) {
      if (!rows.some(r => r[index.kind + "_id"] === record.id)) issue(index.path, "RECORD_MISSING_FROM_INDEX");
    }
  }
  const protectedFiles = source.entries.filter(r => /protected-(?:permit|anchor|store)/.test(path.basename(r.path)) || /\.(?:sqlite|db)(?:-wal|-shm)?$/.test(r.path));
  if (protectedFiles.length) issue(protectedFiles[0].path, "PERMIT_STORE_REQUIRES_SEPARATE_OFFLINE_VALIDATION");
  const after = inventory(project);
  if (source.digest !== after.digest) fail("MIGRATION_SOURCE_CHANGED");
  return {
    schema_version: 1, adapter_version: 1, product_version_marker: marker,
    assessment: "data-format-inspection-only; not backup, authorization or operational verification",
    status: issues.length ? "unresolved" : "no_migration_needed",
    needs_migration: issues.length ? null : false,
    quiescence_verified: false, migration_eligible: false,
    permit_store: protectedFiles.length ? "unresolved" : "not_detected_in_agent_scope",
    scope: { root: source.root, paths: [".agent"], external_permit_domains_inspected: false },
    manifest: source.entries, source_digest: source.digest,
    records: records.map(({ value, ...r }) => r), mission_count: missionIds.size,
    unresolved: issues, operations: [],
  };
}
function plan(project) {
  const result = inspect(project);
  return { ...result, action: "plan", plan_digest: hash(JSON.stringify(result)), executable: false,
    blocked_stages: ["backup", "rehearse", "verify", "switch", "activate"],
    next_action: result.status === "unresolved" ? "resolve_source_evidence" : "none" };
}
module.exports = { inspect, plan };
