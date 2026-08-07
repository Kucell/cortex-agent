"use strict";

// ─── lib/commands/patches.js unit tests ──────────────────────────────────────
//
// Coverage:
//   - writeVersionFile / readVersionFile round-trip
//   - applyPatches: no patch dir → no-op
//   - applyPatches: parses frontmatter, applies body after insert_after marker
//   - applyPatches: idempotent — re-running with same .applied-patches skips
//   - applyPatches: anchor-already-present → marks applied + skips
//   - applyPatches: target file missing → skips
//   - applyPatches: writes .applied-patches file

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyPatches,
  writeVersionFile,
  readVersionFile,
  APPLIED_FILE,
  PATCH_DIR_NAME,
} = require("../../lib/commands/patches");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-patches-test-"));
}

function setupTemplatePatchDir(root, patches) {
  const templateDir = path.join(root, "templates", "_lang");
  const patchDir = path.join(templateDir, ".agent", PATCH_DIR_NAME);
  fs.mkdirSync(patchDir, { recursive: true });
  for (const [name, content] of Object.entries(patches)) {
    fs.writeFileSync(path.join(patchDir, name), content);
  }
  return { templateDir, patchDir };
}

test("writeVersionFile / readVersionFile round-trip", () => {
  const root = mkRoot();
  writeVersionFile(root);
  const read = readVersionFile(root);
  // The version comes from package.json — just assert it's a non-empty semver-ish string.
  assert.match(read, /^\d+\.\d+\.\d+/);
});

test("writeVersionFile is best-effort (no crash on readonly / nonexistent)", () => {
  // Passing a path whose .agent/ can't be created (parent is a file, not a dir).
  const root = mkRoot();
  const blocker = path.join(root, ".agent");
  fs.writeFileSync(blocker, "not a directory");
  // Should not throw.
  writeVersionFile(root);
});

test("readVersionFile returns null when .cortex-version missing", () => {
  const root = mkRoot();
  assert.equal(readVersionFile(root), null);
});

test("applyPatches: no patch dir → early-return, no .applied-patches written", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const ctx = { cwd: root, templateDir: path.join(root, "templates", "_lang"), lang: "en" };
  // No patchDir exists — function early-returns, no .applied-patches written.
  applyPatches(ctx);
  const appliedPath = path.join(root, ".agent", APPLIED_FILE);
  assert.equal(fs.existsSync(appliedPath), false);
});

test("applyPatches: applies body after insert_after marker and writes .applied-patches", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const { templateDir } = setupTemplatePatchDir(root, {
    "001-test.patch.md": [
      "---",
      "id: TEST-PATCH-001",
      'target: rules/test.md',
      "anchor: ANCHOR-PATCH-001",
      "insert_after: line-A",
      "---",
      "INSERTED-BY-PATCH",
      "",
    ].join("\n"),
  });
  // Create the target file with the marker line.
  const rulesDir = path.join(root, ".agent", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "test.md"), "line-A\nline-B\n");

  const ctx = { cwd: root, templateDir, lang: "en" };
  applyPatches(ctx);

  const updated = fs.readFileSync(path.join(rulesDir, "test.md"), "utf8");
  assert.match(updated, /line-A/);
  assert.match(updated, /line-B/);
  assert.match(updated, /INSERTED-BY-PATCH/);
  // insert_after puts body right after the marker line, so the body sits
  // between line-A and line-B.
  const aIdx = updated.indexOf("line-A");
  const bIdx = updated.indexOf("line-B");
  const pIdx = updated.indexOf("INSERTED-BY-PATCH");
  assert.ok(aIdx < pIdx && pIdx < bIdx, "body must land between marker and next line");

  // .applied-patches records the id.
  const appliedRaw = fs.readFileSync(path.join(root, ".agent", APPLIED_FILE), "utf8");
  assert.match(appliedRaw, /TEST-PATCH-001/);
});

test("applyPatches: idempotent — second run is a no-op (skipped, no re-write)", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const { templateDir } = setupTemplatePatchDir(root, {
    "001-test.patch.md": [
      "---",
      "id: TEST-PATCH-002",
      "target: rules/test.md",
      "anchor: ANCHOR-002",
      "---",
      "BODY-002",
    ].join("\n"),
  });
  const rulesDir = path.join(root, ".agent", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  const target = path.join(rulesDir, "test.md");
  fs.writeFileSync(target, "existing-content\n");

  const ctx = { cwd: root, templateDir, lang: "en" };
  applyPatches(ctx);
  const after1 = fs.readFileSync(target, "utf8");
  assert.match(after1, /BODY-002/);

  // Manually re-introduce the original target content to detect a re-write.
  fs.writeFileSync(target, "clean\n");
  applyPatches(ctx);
  const after2 = fs.readFileSync(target, "utf8");
  assert.equal(after2, "clean\n", "second run must NOT re-apply (id is in .applied-patches)");
});

test("applyPatches: anchor-already-present → marks applied + skips", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const { templateDir } = setupTemplatePatchDir(root, {
    "001-test.patch.md": [
      "---",
      "id: TEST-PATCH-003",
      "target: rules/test.md",
      "anchor: ALREADY-PRESENT",
      "---",
      "BODY-SHOULD-NOT-APPEAR",
    ].join("\n"),
  });
  const rulesDir = path.join(root, ".agent", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(path.join(rulesDir, "test.md"), "ALREADY-PRESENT\n");

  const ctx = { cwd: root, templateDir, lang: "en" };
  applyPatches(ctx);

  const updated = fs.readFileSync(path.join(rulesDir, "test.md"), "utf8");
  assert.doesNotMatch(updated, /BODY-SHOULD-NOT-APPEAR/);
  const appliedRaw = fs.readFileSync(path.join(root, ".agent", APPLIED_FILE), "utf8");
  assert.match(appliedRaw, /TEST-PATCH-003/);
});

test("applyPatches: target file missing → skipped (id NOT recorded)", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const { templateDir } = setupTemplatePatchDir(root, {
    "001-test.patch.md": [
      "---",
      "id: TEST-PATCH-004",
      "target: rules/does-not-exist.md",
      "anchor: ANCHOR-004",
      "---",
      "BODY-004",
    ].join("\n"),
  });

  const ctx = { cwd: root, templateDir, lang: "en" };
  applyPatches(ctx);

  // Original original applyPatches (lib/commands.js) does NOT record the id
  // for missing targets. This test pins the current behavior; if the rule
  // ever changes, this test will fail and force an explicit review.
  const appliedPath = path.join(root, ".agent", APPLIED_FILE);
  if (fs.existsSync(appliedPath)) {
    const raw = fs.readFileSync(appliedPath, "utf8");
    assert.doesNotMatch(raw, /TEST-PATCH-004/);
  }
});

test("applyPatches: missing required frontmatter field → patch silently skipped", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const { templateDir } = setupTemplatePatchDir(root, {
    "001-bad.patch.md": [
      "---",
      "id: TEST-PATCH-005",
      // no target / no anchor
      "---",
      "BODY",
    ].join("\n"),
  });

  const ctx = { cwd: root, templateDir, lang: "en" };
  applyPatches(ctx);
  // No id recorded for invalid frontmatter — .applied-patches is just empty.
  const appliedPath = path.join(root, ".agent", APPLIED_FILE);
  assert.equal(fs.existsSync(appliedPath), true);
  assert.equal(fs.readFileSync(appliedPath, "utf8"), "\n");
});
