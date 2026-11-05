"use strict";

/**

 * The pending update queue (issue #154).

 *

 * When the rebuild lock is held, an incremental update cannot run. The

 * request is not lost: it is recorded in a one-file-per-request queue and

 * replayed once the lock is free.

 */



const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");

const { spawn } = require("node:child_process");



const {

  pluginDir,

  writeFileAtomic,

  publishExclusive,

  readJsonFile,

} = require("./density-files");

const { isProcessAlive } = require("./density-lock");

const { BASELINE_SCHEMA_VERSION } = require("./density-baseline");



// How many times a deferred update may be replayed before the runner stops
// respawning itself for it. Without a bound, a permanently failing
// `graphify update .` would make every runner start another runner, and
// the project would spawn processes forever.
const PENDING_MAX_ATTEMPTS = 5;

// A claimed pending file that is older than this, and whose owner is gone,
// was left behind by a consumer that died between claiming the request and
// processing it. The request is put back instead of being lost.
const PENDING_CLAIM_STALE_MS = 6 * 60 * 60 * 1000;

// -- The pending update queue ------------------------------------------------

// When the rebuild lock is held, an incremental update cannot run: the full
// rebuild that holds the lock is about to publish a complete graph, and a
// second writer would only race it. The request is not LOST, though -- it
// is recorded in a pending queue and replayed once the lock is free.
//
// The queue is a DIRECTORY of one-file-per-request, not a single JSON
// document. A single document cannot express the state transitions safely:
// two writers would overwrite each other's paths, a consumer that read the
// document and then deleted it would also delete whatever a writer had
// published in between, and two consumers would both claim the same
// request. One file per request removes all three races:
//
//   - a writer creates its file EXCLUSIVELY, so two writers never collide;
//   - a consumer removes the file it read, and only the consumer whose
//     removal succeeds owns the request;
//   - a writer publishing a NEW file is unaffected by a consumer removing an
//     OLD one.
//
// The file name is derived from the request's paths, so two requests for the
// same paths collapse into one -- they describe the same work.
//
// The name also carries a UNIQUE suffix. Without it, a file name identifies
// the request only as long as it is the only file with that name: a
// consumer that read the file, then a writer that removed and recreated the
// SAME name, then the consumer's unlink would delete the NEW file while the
// consumer processed the OLD content -- the new request is lost and the old
// one is replayed twice. The unique suffix makes every generation of a
// request a distinct file, so a consumer can only ever remove the exact
// file it read.
function pendingDir(projectRoot) {
  return path.join(pluginDir(projectRoot), ".density-pending");
}

function pendingFileName(changedPaths, attempts = 0) {
  const sorted = [...new Set(changedPaths.map((p) => String(p)))].sort();
  const digest = crypto.createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 32);
  const unique = process.pid + "-" + crypto.randomBytes(6).toString("hex");
  // The attempt counter lives in the NAME, not only in the content.
  //
  // Handing a request back to the queue is a RENAME, which is atomic, and
  // a rename cannot rewrite the content. An attempt counter that lived
  // only in the content could therefore not be incremented atomically: it
  // would need a separate rewrite, and a crash during that rewrite would
  // leave a truncated request that no recovery could parse.
  return digest + "-a" + (Number(attempts) || 0) + "-" + unique + ".json";
}

/**
 * Parse the digest and the attempt counter out of a pending file name.
 *
 * The name is `<digest>-a<attempts>-<pid>-<random>.json`. Returns null
 * when the name does not belong to a pending request.
 */
function parsePendingName(name) {
  const match = /^([0-9a-f]{32})-a(\d+)-[0-9]+-[0-9a-f]+\.json$/.exec(name);
  if (!match) return null;
  const attempts = Number(match[2]);
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  return { digest: match[1], attempts };
}

/**
 * Record that an incremental update still has to run.
 *
 * Returns { ok, path }.
 */
