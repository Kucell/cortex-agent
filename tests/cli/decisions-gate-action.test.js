"use strict";

// M-035 MS-004 (P-009): decisions --gate-action / --action compatibility window.
//
// `decisions request` carries two independent gate concepts:
//   --gate <mission|agent>          workflow gate (who may perform the write)
//   --gate-action <architecture|..> decision gate action (what is gated)
// Omitting --gate fails closed with WORKFLOW_GATE_REQUIRED; the deprecated
// --action alias must keep working through 1.x with a stderr warning, and must
// never win over an explicit --gate-action.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const DEPRECATION = "warning: --action is deprecated";

function makeProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "m035-decisions-"));
  fs.cpSync(path.join(ROOT, "templates", "_shared", ".agent"), path.join(project, ".agent"), { recursive: true });
  return project;
}

function run(project, args) {
  return spawnSync(process.execPath, [CLI, "decisions", "request", "--project", project, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function payload(result) {
  return JSON.parse(result.stdout);
}

const BASE = ["--type", "approval", "--requested-by", "test", "--prompt", "probe", "--resource-ref", "probe:test", "--options", '["approve","reject"]'];

test("--gate-action opens a decision and records gate.action", () => {
  const project = makeProject();
  const result = run(project, ["--decision-id", "D-T1", "--gate", "mission", "--gate-action", "architecture", ...BASE]);
  assert.equal(result.status, 0, result.stderr);
  const body = payload(result);
  assert.equal(body.ok, true);
  assert.equal(body.decision.gate.action, "architecture");
  assert.equal(body.decision.workflow_gate, "mission");
  assert.ok(!result.stderr.includes(DEPRECATION), "no deprecation warning expected");
});

test("legacy --action still works but warns on stderr", () => {
  const project = makeProject();
  const result = run(project, ["--decision-id", "D-T2", "--gate", "mission", "--action", "architecture", ...BASE]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(DEPRECATION), result.stderr);
  assert.equal(payload(result).decision.gate.action, "architecture");
});

test("--gate-action wins when both flags are present", () => {
  const project = makeProject();
  const result = run(project, ["--decision-id", "D-T3", "--gate", "mission", "--action", "user", "--gate-action", "architecture", ...BASE]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload(result).decision.gate.action, "architecture");
  assert.ok(!result.stderr.includes(DEPRECATION), "dropped alias must not warn");
});

test("--action=<value> inline form is also accepted", () => {
  const project = makeProject();
  const result = run(project, ["--decision-id", "D-T4", "--gate", "mission", "--action=architecture", ...BASE]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(DEPRECATION), result.stderr);
  assert.equal(payload(result).decision.gate.action, "architecture");
});

test("omitting --gate still fails closed with WORKFLOW_GATE_REQUIRED", () => {
  const project = makeProject();
  const result = run(project, ["--decision-id", "D-T5", "--gate-action", "architecture", ...BASE]);
  assert.notEqual(result.status, 0);
  const body = payload(result);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "WORKFLOW_GATE_REQUIRED");
});

test("an invalid gate action fails closed as INVALID_DECISION_GATE", () => {
  const project = makeProject();
  const result = run(project, ["--decision-id", "D-T6", "--gate", "mission", "--gate-action", "not-a-gate", ...BASE]);
  assert.notEqual(result.status, 0);
  assert.equal(payload(result).error.code, "INVALID_DECISION_GATE");
});

test("help documents both gate concepts without touching the filesystem", () => {
  const result = spawnSync(process.execPath, [CLI, "decisions", "request", "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("--gate-action"));
  assert.ok(/deprecat/i.test(result.stdout), result.stdout);
  assert.ok(result.stdout.includes("WORKFLOW_GATE_REQUIRED"));
});

// The Management API ignores unknown flags, so before P-009 a `--dry-run` on
// `decisions request` silently performed a real, audited write and still exited
// 0. It now fails closed and must not touch the project.
test("--dry-run fails closed instead of silently performing a real write", () => {
  const project = makeProject();
  const before = fs.readdirSync(path.join(project, ".agent", "decisions")).length;
  const result = run(project, ["--decision-id", "D-DR", "--gate", "mission", "--gate-action", "architecture", ...BASE, "--dry-run"]);
  assert.notEqual(result.status, 0, "--dry-run must not exit 0");
  assert.match(result.stderr, /--dry-run is not supported/);
  const after = fs.readdirSync(path.join(project, ".agent", "decisions")).length;
  assert.equal(after, before, "no decision record may be written");
  assert.equal(fs.existsSync(path.join(project, ".agent", "decisions", "D-DR.json")), false);
});

test("the same command without --dry-run still writes the decision (control)", () => {
  const project = makeProject();
  const result = run(project, ["--decision-id", "D-CTL", "--gate", "mission", "--gate-action", "architecture", ...BASE]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(payload(result).decision.gate.action, "architecture");
  assert.equal(fs.existsSync(path.join(project, ".agent", "decisions", "D-CTL.json")), true);
});
