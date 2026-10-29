"use strict";

// ---------------------------------------------------------------------------
// Coordination event schema migration.
//
// A managed project owns its copy of the coordination event schema, and the
// additive upgrade never rewrites it. So when the framework adds an event
// type, the project's copy keeps the old allow-list and starts rejecting a
// legal event — the framework's own recovery command would be unusable on
// the project that needs it.
//
// The migration fixes that without giving up the protection: it only adds
// to the allow-list, never removes or rewrites an entry, never touches any
// other part of the schema, and is idempotent.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  migrateEventSchema,
  migrateProjectEventSchema,
} = require(path.join(ROOT, "lib", "coordination", "schema-migration.js"));

function schemaFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-schema-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "coordination-event.schema.json");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

const BASE_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    eventType: { type: "string", enum: ["task.created", "task.progress"] },
    producer: { type: "object" },
  },
}, null, 2);

test("a missing event type is added to the allow-list", (t) => {
  const file = schemaFile(t, BASE_SCHEMA);
  const report = migrateEventSchema(file, ["task.created", "ownership.rebound"]);

  assert.equal(report.status, "updated");
  assert.deepEqual(report.added, ["ownership.rebound"]);
  assert.deepEqual(report.alreadyPresent, ["task.created"]);

  const schema = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(schema.properties.eventType.enum.includes("ownership.rebound"));
  // The existing entries keep their order and are not rewritten.
  assert.deepEqual(
    schema.properties.eventType.enum,
    ["task.created", "task.progress", "ownership.rebound"],
  );
});

test("the migration is idempotent", (t) => {
  const file = schemaFile(t, BASE_SCHEMA);
  migrateEventSchema(file, ["ownership.rebound"]);
  const afterFirst = fs.readFileSync(file, "utf8");

  const second = migrateEventSchema(file, ["ownership.rebound"]);
  assert.equal(second.status, "unchanged");
  assert.deepEqual(second.added, []);
  assert.equal(fs.readFileSync(file, "utf8"), afterFirst, "a second run changes nothing");
});

test("an entry the project added is never removed", (t) => {
  const withLocal = JSON.stringify({
    properties: {
      eventType: { enum: ["task.created", "local.only.event"] },
    },
  }, null, 2);
  const file = schemaFile(t, withLocal);
  const report = migrateEventSchema(file, ["ownership.rebound"]);

  assert.equal(report.status, "updated");
  const schema = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(schema.properties.eventType.enum.includes("local.only.event"));
  assert.ok(schema.properties.eventType.enum.includes("ownership.rebound"));
});

test("no other part of the schema is touched", (t) => {
  const file = schemaFile(t, BASE_SCHEMA);
  migrateEventSchema(file, ["ownership.rebound"]);
  const schema = JSON.parse(fs.readFileSync(file, "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.properties.producer, { type: "object" });
  assert.equal(schema.properties.eventType.type, "string");
});

test("a file that is not an event schema is skipped, not rewritten", (t) => {
  const original = JSON.stringify({ properties: { somethingElse: { type: "string" } } }, null, 2);
  const file = schemaFile(t, original);
  const report = migrateEventSchema(file, ["ownership.rebound"]);

  assert.equal(report.status, "skipped");
  assert.equal(report.reason, "not_an_event_type_enum");
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("an invalid JSON file is skipped, not rewritten", (t) => {
  const original = "{ not json";
  const file = schemaFile(t, original);
  const report = migrateEventSchema(file, ["ownership.rebound"]);

  assert.equal(report.status, "skipped");
  assert.equal(report.reason, "invalid_json");
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("a project without a local schema is reported, not created", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-schema-project-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const report = migrateProjectEventSchema(dir, ["ownership.rebound"]);
  assert.equal(report.status, "skipped");
  assert.equal(report.reason, "no_local_schema");
  assert.equal(
    fs.existsSync(path.join(dir, ".agent", "coordination", "schemas", "coordination-event.schema.json")),
    false,
  );
});

test("the shipped template schema already carries every runtime event type", () => {
  // The migration exists for projects whose copy lags. The template the
  // framework ships must never lag: a fresh install gets the current
  // allow-list without a migration.
  const { EVENT_TYPES } = require(path.join(ROOT, "lib", "coordination", "contract.js"));
  const template = JSON.parse(fs.readFileSync(
    path.join(ROOT, "templates", "_shared", ".agent", "coordination", "schemas", "coordination-event.schema.json"),
    "utf8",
  ));
  const allowed = new Set(template.properties.eventType.enum);
  for (const type of EVENT_TYPES) {
    assert.ok(allowed.has(type), `${type} is in the shipped schema`);
  }
});
