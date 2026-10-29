"use strict";

// Package-owned data validators only. Never load a project schema or execute
// project code. This module validates syntax; it does not establish provenance.
const crypto = require("node:crypto");
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
class CanonicalControlError extends Error {
  constructor(code) { super(code); this.name = "CanonicalControlError"; this.code = code; }
}
function check(value, code) { if (!value) throw new CanonicalControlError(code); }
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
function digest(text) { return "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
function freeze(v) {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function clone(value) {
  const ancestors = new Set(); let nodes = 0;
  function copy(v, depth) {
    check(++nodes <= 20000 && depth <= 30, "CONTROL_DATA_LIMIT");
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    check(v && typeof v === "object" && !ancestors.has(v), "CONTROL_INVALID_DATA");
    const array = Array.isArray(v);
    check(array || [Object.prototype, null].includes(Object.getPrototypeOf(v)), "CONTROL_INVALID_DATA");
    check(Object.getOwnPropertySymbols(v).length === 0, "CONTROL_INVALID_DATA");
    ancestors.add(v);
    const ds = Object.getOwnPropertyDescriptors(v), result = array ? [] : Object.create(null);
    if (array) check(Object.keys(ds).length === v.length + 1, "CONTROL_INVALID_DATA");
    for (const [k, d] of Object.entries(ds)) {
      if (array && k === "length") continue;
      check(own(d, "value") && d.enumerable && !["__proto__", "prototype", "constructor"].includes(k), "CONTROL_INVALID_DATA");
      if (array) check(/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < v.length, "CONTROL_INVALID_DATA");
      result[k] = copy(d.value, depth + 1);
    }
    ancestors.delete(v); return result;
  }
  const result = copy(value, 0);
  check(Buffer.byteLength(stable(result), "utf8") <= 262144, "CONTROL_DATA_LIMIT");
  return result;
}
function parse(text) {
  check(typeof text === "string" && Buffer.byteLength(text, "utf8") <= 65536, "CONTROL_JSON_LIMIT");
  check(Buffer.from(text, "utf8").toString("utf8") === text, "CONTROL_INVALID_UTF8");
  let at = 0;
  const bad = () => { throw new CanonicalControlError("CONTROL_INVALID_JSON"); };
  function ws() { while (at < text.length && /[ \t\r\n]/.test(text[at])) at++; }
  function str() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at++] === '"') { try { return JSON.parse(text.slice(start, at)); } catch (_) { bad(); } }
    }
    bad();
  }
  function value(depth) {
    if (depth > 30) bad(); ws();
    if (text[at] === '"') return str();
    if (text[at] === "{") {
      at++; const out = Object.create(null); ws();
      if (text[at] === "}") { at++; return out; }
      while (at < text.length) {
        ws(); if (text[at] !== '"') bad(); const k = str();
        if (own(out, k) || ["__proto__", "prototype", "constructor"].includes(k)) bad();
        ws(); if (text[at++] !== ":") bad(); out[k] = value(depth + 1); ws();
        const sep = text[at++]; if (sep === "}") return out; if (sep !== ",") bad();
      } bad();
    }
    if (text[at] === "[") {
      at++; const out = []; ws();
      if (text[at] === "]") { at++; return out; }
      while (at < text.length) {
        out.push(value(depth + 1)); ws(); const sep = text[at++];
        if (sep === "]") return out; if (sep !== ",") bad();
      } bad();
    }
    const m = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!m) bad(); at += m[0].length;
    const v = JSON.parse(m[0]); if (typeof v === "number" && !Number.isFinite(v)) bad(); return v;
  }
  const result = value(0); ws(); if (at !== text.length) bad();
  return clone(result);
}
function epoch(v) {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)) return NaN;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v.replace(/Z$/, v.includes(".") ? "Z" : ".000Z") ? ms : NaN;
}
const KEYWORDS = new Set(["$schema", "$id", "$defs", "$ref", "title", "description", "default",
  "type", "const", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern", "format",
  "minItems", "maxItems", "uniqueItems", "items", "required", "properties", "additionalProperties", "allOf", "if", "then"]);
