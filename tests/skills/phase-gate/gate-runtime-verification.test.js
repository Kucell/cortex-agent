/**
 * tests/skills/phase-gate/gate-runtime-verification.test.js
 *
 * The CLEAN transition must consume the runtime verification evidence.
 *
 * Before this check existed, `/ship` CLEAN was prose only: the runtime
 * evidence skill documents that `verification-summary.json` blocks a release
 * when `overall_status` is `fail`, but no code read that file. The CLEAN
 * transition only looked for a self-check report — which proves the
 * governance state is healthy, not that the application's behaviour was
 * verified. The two are not interchangeable, and the gate had no way to tell
 * "not verified" from "verified".
 *
 * These tests pin the discriminator:
 *   fail    → the transition is blocked
 *   not_run → the transition passes, but the warning is visible
 *   pass    → the transition passes without a warning
 *
 * Source: templates/_shared/.agent/skills/phase-gate/scripts/gate.js
 *
 * The test targets the L1 template copy, not the L3 working instance: the
 * template is what ships to every managed project and it is tracked in this
 * repository, so the test also runs in CI where `.agent/` is a submodule
 * pinned to an older commit.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const GATE = path.resolve(
  __dirname,
  "../../../templates/_shared/.agent/skills/phase-gate/scripts/gate.js"
);

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeProject(verification) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-gate-verification-"));
  fs.mkdirSync(path.join(dir, ".agent", "metrics"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".agent", "hooks"), { recursive: true });
  const run = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["init", "-q", "."]);
  run(["config", "user.email", "gate@test.local"]);
  run(["config", "user.name", "gate test"]);
  if (verification !== undefined) {
    fs.writeFileSync(
      path.join(dir, ".agent", "metrics", "verification-summary.json"),
      `${JSON.stringify(verification, null, 2)}\n`,
      "utf8"
    );
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCleanGate(cwd) {
  return spawnSync(
    "node",
    [GATE, "--from", "SELF_CHECK", "--to", "CLEAN", "--cwd", cwd, "--json"],
    { cwd, encoding: "utf8" }
  );
}

function checkNamed(payload, id) {
  return (payload.checks || []).find((c) => c.id === id);
}

// ─── the discriminator ───────────────────────────────────────────────────────

test("CLEAN is blocked when the runtime verification failed", () => {
  const dir = makeProject({
    overall_status: "fail",
    blockers: [{ case_id: "event-bus-publish", assertion_id: "count-is-one", kind: "output_json_field_equals" }],
  });
  try {
    const result = runCleanGate(dir);
    assert.equal(result.status, 1, "a failed verification must block the release");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "FAIL");
    assert.ok(
      payload.blocking_issues.some((b) => b.includes("runtime_verification")),
      `the blocking issue must name the check: ${JSON.stringify(payload.blocking_issues)}`
    );
    assert.ok(
      payload.blocking_issues.some((b) => b.includes("event-bus-publish#count-is-one")),
      "the blocking issue must name the failing assertion"
    );
  } finally {
    cleanup(dir);
  }
});

test("CLEAN passes but warns when the runtime verification never ran", () => {
  const dir = makeProject({ overall_status: "not_run" });
  try {
    const result = runCleanGate(dir);
    assert.equal(result.status, 0, "not_run must not block — it must be visible instead");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "PASS");
    assert.ok(
      payload.warnings.some((w) => w.includes("runtime_verification")),
      `a not_run verification must produce a visible warning: ${JSON.stringify(payload.warnings)}`
    );
  } finally {
    cleanup(dir);
  }
});

test("CLEAN warns when there is no verification summary at all", () => {
  const dir = makeProject(undefined);
  try {
    const result = runCleanGate(dir);
    assert.equal(result.status, 0, "a missing summary must not block the release");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "PASS");
    assert.ok(
      payload.warnings.some((w) => w.includes("runtime_verification")),
      "a missing verification summary must be reported, not silently ignored"
    );
  } finally {
    cleanup(dir);
  }
});

test("CLEAN warns when the runtime verification only partially passed", () => {
  const dir = makeProject({ overall_status: "partial", blockers: [] });
  try {
    const result = runCleanGate(dir);
    assert.equal(result.status, 0, "partial must not block");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "PASS");
    assert.ok(
      payload.warnings.some((w) => w.includes("runtime_verification")),
      "a partial verification must be reported"
    );
  } finally {
    cleanup(dir);
  }
});

test("CLEAN passes silently when the runtime verification passed", () => {
  const dir = makeProject({ overall_status: "pass", blockers: [] });
  try {
    const result = runCleanGate(dir);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "PASS");
    const check = checkNamed(payload, "runtime_verification");
    assert.ok(check, "the check must run");
    assert.equal(check.status, "PASS");
    assert.ok(
      !payload.warnings.some((w) => w.includes("runtime_verification")),
      "a passed verification must not produce a warning"
    );
  } finally {
    cleanup(dir);
  }
});
