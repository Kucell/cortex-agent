"use strict";

// ─── GitHub issue #15 regression: waitpoints/inbox/decisions --help must not
//     sweep pre-existing dirty state into an automatic commit + push ────────
//
// Original report:
//   "cortex-agent waitpoints create --help reported a missing workflow gate,
//    then automatically committed and pushed previously pending project state.
//    A help or invalid-argument invocation must not have a Git side effect."
//
// Suggested coverage (from issue #15):
//   - isolated local Git fixture with pending state and a stubbed remote
//   - assert that `waitpoints create --help`, missing arguments, and rejected
//     gates do NOT invoke state-sync or change the Git index/HEAD/remote
//   - assert consistent exit codes
//   - keep the existing successful-write sync behavior under a separate positive test
//
// We satisfy these by spawning `bin/cli.js` from a fake project whose
// `.agent/` is a real inner git repo with a bare "origin" remote, then
// asserting that the post-help git index is byte-for-byte equal to the
// pre-help one AND that origin/main did not advance.
//
// Successful-write path (control) is verified in tests/cli/decisions-gate-action.test.js
// ("the same command without --dry-run still writes the decision (control)").

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function git(args, cwd, env = {}) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
      LANG: "en_US.UTF-8",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function mkInnerRepoWithOrigin() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-issue15-"));
  const agentDir = path.join(project, ".agent");
  const originDir = path.join(project, "origin.git");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(originDir);

  const o = git(["init", "--bare", "-q", "--initial-branch=main"], originDir);
  if (o.status !== 0) throw new Error("bare init failed: " + o.stderr);

  let r = git(["init", "-q", "-b", "main"], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);
  r = git(["config", "user.email", "t@x"], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);
  r = git(["config", "user.name", "T"], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);
  r = git(["remote", "add", "origin", originDir], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);
  fs.writeFileSync(path.join(agentDir, "README.md"), "init\n");
  r = git(["add", "README.md"], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);
  r = git(["commit", "-q", "-m", "init"], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);
  r = git(["push", "-q", "origin", "main"], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);

  // Seed state-class directories so a regression would have files to sweep.
  for (const dir of ["decisions", "waitpoints", "inbox"]) {
    fs.mkdirSync(path.join(agentDir, dir), { recursive: true });
  }

  return { project, agentDir, originDir };
}

function seedDirtyState(agentDir, files) {
  // files: array of relative paths under agentDir (e.g. "decisions/D-old.json")
  // Each is written and left untracked / unstaged so state-sync would sweep them.
  for (const rel of files) {
    const abs = path.join(agentDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "{\n  \"id\": \"" + path.basename(rel, ".json") + "\"\n}\n");
  }
}

function readPorcelain(agentDir) {
  const r = git(["status", "--porcelain", "--untracked-files=all"], agentDir);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function headSha(agentDir) {
  const r = git(["rev-parse", "HEAD"], agentDir);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function originHeadSha(originDir) {
  const r = git(["rev-parse", "main"], originDir);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function originTree(originDir) {
  const r = git(["ls-tree", "-r", "--name-only", "main"], originDir);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function runCli(project, args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args, "--project", project], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      LANG: "en_US.UTF-8",
      ...extraEnv,
      // Do NOT set CORTEX_STATE_SYNC=off by default — the regression we test
      // is that state-sync auto must be safe on both non-mutation and success.
    },
  });
}

const PRE_EXISTING = [
  "decisions/D-old.json",
  "waitpoints/WP-old.json",
  "inbox/I-old.json",
];

test("issue #15: waitpoints create --help does not touch Git index / HEAD / remote", (t) => {
  const { project, agentDir, originDir } = mkInnerRepoWithOrigin();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  seedDirtyState(agentDir, PRE_EXISTING);
  const beforeIndex = readPorcelain(agentDir);
  const beforeHead = headSha(agentDir);
  const beforeOrigin = originHeadSha(originDir);
  assert.ok(beforeIndex.length > 0, "fixture must have pre-existing dirty state");

  const result = runCli(project, ["waitpoints", "create", "--help"]);
  assert.equal(result.status, 0, "stderr: " + result.stderr + "\nstdout: " + result.stdout);
  assert.match(result.stdout, /Usage: cortex-agent waitpoints create/);
  assert.match(result.stdout, /--gate <workflow>/);

  // The pre-existing dirty files must still be dirty — no commit swept them.
  const afterIndex = readPorcelain(agentDir);
  assert.equal(afterIndex, beforeIndex, "Git index must be byte-for-byte unchanged");
  assert.equal(headSha(agentDir), beforeHead, "HEAD must not advance");
  assert.equal(originHeadSha(originDir), beforeOrigin, "remote must not advance");
});