function writePendingUpdate(projectRoot, { changedPaths = [], semanticPaths = [], sourceHead = null, branch = null, attempts = 0 } = {}) {
  const paths = [...new Set(changedPaths.map((p) => String(p)).filter(Boolean))].sort();
  if (paths.length === 0) return { ok: false, reason: "no_paths" };
  const dir = pendingDir(projectRoot);
  const target = path.join(dir, pendingFileName(paths, attempts));
  const payload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    changedPaths: paths,
    // The semantic paths are kept apart: an incremental update only
    // refreshes the code graph, so a deferred SEMANTIC change needs the
    // stale marker, not another update.
    semanticPaths: [...new Set(semanticPaths.map((p) => String(p)).filter(Boolean))].sort(),
    sourceHead: sourceHead || null,
    branch: branch || null,
    attempts: Number(attempts) || 0,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    // The target name is unique, so the atomic publish always succeeds:
    // two writers never collide, and a writer publishing a NEW request is
    // never affected by a consumer removing an OLD one. The publish is a
    // rename of a private temp file, so a consumer can only ever observe a
    // COMPLETE request -- the fallback path of `publishExclusive`, which
    // writes into the target in place, would expose a half-written one.
    writeFileAtomic(target, JSON.stringify(payload, null, 2) + "\n");
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "pending_write_failed" };
  }
}

/**
 * Whether the pending queue holds at least one request.
 */
