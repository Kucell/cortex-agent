"use strict";

/**
 * Graphify freshness markers (T-GWG-001 / P-001 §4.6).
 *
 * When a Git hook observes a semantic-only change (documentation,
 * proposals, rules, images, etc.) the AST-level graph is left untouched.
 * To keep the resolver honest we MUST write a durable stale marker next
 * to the graph so subsequent queries can fail closed instead of
 * silently trusting the topology.
 *
 * The marker is JSON, written atomically next to `graph.json`. It is
 * always ignored by .gitignore so the marker never enters the source
 * tree as a regular product file.
 *
 * A reminder is stored as ITS OWN FILE. The single `.graphify-stale.json`
 * is a DERIVED view of the outstanding reminders -- it exists for the
 * consumers that read one file (the Graphify CLI), not as the truth.
 *
 * The reason is that one file that every writer OVERWRITES cannot hold
 * two reminders at once. A writer that published a semantic reminder and
 * a writer that published an update-failed reminder raced for the same
 * path, and the loser lost its reminder for good: the request it belongs
 * to had already been confirmed, so nothing would ever publish it again.
 * One file per reminder removes the race -- publishing is an exclusive
 * create of a file that nobody else touches, and clearing removes exactly
 * the files of the reminders that were answered.
 *
 * A marker carries:
 *   - schemaVersion
 *   - recordedAt (ISO timestamp)
 *   - kind: "semantic" | "incremental" | "force_rebuild_required" | "update_failed"
 *   - reason (human-readable)
 *   - changedPaths (relative paths observed in the semantic diff)
 *   - sourceHead (HEAD at the time the marker was written)
 *   - branch (branch at the time the marker was written, may be null)
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MARKER_FILENAME = ".graphify-stale.json";
const MARKER_RECORDS_DIRNAME = ".graphify-stale-records";
const MARKER_SCHEMA_VERSION = "1.0";

const KIND = Object.freeze({
  SEMANTIC: "semantic",
  INCREMENTAL: "incremental",
  FORCE_REBUILD: "force_rebuild_required",
  UPDATE_FAILED: "update_failed",
});

// The kinds a SUCCESSFUL INCREMENTAL UPDATE may clear.
//
// A SEMANTIC marker says "the semantic corpus is stale". An incremental
// update rebuilds the CODE corpus only -- it never regenerates the global
// `contains` / doc-reference edges of a fully built graph -- so it does
// not answer that reminder. A FORCE_REBUILD marker says "a full rebuild
// is required", and an incremental update is not one.
//
// Only the kinds that describe the incremental path itself are resolved by
// a successful incremental update. Clearing the others would drop a
// reminder that nothing has answered, and the reminder is the only
// persistent trace of the change it describes.
const CLEARABLE_BY_INCREMENTAL = Object.freeze([
  KIND.INCREMENTAL,
  KIND.UPDATE_FAILED,
]);

// The strength of a kind, strongest first.
//
// A reminder must never be DOWNGRADED by another writer. A failed update
// that overwrites a semantic reminder turns "the semantic corpus is stale"
// into "the update failed" -- and the next successful incremental update
// clears the second kind, so the semantic change loses its only persistent
// trace. With one record per reminder the downgrade cannot happen at all;
// the priority only decides which kind the DERIVED marker shows, and a
// semantic reminder therefore outranks the kinds an incremental update may
// clear.
const KIND_PRIORITY = Object.freeze({
  [KIND.FORCE_REBUILD]: 4,
  [KIND.SEMANTIC]: 3,
  [KIND.UPDATE_FAILED]: 2,
  [KIND.INCREMENTAL]: 1,
});

function recordsDir(graphDir) {
  return path.join(graphDir || "", MARKER_RECORDS_DIRNAME);
}

function markerPathOf(graphDir) {
  return path.join(graphDir || "", MARKER_FILENAME);
}

/**
 * Every outstanding reminder, one entry per record file.
 *
 * A record that cannot be read is skipped: it is not a reminder this
 * process can vouch for, and a broken file must not hide the reminders
 * that ARE readable.
 */
function listRecords(graphDir) {
  let names;
  try {
    names = fs.readdirSync(recordsDir(graphDir));
  } catch (_) {
    return [];
  }
  const records = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(recordsDir(graphDir), name);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    if (payload.schemaVersion !== MARKER_SCHEMA_VERSION) continue;
    const id = payload.markerId || name.slice(0, -5);
    records.push({ id, file, payload });
  }
  return records;
}

