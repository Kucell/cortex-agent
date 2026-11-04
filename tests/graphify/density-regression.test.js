"use strict";

// ─── Regression tests for the concurrency review findings (#154) ──────────
//
// Every test here pins ONE failure mode that an independent review found
// in an earlier revision of this change. They are deliberately written
// against the OBSERVABLE behaviour (what ends up on disk, which process
// holds what, how many times a request is consumed) rather than against the
// shape of the source, so a mechanism that is removed or replaced fails the
// test instead of silently passing it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");

const density = require("../../lib/graphify/density");
const hook = require("../../lib/graphify/hook");
const markers = require("../../lib/graphify/markers");
const lockLib = require("../../lib/graphify/density-lock");
const updateLib = require("../../lib/graphify/density-update");

const ROOT = path.resolve(__dirname, "..", "..");
const WORK_ROOT = path.join(ROOT, ".agent-work", "test-density-regression");

function mkProject(name) {
  const root = path.join(
    WORK_ROOT,
    name + "-" + process.pid + "-" + Date.now()
      + "-" + Math.random().toString(36).slice(2, 8),
  );
  fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
  fs.mkdirSync(path.join(root, "graphify-out"), { recursive: true });
  return root;
}

function writeGraph(root, { nodes, edges, meta = null }) {
  const graph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: "n" + i })),
    links: Array.from({ length: edges }, (_, i) => ({
      source: "n" + (i % Math.max(nodes, 1)),
      target: "n0",
    })),
    hyperedges: [],
  };
  if (meta) graph._meta = meta;
  fs.writeFileSync(
    path.join(root, "graphify-out", "graph.json"),
    JSON.stringify(graph, null, 2),
  );
}

// A stub `graphify` on PATH: the hook and the runner both shell out to it.
function installStub(root, { updateExit = 0, extractExit = 0 } = {}) {
  const bin = path.join(root, "stub-bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, "graphify-calls.log");
  const script = path.join(bin, "graphify");
  fs.writeFileSync(script, [
    "#!/bin/sh",
    "LOG=\"" + log + "\"",
    // The output directory is redirected by GRAPHIFY_OUT, exactly like the
    // real CLI does: the framework runs the writer against a staging
    // directory and publishes the result itself, so a writer that only
    // writes the public graph is a writer whose isolation is broken.
    "OUT=\"${GRAPHIFY_OUT:-$PWD/graphify-out}\"",
    "mkdir -p \"$OUT\"",
    "printf '{\"nodes\":[{\"id\":\"a\"},{\"id\":\"b\"}],\"links\":[{\"source\":\"a\",\"target\":\"b\"},{\"source\":\"b\",\"target\":\"a\"}]}' > \"$OUT/graph.json\"",
    "case \"$1\" in",
    "  --version) echo 'graphify 0.9.27-stub'; exit 0 ;;",
    "  update) echo \"update $@\" >> \"$LOG\"; exit " + updateExit + " ;;",
    "  extract) echo \"extract $@\" >> \"$LOG\"; exit " + extractExit + " ;;",
    "  *) echo \"$@\" >> \"$LOG\"; exit 0 ;;",
    "esac",
    "",
  ].join("\n"));
  fs.chmodSync(script, 0o755);
  return { bin, log };
}

function stubEnv(stub, extra = {}) {
  return Object.assign({}, process.env, {
    PATH: stub.bin + ":" + process.env.PATH,
    GRAPHIFY_STUB_LOG: stub.log,
    GRAPHIFY_DRAIN_LOCK_WAIT_MS: "0",
  }, extra);
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

// The Git context the resolver is given: it never runs Git, so the context
// is injected.
function fakeGitContext({ head = "abc123", branch = "agent/test" } = {}) {
  return {
    ok: true,
    isWorktree: false,
    isPrimary: true,
    worktreePath: "/current",
    commonDir: "/.git",
    head,
    branch,
    detached: false,
    peers: [{ path: "/current", head, branch, detached: false }],
    primary: null,
    _dirtyCount: 0,
  };
}

function pendingNames(root) {
  try {
    return fs.readdirSync(density.pendingDir(root)).sort();
  } catch (_) {
    return [];
  }
}

// A project whose graph was published by the framework, with the commit
// marker of that publication. Returns the path of the marker.
function publishFixture(root) {
  const pluginDir = path.join(root, ".agent", "plugins", "graphify");
  const out = path.join(root, "graphify-out");
  const staging = path.join(root, "staging");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "config.yml"),
    "graphify:\n  version: '>=0.9.0'\n  map_path: 'graphify-out/graph.json'\n",
  );
  const manifestLib = require("../../lib/graphify/manifest");
  const graph = { schema_version: "1.0", nodes: [{ id: "n1" }], links: [] };
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(graph));
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifestLib.buildManifest({
    graphifyVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    sourceHead: "abc123",
    includedRoots: ["lib/"],
    excludedRoots: [],
    nodeCount: 1,
    edgeCount: 0,
    generationMode: "full",
  }), null, 2));
  fs.writeFileSync(path.join(staging, "graph.json"), JSON.stringify(graph));
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifestLib.buildManifest({
    graphifyVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    sourceHead: "abc123",
    includedRoots: ["lib/"],
    excludedRoots: [],
    nodeCount: 1,
    edgeCount: 0,
    generationMode: "full",
  }), null, 2));
  const published = updateLib.publishStagedOutput(root, staging, { isHeld: () => true });
  assert.equal(published.ok, true, "the fixture must be published");
  return path.join(pluginDir, ".density-commit.json");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A synchronous wait, for the tests that drive a child process.
function sleepSync(ms) {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  } catch (_) { /* a host without Atomics.wait */ }
}

test("regression: a live lock that is moved aside is never put back on top of a new holder", () => {
  // The reclaim used to MOVE the lock file aside and then put it back with
  // a rename. The rename REPLACES whatever is at the path, so a holder that
  // had taken the path in the meantime lost its lock record -- and two live
  // processes both believed they held the lock.
  //
  // The restore now uses link(), which refuses to replace an existing name:
  // the displaced holder is fenced out instead, and the new holder keeps its
  // lock.
  const root = mkProject("live-lock-restore");
  try {
    const file = density.rebuildLockPath(root);
    // A lock whose holder is gone and that is older than the stale window.
    fs.writeFileSync(file, JSON.stringify({
      token: "dead-token",
      pid: 999999,
      acquiredAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }));

    let seamRan = false;
    const acquired = density.acquireRebuildLock(root, {
      staleMs: 1000,
      // Between the judgement and the takeover a LIVE holder takes the lock.
      onStaleJudged: () => {
        fs.writeFileSync(file, JSON.stringify({
          token: "live-token",
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }));
      },
      // Between the takeover and the restore ANOTHER holder takes the path
      // that the move freed.
      onLockMoved: () => {
        seamRan = true;
        fs.writeFileSync(file, JSON.stringify({
          token: "new-holder-token",
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }));
      },
    });

    assert.equal(acquired, null, "the reclaim must be refused when a live lock was moved aside");
    assert.ok(seamRan, "the takeover must have happened");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.token, "new-holder-token",
      "the new holder's lock must survive: the restore must never replace it");
    assert.notEqual(onDisk.token, "live-token",
      "the displaced holder must be fenced out, not restored over the new holder");
  } finally {
    cleanup(root);
  }
});

test("regression: a publication never replaces an existing baseline", () => {
  // The publication used to reserve the name with an EMPTY placeholder and
  // then rename the finished file over it. The reservation did not keep the
  // generation, so a publisher that wrote a NEW baseline while the
  // placeholder was in flight had its value replaced by the older one --
  // the baseline moved BACKWARDS and the guard was weakened.
  const root = mkProject("baseline-no-clobber");
  try {
    const target = path.join(root, "published.json");
    const first = density.publishExclusive(target, JSON.stringify({ ratio: 5 }) + "\n");
    assert.equal(first.created, true);
    const second = density.publishExclusive(target, JSON.stringify({ ratio: 2 }) + "\n");
    assert.equal(second.created, false, "a second publication must not win");
    assert.equal(second.reason, "already_exists");
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).ratio, 5,
      "the newer publication must survive");

    // The same rule for the baseline itself: a stamp that is older than the
    // recorded baseline must be refused.
    const newer = new Date(Date.now() + 60_000).toISOString();
    density.stampBaseline(root, { nodes: 100, edges: 500, buildKind: "full", now: newer });
    const older = density.stampBaseline(root, {
      nodes: 100,
      edges: 200,
      buildKind: "full",
      now: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(older.ok, false, "an older stamp must be refused");
    assert.equal(older.reason, "baseline_is_newer");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "the baseline must not move backwards");
  } finally {
    cleanup(root);
  }
});

test("regression: a request that arrives while the queue is being drained is still consumed", async () => {
  // The runner used to check the queue for emptiness and then EXIT, so a
  // request that arrived in between stayed queued with nobody to replay it.
  // The runner now settles for a short while before it gives up, and it
  // records that it held the lock BEFORE it releases it, so the follow-up
  // drain is started when the queue is not empty any more.
  const root = mkProject("late-arrival");
  const oldLog = process.env.GRAPHIFY_STUB_LOG;
  try {
    const stub = installStub(root);
    process.env.GRAPHIFY_STUB_LOG = stub.log;
    density.writePendingUpdate(root, { changedPaths: ["src/early.js"] });

    // A writer that publishes a request AFTER the drain replayed the first
    // one. It waits for the replay to show up in the stub's call log and
    // then publishes a moment later, so the request really arrives in the
    // window between the last empty check and the exit -- and not in the
    // round that follows the replay.
    const writer = spawn(process.execPath, ["-e", [
      "const fs = require('node:fs');",
      "const density = require(process.argv[1]);",
      "const log = process.env.GRAPHIFY_STUB_LOG;",
      "let seen = 0;",
      "const timer = setInterval(() => {",
      "  let lines = 0;",
      "  try { lines = fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length; } catch (_) { lines = 0; }",
      "  if (lines >= 1) seen += 1;",
      "  if (seen >= 15) {",
      "    clearInterval(timer);",
      "    density.writePendingUpdate(process.argv[2], { changedPaths: ['src/late.js'] });",
      "  }",
      "}, 10);",
    ].join("\n"), path.join(ROOT, "lib", "graphify", "density.js"), root], {
      cwd: root,
      stdio: "ignore",
      detached: true,
    });
    writer.unref();

    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner, "--drain-pending"], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.equal(run.status, 0, "the drain must succeed: " + run.stderr);
    // The late writer publishes its request a moment after the queue looked
    // empty. The runner has to stay long enough to pick it up, so the
    // assertion waits for the writer to have published it.
    await sleep(1500);
    assert.equal(density.hasPendingUpdate(root), false,
      "the late request must have been consumed");
    const calls = fs.existsSync(stub.log)
      ? fs.readFileSync(stub.log, "utf8").trim().split("\n").filter(Boolean)
      : [];
    assert.equal(calls.length, 2,
      "both requests must have been replayed, saw: " + JSON.stringify(calls));
  } finally {
    if (oldLog === undefined) delete process.env.GRAPHIFY_STUB_LOG;
    else process.env.GRAPHIFY_STUB_LOG = oldLog;
    cleanup(root);
  }
});

test("regression: a new request never inherits the failure budget of the queue", () => {
  // The hook used to hand the HIGHEST attempt counter of the queue to every
  // request it published, and it published a MERGED request next to the
  // ones it had consumed. A request that was queued next to one that had
  // already failed four times was therefore dropped after a single further
  // failure -- without ever having been retried properly.
  const root = mkProject("hook-attempts");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    density.writePendingUpdate(root, { changedPaths: ["src/old.js"], attempts: 4 });
    density.writePendingUpdate(root, { changedPaths: ["src/fresh.js"], attempts: 0 });

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the rebuild lock must be held so the hook defers");
    const result = hook.runPostCommit({
      cwd: root,
      changedPaths: ["src/new.js"],
      sourceHead: "abc123",
      branch: "main",
    });
    assert.equal(result.result, "skipped");

    const names = pendingNames(root);
    assert.equal(names.length, 3,
      "the two queued requests and the new one must be visible: " + names.join(","));
    assert.equal(names.filter((n) => n.includes("-a4-")).length, 1,
      "the queued request must keep its own budget and must not be duplicated");
    assert.equal(names.filter((n) => n.includes("-a0-")).length, 2,
      "the new request must start with a fresh budget: " + names.join(","));
    lock.release();
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: an abandoned claim is recovered exactly once", async () => {
  // The recovery used to publish a NEW request and then remove the claim,
  // and two consumers could both publish: the request was then replayed
  // twice, from two different claims. The recovery is a rename now, so
  // exactly one consumer can recover a given claim.
  const root = mkProject("abandoned-recovery");
  try {
    const dir = density.pendingDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const stale = Date.now() - 24 * 60 * 60 * 1000;
    const claimPath = path.join(dir, ".claimed-999999-" + stale + "-abcdef123456.json");
    fs.writeFileSync(
      claimPath,
      JSON.stringify({
        changedPaths: ["src/one-request.js"],
        semanticPaths: [],
        sourceHead: null,
        branch: null,
        attempts: 2,
      }),
    );
    const originalInode = fs.statSync(claimPath).ino;
    const script = [
      "const density = require(process.argv[1]);",
      "const taken = density.takePendingUpdate(process.argv[2]);",
      "console.log(JSON.stringify({",
      "  changed: taken ? taken.changedPaths : null,",
      "  claims: taken ? taken.claims : [],",
      "}));",
    ].join("\n");
    const consume = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, path.join(ROOT, "lib", "graphify", "density.js"), root], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out.trim()));
    });
    const outputs = await Promise.all([consume(), consume()]);
    const results = outputs.map((line) => JSON.parse(line));
    const consumed = results.filter((r) => r.changed && r.changed.length > 0);
    assert.equal(consumed.length, 1,
      "the abandoned request must be recovered by exactly one consumer: "
        + outputs.join(" / "));
    assert.equal(consumed[0].claims.length, 1, "the consumer must own exactly one claim");
    // The recovery MOVES the claim: the restored request is the very same
    // file. A recovery that published a new request and removed the claim
    // would leave a window in which two consumers both publish, and the
    // request would be replayed twice.
    const restoredInode = fs.statSync(consumed[0].claims[0]).ino;
    assert.equal(restoredInode, originalInode,
      "the recovery must MOVE the claim, not copy it: a copy leaves a window "
        + "in which two consumers both publish the same request");
  } finally {
    cleanup(root);
  }
});

test("regression: an exhausted request is dropped and its claim file is removed", () => {
  // The branch that only found exhausted requests returned the claim files
  // under the wrong key, so the caller -- which removes `exhaustedClaims` --
  // never removed them, and the queue accumulated claim files that nothing
  // could ever clear.
  const root = mkProject("exhausted-claims");
  try {
    density.writePendingUpdate(root, { changedPaths: ["src/doomed.js"], attempts: 5 });
    const pending = density.takePendingUpdate(root);
    assert.ok(pending, "the exhausted request must still be reported");
    assert.equal(pending.exhausted.length, 1);
    assert.equal(pending.exhaustedClaims.length, 1,
      "the claim file must be reported so that it can be removed");
    assert.equal(pending.claims.length, 0, "an exhausted request must not be replayed");
    density.completePendingUpdate(pending.exhaustedClaims);
    assert.deepEqual(pendingNames(root), [],
      "the queue must be empty once the exhausted request was dropped");
  } finally {
    cleanup(root);
  }
});

test("regression: a finished runner leaves no lock behind", () => {
  // The lock used to be handed from the hook to the runner through the
  // environment, and the handover rewrote the lock file after the runner
  // had already released it: the lock was RECREATED, and every later drain
  // was refused for the whole stale window.
  const root = mkProject("runner-no-lock");
  try {
    const stub = installStub(root);
    density.writePendingUpdate(root, { changedPaths: ["src/a.js"] });
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner, "--drain-pending"], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.equal(run.status, 0, "the drain must succeed: " + run.stderr);
    assert.equal(fs.existsSync(density.rebuildLockPath(root)), false,
      "the runner must release the lock it took");
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be free once the runner exited");
    lock.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a holder that lost the lock cannot release the new holder's lock", () => {
  // The release used to read the lock file, compare the token and then
  // remove the file. Between the comparison and the removal the file could
  // change generation, so a holder whose lock had been reclaimed removed
  // the NEW holder's lock -- and the mutual exclusion was gone.
  //
  // The release now moves the file aside and checks whose record it moved,
  // so it can only ever remove its own lock.
  const root = mkProject("release-fence");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock);
    const file = density.rebuildLockPath(root);
    // Somebody else took the lock while this holder was away.
    fs.writeFileSync(file, JSON.stringify({
      token: "other-token",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }));
    assert.equal(lock.isHeld(), false, "the holder must see that it lost the lock");
    lock.release();
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.token, "other-token",
      "the release must never remove the lock of another holder");
  } finally {
    cleanup(root);
  }
});

