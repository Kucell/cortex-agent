"use strict";

// ─── phase-c-stage1-preflight tests ─────────────────────────────────────────
// Focused regression tests for scripts/phase-c-stage1-preflight.sh
// Verifies that the SampleGate (check #1) implements the M-025 Phase C framework
// §2.1 G-SampleGate criteria after D-TCP-005-sample-gate-relaxation (2026-08-25):
//   - ≥100 non-test eligible receipts per Host per counted UTC day
//   - ≥7 counted days with ≥2 Hosts each meeting the per-day threshold (coverage window)
//   - max consecutive zero-sample days ≤ 2 (weekend/rest allowed, no ≥3-day runs)
//   - WARN with explicit reason when not met (coverage_days_short, zero_run_too_long, …)
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

// Append non-test receipts for given hosts/days at a custom countPerDay.
// Used by trailing-10 tests to push `latest` to a specific anchor date while
// keeping those days BELOW the 100/host/day threshold (so they register as
// zero_sample rather than counted days).
function appendBelowThresholdDays(projectRoot, plan) {
  const ledgerDir = path.join(projectRoot, ".agent", "token-attempts");
  const indexPath = path.join(ledgerDir, "ledger-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  let n = (index.entries || []).length;
  for (const [host, info] of Object.entries(plan)) {
    const prefix = host === "codex" ? "ocx" : host === "dsh" ? "dsh" : host === "pi" ? "pi" : "test";
    for (const day of info.days) {
      for (let i = 0; i < info.countPerDay; i++) {
        n++;
        const aid = `${prefix}-below-${day.replace(/-/g, "")}-${i}`;
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
        (index.entries = index.entries || []).push(rec);
      }
    }
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

// ─── TC-001: PASS — 2 hosts × 7 coverage days × 100 receipts/day, no zero-run ─
test("TC-001: sample_gate=PASS when 2 hosts cover ≥7 days with ≥100/day (no zero-run)", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
    pi:    { days: days7, countPerDay: 100 },
  });
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=PASS/.test(sampleGateLine),
    `expected sample_gate=PASS, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /counted_days=7/);
  assert.match(sampleGateLine, /max_zero_run=0/);
  assert.match(sampleGateLine, /hosts=codex,pi/);
});

// ─── TC-002: WARN — only 6 counted days (short of 7) ────────────────────────
test("TC-002: sample_gate=WARN with coverage_days_short when only 6 days qualify", () => {
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
  assert.match(sampleGateLine, /reason=coverage_days_short:6\/required=7/);
  assert.match(sampleGateLine, /counted_days=6/);
});

// ─── TC-003: WARN — ≥7 days but only 1 host (host parity missing) ───────────
test("TC-003: sample_gate=WARN with host_parity_short when only 1 host has data", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /reason=host_parity_short:1/);
});

// ─── TC-004: PASS with 2-day zero-run (weekend relaxation D-TCP-005) ─────────
test("TC-004: sample_gate=PASS when ≥7 counted days with one 2-day zero-run (weekend)", () => {
  const project = tempProject();
  // 9-day window: days 1..5 counted, days 6..7 zero, days 8..9 counted → 7 counted, max_zero_run=2
  const counted = [
    ...consecutiveDays("2026-08-01", 5),
    ...consecutiveDays("2026-08-08", 2),
  ];
  writeSyntheticLedger(project, {
    codex: { days: counted, countPerDay: 100 },
    pi:    { days: counted, countPerDay: 100 },
  });
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=PASS/.test(sampleGateLine),
    `expected sample_gate=PASS with weekend gap, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /counted_days=7/);
  assert.match(sampleGateLine, /max_zero_run=2/);
});