/**
 * The ids of the outstanding reminders, optionally of some kinds only.
 *
 * A caller that answers a set of reminders needs to know WHICH ones it
 * answered: a full rebuild answers the reminders that existed when it
 * took its input, and a reminder that was published after that moment
 * describes a change the rebuild did not see.
 */
function listRecordIds(graphDir, { kinds = null } = {}) {
  const allowed = (kind) => !Array.isArray(kinds) || kinds.includes(kind);
  return listRecords(graphDir)
    .filter((record) => allowed(record.payload.kind))
    .map((record) => record.id);
}

/**
 * The marker that the outstanding reminders ADD UP to.
 *
 * The kind is the strongest outstanding one; the paths are the union of
 * all of them, because every outstanding reminder describes a change that
 * is still unanswered.
 */
function deriveMarker(records) {
  if (!records || records.length === 0) return null;
  let strongest = null;
  for (const record of records) {
    const priority = KIND_PRIORITY[record.payload.kind] || 0;
    if (!strongest || priority > strongest.priority) {
      strongest = { priority, record };
    }
  }
  const paths = new Set();
  for (const record of records) {
    const listed = record.payload.changedPaths;
    if (!Array.isArray(listed)) continue;
    for (const p of listed) paths.add(p);
  }
  const chosen = strongest.record.payload;
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    markerId: chosen.markerId || strongest.record.id,
    recordedAt: chosen.recordedAt || null,
    kind: chosen.kind,
    reason: chosen.reason || null,
    changedPaths: [...paths].sort(),
    sourceHead: chosen.sourceHead === undefined ? null : chosen.sourceHead,
    branch: chosen.branch === undefined ? null : chosen.branch,
    // The records the derived marker is made of. The ids make the derived
    // marker a function of the records, so two readers that see the same
    // records see the same marker.
    recordIds: records.map((record) => record.id).sort(),
  };
}

/**
 * Publish the DERIVED marker for the consumers that read one file.
 *
 * The file is a cache: the records are the truth. A failure to write it
 * is reported, because the file is what the Graphify CLI reads -- but the
 * reminder itself is already durable in its record.
 */
function writeDerivedMarker(graphDir, derived) {
  const markerPath = markerPathOf(graphDir);
  if (!derived) {
    try {
      fs.unlinkSync(markerPath);
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        return { ok: false, reason: err.code || "unlink_failed" };
      }
    }
    return { ok: true };
  }
  const tmpPath = markerPath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(derived, null, 2));
    fs.renameSync(tmpPath, markerPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
    return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
  }
  return { ok: true };
}

/**
 * Write the single marker file of an OLDER version into a record, so a
 * reminder that was published before the record model existed is not lost
 * when the next writer publishes its own reminder.
 */
function migrateLegacyMarker(graphDir) {
  const markerPath = markerPathOf(graphDir);
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (_) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== "object" || data.schemaVersion !== MARKER_SCHEMA_VERSION) return null;
  if (!Object.values(KIND).includes(data.kind)) return null;
  // A file that carries `recordIds` is not a LEGACY reminder: it is the
  // DERIVED view that this version writes for the single-file consumers.
  // Importing it as a reminder would RE-CREATE a reminder that was
  // already answered -- the derived view of a semantic reminder outlives
  // the record itself until the next write refreshes it, so a reader that
  // found no records could resurrect the reminder that the last clear
  // removed. The records are the truth, and a derived file never becomes
  // a record again.
  if (Array.isArray(data.recordIds)) return null;
  const id = data.markerId || crypto.randomBytes(12).toString("hex");
  const payload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    markerId: id,
    recordedAt: data.recordedAt || new Date().toISOString(),
    kind: data.kind,
    reason: data.reason || null,
    changedPaths: Array.isArray(data.changedPaths) ? [...data.changedPaths].sort() : [],
    sourceHead: data.sourceHead === undefined ? null : data.sourceHead,
    branch: data.branch === undefined ? null : data.branch,
  };
  try {
    fs.mkdirSync(recordsDir(graphDir), { recursive: true });
    fs.writeFileSync(path.join(recordsDir(graphDir), id + ".json"), JSON.stringify(payload, null, 2), { flag: "wx" });
  } catch (_) {
    return null;
  }
  // The legacy file is now a record, so it is not a second copy of the
  // same reminder: leaving it there would let a reader that finds no
  // records fall back to a STALE view of the reminders.
  try {
    fs.unlinkSync(markerPath);
  } catch (_) { /* best-effort */ }
  return payload;
}

