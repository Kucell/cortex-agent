"use strict";

/**

 * The guarded graph update (issue #154).
 *
 * The incremental update REWRITES the graph, and it is done by the
 * external `graphify` CLI. The framework therefore cannot make the rewrite
 * part of a transaction: it can only decide WHETHER the rewrite may
 * happen.
 *
 * The earlier implementation made that decision AFTER the fact: it ran the
 * CLI directly on the public graph, watched the lock while it ran, and put
 * a snapshot of the graph back when the lock was lost. That is unsound:
 * the snapshot is a copy of "whatever is on disk now", so a holder that
 * lost the lock can overwrite the graph of the holder that replaced it, and
 * a writer that outlives the supervision can still write the graph after
 * the framework has already declared the update failed.
 *
 * So the update is a PRIVATE OUTPUT plus a CONTROLLED PUBLICATION:
 *
 *   1. the writer runs with `GRAPHIFY_OUT` pointing at a staging directory
 *      of its own, so it never touches the public graph while it works;
 *   2. the framework publishes the staged output into the public directory
 *      only after the writer finished AND the lock is still held AND the
 *      publication gate can be taken;
 *   3. every failure path -- a lost lock, a timeout, a crashed writer, an
 *      output overflow -- throws the staging directory away. The public
 *      graph is never written by a writer that was not allowed to publish.
 *
 * There is no rollback any more, because there is nothing to roll back: the
 * public graph is only ever written by the holder that is allowed to write
 * it, and it is written in one atomic rename.
 *
 */


const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");

const { spawnSync } = require("node:child_process");


const {

  graphPath,

  graphOutDir,

  stagingDir,

  pluginDir,

  rebuildLogDir,

} = require("./density-files");

const {

  REBUILD_GATE,

  acquireGate,

} = require("./density-gate");


// The exit code the supervisor uses when it stopped the update because
// the lock was lost. It is distinct from every exit code the Graphify CLI
// uses, so a failed update is never mistaken for a lost lock.
const LOCK_LOST_EXIT = 75;

// The exit code the supervisor uses when the update ran out of time.
const TIMEOUT_EXIT = 124;

// How often the supervisor looks at the lock. The window between the
// loss of the lock and the stop of the rewrite is one poll.
const POLL_MS = 40;

// How long the writer may take to stop after it was asked to.
const STOP_GRACE_MS = 2000;

// How long the supervisor waits for the writers of the group to be gone
// after the direct child exited. A writer that ignores the request to stop
// must not be able to write the graph after the framework published it.
const GROUP_DRAIN_MS = 3000;

// The prefix of the line the supervisor writes its report on.
const REPORT_PREFIX = "CORTEX-DENSITY-UPDATE ";

// The files of the public output directory that the writer needs to see as
// its INPUT. They are copied into the staging directory before the writer
// starts, so an incremental update still finds the previous graph and
// still runs in incremental mode.
const SEED_FILES = Object.freeze(["graph.json", "manifest.json", ".graphify_root"]);

// The files of the public output directory that the writer produces and
// that the framework publishes. The graph is published LAST: it is the
// commit point, and a reader that sees the new graph must see the
// manifest that describes it.
const PUBLISHED_FILES = Object.freeze(["manifest.json", ".graphify_root"]);

// How much of the writer's output is handed back to the caller. The output
// is written to a FILE, so a build that prints megabytes does not die of a
// buffer overflow -- but the caller does not need the whole transcript
// either.
const MAX_REPORTED_OUTPUT = 2 * 1024 * 1024;


/**
 * The hash of a file, or null when it cannot be read.
 */
function hashFile(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (_) {
    return null;
  }
}

/**
 * Whether the lock at this path is still held by this token.
 *
 * Two things are checked: the lock file still carries the token, and the
 * holder was not fenced out. A holder that was fenced out can still have
 * its lock file -- when the reclaim could not put the record back -- and
 * it must not publish anything any more.
 */
function lockStillHeld(lockPath, token, displacedPath) {
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (_) {
    return false;
  }
  if (!holder || typeof holder !== "object") return false;
  // The lock file has to carry OUR token. A file that carries another
  // token belongs to the holder that replaced us.
  if (token && holder.token !== token) return false;
  if (displacedPath) {
    try {
      fs.accessSync(displacedPath);
      return false;
    } catch (_) { /* the holder was not fenced out */ }
  }
  return true;
}

/**
 * Stop a child process. The signal is TERM first, so the CLI can clean
 * up, and KILL after a grace period, so a child that ignores TERM does
 * not keep writing.
 */
