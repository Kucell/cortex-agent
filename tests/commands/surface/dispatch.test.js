"use strict";

// ─── lib/commands/surface/dispatch.js unit tests ──────────────────────────────
//
// Coverage:
//   - dispatchDryRunUsage returns a non-empty string
//   - dispatchDryRun(ctx) with no subcommand → exitCode 2 + usage
//   - dispatchDryRun(ctx) with --help → no exitCode change, prints usage
//   - dispatchDryRun(ctx) with unknown sub → exitCode 2
//   - dispatchDryRunHandler: missing <task-id> → exitCode 2
//   - dispatchExecuteUsage returns a non-empty string
//   - dispatchExecute(ctx) with --help → no exitCode change
//   - dispatchExecute(ctx) with execute subcommand
//   - dispatchExecute(ctx) with missing required flags → exitCode 2

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dispatchDryRunUsage,
  dispatchDryRun,
  dispatchDryRunHandler,
  dispatchExecuteUsage,
  dispatchExecute,
  dispatchExecuteHandler,
} = require("../../../lib/commands/surface/dispatch");

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

function makeCtx(args) {
  return {
    args,
    options: {},
    cwd: process.cwd(),
    lang: "en",
    command: "dispatch",
  };
}

test("dispatchDryRunUsage returns a non-empty usage string", () => {
  const out = dispatchDryRunUsage({ args: [], options: {}, cwd: process.cwd(), lang: "en" });
  assert.equal(typeof out, "string");
  assert.match(out, /cortex-agent dispatch dry-run/);
});

test("dispatchDryRun: --help → no exitCode change", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchDryRun(makeCtx(["dispatch", "--help"]));
    assert.equal(process.exitCode, origExit);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchDryRun: no subcommand (no args[1]) → exitCode 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchDryRun(makeCtx(["dispatch"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchDryRun: unknown subcommand → exitCode 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchDryRun(makeCtx(["dispatch", "bogus"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchDryRunHandler: missing <task-id> → exitCode 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchDryRunHandler(makeCtx([]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchDryRunHandler: task-id starts with -- → exitCode 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchDryRunHandler(makeCtx(["--something"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchExecuteUsage returns a non-empty usage string", () => {
  const out = dispatchExecuteUsage({ args: [], options: {}, cwd: process.cwd(), lang: "en" });
  assert.equal(typeof out, "string");
  assert.match(out, /cortex-agent dispatch <task-id>/);
});

test("dispatchExecute: --help → no exitCode change", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchExecute(makeCtx(["dispatch", "--help"]));
    assert.equal(process.exitCode, origExit);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchExecuteHandler: missing <task-id> → exitCode 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchExecuteHandler(makeCtx([]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchExecuteHandler: task-id present but missing required flags → exitCode 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchExecuteHandler(makeCtx(["task-1"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("dispatchExecute: missing subcommand → exitCode 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    dispatchExecute(makeCtx(["dispatch"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});