test("regression: a failed update queues the request with the attempt counted", () => {
  // The hook used to drop a failed commit entirely: the request was not
  // queued, so the commit never reached the graph. It is queued now, and
  // the attempt that already happened is counted.
  const root = mkProject("hook-failure");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root, { updateExit: 1 });
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    const result = hook.runPostCommit({ cwd: root, changedPaths: ["src/broken.js"] });
    assert.equal(result.ok, false, "the failed update must be reported");
    const names = pendingNames(root);
    assert.ok(names.length >= 1, "the failed request must be queued");
    const attempts = names
      .map((n) => /-a(\d+)-/.exec(n))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    assert.ok(attempts.some((a) => a >= 1),
      "the attempt that already happened must be counted: " + names.join(","));
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: the hook's early returns leave no claim behind", () => {
  // The hook used to consume the queue and then return early -- on a
  // semantic-only change or on a NOOP -- without confirming the claims, so
  // the request stayed claimed. A long-lived host then believed the owner
  // was alive for ever, and a short-lived one recovered it after six hours
  // and marked it dirty a second time.
  const root = mkProject("hook-early-return");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    density.writePendingUpdate(root, { changedPaths: ["src/doc.md"] });
    const result = hook.runPostCommit({ cwd: root, changedPaths: ["docs/readme.md"] });
    assert.equal(result.result, "semantic_marked");
    const names = pendingNames(root);
    assert.equal(names.filter((n) => n.startsWith(".claimed-")).length, 0,
      "no claim may survive a successful hook run: " + names.join(","));
    assert.equal(names.length, 1,
      "the queued request must still be visible: " + names.join(","));
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: a reclaim fences the displaced holder by its token", () => {
  // The reclaim of a DEAD holder's lock must NOT advance the epoch. The
  // epoch is shared by every holder, and advancing it would also
  // invalidate a healthy holder that took the lock in the window between
  // the judgement and the takeover -- a holder that never lost anything.
  //
  // The fence that IS precise is the TOKEN: the holder that lost the lock
  // is registered by its token, and only its own publications are dropped.
  const root = mkProject("token-fence");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock);
    const generation = lock.generation;
    // A reclaim needs a lock whose holder is gone, so the record of a dead
    // process is written over the lock.
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "dead-token",
      pid: 999999,
      acquiredAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }));
    const reclaimed = density.acquireRebuildLock(root, {
      staleMs: 0,
      onStaleJudged: () => {},
    });
    assert.ok(reclaimed, "the stale lock must be reclaimable");
    assert.equal(reclaimed.generation, generation,
      "a reclaim must not advance the shared epoch: it would fence a healthy holder too");

    // The holder that lost the lock is fenced by its token: it may not
    // publish any more.
    const fenced = density.stampBaseline(root, {
      nodes: 100,
      edges: 200,
      buildKind: "full",
      lockGeneration: generation,
      lockToken: "dead-token",
    });
    assert.equal(fenced.ok, false, "a displaced holder must not publish");
    assert.equal(fenced.reason, "lock_displaced");
    assert.equal(density.readBaselineSidecar(root), null,
      "the refused stamp must not reach the disk");

    // The healthy holder that took the lock in the meantime keeps its
    // authority: the coarse epoch fence did not touch it.
    const healthy = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      lockGeneration: reclaimed.generation,
      lockToken: reclaimed.token,
    });
    assert.equal(healthy.ok, true,
      "the healthy holder must still be able to publish");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5);
    reclaimed.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a late publication cannot roll the baseline back", () => {
  // The baseline used to be published by comparing the timestamp and then
  // renaming over the file. That is a read followed by a write, and two
  // real runners could roll the baseline back through it: the slower one
  // passed the comparison, the faster one published the new value, and the
  // slower one then replaced it with its older one.
  //
  // The publication appends instead, and the reader picks the record that
  // wins the order. A late publication therefore cannot destroy the record
  // that won it.
  const root = mkProject("append-only-baseline");
  try {
    const newer = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      now: "2026-11-03T00:01:00.000Z",
    });
    assert.equal(newer.ok, true, "the first publication must succeed");
    // The slow publisher arrives late with an older measurement. It is
    // refused, and even a publication that slips through must not win.
    const older = density.stampBaseline(root, {
      nodes: 100,
      edges: 200,
      buildKind: "full",
      now: "2026-11-03T00:00:00.000Z",
    });
    assert.equal(older.ok, false, "the older publication must be refused");
    assert.equal(older.reason, "baseline_is_newer");
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(sidecar.edge_node_ratio, 5,
      "the baseline in effect must still be the newer one");
    assert.equal(sidecar.baseline_locked_at, "2026-11-03T00:01:00.000Z");
  } finally {
    cleanup(root);
  }
});

test("regression: the reader prefers the newest lock generation", () => {
  // The generation is the trustworthy order: it only advances when a live
  // holder can be displaced, so it never depends on the wall clock. A
  // record of a newer generation wins, even when its timestamp is older.
  const root = mkProject("generation-order");
  try {
    density.stampBaseline(root, {
      nodes: 100,
      edges: 200,
      buildKind: "full",
      now: "2026-11-03T00:05:00.000Z",
      lockGeneration: 7,
    });
    density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      now: "2026-11-03T00:01:00.000Z",
      lockGeneration: 8,
    });
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(sidecar.edge_node_ratio, 5,
      "the record of the newer generation must win");
    assert.equal(sidecar.lock_generation, 8);
  } finally {
    cleanup(root);
  }
});

test("regression: a migrated baseline never displaces a measured one", () => {
  // The migration takes the ratio out of the graph meta data -- a snapshot
  // of an older graph. It must never become the baseline of a project that
  // has already measured one: a lower baseline lowers the threshold and
  // weakens the guard.
  const root = mkProject("migration-priority");
  try {
    // The migration runs first: the project carried the consumer-side
    // convention and no baseline yet.
    writeGraph(root, { nodes: 200, edges: 400, meta: { edge_node_ratio: 2 } });
    const migrated = density.migrateMetaBaseline(root);
    assert.equal(migrated.migrated, true,
      "the migration must publish the meta baseline: " + migrated.reason);
    // A full build measures a higher ratio afterwards, with an older
    // timestamp than the migration carried.
    const stamp = density.stampBaseline(root, {
      nodes: 200,
      edges: 1000,
      buildKind: "full",
      now: "2026-11-02T00:00:00.000Z",
    });
    assert.equal(stamp.ok, true, "the measured baseline must be published");
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(sidecar.edge_node_ratio, 5,
      "the measured baseline must win over the migrated one");
  } finally {
    cleanup(root);
  }
});

test("regression: an interrupted publication cannot roll the baseline back", async () => {
  // The publication reads the log, compares, and then writes. A publisher
  // that is interrupted between the read and the write used to replace the
  // file with its own -- OLDER -- record, and the baseline was rolled back.
  // Two real runners could do exactly that.
  //
  // The publication appends, so the interrupted publisher cannot destroy
  // the record that won the order: the reader still sees the newer one.
  const root = mkProject("interrupted-publication");
  try {
    const ready = path.join(root, "publisher-ready");
    const go = path.join(root, "publisher-go");
    const child = path.join(root, "publisher.js");
    fs.writeFileSync(child, [
      "const fs = require('node:fs');",
      "const density = require(process.argv[2]);",
      "const root = process.argv[3];",
      "const ready = process.argv[4];",
      "const go = process.argv[5];",
      "const result = density.stampBaseline(root, {",
      "  nodes: 100,",
      "  edges: 200,",
      "  buildKind: 'full',",
      "  now: '2026-11-03T00:00:00.000Z',",
      "  onBeforeAppend: () => {",
      "    fs.writeFileSync(ready, '1');",
      "    const until = Date.now() + 30000;",
      "    while (!fs.existsSync(go) && Date.now() < until) {",
      "      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
      "    }",
      "  },",
      "});",
      "process.stdout.write(JSON.stringify(result));",
    ].join("\n"));
    const run = spawn(process.execPath, [
      child,
      path.join(ROOT, "lib", "graphify", "density.js"),
      root,
      ready,
      go,
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    run.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    const closed = new Promise((resolve) => run.on("close", (code) => resolve(code)));
    const until = Date.now() + 30000;
    while (!fs.existsSync(ready) && Date.now() < until) await sleep(20);
    assert.ok(fs.existsSync(ready), "the publisher must reach the seam");
    // The second publisher writes its newer record while the first one is
    // suspended between its read and its write.
    const newer = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      now: "2026-11-03T00:01:00.000Z",
    });
    assert.equal(newer.ok, true, "the second publication must succeed");
    fs.writeFileSync(go, "1");
    const status = await closed;
    assert.equal(status, 0, "the suspended publisher must finish");
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(sidecar.edge_node_ratio, 5,
      "the interrupted publication must not roll the baseline back");
    assert.equal(sidecar.baseline_locked_at, "2026-11-03T00:01:00.000Z");
  } finally {
    cleanup(root);
  }
});

test("regression: a semantic marker that cannot be written keeps the request queued", () => {
  // The drain confirmed the claim BEFORE it wrote the marker. A marker that
  // failed to land therefore left an empty queue and no reminder at all:
  // the semantic change lost every persistent trace of itself.
  const root = mkProject("marker-write-failure");
  try {
    const stub = installStub(root);
    // The marker path is occupied by a directory, so the rename that
    // publishes the marker fails.
    const graphDir = path.join(root, "graphify-out");
    fs.mkdirSync(path.join(graphDir, ".graphify-stale.json"), { recursive: true });
    density.writePendingUpdate(root, {
      changedPaths: ["docs/queued.md"],
      semanticPaths: ["docs/queued.md"],
    });
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner, "--drain-pending"], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.notEqual(run.status, 0, "the drain must report the failure");
    const names = pendingNames(root);
    assert.equal(names.filter((n) => n.startsWith(".claimed-")).length, 0,
      "the claim must not stay claimed forever: " + names.join(","));
    assert.equal(names.length, 1,
      "the request must stay visible for the next attempt: " + names.join(","));
    const attempts = /-a(\d+)-/.exec(names[0]);
    assert.ok(attempts && Number(attempts[1]) >= 1,
      "the failed attempt must be counted: " + names.join(","));
  } finally {
    cleanup(root);
  }
});

test("regression: the hook never clears a marker a consumer wrote meanwhile", () => {
  // The hook cleared the stale marker unconditionally after its update. A
  // consumer that wrote a NEW marker in the meantime -- for a deferred
  // semantic change -- lost its reminder, and its request had already been
  // confirmed.
  //
  // The reminder that was there BEFORE the hook ran is not answered by an
  // incremental update either: the update rebuilds the code corpus only.
  // So both reminders have to survive: the one the consumer published and
  // the one that is still unanswered.
  const root = mkProject("marker-generation");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    // The marker that exists before the hook runs.
    const markers = require("../../lib/graphify/markers");
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/old.md"],
    });
    // The consumer writes a NEW marker while the hook is updating: the stub
    // stands in for a concurrent drain.
    const consumerMarker = path.join(root, "consumer-marker.js");
    fs.writeFileSync(consumerMarker, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      // argv[1] is this script; the markers module and the graph
      // directory follow it.
      "const markers = require(process.argv[2]);",
      "markers.writeMarker({",
      "  graphDir: process.argv[3],",
      "  kind: markers.KIND.SEMANTIC,",
      "  reason: 'semantic_changes_only',",
      "  changedPaths: ['docs/queued.md'],",
      "});",
    ].join("\n"));
    const stubBody = fs.readFileSync(path.join(stub.bin, "graphify"), "utf8");
    fs.writeFileSync(path.join(stub.bin, "graphify"), stubBody.replace(
      '  update) echo "update $@" >> "$LOG"; exit 0 ;;',
      '  update) node "' + consumerMarker + '" "' + path.join(ROOT, "lib", "graphify", "markers.js") + '" "' + graphDir + '" >> "$LOG"; exit 0 ;;',
    ));
    fs.chmodSync(path.join(stub.bin, "graphify"), 0o755);
    const result = hook.runPostCommit({ cwd: root, changedPaths: ["src/a.js"] });
    assert.equal(result.result, "incremental_ok", "the hook must report success");
    const after = markers.readMarker(graphDir);
    assert.ok(after.ok, "the consumer's marker must survive");
    assert.deepEqual(after.marker.changedPaths, ["docs/old.md", "docs/queued.md"],
      "neither reminder may be deleted: the consumer published one, and the " +
      "one that was there before is still unanswered");
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: a request that cannot be queued is reported as a failure", () => {
  // The hook reported "safely deferred" even when the queue write itself
  // failed: the commit's changes were then recorded nowhere, and no marker
  // pointed at them either.
  const root = mkProject("queue-publish-failure");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    // The queue directory cannot be written.
    const dir = density.pendingDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock);
    const result = hook.runPostCommit({ cwd: root, changedPaths: ["src/lost.js"] });
    fs.chmodSync(dir, 0o700);
    assert.equal(result.ok, false, "the hook must report the failure");
    assert.equal(result.reason, "pending_publish_failed");
    const markers = require("../../lib/graphify/markers");
    const marker = markers.readMarker(path.join(root, "graphify-out"));
    assert.ok(marker.ok, "a failure marker must point at the lost change");
    lock.release();
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: the crash recovery keeps the retry budget", () => {
  // The claim name carried no attempt counter and the body still carried
  // the counter the request was CREATED with, so a recovery that read the
  // body reset the budget of a request that had already failed four times.
  // Every crash could then refresh the budget for ever.
  const root = mkProject("recovery-budget");
  try {
    const dir = density.pendingDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const stale = Date.now() - 24 * 60 * 60 * 1000;
    fs.writeFileSync(
      path.join(dir, ".claimed-999999-" + stale + "-abcdef123456-a4.json"),
      JSON.stringify({
        changedPaths: ["src/retry.js"],
        semanticPaths: [],
        sourceHead: null,
        branch: null,
        attempts: 0,
      }),
    );
    const taken = density.takePendingUpdate(root);
    assert.ok(taken, "the abandoned claim must be recovered");
    assert.equal(taken.attempts, 4, "the retry budget must survive the recovery");
    const names = pendingNames(root);
    assert.ok(names.some((n) => /-a4[.-]/.test(n)),
      "the recovered request must carry its budget: " + names.join(","));
  } finally {
    cleanup(root);
  }
});

test("regression: a broken sidecar does not block the migration for ever", () => {
  // A publication that failed half-way used to leave an empty file at the
  // fixed sidecar name. The next migration saw the name and reported
  // "sidecar_present", so the guard stayed without a baseline until a
  // human cleaned the file up.
  const root = mkProject("broken-sidecar");
  try {
    writeGraph(root, { nodes: 200, edges: 400, meta: { edge_node_ratio: 2 } });
    fs.mkdirSync(path.dirname(density.baselinePath(root)), { recursive: true });
    fs.writeFileSync(density.baselinePath(root), "");
    const migrated = density.migrateMetaBaseline(root);
    assert.equal(migrated.migrated, true,
      "an invalid sidecar must not block the migration: " + migrated.reason);
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 2);
  } finally {
    cleanup(root);
  }
});

// ─── Round 10: the fences that survived the ninth review ───────────────────

test("regression: a reminder published while another one is cleared is never deleted", () => {
  // The clear used to CHECK the marker and then DELETE it by path. A
  // consumer that published a new reminder between the two steps lost its
  // reminder for good: the request it belonged to had already been
  // confirmed, so nothing would ever publish it again.
  //
  // Every reminder lives in its OWN record now, so the clear removes the
  // records that were answered -- never "the file at the path". A reminder
  // that a consumer publishes while the clear runs is a DIFFERENT record,
  // and it survives.
  const root = mkProject("marker-replace-race");
  try {
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.UPDATE_FAILED,
      reason: "graphify_update_failed:1",
      changedPaths: ["src/a.js"],
    });
    const before = markers.readMarker(graphDir);
    assert.equal(before.ok, true, "the marker must be readable");
    // A concurrent consumer publishes a NEW reminder while the clear is
    // removing the record it read.
    const realUnlink = fs.unlinkSync;
    let published = false;
    fs.unlinkSync = function patched(file) {
      if (!published && String(file).includes(markers.MARKER_RECORDS_DIRNAME)) {
        published = true;
        markers.writeMarker({
          graphDir,
          kind: markers.KIND.SEMANTIC,
          reason: "semantic_changes_only",
          changedPaths: ["docs/concurrent.md"],
        });
      }
      return realUnlink.call(fs, file);
    };
    let cleared;
    try {
      cleared = markers.clearMarkerIfUnchanged(graphDir, before.identity, {
        kinds: markers.CLEARABLE_BY_INCREMENTAL,
      });
    } finally {
      fs.unlinkSync = realUnlink;
    }
    assert.ok(published, "the concurrent reminder must have been published");
    assert.equal(cleared.cleared, true,
      "the reminder that was read is answered and cleared");
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, true, "the concurrent reminder must survive");
    assert.equal(after.marker.kind, markers.KIND.SEMANTIC);
    assert.deepEqual(after.marker.changedPaths, ["docs/concurrent.md"]);
  } finally {
    cleanup(root);
  }
});

test("regression: a code-only hook never clears a semantic marker", () => {
  // A successful incremental update used to clear whatever marker it found.
  // An incremental update rebuilds the CODE corpus only, so it does not
  // answer a SEMANTIC reminder -- clearing it dropped the only persistent
  // trace of a semantic change that nothing had rebuilt.
  const root = mkProject("hook-semantic-marker");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/concurrent.md"],
    });
    const result = hook.runPostCommit({ cwd: root, changedPaths: ["src/module.js"] });
    assert.equal(result.result, "incremental_ok",
      "the hook must report success: " + JSON.stringify(result));
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, true, "the semantic marker must survive a code-only update");
    assert.equal(after.marker.kind, markers.KIND.SEMANTIC);
    assert.deepEqual(after.marker.changedPaths, ["docs/concurrent.md"]);
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: a mixed commit leaves a semantic reminder", () => {
  // A commit that carries code AND semantic changes leaves the semantic
  // corpus stale: the incremental update does not rebuild it. The reminder
  // has to be written, or the semantic part of the commit has no trace at
  // all.
  const root = mkProject("hook-mixed-commit");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    const graphDir = path.join(root, "graphify-out");
    const result = hook.runPostCommit({
      cwd: root,
      changedPaths: ["src/module.js", "docs/spec.md"],
    });
    assert.equal(result.result, "incremental_ok",
      "the hook must report success: " + JSON.stringify(result));
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, true, "the semantic part of the commit needs a reminder");
    assert.equal(after.marker.kind, markers.KIND.SEMANTIC);
    assert.deepEqual(after.marker.changedPaths, ["docs/spec.md"]);
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: a drain hands back the groups it never reached", () => {
  // The drain CLAIMS the requests it takes: a claimed request is not in the
  // queue any more. A drain that stopped early -- because it could not
  // publish its marker -- used to leave the groups it had not reached
  // claimed: they were invisible to every other consumer and only the
  // abandoned-claim window (hours) could recover them.
  const root = mkProject("drain-unreached-groups");
  try {
    const stub = installStub(root);
    // The marker path is occupied by a directory, so the rename that
    // publishes the marker fails and the drain stops.
    const graphDir = path.join(root, "graphify-out");
    fs.mkdirSync(path.join(graphDir, ".graphify-stale.json"), { recursive: true });
    density.writePendingUpdate(root, {
      changedPaths: ["docs/first.md"],
      semanticPaths: ["docs/first.md"],
      attempts: 0,
    });
    density.writePendingUpdate(root, {
      changedPaths: ["docs/second.md"],
      semanticPaths: ["docs/second.md"],
      attempts: 1,
    });
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner, "--drain-pending"], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.notEqual(run.status, 0, "the drain must report the failure");
    const names = pendingNames(root);
    assert.equal(names.filter((n) => n.startsWith(".claimed-")).length, 0,
      "no claim may stay claimed: " + names.join(","));
    assert.equal(names.length, 2,
      "BOTH requests must be visible for the next attempt: " + names.join(","));
  } finally {
    cleanup(root);
  }
});

