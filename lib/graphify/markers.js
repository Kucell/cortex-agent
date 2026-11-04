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

// The directory the CLAIMED legacy reminders are moved into.
//
// A claim moves the single-file reminder aside before it answers it, so
// that a reminder that a concurrent writer publishes is never deleted. The
// claimed file is runtime state of the plugin: it belongs under `.agent/`,
// where the ignore rules of the project cover it, and not in the source
// tree next to the graph.
const CLAIM_DIRNAME = ".density-claimed";

/**
 * The path a claimed legacy reminder is moved to.
 */
function claimPathFor(graphDir) {
  const root = path.dirname(path.resolve(String(graphDir || ".")));
  return path.join(
    root,
    ".agent",
    "plugins",
    "graphify",
    CLAIM_DIRNAME,
    "claimed-" + process.pid + "-" + crypto.randomBytes(6).toString("hex") + ".json",
  );
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
 * What is at the marker path right now.
 *
 * "derived"  -- the view of a set of records: a cache, it may be replaced.
 * "legacy"   -- a REMINDER that was published before the record model
 *                existed: it may only be replaced after it was imported
 *                into the record model.
 * "foreign"  -- a file this version does not understand: it is never
 *                touched.
 * "absent"   -- there is no file.
 */
function inspectMarkerFile(markerPath) {
  let raw = null;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { kind: "absent", raw: null, parsed: null };
    // The file cannot be read: it is left alone. It may hold a reminder in
    // a format this version does not know.
    return { kind: "foreign", raw: null, parsed: null };
  }
  // An EMPTY file is not a reminder and not a view: it is the residue of
  // a publication that was interrupted between the creation of the file
  // and the writing of its content. It may be replaced.
  if (raw.length === 0) return { kind: "incomplete", raw, parsed: null };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== "object") return { kind: "foreign", raw, parsed: null };
  // A file that carries `recordIds` is the DERIVED view of a set of
  // records.
  if (Array.isArray(parsed.recordIds)) return { kind: "derived", raw, parsed };
  if (parsed.schemaVersion === MARKER_SCHEMA_VERSION && Object.values(KIND).includes(parsed.kind)) {
    return { kind: "legacy", raw, parsed };
  }
  return { kind: "foreign", raw, parsed };
}

/**
 * Put a claimed file back at the marker path.
 *
 * The LINK never replaces an existing name: a reminder that a writer
 * published while the file was claimed is not overwritten by the file that
 * was claimed before it. When the path is taken, the claimed file stays
 * where it is -- it is the only copy of that reminder, and the caller is
 * told that it could not be put back.
 */
function restoreClaimedFile(file, markerPath) {
  try {
    fs.linkSync(file, markerPath);
    try { fs.unlinkSync(file); } catch (_) { /* best-effort */ }
    return { ok: true };
  } catch (err) {
    if (err && err.code === "EEXIST") return { ok: false, reason: "path_taken" };
    return { ok: false, reason: err && err.code ? err.code : "link_failed" };
  }
}

// Whether the filesystem of a directory supports hard links.
//
// The derived view is published with a LINK: the link creates the file in
// ONE step and fails when the name is taken, so a reminder that a writer
// publishes in the meantime is never overwritten -- it is found by the
// next round and imported into the record model.
//
// Without hard links there is no such step: the name has to be reserved
// first, and the content is written afterwards. A writer that publishes a
// reminder in that window writes INTO the reserved file, and the view
// overwrites it -- and no check of the file before or after the write can
// tell that the reminder was there. The view is therefore NOT published
// on such a filesystem: the reminders stay in their records (they are
// durable), and the file at the path is left exactly as it is.
const linkSupport = new Map();

// The errors that say that the filesystem does not support hard links.
function isNoLinkError(code) {
  return code === "EOPNOTSUPP"
    || code === "ENOTSUP"
    || code === "ENOSYS"
    || code === "EPERM"
    || code === "EXDEV";
}

function isDefinitiveNoLinkSupportError(code) {
  return code === "EOPNOTSUPP"
    || code === "ENOTSUP"
    || code === "ENOSYS";
}

