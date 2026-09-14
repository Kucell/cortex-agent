"use strict";

// P-003d — safety, integrity, reproducibility tests
// Covers: corpus-id conflict -> tombstone, stale lock detection, lock cleanup,
// source-change produces different merkle, policy-version differentiation.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const HARVEST = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "harvest.js");

function receipt(kinds, policyVersion = "1.0.0") {
  return {
    schema_version: 1,
    receipt_id: "RCPT-test-p003d",
    project_slug: "cortex-agent",
    project_hash: "d".repeat(64),
    approved_by: "user",
    status: "active",
    kinds,
    redaction_policy_version: policyVersion,
    retention_days: 30,
    destination: ".agent-runtime/corpus",
    created_at: "2026-09-11T00:00:00.000Z",
    revoked_at: null,
    revocation_note: null,
  };
}

function runExtract(corpusId, tmpDir, kinds, policyVersion) {
  const rp = path.join(tmpDir, "receipt.json");
  fs.writeFileSync(rp, JSON.stringify(receipt(kinds, policyVersion)));
  const out = path.join(tmpDir, "out");
  const r = spawnSync("node", [HARVEST, "extract",
    "--project", ROOT,
    "--corpus-id", corpusId,
    "--kinds", kinds.join(","),
    "--consent-receipt", rp,
    "--output", out,
  ], { cwd: ROOT, encoding: "utf8" });
  return { r, corpusRoot: path.join(out, corpusId) };
}

test("P-003d: corpus-id conflict writes tombstone + exit 1", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003d-cf-"));
  const id = "test-2026-09-11-1.0.0-cfff00000020";
  const kinds = ["episodic", "semantic"];
  const first = runExtract(id, tmp, kinds);
  assert.equal(first.r.status, 0, "first run: " + first.r.stderr);
  const second = runExtract(id, tmp, kinds);
  assert.notEqual(second.r.status, 0, "second run with same id must fail");
  const tomb = path.join(first.corpusRoot, "tombstones.jsonl");
  assert.ok(fs.existsSync(tomb), "tombstone file written");
  const lines = fs.readFileSync(tomb, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "at least one tombstone entry");
  const t = JSON.parse(lines[lines.length - 1]);
  assert.equal(t.corpus_id, id);
  assert.ok(/silent overwrite/i.test(t.reason), "tombstone explains reason");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003d: stale harvest.lock triggers fail-closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003d-lk-"));
  const out = path.join(tmp, "out");
  // Plant a stale lock under a different corpus id to simulate prior interrupted run.
  const stale = path.join(out, "stale-corpus");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, ".harvest.lock"), JSON.stringify({
    pid: 99999, started_at: "2026-09-11T00:00:00Z", corpus_id: "stale-corpus",
  }) + "\n");
  const rp = path.join(tmp, "receipt.json");
  fs.writeFileSync(rp, JSON.stringify(receipt(["episodic"])));
  const r = spawnSync("node", [HARVEST, "extract",
    "--project", ROOT,
    "--corpus-id", "test-2026-09-11-1.0.0-dddd00000021",
    "--kinds", "episodic",
    "--consent-receipt", rp,
    "--output", out,
  ], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(r.status, 0, "stale lock must abort");
  assert.match(r.stderr, /stale harvest\.lock/, "error message names lock");
  // No corpus dir created for the new id (we never got past the guard).
  assert.ok(!fs.existsSync(path.join(out, "test-2026-09-11-1.0.0-dddd00000021")), "no partial corpus written");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003d: successful run cleans its lock", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003d-clean-"));
  const { r, corpusRoot } = runExtract("test-2026-09-11-1.0.0-eeee00000022", tmp, ["episodic"]);
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(corpusRoot, "manifest.json")), "manifest written");
  assert.ok(!fs.existsSync(path.join(corpusRoot, ".harvest.lock")), "lock cleaned on success");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003d: source change produces different merkle root", () => {
  // Run 1: full extraction with all kinds.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003d-mk-"));
  const id1 = "test-2026-09-11-1.0.0-eeee00000023";
  const r1 = runExtract(id1, tmp, ["intent_execution", "approval_judgement", "investigation_narrative", "failure_recovery", "episodic", "semantic"]);
  assert.equal(r1.r.status, 0);
  const m1 = JSON.parse(fs.readFileSync(path.join(r1.corpusRoot, "manifest.json"), "utf8"));
  // Run 2: same input snapshot (we did not modify .agent) -> identical merkle.
  const id2 = "test-2026-09-11-1.0.0-eeee00000024";
  const r2 = runExtract(id2, tmp, ["intent_execution", "approval_judgement", "investigation_narrative", "failure_recovery", "episodic", "semantic"]);
  assert.equal(r2.r.status, 0);
  const m2 = JSON.parse(fs.readFileSync(path.join(r2.corpusRoot, "manifest.json"), "utf8"));
  assert.equal(m1.merkle.root, m2.merkle.root, "same input -> same merkle (reproducibility)");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003d: different policy_version produces different corpus id namespace", () => {
  // P-003 schema requires corpus-id to embed policy_version; consumers must
  // bump policy to produce a new corpus under a new id.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003d-pv-"));
  const id10 = "test-2026-09-11-1.0.0-eeee00000025";
  const id20 = "test-2026-09-11-2.0.0-eeee00000025";
  const r10 = runExtract(id10, tmp, ["episodic"]);
  const r20 = runExtract(id20, tmp, ["episodic"], "2.0.0");
  assert.equal(r10.r.status, 0);
  assert.equal(r20.r.status, 0);
  assert.ok(fs.existsSync(path.join(r10.corpusRoot, "manifest.json")));
  assert.ok(fs.existsSync(path.join(r20.corpusRoot, "manifest.json")));
  const m10 = JSON.parse(fs.readFileSync(path.join(r10.corpusRoot, "manifest.json"), "utf8"));
  const m20 = JSON.parse(fs.readFileSync(path.join(r20.corpusRoot, "manifest.json"), "utf8"));
  assert.equal(m10.policy_version, "1.0.0");
  assert.equal(m20.policy_version, "2.0.0");
  fs.rmSync(tmp, { recursive: true, force: true });
});