"use strict";

// TEST ONLY: no updater, deployment authority, signer service or N-API import.
// Execute the unchanged, hash-pinned legacy closure; never patch its threshold.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const rehearsal = require("./permit-legacy-sqlite-rehearsal");
const core = require("../../../lib/coordination/permit-legacy-migration-core");
const { ROOT, hash, manifest } = rehearsal;
const WATER = "protected-anchor-high-water.log";
const THRESHOLD = 256 * 1024;
const RETENTION = 64;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const lines = bytes => bytes.toString("utf8").trim().split("\n").map(JSON.parse);
function save(file, bytes) { fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); }
function newRun() {
  fs.mkdirSync(ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(ROOT, "permit-legacy-highwater-"));
}
function installedRoot() {
  if (process.env.CORTEX_LEGACY_1157_ROOT) return path.resolve(process.env.CORTEX_LEGACY_1157_ROOT);
  const r = spawnSync("volta", ["which", "cortex-agent"], { encoding: "utf8", timeout: 10000 });
  if (r.status !== 0 || !r.stdout.trim()) fail("HIGHWATER_INSTALLED_1157_UNAVAILABLE");
  return path.dirname(path.dirname(fs.realpathSync(r.stdout.trim())));
}
function installed() {
  const root = installedRoot();
  if (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version !== "1.15.7") fail("HIGHWATER_INSTALLED_VERSION");
  const names = ["protected-permit-store", "protected-anchor", "anchor-authorization", "protected-scope"];
  const sources = names.map(name => {
    const file = path.join(root, "lib/coordination", name + ".js");
    const frozen = path.join(__dirname, name === "protected-permit-store" ? manifest.legacy.store_fixture : "permit-legacy-sqlite-sources/" + name + ".txt");
    const bytes = fs.readFileSync(file), expected = fs.readFileSync(frozen);
    // The legacy producer must be the UNCHANGED 1.15.7 build. A 1.15.7
    // installation whose sources were rebuilt on top of it is a DIFFERENT
    // build: it is not this producer, and it cannot stand in for one. Report
    // that as an unavailable legacy producer instead of failing the suite.
    if (!bytes.equals(expected) || hash(bytes) !== (name === "protected-permit-store" ? manifest.legacy.store_sha256 : manifest.dependencies[name])) fail("HIGHWATER_INSTALLED_NOT_LEGACY");
    return { name, sha256: hash(bytes) };
  });
  // Load actual installed files, rather than relabeling a frozen-fixture run.
  return { root, sources, store: require(path.join(root, "lib/coordination/protected-permit-store.js")),
    anchor: require(path.join(root, "lib/coordination/protected-anchor.js")) };
}
function engine(kind) {
  if (kind === "installed") return installed();
  if (kind !== "frozen") fail("HIGHWATER_ENGINE");
  return rehearsal.frozen("legacy");
}
function fileBytes(root) {
  const out = {};
  function visit(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), key = rel ? rel + "/" + name : name, s = fs.lstatSync(file);
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) fail("HIGHWATER_UNSAFE_PATH");
      if (s.isDirectory()) visit(file, key);
      else out[key] = fs.readFileSync(file);
    }
  }
  visit(root, ""); return out;
}
function byteManifest(root) {
  return Object.entries(fileBytes(root)).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) }));
}
function identity(stat) {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
    nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function collectSource(root) {
  const manifest = [], files = new Map();
  function visit(file, name) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) fail("HIGHWATER_UNSAFE_PATH");
    const item = { name, kind: stat.isDirectory() ? "directory" : "file", ...identity(stat) };
    if (stat.isDirectory()) {
      manifest.push(item);
      for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child), name === "." ? child : name + "/" + child);
    } else {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = identity(fs.fstatSync(fd));
        if (JSON.stringify(opened) !== JSON.stringify(identity(stat))) fail("HIGHWATER_SOURCE_CHANGED");
        const bytes = fs.readFileSync(fd);
        if (JSON.stringify(identity(fs.fstatSync(fd))) !== JSON.stringify(opened)) fail("HIGHWATER_SOURCE_CHANGED");
        files.set(name, bytes); manifest.push({ ...item, sha256: hash(bytes) });
      } finally { fs.closeSync(fd); }
    }
  }
  visit(root, "."); return { manifest, files };
}
function sourceManifest(root) { return collectSource(root).manifest; }
function assertSourceUnchanged(root, manifest) {
  if (JSON.stringify(sourceManifest(root)) !== JSON.stringify(manifest)) fail("HIGHWATER_SOURCE_CHANGED");
}
function captureSource(root) {
  // One captured byte set feeds BOTH SQLite and anchor evidence. No second
  // read of live anchor files after copying DB. Bracket checks detect observed
  // replacement/mutation; they are NOT an atomic snapshot or hostile ABA fence.
  const captured = collectSource(root), copy = path.join(newRun(), "source-copy");
  fs.mkdirSync(copy, { mode: 0o700 });
  for (const item of captured.manifest) if (item.kind === "directory" && item.name !== ".") fs.mkdirSync(path.join(copy, item.name), { mode: 0o700 });
  for (const [name, bytes] of captured.files) save(path.join(copy, name), bytes);
  const row = rehearsal.inspect(copy), state = JSON.parse(row.body);
  const journal = [...captured.files].filter(([name]) => name.startsWith("anchor/protected-anchor-entry-"))
    .map(([, bytes]) => JSON.parse(bytes.toString("utf8")));
  const waterBytes = captured.files.get("anchor/" + WATER);
  const input = { format_version: 1, source: row,
    expected: { decision_id: state.decision_id, store_id: state.store_id, body_digest: row.sha256, anchor_sequence: state.anchor_sequence },
    journal, high_water: lines(waterBytes), audit: lines(captured.files.get("anchor/protected-anchor-audit.log")) };
  assertSourceUnchanged(root, captured.manifest);
  return { manifest: captured.manifest, input, waterBytes };
}
function sourceEvidence(root) {
  return captureSource(root).input;
}
function create(kind, run) {
  const loaded = engine(kind), source = path.join(run, "source");
  fs.mkdirSync(source, { mode: 0o700 });
  const dbDir = path.join(source, "db"), anchorDir = path.join(source, "anchor");
  fs.mkdirSync(dbDir, { mode: 0o700 }); fs.mkdirSync(anchorDir, { mode: 0o700 });
  save(path.join(source, "fixture.json"), JSON.stringify({ kind: "legacy-sqlite-rehearsal-only", version: "1.15.7" }) + "\n");
  const file = path.join(dbDir, "state.sqlite"), water = path.join(anchorDir, WATER);
  const old = loaded.store.ProtectedPermitStore.initialize(file, { decisionId: "D-highwater-fixture", anchorDir,
    anchorMode: "permissive", clock: () => 1000, verifyRecovery: () => true });
  let compaction, calls = 0;
  // Retain exactly the bytes emitted by the old writer. This observer archive
  // is local test evidence, NOT an authenticated external backup or receipt.
  const archive = [fs.readFileSync(water)];
  function operation(fn) {
    const before = fs.statSync(water);
    const prefix = before.size >= THRESHOLD ? fs.readFileSync(water) : null;
    const result = fn(); calls++;
    const after = fs.statSync(water);
    if (prefix) {
      if (compaction || after.ino === before.ino || after.size >= before.size) fail("HIGHWATER_COMPACTION_NOT_OBSERVED");
      const suffix = fs.readFileSync(water), prior = lines(prefix), current = lines(suffix);
      compaction = { beforeBytes: before.size, afterBytes: after.size, beforeInode: before.ino, afterInode: after.ino,
        beforeCount: prior.length, afterCount: current.length, previousMark: prior.at(-1).sequence,
        firstRetained: current[0].sequence, appendedSequence: current.at(-1).sequence };
      save(path.join(run, "pre-compaction-high-water.log"), prefix);
      save(path.join(run, "immediate-post-compaction-high-water.log"), suffix);
      archive.push(Buffer.from(suffix.toString("utf8").trimEnd().split("\n").at(-1) + "\n"));
    } else {
      const fd = fs.openSync(water, "r");
      try {
        const delta = Buffer.alloc(after.size - before.size);
        if (fs.readSync(fd, delta, 0, delta.length, before.size) !== delta.length) fail("HIGHWATER_SHORT_READ");
        archive.push(delta);
      } finally { fs.closeSync(fd); }
    }
    return result;
  }
  let state;
  try {
    const lease = operation(() => old.acquire({ owner: "fixture", sessionId: "s", hostId: "h", workerId: "w", runId: "r",
      generation: "g", desktopKey: "desktop", ownedAppId: "a", idempotencyKey: "lease", ttlMs: 100000 }));
    const reserve = (id, digest) => operation(() => old.reserve({ ...lease, operation: "fixture-no-business-dispatch",
      targetDigest: digest.repeat(64), paramsDigest: "b".repeat(64), idempotencyKey: id, ttlMs: 100 }));
    const finished = reserve("finished", "a");
    operation(() => old.consume(finished)); operation(() => old.finish({ ...finished, outcome: "finished" }));
    reserve("revoked", "c");
    operation(() => old.release(lease)); operation(() => old.recover({ fixture: "no external operation dispatched" }));
    // Idempotent consume is still a real legacy SQLite transaction. It grows
    // anchor/audit/high-water without creating thousands of live permits.
    while (!compaction && calls < 2000) operation(() => old.consume(finished));
    if (!compaction) fail("HIGHWATER_THRESHOLD_NOT_REACHED");
    state = old.snapshot();
  } finally { old.close(); }
  const complete = Buffer.concat(archive);
  save(path.join(run, "observed-complete-high-water.log"), complete);
  const input = sourceEvidence(source);
  save(path.join(run, "compacted-evidence.json"), JSON.stringify(input));
  const result = { kind, run, source, state, compaction, calls, completeBytes: complete.length,
    completeSha256: hash(complete), highWaterCount: input.high_water.length, journalCount: input.journal.length,
    auditCount: input.audit.length, node: process.version, sqlite: process.versions.sqlite,
    nodeBinarySha256: hash(fs.readFileSync(process.execPath)), platform: process.platform, arch: process.arch,
    installedSources: loaded.sources || null, frozenSources: manifest,
    authority: false, executionAuthorized: false, businessStarted: false, atimePreservationClaimed: false };
  save(path.join(run, "producer.json"), JSON.stringify(result, null, 2));
  return result;
}

