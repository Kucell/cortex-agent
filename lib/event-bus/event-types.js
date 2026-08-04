"use strict";

/**
 * lib/event-bus/event-types.js
 *
 * Event type registry + lightweight JSON Schema (draft-07 subset) validator.
 *
 * Zero npm dependencies - uses only Node.js built-ins (node:fs, node:path,
 * node:crypto).  The schema .json files in ./schemas/ are the authoritative
 * contract; this module loads and validates against them at runtime.
 *
 * References:
 *   - docs/architecture/framework-event-bus-design.md §3.2 (8 core events)
 *   - .agent/missions/M-004/validation-contract.json VC-002
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMAS_DIR = path.join(__dirname, "schemas");

/** The 8 core event names (extension events use the `custom:` prefix). */
const CORE_EVENT_NAMES = [
  "subagent_spawned",
  "subagent_progress",
  "subagent_completed",
  "subagent_failed",
  "subagent_cancelled",
  "handoff_ready",
  "decision_resolved",
  "waitpoint_released",
];

/** Events whose delivery requires an explicit ack (per §3.2 table). */
const ACK_REQUIRED_EVENTS = new Set([
  "subagent_completed",
  "subagent_failed",
]);

const EVENT_VERSION = "1.0";

const EVENT_ID_PREFIX = "eb-evt-";

// ---------------------------------------------------------------------------
// Schema loading (lazy, cached)
// ---------------------------------------------------------------------------

const _schemaCache = new Map();

/**
 * Load a JSON Schema file by short name.
 * @param {string} name - "envelope" | "subagent_spawned" | ... | "extension"
 * @returns {object} parsed schema
 */
function loadSchema(name) {
  if (_schemaCache.has(name)) return _schemaCache.get(name);
  const file = path.join(SCHEMAS_DIR, `${name}.schema.json`);
  const raw = fs.readFileSync(file, "utf8");
  const schema = JSON.parse(raw);
  _schemaCache.set(name, schema);
  return schema;
}

/**
 * Return the payload schema for a given event_name.
 * Core events map to their dedicated schema; `custom:*` events map to the
 * extension template.
 * @param {string} eventName
 * @returns {object} JSON Schema for the payload
 */
function getPayloadSchema(eventName) {
  if (eventName.startsWith("custom:")) return loadSchema("extension");
  if (CORE_EVENT_NAMES.includes(eventName)) return loadSchema(eventName);
  throw new Error(`Unknown event_name: ${eventName}`);
}

/**
 * Return all available schema short names (for enumeration / testing).
 * @returns {string[]}
 */
function listSchemas() {
  return ["envelope", "extension", ...CORE_EVENT_NAMES];
}

// ---------------------------------------------------------------------------
// Event ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a new event_id (`eb-evt-<uuid-v4>`).
 * @returns {string}
 */
