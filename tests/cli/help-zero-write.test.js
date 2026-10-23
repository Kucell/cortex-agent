"use strict";

// ─── `cortex-agent init|track|untrack --help` must not touch the project ─────
//
// `init` scaffolds `.agent/`, the root entry files and the cross-tool anchor;
// `track` / `untrack` rewrite the Git tracking configuration and the local
// exclude list. Asking for usage must not do any of that.
//
// Measured on the unfixed CLI: `init --help` created 124 files and
// `track --help` created 154 files inside the working directory.
//
// Same contract as the issue #15 regression
// (tests/cli/issue-15-waitpoints-help-state-sync.test.js) and as
// `upgrade --help` (tests/cli/upgrade-help-zero-write.test.js): a help
// invocation is a read.

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

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-help-zero-write-"));
  // A git repo so `track` / `untrack` have something to configure; the
  // assertions are about the working tree, not about git state.
  spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  return root;
}

for (const command of ["init", "track", "untrack"]) {
  for (const flag of ["--help", "-h"]) {
    test(`${command} ${flag} prints usage and writes nothing`, () => {
      const root = project();
      try {
        const before = snapshot(root);

        const out = spawnSync(process.execPath, [CLI, command, flag], {
          cwd: root,
          encoding: "utf8",
        });

        assert.match(out.stdout + out.stderr, /Usage: cortex-agent/);
        assert.deepEqual(
          snapshot(root),
          before,
          `${command} ${flag} must not write into the project`,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("the zero-write guard covers every command that scaffolds or reconfigures", () => {
  const source = fs.readFileSync(CLI, "utf8");
  const match = source.match(
    /const ZERO_WRITE_HELP_COMMANDS = new Set\(\[(.*?)\]\)/s,
  );
  assert.ok(match, "the CLI must declare a zero-write help guard set");

  const commands = match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  assert.deepEqual(commands.sort(), ["init", "track", "untrack"]);
  // `upgrade` and `update` keep their own guards inside the switch; they must
  // not be duplicated into the shared set.
  assert.ok(!commands.includes("upgrade"));
  assert.ok(!commands.includes("update"));
});
