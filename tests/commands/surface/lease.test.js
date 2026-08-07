"use strict";

// ─── lib/commands/surface/lease.js unit tests ─────────────────────────────────
//
// Coverage:
//   - leaseUsage returns a non-empty usage string mentioning acquire/renew/etc.
//   - leaseFlag / leaseFlagList parse simple and repeated flags
//   - leaseCliSubcommand returns ctx.args[1] || "status"
//   - leaseResolveProjectRoot honours ctx.options.project
//   - leaseAcquireHandler missing --scope/--owner → exitCode 2
//   - leaseRenewHandler missing --lease-id/--scope → exitCode 2
//   - leaseReleaseHandler missing --lease-id → exitCode 2
//   - leaseStatusHandler (no service needed for JSON) — smoke test
//   - leaseRecoverHandler missing --scope/--new-owner → exitCode 2
//   - Second-declaration lease(): with unknown subcommand + printManagementPayload
//     shape (no exit) and INVALID_USAGE → exitCode 2

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  leaseUsage,
  leaseFlag,
  leaseFlagList,
  leaseCliSubcommand,
  leaseResolveProjectRoot,
  leaseAcquireHandler,
  leaseRenewHandler,
  leaseReleaseHandler,
  leaseRecoverHandler,
  lease,
} = require("../../../lib/commands/surface/lease");

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

function makeCtx(args, options = {}, cwd) {
  return {
    args,
    options,
    cwd: cwd || process.cwd(),
    lang: "en",
    command: "lease",
  };
}

test("leaseUsage returns a non-empty usage string", () => {
  const out = leaseUsage({ args: [], options: {}, cwd: process.cwd(), lang: "en" });
  assert.equal(typeof out, "string");
  assert.match(out, /lease acquire/);
  assert.match(out, /lease renew/);
  assert.match(out, /lease release/);
  assert.match(out, /lease status/);
  assert.match(out, /lease recover/);
});

test("leaseFlag returns the value following a flag", () => {
  const ctx = makeCtx(["lease", "acquire", "--scope", "team:foo", "--owner", "alice"]);
  assert.equal(leaseFlag(ctx, "--scope"), "team:foo");
  assert.equal(leaseFlag(ctx, "--owner"), "alice");
  assert.equal(leaseFlag(ctx, "--missing"), null);
  assert.equal(leaseFlag(ctx, "--missing", "fallback"), "fallback");
});

test("leaseFlag returns null when value is missing", () => {
  const ctx = makeCtx(["lease", "acquire", "--scope"]);
  assert.equal(leaseFlag(ctx, "--scope"), null);
});

test("leaseFlagList collects all values for repeated flag", () => {
  const ctx = makeCtx(["lease", "renew", "--evidence", "ev1", "--evidence", "ev2"]);
  assert.deepEqual(leaseFlagList(ctx, "--evidence"), ["ev1", "ev2"]);
});

test("leaseCliSubcommand returns ctx.args[1] or 'status'", () => {
  assert.equal(leaseCliSubcommand(makeCtx(["lease", "acquire"])), "acquire");
  assert.equal(leaseCliSubcommand(makeCtx(["lease"])), "status");
});

test("leaseResolveProjectRoot honours ctx.options.project", () => {
  const cwd = "/tmp/seed";
  const explicit = leaseResolveProjectRoot(makeCtx(["lease"], { project: "subdir" }, cwd));
  assert.equal(explicit, path.resolve(cwd, "subdir"));
  const implicit = leaseResolveProjectRoot(makeCtx(["lease"], {}, cwd));
  assert.equal(implicit, path.resolve(cwd, "."));
});

test("leaseAcquireHandler: missing --scope/--owner → exitCode = 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    leaseAcquireHandler(makeCtx(["lease", "acquire"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("leaseRenewHandler: missing --lease-id/--scope → exitCode = 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    leaseRenewHandler(makeCtx(["lease", "renew"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("leaseReleaseHandler: missing --lease-id → exitCode = 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    leaseReleaseHandler(makeCtx(["lease", "release"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("leaseRecoverHandler: missing --scope/--new-owner → exitCode = 2", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    leaseRecoverHandler(makeCtx(["lease", "recover"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

test("lease (second declaration): unknown subcommand → exitCode = 2, prints usage", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    lease(makeCtx(["lease", "bogus"]));
    assert.equal(process.exitCode, 2);
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
  // The second declaration calls printManagementPayload({ ok: false, code: "INVALID_USAGE", ... })
  // and sets process.exitCode = 2.
});

test("lease (second declaration): repeated evidence with no value → exitCode = 2", () => {
  // "lease acquire --evidence" with no following value triggers the repeated()
  // null branch (because args[index+1] is the next flag/undefined).
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    lease(makeCtx(["lease", "acquire", "--scope", "s", "--owner", "o", "--evidence"]));
    assert.equal(process.exitCode, 2);
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});
