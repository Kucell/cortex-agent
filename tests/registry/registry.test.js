"use strict";

// Coverage for lib/registry/index.js — platform registry data integrity.

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  PLATFORM_REGISTRY,
  DEFAULT_PLATFORMS,
  BASE_PATHS,
  PLATFORMS_STATE_FILE,
  LEGACY_CONFIG_FILES,
} = require("../../lib/registry/index.js");

describe("registry — top-level constants", () => {
  test("PLATFORM_REGISTRY is a non-empty object", () => {
    assert.equal(typeof PLATFORM_REGISTRY, "object");
    assert.ok(Object.keys(PLATFORM_REGISTRY).length >= 10);
  });

  test("DEFAULT_PLATFORMS is a non-empty subset of registry keys", () => {
    assert.ok(DEFAULT_PLATFORMS.length > 0);
    for (const key of DEFAULT_PLATFORMS) {
      assert.ok(Object.prototype.hasOwnProperty.call(PLATFORM_REGISTRY, key), key);
    }
  });

  test("BASE_PATHS contains the shared .agent and entry files", () => {
    assert.ok(BASE_PATHS.includes(".agent"));
    assert.ok(BASE_PATHS.includes("AGENTS.md"));
    // `.agent-runtime` shares the `.agent` track/untrack lifecycle.
    assert.ok(BASE_PATHS.includes(".agent-runtime"));
  });

  test("PLATFORMS_STATE_FILE lives under .agent", () => {
    assert.ok(PLATFORMS_STATE_FILE.startsWith(".agent/"));
  });

  test("LEGACY_CONFIG_FILES are all strings with a leading dot or known path", () => {
    assert.ok(LEGACY_CONFIG_FILES.length > 0);
    for (const f of LEGACY_CONFIG_FILES) {
      assert.equal(typeof f, "string");
      assert.ok(f.startsWith(".") || f === "CLAUDE.md", `unexpected legacy path: ${f}`);
    }
  });
});

describe("registry — per-platform shape", () => {
  test("every platform declares bilingual desc with non-empty zh and en", () => {
    for (const [key, p] of Object.entries(PLATFORM_REGISTRY)) {
      assert.equal(typeof p.name, "string", `${key}.name`);
      assert.ok(p.desc.zh && p.desc.zh.length > 0, `${key} zh desc empty`);
      assert.ok(p.desc.en && p.desc.en.length > 0, `${key} en desc empty`);
    }
  });

  test("file entries reference src under integrations and a dest", () => {
    for (const [key, p] of Object.entries(PLATFORM_REGISTRY)) {
      for (const f of p.files) {
        assert.ok(f.src && typeof f.src === "string", `${key} file src missing`);
        assert.ok(f.dest && typeof f.dest === "string", `${key} file dest missing`);
      }
    }
  });

  test("link entries have target and link relative to project root", () => {
    for (const [key, p] of Object.entries(PLATFORM_REGISTRY)) {
      for (const l of p.links) {
        assert.ok(l.target && l.target.startsWith("../.agent/"), `${key} link target should point into ../.agent/: ${l.target}`);
        assert.ok(l.link && typeof l.link === "string", `${key} link dest missing`);
      }
    }
  });

  test("cleanupPaths are never empty so remove can tidy up", () => {
    for (const [key, p] of Object.entries(PLATFORM_REGISTRY)) {
      assert.ok(Array.isArray(p.cleanupPaths) && p.cleanupPaths.length > 0, `${key}`);
    }
  });

  test("claude declares a postSetup hook", () => {
    assert.equal(PLATFORM_REGISTRY.claude.postSetup, "claude-settings");
  });

  test("pi declares merge:true for settings.json so user config is preserved", () => {
    const settings = PLATFORM_REGISTRY.pi.files.find((f) => f.dest === ".pi/settings.json");
    assert.ok(settings, "pi settings.json entry missing");
    assert.equal(settings.merge, true);
  });
});
