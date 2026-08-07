"use strict";

// ─── Bilingual dispatch/lease schema parity tests (FAE-002/003/004/007) ──
//
// Verifies that the machine-readable schemas + README are byte-identical
// across the _shared / zh / en overlays so Architecture Guard + downstream
// consumers never see drift.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const SHARED = path.join(__dirname, "../../templates/_shared/.agent/dispatch");
const ZH = path.join(__dirname, "../../templates/zh/.agent/dispatch");
const EN = path.join(__dirname, "../../templates/en/.agent/dispatch");

const FILES = [
  "README.md",
  "lease-cli.schema.json",
  "dispatch-state.schema.json",
  "dispatch-plan.schema.json",
  "trigger.schema.json",
  "daemon-state.schema.json",
  "idempotency.schema.json",
];

function diff(a, b) {
  const ra = fs.readFileSync(a);
  const rb = fs.readFileSync(b);
  if (ra.length !== rb.length) return { ok: false, reason: `length differs (${ra.length} vs ${rb.length})` };
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i] !== rb[i]) return { ok: false, reason: `byte ${i} differs` };
  }
  return { ok: true };
}

for (const name of FILES) {
  test(`VC-013-03-template dispatch/${name} parity across _shared / zh / en`, () => {
    for (const langPath of [ZH, EN]) {
      const target = path.join(langPath, name);
      assert.equal(fs.existsSync(target), true, `${target} must exist`);
      const result = diff(path.join(SHARED, name), target);
      assert.equal(result.ok, true, `${target} must match _shared (${result.reason || "byte mismatch"})`);
    }
  });
}