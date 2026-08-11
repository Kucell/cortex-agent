"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function digestTree(root) {
  const hash = crypto.createHash("sha256");
  // runtime-evidence/ is a runtime cache (state.json files written by
  // the Management API on every query). Excluding it from the digest
  // lets the test verify "queries do not mutate business state" —
  // the original invariant — without false-failing on cache writes
  // that are by design.
  const skipDirs = new Set(["runtime-evidence"]);
  const visit = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (skipDirs.has(name)) continue;
      const file = path.join(dir, name);
      const relative = path.relative(root, file);
      const stat = fs.lstatSync(file);
      hash.update(relative);
      if (stat.isDirectory()) visit(file);
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else hash.update(fs.readFileSync(file));
    }
  };
  visit(root);
  return hash.digest("hex");
}

test("focused, aggregate, and activity queries do not mutate managed state", () => {
  // Use a tmpdir project root so the test is parallel-run safe.
  // Querying against the real cortex-agent project root works in
  // isolation, but fails under the npm test parallel runner because
  // sibling tests concurrently write to .agent/runtime-evidence/
  // and other directories. Spinning up a minimal project in a tmpdir
  // copies the Management API scripts + tasks + metrics surface that
  // each projection needs, and gives the test its own isolated tree
  // to digest.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-query-readonly-"));
  const agentRoot = path.join(scratch, ".agent");
  fs.mkdirSync(path.join(agentRoot, "skills/management-api/scripts"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "tasks/scripts"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "metrics"), { recursive: true });
  fs.cpSync(
    path.join(ROOT, "templates/_shared/.agent/skills/management-api/scripts"),
    path.join(agentRoot, "skills/management-api/scripts"),
    { recursive: true },
  );
  fs.cpSync(
    path.join(ROOT, "templates/_shared/.agent/tasks/scripts/task-state.js"),
    path.join(agentRoot, "tasks/scripts/task-state.js"),
  );
  try {
    const before = digestTree(agentRoot);
    for (const args of [
      ["query", "runs", "--project", scratch],
      ["query", "dashboard-state", "--project", scratch],
      ["query", "activity", "--project", scratch, "--since", "2026-07-01", "--until", "2026-07-31"],
    ]) {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch, encoding: "utf8", env: { ...process.env, LANG: "en_US.UTF-8" } });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(digestTree(agentRoot), before);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
