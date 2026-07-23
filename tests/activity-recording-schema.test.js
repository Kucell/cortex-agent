"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const shared = path.join(root, "templates", "_shared", ".agent", "activities");
const local = path.join(root, ".agent", "activities");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("activity recording schemas are synchronized and fail closed", () => {
  for (const name of [
    "activity-recording-profile.schema.json",
    "activity-source-health.schema.json",
    "activity-event.schema.json",
    "activity-receipt.schema.json",
    "index.schema.json",
    "index.json"
  ]) {
    assert.deepStrictEqual(readJson(path.join(local, name)), readJson(path.join(shared, name)), name);
  }

  const eventSchema = readJson(path.join(shared, "activity-event.schema.json"));
  assert.strictEqual(eventSchema.additionalProperties, false);
  assert.ok(eventSchema.required.includes("dedupe_key"));
  assert.ok(eventSchema.required.includes("availability"));

  const profileSchema = readJson(path.join(shared, "activity-recording-profile.schema.json"));
  assert.strictEqual(profileSchema.properties.retention.additionalProperties, false);
  assert.strictEqual(profileSchema.properties.redaction.additionalProperties, false);

  const receiptSchema = readJson(path.join(shared, "activity-receipt.schema.json"));
  assert.strictEqual(receiptSchema.additionalProperties, false);
  assert.ok(receiptSchema.properties.receipt_kind.enum.includes("commit_intent"));
  assert.ok(receiptSchema.properties.receipt_kind.enum.includes("commit_result"));
  assert.ok(receiptSchema.required.includes("dedupe_key"));

  const indexSchema = readJson(path.join(shared, "index.schema.json"));
  assert.ok(indexSchema.$id);
  assert.strictEqual(indexSchema.properties.schema_version.const, 1);
  assert.strictEqual(indexSchema.properties.events.items.additionalProperties, false);
  assert.strictEqual(indexSchema.properties.receipts.items.additionalProperties, false);
  assert.strictEqual(
    fs.readFileSync(path.join(local, "..", "skills", "activity-recording", "scripts", "index.js"), "utf8"),
    fs.readFileSync(path.join(shared, "..", "skills", "activity-recording", "scripts", "index.js"), "utf8")
  );
});

test("default recording profile declares policy without runtime health", () => {
  const profile = fs.readFileSync(path.join(root, "templates", "_shared", ".agent", "config", "activity-recording.yml"), "utf8");
  assert.match(profile, /policy: workflow-enforced/);
  assert.match(profile, /mode: unavailable/);
  assert.match(profile, /full_prompts: excluded/);
  assert.match(profile, /terminal_payloads: referenced/);
  assert.doesNotMatch(profile, /status: healthy/);
});
