"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { decoder } = require("../../lib/offline-migration/native/protocol");
const native = process.platform === "darwin" ? test : (name, fn) => test(name, { skip: "Darwin native source test; not signed distribution validation" }, fn);
let area, binary;
// Test the worker mechanism directly in a disposable fixture. Production must
// enter through authenticated launcher; this is not a signing-gate substitute.
test.before(() => {
  if (process.platform !== "darwin") return;
  area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migration-native-test-"))); binary = path.join(area, "worker");
  const build = spawnSync("/usr/bin/clang", ["-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-mmacosx-version-min=13.0", "-framework", "Foundation", path.resolve(__dirname, "../../scripts/native/inventory-worker.m"), "-o", binary], { encoding: "utf8", timeout: 30000 });
  assert.equal(build.status, 0, build.stderr);
});
test.after(() => { if (area) fs.rmSync(area, { recursive: true, force: true }); });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(area, "project-")); fs.mkdirSync(path.join(root, ".agent"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, agent: path.join(root, ".agent") };
}
function run(root, overrides = {}) {
  const request = { protocol: 1, operation: "inventory", root, limits: { entries: 20000, fileBytes: 8388608, totalBytes: 67108864 }, ...overrides };
  return spawnSync(binary, [], { input: JSON.stringify(request), timeout: 35000, maxBuffer: 96 * 1024 * 1024 });
}
function accepted(root) {
  const r = run(root); assert.equal(r.status, 0, String(r.stderr));
  const d = decoder(root); d.write(r.stdout); return d.finish();
}
native("native worker returns authentic bytes without changing source", t => {
  const { root, agent } = fixture(t), file = path.join(agent, "data"); fs.writeFileSync(file, Buffer.from([0, 255, 1, 42]));
  const before = fs.statSync(file); assert.deepEqual(accepted(root).content.get(".agent/data"), Buffer.from([0, 255, 1, 42]));
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
});
native("native empty directory and empty file are complete", t => {
  const { root, agent } = fixture(t); fs.writeFileSync(path.join(agent, "empty"), "");
  assert.equal(accepted(root).content.get(".agent/empty").length, 0);
});
native("native deterministic UTF16 ordering and chunk boundaries", t => {
  const { root, agent } = fixture(t), names = ["汉字", "a", "😀", "\ue000"];
  for (const n of names) fs.writeFileSync(path.join(agent, n), Buffer.alloc(70000, 7));
  const result = accepted(root); assert.deepEqual(result.entries.slice(1).map(e => e.path), names.sort().map(n => ".agent/" + n));
  assert.equal(result.content.get(".agent/a").length, 70000);
});
for (const kind of ["file", "directory", "parent", "hardlink"])
  native(`native rejects ${kind} alias`, t => {
    const { root, agent } = fixture(t), real = path.join(root, "real"); fs.writeFileSync(real, "secret");
    if (kind === "parent") { const alias = path.join(area, "alias-" + path.basename(root)); fs.symlinkSync(root, alias); t.after(() => fs.unlinkSync(alias)); assert.notEqual(run(alias).status, 0); return; }
    if (kind === "hardlink") fs.linkSync(real, path.join(agent, "link"));
    else fs.symlinkSync(kind === "file" ? real : root, path.join(agent, "link"));
    assert.notEqual(run(root).status, 0);
  });
native("native rejects per-file byte overflow", t => {
  const { root, agent } = fixture(t); fs.writeFileSync(path.join(agent, "large"), Buffer.alloc(8388609)); assert.notEqual(run(root).status, 0);
});
native("native rejects invalid request and caller-raised limits", t => {
  const { root } = fixture(t);
  for (const override of [{ protocol: 2 }, { operation: "apply" }, { extra: true }, { root: root + "/.." }, { limits: { entries: 999999 } }]) assert.notEqual(run(root, override).status, 0);
});
native("APFS rejects invalid UTF8 names before native traversal", t => {
  const { root, agent } = fixture(t);
  const bad = Buffer.concat([Buffer.from(agent + "/"), Buffer.from([255])]);
  try { fs.writeFileSync(bad, "x"); } catch (error) { assert.equal(error.code, "EILSEQ"); assert.equal(accepted(root).entries.length, 1); return; }
  assert.notEqual(run(root).status, 0);
});

native("native rejects duplicate decoded request keys and boolean protocol", t => {
  const { root } = fixture(t);
  const valid = JSON.stringify({ protocol: 1, operation: "inventory", root, limits: { entries: 20000, fileBytes: 8388608, totalBytes: 67108864 } });
  for (const input of [valid.replace('"protocol":1', '"protocol":true'), valid.replace('"protocol":1', '"protocol":2,"protocol":1'), valid.replace('"entries":20000', '"entries":3,"entr\\u0069es":20000'), valid.replace('"root":', '"root":"/nonexistent","root":'), valid.replace('"limits":', '"limits":{},"limits":')]) {
    const r = spawnSync(binary, [], { input, timeout: 5000 }); assert.notEqual(r.status, 0);
  }
});

native("native bounds discovered entries across nested pending directories", t => {
  const { root, agent } = fixture(t), child = path.join(agent, "000-child"); fs.mkdirSync(child);
  for (const dir of [agent, child]) for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(dir, "z" + i), "");
  const r = run(root); assert.notEqual(r.status, 0); assert.match(r.stderr.toString(), /MIGRATION_INVENTORY_LIMIT/);
  // Failure while discovering second directory, before walking queued files.
  assert.ok(r.stdout.length < 4096);
});