test("regression: the legacy single-object sidecar is still read", () => {
  // The version that published the baseline by REPLACING the file wrote one
  // pretty-printed JSON object. A reader that only understands the log
  // format would silently lose the baseline, and the guard would stop
  // firing without a word.
  const root = mkProject("legacy-sidecar");
  try {
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.mkdirSync(path.dirname(density.baselinePath(root)), { recursive: true });
    fs.writeFileSync(density.baselinePath(root), JSON.stringify({
      schemaVersion: "1.0",
      kind: "stamp",
      priority: 1,
      build_kind: "full",
      edge_node_ratio: 2.5,
      nodes: 100,
      edges: 250,
      baseline_locked_at: "2026-11-03T00:00:00.000Z",
    }, null, 2) + "\n");
    const sidecar = density.readBaselineSidecar(root);
    assert.ok(sidecar, "the legacy sidecar must be read");
    assert.equal(sidecar.edge_node_ratio, 2.5);
    assert.equal(sidecar.build_kind, "full");
  } finally {
    cleanup(root);
  }
});

test("regression: a legacy claim keeps the retry budget of its body", () => {
  // A claim of the older format carries no attempt suffix: its counter
  // lives in the body. A recovery that read the suffix -- or that reset
  // the counter -- gave a request that had already failed several times a
  // fresh budget.
  const root = mkProject("legacy-claim");
  try {
    const dir = density.pendingDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const stale = Date.now() - 7 * 60 * 60 * 1000;
    fs.writeFileSync(
      path.join(dir, ".claimed-999999-" + stale + "-abcdef123456.json"),
      JSON.stringify({
        changedPaths: ["src/legacy.js"],
        semanticPaths: [],
        sourceHead: null,
        branch: null,
        attempts: 3,
      }),
    );
    const taken = density.takePendingUpdate(root);
    assert.ok(taken, "the legacy claim must be recovered");
    assert.equal(taken.attempts, 3,
      "the budget of the body must survive the recovery");
    const names = pendingNames(root);
    assert.ok(names.some((n) => /-a3[.-]/.test(n)),
      "the recovered request must carry its budget: " + names.join(","));
  } finally {
    cleanup(root);
  }
});

test("regression: only the records a displaced holder published AFTER the loss are dropped", () => {
  // A holder that LOST the lock may still be alive and may still publish.
  // Its artifacts are fenced by its TOKEN, so only that holder is
  // distrusted -- a healthy holder that took the lock in the meantime
  // keeps its authority.
  //
  // The fence is PRECISE in time as well: everything the holder published
  // BEFORE it lost the lock was published while it still had the
  // authority, so it stays valid. Only what it publishes after the loss is
  // dropped -- otherwise the registration would delete the one baseline the
  // guard needs.
  const root = mkProject("displaced-holder");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const stamp = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      lockGeneration: lock.generation,
      lockToken: lock.token,
    });
    assert.equal(stamp.ok, true, "the stamp must succeed while the holder owns the lock");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5);

    // Another holder owns the path now: this holder was displaced without
    // knowing it.
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "other-holder",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      generation: lock.generation,
    }));
    const released = lock.release();
    assert.equal(released, false, "the release must report that the lock was not ours");

    // The publication that happened while the holder still owned the lock
    // is still valid: the guard must not lose its only baseline.
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "a record published before the loss must survive the registration");

    // A displaced holder may not publish any more.
    const after = density.stampBaseline(root, {
      nodes: 100,
      edges: 250,
      buildKind: "full",
      lockToken: lock.token,
    });
    assert.equal(after.ok, false, "a displaced holder must not publish");
    assert.equal(after.reason, "lock_displaced");

    // A record the displaced holder managed to append AFTER the loss -- it
    // passed the check before the loss and landed on disk after it -- is
    // dropped by the readers. It carries a publication sequence that is
    // higher than the one the holder had when it lost the lock.
    fs.appendFileSync(density.baselinePath(root), JSON.stringify({
      schemaVersion: "1.0",
      kind: "stamp",
      priority: 1,
      build_kind: "full",
      edge_node_ratio: 9,
      nodes: 100,
      edges: 900,
      baseline_locked_at: new Date(Date.now() + 60_000).toISOString(),
      lock_generation: lock.generation,
      lock_token: lock.token,
      sequence: 999,
    }) + "\n");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "a record published after the loss must be dropped by the readers");
  } finally {
    cleanup(root);
  }
});

test("regression: the coarse epoch fence advances when the token fence cannot be persisted", () => {
  // The epoch used to be a counter that was READ, incremented and written
  // back. Two publishers that read the same value wrote the same value
  // back, so the epoch went backwards -- and an epoch that goes backwards
  // is no fence at all.
  //
  // The epoch is now the COARSE fallback fence: it advances only when the
  // precise token fence cannot be persisted, because a holder that cannot
  // be fenced by its token has to be fenced by something. It is allocated
  // by an exclusive create, so it never goes backwards.
  const root = mkProject("epoch-monotonic");
  try {
    // The token fence needs a DIRECTORY it can write into. A regular file
    // in its place makes every registration fail, so the coarse fence is
    // the only one left.
    fs.mkdirSync(path.join(root, ".agent", "plugins", "graphify"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", ".density-displaced"),
      "not a directory\n",
    );

    const generations = [];
    for (let round = 0; round < 3; round += 1) {
      const lock = density.acquireRebuildLock(root);
      assert.ok(lock, "the lock must be acquired: round " + round);
      generations.push(lock.generation);
      // This holder is displaced: somebody else owns the path now. The
      // release cannot fence it by its token, so the coarse epoch advances.
      fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
        token: "other-holder-" + round,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        generation: lock.generation,
      }));
      assert.equal(lock.release(), false,
        "the release must report that the lock was not ours");
      // The other holder's record is still on disk. The test owns the
      // directory, so it clears it to let the next round acquire the lock.
      fs.rmSync(density.rebuildLockPath(root), { force: true });
    }
    for (let index = 1; index < generations.length; index += 1) {
      assert.ok(generations[index] > generations[index - 1],
        "the epoch must advance: " + generations.join(","));
    }

    // A holder that publishes under the OLD epoch is refused: the coarse
    // fence is the one that is left when the token fence failed.
    const stale = density.stampBaseline(root, {
      nodes: 100,
      edges: 200,
      buildKind: "full",
      lockGeneration: generations[0],
    });
    assert.equal(stale.ok, false, "a stamp under a stale epoch must be refused");
    assert.equal(stale.reason, "lock_generation_stale");
    assert.equal(density.readBaselineSidecar(root), null,
      "the refused stamp must not reach the disk");
  } finally {
    cleanup(root);
  }
});

test("regression: a short baseline append is reported as a failure", () => {
  // A write that lands only PART of the record leaves a fragment on disk.
  // Reporting that as a publication would tell the caller that the
  // baseline moved when it did not.
  const root = mkProject("short-append");
  try {
    const realWriteSync = fs.writeSync;
    fs.writeSync = function patched(fd, ...rest) {
      const first = rest[0];
      if (first && typeof first === "object" && typeof first.subarray === "function"
        && first.length > 8) {
        // The write lands SHORT: the tail of the record never reaches the
        // disk, so the file carries a fragment instead of a record.
        return realWriteSync.call(fs, fd, first.subarray(0, first.length - 8), ...rest.slice(1));
      }
      return realWriteSync.call(fs, fd, ...rest);
    };
    let stamp;
    try {
      stamp = density.stampBaseline(root, { nodes: 100, edges: 500, buildKind: "full" });
    } finally {
      fs.writeSync = realWriteSync;
    }
    assert.equal(stamp.ok, false, "a short write must not be reported as a publication");
    assert.equal(stamp.reason, "sidecar_write_failed");
    // The fragment is skipped by the reader instead of poisoning it.
    assert.equal(density.readBaselineSidecar(root), null);
  } finally {
    cleanup(root);
  }
});

// ─── Round 11: the reminders and the budgets that could still be lost ─────

test("regression: a reminder survives a writer that overwrites the derived file", () => {
  // The derived file is what the Graphify CLI reads. A writer that
  // overwrites it -- another tool, or a stale version of the framework --
  // must not be able to ERASE a reminder: the records are the truth, and
  // the file is only a view of them.
  const root = mkProject("marker-derived-overwrite");
  try {
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/keep.md"],
    });
    // Something overwrites the derived file with content of its own.
    fs.writeFileSync(
      path.join(graphDir, markers.MARKER_FILENAME),
      JSON.stringify({ kind: "semantic", changedPaths: [] }),
    );
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, true, "the reminder must still be readable");
    assert.deepEqual(after.marker.changedPaths, ["docs/keep.md"],
      "the reminder must survive the overwrite of the derived file");
  } finally {
    cleanup(root);
  }
});

test("regression: a crash between the record and the derived file loses no reminder", () => {
  // A process that dies after it published the record but before it
  // published the derived file leaves the reminder in its record only. The
  // reader derives the marker from the records, so the gap cannot become a
  // permanent loss -- and the derived file is restored.
  const root = mkProject("marker-derived-missing");
  try {
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/crash.md"],
    });
    fs.unlinkSync(path.join(graphDir, markers.MARKER_FILENAME));
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, true, "the reminder must survive the gap");
    assert.deepEqual(after.marker.changedPaths, ["docs/crash.md"]);
    assert.ok(fs.existsSync(path.join(graphDir, markers.MARKER_FILENAME)),
      "the derived file must be restored");
  } finally {
    cleanup(root);
  }
});

test("regression: a failed update does not downgrade an unanswered semantic reminder", () => {
  // The failed update used to write an `update_failed` marker that
  // REPLACED the semantic one. The next successful code-only update
  // cleared the `update_failed` marker -- and the semantic change lost the
  // only persistent trace of itself.
  //
  // The failure and the semantic reminder are two records now, so the
  // failure cannot take the semantic reminder's place.
  const root = mkProject("hook-failure-keeps-semantic");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root, { updateExit: 1 });
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/important.md"],
    });
    const failed = hook.runPostCommit({ cwd: root, changedPaths: ["src/module.js"] });
    assert.equal(failed.result, "incremental_failed",
      "the hook must report the failure: " + JSON.stringify(failed));
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, true, "the semantic reminder must still be there");
    assert.equal(after.marker.kind, markers.KIND.SEMANTIC,
      "the failure must not downgrade the semantic reminder");
    assert.ok(after.marker.changedPaths.includes("docs/important.md"),
      "the semantic paths must survive the failure");
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: a failed baseline migration keeps the _meta baseline", () => {
  // `graphify update .` rewrites graph.json and drops every key the CLI
  // does not own -- `_meta` included. So an incremental update that runs
  // after a FAILED migration destroys the only baseline the project has,
  // and the density guard can never fire again.
  //
  // The migration is fail-closed: when it fails, the update does not run.
  const root = mkProject("hook-migration-failure");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, {
      nodes: 100,
      edges: 500,
      meta: { edge_node_ratio: 5, nodes: 100, edges: 500, build_kind: "full" },
    });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    // The ticket directory cannot be created: a FILE is in its place, so
    // the migration cannot allocate the publication sequence it needs.
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", ".density-tickets"),
      "not a directory\n",
    );
    // The lock is held by this process, so the deferred drain that the hook
    // schedules cannot run an update behind the assertions.
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the test must hold the rebuild lock");
    const result = hook.runPostCommit({ cwd: root, changedPaths: ["src/module.js"] });
    assert.equal(result.ok, false, "the hook must report the failure");
    assert.equal(result.reason, "baseline_migration_failed");
    const calls = fs.existsSync(stub.log) ? fs.readFileSync(stub.log, "utf8") : "";
    assert.equal(calls.trim(), "",
      "the update must not run: it would delete the only baseline");
    const graph = JSON.parse(
      fs.readFileSync(path.join(root, "graphify-out", "graph.json"), "utf8"),
    );
    assert.equal(graph._meta.edge_node_ratio, 5, "the baseline must survive");
    lock.release();
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: a group that was never attempted keeps its retry budget", () => {
  // The drain hands a group back when it cannot publish. A group whose
  // update was never INVOKED -- because the lock was gone before the
  // attempt -- must not spend an attempt: five such losses would drop a
  // request that never ran once.
  const root = mkProject("drain-unattempted-budget");
  try {
    const stub = installStub(root);
    // The stub announces that it runs and then waits, so the thief below
    // can take the lock away WHILE the first group is being attempted --
    // no timing guess is involved.
    const signal = path.join(root, "update-started");
    const stubPath = path.join(stub.bin, "graphify");
    const stubBody = fs.readFileSync(stubPath, "utf8");
    fs.writeFileSync(stubPath, stubBody.replace(
      '  update) echo "update $@" >> "$LOG"; exit 0 ;;',
      '  update) echo "update $@" >> "$LOG"; touch "' + signal + '"; sleep 1; exit 0 ;;',
    ));
    fs.chmodSync(stubPath, 0o755);
    // Two groups: the first one is attempted, the second one finds the
    // lock gone.
    density.writePendingUpdate(root, {
      changedPaths: ["src/first.js"],
      semanticPaths: [],
      attempts: 0,
    });
    density.writePendingUpdate(root, {
      changedPaths: ["src/second.js"],
      semanticPaths: [],
      attempts: 1,
    });
    // The thief: it takes the lock away as soon as the first group is
    // running.
    const thief = path.join(root, "thief.js");
    fs.writeFileSync(thief, [
      "const fs = require('node:fs');",
      "const signal = process.argv[2];",
      "const lockPath = process.argv[3];",
      "const deadline = Date.now() + 30000;",
      "while (Date.now() < deadline) {",
      "  if (fs.existsSync(signal)) {",
      "    fs.writeFileSync(lockPath, JSON.stringify({",
      "      token: 'foreign-token',",
      "      pid: process.pid,",
      "      acquiredAt: new Date().toISOString(),",
      "      generation: 1,",
      "    }));",
      "    process.exit(0);",
      "  }",
      "  const buffer = new Int32Array(new SharedArrayBuffer(4));",
      "  Atomics.wait(buffer, 0, 0, 5);",
      "}",
    ].join("\n"));
    const thiefProcess = spawn(process.execPath, [thief, signal, density.rebuildLockPath(root)], {
      stdio: "ignore",
      detached: true,
    });
    thiefProcess.unref();
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner, "--drain-pending"], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.notEqual(run.status, 0, "the drain must report the failure");
    const names = pendingNames(root);
    // The group that WAS attempted loses its lock WHILE the update runs, so
    // its result cannot be trusted: it is not confirmed and it goes back to
    // the queue with its attempt counted. The group that was NEVER
    // attempted stays queued with its counter UNCHANGED.
    assert.equal(names.length, 2,
      "both groups must stay queued: " + names.join(","));
    for (const name of names) {
      const attempts = /-a(\d+)-/.exec(name);
      assert.ok(attempts, "the request must carry its counter: " + names.join(","));
      assert.equal(Number(attempts[1]), 1,
        "a group that was never attempted must not spend its retry budget: "
        + names.join(","));
    }
  } finally {
    cleanup(root);
  }
});

test("regression: a new semantic reminder subsumes the older one", () => {
  // Every reminder lives in its own record, so a queue of reminders would
  // grow without bound: a mixed commit publishes a semantic record every
  // time. A record that the new one SUBSUMES -- the same kind, and every
  // one of its paths among the new one's paths -- is removed, so the queue
  // stays at the reminders that are still outstanding.
  const root = mkProject("marker-compaction");
  try {
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/old.md"],
    });
    const recordsDir = path.join(graphDir, markers.MARKER_RECORDS_DIRNAME);
    assert.equal(fs.readdirSync(recordsDir).length, 1,
      "the first reminder is a record of its own");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_in_mixed_commit",
      changedPaths: ["docs/old.md", "docs/new.md"],
    });
    assert.equal(fs.readdirSync(recordsDir).length, 1,
      "the record that the new one subsumes must be removed");
    const after = markers.readMarker(graphDir);
    assert.deepEqual(after.marker.changedPaths, ["docs/new.md", "docs/old.md"],
      "the subsumed paths must survive in the new record");
  } finally {
    cleanup(root);
  }
});

test("regression: a marker of an older version is not lost when a new reminder is published", () => {
  // The single marker file of an older version is a reminder too. When the
  // next writer publishes its own reminder, the older one must not be
  // overwritten: it becomes a record of its own.
  const root = mkProject("marker-legacy-migration");
  try {
    const graphDir = path.join(root, "graphify-out");
    fs.writeFileSync(
      path.join(graphDir, markers.MARKER_FILENAME),
      JSON.stringify({
        schemaVersion: markers.MARKER_SCHEMA_VERSION,
        markerId: "legacy-marker",
        recordedAt: "2026-11-03T00:00:00.000Z",
        kind: markers.KIND.SEMANTIC,
        reason: "semantic_changes_only",
        changedPaths: ["docs/legacy.md"],
        sourceHead: null,
        branch: null,
      }, null, 2),
    );
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.UPDATE_FAILED,
      reason: "graphify_update_failed:1",
      changedPaths: ["src/a.js"],
    });
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, true, "the legacy reminder must still be readable");
    assert.ok(after.marker.changedPaths.includes("docs/legacy.md"),
      "the legacy reminder must survive the new one: "
      + JSON.stringify(after.marker.changedPaths));
  } finally {
    cleanup(root);
  }
});

test("regression: a legacy sidecar with a fragment after it is still read", () => {
  // A legacy sidecar that a later append left a FRAGMENT behind is
  // neither valid JSON nor a valid log: the pretty-printed object is
  // followed by a truncated line. The baseline it carries is still the
  // baseline the project has, so it must be read.
  const root = mkProject("legacy-sidecar-fragment");
  try {
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.mkdirSync(path.dirname(density.baselinePath(root)), { recursive: true });
    fs.writeFileSync(
      density.baselinePath(root),
      JSON.stringify({
        schemaVersion: "1.0",
        kind: "stamp",
        priority: 1,
        build_kind: "full",
        edge_node_ratio: 2.5,
        nodes: 100,
        edges: 250,
        baseline_locked_at: "2026-11-03T00:00:00.000Z",
      }, null, 2) + "\n" + '{"schemaVersion":"1.0","kind":"stamp","edge_node_ra',
    );
    const sidecar = density.readBaselineSidecar(root);
    assert.ok(sidecar, "the legacy sidecar must be read");
    assert.equal(sidecar.edge_node_ratio, 2.5);
    assert.equal(sidecar.build_kind, "full");
  } finally {
    cleanup(root);
  }
});