function stopChild(child) {
  // The whole GROUP is stopped, not only the child: the update is a shell
  // script in most installations, and the shell's own child would keep
  // writing the graph -- after the shell is gone.
  const signal = (name) => {
    try {
      if (process.platform === "win32") {
        child.kill(name);
        return;
      }
      process.kill(-child.pid, name);
    } catch (_) {
      try { child.kill(name); } catch (__) { /* it is already gone */ }
    }
  };
  signal("SIGTERM");
  // The timer is NOT unref'd: it has to fire while the supervisor waits for
  // the group to drain, and an unref'd timer never does.
  const kill = setTimeout(() => {
    signal("SIGKILL");
  }, STOP_GRACE_MS);
  return kill;
}

/**
 * Whether the process group of the writer still has members.
 *
 * A writer that spawned a child that ignores the request to stop keeps the
 * group alive after the direct child exited. The supervisor waits for the
 * group to drain, so that such a writer cannot outlive the publication.
 */
function groupIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

/**
 * The supervisor: it runs the writer and watches the lock.
 *
 * It is a separate process because the callers are synchronous: a
 * synchronous caller cannot watch a child while the child runs.
 *
 * The supervisor writes the writer's output to FILES, not to pipes: a
 * build that prints megabytes must not be killed by a buffer limit, and a
 * writer that keeps the pipe open must not keep the framework waiting.
 */
function supervise() {
  const { spawn } = require("node:child_process");
  const lockPath = process.env.GRAPHIFY_UPDATE_LOCK || "";
  const token = process.env.GRAPHIFY_UPDATE_TOKEN || "";
  const displacedPath = process.env.GRAPHIFY_UPDATE_DISPLACED || "";
  const cwd = process.env.GRAPHIFY_UPDATE_CWD || process.cwd();
  const timeoutMs = Number(process.env.GRAPHIFY_UPDATE_TIMEOUT_MS) || 120000;
  const stdoutPath = process.env.GRAPHIFY_UPDATE_STDOUT || "";
  const stderrPath = process.env.GRAPHIFY_UPDATE_STDERR || "";
  const reportPath = process.env.GRAPHIFY_UPDATE_REPORT || "";
  let argv = ["graphify", "update", "."];
  try {
    const parsed = JSON.parse(process.env.GRAPHIFY_UPDATE_ARGV || "null");
    if (Array.isArray(parsed) && parsed.length > 0) argv = parsed.map(String);
  } catch (_) { /* the default arguments are used */ }

  let child = null;
  let lost = false;
  let timedOut = false;
  let finished = false;
  let stopTimer = null;

  const report = (payload) => {
    if (!reportPath) return;
    try {
      fs.writeFileSync(reportPath, JSON.stringify(payload));
    } catch (_) { /* the report is best-effort */ }
  };

  const poll = setInterval(() => {
    if (finished || !child) return;
    if (lockStillHeld(lockPath, token, displacedPath)) return;
    // The lock is gone: the rewrite is not allowed to finish.
    lost = true;
    if (!stopTimer) stopTimer = stopChild(child);
  }, POLL_MS);

  const timer = setTimeout(() => {
    if (finished || !child) return;
    timedOut = true;
    if (!stopTimer) stopTimer = stopChild(child);
  }, timeoutMs);

  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearInterval(poll);
    clearTimeout(timer);
    if (stopTimer) clearTimeout(stopTimer);
    process.exitCode = code;
  };

  let outFd = null;
  let errFd = null;
  try {
    if (stdoutPath) outFd = fs.openSync(stdoutPath, "a");
    if (stderrPath) errFd = fs.openSync(stderrPath, "a");
  } catch (_) {
    outFd = null;
    errFd = null;
  }

  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["ignore", outFd === null ? "inherit" : outFd, errFd === null ? "inherit" : errFd],
      env: process.env,
      // The child leads its own process group, so the whole group can be
      // stopped when the lock is lost.
      detached: process.platform !== "win32",
    });
  } catch (err) {
    report({ status: "error", reason: "spawn_failed", message: String(err && err.message) });
    finish(1);
    return;
  }
  child.on("error", (err) => {
    report({ status: "error", reason: "spawn_failed", message: String(err && err.message) });
    finish(1);
  });
  child.on("exit", (code, signal) => {
    // The direct child is gone, but the group it led may still have
    // members: a writer that ignores the request to stop keeps writing.
    // The supervisor waits for the group to drain before it reports, so the
    // framework never publishes while a writer is still running.
    const drain = setInterval(() => {
      if (!groupIsAlive(child.pid)) {
        clearInterval(drain);
        if (stopTimer) clearTimeout(stopTimer);
        if (lost) { report({ status: "lock_lost" }); finish(LOCK_LOST_EXIT); return; }
        if (timedOut) { report({ status: "timeout" }); finish(TIMEOUT_EXIT); return; }
        report({ status: "ok", exitCode: code === null ? 1 : code, signal: signal || null });
        finish(code === null ? 1 : code);
        return;
      }
    }, POLL_MS);
    // The group is given a bounded time to drain. When it does not, it is
    // killed: a writer that survives the kill can no longer damage the
    // public graph, because it only ever writes into the staging area.
    const deadline = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) { /* best-effort */ }
    }, GROUP_DRAIN_MS);
    if (typeof deadline.unref === "function") deadline.unref();
  });
}