function hasPendingUpdate(projectRoot) {
  try {
    const dir = pendingDir(projectRoot);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch (_) {
    return false;
  }
}

/**
 * Whether the pending queue holds anything at all -- a visible request, or
 * an abandoned claim that can still be recovered.
 *
 * The abandoned claim is invisible to the queue (the claim is what makes
 * it invisible), but it still describes a commit that has to reach the
 * graph. A scheduler that only looks at the visible requests would decide
 * there is nothing to do and never recover it.
 */
function hasRecoverablePending(projectRoot) {
  if (hasPendingUpdate(projectRoot)) return true;
  try {
    const dir = pendingDir(projectRoot);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((name) => {
      if (!name.startsWith(".claimed-") || !name.endsWith(".json")) return false;
      const meta = parseClaimName(name);
      if (!meta) return false;
      // Only an abandoned claim -- one whose owner is gone and that is old
      // enough -- is worth recovering.
      return !isProcessAlive(meta.pid) && (Date.now() - meta.claimedAt) > PENDING_CLAIM_STALE_MS;
    });
  } catch (_) {
    return false;
  }
}

/**
 * Claim the pending requests. A request is owned by the caller that
 * successfully REMOVED its file, so two consumers never process the same
 * request.
 *
 * Returns a merged request, or null when there is nothing queued.
 */
function takePendingUpdate(projectRoot) {
  const dir = pendingDir(projectRoot);
  // Recover the requests that a consumer CLAIMED but never finished.
  recoverAbandonedClaims(projectRoot, dir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const claimed = [];
  const claims = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    const meta = parsePendingName(name);
    if (!meta) continue;
    // CLAIM the file by renaming it to a name only this consumer knows.
    // The rename is atomic, so exactly one consumer can move a given file
    // and only the consumer whose rename succeeded owns the request. A
    // writer that publishes a new request creates a DIFFERENT file and is
    // unaffected.
    //
    // The claim name encodes the OWNING PID and the claim time, so no
    // metadata has to be written INTO the claimed file. Writing the record
    // into the file would mean an in-place rewrite: a crash during that
    // rewrite would leave a truncated file that no recovery could parse,
    // and the request would be lost for good.
    // The attempt counter travels in the CLAIM name as well as in the
    // request name. The body of a claimed file still carries the counter it
    // was written with, and a hand-back renames the file without rewriting
    // it -- so the body alone is not authoritative, and a recovery that read
    // the body would RESET the retry budget of a request that had already
    // failed several times.
    const claimName = ".claimed-" + process.pid + "-" + Date.now()
      + "-" + crypto.randomBytes(6).toString("hex")
      + "-a" + meta.attempts + ".json";
    const claimedPath = path.join(dir, claimName);
    try {
      fs.renameSync(file, claimedPath);
    } catch (_) {
      continue;
    }
    const parsed = readJsonFile(claimedPath);
    if (!parsed || typeof parsed !== "object") {
      // A corrupt request is dropped; it must not block the queue forever.
      try { fs.unlinkSync(claimedPath); } catch (_) { /* best-effort */ }
      continue;
    }
    claims.push(claimedPath);
    claimed.push({
      changedPaths: Array.isArray(parsed.changedPaths) ? parsed.changedPaths : [],
      semanticPaths: Array.isArray(parsed.semanticPaths) ? parsed.semanticPaths : [],
      sourceHead: parsed.sourceHead || null,
      branch: parsed.branch || null,
      // The attempt counter in the NAME is authoritative: it is what the
      // hand-back rename could change atomically. The counter in the
      // content is the value the request was written with.
      attempts: meta.attempts,
    });
  }
  if (claimed.length === 0) return null;
  // The EXHAUSTED requests are separated out before the merge. Merging them
  // into the batch would hand their failure history to a FRESH request that
  // happens to be in the same batch: the fresh request would inherit the
  // exhausted counter and be dropped without ever being attempted. So the
  // exhausted ones are reported on their own, and the caller drops them
  // without replaying them, while the rest are replayed as usual.
  const live = claimed.filter((c) => (c.attempts || 0) < PENDING_MAX_ATTEMPTS);
  const exhausted = claimed.filter((c) => (c.attempts || 0) >= PENDING_MAX_ATTEMPTS);
  if (live.length === 0) {
    // EVERY branch returns the same contract: `claims` are the claim files
    // of the requests that are still alive, `exhaustedClaims` are the claim
    // files of the requests that are dropped. The earlier branch returned
    // the exhausted claims under `claims` and no `exhaustedClaims` at all,
    // so the caller -- which deletes `exhaustedClaims` -- never removed
    // them, and the queue accumulated claim files that nothing could ever
    // clear.
    if (exhausted.length === 0) return null;
    return {
      changedPaths: [],
      attempts: 0,
      exhausted,
      claims: [],
      exhaustedClaims: claims.slice(),
    };
  }
  // The requests are NOT all merged into one replay. Merging them hands the
  // highest attempt counter to every request in the batch, so a fresh
  // request that merely happened to be queued alongside a request that has
  // failed four times inherits that budget and is dropped after a single
  // further failure -- without ever having been retried properly.
  //
  // The requests are therefore replayed in groups of equal attempt count,
  // oldest first. Every request is attempted as many times as it has
  // failed, and no request inherits another one's history.
  const groups = [];
  for (const entry of live) {
    const index = claimed.indexOf(entry);
    const attempts = entry.attempts || 0;
    let group = groups.find((g) => g.attempts === attempts);
    if (!group) {
      group = { attempts, entries: [], claims: [] };
      groups.push(group);
    }
    group.entries.push(entry);
    if (index >= 0 && claims[index]) group.claims.push(claims[index]);
  }
  groups.sort((a, b) => a.attempts - b.attempts);
  const liveClaims = [];
  for (const entry of live) {
    const index = claimed.indexOf(entry);
    if (index >= 0 && claims[index]) liveClaims.push(claims[index]);
  }
  return {
    changedPaths: [...new Set(live.flatMap((c) => c.changedPaths))].sort(),
    sourceHead: (live.find((c) => c.sourceHead) || {}).sourceHead || null,
    branch: (live.find((c) => c.branch) || {}).branch || null,
    attempts: live.reduce((max, c) => Math.max(max, c.attempts || 0), 0),
    exhausted,
    // The replay groups, each with its own attempt counter and its own
    // claims.
    groups: groups.map((g) => ({
      attempts: g.attempts,
      changedPaths: [...new Set(g.entries.flatMap((c) => c.changedPaths))].sort(),
      semanticPaths: [...new Set(g.entries.flatMap((c) => c.semanticPaths || []))].sort(),
      sourceHead: (g.entries.find((c) => c.sourceHead) || {}).sourceHead || null,
      branch: (g.entries.find((c) => c.branch) || {}).branch || null,
      claims: g.claims,
    })),
    // The claim files are NOT removed here. They are removed only when the
    // caller confirms that the replay actually SUCCEEDED, so a consumer
    // that dies before the replay leaves the request on disk and it can be
    // recovered.
    claims: liveClaims,
    exhaustedClaims: claims.filter((c) => !liveClaims.includes(c)),
  };
}

/**
 * Confirm that a claimed request was replayed successfully: the claim files
 * are removed, and the request is gone for good.
 *
 * The removal is a plain unlink of files the caller OWNS -- the claim names
 * are unique per claim -- so there is nothing to check against.
 */
function completePendingUpdate(claims) {
  for (const claim of claims || []) {
    try { fs.unlinkSync(claim); } catch (_) { /* best-effort */ }
  }
}

/**
 * Give a claimed request back to the queue because the replay did NOT
 * succeed.
 *
 * The hand-back is a RENAME into a fresh request name: it is atomic, so
 * exactly one consumer can move a given claim, and there is no window in
 * which the request is neither claimed nor visible. The earlier
 * implementation published a NEW request and then removed the claim, and
 * two consumers could both publish in between -- the request was then
 * replayed twice, and the queue ended up with duplicates.
 *
 * The attempt counter is carried over, so a request that keeps failing
 * eventually reaches the bound and is dropped instead of being retried
 * for ever.
 */
function releasePendingUpdate(projectRoot, claims, { attempts = 0 } = {}) {
  const dir = pendingDir(projectRoot);
  for (const claim of claims || []) {
    const parsed = readJsonFile(claim);
    if (!parsed || typeof parsed !== "object") {
      try { fs.unlinkSync(claim); } catch (_) { /* best-effort */ }
      continue;
    }
    const paths = Array.isArray(parsed.changedPaths) ? parsed.changedPaths : [];
    if (paths.length === 0) {
      try { fs.unlinkSync(claim); } catch (_) { /* best-effort */ }
      continue;
    }
    // The base counter comes from the CLAIM NAME: the body still carries the
    // counter the request was created with, because a hand-back renames the
    // file without rewriting it. A claim that carries NO suffix is a claim
    // of the older format: its counter lives in the body.
    const meta = parseClaimName(path.basename(claim));
    const current = meta && meta.attempts !== null
      ? meta.attempts
      : (Number(parsed.attempts) || 0);
    const next = Math.max(current, Number(attempts) || 0);
    const target = path.join(dir, pendingFileName(paths, next));
    try {
      fs.renameSync(claim, target);
    } catch (_) {
      // The claim is gone -- another consumer recovered it. Nothing to do.
    }
  }
}

/**
 * Put abandoned claims back into the queue.
 *
 * A claim records the pid that took it and when. A claim whose owner is
 * gone AND that is older than the stale window belonged to a consumer that
 * died mid-flight, so its request is returned to the queue.
 */
function recoverAbandonedClaims(projectRoot, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(".claimed-") || !name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    // The claim's owner and its claim time are encoded in the FILE NAME,
    // not in the file's content. Writing them into the content would mean
    // an in-place rewrite of the claimed file, and a crash during that
    // rewrite would leave a truncated file that no recovery could parse --
    // the request would be lost for good.
    const meta = parseClaimName(name);
    if (!meta) continue;
    const ownerAlive = isProcessAlive(meta.pid);
    if (ownerAlive) continue;
    const age = Date.now() - meta.claimedAt;
    if (age <= PENDING_CLAIM_STALE_MS) continue;
    const claim = readJsonFile(file);
    if (!claim || typeof claim !== "object") {
      // A claim that cannot be parsed carries no request, so there is
      // nothing to recover.
      try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
      continue;
    }
    const paths = Array.isArray(claim.changedPaths) ? claim.changedPaths : [];
    if (paths.length === 0) {
      try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
      continue;
    }
    // The request is returned under a fresh name, so the abandoned claim is
    // not simply renamed back into a name another writer may reuse.
    //
    // The recovery is a RENAME: it is atomic, so exactly one consumer can
    // recover a given claim. The earlier implementation published a new
    // request and then removed the claim, and two consumers could both
    // publish -- the request was then replayed twice, from two different
    // claims.
    //
    // The attempt counter is carried over, so the retry history of the
    // request survives the recovery.
    // The attempt counter comes from the CLAIM NAME, not from the body: the
    // body was not rewritten when the request was handed back, so it still
    // carries the counter the request was created with. Reading the body
    // would reset the retry budget of a request that had already failed
    // several times. A claim of the OLDER format carries no suffix: its
    // counter lives in the body, and there it is authoritative.
    const recovered = meta.attempts !== null ? meta.attempts : (Number(claim.attempts) || 0);
    const target = path.join(dir, pendingFileName(paths, recovered));
    try {
      fs.renameSync(file, target);
    } catch (_) {
      // Somebody else recovered it first.
    }
  }
}

