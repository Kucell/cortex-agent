"use strict";

// ─── Proposal → Mission Skeleton Materialiser (P-006 Capability B) ──────────
//
// Given an approved `cross-project-coordination` proposal file (YAML
// frontmatter + body), derive the mission skeleton: mission-plan.md,
// validation-contract.json, handoffs/ directory and command-log.md.
//
// Inputs:
//   • proposalAbsPath  — absolute path to the proposal markdown file.
//   • hostRoot         — project root where the mission directory lives.
//   • missionId        — explicit M-XXX id (e.g. "M-P006-001"); if absent
//                        the materialiser derives M-<slug>-<random> from the
//                        proposal title.
//
// The materialised mission:
//   • Plans milestones declared in §frontmatter phases (defaults to a single
//     milestone "MS-001 Implementation" when the proposal is silent).
//   • Generates validation-contract.json from frontmatter gates (status,
//     depends_on, blocks) and the bridge_sync gate when bridge frontmatter
//     fields are present (Capability E — see proposal-to-bridge-gate.js).
//   • Provisions `.agent/bridges/<missionId>.json` if the proposal lists
//     cross-project wiring — out of scope here; left as a hook for the
//     mission-completion-hook module (Capability D).
//
// Output:
//   • { ok, mission_id, mission_dir, files: { … } } or { ok: false, errors[] }
//
// The materialiser is deterministic: same proposal hash ⇒ same mission_dir
// layout, but only when invoked with the same missionId. Filenames match the
// mission naming convention used by /mission (M-XXX/MS-NNN.md).
//
// Source: P-006 §3.2 Capability B.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bridgeGate = require("./proposal-to-bridge-gate");

const PROPOSAL_FRONT_DELIM = "---";

function splitFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0].trim() !== PROPOSAL_FRONT_DELIM) {
    return { yaml: null, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === PROPOSAL_FRONT_DELIM) {
      end = i;
      break;
    }
  }
  if (end === -1) return { yaml: null, body: raw };
  return { yaml: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

function parseYamlBlock(block) {
  // Tiny YAML subset: scalar key: value, list items (- value), nested via indent.
  // Sufficient for proposal frontmatter (lists, scalars, plain strings). We use an
  // explicit stack of (indent, container) so lists-of-objects can stay extensible
  // without losing the most recent committed scalar.
  const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const root = {};
  const stack = [{ indent: -1, container: root }];
  function commitListToCurrentOwner() {
    const top = stack[stack.length - 1];
    if (top && Array.isArray(top.__pendingList) && top.__pendingList.length > 0) {
      for (const k of Object.keys(top.container)) {
        if (k === "__pendingList") continue;
        // First list slot wins; preserve any earlier scalar for that key.
      }
    }
  }
  function currentContainer() { return stack[stack.length - 1].container; }
  function popListMode() {
    while (stack.length > 1) stack.pop();
  }
  for (const raw of lines) {
    const indent = raw.match(/^ */)[0].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const line = raw.trim();
    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      const owner = currentContainer();
      if (!Array.isArray(owner.__pendingList)) owner.__pendingList = [];
      owner.__pendingList.push(coerceScalar(item));
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    // If a list was pending on this scope, attach it to this key as the value.
    const owner = currentContainer();
    if (Array.isArray(owner.__pendingList) && owner.__pendingList.length > 0) {
      owner[key] = owner.__pendingList;
      delete owner.__pendingList;
    }
    if (val.length === 0) {
      const child = {};
      owner[key] = child;
      stack.push({ indent, container: child });
      child.__pendingList = [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      owner[key] = val.slice(1, -1).split(",").map((s) => coerceScalar(s.trim())).filter((s) => s !== "");
    } else {
      owner[key] = coerceScalar(val);
    }
  }
  // Final flush: any list still pending somewhere becomes an empty list.
  function flush(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o.__pendingList)) {
      delete o.__pendingList;
    }
    for (const k of Object.keys(o)) flush(o[k]);
  }
  flush(root);
  return root;
}

function coerceScalar(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function deriveMissionId(title, explicit) {
  if (explicit && typeof explicit === "string" && explicit.length > 0) return explicit;
  const slug = String(title || "proposal")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 32);
  const tail = crypto.randomBytes(2).toString("hex");
  return `M-${slug}-${tail}`;
}

function deriveMilestones(frontmatter, body) {
  // Phases declared in frontmatter, or fall back to a single "MS-001 Plan" MS.
  if (Array.isArray(frontmatter.milestones) && frontmatter.milestones.length > 0) {
    return frontmatter.milestones.map((m, i) => ({
      id: typeof m === "string" ? m : m.id || `MS-${String(i + 1).padStart(3, "0")}`,
      title: typeof m === "string" ? m.split(/[-_]/).slice(1).join(" ") || m : m.title || m.id || `MS-${i + 1}`,
      gates: typeof m === "object" ? m.gates || [] : [],
    }));
  }
  const phase = frontmatter.phase || frontmatter.phases || null;
  if (phase) {
    return [{ id: `MS-PHASE-${phase}`, title: `Phase ${phase}`, gates: [] }];
  }
  return [{ id: "MS-001", title: "Implementation", gates: [] }];
}

