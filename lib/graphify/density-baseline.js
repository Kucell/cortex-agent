"use strict";

/**

 * The durable baseline log (issue #154).

 *

 * The baseline is an APPEND-ONLY log of records; the reader picks the

 * record that wins the order, so a publisher that lost a race cannot

 * destroy the record that won it. This module owns reading, ordering,

 * appending and stamping the log, and the migration of a legacy

 * `graph.json._meta` baseline into it.

 */



const fs = require("node:fs");

const path = require("node:path");



const {

  baselinePath,

  graphPath,

  parseJsonLines,

} = require("./density-files");

const {

  allocateTicket,

  currentGeneration,

  isDisplaced,

  isDisplacedRecord,

} = require("./density-lock");



const BASELINE_SCHEMA_VERSION = "1.0";

// The baseline log grows by one record per publication. It is NEVER
// compacted: a compaction rewrites the log, and a rewrite is a read
// followed by a write -- the very shape that lets two publishers roll the
// baseline back. The log therefore only grows, and only by a record per
// full rebuild (a handful per project and year).

/**
 * Read every usable record of the baseline log.
 *
 * The sidecar is an APPEND-ONLY log: one JSON record per line. A line that
 * cannot be parsed is skipped -- a publisher that died in the middle of a
 * write leaves a partial line, and the records around it are still valid.
 */
function readBaselineRecords(projectRoot) {
  let buffer;
  try {
    buffer = fs.readFileSync(baselinePath(projectRoot));
  } catch (_) {
    return [];
  }
  const text = buffer.toString("utf8");
  const records = [];
  // The LEGACY format: one pretty-printed JSON object for the whole file.
  // It was written by the version that published the baseline by replacing
  // the file. It must still be read, or the guard would silently lose its
  // baseline and stop firing.
  const whole = text.trim();
  if (whole.startsWith("{")) {
    try {
      pushBaselineCandidate(records, projectRoot, JSON.parse(whole), 0, 0);
    } catch (_) { /* not the legacy format: fall through to the log */ }
  }
  // The legacy object may be followed by the records that a later append
  // added, and possibly by a FRAGMENT: an append that failed half-way
  // leaves a truncated line at the end.
  //
  // The legacy object is the baseline the project has, so it must be read
  // even when a fragment follows it: the whole file is neither valid JSON
  // nor a valid log, and a reader that gives up would lose the baseline
  // silently.
  //
  // The legacy object and the records that follow it are BOTH handed to
  // the same order. A reader that stopped at the first parsable line would
  // throw the legacy object away as soon as one record was appended after
  // it -- and the legacy object is often the MEASURED baseline, which is
  // exactly the one that must not be displaced by a later migration.
  const legacy = firstJsonObject(text);
  if (legacy) {
    pushBaselineCandidate(records, projectRoot, legacy.value, 0, 0);
  }
  // The line-delimited records of the whole file. The records that follow
  // the legacy object are among them, so they are found either way.
  for (const entry of parseBaselineLines(buffer, projectRoot)) {
    records.push(entry);
  }
  return records;
}

/**
 * Add a record to the candidates of the baseline log, when it is usable.
 */
function pushBaselineCandidate(records, projectRoot, value, index, offset) {
  if (!value || typeof value !== "object") return;
  const ratio = Number(value.edge_node_ratio);
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  // A record published by a holder that LOST the lock is dropped.
  if (isDisplacedRecord(projectRoot, value, offset)) return;
  records.push({ record: value, index, offset });
}

/**
 * Parse the records of a line-delimited baseline log. A line that cannot
 * be parsed is skipped: a publisher that died in the middle of a write
 * leaves a partial line, and the records around it are still valid.
 */
function parseBaselineLines(source, projectRoot) {
  const records = [];
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source), "utf8");
  for (const entry of parseJsonLines(buffer)) {
    const parsed = entry.value;
    const ratio = Number(parsed.edge_node_ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    // A record published by a holder that LOST the lock is dropped: the
    // holder may have published it after it was displaced, and the readers
    // must not trust it.
    if (isDisplacedRecord(projectRoot, parsed, entry.offset)) continue;
    records.push({ record: parsed, index: entry.index, offset: entry.offset });
  }
  return records;
}