/**
 * Whether the filesystem of a directory supports hard links.
 *
 * The answer is asked with a real link, and it is remembered: whether a
 * filesystem supports hard links does not change while the process runs.
 * Only the definitive answer -- "this filesystem has no hard links" -- is
 * remembered; a failure that says nothing about the support of hard links
 * is answered with "no" for this round only.
 */
function hardLinksAvailable(dir, sample) {
  const key = path.resolve(String(dir || "."));
  if (linkSupport.has(key)) return linkSupport.get(key);
  const probe = path.join(key, ".link-probe-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
  try {
    fs.linkSync(sample, probe);
  } catch (err) {
    const code = err && err.code ? err.code : "link_failed";
    try { fs.unlinkSync(probe); } catch (_) { /* best-effort */ }
    if (isDefinitiveNoLinkSupportError(code)) linkSupport.set(key, false);
    return false;
  }
  try { fs.unlinkSync(probe); } catch (_) { /* best-effort */ }
  linkSupport.set(key, true);
  return true;
}

/**
 * Get rid of a file that was moved aside.
 *
 * The file may hold a REMINDER: a writer that published a reminder
 * between the inspection of the path and the move captured it. It is
 * imported into the record model BEFORE it is removed -- and when the
 * import fails, the file stays and the failure is reported. A reminder
 * that is only a file is a reminder that is lost.
 */
function disposeGuard(graphDir, guard) {
  const state = inspectMarkerFile(guard);
  if (state.kind === "legacy") {
    const imported = importLegacyFromFile(graphDir, guard);
    if (!imported) return { ok: false, reason: "legacy_not_imported" };
  }
  try { fs.unlinkSync(guard); } catch (_) { /* best-effort */ }
  return { ok: true };
}

/**
 * Publish the DERIVED marker for the consumers that read one file.
 *
 * The file is a cache: the records are the truth. A failure to write it
 * is reported, because the file is what the Graphify CLI reads -- but the
 * reminder itself is already durable in its record.
 *
 * The publication never DESTROYS a reminder:
 *
 *   - a REMINDER at the path is imported into the record model first; the
 *     view is only written when the import succeeded;
 *   - the view is created with a LINK, which fails when the path is
 *     taken: a reminder that a writer publishes in the meantime is found
 *     by the next round instead of being overwritten;
 *   - a view that is replaced is MOVED ASIDE first, so that whatever a
 *     writer publishes in that window is captured -- and imported --
 *     instead of being destroyed by the rename.
 */
function writeDerivedMarker(graphDir, derived) {
  const markerPath = markerPathOf(graphDir);
  let content = derived;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = inspectMarkerFile(markerPath);
    if (state.kind === "legacy") {
      // The file at the path is a REMINDER: it is imported into the record
      // model first. The import has to succeed -- a view that replaces a
      // reminder that was not imported would destroy it.
      const migrated = migrateLegacyMarker(graphDir);
      if (!migrated) return { ok: false, reason: "legacy_not_imported" };
      content = deriveMarker(listRecords(graphDir));
      continue;
    }
    if (state.kind === "foreign") {
      return { ok: false, reason: "marker_foreign" };
    }
    if (!content) {
      return removeDerivedMarker(graphDir, state);
    }
    const tmpPath = markerPath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2));
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
      return { ok: false, reason: err && err.code ? err.code : "write_failed" };
    }
    if (state.kind === "absent") {
      // The LINK creates the file in one step, and it fails when the path
      // is taken: a reminder that a writer publishes in the meantime is
      // never overwritten -- the next round finds it.
      try {
        fs.linkSync(tmpPath, markerPath);
      } catch (err) {
        const code = err && err.code ? err.code : "link_failed";
        if (code === "EEXIST") {
          try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
          continue;
        }
        // Filesystems without hard links: there is no atomic create that
        // does not overwrite. The view is NOT published there: the name
        // would have to be reserved first, and a reminder that a writer
        // publishes in that window would be overwritten by the view. The
        // reminders stay in their records, and the file at the path is
        // left alone.
        //
        // A rename over the path would be simpler -- and it would
        // DESTROY a reminder that a writer published between the check of
        // the path and the rename. That is why the rename is not used
        // here.
        if (isNoLinkError(code)) {
          try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
          return { ok: false, reason: "no_hardlink_support" };
        }
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
        return { ok: false, reason: code };
      }
      try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
      return { ok: true };
    }
    // The file at the path is a VIEW -- or the residue of a publication
    // that was interrupted. It is moved aside instead of being
    // overwritten, so that whatever a writer publishes in this window is
    // captured -- and not destroyed by the rename.
    //
    // The move is only safe when the view can be put back with a LINK: a
    // link never replaces a name that is taken, so a reminder that a
    // writer publishes in the meantime stays where it is. Without hard
    // links there is no such step, and the file at the path is left
    // alone -- the view is a cache, and the reminders are in their
    // records.
    if (!hardLinksAvailable(path.dirname(markerPath), tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
      return { ok: false, reason: "no_hardlink_support" };
    }
    const guard = markerPath + ".guard-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
    try {
      fs.renameSync(markerPath, guard);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
      if (err && err.code === "ENOENT") continue;
      return { ok: false, reason: err && err.code ? err.code : "rename_failed" };
    }
    try {
      fs.linkSync(tmpPath, markerPath);
    } catch (err) {
      const code = err && err.code ? err.code : "link_failed";
      if (isNoLinkError(code)) {
        // The links are not available after all. The file that was at the
        // path is put back with a LINK, which never replaces a name that
        // is taken: a reminder that a writer publishes in the meantime
        // stays where it is.
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
        let restored = false;
        try {
          fs.linkSync(guard, markerPath);
          restored = true;
        } catch (_) { /* the path is taken by a newer file */ }
        if (restored) {
          try { fs.unlinkSync(guard); } catch (_) { /* best-effort */ }
          return { ok: false, reason: "no_hardlink_support" };
        }
        // The path is taken: the guard holds the file that was there. A
        // reminder it holds is imported before it is removed.
        const displaced = inspectMarkerFile(guard);
        if (displaced.kind === "legacy") {
          const imported = importLegacyFromFile(graphDir, guard);
          if (!imported) return { ok: false, reason: "legacy_not_imported" };
        }
        try { fs.unlinkSync(guard); } catch (_) { /* best-effort */ }
        return { ok: false, reason: "no_hardlink_support" };
      } else {
        // The path is taken again: a writer published a reminder -- or a
        // newer view -- in this window. The guard holds the view that was
        // replaced.
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
        const occupied = inspectMarkerFile(markerPath);
        if (occupied.kind === "legacy") {
          const migrated = migrateLegacyMarker(graphDir);
          if (!migrated) {
            // The reminder stays where it is, and the guard holds the view
            // that was replaced. Nothing is lost, and the failure is
            // reported.
            return { ok: false, reason: "legacy_not_imported" };
          }
          content = deriveMarker(listRecords(graphDir));
          // The guard may hold a reminder as well: it is imported before
          // it is removed.
          const disposed = disposeGuard(graphDir, guard);
          if (!disposed.ok) return disposed;
          // The import of the guard may have added a record: the view
          // that is published next has to describe the records as they
          // are now, not as they were before the import.
          content = deriveMarker(listRecords(graphDir));
          continue;
        }
        if (occupied.kind === "absent") {
          try { fs.renameSync(guard, markerPath); } catch (_) { /* best-effort */ }
        } else {
          const disposed = disposeGuard(graphDir, guard);
          if (!disposed.ok) return disposed;
          // The guard may have held a reminder that was imported: the
          // view that is published next has to describe it.
          content = deriveMarker(listRecords(graphDir));
        }
        continue;
      }
    }
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
    // The guard holds the file that was at the path. It was a view when it
    // was inspected -- but a writer may have replaced it in the meantime,
    // and then it is a REMINDER that must not be lost.
    const displaced = inspectMarkerFile(guard);
    if (displaced.kind === "legacy") {
      const imported = importLegacyFromFile(graphDir, guard);
      if (!imported) {
        // The guard file stays: it is the only copy of that reminder.
        return { ok: false, reason: "legacy_not_imported" };
      }
      try { fs.unlinkSync(guard); } catch (_) { /* best-effort */ }
      content = deriveMarker(listRecords(graphDir));
      // The view that was published does not describe the imported record
      // yet: it is published again.
      continue;
    }
    try { fs.unlinkSync(guard); } catch (_) { /* best-effort */ }
    return { ok: true };
  }
  return { ok: false, reason: "marker_busy" };
}

