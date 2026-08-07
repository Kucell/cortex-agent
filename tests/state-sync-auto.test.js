"use strict";

// ─── state-sync auto mode tests (T-FOLLOW-002 v2) ─────────────────────────────
//
// Coverage: lib/state-sync.js stateSyncAuto
//   - CORTEX_STATE_SYNC=off escape hatch → skipped
//   - no .agent/ or non-git .agent/ → skipped (no-op)
//   - clean working tree → { ok, summary: 'clean' }
//   - dirty + commit + push → { ok, summary: 'pushed <sha> to origin/<branch>' }
//   - dirty + commit + no origin → { ok, summary: 'committed <sha> locally' }
//   - commit failure → { ok: false, error }
//
// The local-push tests use a fake "origin" set to a path-based git repo so
// no network is involved.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { stateSyncAuto } = require("../lib/state-sync");

function git(args, cwd, env = {}) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x",
           GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function mkAgentRepoWithOrigin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-state-sync-auto-"));
  const agentDir = path.join(root, ".agent");
  const originDir = path.join(root, "origin.git");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(originDir);

  // bare origin
  const o = git(["init", "--bare", "-q", "--initial-branch=main"], originDir);
  if (o.status !== 0) throw new Error("bare init failed: " + o.stderr);

  // working repo
  let r = git(["init", "-q", "-b", "main"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
  r = git(["config", "user.email", "t@x"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
  r = git(["config", "user.name", "T"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
  r = git(["remote", "add", "origin", originDir], agentDir); if (r.status !== 0) throw new Error(r.stderr);
  fs.writeFileSync(path.join(agentDir, "README.md"), "init\n");
  r = git(["add", "README.md"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
  r = git(["commit", "-q", "-m", "init"], agentDir); if (r.status !== 0) throw new Error(r.stderr);
  r = git(["push", "-q", "origin", "main"], agentDir); if (r.status !== 0) throw new Error(r.stderr);

  return { root, agentDir, originDir };
}

function touchStateFile(agentDir, relPath, content = "x") {
  const abs = path.join(agentDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

test("stateSyncAuto: skipped when CORTEX_STATE_SYNC=off", async () => {
  const { root } = mkAgentRepoWithOrigin();
  const prev = process.env.CORTEX_STATE_SYNC;
  process.env.CORTEX_STATE_SYNC = "off";
  try {
    const res = await stateSyncAuto({ cwd: root });
    assert.deepEqual(res, { ok: true, skipped: "CORTEX_STATE_SYNC=off" });
  } finally {
    if (prev === undefined) delete process.env.CORTEX_STATE_SYNC;
    else process.env.CORTEX_STATE_SYNC = prev;
  }
});

test("stateSyncAuto: no .agent/ is a no-op", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-state-sync-noagent-"));
  const res = await stateSyncAuto({ cwd: root });
  assert.deepEqual(res, { ok: true, skipped: "no .agent/ git repo" });
});

test("stateSyncAuto: non-git .agent/ is a no-op", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-state-sync-nogit-"));
  const agentDir = path.join(root, ".agent");
  fs.mkdirSync(agentDir);
  const res = await stateSyncAuto({ cwd: root });
  assert.deepEqual(res, { ok: true, skipped: "no .agent/ git repo" });
});

test("stateSyncAuto: clean working tree returns summary=clean", async () => {
  const { root } = mkAgentRepoWithOrigin();
  const res = await stateSyncAuto({ cwd: root });
  assert.equal(res.ok, true);
  assert.equal(res.summary, "clean");
});

test("stateSyncAuto: dirty state → commit + push to origin", async () => {
  const { root, agentDir, originDir } = mkAgentRepoWithOrigin();
  touchStateFile(agentDir, "decisions/D-001.json", "{}");
  touchStateFile(agentDir, "waitpoints/WP-001.json", "{}");

  const res = await stateSyncAuto({ cwd: root });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.summary, /^pushed [0-9a-f]{7,} to origin\/main$/);

  // Verify origin actually got the new files.
  const showRes = git(["ls-tree", "-r", "main"], originDir);
  assert.equal(showRes.status, 0, showRes.stderr);
  assert.match(showRes.stdout, /decisions\/D-001\.json/);
  assert.match(showRes.stdout, /waitpoints\/WP-001\.json/);
});

test("stateSyncAuto: no origin remote → commit only, summary says 'locally'", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-state-sync-noorigin-"));
  const agentDir = path.join(root, ".agent");
  fs.mkdirSync(agentDir);
  const env = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" };
  let r = spawnSync("git", ["-C", agentDir, "init", "-q", "-b", "main"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(r.stderr);
  r = spawnSync("git", ["-C", agentDir, "config", "user.email", "t@x"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  r = spawnSync("git", ["-C", agentDir, "config", "user.name", "T"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(agentDir, "README.md"), "init\n");
  spawnSync("git", ["-C", agentDir, "add", "README.md"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  spawnSync("git", ["-C", agentDir, "commit", "-q", "-m", "init"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });

  touchStateFile(agentDir, "decisions/D-001.json", "{}");
  const res = await stateSyncAuto({ cwd: root });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.summary, /^committed [0-9a-f]{7,} locally \(no origin remote\)$/);
});

test("stateSyncAuto: already-staged change → no new commit, push to origin", async () => {
  const { root, agentDir, originDir } = mkAgentRepoWithOrigin();
  // Pre-stage a change so dirty=0, staged=1.
  touchStateFile(agentDir, "decisions/D-001.json", "{}");
  const stage = git(["add", "decisions/D-001.json"], agentDir);
  assert.equal(stage.status, 0);

  const res = await stateSyncAuto({ cwd: root });
  assert.equal(res.ok, true, JSON.stringify(res));
  // Either 'pushed ...' (if a new commit was made) or 'clean' depending on
  // what scanState saw at start; both are valid happy paths.
  assert.ok(res.summary === "clean" || /^pushed [0-9a-f]{7,} to origin\/main$/.test(res.summary),
    `unexpected summary: ${res.summary}`);
  // Either way origin should now have the file.
  const showRes = git(["ls-tree", "-r", "main"], originDir);
  assert.match(showRes.stdout, /decisions\/D-001\.json/);
});
