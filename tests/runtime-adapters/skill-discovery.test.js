"use strict";

// ─── Skill Discovery Wrapper (M-031 MS-002 / VC-031-002-04) ───────────────────
//
// Canonical authority for skill discovery lives at
// `lib/runtime-adapters/minimax-cli-skill-discovery.js` — the MS-002
// expansion adds `dsh` / `codey` / `minimax` to that file's HOSTS and
// HOST_PATH_BUILDER (per P-007 §4.7). This file is a thin wrapper so the
// validation contract command
//
//   node --test tests/runtime-adapters/skill-discovery.test.js
//
// resolves to a path under `tests/runtime-adapters/` without inventing a
// second discovery surface (VC-031-DRIFT-002 forbids it). All focused
// assertions for VC-031-002-04 also live in
// `tests/minimax-cli/minimax-cli-skill-discovery.test.js` next to the
// module under test.

const test = require("node:test");
const assert = require("node:assert/strict");

const skillDiscovery = require("../../lib/runtime-adapters/minimax-cli-skill-discovery");

test("VC-031-002-04 wrapper: HOSTS contains all seven P-007 hosts + common", () => {
  // The seven P-007 hosts (claude-code, pi, cursor, codex, codey, minimax,
  // dsh) plus `common` (the shared template surface). The additive MS-002
  // expansion is exactly dsh / codey / minimax — no others.
  for (const host of ["claude-code", "pi", "cursor", "codex", "codey", "minimax", "dsh", "common"]) {
    assert.ok(skillDiscovery.HOSTS.includes(host), `HOSTS missing ${host}`);
  }
});

test("VC-031-002-04 wrapper: SUPPORTED_HOSTS mirrors the canonical dispatch whitelist", () => {
  // DRIFT-002: the dispatch execute module reads the same HOSTS union. This
  // test only validates the wrapper wiring; the SUPPORTED_HOSTS test
  // itself lives in tests/dispatch/dispatch-execute.test.js.
  const dispatchExecute = require("../../lib/dispatch/execute");
  for (const host of ["dsh", "codey", "minimax"]) {
    assert.ok(
      dispatchExecute.SUPPORTED_HOSTS.includes(host),
      `SUPPORTED_HOSTS missing ${host} (DRIFT-002: dispatch must consume the same source)`,
    );
    assert.ok(
      skillDiscovery.HOSTS.includes(host),
      `HOSTS missing ${host} (DRIFT-002: skill discovery must consume the same source)`,
    );
  }
});

test("VC-031-002-04 wrapper: enumerateDiscoveryPaths is safe when no skill dirs exist", () => {
  const descriptors = skillDiscovery.discoverSkills({
    projectRoot: "/tmp/__nonexistent_proj_wrapper__",
    templatesRoot: "/tmp/__nonexistent_tpl_wrapper__",
  });
  assert.ok(descriptors.length > 0);
  for (const d of descriptors) {
    assert.equal(d.present, false);
    assert.equal(d.size_bytes, null);
    assert.equal(d.schema_version, "1.0");
  }
});