function generateEventId() {
  return EVENT_ID_PREFIX + crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Lightweight JSON Schema (draft-07 subset) validator
// ---------------------------------------------------------------------------

/**
 * Validate `value` against a JSON Schema fragment.
 *
 * Supports the subset used by our schemas:
 *   - type: string | integer | number | boolean | array | object | null
 *   - type: [type, "null"]  (nullable)
 *   - enum
 *   - required
 *   - additionalProperties: false (reject unknown keys)
 *   - properties
 *   - items (for arrays)
 *   - pattern (regex)
 *   - minimum / maximum
 *   - $ref "#/definitions/<name>"
 *
 * @param {*} value
 * @param {object} schema - JSON Schema fragment
 * @param {object} [root] - root schema for $ref resolution
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSchema(value, schema, root) {
  root = root || schema;
  const errors = [];

  // $ref resolution
  if (schema.$ref) {
    const refResult = resolveRef(value, schema.$ref, root);
    if (!refResult.valid) errors.push(...refResult.errors);
    return { valid: errors.length === 0, errors };
  }

  // enum
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errors.push(`Expected one of [${schema.enum.join(", ")}] but got ${JSON.stringify(value)}`);
    }
    return { valid: errors.length === 0, errors };
  }

  // type
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matched = types.some((t) => checkType(value, t));
    if (!matched) {
      errors.push(`Expected type ${types.join("|")} but got ${actualType(value)}`);
      return { valid: false, errors };
    }
  }

  // For integers, exclude booleans
  if ((schema.type === "integer" || (Array.isArray(schema.type) && schema.type.includes("integer"))) && typeof value === "boolean") {
    errors.push("Expected integer but got boolean");
    return { valid: false, errors };
  }

  // pattern (strings only)
  if (schema.pattern && typeof value === "string") {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) {
      errors.push(`String does not match pattern ${schema.pattern}`);
    }
  }

  // minimum / maximum (numbers)
  if (typeof value === "number" && !Number.isNaN(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`Value ${value} is below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`Value ${value} exceeds maximum ${schema.maximum}`);
    }
  }

  // object validation
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    // required
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in value)) {
          errors.push(`Missing required property: ${field}`);
        }
      }
    }

    // additionalProperties: false
    if (schema.additionalProperties === false && schema.properties) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push(`Unknown property: ${key}`);
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          const sub = validateSchema(value[key], subSchema, root);
          if (!sub.valid) {
            for (const e of sub.errors) errors.push(`properties.${key}: ${e}`);
          }
        }
      }
    }
  }

  // array validation
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const sub = validateSchema(value[i], schema.items, root);
      if (!sub.valid) {
        for (const e of sub.errors) errors.push(`items[${i}]: ${e}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function resolveRef(value, ref, root) {
  if (!ref.startsWith("#/")) return { valid: false, errors: [`Cannot resolve $ref: ${ref}`] };
  const parts = ref.slice(2).split("/");
  let node = root;
  for (const p of parts) {
    if (node && typeof node === "object" && p in node) {
      node = node[p];
    } else {
      return { valid: false, errors: [`Cannot resolve $ref path: ${ref}`] };
    }
  }
  return validateSchema(value, node, root);
}

function checkType(value, type) {
  switch (type) {
    case "string":  return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number":  return typeof value === "number" && !Number.isNaN(value);
    case "boolean": return typeof value === "boolean";
    case "array":   return Array.isArray(value);
    case "object":  return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":    return value === null;
    default:        return true; // unknown types pass
  }
}

function actualType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Public validation API
// ---------------------------------------------------------------------------

/**
 * Validate a full event envelope (including payload).
 * @param {object} event - the event object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEvent(event) {
  const errors = [];

  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return { valid: false, errors: ["Event must be an object"] };
  }

  // 1. Envelope validation
  const envelopeSchema = loadSchema("envelope");
  const envResult = validateSchema(event, envelopeSchema);
  if (!envResult.valid) {
    errors.push(...envResult.errors);
  }

  // 2. Payload validation (only if event_name is present and valid)
  const eventName = event.event_name;
  if (typeof eventName === "string" && eventName.length > 0) {
    try {
      const payloadSchema = getPayloadSchema(eventName);
      if (event.payload !== undefined) {
        const payResult = validateSchema(event.payload, payloadSchema);
        if (!payResult.valid) {
          for (const e of payResult.errors) errors.push(`payload: ${e}`);
        }
      }
    } catch {
      // Unknown event_name already caught by envelope pattern; skip
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate only the payload for a given event_name.
 * @param {string} eventName
 * @param {object} payload
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePayload(eventName, payload) {
  try {
    const schema = getPayloadSchema(eventName);
    return validateSchema(payload, schema);
  } catch (err) {
    return { valid: false, errors: [err.message] };
  }
}

/**
 * Check whether an event_name requires an explicit ack.
 * @param {string} eventName
 * @returns {boolean}
 */
function requiresAck(eventName) {
  return ACK_REQUIRED_EVENTS.has(eventName);
}

/**
 * Check whether an event_name is a known core event or valid custom extension.
 * @param {string} eventName
 * @returns {boolean}
 */
function isKnownEvent(eventName) {
  return CORE_EVENT_NAMES.includes(eventName) || eventName.startsWith("custom:");
}

/**
 * Build a valid event envelope from raw input (used by publish).
 * @param {object} input - { event_name, payload, correlation? }
 * @param {object} ctx    - { producer, sessionId?, busId, missionId?, subagentId?, parentRunId?, causationId? }
 * @returns {object} fully-formed event
 */
function buildEvent(input, ctx) {
  const eventName = input.event_name;
  if (!isKnownEvent(eventName)) {
    throw new Error(`Unknown event_name: ${eventName}`);
  }

  const event = {
    event_id: generateEventId(),
    event_name: eventName,
    event_version: EVENT_VERSION,
    bus_id: ctx.busId,
    occurred_at: new Date().toISOString(),
    producer: {
      producer_id: ctx.producer.producer_id,
      producer_kind: ctx.producer.producer_kind,
      session_id: ctx.producer.session_id || null,
    },
    correlation: {
      mission_id: ctx.missionId || "global",
      subagent_id: ctx.subagentId || "host",
      parent_run_id: ctx.parentRunId || "global",
      causation_id: ctx.causationId || null,
    },
    payload: input.payload || {},
  };

  return event;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  CORE_EVENT_NAMES,
  ACK_REQUIRED_EVENTS,
  EVENT_VERSION,
  EVENT_ID_PREFIX,
  SCHEMAS_DIR,

  // Schema loading
  loadSchema,
  getPayloadSchema,
  listSchemas,

  // Event ID
  generateEventId,

  // Validation
  validateEvent,
  validatePayload,
  validateSchema,
  requiresAck,
  isKnownEvent,

  // Building
  buildEvent,
};
