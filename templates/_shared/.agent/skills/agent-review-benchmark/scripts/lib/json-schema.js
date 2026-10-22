"use strict";

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (draft 2020-12 subset)
// ---------------------------------------------------------------------------
// The finding contract has to be *enforceable*, not decorative: a reviewer
// backend that emits a finding the schema rejects must be able to detect it
// locally, before the artifact is attached to /ship or a Mission milestone.
//
// This repository ships zero npm dependencies, so `ajv` is not an option. This
// module implements exactly the keyword subset the Cortex review schemas use,
// and it *rejects* any schema that reaches for a keyword it does not
// implement. A silently ignored keyword is worse than no validator at all:
// it would let a broken schema pass as a working one.
//
// Supported keywords:
//   type (string | array), const, enum, required, properties,
//   additionalProperties (boolean), items, minItems, maxItems, uniqueItems,
//   minLength, maxLength, pattern, format ("date-time"), minimum, maximum
//
// Unsupported keywords are reported as errors rather than ignored, so a schema
// can never silently widen the contract it claims to describe.
// ---------------------------------------------------------------------------

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
]);

const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(expected, value) {
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "string") return typeof value === "string";
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "null") return value === null;
  return false;
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function stableKey(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// A schema that uses a keyword this validator does not implement would make the
// contract weaker than it reads. Collect them instead of ignoring them.
function unsupportedKeywords(schema, path = "#") {
  const found = [];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return found;
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      found.push({ path: `${path}/${key}`, keyword: key });
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, sub] of Object.entries(value)) {
        found.push(...unsupportedKeywords(sub, `${path}/properties/${name}`));
      }
    } else if (key === "items") {
      found.push(...unsupportedKeywords(value, `${path}/items`));
    }
  }
  return found;
}

function validateNode(schema, data, path, errors) {
  if (schema === true || schema === undefined || schema === null) return;
  if (typeof schema !== "object" || Array.isArray(schema)) {
    errors.push({ path, keyword: "schema", message: "schema must be an object" });
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const one of expected) {
      if (!SUPPORTED_TYPES.has(one)) {
        errors.push({ path, keyword: "type", message: `unsupported type "${one}"` });
        return;
      }
    }
    if (!expected.some((one) => matchesType(one, data))) {
      errors.push({ path, keyword: "type", message: `expected ${expected.join("|")}, got ${typeOf(data)}` });
      return;
    }
  }

  if (schema.const !== undefined && !deepEqual(schema.const, data)) {
    errors.push({ path, keyword: "const", message: `expected ${stableKey(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, data))) {
    errors.push({ path, keyword: "enum", message: `expected one of ${schema.enum.map(stableKey).join(", ")}` });
  }

  if (schema.type === "string" || typeof data === "string") {
    if (typeof data === "string") {
      if (typeof schema.minLength === "number" && data.length < schema.minLength) {
        errors.push({ path, keyword: "minLength", message: `shorter than ${schema.minLength}` });
      }
      if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
        errors.push({ path, keyword: "maxLength", message: `longer than ${schema.maxLength}` });
      }
      if (typeof schema.pattern === "string") {
        let expression = null;
        try {
          expression = new RegExp(schema.pattern);
        } catch (error) {
          errors.push({ path, keyword: "pattern", message: `invalid pattern: ${error.message}` });
        }
        if (expression && !expression.test(data)) {
          errors.push({ path, keyword: "pattern", message: `does not match ${schema.pattern}` });
        }
      }
      if (schema.format === "date-time" && !DATE_TIME.test(data)) {
        errors.push({ path, keyword: "format", message: "not an RFC 3339 date-time" });
      } else if (schema.format === "date-time" && Number.isNaN(Date.parse(data))) {
        errors.push({ path, keyword: "format", message: "not a parseable date-time" });
      }
    }
  }

  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push({ path, keyword: "minimum", message: `below ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push({ path, keyword: "maximum", message: `above ${schema.maximum}` });
    }
  }

  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push({ path, keyword: "minItems", message: `fewer than ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      errors.push({ path, keyword: "maxItems", message: `more than ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of data) {
        const key = stableKey(item);
        if (seen.has(key)) {
          errors.push({ path, keyword: "uniqueItems", message: "duplicate item" });
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      data.forEach((item, index) => validateNode(schema.items, item, `${path}/${index}`, errors));
    }
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(data, field)) {
          errors.push({ path: `${path}/${field}`, keyword: "required", message: "missing required property" });
        }
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(properties[key], value, `${path}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}/${key}`, keyword: "additionalProperties", message: "property not allowed" });
      }
    }
  }
}

/**
 * Validate `data` against `schema`.
 * @returns {{ ok: boolean, errors: Array<{path: string, keyword: string, message: string}> }}
 */
function validate(schema, data) {
  const errors = [];
  for (const entry of unsupportedKeywords(schema)) {
    errors.push({
      path: entry.path,
      keyword: "unsupported_keyword",
      message: `keyword "${entry.keyword}" is not implemented by this validator`,
    });
  }
  if (errors.length === 0) validateNode(schema, data, "#", errors);
  return { ok: errors.length === 0, errors };
}

/**
 * @returns {string[]} human readable one-line messages, one per violation.
 */
function formatErrors(errors) {
  return errors.map((entry) => `${entry.path}: ${entry.message} (${entry.keyword})`);
}

module.exports = { formatErrors, stableKey, validate };
