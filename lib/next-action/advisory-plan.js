"use strict";

// Pure draft/validation helpers. Serialization never persists or approves a plan.
const crypto = require("node:crypto");
const schema = require("./advisory-plan.schema.json");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function iso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fail(code) { const error = new Error(code); error.code = code; throw error; }

// Deliberately limited to the bundled plan/Decision/Waitpoint schemas. Unknown
// schema keywords fail closed; this is not an extensible JSON Schema engine.
function supportedSchema(rule) {
  if (!object(rule)) return false;
  const keys = ["$schema", "$id", "title", "description", "type", "const", "enum",
    "minLength", "maxLength", "pattern", "format", "minimum", "maximum",
    "minItems", "maxItems", "uniqueItems", "items", "required", "properties",
    "additionalProperties", "allOf", "if", "then"];
  if (Object.keys(rule).some((key) => !keys.includes(key))) return false;
  if (rule.$schema !== undefined && rule.$schema !== "https://json-schema.org/draft/2020-12/schema") return false;
  if (rule.format !== undefined && rule.format !== "date-time") return false;
  if (rule.additionalProperties !== undefined && rule.additionalProperties !== false) return false;
  for (const key of ["items", "if", "then"]) if (rule[key] !== undefined && !supportedSchema(rule[key])) return false;
  if (rule.allOf && !rule.allOf.every(supportedSchema)) return false;
  return !rule.properties || Object.values(rule.properties).every(supportedSchema);
}
function matches(rule, value) {
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual) && !(types.includes("integer") && Number.isSafeInteger(value))) return false;
  }
  if (own(rule, "const") && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || own(rule, "minimum") && value < rule.minimum
        || own(rule, "maximum") && value > rule.maximum) return false;
  }
  if (typeof value === "string") {
    if (own(rule, "minLength") && value.length < rule.minLength
        || own(rule, "maxLength") && value.length > rule.maxLength) return false;
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
    if (rule.format === "date-time" && iso(value) === null) return false;
  }
  if (Array.isArray(value)) {
    if (own(rule, "minItems") && value.length < rule.minItems
        || own(rule, "maxItems") && value.length > rule.maxItems) return false;
    if (rule.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) return false;
    if (rule.items && !value.every((entry) => matches(rule.items, entry))) return false;
  }
  if (object(value)) {
    if (rule.required && !rule.required.every((key) => own(value, key))) return false;
    if (rule.additionalProperties === false && Object.keys(value).some((key) => !own(rule.properties || {}, key))) return false;
    for (const [key, item] of Object.entries(rule.properties || {})) if (own(value, key) && !matches(item, value[key])) return false;
  }
  if (rule.allOf && !rule.allOf.every((item) => matches(item, value))) return false;
  if (rule.if && matches(rule.if, value) && rule.then && !matches(rule.then, value)) return false;
  return true;
}
function safeText(value) { return typeof value === "string" && value.trim() === value && !!value && !/[\u0000-\u001f\u007f]/.test(value); }
function safePath(value) {
  return safeText(value) && !value.startsWith("/") && !value.includes("\\")
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}
function validateAdvisoryPlan(value) {
  if (!supportedSchema(schema)) fail("ERR_ADVISOR_PLAN_SCHEMA_UNSUPPORTED");
  if (!matches(schema, value)) fail("ERR_ADVISOR_PLAN_SCHEMA");
  for (const key of ["plan_id", "project_id", "task_id", "mission_id"]) if (value[key].includes("..")) fail("ERR_ADVISOR_PLAN_ID");
  if (value.approval.decision_id.includes("..") || value.approval.waitpoint_id.includes("..")) fail("ERR_ADVISOR_PLAN_ID");
  if (value.task_source.path !== "tasks/" + value.task_id + ".json") fail("ERR_ADVISOR_TASK_SOURCE_PATH");
  if (value.mission_contract.path !== "missions/" + value.mission_id + "/validation-contract.json") fail("ERR_ADVISOR_MISSION_CONTRACT_PATH");
  const branch = value.scope.branch;
  if (!safeText(branch) || branch.includes(" ") || branch === "@"
      || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith(".")
      || branch.includes("..") || branch.includes("@{") || /[~^:?*\[\\]/.test(branch)
      || branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) fail("ERR_ADVISOR_PLAN_BRANCH");
  if (!value.scope.allowed_paths.every(safePath)
      || !value.validation_commands.every(safeText) || !value.stop_conditions.every(safeText)) fail("ERR_ADVISOR_PLAN_SCOPE");
  if (iso(value.created_at) >= iso(value.expires_at)) fail("ERR_ADVISOR_PLAN_VALIDITY");
  return value;
}
function planPath(value) { return "missions/" + value.mission_id + "/advisory-plans/" + value.plan_id + ".json"; }
function planResource(path, digest) { return "artifact:" + path + "#sha256:" + digest; }
function prepareAdvisoryPlan(text) {
  // JSON text is the only input: no caller object getters or toJSON hooks run.
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1024 * 1024) fail("ERR_ADVISOR_PLAN_TEXT");
  const plan = validateAdvisoryPlan(JSON.parse(text));
  const content = JSON.stringify(plan, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024) fail("ERR_ADVISOR_PLAN_TOO_LARGE");
  const path = planPath(plan), digest = sha256(content);
  return Object.freeze({ status: "DRAFT_PREPARED", path, content, sha256: digest,
    resource_ref: planResource(path, digest), write_permitted: false, execution_authorized: false });
}

module.exports = Object.freeze({ prepareAdvisoryPlan, validateAdvisoryPlan, planPath, planResource,
  supportedSchema, matches, iso, sha256 });