// ─── TC-005: WARN — 3-day zero-run is too long ──────────────────────────────
test("TC-005: sample_gate=WARN with zero_run_too_long when zero-run > 2 days", () => {
  const project = tempProject();
  // 10-day window: 5 counted + 3 zero + 2 counted → counted_days=7 BUT max_zero_run=3
  const counted = [
    ...consecutiveDays("2026-08-01", 5),
    ...consecutiveDays("2026-08-09", 2),
  ];
  writeSyntheticLedger(project, {
    codex: { days: counted, countPerDay: 100 },
    pi:    { days: counted, countPerDay: 100 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN with 3-day zero-run, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /reason=zero_run_too_long:3\/max=2/);
});

// ─── TC-006: WARN — ledger with only test receipts (excluded by prefix) ─────
test("TC-006: sample_gate=WARN when ledger contains only test receipts", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    test: { days: days7, countPerDay: 100 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN (test-only), got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /reason=host_parity_short:0/);
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

// ─── TC-008: WARN — 99/day (one under threshold) breaks all counted days ────
test("TC-008: sample_gate=WARN at 99/day (one below threshold) breaks counted days", () => {
  const project = tempProject();
  const days7 = consecutiveDays("2026-08-01", 7);
  writeSyntheticLedger(project, {
    codex: { days: days7, countPerDay: 100 },
    pi:    { days: days7, countPerDay: 99 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN at 99/day boundary, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /counted_days=0/);
});

// ─── TC-009: WARN — missing ledger-index.json yields WARN, never PASS ───────
test("TC-009: sample_gate=WARN when ledger-index.json is missing (no false PASS)", () => {
  const project = tempProject();
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN on missing ledger, got: ${sampleGateLine}`);
  assert.ok(!/^sample_gate=PASS/.test(sampleGateLine),
    `must not report PASS without sufficient data: ${sampleGateLine}`);
});

// ─── TC-010: regression — multi-host presence alone does NOT trigger PASS ────
test("TC-010: multi-host presence alone (with insufficient per-day counts) never triggers PASS", () => {
  const project = tempProject();
  const days = consecutiveDays("2026-08-01", 14);
  writeSyntheticLedger(project, {
    codex: { days, countPerDay: 5 },
    pi:    { days, countPerDay: 5 },
  });
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(!/^sample_gate=PASS/.test(sampleGateLine),
    `multi-host presence alone must not yield PASS: ${sampleGateLine}`);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine));
});

// ─── TC-011: real-world DSH coverage shape (6 days, 1 zero-run) ─────────────
test("TC-011: sample_gate=WARN coverage_days_short:6/required=7 for real-world 6-day shape", () => {
  // Mirrors actual DSH ledger shape after backfill on 2026-08-25:
  // 6 covered days, 1 single-day zero sample. Should still WARN because coverage<7.
  const project = tempProject();
  const counted = [
    "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21",
    "2026-08-24", "2026-08-25",
  ];
  writeSyntheticLedger(project, {
    codex: { days: counted, countPerDay: 200 },
    pi:    { days: counted, countPerDay: 200 },
  });
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected WARN for 6-day coverage, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /reason=coverage_days_short:6\/required=7/);
  assert.match(sampleGateLine, /max_zero_run=2/);
});

// ─── TC-012: stale dates OUTSIDE trailing 10 must NOT pin max zero run ───────
test("TC-012: sample_gate=PASS even with stale dates outside trailing 10 (D-TCP-006)", () => {
  // Authority D-TCP-006 (2026-08-31): candidate window = trailing 10 UTC days
  // ending at the latest eligible receipt day. Historical receipts BEFORE the
  // trailing window are excluded entirely — they can no longer inflate
  // max_zero_run. Under the pre-D-TCP-006 [earliest..latest] semantics this
  // scenario produced zero_run_too_long (~20-day gap from 2026-08-01 to
  // 2026-08-22) and would have FAILed the gate.
  const project = tempProject();
  const stale = ["2026-08-01"];                  // far outside trailing 10
  const trailing10 = consecutiveDays("2026-08-22", 10); // 2026-08-22..2026-08-31
  writeSyntheticLedger(project, {
    codex: { days: [...stale, ...trailing10], countPerDay: 100 },
    pi:    { days: [...stale, ...trailing10], countPerDay: 100 },
  });
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=PASS/.test(sampleGateLine),
    `expected sample_gate=PASS (stale outside trailing must not pin zero run), got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /counted_days=10/);
  assert.match(sampleGateLine, /max_zero_run=0/);
  assert.match(sampleGateLine, /window=2026-08-22\.\.2026-08-31/);
});

// ─── TC-013: exactly 6 qualifying days inside trailing 10 → WARN ─────────────
test("TC-013: sample_gate=WARN coverage_days_short when only 6 of trailing 10 days qualify", () => {
  // Authority D-TCP-006: 6 counted days inside the trailing-10 window with
  // max_zero_run ≤ 2 must still WARN because coverage_days_short:6/required=7.
  // Trailing window [2026-08-22..2026-08-31]; 6 days cross the 100/host/day
  // threshold (2026-08-22..25, 2026-08-28..29), 4 days stay below it
  // (2026-08-26..27, 2026-08-30..31). Two separate 2-day zero runs;
  // counted_days=6.
  const project = tempProject();
  const trailing10 = consecutiveDays("2026-08-22", 10); // 2026-08-22..2026-08-31
  const countedSubset = [
    "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25",
    "2026-08-28", "2026-08-29",
  ];
  const belowThresholdSubset = [
    "2026-08-26", "2026-08-27", "2026-08-30", "2026-08-31",
  ];
  for (const d of [...countedSubset, ...belowThresholdSubset]) {
    assert.ok(trailing10.includes(d), `test bug: ${d} not in trailing 10`);
  }
  // Compose ledger plan: counted days with 100/day, below-threshold days with 50/day.
  writeSyntheticLedger(project, {
    codex: { days: countedSubset, countPerDay: 100 },
    pi:    { days: countedSubset, countPerDay: 100 },
  });
  appendBelowThresholdDays(project, {
    codex: { days: belowThresholdSubset, countPerDay: 50 },
    pi:    { days: belowThresholdSubset, countPerDay: 50 },
  });
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=WARN/.test(sampleGateLine),
    `expected sample_gate=WARN for 6-of-trailing-10, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /reason=coverage_days_short:6\/required=7/);
  assert.match(sampleGateLine, /max_zero_run=2/);
  assert.match(sampleGateLine, /window=2026-08-22\.\.2026-08-31/);
});

// ─── TC-014: 7 counted days in trailing 10 with zero run ≤ 2 → PASS ─────────
test("TC-014: sample_gate=PASS with 7 counted days in trailing 10 (zero run ≤ 2, D-TCP-006)", () => {
  // Authority D-TCP-006: 7 counted days inside the trailing-10 window with a
  // single 2-day zero run must PASS. Trailing window [2026-08-22..2026-08-31];
  // 8 days cross the 100/host/day threshold (2026-08-22..29), 2 days stay
  // below it (2026-08-30..31). counted_days=8 ≥ 7 and max_zero_run=2.
  const project = tempProject();
  const trailing10 = consecutiveDays("2026-08-22", 10);
  const countedSubset = consecutiveDays("2026-08-22", 8); // 2026-08-22..2026-08-29
  const belowThresholdSubset = ["2026-08-30", "2026-08-31"];
  for (const d of [...countedSubset, ...belowThresholdSubset]) {
    assert.ok(trailing10.includes(d), `test bug: ${d} not in trailing 10`);
  }
  writeSyntheticLedger(project, {
    codex: { days: countedSubset, countPerDay: 100 },
    pi:    { days: countedSubset, countPerDay: 100 },
  });
  appendBelowThresholdDays(project, {
    codex: { days: belowThresholdSubset, countPerDay: 50 },
    pi:    { days: belowThresholdSubset, countPerDay: 50 },
  });
  appendTestReceipts(project, 2);
  const r = runScript(project);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);
  const sampleGateLine = extractSampleGate(r);
  assert.ok(/^sample_gate=PASS/.test(sampleGateLine),
    `expected sample_gate=PASS for 7+ counted in trailing 10, got: ${sampleGateLine}`);
  assert.match(sampleGateLine, /counted_days=8/);
  assert.match(sampleGateLine, /max_zero_run=2/);
  // PASS branch reports counted span (window_start=first counted, window_end=last counted).
  assert.match(sampleGateLine, /window=2026-08-22\.\.2026-08-29/);
});