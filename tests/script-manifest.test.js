"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sm = require("../lib/script-manifest");

// ─── fixtures ───────────────────────────────────────────────────────────────

// Build a fake template dir containing a couple of L1 .js scripts (and some
// noise that must be ignored), plus an empty project cwd.
function makeEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sm-"));
  const templateDir = path.join(base, "template");
  const cwd = path.join(base, "project");

  const tplScripts = {
    "skills/architecture-guard/scripts/index.js": "module.exports = 1;\n",
    "artifacts/scripts/artifact-bus.js": "module.exports = 2;\n",
  };
  for (const [rel, body] of Object.entries(tplScripts)) {
    const abs = path.join(templateDir, ".agent", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  // Noise that must NOT be discovered.
  writeFile(path.join(templateDir, ".agent/skills/x/scripts/note.md"), "# doc\n");
  writeFile(path.join(templateDir, ".agent/skills/x/data.schema.json"), "{}\n");
  writeFile(path.join(templateDir, ".agent/skills/x/scripts/old.js.bak"), "stale\n");

  fs.mkdirSync(path.join(cwd, ".agent"), { recursive: true });
  return { base, templateDir, cwd, tplScripts };
}

function writeFile(abs, body) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function projFile(cwd, rel) {
  return path.join(cwd, ".agent", rel);
}

function copyTemplateInto(templateDir, cwd, rel) {
  const src = path.join(templateDir, ".agent", rel);
  const dst = projFile(cwd, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// ─── discovery ────────────────────────────────────────────────────────────────

test("discoverTemplateScripts returns only managed .js, sorted, posix relative", () => {
  const { templateDir } = makeEnv();
  const found = sm.discoverTemplateScripts(templateDir);
  assert.deepEqual(found, [
    "artifacts/scripts/artifact-bus.js",
    "skills/architecture-guard/scripts/index.js",
  ]);
});

test("discoverTemplateScripts returns [] when template missing", () => {
  assert.deepEqual(sm.discoverTemplateScripts("/no/such/dir"), []);
});

// ─── hashing ────────────────────────────────────────────────────────────────

test("hashFile is stable and content-sensitive", () => {
  const { base } = makeEnv();
  const a = path.join(base, "a.js");
  const b = path.join(base, "b.js");
  fs.writeFileSync(a, "same\n");
  fs.writeFileSync(b, "same\n");
  assert.equal(sm.hashFile(a), sm.hashFile(b));
  fs.writeFileSync(b, "different\n");
  assert.notEqual(sm.hashFile(a), sm.hashFile(b));
});

// ─── manifest read / write ────────────────────────────────────────────────────

test("readManifest returns null when missing or corrupt", () => {
  const { cwd } = makeEnv();
  assert.equal(sm.readManifest(cwd), null);
  fs.writeFileSync(sm.manifestPath(cwd), "{ not json");
  assert.equal(sm.readManifest(cwd), null);
  fs.writeFileSync(sm.manifestPath(cwd), JSON.stringify({ schema_version: 1 })); // no scripts
  assert.equal(sm.readManifest(cwd), null);
});

test("writeManifest then readManifest round-trips", () => {
  const { cwd } = makeEnv();
  sm.writeManifest(cwd, { schema_version: 1, scripts: { "a.js": { sha256: "x" } } });
  const m = sm.readManifest(cwd);
  assert.equal(m.scripts["a.js"].sha256, "x");
});

// ─── ensureManifestForInit ─────────────────────────────────────────────────────

test("ensureManifestForInit registers installed scripts with sha256 == origin_hash", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  for (const rel of Object.keys(tplScripts)) copyTemplateInto(templateDir, cwd, rel);

  const m = sm.ensureManifestForInit(cwd, templateDir, "en");
  for (const rel of Object.keys(tplScripts)) {
    const entry = m.scripts[rel];
    assert.ok(entry, `entry for ${rel}`);
    assert.equal(entry.sha256, entry.origin_hash);
    assert.equal(entry.source_template_lang, "en");
  }
});

test("ensureManifestForInit skips template scripts not installed in project", () => {
  const { templateDir, cwd } = makeEnv();
  copyTemplateInto(templateDir, cwd, "artifacts/scripts/artifact-bus.js"); // only one
  const m = sm.ensureManifestForInit(cwd, templateDir, "en");
  assert.ok(m.scripts["artifacts/scripts/artifact-bus.js"]);
  assert.ok(!m.scripts["skills/architecture-guard/scripts/index.js"]);
});

// ─── classify (decision table) ─────────────────────────────────────────────────

test("classify: missing file → update(missing)", () => {
  const { cwd } = makeEnv();
  const d = sm.classify({
    destAbs: projFile(cwd, "nope.js"),
    templateSha: "aaa",
    entry: undefined,
    manifestMissing: false,
    force: false,
  });
  assert.deepEqual(d, { action: "update", reason: "missing" });
});

test("classify: user==template → skip(in_sync)", () => {
  const { cwd } = makeEnv();
  const f = projFile(cwd, "x.js");
  writeFile(f, "content\n");
  const d = sm.classify({ destAbs: f, templateSha: sm.hashFile(f), entry: undefined, manifestMissing: false, force: false });
  assert.equal(d.reason, "in_sync");
});

test("classify: cold start (no manifest) & differs → skip(unmanaged_cold_start)", () => {
  const { cwd } = makeEnv();
  const f = projFile(cwd, "x.js");
  writeFile(f, "user\n");
  const d = sm.classify({ destAbs: f, templateSha: "different", entry: undefined, manifestMissing: true, force: false });
  assert.equal(d.reason, "unmanaged_cold_start");
});

test("classify: unmodified (user==origin) & template newer → update(stale_template)", () => {
  const { cwd } = makeEnv();
  const f = projFile(cwd, "x.js");
  writeFile(f, "installed\n");
  const userSha = sm.hashFile(f);
  const d = sm.classify({
    destAbs: f,
    templateSha: "newtemplatehash",
    entry: { origin_hash: userSha },
    manifestMissing: false,
    force: false,
  });
  assert.equal(d.reason, "stale_template");
});

test("classify: user modified → skip(user_modified)", () => {
  const { cwd } = makeEnv();
  const f = projFile(cwd, "x.js");
  writeFile(f, "user edited\n");
  const d = sm.classify({
    destAbs: f,
    templateSha: "newtemplatehash",
    entry: { origin_hash: "somethingelse" },
    manifestMissing: false,
    force: false,
  });
  assert.equal(d.reason, "user_modified");
});

test("classify: force overrides user_modified → update(forced)", () => {
  const { cwd } = makeEnv();
  const f = projFile(cwd, "x.js");
  writeFile(f, "user edited\n");
  const d = sm.classify({
    destAbs: f,
    templateSha: "newtemplatehash",
    entry: { origin_hash: "somethingelse" },
    manifestMissing: false,
    force: true,
  });
  assert.equal(d.reason, "forced");
});

// ─── reconcileScripts ──────────────────────────────────────────────────────────

test("reconcile cold start: existing differing files skipped, manifest bootstrapped", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  // Install user copies that differ from template.
  for (const rel of Object.keys(tplScripts)) writeFile(projFile(cwd, rel), "user version\n");

  const report = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.equal(report.manifestMissing, true);
  assert.equal(report.applied.length, 0);
  assert.equal(report.skipped.length, 2);
  // Manifest now exists and records the user files.
  const m = sm.readManifest(cwd);
  assert.ok(m.scripts["artifacts/scripts/artifact-bus.js"]);
});

test("reconcile after cold start: unmodified file becomes updatable", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  const rel = "artifacts/scripts/artifact-bus.js";
  // User has an OLD version, registered by cold-start bookkeeping.
  writeFile(projFile(cwd, rel), "old body\n");
  writeFile(projFile(cwd, "skills/architecture-guard/scripts/index.js"), "old2\n");
  sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true }); // cold start registers

  // Now template ships a NEW version of that file.
  writeFile(path.join(templateDir, ".agent", rel), "NEW body\n");

  const dry = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: false });
  const upd = dry.updates.find((u) => u.path === rel);
  assert.ok(upd && upd.reason === "stale_template", "should be updatable");
});

