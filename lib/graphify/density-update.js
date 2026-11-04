"use strict";

/**
 * The guarded graph update (issue #154).
 *
 * The incremental update REWRITES the graph. The rewrite is done by the
 * external `graphify` CLI, so the framework cannot make it part of a
 * transaction: the framework can only decide WHETHER the rewrite may
 * happen, and it can undo a rewrite that was not allowed.
 *
 * The lock is what makes the rewrite exclusive. A holder can lose the
 * lock WHILE the rewrite runs -- the lock can be reclaimed as stale, or
 * the reclaim can fence the holder out -- and a check after the rewrite
 * only says that something went wrong. It does not undo the rewrite: the
 * graph on disk is the DEGRADED graph of a holder that had no authority
 * any more, and it overwrote the graph of the holder that replaced it.
 *
 * So the rewrite runs under a SUPERVISOR:
 *
   - the supervisor watches the lock while the rewrite runs and STOPS the
     rewrite as soon as the lock is gone, so a displaced holder does not
     get to finish its write;
   - the framework takes a SNAPSHOT of the graph before the rewrite and
     puts it back when the rewrite was not allowed to happen, so the
     graph the displaced holder published does not survive.
 *
 * The supervisor is a separate process on purpose: the caller is
 * SYNCHRONOUS, and a synchronous caller cannot watch a child while it
 * runs.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { graphPath, pluginDir } = require("./density-files");

// The exit code the supervisor uses when it stopped the update because
// the lock was lost. It is distinct from every exit code the Graphify CLI
// uses, so a failed update is never mistaken for a lost lock.
const LOCK_LOST_EXIT = 75;

// The exit code the supervisor uses when the update ran out of time.
const TIMEOUT_EXIT = 124;

// How often the supervisor looks at the lock. The window between the
// loss of the lock and the stop of the rewrite is one poll.
const POLL_MS = 40;

// The prefix of the line the supervisor writes its report on. It is on
// STDERR, because STDERR is where the Graphify CLI writes as well, and
// the report has to be told apart from the output of the update.
const REPORT_PREFIX = "CORTEX-DENSITY-UPDATE ";

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
  // script in most installations, and the shell's own child would keep the
  // pipes open -- and keep writing the graph -- after the shell is gone.
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
  const kill = setTimeout(() => {
    signal("SIGKILL");
  }, 2000);
  if (typeof kill.unref === "function") kill.unref();
}

/**
 * The supervisor: it runs the update and watches the lock.
 *
 * It is a separate process because the callers are synchronous: a
 * synchronous caller cannot watch a child while the child runs.
 */
function supervise() {
  const { spawn } = require("node:child_process");
  const lockPath = process.env.GRAPHIFY_UPDATE_LOCK || "";
  const token = process.env.GRAPHIFY_UPDATE_TOKEN || "";
  const displacedPath = process.env.GRAPHIFY_UPDATE_DISPLACED || "";
  const cwd = process.env.GRAPHIFY_UPDATE_CWD || process.cwd();
  const graph = process.env.GRAPHIFY_UPDATE_GRAPH || "";
  const timeoutMs = Number(process.env.GRAPHIFY_UPDATE_TIMEOUT_MS) || 120000;
  let argv = ["graphify", "update", "."];
  try {
    const parsed = JSON.parse(process.env.GRAPHIFY_UPDATE_ARGV || "null");
    if (Array.isArray(parsed) && parsed.length > 0) argv = parsed.map(String);
  } catch (_) { /* the default arguments are used */ }

  let child = null;
  let lost = false;
  let timedOut = false;
  let finished = false;

  const poll = setInterval(() => {
    if (finished || !child) return;
    if (lockStillHeld(lockPath, token, displacedPath)) return;
    // The lock is gone: the rewrite is not allowed to finish.
    lost = true;
    stopChild(child);
  }, POLL_MS);

  const timer = setTimeout(() => {
    if (finished || !child) return;
    timedOut = true;
    stopChild(child);
  }, timeoutMs);

  const report = () => {
    if (!graph) return;
    let hash = null;
    let size = null;
    try {
      const stat = fs.statSync(graph);
      size = stat.size;
    } catch (_) { /* the graph is gone */ }
    hash = hashFile(graph);
    try {
      // A SYNCHRONOUS write: a report that is written when the process
      // exits must not be lost in a buffer.
      fs.writeSync(2, REPORT_PREFIX + JSON.stringify({ hash, size }) + "\n");
    } catch (_) { /* the report is best-effort */ }
  };

  const finish = (code) => {
    finished = true;
    clearInterval(poll);
    clearTimeout(timer);
    report();
    process.exitCode = code;
  };

  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
      // The child leads its own process group, so the whole group can be
      // stopped when the lock is lost.
      detached: process.platform !== "win32",
    });
  } catch (err) {
    finish(1);
    return;
  }
  child.on("error", (err) => {
    try {
      fs.writeSync(2, "CORTEX-DENSITY-UPDATE-ERROR " + String(err && err.message) + "\n");
    } catch (_) { /* best-effort */ }
    finish(1);
  });
  child.on("exit", (code, signal) => {
    if (lost) { finish(LOCK_LOST_EXIT); return; }
    if (timedOut) { finish(TIMEOUT_EXIT); return; }
    finish(code === null ? 1 : code);
  });
}

