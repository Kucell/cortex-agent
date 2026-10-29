"use strict";

// Contract for the version-carrier registry.
//
// The failure this guards against is concrete: a bump that rewrites
// package.json and leaves the lockfile, the Claude plugin manifest, the
// marketplace manifest and the changelog behind produces a tree that
// tests/release/release-version-consistency.test.js rejects — which is
// exactly what happened the first time local-publish-validate ran a bump.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const carriers = require(path.join(root, "lib/release/version-carriers"));
const { buildAnchor } = require(path.join(root, "lib/anchor/anchor.js"));
const { ALLOWED } = require(path.join(root, "scripts/release/verify-approved-release.cjs"));

function fixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "version-carriers-"));
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "cortex-agent", version: "1.0.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify(
      { name: "cortex-agent", version: "1.0.0", packages: { "": { version: "1.0.0", engines: { node: ">=20" } } } },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    path.join(dir, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "cortex-agent", version: "1.0.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(dir, ".claude-plugin/marketplace.json"),
    JSON.stringify(
      {
        name: "cortex-agent",
        metadata: { version: "1.0.0" },
        plugins: [{ name: "cortex-agent", version: "1.0.0" }, { name: "other-plugin", version: "9.9.9" }],
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-01-01\n");
  const anchorDir = path.join(dir, "docs", "cortex-agent");
  fs.mkdirSync(anchorDir, { recursive: true });
  fs.writeFileSync(
    path.join(anchorDir, "anchor.md"),
    buildAnchor({ projectDir: dir, version: "1.0.0" }).body,
  );
  return dir;
}

test("syncVersion stamps every carrier and reports exactly what moved", () => {
  const dir = fixtureRoot();
  const result = carriers.syncVersion(dir, "2.0.0");

  assert.equal(result.missing.length, 0);
  assert.deepEqual(
    [...result.changed].sort(),
    [
      ".claude-plugin/marketplace.json",
      ".claude-plugin/plugin.json",
      "docs/cortex-agent/anchor.md",
      "package-lock.json",
      "package.json",
    ].sort(),
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin/plugin.json"), "utf8"));
  const market = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin/marketplace.json"), "utf8"));

  assert.equal(pkg.version, "2.0.0");
  assert.equal(lock.version, "2.0.0");
  assert.equal(lock.packages[""].version, "2.0.0");
  assert.equal(plugin.version, "2.0.0");
  assert.equal(market.metadata.version, "2.0.0");
  assert.equal(market.plugins.find((p) => p.name === "cortex-agent").version, "2.0.0");
  // A plugin entry that is not this package must not be rewritten.
  assert.equal(market.plugins.find((p) => p.name === "other-plugin").version, "9.9.9");
  // The anchor is re-rendered from the template, not patched in place.
  const anchor = fs.readFileSync(path.join(dir, "docs/cortex-agent/anchor.md"), "utf8");
  assert.equal(anchor, buildAnchor({ projectDir: dir, version: "2.0.0" }).body);
});

test("syncVersion is idempotent — a second run changes nothing", () => {
  const dir = fixtureRoot();
  carriers.syncVersion(dir, "2.0.0");
  const second = carriers.syncVersion(dir, "2.0.0");
  assert.deepEqual(second.changed, []);
});

test("syncVersion reports a missing carrier instead of failing", () => {
  const dir = fixtureRoot();
  fs.rmSync(path.join(dir, "package-lock.json"));
  const result = carriers.syncVersion(dir, "2.0.0");
  assert.deepEqual(result.missing, ["package-lock.json"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "2.0.0");
});

test("ensureChangelogEntry inserts the section above the newest released version", () => {
  const dir = fixtureRoot();
  const result = carriers.ensureChangelogEntry(dir, "2.0.0", "> placeholder");
  assert.equal(result.created, true);

  const text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.ok(text.includes("## [2.0.0]"));
  assert.ok(text.indexOf("## [2.0.0]") < text.indexOf("## [0.9.0]"));
  assert.ok(text.indexOf("## [Unreleased]") < text.indexOf("## [2.0.0]"));
  assert.ok(text.includes("> placeholder"));
});

test("ensureChangelogEntry does not rewrite an existing section", () => {
  const dir = fixtureRoot();
  carriers.ensureChangelogEntry(dir, "2.0.0", "> placeholder");
  const before = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  const again = carriers.ensureChangelogEntry(dir, "2.0.0", "> another placeholder");

  assert.equal(again.created, false);
  assert.equal(again.reason, "already_present");
  assert.equal(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), before);
});

test("the release gate allowlist covers every carrier and nothing arbitrary", () => {
  for (const file of carriers.carrierFiles()) {
    assert.ok(ALLOWED.has(file), `release allowlist must permit the carrier ${file}`);
  }
  assert.ok(ALLOWED.has("CHANGELOG.md"));
  assert.ok(ALLOWED.has("tests/release/release-version-consistency.test.js"));
  assert.ok(!ALLOWED.has("lib/release/version-carriers.js"));
  assert.ok(!ALLOWED.has("templates/_shared/.agent/tasks/scripts/render-progress.js"));
});

// The live-tree assertion ("do the repository's carriers agree right now?")
// already lives in tests/release/release-version-consistency.test.js. It stays
// there on purpose: a gate must not be satisfied by the implementation it
// guards. This file only pins the registry's behaviour on fixtures.
