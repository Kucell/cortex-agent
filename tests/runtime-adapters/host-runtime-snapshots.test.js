"use strict";

// ─── Host Runtime Snapshots Tests (M-031 MS-001 / F-031-001) ──────────────────
//
// Coverage: lib/runtime-adapters/host-runtime-snapshots.js
//
// VC-031-001-04: host-runtime-snapshots exposes cursor, codey, and minimax
// rows with capabilities, limits, evidence, and received_at.
//
// Additional VC-031-001-05 contract: zero npm deps; no subprocess; pure
// read-only data shape.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  snapshotAll,
  snapshotFor,
  enumeratedHosts,
  hostOrder,
  registeredAdapters,
} = require("../../lib/runtime-adapters/host-runtime-snapshots");
const { reset, register } = require("../../lib/agents/adapters");

// ─── row shape contract ──────────────────────────────────────────────────────

test("snapshotFor returns cursor with capabilities, limits, evidence, received_at", () => {
  const row = snapshotFor("cursor");
  assert.equal(row.host, "cursor");
  assert.ok(Array.isArray(row.capabilities));
  assert.ok(row.capabilities.includes("editor_discovery"));
  assert.ok(Array.isArray(row.limits));
  assert.ok(row.limits.includes("no_dispatch_protocol"));
  assert.ok(Array.isArray(row.evidence));
  assert.ok(row.evidence.length > 0);
  assert.equal(typeof row.received_at, "string");
  assert.ok(!Number.isNaN(Date.parse(row.received_at)));
  assert.equal(row.observer, true);
  assert.equal(row.invoke_supported, false);
  assert.equal(row.cancel_supported, false);
});

test("snapshotFor returns codey with capability + limits", () => {
  const row = snapshotFor("codey");
  assert.equal(row.host, "codey");
  assert.ok(Array.isArray(row.capabilities));
  assert.ok(row.capabilities.includes("text_generation"));
  assert.ok(Array.isArray(row.limits));
  // Pre-MS-002 gaps that the canonical dispatch + discovery surfaces close
  // when MS-002 lands:
  assert.ok(row.limits.includes("missing_dispatch_whitelist"));
  assert.ok(row.limits.includes("missing_skill_discovery_path"));
  assert.ok(Array.isArray(row.evidence));
  assert.equal(typeof row.received_at, "string");
});

test("snapshotFor returns minimax with capability + limits", () => {
  const row = snapshotFor("minimax");
  assert.equal(row.host, "minimax");
  assert.ok(Array.isArray(row.capabilities));
  assert.ok(row.capabilities.includes("text_generation"));
  assert.ok(Array.isArray(row.limits));
  // Pre-MS-002 gaps that the canonical dispatch + discovery surfaces close
  // when MS-002 lands:
  assert.ok(row.limits.includes("missing_dispatch_whitelist"));
  assert.ok(row.limits.includes("missing_skill_discovery_path"));
  assert.ok(Array.isArray(row.evidence));
  assert.equal(typeof row.received_at, "string");
});

test("snapshotAll returns 7 rows in HOST_ORDER", () => {
  const rows = snapshotAll();
  assert.equal(rows.length, 7);
  const ids = rows.map((r) => r.host);
  assert.deepEqual(ids, [
    "claude-code",
    "pi",
    "cursor",
    "codex",
    "codey",
    "minimax",
    "dsh",
  ]);
  for (const row of rows) {
    assert.ok(Array.isArray(row.capabilities));
    assert.ok(Array.isArray(row.limits));
    assert.ok(Array.isArray(row.evidence));
    assert.equal(typeof row.received_at, "string");
  }
});

test("snapshotFor returns empty-row for unknown host", () => {
  const row = snapshotFor("not-a-real-host-xyz");
  assert.equal(row.host, "not-a-real-host-xyz");
  assert.deepEqual(row.capabilities, []);
  assert.deepEqual(row.limits, ["host_not_enumerated"]);
  assert.equal(row.observer, false);
  assert.equal(row.invoke_supported, false);
  assert.equal(row.cancel_supported, false);
  assert.equal(typeof row.received_at, "string");
});

