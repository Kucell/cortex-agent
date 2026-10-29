"use strict";

// ─── Template parity test (MS-006 / VC-006-01) ──────────────────────────────
//
// Verifies that MS-003..MS-005 work is consistently reflected across:
//   * canonical .agent/ scripts (the live state)
//   * templates/_shared/.agent (shared machine files)
//   * templates/en/.agent + templates/zh/.agent (localized docs)
//
// The Pi reference adapter is intentionally absent from the templates because
// it lives in the canonical lib/runtime-adapters/ tree and is loaded via
// require — no template copy is required.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CANONICAL_CONTEXT_BUDGET_SELECT = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "select.js");
const SHARED_MANAGEMENT_INDEX = path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", "index.js");
const SHARED_PROJECTION_REGISTRY = path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", "projection-registry.json");
const SHARED_SELECT = path.join(ROOT, "templates", "_shared", ".agent", "skills", "context-budget", "scripts", "select.js");
// The English SKILL.md is the shared base; the Chinese one overrides it in
// the zh layer. A language layer only overrides — it never removes the file
// from the base — so an English project receives the shared copy.
const EN_MGMT_SKILL = path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "SKILL.md");
const ZH_MGMT_SKILL = path.join(ROOT, "templates", "zh", ".agent", "skills", "management-api", "SKILL.md");
const SHARED_JSON_SCHEMA = path.join(ROOT, "templates", "_shared", ".agent", "scripts", "json-schema.js");
const LIVE_JSON_SCHEMA = path.join(ROOT, ".agent", "scripts", "json-schema.js");

// The schema validator ships to every project (it is how an upgraded project
// checks its own task records). The framework repository keeps its own copy
// of the same file: two copies of one rule drift apart silently, so they are
// compared here. A checkout of the framework repository alone has no live
// copy to compare against.
test("the json-schema validator is byte-identical between the live copy and the template", {
  skip: fs.existsSync(LIVE_JSON_SCHEMA) ? false : "the live .agent copy is not part of this checkout",
}, () => {
  assert.equal(
    fs.readFileSync(LIVE_JSON_SCHEMA, "utf8"),
    fs.readFileSync(SHARED_JSON_SCHEMA, "utf8"),
  );
});

// The template tree has three layers and a file lives in exactly one of them
// (see rules/template-layer-dedup.md). The selector is language-neutral, so
// it ships from _shared. The test resolves the copy each layer actually
// carries instead of assuming a particular placement.
function readSelectFromLayer(layer) {
  const candidates = [
    path.join(ROOT, "templates", layer, ".agent", "skills", "context-budget", "scripts", "select.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  return null;
}

test("context-budget selector is byte-identical between canonical and every layer that carries it", () => {
  const canonical = fs.readFileSync(CANONICAL_CONTEXT_BUDGET_SELECT, "utf8");
  let found = 0;
  for (const layer of ["_shared", "zh", "en"]) {
    const content = readSelectFromLayer(layer);
    if (content === null) continue;
    found += 1;
    assert.equal(canonical, content, `${layer} template drifts from canonical select.js`);
  }
  assert.ok(found > 0, "the selector must ship in at least one template layer");
});

test("shared management-api scripts expose the context-trajectories projection", () => {
  const index = fs.readFileSync(SHARED_MANAGEMENT_INDEX, "utf8");
  assert.ok(index.includes("queryContextTrajectories"), "queryContextTrajectories missing in shared management-api");
  assert.ok(index.includes('"context-trajectories"'), "context-trajectories handler missing");
  const registry = JSON.parse(fs.readFileSync(SHARED_PROJECTION_REGISTRY, "utf8"));
  const projections = Array.isArray(registry.projections) ? registry.projections : registry;
  const entry = projections.find((row) => row && row.name === "context-trajectories");
  assert.ok(entry, "context-trajectories missing from projection registry");
  assert.equal(entry.kind, "collection");
  assert.deepEqual(entry.filters, ["task", "run", "session", "host"]);
});

test("EN and ZH management-api SKILL.md document the context-trajectories focused query", () => {
  const en = fs.readFileSync(EN_MGMT_SKILL, "utf8");
  const zh = fs.readFileSync(ZH_MGMT_SKILL, "utf8");
  assert.ok(en.includes("context-trajectories"), "EN SKILL.md missing context-trajectories query");
  assert.ok(zh.includes("context-trajectories"), "ZH SKILL.md missing context-trajectories query");
});

test("localized templates stay available without requiring the Pi adapter at runtime", () => {
  // The Pi adapter is loaded only when a host actually requests it; templates
  // therefore must not import it. The selector is the only consumer of the
  // context-trajectory contract, and it loads via canonical require path.
  const enSelect = readSelectFromLayer("en") || readSelectFromLayer("_shared");
  const zhSelect = readSelectFromLayer("zh") || readSelectFromLayer("_shared");
  assert.ok(enSelect, "the selector must ship for English projects");
  assert.ok(zhSelect, "the selector must ship for Chinese projects");
  assert.ok(!enSelect.includes("pi-adapter"), "EN select.js should not import pi-adapter");
  assert.ok(!zhSelect.includes("pi-adapter"), "ZH select.js should not import pi-adapter");
  // The canonical lib path is reachable from both template locations.
  assert.ok(enSelect.includes("lib/runtime-adapters/context-trajectory"));
  assert.ok(zhSelect.includes("lib/runtime-adapters/context-trajectory"));
});

test("EN and ZH management-api SKILL.md maintain the same number of query examples after the MS-006 sync", () => {
  const en = fs.readFileSync(EN_MGMT_SKILL, "utf8");
  const zh = fs.readFileSync(ZH_MGMT_SKILL, "utf8");
  const enCount = (en.match(/^cortex-agent query /gm) || []).length;
  const zhCount = (zh.match(/^cortex-agent query /gm) || []).length;
  assert.equal(enCount, zhCount, `EN/ZH query example count mismatch: ${enCount} vs ${zhCount}`);
});

test("shared projection registry remains parseable and exposes the new collection", () => {
  const registry = JSON.parse(fs.readFileSync(SHARED_PROJECTION_REGISTRY, "utf8"));
  const projections = Array.isArray(registry.projections) ? registry.projections : registry;
  assert.ok(Array.isArray(projections));
  assert.ok(projections.length > 0);
  for (const row of projections) {
    if (row && typeof row === "object" && "name" in row) {
      assert.equal(typeof row.name, "string");
      assert.equal(typeof row.kind, "string");
    }
  }
});
