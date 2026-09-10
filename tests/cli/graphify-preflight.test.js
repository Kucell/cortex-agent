"use strict";

// M-035 MS-004 (P-009): Graphify preflight entry point.
//
// The template ships `.agent/skills/graphify/scripts/preflight.mjs`; `init` and
// `upgrade` copy `templates/_shared/.agent` into the target project, so the
// template copy is the source of truth and the installed copy is derived.
// Two guarantees are asserted here:
//   1. preflight is strictly offline (P-009 risk row: "preflight 误发网络").
//   2. it fails closed when the project is not a Graphify-ready .agent root.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const PREFLIGHT = path.join(ROOT, "templates", "_shared", ".agent", "skills", "graphify", "scripts", "preflight.mjs");

function runPreflight(projectRoot) {
  const result = spawnSync(process.execPath, [PREFLIGHT, "--project", projectRoot], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { ...result, report: JSON.parse(result.stdout) };
}

test("preflight entry point exists in the shared template", () => {
  assert.ok(fs.existsSync(PREFLIGHT), PREFLIGHT + " is missing");
});

test("preflight is strictly offline (no network imports)", () => {
  const source = fs.readFileSync(PREFLIGHT, "utf8");
  const offenders = source
    .split("\n")
    .filter((line) => /\b(fetch|axios|https?\.(get|request))\b/.test(line));
  assert.deepEqual(offenders, [], "network calls are not allowed in preflight");
  assert.ok(!/require\(["'](axios|node-fetch|undici)/.test(source));
});

test("preflight reports ok on a graphify-ready project", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "m035-graphify-ok-"));
  const skillDir = path.join(project, ".agent", "skills", "graphify", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "index.mjs"), "// graphify entry\n");

  const result = runPreflight(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.ok, true);
  assert.deepEqual(result.report.summary, { total: 5, pass: 5, fail: 0 });
  assert.equal(result.report.checks.length, 5);
});

test("preflight fails closed when the graphify skill is absent", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "m035-graphify-missing-"));
  fs.mkdirSync(path.join(project, ".agent"), { recursive: true });

  const result = runPreflight(project);
  assert.equal(result.status, 1, "a missing skill must not report success");
  assert.equal(result.report.ok, false);
  assert.ok(result.report.summary.fail >= 1);
  const failed = result.report.checks.filter((entry) => !entry.ok).map((entry) => entry.name);
  assert.ok(failed.includes("graphify_skill"), failed.join(","));
});

test("preflight fails closed when only the preflight script is present", () => {
  // Self-satisfaction guard: the script must not count itself as the graphify
  // entry point, otherwise a bare copy would always report ok.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "m035-graphify-self-"));
  const skillDir = path.join(project, ".agent", "skills", "graphify", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(PREFLIGHT, path.join(skillDir, "preflight.mjs"));

  const result = runPreflight(project);
  assert.equal(result.status, 1);
  assert.equal(result.report.ok, false);
  const failed = result.report.checks.filter((entry) => !entry.ok).map((entry) => entry.name);
  assert.ok(failed.includes("graphify_entry"), failed.join(","));
});

