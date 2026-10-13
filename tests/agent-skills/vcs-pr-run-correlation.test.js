"use strict";

// Regression coverage for the vcs-pr <-> run-event correlation guard.
//
// `vcs-pr create` opportunistically appends a `vcs_pr_opened` event to the
// active run when the caller omits --run-id.  The inference helper used to
// fall back to "the most-recently-modified run of any status", so a project
// whose runs/ directory held only terminal or stale runs had its unrelated
// run rewritten (event appended, last_event + updated_at overwritten).
// Observed in SamHMI: MR !327 was recorded onto an M-034 run that referenced
// a different MR entirely.
//
// The template script already exports discoverActiveRunId / appendRunEvent,
// so these cases exercise the real helpers against throwaway .agent/runs
// directories, with cwd pointed at the fixture (AGENT_ROOT is cwd-derived).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, test } = require("node:test");

const SCRIPT = path.resolve(
  __dirname,
  "../../templates/en/.agent/skills/vcs-pr/scripts/index.js"
);

function makeProject(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-vcspr-run-"));
  const runsDir = path.join(root, ".agent", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "config"), { recursive: true });
  for (const run of runs) fs.writeFileSync(path.join(runsDir, `${run.run_id}.json`), JSON.stringify(run, null, 2));
  return root;
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function eventOwners(root) {
  const runsDir = path.join(root, ".agent", "runs");
  const owners = [];
  for (const name of fs.readdirSync(runsDir)) {
    const json = JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8"));
    if ((json.events || []).some((e) => e.type === "vcs_pr_opened")) owners.push(name.replace(/\.json$/, ""));
  }
  return owners.sort();
}

// AGENT_ROOT is derived from process.cwd() at module load, so each case runs
// in a child process whose cwd is the fixture.
function discoverIn(root) {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      "const {discoverActiveRunId,appendRunEvent}=require(process.argv[1]);" +
        "const r=discoverActiveRunId();if(r)appendRunEvent(r,{type:'vcs_pr_opened',pr_number:1});" +
        "process.stdout.write(String(r));",
      SCRIPT,
    ],
    { cwd: root, encoding: "utf8", timeout: 30000 }
  );
  return out;
}

describe("vcs-pr run-event correlation", () => {
  test("does not stamp a terminal run when no run is active", () => {
    const root = makeProject([
      { run_id: "R-DONE", status: "completed", updated_at: hoursAgo(1) },
      { run_id: "R-FAILED", status: "failed", updated_at: hoursAgo(2) },
    ]);
    assert.equal(discoverIn(root), "null");
    // Fail-closed: no run may be claimed.
    assert.deepEqual(eventOwners(root), []);
  });

  test("does not stamp an ambiguous parked run", () => {
    const root = makeProject([
      { run_id: "R-ACTIVE", status: "active", updated_at: hoursAgo(1) },
      { run_id: "R-INPROG", status: "in_progress", updated_at: hoursAgo(1) },
      { run_id: "R-STARTED", status: "started", updated_at: hoursAgo(1) },
    ]);
    assert.equal(discoverIn(root), "null");
    assert.deepEqual(eventOwners(root), []);
  });

  test("does not stamp a stale zombie run left in running", () => {
    const root = makeProject([{ run_id: "R-ZOMBIE", status: "running", updated_at: hoursAgo(500) }]);
    assert.equal(discoverIn(root), "null");
    assert.deepEqual(eventOwners(root), []);
  });

  test("still correlates with a genuinely active fresh run", () => {
    const root = makeProject([
      { run_id: "R-ZOMBIE", status: "running", updated_at: hoursAgo(500) },
      { run_id: "R-LIVE", status: "running", updated_at: hoursAgo(0) },
    ]);
    assert.equal(discoverIn(root), "R-LIVE");
    assert.deepEqual(eventOwners(root), ["R-LIVE"]);
  });

  test("explicit --run-id still wins and is honoured", () => {
    const root = makeProject([{ run_id: "R-EXPLICIT", status: "completed", updated_at: hoursAgo(3) }]);
    // Explicit --run-id is authoritative regardless of status or age, so
    // appendRunEvent must still write to it.
    assert.equal(
      execFileSync(
        process.execPath,
        [
          "-e",
          "const {appendRunEvent}=require(process.argv[1]);" +
            "process.stdout.write(String(appendRunEvent(process.argv[2],{type:'vcs_pr_opened',pr_number:1})));",
          SCRIPT,
          "R-EXPLICIT",
        ],
        { cwd: root, encoding: "utf8", timeout: 30000 }
      ),
      "true"
    );
    assert.deepEqual(eventOwners(root), ["R-EXPLICIT"]);
  });
});