/**
 * The report of the supervisor, parsed out of its STDERR.
 */
function parseReport(stderr) {
  const text = String(stderr || "");
  for (const line of text.split("\n")) {
    if (!line.startsWith(REPORT_PREFIX)) continue;
    try {
      return JSON.parse(line.slice(REPORT_PREFIX.length).trim());
    } catch (_) { /* the report is best-effort */ }
  }
  return null;
}

/**
 * Put the graph back the way it was.
 *
 * The restore is done by CONTENT: the graph is put back only when the
 * file on disk is still the one the update left behind. A graph that a
 * foreign holder published in the meantime is NOT touched -- that graph
 * belongs to the holder that has the authority.
 */
function restoreGraph(graph, snapshot, report) {
  const currentHash = hashFile(graph);
  if (currentHash === null) return { restored: false, reason: "graph_missing" };
  // The graph on disk is not the one the update left behind: somebody
  // else published a graph after it, and that graph stands.
  if (report && report.hash && currentHash !== report.hash) {
    return { restored: false, reason: "graph_replaced" };
  }
  if (!snapshot) return { restored: false, reason: "no_snapshot" };
  if (snapshot.hash === currentHash) return { restored: false, reason: "unchanged" };
  const temporary = path.join(
    path.dirname(graph),
    "." + path.basename(graph) + ".restore-" + process.pid + "-" + crypto.randomBytes(6).toString("hex")
  );
  try {
    fs.writeFileSync(temporary, snapshot.bytes);
    fs.renameSync(temporary, graph);
    return { restored: true };
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (_) { /* best-effort */ }
    return { restored: false, reason: err && err.code ? err.code : "restore_failed" };
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
  const graph = graphPath(projectRoot);
  // The SNAPSHOT of the graph before the update. It is what the restore
  // puts back when the update was not allowed to publish.
  let snapshot = null;
  try {
    const bytes = fs.readFileSync(graph);
    snapshot = {
      bytes,
      hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (_) { snapshot = null; }

  const displaced = path.join(pluginDir(projectRoot), ".density-displaced", String(lock.token));
  const result = spawnSync(
    process.execPath,
    [__filename, "--supervise"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs + 15000,
      env: Object.assign({}, process.env, env || {}, {
        GRAPHIFY_UPDATE_LOCK: lock.path,
        GRAPHIFY_UPDATE_DISPLACED: displaced,
        GRAPHIFY_UPDATE_TOKEN: String(lock.token),
        GRAPHIFY_UPDATE_CWD: String(projectRoot),
        GRAPHIFY_UPDATE_GRAPH: String(graph),
        GRAPHIFY_UPDATE_TIMEOUT_MS: String(timeoutMs),
        GRAPHIFY_UPDATE_ARGV: JSON.stringify(argv),
      }),
    }
  );

  if (result.error) {
    return {
      ok: false,
      status: 1,
      stdout: result.stdout || "",
      stderr: (result.stderr || "") + String(result.error.message || ""),
      reason: "supervisor_failed",
    };
  }
  const report = parseReport(result.stderr);
  const lockLost = result.status === LOCK_LOST_EXIT;
  if (lockLost) {
    // The update was stopped because the lock was lost. The graph is put
    // back, so the displaced holder does not publish a degraded graph
    // over the graph of the holder that replaced it.
    const restored = restoreGraph(graph, snapshot, report);
    return {
      ok: false,
      status: 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      reason: "lock_lost",
      lockLost: true,
      restored: restored.restored,
      restoreReason: restored.reason,
    };
  }
  if (result.status === TIMEOUT_EXIT) {
    return {
      ok: false,
      status: 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      reason: "timeout",
    };
  }
  return {
    ok: result.status === 0,
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
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
  restoreGraph,
};
