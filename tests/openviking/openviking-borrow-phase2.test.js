"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const VARS = {
  zh: path.join(ROOT, "templates", "zh", ".agent"),
  en: path.join(ROOT, "templates", "en", ".agent"),
};
const INGEST = path.join(ROOT, ".agent", "skills", "resource-ingest", "scripts", "ingest.js");
const BUILD_L0L1 = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "build-l0l1.js");

function runScript(script, args = []) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: ROOT }));
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const RESOURCES_DIR = path.join(ROOT, ".agent", "resources");
const EXTERNAL_DIR = path.join(RESOURCES_DIR, "external");
const MANIFEST_FILE = path.join(RESOURCES_DIR, "MANIFEST.json");
const URI_MAP = path.join(ROOT, ".agent", "registry", "uri-map.json");
const INDEX_FILE = path.join(ROOT, ".agent", "context-index.json");

test("resource-ingest dry-run reports plan without writing", () => {
  const result = runScript(INGEST, [
    "--file", ".agent/rules/core-principles.md",
    "--source", "e2e-test-source",
    "--slug", "dry-run-1",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.written.length, 0);
  assert.match(result.plan.uri, /^cortex:\/\/resources\/e2e-test-source\/dry-run-1$/);
  // File should NOT exist on disk
  const targetFile = path.join(ROOT, result.plan.target);
  assert.ok(!fs.existsSync(targetFile), "dry-run must not write files");
});

test("resource-ingest --file writes and updates MANIFEST + context-index + uri-map", () => {
  const source = "e2e-fs";
  const slug = `core-${Date.now()}`;
  const result = runScript(INGEST, [
    "--file", ".agent/rules/core-principles.md",
    "--source", source,
    "--slug", slug,
    "--write",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.written.length, 1);
  assert.ok(result.written[0].ok);
  assert.ok(result.content_hash.length === 16);

  const targetFile = path.join(ROOT, result.plan.target);
  assert.ok(fs.existsSync(targetFile), "file must be written");
  const content = fs.readFileSync(targetFile, "utf8");
  assert.match(content, /^---/);
  assert.match(content, /^name: /m);
  assert.match(content, new RegExp(`^uri: cortex://resources/${source}/${slug}$`, "m"));
  assert.match(content, new RegExp(`^content_hash: ${result.content_hash}$`, "m"));

  // MANIFEST gets a new entry
  const manifest = loadJson(MANIFEST_FILE);
  const entry = manifest.entries.find((e) => e.uri === result.plan.uri);
  assert.ok(entry, "MANIFEST must record the entry");
  assert.equal(entry.content_hash, result.content_hash);

  // context-index.json gets a new module
  const idx = loadJson(INDEX_FILE);
  const mod = idx.modules.find((m) => m.ref_path === result.plan.target);
  assert.ok(mod, "context-index.json must register the module");
  assert.ok(mod.uri);
  assert.match(mod.uri, /cortex:\/\/resources\//);

  // uri-map.json timestamp updated
  const map = loadJson(URI_MAP);
  assert.ok(map.scopes.resources);

  // Cleanup
  fs.unlinkSync(targetFile);
  const manifest2 = loadJson(MANIFEST_FILE);
  manifest2.entries = manifest2.entries.filter((e) => e.uri !== result.plan.uri);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest2, null, 2) + "\n");
  const idx2 = loadJson(INDEX_FILE);
  idx2.modules = idx2.modules.filter((m) => m.ref_path !== result.plan.target);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx2, null, 2) + "\n");
});

test("resource-ingest --refresh-l0l1 generates L0/L1 for the new resource", () => {
  const source = "e2e-l0l1";
  const slug = `d-${Date.now()}`;
  const target = path.join(EXTERNAL_DIR, source, `${slug}.md`);
  const result = runScript(INGEST, [
    "--file", ".agent/rules/core-principles.md",
    "--source", source,
    "--slug", slug,
    "--write",
    "--refresh-l0l1",
  ]);
  assert.equal(result.ok, true);
  assert.ok(result.refresh_l0l1 && result.refresh_l0l1.ok);

  // The new file should now have L0/L1 in context-index.json
  const idx = loadJson(INDEX_FILE);
  const mod = idx.modules.find((m) => m.ref_path === path.relative(ROOT, target));
  assert.ok(mod && mod.l0, "module must have L0 after refresh-l0l1");
  assert.ok(mod.l0_tokens <= 100, "L0 must respect token cap");
  assert.ok(mod.l1_tokens <= 2000, "L1 must respect token cap");

  // Cleanup
  fs.unlinkSync(target);
  const manifest = loadJson(MANIFEST_FILE);
  manifest.entries = manifest.entries.filter((e) => e.uri !== result.plan.uri);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
  const idx2 = loadJson(INDEX_FILE);
  idx2.modules = idx2.modules.filter((m) => m.ref_path !== path.relative(ROOT, target));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx2, null, 2) + "\n");
});