/**
 * The report of the supervisor, parsed out of its report file.
 */
function parseReport(text) {
  const raw = String(text || "");
  for (const line of raw.split("\n")) {
    if (!line.startsWith(REPORT_PREFIX)) continue;
    try {
      return JSON.parse(line.slice(REPORT_PREFIX.length).trim());
    } catch (_) { /* the report is best-effort */ }
  }
  try {
    return JSON.parse(raw.trim());
  } catch (_) {
    return null;
  }
}

/**
 * Read a file, bounded: the caller gets at most `limit` bytes.
 */
function readBounded(file, limit = MAX_REPORTED_OUTPUT) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
  if (raw.length <= limit) return raw;
  return raw.slice(0, limit) + "\n...[output truncated by the framework]\n";
}

/**
 * Prepare the staging directory of one update.
 *
 * The staging directory starts as a copy of the INPUT of the writer: the
 * previous graph, the manifest and the root marker. Without them the CLI
 * would not find a graph and would run a FULL build instead of an
 * incremental one.
 *
 * The cache is MOVED into the staging area: the writer works on it, and a
 * copy of a large cache would cost as much as the build itself. A cache
 * that is lost is only a cache that is rebuilt on demand.
 */
function prepareStaging(projectRoot, staging) {
  const out = graphOutDir(projectRoot);
  fs.mkdirSync(staging, { recursive: true });
  for (const name of SEED_FILES) {
    try {
      fs.copyFileSync(path.join(out, name), path.join(staging, name));
    } catch (_) { /* the file is not there */ }
  }
  const cache = path.join(out, "cache");
  const stagedCache = path.join(staging, "cache");
  try {
    if (fs.statSync(cache).isDirectory()) fs.renameSync(cache, stagedCache);
  } catch (_) { /* there is no cache */ }
  return staging;
}

/**
 * Throw the staging directory away.
 *
 * Everything the writer produced is discarded: the writer was not allowed
 * to publish, so its output is not a graph anybody may read.
 */
function discardStaging(staging) {
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

/**
 * Publish the staged output into the public output directory.
 *
 * The publication happens while the publication gate is held and while the
 * lock is still held, so no other participant of the protocol can publish
 * at the same time. The graph itself is published with ONE rename, so a
 * reader never sees a half-written graph.
 */
function publishStagedOutput(projectRoot, staging, lock) {
  const out = graphOutDir(projectRoot);
  const stagedGraph = path.join(staging, "graph.json");
  if (!fs.existsSync(stagedGraph)) {
    return { ok: false, reason: "no_staged_graph" };
  }
  const gate = acquireGate(projectRoot, REBUILD_GATE, { timeoutMs: 0 });
  if (!gate) return { ok: false, reason: "gate_busy" };
  try {
    if (lock && typeof lock.isHeld === "function" && !lock.isHeld()) {
      return { ok: false, reason: "lock_lost" };
    }
    fs.mkdirSync(out, { recursive: true });
    for (const name of PUBLISHED_FILES) {
      const from = path.join(staging, name);
      if (!fs.existsSync(from)) continue;
      try { fs.renameSync(from, path.join(out, name)); } catch (_) { /* best-effort */ }
    }
    // The cache is a directory: the old one is moved aside first, so the
    // rename cannot fail on a non-empty target. The old one is moved into
    // the STAGING area, which lives under `.agent/`: the temporary file is
    // therefore ignored by the project's own ignore rules, and it is
    // removed together with the staging directory.
    const stagedCache = path.join(staging, "cache");
    if (fs.existsSync(stagedCache)) {
      const oldCache = path.join(staging, "superseded-cache");
      try { fs.renameSync(path.join(out, "cache"), oldCache); } catch (_) { /* there is none */ }
      try { fs.renameSync(stagedCache, path.join(out, "cache")); } catch (_) { /* best-effort */ }
    }
    // The graph is the commit point of the publication.
    fs.renameSync(stagedGraph, path.join(out, "graph.json"));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "publish_failed" };
  } finally {
    gate.release();
  }
}

/**
 * Run the incremental update under the lock, and keep the graph write
 * isolated.
 *
 * Returns { ok, status, stdout, stderr, reason?, lockLost? }.
 */
