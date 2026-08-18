"use strict";

// ─── Memory Scope Tests (P-007 §3.1 M1) ────────────────────────────────────────
//
// Coverage: scope enum extension (5 values incl. skill/runtime), legacy
// default (entries without scope → 'project'), recall filter, CLI end-to-end.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  SCOPES,
  ALL_SCOPES,
  DEFAULT_SCOPE,
  isValidScope,
  resolveScope,
} = require("../../lib/memory/types");
const { writeMemory } = require("../../lib/memory/store");
const { recall } = require("../../lib/memory/recall");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p007-scope-"));
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seed(root, type, id, content, opts = {}) {
  writeMemory(root, type, {
    schema_version: 1,
    memory_id: id,
    type,
    title: opts.title || (content.length <= 80 ? content : content.slice(0, 77) + "..."),
    content,
    tags: opts.tags || [],
    scope: opts.scope,  // intentionally allow undefined for legacy seed
    pinned: !!opts.pinned,
    confidence: opts.confidence != null ? opts.confidence : 0.8,
    expires_at: opts.expiresAt || null,
    created_at: opts.createdAt || "2026-08-02T00:00:00.000Z",
    updated_at: null,
  });
}

// ─── types.js: scope enum + resolver ────────────────────────────────────────

test("scope: SCOPES exposes 5 canonical names", () => {
  assert.equal(SCOPES.USER, "user");
  assert.equal(SCOPES.PROJECT, "project");
  assert.equal(SCOPES.SKILL, "skill");
  assert.equal(SCOPES.RUNTIME, "runtime");
  assert.equal(SCOPES.GLOBAL, "global");
});

test("scope: ALL_SCOPES has exactly 5 entries in expected order", () => {
  assert.deepEqual([...ALL_SCOPES], ["user", "project", "skill", "runtime", "global"]);
});

test("scope: DEFAULT_SCOPE is 'project' for back-compat", () => {
  assert.equal(DEFAULT_SCOPE, "project");
});

test("scope: isValidScope accepts only known scopes", () => {
  for (const s of ALL_SCOPES) assert.equal(isValidScope(s), true);
  assert.equal(isValidScope("bogus"), false);
  assert.equal(isValidScope(null), false);
  assert.equal(isValidScope(""), false);
  assert.equal(isValidScope(undefined), false);
  assert.equal(isValidScope(42), false);
});

test("scope: resolveScope returns stored value when valid", () => {
  assert.equal(resolveScope({ scope: "user" }), "user");
  assert.equal(resolveScope({ scope: "skill" }), "skill");
  assert.equal(resolveScope({ scope: "runtime" }), "runtime");
  assert.equal(resolveScope({ scope: "global" }), "global");
});

test("scope: resolveScope falls back to project for legacy/missing entries", () => {
  assert.equal(resolveScope({}), "project");
  assert.equal(resolveScope({ scope: undefined }), "project");
  assert.equal(resolveScope({ scope: null }), "project");
  assert.equal(resolveScope({ scope: "bogus" }), "project");
  assert.equal(resolveScope(null), "project");
});

// ─── recall.js: scope filter ───────────────────────────────────────────────

test("recall: scope=null returns all scopes", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-S-1", "user prefers Chinese replies", { scope: "user" });
    seed(root, "semantic", "MEM-S-2", "project uses Spring + PostgreSQL", { scope: "project" });
    seed(root, "semantic", "MEM-S-3", "evaluator score dropped 5 points", { scope: "skill" });
    seed(root, "semantic", "MEM-S-4", "M-025 phase B running", { scope: "runtime" });
    seed(root, "semantic", "MEM-S-5", "legacy entry without scope", {});  // no scope
    const r = recall({ projectRoot: root, query: "", limit: 10, scope: null });
    assert.equal(r.returned, 5);
    assert.equal(r.scope, null);
    assert.equal(r.scope_filtered_skipped, 0);
  } finally {
    rmProject(root);
  }
});

