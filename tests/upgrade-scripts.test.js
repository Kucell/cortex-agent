"use strict";

// End-to-end coverage for `cortex-agent upgrade` L1 script reconciliation.
// Uses a synthetic template dir so tests are hermetic and fast.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sm = require("../lib/script-manifest");

// Simulate the CLI ctx shape and call reconcile the same way upgrade() does.
function makeTemplate() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-up-"));
  const templateDir = path.join(base, "template");
  const cwd = path.join(base, "project");
  const rel = "skills/knowledge-lint/scripts/index.js";
  writeFile(path.join(templateDir, ".agent", rel), "// template v1\n");
  fs.mkdirSync(path.join(cwd, ".agent"), { recursive: true });
  return { base, templateDir, cwd, rel };
}

function writeFile(abs, body) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function proj(cwd, rel) {
  return path.join(cwd, ".agent", rel);
}

test("init baseline then template fix flows to project on second upgrade", () => {
  const { templateDir, cwd, rel } = makeTemplate();

  // 1) init: copy template + register manifest baseline.
  writeFile(proj(cwd, rel), "// template v1\n");
  sm.ensureManifestForInit(cwd, templateDir, "en");

  // 2) template ships a fix.
  writeFile(path.join(templateDir, ".agent", rel), "// template v2 FIX\n");

  // 3) upgrade dry-run: candidate present, file untouched.
  const dry = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: false });
  assert.ok(dry.updates.some((u) => u.path === rel && u.reason === "stale_template"));
  assert.equal(fs.readFileSync(proj(cwd, rel), "utf8"), "// template v1\n");

  // 4) upgrade --update-scripts: fix applied.
  const applied = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(applied.applied.includes(rel));
  assert.equal(fs.readFileSync(proj(cwd, rel), "utf8"), "// template v2 FIX\n");
});

test("existing project cold start is conservative, second upgrade updates unmodified", () => {
  const { templateDir, cwd, rel } = makeTemplate();

  // Existing project with an OLD copy, no manifest (simulates pre-feature project).
  writeFile(proj(cwd, rel), "// old copy\n");

  // First upgrade (apply): cold start → skip, but manifest bootstrapped.
  const first = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(first.manifestMissing);
  assert.equal(first.applied.length, 0);
  assert.equal(fs.readFileSync(proj(cwd, rel), "utf8"), "// old copy\n");

  // Template ships a new version.
  writeFile(path.join(templateDir, ".agent", rel), "// template v2\n");

  // Second upgrade: file is unmodified since baseline → now updatable.
  const second = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(second.applied.includes(rel));
  assert.equal(fs.readFileSync(proj(cwd, rel), "utf8"), "// template v2\n");
});

test("user-modified file is protected across upgrades unless forced", () => {
  const { templateDir, cwd, rel } = makeTemplate();
  writeFile(proj(cwd, rel), "// template v1\n");
  sm.ensureManifestForInit(cwd, templateDir, "en");

  // User edits, template also advances.
  writeFile(proj(cwd, rel), "// USER PATCH\n");
  writeFile(path.join(templateDir, ".agent", rel), "// template v2\n");

  const guarded = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true });
  assert.ok(!guarded.applied.includes(rel));
  assert.equal(fs.readFileSync(proj(cwd, rel), "utf8"), "// USER PATCH\n");

  const forced = sm.reconcileScripts({ cwd, templateDir, lang: "en", apply: true, force: true });
  assert.ok(forced.applied.includes(rel));
  assert.equal(fs.readFileSync(proj(cwd, rel), "utf8"), "// template v2\n");
  assert.ok(fs.existsSync(proj(cwd, rel) + ".bak"), "backup preserved before force overwrite");
});
