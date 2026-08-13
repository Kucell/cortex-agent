"use strict";

// ─── Memory CLI Tests (M-002 MS-002) ──────────────────────────────────────────
//
// Coverage: lib/memory/cli.js — argv parsing + end-to-end CLI invocation via
// `bin/cli.js memory <recall|distill>`. Mirrors `tests/dispatch-dry-run-cli.test.js`
// style (spawn the real binary, assert stdout/stderr/exit code).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m002-cli-"));
  for (const sub of ["runs", "sessions", "conversations"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seedMemory(root, type, id, content, opts = {}) {
  fs.mkdirSync(path.join(root, ".agent/memory", type), { recursive: true });
  fs.writeFileSync(
    path.join(root, `.agent/memory/${type}/${id}.json`),
    JSON.stringify({
      schema_version: 1,
      memory_id: id,
      type,
      title: opts.title || content.slice(0, 60),
      content,
      tags: opts.tags || [],
      scope: opts.scope || "project",
      pinned: !!opts.pinned,
      confidence: opts.confidence != null ? opts.confidence : 0.8,
      expires_at: opts.expiresAt || null,
      created_at: opts.createdAt || "2026-08-02T00:00:00.000Z",
      updated_at: null,
    }),
  );
}

test("memory-cli: memory recall without subcommand exits 2", () => {
  const result = spawnSync("node", [path.join(repoRoot, "bin/cli.js"), "memory"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/subcommand required/.test(result.stderr));
});

test("memory-cli: memory --help exits 0 with usage", () => {
  const result = spawnSync("node", [path.join(repoRoot, "bin/cli.js"), "memory", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.ok(/Usage:/.test(result.stdout));
  assert.ok(/memory recall/.test(result.stdout));
  assert.ok(/memory distill/.test(result.stdout));
  assert.ok(/memory validate/.test(result.stdout));
});

test("memory-cli: memory validate honors --project and emits one JSON document", () => {
  const root = mkProject();
  const caller = mkProject();
  try {
    for (const type of ["user", "feedback", "project", "reference"]) {
      fs.mkdirSync(path.join(root, ".agent", "memory", type), { recursive: true });
    }
    fs.writeFileSync(path.join(root, ".agent", "memory", "MEMORY.md"), [
      "# Memory", "", "## user (0/10)", "", "## feedback (0/30)", "",
      "## project (0/20)", "", "## reference (0/50)", "",
    ].join("\n"));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "validate",
      "--project", root, "--output", "json",
    ], { cwd: caller, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.memoryRoot, path.join(root, ".agent", "memory"));
    assert.deepEqual(payload.issues, []);
  } finally {
    rmProject(root);
    rmProject(caller);
  }
});

test("memory-cli: memory validate --fix --yes emits one parseable JSON result", () => {
  const root = mkProject();
  try {
    for (const type of ["user", "feedback", "project", "reference"]) {
      fs.mkdirSync(path.join(root, ".agent", "memory", type), { recursive: true });
    }
    fs.writeFileSync(path.join(root, ".agent", "memory", "user", "reply.md"),
      "---\nname: reply\ndescription: preference\ntype: user\ncreated: 2026-08-13\ntags: [reply]\n---\nbody\n");
    fs.writeFileSync(path.join(root, ".agent", "memory", "MEMORY.md"), [
      "# Memory", "", "## user (0/10)", "", "## feedback (0/30)", "",
      "## project (0/20)", "", "## reference (0/50)", "",
    ].join("\n"));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "validate", "--project", root,
      "--fix", "--yes", "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.apply.applied, 2);
    assert.equal("newText" in payload.apply, false);
    assert.deepEqual(payload.after.issues, []);
  } finally { rmProject(root); }
});

test("memory-cli: memory recall missing query exits 2 with usage", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "--project", root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.ok(/<query> required/.test(result.stderr));
  } finally { rmProject(root); }
});

test("memory-cli: memory recall with empty store returns 0 hits", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "FAE-001",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.returned, 0);
    assert.equal(json.scanned, 0);
  } finally { rmProject(root); }
});

test("memory-cli: memory recall --output json shape", () => {
  const root = mkProject();
  try {
    seedMemory(root, "semantic", "MEM-1", "FAE-001 dispatch vocabulary", { tags: ["dispatch"] });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "dispatch",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.returned, 1);
    assert.equal(json.memories[0].memory_id, "MEM-1");
    assert.equal(json.memories[0].type, "semantic");
  } finally { rmProject(root); }
});

test("memory-cli: memory recall --json shortcut produces identical shape", () => {
  const root = mkProject();
  try {
    seedMemory(root, "semantic", "MEM-1", "FAE-001 dispatch");
    const r1 = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "dispatch",
      "--project", root, "--json",
    ], { encoding: "utf8" });
    const r2 = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "dispatch",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r1.status, 0);
    assert.equal(r2.status, 0);
    assert.deepEqual(JSON.parse(r1.stdout), JSON.parse(r2.stdout));
  } finally { rmProject(root); }
});