/**
 * The marker of an older version: one file, one reminder.
 *
 * Returns { present, kind, value }. A file that cannot be parsed has no
 * kind: it is then cleared like an unreadable reminder would be, because
 * nobody can tell what it stands for.
 */
function readLegacyMarker(graphDir) {
  return readLegacyMarkerAt(markerPathOf(graphDir));
}

/**
 * The marker of an older version at a given path.
 *
 * The path is a parameter so that a marker that was moved aside -- the
 * CLAIM of the single-file reminder -- can be read and examined on its
 * own.
 */
function readLegacyMarkerAt(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_) {
    return { present: false, kind: null, value: null };
  }
  let value = null;
  try {
    value = JSON.parse(raw);
  } catch (_) {
    return { present: true, kind: null, value: null, raw, identity: markerIdentity(raw) };
  }
  const kind = value && typeof value === "object" && typeof value.kind === "string"
    ? value.kind
    : null;
  return { present: true, kind, value, raw, identity: markerIdentity(raw) };
}

/**
 * Write a freshness marker into a graph directory. Atomic via rename.
 * Returns { ok, path } or { ok: false, reason }.
 */
function writeMarker({
  graphDir,
  kind,
  reason,
  changedPaths = [],
  sourceHead = null,
  branch = null,
  now = null,
  onBeforeCompaction = null,
}) {
  if (!graphDir) return { ok: false, reason: "graph_dir_required" };
  if (!Object.values(KIND).includes(kind)) {
    return { ok: false, reason: "invalid_kind" };
  }
  const markerPath = markerPathOf(graphDir);
  const payload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    // The ID of THIS reminder. Every write produces a new one, so two
    // generations of the marker are always distinguishable -- even when a
    // writer rewrote the file in place instead of replacing it.
    markerId: crypto.randomBytes(12).toString("hex"),
    recordedAt: now || new Date().toISOString(),
    kind,
    reason: reason || null,
    changedPaths: [...changedPaths].sort(),
    sourceHead,
    branch,
  };
  // The records that were there before this write. A record that a
  // concurrent writer publishes in the meantime is NOT among them, and it
  // is never removed by the compaction below.
  const beforeIds = new Set(listRecords(graphDir).map((record) => record.id));
  try {
    fs.mkdirSync(recordsDir(graphDir), { recursive: true });
    // The record is created EXCLUSIVELY: the id is unique, so the create
    // cannot overwrite a record that another writer published.
    fs.writeFileSync(
      path.join(recordsDir(graphDir), payload.markerId + ".json"),
      JSON.stringify(payload, null, 2),
      { flag: "wx" },
    );
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "write_failed" };
  }
  // A reminder that was published before the record model existed is kept:
  // it becomes a record of its own, so the next writer cannot overwrite
  // it.
  migrateLegacyMarker(graphDir);
  // A TEST SEAM: called after the record was published and BEFORE the
  // compaction. It injects the interleaving the compaction has to
  // survive: a reminder that a concurrent writer publishes in this
  // window describes a change this record does not know about.
  if (typeof onBeforeCompaction === "function") {
    try { onBeforeCompaction(); } catch (_) { /* the seam must not break the write */ }
  }
  //
  // The COMPACTION: the records that this record SUBSUMES -- the same
  // kind, and every one of their paths among this record's paths -- are
  // removed. Without it a reminder queue grows without bound, because a
  // mixed commit publishes a new semantic record every time.
  //
  // Only the records that were there BEFORE this write are eligible. A
  // record a concurrent writer published in the meantime describes a
  // change this record does not know about, and removing it would drop a
  // reminder that nobody has answered.
  const publishedPaths = new Set(payload.changedPaths);
  for (const record of listRecords(graphDir)) {
    if (record.id === payload.markerId) continue;
    if (!beforeIds.has(record.id)) continue;
    if (record.payload.kind !== payload.kind) continue;
    const listed = Array.isArray(record.payload.changedPaths)
      ? record.payload.changedPaths
      : [];
    if (!listed.every((p) => publishedPaths.has(p))) continue;
    try { fs.unlinkSync(record.file); } catch (_) { /* best-effort */ }
  }
  const derived = writeDerivedMarker(graphDir, deriveMarker(listRecords(graphDir)));
  if (!derived.ok) {
    // The reminder IS durable -- it is in its record -- but the derived
    // file, which the Graphify CLI reads, could not be published. The
    // caller is told, because a consumer that reads one file would not
    // see the reminder yet.
    return { ok: false, reason: derived.reason, path: markerPath, markerId: payload.markerId };
  }
  return { ok: true, path: markerPath, markerId: payload.markerId };
}

