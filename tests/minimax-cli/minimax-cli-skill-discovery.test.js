"use strict";

// ─── M-011 / ARI P-005 — portable skill discovery tests ───────────────────
// Zero external dependencies.

const test = require("node:test");
const assert = require("node:assert/strict");

const skillDiscovery = require("../../lib/runtime-adapters/minimax-cli-skill-discovery");

const HOSTS = ["claude-code", "cursor", "pi", "codex", "common"];
const SCOPES = ["user", "project", "template"];

test("SKILL_NAME is kebab-case 'minimax-cli'", () => {
  assert.equal(skillDiscovery.SKILL_NAME, "minimax-cli");
});

test("enumerateDiscoveryPaths returns 21 entries (Pi enumerates both ~/.pi/skills and ~/.agents/skills)", () => {
  const paths = skillDiscovery.enumerateDiscoveryPaths({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  // 3 non-common hosts (claude-code, cursor, codex) × (1 user + 1 project + 2 templates) = 12
  // Pi × (2 user + 1 project + 2 templates) = 5
  // common × (0 user + 1 project + 2 templates) = 3
  // shared template (locale "shared") = 1
  // Total = 21.
  assert.equal(paths.length, 21);
  // common/user must NOT be present.
  for (const p of paths) {
    if (p.host === "common" && p.scope === "user") {
      assert.fail("common/user must not be in the discovery list");
    }
  }
  // shared-template slot is present (locale: "shared").
  assert.ok(paths.some((p) => p.host === "common" && p.scope === "template" && p.locale === "shared"));
});

test("enumerateDiscoveryPaths covers zh and en locales per template", () => {
  const paths = skillDiscovery.enumerateDiscoveryPaths({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  const templateHosts = paths.filter((p) => p.scope === "template");
  // For each non-common host: 2 template locales (zh + en) = 4*2 = 8
  // For common: 2 template locales (zh + en) = 2
  // Plus shared template = 1
  // Total template entries: 11.
  assert.equal(templateHosts.length, 11);
  for (const host of HOSTS) {
    const hostPaths = templateHosts.filter((p) => p.host === host);
    const expectedCount = host === "common" ? 3 : 2; // common includes shared
    assert.equal(hostPaths.length, expectedCount, `expected ${expectedCount} template entries for host ${host}`);
    const locales = hostPaths.map((p) => p.locale).sort();
    if (host === "common") {
      assert.deepEqual(locales, ["en", "shared", "zh"]);
    } else {
      assert.deepEqual(locales, ["en", "zh"]);
    }
  }
});

// Regression: Pi user scope must enumerate BOTH ~/.pi/skills/minimax-cli and
// ~/.agents/skills/minimax-cli independently (ARI P-005 §5.2).  Previously the
// builder appended SKILL_NAME twice producing malformed paths.
test("enumerateDiscoveryPaths enumerates both Pi user roots (ARI P-005 §5.2)", () => {
  const paths = skillDiscovery.enumerateDiscoveryPaths({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  const piUser = paths.filter((p) => p.host === "pi" && p.scope === "user");
  assert.equal(piUser.length, 2, "Pi user scope must enumerate two independent roots");
  const paths_listed = piUser.map((p) => p.path).sort();
  assert.ok(paths_listed.some((p) => p.endsWith("/.pi/skills/minimax-cli")), `expected ~/.pi/skills/minimax-cli in ${paths_listed.join(", ")}`);
  assert.ok(paths_listed.some((p) => p.endsWith("/.agents/skills/minimax-cli")), `expected ~/.agents/skills/minimax-cli in ${paths_listed.join(", ")}`);
  for (const p of piUser) {
    const suffixCount = (p.path.match(/minimax-cli/g) || []).length;
    assert.equal(suffixCount, 1, `Pi user path ${p.path} must contain exactly one /minimax-cli suffix (was ${suffixCount})`);
  }
});

test("enumerateDiscoveryPaths is deterministic (sorted shape)", () => {
  const a = skillDiscovery.enumerateDiscoveryPaths({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  const b = skillDiscovery.enumerateDiscoveryPaths({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  assert.deepEqual(a, b);
});

test("enumerateDiscoveryPaths host/scope combinations are complete and unique", () => {
  const paths = skillDiscovery.enumerateDiscoveryPaths({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  const seen = new Set();
  for (const p of paths) {
    // Pi user scope has 2 entries (pi + agents) which both lack a `locale`;
    // include `path` in the dedupe key so the two Pi user entries are not
    // treated as duplicates.
    const key = `${p.host}|${p.scope}|${p.locale || ""}|${p.path}`;
    assert.ok(!seen.has(key), `duplicate path entry: ${key}`);
    seen.add(key);
  }
});

test("discoverSkills reports present=false for missing paths", () => {
  const descriptors = skillDiscovery.discoverSkills({ projectRoot: "/tmp/__nonexistent_proj__", templatesRoot: "/tmp/__nonexistent_tpl__" });
  for (const d of descriptors) {
    assert.equal(d.present, false);
    assert.equal(d.size_bytes, null);
  }
});

test("discoverSkills never creates files (idempotent reads only)", () => {
  // Probe a directory that does not exist; verify the directory is still
  // absent after the call.
  const fs = require("node:fs");
  const probe = "/tmp/__m011_discovery_probe__";
  try {
    fs.rmdirSync(probe, { recursive: true });
  } catch (_) { /* ignore */ }
  skillDiscovery.discoverSkills({ projectRoot: "/tmp/__nonexistent__", templatesRoot: probe });
  assert.equal(fs.existsSync(probe), false);
});

test("discoverSkills returns descriptors with the canonical schema", () => {
  const descriptors = skillDiscovery.discoverSkills({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  for (const d of descriptors) {
    assert.equal(d.schema_version, "1.0");
    assert.ok(HOSTS.includes(d.host), `unexpected host ${d.host}`);
    assert.ok(SCOPES.includes(d.scope), `unexpected scope ${d.scope}`);
    assert.equal(typeof d.path, "string");
    assert.equal(typeof d.present, "boolean");
  }
});

test("summarizeSkills counts total + present + per-host breakdown", () => {
  const descriptors = skillDiscovery.discoverSkills({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  const summary = skillDiscovery.summarizeSkills(descriptors);
  assert.equal(summary.total, descriptors.length);
  assert.ok(summary.present >= 0);
  assert.ok(summary.by_host);
  for (const host of HOSTS) {
    assert.ok(summary.by_host[host]);
    assert.equal(summary.by_host[host].total, descriptors.filter((d) => d.host === host).length);
  }
});

test("enumerateDiscoveryPaths includes shared template at templates/_shared/.agent/skills/minimax-cli", () => {
  const paths = skillDiscovery.enumerateDiscoveryPaths({ projectRoot: "/tmp/proj", templatesRoot: "/tmp/tpl" });
  const shared = paths.find((p) => p.host === "common" && p.scope === "template" && p.locale === "shared");
  assert.ok(shared);
  assert.match(shared.path, /_shared[\\/].agent[\\/]skills[\\/]minimax-cli$/);
});

test("SkillDiscoveryError carries code and details", () => {
  try {
    skillDiscovery.inspectPath({ host: "claude-code", scope: "user", path: "x".repeat(2000) });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.name, "SkillDiscoveryError");
    assert.equal(err.code, "ERR_PATH_INVALID");
  }
});