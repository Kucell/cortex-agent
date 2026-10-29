"use strict";

// ─── Coordination event schema migration ────────────────────────────────────
//
// A managed project holds its own copy of the coordination event schema, and
// the copy is not overwritten by an upgrade — the upgrade is additive by
// design, so a project never loses a local edit to a file the framework
// ships. That has a consequence: when the framework adds an event type,
// the project's copy keeps the old allow-list and starts rejecting a legal
// event.
//
// The migration here is the narrow thing that fixes that without giving up
// the protection:
//
//   * it only ever *adds* an event type to `eventType.enum`;
//   * it never removes or rewrites an entry the project has;
//   * it never touches any other part of the schema;
//   * it is idempotent — running it twice changes nothing the second time;
//   * it reports what it did, so the operator can see the difference.
//
// A file that is not a coordination event schema, or one whose `eventType`
// is not an enum, is left alone and reported as skipped. The migration never
// guesses: it reports what it could not do and why.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_RELATIVE = path.join(
  "coordination",
  "schemas",
  "coordination-event.schema.json",
);

/**
 * Add `eventTypes` to a coordination event schema's `eventType.enum`.
 *
 * Returns a report: `{ status, added, alreadyPresent, reason }`.
 *   - status "updated"  — the file was written, `added` lists the new types
 *   - status "unchanged" — every type was already present
 *   - status "skipped"  — the file is not a usable schema; `reason` says why
 */
function migrateEventSchema(schemaPath, eventTypes) {
  let raw;
  try {
    raw = fs.readFileSync(schemaPath, "utf8");
  } catch (error) {
    return { status: "skipped", added: [], alreadyPresent: [], reason: error.code || "read_failed" };
  }

  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (_) {
    return { status: "skipped", added: [], alreadyPresent: [], reason: "invalid_json" };
  }

  const eventType = schema && schema.properties && schema.properties.eventType;
  if (!eventType || !Array.isArray(eventType.enum)) {
    return { status: "skipped", added: [], alreadyPresent: [], reason: "not_an_event_type_enum" };
  }

  const existing = new Set(eventType.enum.filter((value) => typeof value === "string"));
  const added = [];
  const alreadyPresent = [];
  for (const type of eventTypes) {
    if (existing.has(type)) alreadyPresent.push(type);
    else {
      added.push(type);
      existing.add(type);
    }
  }

  if (added.length === 0) {
    return { status: "unchanged", added: [], alreadyPresent, reason: null };
  }

  // Only the allow-list grows. The order of the existing entries is kept so
  // the diff stays readable, and the new entries are appended in the order
  // they were requested.
  const merged = eventType.enum.concat(added);
  const next = { ...schema, properties: { ...schema.properties, eventType: { ...eventType, enum: merged } } };

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    return { status: "skipped", added: [], alreadyPresent, reason: error.code || "write_failed" };
  }

  return { status: "updated", added, alreadyPresent, reason: null };
}

/**
 * Migrate the coordination event schema of a project, if it has one.
 */
function migrateProjectEventSchema(projectRoot, eventTypes) {
  const schemaPath = path.join(path.resolve(projectRoot), ".agent", SCHEMA_RELATIVE);
  if (!fs.existsSync(schemaPath)) {
    return {
      status: "skipped",
      added: [],
      alreadyPresent: [],
      reason: "no_local_schema",
      path: schemaPath,
    };
  }
  const report = migrateEventSchema(schemaPath, eventTypes);
  return { ...report, path: schemaPath };
}

module.exports = {
  SCHEMA_RELATIVE,
  migrateEventSchema,
  migrateProjectEventSchema,
};
