"use strict";

// The knowledge lint counts active tasks from the structured truth source
// when the project has task records. A project that has not migrated yet
// keeps its task state in the markdown view, and the count then falls back
// to parsing that view. The fallback reads the LAST matching section, so a
// later write wins over an earlier one.
//
// The parser lives in the shared template layer, so there is exactly one
// implementation to exercise — not one per language.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(
  path.join(root, "templates/_shared/.agent/skills/knowledge-lint/scripts/index.js"),
  "utf8",
);

const start = source.indexOf("function countActiveTasks(taskProgressContent)");
assert.ok(start >= 0, "countActiveTasks must exist in the shared knowledge-lint script");
const end = source.indexOf("\n}", start) + 2;
const count = vm.runInNewContext(source.slice(start, end) + ";countActiveTasks", {
  countActiveTasksFromTruthSource: () => null,
});

for (const title of ["当前活跃任务", "Active Tasks"]) {
  test("fallback counts " + title + " through true EOF", () => {
    const table =
      "## " + title + "\n\n" +
      "| Task ID | Priority | Description | Progress |\n" +
      "| --- | --- | --- | --- |\n" +
      "| T-SYN-001 | P1 | One | 20% |\n" +
      "| T-SYN-002 | P0 | Two | 30% |";
    assert.equal(count(table), 2);
    assert.equal(count(table + "\n## History\n| T-OLD-001 | P2 | Old | 100% |"), 2);
    assert.equal(count(table + "\n## " + title + "\n| T-LAST-001 | P1 | Last | 55% |"), 1);
  });
}
