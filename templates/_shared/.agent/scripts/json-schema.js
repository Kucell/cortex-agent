"use strict";

// ─── json-schema (dependency-free JSON Schema subset validator) ────────────
//
// The repository's only JSON Schema subset implementation.
//
// It validates a record against a schema document. Two schemas use it:
//
//   - `.agent/tasks/task.schema.json`      — the task record contract
//   - `.agent/missions/mission.schema.json` — the mission record contract
//
// Zero runtime dependencies, so it implements only the keywords those schemas
// actually use. An unknown keyword in the schema is reported as an error
// rather than ignored: a silently skipped constraint would let a non-compliant
// record pass the gate.
//
// This file is L1: it ships to every managed project, so a project can
// validate its own task records after an upgrade without depending on the
// framework repository. The governance repository keeps a byte-identical copy
// under `.agent/scripts/json-schema.js`.

const fs = require("fs");
const path = require("path");

const SUPPORTED_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "type", "required", "properties",
  "additionalProperties", "enum", "const", "pattern", "minItems", "minLength",
  "items", "format", "uniqueItems",
  // Reference + annotation keywords. `$ref` is resolved against the root
  // schema; `$defs` and `default` are containers/annotations and carry no
  // instance constraint.
  "$ref", "$defs", "default",
]);

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// Resolve a local JSON pointer reference (`#/$defs/stage`) against the root
// schema. Returns null when the pointer does not resolve — the caller reports
// that as an error rather than skipping the constraint.
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = root;
  for (const part of parts) {
    if (!node || typeof node !== "object" || !(part in node)) return null;
    node = node[part];
  }
  return node;
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

// Validate a value against a schema node.
//
// `root` is the document the schema belongs to; it is what `$ref` resolves
// against. `errors` is collected, never thrown, so a caller can report every
// violation of a record in one pass instead of fixing them one run at a time.
function validate(value, schema, pointer, errors, schemaPath, root) {
  // A schema node may be a reference to a shared definition. Resolve it
  // against the root schema and validate against the target instead.
  if (schema && typeof schema.$ref === "string") {
    const target = root ? resolveRef(schema.$ref, root) : null;
    if (!target) {
      errors.push(`${pointer || "#"}: cannot resolve schema reference "${schema.$ref}" (${schemaPath})`);
      return errors;
    }
    return validate(value, target, pointer, errors, schemaPath, root);
  }

  for (const keyword of Object.keys(schema || {})) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      errors.push(`${pointer || "#"}: unsupported schema keyword "${keyword}" (${schemaPath})`);
    }
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((type) => matchesType(value, type))) {
      errors.push(`${pointer || "#"}: expected type ${expected.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer || "#"}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${pointer || "#"}: value ${JSON.stringify(value)} is not in enum`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer || "#"}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pointer || "#"}: string does not match pattern ${schema.pattern}`);
    }
    if (schema.format === "date-time" && !DATE_TIME_RE.test(value)) {
      errors.push(`${pointer || "#"}: string is not a valid date-time`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer || "#"}: array has ${value.length} items, minItems is ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) {
        errors.push(`${pointer || "#"}: array items are not unique`);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validate(item, schema.items, `${pointer}/${index}`, errors, schemaPath, root);
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${pointer || "#"}: missing required property "${key}"`);
      }
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          errors.push(`${pointer || "#"}: unexpected property "${key}"`);
        }
        continue;
      }
      validate(child, childSchema, `${pointer}/${key}`, errors, schemaPath, root);
    }
  }

  return errors;
}

// Validate one record against a schema document.
// Returns { ok, errors }.
function validateRecord(record, schema, schemaPath = "schema.json") {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["#: record must be a JSON object"] };
  }
  const errors = [];
  validate(record, schema, "", errors, schemaPath, schema);
  return { ok: errors.length === 0, errors };
}

// Read and parse a schema document. Returns null when the file is absent.
function loadSchema(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

module.exports = {
  validate,
  validateRecord,
  resolveRef,
  loadSchema,
  SUPPORTED_KEYWORDS,
};
