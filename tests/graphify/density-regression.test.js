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
function installStub(root, { updateExit = 0 } = {}) {
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

test("regression: a stamp under a stale lock generation is refused", () => {
  // The fence used to be a CHECK: "is this still my lock?". The lock can
  // be taken away between the check and the write, and no amount of
  // re-checking closes that window -- it is the same ABA shape as a
  // judgement followed by a removal.
  //
  // The generation is a VALUE that travels with the artifact: a reclaim
  // advances it, so a holder that was displaced publishes artifacts that
  // carry an older generation, and the stamp refuses them.
  const root = mkProject("generation-fence");
  try {
    const lock = density.acquireRebuildLock(root);
    assert.ok(lock);
    const generation = lock.generation;
    // A reclaim advances the generation: the holder that was displaced
    // keeps its OLD generation. The reclaim needs a lock whose holder is
    // gone, so the record of a dead process is written over the lock.
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
    assert.ok(reclaimed.generation > generation,
      "a reclaim must advance the generation");
    const stale = density.stampBaseline(root, {
      nodes: 100,
      edges: 200,
      buildKind: "full",
      lockGeneration: generation,
    });
    assert.equal(stale.ok, false, "a stamp under a stale generation must be refused");
    assert.equal(stale.reason, "lock_generation_stale");
    assert.equal(density.readBaselineSidecar(root), null,
      "the refused stamp must not reach the disk");
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
    assert.deepEqual(after.marker.changedPaths, ["docs/queued.md"],
      "the marker of the concurrent consumer must not be deleted");
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

