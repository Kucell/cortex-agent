"use strict";

// These fixtures need an empty runtime, not a copy of the governance tree.
// One project per test process preserves shared-directory races within a file.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
let project;

function testProject() {
  if (!project) {
    const inherited = process.env.CORTEX_PERMIT_TEST_PROJECT;
    if (inherited) {
      project = inherited;
    } else {
      project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-permit-test-")));
      // Also used by plain fixture subprocesses: importing node:test here
      // would append TAP output to their JSON protocol. Exit runs after all
      // test hooks have closed stores, children and evidence files.
      process.once("exit", () => fs.rmSync(project, { recursive: true, force: true }));
    }
    fs.mkdirSync(path.join(project, ".agent", "runtime"), { recursive: true });
  }
  return project;
}

function testRuntime(relative = "") {
  const directory = path.join(testProject(), ".agent", "runtime", relative);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  return directory;
}

// Dedicated native jobs used to supply absolute roots in the checkout's
// runtime. Preserve their relative layout inside the disposable project.
function relocatedTestRuntime(input, fallback) {
  const runtime = testRuntime();
  let directory = input || path.join(runtime, fallback);
  if (input) {
    const originalRuntime = path.resolve(__dirname, "../../.agent/runtime");
    const relative = path.relative(originalRuntime, input);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) directory = path.join(runtime, relative);
  }
  const relative = path.relative(runtime, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw Error("fixture root outside sandbox runtime");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function createRuntimeSandboxWithEnv() {
  const root = testProject();
  const keys = ["CORTEX_PERMIT_TEST_PROJECT_ROOT", "CORTEX_PERMIT_TEST_RUNTIME_ROOT", "CORTEX_PERMIT_TEST_PROJECT"];
  const previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = root;
  process.env[keys[1]] = testRuntime();
  process.env[keys[2]] = root;
  return { root, agentRoot: path.join(root, ".agent"), cleanup() {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  } };
}

module.exports = { testProject, testRuntime, relocatedTestRuntime, createRuntimeSandboxWithEnv };