test("issue #15: inbox send --help does not touch Git index / HEAD / remote", (t) => {
  const { project, agentDir, originDir } = mkInnerRepoWithOrigin();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  seedDirtyState(agentDir, PRE_EXISTING);
  const beforeIndex = readPorcelain(agentDir);
  const beforeHead = headSha(agentDir);
  const beforeOrigin = originHeadSha(originDir);

  const result = runCli(project, ["inbox", "send", "--help"]);
  assert.equal(result.status, 0, "stderr: " + result.stderr + "\nstdout: " + result.stdout);
  assert.match(result.stdout, /Usage: cortex-agent inbox send/);

  const afterIndex = readPorcelain(agentDir);
  assert.equal(afterIndex, beforeIndex, "Git index must be byte-for-byte unchanged");
  assert.equal(headSha(agentDir), beforeHead, "HEAD must not advance");
  assert.equal(originHeadSha(originDir), beforeOrigin, "remote must not advance");
});

test("issue #15: decisions request --help does not touch Git index / HEAD / remote", (t) => {
  const { project, agentDir, originDir } = mkInnerRepoWithOrigin();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  seedDirtyState(agentDir, PRE_EXISTING);
  const beforeIndex = readPorcelain(agentDir);
  const beforeHead = headSha(agentDir);
  const beforeOrigin = originHeadSha(originDir);

  const result = runCli(project, ["decisions", "request", "--help"]);
  assert.equal(result.status, 0, "stderr: " + result.stderr + "\nstdout: " + result.stdout);
  assert.match(result.stdout, /--gate-action/);

  const afterIndex = readPorcelain(agentDir);
  assert.equal(afterIndex, beforeIndex, "Git index must be byte-for-byte unchanged");
  assert.equal(headSha(agentDir), beforeHead, "HEAD must not advance");
  assert.equal(originHeadSha(originDir), beforeOrigin, "remote must not advance");
});

test("issue #15: waitpoints missing-arg error path does not touch Git index / HEAD / remote", (t) => {
  // This is the exact scenario the issue reported: a missing-argument probe
  // (here, no action) used to sweep pre-existing state. Now it must not.
  const { project, agentDir, originDir } = mkInnerRepoWithOrigin();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  // Seed management-api scripts so the real Management API is exercised.
  seedManagementScripts(project);

  seedDirtyState(agentDir, PRE_EXISTING);
  const beforeIndex = readPorcelain(agentDir);
  const beforeHead = headSha(agentDir);
  const beforeOrigin = originHeadSha(originDir);

  const result = runCli(project, ["waitpoints"]);
  assert.notEqual(result.status, 0, "missing action must exit nonzero");
  assert.match(result.stderr, /Usage: cortex-agent waitpoints/);

  const afterIndex = readPorcelain(agentDir);
  assert.equal(afterIndex, beforeIndex, "Git index must be byte-for-byte unchanged");
  assert.equal(headSha(agentDir), beforeHead, "HEAD must not advance");
  assert.equal(originHeadSha(originDir), beforeOrigin, "remote must not advance");
});

test("issue #15: invalid gate value fails closed (exit != 0) and does not push state", (t) => {
  // The original report cited WORKFLOW_GATE_REQUIRED for an invalid gate.
  // Verify the failure path leaves Git untouched.
  const { project, agentDir, originDir } = mkInnerRepoWithOrigin();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  seedManagementScripts(project);

  seedDirtyState(agentDir, PRE_EXISTING);
  const beforeIndex = readPorcelain(agentDir);
  const beforeHead = headSha(agentDir);
  const beforeOrigin = originHeadSha(originDir);

  const result = runCli(project, [
    "waitpoints",
    "create",
    "--waitpoint-id", "WP-rejected",
    "--gate", "hacker",  // invalid gate value
    "--owner-workflow", "test",
    "--reason", "regression",
    "--action", "release",
    "--resource-ref", "branch:main",
    "--decision-id", "D-test",
  ]);
  assert.notEqual(result.status, 0, "invalid gate must fail closed");
  assert.match(
    result.stdout + result.stderr,
    /WORKFLOW_GATE_REQUIRED|INVALID.*GATE/,
  );

  const afterIndex = readPorcelain(agentDir);
  assert.equal(afterIndex, beforeIndex, "Git index must be byte-for-byte unchanged");
  assert.equal(headSha(agentDir), beforeHead, "HEAD must not advance");
  assert.equal(originHeadSha(originDir), beforeOrigin, "remote must not advance");
});