// A protocol mechanics model, NOT a new production acceptance path. The real
// verifier must obtain key, latest head and fence capability from an isolated host.
// Here a test-held key merely exercises signatures and exact byte bindings.
function fixtureWitness() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey, sign(payload) {
    return { payload, signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64") };
  } };
}
function archivePayload(captured, completeBytes, nonceParameter) {
  const input = captured.input;
  return { protocol: "legacy-highwater-archive-v2-test-model", version: "1.15.7", nonceParameter,
    storeId: input.expected.store_id, decisionId: input.expected.decision_id,
    sequence: input.expected.anchor_sequence, bodyDigest: input.source.sha256,
    sourceManifestDigest: hash(JSON.stringify(captured.manifest)), completeLogDigest: hash(completeBytes),
    evidenceDigest: hash(JSON.stringify(input)), anchorSourceDigest: manifest.dependencies["protected-anchor"],
    storeSourceDigest: manifest.legacy.store_sha256 };
}
function assertSameEvidence(captured, input) {
  if (JSON.stringify(captured.input) !== JSON.stringify(input)) fail("HIGHWATER_SOURCE_EVIDENCE");
}
function validateArchive(captured, completeBytes) {
  const input = captured.input;
  const full = lines(completeBytes);
  if (!completeBytes.length || completeBytes.at(-1) !== 10 || full.length !== input.expected.anchor_sequence ||
      full.some((r, i) => r.sequence !== i + 1) ||
      JSON.stringify(full.slice(-input.high_water.length)) !== JSON.stringify(input.high_water)) fail("HIGHWATER_ARCHIVE_PREFIX");
  // Recovered records remain in a separate in-memory evidence envelope. Do
  // not rewrite the source log or claim local hashes prove archive provenance.
  const prepared = core.prepareLegacyPermitMigration(JSON.stringify({ ...input, high_water: full }));
  const replay = newRun(), anchor = engine("frozen").anchor;
  for (const entry of full) anchor.appendHighWater(replay, entry);
  if (!fs.readFileSync(path.join(replay, WATER)).equals(captured.waterBytes)) fail("HIGHWATER_REPLAY_BYTES");
  return prepared;
}
function backupPayload(source, input, completeBytes, nonceParameter) {
  const captured = captureSource(source);
  assertSameEvidence(captured, input);
  validateArchive(captured, completeBytes);
  assertSourceUnchanged(source, captured.manifest);
  return archivePayload(captured, completeBytes, nonceParameter);
}
function reviewBackup({ source, input, completeBytes, receipt, publicKey, expectedReceiptHead, nonceParameter }) {
  // These supplied parameters are bindings, NOT an external latest-head query,
  // nonce issuance, freshness check or single-use CAS. Repetition WILL succeed.
  if (!crypto.verify(null, Buffer.from(JSON.stringify(receipt.payload)), publicKey, Buffer.from(receipt.signature, "base64"))) fail("HIGHWATER_RECEIPT_SIGNATURE");
  const captured = captureSource(source);
  assertSameEvidence(captured, input);
  const expected = archivePayload(captured, completeBytes, nonceParameter);
  if (JSON.stringify(receipt.payload) !== JSON.stringify(expected) || expectedReceiptHead !== hash(JSON.stringify(receipt))) fail("HIGHWATER_RECEIPT_BINDING");
  const prepared = validateArchive(captured, completeBytes);
  assertSourceUnchanged(source, captured.manifest);
  return { status: "fixture-source-bound-archive-prepared-only", authority: false, executionAuthorized: false,
    nonceParameterBound: true, receiptHeadParameterBound: true, freshnessProven: false, singleUseProven: false,
    target: prepared.target, source_evidence_digest: prepared.source_evidence_digest };
}

module.exports = { ROOT, WATER, THRESHOLD, RETENTION, hash, lines, save, newRun, installed, engine, fileBytes,
  byteManifest, sourceManifest, sourceEvidence, create, fixtureWitness, backupPayload, reviewBackup, snapshot: rehearsal.snapshot };
if (require.main === module) {
  const [kind, run] = process.argv.slice(2);
  // Child may write only to a freshly allocated, empty runtime child directory.
  const relative = path.relative(ROOT, path.resolve(run));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || fs.readdirSync(run).length) fail("HIGHWATER_RUN_PATH");
  process.stdout.write(JSON.stringify(create(kind, run)) + "\n");
}