function runGuardedUpdate({
  projectRoot,
  lock,
  timeoutMs = 120000,
  argv = ["graphify", "update", "."],
  env = null,
} = {}) {
  if (!lock) return { ok: false, status: 1, stdout: "", stderr: "", reason: "no_lock" };

  const out = graphOutDir(projectRoot);
  const graph = path.join(out, "graph.json");
  // The hash of the PUBLIC graph before the update. The writer must not
  // touch it: a writer that writes the public graph directly ignores the
  // staging directory, and the isolation the framework relies on is then
  // gone. The hash is what proves that it did not.
  const publicBefore = hashFile(graph);

  const token = String(lock.token || crypto.randomBytes(8).toString("hex"));
  const staging = path.join(stagingDir(projectRoot), token + "-" + crypto.randomBytes(6).toString("hex"));
  const logs = rebuildLogDir(projectRoot);
  const stdoutPath = path.join(logs, "density-update-" + token + "-" + process.pid + ".stdout.log");
  const stderrPath = path.join(logs, "density-update-" + token + "-" + process.pid + ".stderr.log");
  const reportPath = path.join(logs, "density-update-" + token + "-" + process.pid + ".report.json");

  try {
    fs.mkdirSync(logs, { recursive: true });
  } catch (_) { /* the logs are best-effort */ }
  prepareStaging(projectRoot, staging);

  const displaced = path.join(pluginDir(projectRoot), ".density-displaced", token);
  const childEnv = Object.assign({}, process.env, env || {}, {
    // The writer writes into the staging directory. This is what keeps it
    // away from the public graph.
    GRAPHIFY_OUT: staging,
    GRAPHIFY_UPDATE_LOCK: lock.path,
    GRAPHIFY_UPDATE_DISPLACED: displaced,
    GRAPHIFY_UPDATE_TOKEN: token,
    GRAPHIFY_UPDATE_CWD: String(projectRoot),
    GRAPHIFY_UPDATE_TIMEOUT_MS: String(timeoutMs),
    GRAPHIFY_UPDATE_ARGV: JSON.stringify(argv),
    GRAPHIFY_UPDATE_STDOUT: stdoutPath,
    GRAPHIFY_UPDATE_STDERR: stderrPath,
    GRAPHIFY_UPDATE_REPORT: reportPath,
  });

  const result = spawnSync(
    process.execPath,
    [__filename, "--supervise"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs + 15000,
      env: childEnv,
    }
  );

  const stdout = readBounded(stdoutPath);
  const stderr = readBounded(stderrPath);
  let report = null;
  try { report = parseReport(fs.readFileSync(reportPath, "utf8")); } catch (_) { report = null; }

  const cleanup = () => {
    discardStaging(staging);
    for (const file of [stdoutPath, stderrPath, reportPath]) {
      try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
    }
  };

  if (result.error) {
    cleanup();
    return {
      ok: false,
      status: 1,
      stdout,
      stderr: stderr + String(result.error.message || ""),
      reason: "supervisor_failed",
    };
  }

  const lockLost = result.status === LOCK_LOST_EXIT || (report && report.status === "lock_lost");
  if (lockLost) {
    // The update was stopped because the lock was lost. The staged output is
    // thrown away: the public graph was never written by this writer, so
    // there is nothing to restore and nothing to overwrite.
    cleanup();
    return {
      ok: false,
      status: 1,
      stdout,
      stderr,
      reason: "lock_lost",
      lockLost: true,
      restored: false,
      restoreReason: "never_published",
    };
  }
  if (result.status === TIMEOUT_EXIT || (report && report.status === "timeout")) {
    cleanup();
    return {
      ok: false,
      status: 1,
      stdout,
      stderr,
      reason: "timeout",
    };
  }
  if (result.status !== 0) {
    cleanup();
    return {
      ok: false,
      status: result.status === null ? 1 : result.status,
      stdout,
      stderr,
      reason: (report && report.reason) || "update_failed",
    };
  }

  // The writer finished. The public graph must NOT have been touched by it:
  // a writer that ignored the staging directory wrote the public graph
  // directly, and the framework cannot tell which of the two graphs is the
  // one it may publish.
  const publicAfter = hashFile(graph);
  if (publicAfter !== publicBefore) {
    cleanup();
    return {
      ok: false,
      status: 1,
      stdout,
      stderr: stderr + "\n[graphify] the writer wrote the public graph instead of the staging area; the update was refused\n",
      reason: "isolation_violated",
    };
  }

  const published = publishStagedOutput(projectRoot, staging, lock);
  cleanup();
  if (!published.ok) {
    return {
      ok: false,
      status: 1,
      stdout,
      stderr,
      reason: published.reason,
    };
  }
  return {
    ok: true,
    status: 0,
    stdout,
    stderr,
  };
}

if (require.main === module && process.argv.includes("--supervise")) {
  supervise();
}

module.exports = {
  LOCK_LOST_EXIT,
  TIMEOUT_EXIT,
  REPORT_PREFIX,
  runGuardedUpdate,
  supervise,
  hashFile,
  lockStillHeld,
  prepareStaging,
  discardStaging,
  publishStagedOutput,
};

