"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GATE_ID = /^(?:M|D|WP)-[A-Za-z0-9._-]+$/;

function addGate(gates, value) {
  if (typeof value === "string" && GATE_ID.test(value)) gates.add(value);
}

function readExplicitPolicy(agentRoot, gates) {
  const policyPath = path.join(
    agentRoot,
    "coordination",
    "authorization-policy.json",
  );
  if (!fs.existsSync(policyPath)) return;
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (_) {
    return;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
      || !Array.isArray(policy.workflowGates)) return;
  for (const gate of policy.workflowGates) addGate(gates, gate);
}

function readMissionRegistry(agentRoot, gates) {
  const missionsDir = path.join(agentRoot, "missions");
  let entries;
  try {
    entries = fs.readdirSync(missionsDir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !GATE_ID.test(entry.name)
        || !entry.name.startsWith("M-")) continue;
    const plan = path.join(missionsDir, entry.name, "mission-plan.md");
    if (fs.existsSync(plan) && fs.statSync(plan).isFile()) {
      gates.add(entry.name);
    }
  }
}

/**
 * Resolve authorization roots controlled by the target project. This is a
 * local same-user trust boundary: the JSON supplied by a caller is a claim;
 * it becomes authorized only when its gate exists in this registry.
 */
function loadAuthorizationPolicy(projectRoot) {
  const agentRoot = path.join(path.resolve(projectRoot), ".agent");
  const gates = new Set();
  readExplicitPolicy(agentRoot, gates);
  readMissionRegistry(agentRoot, gates);
  return Object.freeze({
    trustModel: "local_same_user",
    workflowGates: Object.freeze([...gates].sort()),
  });
}

module.exports = {
  loadAuthorizationPolicy,
};