/**
 * Parse the owner and the claim time out of a claim file name.
 *
 * The name is `.claimed-<pid>-<epochMillis>-<random>.json`, with an
 * optional `-a<attempts>` suffix that carries the retry budget of the
 * request. A claim written by an older version carries no suffix; its
 * budget is then read from the body.
 */
function parseClaimName(name) {
  // The attempt suffix is optional: a claim that was written by an older
  // version carries no counter, and it must still be recoverable instead of
  // lingering in the queue for ever. A missing suffix is NOT a zero: the
  // counter of such a claim lives in its body, and it must be read from
  // there. An explicit `-a0` IS a zero.
  const match = /^\.claimed-(\d+)-(\d+)-[0-9a-f]+(?:-a(\d+))?\.json$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  const claimedAt = Number(match[2]);
  const attempts = match[3] === undefined ? null : Number(match[3]);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(claimedAt)) return null;
  if (attempts !== null && (!Number.isFinite(attempts) || attempts < 0)) return null;
  return { pid, claimedAt, attempts };
}


/**
 * Start a DETACHED drain of the pending queue.
 *
 * A request that arrived while the lock was busy waits in the queue. The
 * holder of the lock drains it when it releases, so the request is not left
 * waiting for a later commit that may never come.
 *
 * The drain runs in the framework's own runner, in its "--drain-pending"
 * mode: it takes the lock itself, so it cannot race a rebuild that is
 * starting at the same time.
 *
 * Returns { started, pid } or { started: false, reason }.
 */