/**
 * Read a freshness marker. Returns { ok, marker, errors } — never throws.
 */
function readMarker(graphDir) {
  if (!graphDir) {
    return { ok: false, marker: null, reason: "marker_missing" };
  }
  const records = listRecords(graphDir);
  if (records.length > 0) {
    const derived = deriveMarker(records);
    const raw = JSON.stringify(derived, null, 2);
    // The derived file is a cache. When it is missing -- a crash between
    // publishing a record and publishing the cache, for instance -- it is
    // restored here, so a brief gap cannot become a permanent loss.
    //
    // It is also restored when it is STALE: two writers can publish their
    // records and their views in any order, so the file on disk can name
    // fewer records than the ones that exist. A single-file consumer would
    // then miss a reminder that the records still hold, and the two views
    // would stay apart for good. The cache is REBUILT from the records
    // whenever it does not describe them.
    repairDerivedMarker(graphDir, derived, raw);
    return {
      ok: true,
      marker: derived,
      identity: markerIdentity(raw),
      raw,
      records: records.map((record) => ({
        id: record.id,
        kind: record.payload.kind,
        changedPaths: Array.isArray(record.payload.changedPaths) ? record.payload.changedPaths : [],
      })),
    };
  }
  // No record: either there is no marker at all, or the marker was
  // published by an older version that wrote the single file.
  const markerPath = markerPathOf(graphDir);
  if (!fs.existsSync(markerPath)) {
    return { ok: false, marker: null, reason: "marker_missing" };
  }
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (err) {
    return { ok: false, marker: null, reason: "marker_missing" };
  }
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, marker: null, reason: "marker_corrupt" };
  }
  if (!data || data.schemaVersion !== MARKER_SCHEMA_VERSION) {
    return { ok: false, marker: data, reason: "schema_mismatch", identity: markerIdentity(raw) };
  }
  // A file that carries `recordIds` is the DERIVED view of a set of
  // records -- and there are NO records. The view is therefore stale: it
  // describes reminders that were answered already.
  //
  // It must not be read as a reminder. A reader that fell back to it
  // would resurrect a reminder that a full rebuild answered, and the
  // graph would fail closed for good. The file is removed as well, so
  // that the next reader does not have to make the same judgement.
  if (Array.isArray(data.recordIds)) {
    try { fs.unlinkSync(markerPathOf(graphDir)); } catch (_) { /* best-effort */ }
    return { ok: false, marker: null, reason: "marker_missing" };
  }
  // The identity tells two generations of the marker apart: a marker that a
  // concurrent writer replaced is a DIFFERENT marker, so a compare-and-
  // clear can tell whether the marker it read is still the one on disk.
  return { ok: true, marker: data, identity: markerIdentity(raw), raw };
}

/**
 * Bring the derived view back in line with the records.
 *
 * The file is only rewritten when it is a DERIVED view that does not
 * describe the current records. A file that is MISSING is restored, and a
 * file that carries `recordIds` but names a different set of records is
 * rebuilt. A LEGACY file -- one that carries no `recordIds` -- is left
 * alone: it may hold a reminder that was published before the record model
 * existed, and overwriting it would drop that reminder before it was
 * migrated.
 */
function repairDerivedMarker(graphDir, derived, raw) {
  const markerPath = markerPathOf(graphDir);
  let current = null;
  try {
    current = fs.readFileSync(markerPath, "utf8");
  } catch (_) {
    current = null;
  }
  if (current === null) {
    writeDerivedMarker(graphDir, derived);
    return;
  }
  if (current === raw) return;
  let parsed = null;
  try { parsed = JSON.parse(current); } catch (_) { parsed = null; }
  // Only a file that is recognisably a derived view is rebuilt. Anything
  // else is left for the legacy migration to deal with.
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.recordIds)) return;
  writeDerivedMarker(graphDir, derived);
}

/**
 * The identity of a marker: the hash of its CONTENT.
 *
 * The inode, the modification time and the size cannot tell two versions
 * of a marker apart: a writer that rewrites the file IN PLACE within the
 * same millisecond, with the same length, produces the very same triple.
 * The content hash cannot -- every write produces a different content.
 */