test("reconcile apply updates a stale unmodified file and writes .bak", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  const rel = "artifacts/scripts/artifact-bus.js";
  for (const r of Object.keys(tplScripts)) copyTemplateInto(templateDir, cwd, r);
  sm.ensureManifestForInit(cwd, templateDir, "en"); // clean install baseline

  // Template ships a fix.
  writeFile(path.join(templateDir, ".agent", rel), "FIXED\n");

  const report = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(report.applied.includes(rel));
  assert.equal(fs.readFileSync(projFile(cwd, rel), "utf8"), "FIXED\n");
  assert.ok(fs.existsSync(projFile(cwd, rel) + ".bak"), ".bak created");
  // manifest origin_hash updated to new content.
  const m = sm.readManifest(cwd);
  assert.equal(m.scripts[rel].origin_hash, sm.hashFile(projFile(cwd, rel)));
});

test("reconcile is idempotent: second run applies nothing", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  for (const r of Object.keys(tplScripts)) copyTemplateInto(templateDir, cwd, r);
  sm.ensureManifestForInit(cwd, templateDir, "en");
  writeFile(path.join(templateDir, ".agent", "artifacts/scripts/artifact-bus.js"), "FIXED\n");

  sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  const second = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.equal(second.applied.length, 0);
});

test("reconcile repairs a stale manifest when project and template are identical", () => {
  const { templateDir, cwd } = makeEnv();
  const rel = "artifacts/scripts/artifact-bus.js";
  copyTemplateInto(templateDir, cwd, rel);
  sm.writeManifest(cwd, {
    schema_version: 1,
    scripts: { [rel]: { origin_hash: "stale-origin", sha256: "stale-origin" } },
  });

  const report = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(report.skipped.some((item) => item.path === rel && item.reason === "in_sync"));
  const manifest = sm.readManifest(cwd);
  assert.equal(manifest.scripts[rel].origin_hash, sm.hashFile(projFile(cwd, rel)));
  assert.equal(manifest.scripts[rel].source_template_sha256, manifest.scripts[rel].origin_hash);
});

