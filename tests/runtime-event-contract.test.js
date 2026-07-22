"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const EN = path.join(ROOT, "templates", "en", ".agent", "runtime");
const ZH = path.join(ROOT, "templates", "zh", ".agent", "runtime");
const SHARED = path.join(ROOT, "templates", "_shared", ".agent", "runtime");
const SCHEMAS = [
  "resource-event.schema.json",
  "log-cursor.schema.json",
  "evidence-ref.schema.json",
  "runtime-state-projection.schema.json",
];

function read(root, file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function schema(root, file) {
  return JSON.parse(read(root, file));
}

test("runtime schemas parse and remain identical across distribution templates", () => {
  assert.deepEqual(fs.readdirSync(EN).sort(), ["README.md"]);
  assert.deepEqual(fs.readdirSync(ZH).sort(), ["README.md"]);
  assert.deepEqual(fs.readdirSync(SHARED).sort(), SCHEMAS.sort());

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
  for (const marker of ["Writers remain owned by workflows", "Readers never mutate", "Bulky logs stay outside"]) {
    assert.ok(english.includes(marker), `English README missing: ${marker}`);
  }
  for (const marker of ["workflow", "read-only", "绝不修改", "大体量原始日志必须保留在事件记录之外"]) {
    assert.ok(chinese.includes(marker), `Chinese README missing: ${marker}`);
  }
});