/**
 * The first balanced JSON object in a text, with the offset behind it.
 *
 * The legacy sidecar was ONE pretty-printed object. A failed append can
 * leave that object followed by a fragment, so the object has to be found
 * by its braces instead of by the whole file.
 */
function firstJsonObject(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        try {
          return { value: JSON.parse(candidate), end: index + 1 };
        } catch (_) {
          start = -1;
        }
      }
    }
  }
  return null;
}

/**
 * The order of two baseline records.
 *
 * The order is TOTAL and it is derived from the records themselves, so it
 * does not depend on a judgement that can be invalidated a moment later:
 *
 *   1. the PRIORITY -- a baseline that a full build measured (1) always
 *      beats one that was migrated from the graph meta data (0). The
 *      migration is a snapshot of an older graph, so it must never
 *      displace a measured baseline.
 *   2. the LOCK GENERATION -- the generation only advances when a live
 *      holder can be displaced, so a newer generation is a newer build.
 *   3. the TIMESTAMP -- within one generation the build that measured the
 *      newer graph is the newer one. It is compared as text, because the
 *      ISO-8601 format sorts chronologically.
 *   4. the PUBLICATION SEQUENCE -- the tie-breaker for two measurements
 *      that carry the same timestamp. It is allocated when a build hands
 *      its result over, so it does not depend on the wall clock and not on
 *      the position of the record in the log.
 */
function compareBaselineRecords(a, b) {
  const priorityA = Number(a.priority) || 0;
  const priorityB = Number(b.priority) || 0;
  if (priorityA !== priorityB) return priorityA < priorityB ? -1 : 1;
  // The PUBLICATION SEQUENCE orders the MEASUREMENTS, not the
  // publications. It is allocated when a build takes its INPUT -- the
  // moment the build starts reading the project -- so a build that started
  // later measured a newer graph.
  //
  // The order therefore does not depend on the wall clock. A build that
  // measured an OLDER graph and was published LATE -- because it was
  // suspended, or because its process was slow -- used to win the order
  // through its later timestamp, and the baseline was dragged back to the
  // older measurement while the graph on disk was the newer one.
  // An absent sequence and the number zero are different things:
  // `Number(null)` is zero, so a record without a sequence used to be
  // ordered as the sequence zero.
  const rawSequenceA = a.sequence;
  const rawSequenceB = b.sequence;
  const hasSequenceA = rawSequenceA !== null
    && rawSequenceA !== undefined
    && rawSequenceA !== ""
    && Number.isFinite(Number(rawSequenceA));
  const hasSequenceB = rawSequenceB !== null
    && rawSequenceB !== undefined
    && rawSequenceB !== ""
    && Number.isFinite(Number(rawSequenceB));
  const sequenceA = hasSequenceA ? Number(rawSequenceA) : NaN;
  const sequenceB = hasSequenceB ? Number(rawSequenceB) : NaN;
  // The sequence orders the MEASUREMENTS only when the publisher DECLARED
  // it: a sequence that the publisher allocated itself says nothing about
  // the order of the inputs. Such a record takes part in the tie-breaker
  // at the end, and not in the order of the measurements.
  const declaredA = hasSequenceA && a.sequence_allocated !== true;
  const declaredB = hasSequenceB && b.sequence_allocated !== true;
  if (declaredA && declaredB && sequenceA !== sequenceB) {
    return sequenceA < sequenceB ? -1 : 1;
  }
  const generationA = Number.isFinite(Number(a.lock_generation)) ? Number(a.lock_generation) : 0;
  const generationB = Number.isFinite(Number(b.lock_generation)) ? Number(b.lock_generation) : 0;
  if (generationA !== generationB) return generationA < generationB ? -1 : 1;
  const atA = String(a.baseline_locked_at || "");
  const atB = String(b.baseline_locked_at || "");
  if (atA !== atB) return atA < atB ? -1 : 1;
  // The PUBLICATION SEQUENCE breaks the tie between two measurements that
  // carry the SAME timestamp. It is allocated when a build hands its
  // result over, so it depends neither on the wall clock nor on the
  // position of the record in the log.
  //
  // It comes AFTER the timestamp on purpose: the sequence says which
  // publication came last, not which MEASUREMENT is newer. A publisher
  // that measured an older graph and published it late must not win -- that
  // is exactly the rollback the order exists to prevent.
  if (hasSequenceA && hasSequenceB && sequenceA !== sequenceB) {
    return sequenceA < sequenceB ? -1 : 1;
  }
  return 0;
}