test("reconcile does not overwrite user-modified file without force", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  const rel = "artifacts/scripts/artifact-bus.js";
  for (const r of Object.keys(tplScripts)) copyTemplateInto(templateDir, cwd, r);
  sm.ensureManifestForInit(cwd, templateDir, "en");

  // User edits the file, then template also ships a change.
  writeFile(projFile(cwd, rel), "USER LOCAL EDIT\n");
  writeFile(path.join(templateDir, ".agent", rel), "FIXED\n");

  const report = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(!report.applied.includes(rel));
  assert.ok(report.skipped.some((s) => s.path === rel && s.reason === "user_modified"));
  assert.equal(fs.readFileSync(projFile(cwd, rel), "utf8"), "USER LOCAL EDIT\n");
});

test("reconcile with force overwrites user-modified file", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  const rel = "artifacts/scripts/artifact-bus.js";
  for (const r of Object.keys(tplScripts)) copyTemplateInto(templateDir, cwd, r);
  sm.ensureManifestForInit(cwd, templateDir, "en");
  writeFile(projFile(cwd, rel), "USER LOCAL EDIT\n");
  writeFile(path.join(templateDir, ".agent", rel), "FIXED\n");

  const report = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true, force: true });
  assert.ok(report.applied.includes(rel));
  assert.equal(fs.readFileSync(projFile(cwd, rel), "utf8"), "FIXED\n");
});

test("reconcile adds a missing managed file (additive path)", () => {
  const { templateDir, cwd, tplScripts } = makeEnv();
  // Only install one; the other is missing.
  copyTemplateInto(templateDir, cwd, "artifacts/scripts/artifact-bus.js");
  sm.ensureManifestForInit(cwd, templateDir, "en");
  const missingRel = "skills/architecture-guard/scripts/index.js";

  const report = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(report.applied.includes(missingRel));
  assert.ok(fs.existsSync(projFile(cwd, missingRel)));
});
