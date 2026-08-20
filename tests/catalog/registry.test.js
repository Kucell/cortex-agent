"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadAllKinds,
  loadAllKindsAsync,
  findById,
  listKind,
  indexDigest,
  DEFAULT_UPSTREAM,
  KIND_LIST,
} = require("../../lib/catalog/registry");

// ─── loadAllKinds sync ───────────────────────────────────────────────────────

test("loadAllKinds: returns 4 kinds when no cache present", () => {
  const idx = loadAllKinds();
  assert.equal(idx.fetched_at.length > 0, true);
  assert.equal(idx.upstream, DEFAULT_UPSTREAM);
  for (const kind of KIND_LIST) {
    assert.ok(idx.kinds[kind], `${kind} should be present`);
    assert.ok(Array.isArray(idx.kinds[kind].entries));
    assert.ok(["starter", "cache", "upstream"].includes(idx.kinds[kind].source));
  }
});

test("loadAllKinds: starter indices include well-known entries per kind", () => {
  const idx = loadAllKinds();
  assert.ok(idx.kinds["design-system"].entries.some((e) => e.id === "linear-app" || e.id === "default"));
  assert.ok(idx.kinds.plugin.entries.some((e) => e.id === "od-figma-migration" || e.id === "od-claude-design-bridge"));
  assert.ok(idx.kinds.skill.entries.some((e) => e.id === "open-design-launch-checklist"));
  assert.ok(idx.kinds.template.entries.some((e) => e.id === "saas-landing"));
});

test("loadAllKinds: each entry carries its kind discriminator", () => {
  const idx = loadAllKinds();
  for (const kind of KIND_LIST) {
    for (const e of idx.kinds[kind].entries) {
      assert.equal(e.kind, kind, `entry in ${kind} should have kind=${kind}`);
    }
  }
});

test("loadAllKinds: respects injected upstream", () => {
  const idx = loadAllKinds({ upstream: "https://custom.example/repo" });
  assert.equal(idx.upstream, "https://custom.example/repo");
});

// ─── loadAllKindsAsync: design-system delegation ─────────────────────────────

test("loadAllKindsAsync: returns 4 kinds with starter fallback on upstream error", async () => {
  const idx = await loadAllKindsAsync({
    fetcher: () => Promise.reject(new Error("network down")),
  });
  for (const kind of KIND_LIST) {
    assert.ok(idx.kinds[kind].entries.length > 0, `${kind} should have entries`);
  }
  // design-system falls back to starter or cache
  assert.equal(idx.kinds["design-system"].source, "starter");
});

test("loadAllKindsAsync: design-system source=upstream on success", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const fakeFetcher = (url) => {
    // lib/design/registry.fetchCatalog hits GitHub /git/trees/main and
    // expects { tree: [{path: "design-systems/.../manifest.json"}, ...] }.
    if (url.includes("/git/trees/")) {
      return Promise.resolve({
        tree: [
          { path: "design-systems/linear-app/manifest.json" },
          { path: "design-systems/stripe/manifest.json" },
          { path: "design-systems/default/manifest.json" },
        ],
      });
    }
    return Promise.resolve({ tree: [] });
  };
  // Use a tmp dir for cachePath + forceRefresh to bypass the user's real
  // ~/.agent/cache/design-catalog-cache.json.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-registry-async-"));
  const tmpCache = path.join(tmpDir, "cache.json");
  try {
    const idx = await loadAllKindsAsync({
      fetcher: fakeFetcher,
      cachePath: tmpCache,
      forceRefresh: true,
    });
    assert.equal(idx.kinds["design-system"].source, "upstream");
    assert.equal(idx.kinds["design-system"].entries.length, 3);
    for (const e of idx.kinds["design-system"].entries) {
      assert.equal(e.kind, "design-system");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── findById ────────────────────────────────────────────────────────────────

test("findById: returns matches with kind discriminator", () => {
  const idx = loadAllKinds();
  const matches = findById(idx, "default");
  // `default` may exist in multiple kinds (starter lists)
  assert.ok(matches.length >= 1);
  for (const m of matches) {
    assert.ok(KIND_LIST.includes(m.kind));
    assert.equal(m.id, "default");
  }
});

test("findById: empty array for missing id", () => {
  const idx = loadAllKinds();
  assert.deepEqual(findById(idx, "nonexistent-id-xyz"), []);
});

test("findById: handles empty/null index gracefully", () => {
  assert.deepEqual(findById(null, "x"), []);
  assert.deepEqual(findById({}, "x"), []);
});

// ─── listKind ────────────────────────────────────────────────────────────────

test("listKind: returns slice of entries for kind", () => {
  const idx = loadAllKinds();
  const skills = listKind(idx, "skill");
  assert.ok(skills.length > 0);
  assert.ok(skills.every((e) => e.kind === "skill"));
});

test("listKind: throws for unknown kind", () => {
  const idx = loadAllKinds();
  assert.throws(() => listKind(idx, "unknown"), /unknown kind/);
});

test("listKind: returned array is a copy (mutating doesn't affect index)", () => {
  const idx = loadAllKinds();
  const skills = listKind(idx, "skill");
  const before = idx.kinds.skill.entries.length;
  skills.push({ id: "rogue", kind: "skill" });
  assert.equal(idx.kinds.skill.entries.length, before);
});

// ─── indexDigest ─────────────────────────────────────────────────────────────

test("indexDigest: stable across calls when content unchanged", () => {
  const idx = loadAllKinds();
  const d1 = indexDigest(idx);
  const d2 = indexDigest(idx);
  assert.equal(d1, d2);
});

test("indexDigest: changes when entries change", () => {
  const idx = loadAllKinds();
  const d1 = indexDigest(idx);
  idx.kinds.skill.entries.push({ id: "new-skill", kind: "skill" });
  const d2 = indexDigest(idx);
  assert.notEqual(d1, d2);
});

test("indexDigest: covers all 4 kinds", () => {
  const idx = loadAllKinds();
  const d = indexDigest(idx);
  for (const kind of KIND_LIST) {
    assert.match(d, new RegExp(`${kind}:`), `digest should contain ${kind}:`);
  }
});

test("indexDigest: empty for null/empty index", () => {
  assert.equal(indexDigest(null), "");
  assert.equal(indexDigest({}), "");
});

// ─── DEFAULT_UPSTREAM ────────────────────────────────────────────────────────

test("DEFAULT_UPSTREAM: points to nexu-io/open-design", () => {
  assert.match(DEFAULT_UPSTREAM, /nexu-io\/open-design/);
});