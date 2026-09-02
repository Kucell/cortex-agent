"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(ROOT, "templates/_shared/.agent/skills/mission-progress/scripts/report.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-progress-"));
  const base = path.join(root, ".agent/missions/M-001/milestones");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(base), "mission-plan.md"), "# Mission Plan: M-001 — Example\n");
  fs.writeFileSync(path.join(base, "MS-001.md"), "# Milestone: MS-001 — Foundation\n\n## Status\n- State: Completed\n");
  fs.writeFileSync(path.join(base, "MS-002.md"), "# Milestone: MS-002 — Delivery\n\n## Status\n- State: Planned\n- Depends on: MS-001\n");
  fs.writeFileSync(path.join(base, "MS-003.md"), "# Milestone: MS-003 — External\n\n## Status\n- State: Waiting on receipt\n");
  fs.writeFileSync(path.join(base, "MS-004.md"), "# Milestone: MS-004 — Gate\n\n## Status\n- State: DELTA_GATE_PENDING\n");
  return root;
}

function run(root, args = []) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" }); }

test("reports standard Mission Lite data without writing it", () => {
  const root = fixture();
  const before = fs.readFileSync(path.join(root, ".agent/missions/M-001/milestones/MS-002.md"), "utf8");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mission Status Matrix/);
  assert.match(result.stdout, /M-001\/MS-002/);
  assert.match(result.stdout, /graph TD/);
  assert.equal(fs.readFileSync(path.join(root, ".agent/missions/M-001/milestones/MS-002.md"), "utf8"), before);
});

test("reports a dependency-ready milestone as parallel work and emits JSON", () => {
  const root = fixture();
  const parallel = run(root, ["M-001", "--parallel"]);
  assert.equal(parallel.status, 0, parallel.stderr);
  assert.match(parallel.stdout, /M-001\/MS-002/);
  const json = run(root, ["--format", "json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).missions[0].milestones.length, 4);
});

test("classifies delta-gate pending as waiting rather than active work", () => {
  const root = fixture();
  const result = run(root, ["--blocked"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /M-001\/MS-004 — DELTA_GATE_PENDING/);
});

test("fails clearly when no standard mission data exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-progress-empty-"));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Mission Lite data/);
});
