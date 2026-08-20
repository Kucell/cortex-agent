"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const resolve = require("../../lib/catalog/resolve");
const { KIND_LIST } = require("../../lib/catalog/kind-map");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-resolve-"));
}

function installFakeSystem(cwd, kind, id, files) {
  const root = path.join(cwd, getKindDir(kind), id);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(root, name), content, "utf8");
  }
  return root;
}

function getKindDir(kind) {
  return {
    "design-system": ".agent/design-systems",
    plugin: ".agent/plugins",
    skill: ".agent/skills",
    template: ".agent/templates",
  }[kind];
}

// ─── checkInstalled ──────────────────────────────────────────────────────────

test("checkInstalled: returns null for missing install", () => {
  const dir = makeTmp();
  try {
    assert.equal(resolve.checkInstalled("plugin", "od-x", dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkInstalled: returns install root for present install", () => {
  const dir = makeTmp();
  try {
    const root = installFakeSystem(dir, "plugin", "od-x", { "manifest.json": "{}" });
    assert.equal(resolve.checkInstalled("plugin", "od-x", dir), root);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkInstalled: works for all 4 kinds", () => {
  const dir = makeTmp();
  try {
    for (const kind of KIND_LIST) {
      const file = kind === "design-system" ? "DESIGN.md" : kind === "plugin" ? "manifest.json" : "SKILL.md";
      installFakeSystem(dir, kind, `test-${kind}`, { [file]: "# hello" });
      const root = resolve.checkInstalled(kind, `test-${kind}`, dir);
      assert.ok(root && root.includes(`test-${kind}`));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── readManifest ────────────────────────────────────────────────────────────

test("readManifest: returns null for missing install", () => {
  const dir = makeTmp();
  try {
    assert.equal(resolve.readManifest("skill", "missing", dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readManifest: parses JSON manifests", () => {
  const dir = makeTmp();
  try {
    installFakeSystem(dir, "plugin", "od-x", {
      "manifest.json": JSON.stringify({ name: "od-x", version: "1.0.0" }),
    });
    const m = resolve.readManifest("plugin", "od-x", dir);
    assert.deepEqual(m, { name: "od-x", version: "1.0.0" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readManifest: returns raw text for SKILL.md / DESIGN.md", () => {
  const dir = makeTmp();
  try {
    installFakeSystem(dir, "skill", "s1", { "SKILL.md": "---\nlicense: MIT\n---\n# skill body" });
    const m = resolve.readManifest("skill", "s1", dir);
    assert.match(m, /license: MIT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── listInstalled ───────────────────────────────────────────────────────────

test("listInstalled: empty array when nothing installed", () => {
  const dir = makeTmp();
  try {
    assert.deepEqual(resolve.listInstalled("plugin", dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listInstalled: enumerates top-level subdirs", () => {
  const dir = makeTmp();
  try {
    installFakeSystem(dir, "plugin", "od-x", { "manifest.json": "{}" });
    installFakeSystem(dir, "plugin", "od-y", { "manifest.json": "{}" });
    installFakeSystem(dir, "plugin", ".hidden", { "manifest.json": "{}" });
    const installed = resolve.listInstalled("plugin", dir);
    assert.equal(installed.length, 2);
    const ids = installed.map((e) => e.id);
    assert.ok(ids.includes("od-x"));
    assert.ok(ids.includes("od-y"));
    assert.equal(ids.includes(".hidden"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listAllInstalled: covers all 4 kinds", () => {
  const dir = makeTmp();
  try {
    installFakeSystem(dir, "plugin", "p1", { "manifest.json": "{}" });
    installFakeSystem(dir, "skill", "s1", { "SKILL.md": "x" });
    const all = resolve.listAllInstalled(dir);
    assert.equal(all.plugin.length, 1);
    assert.equal(all.skill.length, 1);
    assert.equal(all.template.length, 0);
    assert.equal(all["design-system"].length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── verifyInstall ───────────────────────────────────────────────────────────

test("verifyInstall: missing install reports all required files", () => {
  const dir = makeTmp();
  try {
    const v = resolve.verifyInstall("skill", "missing", dir);
    assert.equal(v.present, false);
    assert.equal(v.root, null);
    assert.ok(v.missing.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyInstall: present install with all files → present=true", () => {
  const dir = makeTmp();
  try {
    installFakeSystem(dir, "plugin", "od-x", { "manifest.json": "{}" });
    const v = resolve.verifyInstall("plugin", "od-x", dir);
    assert.equal(v.present, true);
    assert.deepEqual(v.missing, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyInstall: present install with missing required files", () => {
  const dir = makeTmp();
  try {
    installFakeSystem(dir, "skill", "s1", { "README.md": "no SKILL.md" });
    const v = resolve.verifyInstall("skill", "s1", dir);
    assert.equal(v.present, false);
    assert.ok(v.missing.includes("SKILL.md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── resolveEffective ────────────────────────────────────────────────────────

test("resolveEffective: design-system delegates to T-OD-001 4-level cascade", () => {
  const dir = makeTmp();
  try {
    const r = resolve.resolveEffective("design-system", "default", dir);
    assert.equal(r.kind, "design-system");
    assert.ok(Array.isArray(r.layers));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEffective: non-system kind returns installed source when present", () => {
  const dir = makeTmp();
  try {
    installFakeSystem(dir, "plugin", "od-x", { "manifest.json": "{}" });
    const r = resolve.resolveEffective("plugin", "od-x", dir);
    assert.equal(r.source, "installed");
    assert.equal(r.kind, "plugin");
    assert.equal(r.id, "od-x");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEffective: non-system kind returns missing source when absent", () => {
  const dir = makeTmp();
  try {
    const r = resolve.resolveEffective("template", "saas-landing", dir);
    assert.equal(r.source, "missing");
    assert.equal(r.kind, "template");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveEffective: throws for unknown kind", () => {
  assert.throws(
    () => resolve.resolveEffective("unknown", "x", "/tmp"),
    /unknown kind/,
  );
});