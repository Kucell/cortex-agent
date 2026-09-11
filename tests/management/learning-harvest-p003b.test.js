"use strict";

// P-003b — four-source-kind extraction tests
// Locks: real records from structured sources, redaction 7 fixtures,
// provenance (opaque hashes), full SHA-256, Merkle root, stable rerun.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const HARVEST = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "harvest.js");
const REDACT = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "redact.js");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function receipt() {
  return {
    schema_version: 1,
    receipt_id: "RCPT-test-p003b",
    project_slug: "cortex-agent",
    project_hash: "b".repeat(64),
    approved_by: "user",
    status: "active",
    kinds: ["intent_execution", "approval_judgement", "investigation_narrative", "failure_recovery"],
    redaction_policy_version: "1.0.0",
    retention_days: 30,
    destination: ".agent-runtime/corpus",
    created_at: "2026-09-11T00:00:00.000Z",
    revoked_at: null,
    revocation_note: null,
  };
}

function runExtract(corpusId, tmpDir) {
  const rp = path.join(tmpDir, "receipt.json");
  fs.writeFileSync(rp, JSON.stringify(receipt()));
  const out = path.join(tmpDir, "out");
  const r = spawnSync("node", [HARVEST, "extract",
    "--project", ROOT,
    "--corpus-id", corpusId,
    "--kinds", "intent_execution,approval_judgement,investigation_narrative,failure_recovery",
    "--consent-receipt", rp,
    "--output", out,
  ], { cwd: ROOT, encoding: "utf8" });
  return { r, out, corpusRoot: path.join(out, corpusId) };
}

test("P-003b: redaction 7 fixtures", () => {
  const { redact, scan } = require(REDACT);
  const cases = [
    ["credential", "api_key=sk-abcdef1234567890abcdef12", "credential"],
    ["email", "mail to a.b@example.com", "email"],
    ["phone", "call +86 138-1234-5678", "phone"],
    ["id_card", "id 110101199003078811", "id_card"],
    ["credit_card", "card 4111111111111111", "credit_card"],
    ["absolute_path", "at /Users/john/proj/src/x.js", "absolute_path"],
    ["digit_id_no_fp", "decision D-20260819082739 approved", null],
  ];
  for (const [label, text, expectRule] of cases) {
    const hits = scan(text);
    if (expectRule === null) {
      assert.equal(hits.length, 0, label + " must not false-positive");
    } else {
      assert.ok(hits.some((h) => h.rule === expectRule), label + " must hit " + expectRule);
      const { text: out } = redact(text);
      assert.ok(out !== text, label + " must change output");
      assert.match(out, /\[REDACTED_/, label + " must emit a redaction token");
    }
  }
});

test("P-003b: four kinds extract real records with provenance+sha", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003b-"));
  const { r, corpusRoot } = runExtract("test-2026-09-11-1.0.0-abcd00000001", tmp);
  assert.equal(r.status, 0, "extract failed: " + r.stderr);
  for (const kind of ["intent_execution", "approval_judgement", "investigation_narrative", "failure_recovery"]) {
    const bf = path.join(corpusRoot, "records", kind, "batch-1.jsonl");
    assert.ok(fs.existsSync(bf), kind + " batch missing");
    const rec = JSON.parse(fs.readFileSync(bf, "utf8").split("\n").filter(Boolean)[0]);
    assert.equal(rec.kind, kind);
    assert.equal(rec.schema_version, 1);
    assert.match(rec.source_project_hash, /^[a-f0-9]{64}$/, kind + " project hash");
    assert.ok(Array.isArray(rec.source_refs) && rec.source_refs.length > 0, kind + " source_refs");
    assert.match(rec.source_refs[0].opaque_ref_hash, /^[a-f0-9]{64}$/, kind + " opaque ref");
    assert.equal(rec.redaction_policy_version, "1.0.0");
    assert.match(rec.content_sha256, /^[a-f0-9]{64}$/, kind + " content sha");
    const canonical = JSON.stringify(rec.payload);
    assert.equal(rec.content_sha256, sha256(canonical), kind + " content_sha256 matches canonical payload");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003b: approval records exclude decision prompt", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003b-ap-"));
  const { corpusRoot } = runExtract("test-2026-09-11-1.0.0-efab00000002", tmp);
  const bf = path.join(corpusRoot, "records", "approval_judgement", "batch-1.jsonl");
  const text = fs.readFileSync(bf, "utf8");
  assert.ok(!/\.payload\.prompt/.test(text), "no prompt field");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003b: manifest has merkle root + input snapshot + counts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003b-mf-"));
  const { corpusRoot } = runExtract("test-2026-09-11-1.0.0-cdab00000003", tmp);
  const m = JSON.parse(fs.readFileSync(path.join(corpusRoot, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 1);
  assert.match(m.merkle.root, /^[a-f0-9]{64}$/, "merkle root sha256");
  assert.ok(m.leaf_hashes.length > 0, "leaf hashes present");
  assert.ok(m.input_snapshot.files.length > 0, "input snapshot present");
  assert.equal(m.input_snapshot.stable_order, true);
  const total = Object.values(m.record_counts).reduce((a, b) => a + b, 0);
  assert.ok(total > 0, "total record counts > 0");
  // Test receipt does not consent procedural => disabled_no_consent (correct gate).
  assert.equal(m.kinds.procedural.status, "disabled_no_consent");
  assert.equal(m.kinds.procedural.enabled, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003b: stable rerun gives identical hashes (reproducibility)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003b-rr-"));
  const c1 = runExtract("test-2026-09-11-1.0.0-aaaa00000004", tmp);
  const c2 = runExtract("test-2026-09-11-1.0.0-aaaa00000004", tmp);
  const m1 = JSON.parse(fs.readFileSync(path.join(c1.corpusRoot, "manifest.json"), "utf8"));
  const m2 = JSON.parse(fs.readFileSync(path.join(c2.corpusRoot, "manifest.json"), "utf8"));
  assert.equal(m1.merkle.root, m2.merkle.root, "same input+policy -> same merkle root");
  assert.deepEqual(m1.leaf_hashes.sort(), m2.leaf_hashes.sort(), "same leaf hashes");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003b: no sensitive residual in corpus output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003b-sec-"));
  const { corpusRoot } = runExtract("test-2026-09-11-1.0.0-bbbb00000005", tmp);
  const { scan } = require(REDACT);
  const allText = [];
  for (const kind of ["intent_execution", "approval_judgement", "investigation_narrative", "failure_recovery"]) {
    const bf = path.join(corpusRoot, "records", kind, "batch-1.jsonl");
    if (fs.existsSync(bf)) allText.push(fs.readFileSync(bf, "utf8"));
  }
  const joined = allText.join("\n");
  const hits = scan(joined);
  assert.equal(hits.length, 0, "corpus must have zero residual sensitive hits: " + hits.map((h) => h.rule).join(","));
  fs.rmSync(tmp, { recursive: true, force: true });
});