/**
 * Remove the derived view -- without destroying a reminder.
 *
 * The file at the path is moved aside first, so that a reminder that a
 * writer publishes in this window is captured instead of deleted. A
 * reminder that was captured is imported into the record model.
 */
function removeDerivedMarker(graphDir, state) {
  const markerPath = markerPathOf(graphDir);
  if (state.kind === "absent") return { ok: true };
  const guard = markerPath + ".guard-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  try {
    fs.renameSync(markerPath, guard);
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true };
    return { ok: false, reason: err && err.code ? err.code : "rename_failed" };
  }
  const displaced = inspectMarkerFile(guard);
  if (displaced.kind === "legacy") {
    const imported = importLegacyFromFile(graphDir, guard);
    if (!imported) return { ok: false, reason: "legacy_not_imported" };
    // The reminder is now a record: the view is rebuilt from the records
    // instead of being removed, because the records describe it.
    const rebuilt = writeDerivedMarker(graphDir, deriveMarker(listRecords(graphDir)));
    try { fs.unlinkSync(guard); } catch (_) { /* best-effort */ }
    return rebuilt;
  }
  try { fs.unlinkSync(guard); } catch (_) { /* best-effort */ }
  return { ok: true };
}

/**
 * Write the single marker file of an OLDER version into a record, so a
 * reminder that was published before the record model existed is not lost
 * when the next writer publishes its own reminder.
 */
