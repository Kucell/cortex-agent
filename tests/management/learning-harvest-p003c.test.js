"use strict";

// P-003c — memory-kind enablement tests
// episodic/semantic enabled only from real validated upstream memory records;
// procedural stays disabled (no extractor, never a stub success).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const HARVEST = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "harvest.js");
const REDACT = path.join(ROOT, ".agent", "skills", "learning-harvest", "scripts", "redact.js");

function receipt(kinds) {
  return {
    schema_version: 1,
    receipt_id: "RCPT-test-p003c",
    project_slug: "cortex-agent",
    project_hash: "c".repeat(64),
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

function runExtract(corpusId, tmpDir, kinds) {
  const rp = path.join(tmpDir, "receipt.json");
  fs.writeFileSync(rp, JSON.stringify(receipt(kinds)));
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

const MEM_KINDS = ["intent_execution", "approval_judgement", "investigation_narrative", "failure_recovery", "episodic", "semantic"];

test("P-003c: episodic/semantic enabled from real memory records", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003c-mem-"));
  const { r, corpusRoot } = runExtract("test-2026-09-11-1.0.0-aaaa00000010", tmp, MEM_KINDS);
  assert.equal(r.status, 0, "extract failed: " + r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(corpusRoot, "manifest.json"), "utf8"));
  assert.equal(m.kinds.episodic.enabled, true);
  assert.equal(m.kinds.episodic.status, "enabled");
  assert.ok(m.kinds.episodic.record_count >= 1, "episodic has real records");
  assert.equal(m.kinds.semantic.enabled, true);
  assert.ok(m.kinds.semantic.record_count >= 1, "semantic has real records");
  // Records carry title/content/confidence + provenance + sha
  const ep = JSON.parse(fs.readFileSync(path.join(corpusRoot, "records", "episodic", "batch-1.jsonl"), "utf8").split("\n").filter(Boolean)[0]);
  assert.equal(ep.kind, "episodic");
  assert.ok(ep.payload.title, "episodic record has title");
  assert.ok(ep.payload.content, "episodic record has content");
  assert.equal(typeof ep.payload.confidence, "number");
  assert.match(ep.content_sha256, /^[a-f0-9]{64}$/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003c: procedural stays disabled (no extractor)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003c-proc-"));
  const kinds = [...MEM_KINDS, "procedural"];
  const { r, corpusRoot } = runExtract("test-2026-09-11-1.0.0-bbbb00000011", tmp, kinds);
  assert.equal(r.status, 0, "extract failed: " + r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(corpusRoot, "manifest.json"), "utf8"));
  assert.equal(m.kinds.procedural.enabled, false, "procedural never enabled");
  assert.ok(["disabled_missing_source", "disabled_no_consent", "disabled_policy"].includes(m.kinds.procedural.status));
  assert.equal(m.kinds.procedural.record_count, 0);
  assert.ok(!fs.existsSync(path.join(corpusRoot, "records", "procedural")), "no procedural records dir");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003c: memory content is redaction-clean (zero residual)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003c-sec-"));
  const { r, corpusRoot } = runExtract("test-2026-09-11-1.0.0-cccc00000012", tmp, MEM_KINDS);
  assert.equal(r.status, 0);
  const { scan } = require(REDACT);
  const texts = [];
  for (const kind of ["episodic", "semantic"]) {
    const bf = path.join(corpusRoot, "records", kind, "batch-1.jsonl");
    if (fs.existsSync(bf)) texts.push(fs.readFileSync(bf, "utf8"));
  }
  const hits = scan(texts.join("\n"));
  assert.equal(hits.length, 0, "memory records must be redaction-clean: " + hits.map((h) => h.rule).join(","));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("P-003c: memory record content_sha256 matches canonical payload", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p003c-sha-"));
  const { r, corpusRoot } = runExtract("test-2026-09-11-1.0.0-dddd00000013", tmp, MEM_KINDS);
  assert.equal(r.status, 0);
  const crypto = require("node:crypto");
  const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
  for (const kind of ["episodic", "semantic"]) {
    const bf = path.join(corpusRoot, "records", kind, "batch-1.jsonl");
    for (const lineText of fs.readFileSync(bf, "utf8").split("\n").filter(Boolean)) {
      const rec = JSON.parse(lineText);
      assert.equal(rec.content_sha256, sha256(JSON.stringify(rec.payload)), kind + " sha matches canonical payload");
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});