test("regression: a full rebuild answers the semantic reminder", () => {
  // A FULL rebuild rebuilds the semantic corpus as well -- that is what
  // separates it from an incremental update. So it answers the reminder
  // that says "the semantic corpus is stale". Without this the reminder
  // would outlive every rebuild, and the graph would fail closed for good.
  const root = mkProject("full-rebuild-clears-semantic");
  try {
    const stub = installStub(root);
    writeGraph(root, { nodes: 200, edges: 400 });
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/spec.md"],
    });
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.equal(run.status, 0, "the rebuild must succeed: " + run.stderr);
    const after = markers.readMarker(graphDir);
    assert.equal(after.ok, false,
      "the semantic reminder must be answered by the rebuild");
  } finally {
    cleanup(root);
  }
});

test("regression: a reminder published after the identity was read survives the clear", () => {
  // The compare-and-clear read the marker, checked its identity and then
  // RE-ENUMERATED the record directory. A reminder that a concurrent
  // writer published in that window was in the fresh enumeration, so it
  // was deleted together with the reminder that was actually answered --
  // and nothing would ever publish it again.
  const root = mkProject("clear-concurrent-record");
  try {
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.INCREMENTAL,
      reason: "first",
      changedPaths: ["src/a.js"],
    });
    const before = markers.readMarker(graphDir);
    assert.ok(before.ok, "the reminder must be readable");
    let concurrent = null;
    const result = markers.clearMarkerIfUnchanged(graphDir, before.identity, {
      kinds: markers.CLEARABLE_BY_INCREMENTAL,
      // The concurrent publication happens between the identity check and
      // the removal -- exactly the window the identity cannot see.
      onAfterRead: () => {
        concurrent = markers.writeMarker({
          graphDir,
          kind: markers.KIND.UPDATE_FAILED,
          reason: "concurrent",
          changedPaths: ["src/b.js"],
        });
      },
    });
    assert.ok(concurrent && concurrent.ok, "the concurrent reminder must be published");
    assert.ok(result.ok);
    const after = markers.readMarker(graphDir);
    assert.ok(after.ok, "the concurrent reminder must still be readable");
    assert.equal(after.records.length, 1,
      "only the reminder that was answered may be removed");
    assert.equal(after.records[0].kind, markers.KIND.UPDATE_FAILED);
  } finally {
    cleanup(root);
  }
});

test("regression: a semantic reminder published during the build survives the rebuild", async () => {
  // A full rebuild answers the reminders that existed when it took its
  // INPUT. A reminder that is published while the build runs describes a
  // change the build did not see, so clearing "every semantic reminder"
  // at the end of the build dropped a reminder that nothing answered.
  const root = mkProject("rebuild-during-build-reminder");
  try {
    const graphDir = path.join(root, "graphify-out");
    const stub = installStub(root);
    const signal = path.join(root, "extract-started");
    const graphFile = path.join(graphDir, "graph.json");
    const stubPath = path.join(stub.bin, "graphify");
    fs.writeFileSync(stubPath, [
      "#!/bin/sh",
      "LOG=\"" + stub.log + "\"",
      // The writer writes into the directory GRAPHIFY_OUT points at, like
      // the real CLI does.
      "OUT=\"$GRAPHIFY_OUT\"",
      "if [ -z \"$OUT\" ]; then OUT=\"" + path.join(root, "graphify-out") + "\"; fi",
      "mkdir -p \"$OUT\"",
      "case \"$1\" in",
      "  --version) echo 'graphify 0.9.27-stub'; exit 0 ;;",
      "  extract)",
      "    echo \"extract $@\" >> \"$LOG\";",
      "    touch \"" + signal + "\";",
      "    node -e \"const fs=require('fs');const n=200,e=400;const g={directed:true,multigraph:false,graph:{},nodes:Array.from({length:n},function(_,i){return {id:'n'+i};}),links:Array.from({length:e},function(_,i){return {source:'n'+(i%n),target:'n0'};}),hyperedges:[]};fs.writeFileSync(process.argv[1],JSON.stringify(g));\" \"$OUT/graph.json\";",
      "    sleep 1;",
      "    exit 0 ;;",
      "  update) echo \"update $@\" >> \"$LOG\"; exit 0 ;;",
      "  *) echo \"$@\" >> \"$LOG\"; exit 0 ;;",
      "esac",
      "",
    ].join("\n"));
    fs.chmodSync(stubPath, 0o755);
    // The reminder that the build DOES cover.
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "before_build",
      changedPaths: ["docs/before.md"],
    });
    // The reminder that is published WHILE the build runs.
    const publisher = path.join(root, "publisher.js");
    fs.writeFileSync(publisher, [
      "const fs = require('node:fs');",
      "const markers = require(" + JSON.stringify(path.join(ROOT, "lib", "graphify", "markers.js")) + ");",
      "const signal = process.argv[2];",
      "const graphDir = process.argv[3];",
      "const deadline = Date.now() + 30000;",
      "while (Date.now() < deadline) {",
      "  if (fs.existsSync(signal)) {",
      "    markers.writeMarker({ graphDir: graphDir, kind: markers.KIND.SEMANTIC, reason: 'during_build', changedPaths: ['docs/late.md'] });",
      "    process.exit(0);",
      "  }",
      "  const buffer = new Int32Array(new SharedArrayBuffer(4));",
      "  Atomics.wait(buffer, 0, 0, 10);",
      "}",
    ].join("\n"));
    const publisherProcess = spawn(process.execPath, [publisher, signal, graphDir], {
      cwd: root,
      stdio: "ignore",
      detached: true,
    });
    publisherProcess.unref();
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.equal(run.status, 0, "the rebuild must succeed: " + run.stderr);
    await sleep(500);
    const after = markers.readMarker(graphDir);
    assert.ok(after.ok, "the reminder of the running build must survive");
    assert.equal(after.records.length, 1,
      "only the reminder the build covered may be answered");
    assert.deepEqual(after.records[0].changedPaths, ["docs/late.md"]);
  } finally {
    cleanup(root);
  }
});

test("regression: the hook does not confirm a request whose lock was lost during the update", () => {
  // The lock can be taken away while the update runs. The request was then
  // confirmed on the strength of a graph that another holder may have
  // replaced -- and a confirmed request is never replayed.
  const root = mkProject("hook-lock-lost-during-update");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    const signal = path.join(root, "update-started");
    const stubPath = path.join(stub.bin, "graphify");
    fs.writeFileSync(stubPath, [
      "#!/bin/sh",
      "LOG=\"" + stub.log + "\"",
      "case \"$1\" in",
      "  --version) echo 'graphify 0.9.27-stub'; exit 0 ;;",
      "  update)",
      "    echo \"update $@\" >> \"$LOG\";",
      "    touch \"" + signal + "\";",
      "    sleep 1;",
      "    exit 0 ;;",
      "  *) echo \"$@\" >> \"$LOG\"; exit 0 ;;",
      "esac",
      "",
    ].join("\n"));
    fs.chmodSync(stubPath, 0o755);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400 });
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    // The thief: it takes the lock away while the update runs.
    const thief = path.join(root, "thief.js");
    fs.writeFileSync(thief, [
      "const fs = require('node:fs');",
      "const signal = process.argv[2];",
      "const lockPath = process.argv[3];",
      "const deadline = Date.now() + 30000;",
      "while (Date.now() < deadline) {",
      "  if (fs.existsSync(signal)) {",
      "    fs.writeFileSync(lockPath, JSON.stringify({",
      "      token: 'foreign-token',",
      "      pid: process.pid,",
      "      acquiredAt: new Date().toISOString(),",
      "      generation: 1,",
      "    }));",
      "    process.exit(0);",
      "  }",
      "  const buffer = new Int32Array(new SharedArrayBuffer(4));",
      "  Atomics.wait(buffer, 0, 0, 5);",
      "}",
    ].join("\n"));
    const thiefProcess = spawn(process.execPath, [thief, signal, density.rebuildLockPath(root)], {
      stdio: "ignore",
      detached: true,
    });
    thiefProcess.unref();
    const result = hook.runPostCommit({
      cwd: root,
      changedPaths: ["src/module.js"],
      sourceHead: "abc123",
      branch: "main",
    });
    assert.equal(result.result, "incremental_failed",
      "a request whose lock was lost must not be confirmed");
    assert.equal(result.reason, "rebuild_lock_lost_during_update");
    const names = pendingNames(root);
    assert.equal(names.length, 1,
      "the request must stay queued: " + names.join(","));
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: an older measurement published later does not win the baseline", () => {
  // The order of the baselines used to be decided by the wall clock, so a
  // build that measured an OLDER graph and was published LATE won -- and
  // the baseline was dragged back while the graph on disk was newer.
  const root = mkProject("baseline-input-order");
  try {
    const newer = density.stampBaseline(root, {
      nodes: 200,
      edges: 1000,
      sequence: 2,
      now: "2026-01-02T00:00:00.000Z",
    });
    assert.ok(newer.ok, "the newer measurement must be published");
    const older = density.stampBaseline(root, {
      nodes: 200,
      edges: 400,
      sequence: 1,
      now: "2026-01-03T00:00:00.000Z",
    });
    assert.equal(older.ok, false,
      "the older measurement must be refused");
    assert.equal(older.reason, "baseline_is_newer");
    const sidecar = density.readBaselineSidecar(root);
    assert.equal(Number(sidecar.edge_node_ratio), 5,
      "the baseline must stay at the newer measurement");
  } finally {
    cleanup(root);
  }
});

test("regression: a record that a displaced holder published after its loss is not trusted", () => {
  // The displacement threshold is the SIZE of the baseline log at the
  // moment of the loss. Everything the holder published before the loss
  // ends before the threshold, so it stays valid; everything it publishes
  // afterwards starts at or after it, and the readers drop it.
  //
  // The threshold used to be a SEPARATE registry of the published
  // sequences. The registry was a second write: a holder that appended
  // its record and was displaced before it could register the publication
  // lost a baseline it had published legitimately.
  const root = mkProject("displaced-unpublished");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const published = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      lockGeneration: lock.generation,
      lockToken: lock.token,
    });
    assert.equal(published.ok, true, "the publication must succeed");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5);

    // The holder loses the lock.
    assert.ok(lockLib.registerDisplaced(root, lock.token), "the holder must be fenced out");

    // The record it published BEFORE the loss stays valid: it is the one
    // baseline the guard needs.
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "a record published before the loss must survive the registration");

    // A record the displaced holder appends AFTER the loss is dropped. It
    // carries a higher sequence, so it would win the order if it were
    // trusted.
    fs.appendFileSync(density.baselinePath(root), JSON.stringify({
      schemaVersion: "1.0",
      kind: "stamp",
      priority: 1,
      build_kind: "full",
      edge_node_ratio: 9,
      nodes: 100,
      edges: 900,
      baseline_locked_at: new Date(Date.now() + 60_000).toISOString(),
      lock_generation: lock.generation,
      lock_token: lock.token,
      sequence: 999,
    }) + "\n");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "a record published after the loss must be dropped by the readers");

    // A record of a holder that never lost the lock is trusted.
    fs.appendFileSync(density.baselinePath(root), JSON.stringify({
      schemaVersion: "1.0",
      kind: "stamp",
      priority: 1,
      build_kind: "full",
      edge_node_ratio: 4,
      nodes: 100,
      edges: 400,
      baseline_locked_at: new Date(Date.now() + 120_000).toISOString(),
      lock_generation: lock.generation,
      lock_token: "healthy-holder",
      sequence: 1000,
    }) + "\n");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 4,
      "the record of a healthy holder must be trusted");
  } finally {
    cleanup(root);
  }
});

test("regression: a reclaim never takes the lock of a holder that took the path in the meantime", () => {
  // The reclaim MOVED the lock aside and looked at what it moved. The move
  // took the path away FIRST, so a holder that took the path in the window
  // between the judgement and the move lost its lock record -- and it
  // published its result over the graph of the holder that replaced it.
  //
  // The claim is a hard link plus an identity check now: the path is only
  // removed when it still holds the very instance that was judged stale.
  const root = mkProject("reclaim-identity");
  try {
    const file = density.rebuildLockPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A lock whose holder is gone and that is older than the stale window.
    fs.writeFileSync(file, JSON.stringify({
      token: "stale-token",
      pid: 999999,
      acquiredAt: new Date(Date.now() - 3600_000).toISOString(),
      generation: 0,
    }));
    let second = null;
    const acquired = lockLib.acquireRebuildLock(root, {
      staleMs: 1000,
      // A second holder takes the lock while the first reclaim is paused.
      onStaleJudged: () => {
        second = lockLib.acquireRebuildLock(root, { staleMs: 1000 });
      },
    });
    assert.equal(acquired, null,
      "the reclaim must be refused: the lock at the path is a different one");
    assert.ok(second, "the second holder must have taken the lock");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.token, second.token,
      "the lock of the holder that took the path must survive the reclaim");
    assert.equal(second.isHeld(), true,
      "the holder that took the path must still own the lock");
    second.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a holder that lost the lock does not publish the graph", () => {
  // The update REWRITES the graph, and the framework cannot make that a
  // transaction: it can only decide whether the rewrite may happen, and
  // it can undo a rewrite that was not allowed.
  //
  // The update therefore runs under a guard that watches the lock while it
  // runs: a holder that lost the lock is stopped, and the graph it
  // published is put back.
  const root = mkProject("guarded-update");
  try {
    const bin = path.join(root, "stub-bin");
    fs.mkdirSync(bin, { recursive: true });
    const graphFile = path.join(root, "graphify-out", "graph.json");
    const script = path.join(bin, "graphify");
    fs.writeFileSync(script, [
      "#!/bin/sh",
      // The writer writes into the directory GRAPHIFY_OUT points at, like
      // the real CLI does. The framework publishes the staged graph itself,
      // so a writer that touches the public graph is caught.
      "OUT=\"${GRAPHIFY_OUT:-" + graphFile.replace(/graph\.json$/, "") + "}\"",
      "mkdir -p \"$OUT\"",
      "printf '{\"nodes\":[{\"id\":\"a\"}],\"links\":[]}' > \"$OUT/graph.json\"",
      "sleep 30",
      "",
    ].join("\n"));
    fs.chmodSync(script, 0o755);
    writeGraph(root, { nodes: 200, edges: 400 });
    const before = fs.readFileSync(graphFile, "utf8");

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    // Another holder takes the lock while the update runs.
    const thief = spawn(process.execPath, ["-e", [
      "setTimeout(() => {",
      "  require('node:fs').writeFileSync("
        + JSON.stringify(density.rebuildLockPath(root))
        + ", JSON.stringify({ token: 'thief', pid: process.pid,"
        + " acquiredAt: new Date().toISOString(), generation: 0 }));",
      "}, 400);",
    ].join("\n")], { stdio: "ignore" });
    const result = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock,
      timeoutMs: 30_000,
      env: { PATH: bin + ":" + process.env.PATH },
    });
    thief.kill();
    assert.equal(result.ok, false, "the update must not be reported as a success");
    assert.equal(result.lockLost, true, "the loss of the lock must be reported");
    const after = fs.readFileSync(graphFile, "utf8");
    assert.equal(after, before,
      "the graph of the holder that lost the lock must not survive");
  } finally {
    cleanup(root);
  }
});

test("regression: a holder that was fenced out does not believe it owns the lock", () => {
  // The lock file can still carry the token of a holder that was fenced
  // out -- when the reclaim could not put the record back, for instance.
  // A holder that only looked at the file believed it still owned the lock,
  // and it published its result over the graph of the holder that
  // replaced it.
  const root = mkProject("fenced-holder");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    assert.equal(lock.isHeld(), true, "the holder owns the lock");
    assert.ok(lockLib.registerDisplaced(root, lock.token),
      "the holder must be registered as displaced");
    assert.equal(lock.isHeld(), false,
      "a fenced holder must not believe it owns the lock");
    const onDisk = JSON.parse(fs.readFileSync(density.rebuildLockPath(root), "utf8"));
    assert.equal(onDisk.token, lock.token,
      "the lock file still carries the token: the registry is the fence");
  } finally {
    cleanup(root);
  }
});

test("regression: a stamp that the readers drop is not a success", () => {
  // The stamp appended its record and then reported the record it wrote
  // as the published baseline -- even when the readers DROPPED that
  // record, because the holder was displaced while it was written. The
  // caller believed that the baseline moved forward while it did not.
  const root = mkProject("stamp-publication-rejected");
  try {
    const stamp = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      lockToken: "displaced-token",
      // The holder is displaced between the check and the append.
      onBeforeAppend: () => {
        assert.ok(lockLib.registerDisplaced(root, "displaced-token"));
      },
    });
    assert.equal(stamp.ok, false, "a stamp that was dropped must not succeed");
    assert.equal(stamp.reason, "publication_rejected");
    assert.equal(density.readBaselineSidecar(root), null,
      "the baseline must not have moved");
  } finally {
    cleanup(root);
  }
});

test("regression: two publications in the same millisecond are ordered by the allocator", () => {
  // A publication that does not bring a sequence used to be published with
  // the sequence ZERO: the allocator never ran, and two publications of
  // the same millisecond carried the same order.
  const root = mkProject("sequence-allocated");
  try {
    const now = new Date().toISOString();
    const first = density.stampBaseline(root, {
      nodes: 100, edges: 200, buildKind: "full", now,
    });
    const second = density.stampBaseline(root, {
      nodes: 100, edges: 1000, buildKind: "full", now,
    });
    assert.equal(first.ok, true, "the first publication must succeed");
    assert.equal(second.ok, true, "the second publication must succeed");
    assert.notEqual(first.payload.sequence, second.payload.sequence,
      "the allocator must hand out a sequence of its own");
    assert.notEqual(first.payload.sequence, 0,
      "the sequence zero is not a sequence");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 10,
      "the publication that came last must be the baseline in effect");
  } finally {
    cleanup(root);
  }
});

test("regression: a full rebuild answers the legacy single-file reminder", () => {
  // The rebuild answers the reminders that existed at its INPUT boundary.
  // The reminder of an older version is the single file, and it was left
  // behind: the rebuild cleared the records it captured and the legacy
  // reminder outlived every rebuild.
  const root = mkProject("full-rebuild-clears-legacy");
  try {
    const stub = installStub(root);
    writeGraph(root, { nodes: 200, edges: 400 });
    const graphDir = path.join(root, "graphify-out");
    const legacyPath = path.join(graphDir, ".graphify-stale.json");
    fs.writeFileSync(legacyPath, JSON.stringify({
      schemaVersion: "1.0",
      markerId: "legacy-reminder",
      recordedAt: new Date().toISOString(),
      kind: "semantic",
      reason: "semantic_changes_only",
      changedPaths: ["docs/spec.md"],
      sourceHead: null,
      branch: null,
    }, null, 2));
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.equal(run.status, 0, "the rebuild must succeed: " + run.stderr);
    assert.equal(fs.existsSync(legacyPath), false,
      "the legacy reminder must be answered by the rebuild");
  } finally {
    cleanup(root);
  }
});

