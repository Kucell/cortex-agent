"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const runner = path.resolve(__dirname, "../../scripts/test-runner.cjs");

for (const mutation of ["none", "create", "rewrite"]) {
  test(`strict hermetic runner: ${mutation} non-curated governance file`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "strict-hermetic-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const dir of ["scripts", "tests", ".agent/probe"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(runner, path.join(root, "scripts/test-runner.cjs"));
    const target = path.join(root, ".agent/probe/non-curated.txt");
    if (mutation === "rewrite") fs.writeFileSync(target, "before");
    fs.writeFileSync(path.join(root, "tests/probe.test.js"),
      `require('node:test')('passing test', () => { ${mutation === "none" ? "" : `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'after')`} });`);
    const env = { ...process.env };
    // A fresh runner process must not inherit the parent node:test IPC context.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["scripts/test-runner.cjs", "--strict-hermetic", "--file", "probe.test.js", "--max-time", "20"],
      { cwd: root, env, encoding: "utf8", timeout: 25000 });
    assert.ifError(result.error);
    assert.match(result.stdout, /1\/1 passed/, result.stderr);
    assert.equal(result.status, mutation === "none" ? 0 : 1, result.stdout + result.stderr);
    if (mutation !== "none") {
      assert.match(result.stderr, /Strict mode treats every drift as a defect/);
      assert.match(result.stdout, /non-curated\.txt/);
      assert.equal(fs.readFileSync(target, "utf8"), "after");
    }
  });
}