function startPendingDrain({ projectRoot, generation = 1 }) {
  if (!hasRecoverablePending(projectRoot)) return { started: false, reason: "nothing_pending" };

  // The drain takes the REBUILD lock itself, so two drains can never write
  // the graph at the same time: the second one waits for the first to
  // finish, and by then the queue is empty and it has nothing to do.
  //
  // There used to be a second, dedicated "scheduler" lock that made the
  // drain a singleton. It guarded nothing that the rebuild lock does not
  // already guard, and its handover to the drain process carried the same
  // race as the rebuild lock's handover: the starter rewrote the lock file
  // after the child had already released it, so the lock was RECREATED and
  // every later drain was refused for the whole stale window.

  const runner = path.join(__dirname, "full-rebuild-runner.js");
  try {
    const child = spawn(process.execPath, [runner, "--drain-pending"], {
      cwd: projectRoot,
      stdio: "ignore",
      detached: true,
      env: Object.assign({}, process.env, {
        // The generation of this drain in the follow-up chain, so the chain
        // has a bound.
        GRAPHIFY_DRAIN_GENERATION: String(generation),
      }),
    });
    child.unref();
    // An asynchronous spawn failure is reported through the `error` event,
    // NOT through a throw. Without a listener the unhandled `error` event
    // takes the whole process down. The request stays queued, so the next
    // consumer picks it up.
    child.on("error", () => { /* the request stays queued for the next consumer */ });
    return { started: true, pid: child.pid };
  } catch (_) {
    return { started: false, reason: "drain_spawn_failed" };
  }
}



module.exports = {

  PENDING_MAX_ATTEMPTS,

  PENDING_CLAIM_STALE_MS,

  pendingDir,

  pendingFileName,

  parsePendingName,

  writePendingUpdate,

  hasPendingUpdate,

  hasRecoverablePending,

  takePendingUpdate,

  completePendingUpdate,

  releasePendingUpdate,

  recoverAbandonedClaims,

  parseClaimName,

  startPendingDrain,

};