function validate(schema, input, root = schema) {
  for (const k of Object.keys(schema)) check(KEYWORDS.has(k), "CONTROL_UNSUPPORTED_SCHEMA");
  if (schema.$ref) {
    check(/^#\/\$defs\/[A-Za-z0-9_-]+$/.test(schema.$ref), "CONTROL_UNSUPPORTED_SCHEMA");
    const target = root.$defs && root.$defs[schema.$ref.slice(8)];
    check(target, "CONTROL_UNSUPPORTED_SCHEMA"); validate(target, input, root);
  }
  const type = input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
  if (schema.type) check([].concat(schema.type).some(t => t === type || (t === "integer" && Number.isSafeInteger(input))), "CONTROL_SCHEMA");
  if (own(schema, "const")) check(stable(input) === stable(schema.const), "CONTROL_SCHEMA");
  if (schema.enum) check(schema.enum.some(v => stable(v) === stable(input)), "CONTROL_SCHEMA");
  if (typeof input === "number") {
    if (schema.minimum != null) check(input >= schema.minimum, "CONTROL_SCHEMA");
    if (schema.maximum != null) check(input <= schema.maximum, "CONTROL_SCHEMA");
  }
  if (typeof input === "string") {
    if (schema.minLength != null) check(input.length >= schema.minLength, "CONTROL_SCHEMA");
    if (schema.maxLength != null) check(input.length <= schema.maxLength, "CONTROL_SCHEMA");
    if (schema.pattern) check(new RegExp(schema.pattern).test(input), "CONTROL_SCHEMA");
    if (schema.format) check(schema.format === "date-time" && Number.isFinite(epoch(input)), "CONTROL_SCHEMA");
  }
  if (Array.isArray(input)) {
    if (schema.minItems != null) check(input.length >= schema.minItems, "CONTROL_SCHEMA");
    if (schema.maxItems != null) check(input.length <= schema.maxItems, "CONTROL_SCHEMA");
    if (schema.uniqueItems) check(new Set(input.map(stable)).size === input.length, "CONTROL_SCHEMA");
    if (schema.items) input.forEach(v => validate(schema.items, v, root));
  } else if (input !== null && typeof input === "object") {
    for (const k of schema.required || []) check(own(input, k), "CONTROL_SCHEMA");
    if (schema.additionalProperties === false) for (const k of Object.keys(input)) check(own(schema.properties || {}, k), "CONTROL_SCHEMA");
    for (const [k, v] of Object.entries(schema.properties || {})) if (own(input, k)) validate(v, input[k], root);
  }
  for (const s of schema.allOf || []) validate(s, input, root);
  if (schema.if) {
    let match = true;
    try { validate(schema.if, input, root); } catch (e) { if (e.code !== "CONTROL_SCHEMA") throw e; match = false; }
    if (match && schema.then) validate(schema.then, input, root);
  }
  return input;
}
function record(schema, text) { return validate(schema, parse(text)); }
function json(value) { return stable(value) + "\n"; }

function validateManifest(input) {
  const m = clone(input), defs = require("./canonical-control.schema.json").$defs;
  validate(defs.manifest, m);
  check(Buffer.byteLength(json(m), "utf8") <= 65536, "CONTROL_MANIFEST_LIMIT");
  check(m.backend.authority_ref === "refs/heads/cortex-authority/" + m.project_id, "CONTROL_MANIFEST_BACKEND");
  check(!/^0+$/.test(m.product_repository.head_sha) && m.backend.repository_id !== m.product_repository.id &&
    m.backend.repository !== m.product_repository.name, "CONTROL_MANIFEST_REPOSITORIES");
  check(epoch(m.valid_from) < epoch(m.expires_at), "CONTROL_MANIFEST_TIME");
  check(!/[\u0000-\u001f\u007f]/.test(m.project_root_binding.reference), "CONTROL_MANIFEST_ROOT");
  const records = new Map(), selected = new Set(), decisions = new Set();
  for (const row of m.initial_records) {
    check(!records.has(row.key) && row.key.split("/").every(p => p !== "." && p !== ".." &&
      !p.endsWith(".lock")) && digest(row.content) === row.sha256, "CONTROL_MANIFEST_RECORD");
    records.set(row.key, { row, value: parse(row.content) });
  }
  check(records.has("decisions/index.json") && records.has("waitpoints/index.json"), "CONTROL_MANIFEST_INDEX");
  for (const t of m.selections) {
    check(!selected.has(t.resource_ref + "\n" + t.operation_id) && !decisions.has(t.decision_id),
      "CONTROL_MANIFEST_SELECTION_DUPLICATE");
    selected.add(t.resource_ref + "\n" + t.operation_id); decisions.add(t.decision_id);
    check(t.decision_key === "decisions/" + t.decision_id + ".json" &&
      records.has(t.resource_key) && records.has(t.decision_key), "CONTROL_MANIFEST_SELECTION");
    const scope = records.get(t.resource_key).value, decision = records.get(t.decision_key).value;
    validate(defs.scope, scope);
    check(scope.project_id === m.project_id && scope.resource_ref === t.resource_ref &&
      scope.decision_id === t.decision_id && scope.owner_generation === 1 &&
      scope.owner_workflow === m.owner_workflow && epoch(scope.valid_from) < epoch(scope.expires_at) &&
      epoch(scope.valid_from) >= epoch(m.valid_from) && epoch(scope.expires_at) <= epoch(m.expires_at),
      "CONTROL_MANIFEST_SCOPE");
    const wp = records.get("waitpoints/" + scope.waitpoint_id + ".json");
    check(wp && decision.decision_id === t.decision_id && decision.status === "open" &&
      decision.selected_option === null && decision.resolved_by === null && decision.resolved_at === null &&
      Array.isArray(decision.options) && t.allowed_actions.every(a => decision.options.includes(a)) &&
      decision.gate && decision.gate.resource_ref === t.resource_ref && wp.value.decision_id === t.decision_id &&
      wp.value.owner_workflow === m.owner_workflow && ["pending", "blocked"].includes(wp.value.status) &&
      wp.value.released_by === null && wp.value.released_at === null &&
      stable(decision.gate) === stable(wp.value.gate), "CONTROL_MANIFEST_GATE");
    for (const dependency of scope.dependencies) {
      const target = records.get("tasks/" + dependency.task_id + ".json");
      check(target && target.row.sha256 === dependency.digest, "CONTROL_MANIFEST_DEPENDENCY");
    }
  }
  for (const [key, row] of records) {
    if (key.startsWith("scopes/")) check(m.selections.some(t => t.resource_key === key), "CONTROL_MANIFEST_ORPHAN");
    if (key.startsWith("decisions/") && key !== "decisions/index.json")
      check(decisions.has(row.value.decision_id), "CONTROL_MANIFEST_ORPHAN");
    if (key.startsWith("waitpoints/") && key !== "waitpoints/index.json")
      check(m.selections.some(t => records.get(t.resource_key).value.waitpoint_id === row.value.waitpoint_id),
        "CONTROL_MANIFEST_ORPHAN");
  }
  return freeze(m);
}

module.exports = Object.freeze({ validateManifest, CanonicalControlError, check, clone, parse, stable, digest, freeze, epoch, validate, record, json });
