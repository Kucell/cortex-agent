"use strict";

// Coverage for the L3 archive-missions self-heal script.
// This script lives ONLY in the main repo's .agent/ (never distributed).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const am = require("../.agent/skills/self-check/scripts/archive-missions.js");

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-arch-"));
}

function writeMission(root, name, body) {
  const dir = path.join(root, ".agent", "missions", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mission-plan.md"), body);
  return dir;
}

const COMPLETE_PLAN = `# Mission ${"X"}

## Current State

- State: COMPLETE
- Last updated: 2026-07-20
`;

const ACTIVE_PLAN = `# Mission

## Current State

- State: IN_PROGRESS
- Current milestone: MS-002
`;

// ─── readMissionState ─────────────────────────────────────────────────────────

test("readMissionState reads State from Current State section", () => {
  const root = makeRepo();
  const dir = writeMission(root, "M-001", COMPLETE_PLAN);
  assert.equal(am.readMissionState(path.join(dir, "mission-plan.md")), "COMPLETE");
});

test("readMissionState handles Current State as the last section", () => {
  const root = makeRepo();
  const dir = writeMission(root, "M-001", "# M\n\n## Current State\n- State: COMPLETE\n");
  assert.equal(am.readMissionState(path.join(dir, "mission-plan.md")), "COMPLETE");
});

test("readMissionState returns null for missing file", () => {
  assert.equal(am.readMissionState("/no/such/plan.md"), null);
});

test("isCompleteState accepts COMPLETE/COMPLETED only", () => {
  assert.equal(am.isCompleteState("COMPLETE"), true);
  assert.equal(am.isCompleteState("COMPLETED"), true);
  assert.equal(am.isCompleteState("IN_PROGRESS"), false);
  assert.equal(am.isCompleteState(null), false);
});

// ─── findCompleteMissions ──────────────────────────────────────────────────────

test("findCompleteMissions selects only COMPLETE M-* dirs", () => {
  const root = makeRepo();
  writeMission(root, "M-001", COMPLETE_PLAN);
  writeMission(root, "M-002", ACTIVE_PLAN);
  writeMission(root, "M-003", "# M\n(no current state section)\n");
  const found = am.findCompleteMissions(root).map((c) => c.mission);
  assert.deepEqual(found, ["M-001"]);
});

test("findCompleteMissions ignores non-M dirs (handoffs, archive)", () => {
  const root = makeRepo();
  writeMission(root, "M-001", COMPLETE_PLAN);
  fs.mkdirSync(path.join(root, ".agent/missions/handoffs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent/missions/archive"), { recursive: true });
  const found = am.findCompleteMissions(root).map((c) => c.mission);
  assert.deepEqual(found, ["M-001"]);
});

test("findCompleteMissions skips M-* dir without mission-plan.md", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".agent/missions/M-009"), { recursive: true });
  assert.deepEqual(am.findCompleteMissions(root), []);
});

// ─── archiveMissions ───────────────────────────────────────────────────────────

test("dry-run reports candidates without moving", () => {
  const root = makeRepo();
  writeMission(root, "M-001", COMPLETE_PLAN);
  const result = am.archiveMissions(root, { dryRun: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.archived.length, 0);
  assert.ok(fs.existsSync(path.join(root, ".agent/missions/M-001")), "still in place");
});

test("archive moves COMPLETE mission into archive/ with contents", () => {
  const root = makeRepo();
  const dir = writeMission(root, "M-001", COMPLETE_PLAN);
  fs.writeFileSync(path.join(dir, "command-log.md"), "log\n"); // extra child file

  const result = am.archiveMissions(root, { dryRun: false });
  assert.deepEqual(result.archived, ["M-001"]);
  assert.ok(!fs.existsSync(path.join(root, ".agent/missions/M-001")));
  assert.ok(fs.existsSync(path.join(root, ".agent/missions/archive/M-001/mission-plan.md")));
  assert.ok(fs.existsSync(path.join(root, ".agent/missions/archive/M-001/command-log.md")));
});

test("archive is idempotent (second run finds nothing)", () => {
  const root = makeRepo();
  writeMission(root, "M-001", COMPLETE_PLAN);
  am.archiveMissions(root, { dryRun: false });
  const second = am.archiveMissions(root, { dryRun: false });
  assert.equal(second.scanned, 0);
  assert.equal(second.archived.length, 0);
});

test("archive reports conflict when archive/M-xxx already exists, never overwrites", () => {
  const root = makeRepo();
  writeMission(root, "M-001", COMPLETE_PLAN);
  // Pre-existing archive target with different content.
  const existing = path.join(root, ".agent/missions/archive/M-001");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "mission-plan.md"), "PRE-EXISTING\n");

  const result = am.archiveMissions(root, { dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error, "archive_target_exists");
  // Original still in place, pre-existing archive untouched.
  assert.ok(fs.existsSync(path.join(root, ".agent/missions/M-001")));
  assert.equal(fs.readFileSync(path.join(existing, "mission-plan.md"), "utf8"), "PRE-EXISTING\n");
});

test("archive leaves active missions untouched", () => {
  const root = makeRepo();
  writeMission(root, "M-001", COMPLETE_PLAN);
  writeMission(root, "M-002", ACTIVE_PLAN);
  am.archiveMissions(root, { dryRun: false });
  assert.ok(fs.existsSync(path.join(root, ".agent/missions/M-002")), "active kept");
  assert.ok(fs.existsSync(path.join(root, ".agent/missions/archive/M-001")), "complete archived");
});