test("regression: a derived view without records is not a reminder", () => {
  // The single file is the DERIVED view of the records. When there are no
  // records, the view is stale: it describes reminders that were answered
  // already. A reader that fell back to it resurrected a reminder that a
  // full rebuild had answered.
  const root = mkProject("stale-derived-view");
  try {
    const graphDir = path.join(root, "graphify-out");
    const markerPath = path.join(graphDir, ".graphify-stale.json");
    fs.writeFileSync(markerPath, JSON.stringify({
      schemaVersion: "1.0",
      markerId: "derived-1",
      recordedAt: new Date().toISOString(),
      kind: "semantic",
      reason: "semantic_changes_only",
      changedPaths: ["docs/spec.md"],
      sourceHead: null,
      branch: null,
      recordIds: ["answered-reminder"],
    }, null, 2));
    const read = markers.readMarker(graphDir);
    assert.equal(read.ok, false, "a stale view must not be a reminder");
    assert.equal(read.reason, "marker_missing");
    assert.equal(fs.existsSync(markerPath), false,
      "the stale view must be removed");
  } finally {
    cleanup(root);
  }
});

test("regression: a derived view that cannot be published is reported", () => {
  // The records were removed, but the view that the single-file consumers
  // read could not be published. The caller has to be told: a consumer
  // that reads the file would still see the reminder that was answered.
  const root = mkProject("derived-write-failure");
  try {
    const graphDir = path.join(root, "graphify-out");
    const written = markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/spec.md"],
    });
    assert.ok(written.ok, "the reminder must be published");
    // The path of the derived view is taken by a directory: the rename
    // that publishes the view cannot succeed.
    const markerPath = path.join(graphDir, ".graphify-stale.json");
    fs.rmSync(markerPath, { force: true });
    fs.mkdirSync(markerPath);
    const cleared = markers.clearMarkerRecords(graphDir, {
      recordIds: markers.listRecordIds(graphDir, { kinds: [markers.KIND.SEMANTIC] }),
      kinds: [markers.KIND.SEMANTIC],
    });
    assert.equal(cleared.ok, false,
      "a view that could not be published must be reported");
  } finally {
    cleanup(root);
  }
});

test("regression: a failed full rebuild keeps the reminders", () => {
  // A rebuild that failed answered nothing: the reminders it captured
  // describe a change that is still not in the graph.
  const root = mkProject("failed-rebuild-keeps-reminders");
  try {
    const stub = installStub(root, { extractExit: 1 });
    writeGraph(root, { nodes: 200, edges: 400 });
    const graphDir = path.join(root, "graphify-out");
    markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/spec.md"],
    });
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.equal(run.status, 1, "the rebuild must fail: " + run.stderr);
    const after = markers.readMarker(graphDir);
    assert.ok(after.ok, "the reminder must survive a failed rebuild");
    assert.equal(after.records.length, 1);
    assert.equal(after.records[0].kind, markers.KIND.SEMANTIC);
  } finally {
    cleanup(root);
  }
});

test("regression: the compaction never removes a reminder a concurrent writer published", () => {
  // The compaction removes the reminders that the new record SUBSUMES. A
  // reminder that a concurrent writer published in the meantime was not
  // subsumed by anything -- the new record does not know about it -- so it
  // must survive.
  const root = mkProject("compaction-concurrent");
  try {
    const graphDir = path.join(root, "graphify-out");
    const written = markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "semantic_changes_only",
      changedPaths: ["docs/spec.md"],
      onBeforeCompaction: () => {
        markers.writeMarker({
          graphDir,
          kind: markers.KIND.SEMANTIC,
          reason: "concurrent",
          changedPaths: ["docs/spec.md"],
        });
      },
    });
    assert.ok(written.ok, "the reminder must be published");
    const ids = markers.listRecordIds(graphDir);
    assert.equal(ids.length, 1,
      "the reminder of the concurrent writer must survive the compaction");
    const remaining = JSON.parse(fs.readFileSync(
      path.join(graphDir, ".graphify-stale-records", ids[0] + ".json"),
      "utf8",
    ));
    assert.equal(remaining.reason, "concurrent",
      "the reminder that is left must be the one of the concurrent writer");
  } finally {
    cleanup(root);
  }
});

test("regression: the drain does not replay a request whose baseline cannot be migrated", () => {
  // Every path that rewrites the graph must pass the migration
  // precondition: `graphify update .` drops the `_meta` baseline, so a
  // drain that updates without migrating destroys the only baseline the
  // project has.
  const root = mkProject("drain-migration-precondition");
  try {
    const stub = installStub(root);
    writeGraph(root, { nodes: 200, edges: 400, meta: { edge_node_ratio: 5 } });
    // The ticket directory cannot be created: the sequence of the
    // migration cannot be allocated.
    fs.writeFileSync(density.pluginDir(root) + "/.density-tickets", "blocked");
    density.writePendingUpdate(root, { changedPaths: ["src/a.js"], attempts: 0 });
    const runner = path.join(ROOT, "lib", "graphify", "full-rebuild-runner.js");
    const run = spawnSync(process.execPath, [runner, "--drain-pending"], {
      cwd: root,
      encoding: "utf8",
      env: stubEnv(stub),
      timeout: 60_000,
    });
    assert.notEqual(run.status, 0, "the drain must report the failure");
    const calls = fs.existsSync(stub.log)
      ? fs.readFileSync(stub.log, "utf8").trim().split("\n").filter(Boolean)
      : [];
    assert.equal(calls.filter((line) => line.startsWith("update")).length, 0,
      "the update must not run while the baseline cannot be migrated");
    const names = pendingNames(root);
    assert.equal(names.length, 1,
      "the request must stay queued: " + names.join(","));
    assert.ok(/-a0-/.test(names[0]),
      "a request that was never attempted must not spend its budget: " + names.join(","));
    const graph = JSON.parse(
      fs.readFileSync(path.join(root, "graphify-out", "graph.json"), "utf8"),
    );
    assert.equal(Number(graph._meta.edge_node_ratio), 5,
      "the baseline must survive");
  } finally {
    cleanup(root);
  }
});

test("regression: a graph that cannot be read is not a graph without a baseline", () => {
  // A read failure used to be reported as "there is no baseline", so the
  // incremental update ran and destroyed the only baseline the project had.
  const root = mkProject("unreadable-graph");
  const oldPath = process.env.PATH;
  try {
    const stub = installStub(root);
    process.env.PATH = stub.bin + ":" + oldPath;
    writeGraph(root, { nodes: 200, edges: 400, meta: { edge_node_ratio: 5 } });
    // The graph cannot be read: the path is a directory.
    const graphPath = path.join(root, "graphify-out", "graph.json");
    fs.unlinkSync(graphPath);
    fs.mkdirSync(graphPath);
    fs.writeFileSync(
      path.join(root, ".agent", "plugins", "graphify", "config.yml"),
      "enabled: true\n",
    );
    const result = hook.runPostCommit({
      cwd: root,
      changedPaths: ["src/module.js"],
      sourceHead: "abc123",
      branch: "main",
    });
    assert.equal(result.result, "incremental_failed",
      "the hook must fail closed when the graph cannot be read");
    assert.equal(result.reason, "baseline_migration_failed");
    const calls = fs.existsSync(stub.log)
      ? fs.readFileSync(stub.log, "utf8").trim().split("\n").filter(Boolean)
      : [];
    assert.equal(calls.filter((line) => line.startsWith("update")).length, 0,
      "the update must not run while the baseline cannot be read");
  } finally {
    process.env.PATH = oldPath;
    cleanup(root);
  }
});

test("regression: the derived view is repaired when it does not describe the records", () => {
  // The derived file is a cache. Two writers can publish their records and
  // their views in any order, so the file on disk can name fewer records
  // than the ones that exist -- and a single-file consumer would miss a
  // reminder that the records still hold.
  const root = mkProject("derived-view-repair");
  try {
    const graphDir = path.join(root, "graphify-out");
    const first = markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "first",
      changedPaths: ["docs/a.md"],
    });
    assert.ok(first.ok);
    // A second record that no view describes.
    const secondId = "second-record";
    fs.writeFileSync(
      path.join(graphDir, ".graphify-stale-records", secondId + ".json"),
      JSON.stringify({
        schemaVersion: markers.MARKER_SCHEMA_VERSION,
        markerId: secondId,
        recordedAt: new Date().toISOString(),
        kind: markers.KIND.SEMANTIC,
        reason: "second",
        changedPaths: ["docs/b.md"],
        sourceHead: null,
        branch: null,
      }, null, 2),
    );
    const read = markers.readMarker(graphDir);
    assert.ok(read.ok);
    assert.equal(read.records.length, 2, "both records must be readable");
    const view = JSON.parse(
      fs.readFileSync(path.join(graphDir, ".graphify-stale.json"), "utf8"),
    );
    assert.equal(view.recordIds.length, 2,
      "the derived view must describe every record");
  } finally {
    cleanup(root);
  }
});

test("regression: a derived view is never re-imported as a reminder", () => {
  // The derived file outlives the records it describes. A writer that read
  // it as if it were a LEGACY reminder re-created the reminder that the
  // last clear had answered.
  const root = mkProject("derived-view-reimport");
  try {
    const graphDir = path.join(root, "graphify-out");
    const first = markers.writeMarker({
      graphDir,
      kind: markers.KIND.SEMANTIC,
      reason: "answered",
      changedPaths: ["docs/answered.md"],
    });
    assert.ok(first.ok);
    // The reminder is answered: its record is gone, the derived view still
    // names it.
    fs.unlinkSync(
      path.join(graphDir, ".graphify-stale-records", first.markerId + ".json"),
    );
    const next = markers.writeMarker({
      graphDir,
      kind: markers.KIND.INCREMENTAL,
      reason: "next",
      changedPaths: ["src/next.js"],
    });
    assert.ok(next.ok);
    const ids = markers.listRecordIds(graphDir);
    assert.equal(ids.length, 1,
      "the answered reminder must not be re-imported: " + ids.join(","));
    assert.equal(ids[0], next.markerId);
  } finally {
    cleanup(root);
  }
});

test("regression: a legacy baseline object is not lost to a later migration record", () => {
  // The sidecar may hold a legacy pretty-printed object AND the records
  // that were appended after it. A reader that stopped at the first
  // parsable line threw the legacy object away -- and the legacy object is
  // often the MEASURED baseline, which must not be displaced by a later
  // migration.
  const root = mkProject("legacy-baseline-mixed");
  try {
    const sidecar = density.baselinePath(root);
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, [
      "{",
      '  "edge_node_ratio": 5,',
      '  "priority": 1,',
      '  "kind": "stamp",',
      '  "baseline_locked_at": "2026-01-01T00:00:00.000Z"',
      "}",
      JSON.stringify({
        edge_node_ratio: 2,
        priority: 0,
        kind: "migration",
        baseline_locked_at: "2026-01-02T00:00:00.000Z",
      }),
      "",
    ].join("\n"));
    const sidecarValue = density.readBaselineSidecar(root);
    assert.ok(sidecarValue, "the sidecar must be readable");
    assert.equal(Number(sidecarValue.edge_node_ratio), 5,
      "the measured legacy baseline must win over the later migration");
  } finally {
    cleanup(root);
  }
});

// ─── The scenarios the protocol has to keep honest ────────────────────────
//
// The independent review asked for four scenarios that the regressions
// did not pin down yet: an existing baseline with a THIRD holder, a writer
// that is faster than the poll that watches the lock, a descendant that
// survives the writer, and a real rollback that would hit the wrong file.
//
// Every test below asserts what ends up ON DISK and whether a later write
// still works -- not only the return code of a call.

test("regression: a reclaim leaves the lock of a live holder that took the path alone", () => {
  // The reclaim judged a lock whose holder is gone, and then it took the
  // path away. The path was the only record of the lock, so a holder that
  // took the path in the window between the judgement and the takeover
  // lost its lock record -- and the reclaim ended with a refusal anyway,
  // which HID the transient removal.
  //
  // The claim compares the identity of the instance that was JUDGED with
  // the identity of the instance that is at the path NOW. A holder that
  // took the path in the meantime keeps its lock, and it can still write.
  const root = mkProject("reclaim-live-holder");
  try {
    // A baseline that the reclaim must not touch.
    const seed = density.acquireRebuildLock(root);
    assert.ok(seed, "the seed lock must be acquired");
    const seeded = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      lockGeneration: seed.generation,
      lockToken: seed.token,
    });
    assert.equal(seeded.ok, true, "the baseline must be published");
    seed.release();

    // A lock whose holder is gone, and that is older than the stale window.
    const file = density.rebuildLockPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      token: "stale-token",
      pid: 999999,
      acquiredAt: new Date(Date.now() - 3600_000).toISOString(),
      generation: 0,
    }));

    let live = null;
    const acquired = density.acquireRebuildLock(root, {
      staleMs: 1000,
      // The live holder takes the path in the window between the judgement
      // and the takeover.
      onStaleJudged: () => {
        live = density.acquireRebuildLock(root, { staleMs: 1000 });
      },
      // A holder that takes the path AFTER the claim took the path away.
      onLockMoved: () => {
        fs.writeFileSync(file, JSON.stringify({
          token: "window-token",
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          generation: 0,
        }));
      },
    });
    assert.equal(acquired, null, "the reclaim must be refused");
    assert.ok(live, "the live holder must have taken the lock");
    assert.equal(live.isHeld(), true,
      "the lock of the live holder must survive the reclaim");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.token, live.token,
      "the lock at the path must still be the one of the live holder");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "the baseline of the project must not have moved");
    // The live holder can still publish AFTER the reclaim.
    const republished = density.stampBaseline(root, {
      nodes: 100,
      edges: 600,
      buildKind: "full",
      lockGeneration: live.generation,
      lockToken: live.token,
    });
    assert.equal(republished.ok, true,
      "the live holder must still be able to publish");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 6,
      "the baseline must have moved to the new measurement");
    live.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a publication that the readers drop is not a success when an older baseline exists", () => {
  // The stamp confirmed its publication by looking for a record with the
  // SAME IDENTITY. When the record was dropped by the readers -- because
  // the holder was displaced while the record was written -- the stamp
  // has to fail.
  //
  // The older baseline is what made this invisible: without it there was
  // no winner either, so the refusal happened for a different reason and
  // the missing identity check was not noticed.
  const root = mkProject("dropped-publication-with-old-winner");
  try {
    const seed = density.acquireRebuildLock(root);
    assert.ok(seed, "the seed lock must be acquired");
    const seeded = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      lockGeneration: seed.generation,
      lockToken: seed.token,
    });
    assert.equal(seeded.ok, true, "the baseline must be published");
    seed.release();
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5);

    const dropped = density.stampBaseline(root, {
      nodes: 100,
      edges: 900,
      buildKind: "full",
      lockToken: "displaced-token",
      // The holder is displaced between the comparison and the append, so
      // the readers drop the record it wrote.
      onBeforeAppend: () => {
        assert.ok(lockLib.registerDisplaced(root, "displaced-token"));
      },
    });
    assert.equal(dropped.ok, false,
      "a publication that the readers drop must not be a success");
    assert.equal(dropped.reason, "publication_rejected");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "the baseline on disk must still be the old one");

    // A healthy holder can still publish afterwards.
    const healthy = density.acquireRebuildLock(root);
    assert.ok(healthy, "the healthy holder must be able to take the lock");
    const stamped = density.stampBaseline(root, {
      nodes: 100,
      edges: 700,
      buildKind: "full",
      lockGeneration: healthy.generation,
      lockToken: healthy.token,
    });
    assert.equal(stamped.ok, true,
      "a healthy holder must still be able to publish");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 7,
      "the baseline must have moved to the new measurement");
    healthy.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a writer that finishes before the poll cannot publish over the graph", () => {
  // The lock is taken away while the writer runs, and the writer is faster
  // than the poll that watches the lock: the supervisor may never see the
  // loss. The publication is the LAST gate, and it asks the lock whether
  // it is still held -- the result of the writer alone is not enough.
  const root = mkProject("fast-writer-lost-lock");
  try {
    const stub = installStub(root);
    const graphFile = path.join(root, "graphify-out", "graph.json");
    writeGraph(root, { nodes: 200, edges: 400 });
    const before = fs.readFileSync(graphFile, "utf8");

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    // The lock is taken over by somebody else before the writer starts.
    fs.writeFileSync(density.rebuildLockPath(root), JSON.stringify({
      token: "thief",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      generation: 0,
    }));

    const result = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock,
      timeoutMs: 30_000,
      env: { PATH: stub.bin + ":" + process.env.PATH },
    });
    assert.equal(result.ok, false,
      "an update that lost the lock must not be reported as a success");
    const after = fs.readFileSync(graphFile, "utf8");
    assert.equal(after, before,
      "the graph of the holder that took over must survive");

    // A later write still works.
    fs.unlinkSync(density.rebuildLockPath(root));
    const healthy = density.acquireRebuildLock(root);
    assert.ok(healthy, "a healthy holder must be able to take the lock");
    const published = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock: healthy,
      timeoutMs: 30_000,
      env: { PATH: stub.bin + ":" + process.env.PATH },
    });
    assert.equal(published.ok, true,
      "the healthy holder must be able to publish: " + published.reason);
    const graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.equal(graph.nodes.length, 2,
      "the published graph must be the one of the writer");
    healthy.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a failed build does not roll the graph of a concurrent publication back", async () => {
  // The old implementation kept a snapshot of the public graph and put it
  // back when the update failed. The snapshot is a copy of "whatever is
  // on disk", so a FAILED build could overwrite the graph that a healthy
  // holder published while the build was running.
  //
  // There is no rollback any more: the writer works on a private staging
  // area, and the publication is the only thing that touches the public
  // graph. A failed build therefore leaves every publication alone.
  const root = mkProject("failed-build-no-rollback");
  try {
    const graphFile = path.join(root, "graphify-out", "graph.json");
    const graphDir = path.join(root, "graphify-out");
    writeGraph(root, { nodes: 200, edges: 400 });

    // The writer fails after a moment.
    const stub = installStub(root);
    const stubPath = path.join(stub.bin, "graphify");
    fs.writeFileSync(stubPath, [
      "#!/bin/sh",
      "sleep 1",
      "exit 3",
      "",
    ].join("\n"));
    fs.chmodSync(stubPath, 0o755);

    // The healthy holder that publishes while the failing build runs.
    const publisher = path.join(root, "publisher.js");
    fs.writeFileSync(publisher, [
      "const fs = require('node:fs');",
      "const markers = require(" + JSON.stringify(path.join(ROOT, "lib", "graphify", "markers.js")) + ");",
      "const graphFile = process.argv[2];",
      "const graphDir = process.argv[3];",
      "const buffer = new Int32Array(new SharedArrayBuffer(4));",
      "Atomics.wait(buffer, 0, 0, 400);",
      "fs.writeFileSync(graphFile, JSON.stringify({ directed: true, multigraph: false, graph: {}, nodes: [{ id: 'published' }, { id: 'by' }, { id: 'holder' }], links: [], hyperedges: [] }));",
      "markers.writeMarker({ graphDir: graphDir, kind: markers.KIND.SEMANTIC, reason: 'during_failed_build', changedPaths: ['docs/late.md'] });",
      "",
    ].join("\n"));

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const publisherProcess = spawn(process.execPath, [publisher, graphFile, graphDir], {
      cwd: root,
      stdio: "ignore",
      detached: true,
    });
    publisherProcess.unref();
    const result = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock,
      timeoutMs: 30_000,
      env: { PATH: stub.bin + ":" + process.env.PATH },
    });
    assert.equal(result.ok, false, "the failing update must not be a success");
    await new Promise((resolve) => publisherProcess.on("exit", resolve));

    const graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.deepEqual(graph.nodes.map((node) => node.id), ["published", "by", "holder"],
      "the graph of the concurrent publication must survive the failed build");
    const reminder = markers.readMarker(graphDir);
    assert.ok(reminder.ok, "the reminder must still be readable");
    assert.equal(reminder.records.length, 1,
      "the reminder published during the failed build must survive");
    assert.deepEqual(reminder.records[0].changedPaths, ["docs/late.md"]);
    lock.release();

    // A later write still works.
    const healthy = density.acquireRebuildLock(root);
    assert.ok(healthy, "a healthy holder must be able to take the lock");
    const good = installStub(root);
    const published = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock: healthy,
      timeoutMs: 30_000,
      env: { PATH: good.bin + ":" + process.env.PATH },
    });
    assert.equal(published.ok, true,
      "the healthy holder must be able to publish: " + published.reason);
    const after = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.equal(after.nodes.length, 2,
      "the published graph must be the one of the writer");
    healthy.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a descendant that survives the writer can only reach the staging area", async () => {
  // A writer can leave a descendant behind that outlives the supervision.
  // The descendant inherits the staging directory, so it can only ever
  // write into the area that is thrown away -- the published graph is out
  // of its reach.
  const root = mkProject("surviving-descendant");
  try {
    const graphFile = path.join(root, "graphify-out", "graph.json");
    writeGraph(root, { nodes: 200, edges: 400 });

    // The descendant leaves the process group of the writer and writes
    // into the staging area long after the writer is gone.
    const escape = path.join(root, "escape.js");
    fs.writeFileSync(escape, [
      "const { spawn } = require('node:child_process');",
      "const out = process.argv[2];",
      "const target = out + '/graph.json';",
      "const payload = JSON.stringify({ nodes: [{ id: 'evil' }], links: [] });",
      "const code = \"const fs=require('node:fs');setTimeout(function(){try{fs.writeFileSync(process.argv[1], process.argv[2])}catch(e){}},1200);\";",
      "spawn(process.execPath, ['-e', code, target, payload], { detached: true, stdio: 'ignore' }).unref();",
      "",
    ].join("\n"));
    const stub = installStub(root);
    const stubPath = path.join(stub.bin, "graphify");
    fs.writeFileSync(stubPath, [
      "#!/bin/sh",
      "OUT=\"${GRAPHIFY_OUT:-$PWD/graphify-out}\"",
      "mkdir -p \"$OUT\"",
      "printf '{\"nodes\":[{\"id\":\"a\"},{\"id\":\"b\"}],\"links\":[{\"source\":\"a\",\"target\":\"b\"}]}' > \"$OUT/graph.json\"",
      "node \"" + escape + "\" \"$OUT\"",
      "exit 0",
      "",
    ].join("\n"));
    fs.chmodSync(stubPath, 0o755);

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const result = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock,
      timeoutMs: 30_000,
      env: { PATH: stub.bin + ":" + process.env.PATH },
    });
    assert.equal(result.ok, true,
      "the update must succeed: " + (result.reason || result.stderr));
    const published = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.equal(published.nodes.length, 2,
      "the published graph must be the one of the writer");
    lock.release();

    // The descendant wakes up long after the publication.
    await sleep(1800);
    const after = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.equal(after.nodes.length, 2,
      "the published graph must survive the descendant");
    assert.ok(!after.nodes.some((node) => node.id === "evil"),
      "the descendant must not reach the published graph");
    const staging = path.join(root, ".agent", "plugins", "graphify", ".density-staging");
    const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
    assert.deepEqual(leftovers, [],
      "the staging area must be empty: " + leftovers.join(", "));
  } finally {
    cleanup(root);
  }
});