function buildMissionPlan(frontmatter, missionId, milestones) {
  const title = frontmatter.title || `Mission ${missionId}`;
  const milestonesBlock = milestones
    .map((m) => `- **${m.id}** ${m.title}${m.gates.length > 0 ? ` (gates: ${m.gates.join(", ")})` : ""}`)
    .join("\n");
  return [
    `# Mission Plan — ${missionId}`,
    "",
    `> **Title**: ${title}`,
    `> **Source Proposal**: ${frontmatter.source_proposal || "(not set)"}`,
    `> **Generated By**: proposal-to-mission materialiser (P-006 Capability B)`,
    `> **State**: planned`,
    "",
    "## Milestones",
    milestonesBlock,
    "",
    "## Depends-on",
    (Array.isArray(frontmatter.depends_on) ? frontmatter.depends_on : []).map((d) => `- ${d}`).join("\n") || "- (none)",
    "",
    "## Blocks",
    (Array.isArray(frontmatter.blocks) ? frontmatter.blocks : []).map((d) => `- ${d}`).join("\n") || "- (none)",
    "",
    "## Execution Notes",
    "",
    "This mission was materialised from an approved proposal. Use /mission",
    "expectations plus the validation-contract.json gates to drive execution.",
    "",
  ].join("\n");
}

function buildValidationContract(frontmatter, missionId, milestones, proposalHash) {
  const gates = [];
  if (Array.isArray(frontmatter.gates)) {
    for (const g of frontmatter.gates) {
      if (typeof g === "string") gates.push({ id: g, type: "manual" });
      else gates.push(g);
    }
  }
  // Capability E: synthesise the bridge_sync gate when bridge frontmatter is present.
  const bridgeGateSpec = bridgeGate.deriveBridgeSyncGate(frontmatter);
  if (bridgeGateSpec) {
    gates.push(bridgeGateSpec);
  }
  return {
    schema_version: 2,
    mission_id: missionId,
    proposal_hash: proposalHash,
    generated_at: new Date().toISOString(),
    states: {
      current: "planned",
      transitions: ["in_progress", "blocked", "done"],
    },
    milestones: milestones.map((m) => ({ id: m.id, title: m.title })),
    gates,
  };
}

function hashProposal(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function materialiseMission(options) {
  const opts = options || {};
  if (!opts.proposalAbsPath || !opts.hostRoot) {
    return { ok: false, errors: ["proposalAbsPath and hostRoot are required"] };
  }
  let raw;
  try {
    raw = fs.readFileSync(opts.proposalAbsPath, "utf8");
  } catch (cause) {
    return { ok: false, errors: [`cannot read proposal: ${cause.message}`] };
  }
  const { yaml, body } = splitFrontmatter(raw);
  if (!yaml) return { ok: false, errors: ["proposal is missing YAML frontmatter (---)"] };
  const frontmatter = parseYamlBlock(yaml);
  const title = frontmatter.title || path.basename(opts.proposalAbsPath, ".md");
  const missionId = deriveMissionId(title, opts.missionId);
  const missionDir = path.join(opts.hostRoot, ".agent", "missions", missionId);
  fs.mkdirSync(path.join(missionDir, "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(missionDir, "milestones"), { recursive: true });

  const milestones = deriveMilestones(frontmatter, body);
  const missionPlan = buildMissionPlan(frontmatter, missionId, milestones);
  const proposalHash = hashProposal(raw);
  const validationContract = buildValidationContract(frontmatter, missionId, milestones, proposalHash);
  const commandLog = `# Command Log — ${missionId}\n\n> Auto-generated by P-006 Capability B materialiser.\n\n`;
  const handoffReadme = `# Handoffs — ${missionId}\n\nUse /handoff to add entries here.\n`;

  const files = {};
  const planPath = path.join(missionDir, "mission-plan.md");
  fs.writeFileSync(planPath, missionPlan);
  files["mission-plan.md"] = planPath;

  const contractPath = path.join(missionDir, "validation-contract.json");
  fs.writeFileSync(contractPath, `${JSON.stringify(validationContract, null, 2)}\n`);
  files["validation-contract.json"] = contractPath;

  const cmdLogPath = path.join(missionDir, "command-log.md");
  fs.writeFileSync(cmdLogPath, commandLog);
  files["command-log.md"] = cmdLogPath;

  for (const m of milestones) {
    const msPath = path.join(missionDir, "milestones", `${m.id}.md`);
    fs.writeFileSync(msPath, `# ${m.id} — ${m.title}\n\n_TODO: link to execution evidence._\n`);
    files[`milestones/${m.id}.md`] = msPath;
  }

  const handoffReadmePath = path.join(missionDir, "handoffs", "README.md");
  fs.writeFileSync(handoffReadmePath, handoffReadme);
  files["handoffs/README.md"] = handoffReadmePath;

  return {
    ok: true,
    mission_id: missionId,
    mission_dir: missionDir,
    proposal_hash: proposalHash,
    files,
    frontmatter,
  };
}

module.exports = {
  materialiseMission,
  // Exposed for tests
  parseYamlBlock,
  splitFrontmatter,
  deriveMissionId,
  deriveMilestones,
  buildMissionPlan,
  buildValidationContract,
  hashProposal,
};
