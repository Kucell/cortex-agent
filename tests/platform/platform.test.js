"use strict";

// Coverage for lib/platform/index.js — platform state, install/remove, merge.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  getInstalledPlatforms,
  saveInstalledPlatforms,
  getAllGeneratedPaths,
  installPlatform,
  removePlatform,
} = require("../../lib/platform/index.js");

const { PLATFORM_REGISTRY, DEFAULT_PLATFORMS, PLATFORMS_STATE_FILE } = require("../../lib/registry/index.js");

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-platform-test-"));
}

describe("platform — installed state persistence", () => {
  test("saveInstalledPlatforms then getInstalledPlatforms round-trips", () => {
    const root = makeProject();
    saveInstalledPlatforms(root, ["cursor", "claude"]);
    assert.deepEqual(getInstalledPlatforms(root), ["cursor", "claude"]);
  });

  test("getInstalledPlatforms returns [] for a corrupt state file", () => {
    const root = makeProject();
    const stateFile = path.join(root, PLATFORMS_STATE_FILE);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{ not json");
    assert.deepEqual(getInstalledPlatforms(root), []);
  });

  test("getInstalledPlatforms coerces a non-array state file to []", () => {
    const root = makeProject();
    const stateFile = path.join(root, PLATFORMS_STATE_FILE);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ oops: true }));
    assert.deepEqual(getInstalledPlatforms(root), []);
  });

  test("falls back to detection by existing cleanup paths when no state file", () => {
    const root = makeProject();
    // Create a .cursorrules so cursor is detected.
    fs.writeFileSync(path.join(root, ".cursorrules"), "# rules");
    const installed = getInstalledPlatforms(root);
    assert.ok(installed.includes("cursor"));
  });
});

describe("platform — getAllGeneratedPaths", () => {
  test("returns base paths plus every registry cleanup path (deduped)", () => {
    const paths = getAllGeneratedPaths();
    assert.ok(paths.includes(".agent"));
    assert.ok(paths.includes("AGENTS.md"));
    assert.ok(paths.includes(".agent-runtime"));
    const set = new Set(paths);
    assert.equal(set.size, paths.length, "no duplicates");
    // cursor cleanup path present
    assert.ok(paths.includes(".cursor"));
  });
});

describe("platform — install/remove with a real templateDir", () => {
  function makeTemplate() {
    const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-template-"));
    const integrations = path.join(templateDir, "integrations");
    fs.mkdirSync(path.join(integrations, "cursor"), { recursive: true });
    fs.writeFileSync(path.join(integrations, "cursor", ".cursorrules"), "# cursor rules");
    return templateDir;
  }

  test("installPlatform copies files and creates symlinks", () => {
    const root = makeProject();
    const templateDir = makeTemplate();
    installPlatform({ cwd: root, lang: "en", templateDir }, "cursor");
    assert.ok(fs.existsSync(path.join(root, ".cursorrules")));
    assert.ok(fs.lstatSync(path.join(root, ".cursor", "commands")).isSymbolicLink());
  });

  test("installPlatform skips existing files (no overwrite)", () => {
    const root = makeProject();
    const templateDir = makeTemplate();
    fs.writeFileSync(path.join(root, ".cursorrules"), "# my custom rules");
    installPlatform({ cwd: root, lang: "en", templateDir }, "cursor");
    assert.equal(fs.readFileSync(path.join(root, ".cursorrules"), "utf8"), "# my custom rules");
  });

  test("installPlatform returns false for an unknown platform key", () => {
    const root = makeProject();
    assert.equal(installPlatform({ cwd: root, lang: "en", templateDir: makeTemplate() }, "nonexistent"), false);
  });

  test("removePlatform deletes files and symlinks", () => {
    const root = makeProject();
    const templateDir = makeTemplate();
    installPlatform({ cwd: root, lang: "en", templateDir }, "cursor");
    assert.ok(fs.existsSync(path.join(root, ".cursorrules")));
    removePlatform({ cwd: root, lang: "en" }, "cursor");
    assert.ok(!fs.existsSync(path.join(root, ".cursorrules")));
    assert.ok(!fs.existsSync(path.join(root, ".cursor")));
  });
});

describe("platform — qoderclicn integration", () => {
  // qoderclicn relies on the shared AGENTS.md entry plus symlinks only, so no
  // template files are required; templateDir can be any path here.
  const ctx = (root) => ({ cwd: root, lang: "zh", templateDir: root });

  test("registry entry uses AGENTS.md + commands/agents/skills symlinks", () => {
    const p = PLATFORM_REGISTRY.qoderclicn;
    assert.ok(p, "qoderclicn must be registered");
    assert.equal(p.files.length, 0, "no template files expected (AGENTS.md entry)");
    const links = p.links.map((l) => l.link).sort();
    assert.deepEqual(links, [".qoder/agents", ".qoder/commands", ".qoder/skills"]);
  });

  test("installPlatform creates the three .qoder symlinks", () => {
    const root = makeProject();
    installPlatform(ctx(root), "qoderclicn");
    for (const link of [".qoder/commands", ".qoder/agents", ".qoder/skills"]) {
      assert.ok(fs.lstatSync(path.join(root, link)).isSymbolicLink(), `${link} should be a symlink`);
    }
  });

  test("removePlatform removes the .qoder symlinks", () => {
    const root = makeProject();
    installPlatform(ctx(root), "qoderclicn");
    removePlatform({ cwd: root, lang: "zh" }, "qoderclicn");
    for (const name of ["commands", "agents", "skills"]) {
      assert.ok(!fs.existsSync(path.join(root, ".qoder", name)), `.qoder/${name} removed`);
    }
  });
});

describe("platform — registry data sanity", () => {
  test("DEFAULT_PLATFORMS all exist in the registry", () => {
    for (const key of DEFAULT_PLATFORMS) {
      assert.ok(PLATFORM_REGISTRY[key], `default platform ${key} missing from registry`);
    }
  });

  test("every registry entry declares name/desc/files/links/cleanupPaths", () => {
    for (const [key, p] of Object.entries(PLATFORM_REGISTRY)) {
      assert.ok(p.name, `${key} missing name`);
      assert.ok(p.desc && p.desc.en, `${key} missing English desc`);
      assert.ok(Array.isArray(p.files), `${key} files not array`);
      assert.ok(Array.isArray(p.links), `${key} links not array`);
      assert.ok(Array.isArray(p.cleanupPaths) && p.cleanupPaths.length > 0, `${key} cleanupPaths empty`);
    }
  });
});