/**
 * The record that wins the order -- the baseline that is in effect.
 */
function pickBaselineRecord(records) {
  let winner = null;
  for (const entry of records || []) {
    if (!winner) {
      winner = entry;
      continue;
    }
    const order = compareBaselineRecords(entry.record, winner.record);
    // The position in the log is NOT a tie-breaker: a publisher that was
    // interrupted appends its record later, and the log position would then
    // make the OLDER build win.
    if (order > 0) winner = entry;
  }
  return winner ? winner.record : null;
}

/**
 * Append a record to the baseline log.
 *
 * The append NEVER replaces the file, so a publisher that lost a race
 * cannot destroy the record that won it. The reader decides which record
 * is the baseline. That is what removes the "compare the timestamp, then
 * rename over the file" window -- a read followed by a write is not a
 * monotonic commit, and two real runners could roll the baseline back
 * through it.
 */
function appendBaselineRecord(projectRoot, record) {
  const file = baselinePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(record) + "\n";
  // The log is a sequence of lines. A file that does not end with a
  // newline would swallow the next record into the last line.
  let prefix = "";
  try {
    const stat = fs.statSync(file);
    if (stat.size > 0) {
      const handle = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(handle, last, 0, 1, stat.size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(handle);
      }
    }
  } catch (_) { /* the log does not exist yet */ }
  const handle = fs.openSync(file, "a", 0o600);
  try {
    // ONE write call: with O_APPEND the offset update and the write are
    // atomic, so two publishers never interleave their records.
    const bytes = Buffer.from(prefix + line, "utf8");
    const written = fs.writeSync(handle, bytes);
    // A SHORT write is not a publication: the record on disk would be a
    // fragment, and the caller would report a success that never landed.
    if (written !== bytes.length) {
      throw new Error("short baseline append");
    }
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Read the durable baseline sidecar. Returns null when there is none or
 * when it is unusable.
 */
function readBaselineSidecar(projectRoot) {
  return pickBaselineRecord(readBaselineRecords(projectRoot));
}

/**
 * Read the node / edge counts and `_meta` from `graphify-out/graph.json`.
 * Never throws -- a corrupt graph simply yields zero counts.
 */
function readGraphCounts(projectRoot) {
  const file = graphPath(projectRoot);
  const empty = { nodes: 0, edges: 0, meta: {}, present: false, status: "missing" };
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // A graph that CANNOT be read is not a graph that does not exist.
    // The distinction decides whether the baseline migration may run: a
    // missing graph has no baseline to migrate, but an unreadable one
    // hides a baseline that the caller cannot see. Treating a read error
    // as "there is no baseline" let the incremental update run and destroy
    // the only baseline the project had.
    if (err && err.code === "ENOENT") return empty;
    return {
      nodes: 0,
      edges: 0,
      meta: {},
      present: false,
      status: "unreadable",
      error: err && err.code ? err.code : "read_failed",
    };
  }
  if (!graph || typeof graph !== "object") {
    return { nodes: 0, edges: 0, meta: {}, present: false, status: "corrupt" };
  }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  // Graphify writes `links`; older/other shapes use `edges`.
  const edges = Array.isArray(graph.links)
    ? graph.links.length
    : (Array.isArray(graph.edges) ? graph.edges.length : 0);
  const meta = (graph._meta && typeof graph._meta === "object") ? graph._meta : {};
  return { nodes, edges, meta, present: true, status: "ok" };
}

/**
 * Resolve the baseline ratio and its provenance.
 *
 * Priority (highest first):
 *   1. the durable sidecar -- survives the incremental update that erases
 *      `graph.json._meta`;
 *   2. `graph.json._meta.edge_node_ratio` -- the consumer-side convention,
 *      honoured when a project already carries it;
 *   3. the configured `baseline_edge_node_ratio`;
 *   4. nothing -> the caller skips the check.
 */
function resolveBaseline(projectRoot, config, counts) {
  const sidecar = readBaselineSidecar(projectRoot);
  // The sidecar is an append-only log, and the record that wins the order
  // is the baseline in effect. A publisher whose lock was reclaimed cannot
  // publish at all -- the generation fence refuses its record -- so the
  // winner is always a record that a live holder wrote.
  if (sidecar) {
    return { value: Number(sidecar.edge_node_ratio), source: "density_baseline_sidecar" };
  }
  const metaRatio = counts && counts.meta ? Number(counts.meta.edge_node_ratio) : NaN;
  if (Number.isFinite(metaRatio) && metaRatio > 0) {
    return { value: metaRatio, source: "graph_meta" };
  }
  const configRatio = Number(config.baseline_edge_node_ratio);
  if (Number.isFinite(configRatio) && configRatio > 0) {
    return { value: configRatio, source: "threshold_config" };
  }
  return null;
}

/**
 * Migrate a `graph.json._meta.edge_node_ratio` baseline into the durable
 * sidecar.
 *
 * This has to happen BEFORE the incremental update, not after. `graphify
 * update .` rewrites graph.json and drops every key the CLI does not own,
 * `_meta` included. A project that carried the consumer-side convention
 * (`_meta`) and has no sidecar yet would therefore lose its baseline on
 * the very first commit after the upgrade -- the guard would report
 * `no_baseline` and never fire again.
 *
 * The migration only ever ADDS the sidecar when there is none; an existing
 * sidecar is authoritative and is never overwritten by a `_meta` value.
 *
 * Returns { migrated, reason, ratio? }.
 */
function migrateMetaBaseline(projectRoot, counts = null) {
  try {
    if (readBaselineSidecar(projectRoot)) {
      return { migrated: false, reason: "sidecar_present" };
    }
    const graphCounts = counts || readGraphCounts(projectRoot);
    const status = graphCounts && graphCounts.status
      ? graphCounts.status
      : (graphCounts && graphCounts.present ? "ok" : "missing");
    // A graph that could not be READ, or that could not be PARSED, hides
    // a baseline that the caller cannot see. It is NOT the same as a graph
    // without a baseline: the migration refuses, so the incremental update
    // does not run and the baseline survives.
    if (status === "unreadable") {
      return { migrated: false, reason: "graph_unreadable" };
    }
    if (status === "corrupt") {
      return { migrated: false, reason: "graph_corrupt" };
    }
    const meta = graphCounts && graphCounts.meta ? graphCounts.meta : {};
    const ratio = Number(meta.edge_node_ratio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return { migrated: false, reason: "no_meta_baseline" };
    }
    const nodes = Number(meta.nodes) || graphCounts.nodes || 0;
    const edges = Number(meta.edges) || Math.round(ratio * (graphCounts.nodes || 0));
    let sequence;
    try {
      sequence = allocateTicket(projectRoot, "seq");
    } catch (err) {
      return { migrated: false, reason: err && err.code ? err.code : "sequence_alloc_failed" };
    }
    const payload = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      kind: "migration",
      // A migration is a snapshot of the graph meta data, so it never
      // displaces a baseline that a full build measured.
      priority: 0,
      build_kind: String(meta.build_kind || "full"),
      edge_node_ratio: Number(ratio.toFixed(4)),
      nodes,
      edges,
      baseline_locked_at: meta.baseline_locked_at || new Date().toISOString(),
      lock_generation: currentGeneration(projectRoot),
      sequence,
      sequence_allocated: true,
      migrated_from: "graph_meta",
    };
    // The migration APPENDS its record; it never replaces the log. A full
    // rebuild that finished in the meantime may already have published a
    // measured baseline, and the migration must not displace it: the
    // measured record carries the higher priority, so the reader keeps it.
    appendBaselineRecord(projectRoot, payload);
    return { migrated: true, reason: "migrated", ratio };
  } catch (err) {
    return {
      migrated: false,
      reason: err && err.code ? err.code : "migration_failed",
    };
  }
}

