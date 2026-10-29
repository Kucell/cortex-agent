"use strict";

// ---------------------------------------------------------------------------
// Template layer installation — the language overlay must actually win.
//
// The template tree has three layers: `_shared` is the language-neutral
// base, `zh` and `en` are the language overlays. A project receives the
// overlay's copy of a file that exists in both layers.
//
// The installation used to copy the shared layer first and the overlay
// second, with "never overwrite an existing file" as the copy rule. That
// made the *first* writer win: the shared English copy landed first and the
// Chinese overlay was skipped as a duplicate. A Chinese project received
// English skill manifests — the overlay existed in the tree but had no
// effect on what was installed.
//
// These tests pin the two rules that must both hold:
//   1. the overlay wins over the shared base;
//   2. a file the project already has wins over both.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const { installTemplateLayers } = require(path.join(ROOT, "lib", "setup", "index.js"));
const {
  projectTemplateLayers,
  resolveTemplateLayers,
} = require(path.join(ROOT, "lib", "template-layers.js"));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function buildFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-layer-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(path.join(root, "_shared", ".agent", "skills", "demo", "SKILL.md"), "shared english\n");
  write(path.join(root, "zh", ".agent", "skills", "demo", "SKILL.md"), "zh 中文\n");
  write(path.join(root, "en", ".agent", "skills", "demo", "SKILL.md"), "en english\n");
  write(path.join(root, "_shared", ".agent", "skills", "shared-only", "SKILL.md"), "only in shared\n");
  return root;
}

test("the language overlay wins over the shared base", (t) => {
  const root = buildFixture(t);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-layer-dest-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  installTemplateLayers(projectTemplateLayers(root, "zh"), dest);

  assert.equal(
    fs.readFileSync(path.join(dest, "skills", "demo", "SKILL.md"), "utf8"),
    "zh 中文\n",
  );
});

test("the shared base fills in what the overlay does not carry", (t) => {
  const root = buildFixture(t);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-layer-dest-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  installTemplateLayers(projectTemplateLayers(root, "zh"), dest);

  assert.equal(
    fs.readFileSync(path.join(dest, "skills", "shared-only", "SKILL.md"), "utf8"),
    "only in shared\n",
  );
});

test("a file the project already has is never overwritten", (t) => {
  const root = buildFixture(t);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-layer-dest-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  write(path.join(dest, "skills", "demo", "SKILL.md"), "local edit\n");

  installTemplateLayers(projectTemplateLayers(root, "zh"), dest);

  assert.equal(
    fs.readFileSync(path.join(dest, "skills", "demo", "SKILL.md"), "utf8"),
    "local edit\n",
  );
});

test("installing twice is idempotent", (t) => {
  const root = buildFixture(t);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-layer-dest-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  installTemplateLayers(projectTemplateLayers(root, "zh"), dest);
  const second = installTemplateLayers(projectTemplateLayers(root, "zh"), dest);

  assert.deepEqual(second, [], "a second install adds nothing");
  assert.equal(
    fs.readFileSync(path.join(dest, "skills", "demo", "SKILL.md"), "utf8"),
    "zh 中文\n",
  );
});

test("the resolved source map points at the overlay, not the shared base", (t) => {
  const root = buildFixture(t);
  const resolved = resolveTemplateLayers(projectTemplateLayers(root, "zh"));

  assert.equal(
    resolved.get("skills/demo/SKILL.md"),
    path.join(root, "zh", ".agent", "skills", "demo", "SKILL.md"),
  );
  assert.equal(
    resolved.get("skills/shared-only/SKILL.md"),
    path.join(root, "_shared", ".agent", "skills", "shared-only", "SKILL.md"),
  );
});

const SKILLS_WITH_LANGUAGE_OVERLAYS = [
  "context-budget",
  "evolution-pipeline",
  "resource-ingest",
  "retrieval-trajectory",
  "uri-resolver",
];

test("the real template tree installs a Chinese project Chinese skill manifests", (t) => {
  // The end-to-end shape of the regression: a Chinese project must receive
  // the Chinese manifest of every skill that has one, not the English one
  // that sits in the shared base.
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-layer-real-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  installTemplateLayers(
    projectTemplateLayers(path.join(ROOT, "templates"), "zh"),
    dest,
  );

  for (const skill of SKILLS_WITH_LANGUAGE_OVERLAYS) {
    const installed = path.join(dest, "skills", skill, "SKILL.md");
    assert.ok(fs.existsSync(installed), skill + " manifest is installed");
    const zhSource = path.join(ROOT, "templates", "zh", ".agent", "skills", skill, "SKILL.md");
    assert.equal(
      fs.readFileSync(installed, "utf8"),
      fs.readFileSync(zhSource, "utf8"),
      skill + " manifest is the Chinese one",
    );
  }
});

test("the real template tree installs an English project the shared English manifests", (t) => {
  // These five skills carry their English master copy in the shared base and
  // no English overlay — the language layer only holds the genuinely
  // different Chinese text. An English project must still receive the
  // English manifest, through the shared fallback.
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-layer-real-"));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));

  installTemplateLayers(
    projectTemplateLayers(path.join(ROOT, "templates"), "en"),
    dest,
  );

  for (const skill of SKILLS_WITH_LANGUAGE_OVERLAYS) {
    const installed = path.join(dest, "skills", skill, "SKILL.md");
    assert.ok(fs.existsSync(installed), skill + " manifest is installed");
    const enSource = path.join(ROOT, "templates", "_shared", ".agent", "skills", skill, "SKILL.md");
    assert.equal(
      fs.readFileSync(installed, "utf8"),
      fs.readFileSync(enSource, "utf8"),
      skill + " manifest is the shared English one",
    );
  }
});
