"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const supported = Number(process.versions.node.split(".")[0]) >= 24 && process.platform !== "win32";
const opts = { skip: supported ? false : "Requires Node >=24 SQLite and POSIX directory fsync; no platform-gate claim", timeout: 240000 };
const f = supported ? require("./fixtures/permit-legacy-highwater-compaction") : null;
const core = require("../../lib/coordination/permit-legacy-migration-core");
let report, producers, producerPromise, installedAvailable = true;

function produce(kind) {
  const run = f.newRun();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "fixtures/permit-legacy-highwater-compaction.js"), kind, run], {
      env: { ...process.env, TMPDIR: f.ROOT, TMP: f.ROOT, TEMP: f.ROOT }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); }, 220000);
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      fs.writeFileSync(path.join(run, "child-stderr.log"), stderr, { flag: "wx" });
      if (code !== 0) return reject(Error(`${kind} producer ${code}/${signal}: ${stderr}; retained ${run}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}
function evidence(p) { return JSON.parse(fs.readFileSync(path.join(p.run, "compacted-evidence.json"), "utf8")); }
function record(name, value) { f.save(path.join(report, name), JSON.stringify(value, null, 2)); }

test.before(() => {
  if (!supported) return;
  report = f.newRun();
  console.log("high-water compaction evidence: " + report);
});
async function ensureProducers() {
  if (producerPromise) return producerPromise;
  // The installed run is optional on other hosts, but a discovered mismatched
  // version/hash is a hard failure, never silently replaced by the fixture.
  try { f.installed(); }
  catch (e) { if (e.code !== "HIGHWATER_INSTALLED_1157_UNAVAILABLE") throw e; installedAvailable = false; }
  producerPromise = Promise.all([produce("frozen"), ...(installedAvailable ? [produce("installed")] : [])]).then(results => {
    producers = results;
    record("runs.json", { producers, installedAvailable, authority: false, executionAuthorized: false });
  });
  return producerPromise;
}

for (const kind of ["frozen", "installed"]) test(`${kind} unchanged 1.15.7 store naturally compacts nonempty closed history at the byte threshold`, opts, async t => {
  await ensureProducers();
  if (kind === "installed" && !installedAvailable) return t.skip("Installed 1.15.7 unavailable; set CORTEX_LEGACY_1157_ROOT; frozen coverage is not installed coverage");
  const p = producers.find(p => p.kind === kind), input = evidence(p), c = p.compaction;
  assert.ok(c.beforeBytes >= f.THRESHOLD);
  // A record appended by the previous transaction crossed the threshold;
  // compaction happens at the NEXT append, not immediately on crossing it.
  const prior = f.lines(fs.readFileSync(path.join(p.run, "pre-compaction-high-water.log")));
  const lastBytes = Buffer.byteLength(JSON.stringify(prior.at(-1)) + "\n");
  assert.ok(c.beforeBytes - lastBytes < f.THRESHOLD);
  assert.notEqual(c.beforeInode, c.afterInode);
  assert.equal(c.afterCount, f.RETENTION + 1);
  assert.equal(c.firstRetained, c.previousMark - f.RETENTION + 1);
  assert.equal(c.appendedSequence, c.previousMark + 1);
  assert.deepEqual(input.high_water.slice(0, f.RETENTION), prior.slice(-f.RETENTION));
  assert.equal(input.high_water.at(-1).sequence, p.state.anchor_sequence);
  assert.equal(input.journal.length, 2 * p.state.anchor_sequence);
  assert.equal(input.audit.length, p.state.anchor_sequence - 1);
  assert.equal(p.state.lease.status, "released"); assert.equal(p.state.desktop.status, "free");
  assert.deepEqual(Object.values(p.state.permits).map(p => p.status), ["finished", "revoked"]);
  assert.deepEqual(p.state.tombstones["P-PERMIT-2"], { reason: "released", at: 1000 });
  assert.ok(!fs.readdirSync(path.join(p.source, "anchor")).some(n => n.includes("tmp-compact")));
  // Prove the legacy PUBLIC reader accepts this actual compacted state.
  // Open a copy so even SQLite maintenance cannot alter source bytes.
  const before = f.snapshot(p.source), beforeBytes = f.fileBytes(p.source), copy = path.join(f.newRun(), "reader-copy");
  fs.cpSync(p.source, copy, { recursive: true });
  const loaded = f.engine(kind), opened = loaded.store.ProtectedPermitStore.open(path.join(copy, "db/state.sqlite"), {
    anchorDir: path.join(copy, "anchor"), anchorMode: "permissive", expectedDecisionId: p.state.decision_id,
    minimumEpoch: p.state.service_epoch, clock: () => p.state.last_clock_ms });
  try { assert.deepEqual(opened.snapshot(), p.state); } finally { opened.close(); }
  assert.deepEqual(f.fileBytes(p.source), beforeBytes); assert.deepEqual(f.snapshot(p.source), before);
  t.diagnostic(JSON.stringify({ kind, run: p.run, compaction: c, oldReaderAccepted: true, sourceBytesPreserved: true }));
});

test("legacy boundary is >=262144 BEFORE append; retention selects records then preserves every attempt of kept sequences", opts, () => {
  const anchor = f.engine("frozen").anchor;
  function record(sequence, attempt = 1) {
    const r = { sequence, body_digest: "a".repeat(64), store_id: "boundary-only-no-database", attempt };
    return { ...r, record_digest: f.hash([r.sequence, r.body_digest, r.store_id, r.attempt].join("\n")) };
  }
  function probe(bytes, retries = false) {
    const dir = f.newRun(), records = Array.from({ length: 70 }, (_, i) => record(i + 1));
    if (retries) for (let attempt = 2; attempt <= 71; attempt++) records.push(record(69, attempt));
    const raw = records.map(r => JSON.stringify(r) + "\n").join("");
    // Synthetic JSON whitespace measures exact boundary only. Real store
    // history above has no padding, manufactured high-water or source edits.
    f.save(path.join(dir, f.WATER), " ".repeat(bytes - Buffer.byteLength(raw)) + raw);
    anchor.appendHighWater(dir, record(71));
    return { dir, records: f.lines(fs.readFileSync(path.join(dir, f.WATER))) };
  }
  const below = probe(f.THRESHOLD - 1);
  assert.equal(below.records.length, 71); assert.equal(below.records[0].sequence, 1);
  anchor.appendHighWater(below.dir, record(72));
  assert.equal(f.lines(fs.readFileSync(path.join(below.dir, f.WATER))).length, 65);
  const exact = probe(f.THRESHOLD);
  assert.equal(exact.records.length, 65); assert.equal(exact.records[0].sequence, 7);
  const retries = probe(f.THRESHOLD, true);
  assert.equal(retries.records.length, 73); // 71 attempts at seq69 + seq70 + new seq71
  assert.deepEqual([...new Set(retries.records.map(r => r.sequence))], [69, 70, 71]);
  assert.equal(anchor.readHighWater(retries.dir).latestAttemptBySeq.get(69), 71);
  recordResult({ boundary: f.THRESHOLD, uniqueHistoryRetainedBeforeAppend: 64, retryRecordsAfterAppend: 73 });
  function recordResult(value) { f.save(path.join(report, "exact-boundary.json"), JSON.stringify(value, null, 2)); }
});

test("current core and rehearsal refuse unwitnessed legitimate compaction before intent; every source byte survives", opts, async () => {
  await ensureProducers();
  const rehearsal = require("./fixtures/permit-legacy-sqlite-rehearsal");
  for (const p of producers) {
    const input = evidence(p), encoded = JSON.stringify(input), before = f.snapshot(p.source), bytes = f.fileBytes(p.source);
    assert.throws(() => core.prepareLegacyPermitMigration(encoded), { code: "ERR_LEGACY_MIGRATION_EVIDENCE" });
    assert.equal(JSON.stringify(input), encoded);
    let error;
    try { rehearsal.rehearse(p.source); } catch (e) { error = e; }
    assert.equal(error?.code, "FIXTURE_HIGH_WATER_PREFIX");
    assert.equal(error.outcome, "aborted-before-commit");
    assert.ok(!fs.existsSync(path.join(error.run, "prepared.json")));
    const control = f.lines(fs.readFileSync(path.join(error.run, "control.jsonl")));
    assert.deepEqual(control.map(e => e.stage), ["aborted-before-commit"]);
    assert.deepEqual(f.fileBytes(p.source), bytes); assert.deepEqual(f.snapshot(p.source), before);
    record(p.kind + "-refusal.json", { code: error.code, coreCode: "ERR_LEGACY_MIGRATION_EVIDENCE", run: error.run,
      sourceBytesPreserved: true, sourceMetadataPreservedExceptAtime: true, noMigrationIntent: true,
      classification: "valid-legacy-compaction-without-authenticated-provenance", authority: false });
  }
});

test("malicious prefix truncation can produce the exact bytes of the witnessed legitimate compaction", opts, async () => {
  await ensureProducers();
  const p = producers[0], input = evidence(p), before = f.snapshot(p.source), dir = f.newRun(), attacked = path.join(dir, "attacked-copy");
  fs.cpSync(p.source, attacked, { recursive: true });
  const complete = fs.readFileSync(path.join(p.run, "observed-complete-high-water.log")), full = f.lines(complete);
  const completeEvidence = { ...input, high_water: full };
  // A positive content-only control proves no other unsupported state is
  // responsible for the refusal. This does NOT authorize using a local archive.
  assert.equal(core.prepareLegacyPermitMigration(JSON.stringify(completeEvidence)).executionAuthorized, false);
  const water = path.join(attacked, "anchor", f.WATER);
  fs.writeFileSync(water, complete);
  const suffix = Buffer.from(complete.toString("utf8").split("\n").slice(full.length - input.high_water.length).join("\n"));
  fs.writeFileSync(water, suffix); // Deliberate adversarial edit, COPY ONLY.
  assert.deepEqual(f.fileBytes(attacked), f.fileBytes(p.source));
  const attackedEvidence = f.sourceEvidence(attacked);
  assert.deepEqual(attackedEvidence, input);
  assert.throws(() => core.prepareLegacyPermitMigration(JSON.stringify(attackedEvidence)), { code: "ERR_LEGACY_MIGRATION_EVIDENCE" });
  assert.deepEqual(f.snapshot(p.source), before);
  record("indistinguishable.json", { legitimate: p.source, maliciousCopy: attacked, allFileBytesEqual: true,
    evidenceEqual: true, uncompressedControlPreparedOnly: true, authority: false,
    limitation: "Alternative full log is reconstructed from the controlled observer archive; no claim that a second legacy writer produced that full-log final tree." });
});

test("controlled backup replays the exact old compression transition, not an inferred 64-record shape", opts, async () => {
  await ensureProducers();
  for (const p of producers) {
    const before = f.snapshot(p.source), prior = fs.readFileSync(path.join(p.run, "pre-compaction-high-water.log"));
    const expected = fs.readFileSync(path.join(p.run, "immediate-post-compaction-high-water.log"));
    const appended = f.lines(expected).at(-1), replay = f.newRun();
    f.save(path.join(replay, f.WATER), prior);
    f.engine(p.kind).anchor.appendHighWater(replay, appended);
    assert.deepEqual(fs.readFileSync(path.join(replay, f.WATER)), expected);
    assert.deepEqual(fs.readFileSync(path.join(p.source, "anchor", f.WATER)), expected);
    assert.deepEqual(f.snapshot(p.source), before);
    record(p.kind + "-backup-replay.json", { replay, inputDigest: f.hash(prior), outputDigest: f.hash(expected),
      exactReplayMatched: true, sourceUnchanged: true, externalProvenanceVerified: false, authority: false });
  }
});

test("archive receipt model binds one captured source and nonce parameter; repeated receipt still passes", opts, () => {
  // Small real closed history lets --test-name-pattern target this repair
  // without invoking either 1098-sequence producer. Full runs also cover both
  // actual compacted producers through the same receipt verifier below.
  const small = require("./fixtures/permit-legacy-sqlite-rehearsal").createLegacy();
  small.close();
  const source = small.root, input = f.sourceEvidence(source), before = f.snapshot(source), bytes = f.fileBytes(source);
  const completeBytes = fs.readFileSync(path.join(source, "anchor", f.WATER));
  const witness = f.fixtureWitness(), nonceParameter = "fixture-nonce-parameter-only";
  const payload = f.backupPayload(source, input, completeBytes, nonceParameter), receipt = witness.sign(payload);
  const args = { source, input, completeBytes, receipt, publicKey: witness.publicKey, nonceParameter,
    expectedReceiptHead: f.hash(JSON.stringify(receipt)) };
  const accepted = f.reviewBackup(args);
  assert.equal(accepted.executionAuthorized, false); assert.equal(accepted.authority, false);
  assert.equal(accepted.nonceParameterBound, true); assert.equal(accepted.receiptHeadParameterBound, true);
  assert.equal(accepted.freshnessProven, false); assert.equal(accepted.singleUseProven, false);
  // Counterexample: same receipt/nonce/head succeeds again, with no Set or
  // local state pretending to provide an independent durable atomic consumer.
  assert.deepEqual(f.reviewBackup(args), accepted);
  assert.equal(JSON.parse(accepted.target.body).schema_version, 2);
  const reject = (change, code = "HIGHWATER_RECEIPT_BINDING") => assert.throws(() => f.reviewBackup({ ...args, ...change }), { code });
  const signed = (payload, change = {}) => {
    const receipt = witness.sign(payload);
    return { ...change, receipt, expectedReceiptHead: f.hash(JSON.stringify(receipt)) };
  };
  reject({ publicKey: f.fixtureWitness().publicKey }, "HIGHWATER_RECEIPT_SIGNATURE");
  reject({ receipt: { payload: { ...payload, sequence: payload.sequence - 1 }, signature: receipt.signature } }, "HIGHWATER_RECEIPT_SIGNATURE");
  reject({ expectedReceiptHead: "0".repeat(64) }); reject({ nonceParameter: "different-parameter" });
  const bad = Buffer.from(completeBytes.toString().split("\n").slice(1).join("\n"));
  reject({ completeBytes: bad });
  // Signing helper must refuse inconsistency BEFORE producing a payload.
  const mismatched = { ...input, expected: { ...input.expected, store_id: "other-store" } };
  assert.throws(() => f.backupPayload(source, mismatched, completeBytes, nonceParameter), { code: "HIGHWATER_SOURCE_EVIDENCE" });
  assert.throws(() => f.backupPayload(source, input, bad, nonceParameter), { code: "HIGHWATER_ARCHIVE_PREFIX" });
  // Bypass that helper using the test-held signer: a VALID signature over an
  // inconsistent evidence/manifest/archive pair must still fail on review.
  reject(signed({ ...payload, storeId: "other-store", evidenceDigest: f.hash(JSON.stringify(mismatched)) }, { input: mismatched }), "HIGHWATER_SOURCE_EVIDENCE");
  // Stronger counterexample: BOTH stores' evidence is independently valid.
  // A signer can bind source A's manifest to B's coherent evidence/archive;
  // signature and core validation alone used to accept this mixed source.
  const other = require("./fixtures/permit-legacy-sqlite-rehearsal").createLegacy(); other.close();
  const otherInput = f.sourceEvidence(other.root), otherBytes = fs.readFileSync(path.join(other.root, "anchor", f.WATER));
  assert.equal(core.prepareLegacyPermitMigration(JSON.stringify({ ...otherInput, high_water: f.lines(otherBytes) })).executionAuthorized, false);
  const mixed = { ...f.backupPayload(other.root, otherInput, otherBytes, nonceParameter), sourceManifestDigest: payload.sourceManifestDigest };
  assert.throws(() => f.backupPayload(source, otherInput, otherBytes, nonceParameter), { code: "HIGHWATER_SOURCE_EVIDENCE" });
  reject(signed(mixed, { input: otherInput, completeBytes: otherBytes }), "HIGHWATER_SOURCE_EVIDENCE");
  reject(signed({ ...payload, sourceManifestDigest: "0".repeat(64) }));
  reject(signed({ ...payload, completeLogDigest: f.hash(bad) }, { completeBytes: bad }), "HIGHWATER_ARCHIVE_PREFIX");
  const manifest = f.sourceManifest(source), dbItem = manifest.find(e => e.name === "db/state.sqlite");
  for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "mtimeMs", "ctimeMs"]) assert.equal(typeof dbItem[key], "number");
  assert.equal(manifest[0].kind, "directory");
  // Copy with identical bytes still has different filesystem identity.
  const replaced = path.join(f.newRun(), "replacement"); fs.cpSync(source, replaced, { recursive: true });
  assert.deepEqual(f.fileBytes(replaced), bytes);
  reject({ source: replaced });
  // Same-path, identical-byte replacement must also invalidate the receipt.
  const replacementPayload = f.backupPayload(replaced, input, completeBytes, nonceParameter);
  const replacementReceipt = witness.sign(replacementPayload);
  const replacementArgs = { ...args, source: replaced, receipt: replacementReceipt,
    expectedReceiptHead: f.hash(JSON.stringify(replacementReceipt)) };
  const water = path.join(replaced, "anchor", f.WATER), oldInode = fs.statSync(water).ino;
  const swap = path.join(replaced, "anchor", "replacement-file"); f.save(swap, completeBytes); fs.renameSync(swap, water);
  assert.notEqual(fs.statSync(water).ino, oldInode);
  assert.deepEqual(f.fileBytes(replaced), bytes);
  assert.throws(() => f.reviewBackup(replacementArgs), { code: "HIGHWATER_RECEIPT_BINDING" });
  // Mode changes have the same content but different signed metadata.
  const modePayload = f.backupPayload(replaced, input, completeBytes, nonceParameter), modeReceipt = witness.sign(modePayload);
  fs.chmodSync(water, (fs.statSync(water).mode & 0o777) ^ 0o040);
  assert.throws(() => f.reviewBackup({ ...replacementArgs, receipt: modeReceipt,
    expectedReceiptHead: f.hash(JSON.stringify(modeReceipt)) }), { code: "HIGHWATER_RECEIPT_BINDING" });
  // Signed log parses to the same records; exact old-algorithm output differs.
  // This used to pass because only the parsed suffix was compared.
  const noncanonical = path.join(f.newRun(), "noncanonical-copy"); fs.cpSync(source, noncanonical, { recursive: true });
  const noncanonicalWater = path.join(noncanonical, "anchor", f.WATER);
  fs.appendFileSync(noncanonicalWater, "\n");
  assert.deepEqual(f.sourceEvidence(noncanonical), input);
  assert.throws(() => f.backupPayload(noncanonical, input, completeBytes, nonceParameter), { code: "HIGHWATER_REPLAY_BYTES" });
  const inconsistentPayload = { ...payload, sourceManifestDigest: f.hash(JSON.stringify(f.sourceManifest(noncanonical))) };
  reject(signed(inconsistentPayload, { source: noncanonical }), "HIGHWATER_REPLAY_BYTES");
  const compacted = [];
  for (const p of producers || []) {
    const input = evidence(p), complete = fs.readFileSync(path.join(p.run, "observed-complete-high-water.log"));
    const payload = f.backupPayload(p.source, input, complete, nonceParameter), receipt = witness.sign(payload);
    const result = f.reviewBackup({ ...args, source: p.source, input, completeBytes: complete, receipt,
      expectedReceiptHead: f.hash(JSON.stringify(receipt)) });
    assert.equal(result.executionAuthorized, false); assert.equal(result.freshnessProven, false);
    compacted.push(p.kind);
  }
  assert.deepEqual(f.fileBytes(source), bytes); assert.deepEqual(f.snapshot(source), before);
  record("receipt-mechanics.json", { accepted, receipt, publicKey: witness.publicKey.export({ type: "spki", format: "pem" }),
    testOnlyKey: true, externalIsolationVerified: false, realFenceVerified: false, authority: false,
    sameSourceCaptured: true, exactReplayCompared: true, metadataBound: true, compactedReceiptCoverage: compacted,
    repeatedReceiptPassed: true, freshnessProven: false, singleUseProven: false, atomicSnapshotProven: false,
    negativeCoverage: ["wrong-key", "modified-payload", "head-parameter-mismatch", "nonce-parameter-mismatch",
      "truncated-archive", "sign-time-inconsistent-evidence", "signed-inconsistent-evidence", "signed-valid-other-store-evidence", "signed-inconsistent-manifest",
      "signed-incomplete-archive", "identical-byte-source-replacement", "same-path-inode-replacement", "mode-change",
      "signed-parsed-equivalent-but-raw-replay-mismatch"] });
});