function migrateLegacyMarker(graphDir) {
  const markerPath = markerPathOf(graphDir);
  // A file that carries `recordIds` is not a LEGACY reminder: it is the
  // DERIVED view that this version writes for the single-file consumers.
  // Importing it as a reminder would RE-CREATE a reminder that was
  // already answered -- the derived view of a semantic reminder outlives
  // the record itself until the next write refreshes it, so a reader that
  // found no records could resurrect the reminder that the last clear
  // removed. The records are the truth, and a derived file never becomes
  // a record again.
  const state = inspectMarkerFile(markerPath);
  if (state.kind !== "legacy") return null;
  // The file is CLAIMED with an atomic rename before it is imported. A
  // removal of a path that a concurrent writer may replace is a
  // check-then-act: the identity was read, and the writer published a new
  // reminder between that read and the removal, so the removal deleted the
  // NEW reminder. The rename moves whatever is at the path, so the content
  // that is imported is the content that was moved -- and the content that
  // is at the path now is never touched.
  const claim = claimMarkerFile(graphDir, markerPath);
  if (!claim.ok) return null;
  const claimed = inspectMarkerFile(claim.file);
  if (claimed.kind !== "legacy") {
    // The file that was claimed is not a reminder: it is put back.
    restoreClaimedFile(claim.file, markerPath);
    return null;
  }
  const payload = importLegacyPayload(graphDir, claimed.parsed);
  if (!payload) {
    // The import FAILED: the claimed file is the only copy of that
    // reminder, so it is NOT removed. It is put back when the path is
    // free again, and the failure is reported to the caller.
    restoreClaimedFile(claim.file, markerPath);
    return null;
  }
  // The legacy file is now a record, so it is not a second copy of the
  // same reminder: leaving it there would let a reader that finds no
  // records fall back to a STALE view of the reminders.
  try { fs.unlinkSync(claim.file); } catch (_) { /* best-effort */ }
  return payload;
}

/**
 * Claim the file at the marker path with an atomic rename.
 *
 * The claim goes into the RUNTIME STATE of the plugin, so that a crash in
 * the window between the claim and the answer does not leave a file in the
 * source tree. When the runtime state is on another filesystem, the claim
 * stays next to the marker.
 *
 * Returns { ok: true, file } or { ok: false, reason }.
 */
