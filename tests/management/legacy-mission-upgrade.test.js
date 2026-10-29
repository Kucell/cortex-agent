"use strict";
// Regression derived from the reported 1.15.4 -> 1.15.6 legacy Mission shape.
// No Workbench files or approval/state values are copied. This tests data
// preservation and records the current unsupported automatic migration path.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const cli = path.join(root, "bin/cli.js");
const render = path.join(root, "templates/_shared/.agent/tasks/scripts/render-progress.js");
function snapshot(dir) {
  const result = {};
  function visit(p) {
    for (const name of fs.readdirSync(p).sort()) {
      const file = path.join(p, name), stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) visit(file);
      else result[path.relative(dir, file)] = { bytes: fs.readFileSync(file).toString("base64"), mode: stat.mode };
    }
  }
  visit(dir); return result;
}
test("legacy 43 Mission directories / 26 progress rows stay intact when automatic migration has no Mission plan", (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-mission-upgrade-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, "project"), home = path.join(temp, "home");
  fs.mkdirSync(home); fs.mkdirSync(path.join(project, ".agent/plans"), { recursive: true });
  fs.mkdirSync(path.join(project, ".agent/tasks"), { recursive: true });
  const ids = Array.from({ length: 43 }, (_, i) => "M-" + String(i + 1).padStart(3, "0"));
  for (const id of ids) {
    const dir = path.join(project, ".agent/missions", id);
    fs.mkdirSync(path.join(dir, "milestones"), { recursive: true });
    fs.writeFileSync(path.join(dir, "mission-plan.md"), "# Synthetic legacy " + id + "\nOwner interpretation required; no inferred approval.\n");
    fs.writeFileSync(path.join(dir, "validation-contract.json"), '{"synthetic":true}\n');
  }
  const rows = ["# Progress", "", "## 🔥 当前活跃任务", "", "| 任务 ID | 优先级 | 描述 | 进度 |", "| --- | --- | --- | --- |", ...ids.slice(0, 26).map((id) => `| ${id} | P1 | Synthetic legacy mission | 40% |`)];
  fs.writeFileSync(path.join(project, ".agent/plans/task-progress.md"), rows.join("\n") + "\n");
  fs.writeFileSync(path.join(project, ".agent/tasks/index.json"), '{"tasks":[]}\n');
  const before = snapshot(project);
  function invoke(file, args, expected) {
    const result = spawnSync(process.execPath, [file, ...args], { cwd: project,
      env: { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, USERPROFILE: home, LANG: "C", LC_ALL: "C", CORTEX_STATE_SYNC: "off" },
      encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, expected, result.stderr);
    assert.deepEqual(snapshot(project), before, "legacy bytes/modes must not be changed");
    return result;
  }
  const detect = JSON.parse(invoke(cli, ["migrate-task-state", "detect"], 0).stdout);
  assert.equal(detect.needs_migration, true);
  assert.equal(detect.findings.find((x) => x.kind === "mission_rows_without_record").ids.length, 26);
  const plan = JSON.parse(invoke(cli, ["migrate-task-state", "plan"], 0).stdout);
  assert.deepEqual(plan.planned_tasks, []);
  assert.equal(plan.skipped.filter((x) => x.reason === "mission_namespace").length, 26);
  const apply = JSON.parse(invoke(cli, ["migrate-task-state", "apply", "--confirm"], 0).stdout);
  assert.equal(apply.applied, 0);
  const refused = invoke(render, ["--project", project], 1);
  assert.match(refused.stderr + refused.stdout, /拒绝写入|没有对应/);
  assert.equal(ids.some((id) => fs.existsSync(path.join(project, ".agent/missions", id, "mission.json"))), false);
  t.diagnostic("UNSUPPORTED_AUTOMATIC_LEGACY_MISSION_MIGRATION: detect flags missing Mission truth; task plan/apply cannot generate it; renderer preserves all legacy data. Do not force render or infer Owner state.");
});
