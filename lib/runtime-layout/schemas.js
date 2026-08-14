"use strict";

// ─── Runtime Layout Identity / URI / Local-Binding Schemas (M-026 MS-001) ──
//
// Frozen contract surface for the M-026 P-001 "Runtime 目录、身份与路径契约"
// revision `c8e0f0226caca0499ae7a6fa48923b8b5d6e4160d269888115aa51311982c28a`.
// These schemas are deliberately minimal — they only need to give the
// runtime layout resolver a closed, deterministic vocabulary so callers
// cannot accidentally feed it a path-bearing identity, an opaque absolute
// path or an out-of-vocabulary logical URI. Schemas are intentionally NOT
// JSON-Schema draft-2020-12: we use the existing ajv-free validator used by
// lib/coordination/schemas.js so we don't pull in a new dependency.
//
// Vocabulary reference:
//   • project_id            — stable across machines; not derived from the
//                             resolved on-disk root or worktree_path.
//   • repository_id         — stable across machines for one repository.
//   • workspace_id          — logical task/branch workspace (WS-… pattern).
//   • machine_id            — opaque per-host identity; never equals a
//                             username, hostname, or absolute path.
//   • workspace_instance_id — `${machine_id}::${workspace_id}`; unique per
//                             checkout of one logical workspace on one host.
//
// Logical URI schemes (per P-001 §4):
//   project://, repo://, workspace://, agent://, runtime://, artifact://
//
// All schemes use '/' as the path separator, NFC-normalised segments, and
// percent-encoded reserved characters. Absolute paths are NEVER accepted in
// any identity or URI — those are the only places local-binding can land.

const ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID_SAFE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const REPOSITORY_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_ID_SAFE = /^WS-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MACHINE_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const SCHEME_SAFE = /^[a-z][a-z0-9+.-]*$/;
// RFC 3986 `pchar`: unreserved + percent-encoded + sub-delims + ':' + '@'.
const URI_PATH_SEGMENT_SAFE = /^(?!\.{1,2}$)[A-Za-z0-9._~%!$&'()*+,;=:@-]{1,128}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const MAX_PROJECT_ID_LEN = 128;
const MAX_REPOSITORY_ID_LEN = 128;
const MAX_WORKSPACE_ID_LEN = 128;
const MAX_MACHINE_ID_LEN = 64;
const MAX_INSTANCE_ID_LEN = 192;
const MAX_URI_LEN = 2048;

const IDENTITY_KINDS = new Set([
  "project_id",
  "repository_id",
  "workspace_id",
  "machine_id",
  "workspace_instance_id",
]);

const URI_SCHEMES = Object.freeze({
  project: "project",
  repo: "repo",
  workspace: "workspace",
  agent: "agent",
  runtime: "runtime",
  artifact: "artifact",
});

const URI_SCHEME_LIST = Object.freeze(Object.values(URI_SCHEMES));

// ─── Lightweight validator (mirrors lib/coordination/schemas.js) ───────────
//
// The validator only needs to surface the small subset of JSON Schema
// that the runtime-layout / local-binding contracts actually use:
//   * type as a string OR a list of strings (the only union we honour is
//     `["string", "null"]` for `workspace_instance_id`, which must be
//     validated without weakening the rest of the envelope).
//   * required, additionalProperties, properties.
//   * for strings: minLength, maxLength, pattern, enum.
//   * for arrays: items (which may itself be a full object schema), maxItems.
//   * for nested objects: full recursive validation; item properties
//     participate in the same pattern/minLength/maxLength/required chain.
//
// Anything outside that subset is intentionally left to the contract
// authors to assert explicitly via the `required`/`additionalProperties`
// fields; the validator is the runtime-layout's ajv-free mirror, not a
// generic draft-2020-12 implementation.

function valueTypeMatches(def, value) {
  // Single-type specifier.
  if (typeof def.type === "string") {
    return valueMatchesType(def.type, value);
  }
  // Union (e.g. ["string", "null"]). Every branch must independently
  // pass; otherwise we fall back to the legacy "any non-null" check.
  if (Array.isArray(def.type)) {
    if (def.type.includes("null") && value === null) return true;
    for (const branch of def.type) {
      if (branch === "null") continue;
      if (typeof branch === "string" && valueMatchesType(branch, value)) {
        return true;
      }
    }
    return false;
  }
  return false;
}

function valueMatchesType(type, value) {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return false;
}

function describeTypeMismatch(def, value) {
  if (Array.isArray(def.type)) {
    return `must be one of ${def.type.join("|")}`;
  }
  return `must be ${def.type}`;
}

function validateNestedProperties(def, value) {
  const errors = [];
  const subResult = validateAgainst(def, value);
  if (!subResult.ok) errors.push(...subResult.errors);
  return errors;
}

function compilePattern(pattern) {
  if (!pattern) return null;
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern === "string") {
    try { return new RegExp(pattern); } catch { return null; }
  }
  return null;
}

