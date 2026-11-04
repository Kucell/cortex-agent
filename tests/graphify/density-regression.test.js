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

function pendingNames(root) {
  try {
    return fs.readdirSync(density.pendingDir(root)).sort();
  } catch (_) {
    return [];
  }
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
      "case \"$1\" in",
      "  --version) echo 'graphify 0.9.27-stub'; exit 0 ;;",
      "  extract)",
      "    echo \"extract $@\" >> \"$LOG\";",
      "    touch \"" + signal + "\";",
      "    node -e \"const fs=require('fs');const n=200,e=400;const g={directed:true,multigraph:false,graph:{},nodes:Array.from({length:n},function(_,i){return {id:'n'+i};}),links:Array.from({length:e},function(_,i){return {source:'n'+(i%n),target:'n0'};}),hyperedges:[]};fs.writeFileSync(process.argv[1],JSON.stringify(g));\" \"" + graphFile + "\";",
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
      "printf '{\"nodes\":[{\"id\":\"a\"}],\"links\":[]}' > " + graphFile,
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
