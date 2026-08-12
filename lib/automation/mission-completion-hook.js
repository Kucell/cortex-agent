"use strict";

// ─── Mission Completion Hook (P-006 Capability D) ────────────────────────────
//
// Given a mission that just transitioned to "done", inspect its
// validation-contract.json for a `bridge_sync` gate (Capability E) **or** a
// `bridge_emit` field declared in the mission frontmatter. If present,
// synthesise the corresponding bridge event(s) and write them to the local
// outbox through lib/cross-project/outbox.
//
// Source: P-006 §3.4 Capability D.

const fs = require("node:fs");
const path = require("node:path");
const outbox = require("../cross-project/outbox");

function readMissionPlan(root, missionId) {
  const file = path.join(root, ".agent", "missions", missionId, "mission-plan.md");
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

function readValidationContract(root, missionId) {
  const file = path.join(root, ".agent", "missions", missionId, "validation-contract.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readMissionFrontmatter(planRaw) {
  if (!planRaw) return null;
  const lines = planRaw.split(/\r?\n/);
  if (lines[0].trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const block = lines.slice(1, end).join("\n");
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function findBridgeEmitFields(contract) {
  if (!contract || !Array.isArray(contract.gates)) return [];
  const fields = [];
  for (const gate of contract.gates) {
    if (gate && gate.type === "bridge_emit") fields.push(gate);
  }
  return fields;
}

function emitOnCompletion(root, options) {
  const opts = options || {};
  const missionId = opts.mission_id;
  const newState = opts.new_state || "done";
  if (!missionId) return { ok: false, errors: ["mission_id is required"] };
  if (newState !== "done") {
    // Completion hook only fires on transition to done.
    return { ok: true, emitted: [], skipped: "state not done" };
  }

  const contract = readValidationContract(root, missionId);
  const plan = readMissionPlan(root, missionId);
  const frontmatter = readMissionFrontmatter(plan);
  const bridgeFields = findBridgeEmitFields(contract || {});
  const missionBridgeConfig = (frontmatter && frontmatter.bridge_emit_on_done) || null;

  if (bridgeFields.length === 0 && !missionBridgeConfig) {
    return { ok: true, emitted: [], skipped: "no bridge_emit gates declared" };
  }

  const emitted = [];
  const errors = [];
  const specs = [...bridgeFields];
  if (typeof missionBridgeConfig === "string") {
    specs.push({ type: "bridge_emit", event_type: "checkpoint.closed", summary: { mission_id: missionId, state: newState }, correlation_group: missionBridgeConfig });
  }
  for (const spec of specs) {
    if (!spec.event_type) {
      errors.push("bridge_emit gate missing event_type");
      continue;
    }
    const result = outbox.writeEvent(root, {
      source_project_id: opts.source_project_id || frontmatter && frontmatter.source_project_id || "cortex-agent",
      event_type: spec.event_type,
      summary: { mission_id: missionId, ...(spec.summary || {}) },
      correlation_group: spec.correlation_group || (frontmatter && frontmatter.correlation_group),
      bridge_event_id: spec.bridge_event_id || outbox.generateEventId(`ms-${missionId.toLowerCase()}`),
    });
    if (result.ok) emitted.push(result.event_id);
    else errors.push(...result.errors);
  }
  return { ok: errors.length === 0, emitted, errors };
}

module.exports = {
  emitOnCompletion,
  // Exposed for tests
  readValidationContract,
  readMissionPlan,
  readMissionFrontmatter,
  findBridgeEmitFields,
};
