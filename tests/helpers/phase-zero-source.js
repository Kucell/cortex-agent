"use strict";

// Local suite materialization verifies the staged candidate, not a release HEAD.
// The dedicated workflow retains its separate clean exact-HEAD proof.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const MANIFEST = "tests/dispatch/phase-zero-source-manifest.json";
const TEST = "tests/dispatch/phase-zero-bin-boundary.test.js";
const blobHash = (bytes) => crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");

function candidateProof(checkout) {
  checkout = fs.realpathSync(checkout);
  const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", "-C", checkout, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const sourceHead = git("rev-parse", "HEAD").trim();
  assert.match(sourceHead, /^[0-9a-f]{40}$/);
  const inventory = git("ls-files", "--stage", "-z");
  const entries = new Map();
  for (const record of inventory.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, blob, stage] = record.slice(0, tab).split(" ");
    assert.equal(stage, "0", "unresolved index entry");
    assert.equal(entries.has(record.slice(tab + 1)), false, "duplicate index entry");
    entries.set(record.slice(tab + 1), { mode, type: "blob", blob });
  }
  assert.equal(entries.get(".agent")?.mode, "160000", "governance gitlink required");
  function bytesFor(relative) {
    assert.ok(relative && !path.isAbsolute(relative) && !relative.split("/").some((x) => ["..", ".", ""].includes(x)));
    assert.ok(!relative.startsWith(".agent/") && !relative.split("/").includes("node_modules"));
    const entry = entries.get(relative);
    assert.ok(entry && ["100644", "100755"].includes(entry.mode), "not a regular indexed source: " + relative);
    let file = checkout;
    for (const part of relative.split("/")) {
      file = path.join(file, part);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false, "symlink source: " + relative);
    }
    assert.ok(fs.lstatSync(file).isFile());
    const bytes = fs.readFileSync(file);
    assert.equal(blobHash(bytes), entry.blob, "unstaged source: " + relative);
    return { bytes, entry };
  }
  const manifest = JSON.parse(bytesFor(MANIFEST).bytes);
  assert.equal(manifest.sources.length, 260);
  assert.equal(new Set(manifest.sources).size, 260);
  for (const [file, pin] of Object.entries(manifest.protected_source_blobs)) {
    assert.equal(bytesFor(file).entry.blob, pin, "protected source changed: " + file);
  }
  const proof = { source_kind: "index-verified-working-tree", source_head: sourceHead,
    source_index_sha256: crypto.createHash("sha256").update(inventory).digest("hex"),
    source_manifest_blob: entries.get(MANIFEST).blob, test_blob: entries.get(TEST)?.blob, blobs: {} };
  bytesFor("tests/helpers/phase-zero-source.js");
  bytesFor(TEST);
  for (const relative of manifest.sources) proof.blobs[relative] = bytesFor(relative).entry;
  return proof;
}
module.exports = { candidateProof };
