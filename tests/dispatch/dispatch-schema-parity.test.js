"use strict";

// ─── Bilingual dispatch/lease schema parity tests (FAE-002/003/004/007) ──
//
// Verifies that the machine-readable schemas + README reach every language
// and never drift. A template file lives in exactly one layer: the shared
// base when it is language-neutral, a language overlay when it genuinely
// differs. What has to hold is that every language can receive the file and
// that the layers carrying it agree byte for byte — a language layer that
// repeats the shared base is a redundant copy, and one that differs from it
// is a drift.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  LAYERS,
  layersCarrying,
  resolveTemplatePath,
} = require("../helpers/template-layers");

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
    // The helper resolves paths relative to the .agent root of a layer.
    const relativePath = `dispatch/${name}`;
    // Every language has to be able to receive the file.
    for (const lang of ["zh", "en"]) {
      const resolved = resolveTemplatePath(relativePath, lang);
      assert.notEqual(resolved, null, `${name} must reach the ${lang} surface`);
    }
    // And the layers that carry it must agree.
    const carriers = layersCarrying(relativePath);
    const shared = path.join(LAYERS._shared, relativePath);
    if (carriers.includes("_shared")) {
      for (const layer of carriers.filter((candidate) => candidate !== "_shared")) {
        const target = path.join(LAYERS[layer], relativePath);
        const result = diff(shared, target);
        assert.equal(result.ok, true, `${target} must match _shared (${result.reason || "byte mismatch"})`);
      }
    }
  });
}