function markerIdentity(raw) {
  if (typeof raw !== "string") return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Clear the freshness markers of a graph directory.
 *
 * Without `kinds` every reminder is cleared -- the explicit operator
 * path (`cortex-agent graphify update`). With `kinds` only the reminders
 * of those kinds are cleared: a successful incremental update does not
 * answer a SEMANTIC reminder, and only a full rebuild does.
 *
 * Atomic and safe to call repeatedly.
 */
function clearMarker(graphDir, { kinds = null } = {}) {
  // The clear is KIND LIMITED when the caller says so: a successful
  // incremental update does not answer a SEMANTIC reminder, so it must not
  // remove one. A full rebuild DOES rebuild the semantic corpus, so it
  // removes the semantic reminders -- and only those.
  const allowed = (kind) => !Array.isArray(kinds) || kinds.includes(kind);
  const records = listRecords(graphDir);
  const legacy = readLegacyMarker(graphDir);
  let cleared = 0;
  for (const record of records) {
    if (!allowed(record.payload.kind)) continue;
    try {
      fs.unlinkSync(record.file);
      cleared += 1;
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
      }
    }
  }
  if (legacy.present && (legacy.kind === null || allowed(legacy.kind))) {
    try {
      fs.unlinkSync(markerPathOf(graphDir));
      cleared += 1;
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
      }
    }
  }
  // The derived view has to describe the reminders that are left.
  const remaining = listRecords(graphDir);
  if (remaining.length > 0) {
    writeDerivedMarker(graphDir, deriveMarker(remaining));
  } else if (!legacy.present || legacy.kind === null || allowed(legacy.kind)) {
    writeDerivedMarker(graphDir, null);
  }
  return { ok: true, cleared: cleared > 0 };
}

/**
 * Clear the marker ONLY when it is still the very same marker that was read
 * AND its kind is one this caller may clear.
 *
 * Two problems are solved here.
 *
 * 1. The check and the removal must not be separated by a window in which
 *    the file can change. A marker that a concurrent consumer wrote in the
 *    meantime describes a DIFFERENT change -- a deferred semantic change,
 *    for instance -- and an unconditional clear would delete that reminder
 *    for good: the request it belongs to has already been confirmed, so
 *    nothing would ever publish it again.
 *
 *    Every reminder lives in its OWN record, so the removal is a removal of
 *    the records that were read -- never a removal BY PATH. A reminder that
 *    a concurrent writer published in the meantime is a different record,
 *    and it is not touched. The identity check stays as the second line of
 *    defence: when the derived marker changed, nothing is cleared at all.
 *
 * 2. A marker of a kind this caller may not clear is left alone. A
 *    successful incremental update does not rebuild the semantic corpus,
 *    so it does not answer a SEMANTIC reminder.
 *
 * Returns { ok, cleared, reason? }.
 */
function clearMarkerIfUnchanged(graphDir, identity, { kinds = null, onAfterRead = null } = {}) {
  if (!identity) return { ok: true, cleared: false, reason: "no_marker" };
  const current = readMarker(graphDir);
  if (!current.ok || !current.marker) {
    return { ok: true, cleared: false, reason: current.reason || "marker_missing" };
  }
  if (!current.identity || current.identity !== identity) {
    return { ok: true, cleared: false, reason: "marker_changed" };
  }
  // A TEST SEAM: called after the marker was read and BEFORE the removal.
  // It injects the interleaving that the identity check cannot see: a
  // reminder that a concurrent writer publishes in this window.
  if (typeof onAfterRead === "function") {
    try { onAfterRead(); } catch (_) { /* the seam must not break the clear */ }
  }
  const allowed = (kind) => !Array.isArray(kinds) || kinds.includes(kind);
  // The records that were READ together with the identity. They are the
  // ones this clear may remove: a reminder that a concurrent writer
  // published after this read is a DIFFERENT record, and removing it would
  // drop a reminder that nobody answered. The identity check alone does
  // not protect it -- the identity was computed BEFORE the concurrent
  // publication, so it still matches.
  const observed = Array.isArray(current.records) ? current.records : [];
  if (observed.length === 0) {
    // A marker of an older version: one file, one reminder.
    if (!allowed(current.marker.kind)) {
      return { ok: true, cleared: false, reason: "kind_not_clearable" };
    }
    try {
      fs.unlinkSync(markerPathOf(graphDir));
    } catch (err) {
      if (err && err.code === "ENOENT") return { ok: true, cleared: false, reason: "marker_missing" };
      return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
    }
    return { ok: true, cleared: true };
  }
  // Only the records of the kinds this caller may clear are removed, and
  // only the ones that were there when the marker was read: a reminder that
  // a concurrent writer published in the meantime is a DIFFERENT record,
  // and it is not touched.
  const removable = observed.filter((record) => allowed(record.kind));
  if (removable.length === 0) {
    return { ok: true, cleared: false, reason: "kind_not_clearable" };
  }
  for (const record of removable) {
    // The removal is a removal of THAT record: the file is addressed by
    // the id that was read, never by a fresh enumeration of the directory.
    try {
      fs.unlinkSync(path.join(recordsDir(graphDir), record.id + ".json"));
    } catch (_) { /* best-effort */ }
  }
  const derived = writeDerivedMarker(graphDir, deriveMarker(listRecords(graphDir)));
  if (!derived.ok) {
    // The records are gone, but the derived view could not be published.
    // The caller is told: a consumer that reads the single file would
    // still see a reminder that was answered.
    return { ok: false, cleared: true, reason: derived.reason };
  }
  return { ok: true, cleared: true };
}

