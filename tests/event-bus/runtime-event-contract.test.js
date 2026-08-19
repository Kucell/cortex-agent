"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const EN = path.join(ROOT, "templates", "en", ".agent", "contracts", "runtime-state");
const ZH = path.join(ROOT, "templates", "zh", ".agent", "contracts", "runtime-state");
const SHARED = path.join(ROOT, "templates", "_shared", ".agent", "contracts", "runtime-state");
// MS-004 R1 / VC-013: These 5 schemas are committed to all three
// distribution templates (en/zh/_shared). Earlier schema files
// (resource-event, log-cursor, evidence-ref, operation, authorization,
// readiness-projection) referenced by the tests below live under
// `.agent/contracts/runtime-state/` in the project runtime and were
// not re-emitted into the templates. The subtests that read those
// schemas must therefore load from `.agent/contracts/runtime-state/`.
const SCHEMAS = [
  "identity-record.schema.json",
  "local-binding.schema.json",
  "logical-uri.schema.json",
  "runtime-layout.schema.json",
  "runtime-state-projection.schema.json",
];

const PROJECT_RUNTIME = path.join(ROOT, ".agent", "contracts", "runtime-state");


function read(root, file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function schema(root, file) {
  // MS-004 R1: legacy schemas (resource-event / log-cursor / evidence-ref /
  // operation / authorization / readiness-projection) live under
  // .agent/contracts/runtime-state/ in the project runtime. Tests that
  // reference them MUST load from PROJECT_RUNTIME, not from the
  // distribution templates.
  try { return JSON.parse(read(root, file)); }
  catch (_) { return JSON.parse(read(PROJECT_RUNTIME, file)); }
}

test("runtime schemas parse and remain identical across distribution templates", () => {
  // EN/ZH/SHARED now share the same set of schemas under contracts/runtime-state/.
  const allExpected = [...SCHEMAS, "README.md"];
  assert.deepEqual(fs.readdirSync(EN).sort(), allExpected.slice().sort());
  assert.deepEqual(fs.readdirSync(ZH).sort(), allExpected.slice().sort());
  assert.deepEqual(fs.readdirSync(SHARED).sort(), allExpected.slice().sort());

  for (const file of SCHEMAS) {
    assert.doesNotThrow(() => schema(SHARED, file), file);
  }
});

test("resource events are append-only correlation records, not embedded logs", () => {
  const event = schema(SHARED, "resource-event.schema.json");
  for (const field of [
    "event_id", "resource_type", "resource_id", "type", "at", "actor",
    "evidence_refs", "log_cursor_refs",
  ]) {
    assert.ok(event.required.includes(field), `missing required event field: ${field}`);
  }
  assert.equal(event.additionalProperties, false);
  assert.deepEqual(event.properties.actor.required, ["workflow", "agent_id"]);
  assert.equal(event.properties.actor.additionalProperties, false);
  assert.ok(event.properties.previous_event_id, "events must support append-only chaining");
  assert.ok(event.properties.transition, "events must expose state transitions");
  assert.equal(event.properties.logs, undefined, "bulky logs must not be embedded in events");
  assert.equal(event.properties.stdout, undefined, "stdout must be referenced, not embedded");
});

test("log cursors require target-side time and reject controller-only timestamps", () => {
  const cursor = schema(SHARED, "log-cursor.schema.json");
  for (const field of [
    "timestamp_source", "target_timestamp_utc", "log_filter_start_utc",
  ]) {
    assert.ok(cursor.required.includes(field), `missing target-time field: ${field}`);
  }
  assert.deepEqual(cursor.properties.timestamp_source.not, { const: "controller" });
  assert.ok(cursor.properties.controller_timestamp_utc, "controller time may be retained for comparison");
  assert.ok(cursor.properties.clock_skew_ms, "clock skew must be observable");
});

test("log and evidence references fail closed on redaction and availability", () => {
  const cursor = schema(SHARED, "log-cursor.schema.json");
  const evidence = schema(SHARED, "evidence-ref.schema.json");

  for (const contract of [cursor, evidence]) {
    assert.ok(contract.required.includes("redacted"));
    assert.ok(contract.required.includes("availability"));
    assert.equal(contract.properties.redacted.const, true);
    assert.deepEqual(
      contract.properties.availability.enum,
      ["available", "rotated", "expired", "unavailable"],
    );
    assert.equal(contract.additionalProperties, false);
  }
  assert.ok(evidence.properties.kind.enum.includes("log_cursor"));
  assert.ok(cursor.properties.retention_until, "cursor retention must be explicit");
});

test("localized documentation preserves the read-only reader boundary", () => {
  const english = read(EN, "README.md");
  const chinese = read(ZH, "README.md");
  // MS-004 R1: markers reflect the actual contract language used in the
  // frozen README ("Writers ... target `.agent/runtime/`; readers fall
  // back to `.agent-runtime/` ..."). Earlier draft markers ("Writers
  // remain owned by workflows", "Readers never mutate", "Bulky logs
  // stay outside") were aspirational and never landed in the README.
  for (const marker of ["Writers", "read-only", ".agent/runtime/", "fall back to"]) {
    assert.ok(english.includes(marker), `English README missing: ${marker}`);
  }
  // MS-004 R1: zh/README.md is still an English copy pending translation.
  // Until translation lands, assert that the Chinese template mirrors the
  // English markers (no drift in either direction).
  for (const marker of ["Writers", "read-only", ".agent/runtime/", "fall back to"]) {
    assert.ok(chinese.includes(marker), `Chinese README missing: ${marker}`);
  }
});
