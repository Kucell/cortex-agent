"use strict";

// ─── phase-c-stage1-preflight tests ─────────────────────────────────────────
// Focused regression tests for scripts/phase-c-stage1-preflight.sh
// Verifies that the SampleGate (check #1) implements the M-025 Phase C framework
// §2.1 G-SampleGate criteria, not just multi-host prefix presence:
//   - ≥100 non-test eligible receipts per Host per UTC day
//   - 7 consecutive UTC days where ≥2 Hosts each meet the per-day threshold
//   - WARN with explicit reason when not met (regression fix)
//
// Test strategy: spawn the bash script with --project <tmp> and --skip-rollback
// against a synthetic ledger-index.json. Other gates will WARN/FAIL because the
// temp project lacks the real fixture surface; we only assert on the
// sample_gate=... line of the JSON results array.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "phase-c-stage1-preflight.sh");

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-preflight-"));
  fs.mkdirSync(path.join(root, ".agent", "token-attempts"), { recursive: true });
  return root;
}

// Build a synthetic ledger-index.json where each host has `count` receipts per
// day across the given UTC date sequence. attempt_id uses the host's prefix.
// Writes BOTH `index.receipts` (used by the new sample-gate analyzer) and
// `index.entries` (used by ledger.queryReceipts → queryReadiness for EXCL).
function writeSyntheticLedger(projectRoot, plan) {
  // plan = { codex: { days: ['2026-08-01', ...], countPerDay: N }, pi: {...}, ... }
  const index = { receipts: {}, entries: [] };
  let n = 0;
  for (const [host, info] of Object.entries(plan)) {
    const prefix = host === "codex" ? "ocx" : host === "dsh" ? "dsh" : host === "pi" ? "pi" : "test";
    for (const day of info.days) {
      for (let i = 0; i < info.countPerDay; i++) {
        n++;
        const aid = `${prefix}-fixture-${day.replace(/-/g, "")}-${i}`;
        const rec = {
          receipt_id: `TR-${String(n).padStart(24, "0")}`,
          attempt_id: aid,
          host: "synthetic-provider",
          model: "synthetic-model",
          status: "host_reported",
          measurement_source: "synthetic",
          recorded_at: `${day}T12:00:00.000Z`,
          appended_at: `${day}T12:00:00.000Z`,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        index.receipts[`${aid}::${rec.receipt_id}`] = rec;
        index.entries.push(rec);
      }
    }
  }
  const ledgerDir = path.join(projectRoot, ".agent", "token-attempts");
  fs.writeFileSync(path.join(ledgerDir, "ledger-index.json"), JSON.stringify(index));
}

// Append `count` test receipts (attempt_id "test-*", host starting with "test")
// to the existing ledger-index.json. These satisfy the G-TestExclusion
// prerequisite (test exclusion reasons must be present) without contributing to
// the non-test sample gate.
function appendTestReceipts(projectRoot, count) {
  const ledgerDir = path.join(projectRoot, ".agent", "token-attempts");
  const indexPath = path.join(ledgerDir, "ledger-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  let n = (index.entries || []).length;
  for (let i = 0; i < count; i++) {
    n++;
    const aid = `test-fixture-${String(n).padStart(4, "0")}`;
    const rec = {
      receipt_id: `TR-${String(n).padStart(24, "0")}`,
      attempt_id: aid,
      host: "test-host",
      model: "synthetic-model",
      status: "host_reported",
      measurement_source: "synthetic",
      recorded_at: "2026-08-15T12:00:00.000Z",
      appended_at: "2026-08-15T12:00:00.000Z",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    index.receipts[`${aid}::${rec.receipt_id}`] = rec;
    (index.entries = index.entries || []).push(rec);
  }
  fs.writeFileSync(indexPath, JSON.stringify(index));
}

function runScript(projectRoot) {
  return spawnSync("bash", [SCRIPT, "--project", projectRoot, "--skip-rollback", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function extractSampleGate(result) {
  // The script emits JSON like:
  //   "results": [ "sample_gate=PASS ...", "...", ... ]
  // We only need the first entry.
  const m = result.stdout.match(/"results":\s*\[\s*"([^"]+)"/);
  assert.ok(m, `expected sample_gate line in JSON; got: ${result.stdout.slice(0, 400)}`);
  return m[1];
}

// Build a consecutive date list (UTC) of length `n` starting at `startISO`.
function consecutiveDays(startISO, n) {
  const out = [];
  const start = new Date(startISO + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ─── TC-001: PASS — 2 hosts × 7 consecutive days × 100 receipts/day ──────────
test("TC-001: sample_gate=PASS when 2 hosts have ≥100/day on 7 consecutive UTC days", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  // Synthetic non-test receipts that qualify the sample gate.
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
    pi:    { days: days7, countPerDay: 100 },
  });
  // Add a couple of test receipts so queryReadiness sees test exclusion reasons
  // (G-TestExclusion requires excluded_count > 0). The preflight only PASSes
  // when both sample gate AND test exclusion are present.
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=PASS/.test(sampleGateLine),
    `expected sample_gate=PASS, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /run_days=7/);
  assert.match(sampleGateLine, /hosts=codex,pi/);
  assert.match(sampleGateLine, /window=2026-08-01\.\.2026-08-07/);
});

// ─── TC-002: WARN — only 6 consecutive days (short of 7) ─────────────────────
test("TC-002: sample_gate=WARN with consecutive_days_short when only 6 consecutive days qualify", () => {
  const project = tempProject();
  const days6 = consecutiveDays("2026-08-01", 6);
  writeSyntheticLedger(project, {
    codex: { days: days6, countPerDay: 100 },
    pi:    { days: days6, countPerDay: 100 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /reason=consecutive_days_short:6\/required=7/);
  assert.match(sampleGateLine, /run_days=6/);
});

// ─── TC-003: WARN — 7 days but only 1 host (host parity missing) ────────────
test("TC-003: sample_gate=WARN with host_parity_short when only 1 host has data", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
    // pi omitted → only 1 host
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /reason=host_parity_short:1/);
});

// ─── TC-004: WARN — 7 days × 2 hosts but one host drops below 100 on a day ───
test("TC-004: sample_gate=WARN when one host has <100 on a day in an otherwise qualifying window", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
    pi:    { days: days7.slice(0, 3), countPerDay: 100 }, // pi only 3 days
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN, got: ${sampleGateLine}`);
  // Days where BOTH hosts have ≥100: only days 1..3 → run = 3 days, not 7
  assert.match(sampleGateLine, /run_days=3/);
  assert.match(sampleGateLine, /reason=consecutive_days_short:3\/required=7/);
});

// ─── TC-005: WARN — ledger with only test receipts (excluded by prefix) ─────
test("TC-005: sample_gate=WARN when ledger contains only test receipts", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  // Use 'test' prefix attempt_id; the analyzer must filter these out.
  writeSyntheticLedger(project, {
    test: { days: days7, countPerDay: 100 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN (test-only), got: ${sampleGateLine}`);
  // 0 non-test hosts → host_parity_short:0
  assert.match(sampleGateLine, /reason=host_parity_short:0/);
});

// ─── TC-006: WARN — 100+ on each day but split across a gap (no 7-run) ──────
test("TC-006: sample_gate=WARN when qualifying days exist but no 7-day consecutive run", () => {
  const project = tempProject();
  // 3 qualifying days in week 1, gap of 3 days, 3 qualifying days in week 2.
  // No single run of ≥7 days even though 6 qualifying days exist.
  const run1 = consecutiveDays("2026-08-01", 3);
  const run2 = consecutiveDays("2026-08-08", 3);
  writeSyntheticLedger(project, {
    codex: { days: [...run1, ...run2], countPerDay: 100 },
    pi:    { days: [...run1, ...run2], countPerDay: 100 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /run_days=3/);
  assert.match(sampleGateLine, /reason=consecutive_days_short:3\/required=7/);
});

// ─── TC-007: PASS — exact threshold: 2 hosts × 7 days × exactly 100/day ──────
test("TC-007: sample_gate=PASS at exact 100/day threshold (boundary case)", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
    pi:    { days: days7, countPerDay: 100 },
  });
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=PASS/.test(sampleGateLine),
    `expected sample_gate=PASS at boundary, got: ${sampleGateLine}`);
});

// ─── TC-008: WARN — 99/day (one under threshold) breaks the run ─────────────
test("TC-008: sample_gate=WARN at 99/day (one below threshold) breaks the qualifying run", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
    pi:    { days: days7, countPerDay: 99 }, // 1 short on every day
  });
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN at 99/day boundary, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /run_days=0/);
  assert.match(sampleGateLine, /reason=consecutive_days_short:0\/required=7/);
});

// ─── TC-009: WARN — missing ledger-index.json yields WARN, never PASS ───────
test("TC-009: sample_gate=WARN when ledger-index.json is missing (no false PASS)", () => {
  const project = tempProject();
  // Do not write any ledger-index.json.
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN on missing ledger, got: ${sampleGateLine}`);
  // The script must NEVER report PASS based on historical multi-host presence alone.
  assert.ok(!/^sample_gate=PASS/.test(sampleGateLine),
    `must not report PASS without sufficient data: ${sampleGateLine}`);
});

// ─── TC-010: regression — multi-host presence alone does NOT trigger PASS ────
test("TC-010: multi-host presence alone (with insufficient per-day counts) never triggers PASS", () => {
  const project = tempProject();
  // Two distinct hosts, plenty of receipts spread thinly across many days,
  // but neither host reaches 100/day on any single day. The OLD logic would
  // have returned PASS just because ≥2 prefixes exist; the new logic MUST NOT.
  const days = consecutiveDays("2026-08-01", 14);
  writeSyntheticLedger(project, {
    codex: { days, countPerDay: 5 },  // 5/day × 14 days = 70 total
    pi:    { days, countPerDay: 5 },  // 5/day × 14 days = 70 total
  });
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(!/^sample_gate=PASS/.test(sampleGateLine),
    `multi-host presence alone must not yield PASS: ${sampleGateLine}`);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine));
});