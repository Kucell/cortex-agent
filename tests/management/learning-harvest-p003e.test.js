"use strict";

// P-003e — Pilot audit + export tests
// Locks: 6 audit checks, export Decision gate (fail-closed on missing/unapproved),
// provenance manifest + tarball sha256 + audit pass rate.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const AUDIT = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "audit.js");
const EXPORT = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "export.js");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sha256File = (p) => sha256(fs.readFileSync(p));

function receipt(kinds) {
  return {
    schema_version: 1,
    receipt_id: "RCPT-test-p003e",
    project_slug: "cortex-agent",
    project_hash: "e".repeat(64),
    approved_by: "user",
    status: "active",
    kinds,
    redaction_policy_version: "1.0.0",
    retention_days: 30,
    destination: ".agent-runtime/corpus",
    created_at: "2026-09-11T00:00:00.000Z",
    revoked_at: null,
    revocation_note: null,
  };
}

function makeCorpus(tmp, id, kinds) {
  fs.writeFileSync(path.join(tmp, "receipt.json"), JSON.stringify(receipt(kinds)));
  const out = path.join(tmp, "out");
  const r = spawnSync("node", [path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "harvest.js"), "extract",
    "--project", ROOT,
    "--corpus-id", id,
    "--kinds", kinds.join(","),
    "--consent-receipt", path.join(tmp, "receipt.json"),
    "--output", out,
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, "harvest failed: " + r.stderr);
  return { corpusRoot: path.join(out, id), out };
}

test("P-003e: audit covers 6 checks (5 hard + stable_rerun)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003e-audit-"));
  const id = "test-2026-09-11-1.0.0-eeee00000030";
  const { corpusRoot } = makeCorpus(tmp, id, ["intent_execution", "approval_judgement", "investigation_narrative", "failure_recovery", "episodic", "semantic"]);
  const reportPath = path.join(tmp, "report.json");
  const r = spawnSync("node", [AUDIT, "--corpus", corpusRoot, "--project", ROOT, "--reextract", "--output", reportPath], { cwd: ROOT, encoding: "utf8" });
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.report_version, 1);
  assert.equal(report.reextract_performed, true);
  const names = report.checks.map((c) => c.name);
  assert.ok(names.includes("redaction_clean_no_residual_hits"));
  assert.ok(names.includes("provenance_100_percent"));
  assert.ok(names.includes("manifest_validation"));
  assert.ok(names.includes("record_accounting"));
  assert.ok(names.includes("per_project_consent"));
  assert.ok(names.includes("stable_rerun"));
  // Hard checks must pass for any fresh extraction.
  for (const c of report.checks) {
    if (c.name === "stable_rerun") continue;
    assert.equal(c.pass, true, c.name + " must pass; evidence: " + JSON.stringify(c.evidence));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003e: export fails closed on missing decision", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003e-ex-"));
  const id = "test-2026-09-11-1.0.0-eeee00000031";
  const { corpusRoot, out } = makeCorpus(tmp, id, ["episodic", "semantic"]);
  const tarball = path.join(tmp, "out.tar.gz");
  const r = spawnSync("node", [EXPORT, "--corpus", corpusRoot, "--tarball", tarball, "--decision-id", "D-ATR-NONEXISTENT-xxx"], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(r.status, 0, "missing decision must fail closed");
  assert.match(r.stderr, /decision not found/);
  assert.ok(!fs.existsSync(tarball), "no tarball on gate failure");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003e: export fails closed on unapproved decision", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003e-unapp-"));
  // Drop an unapproved decision file directly under .agent/decisions/ for the test.
  const decId = "D-ATR-P003e-test-unapproved";
  const decPath = path.join(ROOT, ".agent", "decisions", decId + ".json");
  const dec = {
    schema_version: 1, decision_id: decId, type: "approval", status: "pending",
    requested_by: "test", prompt: "test", options: ["a", "b"], gate: { action: "external_side_effect", resource_ref: "test" },
  };
  fs.writeFileSync(decPath, JSON.stringify(dec));
  try {
    const id = "test-2026-09-11-1.0.0-eeee00000032";
    const { corpusRoot } = makeCorpus(tmp, id, ["episodic"]);
    const r = spawnSync("node", [EXPORT, "--corpus", corpusRoot, "--tarball", path.join(tmp, "out.tar.gz"), "--decision-id", decId], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /status must be approved/);
  } finally {
    try { fs.unlinkSync(decPath); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("P-003e: export fails closed on decision without export keyword", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003e-noexp-"));
  const decId = "D-ATR-P003e-test-noexpword";
  const decPath = path.join(ROOT, ".agent", "decisions", decId + ".json");
  const dec = {
    schema_version: 1, decision_id: decId, type: "approval", status: "approved",
    requested_by: "test", prompt: "test", selected_option: "approve something else", options: ["a"],
    resolved_by: "test", resolved_at: "2026-09-11T00:00:00Z", rationale: "approve the architecture change",
    gate: { action: "architecture", resource_ref: "test" },
  };
  fs.writeFileSync(decPath, JSON.stringify(dec));
  try {
    const id = "test-2026-09-11-1.0.0-eeee00000033";
    const { corpusRoot } = makeCorpus(tmp, id, ["episodic"]);
    const r = spawnSync("node", [EXPORT, "--corpus", corpusRoot, "--tarball", path.join(tmp, "out.tar.gz"), "--decision-id", decId], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must mention export/);
  } finally {
    try { fs.unlinkSync(decPath); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("P-003e: export produces tarball + provenance + sha256 (approved decision)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003e-ok-"));
  const decId = "D-ATR-P003e-test-approve-export";
  const decPath = path.join(ROOT, ".agent", "decisions", decId + ".json");
  const dec = {
    schema_version: 1, decision_id: decId, type: "approval", status: "approved",
    requested_by: "test", prompt: "Approve export of pilot corpus", selected_option: "Approve export: package pilot corpus",
    options: ["a"], resolved_by: "user", resolved_at: "2026-09-11T00:00:00Z",
    rationale: "approve the export under audit gate",
    gate: { action: "external_side_effect", resource_ref: "corpus:test" },
  };
  fs.writeFileSync(decPath, JSON.stringify(dec));
  try {
    const id = "test-2026-09-11-1.0.0-eeee00000034";
    const { corpusRoot } = makeCorpus(tmp, id, ["episodic", "semantic"]);
    const tarball = path.join(tmp, "out.tar.gz");
    const r = spawnSync("node", [EXPORT, "--corpus", corpusRoot, "--tarball", tarball, "--decision-id", decId], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, "export failed: " + r.stderr);
    assert.ok(fs.existsSync(tarball), "tarball written");
    const provPath = tarball.replace(/\.tar\.gz$/, "") + ".provenance.json";
    assert.ok(fs.existsSync(provPath), "provenance manifest written");
    const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));
    assert.equal(prov.decision_id, decId);
    assert.equal(prov.decision_status, "approved");
    assert.equal(prov.tarball_sha256, sha256File(tarball));
    assert.match(prov.merkle_root, /^[a-f0-9]{64}$/);
    assert.equal(typeof prov.tarball_bytes, "number");
    assert.match(provenance_audit_text(prov), /4\/4/, "audit 4/4 reported");
  } finally {
    try { fs.unlinkSync(decPath); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function provenance_audit_text(p) { return p.audit_required_checks_passed || ""; }