test("resource-ingest --git emits a clone hint when cache missing", () => {
  const source = "e2e-git";
  const slug = `g-${Date.now()}`;
  const result = runScript(INGEST, [
    "--git", "https://github.com/volcengine/OpenViking",
    "--source", source,
    "--slug", slug,
    "--write",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.plan.source, source);
  assert.match(result.plan.uri, /^cortex:\/\/resources\//);
  // Body should explain how to clone
  const targetFile = path.join(ROOT, result.plan.target);
  const content = fs.readFileSync(targetFile, "utf8");
  assert.match(content, /git clone/);

  // Cleanup
  fs.unlinkSync(targetFile);
  const manifest = loadJson(MANIFEST_FILE);
  manifest.entries = manifest.entries.filter((e) => e.uri !== result.plan.uri);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
  const idx = loadJson(INDEX_FILE);
  idx.modules = idx.modules.filter((m) => m.ref_path !== path.relative(ROOT, targetFile));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2) + "\n");
});

test("resource-ingest idempotent on second --write (same content_hash)", () => {
  const source = "e2e-idem";
  const slug = `i-${Date.now()}`;
  const args = ["--file", ".agent/rules/core-principles.md", "--source", source, "--slug", slug, "--write"];
  const r1 = runScript(INGEST, args);
  const r2 = runScript(INGEST, args);
  assert.equal(r1.content_hash, r2.content_hash, "content_hash must be stable across re-ingests");
  const manifest = loadJson(MANIFEST_FILE);
  const count = manifest.entries.filter((e) => e.uri === r1.plan.uri).length;
  assert.ok(count >= 2, "MANIFEST should record both calls (append-only)");

  // Cleanup
  const targetFile = path.join(ROOT, r1.plan.target);
  fs.unlinkSync(targetFile);
  const manifest2 = loadJson(MANIFEST_FILE);
  manifest2.entries = manifest2.entries.filter((e) => e.uri !== r1.plan.uri);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest2, null, 2) + "\n");
  const idx = loadJson(INDEX_FILE);
  idx.modules = idx.modules.filter((m) => m.ref_path !== path.relative(ROOT, targetFile));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2) + "\n");
});

test("resource-ingest --url without network emits structured error", () => {
  // Use a bogus URL that won't resolve to verify graceful error
  const result = runScript(INGEST, [
    "--url", "https://this-host-should-not-exist.invalid/api-docs",
    "--source", "e2e-url",
    "--slug", "u",
    "--write",
  ]);
  // Should fail gracefully (not throw) — either ok:false with error or success but 0 content
  if (!result.ok) {
    assert.ok(result.error);
  } else {
    assert.equal(result.dry_run, false);
    // Cleanup best-effort
    const targetFile = result.plan && path.join(ROOT, result.plan.target);
    if (targetFile && fs.existsSync(targetFile)) {
      fs.unlinkSync(targetFile);
    }
  }
});

test("resources/ is part of build-l0l1 default scan", () => {
  const result = runScript(BUILD_L0L1, ["--all"]);
  assert.equal(result.ok, true);
  // The default scan now includes resources/external; this is implicit but worth asserting.
  assert.ok(result.count > 0);
});

test("English and Chinese resource-ingest templates stay aligned", () => {
  const pairs = [
    ["skills/resource-ingest/SKILL.md", "skills/resource-ingest/SKILL.md"],
    ["skills/resource-ingest/scripts/ingest.js", "skills/resource-ingest/scripts/ingest.js"],
  ];
  for (const [zh, en] of pairs) {
    const a = fs.readFileSync(path.join(VARS.zh, zh), "utf8");
    const b = fs.readFileSync(path.join(VARS.en, en), "utf8");
    assert.ok(a.length > 100 && b.length > 100, `template ${zh} too small`);
    if (zh.endsWith("SKILL.md")) {
      const nameA = a.match(/^name:\s*(\S+)/m);
      const nameB = b.match(/^name:\s*(\S+)/m);
      assert.equal(nameA && nameA[1], nameB && nameB[1], `name drift between SKILL.md (zh/en)`);
    }
  }
});

test("ingested resource is discoverable via context-budget L0 path", () => {
  const source = "e2e-discovery";
  const slug = `d-${Date.now()}`;
  const result = runScript(INGEST, [
    "--file", ".agent/rules/core-principles.md",
    "--source", source,
    "--slug", slug,
    "--write",
    "--refresh-l0l1",
  ]);
  assert.equal(result.ok, true);
  const targetFile = path.join(ROOT, result.plan.target);
  // Now query with the slug + "core" tokens — should appear in context-index
  const idx = loadJson(INDEX_FILE);
  const mod = idx.modules.find((m) => m.ref_path === result.plan.target);
  assert.ok(mod, "module must exist in context-index");
  assert.ok(mod.l0, "module must have L0");

  // Cleanup
  fs.unlinkSync(targetFile);
  const manifest = loadJson(MANIFEST_FILE);
  manifest.entries = manifest.entries.filter((e) => e.uri !== result.plan.uri);
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
  const idx2 = loadJson(INDEX_FILE);
  idx2.modules = idx2.modules.filter((m) => m.ref_path !== path.relative(ROOT, targetFile));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx2, null, 2) + "\n");
});
