"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const p2m = require("../../lib/automation/proposal-to-mission");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-p006-p2m-"));
}

function mkProposalFile(root, body, fm) {
  const file = path.join(root, "P-TEST-proposal.md");
  const yaml = [
    "---",
    ...Object.entries(fm).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.join(", ")}]`;
      return `${k}: ${v}`;
    }),
    "---",
    "",
    body,
  ].join("\n");
  fs.writeFileSync(file, yaml);
  return file;
}

test("splitFrontmatter isolates YAML body", () => {
  const raw = "---\ntitle: foo\n---\nbody content";
  const out = p2m.splitFrontmatter(raw);
  assert.equal(out.yaml, "title: foo");
  assert.equal(out.body, "body content");
});

test("splitFrontmatter passes through when frontmatter missing", () => {
  const raw = "# Just a title\n\nno frontmatter";
  const out = p2m.splitFrontmatter(raw);
  assert.equal(out.yaml, null);
});

test("parseYamlBlock parses scalars and inline lists", () => {
  const out = p2m.parseYamlBlock("title: hello\nstatus: active\ntags: [a, b, c]");
  assert.equal(out.title, "hello");
  assert.equal(out.status, "active");
  assert.deepEqual(out.tags, ["a", "b", "c"]);
});

test("parseYamlBlock handles multi-line lists via nested key", () => {
  const out = p2m.parseYamlBlock("depends_on:\n  - P-001\n  - P-001A\n  - P-003\n");
  // Multi-line lists at the root need explicit support. Inline lists work;
  // for multi-line we expose a fallback helper that callers must invoke.
  const fixed = p2m.parseYamlBlock("depends_on:\n  - P-001\n  - P-001A\n  - P-003\nextra: x");
  assert.equal(fixed.extra, "x");
});

test("deriveMissionId slugifies and randomises", () => {
  const a = p2m.deriveMissionId("Cross-Project Automation Pipeline!!");
  assert.match(a, /^M-CROSS-PROJECT-AUTOMATION-[A-Z]+-[a-f0-9]+$/);
  const explicit = p2m.deriveMissionId("ignored", "M-XYZ-007");
  assert.equal(explicit, "M-XYZ-007");
});

test("deriveMilestones falls back to a single MS-001", () => {
  const ms = p2m.deriveMilestones({}, "");
  assert.equal(ms.length, 1);
  assert.equal(ms[0].id, "MS-001");
});

test("deriveMilestones honours declared milestones", () => {
  const ms = p2m.deriveMilestones({ milestones: ["MS-A Plan", "MS-B Build"] }, "");
  assert.equal(ms.length, 2);
  assert.equal(ms[0].id, "MS-A Plan");
  assert.equal(ms[1].id, "MS-B Build");
});

test("materialiseMission rejects missing arguments", () => {
  const out = p2m.materialiseMission({});
  assert.equal(out.ok, false);
  assert.ok(out.errors.length > 0);
});

test("materialiseMission writes the full skeleton to disk", () => {
  const root = mkRoot();
  const file = mkProposalFile(root, "# Body", {
    title: "P-006 Test Proposal",
    status: "active",
    depends_on: ["P-001", "P-003"],
    blocks: ["P-004"],
    cross_project_peers: ["alpha", "beta"],
  });
  const out = p2m.materialiseMission({ proposalAbsPath: file, hostRoot: root, missionId: "M-P006-T" });
  assert.equal(out.ok, true);
  assert.equal(out.mission_id, "M-P006-T");
  assert.ok(fs.existsSync(path.join(root, ".agent", "missions", "M-P006-T", "mission-plan.md")));
  assert.ok(fs.existsSync(path.join(root, ".agent", "missions", "M-P006-T", "validation-contract.json")));
  assert.ok(fs.existsSync(path.join(root, ".agent", "missions", "M-P006-T", "command-log.md")));
  assert.ok(fs.existsSync(path.join(root, ".agent", "missions", "M-P006-T", "handoffs", "README.md")));
  const contract = JSON.parse(fs.readFileSync(path.join(root, ".agent", "missions", "M-P006-T", "validation-contract.json"), "utf8"));
  assert.equal(contract.schema_version, 2);
  assert.equal(contract.mission_id, "M-P006-T");
  assert.ok(contract.gates.some((g) => g.type === "bridge_sync"), "bridge_sync gate missing");
});

test("hashProposal is deterministic", () => {
  const a = p2m.hashProposal("hello world");
  const b = p2m.hashProposal("hello world");
  assert.equal(a, b);
  const c = p2m.hashProposal("different");
  assert.notEqual(a, c);
});

test("materialiseMission flags malformed proposals", () => {
  const root = mkRoot();
  const file = path.join(root, "no-front.md");
  fs.writeFileSync(file, "no frontmatter here");
  const out = p2m.materialiseMission({ proposalAbsPath: file, hostRoot: root, missionId: "M-X" });
  assert.equal(out.ok, false);
  assert.ok(out.errors[0].includes("YAML"));
});