// -- Writing the baseline (full builds only) --------------------------------

/**
 * Stamp the measured ratio as the new baseline. Called ONLY after a FULL
 * build has completed. The incremental path never reaches this function,
 * which is what keeps the baseline from drifting down with the graph.
 *
 * Writes the sidecar -- and NOTHING ELSE. The framework does not write
 * `graph.json`: a mirror of the baseline into the graph is a read-modify-
 * write of the whole file, and it can publish a stale snapshot over a
 * newer graph. The sidecar is the durable copy.
 *
 * Returns { ok, ratio, sidecarPath, metaStamped }.
 */
function stampBaseline(projectRoot, { nodes, edges, buildKind = "full", now = null, lockGeneration = null, lockToken = null, sequence: sequenceHint = null, onBeforeAppend = null } = {}) {
  const nodeCount = Math.max(0, Number(nodes) || 0);
  const edgeCount = Math.max(0, Number(edges) || 0);
  if (nodeCount <= 0) {
    return { ok: false, reason: "no_nodes" };
  }
  const ratio = edgeCount / nodeCount;
  const timestamp = now || new Date().toISOString();
  // The PUBLICATION SEQUENCE orders the MEASUREMENTS. It is allocated when
  // the build takes its INPUT -- the moment it starts reading the project
  // -- so that a build which started later measured a newer graph.
  //
  // The caller hands it in, because the input boundary is where the build
  // read the project and not where it published its result: a build that
  // was suspended between its input and its publication must not win the
  // order through a later wall-clock timestamp.
  // A sequence that is NOT given is allocated here. The absence of a
  // sequence and the number zero are different things: `Number(null)` is
  // zero, so an absent sequence used to be published as the sequence
  // zero, the allocator never ran, and every publication of the same
  // millisecond carried the same order.
  let sequence = null;
  let sequenceAllocated = false;
  if (sequenceHint !== null && sequenceHint !== undefined && sequenceHint !== "") {
    const hinted = Number(sequenceHint);
    if (Number.isFinite(hinted)) sequence = hinted;
  }
  if (sequence === null) {
    try {
      sequence = allocateTicket(projectRoot, "seq");
      sequenceAllocated = true;
    } catch (err) {
      return { ok: false, reason: err && err.code ? err.code : "sequence_alloc_failed", ratio };
    }
  }
  const payload = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    kind: "stamp",
    // A baseline that a full build measured outranks a migrated one.
    priority: 1,
    build_kind: buildKind,
    edge_node_ratio: Number(ratio.toFixed(4)),
    nodes: nodeCount,
    edges: edgeCount,
    baseline_locked_at: timestamp,
    // The generation of the lock this baseline was written under. A holder
    // that was displaced by a reclaim keeps writing with an OLDER
    // generation, and every reader can tell that the value was not written
    // by the lock's owner.
    lock_generation: lockGeneration === null ? currentGeneration(projectRoot) : Number(lockGeneration),
    // The TOKEN of the lock that holds this publication. A holder that
    // lost the lock is registered by its token, and every artifact it
    // publishes is dropped by the readers. The token is precise: it fences
    // exactly the holder that lost the lock, and no other one.
    lock_token: lockToken || null,
    // The order of the builds themselves.
    sequence,
    // Whether the sequence was ALLOCATED here. An allocated sequence is
    // unique and monotonic, but it says nothing about the order of the
    // inputs: only a sequence the caller declared orders the
    // measurements.
    sequence_allocated: sequenceAllocated,
  };
  const sidecar = baselinePath(projectRoot);
  // The FENCE that does not depend on the shared counter: a holder that
  // lost the lock must not publish. Its artifacts are dropped by the
  // readers, so publishing here would only leave a record that is
  // distrusted.
  if (lockToken && isDisplaced(projectRoot, lockToken)) {
    return { ok: false, reason: "lock_displaced", ratio, sidecarPath: sidecar };
  }
  // The generation fence: a holder whose lock was reclaimed must not
  // publish a baseline. The check is a comparison of values, so the window
  // between it and the write is closed by the generation that travels with
  // the artifact: a baseline written by a displaced holder carries an old
  // generation and is distrusted by the reader.
  const current = currentGeneration(projectRoot);
  if (Number(payload.lock_generation) < current) {
    return { ok: false, reason: "lock_generation_stale", ratio, sidecarPath: sidecar };
  }
  // The baseline only ever moves FORWARD.
  //
  // A publication that replaces a NEWER baseline with an older one lowers
  // the threshold and weakens the guard -- the ratio the guard compares
  // against is the one the graph was measured against, and an older value
  // describes an older graph.
  //
  // The publication APPENDS its record instead of replacing the file, so a
  // publisher that lost the race cannot destroy the record that won it.
  // The reader picks the winner, which is what makes the order a property
  // of the records rather than of a judgement that a later publisher can
  // invalidate. This refusal is therefore only an optimisation: it keeps
  // the log free of records that lost the order anyway.
  const existing = readBaselineSidecar(projectRoot);
  if (existing && compareBaselineRecords(existing, payload) > 0) {
    return { ok: false, reason: "baseline_is_newer", ratio, sidecarPath: sidecar };
  }
  // A TEST SEAM: called after the comparison and BEFORE the append. It
  // injects the interleaving that makes the race observable: another
  // publisher writes its record while this one is suspended, and the
  // suspended publisher then writes its own record.
  if (typeof onBeforeAppend === "function") {
    try { onBeforeAppend(); } catch (_) { /* the seam must not break the stamp */ }
  }
  try {
    appendBaselineRecord(projectRoot, payload);
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "sidecar_write_failed", ratio };
  }
  // The publication is VERIFIED. A record that is in the log but that the
  // readers DROP -- because its holder was displaced while the record was
  // being written -- is not a published baseline, and a stamp that
  // reported success anyway would let the caller believe that the
  // baseline moved forward while it did not.
  const published = readBaselineRecords(projectRoot).some(
    (entry) => entry.record
      && entry.record.sequence !== null
      && entry.record.sequence !== undefined
      && Number(entry.record.sequence) === sequence
  );
  if (!published) {
    return { ok: false, reason: "publication_rejected", ratio, sidecarPath: sidecar };
  }
  // The baseline in effect is the winner of the log, which is not
  // necessarily the record that was just appended -- but it has to EXIST:
  // a stamp that has no winner did not publish anything.
  const winner = readBaselineSidecar(projectRoot);
  if (!winner) {
    return { ok: false, reason: "publication_rejected", ratio, sidecarPath: sidecar };
  }
  return { ok: true, ratio, sidecarPath: sidecar, metaStamped: false, payload: winner };
}

