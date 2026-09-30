"use strict";

// ─── decisions/waitpoints --gate whitelist (contract regression) ──────────────
//
// `.help/decisions-request.md` and the `write.js` per-subcommand contracts
// declare `--gate: mission | agent | user`, but `requestDecision()` and
// `createWaitpoint()` only accepted `["mission", "agent"]`. Passing `--gate user`
// failed closed with WORKFLOW_GATE_REQUIRED — help and implementation disagreed.
//
// These tests pin the contract on BOTH sides:
//   - the three documented gate values are accepted
//   - anything outside the set still fails closed (widening must not weaken the
//     fail-closed guarantee)
//   - the _shared / zh / en template copies stay in agreement, since a gate fix
//     applied to only some copies silently reintroduces the split
//
// The Management API script is invoked directly (not through bin/cli.js) so the
// assertions isolate gate validation from the state-sync/git side effects that
// the issue-15 suite already covers.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, describe, before, after } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATES = ["_shared", "zh", "en"];

// The script emits the lowercase code; bin/cli.js upcases it to
// WORKFLOW_GATE_REQUIRED on the way out. Match either casing.
const GATE_REJECTED = /workflow_gate_required/i;

const MGMT_FILES = [
  "index.js",
  "normalize-token-usage.js",
  "projection-registry.json",
  "query-activity.js",
  "query-dispatch-state.js",
];

const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gate-"));

before(() => {
  // One project per template copy; each gets that copy's real management-api
  // scripts plus the task-state helper the script requires at module load.
  for (const tpl of TEMPLATES) {
    const root = path.join(project, tpl);
    const scripts = path.join(root, ".agent", "skills", "management-api", "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    const src = path.join(ROOT, "templates", tpl, ".agent", "skills", "management-api", "scripts");
    for (const f of MGMT_FILES) {
      fs.copyFileSync(path.join(src, f), path.join(scripts, f));
    }
    const taskScripts = path.join(root, ".agent", "tasks", "scripts");
    fs.mkdirSync(taskScripts, { recursive: true });
    // task-state.js ships only from _shared; the locale copies overlay on top
    // of it at install time, so _shared is the correct source for every copy.
    fs.copyFileSync(
      path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
      path.join(taskScripts, "task-state.js"),
    );
    for (const dir of ["runs", "queues", "sessions", "decisions", "inbox", "waitpoints"]) {
      fs.mkdirSync(path.join(root, ".agent", dir), { recursive: true });
    }
  }
});

after(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

function runApi(tpl, args) {
  const root = path.join(project, tpl);
  const script = path.join(root, ".agent", "skills", "management-api", "scripts", "index.js");
  return spawnSync("node", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function requestArgs(gate) {
  return [
    "decisions", "request",
    "--gate", gate,
    "--decision-id", `D-gate-${gate}`,
    "--gate-action", "architecture",
    "--type", "approval",
    "--requested-by", "tester",
    "--prompt", "contract probe",
    "--resource-ref", "proposal:probe@digest",
    "--options", '["approve","reject"]',
  ];
}

function waitpointArgs(gate) {
  return [
    "waitpoints", "create",
    "--gate", gate,
    "--waitpoint-id", `WP-gate-${gate}`,
    "--owner-workflow", "test",
    "--reason", "contract probe",
    "--action", "release",
    "--resource-ref", "branch:refs/heads/main",
    "--decision-id", "D-gate-probe",
  ];
}

describe("management-api --gate whitelist", () => {
  for (const tpl of TEMPLATES) {
    describe(`template copy: ${tpl}`, () => {
      for (const gate of ["mission", "agent", "user"]) {
        test(`decisions request accepts --gate ${gate}`, () => {
          const r = runApi(tpl, requestArgs(gate));
          const out = r.stdout + r.stderr;
          assert.ok(
            !GATE_REJECTED.test(out),
            `--gate ${gate} is documented as valid but was rejected:\n${out}`,
          );
        });

        test(`waitpoints create accepts --gate ${gate}`, () => {
          const r = runApi(tpl, waitpointArgs(gate));
          const out = r.stdout + r.stderr;
          assert.ok(
            !GATE_REJECTED.test(out),
            `--gate ${gate} is documented as valid but was rejected:\n${out}`,
          );
        });
      }

      test("decisions request still fails closed on an undocumented gate", () => {
        const r = runApi(tpl, requestArgs("hacker"));
        const out = r.stdout + r.stderr;
        assert.match(
          out,
          GATE_REJECTED,
          "widening the whitelist must not let unknown gates through",
        );
      });

      test("waitpoints create still fails closed on an undocumented gate", () => {
        const r = runApi(tpl, waitpointArgs("hacker"));
        const out = r.stdout + r.stderr;
        assert.match(
          out,
          GATE_REJECTED,
          "widening the whitelist must not let unknown gates through",
        );
      });

      test("omitting --gate still fails closed", () => {
        const r = runApi(tpl, requestArgs("").filter((a, i, arr) => a !== "--gate" && arr[i - 1] !== "--gate"));
        const out = r.stdout + r.stderr;
        assert.match(out, GATE_REJECTED, "a missing gate must fail closed");
      });
    });
  }

  test("all three template copies share one gate whitelist", () => {
    // The original defect was a three-way split risk: a fix applied to one copy
    // leaves the others rejecting a documented value. Assert parity explicitly.
    const rejectWith = (tpl) =>
      runApi(tpl, requestArgs("owner")).stdout + runApi(tpl, requestArgs("owner")).stderr;

    const results = TEMPLATES.map(rejectWith);
    const allRejected = results.every((out) => GATE_REJECTED.test(out));
    assert.ok(allRejected, `every copy must reject --gate owner:\n${results.join("\n---\n")}`);
  });
});