test("snapshotFor throws on invalid host", () => {
  assert.throws(() => snapshotFor(""), /non-empty string/);
  assert.throws(() => snapshotFor(null), /non-empty string/);
});

// ─── enumeratedHosts + hostOrder + registeredAdapters ────────────────────────

test("enumeratedHosts returns cursor / codey / minimax", () => {
  const hosts = enumeratedHosts();
  assert.deepEqual(hosts, ["cursor", "codey", "minimax"]);
});

test("hostOrder returns canonical seven-host ordering", () => {
  const order = hostOrder();
  assert.equal(order.length, 7);
  assert.equal(order[0], "claude-code");
  assert.equal(order[6], "dsh");
  // Returned array is a defensive copy.
  order.push("evil");
  assert.equal(hostOrder().length, 7);
});

test("registeredAdapters returns list snapshot (post-_seed)", () => {
  reset();
  const ids = registeredAdapters();
  assert.ok(Array.isArray(ids));
  assert.ok(ids.includes("claude-code"));
  assert.ok(ids.includes("codex"));
  // cursor may or may not be in list depending on _seed() try/catch result;
  // but the snapshot for cursor is ALWAYS available via snapshotFor().
  // We don't assert `ids.includes("cursor")` here to avoid flake on missing
  // cursor.js during partial checkouts.
});

// ─── derived rows for registered adapters ────────────────────────────────────

test("snapshotFor derives row from registered codex adapter", () => {
  reset();
  const row = snapshotFor("codex");
  assert.equal(row.host, "codex");
  assert.ok(Array.isArray(row.capabilities));
  assert.ok(Array.isArray(row.evidence));
  // Discover envelope includes version; evidence includes "discover:codex@…".
  const hasDiscover = row.evidence.some((e) => e.startsWith("discover:codex@"));
  assert.ok(hasDiscover, `evidence missing discover: ${row.evidence.join(",")}`);
});

test("snapshotFor derives row from registered pi adapter (via bootstrap)", () => {
  // pi is registered via codey-pi-bootstrap (M-003), not via the default
  // _seed() path. Load the bootstrap so getAdapter("pi") returns an instance.
  reset();
  require("../../lib/agents/adapters/codey-pi-bootstrap");
  const row = snapshotFor("pi");
  assert.equal(row.host, "pi");
  assert.ok(Array.isArray(row.capabilities));
  // Either discover-derived evidence or static evidence should be present.
  assert.ok(row.evidence.length > 0);
});

// ─── security / purity ───────────────────────────────────────────────────────

test("snapshot module uses no fs / no subprocess / no network", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "lib", "runtime-adapters", "host-runtime-snapshots.js"),
    "utf8",
  );
  // No fs.writeFileSync / openSync / spawn allowed.
  assert.ok(!/\bspawn\s*\(/.test(src), "snapshot module must not spawn subprocesses");
  assert.ok(!/\bwriteFileSync\b/.test(src), "snapshot module must not write files");
  assert.ok(!/\bopenSync\b/.test(src), "snapshot module must not open files");
  assert.ok(!/https?:\/\//.test(src), "snapshot module must not hard-code URLs");
  // No fetch / http modules.
  assert.ok(!/require\(["'](node:http|node:https|node:net)["']\)/.test(src));
});

test("snapshot module uses only Node.js built-ins", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "lib", "runtime-adapters", "host-runtime-snapshots.js"),
    "utf8",
  );
  const reqMatches = src.match(/require\(["'][^"']+["']\)/g) || [];
  for (const m of reqMatches) {
    assert.ok(
      m.includes('"node:')
      || m.includes("'node:")
      || m.includes("../agents/adapters"),
      `disallowed require: ${m}`,
    );
  }
});