/**
 * Clear exactly the reminders of the given ids.
 *
 * A full rebuild answers the reminders that existed when it took its
 * INPUT. A reminder that was published after that moment describes a
 * change the rebuild did not see, so it must survive: clearing "every
 * semantic reminder" at the END of the build would drop a reminder that
 * arrived while the build was running, and nothing would ever publish it
 * again.
 *
 * The ids are therefore the ones the caller captured at its input
 * boundary. A record that was already removed is not an error -- another
 * consumer may have answered it.
 *
 * Returns { ok, cleared }.
 */
function clearMarkerRecords(graphDir, { recordIds = null, kinds = null } = {}) {
  const allowed = (kind) => !Array.isArray(kinds) || kinds.includes(kind);
  const wanted = Array.isArray(recordIds) ? new Set(recordIds) : null;
  if (!wanted || wanted.size === 0) return { ok: true, cleared: false };
  const byId = new Map();
  for (const record of listRecords(graphDir)) byId.set(record.id, record);
  let cleared = 0;
  for (const id of wanted) {
    const record = byId.get(id);
    if (!record) continue;
    if (!allowed(record.payload.kind)) continue;
    try {
      fs.unlinkSync(record.file);
      cleared += 1;
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
    }
  }
  const remaining = listRecords(graphDir);
  if (remaining.length > 0) {
    const derived = writeDerivedMarker(graphDir, deriveMarker(remaining));
    if (!derived.ok) {
      // The records were removed, but the derived view could not be
      // published. The caller is told, because a consumer that reads the
      // single file would still see the reminder that was answered.
      return { ok: false, reason: derived.reason };
    }
  } else {
    const derived = writeDerivedMarker(graphDir, null);
    if (!derived.ok) {
      return { ok: false, reason: derived.reason };
    }
  }
  return { ok: true, cleared: cleared > 0 };
}

/**
 * Clear the marker of an OLDER version -- the single file -- but only when
 * it is still the very same file that was read.
 *
 * A full rebuild answers the reminders that existed when it took its
 * INPUT. A reminder that is published after that moment describes a
 * change the rebuild did not see, so it must survive.
 *
 * The single file is the reminder of a version that had no records. It is
 * cleared by CONTENT: a file that a concurrent writer replaced in the
 * meantime is a DIFFERENT reminder, and it is not touched.
 *
 * Returns { ok, cleared, reason? }.
 */
