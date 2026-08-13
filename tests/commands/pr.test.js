"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parsePrArgs, prCommand } = require("../../lib/commands/pr");

function run(args, dependencies = {}) {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    return prCommand({ args: ["pr", ...args], cwd: "/tmp/project" }, dependencies);
  } finally {
    process.exitCode = originalExitCode;
  }
}

test("parsePrArgs maps the positional PR number and preserves runtime options", () => {
  assert.deepEqual(
    parsePrArgs(["pr", "merge", "12", "--commit-message", "ship", "--gate", "user"]),
    {
      subcommand: "merge",
      prNumber: "12",
      gate: "user",
      forwarded: ["--commit-message", "ship", "--gate", "user"],
    }
  );
});

test("pr merge fails closed without --gate user and never starts runtime", () => {
  let started = false;
  const code = run(["merge", "12"], {
    script: "/runtime/index.js",
    spawnSync() { started = true; return { status: 0 }; },
  });
  assert.equal(code, 2);
  assert.equal(started, false);
});

test("pr merge rejects a non-numeric PR number before runtime lookup", () => {
  const code = run(["merge", "main", "--gate", "user"], {
    existsSync() { throw new Error("must not resolve runtime"); },
  });
  assert.equal(code, 1);
});

test("pr merge delegates to vcs-pr with explicit gate and returns its status", () => {
  let invocation = null;
  const code = run(
    ["merge", "12", "--commit-message", "ship", "--gate", "user"],
    {
      script: "/runtime/index.js",
      spawnSync(command, args, options) {
        invocation = { command, args, options };
        return { status: 7 };
      },
    }
  );

  assert.equal(code, 7);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    "/runtime/index.js",
    "merge",
    "--pr-number",
    "12",
    "--commit-message",
    "ship",
    "--gate",
    "user",
  ]);
  assert.deepEqual(invocation.options, { cwd: "/tmp/project", stdio: "inherit" });
});

test("pr merge reports unavailable runtime as system failure", () => {
  const code = run(["merge", "12", "--gate", "user"], { existsSync: () => false });
  assert.equal(code, 3);
});

test("pr merge maps process launch errors to system failure", () => {
  const code = run(["merge", "12", "--gate", "user"], {
    script: "/runtime/index.js",
    spawnSync: () => ({ error: new Error("boom") }),
  });
  assert.equal(code, 3);
});