test("regression: a publication is refused when the lock is not held any more", () => {
  // The publication is the LAST gate before the public graph is written.
  // The supervisor watches the lock WHILE the writer runs, but a writer
  // that is faster than that watch -- or a lock that was taken over in
  // the window between the end of the writer and the publication -- is
  // only caught here. The staged graph must not reach the public graph.
  const root = mkProject("publication-gate");
  try {
    const graphFile = path.join(root, "graphify-out", "graph.json");
    writeGraph(root, { nodes: 200, edges: 400 });
    const before = fs.readFileSync(graphFile, "utf8");

    const staging = path.join(
      root, ".agent", "plugins", "graphify", ".density-staging", "staged-1",
    );
    updateLib.prepareStaging(root, staging);
    fs.writeFileSync(path.join(staging, "graph.json"), JSON.stringify({
      directed: true,
      multigraph: false,
      graph: {},
      nodes: [{ id: "staged" }],
      links: [],
      hyperedges: [],
    }));

    const refused = updateLib.publishStagedOutput(root, staging, {
      isHeld: () => false,
    });
    assert.equal(refused.ok, false,
      "a publication without the lock must be refused");
    assert.equal(refused.reason, "lock_lost");
    assert.equal(fs.readFileSync(graphFile, "utf8"), before,
      "the public graph must not have been written");

    // The positive control: a holder that still owns the lock publishes.
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const published = updateLib.publishStagedOutput(root, staging, lock);
    assert.equal(published.ok, true,
      "the holder that owns the lock must be able to publish: " + published.reason);
    const after = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.equal(after.nodes.length, 1,
      "the published graph must be the staged one");
    assert.equal(after.nodes[0].id, "staged");
    lock.release();
  } finally {
    cleanup(root);
  }
});

// ─── The mechanisms the previous round found under-constrained ────────────

test("regression: the participant with the lowest ticket holds the gate", () => {
  // The gate is a mutual exclusion, and the exclusion is the election: the
  // participant with the LOWEST live ticket is the one inside the
  // protocol. Without the election every participant would believe that
  // it holds the gate, and two of them would publish at the same time.
  const root = mkProject("gate-lowest-ticket");
  try {
    const gate = require("../../lib/graphify/density-gate");
    const dir = gate.gateDir(root, "election");
    fs.mkdirSync(dir, { recursive: true });
    // A participant that is alive and holds the lower ticket.
    fs.writeFileSync(path.join(dir, "gate-1.json"), JSON.stringify({
      ticket: 1,
      pid: process.pid,
      at: new Date().toISOString(),
    }));
    const held = gate.acquireGate(root, "election", { timeoutMs: 0 });
    assert.equal(held, null,
      "a participant with a higher ticket must not enter the gate");
    assert.ok(fs.existsSync(path.join(dir, "gate-1.json")),
      "the participant that holds the gate must not be removed");
  } finally {
    cleanup(root);
  }
});

test("regression: a participant that is alive is never reclaimed, however old it is", () => {
  // The liveness of a participant is decided by its process. A participant
  // whose file is OLD but whose process is alive is a participant that is
  // about to publish: removing it would let a second participant into the
  // protocol.
  const root = mkProject("gate-live-participant");
  try {
    const gate = require("../../lib/graphify/density-gate");
    const dir = gate.gateDir(root, "live");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "gate-1.json");
    fs.writeFileSync(file, JSON.stringify({
      ticket: 1,
      pid: process.pid,
      at: new Date().toISOString(),
    }));
    const old = new Date(Date.now() - 24 * 3600 * 1000);
    fs.utimesSync(file, old, old);
    const held = gate.acquireGate(root, "live", { timeoutMs: 0 });
    assert.equal(held, null,
      "a live participant must keep the gate, however old its file is");
    assert.ok(fs.existsSync(file),
      "the file of a live participant must not be removed");
  } finally {
    cleanup(root);
  }
});

test("regression: a publication is not signed off by a record with the same sequence", () => {
  // The publication is confirmed by the IDENTITY of THIS record. A record
  // that carries the same SEQUENCE is a DIFFERENT record: an explicit
  // sequence can collide with an allocated one, and an older record with
  // the same number must not sign off a publication that the readers
  // dropped.
  const root = mkProject("published-record-identity");
  try {
    const seed = density.acquireRebuildLock(root);
    assert.ok(seed, "the seed lock must be acquired");
    const seeded = density.stampBaseline(root, {
      nodes: 100,
      edges: 500,
      buildKind: "full",
      lockGeneration: seed.generation,
      lockToken: seed.token,
      // An EXPLICIT sequence: the allocator does not reserve it, so a
      // later publication can carry the same number.
      sequence: 1,
    });
    assert.equal(seeded.ok, true, "the baseline must be published");
    seed.release();
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5);

    const dropped = density.stampBaseline(root, {
      nodes: 100,
      edges: 900,
      buildKind: "full",
      lockToken: "displaced-token",
      sequence: 1,
      onBeforeAppend: () => {
        assert.ok(lockLib.registerDisplaced(root, "displaced-token"));
      },
    });
    assert.equal(dropped.ok, false,
      "a publication that the readers drop must not be a success");
    assert.equal(dropped.reason, "publication_rejected");
    assert.equal(density.readBaselineSidecar(root).edge_node_ratio, 5,
      "the baseline on disk must still be the old one");
  } finally {
    cleanup(root);
  }
});

test("regression: a writer that ignores the staging area is detected", () => {
  // The writer is supposed to write into the staging area. A writer that
  // writes the PUBLIC graph instead breaks the isolation the framework
  // relies on, and the framework has to notice: it cannot tell which of
  // the two graphs is the one it may publish.
  const root = mkProject("isolation-violation");
  try {
    const graphFile = path.join(root, "graphify-out", "graph.json");
    writeGraph(root, { nodes: 200, edges: 400 });
    const bin = path.join(root, "stub-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "graphify"), [
      "#!/bin/sh",
      // The writer IGNORES GRAPHIFY_OUT and writes the public graph.
      "printf '{\"nodes\":[{\"id\":\"rogue\"}],\"links\":[]}' > \"" + graphFile + "\"",
      "exit 0",
      "",
    ].join("\n"));
    fs.chmodSync(path.join(bin, "graphify"), 0o755);

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const result = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock,
      timeoutMs: 30_000,
      env: { PATH: bin + ":" + process.env.PATH },
    });
    assert.equal(result.ok, false,
      "a writer that wrote the public graph must not be a success");
    assert.equal(result.reason, "isolation_violated");
    lock.release();
  } finally {
    cleanup(root);
  }
});

test("regression: the legacy claim replays the reminder it claimed", () => {
  // The claim moved the single file aside. A writer published a NEW
  // reminder at the path in the meantime, so the claimed content cannot be
  // put back -- it is imported into the record model instead, and the NEW
  // reminder has to survive.
  const root = mkProject("legacy-claim-replay");
  try {
    const graphDir = path.join(root, "graphify-out");
    const legacyPath = path.join(graphDir, ".graphify-stale.json");
    const old = {
      schemaVersion: "1.0",
      markerId: "old",
      kind: "semantic",
      changedPaths: ["docs/old.md"],
    };
    fs.writeFileSync(legacyPath, JSON.stringify(old));
    const identity = markers.readMarker(graphDir).identity;
    assert.ok(identity, "the legacy reminder must be readable");

    const newer = {
      schemaVersion: "1.0",
      markerId: "new",
      kind: "semantic",
      changedPaths: ["docs/new.md"],
    };
    const middle = {
      schemaVersion: "1.0",
      markerId: "middle",
      kind: "semantic",
      changedPaths: ["docs/middle.md"],
    };
    const result = markers.clearLegacyMarkerIfUnchanged(graphDir, identity, {
      onBeforeClaim: () => {
        // The concurrent writer replaces the file between the read and the
        // claim: the claim takes a reminder that was never answered.
        fs.writeFileSync(legacyPath, JSON.stringify(middle));
      },
      onAfterClaim: () => {
        // The concurrent writer publishes a NEW reminder at the path.
        fs.writeFileSync(legacyPath, JSON.stringify(newer));
        // The claimed file is runtime state under `.agent/`, so the
        // ignore rules of the project cover it.
        const claimDir = path.join(
          root, ".agent", "plugins", "graphify", ".density-claimed",
        );
        const claimed = fs.existsSync(claimDir) ? fs.readdirSync(claimDir) : [];
        assert.equal(claimed.length, 1,
          "the claimed reminder must be moved into the runtime state of the plugin");
        const leftovers = fs.readdirSync(graphDir).filter((name) => name.includes(".claimed-"));
        assert.deepEqual(leftovers, [],
          "the claim must not leave a file in the source tree");
      },
    });
    assert.ok(result.ok, "the clear must not fail: " + result.reason);
    assert.equal(result.cleared, false);
    assert.equal(result.reason, "marker_changed");

    // The CLAIMED reminder was replayed into the record model, and the
    // reminder that was published while the claim was running survived:
    // both of them are still readable.
    const after = markers.readMarker(graphDir);
    assert.ok(after.ok, "the reminders must be readable");
    const paths = after.records.flatMap((record) => record.changedPaths).sort();
    assert.ok(paths.includes("docs/middle.md"),
      "the claimed reminder must be replayed into the record model");
    const onDisk = fs.existsSync(legacyPath)
      ? JSON.parse(fs.readFileSync(legacyPath, "utf8"))
      : null;
    const onDiskPaths = onDisk && Array.isArray(onDisk.changedPaths)
      ? onDisk.changedPaths
      : [];
    const all = paths.concat(onDiskPaths);
    assert.ok(all.includes("docs/middle.md"),
      "the claimed reminder must not be lost");
    assert.ok(all.includes("docs/new.md"),
      "the reminder that was published while the claim was running must not be lost");
  } finally {
    cleanup(root);
  }
});

test("regression: a descendant that holds the staged graph open cannot change the published graph", async () => {
  // The published file must not be an inode that the writer -- or a
  // descendant of the writer -- still holds open. A rename of the staged
  // file would publish exactly that inode, and the descendant could then
  // change the published graph AFTER the publication reported success.
  const root = mkProject("published-inode");
  try {
    const graphFile = path.join(root, "graphify-out", "graph.json");
    writeGraph(root, { nodes: 200, edges: 400 });

    const writer = path.join(root, "writer.js");
    fs.writeFileSync(writer, [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const out = process.env.GRAPHIFY_OUT;",
      "fs.writeFileSync(out + '/graph.json', JSON.stringify({ nodes: [{ id: 'good' }], links: [] }));",
      "const fd = fs.openSync(out + '/graph.json', 'r+');",
      "const code = [",
      "  \"const fs=require('node:fs');\",",
      "  \"setTimeout(function(){try{fs.ftruncateSync(3,0);fs.writeSync(3,JSON.stringify({nodes:[{id:'evil'}],links:[]}));}catch(e){}},1200);\",",
      "].join('\\n');",
      "spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }).unref();",
      "",
    ].join("\n"));
    const bin = path.join(root, "stub-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "graphify"), [
      "#!/bin/sh",
      "node \"" + writer + "\"",
      "exit 0",
      "",
    ].join("\n"));
    fs.chmodSync(path.join(bin, "graphify"), 0o755);

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const result = updateLib.runGuardedUpdate({
      projectRoot: root,
      lock,
      timeoutMs: 30_000,
      env: { PATH: bin + ":" + process.env.PATH },
    });
    assert.equal(result.ok, true,
      "the update must succeed: " + (result.reason || result.stderr));
    const published = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.deepEqual(published.nodes.map((node) => node.id), ["good"],
      "the published graph must be the one of the writer");
    lock.release();

    // The descendant wakes up long after the publication.
    await sleep(1800);
    const after = JSON.parse(fs.readFileSync(graphFile, "utf8"));
    assert.deepEqual(after.nodes.map((node) => node.id), ["good"],
      "the published graph must survive the descendant that holds the staged file open");
  } finally {
    cleanup(root);
  }
});

test("regression: a failed publication leaves the graph and the manifest as they were", () => {
  // The publication replaces more than one file. A failure in the middle
  // must not leave the public directory with a graph and a manifest that
  // describe different builds: the next incremental build would read a
  // mismatched pair.
  const root = mkProject("publication-rollback");
  try {
    const graphFile = path.join(root, "graphify-out", "graph.json");
    const manifestFile = path.join(root, "graphify-out", "manifest.json");
    fs.writeFileSync(graphFile, JSON.stringify({ nodes: [{ id: "old" }], links: [] }));
    fs.writeFileSync(manifestFile, JSON.stringify({ version: "old" }));

    const staging = path.join(
      root, ".agent", "plugins", "graphify", ".density-staging", "staged-1",
    );
    updateLib.prepareStaging(root, staging);
    fs.writeFileSync(path.join(staging, "graph.json"), JSON.stringify({
      nodes: [{ id: "new" }],
      links: [],
    }));
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ version: "new" }));

    const lock = density.acquireRebuildLock(root);
    assert.ok(lock, "the lock must be acquired");
    const realRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function (from, to, ...rest) {
      if (!injected && String(to).endsWith(path.join("graphify-out", "graph.json"))) {
        injected = true;
        const err = new Error("injected");
        err.code = "EIO";
        throw err;
      }
      return realRename.call(this, from, to, ...rest);
    };
    let published = null;
    try {
      published = updateLib.publishStagedOutput(root, staging, lock);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(published.ok, false, "the publication must fail");
    assert.equal(JSON.parse(fs.readFileSync(graphFile, "utf8")).nodes[0].id, "old",
      "the public graph must be the one it was");
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, "utf8")).version, "old",
      "the public manifest must be the one it was");
    lock.release();
  } finally {
    cleanup(root);
  }
});

