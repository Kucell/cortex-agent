"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { ROOT, createProject } = require("./helpers/management-mcp");

const CLI = path.join(ROOT, "bin", "cli.js");
const GLOBAL_WORKFLOW_ROOT = path.join(os.homedir(), ".agent", "workflows");
const WEEKLY_REPORT = path.join(GLOBAL_WORKFLOW_ROOT, "weekly-report.md");
const WEEKLY_SUMMARY = path.join(GLOBAL_WORKFLOW_ROOT, "weekly-summary.md");

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("weekly workflows are activity-first and distinguish empty from unavailable", () => {
  for (const file of [WEEKLY_REPORT, WEEKLY_SUMMARY]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /cortex-agent help query --json --project/);
    assert.match(source, /cortex-agent query activity --project/);
    assert.match(source, /direct-state-fallback/);
    assert.match(source, /mtime/);
    assert.match(source, /Git/);
    assert.match(source, /为空|empty/);
  }
  assert.match(fs.readFileSync(WEEKLY_SUMMARY, "utf8"), /unavailable/);
});

test("activity CLI and direct-state fallback yield equivalent fixed-date facts without rewriting reports", (t) => {
  const project = createProject();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeJson(path.join(project, ".agent", "runs", "R-1.json"), {
    run_id: "R-1", task_id: "T-1", kind: "implement", status: "completed", started_at: "2026-07-15T00:00:00.000Z",
    events: [{ type: "completed", status: "completed", message: "Feature complete", at: "2026-07-15T08:00:00.000Z" }],
  });
  writeJson(path.join(project, ".agent", "decisions", "D-1.json"), {
    decision_id: "D-1", status: "approved", prompt: "Approve release", resolved_at: "2026-07-16T08:00:00.000Z", relations: { task_ids: ["T-1"] },
  });
  const history = path.join(project, "reports", "history.md");
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, "# historical report\n", "utf8");
  const before = fs.readFileSync(history);

  const result = spawnSync(process.execPath, [CLI, "query", "activity", "--project", project, "--since", "2026-07-14", "--until", "2026-07-17"], {
    cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, TZ: "Asia/Shanghai", LANG: "en_US.UTF-8" },
  });
  assert.equal(result.status, 0, result.stderr);
  const cliFacts = JSON.parse(result.stdout).data.activity.map(({ activity_id, title, status }) => ({ activity_id, title, status })).sort((a, b) => a.activity_id.localeCompare(b.activity_id));
  const fallbackFacts = [
    { activity_id: "decision:D-1", title: "Approve release", status: "approved" },
    { activity_id: "run:R-1:event:0001", title: "Feature complete", status: "completed" },
  ];
  assert.deepEqual(cliFacts, fallbackFacts);
  assert.deepEqual(fs.readFileSync(history), before);
});