function clearLegacyMarkerIfUnchanged(graphDir, identity, { kinds = null, onBeforeClaim = null, onAfterClaim = null } = {}) {
  if (!identity) return { ok: true, cleared: false, reason: "no_marker" };
  const legacy = readLegacyMarker(graphDir);
  if (!legacy.present) return { ok: true, cleared: false, reason: "marker_missing" };
  if (!legacy.identity || legacy.identity !== identity) {
    return { ok: true, cleared: false, reason: "marker_changed" };
  }
  // A file that carries `recordIds` is the DERIVED view, not a legacy
  // reminder. It is rebuilt from the records, so it is not cleared here.
  if (legacy.value && Array.isArray(legacy.value.recordIds)) {
    return { ok: true, cleared: false, reason: "derived_view" };
  }
  const allowed = (kind) => !Array.isArray(kinds) || kinds.includes(kind);
  if (!allowed(legacy.kind)) {
    return { ok: true, cleared: false, reason: "kind_not_clearable" };
  }
  // The file is CLAIMED with an atomic rename before it is removed.
  //
  // A removal of a path that a concurrent writer may replace is a
  // check-then-act: the identity was read, and the writer published a new
  // reminder between that read and the removal, so the removal deleted the
  // NEW reminder. The rename moves whatever is at the path, so the content
  // that has to be examined is the content that was moved -- and the
  // content that is at the path now is never touched.
  const markerPath = markerPathOf(graphDir);
  const grave = markerPath + ".claimed-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  // A TEST SEAM: called after the identity was read and BEFORE the file is
  // claimed. It injects the interleaving that used to lose a reminder: a
  // writer replaces the file between the read and the claim, so the claim
  // takes a reminder that was never answered.
  if (typeof onBeforeClaim === "function") {
    try { onBeforeClaim(); } catch (_) { /* the seam must not break the clear */ }
  }
  try {
    fs.renameSync(markerPath, grave);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, cleared: false, reason: "marker_missing" };
    }
    return { ok: false, reason: err && err.code ? err.code : "claim_failed" };
  }
  // A TEST SEAM: called after the file was claimed and BEFORE the claimed
  // content is examined. It injects the interleaving that used to lose a
  // reminder: a writer publishes a NEW reminder at the path while the
  // claimed one is being examined.
  if (typeof onAfterClaim === "function") {
    try { onAfterClaim(); } catch (_) { /* the seam must not break the clear */ }
  }
  const claimed = readLegacyMarkerAt(grave);
  if (claimed.present && claimed.identity === identity) {
    // The claimed file IS the reminder that was answered.
    try { fs.unlinkSync(grave); } catch (err) {
      return { ok: false, reason: err && err.code ? err.code : "unlink_failed" };
    }
    return { ok: true, cleared: true };
  }
  // The claimed file is NOT the reminder that was answered: a concurrent
  // writer published a new reminder while the rebuild was running. It has
  // to survive, so it is put back -- with a LINK, which never replaces an
  // existing name.
  try {
    fs.linkSync(grave, markerPath);
    try { fs.unlinkSync(grave); } catch (_) { /* best-effort */ }
  } catch (_) {
    // The path is taken by an even newer reminder. The claimed content is
    // imported into the RECORD model, so that the reminder it describes is
    // not lost: the records are the truth, and a reminder that only exists
    // in a file that is about to be removed would be gone for good.
    const replayed = importClaimedMarker(graphDir, grave);
    if (!replayed) {
      // The replay FAILED: the claimed file is the only copy of that
      // reminder, so it is NOT removed. It is put back when the path is
      // free again, and the caller is told that the reminder was not
      // replayed -- a clear that cannot replay what it claimed did not
      // answer anything.
      try { fs.linkSync(grave, markerPath); } catch (_) { /* the path is taken */ }
      return { ok: false, reason: "replay_failed", cleared: false };
    }
    try { fs.unlinkSync(grave); } catch (_) { /* best-effort */ }
  }
  return { ok: true, cleared: false, reason: "marker_changed" };
}

/**
 * Import a claimed legacy reminder into the record model.
 *
 * The record is written with the ID of the reminder itself, so the import
 * is idempotent: a reminder that was imported before is not imported a
 * second time.
 */
function importClaimedMarker(graphDir, file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (_) { return null; }
  let data;
  try { data = JSON.parse(raw); } catch (_) { return null; }
  if (!data || typeof data !== "object" || data.schemaVersion !== MARKER_SCHEMA_VERSION) return null;
  if (!Object.values(KIND).includes(data.kind)) return null;
  if (Array.isArray(data.recordIds)) return null;
  const id = data.markerId || crypto.randomBytes(12).toString("hex");
  const payload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    markerId: id,
    recordedAt: data.recordedAt || new Date().toISOString(),
    kind: data.kind,
    reason: data.reason || null,
    changedPaths: Array.isArray(data.changedPaths) ? [...data.changedPaths].sort() : [],
    sourceHead: data.sourceHead === undefined ? null : data.sourceHead,
    branch: data.branch === undefined ? null : data.branch,
  };
  try {
    fs.mkdirSync(recordsDir(graphDir), { recursive: true });
    fs.writeFileSync(path.join(recordsDir(graphDir), id + ".json"), JSON.stringify(payload, null, 2), { flag: "wx" });
  } catch (_) {
    return null;
  }
  // The derived view may only replace a file that IS a derived view. A
  // legacy reminder that a concurrent writer published at the path is a
  // reminder in its own right: it is imported into the record model first,
  // so that rebuilding the derived view does not destroy it.
  if (mayReplaceDerivedView(graphDir)) {
    const derived = writeDerivedMarker(graphDir, deriveMarker(listRecords(graphDir)));
    if (!derived.ok) {
      // The derived view is a CACHE: the records are the truth, and the
      // readers rebuild the cache. The import itself succeeded.
      return payload;
    }
  }
  return payload;
}