test("regression: a reclaim that cannot register the fence does not release the lock", () => {
  // The fence has to be in place BEFORE the path is released: a fence that
  // fails must not leave the path free for the next holder. This is the
  // branch that runs on a filesystem WITHOUT hard links -- and it used to
  // move the lock away first, so a failed registration lost the lock.
  const root = mkProject("no-hardlink-fence");
  try {
    const file = density.rebuildLockPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      token: "stale-token",
      pid: 999999,
      acquiredAt: new Date(Date.now() - 3600_000).toISOString(),
      generation: 0,
    }));
    // The registry of the displaced holders cannot be written: it is a
    // plain file where the directory has to be.
    const displaced = path.join(root, ".agent", "plugins", "graphify", ".density-displaced");
    fs.mkdirSync(path.dirname(displaced), { recursive: true });
    fs.writeFileSync(displaced, "blocked");

    const realLink = fs.linkSync;
    fs.linkSync = function () {
      const err = new Error("injected");
      err.code = "EOPNOTSUPP";
      throw err;
    };
    let acquired = null;
    try {
      acquired = density.acquireRebuildLock(root, { staleMs: 1000 });
    } finally {
      fs.linkSync = realLink;
    }
    assert.equal(acquired, null, "the reclaim must be refused");
    assert.ok(fs.existsSync(file),
      "the lock at the path must survive a reclaim that could not register its fence");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.token, "stale-token",
      "the lock at the path must still be the one that was there");
  } finally {
    cleanup(root);
  }
});

// ─── The mechanisms the fifteenth round found under-constrained ────────────

test("regression: a ticket that was used is not handed out a second time", () => {
  // The gate orders its participants by ticket, and a ticket that was
  // handed out must never be handed out again. A late participant that
  // reuses the ticket of a participant that arrived earlier enters the
  // protocol IN FRONT of it -- and two participants are then inside the
  // mutual exclusion at the same time.
  const root = mkProject("gate-ticket-not-reused");
  try {
    const gate = require("../../lib/graphify/density-gate");
    const dir = gate.gateDir(root, "reuse");
    const held = gate.acquireGate(root, "reuse", { timeoutMs: 0 });
    assert.ok(held, "the first participant must take the gate");
    held.release();
    const slot = path.join(dir, "gate-" + held.ticket + ".json");
    assert.ok(fs.existsSync(slot),
      "the slot of a released participant must stay: the ticket is taken for ever");
    assert.equal(gate.readGateEntry(slot).active, false,
      "a released slot is not a participant any more");
    const next = gate.registerParticipant(dir);
    assert.ok(next, "the next participant must register");
    assert.ok(next.ticket > held.ticket,
      "a ticket that was used must not be handed out a second time");
  } finally {
    cleanup(root);
  }
});

test("regression: the registration of a ticket never overwrites the slot of another participant", () => {
  // The registration is the step that takes the ticket. If it could
  // OVERWRITE the slot of a participant that took the same number in the
  // meantime, two participants would believe that they own one ticket --
  // and the order of the participants would not be an order any more.
  const root = mkProject("gate-registration-exclusive");
  try {
    const gate = require("../../lib/graphify/density-gate");
    const dir = gate.gateDir(root, "exclusive");
    fs.mkdirSync(dir, { recursive: true });
    let injected = false;
    const participant = gate.registerParticipant(dir, {
      onBeforeCreate: ({ ticket, file }) => {
        if (injected) return;
        injected = true;
        // Somebody else takes this ticket in the window between the
        // decision and the create.
        fs.writeFileSync(file, JSON.stringify({
          ticket,
          pid: 999999,
          active: true,
          at: new Date().toISOString(),
        }));
      },
    });
    assert.ok(participant, "the participant must register");
    assert.ok(participant.ticket > 1,
      "the participant must take the next ticket, not the one that was taken");
    const competing = JSON.parse(fs.readFileSync(path.join(dir, "gate-1.json"), "utf8"));
    assert.equal(competing.pid, 999999,
      "the slot of the other participant must not be overwritten");
  } finally {
    cleanup(root);
  }
});

test("regression: the public graph is never absent while a publication runs", () => {
  // The public graph is the file every reader of the project reads. A
  // publication that MOVES it aside leaves a window in which the file is
  // not there at all -- and a reader that looks into that window sees no
  // graph, not the old one.
  const root = mkProject("publish-graph-never-absent");
  try {
    const out = path.join(root, "graphify-out");
    const staging = path.join(root, "staging");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify({ nodes: [{ id: "old" }], links: [] }));
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ version: "old" }));
    fs.writeFileSync(path.join(staging, "graph.json"), JSON.stringify({ nodes: [{ id: "new" }], links: [] }));
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ version: "new" }));
    const ren = fs.renameSync;
    let before = null;
    let after = null;
    fs.renameSync = function (from, to) {
      const isGraph = String(to) === path.join(out, "graph.json") && String(from).includes(".publish-");
      if (isGraph) before = fs.existsSync(path.join(out, "graph.json"));
      const result = ren.apply(this, arguments);
      if (isGraph) after = fs.existsSync(path.join(out, "graph.json"));
      return result;
    };
    let published;
    try {
      published = updateLib.publishStagedOutput(root, staging, { isHeld: () => true });
    } finally {
      fs.renameSync = ren;
    }
    assert.equal(published.ok, true, "the publication must succeed");
    assert.equal(before, true,
      "the public graph must be there while it is replaced");
    assert.equal(after, true,
      "the public graph must be there right after it was replaced");
  } finally {
    cleanup(root);
  }
});

test("regression: a publication whose restore fails is reported and keeps the backup", () => {
  // A publication that fails AND whose restore fails is a different fact
  // from a publication that failed cleanly: the public directory may hold
  // a file of the failed build, and the backup of the previous version is
  // the only way back. The failure has to say so, and the backup has to
  // survive.
  const root = mkProject("publish-restore-failed");
  try {
    const out = path.join(root, "graphify-out");
    const staging = path.join(root, "staging");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify({ nodes: [{ id: "old" }], links: [] }));
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ version: "old" }));
    fs.writeFileSync(path.join(staging, "graph.json"), JSON.stringify({ nodes: [{ id: "new" }], links: [] }));
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ version: "new" }));
    const ren = fs.renameSync;
    let failures = 0;
    fs.renameSync = function (from, to) {
      const fail = (String(to) === path.join(out, "graph.json") && failures === 0)
        || String(from).endsWith("superseded-manifest.json");
      if (fail) { failures += 1; throw Object.assign(new Error("injected"), { code: "EIO" }); }
      return ren.apply(this, arguments);
    };
    let published;
    try {
      published = updateLib.publishStagedOutput(root, staging, { isHeld: () => true });
    } finally {
      fs.renameSync = ren;
    }
    assert.equal(published.ok, false, "the publication must fail");
    assert.equal(published.restored, false,
      "a restore that failed must not be reported as a restore that succeeded");
    assert.equal(published.restoreReason, "restore_failed",
      "the failure of the restore must be reported as its own fact");
    assert.equal(published.preserveStaging, true,
      "the staging area with the backup must be kept");
    assert.ok(fs.existsSync(path.join(staging, "superseded-manifest.json")),
      "the backup of the file that could not be restored must survive");
    const marker = path.join(root, ".agent", "plugins", "graphify", ".density-commit.json");
    const state = JSON.parse(fs.readFileSync(marker, "utf8")).state;
    assert.equal(state, "publishing",
      "a directory whose restore failed must be marked as in doubt");
  } finally {
    cleanup(root);
  }
});

test("regression: a reader fails closed while a publication is in flight", () => {
  // The publication of several files is not one atomic step, so the
  // reader and the writer have to agree on a version boundary. The commit
  // marker is that boundary: a reader that finds a marker that says the
  // publication did not finish must not read the directory.
  const resolver = require("../../lib/graphify/resolver");
  const root = mkProject("resolver-commit-marker");
  try {
    const pluginDir = path.join(root, ".agent", "plugins", "graphify");
    const out = path.join(root, "graphify-out");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "config.yml"),
      "graphify:\n  version: '>=0.9.0'\n  map_path: 'graphify-out/graph.json'\n",
    );
    const graph = { schema_version: "1.0", nodes: [{ id: "n1" }], links: [] };
    fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(graph));
    const manifestLib = require("../../lib/graphify/manifest");
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifestLib.buildManifest({
      graphifyVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      sourceHead: "abc123",
      includedRoots: ["lib/"],
      excludedRoots: [],
      nodeCount: 1,
      edgeCount: 0,
      generationMode: "full",
    }), null, 2));
    const marker = path.join(pluginDir, ".density-commit.json");
    fs.writeFileSync(marker, JSON.stringify({
      schemaVersion: "1.0",
      state: "publishing",
      publishedAt: new Date().toISOString(),
      graphRoot: fs.realpathSync(out),
      files: {},
    }));
    const inFlight = resolver.resolveContext({
      projectRoot: root,
      gitContext: fakeGitContext(),
      includeDirtyCheck: false,
      now: new Date().toISOString(),
    });
    assert.equal(inFlight.available, false,
      "a reader must not read a directory whose publication is in flight");
    assert.ok(inFlight.staleReasons.includes("commit_incomplete"),
      "the reader must say why the directory is not usable");

    // The positive control: a marker that describes the files that are
    // there lets the reader through.
    const digest = (file) => require("node:crypto")
      .createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fs.writeFileSync(marker, JSON.stringify({
      schemaVersion: "1.0",
      state: "published",
      publishedAt: new Date().toISOString(),
      graphRoot: fs.realpathSync(out),
      files: {
        "graph.json": { sha256: digest(path.join(out, "graph.json")), mtimeMs: fs.statSync(path.join(out, "graph.json")).mtimeMs },
        "manifest.json": { sha256: digest(path.join(out, "manifest.json")), mtimeMs: fs.statSync(path.join(out, "manifest.json")).mtimeMs },
      },
    }));
    const published = resolver.resolveContext({
      projectRoot: root,
      gitContext: fakeGitContext(),
      includeDirtyCheck: false,
      now: new Date().toISOString(),
    });
    assert.equal(published.available, true,
      "a directory whose marker describes its files must be readable");
    assert.equal(published.staleReasons.length, 0,
      "a consistent directory must not be reported as stale");
  } finally {
    cleanup(root);
  }
});

test("regression: a legacy reminder that cannot be imported is preserved and reported", () => {
  // A reminder that a concurrent writer published at the path is a
  // reminder in its own right. When it cannot be imported into the record
  // model, it must STAY where it is -- and the caller has to be told that
  // it is still pending.
  const root = mkProject("legacy-reminder-pending");
  try {
    const dir = path.join(root, "graphify-out");
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, ".graphify-stale.json");
    const reminder = (id) => ({
      schemaVersion: "1.0",
      markerId: id,
      kind: "semantic",
      changedPaths: [id + ".md"],
    });
    fs.writeFileSync(markerPath, JSON.stringify(reminder("old")));
    const identity = markers.readLegacyMarker(dir).identity;
    const write = fs.writeFileSync;
    fs.writeFileSync = function (file, ...rest) {
      if (String(file).endsWith("/new.json")) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return write.call(this, file, ...rest);
    };
    let result;
    try {
      result = markers.clearLegacyMarkerIfUnchanged(dir, identity, {
        onBeforeClaim: () => write.call(fs, markerPath, JSON.stringify(reminder("middle"))),
        onAfterClaim: () => write.call(fs, markerPath, JSON.stringify(reminder("new"))),
      });
    } finally {
      fs.writeFileSync = write;
    }
    assert.equal(result.ok, true, "the clear itself must not fail");
    assert.equal(result.pending, true,
      "a reminder that could not be imported must be reported as pending");
    const onDisk = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(onDisk.markerId, "new",
      "the reminder that could not be imported must stay where it is");
    const records = fs.readdirSync(path.join(dir, ".graphify-stale-records"));
    assert.ok(records.includes("middle.json"),
      "the reminder that was claimed must be in the record model");
    assert.ok(!records.includes("new.json"),
      "the reminder that could not be written must not be in the record model");
  } finally {
    cleanup(root);
  }
});

test("regression: a reminder that arrives while the view is written is not lost", () => {
  // The derived view is published with an atomic create. A reminder that
  // a writer publishes in that window must be FOUND -- and imported --
  // instead of being overwritten by the view.
  const root = mkProject("legacy-reminder-during-view");
  try {
    const dir = path.join(root, "graphify-out");
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, ".graphify-stale.json");
    const reminder = (id) => ({
      schemaVersion: "1.0",
      markerId: id,
      kind: "semantic",
      changedPaths: [id + ".md"],
    });
    fs.writeFileSync(markerPath, JSON.stringify(reminder("old")));
    const identity = markers.readLegacyMarker(dir).identity;
    const write = fs.writeFileSync;
    const link = fs.linkSync;
    let injected = false;
    fs.linkSync = function (from, to) {
      if (!injected && String(to) === markerPath) {
        injected = true;
        write.call(fs, markerPath, JSON.stringify(reminder("third")));
      }
      return link.apply(this, arguments);
    };
    let result;
    try {
      result = markers.clearLegacyMarkerIfUnchanged(dir, identity, {
        onBeforeClaim: () => write.call(fs, markerPath, JSON.stringify(reminder("middle"))),
        onAfterClaim: () => write.call(fs, markerPath, JSON.stringify(reminder("new"))),
      });
    } finally {
      fs.linkSync = link;
      fs.writeFileSync = write;
    }
    assert.equal(injected, true, "the reminder must have arrived in the window");
    assert.equal(result.ok, true, "the clear itself must not fail");
    const records = fs.readdirSync(path.join(dir, ".graphify-stale-records"));
    assert.ok(records.includes("third.json"),
      "a reminder that arrives while the view is written must not be lost");
  } finally {
    cleanup(root);
  }
});

test("regression: a participant whose slot was taken while it registered does not enter the protocol", () => {
  // Filesystems without hard links cannot publish a registration and its
  // content in one step. The registration then reserves the name first
  // and writes the content afterwards -- and a participant that reclaims
  // the empty slot in that window replaces the file. The participant that
  // was registering has to notice that its slot is no longer its own,
  // because a half-registered participant that enters the protocol is two
  // participants inside the mutual exclusion.
  //
  // The slot of that fallback carries the pid in its NAME, so a slot
  // whose content was not written yet is still attributable: a
  // participant that is alive is never reclaimed.
  const root = mkProject("gate-slot-taken-while-registering");
  try {
    const gate = require("../../lib/graphify/density-gate");
    const dir = gate.gateDir(root, "taken");
    fs.mkdirSync(dir, { recursive: true });
    const link = fs.linkSync;
    const open = fs.openSync;
    let displaced = false;
    fs.linkSync = function () {
      throw Object.assign(new Error("no links"), { code: "EOPNOTSUPP" });
    };
    fs.openSync = function (file, ...rest) {
      const handle = open.call(this, file, ...rest);
      if (!displaced && path.basename(String(file)).startsWith("gate-")) {
        displaced = true;
        // Somebody else reclaims the empty slot while the content is
        // written: the file at the path is a DIFFERENT file now, with a
        // DIFFERENT inode.
        const other = String(file) + ".reclaimed-" + process.pid;
        fs.writeFileSync(other, JSON.stringify({
          ticket: 1,
          pid: 999999,
          active: false,
          releasedAt: new Date().toISOString(),
        }));
        fs.renameSync(other, String(file));
        // The reclaimer takes the NEXT ticket itself, and it is ALIVE.
        fs.writeFileSync(path.join(dir, "gate-2.json"), JSON.stringify({
          ticket: 2,
          pid: 1,
          active: true,
          at: new Date().toISOString(),
        }));
      }
      return handle;
    };
    let held = null;
    try {
      held = gate.acquireGate(root, "taken", { timeoutMs: 0 });
    } finally {
      fs.linkSync = link;
      fs.openSync = open;
    }
    assert.equal(displaced, true, "the slot must have been reclaimed");
    assert.equal(held, null,
      "a participant whose slot was taken must not enter the protocol");
    const slots = fs.readdirSync(dir).filter((n) => n.startsWith("gate-"));
    assert.ok(slots.some((n) => /^gate-1-/.test(n)),
      "the reclaimed slot keeps its ticket: " + slots.join(", "));
  } finally {
    cleanup(root);
  }
});

test("regression: a commit marker that cannot be read fails the reader closed", () => {
  // A directory that never had a marker is a directory of an older
  // version. A marker that EXISTS but cannot be read is a different fact:
  // the protocol is in use here, and the reader cannot know what the
  // marker says -- so it must not read the directory as if it were fine.
  const resolver = require("../../lib/graphify/resolver");
  const root = mkProject("resolver-marker-unreadable");
  try {
    const marker = publishFixture(root);
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      if (String(file) === marker) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return read.call(this, file, ...rest);
    };
    let out;
    try {
      out = resolver.resolveContext({
        projectRoot: root,
        gitContext: fakeGitContext(),
        includeDirtyCheck: false,
        now: new Date().toISOString(),
      });
    } finally {
      fs.readFileSync = read;
    }
    assert.equal(out.available, false,
      "a marker that cannot be read must not let the reader through");
    assert.ok(out.staleReasons.includes("commit_invalid"),
      "the reader must say why the directory is not usable");
  } finally {
    cleanup(root);
  }
});

