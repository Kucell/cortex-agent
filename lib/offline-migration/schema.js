"use strict";
// Restricted validator for the shipped data schemas. Unknown vocabulary fails
// closed; this is not a general JSON Schema engine and loads no project code.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const metadata = new Set(["$schema", "$id", "title", "description", "default", "$defs", "definitions"]);
const supported = new Set(["$ref", "type", "const", "enum", "required", "properties", "additionalProperties", "items", "minItems", "uniqueItems", "minLength", "pattern", "format", "allOf", "if", "then"]);
function validate(value, schema, root = schema, depth = 0) {
  if (depth > 80) return false;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (Object.keys(schema).some(k => !metadata.has(k) && !supported.has(k))) return false;
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/$defs/")) return false;
    return validate(value, root.$defs?.[schema.$ref.slice(8)], root, depth + 1);
  }
  const check = (v, s) => validate(v, s, root, depth + 1);
  if (schema.allOf && !schema.allOf.every(s => check(value, s))) return false;
  if (schema.if && check(value, schema.if) && schema.then && !check(value, schema.then)) return false;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (own(schema, "const") && !eq(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some(v => eq(value, v))) return false;
  const type = v => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (schema.type && ![].concat(schema.type).some(t => t === "integer" ? Number.isSafeInteger(value) : type(value) === t)) return false;
  if (typeof value === "string") {
    if (schema.minLength && [...value].length < schema.minLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "date-time") {
      const [y, m, d] = value.slice(0, 10).split("-").map(Number);
      const time = /^.{10}T(\d\d):(\d\d):(\d\d)/.exec(value);
      if (!time || +time[1] > 23 || +time[2] > 59 || +time[3] > 59) return false;
      const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (!(m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1])) return false;
    }
    if (schema.format && (schema.format !== "date-time" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every(v => check(v, schema.items))) return false;
  } else if (value && typeof value === "object") {
    if (schema.required && !schema.required.every(k => own(value, k))) return false;
    if ([].concat(schema.type || []).includes("object") && schema.properties && Object.keys(value).some(k => !own(schema.properties, k))) return false;
    if (schema.properties && !Object.entries(schema.properties).every(([k, s]) => !own(value, k) || check(value[k], s))) return false;
  }
  return true;
}
module.exports = { validate };