function claimMarkerFile(graphDir, markerPath) {
  let target = claimPathFor(graphDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (_) { /* the claim fails below */ }
  try {
    fs.renameSync(markerPath, target);
    return { ok: true, file: target };
  } catch (err) {
    if (err && err.code === "EXDEV") {
      target = markerPath + ".claimed-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
      try {
        fs.renameSync(markerPath, target);
        return { ok: true, file: target };
      } catch (inner) {
        if (inner && inner.code === "ENOENT") return { ok: false, reason: "marker_missing" };
        return { ok: false, reason: inner && inner.code ? inner.code : "claim_failed" };
      }
    }
    if (err && err.code === "ENOENT") return { ok: false, reason: "marker_missing" };
    return { ok: false, reason: err && err.code ? err.code : "claim_failed" };
  }
}

/**
 * Import a LEGACY reminder into the record model.
 *
 * The record is written with the ID of the reminder itself, so the import
 * is idempotent: a reminder that was imported before is not imported a
 * second time. Returns the payload, or null when the record could not be
 * written.
 */
function importLegacyPayload(graphDir, value) {
  if (!value || typeof value !== "object") return null;
  if (value.schemaVersion !== MARKER_SCHEMA_VERSION) return null;
  if (!Object.values(KIND).includes(value.kind)) return null;
  if (Array.isArray(value.recordIds)) return null;
  const id = value.markerId || crypto.randomBytes(12).toString("hex");
  const payload = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    markerId: id,
    recordedAt: value.recordedAt || new Date().toISOString(),
    kind: value.kind,
    reason: value.reason || null,
    changedPaths: Array.isArray(value.changedPaths) ? [...value.changedPaths].sort() : [],
    sourceHead: value.sourceHead === undefined ? null : value.sourceHead,
    branch: value.branch === undefined ? null : value.branch,
  };
  const file = path.join(recordsDir(graphDir), id + ".json");
  try {
    fs.mkdirSync(recordsDir(graphDir), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { flag: "wx" });
    return payload;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      // The record is there: the reminder was imported before. The import
      // is idempotent, so the existing record is the payload.
      try {
        const existing = JSON.parse(fs.readFileSync(file, "utf8"));
        if (existing && existing.schemaVersion === MARKER_SCHEMA_VERSION) return existing;
      } catch (_) { /* the record cannot be read */ }
    }
    return null;
  }
}

/**
 * Import a LEGACY reminder that was found at an arbitrary path -- the file
 * that was claimed, or the file that was moved aside.
 *
 * Returns the payload, or null when the file is not a reminder or when the
 * record could not be written. The file is NOT removed: the caller owns
 * it.
 */
