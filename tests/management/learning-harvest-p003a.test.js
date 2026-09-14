"use strict";

// P-003a — Governed corpus base contract tests
// Locks the fail-closed gates + isolation invariants from P-003 §1/§5 and
// the P-003a acceptance: git-ignore corpus, team-pack exclusion, consent
// receipt gate, manifest/kind schemas, procedural disabled.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const HARVEST = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "harvest.js");
const SCHEMAS = path.join(ROOT, ".agent", "skills", "learning-harvest", "schemas");

function validReceipt(overrides = {}) {
  return {
    schema_version: 1,
    receipt_id: "RCPT-test-001",
    project_slug: "test-project",
    project_hash: "a".repeat(64),
    approved_by: "user",
    status: "active",
    kinds: ["episodic", "semantic"],
    redaction_policy_version: "1.0.0",
    retention_days: 30,
    destination: ".agent-runtime/corpus",
    created_at: "2026-09-11T00:00:00.000Z",
    revoked_at: null,
    revocation_note: null,
    ...overrides,
  };
}

function runHarvest(args, cwd = ROOT) {
  return spawnSync("node", [HARVEST, "extract", ...args], { cwd, encoding: "utf8" });
}

test("P-003a: harvest script exists", () => {
  assert.ok(fs.existsSync(HARVEST), "harvest.js missing");
});

test("P-003a: fail-closed without consent receipt", () => {
  const out = path.join(os.tmpdir(), "corpus-p003a-" + Date.now());
  const r = runHarvest([
    "--project", ROOT,
    "--corpus-id", "test-2026-09-11-1.0.0-a1b2c3d4e5f6",
    "--kinds", "episodic",
    "--consent-receipt", path.join(os.tmpdir(), "missing-receipt.json"),
    "--output", out,
  ]);
  assert.notEqual(r.status, 0, "must fail closed without receipt");
  assert.ok(!fs.existsSync(path.join(out, "test-2026-09-11-1.0.0-a1b2c3d4e5f6", "manifest.json")), "no manifest written");
});

test("P-003a: fail-closed on revoked receipt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcpt-revoked-"));
  const rp = path.join(tmp, "receipt.json");
  fs.writeFileSync(rp, JSON.stringify(validReceipt({ status: "revoked", revoked_at: "2026-09-11T01:00:00.000Z" })));
  const out = path.join(tmp, "out");
  const r = runHarvest([
    "--project", ROOT,
    "--corpus-id", "test-2026-09-11-1.0.0-deadbeef0001",
    "--kinds", "episodic",
    "--consent-receipt", rp,
    "--output", out,
  ]);
  assert.notEqual(r.status, 0, "revoked receipt must fail closed");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003a: valid receipt writes manifest with correct kind states", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rcpt-valid-"));
  const rp = path.join(tmp, "receipt.json");
  fs.writeFileSync(rp, JSON.stringify(validReceipt()));
  const out = path.join(tmp, "out");
  const r = runHarvest([
    "--project", ROOT,
    "--corpus-id", "test-2026-09-11-1.0.0-b1b2c3d4e5f6",
    "--kinds", "episodic,semantic",
    "--consent-receipt", rp,
    "--output", out,
  ]);
  assert.equal(r.status, 0, "valid receipt should pass: " + r.stderr);
  const manifestPath = path.join(out, "test-2026-09-11-1.0.0-b1b2c3d4e5f6", "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "manifest written");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(m.manifest_version, 1);
  assert.equal(m.corpus_id, "test-2026-09-11-1.0.0-b1b2c3d4e5f6");
  // P-003c: episodic/semantic enabled from real upstream memory records.
  assert.equal(m.kinds.episodic.enabled, true, "episodic enabled (real records exist)");
  assert.equal(m.kinds.episodic.status, "enabled");
  assert.equal(m.kinds.semantic.enabled, true, "semantic enabled (real records exist)");
  assert.equal(m.kinds.procedural.enabled, false, "procedural stays disabled");
  assert.equal(m.kinds.procedural.status, "disabled_no_consent");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003a: gitignore excludes corpus root", () => {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.ok(gi.includes(".agent-runtime/corpus/"), "corpus must be git-ignored");
});

test("P-003a: team-pack includes cannot match corpus paths", () => {
  const tp = JSON.parse(fs.readFileSync(path.join(ROOT, ".agent-shared", "team-pack.json"), "utf8"));
  const includes = tp.includes;
  const corpusPaths = [
    ".agent-runtime/corpus/x/manifest.json",
    ".agent-runtime/corpus/x/records/episodic/batch-1.jsonl",
  ];
  const globToRegex = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "@@GS@@").replace(/\*/g, "[^/]*").replace(/@@GS@@/g, ".*") + "$");
  for (const p of corpusPaths) {
    assert.ok(!includes.some((inc) => globToRegex(inc).test(p)), p + " must not match team-pack includes");
  }
});

test("P-003a: schemas exist for consent/manifest/kind", () => {
  for (const f of ["consent-receipt.schema.json", "manifest.schema.json", "kind.schema.json"]) {
    const fp = path.join(SCHEMAS, f);
    assert.ok(fs.existsSync(fp), f + " missing");
    const s = JSON.parse(fs.readFileSync(fp, "utf8"));
    assert.equal(s.$schema, "http://json-schema.org/draft-07/schema#", f + " draft-07");
    assert.equal(s.additionalProperties, false, f + " strict schema");
  }
});

test("P-003a: manifest schema requires all 7 kinds", () => {
  const s = JSON.parse(fs.readFileSync(path.join(SCHEMAS, "manifest.schema.json"), "utf8"));
  const required = s.properties.kinds.required;
  assert.deepEqual(required.sort(), [
    "approval_judgement", "episodic", "failure_recovery", "intent_execution",
    "investigation_narrative", "procedural", "semantic",
  ].sort());
});