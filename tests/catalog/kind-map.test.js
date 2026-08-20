"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const kindMap = require("../../lib/catalog/kind-map");
const {
  KINDS,
  KIND_LIST,
  getKind,
  hasKind,
  resolveInstallPath,
  resolveLicense,
  kindFromPath,
  getStarterIds,
  STARTER_IDS,
  requiredFiles,
  _internal,
} = kindMap;

// ─── Kinds registered ────────────────────────────────────────────────────────

test("KINDS: all 4 kinds registered", () => {
  assert.equal(KIND_LIST.length, 4);
  assert.ok(KINDS["design-system"]);
  assert.ok(KINDS.plugin);
  assert.ok(KINDS.skill);
  assert.ok(KINDS.template);
});

test("KINDS: each entry has required fields", () => {
  for (const kind of KIND_LIST) {
    const k = KINDS[kind];
    assert.ok(typeof k.kind === "string");
    assert.ok(typeof k.upstreamSubdir === "string");
    assert.ok(typeof k.installDir === "string");
    assert.ok(typeof k.manifestFilename === "string");
    assert.ok(Array.isArray(k.licenseSources) && k.licenseSources.length > 0);
    assert.ok(typeof k.licenseDefault === "string");
    assert.ok(typeof k.schemaVersion === "string");
    assert.ok(typeof k.lockfileKindKey === "string");
    assert.equal(k.kind, kind);
  }
});

test("KINDS: schemas follow od-<kind>-project/v1 convention", () => {
  assert.match(KINDS["design-system"].schemaVersion, /^od-design-system-project\/v\d+$/);
  assert.match(KINDS.plugin.schemaVersion, /^od-plugin-project\/v\d+$/);
  assert.match(KINDS.skill.schemaVersion, /^od-skill-project\/v\d+$/);
  assert.match(KINDS.template.schemaVersion, /^od-template-project\/v\d+$/);
});

// ─── getKind / hasKind ───────────────────────────────────────────────────────

test("getKind: returns the entry for valid kind", () => {
  assert.equal(getKind("plugin").kind, "plugin");
});

test("getKind: throws for unknown kind", () => {
  assert.throws(() => getKind("foobar"), /unknown kind "foobar"/);
});

test("hasKind: returns boolean", () => {
  assert.equal(hasKind("design-system"), true);
  assert.equal(hasKind("plugin"), true);
  assert.equal(hasKind("skill"), true);
  assert.equal(hasKind("template"), true);
  assert.equal(hasKind("foobar"), false);
});

// ─── resolveInstallPath ──────────────────────────────────────────────────────

test("resolveInstallPath: returns absolute path under cwd/installDir/id", () => {
  const p = resolveInstallPath("plugin", "od-figma-migration", "/tmp/proj");
  assert.equal(p, path.join("/tmp/proj", ".agent", "plugins", "od-figma-migration"));
});

test("resolveInstallPath: works for all 4 kinds", () => {
  for (const kind of KIND_LIST) {
    const p = resolveInstallPath(kind, "test-id", "/tmp/proj");
    assert.ok(p.startsWith("/tmp/proj/"));
    assert.ok(p.endsWith("/test-id"));
  }
});

test("resolveInstallPath: defaults cwd to process.cwd()", () => {
  const p = resolveInstallPath("skill", "open-design-launch-checklist");
  assert.ok(p.includes(".agent/skills/open-design-launch-checklist"));
});

test("resolveInstallPath: rejects id with path traversal", () => {
  assert.throws(() => resolveInstallPath("plugin", "../etc"), /invalid id/);
  assert.throws(() => resolveInstallPath("plugin", "a/b"), /invalid id/);
  assert.throws(() => resolveInstallPath("plugin", ""), /invalid id/);
});

// ─── resolveLicense ──────────────────────────────────────────────────────────

test("resolveLicense: returns first match from licenseSources", () => {
  const tree = {
    "open-design.json": { license: "Apache-2.0" },
    "SKILL.md": { frontmatter: { license: "MIT" } },
  };
  const r = resolveLicense("plugin", tree);
  assert.equal(r.value, "Apache-2.0");
  assert.equal(r.source, "open-design.json#/license");
});

test("resolveLicense: falls through to SKILL.md frontmatter for plugin", () => {
  const tree = {
    "open-design.json": { /* no license field */ },
    "SKILL.md": { frontmatter: { license: "MIT" } },
  };
  const r = resolveLicense("plugin", tree);
  assert.equal(r.value, "MIT");
  assert.equal(r.source, "SKILL.md#frontmatter/license");
});

test("resolveLicense: returns null when no match", () => {
  assert.equal(resolveLicense("skill", {}), null);
  assert.equal(resolveLicense("skill", { "SKILL.md": {} }), null);
});

test("resolveLicense: handles design-system's DESIGN.md frontmatter", () => {
  const tree = {
    "DESIGN.md": { frontmatter: { license: "Apache-2.0" } },
  };
  const r = resolveLicense("design-system", tree);
  assert.equal(r.value, "Apache-2.0");
});

test("resolveLicense: empty/null license fields are skipped", () => {
  const tree = {
    "open-design.json": { license: "" },
    "SKILL.md": { frontmatter: { license: "MIT" } },
  };
  const r = resolveLicense("plugin", tree);
  assert.equal(r.value, "MIT");
});

// ─── kindFromPath ────────────────────────────────────────────────────────────

test("kindFromPath: matches top-level upstream subdir", () => {
  assert.equal(kindFromPath("design-systems/linear-app/manifest.json"), "design-system");
  assert.equal(kindFromPath("plugins/od-figma-migration/open-design.json"), "plugin");
  assert.equal(kindFromPath("skills/open-design-launch-checklist/SKILL.md"), "skill");
  assert.equal(kindFromPath("design-templates/saas-landing/SKILL.md"), "template");
});

test("kindFromPath: returns null for unknown top-level", () => {
  assert.equal(kindFromPath("unknown/foo/bar"), null);
  assert.equal(kindFromPath(""), null);
});

// ─── STARTER_IDS ─────────────────────────────────────────────────────────────

test("STARTER_IDS: each kind has at least one starter id", () => {
  for (const kind of KIND_LIST) {
    const ids = STARTER_IDS[kind] || [];
    assert.ok(ids.length > 0, `${kind} should have starter ids`);
  }
});

test("getStarterIds: returns frozen array per kind", () => {
  const ids = getStarterIds("template");
  assert.ok(Array.isArray(ids));
  assert.ok(ids.includes("saas-landing"));
});

// ─── requiredFiles ───────────────────────────────────────────────────────────

test("requiredFiles: each kind has at least 1 required file", () => {
  for (const kind of KIND_LIST) {
    const files = requiredFiles(kind);
    assert.ok(files.length > 0);
    assert.equal(files[0], KINDS[kind].manifestFilename);
  }
});

// ─── Internal helpers ────────────────────────────────────────────────────────

test("_internal: readPointer walks nested JSON pointer", () => {
  const obj = { a: { b: { c: 42 } } };
  assert.equal(_internal.readPointer(obj, "/a/b/c"), 42);
  assert.equal(_internal.readPointer(obj, "/"), obj);
  assert.equal(_internal.readPointer(obj, "/a/missing"), undefined);
});