function importLegacyFromFile(graphDir, file) {
  const state = inspectMarkerFile(file);
  if (state.kind !== "legacy") return null;
  return importLegacyPayload(graphDir, state.parsed);
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
 * Inspect outstanding freshness reminders without repairing the cached view.
 * Resolver callers are read-only and must fail closed on unreadable state.
 */
function inspectMarker(graphDir) {
  if (!graphDir) return { ok: false, pending: false, reason: "marker_missing" };
  const recordsPath = recordsDir(graphDir);
  let names;
  try {
    names = fs.readdirSync(recordsPath);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      return { ok: false, pending: false, reason: "records_unreadable" };
    }
    names = [];
  }
  const records = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(recordsPath, name);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      return { ok: false, pending: false, reason: "record_unreadable" };
    }
    if (!payload || typeof payload !== "object"
        || payload.schemaVersion !== MARKER_SCHEMA_VERSION
        || !Object.values(KIND).includes(payload.kind)) {
      return { ok: false, pending: false, reason: "record_invalid" };
    }
    records.push({
      id: payload.markerId || name.slice(0, -5),
      file,
      payload,
    });
  }
  if (records.length > 0) {
    return { ok: true, pending: true, marker: deriveMarker(records), records };
  }

  const legacy = inspectMarkerFile(markerPathOf(graphDir));
  if (legacy.kind === "absent" || legacy.kind === "derived") {
    return { ok: true, pending: false, marker: null, records: [] };
  }
  if (legacy.kind === "legacy") {
    return { ok: true, pending: true, marker: legacy.parsed, records: [] };
  }
  return {
    ok: false,
    pending: false,
    reason: legacy.kind === "incomplete" ? "marker_incomplete" : "marker_invalid",
  };
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
  // The claimed file is moved into the RUNTIME STATE of the plugin, not
  // next to the marker: the runtime state lives under `.agent/`, and
  // that is where the ignore rules of the project cover it. A claim
  // leftover next to the marker would be a file in the source tree.
  let grave = claimPathFor(graphDir);
  // A TEST SEAM: called after the identity was read and BEFORE the file is
  // claimed. It injects the interleaving that used to lose a reminder: a
  // writer replaces the file between the read and the claim, so the claim
  // takes a reminder that was never answered.
  if (typeof onBeforeClaim === "function") {
    try { onBeforeClaim(); } catch (_) { /* the seam must not break the clear */ }
  }
  try {
    fs.mkdirSync(path.dirname(grave), { recursive: true });
  } catch (_) { /* the claim fails below */ }
  try {
    fs.renameSync(markerPath, grave);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      // The runtime state is on another filesystem: the claim stays next
      // to the marker. The file is transient -- it is removed as soon as
      // the claim is answered -- but a crash in that window leaves it
      // behind, and the ignore rules of the project do not cover it.
      grave = markerPath + ".claimed-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
      try {
        fs.renameSync(markerPath, grave);
      } catch (inner) {
        if (inner && inner.code === "ENOENT") {
          return { ok: true, cleared: false, reason: "marker_missing" };
        }
        return { ok: false, reason: inner && inner.code ? inner.code : "claim_failed" };
      }
    } else {
    if (err && err.code === "ENOENT") {
      return { ok: true, cleared: false, reason: "marker_missing" };
    }
    return { ok: false, reason: err && err.code ? err.code : "claim_failed" };
    }
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
    if (!replayed || !replayed.ok) {
      // The replay FAILED: the claimed file is the only copy of that
      // reminder, so it is NOT removed. It is put back when the path is
      // free again, and the caller is told that the reminder was not
      // replayed -- a clear that cannot replay what it claimed did not
      // answer anything.
      try { fs.linkSync(grave, markerPath); } catch (_) { /* the path is taken */ }
      return { ok: false, reason: "replay_failed", cleared: false };
    }
    try { fs.unlinkSync(grave); } catch (_) { /* best-effort */ }
    if (replayed.pending) {
      // A reminder that a concurrent writer published at the path could
      // NOT be imported into the record model. It stays where it is -- it
      // is not lost, and it is not covered by the view either -- and the
      // caller is told that it is still pending.
      return { ok: true, cleared: false, reason: "legacy_pending", pending: true };
    }
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
  const state = inspectMarkerFile(file);
  if (state.kind !== "legacy") return { ok: false, reason: "not_a_reminder", payload: null };
  const payload = importLegacyPayload(graphDir, state.parsed);
  if (!payload) return { ok: false, reason: "record_write_failed", payload: null };
  // The derived view may only replace a file that IS a derived view. A
  // legacy reminder that a concurrent writer published at the path is a
  // reminder in its own right: it is imported into the record model first,
  // so that rebuilding the derived view does not destroy it.
  const may = mayReplaceDerivedView(graphDir);
  if (!may.ok) {
    // A reminder at the path could NOT be imported: it stays where it is,
    // and the caller is told that it is still pending. The reminder is not
    // lost -- and it is not covered by the view either.
    return { ok: true, payload, pending: true, reason: may.reason };
  }
  const derived = writeDerivedMarker(graphDir, deriveMarker(listRecords(graphDir)));
  if (!derived.ok) {
    // The derived view is a CACHE: the records are the truth, and the
    // readers rebuild the cache. The import itself succeeded.
    return {
      ok: true,
      payload,
      pending: derived.reason === "legacy_not_imported",
      reason: derived.reason,
    };
  }
  return { ok: true, payload };
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
  const state = inspectMarkerFile(markerPathOf(graphDir));
  if (state.kind === "absent") return { ok: true };
  if (state.kind === "derived") return { ok: true };
  if (state.kind === "legacy") {
    // A legacy reminder: it is imported into the record model first, and
    // then the derived view may replace it. The result of the import is
    // CHECKED: a view that replaces a reminder that was not imported would
    // destroy it.
    const migrated = migrateLegacyMarker(graphDir);
    if (!migrated) return { ok: false, reason: "legacy_not_imported" };
    return { ok: true };
  }
  // A file this version does not understand: it is not touched.
  return { ok: false, reason: "marker_foreign" };
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
  inspectMarker,
  clearMarker,
  clearMarkerIfUnchanged,
  clearMarkerRecords,
  clearLegacyMarkerIfUnchanged,
  readLegacyMarker,
  listRecordIds,
  classifyChanges,
};
