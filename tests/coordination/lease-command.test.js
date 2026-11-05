"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function projectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lease-command-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  return root;
}

function run(root, args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, "lease", ...args, "--project", root], {
    cwd: ROOT,
    encoding: "utf8",
  }));
}

test("public lease command acquires, reports, and releases a fenced lease", () => {
  const root = projectRoot();
  try {
    const acquired = run(root, ["acquire", "--scope", "task:T-LEASE-CMD", "--owner", "claude-e2e", "--actor", "S-LEASE-CMD", "--idempotency-key", "lease-command-e2e"]);
    assert.equal(acquired.ok, true);
    assert.equal(acquired.action, "lease_acquire");
    assert.equal(acquired.lease.scope, "task:T-LEASE-CMD");

    const status = run(root, ["status", "--lease-id", acquired.lease.leaseId]);
    assert.equal(status.ok, true);
    assert.equal(status.lease.status, "active");

    const released = run(root, ["release", "--lease-id", acquired.lease.leaseId, "--actor", "S-LEASE-CMD"]);
    assert.equal(released.ok, true);
    assert.ok(released.lease.releasedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public lease command keeps tainted evidence out of its response", () => {
  const root = projectRoot();
  const secretLikeValue = "api-key";
  try {
    let output = "";
    try {
      output = execFileSync(process.execPath, [CLI, "lease", "acquire", "--scope", "task:T-LEASE-TAINT", "--owner", "claude-e2e", "--evidence", secretLikeValue, "--project", root], {
        cwd: ROOT,
        encoding: "utf8",
      });
    } catch (error) {
      output = error.stdout;
    }
    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(secretLikeValue), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public lease command exposes the scope tree option end to end", () => {
  const root = projectRoot();
  try {
    const parent = run(root, ["acquire", "--scope", "samhmi:windows", "--owner", "owner-machine", "--scope-tree"]);
    assert.equal(parent.ok, true);
    assert.equal(parent.lease.scopeTree, true);

    let output = "";
    try {
      output = execFileSync(process.execPath, [CLI, "lease", "acquire", "--scope", "samhmi:windows:instance:a", "--owner", "owner-a", "--scope-tree", "--project", root], {
        cwd: ROOT,
        encoding: "utf8",
      });
    } catch (error) {
      output = error.stdout;
    }
    const refused = JSON.parse(output);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "ERR_LEASE_CONFLICT");
    assert.equal(refused.error.reason, "scope_tree_conflict");

    // Without the option the same pair stays independent (exact-key default).
    const siblingRoot = projectRoot();
    try {
      const machine = run(siblingRoot, ["acquire", "--scope", "samhmi:windows", "--owner", "owner-machine"]);
      assert.equal(machine.ok, true);
      const instance = run(siblingRoot, ["acquire", "--scope", "samhmi:windows:instance:a", "--owner", "owner-a"]);
      assert.equal(instance.ok, true);
    } finally {
      fs.rmSync(siblingRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