test("issue #15: successful waitpoints write DOES push state (positive control)", (t) => {
  // The companion positive test: a successful management mutation must still
  // commit + push the new state file. This guards against an over-correction
  // that disables fireAndForgetSync entirely.
  const { project, agentDir, originDir } = mkInnerRepoWithOrigin();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  seedManagementScripts(project);

  // Leave unrelated dirty state in the same state classes. A successful
  // mutation must sync only its own changed_paths, not sweep these files.
  seedDirtyState(agentDir, PRE_EXISTING);
  const beforeDirty = readPorcelain(agentDir);
  const beforeHead = headSha(agentDir);
  const beforeOrigin = originHeadSha(originDir);

  const result = runCli(project, [
    "waitpoints",
    "create",
    "--waitpoint-id", "WP-OK",
    "--gate", "mission",
    "--owner-workflow", "test",
    "--reason", "regression control",
    "--action", "release",
    "--resource-ref", "branch:main",
    "--decision-id", "D-test",
  ]);
  assert.equal(result.status, 0, "stderr: " + result.stderr + "\nstdout: " + result.stdout);
  // The CLI prints the JSON payload followed by an optional `🔄 state-sync: ...`
  // status line emitted by fireAndForgetSync. Trim to the JSON object boundary.
  const jsonText = result.stdout.slice(0, result.stdout.indexOf("\n}") + 2);
  const body = JSON.parse(jsonText);
  assert.equal(body.ok, true);

  const afterHead = headSha(agentDir);
  const afterOrigin = originHeadSha(originDir);
  assert.notEqual(afterHead, beforeHead, "successful write must commit");
  assert.notEqual(afterOrigin, beforeOrigin, "successful write must push");

  const afterDirty = readPorcelain(agentDir);
  for (const rel of PRE_EXISTING) {
    assert.ok(afterDirty.includes(rel), rel + " must remain dirty locally");
  }
  assert.notEqual(afterDirty, "", "unrelated dirty state must remain after exact-path sync");

  const remoteFiles = originTree(originDir);
  assert.ok(remoteFiles.includes("waitpoints/WP-OK.json"), "mutation-owned waitpoint must reach remote");
  assert.ok(remoteFiles.includes("waitpoints/index.json"), "mutation-owned index must reach remote");
  for (const rel of PRE_EXISTING) {
    assert.equal(remoteFiles.includes(rel), false, rel + " must not be swept into remote commit");
  }
  assert.ok(beforeDirty.length > 0, "fixture must start with unrelated dirty state");
});

test("decision resolve reports every auto-released waitpoint path", (t) => {
  const { project } = mkInnerRepoWithOrigin();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  seedManagementScripts(project);
  const env = { CORTEX_STATE_SYNC: "off" };

  let result = runCli(project, [
    "decisions", "request",
    "--decision-id", "D-MULTI",
    "--gate", "mission",
    "--gate-action", "architecture",
    "--type", "approval",
    "--requested-by", "test",
    "--prompt", "approve?",
    "--resource-ref", "resource:test",
    "--options", '["approve","reject"]',
  ], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  result = runCli(project, [
    "waitpoints", "create",
    "--waitpoint-id", "WP-MULTI",
    "--gate", "mission",
    "--owner-workflow", "/mission",
    "--reason", "wait",
    "--action", "architecture",
    "--resource-ref", "resource:test",
    "--decision-id", "D-MULTI",
  ], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  result = runCli(project, [
    "decisions", "resolve",
    "--decision-id", "D-MULTI",
    "--gate", "user",
    "--status", "approved",
    "--selected-option", "approve",
    "--resolved-by", "test-user",
    "--rationale", "approved",
  ], env);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const body = JSON.parse(result.stdout);
  const paths = new Set(body.changed_paths || []);
  for (const expected of [
    ".agent/decisions/D-MULTI.json",
    ".agent/decisions/index.json",
    ".agent/waitpoints/WP-MULTI.json",
    ".agent/waitpoints/index.json",
  ]) {
    assert.ok(paths.has(expected), "missing changed path " + expected);
  }
  assert.deepEqual(
    new Set(body.changed_resources || []),
    new Set(["decision:D-MULTI", "waitpoint:WP-MULTI"]),
  );
});

// helpers ─────────────────────────────────────────────────────────────────────

function seedManagementScripts(project) {
  // Copy the real management-api scripts so the Management API is functional.
  // Without these, every mutation fails with "management-api skill missing",
  // which would also satisfy the regression test (no push) but wouldn't prove
  // the positive control worked. The same seed pattern is used by
  // tests/management/management-writer-cli.test.js to keep both suites
  // exercising the same end-to-end write path.
  const scriptsDir = path.join(project, ".agent", "skills", "management-api", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const file of ["index.js", "normalize-token-usage.js", "projection-registry.json", "query-activity.js", "query-dispatch-state.js"]) {
    fs.copyFileSync(
      path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", file),
      path.join(scriptsDir, file),
    );
  }
  const taskScripts = path.join(project, ".agent", "tasks", "scripts");
  fs.mkdirSync(taskScripts, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "tasks", "scripts", "task-state.js"),
    path.join(taskScripts, "task-state.js"),
  );
  for (const dir of ["runs", "queues", "sessions", "decisions", "inbox", "waitpoints"]) {
    fs.mkdirSync(path.join(project, ".agent", dir), { recursive: true });
  }
}