/**
 * Stamp the baseline from the CURRENT graph file, but only when the graph
 * still holds the counts the caller measured.
 *
 * The rebuild and the incremental update can interleave: the full build
 * writes the graph, and an incremental update that started earlier
 * publishes its own (degraded) graph before the rebuild reads it back. The
 * rebuild would then stamp the DEGRADED ratio as the new "full" baseline,
 * and the guard would never fire again.
 *
 * The caller therefore passes the counts it measured right after the build.
 * If the graph no longer matches them, the stamp is refused: the baseline
 * stays at the previous value, which is conservative (the guard keeps
 * firing) instead of being dragged down with the degraded graph.
 *
 * Returns { ok, ratio?, reason? }.
 */
function stampBaselineFromGraph(projectRoot, { expectedNodes = null, expectedEdges = null, buildKind = "full", now = null, lockGeneration = null, lockToken = null, sequence = null } = {}) {
  const counts = readGraphCounts(projectRoot);
  if (!counts.present) {
    return { ok: false, reason: "graph_missing" };
  }
  if (expectedNodes !== null && Number(expectedNodes) !== counts.nodes) {
    return { ok: false, reason: "graph_changed_during_rebuild", nodes: counts.nodes };
  }
  if (expectedEdges !== null && Number(expectedEdges) !== counts.edges) {
    return { ok: false, reason: "graph_changed_during_rebuild", edges: counts.edges };
  }
  const stamp = stampBaseline(projectRoot, {
    nodes: counts.nodes,
    edges: counts.edges,
    buildKind,
    now,
    lockGeneration,
    lockToken,
    sequence,
  });
  if (!stamp.ok) return stamp;
  return Object.assign({}, stamp, { nodes: counts.nodes, edges: counts.edges });
}



module.exports = {

  BASELINE_SCHEMA_VERSION,

  readBaselineRecords,

  parseBaselineLines,

  firstJsonObject,

  compareBaselineRecords,

  pickBaselineRecord,

  appendBaselineRecord,

  readBaselineSidecar,

  readGraphCounts,

  resolveBaseline,

  migrateMetaBaseline,

  stampBaseline,

  stampBaselineFromGraph,

};
