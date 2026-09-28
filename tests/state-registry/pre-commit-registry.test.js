"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(ROOT, "templates", "_shared", ".agent", ".githooks", "pre-commit");
const REGISTRY = path.join(ROOT, "templates", "_shared", ".agent", "contracts", "state-classes.json");

function git(args, cwd) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("pre-commit hook reads state registry and only reminds for syncable classes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-state-hook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, ".agent");
  fs.mkdirSync(path.join(agentDir, "contracts"), { recursive: true });
  fs.copyFileSync(REGISTRY, path.join(agentDir, "contracts", "state-classes.json"));

  let r = git(["init", "-q", "-b", "main"], agentDir);
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(path.join(agentDir, "README.md"), "init\n");
  r = git(["add", "README.md"], agentDir);
  assert.equal(r.status, 0, r.stderr);
  r = git(["commit", "-q", "-m", "init"], agentDir);
  assert.equal(r.status, 0, r.stderr);

  fs.mkdirSync(path.join(agentDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "decisions", "D-1.json"), "{}\n");
  fs.mkdirSync(path.join(agentDir, "runtime", "hosts", "machine"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "runtime", "hosts", "machine", "state.json"), "{}\n");

  const run = spawnSync("bash", [HOOK], {
    cwd: agentDir,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /decisions\/D-1\.json/);
  assert.doesNotMatch(run.stdout, /runtime\/hosts\/machine\/state\.json/);
});
