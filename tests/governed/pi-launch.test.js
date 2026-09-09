"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { executeGovernedPiLaunch } = require("../../lib/governed/pi-launch");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pi-launch-"));
  const pi = path.join(root, "pi");
  const task = path.join(root, "task.md");
  fs.writeFileSync(pi, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(task, "private task body\n");
  return { root, pi, task };
}

function args(ctx) {
  return ["--task-id", "T-PI-001", "--agent-id", "pi-1", "--session-id", "session-pi-1", "--lease-id", "LEASE-1", "--fencing-token", "1", "--worktree", ctx.root, "--task-file", "task.md"];
}

test("Pi launch compiles fixed private argv and delegates to governed launch", async () => {
  const ctx = fixture();
  const previousPath = process.env.PATH;
  process.env.PATH = `${ctx.root}${path.delimiter}${previousPath || ""}`;
  try {
    let captured;
    const result = await executeGovernedPiLaunch(args(ctx), {
      projectRoot: ctx.root,
      executeLaunch: async (launchArgs) => { captured = launchArgs; return { ok: true, spawnStatus: "accepted" }; },
    });
    assert.equal(result.ok, true);
    assert.ok(captured.includes("--command"));
    assert.equal(captured[captured.indexOf("--command") + 1], ctx.pi);
    assert.equal(captured.filter((value) => value === "--agent-arg").length, 7);
    assert.ok(captured.includes("--mode"));
    assert.ok(captured.includes("json"));
    assert.ok(captured.includes("--print"));
    assert.ok(captured.includes(`@${ctx.task}`));
    assert.equal(JSON.stringify(result).includes("private task body"), false);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("Pi launch rejects generic escape flags and task files outside the worktree", async () => {
  const ctx = fixture();
  const outside = path.join(os.tmpdir(), "cortex-pi-launch-outside.md");
  fs.writeFileSync(outside, "outside\n");
  const previousPath = process.env.PATH;
  process.env.PATH = `${ctx.root}${path.delimiter}${previousPath || ""}`;
  try {
    const escaped = await executeGovernedPiLaunch([...args(ctx), "--command", "/bin/sh"], { projectRoot: ctx.root });
    assert.equal(escaped.code, "ERR_PI_ARGUMENT_FORBIDDEN");
    const override = await executeGovernedPiLaunch([...args(ctx), "--pi-command", ctx.pi], { projectRoot: ctx.root });
    assert.equal(override.code, "ERR_PI_ARGUMENT_FORBIDDEN");
    const pathEscape = await executeGovernedPiLaunch([...args(ctx).slice(0, -2), "--task-file", outside], { projectRoot: ctx.root });
    assert.equal(pathEscape.code, "ERR_PI_TASK_FILE");
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(ctx.root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