/**
 * Whether the derived view may replace the file at the marker path.
 *
 * It may when there is no file, or when the file IS a derived view. A
 * legacy reminder is imported into the record model first, so that the
 * reminder is not lost when the view is rebuilt. A file that cannot be
 * read is left alone: it may be a reminder in a format this version does
 * not know, and overwriting it would destroy it.
 */
function mayReplaceDerivedView(graphDir) {
  const markerPath = markerPathOf(graphDir);
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (err) {
    // There is no file at the path: the derived view may be written.
    if (err && err.code === "ENOENT") return true;
    // The file cannot be read: it is left alone.
    return false;
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.recordIds)) {
    // A derived view: it may be replaced.
    return true;
  }
  if (parsed && typeof parsed === "object" && parsed.schemaVersion === MARKER_SCHEMA_VERSION) {
    // A legacy reminder: it is imported into the record model first, and
    // then the derived view may replace it.
    migrateLegacyMarker(graphDir);
    return true;
  }
  // A file this version does not understand: it is not touched.
  return false;
}

/**
 * Classify a set of changed paths into "code" vs "semantic" per the
 * Graphify contract. Code changes flow to `graphify update`; semantic
 * changes trigger a stale marker.
 *
 * The classification is intentionally coarse and language-agnostic:
 *   - code-like extensions → code change
 *   - documentation / proposal / rule / image → semantic change
 *   - everything else → default semantic (safe default; we never
 *     auto-update on ambiguous changes).
 *
 * The hook can inspect this output to decide whether to (a) silently
 * trigger `graphify update .` or (b) write a stale marker.
 */
function classifyChanges(changedPaths = []) {
  const CODE_EXT = new Set([
    ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".cs",
    ".scala", ".php", ".lua", ".sh", ".bash", ".zsh",
    ".sql", ".r", ".jl", ".dart",
  ]);
  const SEMANTIC_DIR = new Set([
    "docs", "doc",
    ".agent/skills", ".agent/rules", ".agent/proposals",
    ".agent/workflows",
    "proposals", "plans",
  ]);
  const SEMANTIC_NAME = new Set([
    "readme.md", "agents.md", "changelog.md", "license",
    "license.md", "contributing.md", "code_of_conduct.md",
    "graphify-integration-proposal.md",
  ]);
  const SEMANTIC_EXT = new Set([
    ".md", ".markdown", ".rst", ".adoc", ".txt",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".pdf", ".drawio", ".dot",
  ]);
  const code = [];
  const semantic = [];
  const unknown = [];
  for (const raw of changedPaths) {
    const p = String(raw || "").replace(/\\/g, "/");
    if (!p) continue;
    const lower = p.toLowerCase();
    const ext = path.extname(lower);
    const base = path.basename(lower);
    if (CODE_EXT.has(ext)) {
      code.push(p);
      continue;
    }
    if (SEMANTIC_NAME.has(base) || SEMANTIC_EXT.has(ext)) {
      semantic.push(p);
      continue;
    }
    const parts = p.split("/");
    if (parts.some((seg) => SEMANTIC_DIR.has(seg))) {
      semantic.push(p);
      continue;
    }
    unknown.push(p);
  }
  // Safe default: treat unknown as semantic so the hook writes a marker.
  for (const p of unknown) semantic.push(p);
  return { code, semantic };
}

module.exports = {
  MARKER_FILENAME,
  MARKER_RECORDS_DIRNAME,
  MARKER_SCHEMA_VERSION,
  KIND,
  CLEARABLE_BY_INCREMENTAL,
  writeMarker,
  readMarker,
  clearMarker,
  clearMarkerIfUnchanged,
  clearMarkerRecords,
  clearLegacyMarkerIfUnchanged,
  readLegacyMarker,
  listRecordIds,
  classifyChanges,
};
