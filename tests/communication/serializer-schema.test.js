"use strict";

// Actual serializer outputs in fresh synthetic projects. The validator below
// independently covers every keyword used by the two bundled closed schemas;
// it refuses unsupported keywords and is not a general JSON Schema library.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "../..");
const decisionSchema = require("../../templates/_shared/.agent/decisions/decision.schema.json");
const waitpointSchema = require("../../templates/_shared/.agent/waitpoints/waitpoint.schema.json");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keywords = new Set(["$schema", "title", "description", "type", "const", "enum",
  "minLength", "pattern", "format", "minItems", "uniqueItems", "items", "required",
  "properties", "additionalProperties", "allOf", "if", "then"]);
function checkSchema(schema) {
  assert.ok(object(schema));
  for (const key of Object.keys(schema)) assert.ok(keywords.has(key), "unsupported keyword: " + key);
  if (schema.format !== undefined) assert.equal(schema.format, "date-time");
  if (schema.additionalProperties !== undefined) assert.equal(schema.additionalProperties, false);
  for (const value of Object.values(schema.properties || {})) checkSchema(value);
  for (const value of schema.allOf || []) checkSchema(value);
  for (const key of ["items", "if", "then"]) if (schema[key]) checkSchema(schema[key]);
}
function valid(schema, value) {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).includes(type)) return false;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (type === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    // Serializer emits canonical UTC. This intentionally stricter date-time
    // check also rejects impossible dates instead of accepting Date rollover.
    if (schema.format && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) return false;
  }
  if (type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every((v) => valid(schema.items, v))) return false;
  }
  if (type === "object") {
    if (schema.required && !schema.required.every((key) => Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties || {}, key))) return false;
    for (const [key, rule] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key) && !valid(rule, value[key])) return false;
    }
  }
  if (schema.allOf && !schema.allOf.every((rule) => valid(rule, value))) return false;
  if (schema.if && valid(schema.if, value) && schema.then && !valid(schema.then, value)) return false;
  return true;
}
checkSchema(decisionSchema); checkSchema(waitpointSchema);

function fixture(t, variant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-serializer-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, ".agent/skills/management-api/scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of ["index.js", "normalize-token-usage.js", "query-activity.js", "query-dispatch-state.js", "projection-registry.json"]) {
    // The management-api scripts are shipped once, in the shared layer. The
    // language overlays carry the manifest, not a second copy of the code, so
    // every language receives the same script -- which is what the variant
    // loop below now asserts.
    fs.copyFileSync(path.join(ROOT, "templates/_shared/.agent/skills/management-api/scripts", file),
      path.join(scripts, file));
  }
  const tasks = path.join(root, ".agent/tasks/scripts");
  fs.mkdirSync(tasks, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "templates/_shared/.agent/tasks/scripts/task-state.js"), path.join(tasks, "task-state.js"));
  const guard = path.join(root, "offline-guard.cjs");
  fs.writeFileSync(guard, [
    "'use strict';",
    "const Module=require('node:module'),load=Module._load;",
    "const blocked=new Set(['net','tls','http','https','http2','dns','dgram','worker_threads','cluster']);",
    "Module._load=function(id,...args){if(blocked.has(id.replace(/^node:/,'')))throw Error('offline fixture import blocked');return load.call(this,id,...args);};",
    "const cp=require('node:child_process');for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=()=>{throw Error('nested process blocked');};",
    "globalThis.fetch=()=>{throw Error('offline fixture fetch blocked');};",
  ].join("\n"));
  return { root, script: path.join(scripts, "index.js"), guard };
}
function run(f, args) {
  const result = spawnSync(process.execPath, ["--require", f.guard, f.script, ...args], {
    cwd: f.root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, CORTEX_STATE_SYNC: "off" },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
function record(f, kind, id) {
  const value = JSON.parse(fs.readFileSync(path.join(f.root, ".agent", kind === "decision" ? "decisions" : "waitpoints", id + ".json"), "utf8"));
  const schema = kind === "decision" ? decisionSchema : waitpointSchema;
  assert.equal(valid(schema, value), true, JSON.stringify(value));
  assert.equal(schema.additionalProperties, false);
  const legacy = { ...value }; delete legacy.workflow_gate;
  assert.equal(valid(schema, legacy), true, "audit label is backward-compatible and optional");
  for (const invalid of ["admin", "", null, true]) assert.equal(valid(schema, { ...value, workflow_gate: invalid }), false);
  for (const field of ["approved_scope", "execution_authorized", "owner_authenticated"]) {
    assert.equal(valid(schema, { ...value, [field]: true }), false, "unknown authority remains rejected");
  }
  assert.equal(valid(schema, { ...value, updated_at: "2026-02-30T00:00:00.000Z" }), false);
  return value;
}
function request(f, id) {
  run(f, ["decisions", "request", "--decision-id", id, "--gate", "mission", "--type", "approval",
    "--requested-by", "fixture-owner", "--prompt", "Synthetic schema fixture",
    "--gate-action", "external_side_effect", "--resource-ref", "fixture:serializer",
    "--options", '["approve","reject","revise","cancel"]']);
  assert.equal(record(f, "decision", id).workflow_gate, "mission");
}
for (const variant of ["_shared", "en", "zh"]) {
  test(variant + " real Decision/Waitpoint serialization satisfies every bundled schema constraint", (t) => {
    const f = fixture(t, variant);
    request(f, "D-current");
    run(f, ["decisions", "resolve", "--decision-id", "D-current", "--gate", "user", "--status", "approved",
      "--selected-option", "approve", "--resolved-by", "fixture-user", "--rationale", "Synthetic only"]);
    const approved = record(f, "decision", "D-current");
    assert.equal(approved.workflow_gate, "user");
    assert.equal(valid(decisionSchema, { ...approved, resolved_by: null }), false, "approved if/then applies");
    request(f, "D-old"); request(f, "D-replacement");
    run(f, ["decisions", "supersede", "--decision-id", "D-old", "--gate", "requester",
      "--superseded-by-decision-id", "D-replacement", "--superseded-by", "fixture-owner"]);
    assert.equal(record(f, "decision", "D-old").workflow_gate, "requester");
    for (const id of ["WP-release", "WP-cancel"]) {
      run(f, ["waitpoints", "create", "--waitpoint-id", id, "--gate", "agent", "--owner-workflow", "/mission",
        "--reason", "Synthetic only", "--action", "external_side_effect", "--resource-ref", "fixture:serializer",
        "--decision-id", "D-current", "--expires-at", "2099-01-01T00:00:00.000Z"]);
      assert.equal(record(f, "waitpoint", id).workflow_gate, "agent");
    }
    run(f, ["waitpoints", "release", "--waitpoint-id", "WP-release", "--gate", "owner", "--owner-workflow", "/mission",
      "--decision-id", "D-current", "--released-by", "fixture-owner"]);
    const released = record(f, "waitpoint", "WP-release");
    assert.equal(released.workflow_gate, "owner");
    assert.equal(valid(waitpointSchema, { ...released, evidence_refs: [] }), false, "released if/then applies");
    run(f, ["waitpoints", "cancel", "--waitpoint-id", "WP-cancel", "--gate", "owner",
      "--owner-workflow", "/mission", "--reason", "Synthetic cancellation"]);
    assert.equal(record(f, "waitpoint", "WP-cancel").workflow_gate, "owner");
  });
}
