"use strict";

// ─── Coordination event schema parity ─────────────────────────────────────
//
// The event envelope schema that ships to every managed project
// (templates/_shared/.agent/coordination/schemas/coordination-event.schema.json)
// carries its own copy of the event type enum. That copy is what a project
// sees, and what `cortex-agent upgrade` writes into its .agent/. Nothing in
// the runtime reads it — the runtime validates against EVENT_TYPES in
// lib/coordination/contract.js — so the two can drift apart silently.
//
// That already happened once: `ownership.rebound` was added to the runtime
// contract but not to the shipped schema, so a project that upgraded would
// have had a schema that rejected a legal event type.
//
// This test binds the two lists together. Adding an event type to the runtime
// without shipping it in the template now fails here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { EVENT_TYPES } = require("../../lib/coordination/contract");

const root = path.resolve(__dirname, "..", "..");
const schemaPath = path.join(
  root,
  "templates",
  "_shared",
  ".agent",
  "coordination",
  "schemas",
  "coordination-event.schema.json"
);

function readSchemaEventTypes() {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const properties = schema.properties || {};
  const eventType = properties.eventType;
  assert.ok(eventType, "event envelope schema must declare an eventType property");
  assert.ok(Array.isArray(eventType.enum), "eventType must carry an enum of event types");
  return eventType.enum;
}

test("the shipped event envelope schema accepts every runtime event type", () => {
  const shipped = readSchemaEventTypes();
  const missing = EVENT_TYPES.filter((type) => !shipped.includes(type));
  assert.deepEqual(
    missing,
    [],
    `event types missing from the shipped schema: ${missing.join(", ")}. ` +
      "A managed project would reject a legal event type."
  );
});

test("the shipped event envelope schema declares no event type the runtime does not know", () => {
  const shipped = readSchemaEventTypes();
  const unknown = shipped.filter((type) => !EVENT_TYPES.includes(type));
  assert.deepEqual(
    unknown,
    [],
    `event types shipped in the schema but unknown to the runtime: ${unknown.join(", ")}`
  );
});

test("the shipped event envelope schema carries no duplicate event type", () => {
  const shipped = readSchemaEventTypes();
  const seen = new Set();
  const duplicates = shipped.filter((type) => {
    if (seen.has(type)) return true;
    seen.add(type);
    return false;
  });
  assert.deepEqual(duplicates, [], `duplicate event types in the shipped schema: ${duplicates.join(", ")}`);
});
