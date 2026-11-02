"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { testProject, testRuntime, relocatedTestRuntime } = require("./runtime-sandbox");
const helper = require.resolve("./runtime-sandbox");

function child(env) {
  const result = spawnSync(process.execPath, ["-e", `
    const { testProject, testRuntime } = require(${JSON.stringify(helper)});
    require('node:fs').writeFileSync(require('node:path').join(testRuntime(), 'child-marker'), 'shared');
    process.stdout.write(JSON.stringify({ project: testProject(), runtime: testRuntime() }));
  `], { env, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("fixture subprocess shares the parent project and cannot clean it on exit", () => {
  const project = testProject();
  const result = child({ ...process.env, CORTEX_PERMIT_TEST_PROJECT: project });
  assert.equal(result.project, project);
  assert.equal(result.runtime, path.join(project, ".agent", "runtime"));
  assert.equal(fs.readFileSync(path.join(testRuntime(), "child-marker"), "utf8"), "shared");
  assert.equal(fs.realpathSync(project), project);
});

test("standalone fixture emits only JSON and removes its own project on exit", () => {
  const env = { ...process.env };
  delete env.CORTEX_PERMIT_TEST_PROJECT;
  const result = child(env);
  assert.notEqual(result.project, testProject());
  assert.equal(fs.existsSync(result.project), false);
});

test("native job roots relocate into the supplied project without accepting outside paths", () => {
  const original = path.resolve(__dirname, "../../.agent/runtime/native-job/journal");
  const directory = relocatedTestRuntime(original, "unused");
  assert.equal(directory, path.join(testRuntime(), "native-job", "journal"));
  assert.equal(fs.realpathSync(directory), directory);
  assert.equal(relocatedTestRuntime(undefined, "native-default"), path.join(testRuntime(), "native-default"));
  assert.throws(() => relocatedTestRuntime(path.dirname(testProject()), "unused"));
});
