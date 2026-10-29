"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { candidateProof } = require("../helpers/phase-zero-source");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phase-proof-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); };
  git("init");
  const sources = Array.from({ length: 270 }, (_, i) => "source/f" + i + ".js");
  for (const file of sources) write(file, "// synthetic source\n");
  for (const file of ["tests/helpers/phase-zero-source.js", "tests/dispatch/phase-zero-bin-boundary.test.js"]) write(file, "// synthetic verifier\n");
  const pin = git("hash-object", sources[0]);
  const manifest = { sources, protected_source_blobs: { [sources[0]]: pin } };
  const save = () => write("tests/dispatch/phase-zero-source-manifest.json", JSON.stringify(manifest));
  save(); git("add", ".");
  git("update-index", "--add", "--cacheinfo", "160000," + "1".repeat(40) + ",.agent");
  git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "synthetic fixture");
  return { root, git, write, sources, manifest, save, pin };
}
test("candidate proof identifies index provenance and never labels it exact HEAD", (t) => {
  const f = fixture(t), proof = candidateProof(f.root);
  assert.equal(proof.source_kind, "index-verified-working-tree");
  assert.equal(proof.source_head, f.git("rev-parse", "HEAD"));
  assert.match(proof.source_index_sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(proof.blobs).length, 270);
});
for (const file of ["source/f1.js", "tests/helpers/phase-zero-source.js", "tests/dispatch/phase-zero-bin-boundary.test.js", "tests/dispatch/phase-zero-source-manifest.json"]) {
  test("rejects unstaged bytes: " + file, (t) => {
    const f = fixture(t); fs.appendFileSync(path.join(f.root, file), " ");
    assert.throws(() => candidateProof(f.root), /unstaged source/);
  });
}
test("rejects missing indexed source", (t) => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, f.sources[1]));
  assert.throws(() => candidateProof(f.root), /ENOENT/);
});
test("rejects symlink parent even when bytes still match", (t) => {
  const f = fixture(t); fs.renameSync(path.join(f.root, "source"), path.join(f.root, "actual"));
  fs.symlinkSync("actual", path.join(f.root, "source"));
  assert.throws(() => candidateProof(f.root), /symlink source/);
});
test("rejects staged protected-source drift", (t) => {
  const f = fixture(t); f.write(f.sources[0], "// changed\n"); f.git("add", f.sources[0]);
  assert.throws(() => candidateProof(f.root), /protected source changed/);
});
test("rejects nonregular index mode", (t) => {
  const f = fixture(t); f.git("update-index", "--cacheinfo", "120000," + f.pin + "," + f.sources[1]);
  assert.throws(() => candidateProof(f.root), /not a regular indexed source/);
});
test("rejects unresolved index stage", (t) => {
  const f = fixture(t); f.git("update-index", "--force-remove", f.sources[1]);
  execFileSync("git", ["-C", f.root, "update-index", "--index-info"], { input: "100644 " + f.pin + " 1\t" + f.sources[1] + "\n" });
  assert.throws(() => candidateProof(f.root), /unresolved index entry/);
});
