"use strict";

// ─── `cortex-agent upgrade --help` must not touch the project ────────────────
//
// `upgrade` copies the L1 templates into the project's `.agent/`. Asking for
// usage must not install anything: without the guard, `upgrade --help`
// silently rewrote the project (it added the template files and wrote an
// update receipt).
//
// Same contract as the issue #15 regression
// (tests/cli/issue-15-waitpoints-help-state-sync.test.js): a help invocation
// is a read.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

test("upgrade --help prints usage and writes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-upgrade-help-"));
  try {
    fs.mkdirSync(path.join(root, ".agent", "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "plans", "task-progress.md"), "# tasks\n", "utf8");
    const before = snapshot(root);

    const out = spawnSync(process.execPath, [CLI, "upgrade", "--help", "--project", root], {
      encoding: "utf8",
    });

    assert.match(out.stdout + out.stderr, /Usage: cortex-agent/);
    assert.deepEqual(snapshot(root), before, "upgrade --help must not write into the project");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade -h prints usage and writes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-upgrade-help-"));
  try {
    fs.mkdirSync(path.join(root, ".agent", "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "plans", "task-progress.md"), "# tasks\n", "utf8");
    const before = snapshot(root);

    const out = spawnSync(process.execPath, [CLI, "upgrade", "-h", "--project", root], {
      encoding: "utf8",
    });

    assert.match(out.stdout + out.stderr, /Usage: cortex-agent/);
    assert.deepEqual(snapshot(root), before, "upgrade -h must not write into the project");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
