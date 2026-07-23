"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "templates", "_shared", ".agent", "skills", "activity-recording", "scripts", "index.js");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-activity-security-"));
  const script = path.join(cwd, ".agent", "skills", "activity-recording", "scripts", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(source, script);
  spawnSync(process.execPath, [script, "init"], { cwd, encoding: "utf8" });
  return { cwd, script };
}

function baseEvent(summary) {
  return {
    schema_version: 1,
    activity_id: "ACT-security-001",
    activity_kind: "execution",
    capture_mode: "automatic",
    project_id: "fixture",
    source: "terminal",
    source_revision: "run:1",
    observed_at: "2026-07-23T00:00:00.000Z",
    occurred_at: null,
    actor: { type: "system", id: "runner" },
    summary,
    evidence_refs: [],
    log_cursor_refs: [],
    completeness: "partial",
    confidence: "observed",
    availability: "available",
    dedupe_key: "terminal:run:1"
  };
}

test("writer rejects unknown fields and sensitive summaries", () => {
  const context = fixture();
  for (const payload of [
    { ...baseEvent("safe summary"), unexpected: true },
    { ...baseEvent("safe summary"), actor: { type: "system", id: "runner", secret: "hidden" } },
    baseEvent("credential=top-secret full prompt payload"),
    baseEvent("clipboard contents: session cookie=abc complete user instructions"),
    { ...baseEvent("x".repeat(1001)) },
    { ...baseEvent("safe summary"), evidence_refs: [42] },
    { ...baseEvent("safe summary"), log_cursor_refs: ["stdout payload: private data"] },
    { ...baseEvent("safe summary"), task_id: 42 },
    { ...baseEvent("safe summary"), evidence_refs: ["same", "same"] },
    { ...baseEvent("safe summary"), observed_at: "July 23, 2026" },
    { ...baseEvent("safe summary"), occurred_at: "2026-07-23" },
    { ...baseEvent("safe summary"), observed_at: "2026-02-30T00:00:00Z" },
    { ...baseEvent("safe summary"), observed_at: "2025-02-29T00:00:00Z" },
    { ...baseEvent("safe summary"), observed_at: "2026-04-31T00:00:00Z" }
  ]) {
    const result = spawnSync(process.execPath, [context.script, "event", "append", "--payload-json", JSON.stringify(payload)], { cwd: context.cwd, encoding: "utf8" });
    assert.strictEqual(result.status, 1);
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(context.cwd, ".agent", "activities", "events")), []);
});

test("receipt redaction failures and sensitive evidence are rejected", () => {
  const context = fixture();
  const receipt = {
    schema_version: 1,
    receipt_id: "AR-security-001",
    receipt_kind: "capture",
    source: "terminal",
    source_revision: "run:1",
    capture_mode: "automatic",
    observed_at: "2026-07-23T00:00:00.000Z",
    activity_refs: [],
    gaps: [],
    evidence_refs: [],
    availability: "available",
    redaction: { status: "failed", ruleset: "default" },
    dedupe_key: "terminal:receipt:1"
  };
  const result = spawnSync(process.execPath, [context.script, "receipt", "append", "--payload-json", JSON.stringify(receipt)], { cwd: context.cwd, encoding: "utf8" });
  assert.strictEqual(result.status, 1);
  assert.ok(!fs.existsSync(path.join(context.cwd, ".agent", "activities", "receipts", "AR-security-001.json")));

  const invalidDate = { ...receipt, redaction: { status: "passed", ruleset: "default" }, evidence_refs: [], observed_at: "July 23, 2026" };
  const dateResult = spawnSync(process.execPath, [context.script, "receipt", "append", "--payload-json", JSON.stringify(invalidDate)], { cwd: context.cwd, encoding: "utf8" });
  assert.strictEqual(dateResult.status, 1);
  const invalidCalendar = { ...invalidDate, observed_at: "2026-02-30T00:00:00Z" };
  const calendarResult = spawnSync(process.execPath, [context.script, "receipt", "append", "--payload-json", JSON.stringify(invalidCalendar)], { cwd: context.cwd, encoding: "utf8" });
  assert.strictEqual(calendarResult.status, 1);
});
