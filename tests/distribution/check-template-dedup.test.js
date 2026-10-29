"use strict";

// ---------------------------------------------------------------------------
// Template layer dedup gate — reverse verification.
//
// The template tree has three layers and `upgrade` lays them down shared
// first, language overlay second. A byte-identical copy in a language layer
// is pure duplication: it is maintained twice and drifts silently.
//
// So each case injects one duplication and asserts the check fires, plus the
// negative cases that keep it quiet on a legitimate language override and on
// a file that simply lives in one layer.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CHECK = path.join(ROOT, "scripts", "check-template-dedup.js");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function buildFixture(t, layers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-template-dedup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [layer, files] of Object.entries(layers || {})) {
    for (const [rel, content] of Object.entries(files || {})) {
      write(path.join(root, "templates", layer, ".agent", rel), content);
    }
  }
  return root;
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK, "--root", root], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

// ─── The duplication the gate must catch ──────────────────────────────────────

test("a file duplicated byte-for-byte across all three layers fails", (t) => {
  const root = buildFixture(t, {
    _shared: { "rules/demo.md": "same content\n" },
    zh: { "rules/demo.md": "same content\n" },
    en: { "rules/demo.md": "same content\n" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /duplicate in zh/);
  assert.match(result.stdout, /duplicate in en/);
  assert.match(result.stdout, /rules\/demo\.md/);
});

test("a file duplicated between the shared base and one language layer fails", (t) => {
  const root = buildFixture(t, {
    _shared: { "skills/demo/SKILL.md": "same content\n" },
    zh: { "skills/demo/SKILL.md": "same content\n" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /duplicate in zh/);
});

test("a file duplicated between the shared base and the English layer fails", (t) => {
  const root = buildFixture(t, {
    _shared: { "skills/demo/SKILL.md": "same content\n" },
    en: { "skills/demo/SKILL.md": "same content\n" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /duplicate in en/);
});

// ─── The legitimate arrangements the gate must accept ────────────────────────

test("a genuine language override passes when no layer is redundant", (t) => {
  // Both language layers say something different from the shared base — that
  // is exactly what a language layer is for, and neither copy is redundant.
  const root = buildFixture(t, {
    _shared: { "skills/demo/SKILL.md": "# Demo\n\nShared body.\n" },
    zh: { "skills/demo/SKILL.md": "# Demo\n\n共享正文。\n" },
    en: { "skills/demo/SKILL.md": "# Demo\n\nEnglish body.\n" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Every template file lives in exactly one layer/);
});

test("a language layer that repeats the shared base is reported", (t) => {
  // The Chinese layer is a genuine override, but the English layer repeats
  // the shared base byte for byte. It carries no information: the shared
  // layer already delivers those bytes, so the copy is maintained twice and
  // the copy that is forgotten is the one that drifts.
  //
  // The layers are compared pairwise against the shared base, so the
  // redundant one is named even when the third layer genuinely differs.
  const root = buildFixture(t, {
    _shared: { "skills/demo/SKILL.md": "# Demo\n\nShared body.\n" },
    zh: { "skills/demo/SKILL.md": "# Demo\n\n共享正文。\n" },
    en: { "skills/demo/SKILL.md": "# Demo\n\nShared body.\n" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /duplicate in en/);
  assert.match(result.stdout, /skills\/demo\/SKILL\.md/);
});

test("a file that lives only in the shared base passes", (t) => {
  const root = buildFixture(t, {
    _shared: { "schemas/demo.schema.json": "{}\n" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("a file that lives only in one language layer passes", (t) => {
  const root = buildFixture(t, {
    zh: { "rules/zh-only.md": "仅中文\n" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

test("OS noise is ignored rather than reported or sunk", (t) => {
  // A .DS_Store sitting in two layers is macOS noise. It must neither be
  // reported as a duplicate nor be treated as content to keep.
  const root = buildFixture(t, {
    _shared: { "rules/.DS_Store": "junk" },
    zh: { "rules/.DS_Store": "junk" },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
});

// ─── The gate against the real repository ────────────────────────────────────

test("the real repository has no duplicated template copies", () => {
  const result = runCheck(ROOT);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Every template file lives in exactly one layer/);
});

test("the real repository keeps genuine language overrides", () => {
  // The dedup gate must not have flattened the language layers into one.
  // If every layer were identical, the tree would no longer be bilingual.
  const result = runCheck(ROOT);
  assert.match(result.stdout, /_shared files:\s+\d+/);
  assert.match(result.stdout, /zh files:\s+\d+/);
  assert.match(result.stdout, /en files:\s+\d+/);

  const fs2 = require("node:fs");
  const zhRule = fs2.readFileSync(
    path.join(ROOT, "templates", "zh", ".agent", "rules", "portable-path-design.md"),
    "utf8"
  );
  const enRule = fs2.readFileSync(
    path.join(ROOT, "templates", "en", ".agent", "rules", "portable-path-design.md"),
    "utf8"
  );
  assert.notEqual(zhRule, enRule, "the zh and en rules must remain different languages");
  assert.match(zhRule, /可移植路径设计/);
  assert.match(enRule, /Portable Path Design/);
});