test("memory-cli: memory recall human output is human-readable", () => {
  const root = mkProject();
  try {
    seedMemory(root, "semantic", "MEM-h", "decision style preference", { tags: ["style"] });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "decision",
      "--project", root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.ok(/memory recall query="decision"/.test(result.stdout));
    assert.ok(/MEM-h \(semantic/.test(result.stdout));
    assert.ok(/scanned=\d+ matched=\d+ returned=\d+/.test(result.stdout));
  } finally { rmProject(root); }
});

test("memory-cli: memory recall --type filters by type", () => {
  const root = mkProject();
  try {
    seedMemory(root, "episodic", "MEM-ep", "shared event");
    seedMemory(root, "semantic", "MEM-sem", "shared fact");
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "shared",
      "--project", root, "--type", "episodic", "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.returned, 1);
    assert.equal(json.memories[0].type, "episodic");
  } finally { rmProject(root); }
});

test("memory-cli: memory recall --min-confidence filters low confidence", () => {
  const root = mkProject();
  try {
    seedMemory(root, "semantic", "MEM-hi", "match", { confidence: 0.9 });
    seedMemory(root, "semantic", "MEM-lo", "match", { confidence: 0.1 });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "recall", "match",
      "--project", root, "--min-confidence", "0.5", "--output", "json",
    ], { encoding: "utf8" });
    const json = JSON.parse(result.stdout);
    assert.equal(json.returned, 1);
    assert.equal(json.memories[0].memory_id, "MEM-hi");
  } finally { rmProject(root); }
});

test("memory-cli: memory distill --candidates writes entries", () => {
  const root = mkProject();
  try {
    fs.writeFileSync(
      path.join(root, ".agent/sessions/S-1.json"),
      JSON.stringify({ created_at: "2026-08-02T00:00:00.000Z" }),
    );
    const cands = path.join(root, "cands.json");
    fs.writeFileSync(cands, JSON.stringify([
      { type: "episodic", content: "user did X", tags: ["x"] },
      { type: "semantic", content: "Eric prefers concrete recommendations", confidence: 0.95 },
    ]));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "distill",
      "--project", root, "--candidates", cands, "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.written.length, 2);
    assert.equal(json.error, null);
    assert.equal(fs.existsSync(path.join(root, ".agent/memory/episodic")), true);
    assert.equal(fs.existsSync(path.join(root, ".agent/memory/semantic")), true);
  } finally { rmProject(root); }
});

test("memory-cli: memory distill without --candidates is a no-op (LLM deferred to MS-004)", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "distill",
      "--project", root, "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.written.length, 0);
    assert.match(json.note, /deferred to MS-004/);
  } finally { rmProject(root); }
});

test("memory-cli: memory distill exits 3 on validation failure (rollback)", () => {
  const root = mkProject();
  try {
    const cands = path.join(root, "bad-cands.json");
    fs.writeFileSync(cands, JSON.stringify([
      { type: "episodic", content: "good" },
      { type: "episodic", content: "x".repeat(5000) },  // too long
    ]));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "distill",
      "--project", root, "--candidates", cands, "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 3);
    const json = JSON.parse(result.stdout);
    assert.ok(json.error);
    assert.equal(json.error.code, "ERR_CONTENT_TOO_LONG");
    // No .agent/memory/episodic/ should exist (rollback)
    assert.equal(fs.existsSync(path.join(root, ".agent/memory/episodic")), false);
  } finally { rmProject(root); }
});

test("memory-cli: memory distill rejects procedural type (v1.12 deferred)", () => {
  const root = mkProject();
  try {
    const cands = path.join(root, "proc-cands.json");
    fs.writeFileSync(cands, JSON.stringify([
      { type: "procedural", content: "user prefers /ship before commit" },
    ]));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "distill",
      "--project", root, "--candidates", cands, "--json",
    ], { encoding: "utf8" });
    // Exit 3 (rollback) since validation failed mid-distill (matches
    // memory-distill.md §3 failure_recovery = rollback-draft-and-notify).
    assert.equal(result.status, 3);
    const json = JSON.parse(result.stdout);
    assert.equal(json.error.code, "ERR_TYPE_NOT_WRITABLE");
    // No .agent/memory/ should exist (rollback)
    assert.equal(fs.existsSync(path.join(root, ".agent/memory")), false);
  } finally { rmProject(root); }
});

test("memory-cli: memory distill --type episodic,semantic filters out procedural", () => {
  const root = mkProject();
  try {
    const cands = path.join(root, "mixed-cands.json");
    fs.writeFileSync(cands, JSON.stringify([
      { type: "episodic", content: "ok" },
    ]));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "distill",
      "--project", root, "--candidates", cands, "--type", "episodic,semantic,procedural", "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.written.length, 1);
  } finally { rmProject(root); }
});

test("memory-cli: memory distill --run-id uses provided run id", () => {
  const root = mkProject();
  try {
    const cands = path.join(root, "cands.json");
    fs.writeFileSync(cands, JSON.stringify([{ type: "episodic", content: "x" }]));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "memory", "distill",
      "--project", root, "--candidates", cands, "--run-id", "R-custom", "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.run_id, "R-custom");
    assert.ok(fs.existsSync(path.join(root, ".agent/runs/R-custom/result.json")));
  } finally { rmProject(root); }
});

test("memory-cli: unknown memory subcommand exits 2", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "memory", "forget",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/unknown memory subcommand/.test(result.stderr));
});

test("memory-cli: cli-contract advertises memory as general_memory mode", () => {
  // Sanity check that the contract entry was added (regression guard).
  const contract = require(path.join(repoRoot, "lib/cli/contract.js"));
  const mem = contract.commands.find((c) => c.name === "memory");
  assert.ok(mem, "memory command must be registered in lib/cli-contract.js");
  assert.equal(mem.mode, "general_memory");
  assert.equal(mem.implemented, true);
  assert.equal(mem.automatic_dispatch_enabled, false);
});
