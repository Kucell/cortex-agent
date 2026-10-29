"use strict";

// The public view of the task state is a projection of the truth source.
// Two gates protect it: the renderer refuses to overwrite a view that has
// drifted from the records, and the CI script refuses a view that carries
// more than one active section. A project that has not migrated yet has no
// records at all — the renderer must report the mismatch instead of
// replacing the rows with an empty table.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const renderer = path.join(root, "templates/_shared/.agent/tasks/scripts/render-progress.js");
const gate = path.join(root, ".github/scripts/check-active-tasks-section.js");

test("public synthetic view detects drift and duplicate active sections", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-public-view-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, ".agent/tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".agent/tasks/T-SYNTH-001.json"),
    JSON.stringify({
      task_id: "T-SYNTH-001",
      title: "Synthetic public task",
      status: "active",
      stage: "implement",
      priority: "P1",
    }),
  );
  const run = (script, args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10000 });

  assert.equal(run(renderer, ["--check", "--project", project]).status, 1);
  const write = run(renderer, ["--project", project]);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(run(renderer, ["--check", "--project", project]).status, 0);

  const view = path.join(project, ".agent/plans/task-progress.md");
  assert.equal(run(gate, ["--file", view]).status, 0);
  fs.appendFileSync(view, "\n## Active Tasks\n");
  assert.equal(run(gate, ["--file", view]).status, 1);
  assert.equal(run(renderer, ["--check", "--project", project]).status, 1);
});
