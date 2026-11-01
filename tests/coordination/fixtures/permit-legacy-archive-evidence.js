"use strict";

// Dedicated test adapter only. Production does not import this file, the
// legacy test engine, or the fixture-held receipt signer.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const legacy = require("./permit-legacy-highwater-compaction");
const rehearsal = require("./permit-legacy-sqlite-rehearsal");
const api = require("../../../lib/coordination/permit-legacy-archive-evidence");
const PROJECT = path.resolve(__dirname, "../../.."), ROOT = path.join(PROJECT, ".agent/runtime");
function run() { return fs.mkdtempSync(path.join(ROOT, "permit-legacy-archive-evidence-")); }
function installedAvailability() {
  // An explicitly absent installation is optional. An existing but incomplete
  // installation, wrong version or wrong source is a failure, never a fallback.
  let root = process.env.CORTEX_LEGACY_1157_ROOT;
  const explicitRoot = Boolean(root);
  if (!root) {
    const result = childProcess.spawnSync("volta", ["which", "cortex-agent"], { encoding: "utf8", timeout: 10000 });
    if (result.error) {
      if (result.error.code === "ENOENT") return { available: false, reason: "Volta not installed; no installed 1.15.7 path discoverable; frozen coverage is separate" };
      throw result.error; // Timeout/permissions are failures, not absence.
    }
    // Human stderr is not a typed absence result. Even "not installed" may be
    // embedded in a permissions/configuration failure. All nonzero exits fail.
    // Supported absence: OS ENOENT spawning Volta, or an explicitly supplied
    // root whose lstat is ENOENT. Unknown Volta releases/locales fail closed.
    if (result.status !== 0) throw Object.assign(Error("ARCHIVE_INSTALLED_DISCOVERY_FAILED"), { code: "ARCHIVE_INSTALLED_DISCOVERY_FAILED" });
    if (!result.stdout?.trim()) throw Object.assign(Error("ARCHIVE_INSTALLED_DISCOVERY_FAILED"), { code: "ARCHIVE_INSTALLED_DISCOVERY_FAILED" });
    // Success promises an executable exists. Missing/dangling paths are broken
    // discovery, not optional absence. Preserve the filesystem failure.
    root = path.dirname(path.dirname(fs.realpathSync(result.stdout.trim())));
  }
  if (root) {
    try { fs.lstatSync(path.resolve(root)); }
    catch (error) {
      if (explicitRoot && error.code === "ENOENT") return { available: false, reason: "Installed 1.15.7 path does not exist; frozen coverage is separate" };
      throw error;
    }
  }
  const prior = process.env.CORTEX_LEGACY_1157_ROOT;
  process.env.CORTEX_LEGACY_1157_ROOT = root;
  try { legacy.installed(); return { available: true }; }
  catch (error) {
    // A 1.15.7 installation whose sources were rebuilt on top of the release
    // is not the unchanged legacy producer. It is unavailable evidence, not
    // a corrupted installation: the frozen producer still covers the case.
    if (error.code === "HIGHWATER_INSTALLED_NOT_LEGACY") {
      return { available: false, reason: "Installed 1.15.7 is not the unchanged legacy build; frozen coverage is separate" };
    }
    throw error;
  }
  finally { if (prior === undefined) delete process.env.CORTEX_LEGACY_1157_ROOT; else process.env.CORTEX_LEGACY_1157_ROOT = prior; }
}
function capture(source, archive) {
  // ONE captured file byte set supplies DB, journal, audit and actual water.
  // The surrounding observations are replacement detection, not a real fence.
  const before = legacy.snapshot(source), captured = legacy.fileBytes(source);
  assert.deepEqual(legacy.snapshot(source), before);
  assert.deepEqual(Object.keys(captured).filter(n => !n.startsWith("anchor/") && !n.startsWith("db/")), ["fixture.json"]);
  const files = Object.entries(captured).filter(([name]) => name !== "fixture.json")
    .map(([name, bytes]) => ({ path: name, bytes_base64: bytes.toString("base64") }));
  return { format_version: 1, snapshot_id: "fixture-capture-no-provenance",
    producer_store_sha256: rehearsal.manifest.legacy.store_sha256, producer_anchor_sha256: api.ANCHOR_SOURCE_SHA256,
    files, archive_high_water_base64: archive.toString("base64") };
}
function small() {
  const old = rehearsal.createLegacy(); old.close();
  const archive = fs.readFileSync(path.join(old.root, "anchor", legacy.WATER));
  return { source: old.root, snapshot: capture(old.root, archive), archive };
}
function file(snapshot, name) { return snapshot.files.find(f => f.path === name); }
function changeFile(snapshot, name, bytes) { file(snapshot, name).bytes_base64 = Buffer.from(bytes).toString("base64"); }
function readFile(snapshot, name) { return Buffer.from(file(snapshot, name).bytes_base64, "base64"); }
function invalidBodyUtf8(snapshot, invalid = true) {
  const { DatabaseSync } = require("node:sqlite"), dir = run(), dbFile = path.join(dir, "invalid-body.sqlite");
  const s = JSON.parse(JSON.stringify(snapshot));
  fs.writeFileSync(dbFile, readFile(s, "db/state.sqlite"));
  const db = new DatabaseSync(dbFile);
  try {
    const state = JSON.parse(db.prepare("SELECT body FROM protected_state").get().body);
    state.decision_id = "D-\ufffd-invalid-byte";
    const decoded = JSON.stringify(state), valid = Buffer.from(decoded), offset = valid.indexOf(Buffer.from("\ufffd"));
    const raw = invalid ? Buffer.concat([valid.subarray(0, offset), Buffer.from([255]), valid.subarray(offset + 3)]) : valid;
    if (invalid) assert.notDeepEqual(Buffer.from(raw.toString("utf8")), raw);
    assert.equal(raw.toString("utf8"), decoded);
    const digest = legacy.hash(decoded), sequence = state.anchor_sequence;
    db.prepare("UPDATE protected_state SET body=CAST(? AS TEXT),sha256=?").run(raw, digest);
    const row = db.prepare("SELECT body,CAST(body AS BLOB) AS raw FROM protected_state").get();
    assert.equal(row.body, decoded); assert.deepEqual(Buffer.from(row.raw), raw);
    // Give the buggy reader a completely coherent decoded-body history, so
    // rejection cannot be attributed to an unrelated digest/identity mismatch.
    for (const item of s.files.filter(v => v.path.includes("protected-anchor-entry-"))) {
      const entry = JSON.parse(Buffer.from(item.bytes_base64, "base64"));
      if (entry.sequence !== sequence) continue;
      entry.body_digest = digest;
      entry.entry_digest = legacy.hash([entry.schema_version, entry.type, entry.sequence, entry.body_digest, entry.store_id, entry.attempt].join("\n"));
      const bytes = Buffer.from(JSON.stringify(entry) + "\n");
      item.bytes_base64 = bytes.toString("base64");
      item.path = item.path.replace(/-[a-f0-9]{16}\.json$/, "-" + legacy.hash(bytes).slice(0, 16) + ".json");
    }
    for (const name of ["anchor/" + legacy.WATER, "anchor/protected-anchor-audit.log"]) {
      const entries = legacy.lines(readFile(s, name));
      for (const entry of entries) if (entry.sequence === sequence) {
        entry.body_digest = digest;
        if (name.endsWith(legacy.WATER)) entry.record_digest = legacy.hash([entry.sequence, digest, entry.store_id, entry.attempt].join("\n"));
      }
      changeFile(s, name, entries.map(e => JSON.stringify(e) + "\n").join(""));
    }
    s.archive_high_water_base64 = file(s, "anchor/" + legacy.WATER).bytes_base64;
  } finally { db.close(); }
  changeFile(s, "db/state.sqlite", fs.readFileSync(dbFile));
  return s;
}
function save(dir, name, data) { fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 }); }
module.exports = { PROJECT, ROOT, api, legacy, rehearsal, run, installedAvailability, capture, small, file, changeFile, readFile, invalidBodyUtf8, save };

if (require.main === module) {
  const [kind, dir] = process.argv.slice(2), relative = path.relative(ROOT, path.resolve(dir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || fs.readdirSync(dir).length) throw Error("FIXTURE_RUNTIME_PATH");
  process.stdout.write(JSON.stringify(legacy.create(kind, dir)) + "\n");
}
