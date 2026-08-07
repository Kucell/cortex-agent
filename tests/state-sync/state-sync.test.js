"use strict";

// ─── state-sync tests (T-FOLLOW-002 v2) ───────────────────────────────────────
//
// Coverage: lib/state-sync.js
// - parsePorcelain: porcelain status line → { staged, unstaged, untracked }
// - isStatePath: 9 state classes correctly classified
// - suggestCommitMessage: deterministic conventional-commit output
// - scanState: detects dirty / staged changes in inner-`.agent/` repo
// - addState: actually stages the 9 state classes
// - commitState: actually commits and returns a SHA
// - end-to-end: --dry-run → --add → --commit flow on a temp git repo

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const {
  parsePorcelain,
  isStatePath,
  suggestCommitMessage,
  scanState,
  addState,
  commitState,
  STATE_DIRS,
  STATE_FILES,
} = require("../../lib/state-sync");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkAgentRepo() {
  // Layout: <tmp>/.agent/  (the inner repo root)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-state-sync-"));
  const agentDir = path.join(root, ".agent");
  fs.mkdirSync(agentDir);
  // git init + first commit so the repo is in a "clean working tree" baseline.
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@x",
                GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@x" };
  const run = (args) => spawnSync("git", ["-C", agentDir, ...args],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const ok = (res, label) => {
    if (res.status !== 0) {
      throw new Error(`${label} failed: ${res.stderr || res.stdout}`);
    }
    return res;
  };
  ok(run(["init", "-q", "-b", "main"]), "git init");
  ok(run(["config", "user.email", "t@x"]), "git config user.email");
  ok(run(["config", "user.name", "Test"]), "git config user.name");
  // Seed an initial commit so HEAD exists (required for diff / status).
  fs.writeFileSync(path.join(agentDir, "README.md"), "init\n");
  ok(run(["add", "README.md"]), "git add README");
  ok(run(["commit", "-q", "-m", "init"]), "git commit init");
  return { root, agentDir };
}

function touchStateFile(agentDir, relPath, content = "x") {
  const abs = path.join(agentDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// ─── Pure unit tests (no git required) ───────────────────────────────────────

test("parsePorcelain: unstaged modification", () => {
  const entries = parsePorcelain(" M decisions/D-001.json\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "decisions/D-001.json");
  assert.equal(entries[0].staged, false);
  assert.equal(entries[0].unstaged, true);
  assert.equal(entries[0].untracked, false);
});

test("parsePorcelain: staged addition", () => {
  const entries = parsePorcelain("A  tasks/T-001.json\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "tasks/T-001.json");
  assert.equal(entries[0].staged, true);
  assert.equal(entries[0].unstaged, false);
});

test("parsePorcelain: untracked file", () => {
  const entries = parsePorcelain("?? plans/proposals/foo.md\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "plans/proposals/foo.md");
  assert.equal(entries[0].untracked, true);
});

test("parsePorcelain: rename picks the destination", () => {
  const entries = parsePorcelain("R  old.json -> new.json\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "new.json");
  assert.equal(entries[0].staged, true);
});

test("isStatePath: 9 state classes return true", () => {
  assert.equal(isStatePath("decisions"), true);
  assert.equal(isStatePath("decisions/D-001.json"), true);
  assert.equal(isStatePath("waitpoints/WP-x.json"), true);
  assert.equal(isStatePath("tasks/T-001.json"), true);
  assert.equal(isStatePath("missions/M-007/gate.md"), true);
  assert.equal(isStatePath("plans/proposals/foo.md"), true);
  assert.equal(isStatePath("dispatch/abc.json"), true);
  assert.equal(isStatePath("workflows/agent-update.md"), true);
  assert.equal(isStatePath("skills/secrets/SKILL.md"), true);
  assert.equal(isStatePath("branches/registry.json"), true);
});

test("isStatePath: non-state paths return false", () => {
  assert.equal(isStatePath("README.md"), false);
  assert.equal(isStatePath("lib/state-sync.js"), false);
  assert.equal(isStatePath("metrics/agent-dashboard.html"), false);
  assert.equal(isStatePath(".gitignore"), false);
  assert.equal(isStatePath(""), false);
});

test("isStatePath: .bak / .bak.prev / .tmp / ~ backup paths return false even in state dirs", () => {
  // cortex-agent update --force-scripts leaves these behind; they are
  // backups, not state, even if they live under a state dir.
  assert.equal(isStatePath("skills/vcs-pr/scripts/index.js.bak"), false);
  assert.equal(isStatePath("skills/vcs-pr/scripts/index.js.bak.prev"), false);
  assert.equal(isStatePath("decisions/D-001.json.bak"), false);
  assert.equal(isStatePath("branches/registry.json.tmp"), false);
  assert.equal(isStatePath("workflows/foo.md~"), false);
  assert.equal(isStatePath("decisions/.#D-001.json"), true, "lockfile pattern not on blocklist, still state");
});

test("suggestCommitMessage: deterministic, includes dirs and count", () => {
  const msg = suggestCommitMessage(
    ["decisions/D-001.json", "tasks/T-001.json"],
    ["waitpoints/WP-001.json"]
  );
  assert.match(msg, /^chore\(state-sync\): sync \d+ file\(s\) across /);
  assert.match(msg, /decisions/);
  assert.match(msg, /tasks/);
  assert.match(msg, /waitpoints/);
});

test("suggestCommitMessage: empty input still produces a message", () => {
  const msg = suggestCommitMessage([], []);
  assert.match(msg, /^chore\(state-sync\): sync 0 file\(s\)/);
});

test("STATE_DIRS has 8 entries, STATE_FILES has 1 (total 9)", () => {
  assert.equal(STATE_DIRS.length, 8);
  assert.equal(STATE_FILES.length, 1);
  assert.equal(STATE_FILES[0], "branches/registry.json");
});

// ─── Git-backed tests ─────────────────────────────────────────────────────────

test("scanState: clean working tree returns empty dirty/staged", () => {
  const { agentDir } = mkAgentRepo();
  const res = scanState(agentDir);
  assert.equal(res.ok, true);
  assert.equal(res.dirty.length, 0);
  assert.equal(res.staged.length, 0);
  assert.equal(res.branch, "main");
  assert.equal(res.remoteConfigured, false);
});

test("scanState: detects untracked state-class file as dirty", () => {
  const { agentDir } = mkAgentRepo();
  touchStateFile(agentDir, "decisions/D-001.json");
  const res = scanState(agentDir);
  assert.equal(res.ok, true);
  assert.deepEqual(res.dirty, ["decisions/D-001.json"]);
  assert.equal(res.staged.length, 0);
});

test("scanState: detects staged state-class file separately", () => {
  const { agentDir } = mkAgentRepo();
  touchStateFile(agentDir, "tasks/T-001.json");
  // Stage the file via direct git call.
  const stage = spawnSync("git", ["-C", agentDir, "add", "tasks/T-001.json"],
    { encoding: "utf8" });
  assert.equal(stage.status, 0, "git add should succeed");
  const res = scanState(agentDir);
  assert.equal(res.ok, true);
  assert.equal(res.dirty.length, 0);
  assert.deepEqual(res.staged, ["tasks/T-001.json"]);
});

test("scanState: ignores non-state files", () => {
  const { agentDir } = mkAgentRepo();
  touchStateFile(agentDir, "lib/foo.js");
  touchStateFile(agentDir, "README.md", "updated");
  const res = scanState(agentDir);
  assert.equal(res.ok, true);
  assert.equal(res.dirty.length, 0, "non-state files must be ignored");
});

test("scanState: non-git dir returns ok=false with error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-state-sync-nogit-"));
  const agentDir = path.join(root, ".agent");
  fs.mkdirSync(agentDir);
  const res = scanState(agentDir);
  assert.equal(res.ok, false);
  assert.match(res.error, /not a git repository/);
});

test("addState: stages the 9 state classes", () => {
  const { agentDir } = mkAgentRepo();
  touchStateFile(agentDir, "decisions/D-001.json");
  touchStateFile(agentDir, "branches/registry.json", "{}");
  const res = addState(agentDir);
  assert.equal(res.ok, true, res.error);
  // After add, status should show 0 dirty.
  const scan = scanState(agentDir);
  assert.equal(scan.dirty.length, 0, "dirty should be empty after add");
  assert.equal(scan.staged.length, 2, "both state files should be staged");
});

test("commitState: creates a commit and returns a SHA", () => {
  const { agentDir } = mkAgentRepo();
  touchStateFile(agentDir, "decisions/D-001.json");
  addState(agentDir);
  const message = "chore(state-sync): sync 1 file(s) across decisions";
  const res = commitState(agentDir, message);
  assert.equal(res.ok, true, res.error);
  assert.match(res.sha, /^[0-9a-f]{7,40}$/);
  // Working tree should now be clean across state classes.
  const scan = scanState(agentDir);
  assert.equal(scan.dirty.length, 0);
  assert.equal(scan.staged.length, 0);
});

test("end-to-end: touch → scan → add → commit", () => {
  const { agentDir } = mkAgentRepo();
  // Mix of untracked + already-tracked-but-modified.
  touchStateFile(agentDir, "decisions/D-001.json");
  touchStateFile(agentDir, "waitpoints/WP-001.json", "v2");
  // Pre-existing tracked file under branches/:
  touchStateFile(agentDir, "branches/registry.json", "{}");
  // Scan first: should see 3 dirty.
  let scan = scanState(agentDir);
  assert.equal(scan.ok, true);
  assert.equal(scan.dirty.length, 3);
  // addState stages them all.
  const addRes = addState(agentDir);
  assert.equal(addRes.ok, true, addRes.error);
  // Scan again: dirty=0, staged=3.
  scan = scanState(agentDir);
  assert.equal(scan.dirty.length, 0);
  assert.equal(scan.staged.length, 3);
  // Commit.
  const commitRes = commitState(agentDir, suggestCommitMessage(scan.dirty, scan.staged));
  assert.equal(commitRes.ok, true, commitRes.error);
  // Final scan: 0 dirty, 0 staged.
  scan = scanState(agentDir);
  assert.equal(scan.dirty.length, 0);
  assert.equal(scan.staged.length, 0);
});