function validateAgainst(schema, obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["root: must be object"] };
  }
  const errors = [];
  for (const req of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(obj, req)) {
      errors.push(`missing required: ${req}`);
    }
  }
  if (schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(obj)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        errors.push(`additional property not allowed: ${key}`);
      }
    }
  }
  if (schema.properties) {
    for (const [key, def] of Object.entries(schema.properties)) {
      const v = obj[key];
      if (v === undefined) continue;
      // null must always run through the type check: only a union whose
      // type list explicitly contains "null" (e.g. ["string", "null"])
      // may accept it. Non-nullable fields (type === "string" etc.) must
      // fail closed when the caller supplies an explicit null — JSON
      // Schema considers a present-but-null property as supplied, not
      // missing, so the `required` check above does not cover this case.
      if (def.type !== undefined && !valueTypeMatches(def, v)) {
        errors.push(`${key}: ${describeTypeMismatch(def, v)}`);
        continue;
      }
      if (def.enum && !def.enum.includes(v)) {
        errors.push(`${key}: must be one of ${def.enum.join(",")}`);
      }
      if (typeof v === "string") {
        const compiledPattern = compilePattern(def.pattern);
        if (compiledPattern && !compiledPattern.test(v)) {
          errors.push(`${key}: must match ${def.pattern}`);
        }
        if (def.minLength !== undefined && v.length < def.minLength) {
          errors.push(`${key}: shorter than ${def.minLength}`);
        }
        if (def.maxLength !== undefined && v.length > def.maxLength) {
          errors.push(`${key}: longer than ${def.maxLength}`);
        }
      }
      if (def.type === "object" && def.properties && typeof v === "object" && v !== null) {
        const subErrors = validateNestedProperties(def, v);
        if (subErrors.length > 0) errors.push(`${key}: ${subErrors.join(", ")}`);
      }
      if (def.type === "array" && Array.isArray(v)) {
        if (def.maxItems !== undefined && v.length > def.maxItems) {
          errors.push(`${key}: must have at most ${def.maxItems} items`);
        }
        if (def.items) {
          v.forEach((entry, index) => {
            const itemDef = def.items;
            if (itemDef.type !== undefined && !valueTypeMatches(itemDef, entry)) {
              if (Array.isArray(itemDef.type)) {
                errors.push(`${key}[${index}]: must be one of ${itemDef.type.join("|")}`);
              } else {
                errors.push(`${key}[${index}]: must be ${itemDef.type}`);
              }
              return;
            }
            if (itemDef.type === "object" && itemDef.properties && typeof entry === "object" && entry !== null) {
              const subErrors = validateNestedProperties(itemDef, entry);
              if (subErrors.length > 0) errors.push(`${key}[${index}]: ${subErrors.join(", ")}`);
            }
          });
        }
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const identityRecordSchema = Object.freeze({
  $id: "cortex-agent/runtime-layout/identity-record",
  type: "object",
  required: ["kind", "value"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: Array.from(IDENTITY_KINDS) },
    value: { type: "string", minLength: 1, maxLength: MAX_INSTANCE_ID_LEN },
  },
});

const logicalUriSchema = Object.freeze({
  $id: "cortex-agent/runtime-layout/logical-uri",
  type: "object",
  required: ["scheme", "path"],
  additionalProperties: false,
  properties: {
    scheme: { type: "string", enum: URI_SCHEME_LIST },
    path: { type: "string", minLength: 1, maxLength: MAX_URI_LEN },
  },
});

const localBindingSchema = Object.freeze({
  $id: "cortex-agent/runtime-layout/local-binding",
  type: "object",
  required: ["schema_version", "machine_id", "bindings", "updated_at"],
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", minLength: 1 },
    machine_id: { type: "string", minLength: 1, maxLength: MAX_MACHINE_ID_LEN },
    bindings: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        required: ["workspace_id", "absolute_path", "captured_at"],
        additionalProperties: false,
        properties: {
          workspace_id: {
            type: "string",
            pattern: "^WS-[A-Za-z0-9][A-Za-z0-9._-]*$",
          },
          workspace_instance_id: {
            type: ["string", "null"],
            maxLength: 256,
          },
          absolute_path: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description: "Absolute POSIX path, Windows drive path, or UNC path. Bindings never cross to another machine.",
          },
          captured_at: { type: "string", maxLength: 64 },
        },
      },
    },
    updated_at: { type: "string", minLength: 1, maxLength: 64 },
  },
});

module.exports = {
  IDENTITY_KINDS,
  ID_SAFE,
  PROJECT_ID_SAFE,
  REPOSITORY_ID_SAFE,
  WORKSPACE_ID_SAFE,
  MACHINE_ID_SAFE,
  SCHEME_SAFE,
  URI_PATH_SEGMENT_SAFE,
  URI_SCHEMES,
  URI_SCHEME_LIST,
  CONTROL_CHARS,
  MAX_PROJECT_ID_LEN,
  MAX_REPOSITORY_ID_LEN,
  MAX_WORKSPACE_ID_LEN,
  MAX_MACHINE_ID_LEN,
  MAX_INSTANCE_ID_LEN,
  MAX_URI_LEN,
  identityRecordSchema,
  logicalUriSchema,
  localBindingSchema,
  validateAgainst,
  validateIdentityRecord(value) {
    return validateAgainst(identityRecordSchema, value);
  },
  validateLogicalUri(value) {
    return validateAgainst(logicalUriSchema, value);
  },
  validateLocalBinding(value) {
    return validateAgainst(localBindingSchema, value);
  },
};