test("recall: scope=user returns only user-scoped entries (legacy→project excluded)", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-U-1", "user likes dark mode", { scope: "user" });
    seed(root, "semantic", "MEM-P-1", "project convention", { scope: "project" });
    seed(root, "semantic", "MEM-L-1", "legacy without scope", {});
    const r = recall({ projectRoot: root, query: "", limit: 10, scope: "user" });
    assert.equal(r.returned, 1);
    assert.equal(r.memories[0].memory_id, "MEM-U-1");
    assert.equal(r.scope_filtered_skipped, 2);
  } finally {
    rmProject(root);
  }
});

test("recall: scope=skill returns only skill-scoped entries", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-K-1", "evaluator output 1", { scope: "skill" });
    seed(root, "semantic", "MEM-K-2", "evaluator output 2", { scope: "skill" });
    seed(root, "semantic", "MEM-R-1", "session state", { scope: "runtime" });
    const r = recall({ projectRoot: root, query: "", limit: 10, scope: "skill" });
    assert.equal(r.returned, 2);
    for (const m of r.memories) assert.equal(m.memory_id.startsWith("MEM-K-"), true);
    assert.equal(r.scope_filtered_skipped, 1);
  } finally {
    rmProject(root);
  }
});

test("recall: scope=runtime returns only runtime-scoped entries", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-RT-1", "M-025 phase B active", { scope: "runtime" });
    seed(root, "semantic", "MEM-RT-2", "deploy in progress", { scope: "runtime" });
    seed(root, "semantic", "MEM-O-1", "other scope", { scope: "user" });
    const r = recall({ projectRoot: root, query: "", limit: 10, scope: "runtime" });
    assert.equal(r.returned, 2);
    assert.equal(r.scope_filtered_skipped, 1);
  } finally {
    rmProject(root);
  }
});

test("recall: invalid scope throws ERR_INVALID_MEMORY_SCOPE", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => recall({ projectRoot: root, query: "", limit: 10, scope: "bogus" }),
      (err) => err.code === "ERR_INVALID_MEMORY_SCOPE"
    );
  } finally {
    rmProject(root);
  }
});

test("recall: scope filter composes with type filter", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-S-1", "user preference A", { scope: "user" });
    seed(root, "episodic", "MEM-E-1", "user event A", { scope: "user" });
    seed(root, "semantic", "MEM-S-2", "project context A", { scope: "project" });
    seed(root, "episodic", "MEM-E-2", "project event A", { scope: "project" });
    // scope=user + type=semantic → only MEM-S-1
    const r = recall({ projectRoot: root, query: "", limit: 10, scope: "user", types: ["semantic"] });
    assert.equal(r.returned, 1);
    assert.equal(r.memories[0].memory_id, "MEM-S-1");
  } finally {
    rmProject(root);
  }
});

// ─── CLI end-to-end ─────────────────────────────────────────────────────────

test("cli: memory recall --scope=user filters correctly", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-CLI-U-1", "user scope entry", { scope: "user" });
    seed(root, "semantic", "MEM-CLI-P-1", "project scope entry", { scope: "project" });
    const r = spawnSync(process.execPath, [
      CLI, "memory", "recall", "scope",
      "--project", root, "--scope", "user", "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.returned, 1);
    assert.equal(out.memories[0].memory_id, "MEM-CLI-U-1");
    assert.equal(out.scope_filtered_skipped, 1);
  } finally {
    rmProject(root);
  }
});

test("cli: memory recall --scope=bogus exits 2 with error message", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-CLI-1", "any", { scope: "user" });
    const r = spawnSync(process.execPath, [
      CLI, "memory", "recall", "any",
      "--project", root, "--scope", "bogus", "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid scope/);
  } finally {
    rmProject(root);
  }
});

test("cli: memory recall without --scope returns all scopes including legacy", () => {
  const root = mkProject();
  try {
    seed(root, "semantic", "MEM-CLI-2", "user entry", { scope: "user" });
    seed(root, "semantic", "MEM-CLI-3", "project entry", { scope: "project" });
    seed(root, "semantic", "MEM-CLI-4", "legacy entry", {});  // no scope
    const r = spawnSync(process.execPath, [
      CLI, "memory", "recall", "entry",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.returned, 3);
    assert.equal(out.scope, null);
  } finally {
    rmProject(root);
  }
});