test("regression: a changed file is not excused by its modification time", () => {
  // The marker describes the files it published. A file that was replaced
  // afterwards belongs to another generation -- and the reader must not
  // excuse the mismatch with a modification time that happens to be
  // different, in either direction.
  const resolver = require("../../lib/graphify/resolver");
  const root = mkProject("resolver-marker-mtime");
  try {
    const marker = publishFixture(root);
    const record = JSON.parse(fs.readFileSync(marker, "utf8"));
    const manifestPath = path.join(root, "graphify-out", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.generatedAt = new Date(Date.now() + 60000).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const newer = new Date(record.files["manifest.json"].mtimeMs + 10000);
    fs.utimesSync(manifestPath, newer, newer);
    const out = resolver.resolveContext({
      projectRoot: root,
      gitContext: fakeGitContext(),
      includeDirtyCheck: false,
      now: new Date().toISOString(),
    });
    assert.equal(out.available, false,
      "a file that is not the one the marker describes must fail the reader closed");
    assert.ok(out.staleReasons.includes("commit_mismatch"),
      "the reader must name the mismatch");
  } finally {
    cleanup(root);
  }
});

test("regression: a commit marker with an invalid structure fails the reader closed", () => {
  // The marker is a protocol: its schema, its state and its entries are
  // validated before it is read. A marker that says nothing -- or that
  // says half of it -- is not read as if it said everything, and it never
  // makes the reader throw.
  const resolver = require("../../lib/graphify/resolver");
  for (const broken of [
    { name: "no state", mutate: (m) => { delete m.state; m.files = {}; } },
    { name: "no files", mutate: (m) => { m.files = {}; } },
    { name: "a null entry", mutate: (m) => { m.files["graph.json"] = null; } },
    { name: "an entry without a digest", mutate: (m) => { m.files["graph.json"] = { mtimeMs: 1 }; } },
  ]) {
    const root = mkProject("resolver-marker-structure");
    try {
      const marker = publishFixture(root);
      const record = JSON.parse(fs.readFileSync(marker, "utf8"));
      broken.mutate(record);
      fs.writeFileSync(marker, JSON.stringify(record));
      let out = null;
      let threw = null;
      try {
        out = resolver.resolveContext({
          projectRoot: root,
          gitContext: fakeGitContext(),
          includeDirtyCheck: false,
          now: new Date().toISOString(),
        });
      } catch (err) {
        threw = err;
      }
      assert.equal(threw, null, "the reader must not throw on a broken marker (" + broken.name + ")");
      assert.equal(out.available, false,
        "a broken marker must fail the reader closed (" + broken.name + ")");
      assert.ok(out.staleReasons.includes("commit_invalid"),
        "the reader must say why the directory is not usable (" + broken.name + ")");
    } finally {
      cleanup(root);
    }
  }
});

test("regression: a reminder that the guard captured is imported before the guard is removed", () => {
  // The file that is moved aside may hold a REMINDER: a writer that
  // published one between the inspection of the path and the move. It is
  // imported into the record model before the file is removed -- on every
  // path out of the publication, not only on the happy one.
  const root = mkProject("legacy-guard-capture");
  try {
    const dir = path.join(root, "graphify-out");
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, ".graphify-stale.json");
    const reminder = (id) => ({
      schemaVersion: "1.0",
      markerId: id,
      kind: "semantic",
      changedPaths: [id + ".md"],
    });
    // A derived view is already published: the next write replaces it.
    markers.writeMarker({ graphDir: dir, kind: "semantic", changedPaths: ["seed.md"] });
    const ren = fs.renameSync;
    const write = fs.writeFileSync;
    let captured = false;
    fs.renameSync = function (from, to) {
      if (!captured && from === markerPath && String(to).includes(".guard-")) {
        captured = true;
        // A writer publishes a reminder right before the file at the path
        // is moved aside: the guard captures THAT reminder.
        write.call(fs, markerPath, JSON.stringify(reminder("middle")));
        const result = ren.apply(this, arguments);
        // ... and another one right after it.
        write.call(fs, markerPath, JSON.stringify(reminder("new")));
        return result;
      }
      return ren.apply(this, arguments);
    };
    let result = null;
    try {
      result = markers.writeMarker({ graphDir: dir, kind: "semantic", changedPaths: ["another.md"] });
    } finally {
      fs.renameSync = ren;
    }
    assert.equal(captured, true, "the guard must have captured the reminder");
    assert.equal(result.ok, true, "the write must succeed");
    const records = fs.readdirSync(path.join(dir, ".graphify-stale-records"));
    assert.ok(records.includes("middle.json"),
      "a reminder that the guard captured must be imported before the guard is removed");
    assert.ok(records.includes("new.json"),
      "a reminder that a writer published must be imported");
  } finally {
    cleanup(root);
  }
});

test("regression: the view is never published over a reminder when hard links are missing", () => {
  // Without hard links there is no atomic create that does not overwrite,
  // so the name would have to be reserved first and the content written
  // afterwards -- and a reminder that a writer publishes in that window
  // is overwritten by the view. No check of the file before or after the
  // write can tell that the reminder was there, so the view is NOT
  // published on such a filesystem: the reminders stay in their records,
  // and the file at the path is left alone.
  const root = mkProject("legacy-view-without-links");
  try {
    const dir = path.join(root, "graphify-out");
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, ".graphify-stale.json");
    const reminder = (id) => ({
      schemaVersion: "1.0",
      markerId: id,
      kind: "semantic",
      changedPaths: [id + ".md"],
    });
    fs.writeFileSync(markerPath, JSON.stringify(reminder("old")));
    const identity = markers.readLegacyMarker(dir).identity;
    const link = fs.linkSync;
    const write = fs.writeFileSync;
    fs.linkSync = function () {
      throw Object.assign(new Error("no links"), { code: "EOPNOTSUPP" });
    };
    let result = null;
    try {
      result = markers.clearLegacyMarkerIfUnchanged(dir, identity, {
        onBeforeClaim: () => write.call(fs, markerPath, JSON.stringify(reminder("middle"))),
        onAfterClaim: () => write.call(fs, markerPath, JSON.stringify(reminder("new"))),
      });
    } finally {
      fs.linkSync = link;
    }
    assert.equal(result.ok, true, "the clear itself must not fail");
    const records = fs.existsSync(path.join(dir, ".graphify-stale-records"))
      ? fs.readdirSync(path.join(dir, ".graphify-stale-records"))
      : [];
    const onDisk = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, "utf8")) : null;
    assert.ok(records.includes("middle.json") || records.includes("new.json"),
      "a reminder must not be lost: " + records.join(", "));
    assert.ok(!onDisk || !Array.isArray(onDisk.recordIds),
      "the file at the path must not be a view that was published over a reminder");
  } finally {
    cleanup(root);
  }
});

// ─── The eighteenth round of the review (#154) ────────────────────────────

test("regression: the view is not published without hard links, and the reminder survives it", () => {
  // Without hard links there is no atomic create that publishes the
  // content in the same step: the name would have to be reserved first,
  // and the content is written afterwards. A reminder that a writer
  // publishes in that window is overwritten by the view -- and no check
  // of the file before or after the write can tell that the reminder was
  // there. The view is therefore refused, and the reminder stays in its
  // record.
  //
  // A refused publication must also leave nothing behind: a residue at
  // the path would make every later publication fail as well.
  const root = mkProject("view-without-links-refused");
  try {
    const dir = path.join(root, "graphify-out");
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, ".graphify-stale.json");
    const link = fs.linkSync;
    fs.linkSync = function () {
      throw Object.assign(new Error("no links"), { code: "EOPNOTSUPP" });
    };
    let result = null;
    try {
      result = markers.writeMarker({ graphDir: dir, kind: "semantic", changedPaths: ["reminder.md"] });
    } finally {
      fs.linkSync = link;
    }
    assert.equal(result.ok, false, "the view must not be published without hard links");
    assert.equal(result.reason, "no_hardlink_support",
      "the refusal must say why the view was not published");
    const records = fs.existsSync(path.join(dir, ".graphify-stale-records"))
      ? fs.readdirSync(path.join(dir, ".graphify-stale-records"))
      : [];
    assert.equal(records.length, 1, "the reminder must be durable in its record");
    const residue = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : "";
    assert.equal(residue, "", "a refused publication must not leave a residue at the path");
    // The publication works again as soon as the filesystem can link.
    const again = markers.writeMarker({ graphDir: dir, kind: "semantic", changedPaths: ["later.md"] });
    assert.equal(again.ok, true, "a later publication must not be poisoned: " + again.reason);
    const view = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.ok(Array.isArray(view.recordIds) && view.recordIds.length === 2,
      "the published view must describe every record: " + JSON.stringify(view));
  } finally {
    cleanup(root);
  }
});

test("regression: a published marker has to describe the graph and the manifest", () => {
  // The marker of a publication is what says that the files next to it
  // belong together. A marker that names the graph only -- or the
  // manifest only, or a file that is not part of the publication at all
  // -- does not say that: the file it leaves out is exactly the file a
  // mismatch could hide in.
  const resolver = require("../../lib/graphify/resolver");
  const root = mkProject("resolver-marker-complete");
  try {
    const marker = publishFixture(root);
    const original = JSON.parse(fs.readFileSync(marker, "utf8"));
    const variants = [
      {
        name: "the graph is not described",
        mutate: (record) => { delete record.files["graph.json"]; },
      },
      {
        name: "the manifest is not described",
        mutate: (record) => { delete record.files["manifest.json"]; },
      },
      {
        name: "an unrelated file is described instead",
        mutate: (record) => {
          record.files = {
            other: { sha256: "a".repeat(64), mtimeMs: Date.now() },
          };
        },
      },
    ];
    for (const variant of variants) {
      const record = JSON.parse(JSON.stringify(original));
      variant.mutate(record);
      fs.writeFileSync(marker, JSON.stringify(record));
      const out = resolver.resolveContext({
        projectRoot: root,
        gitContext: fakeGitContext(),
        includeDirtyCheck: false,
        now: new Date().toISOString(),
      });
      assert.equal(out.available, false,
        "a marker that does not describe the publication must fail the reader closed ("
          + variant.name + ")");
      assert.ok(out.staleReasons.includes("commit_invalid"),
        "the reader must say why the directory is not usable (" + variant.name + ")");
    }
  } finally {
    cleanup(root);
  }
});

test("regression: the re-entrant handle speaks for the handle that is really held", () => {
  // The gate is re-entrant inside one process: the holder of the gate
  // publishes the graph while it still holds it. The handle of that
  // second acquisition speaks for the OUTER holder -- and it has to say
  // that the gate is NOT held any more once the outer holder released
  // it. A handle that cannot confirm its authorisation must not grant
  // it.
  const root = mkProject("gate-reentrant-handle");
  try {
    const gate = require("../../lib/graphify/density-gate");
    const outer = gate.acquireGate(root, "rebuild", { timeoutMs: 0 });
    assert.ok(outer, "the gate must be taken");
    const nested = gate.acquireGate(root, "rebuild", { timeoutMs: 0 });
    assert.equal(nested.reentrant, true, "the second acquisition must be re-entrant");
    assert.equal(nested.isHeld(), true, "the nested handle speaks for the outer holder");
    outer.release();
    assert.equal(outer.isHeld(), false, "the gate is not held after the release");
    assert.equal(nested.isHeld(), false,
      "the nested handle must not keep granting the gate after the release");
  } finally {
    cleanup(root);
  }
});

test("regression: a failed legacy tombstone keeps the ticket taken", () => {
  // The reclaim of a participant of the older protocol moves its slot to
  // a tombstone, and the tombstone is what keeps the ticket taken: a
  // ticket that was handed out is never handed out a second time. When
  // the move fails, the ORIGINAL placeholder has to survive -- removing
  // it would hand the number out again, and a participant that was
  // delayed would enter the protocol with a ticket that is in use.
  const root = mkProject("gate-legacy-tombstone-failure");
  try {
    const gate = require("../../lib/graphify/density-gate");
    const dir = gate.gateDir(root, "x");
    fs.mkdirSync(dir, { recursive: true });
    const rename = fs.renameSync;
    let injected = 0;
    let other = null;
    let afterFailure = null;
    const handle = gate.acquireGate(root, "x", {
      timeoutMs: 0,
      staleMs: 0,
      onBeforeCreate({ ticket, file }) {
        if (ticket !== 1) return;
        // A participant of the older protocol that is gone: its pid is
        // not running any more, and its slot is older than the window.
        const legacy = path.join(path.dirname(file), "gate-1-2147483647-ab.json");
        fs.writeFileSync(legacy, "{}");
        fs.utimesSync(legacy, new Date(0), new Date(0));
        fs.renameSync = function (from, to) {
          if (String(from) === legacy) {
            injected += 1;
            throw Object.assign(new Error("disk"), { code: "EIO" });
          }
          return rename.apply(this, arguments);
        };
        try {
          other = gate.acquireGate(root, "x", { timeoutMs: 0, staleMs: 0 });
        } finally {
          fs.renameSync = rename;
        }
        afterFailure = fs.readdirSync(dir);
      },
    });
    assert.equal(injected, 1, "the tombstone must have failed");
    assert.ok(other, "the participant that reclaims a dead slot must take the gate");
    assert.equal(other.ticket, 2, "the ticket of the dead participant must not be handed out");
    assert.ok(afterFailure.includes("gate-1-2147483647-ab.json"),
      "the placeholder of the ticket must survive a failed tombstone: " + afterFailure.join(", "));
    assert.equal(handle, null,
      "a participant that was delayed must not enter the protocol with a ticket that is in use");
    if (other) other.release();
    // The ticket is still taken: a participant that registers now is given
    // a number of its own, not the number of the dead one.
    const next = gate.acquireGate(root, "x", { timeoutMs: 0 });
    if (next) {
      assert.ok(next.ticket > 1,
        "a ticket that was taken must not be handed out again: " + next.ticket);
      next.release();
    }
  } finally {
    cleanup(root);
  }
});

test("regression: the published view describes the reminder that the guard captured", () => {
  // The file that is moved aside may hold a REMINDER: a writer that
  // published one between the inspection of the path and the move. It is
  // imported into the record model -- and the view that is published
  // next has to describe it. A view that does not name it hides a
  // reminder from the consumers that read ONE file, and that file is
  // exactly what they read.
  const root = mkProject("legacy-guard-view");
  try {
    const dir = path.join(root, "graphify-out");
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, ".graphify-stale.json");
    const reminder = (id) => ({
      schemaVersion: "1.0",
      markerId: id,
      kind: "semantic",
      changedPaths: [id + ".md"],
    });
    markers.writeMarker({ graphDir: dir, kind: "semantic", changedPaths: ["seed.md"] });
    const ren = fs.renameSync;
    const write = fs.writeFileSync;
    let captured = false;
    fs.renameSync = function (from, to) {
      if (!captured && from === markerPath && String(to).includes(".guard-")) {
        captured = true;
        write.call(fs, markerPath, JSON.stringify(reminder("middle")));
        const result = ren.apply(this, arguments);
        write.call(fs, markerPath, JSON.stringify(reminder("new")));
        return result;
      }
      return ren.apply(this, arguments);
    };
    let result = null;
    try {
      result = markers.writeMarker({ graphDir: dir, kind: "semantic", changedPaths: ["another.md"] });
    } finally {
      fs.renameSync = ren;
    }
    assert.equal(captured, true, "the guard must have captured the reminder");
    assert.equal(result.ok, true, "the write must succeed");
    const records = fs.readdirSync(path.join(dir, ".graphify-stale-records"));
    assert.ok(records.includes("middle.json"),
      "the reminder that the guard captured must be imported");
    const view = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.ok(Array.isArray(view.changedPaths) && view.changedPaths.includes("middle.md"),
      "the published view must describe the captured reminder: " + JSON.stringify(view));
    assert.equal(view.recordIds.length, records.length,
      "the published view must name every record: " + JSON.stringify(view));
  } finally {
    cleanup(root);
  }
});

test("regression: two publishers cannot both succeed when the filesystem has no hard links", async () => {
  // The registration of a participant cannot publish its content in one
  // step without hard links: the name is reserved first, and the content
  // is written afterwards. A participant that scans the directory in that
  // window finds a slot whose content it cannot read -- and a reclaim
  // that judged that slot to be GONE takes the gate away from a
  // participant that is alive and inside the protocol. Two publishers
  // then publish, and the one that lost overwrites the one that won.
  //
  // The slot of that fallback carries the pid in its NAME: a slot whose
  // content is not written yet is attributable, so it is never mistaken
  // for a participant that is gone.
  const root = mkProject("two-publishers-without-hard-links");
  const gateModule = path.join(ROOT, "lib", "graphify", "density-gate.js");
  const reserved = path.join(root, "reserved");
  try {
    const holderScript = [
      "const fs = require('node:fs');",
      "const gate = require(process.argv[1]);",
      "const root = process.argv[2];",
      "const reserved = process.argv[3];",
      "fs.linkSync = function () { throw Object.assign(new Error('no links'), { code: 'EOPNOTSUPP' }); };",
      "const open = fs.openSync;",
      "fs.openSync = function (file, ...rest) {",
      "  const handle = open.call(this, file, ...rest);",
      "  if (typeof file === 'string' && require('node:path').basename(file).indexOf('gate-') === 0) {",
      "    fs.writeFileSync(reserved, '1');",
      "    const until = Date.now() + 800;",
      "    while (Date.now() < until) {}",
      "  }",
      "  return handle;",
      "};",
      "const handle = gate.acquireGate(root, 'rebuild', { timeoutMs: 5000, staleMs: 0 });",
      "process.stdout.write(JSON.stringify({ acquired: Boolean(handle), ticket: handle ? handle.ticket : null }));",
      "if (handle) handle.release();",
    ].join("\n");
    const contenderScript = [
      "const fs = require('node:fs');",
      "const gate = require(process.argv[1]);",
      "const root = process.argv[2];",
      "fs.linkSync = function () { throw Object.assign(new Error('no links'), { code: 'EOPNOTSUPP' }); };",
      "const handle = gate.acquireGate(root, 'rebuild', { timeoutMs: 300, staleMs: 0 });",
      "process.stdout.write(JSON.stringify({ acquired: Boolean(handle), ticket: handle ? handle.ticket : null }));",
      "if (handle) handle.release();",
    ].join("\n");
    const run = (script, args) => new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, gateModule].concat(args), {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out.trim()));
    });
    const holderRun = run(holderScript, [root, reserved]);
    // The slot of the holder is reserved and empty now: the content of
    // the registration is written after the name was taken.
    const until = Date.now() + 5000;
    while (!fs.existsSync(reserved) && Date.now() < until) sleepSync(20);
    assert.ok(fs.existsSync(reserved), "the holder must have reserved its slot");
    const contenderRun = run(contenderScript, [root]);
    const outputs = await Promise.all([holderRun, contenderRun]);
    const holder = JSON.parse(outputs[0]);
    const contender = JSON.parse(outputs[1]);
    assert.equal(holder.acquired, true, "the first publisher must take the gate");
    assert.equal(contender.acquired, false,
      "a second publisher must not enter the protocol while the first one holds it: "
        + JSON.stringify(contender));
    assert.equal([holder.acquired, contender.acquired].filter(Boolean).length, 1,
      "exactly one publisher may be inside the protocol");
  } finally {
    cleanup(root);
  }
});
